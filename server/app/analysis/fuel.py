"""Fuel: how much the car burns a lap, and what carrying it costs on the lap.

Fuel used comes from the log when it has a fuel channel: the mass used (MoTeC's mFuelUsed), the volume used
(QFuelUsed) at the fuel's density, or the level in the tank. Without one it is estimated from the time at full
throttle at the BMW M4 GT4's measured rate, and labelled as an estimate.

What the mass costs comes from the lap itself, not a rule of thumb. On full throttle the car is limited by its
power, so its acceleration falls in proportion to its mass: the lap's own speed trace is driven again with the
acceleration on every full-throttle metre scaled by m / (m + dm). Under braking and in the corners the car is
limited by grip, and grip grows with the load the extra mass puts on the tyres, so those metres stay as driven; the
heavier car only reaches each braking point a little slower and brakes a little later. What is left out (the tyres
losing a little grip per kilogram as their load rises, aero) makes the effect slightly larger than shown.
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from app.importers.motec import LdFile

USED_MASS = ("mFuelUsed", "Fuel Used Mass", "Fuel Mass Used")  # kg used so far
USED_VOLUME = ("QFuelUsed", "Fuel Used", "Fuel Used Total", "FuelUsed", "Fuel Consumed")  # litres used so far
LEVEL = ("Fuel Level", "QFuel", "Fuel Tank Level", "FuelLevel", "Fuel Volume", "Fuel Tank")  # litres in the tank
FUEL_DENSITY = 0.75  # kg/L, as the setup sheet takes it
MAX_FLOW_KG_S = 0.5  # a counter step faster than this is a reset or a glitch, not fuel
LEVEL_SMOOTH_S = 20.0  # a tank level sloshes about; averaged over this long
# Without a fuel channel: kg per second at full throttle, from the BMW M4 GT4 at Hockenheim (May 2025 test: about
# 2.05 kg a lap with 70 s of full throttle, 0.029 kg/s with the part-throttle running folded in)
EST_KG_PER_FULL_S = 0.029
FULL_THROTTLE = 95.0  # % pedal
DM_KG = 10.0


@dataclass
class FuelUse:
    """Fuel used since the start of the log (kg), against the log's clock."""
    t: np.ndarray
    used_kg: np.ndarray
    source: str  # "log" or "estimate"
    channel: str | None
    note: str

    def at(self, t: float) -> float:
        return float(np.interp(t, self.t, self.used_kg))


def _counter(t: np.ndarray, v: np.ndarray, hz: float) -> np.ndarray:
    """A running total that only counts real fuel: resets and glitches add nothing."""
    step = np.diff(v, prepend=v[0])
    step[(step < 0) | (step > MAX_FLOW_KG_S / max(hz, 1e-3))] = 0.0
    return np.cumsum(step)


def fuel_from_log(ld: LdFile | None, density: float = FUEL_DENSITY) -> FuelUse | None:
    """The log's fuel channel as kg used since the start, or None when it has none."""
    if ld is None or not hasattr(ld, "channel"):
        return None
    for names, kind in ((USED_MASS, "mass"), (USED_VOLUME, "volume"), (LEVEL, "level")):
        ch = ld.channel(*names)
        if ch is None:
            continue
        t, v = ch.times(), ch.values().astype(float)
        if len(v) < 2 or not np.isfinite(v).all() or np.ptp(v) <= 0:
            continue
        unit = (ch.unit or "").strip().lower()
        scale = 1.0 if unit == "kg" else 1e-3 if unit == "g" else density * (1e-3 if unit == "ml" else 1.0)
        if kind == "mass" and unit not in ("kg", "g"):
            scale = 1.0
        hz = len(t) / max(t[-1] - t[0], 1e-3)
        if kind == "level":
            w = max(1, round(LEVEL_SMOOTH_S * hz)) | 1
            v = np.convolve(np.pad(v, w // 2, mode="edge"), np.ones(w) / w, "valid")
            used = _counter(t, (v[0] - v) * scale, hz)
            what = f"the tank level ({ch.name}) at {density:g} kg/L"
        else:
            used = _counter(t, v * scale, hz)
            what = ch.name if scale == 1.0 else f"{ch.name} at {density:g} kg/L"
        return FuelUse(t, used, "log", ch.name, f"Fuel from the log: {what}.")
    return None


def fuel_estimate(t: np.ndarray, throttle: np.ndarray | None) -> FuelUse | None:
    """Fuel used, estimated from the time at full throttle (no fuel channel in the log)."""
    if throttle is None or len(t) < 2:
        return None
    dt = np.diff(t, prepend=t[0])
    used = np.cumsum(dt * (throttle > FULL_THROTTLE) * EST_KG_PER_FULL_S)
    return FuelUse(t, used, "estimate", None,
                   f"Estimated: no fuel channel in this log, so {EST_KG_PER_FULL_S:.3f} kg per second at full "
                   "throttle (the BMW M4 GT4's rate at Hockenheim).")


def mass_cost(speed_kmh: np.ndarray, throttle: np.ndarray, braking: np.ndarray, mass_kg: float,
              dm_kg: float = DM_KG) -> np.ndarray:
    """Seconds per kilogram that each metre of a lap (on a 1 m grid) takes longer with more mass on board.

    The lap is driven again dm_kg heavier: full-throttle metres accelerate m / (m + dm) as hard; metres where the
    lap slows down (braking, lifting) keep the heavier car's speed until the lap's own speed drops below it (it
    brakes later); every other metre (part throttle, the corners) keeps the lap's own acceleration.
    """
    v2 = np.maximum(np.asarray(speed_kmh, float) / 3.6, 3.0) ** 2
    n = len(v2)
    if n < 2:
        return np.zeros(max(n - 1, 0), np.float32)
    acc = np.diff(v2) / 2  # m/s² over each 1 m step
    full = (np.asarray(throttle)[1:] > FULL_THROTTLE) & (np.asarray(braking)[1:] < 0.5)
    scale = mass_kg / (mass_kg + dm_kg)
    heavy = np.empty(n)
    cur = heavy[0] = v2[0]
    for i in range(1, n):
        a = acc[i - 1]
        if full[i - 1]:
            cur += 2 * a * scale
        elif a > 0:
            cur += 2 * a
        cur = min(max(cur, 1.0), v2[i])
        heavy[i] = cur
    v, vh = np.sqrt(v2), np.sqrt(heavy)
    dt, dth = 2 / (v[1:] + v[:-1]), 2 / (vh[1:] + vh[:-1])
    return ((dth - dt) / dm_kg).astype(np.float32)
