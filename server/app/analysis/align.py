"""Laps placed on one track line by GPS, so laps from different runs and drivers meet metre for metre.

Wheel-speed distance drifts with tyre growth, wheelspin and lock-ups; GPS position does not. Where GPS
drops out or jumps, the wheel-speed distance fills the gap.
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from app.analysis.laps import MASTER_HZ, Lap, SessionData, _local_m, lap_length

GPS_HZ = 10  # positions used for alignment; plenty at racing speeds
MAX_OFFSET_M = 30  # further from the line than this is the pit lane or a GPS error
MAX_JUMP_M = 150  # disagreement with wheel-speed distance beyond this is a GPS error
DRIFT_SMOOTH_S = 4.0  # GPS against wheel-speed distance is averaged over this long
PAD_S = 1.5  # seconds either side of the lap marker searched for the real line crossing
CHUNK = 200  # positions measured against the whole line at once: about 4 MB a step on a 5 km line


@dataclass
class TrackLine:
    """The reference lap's path, one point per metre from the timing line."""
    lat0: float
    lon0: float
    x: np.ndarray
    y: np.ndarray

    @property
    def length(self) -> int:
        return len(self.x)

    def xy(self, lat: np.ndarray, lon: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        return _local_m(lat, lon, self.lat0, self.lon0)

    def to_dict(self, step: int = 10) -> dict:
        return {"x": np.round(self.x[::step], 1).tolist(), "y": np.round(self.y[::step], 1).tolist(), "step_m": step}


def has_gps(data: SessionData) -> bool:
    return "lat" in data.channels and "lon" in data.channels


def track_line(data: SessionData, lap: Lap, length: int | None = None) -> TrackLine | None:
    if not has_gps(data):
        return None
    length = length or round(lap_length(data, lap))
    i0, i1 = round(lap.start * MASTER_HZ), min(round(lap.end * MASTER_HZ), len(data.t) - 1)
    d = data.distance[i0:i1 + 1] - data.distance[i0]
    d = d / d[-1] * length
    grid = np.arange(length)
    la = np.interp(grid, d, data.channels["lat"][i0:i1 + 1])
    lo = np.interp(grid, d, data.channels["lon"][i0:i1 + 1])
    lat0, lon0 = float(la.mean()), float(lo.mean())
    x, y = _local_m(la, lo, lat0, lon0)
    return TrackLine(lat0, lon0, x, y)


def project(line: TrackLine, lat: np.ndarray, lon: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Nearest point on the line (metres from the timing line) and the distance to it, for each position."""
    x, y = line.xy(lat, lon)
    dist = np.empty(len(x), int)
    off = np.empty(len(x))
    lx, ly = line.x.astype(np.float32), line.y.astype(np.float32)
    for i in range(0, len(x), CHUNK):
        d2 = (x[i:i + CHUNK, None].astype(np.float32) - lx) ** 2 + (y[i:i + CHUNK, None].astype(np.float32) - ly) ** 2
        dist[i:i + CHUNK] = d2.argmin(1)
        off[i:i + CHUNK] = np.sqrt(d2.min(1))
    return dist, off


def lap_position(data: SessionData, lap: Lap, line: TrackLine | None, length: int | None = None
                 ) -> tuple[np.ndarray, np.ndarray]:
    """Samples from just before the lap to just after it, and where each sits on the line (metres from the
    timing line, never going backwards; negative before the line, beyond the length after it)."""
    length = line.length if line is not None else (length or round(lap_length(data, lap)))
    s0, s1 = round(lap.start * MASTER_HZ), min(round(lap.end * MASTER_HZ), len(data.t) - 1)
    pad = round(PAD_S * MASTER_HZ)
    idx = np.arange(max(s0 - pad, 0), min(s1 + pad, len(data.t) - 1) + 1)
    dw = (data.distance[idx] - data.distance[s0]) / max(data.distance[s1] - data.distance[s0], 1.0) * length
    if line is None or not has_gps(data):
        return idx, dw
    step = MASTER_HZ // GPS_HZ
    sub = idx[::step]
    dg, off = project(line, data.channels["lat"][sub], data.channels["lon"][sub])
    d = np.interp(idx, sub, dg.astype(float))
    off = np.interp(idx, sub, off)
    # the line repeats every lap: take the copy nearest the wheel-speed estimate
    d = d + length * np.round((dw - d) / length)
    good = (np.abs(d - dw) <= MAX_JUMP_M) & (off <= MAX_OFFSET_M)
    if np.count_nonzero(good) < MASTER_HZ:
        return idx, dw
    # GPS says where the car is, wheel speed says how far it moved from one sample to the next. GPS steps
    # a few metres at a time, so only its slow drift against wheel speed is kept.
    drift = np.interp(idx, idx[good], (d - dw)[good])
    w = round(DRIFT_SMOOTH_S * MASTER_HZ) | 1
    drift = np.convolve(np.pad(drift, w // 2, mode="edge"), np.ones(w) / w, "valid")
    return idx, np.maximum.accumulate(dw + drift)


def aligned_trace(data: SessionData, lap: Lap, line: TrackLine | None, length: int | None = None,
                  step: float = 1.0) -> dict[str, np.ndarray]:
    """One lap on a distance grid from the timing line to the timing line, both ends included.

    Time runs from the moment the car is on the line at 0 m to the moment it is back on it, found from its
    position rather than from the lap marker: a 10 Hz marker is up to 0.1 s off, and that error would
    otherwise land on the first or last metres of the lap.
    """
    idx, d = lap_position(data, lap, line, length)
    length = line.length if line is not None else (length or round(lap_length(data, lap)))
    grid = np.arange(0, length + step / 2, step)
    tt = data.t[idx]
    t0 = float(np.interp(0.0, d, tt))
    out = {"distance": grid, "t": np.interp(grid, d, tt) - t0}
    for role, v in data.channels.items():
        out[role] = np.interp(grid, d, v[idx])
    return out
