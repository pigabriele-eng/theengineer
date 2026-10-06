"""The shape of the road round the lap, from the car's own logs: banking, crests and compressions, and elevation.

Nothing is looked up in a database of tracks, so it works wherever the car has been, from whatever its logger
recorded (any part it can't tell is left out):

- Banking. On a banked road the lateral accelerometer, tilted with the car, reads the turn less the share of gravity
  along the road (c cos b - sin b), while the yaw-rate gyro times speed reads the turn itself (c cos b): the
  difference is sin b. The car's own scale between the two (gyro and speed calibration, body roll) is learned on its
  corners, most of which are flat. The car's sideslip comes and goes within a corner and reads as bank while it
  changes, so both are averaged over the time spent within BANK_WINDOW_M of each place, and the bank is told only
  where the car turns hard enough for it to show, and steadily (turn-in, exits and direction changes are left out).
  Without a gyro the bank is unknown (a banked corner's extra load then shows as a compression).
- Vertical load: the vertical accelerometer, which reads 1 g on the level, more in a dip or a banked corner (the
  bank turns some of the cornering into load: cos b + c sin b) and less over a crest. Without one, the load is
  estimated from the bank and from how the elevation profile curves (v² h'' / g).
- Crests and compressions: where the load is well below or above what the bank explains.
- Elevation: GPS altitude, where it repeats lap after lap. The slope of the road integrated round the lap (the
  longitudinal accelerometer against the change in speed) is no stand-in: cornering, sideslip and pitch leak into
  that accelerometer, and on real laps the profile it gives is several metres off over a lap, so without a sane GPS
  altitude the elevation is unknown.
"""
from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np

from app.analysis.channels import G
from app.analysis.local_limits import _moving

SHAPE_STEP_M = 5
MIN_LAP_M = 200
BANK_WINDOW_M = 25  # the bank at a place: the turning and lateral g averaged over the time within this of it
BANK_TURN_G = 0.5  # the bank is told only where the car turns at least this hard...
STEADY_G_PER_S = 0.5  # ...and steadily: the turn changing by less than this
CORNER_TURN_G = 0.3  # corners for learning the gyro's scale: turning at least this hard...
CORNER_EDGE_G = 0.1  # ...from where the turn starts to where it ends, so the sideslip is back to nothing
CORNER_MIN_M = 20
MIN_CORNERS = 3
MIN_LAPS = 3  # laps to compare with each other at each place
SCALE_RANGE = (0.7, 1.4)  # gyro turning over lateral g outside this: the gyro can't tell the bank
LOAD_WINDOW_M = 5  # vertical load averaged over this either side of a place
BANKED_DEG = 7.0  # a banked corner: at least this much toward the inside, for at least BANKED_MIN_M
BANKED_MIN_M = 25
LOAD_STEP_G = 0.15  # a crest or a compression: the load at least this far below or above what the bank explains
FEATURE_MIN_M = 20  # shorter is a kerb or a bump
FEATURE_GAP_M = 10  # stretches closer than this are one
ALT_SPREAD_M = 2.5  # GPS altitude is used when each lap's profile is within this (rms) of the laps' median
ALT_CLOSE_M = 2.0  # ... and the median profile meets itself at the timing line within this
ALT_MAX_RANGE_M = 400.0
ELEVATION_SMOOTH_M = 10
VERTICAL_CURVE_M = 30  # the elevation's curve, for the load where no vertical accelerometer was logged


@dataclass
class TrackShape:
    step_m: int  # point j is metre j * step_m of the lap line
    elevation_m: np.ndarray  # height relative to the lap's lowest point (nan when unknown)
    bank_deg: np.ndarray  # road bank, + = toward the inside of the corner; nan where unknown
    load_g: np.ndarray  # vertical load in g: 1.0 flat road, <1 crest, >1 compression or banking
    # {"kind": "banked" | "crest" | "compression", "start_m", "end_m", "value"}: value is the bank in degrees through
    # it (the median of the places told), or the load in g the crest or dip alone gives at its extreme (the load
    # less what the bank adds). A stretch through the timing line has start_m > end_m.
    features: list[dict] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {"step_m": self.step_m, "elevation_m": _rounded(self.elevation_m, 1),
                "bank_deg": _rounded(self.bank_deg, 1), "load_g": _rounded(self.load_g, 2),
                "features": [{**f, "value": round(float(f["value"]), 1 if f["kind"] == "banked" else 2)}
                             for f in self.features]}


def _rounded(x: np.ndarray, nd: int) -> list:
    return [None if not np.isfinite(v) else round(float(v), nd) for v in x]


def track_shape(traces: list[dict[str, np.ndarray]]) -> TrackShape | None:
    """The road's shape from laps on one line (traces as place_limits takes them: every metre from the timing line
    to the timing line, math channels included). None when the logs can't tell anything about it."""
    if not traces:
        return None
    n = len(traces[0]["speed"]) - 1
    if n < MIN_LAP_M:
        return None

    def rows(key: str) -> np.ndarray | None:
        if not all(key in tr for tr in traces):
            return None
        return np.array([np.asarray(tr[key][:n], np.float32) for tr in traces])  # laps x metres, in little memory

    v = rows("speed") / 3.6
    ay = rows("ay")
    dt = 1 / np.maximum(v, 5.0)  # seconds per metre
    turn = rows("turn_g")
    az = rows("az")
    elevation = _elevation(rows("altitude"))
    if turn is None and az is None and elevation is None:
        return None

    spent = {half: _moving(dt, half) for half in (BANK_WINDOW_M, LOAD_WINDOW_M)}

    def time_mean(x: np.ndarray, half: int) -> np.ndarray:
        return _moving(x * dt, half) / spent[half]

    # banking: the gyro's turning against the lateral accelerometer, on the gyro's own scale
    bank = np.full(n, np.nan)
    corners = _corners(_smooth(np.median(turn, axis=0), 10)) if turn is not None else []
    scale = _gyro_scale(turn, ay, dt, corners) if turn is not None else None
    if scale is not None:
        t_mean = time_mean(turn, BANK_WINDOW_M)
        med = np.median(t_mean, axis=0)
        sin_b = np.median(np.sign(med) * (t_mean / scale - time_mean(ay, BANK_WINDOW_M)), axis=0)
        steady = np.median(np.abs(np.gradient(t_mean, axis=1) * v), axis=0) <= STEADY_G_PER_S
        told = (np.abs(med) / scale >= BANK_TURN_G) & steady
        bank[told] = np.degrees(np.arcsin(np.clip(sin_b[told], -1, 1)))
        c = np.abs(np.median(time_mean(turn, LOAD_WINDOW_M), axis=0)) / scale
    else:
        c = np.abs(np.median(time_mean(ay, LOAD_WINDOW_M), axis=0))
    features = _stretches(np.nan_to_num(bank) >= BANKED_DEG, n, "banked", bank, np.nanmedian, BANKED_MIN_M)
    # the load the bank gives the cornering (cos b + c sin b) through each banked corner, its bank carried across the
    # places within it where it isn't told; elsewhere the small bank a flat corner reads is noise, not load
    banked = np.zeros(n, bool)
    for f in features:
        banked[np.arange(f["start_m"], f["end_m"] + 1 + (n if f["start_m"] > f["end_m"] else 0)) % n] = True
    b = np.zeros(n)
    for a, e, _ in corners:
        vals = bank[a:e + 1]
        ok = np.flatnonzero(np.isfinite(vals))
        if banked[a:e + 1].any() and len(ok):
            b[a:e + 1] = np.radians(np.interp(np.arange(len(vals)), ok, vals[ok]))
    from_bank = np.cos(b) + c * np.sin(b)

    # vertical load: measured, else what the bank and the curve of the road give
    if az is not None:
        az = _vertical(az, rows("ax"), ay)
        load = np.median(_moving(az, LOAD_WINDOW_M) / (2 * LOAD_WINDOW_M + 1), axis=0)
    else:
        load = from_bank.copy()
        if elevation is not None:
            h = _smooth(elevation, VERTICAL_CURVE_M)
            load += np.median(v, axis=0) ** 2 * np.gradient(np.gradient(h)) / G

    excess = load - from_bank
    features += _stretches(excess <= -LOAD_STEP_G, n, "crest", 1 + excess, np.nanmin)
    features += _stretches(excess >= LOAD_STEP_G, n, "compression", 1 + excess, np.nanmax)
    features.sort(key=lambda f: f["start_m"])

    at = np.arange(0, n, SHAPE_STEP_M)
    if elevation is not None:
        elev = elevation[at] - elevation[at].min()
    else:
        elev = np.full(len(at), np.nan)
    return TrackShape(SHAPE_STEP_M, elev, bank[at], load[at], features)


def _smooth(x: np.ndarray, half: int) -> np.ndarray:
    return _moving(x[None, :], half)[0] / (2 * half + 1)


def _vertical(az: np.ndarray, ax: np.ndarray | None, ay: np.ndarray) -> np.ndarray:
    """The vertical accelerometer as the road's load: a sensor not quite level in the car (a dash tilted toward the
    driver) also reads some of the braking, which would show every braking zone as a crest. That part is learned
    from how each lap differs from the others at the same place (the road is the same every lap, how hard the car
    brakes there is not) and taken out, and the level road reads 1 again."""
    if ax is None:
        return az
    if len(az) >= MIN_LAPS:
        d_az, d_ax = az - np.median(az, axis=0), ax - np.median(ax, axis=0)
        p = float(np.sum(d_az * d_ax) / max(float(np.sum(d_ax * d_ax)), 1e-9))
    else:  # too few laps to compare: what goes with the braking overall
        p = float(np.polyfit(ax.ravel(), az.ravel(), 1)[0])
    out = az - p * ax
    level = (np.abs(ax) < 0.1) & (np.abs(ay) < 0.1)
    ref = float(np.median(out[level])) if np.count_nonzero(level) > 100 else float(np.median(out))
    return out / ref if ref > 0.5 else out


def _corners(turn: np.ndarray) -> list[tuple[int, int, int]]:
    """Corners of the lap from its turning (median over the laps, g): (first metre, last metre, side)."""
    n = len(turn)
    out: list[list[int]] = []
    m = 0
    while m < n:
        s = int(np.sign(turn[m]))
        if s == 0 or s * turn[m] < CORNER_TURN_G:
            m += 1
            continue
        a, b = m, m
        while a > 0 and s * turn[a - 1] > CORNER_EDGE_G:
            a -= 1
        while b < n - 1 and s * turn[b + 1] > CORNER_EDGE_G:
            b += 1
        if out and out[-1][2] == s and a <= out[-1][1] + 1:
            out[-1][1] = b
        else:
            out.append([a, b, s])
        m = b + 1
    return [(a, b, s) for a, b, s in out if b - a >= CORNER_MIN_M]


def _gyro_scale(turn: np.ndarray, ay: np.ndarray, dt: np.ndarray, corners: list[tuple[int, int, int]]
                ) -> float | None:
    """The gyro's turning over the lateral accelerometer on a flat corner, for this car and logger: each corner's
    ratio over the whole corner (the sideslip is nothing at either end), the median over the laps, then over the
    corners (most of a track's corners are flat). None when there are too few corners or the two don't agree."""
    ratios = []
    for a, b, s in corners:
        w = dt[:, a:b + 1]
        t_sum = s * np.sum(turn[:, a:b + 1] * w, axis=1)
        a_sum = s * np.sum(ay[:, a:b + 1] * w, axis=1)
        ok = a_sum > CORNER_TURN_G * np.sum(w, axis=1)
        if np.count_nonzero(ok) * 2 >= len(ok):
            ratios.append(float(np.median(t_sum[ok] / a_sum[ok])))
    if len(ratios) < MIN_CORNERS:
        return None
    k = float(np.median(ratios))
    return k if SCALE_RANGE[0] <= k <= SCALE_RANGE[1] else None


def _elevation(altitude: np.ndarray | None) -> np.ndarray | None:
    """Height per metre (any zero) from GPS altitude, when every lap shows the same profile; else None."""
    if altitude is None or not np.all(np.isfinite(altitude)) or np.ptp(altitude) == 0:
        return None
    prof = altitude - altitude.mean(axis=1, keepdims=True)
    med = np.median(prof, axis=0)
    spread = float(np.median(np.sqrt(np.mean((prof - med) ** 2, axis=1))))
    if spread > ALT_SPREAD_M or abs(med[-1] - med[0]) > ALT_CLOSE_M or np.ptp(med) > ALT_MAX_RANGE_M:
        return None
    return _smooth(med, ELEVATION_SMOOTH_M)


def _stretches(mask: np.ndarray, n: int, kind: str, values: np.ndarray, pick, min_m: int = FEATURE_MIN_M
               ) -> list[dict]:
    """Stretches of the closed lap where mask holds: gaps under FEATURE_GAP_M closed, at least min_m long, each with
    the value over it that pick gives (np.nanmedian, np.nanmin or np.nanmax)."""
    idx = np.flatnonzero(mask)
    if not len(idx):
        return []
    runs = []
    start = prev = int(idx[0])
    for i in idx[1:]:
        if i - prev > FEATURE_GAP_M:
            runs.append([start, prev])
            start = int(i)
        prev = int(i)
    runs.append([start, prev])
    if len(runs) > 1 and runs[0][0] + n - runs[-1][1] <= FEATURE_GAP_M:  # through the timing line: one stretch
        runs[0][0] = runs.pop()[0] - n
    out = []
    for a, b in runs:
        if b - a + 1 < min_m:
            continue
        span = np.arange(a, b + 1) % n
        out.append({"kind": kind, "start_m": int(a % n), "end_m": int(b), "value": float(pick(values[span]))})
    return out
