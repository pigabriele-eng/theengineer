"""Is a log that gives no laps an empty run, or a run whose laps couldn't be timed?

A log with no laps is usually the dash recording in the pit lane or the garage, or an out-lap and an in-lap with no
full lap between them: nothing to analyse. But the car may have done laps that the log can't time: no start/finish
marker, no .ldx with lap beacons, and no known start/finish line to time it from the GPS. That is a missing lap
beacon, and the run is worth keeping.

The data tells the two apart. At racing speed (above any pit-lane limit), the GPS track of a car doing laps passes
the same point in the same direction again and again, a lap's distance apart: an out-lap and an in-lap pass most
of the track twice, and every full lap between them adds a pass. Without a usable GPS, the distance driven at racing
speed against the track's length says the same, more roughly. A run counts as untimed laps only when no timing
source saw the car cross the line at all; a marker, beacon, GPS line or lap counter that saw it cross once means
the car really did no full lap.
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from app.analysis.laps import MASTER_HZ, SessionData, TimingLine, gps_crossings
from app.importers.motec import LdFile

STILL_KMH = 2.0  # never faster than this: the car stood still (pushed around at most)
UNTIMED = "Laps not timed: the lap beacon is missing"  # the headline of a run kept with untimed laps
RACING_KMH = 80.0  # above pit-lane speed limits (60 or 80 km/h): the car is out on track
MOVING_KMH = 20.0  # a line crossing slower than this is the dash starting up, not the car crossing
GPS_HZ = 10  # the GPS track is followed at this rate
CELL_M = 25.0  # the GPS track is binned into squares this size...
HEADINGS = 8  # ...and into this many directions of travel, so a crossover isn't taken for a lap
MIN_LOOP_M = 600.0  # passes of one square closer than this (driven) are one pass, not a lap
GPS_AGREES = (0.6, 1.5)  # GPS path over speed distance at racing speed: outside this, the GPS has no real fix
NO_LENGTH_RACING_M = 15_000.0  # without GPS or a track length: this far at racing speed is laps on any circuit


class NoLaps(Exception):
    """The log gives no laps and the car did none: it isn't kept. reason says why in plain words."""

    def __init__(self, reason: str):
        super().__init__(reason)
        self.reason = reason


@dataclass
class Verdict:
    keep: bool  # True: the car did laps the log couldn't time (a missing lap beacon)
    reason: str  # "no laps: 52 s in the pit lane", or why the laps couldn't be timed (headline UNTIMED)
    fix: str | None = None  # what times the laps, when they are kept untimed
    laps: int = 0  # full laps the data shows
    racing_km: float = 0.0  # driven at racing speed
    gps: bool = False  # the GPS had a real fix at racing speed

    def note(self) -> dict:
        """What LoggerFile.meta["untimed"] keeps for the app."""
        return {"title": UNTIMED, "reason": self.reason, "fix": self.fix, "laps": self.laps,
                "racing_km": round(self.racing_km, 1)}


def _gps_track(data: SessionData) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray] | None:
    """Metres east and north, driven distance and speed at GPS_HZ, where the log has GPS."""
    lat, lon = data.channels.get("lat"), data.channels.get("lon")
    if lat is None or lon is None:
        return None
    step = MASTER_HZ // GPS_HZ
    la, lo = lat[::step], lon[::step]
    lat0, lon0 = float(np.median(la)), float(np.median(lo))
    r = 6_371_000.0
    x = np.radians(lo - lon0) * r * np.cos(np.radians(lat0))
    y = np.radians(la - lat0) * r
    return x, y, data.distance[::step], data.channels["speed"][::step]


def _loops(x: np.ndarray, y: np.ndarray, d: np.ndarray, fast: np.ndarray) -> int:
    """Most times the car came back to one point of its GPS track, at racing speed and in the same direction,
    after driving at least MIN_LOOP_M: the passes of the most-passed point, less one."""
    heading = np.arctan2(np.gradient(x), np.gradient(y))
    sector = np.floor((np.degrees(heading) % 360 + 180 / HEADINGS) / (360 / HEADINGS)).astype(np.int64) % HEADINGS
    cx, cy = np.floor(x / CELL_M).astype(np.int64), np.floor(y / CELL_M).astype(np.int64)
    key = ((cx - cx.min()) * (cy.max() - cy.min() + 1) + (cy - cy.min())) * HEADINGS + sector
    key, d = key[fast], d[fast]
    if len(key) == 0:
        return 0
    order = np.lexsort((d, key))
    key, d = key[order], d[order]
    first = np.r_[True, key[1:] != key[:-1]]
    again = np.r_[False, (key[1:] == key[:-1]) & (np.diff(d) > MIN_LOOP_M)]
    passes = np.add.reduceat((first | again).astype(np.int64), np.flatnonzero(first))
    return int(passes.max()) - 1


def _crossings(ld: LdFile, data: SessionData, beacons: list[float] | None, line: TimingLine | None) -> dict[str, int]:
    """How often each timing source the log has saw the car cross the start/finish line. A marker pulse or a lap
    count step with the car standing is the dash starting up (one log of the Hockenheim test has both at 1 s), not
    a crossing."""
    out = {"beacons": len(beacons or [])}

    def moving(times: np.ndarray) -> int:
        return int(np.count_nonzero(np.interp(times, data.t, data.channels["speed"]) > MOVING_KMH))

    sf = ld.channel("S/F Marker", "Start Finish", "SF Marker")
    if sf is not None:
        out["marker"] = moving(sf.times()[1:][np.diff(sf.values()) > 0])
    counter = ld.channel("Lap Number", "Lap", "lap_number")
    if counter is not None:
        out["counter"] = moving(counter.times()[1:][np.diff(counter.values()) != 0])
    if line is not None:
        out["gps"] = len(gps_crossings(ld, line))
    return out


def judge(ld: LdFile, data: SessionData, beacons: list[float] | None, line: TimingLine | None,
          track_length_m: float | None) -> Verdict:
    """For a log that gives no laps: keep it (the car did laps that couldn't be timed) or not (and why).

    data needs the speed channel, and GPS latitude and longitude when the log has them; beacons are the line
    crossings from the log's .ldx or export, and line the track's start/finish line, as the log was timed with."""
    v = data.channels["speed"]
    seconds = len(v) / MASTER_HZ
    top = float(v.max()) if len(v) else 0.0
    if top < STILL_KMH:
        return Verdict(False, f"no laps: {seconds:.0f} s standing still")
    if top < RACING_KMH:
        return Verdict(False, f"no laps: {seconds:.0f} s in the pit lane")
    fast = v > RACING_KMH
    racing_m = float(np.sum(v[fast]) / 3.6 / MASTER_HZ)
    driven_km = float(data.distance[-1]) / 1000

    laps, gps_ok = None, False
    track = _gps_track(data)
    if track is not None:
        x, y, d, speed = track
        at_speed = speed > RACING_KMH
        path = float(np.sum(np.hypot(np.diff(x), np.diff(y))[at_speed[1:] & at_speed[:-1]]))
        driven = float(np.sum(np.diff(d)[at_speed[1:] & at_speed[:-1]]))
        gps_ok = driven > MIN_LOOP_M and GPS_AGREES[0] < path / driven < GPS_AGREES[1]
        if gps_ok:
            laps = max(0, _loops(x, y, d, at_speed) - 1)  # an out-lap and an in-lap make one loop together
    if laps is None:
        if track_length_m:
            laps = max(0, round(racing_m / track_length_m) - 1)
        else:
            laps = 1 if racing_m >= NO_LENGTH_RACING_M else 0

    seen = _crossings(ld, data, beacons, line if gps_ok else None)
    if laps >= 1 and max(seen.values(), default=0) == 0:
        return _untimed(laps, racing_m, track is not None, gps_ok, line)
    if max(seen.values(), default=0) == 1:
        return Verdict(False, f"no laps: out-lap and in-lap only ({driven_km:.1f} km)", None, laps, racing_m / 1000,
                       gps_ok)
    return Verdict(False, f"no laps: {driven_km:.1f} km driven, no full lap", None, laps, racing_m / 1000, gps_ok)


def _untimed(laps: int, racing_m: float, has_gps: bool, gps_ok: bool, line: TimingLine | None) -> Verdict:
    about = f"about {laps} lap{'s' if laps != 1 else ''}"
    if not has_gps:
        why = "and no GPS to time it from the track's start/finish line"
    elif not gps_ok:
        why = "and its GPS has no usable fix to time it from the track's start/finish line"
    elif line is None:
        why = "and the track's start/finish line isn't known yet to time it from the GPS"
    else:
        why = "and its GPS never crosses the track's start/finish line"
    reason = (f"The car did {about} ({racing_m / 1000:.0f} km at racing speed), but this log has no start/finish "
              f"marker and no lap beacons, {why}.")
    fix = "Upload the .ldx that MoTeC i2 saved with this log (it holds the lap beacons) to this session."
    if gps_ok and line is None:
        fix += (" Or import a log from this track that has the start/finish marker: once the track's line is known, "
                "this log is timed from its GPS by itself.")
    return Verdict(True, reason, fix, laps, racing_m / 1000, gps_ok)
