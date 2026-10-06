"""Perfect driving: a line taken at the limits the car has shown at every place of the track (local_limits.py).

A quasi-steady-state lap simulation. The line's curvature and the cornering the car has shown at each place cap the
speed through every corner; the car then accelerates out of each one and brakes into the next as hard as it has
shown it can at that place while cornering that hard, and at full throttle as its power curve and the place allow.

One model serves the report's theoretical lap and realistic target, the scores, and the technique check's perfect
driving from any point of a lap (technique.Envelope), so they always agree.
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from app.analysis.channels import G
from app.analysis.local_limits import PlaceLimits, smoothed_curvature

AY_STEP = 0.01  # g, lookup resolution
AY_MAX = 4.0
TOP_SPEED_MARGIN = 1.02  # perfect driving may beat the laps' top speed by this much (a better exit)
MIN_CORNER_G = 0.05  # where the laps never turned, a straight line is not a corner
LIMITED_BY = ("corner", "accel", "brake")


@dataclass
class SimLap:
    speed: np.ndarray  # km/h per grid point
    t: np.ndarray  # s, elapsed at each grid point
    time: float
    limited_by: np.ndarray  # index into LIMITED_BY per grid point


class LapModel:
    """Perfect driving on one closed line of n metres (curvature per metre, the timing line at metre 0).

    P is perfect driving's speed (m/s) at metres 0..n (the timing line at both ends): the lower of F, accelerating
    from the corner before, and B, braking for the corner ahead. cum is its time to each metre."""

    def __init__(self, curvature: np.ndarray, lim: PlaceLimits):
        k = smoothed_curvature(curvature)
        n = len(k)
        at = lim.metre_index(n)
        place = lim.place_of(at)
        v_top = lim.top_speed * TOP_SPEED_MARGIN / 3.6
        vc = np.minimum(np.sqrt(np.maximum(lim.corner[place], MIN_CORNER_G) * G / k), v_top)
        self._acc, self._brk, cols = lim.tables(AY_STEP, AY_MAX)
        self.n = n
        self.lim = lim
        self.na = cols - 1
        self.vc = np.append(vc, vc[0])  # m/s, the speed each metre's cornering allows
        self.k = np.append(k, k[0]).tolist()
        self.base = (np.append(place, place[0]) * cols).tolist()  # where each metre's place starts in the tables
        self.drive = np.append(lim.drive[at], lim.drive[at[0]]).tolist()
        self.grade = np.append(lim.grade[at], lim.grade[at[0]])  # g per metre, for comparing a lap's accelerometer
        self._vc = self.vc.tolist()
        self._power = lim.power

        # forward two laps from the timing line, so the line is crossed at the speed the lap really carries
        fwd = [0.0] * (2 * n + 1)
        fwd[0] = self._vc[0]
        for i in range(2 * n):
            fwd[i + 1] = self.step_up(i % n, fwd[i])
        # braking back from every corner, two laps so the corners just after the line count at its end
        bwd = self._vc[:-1] * 2 + [self._vc[0]]
        for i in range(2 * n - 1, -1, -1):
            v = bwd[i + 1]
            b = self.brake_at((i + 1) % n, v)
            bwd[i] = min(bwd[i], (v * v + 2 * b * G) ** 0.5)
        self.F = fwd[n:]
        self.B = bwd[:n + 1]
        self.P = np.minimum(np.array(self.F), np.array(self.B))
        seg = 2 / (self.P[:-1] + self.P[1:])
        self.cum = np.concatenate([[0.0], np.cumsum(seg)])  # perfect driving's time to each metre

    def _ay(self, v: float, i: int) -> int:
        return min(int(v * v * self.k[i] / G / AY_STEP + 0.5), self.na)

    def power_at(self, i: int, v: float) -> float:
        """Acceleration (g) at full throttle at metre i at v (m/s): the power curve plus the place's own part."""
        c0, c1, c2 = self._power
        s = max(v, 30 / 3.6)
        return c0 / s + c1 + c2 * s * s + self.drive[i]

    def grip_accel_at(self, i: int, v: float) -> float:
        """Acceleration (g) the grip allows at metre i at v (m/s), cornering as the line asks."""
        return self._acc[self.base[i] + self._ay(v, i)]

    def brake_at(self, i: int, v: float) -> float:
        """Deceleration (g) the car has shown at metre i cornering as the line asks at v (m/s)."""
        return self._brk[self.base[i] + self._ay(v, i)]

    def brake_limit(self, i: int, ay: float) -> float:
        """Deceleration (g) the car has shown at metre i while cornering at ay (g)."""
        return self._brk[self.base[i] + min(int(abs(ay) / AY_STEP + 0.5), self.na)]

    def step_up(self, i: int, v: float) -> float:
        """Speed at metre i + 1 accelerating as hard as the car can from v (m/s) at metre i."""
        a = min(self.grip_accel_at(i, v), self.power_at(i, v))
        return min(max(v * v + 2 * a * G, 1.0) ** 0.5, self._vc[i + 1])

    def power_limited(self, v: float, i: int) -> bool:
        """True where the car could be at full throttle: the engine, not the grip, limits the acceleration."""
        return self.grip_accel_at(i, v) >= self.power_at(i, v) - 1e-4

    def sim(self) -> SimLap:
        """The closed lap, timing line at both ends."""
        F = np.array(self.F)
        limited = np.where(self.P < F - 1e-6, 2, np.where(np.isclose(self.P, self.vc, rtol=1e-3), 0, 1))
        return SimLap(self.P * 3.6, self.cum.copy(), float(self.cum[-1]), limited)


def theoretical_lap(curvature: np.ndarray, lim: PlaceLimits) -> SimLap:
    """Fastest lap on a closed line with the given curvature (1/m per metre, the timing line at both ends)."""
    return LapModel(np.asarray(curvature, float)[:-1], lim).sim()
