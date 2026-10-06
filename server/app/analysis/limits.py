"""The car's limits, learned from its own laps: no setup sheet, tyre model or reference lap needed.

The grip envelope (g-g diagram) is the 98th percentile of combined g in each direction and speed band: what
the car has shown it can do, often, not a single spike. Straight-line braking and power-limited acceleration
are kept against speed in finer steps, because downforce and drag change them along a straight. Full-throttle
acceleration is the upper quartile, gear changes included: the driver cannot add to it.

This envelope measures how much of its grip a lap used. The theoretical lap and the realistic target drive at the
limits the car has shown at each place instead (local_limits.py): one envelope for the whole track would lend one
corner's grip (a banked one, say) to every other.
"""
from __future__ import annotations

from dataclasses import dataclass
from itertools import pairwise

import numpy as np

from app.analysis.channels import BRAKE, POWER

DIRECTIONS = np.arange(-90, 91, 10)  # -90 pure braking, 0 pure cornering, +90 pure acceleration
SPEED_BANDS = 4
LIMIT_PERCENTILE = 98
ACCEL_PERCENTILE = 75
GRIP_SIDE_DEG = 30  # directions up to this are limited by grip rather than engine power
MIN_SAMPLES = 30
STRAIGHT_STEP_KMH = 10


@dataclass
class CarLimits:
    speeds: np.ndarray  # band centres, km/h
    envelope: np.ndarray  # g, [speed band, direction]
    line_speeds: np.ndarray  # km/h, for the straight-line limits
    accel: np.ndarray  # g, power or traction limited, along a straight
    brake: np.ndarray  # g (positive), along a straight
    top_speed: float  # km/h

    def grip(self, v: np.ndarray, direction: np.ndarray) -> np.ndarray:
        """Combined g the car can pull at this speed in this direction (bilinear in speed and direction)."""
        vi = np.clip(np.interp(v, self.speeds, np.arange(len(self.speeds))), 0, len(self.speeds) - 1)
        dj = np.clip(np.interp(direction, DIRECTIONS, np.arange(len(DIRECTIONS))), 0, len(DIRECTIONS) - 1)
        i0 = np.floor(vi).astype(int)
        i1 = np.minimum(i0 + 1, len(self.speeds) - 1)
        j0 = np.floor(dj).astype(int)
        j1 = np.minimum(j0 + 1, len(DIRECTIONS) - 1)
        fi, fj = vi - i0, dj - j0
        e = self.envelope
        return ((e[i0, j0] * (1 - fj) + e[i0, j1] * fj) * (1 - fi) + (e[i1, j0] * (1 - fj) + e[i1, j1] * fj) * fi)

    def use(self, v: np.ndarray, ax: np.ndarray, ay: np.ndarray) -> np.ndarray:
        """Share of the available grip in use (1 = at the car's demonstrated limit)."""
        direction = np.degrees(np.arctan2(ax, np.abs(ay)))
        return np.clip(np.hypot(ax, ay) / np.maximum(self.grip(v, direction), 0.1), 0, 1.25)

    def max_lateral(self, v: np.ndarray) -> np.ndarray:
        return self.grip(v, np.zeros_like(np.asarray(v, float)))

    def to_dict(self) -> dict:
        return {
            "speeds_kmh": np.round(self.speeds, 0).tolist(), "directions_deg": DIRECTIONS.tolist(),
            "envelope_g": np.round(self.envelope, 3).tolist(),
            "line_speeds_kmh": self.line_speeds.tolist(),
            "accel_g": np.round(self.accel, 3).tolist(), "brake_g": np.round(self.brake, 3).tolist(),
            "top_speed_kmh": round(self.top_speed, 1),
        }


def _fill(x: np.ndarray, y: np.ndarray) -> np.ndarray:
    ok = ~np.isnan(y)
    if not ok.any():
        return np.zeros_like(y)
    return np.interp(x, x[ok], y[ok])


def car_limits(traces: list[dict[str, np.ndarray]]) -> CarLimits:
    """Limits from the clean laps' traces (on a distance grid, with math channels)."""
    pool = {k: np.concatenate([tr[k] for tr in traces]) for k in ("speed", "ax", "ay", "phase")}
    v, ax, ay, phase = pool["speed"], pool["ax"], pool["ay"], np.rint(pool["phase"])
    full = np.concatenate([tr["throttle"] for tr in traces]) >= 95 if all("throttle" in tr for tr in traces) else None
    cg = np.hypot(ax, ay)
    direction = np.degrees(np.arctan2(ax, np.abs(ay)))

    moving = v > 40
    edges = np.percentile(v[moving], np.linspace(0, 100, SPEED_BANDS + 1)) if moving.any() else np.array([40, 300])
    edges[-1] += 1
    speeds = np.array([np.median(v[(v >= a) & (v < b)]) for a, b in pairwise(edges)])
    env = np.full((len(speeds), len(DIRECTIONS)), np.nan)
    for i, (a, b) in enumerate(pairwise(edges)):
        band = (v >= a) & (v < b)
        for j, d in enumerate(DIRECTIONS):
            m = band & (np.abs(direction - d) <= 5)
            if np.count_nonzero(m) >= MIN_SAMPLES:
                env[i, j] = np.percentile(cg[m], LIMIT_PERCENTILE)
    for i in range(len(speeds)):
        env[i] = _fill(DIRECTIONS.astype(float), env[i])
        env[i] = np.convolve(np.pad(env[i], 1, mode="edge"), [0.25, 0.5, 0.25], "valid")
    # Fast corners are often taken flat, below the grip limit, so their samples understate it. Tyres and
    # downforce lose nothing with speed, so cornering and braking grip never fall as speed rises.
    grip_side = DIRECTIONS <= GRIP_SIDE_DEG
    env[:, grip_side] = np.maximum.accumulate(env[:, grip_side], axis=0)

    top = float(np.percentile(v, 99.9))
    line_speeds = np.arange(0, top + STRAIGHT_STEP_KMH, STRAIGHT_STEP_KMH, dtype=float)
    acc = np.full(len(line_speeds), np.nan)
    brk = np.full(len(line_speeds), np.nan)
    straight = np.abs(ay) < 0.3
    for k, s in enumerate(line_speeds):
        near = straight & (np.abs(v - s) <= STRAIGHT_STEP_KMH / 2)
        a = near & (full if full is not None else (phase == POWER) & (ax > 0))
        b = near & (phase == BRAKE)
        if np.count_nonzero(a) >= 3 * MIN_SAMPLES:
            acc[k] = np.percentile(ax[a], ACCEL_PERCENTILE if full is not None else 75)
        if np.count_nonzero(b) >= MIN_SAMPLES:
            brk[k] = np.percentile(-ax[b], LIMIT_PERCENTILE)
    lim = CarLimits(speeds, env, line_speeds, acc, brk, top)
    lim.accel = _power_curve(line_speeds, acc, lim)
    # where braking never happened at a speed, fall back on the envelope's pure braking
    brk = np.where(np.isnan(brk), lim.grip(line_speeds, np.full(len(line_speeds), -90.0)), brk)
    lim.brake = np.maximum(np.convolve(np.pad(brk, 1, mode="edge"), [0.25, 0.5, 0.25], "valid"), 0.1)
    return lim


def _power_curve(speeds: np.ndarray, acc: np.ndarray, lim: CarLimits) -> np.ndarray:
    """Full-throttle acceleration against speed as engine power over speed less drag: a = P/v + r - c v^2.

    Fitted where straights give plenty of samples, so the slow end (where exits are rarely straight) follows
    the physics instead of a handful of samples; grip then caps it through the envelope.
    """
    ok = ~np.isnan(acc) & (speeds >= 60)
    fallback = lim.grip(speeds, np.full(len(speeds), 90.0))
    if np.count_nonzero(ok) < 3:
        return np.where(np.isnan(acc), fallback, acc)
    s = speeds[ok] / 3.6
    coef, *_ = np.linalg.lstsq(np.c_[1 / s, np.ones(len(s)), s**2], acc[ok], rcond=None)
    sv = np.maximum(speeds, 30) / 3.6
    fit = coef[0] / sv + coef[1] + coef[2] * sv**2
    return np.maximum(fit, 0.0)
