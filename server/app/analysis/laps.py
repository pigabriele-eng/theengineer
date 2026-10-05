"""Lap splitting, distance alignment, corner detection and corner metrics.

Works on any logger once its channels are mapped to the standard roles below.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from itertools import pairwise

import numpy as np

from app.importers.motec import LdFile

# Standard channel roles and the logger channel names that can fill them, in order of preference.
DEFAULT_CHANNEL_MAP: dict[str, tuple[str, ...]] = {
    "speed": ("vCar", "Ground Speed", "Corr Speed", "GPS Speed", "Speed"),
    "throttle": ("rThrottlePedal", "Throttle Pedal", "Throttle Pos", "TPS", "rThrottle"),
    "brake": ("Brake Pressure Front", "pBrakeF", "Brake Press Front", "Brake Torque", "Brake Pressure"),
    "steer": ("aSteer", "Steered Angle", "Steering Angle", "Steering"),
    "gear": ("nGear", "NGearPos", "Gear"),
    "rpm": ("nEngine", "Engine Speed", "RPM"),
    "lat": ("GPS Latitude",),
    "lon": ("GPS Longitude",),
    "g_lat": ("gLat", "aLat [m/s/s]", "G Force Lat", "Lateral Accel"),
    "g_long": ("gLong", "aLong [m/s/s]", "G Force Long", "Longitudinal Accel"),
    "yaw": ("nYaw", "Yaw Rate", "Gyro Yaw Velocity", "Yaw Velocity"),
    "steer_wheel": ("aSteerWheel", "Steering Wheel Angle"),
    "brake_rear": ("pBrakeR", "Brake Pressure Rear", "Brake Press Rear"),
    "wheel_fl": ("nWheelFL", "vWheelFL", "Wheel Speed FL"),
    "wheel_fr": ("nWheelFR", "vWheelFR", "Wheel Speed FR"),
    "wheel_rl": ("nWheelRL", "vWheelRL", "Wheel Speed RL"),
    "wheel_rr": ("nWheelRR", "vWheelRR", "Wheel Speed RR"),
    "tc": ("BInterventionCauseTC", "TC Active", "TC Intervention"),
    "abs": ("NAbs", "ABS Active"),
    "tyre_p_fl": ("pTyreFL", "Tyre Pres FL"), "tyre_p_fr": ("pTyreFR", "Tyre Pres FR"),
    "tyre_p_rl": ("pTyreRL", "Tyre Pres RL"), "tyre_p_rr": ("pTyreRR", "Tyre Pres RR"),
    "tyre_t_fl": ("TTyreFL", "Tyre Temp FL"), "tyre_t_fr": ("TTyreFR", "Tyre Temp FR"),
    "tyre_t_rl": ("TTyreRL", "Tyre Temp RL"), "tyre_t_rr": ("TTyreRR", "Tyre Temp RR"),
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


@dataclass
class TimingLine:
    """The start/finish line as a GPS point and the direction of travel through it."""
    lat: float
    lon: float
    heading: float  # degrees clockwise from north


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
                 beacons: list[float] | None = None, line: TimingLine | None = None) -> SessionData:
    cmap = {**DEFAULT_CHANNEL_MAP, **(channel_map or {})}
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
    data.laps, data.lap_source = split_laps(ld, beacons, line)
    if data.lap_source in ("beacons", "marker"):
        data.timing_line = timing_line_at(ld, [l.start for l in data.laps])
    else:
        data.timing_line = line
    return data


def _gps(ld: LdFile):
    lat, lon = ld.channel("GPS Latitude"), ld.channel("GPS Longitude")
    if lat is None or lon is None:
        return None
    t = lat.times()
    la, lo = lat.values().astype(float), np.interp(t, lon.times(), lon.values()).astype(float)
    ok = (np.abs(la) > 0.1) & (np.abs(lo) > 0.1)  # no fix logs as zeros
    return t[ok], la[ok], lo[ok]


def _local_m(la: np.ndarray, lo: np.ndarray, lat0: float, lon0: float) -> tuple[np.ndarray, np.ndarray]:
    r = 6_371_000.0
    return (np.radians(lo - lon0) * r * np.cos(np.radians(lat0)), np.radians(la - lat0) * r)


def timing_line_at(ld: LdFile, times: list[float]) -> TimingLine | None:
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
    return TimingLine(lat0, lon0, heading)


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


def lap_starts(ld: LdFile, beacons: list[float] | None = None,
               line: TimingLine | None = None) -> tuple[np.ndarray, str]:
    """Line-crossing times, from the most precise source the log offers."""
    if beacons and len(beacons) >= 2:
        return np.asarray(beacons, float), "beacons"
    sf = ld.channel("S/F Marker", "Start Finish", "SF Marker")
    if sf is not None:
        starts = sf.times()[1:][np.diff(sf.values()) > 0]
        if len(starts) >= 2:
            return starts, "marker"
    if line is not None:
        starts = gps_crossings(ld, line)
        if len(starts) >= 2:
            return starts, "gps"
    ln = ld.channel("Lap Number", "Lap")
    if ln is not None:
        starts = ln.times()[1:][np.diff(ln.values()) != 0]
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
    """Corners are speed minima that sit well below the surrounding straights."""
    v = _smooth(ref["speed"])
    n = len(v)
    apexes = [i for i in range(60, n - 60)
              if v[i] == v[i - 60:i + 61].min() and v[max(0, i - 150):i + 151].max() - v[i] > min_drop_kmh]
    bounds = [0]
    for a, b in pairwise(apexes):
        bounds.append(max(bounds[-1] + 1, a + int(np.argmax(v[a:b])) - 40))
    bounds.append(n - 1)
    return [Corner(f"T{i + 1}", a, bounds[i], bounds[i + 1]) for i, a in enumerate(apexes)]


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


def analyze(data: SessionData, ref_number: int | None = None) -> dict:
    """Corner-by-corner comparison of every clean lap against a reference lap (best by default)."""
    clean = [l for l in data.laps if l.clean]
    if not clean:
        return {"laps": [], "corners": []}
    ref = next((l for l in data.laps if l.number == ref_number), None) or min(clean, key=lambda l: l.time)
    length = round(lap_length(data, ref))
    traces = {l.number: lap_trace(data, l, length) for l in [*clean, ref]}
    corners = detect_corners(traces[ref.number])
    brake_on = None
    if "brake" in data.channels:
        brake_on = 0.12 * float(np.percentile(data.channels["brake"], 99.5))
    result_corners = []
    for c in corners:
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
        "corners": result_corners,
        "channels": data.sources,
    }


TRACE_ROLES = ("speed", "throttle", "brake", "steer", "gear", "rpm")


def compare_laps(data: SessionData, lap_number: int, ref_number: int | None = None, step: float = 5.0) -> dict:
    """Two laps on one distance grid for charting, with the running time gained or lost against the reference.

    delta > 0 means the lap is behind the reference at that point.
    """
    clean = [l for l in data.laps if l.clean]
    ref = next((l for l in data.laps if l.number == ref_number), None) or min(clean or data.laps, key=lambda l: l.time)
    lap = next((l for l in data.laps if l.number == lap_number), None)
    if lap is None:
        raise ValueError(f"No lap {lap_number} in this file")
    length = round(lap_length(data, ref))
    a, b = lap_trace(data, ref, length, step), lap_trace(data, lap, length, step)

    def pack(tr: dict[str, np.ndarray]) -> dict[str, list[float]]:
        return {r: np.round(tr[r], 2).tolist() for r in TRACE_ROLES if r in tr}

    return {
        "reference_lap": ref.number, "lap": lap.number, "length_m": length, "step_m": step,
        "distance": a["distance"].round(1).tolist(),
        "reference": pack(a), "compare": pack(b),
        "delta": np.round(b["t"] - a["t"], 3).tolist(),
    }
