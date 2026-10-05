"""Stints: each run on one set of tyres, lap by lap, and how the car fades through it.

A stint is the laps between two stops (the car standing in the pit box or the garage). Every lap gets its time,
the share of the car's grip in use against the limits learned from the run's own quickest laps
(insights.prepare), its peak and sustained lateral g, its balance in each phase of the corner against the car's
own average at the same lateral g, the time traction control and ABS were working, and the tyre pressures and
temperatures when they are logged. A straight line through each stint's flying laps gives the fade: seconds
per lap and grip per lap. Out-laps, in-laps, slow laps and clear outliers stay out of the line.
"""
from __future__ import annotations

import numpy as np

from app.analysis.align import aligned_trace
from app.analysis.channels import EXIT, MID, TRAIL
from app.analysis.insights import (
    LapRecord,
    Prepared,
    RunInput,
    Section,
    _lap_state,
    _r,
    cornering,
    prepare,
    section_metrics,
    understeer_fit,
)
from app.analysis.laps import MASTER_HZ, Lap, SessionData

STOP_KMH = 5.0  # slower than this is standing still
STOP_S = 5.0  # standing still this long is a stop in the pits, and ends the stint
SUSTAINED_S = 1.0  # sustained lateral g is the best average over this long
OUTLIER_SIGMAS = 3.0
OUTLIER_MIN_S = 0.5  # a flying lap this far off its stint's trend is a clear outlier (traffic, a mistake)
MIN_FIT_LAPS = 4
MIN_PHASE_M = 10  # metres of a phase in one lap before its balance counts
# a trend is clear when flat lies outside its 95 % confidence band: Student's t for these degrees of freedom
T95 = ((1, 12.71), (2, 4.30), (3, 3.18), (4, 2.78), (5, 2.57), (6, 2.45), (8, 2.31), (10, 2.23), (15, 2.13),
       (20, 2.09), (30, 2.04), (1000, 1.96))
BALANCE_PHASES = ((TRAIL, "entry"), (MID, "mid"), (EXIT, "exit"))
# per-lap values fitted against laps into the stint: key -> (label, unit)
FITTED = {
    "time": ("Lap time", "s"), "grip_use": ("Grip in use", "%"), "sustained_lat_g": ("Sustained lateral g", "g"),
    "balance_entry": ("Entry balance", ""), "balance_mid": ("Mid-corner balance", ""),
    "balance_exit": ("Exit balance", ""), "tc_s": ("Traction control", "s"), "abs_s": ("ABS", "s"),
    "tyre_pressure": ("Tyre pressure (average)", "bar"), "tyre_temperature": ("Tyre temperature (average)", "°C"),
}
WARMING_BAR = 0.1  # average tyre pressure still rising this much over the flying laps: the tyres are coming in


def find_stops(data: SessionData) -> list[tuple[float, float]]:
    """When the car stood still for STOP_S or longer (start and end, seconds into the log)."""
    still = (data.channels["speed"] < STOP_KMH).astype(int)
    edges = np.flatnonzero(np.diff(np.r_[0, still, 0]))
    return [(a / MASTER_HZ, b / MASTER_HZ) for a, b in zip(edges[::2], edges[1::2], strict=True)
            if b - a >= STOP_S * MASTER_HZ]


def split_stints(laps: list[Lap], stops: list[tuple[float, float]]) -> list[list[Lap]]:
    """Laps grouped between stops; the lap with the stop in it closes its stint."""
    out: list[list[Lap]] = []
    for lap in laps:
        if not out or any(out[-1][-1].start <= a < lap.start for a, _ in stops):
            out.append([])
        out[-1].append(lap)
    return out


def lap_kinds(stint: list[Lap], stops: list[tuple[float, float]]) -> list[str]:
    """pit (the stop is in it), out, in, slow (not a clean lap) or flying.

    The laps that are not clean at the start of a stint are its out-laps (tyres and brakes coming in), those at
    its end its in-laps.
    """
    kinds = ["pit" if any(l.start <= a < l.end for a, _ in stops) else "flying" if l.clean else "slow"
             for l in stint]
    for i, k in enumerate(kinds):
        if k != "slow":
            break
        kinds[i] = "out"
    for i in reversed(range(len(kinds))):
        if kinds[i] not in ("slow", "pit"):
            break
        if kinds[i] == "slow":
            kinds[i] = "in"
    return kinds


def outliers(x: np.ndarray, y: np.ndarray) -> np.ndarray:
    """Laps far off the trend: residuals from a Theil-Sen line, which the outliers themselves can't pull."""
    if len(x) < 3:
        return np.zeros(len(x), bool)
    i, j = np.triu_indices(len(x), 1)
    dx = x[j] - x[i]
    slope = float(np.median((y[j] - y[i])[dx != 0] / dx[dx != 0])) if np.any(dx != 0) else 0.0
    res = y - slope * x
    res = res - np.median(res)
    sigma = 1.4826 * float(np.median(np.abs(res)))
    return np.abs(res) > max(OUTLIER_SIGMAS * sigma, OUTLIER_MIN_S)


def trend(x: np.ndarray, y: np.ndarray) -> dict | None:
    """Least-squares line through (laps into the stint, value): change per lap and its standard error."""
    ok = np.isfinite(y)
    x, y = x[ok], y[ok]
    n = len(x)
    if n < MIN_FIT_LAPS or np.ptp(x) == 0:
        return None
    slope, icept = np.polyfit(x, y, 1)
    res = y - (slope * x + icept)
    se = float(np.sqrt(res @ res / (n - 2) / np.sum((x - x.mean()) ** 2)))
    band = float(np.interp(n - 2, [d for d, _ in T95], [t for _, t in T95])) * se
    return {"per_lap": round(float(slope), 4), "se": round(se, 4), "within": round(band, 4), "laps": n,
            "start": round(float(slope * x.min() + icept), 3), "change": round(float(slope * np.ptp(x)), 3),
            "clear": bool(abs(slope) > band and abs(slope) > 1e-9)}


def _record(run: RunInput, prep: Prepared, lap: Lap) -> LapRecord:
    """A lap on the run's track line, like the clean laps insights.prepare already placed there."""
    found = next((x for x in prep.laps if x.number == lap.number), None)
    if found is not None:
        return found
    tr = aligned_trace(run.data, lap, prep.line, prep.length - 1)
    return LapRecord(run.name, lap.number, lap.time, run.driver, tr, -1)


def _lateral_g(data: SessionData, lap: Lap) -> tuple[float, float | None]:
    """Peak lateral g, and the best average over SUSTAINED_S, on the lap's own clock."""
    i0, i1 = round(lap.start * MASTER_HZ), min(round(lap.end * MASTER_HZ), len(data.t))
    ay = np.abs(data.channels["ay"][i0:i1])
    w = round(SUSTAINED_S * MASTER_HZ)
    sustained = float(np.convolve(ay, np.ones(w) / w, "valid").max()) if len(ay) >= w else None
    return float(ay.max()) if len(ay) else 0.0, sustained


def _balance(tr: dict[str, np.ndarray], fit: tuple[float, float]) -> dict[str, float | None]:
    """Median understeer in each phase against the car's own average at the same lateral g (+ = more)."""
    rel = tr["understeer"] - (fit[0] * np.abs(tr["ay"]) + fit[1])
    corner = cornering(tr)
    phase = np.rint(tr["phase"]).astype(int)
    out = {}
    for p, name in BALANCE_PHASES:
        sel = corner & (phase == p)
        out[name] = float(np.median(rel[sel])) if np.count_nonzero(sel) >= MIN_PHASE_M else None
    return out


def _tyres(x: LapRecord) -> dict | None:
    state = _lap_state(x)
    out = {}
    for kind, key, nd in (("p", "pressure_bar", 2), ("t", "temperature_c", 1)):
        vals = {w: round(state[k], nd) for w in ("fl", "fr", "rl", "rr") if (k := f"tyre_{kind}_{w}") in state}
        if vals:
            out[key] = vals
    return out or None


def _lap_row(run: RunInput, prep: Prepared, lap: Lap, kind: str, tyre_lap: int,
             fit: tuple[float, float] | None) -> tuple[dict, LapRecord]:
    rec = _record(run, prep, lap)
    m = section_metrics(rec, Section("Lap", 0, prep.length - 1, None), prep.limits, prep.sim)
    peak, sustained = _lateral_g(run.data, lap)
    row = {
        "lap": lap.number, "tyre_lap": tyre_lap, "kind": kind, "in_fit": False, "outlier": False, "off_trend_s": None,
        "time": lap.time, "grip_use": _r(100 * m["grip_use"], 1) if m.get("grip_use") is not None else None,
        "peak_lat_g": round(peak, 2), "sustained_lat_g": _r(sustained, 2),
        "balance": {k: _r(v, 2) for k, v in _balance(rec.trace, fit).items()} if fit is not None else None,
        "tc_s": _r(m.get("tc"), 1), "abs_s": _r(m.get("abs"), 1), "tyres": _tyres(rec),
    }
    if kind == "pit":  # the time standing still swamps the time-weighted measures
        row.update({"grip_use": None, "balance": None, "tc_s": None, "abs_s": None})
    return row, rec


def _pool(traces: list[dict[str, np.ndarray]]) -> dict[str, np.ndarray]:
    return {k: np.concatenate([tr[k] for tr in traces]) for k in ("understeer", "ay", "phase")}


def _value(row: dict, key: str) -> float:
    if key.startswith("balance_"):
        v = (row["balance"] or {}).get(key.removeprefix("balance_"))
    elif key.startswith("tyre_"):
        corners = (row["tyres"] or {}).get("pressure_bar" if key == "tyre_pressure" else "temperature_c", {})
        v = float(np.mean(list(corners.values()))) if len(corners) == 4 else None
    else:
        v = row.get(key)
    return np.nan if v is None else float(v)


def _stint(run: RunInput, prep: Prepared, number: int, laps: list[Lap], stops: list[tuple[float, float]],
           fit: tuple[float, float] | None, steer_unit: str) -> dict:
    done = [_lap_row(run, prep, lap, kind, i + 1, fit)
            for i, (lap, kind) in enumerate(zip(laps, lap_kinds(laps, stops), strict=True))]
    rows = [row for row, _ in done]
    flying = [r for r in rows if r["kind"] == "flying"]
    x = np.array([r["tyre_lap"] for r in flying], float)
    times = np.array([r["time"] for r in flying])
    bad = outliers(x, times)
    if len(flying) >= 3:
        line = np.polyfit(x[~bad], times[~bad], 1) if np.count_nonzero(~bad) >= 2 else [0.0, np.median(times)]
        for r, b, xi, t in zip(flying, bad, x, times, strict=True):
            r["outlier"] = bool(b)
            r["off_trend_s"] = round(float(t - np.polyval(line, xi)), 2)
    used = [r for r in flying if not r["outlier"]]
    for r in used:
        r["in_fit"] = True
    xu = np.array([r["tyre_lap"] for r in used], float)
    fits = {}
    for key, (label, unit) in FITTED.items():
        t = trend(xu, np.array([_value(r, key) for r in used]))
        if t is not None:
            fits[key] = {"label": label, "unit": unit or steer_unit, **t}
    gradient = None
    if fit is not None and len(used) >= 2:
        gradient = round(understeer_fit(_pool([rec.trace for row, rec in done if row["in_fit"]]))[0], 2)
    timed = [r["time"] for r in used]
    return {
        "number": number, "first_lap": laps[0].number, "last_lap": laps[-1].number,
        "start_s": round(laps[0].start, 1), "end_s": round(laps[-1].end, 1),
        "best": min(timed) if timed else None, "median": round(float(np.median(timed)), 3) if timed else None,
        "understeer_gradient": gradient, "fits": fits, "laps": rows, "notes": stint_notes(fits, rows, steer_unit),
    }


def stint_notes(fits: dict, rows: list[dict], steer_unit: str) -> list[str]:
    """The stint's fade in plain words."""
    notes = []
    t = fits.get("time")
    if t is None:
        notes.append(f"Too few flying laps for a trend (it takes {MIN_FIT_LAPS}).")
    elif not t["clear"]:
        notes.append(f"Lap times hold steady over {t['laps']} flying laps: no clear trend "
                     f"(within ±{t['within']:.2f} s a lap).")
    elif t["per_lap"] > 0:
        notes.append(f"Lap time rises {t['per_lap']:.2f} s a lap over {t['laps']} flying laps, "
                     f"{t['change']:.1f} s from the first to the last.")
    else:
        notes.append(f"Lap time falls {-t['per_lap']:.2f} s a lap over {t['laps']} flying laps: the car got "
                     "quicker as the stint went on.")
    g = fits.get("grip_use")
    if g is not None and g["clear"]:
        notes.append(f"Grip in use {'falls' if g['per_lap'] < 0 else 'rises'} {abs(g['per_lap']):.1f} points a lap "
                     f"(share of the grip the car showed on its best laps), {g['change']:+.1f} over the stint.")
    elif g is not None:
        notes.append("Grip in use holds steady through the stint.")
    for name in ("entry", "mid", "exit"):
        b = fits.get(f"balance_{name}")
        if b is not None and b["clear"]:
            way = "understeer" if b["per_lap"] > 0 else "oversteer"
            notes.append(f"{FITTED[f'balance_{name}'][0]} moves towards {way} through the stint "
                         f"({b['change']:+.2f} {steer_unit} of steering from the first to the last flying lap).")
    p = fits.get("tyre_pressure")
    if p is not None and p["change"] > WARMING_BAR:
        notes.append(f"The tyres were still coming in: average pressure rose {p['change']:.2f} bar over these laps, "
                     "so they show warm-up as much as wear.")
    tc = fits.get("tc_s")
    if tc is not None and tc["clear"] and tc["per_lap"] > 0:
        fading = t is not None and t["clear"] and t["per_lap"] > 0
        notes.append(f"Traction control works {tc['per_lap']:.1f} s a lap longer each lap"
                     + (": with the lap times rising, the rear tyres are fading." if fading else "."))
    left = []
    for r in rows:
        if r["in_fit"]:
            continue
        why = {"out": "out-lap", "in": "in-lap", "pit": "pit stop", "slow": "slow lap"}.get(r["kind"])
        if r["outlier"]:
            why = f"{r['off_trend_s']:+.1f} s off the trend"
        left.append(f"lap {r['lap']} ({why})")
    if left:
        notes.append("Left out of the trend: " + ", ".join(left) + ".")
    return notes


def stint_analysis(run: RunInput) -> dict:
    """Every stint in one run: lap by lap, and its fade."""
    prep = prepare([run])
    if prep is None:
        return {"stints": [], "notes": ["No clean laps in this log, so the car's limits can't be learned yet."]}
    data = run.data
    fit = None
    if "understeer" in prep.reference.trace:
        fit = understeer_fit(_pool([x.trace for x in prep.laps]))
    steer = data.sources.get("steer")
    ch = run.ld.channel(steer) if run.ld is not None and steer else None
    steer_unit = ch.unit if ch is not None and ch.unit else "units"
    stops = find_stops(data)
    stints = [_stint(run, prep, i, laps, stops, fit, steer_unit)
              for i, laps in enumerate(split_stints(data.laps, stops), start=1)]
    notes = []
    if fit is not None:
        k = fit[0]
        notes.append(f"Understeer gradient {k:+.2f} {steer_unit} of {steer} per g: each extra g of cornering takes "
                     + (f"{k:.2f} {steer_unit} more steering than the path alone needs." if k >= 0 else
                        f"{-k:.2f} {steer_unit} less steering than the path needs, so the car gets looser as the "
                        "g rises."))
    if any("time" in s["fits"] for s in stints):
        notes.append("Fuel burning off makes every lap a little quicker, so the tyres alone fade at least as much "
                     "as the lap time trend shows.")
    return {
        "run": run.name, "lap_source": data.lap_source, "steer_channel": steer, "steer_unit": steer_unit,
        "understeer_gradient": round(fit[0], 2) if fit is not None else None,
        "stops": [{"start_s": round(a, 1), "end_s": round(b, 1), "duration_s": round(b - a, 1)} for a, b in stops],
        "stints": stints, "notes": notes,
    }
