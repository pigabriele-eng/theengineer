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
CHUNK = 200  # positions placed on the line at once: a few MB a step on a 5 km line
COARSE = 32  # project takes the line in blocks of this many points


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
    """Nearest point on the line (metres from the timing line) and the distance to it, for each position.

    Each position is measured only against the stretches of line that can hold its nearest point. The line is taken
    in blocks of COARSE points: a block can hold it only when the block's first point is no further from the
    position than the nearest first point is, plus how far the block strays from its first point. The sums are the
    ones made against the whole line, so the answer is too (the first of equally near points), in a fraction of the
    time."""
    x, y = line.xy(lat, lon)
    dist = np.empty(len(x), int)
    off = np.empty(len(x))
    lx, ly = line.x.astype(np.float32), line.y.astype(np.float32)
    n = len(lx)
    cx, cy = lx[::COARSE], ly[::COARSE]  # each block's first point
    bx, by = (np.pad(v.astype(float), (0, -n % COARSE), mode="edge").reshape(-1, COARSE) for v in (lx, ly))
    stray = np.hypot(bx - bx[:, :1], by - by[:, :1]).max(1) + 0.01
    ks = np.arange(COARSE)

    def whole(at: slice | np.ndarray, px: np.ndarray, py: np.ndarray) -> None:
        d2 = (px[:, None] - lx) ** 2 + (py[:, None] - ly) ** 2
        dist[at] = d2.argmin(1)
        off[at] = np.sqrt(d2.min(1))

    for i in range(0, len(x), CHUNK):
        px, py = x[i:i + CHUNK].astype(np.float32), y[i:i + CHUNK].astype(np.float32)
        fix = np.isfinite(px) & np.isfinite(py)
        if not fix.all():  # a position without a fix is measured against the whole line, as before
            whole(np.flatnonzero(~fix) + i, px[~fix], py[~fix])
            px, py = px[fix], py[fix]
        if not len(px):
            continue
        c = np.sqrt(((px[:, None] - cx) ** 2 + (py[:, None] - cy) ** 2).astype(float))
        reach = c.min(1) * 1.001 + 0.01
        p, b = np.nonzero(c <= reach[:, None] + stray)  # by position, then block: each position has one at least
        if len(b) * 4 > c.size:  # far from the line (the pit lane, the paddock): most of it is near enough
            whole(np.flatnonzero(fix) + i, px, py)
            continue
        j = (b[:, None] * COARSE + ks).ravel()
        p = np.repeat(p, COARSE)
        keep = j < n
        j, p = j[keep], p[keep]
        d2 = (px[p] - lx[j]) ** 2 + (py[p] - ly[j]) ** 2
        least = np.minimum.reduceat(d2, np.flatnonzero(np.r_[True, p[1:] != p[:-1]]))
        hit = np.flatnonzero(d2 == least[p])
        first = hit[np.r_[True, p[hit][1:] != p[hit][:-1]]]  # of the nearest points, the first along the line
        dist[np.flatnonzero(fix) + i] = j[first]
        off[np.flatnonzero(fix) + i] = np.sqrt(least)
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
