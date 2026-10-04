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
    "gear": ("nGear", "Gear"),
    "rpm": ("nEngine", "Engine Speed", "RPM"),
    "lat": ("GPS Latitude",),
    "lon": ("GPS Longitude",),
    "g_lat": ("aLat [m/s/s]", "G Force Lat", "Lateral Accel"),
    "g_long": ("aLong [m/s/s]", "G Force Long", "Longitudinal Accel"),
}

MASTER_HZ = 100
CLEAN_LAP_MARGIN = 1.05  # a clean lap is within 5 % of the session's best


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


def load_session(ld: LdFile, channel_map: dict[str, tuple[str, ...]] | None = None) -> SessionData:
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
        v = np.interp(t, ch.times(), ch.values())
        if role == "brake":
            v = np.abs(v)  # some cars log brake torque as a negative number
        if role in ("g_lat", "g_long") and "m/s" in (ch.unit + ch.name):
            v = v / 9.81
        channels[role], sources[role] = v, ch.name
    distance = np.concatenate([[0.0], np.cumsum(channels["speed"][1:] / 3.6 / MASTER_HZ)])
    data = SessionData(t=t, distance=distance, channels=channels, sources=sources)
    data.laps = split_laps(ld)
    return data


def split_laps(ld: LdFile) -> list[Lap]:
    """Lap boundaries from the start/finish marker, falling back to the lap counter."""
    starts: np.ndarray | None = None
    sf = ld.channel("S/F Marker", "Start Finish", "SF Marker")
    if sf is not None:
        v = sf.values()
        starts = sf.times()[1:][np.diff(v) > 0]
    if starts is None or len(starts) < 2:
        ln = ld.channel("Lap Number", "Lap")
        if ln is None:
            return []
        v = ln.values()
        starts = ln.times()[1:][np.diff(v) != 0]
    lap_time = ld.channel("Lap Time")
    laps = []
    for i in range(len(starts) - 1):
        a, b = float(starts[i]), float(starts[i + 1])
        time = b - a
        if lap_time is not None:
            # the dash publishes the completed lap's time shortly after the line
            k = min(np.searchsorted(lap_time.times(), b + 1.5), lap_time.count - 1)
            logged = float(lap_time.values()[k])
            if abs(logged - time) < 1.0:
                time = logged
        laps.append(Lap(number=i + 1, start=a, end=b, time=round(time, 3)))
    if laps:
        best = min(l.time for l in laps)
        for l in laps:
            l.clean = l.time <= best * CLEAN_LAP_MARGIN
    return laps


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
