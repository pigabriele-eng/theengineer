"""Shift points from the logs: each gear's ratio (engine revs per km/h), the engine's torque against its revs at full
throttle (the logger's engine torque channel), and from them the revs where the next gear drives the car harder than
this one. Up to there an upshift is early; past it, or held on the rev limiter, late.

The car's gear ratios and torque curve are not published (the BMW M4 GT4 Evo's ZF gearbox runs motorsport software
and its torque is set by the Balance of Performance), so both come from the logs of the event: every clean lap's full
throttle. Drive force at the wheels is the engine's torque times the gear's ratio (revs per km/h, which carries the
final drive and tyre size), so two gears compare at the same road speed without knowing either.
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np

FULL_THROTTLE = 98.0  # % pedal: the torque curve and the car's response to it are read at full throttle only
MIN_KMH = 30.0
NEAR_SHIFT_M = 8  # metres either side of a gear change left out of the curves: the torque dips through the shift
MIN_GEAR_SAMPLES = 200  # metres at full throttle a gear needs before its ratio is trusted
RATIO_SPREAD = 0.05  # a gear whose revs per km/h spread more than this (interquartile, of the median) is not a gear
RPM_BIN = 100
MIN_BIN_SAMPLES = 20
LIMIT_PCT = 99.9  # the rev limiter: this percentile of the revs at full throttle
LIMITER_CUT_RPM = 30  # within this of the limiter the torque is cut: left out of the curve
STRAIGHT_AY = 0.3  # g: the car's response to drive force is read in a straight line only
BEFORE_LIMIT_RPM = 100  # where a gear pulls harder all the way to the limiter, shift this far short of it


@dataclass
class ShiftModel:
    ratio: dict[int, float]  # gear (as logged) -> engine revs per km/h
    curve_rpm: np.ndarray  # the torque curve at full throttle: revs...
    curve_nm: np.ndarray  # ...and N m
    limit: float  # rpm: the rev limiter
    ideal: dict[int, float]  # gear -> the revs to shift up out of it at (BEFORE_LIMIT_RPM short of the limiter at most)
    per_force: float  # m/s² of acceleration per unit of drive force (N m x revs per km/h)
    drag: float  # m/s² of deceleration per (km/h)² at full throttle (air, rolling)

    def torque(self, rpm: np.ndarray | float) -> np.ndarray:
        return np.interp(rpm, self.curve_rpm, self.curve_nm)

    def force(self, gear: int, kmh: np.ndarray | float) -> np.ndarray:
        """Drive force (N m x revs per km/h) in gear at kmh; none past the rev limiter."""
        rpm = self.ratio[gear] * np.asarray(kmh, float)
        return np.where(rpm <= self.limit, self.torque(rpm) * self.ratio[gear], 0.0)

    def to_limit(self, gear: int) -> bool:
        """The gear pulls harder than the next one all the way to the rev limiter."""
        return self.ideal.get(gear, 0.0) >= self.limit - BEFORE_LIMIT_RPM

    def next_gear(self, gear: int) -> int | None:
        up = [g for g, k in self.ratio.items() if k < self.ratio[gear]]
        return max(up, key=lambda g: self.ratio[g]) if up else None

    def to_dict(self) -> dict:
        return {"limit_rpm": round(self.limit), "shift_rpm": {str(g): round(r) for g, r in self.ideal.items()},
                "rpm_per_kmh": {str(g): round(k, 2) for g, k in self.ratio.items()}}

    @classmethod
    def of(cls, traces: list[dict[str, np.ndarray]]) -> ShiftModel | None:
        """From the clean laps' traces (every metre, with "gear", "rpm", "engine_torque", "speed", "throttle" and
        "t"); None when the logs have no gear, revs or engine torque, or too little full throttle to read them."""
        need = ("gear", "rpm", "engine_torque", "speed", "throttle", "t")
        traces = [tr for tr in traces if all(k in tr for k in need)]
        if not traces:
            return None
        cols: dict[str, list[np.ndarray]] = {k: [] for k in ("gear", "rpm", "nm", "kmh", "acc", "ay")}
        for tr in traces:
            g = np.rint(np.asarray(tr["gear"], float)).astype(int)
            v = np.asarray(tr["speed"], float)
            t = np.asarray(tr["t"], float)
            near = np.zeros(len(g), bool)
            for k in np.flatnonzero(np.diff(g) != 0):
                near[max(k - NEAR_SHIFT_M, 0):k + NEAR_SHIFT_M + 1] = True
            ok = (np.asarray(tr["throttle"], float) >= FULL_THROTTLE) & (v >= MIN_KMH) & ~near
            acc = np.gradient(v / 3.6, t) if len(t) > 2 and np.all(np.diff(t) > 0) else np.full(len(v), np.nan)
            ay = np.abs(np.asarray(tr["ay"], float)) if "ay" in tr else np.zeros(len(v))
            for k, x in (("gear", g), ("rpm", tr["rpm"]), ("nm", tr["engine_torque"]), ("kmh", v), ("acc", acc),
                         ("ay", ay)):
                cols[k].append(np.asarray(x)[ok])
        c = {k: np.concatenate(x).astype(float) for k, x in cols.items()}
        if len(c["rpm"]) < MIN_GEAR_SAMPLES:
            return None
        ratio = {}
        for g in np.unique(c["gear"]).astype(int):
            m = c["gear"] == g
            if m.sum() < MIN_GEAR_SAMPLES:
                continue
            k = c["rpm"][m] / c["kmh"][m]
            q1, med, q3 = np.percentile(k, [25, 50, 75])
            if med > 0 and (q3 - q1) / med <= RATIO_SPREAD:
                ratio[int(g)] = float(med)
        if len(ratio) < 2:
            return None
        limit = float(np.percentile(c["rpm"], LIMIT_PCT))
        uncut = c["rpm"] < limit - LIMITER_CUT_RPM
        bins = np.arange(np.floor(c["rpm"].min() / RPM_BIN) * RPM_BIN, limit, RPM_BIN)
        at, nm = [], []
        for b in bins:
            m = uncut & (c["rpm"] >= b) & (c["rpm"] < b + RPM_BIN)
            if m.sum() >= MIN_BIN_SAMPLES:
                at.append(b + RPM_BIN / 2)
                nm.append(float(np.median(c["nm"][m])))
        if len(at) < 5:
            return None
        nm_s = np.array([np.median(nm[max(i - 1, 0):i + 2]) for i in range(len(nm))])  # a 3-bin running median
        model = cls(ratio, np.array(at), nm_s, limit, {}, 0.0, 0.0)
        # the car's response to drive force: acceleration = per_force x force - drag x speed², in a straight line
        m = (np.isin(c["gear"], list(ratio)) & uncut & (c["ay"] < STRAIGHT_AY) & np.isfinite(c["acc"]))
        if m.sum() >= MIN_GEAR_SAMPLES:
            k = np.array([ratio[int(g)] for g in c["gear"][m]])
            force = model.torque(c["rpm"][m]) * k
            (s, d), *_ = np.linalg.lstsq(np.column_stack([force, -c["kmh"][m] ** 2]), c["acc"][m], rcond=None)
            model.per_force, model.drag = max(float(s), 0.0), max(float(d), 0.0)
        for g in ratio:
            n = model.next_gear(g)
            if n is None:
                continue
            rpm = np.arange(model.curve_rpm[0], limit + 1, 10.0)
            kmh = rpm / ratio[g]
            better = model.force(n, kmh) >= model.force(g, kmh)  # past the limiter the gear gives nothing
            worse = np.flatnonzero(~better)
            cross = float(rpm[worse[-1] + 1]) if len(worse) and worse[-1] + 1 < len(rpm) else limit
            model.ideal[g] = min(cross, limit - BEFORE_LIMIT_RPM)
        return model if model.per_force > 0 else None
