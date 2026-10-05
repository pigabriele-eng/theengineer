"""The car's balance in each section and corner phase, lap by lap, for checking a debrief against the data.

The balance is the report's (app.analysis.balance): the understeer angle at the road wheels, gyro-corrected,
less the car's own normal understeer for the cornering load (its gradient through zero, about 1 degree per g at
Hockenheim). Positive: the front pushes more than normal; negative: the rear slides. Each section and phase is
read exactly as the report's balance table reads it (the median where the car corners at over 0.5 g), but for
every lap on its own, so a debrief point can be checked on how many laps show it, not only on the median.
"""
from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np

from app.analysis import balance
from app.analysis.channels import math_channels
from app.analysis.insights import Prepared, RunInput
from app.vehicle.tyre_fit import NotEnoughData

PHASES = tuple((name, p) for p, name in balance.PHASE_NAMES)  # entry (trail braking), mid, exit (throttle)
CORNER = "corner"  # the whole corner, every phase
SPEED_BANDS = balance.SPEED_BANDS
MIN_SAMPLES = balance.MIN_SAMPLES  # metres of a phase in one lap before its balance counts
MIN_BAND_SAMPLES = 20  # a speed band spans several corners


@dataclass
class SectionBalance:
    per_g: float  # the car's normal understeer: degrees of steering per g of cornering, through zero
    # section code -> phase or CORNER -> one value per clean lap (prep.laps order), NaN where the lap had too little
    # cornering there. Degrees from the car's normal balance at the same lateral g: + understeer, - oversteer.
    laps: dict[str, dict[str, np.ndarray]]
    # the same for all the slow, medium and fast cornering of each lap (SPEED_BANDS)
    bands: dict[str, dict[str, np.ndarray]] = field(default_factory=dict)
    unit: str = "°"


def add_balance_channel(runs: list[RunInput], geo: balance.Geometry) -> list[str]:
    """Replace each run's understeer channel with the balance module's (road wheel, gyro-corrected), before the
    laps are prepared. A run it can't be read on loses the channel rather than mixing two kinds. Returns why not,
    per run that has no balance."""
    notes = []
    for run in runs:
        c = run.data.channels
        if "phase" not in c:
            math_channels(run.data)
        try:
            balance.balance_channel(run.data, geo)
        except NotEnoughData as e:
            c.pop("understeer", None)
            notes.append(f"{run.name}: {e}")
    return notes


def _phase_values(r: np.ndarray, ph: np.ndarray, sel: np.ndarray, need: int) -> dict[str, float]:
    """Median balance in each phase, and over the whole corner."""
    out, used = {}, np.zeros(len(r), bool)
    for name, p in PHASES:
        m = sel & (ph == p)
        if np.count_nonzero(m) >= need:
            out[name] = float(np.median(r[m]))
            used |= m
    if np.count_nonzero(used) >= need:
        out[CORNER] = float(np.median(r[used]))
    return out


def section_balance(prep: Prepared) -> SectionBalance | None:
    """Balance per section (and speed band), phase and lap: see the module docstring."""
    grad = balance.gradient(prep)
    if grad is None:
        return None
    k = grad["per_g"]
    names = (*(n for n, _ in PHASES), CORNER)
    n_laps = len(prep.laps)
    laps = {s.code: {n: np.full(n_laps, np.nan) for n in names} for s in prep.sections}
    bands = {b: {n: np.full(n_laps, np.nan) for n in names} for b, _, _ in SPEED_BANDS}
    for i, x in enumerate(prep.laps):
        tr = x.trace
        if "understeer" not in tr:
            continue
        ph = np.rint(tr["phase"]).astype(int)
        ay = np.abs(tr["ay"])
        turning = ay > balance.CORNERING_G
        r = tr["understeer"] - k * ay
        for s in prep.sections:
            sel = np.zeros(len(r), bool)
            sel[s.start:s.end] = True
            for name, v in _phase_values(r, ph, turning & sel, MIN_SAMPLES).items():
                laps[s.code][name][i] = v
        for band, lo, hi in SPEED_BANDS:
            sel = turning & (tr["speed"] >= lo) & (tr["speed"] < hi)
            for name, v in _phase_values(r, ph, sel, MIN_BAND_SAMPLES).items():
                bands[band][name][i] = v
    return SectionBalance(k, laps, bands)
