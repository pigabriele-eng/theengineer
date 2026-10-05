"""Two drivers (or two stints) on the same car and track: where the time goes and which technique explains it.

Both sets of laps are placed on one GPS line and measured against the same car limits, so the comparison
works corner by corner and phase by phase even when the drivers never set a lap on the same run.
"""
from __future__ import annotations

import numpy as np

from app.analysis.channels import PHASES
from app.analysis.insights import (
    CornerSpec,
    TECHNIQUE,
    LapRecord,
    Prepared,
    RunInput,
    _dt,
    _within,
    corr,
    lap_scores,
    prepare,
    section_metrics,
    top_speeds,
)

MIN_EFFECT_S = 0.01


def _median(values: list) -> float | None:
    vals = [v for v in values if v is not None]
    return float(np.median(vals)) if vals else None


def _time_profile(laps: list[LapRecord]) -> np.ndarray:
    """Median time spent on each metre: a typical lap for the group, robust to one messy lap."""
    return np.median(np.stack([_dt(x.trace) for x in laps]), axis=0)


def _phase_profile(laps: list[LapRecord]) -> np.ndarray:
    ph = np.stack([np.rint(x.trace["phase"]).astype(int) for x in laps])
    return np.array([np.bincount(col, minlength=len(PHASES)).argmax() for col in ph.T])


def fingerprint(laps: list[LapRecord], prep: Prepared) -> dict:
    """How a driver drives, lap-wide: what to compare before looking corner by corner."""
    tr = {k: np.concatenate([x.trace[k] for x in laps]) for k in ("phase", "speed", "ax", "ay") if k in laps[0].trace}
    dt = np.concatenate([_dt(x.trace) for x in laps])
    phase = np.rint(tr["phase"]).astype(int)
    use = prep.limits.use(tr["speed"], tr["ax"], tr["ay"])
    n = len(laps)
    out = {f"grip_{PHASES[p]}": round(float((use * dt)[phase == p].sum() / max(dt[phase == p].sum(), 1e-9)), 3)
           for p in range(4)}
    out.update({f"time_{PHASES[p]}_s": round(float(dt[phase == p].sum()) / n, 2) for p in range(len(PHASES))})
    for key, label in (("coasting", "coasting_s"), ("overlap", "brake_throttle_overlap_s"), ("tc_on", "tc_s"),
                       ("abs_on", "abs_s")):
        if key in laps[0].trace:
            out[label] = round(float(sum((_dt(x.trace) * (x.trace[key] > 0.5)).sum() for x in laps)) / n, 2)
    if "throttle" in laps[0].trace:
        # how fast the throttle goes in on exits, % per second (median of the rising parts)
        rates = []
        for x in laps:
            thr, t = x.trace["throttle"], x.trace["t"]
            d = np.diff(thr) / np.maximum(np.diff(t), 1e-3)
            rates.append(np.median(d[(d > 20) & (thr[:-1] > 5) & (thr[:-1] < 95)]) if np.any(d > 20) else np.nan)
        out["throttle_rate_pct_s"] = round(float(np.nanmedian(rates)), 0)
    if "brake" in laps[0].trace:
        out["peak_brake"] = round(float(np.median([np.percentile(x.trace["brake"], 99.5) for x in laps])), 1)
    return out


def compare_groups(runs: list[RunInput], group_of: dict[str, str], labels: dict[str, str] | None = None,
                   corners: list[CornerSpec] | None = None) -> dict:
    """group_of maps each run name to "a" or "b"; labels names the two groups (driver names)."""
    labels = labels or {"a": "A", "b": "B"}
    prep = prepare(runs, corners)
    if prep is None:
        return {"error": "Each side needs at least one clean lap", "sections": []}
    groups = {g: [x for x in prep.laps if group_of.get(x.run) == g] for g in ("a", "b")}
    if not groups["a"] or not groups["b"]:
        return {"error": "Each side needs at least one clean lap", "sections": []}
    laps = prep.laps
    runs_of = [x.run for x in laps]
    prof = {g: _time_profile(v) for g, v in groups.items()}
    phases = _phase_profile(laps)

    sections = []
    for s in prep.sections:
        ms = [section_metrics(x, s, prep.limits, prep.sim) for x in laps]
        by = {g: [m for m, x in zip(ms, laps, strict=True) if group_of.get(x.run) == g] for g in ("a", "b")}
        times = np.array([m["time"] for m in ms])
        y = _within(times, runs_of)
        diffs = []
        for key, (label, unit, _) in TECHNIQUE.items():
            ma, mb = _median([m.get(key) for m in by["a"]]), _median([m.get(key) for m in by["b"]])
            if ma is None or mb is None:
                continue
            vals = np.array([m.get(key) if m.get(key) is not None else np.nan for m in ms], float)
            c = corr(_within(vals, runs_of), y)
            if c is None or c["p"] > 0.05:
                continue
            worth = c["slope"] * (ma - mb)  # seconds a's value costs (+) or gains (-) against b's
            if abs(worth) >= MIN_EFFECT_S:
                diffs.append({"metric": key, "label": label, "unit": unit, labels["a"]: round(ma, 3),
                              labels["b"]: round(mb, 3), "worth_s": round(worth, 3), "r": c["r"]})
        diffs.sort(key=lambda d: -abs(d["worth_s"]))
        gap = prof["a"][s.start:s.end] - prof["b"][s.start:s.end]
        sections.append({
            **s.to_dict(),
            "median": {labels[g]: round(float(np.median([m["time"] for m in by[g]])), 3) for g in by},
            "best": {labels[g]: round(float(min(m["time"] for m in by[g])), 3) for g in by},
            # + means the first driver is slower here, split by what the drivers were doing on those metres
            "gap_s": round(float(gap.sum()), 3),
            "gap_by_phase": {PHASES[p]: round(float(gap[phases[s.start:s.end] == p].sum()), 3)
                             for p in range(len(PHASES))},
            "differences": diffs[:5],
        })

    best = {g: min(v, key=lambda x: x.time) for g, v in groups.items()}
    summary = {}
    for g, v in groups.items():
        times = [x.time for x in v]
        summary[labels[g]] = {
            "laps": len(v), "best": best[g].time, "median": round(float(np.median(times)), 3),
            "best_scores": lap_scores(best[g], prep),
            "median_extraction": round(float(np.median([100 * prep.sim.time / t for t in times])), 2),
            "style": fingerprint(v, prep),
        }
    gains = sorted(({"code": s["code"], "gap_s": s["gap_s"],
                     "faster": labels["b"] if s["gap_s"] > 0 else labels["a"],
                     "main_phase": max(s["gap_by_phase"].items(), key=lambda kv: abs(kv[1]))[0],
                     # the biggest technique difference that points the same way as the time gap
                     "why": next((d for d in s["differences"] if d["worth_s"] * s["gap_s"] > 0), None)}
                    for s in sections),
                   key=lambda r: -abs(r["gap_s"]))
    return {
        "labels": labels, "length_m": prep.length, "numbering": prep.numbering,
        "theoretical_lap": round(prep.sim.time, 3),
        "typical_gap_s": round(float(prof["a"].sum() - prof["b"].sum()), 3),
        "summary": summary, "sections": sections, "where_time_goes": gains,
        "top_speeds": top_speeds(prep, {labels[g]: v for g, v in groups.items()}),
        "delta_trace": {"step_m": 5, "gap_s": np.round(np.cumsum(prof["a"] - prof["b"])[::5], 3).tolist()},
    }
