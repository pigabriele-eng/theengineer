"""The car's balance in each section and corner phase, lap by lap, for checking a debrief against the data.

Balance is the understeer angle: steering beyond what the path's curvature needs (positive: the front pushes;
negative: the rear helps the car turn). Every car needs more of it as the cornering load rises, so the car's own
gradient (per g) is taken off first; then each phase is measured against the car's average in that same phase,
because the car is not equally balanced braking into a turn, coasting at the apex and on the throttle. What is
left says where, and on which laps, a corner stands out from the rest of this car's corners.

Switch point: this reads the engine's understeer channel (insights.understeer_fit for the gradient). When the
balance module (app.analysis.balance) is merged, point `_gradient` at its gradient through zero
(`balance.gradient(prep)["per_g"]`); its road-wheel understeer angle can replace the engine's channel by running
`balance.balance_channel` on each run before the laps are prepared. Nothing else here needs to change.
"""
from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np

from app.analysis.channels import EXIT, MID, TRAIL
from app.analysis.channels import PHASES as LAP_PHASES
from app.analysis.insights import Prepared, cornering, understeer_fit

PHASES = (("entry", TRAIL), ("mid", MID), ("exit", EXIT))  # braking while turning, neither pedal, throttle
CORNER = "corner"  # the whole corner, every phase
SPEED_BANDS = (("slow", 0, 110), ("medium", 110, 160), ("fast", 160, 400))  # km/h, as insights.setup_diagnostics
MIN_SAMPLES = 5  # metres of a phase in one lap before its balance counts
MIN_BAND_SAMPLES = 20  # a speed band spans several corners


@dataclass
class SectionBalance:
    unit: str  # the steering channel's unit
    per_g: float  # the car's understeer gradient: extra steering per g of cornering
    # how far apart this car's corners usually are (the spread of the corners' medians, every phase together), never
    # less than the extra steering of 0.1 g more cornering: a corner standing out by more is a real difference
    scale: float
    # section code -> phase or CORNER -> one value per clean lap (prep.laps order), NaN where the lap had too little
    # cornering there. + more understeer than the car's average in that phase at the same lateral g.
    laps: dict[str, dict[str, np.ndarray]]
    # the same for all the slow, medium and fast cornering of each lap (SPEED_BANDS)
    bands: dict[str, dict[str, np.ndarray]] = field(default_factory=dict)


def _gradient(pool: dict[str, np.ndarray]) -> float:
    return understeer_fit(pool)[0]


def _robust_sd(x: np.ndarray) -> float:
    x = x[np.isfinite(x)]
    return float(1.4826 * np.median(np.abs(x - np.median(x)))) if len(x) else 0.0


def _phase_values(r: np.ndarray, ph: np.ndarray, sel: np.ndarray, typical: np.ndarray, need: int) -> dict[str, float]:
    """Median balance in each phase, and over the whole stretch, against the car's average in that phase."""
    out, used = {}, np.zeros(len(r), bool)
    for name, p in PHASES:
        m = sel & (ph == p)
        if np.count_nonzero(m) >= need:
            out[name] = float(np.median(r[m])) - typical[p]
            used |= m
    if np.count_nonzero(used) >= need:
        out[CORNER] = float(np.median(r[used] - typical[ph[used]]))
    return out


def section_balance(prep: Prepared, unit: str = "") -> SectionBalance | None:
    """Balance per section (and speed band), phase and lap, against this car's own average (see the module
    docstring)."""
    if not prep.laps or "understeer" not in prep.reference.trace:
        return None
    pool = {k: np.concatenate([x.trace[k] for x in prep.laps]) for k in ("understeer", "ay", "phase")}
    corner = cornering(pool)
    if np.count_nonzero(corner) < 100:
        return None
    k = _gradient(pool)
    phase = np.rint(pool["phase"]).astype(int)
    rel = pool["understeer"] - k * np.abs(pool["ay"])
    typical = np.zeros(len(LAP_PHASES))  # the car's average in each phase of the lap
    for _, p in PHASES:
        sel = corner & (phase == p)
        if sel.any():
            typical[p] = float(np.median(rel[sel]))
    floor = max(0.25 * _robust_sd((rel - typical[phase])[corner]), 0.1 * abs(k), 1e-6)
    del pool, corner, phase, rel

    names = (*(n for n, _ in PHASES), CORNER)
    n_laps = len(prep.laps)
    laps = {s.code: {n: np.full(n_laps, np.nan) for n in names} for s in prep.sections}
    bands = {b: {n: np.full(n_laps, np.nan) for n in names} for b, _, _ in SPEED_BANDS}
    for i, x in enumerate(prep.laps):
        tr = x.trace
        ph = np.rint(tr["phase"]).astype(int)
        turning = cornering(tr)
        r = tr["understeer"] - k * np.abs(tr["ay"])
        for s in prep.sections:
            sel = np.zeros(len(r), bool)
            sel[s.start:s.end] = True
            for name, v in _phase_values(r, ph, turning & sel, typical, MIN_SAMPLES).items():
                laps[s.code][name][i] = v
        for band, lo, hi in SPEED_BANDS:
            sel = turning & (tr["speed"] >= lo) & (tr["speed"] < hi)
            for name, v in _phase_values(r, ph, sel, typical, MIN_BAND_SAMPLES).items():
                bands[band][name][i] = v
    meds = np.array([np.nanmedian(v[name]) for v in laps.values() for name, _ in PHASES
                     if np.isfinite(v[name]).sum() >= 2])
    return SectionBalance(unit, k, max(_robust_sd(meds), floor), laps, bands)
