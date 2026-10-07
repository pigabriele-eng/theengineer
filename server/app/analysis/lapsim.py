"""Perfect driving: a line taken at the limits the car has shown at every place of the track (local_limits.py).

A quasi-steady-state lap simulation. The line's curvature and the cornering the car has shown at each place cap the
speed through every corner; the car then accelerates out of each one and brakes into the next as hard as it has
shown it can at that place while cornering that hard, and at full throttle as its power curve and the place allow.

A model is only a model: fed only the fastest lap's own limits, it still drives that lap's own line about a second
quicker than the lap itself (the limits are each place's best over a few metres either side, and no lap is driven
at the limit everywhere). So every target is calibrated on the fastest lap (Calibration): its real time and speed
at every metre, plus what perfect driving at the target's limits gains over perfect driving at that lap's own limits
there. The model's own error cancels, and each place gains only what other laps really showed beyond the fastest lap.

One model and one calibration serve the report's theoretical lap and realistic target, the scores, and the technique
check's perfect driving from any point of a lap (technique.Envelope), so they always agree.
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
    """Fastest lap on a closed line with the given curvature (1/m per metre, the timing line at both ends), as the
    model drives it (not calibrated)."""
    return LapModel(np.asarray(curvature, float)[:-1], lim).sim()


@dataclass
class Calibration:
    """The model's own error along the fastest lap, metre by metre: the lap's real time and speed against perfect
    driving at its own limits on its line (local_limits.place_limits own=True). Every point of the line's distance
    grid, the timing line at both ends. For the theoretical lap, also what it takes from the best pass of a section
    that is quicker than it, or gives back where it would beat every pass the car has really made (to_best)."""
    t: np.ndarray  # s to each metre: the fastest lap's real time
    speed: np.ndarray  # km/h: its real speed
    own: SimLap  # perfect driving at its own limits on its line
    best_t: np.ndarray | None = None  # s to each metre (none above zero): where a section's best pass is quicker
    best_v: np.ndarray | None = None  # km/h at each metre: the same for its speed

    @classmethod
    def of(cls, reference: dict[str, np.ndarray], lap_time: float, own: SimLap) -> Calibration:
        """From the fastest lap's trace (its "t" if it has one, else its speed) and its lap time, which its time to
        each metre is scaled to (the trace's own timing is a hair off the lap's)."""
        v = np.asarray(reference["speed"], float)
        if "t" in reference:
            t = np.asarray(reference["t"], float) - float(reference["t"][0])
        else:
            ms = np.maximum(v, 1.0) / 3.6
            t = np.concatenate([[0.0], np.cumsum(2 / (ms[:-1] + ms[1:]))])
        return cls(t * (lap_time / t[-1]), v, own)

    def target(self, sim: SimLap) -> SimLap:
        """A target on the fastest lap's line at limits never below its own: its real lap, gaining at every metre
        what perfect driving at the target's limits gains there over perfect driving at its own. Never slower than
        the fastest lap anywhere."""
        gain = np.minimum(np.diff(sim.t) - np.diff(self.own.t), 0.0)
        t = np.concatenate([[0.0], np.cumsum(np.diff(self.t) + gain)])
        speed = self.speed + np.maximum(sim.speed - self.own.speed, 0.0)
        if self.best_t is not None:
            t, speed = t + self.best_t, speed + self.best_v
        return SimLap(speed, t, float(t[-1]), sim.limited_by)

    def to_best(self, sim: SimLap, best: list[tuple[int, int, float]],
                cap: list[tuple[int, int, float]] | None = None) -> Calibration:
        """This calibration for a target that is never slower than the best pass through any section (start metre,
        end metre, the best pass's time) and, given cap, never quicker than cap's pass through it either. Where it
        would be slower, its time through the section is scaled to that pass's, its speed with it; where it would be
        quicker, what it gains over the fastest lap is scaled down at every metre, so it stays never slower than that
        lap anywhere."""
        lap = self.target(sim)
        dt = np.diff(lap.t)
        extra, dv = np.zeros_like(dt), np.zeros_like(lap.speed)
        bound = {(a, b): (q, None) for a, b, q in best}
        for a, b, q in cap or []:
            bound[(a, b)] = (bound.get((a, b), (None, None))[0], q)
        own_dt = np.diff(self.t)
        for (a, b), (slowest, quickest) in bound.items():
            took = float(lap.t[b] - lap.t[a])
            if slowest is not None and slowest < took and took > 0:  # quicker, at every metre alike
                f = slowest / took
                extra[a:b] = dt[a:b] * (f - 1)
                dv[a + 1:b] = lap.speed[a + 1:b] * (1 / f - 1)
            elif quickest is not None and quickest > took:  # less of the gain over the fastest lap, at every metre
                gained = float(self.t[b] - self.t[a]) - took
                keep = max(float(self.t[b] - self.t[a]) - quickest, 0.0) / gained if gained > 0 else 0.0
                extra[a:b] = (own_dt[a:b] - dt[a:b]) * (1 - keep)
                dv[a + 1:b] = (self.speed[a + 1:b] - lap.speed[a + 1:b]) * (1 - keep)
        return Calibration(self.t, self.speed, self.own, np.concatenate([[0.0], np.cumsum(extra)]), dv)

    @property
    def dt(self) -> np.ndarray:
        """s to each metre: what to add to perfect driving's time, on any line of the same track."""
        out = self.t - self.own.t
        return out + self.best_t if self.best_t is not None else out

    @property
    def dv(self) -> np.ndarray:
        """km/h at each metre: what to add to perfect driving's speed."""
        out = self.speed - self.own.speed
        return out + self.best_v if self.best_v is not None else out

    def lap(self, sim: SimLap) -> SimLap:
        """Perfect driving on any lap's line (the same distance grid), with the model's error at every metre taken
        out as measured on the fastest lap."""
        dt = self.dt
        return SimLap(sim.speed + self.dv, sim.t + dt, sim.time + float(dt[-1]), sim.limited_by)
