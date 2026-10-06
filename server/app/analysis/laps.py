"""Lap splitting, distance alignment, corner detection and numbering, and corner metrics.

Works on any logger once its channels are mapped to the standard roles below.
"""
from __future__ import annotations

from collections.abc import Collection
from dataclasses import dataclass, field
from itertools import pairwise

import numpy as np

from app.importers.motec import LdFile

# Standard channel roles and the logger channel names that can fill them, in order of preference: native
# MoTeC names first, then MoTeC i2 export names, AiM Race Studio names and Cosworth (Pi Toolbox) names.
# Names are matched without regard to case.
WHEELS = ("FL", "FR", "RL", "RR")
DEFAULT_CHANNEL_MAP: dict[str, tuple[str, ...]] = {
    "speed": ("vCar", "Ground Speed", "Corr Speed", "Vehicle Speed", "ecu_speed", "GPS Speed", "Speed",
              "log_gps_speed"),
    "throttle": ("rThrottlePedal", "Throttle Pedal", "Throttle Pos", "TPS", "rThrottle", "Throttle Position",
                 "Throttle", "ThrPos", "PPS", "Pedal Pos", "Accel Pos", "Accelerator", "ECU Throttle", "ecu_aps"),
    "brake": ("Brake Pressure Front", "pBrakeF", "Brake Press Front", "Brake Torque", "Brake Pressure",
              "Brake Pres Front", "Front Brake Pres", "Front Brake Press", "BrakePress Front", "Brake Press F",
              "Brake Press", "log_pbrake_f", "Brake Pos"),
    "steer": ("aSteer", "Steered Angle", "Steering Angle", "Steering", "Steer Angle", "SteerAngle", "log_asteer"),
    "gear": ("nGear", "NGearPos", "Gear", "Gear Position", "Gear Pos", "ecu_gear"),
    "rpm": ("nEngine", "Engine Speed", "RPM", "Engine RPM", "ECU RPM", "ecu_nmot"),
    "lat": ("GPS Latitude", "GPS Lat", "Latitude", "log_gps_lat"),
    "lon": ("GPS Longitude", "GPS Long", "GPS Lon", "Longitude", "log_gps_lon"),
    "g_lat": ("gLat", "aLat [m/s/s]", "G Force Lat", "Lateral Accel", "LateralAcc", "Lateral Acc",
              "Lateral Acceleration", "LatAcc", "Lateral G", "log_acc_y", "GPS LatAcc"),
    "g_long": ("gLong", "aLong [m/s/s]", "G Force Long", "Longitudinal Accel", "InlineAcc", "Inline Acc",
               "LongAcc", "LonAcc", "Longitudinal Acceleration", "Longitudinal G", "log_acc_x", "GPS LonAcc"),
    "yaw": ("nYaw", "Yaw Rate", "Gyro Yaw Velocity", "Yaw Velocity", "YawRate", "sclu_yaw_rate", "log_yaw_rate",
            "GPS Gyro"),
    "steer_wheel": ("aSteerWheel", "Steering Wheel Angle"),
    "brake_rear": ("pBrakeR", "Brake Pressure Rear", "Brake Press Rear", "Brake Pres Rear", "Rear Brake Pres",
                   "Rear Brake Press", "BrakePress Rear", "Brake Press R", "log_pbrake_r"),
    **{f"wheel_{w.lower()}": (f"nWheel{w}", f"vWheel{w}", f"Wheel Speed {w}", f"WheelSpd{w}", f"Wheel Spd {w}",
                              f"log_speed_{w.lower()}", f"abs_speed_{w.lower()}") for w in WHEELS},
    "tc": ("BInterventionCauseTC", "TC Active", "TC Intervention", "ecu_B_tc_act"),
    "abs": ("NAbs", "ABS Active", "abs_active"),
    **{f"tyre_p_{w.lower()}": (f"pTyre{w}", f"Tyre Pres {w}", f"Tyre Pressure {w}", f"Tire Pressure {w}",
                               f"Tire Pres {w}", f"TPMS Press {w}", f"TPMS Pressure {w}", f"tpms_press_{w.lower()}")
       for w in WHEELS},
    **{f"tyre_t_{w.lower()}": (f"TTyre{w}", f"Tyre Temp {w}", f"Tyre Temperature {w}", f"Tire Temp {w}",
                               f"TPMS Temp {w}", f"tpms_temp_{w.lower()}") for w in WHEELS},
}
# Roles that hold states or flags: sampled, not interpolated, onto the master clock.
DISCRETE_ROLES = {"gear", "tc", "abs"}
# Sensors that log a fixed value when they have no signal; those samples are dropped before resampling.
NO_SIGNAL_BELOW = {"tyre_t_fl": -40, "tyre_t_fr": -40, "tyre_t_rl": -40, "tyre_t_rr": -40,
                   "tyre_p_fl": 0.05, "tyre_p_fr": 0.05, "tyre_p_rl": 0.05, "tyre_p_rr": 0.05, "lat": 0.1, "lon": 0.1}

MASTER_HZ = 100
CLEAN_LAP_MARGIN = 1.05  # a clean lap is within 5 % of the session's best
PIT_SPEED_KMH = 70  # below this for PIT_SECONDS in one lap means pit lane or a slow lap, not a clean lap
PIT_SECONDS = 8
TIMING_LINE_WIDTH_M = 40  # how far either side of the start/finish point a GPS crossing still counts
# Line crossings closer together than a real lap can be are one pass of the line: a double pulse of the dash's
# marker, a GPS position wobbling across the line while the car stands near it. No circuit's lap is this short.
MIN_LAP_S = 20.0
MIN_LAP_M = 500.0  # ... or with less than this driven between them (by the speed channel)
# Raise when the laps a log gives change (how line crossings are found or split into laps): every stored log is
# then timed again once, in the background (timing.py).
TIMING_VERSION = 2  # 2: crossings closer than MIN_LAP_S / MIN_LAP_M are one crossing


@dataclass
class TimingLine:
    """The start/finish line as a GPS point and the direction of travel through it."""
    lat: float
    lon: float
    heading: float  # degrees clockwise from north
    # what it was learned from: "marker" (the dash's S/F marker) or "beacons" (an .ldx, often i2's own "Auto GPS"
    # beacons, which can sit metres away from the line); "" when that wasn't recorded
    source: str = ""


@dataclass
class Lap:
    number: int
    start: float
    end: float
    time: float
    clean: bool = False


@dataclass
class SessionData:
    t: np.ndarray
    distance: np.ndarray
    channels: dict[str, np.ndarray]
    sources: dict[str, str]
    laps: list[Lap] = field(default_factory=list)
    lap_source: str = ""  # beacons, marker, gps or counter
    timing_line: TimingLine | None = None


def load_session(ld: LdFile, channel_map: dict[str, tuple[str, ...]] | None = None,
                 beacons: list[float] | None = None, line: TimingLine | None = None,
                 roles: Collection[str] | None = None) -> SessionData:
    """The log on the 100 Hz master clock, split into laps. roles limits the channels read (speed always is)."""
    cmap = {**DEFAULT_CHANNEL_MAP, **(channel_map or {})}
    if roles is not None:
        cmap = {role: names for role, names in cmap.items() if role in roles or role == "speed"}
    speed = ld.channel(*cmap["speed"])
    if speed is None:
        raise ValueError("No speed channel found; add the car's speed channel to its channel map")
    t = np.arange(0, speed.duration, 1 / MASTER_HZ)
    channels, sources = {}, {}
    for role, names in cmap.items():
        ch = ld.channel(*names)
        if ch is None:
            continue
        ct, cv = ch.times(), ch.values()
        if role in NO_SIGNAL_BELOW:
            ok = np.abs(cv) > NO_SIGNAL_BELOW[role] if role in ("lat", "lon") else cv > NO_SIGNAL_BELOW[role]
            if np.count_nonzero(ok) < 2:
                continue
            ct, cv = ct[ok], cv[ok]
        if role in DISCRETE_ROLES:
            v = cv[np.clip(np.searchsorted(ct, t, side="right") - 1, 0, len(cv) - 1)].astype(float)
        else:
            v = np.interp(t, ct, cv)
        if role.startswith("tyre_p") and np.nanmedian(v) > 50:  # some tyre systems log kPa
            v = v / 100
        if role in ("brake", "brake_rear"):
            v = np.abs(v)  # some cars log brake torque as a negative number
        if role in ("g_lat", "g_long") and "m/s" in (ch.unit + ch.name):
            v = v / 9.81
        channels[role], sources[role] = v, ch.name
    distance = np.concatenate([[0.0], np.cumsum(channels["speed"][1:] / 3.6 / MASTER_HZ)])
    data = SessionData(t=t, distance=distance, channels=channels, sources=sources)
    timing = time_laps(ld, beacons, line)
    data.laps, data.lap_source, data.timing_line = timing.laps, timing.source, timing.line
    return data


@dataclass
class LapTiming:
    laps: list[Lap]
    source: str  # beacons, marker, gps or counter; "" when the log has no laps
    line: TimingLine | None  # where the laps start: learned from the beacons or marker, else the line given


def time_laps(ld: LdFile, beacons: list[float] | None = None, line: TimingLine | None = None) -> LapTiming:
    """The log's laps, without resampling its channels: what's needed to (re-)time a stored log."""
    laps, source = split_laps(ld, beacons, line)
    if source in ("beacons", "marker"):
        return LapTiming(laps, source, timing_line_at(ld, [l.start for l in laps], source))
    return LapTiming(laps, source, line)


def _gps(ld: LdFile):
    lat, lon = ld.channel(*DEFAULT_CHANNEL_MAP["lat"]), ld.channel(*DEFAULT_CHANNEL_MAP["lon"])
    if lat is None or lon is None:
        return None
    t = lat.times()
    la, lo = lat.values().astype(float), np.interp(t, lon.times(), lon.values()).astype(float)
    ok = (np.abs(la) > 0.1) & (np.abs(lo) > 0.1)  # no fix logs as zeros
    return t[ok], la[ok], lo[ok]


def _local_m(la: np.ndarray, lo: np.ndarray, lat0: float, lon0: float) -> tuple[np.ndarray, np.ndarray]:
    r = 6_371_000.0
    return (np.radians(lo - lon0) * r * np.cos(np.radians(lat0)), np.radians(la - lat0) * r)


def timing_line_at(ld: LdFile, times: list[float], source: str = "") -> TimingLine | None:
    """Where the car was at known line-crossing times: the start/finish line for GPS lap timing."""
    g = _gps(ld)
    if g is None or len(times) < 2 or len(g[0]) < 10:
        return None
    t, la, lo = g
    lats, lons = np.interp(times, t, la), np.interp(times, t, lo)
    lat0, lon0 = float(np.median(lats)), float(np.median(lons))
    x, y = _local_m(la, lo, lat0, lon0)
    heads = []
    for c in times:
        i = int(np.searchsorted(t, c))
        if 1 <= i < len(t) - 1:
            heads.append(np.arctan2(x[i + 1] - x[i - 1], y[i + 1] - y[i - 1]))
    if not heads:
        return None
    heading = float(np.degrees(np.arctan2(np.mean(np.sin(heads)), np.mean(np.cos(heads))))) % 360
    return TimingLine(lat0, lon0, heading, source)


def gps_crossings(ld: LdFile, line: TimingLine, min_gap_s: float = 10.0) -> np.ndarray:
    """Times the car crossed the timing line in the direction of travel, interpolated between GPS samples."""
    g = _gps(ld)
    if g is None:
        return np.array([])
    t, la, lo = g
    x, y = _local_m(la, lo, line.lat, line.lon)
    h = np.radians(line.heading)
    along = x * np.sin(h) + y * np.cos(h)
    across = x * np.cos(h) - y * np.sin(h)
    out: list[float] = []
    for i in np.nonzero((along[:-1] < 0) & (along[1:] >= 0))[0]:
        if abs(across[i]) > TIMING_LINE_WIDTH_M or along[i + 1] - along[i] > 50:  # off the line, or a GPS jump
            continue
        tc = t[i] + (t[i + 1] - t[i]) * (-along[i]) / (along[i + 1] - along[i])
        if not out or tc - out[-1] >= min_gap_s:
            out.append(float(tc))
    return np.array(out)


def _driven_at(ld: LdFile, times: np.ndarray) -> np.ndarray | None:
    """Distance driven (m) from the start of the log to each of these times, by the speed channel (None without
    one)."""
    speed = ld.channel(*DEFAULT_CHANNEL_MAP["speed"])
    if speed is None or speed.count < 2:
        return None
    t, v = speed.times(), np.abs(np.nan_to_num(speed.values(), nan=0.0))
    return np.interp(times, t, np.concatenate([[0.0], np.cumsum(v[:-1] * np.diff(t))]) / 3.6)


def one_per_pass(starts: np.ndarray, ld: LdFile) -> np.ndarray:
    """Line crossings with those that follow one too soon dropped: less than MIN_LAP_S, or MIN_LAP_M driven, after
    the last crossing kept. A double marker pulse or a GPS wobble at the line is one pass of the line, so a lap it
    would split stays one lap, and a car standing at the line does no lap."""
    starts = np.asarray(starts, float)
    if len(starts) < 2:
        return starts
    at = _driven_at(ld, starts)
    keep = [0]
    for i in range(1, len(starts)):
        j = keep[-1]
        if starts[i] - starts[j] < MIN_LAP_S or (at is not None and at[i] - at[j] < MIN_LAP_M):
            continue
        keep.append(i)
    return starts[keep]


def lap_starts(ld: LdFile, beacons: list[float] | None = None,
               line: TimingLine | None = None) -> tuple[np.ndarray, str]:
    """Line-crossing times. The dash's own S/F marker comes first; then the GPS crossing of a line learned from
    the dash's marker, so every log of a track starts its laps at the same place; then .ldx beacons (i2's "Auto
    GPS" beacons can sit tens of metres from the dash's line, and miss laps); then the GPS crossing of any other
    line; then the lap counter. Whatever the source, crossings too close together are one pass (one_per_pass)."""
    sf = ld.channel("S/F Marker", "Start Finish", "SF Marker")
    if sf is not None:
        starts = one_per_pass(sf.times()[1:][np.diff(sf.values()) > 0], ld)
        if len(starts) >= 2:
            return starts, "marker"
    marker_line = line is not None and line.source == "marker"
    if marker_line:
        starts = one_per_pass(gps_crossings(ld, line), ld)
        if len(starts) >= 2:
            return starts, "gps"
    if beacons and len(beacons) >= 2:
        starts = one_per_pass(np.asarray(beacons, float), ld)
        if len(starts) >= 2:
            return starts, "beacons"
    if line is not None and not marker_line:
        starts = one_per_pass(gps_crossings(ld, line), ld)
        if len(starts) >= 2:
            return starts, "gps"
    ln = ld.channel("Lap Number", "Lap", "lap_number")
    if ln is not None:
        starts = one_per_pass(ln.times()[1:][np.diff(ln.values()) != 0], ld)
        if len(starts) >= 2:
            return starts, "counter"
    return np.array([]), ""


def split_laps(ld: LdFile, beacons: list[float] | None = None,
               line: TimingLine | None = None) -> tuple[list[Lap], str]:
    """Laps between consecutive line crossings, with the dash's own lap time where it agrees."""
    starts, source = lap_starts(ld, beacons, line)
    lap_time = ld.channel("Lap Time")
    speed = ld.channel(*DEFAULT_CHANNEL_MAP["speed"])
    laps = []
    for i in range(len(starts) - 1):
        a, b = float(starts[i]), float(starts[i + 1])
        time = b - a
        if lap_time is not None:
            # the dash publishes the completed lap's time shortly after the line
            k = min(np.searchsorted(lap_time.times(), b + 1.5), lap_time.count - 1)
            logged = float(lap_time.values()[k])
            if abs(logged - time) < (1.0 if source == "counter" else 0.25):
                time = logged
        laps.append(Lap(number=i + 1, start=a, end=b, time=round(time, 3)))
    if laps:
        best = min(l.time for l in laps)
        for l in laps:
            l.clean = l.time <= best * CLEAN_LAP_MARGIN and not _has_slow_section(speed, l)
        clean = [l.time for l in laps if l.clean]
        if clean and min(clean) > best:  # the fastest "lap" was not a real lap; judge against the best clean one
            for l in laps:
                l.clean = l.clean and l.time <= min(clean) * CLEAN_LAP_MARGIN
    return laps, source


def _has_slow_section(speed, lap: Lap) -> bool:
    if speed is None:
        return False
    t = speed.times()
    v = speed.values()[(t >= lap.start) & (t < lap.end)]
    return len(v) > 0 and np.count_nonzero(v < PIT_SPEED_KMH) / speed.freq > PIT_SECONDS


def lap_trace(data: SessionData, lap: Lap, length: float, step: float = 1.0) -> dict[str, np.ndarray]:
    """One lap resampled on a common distance grid, stretched to the reference length."""
    i0, i1 = round(lap.start * MASTER_HZ), round(lap.end * MASTER_HZ)
    i1 = min(i1, len(data.t) - 1)
    d = data.distance[i0:i1 + 1] - data.distance[i0]
    d = d / d[-1] * length
    grid = np.arange(0, length, step)
    out = {"distance": grid, "t": np.interp(grid, d, data.t[i0:i1 + 1] - data.t[i0])}
    if out["t"][-1] > 0:
        out["t"] *= lap.time / out["t"][-1]
    for role, v in data.channels.items():
        out[role] = np.interp(grid, d, v[i0:i1 + 1])
    return out


def lap_length(data: SessionData, lap: Lap) -> float:
    i0, i1 = round(lap.start * MASTER_HZ), min(round(lap.end * MASTER_HZ), len(data.t) - 1)
    return float(data.distance[i1] - data.distance[i0])


@dataclass
class Corner:
    code: str
    apex: int
    start: int
    end: int


def _smooth(y: np.ndarray, w: int = 25) -> np.ndarray:
    k = np.ones(w) / w
    return np.convolve(np.pad(y, w, mode="wrap"), k, "same")[w:-w]


def detect_corners(ref: dict[str, np.ndarray], min_drop_kmh: float = 15.0) -> list[Corner]:
    """Corners are speed minima that sit well below the surrounding straights.

    They are numbered C1, C2... in lap order: the speed trace can't tell which official corner number each is.
    """
    v = _smooth(ref["speed"])
    n = len(v)
    apexes: list[int] = []
    for i in range(60, n - 60):
        if v[i] == v[i - 60:i + 61].min() and v[max(0, i - 150):i + 151].max() - v[i] > min_drop_kmh:
            if apexes and i - apexes[-1] <= 60:
                continue  # the same flat-bottomed minimum, not a second corner
            apexes.append(i)
    bounds = [0]
    for a, b in pairwise(apexes):
        bounds.append(max(bounds[-1] + 1, a + int(np.argmax(v[a:b])) - 40))
    bounds.append(n - 1)
    return [Corner(f"C{i + 1}", a, bounds[i], bounds[i + 1]) for i, a in enumerate(apexes)]


GROUP_WITHIN_M = 150  # official corners this close to a corner's slowest point share its section

# An official corner: (code, metres from the line) or (code, metres, sector). Corners given the same sector
# name are timed and compared as one section, whatever the speed trace would split them into.
CornerSpec = tuple[str, float] | tuple[str, float, str | None]


@dataclass
class Section:
    code: str
    start: int
    end: int
    apex: int | None  # slowest point, or None for a section without a real corner
    corners: list[str] = field(default_factory=list)  # the official numbers inside it

    def to_dict(self) -> dict:
        return {"code": self.code, "start_m": self.start, "end_m": self.end, "apex_m": self.apex}


def _label(codes: list[str]) -> str:
    if len(codes) == 1:
        return codes[0]
    if len(codes) == 2:
        return f"{codes[0]}/{codes[1]}"
    return f"{codes[0]}-{codes[-1]}"


def make_sections(ref: dict[str, np.ndarray], corners: list[CornerSpec] | None = None
                  ) -> tuple[list[Section], str]:
    """Split the lap at the fast points between corners.

    With the track's official corners, each section carries the official numbers inside it, grouped like
    "T8/T9" or "T2-T4"; each flat-out kink far from any slow point gets its own section. Corners the track
    puts in one sector become one section, labelled first to last ("T6-T7", "T2-T5"), and never share it with a
    corner outside the sector. Without official corners, the slowest points are numbered C1, C2... so they are
    never mistaken for official numbers.
    """
    found = detect_corners(ref)
    n = len(ref["speed"])
    if not found:
        return [Section("Lap", 0, n - 1, None)], "detected"
    if not corners:
        secs = [Section(f"C{i + 1}", c.start, c.end, c.apex) for i, c in enumerate(found)]
        return secs, "detected"
    official = sorted(((c[0], int(c[1])) for c in corners if c[1] is not None and 0 <= c[1] < n), key=lambda c: c[1])
    sector = {c[0]: c[2] for c in corners if len(c) > 2 and c[2]}
    secs: list[Section] = []
    for c in found:
        inside = [(code, a) for code, a in official if c.start <= a < c.end or (c is found[-1] and a >= c.start)]
        near = [x for x in inside if abs(x[1] - c.apex) <= GROUP_WITHIN_M]
        far = [x for x in inside if abs(x[1] - c.apex) > GROUP_WITHIN_M]
        if not near and secs and not far:  # a slow point the track map has no number for: part of the last one
            secs[-1].end = c.end
            continue
        before = [x for x in far if x[1] < c.apex]
        after = [x for x in far if x[1] > c.apex]
        first, last = (near[0][1], near[-1][1]) if near else (c.apex, c.apex)
        # each flat kink a section of its own, split halfway between official positions
        cuts = [(a + b) // 2 for a, b in pairwise([*(x[1] for x in before), first])]
        ends = [(a + b) // 2 for a, b in pairwise([last, *(x[1] for x in after)])]
        for x, s0, e0 in zip(before, [c.start, *cuts], cuts, strict=False):
            secs.append(Section(x[0], s0, e0, None, [x[0]]))
        start, end = (cuts[-1] if cuts else c.start), (ends[0] if ends else c.end)
        if near:
            secs += _by_sector(near, start, end, c.apex, sector)
        else:
            secs.append(Section(f"C{len(secs) + 1}", start, end, c.apex))
        for x, s0, e0 in zip(after, ends, [*ends[1:], c.end], strict=False):
            secs.append(Section(x[0], s0, e0, None, [x[0]]))
    secs[0].start, secs[-1].end = 0, n - 1
    for a, b in pairwise(secs):
        b.start = a.end
    return _join_sectors(secs, sector, ref["speed"]), "official"


def _by_sector(near: list[tuple[str, int]], start: int, end: int, apex: int,
               sector: dict[str, str]) -> list[Section]:
    """The official corners around one slow point as one section, or one per sector when they belong to
    different sectors of the track (split halfway between them); the slow point goes to the corners nearest it."""
    runs: list[list[tuple[str, int]]] = []
    for x in near:
        if runs and sector.get(runs[-1][-1][0]) == sector.get(x[0]):
            runs[-1].append(x)
        else:
            runs.append([x])
    cuts = [(a[-1][1] + b[0][1]) // 2 for a, b in pairwise(runs)]
    nearest = min(range(len(runs)), key=lambda i: min(abs(a - apex) for _, a in runs[i]))
    return [Section(_label([x[0] for x in run]), s0, e0, apex if i == nearest else None, [x[0] for x in run])
            for i, (run, s0, e0) in enumerate(zip(runs, [start, *cuts], [*cuts, end], strict=True))]


def _join_sectors(secs: list[Section], sector: dict[str, str], speed: np.ndarray) -> list[Section]:
    """The sections whose corners all belong to one sector of the track become one section, with any section
    between them that has no official corner (a slow point the track map has no number for)."""
    if not sector:
        return secs

    def key(s: Section) -> str | None:
        names = {sector.get(code) for code in s.corners}
        return names.pop() if len(names) == 1 and None not in names else None

    out: list[Section] = []
    for s in secs:
        k, j = key(s), len(out) - 1
        while k is not None and j >= 0 and not out[j].corners:
            j -= 1
        if k is not None and j >= 0 and key(out[j]) == k:
            joined = [*out[j:], s]
            apexes = [x.apex for x in joined if x.apex is not None]
            apex = min(apexes, key=lambda a: speed[a]) if apexes else None
            out[j:] = [Section("", joined[0].start, s.end, apex, [code for x in joined for code in x.corners])]
        else:
            out.append(s)
    for s in out:
        if s.corners and key(s) is not None:  # a sector: first to last, however many corners it has
            s.code = s.corners[0] if len(s.corners) == 1 else f"{s.corners[0]}-{s.corners[-1]}"
    return out


def corner_sections(ref: dict[str, np.ndarray], corners: list[CornerSpec] | None = None) -> tuple[list[Corner], str]:
    """The reference lap's corners, numbered and grouped as the insights engine numbers its sections.

    With the track's official corners, each corner is labelled with the official numbers inside it ("T6",
    "T8/T9", a whole sector such as "T2-T5"); a flat kink is placed at its official position. Without them,
    the slowest points are numbered C1, C2... The second value says which: "official" or "detected".
    """
    sections, numbering = make_sections(ref, corners)
    at = {c[0]: int(c[1]) for c in corners or [] if c[1] is not None}
    out = []
    for s in sections:
        if s.apex is not None:
            apex = s.apex
        elif s.corners:
            apex = min((at[code] for code in s.corners), key=lambda a: ref["speed"][a])
        else:
            continue  # no corner anywhere on the lap
        out.append(Corner(s.code, apex, s.start, s.end))
    return out, numbering


def corner_metrics(tr: dict[str, np.ndarray], c: Corner, brake_on: float | None = None) -> dict:
    lo, apex, hi = c.start, c.apex, c.end
    brake = tr.get("brake")
    throttle = tr.get("throttle")
    out: dict = {"time": round(float(tr["t"][hi] - tr["t"][lo]), 3)}
    win = slice(max(lo, apex - 60), min(hi, apex + 60))
    i_min = win.start + int(np.argmin(tr["speed"][win]))
    out["min_speed"] = round(float(tr["speed"][i_min]), 1)
    out["min_speed_at"] = int(tr["distance"][i_min])
    bp = None
    threshold = 0.0
    if brake is not None:
        peak = float(brake[lo:hi].max())
        out["peak_brake"] = round(peak, 1)
        threshold = brake_on if brake_on is not None else 0.12 * peak
        if peak > 0:
            bp = next((lo + i for i, x in enumerate(brake[lo:apex]) if x > threshold), None)
        out["brake_point"] = int(tr["distance"][bp]) if bp is not None else None
    if throttle is not None:
        b0 = bp if bp is not None else lo
        released = brake[b0:hi] <= 0.3 * threshold if brake is not None else np.ones(hi - b0, bool)
        pairs = enumerate(zip(throttle[b0:hi], released, strict=True))
        on = next((b0 + i for i, (x, r) in pairs if x > 20 and r), None)
        full = next((on + i for i, x in enumerate(throttle[on:hi]) if x > 95), None) if on is not None else None
        out["throttle_on"] = int(tr["distance"][on]) if on is not None else None
        out["full_throttle"] = int(tr["distance"][full]) if full is not None else None
    return out


def analyze(data: SessionData, ref_number: int | None = None, corners: list[CornerSpec] | None = None) -> dict:
    """Corner-by-corner comparison of every clean lap against a reference lap (best by default).

    corners: the track's official corners, which number and group the corners (see corner_sections).
    """
    clean = [l for l in data.laps if l.clean]
    if not clean:
        return {"laps": [], "corners": []}
    ref = next((l for l in data.laps if l.number == ref_number), None) or min(clean, key=lambda l: l.time)
    length = round(lap_length(data, ref))
    traces = {l.number: lap_trace(data, l, length) for l in [*clean, ref]}
    found, numbering = corner_sections(traces[ref.number], corners)
    brake_on = None
    if "brake" in data.channels:
        brake_on = 0.12 * float(np.percentile(data.channels["brake"], 99.5))
    result_corners = []
    for c in found:
        per_lap = {n: corner_metrics(tr, c, brake_on) for n, tr in traces.items()}
        best = min(per_lap, key=lambda n: per_lap[n]["time"])
        result_corners.append({
            "code": c.code, "apex_m": c.apex, "start_m": c.start, "end_m": c.end,
            "best_lap": best, "laps": per_lap,
        })
    return {
        "reference_lap": ref.number,
        "length_m": length,
        "theoretical_best": round(sum(min(m["time"] for m in c["laps"].values()) for c in result_corners), 3),
        "laps": [{"number": l.number, "time": l.time, "clean": l.clean} for l in data.laps],
        "numbering": numbering,
        "corners": result_corners,
        "channels": data.sources,
    }


TRACE_ROLES = ("speed", "throttle", "brake", "steer", "gear", "rpm")


def compare_laps(data: SessionData, lap_number: int, ref_number: int | None = None, step: float = 5.0,
                 corners: list[CornerSpec] | None = None) -> dict:
    """Two laps on one distance grid for charting, with the running time gained or lost against the reference,
    and the reference lap's corners as analyze() numbers them.

    delta > 0 means the lap is behind the reference at that point.
    """
    clean = [l for l in data.laps if l.clean]
    ref = next((l for l in data.laps if l.number == ref_number), None) or min(clean or data.laps, key=lambda l: l.time)
    lap = next((l for l in data.laps if l.number == lap_number), None)
    if lap is None:
        raise ValueError(f"No lap {lap_number} in this file")
    length = round(lap_length(data, ref))
    a, b = lap_trace(data, ref, length, step), lap_trace(data, lap, length, step)
    found, numbering = corner_sections(lap_trace(data, ref, length), corners)

    def pack(tr: dict[str, np.ndarray]) -> dict[str, list[float]]:
        return {r: np.round(tr[r], 2).tolist() for r in TRACE_ROLES if r in tr}

    return {
        "reference_lap": ref.number, "lap": lap.number, "length_m": length, "step_m": step,
        "distance": a["distance"].round(1).tolist(),
        "reference": pack(a), "compare": pack(b),
        "delta": np.round(b["t"] - a["t"], 3).tolist(),
        "numbering": numbering,
        "corners": [{"code": c.code, "apex_m": c.apex, "start_m": c.start, "end_m": c.end} for c in found],
    }
