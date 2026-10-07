"""Several runs at one track, compared on one reference lap: the overview of a test day or an event."""
from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np

from app.analysis.laps import SessionData, corner_metrics, detect_corners, lap_length, lap_trace
from app.importers.motec import LdFile


@dataclass
class Run:
    name: str
    data: SessionData
    ld: LdFile | None = None  # for the condition channels
    meta: dict = field(default_factory=dict)


# Channels summarised per run when the logger has them: (label, unit, candidate names, statistic over clean laps)
CONDITIONS: list[tuple[str, str, tuple[str, ...], str]] = [
    ("Ambient temp", "°C", ("TAmbient", "Air Temp", "Ambient Temp"), "median"),
    ("Tyre pressure FL", "bar", ("pTyreFL", "Tyre Pres FL"), "median"),
    ("Tyre pressure FR", "bar", ("pTyreFR", "Tyre Pres FR"), "median"),
    ("Tyre pressure RL", "bar", ("pTyreRL", "Tyre Pres RL"), "median"),
    ("Tyre pressure RR", "bar", ("pTyreRR", "Tyre Pres RR"), "median"),
    ("Tyre temp FL", "°C", ("TTyreFL", "Tyre Temp FL"), "median"),
    ("Tyre temp FR", "°C", ("TTyreFR", "Tyre Temp FR"), "median"),
    ("Tyre temp RL", "°C", ("TTyreRL", "Tyre Temp RL"), "median"),
    ("Tyre temp RR", "°C", ("TTyreRR", "Tyre Temp RR"), "median"),
    ("Brake temp FL max", "°C", ("TBrakeFL", "Brake Temp FL"), "max"),
    ("Brake temp FR max", "°C", ("TBrakeFR", "Brake Temp FR"), "max"),
    ("Brake balance", "% front", ("rBrakebalance", "Brake Bias"), "median"),
    ("Engine oil temp", "°C", ("TEngineOil", "Oil Temp"), "median"),
    ("Water temp", "°C", ("TEngineWater", "Water Temp"), "median"),
]


def _in_laps(t: np.ndarray, laps) -> np.ndarray:
    mask = np.zeros(len(t), bool)
    for l in laps:
        mask |= (t >= l.start) & (t < l.end)
    return mask


def conditions(ld: LdFile, laps) -> dict[str, dict]:
    """Condition channels over the run's clean laps (pit and slow laps would skew them)."""
    out = {}
    for label, unit, names, stat in CONDITIONS:
        ch = ld.channel(*names)
        if ch is None:
            continue
        v = ch.values()[_in_laps(ch.times(), laps)]
        v = v[v > -40]  # sensors with no signal log -50
        if len(v) == 0:
            continue
        value = float(np.median(v) if stat == "median" else np.max(v))
        if unit == "bar" and value > 50:  # some tyre systems log kPa
            value /= 100
        out[label] = {"value": round(value, 2), "unit": unit}
    return out


def driver_aids(ld: LdFile, laps) -> dict[str, float]:
    """How often ABS and traction control were working, per clean lap."""
    out: dict[str, float] = {}
    if not laps:
        return out
    n_laps = len(laps)
    abs_ch = ld.channel("NAbs", "ABS Active")
    brake = ld.channel("pBrakeF", "Brake Pressure Front", "Brake Pressure")
    if abs_ch is not None and brake is not None:
        t = abs_ch.times()
        on = _in_laps(t, laps)
        braking = np.interp(t, brake.times(), brake.values()) > 5
        # NAbs: 1 armed, 2 regulating (in the BMW M4 GT4 logs 2 only ever appears under braking)
        regulating = abs_ch.values() >= 2
        if np.count_nonzero(on & braking):
            out["abs_share_of_braking"] = round(float(np.count_nonzero(on & braking & regulating)
                                                      / np.count_nonzero(on & braking)), 3)
    tc = ld.channel("BInterventionCauseTC", "TC Active")
    if tc is not None:
        t = tc.times()
        v = tc.values() > 0
        starts = np.count_nonzero((np.diff(v.astype(int)) == 1) & _in_laps(t, laps)[1:])
        out["tc_interventions_per_lap"] = round(starts / n_laps, 1)
    return out


def summarize(runs: list[Run]) -> dict:
    """Every run against the fastest clean lap of all runs, corner by corner, plus the best possible lap."""
    clean = [(r, l) for r in runs for l in r.data.laps if l.clean]
    if not clean:
        return {"runs": [], "corners": []}
    ref_run, ref_lap = min(clean, key=lambda rl: rl[1].time)
    length = round(lap_length(ref_run.data, ref_lap))
    ref_trace = lap_trace(ref_run.data, ref_lap, length)
    corners = detect_corners(ref_trace)
    brake_on = None
    if "brake" in ref_run.data.channels:
        brake_on = 0.12 * float(np.percentile(ref_run.data.channels["brake"], 99.5))

    seg: dict[tuple[str, int], dict] = {}  # (run, lap) -> {corner: metrics}
    for r, l in clean:
        tr = lap_trace(r.data, l, length)
        seg[(r.name, l.number)] = {c.code: corner_metrics(tr, c, brake_on) for c in corners}

    ideal_parts = []
    out_corners = []
    for c in corners:
        times = {k: m[c.code]["time"] for k, m in seg.items()}
        best_key = min(times, key=times.get)
        ideal_parts.append(times[best_key])
        out_corners.append({
            "code": c.code, "apex_m": c.apex, "start_m": c.start, "end_m": c.end,
            "reference": seg[(ref_run.name, ref_lap.number)][c.code],
            "best": {"run": best_key[0], "lap": best_key[1], **seg[best_key][c.code]},
        })

    out_runs = []
    for r in runs:
        laps = r.data.laps
        cl = [l for l in laps if l.clean]
        entry = {
            "name": r.name, **r.meta, "lap_source": r.data.lap_source,
            "laps": [{"number": l.number, "time": l.time, "clean": l.clean} for l in laps],
        }
        if cl:
            best = min(cl, key=lambda l: l.time)
            times = np.array([l.time for l in cl])
            entry.update({
                "best_lap": best.number, "best_time": best.time,
                "clean_laps": len(cl), "mean_clean": round(float(times.mean()), 3),
                "spread_clean": round(float(times.std()), 3),
                "theoretical_best": round(sum(min(seg[(r.name, l.number)][c.code]["time"] for l in cl)
                                              for c in corners), 3) if corners else None,
                # where this run's best lap loses to the reference lap, corner by corner
                "best_vs_reference": {c.code: round(seg[(r.name, best.number)][c.code]["time"]
                                                    - seg[(ref_run.name, ref_lap.number)][c.code]["time"], 3)
                                      for c in corners},
                "best_lap_corners": seg[(r.name, best.number)],
            })
            if r.ld is not None:
                entry["conditions"] = conditions(r.ld, cl)
                entry["driver_aids"] = driver_aids(r.ld, cl)
        out_runs.append(entry)

    return {
        "reference": {"run": ref_run.name, "lap": ref_lap.number, "time": ref_lap.time},
        "length_m": length,
        "ideal_lap": round(sum(ideal_parts), 3),
        "corners": out_corners,
        "runs": out_runs,
    }
