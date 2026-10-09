"""Two stints side by side, to see whether a setup change worked (Gabriele, 2026-10-09: "in the stint analysis, add
stint comparison to validate setup changes").

The stints come from the stint view (analysis/stint.assemble), so both are measured the same way and their balance
against the same normal (the car's understeer gradient over every clean lap in view). Each figure is the mean over the
stint's laps in its trend (out-laps, in-laps, outliers and the laps tagged for a safety car, an FCY or traffic left
out) with its 95 % band, so a difference reads "clear" only when it is bigger than the two stints' lap-to-lap scatter
says it could be by chance:
- lap time: each lap taken to one tyre age and one fuel load first (analysis/like_for_like.py: the caller's
  correction), so a stint isn't quicker only for newer tyres or less fuel;
- grip per phase (g) and balance per phase (understeer angle, + understeer, - oversteer);
- the balance per corner (each stint's early and late laps), the corners where it moved most;
- how fast the tyres faded (lap time per lap on the set, fuel burn taken out), and traction control and ABS use.
Then it says so in a few plain lines. Pure numbers in and out, so the tests run it on made-up stints.
"""
from __future__ import annotations

import math

import numpy as np

from app.analysis.stint import GRIP, _t95

MIN_LAPS = 3  # laps in a stint's trend before it can be compared
SAME_S = 0.005  # lap times closer than this are the same
BALANCE_STEP = 0.1  # ° of understeer: a smaller move of the balance isn't worth a line
CORNER_STEP = 0.4  # ° in one corner (fewer laps, more scatter): a smaller move isn't shown
CORNERS_SHOWN = 4
PHASE_WORDS = {"entry": "entry", "mid": "mid-corner", "exit": "exit"}
AIDS = (("tc_s", "Traction control"), ("abs_s", "ABS"))


def _values(stint: dict, get) -> np.ndarray:
    out = []
    for row in stint.get("laps", []):
        if not row.get("in_fit"):
            continue
        v = get(row)
        out.append(np.nan if v is None else float(v))
    return np.array(out, float)


def difference(a, b, nd: int = 3) -> dict | None:
    """Mean of each side, b - a, and the 95 % band on that difference (Welch). None when a side has fewer than two
    values."""
    a = np.asarray(a, float)
    b = np.asarray(b, float)
    a, b = a[np.isfinite(a)], b[np.isfinite(b)]
    if len(a) < 2 or len(b) < 2:
        return None
    va, vb = a.var(ddof=1) / len(a), b.var(ddof=1) / len(b)
    se = float(np.sqrt(va + vb))
    # Welch-Satterthwaite degrees of freedom
    dof = (va + vb) ** 2 / ((va ** 2 / (len(a) - 1)) + (vb ** 2 / (len(b) - 1))) if va + vb > 0 else len(a) + len(b) - 2
    within = _t95(max(1, int(dof))) * se
    change = float(b.mean() - a.mean())
    return {"a": round(float(a.mean()), nd), "b": round(float(b.mean()), nd), "change": round(change, nd),
            "within": round(within, nd), "clear": bool(abs(change) > within and abs(change) > 10 ** -nd),
            "laps": [len(a), len(b)]}


def lap_time(a_times: list[float], b_times: list[float]) -> dict | None:
    return difference(a_times, b_times)


def phases(a: dict, b: dict) -> list[dict]:
    """Grip and balance per phase, a against b."""
    out = []
    balance_of = {"trail": "entry", "mid": "mid", "exit": "exit"}
    for key, label, measure in GRIP:
        grip = difference(_values(a, lambda r, k=key: (r.get("grip") or {}).get(k)),
                          _values(b, lambda r, k=key: (r.get("grip") or {}).get(k)))
        if grip is not None and grip["a"]:
            grip["pct"] = round(100 * grip["change"] / grip["a"], 1)
        name = balance_of.get(key)
        balance = None if name is None else difference(
            _values(a, lambda r, n=name: (r.get("balance") or {}).get(n)),
            _values(b, lambda r, n=name: (r.get("balance") or {}).get(n)), 2)
        if grip is None and balance is None:
            continue
        out.append({"key": key, "label": label, "measure": measure, "balance_phase": name, "grip": grip,
                    "balance": balance})
    return out


def _corner_levels(stint: dict) -> dict[tuple[str, str], float]:
    out = {}
    for row in stint.get("sections", []):
        if not row.get("corner"):
            continue
        for phase in PHASE_WORDS:
            v = row.get(phase)
            if v and v.get("early") is not None and v.get("late") is not None:
                out[(row["code"], phase)] = (v["early"] + v["late"]) / 2
    return out


def corners(a: dict, b: dict) -> list[dict]:
    """The corners where the balance moved most from a to b (each stint's early and late laps), biggest first."""
    la, lb = _corner_levels(a), _corner_levels(b)
    moves = [{"code": code, "phase": phase, "a": round(la[(code, phase)], 2), "b": round(lb[(code, phase)], 2),
              "change": round(lb[(code, phase)] - la[(code, phase)], 2)}
             for code, phase in la if (code, phase) in lb]
    moves = [m for m in moves if abs(m["change"]) >= CORNER_STEP]
    return sorted(moves, key=lambda m: -abs(m["change"]))[:CORNERS_SHOWN]


def fade(a: dict, b: dict) -> dict | None:
    """Each stint's lap time lost per lap on the set, fuel burn taken out where the log says."""
    def one(s: dict) -> dict | None:
        fits = s.get("fits") or {}
        f = fits.get("corrected_time") or fits.get("time")
        return None if f is None else {"per_lap": f["per_lap"], "within": f["within"], "clear": f["clear"],
                                       "fuel_out": "corrected_time" in fits}
    fa, fb = one(a), one(b)
    if fa is None or fb is None:
        return None
    return {"a": fa, "b": fb, "change": round(fb["per_lap"] - fa["per_lap"], 4)}


def aids(a: dict, b: dict) -> list[dict]:
    out = []
    for key, label in AIDS:
        d = difference(_values(a, lambda r, k=key: r.get(k)), _values(b, lambda r, k=key: r.get(k)), 2)
        if d is not None and (d["a"] or d["b"]):
            out.append({"key": key, "label": label, **d})
    return out


def _fade_words(name: str, f: dict) -> str:
    if not f["clear"]:
        return f"no clear trend on {name}"
    if f["per_lap"] > 0:
        return f"{f['per_lap']:.2f} s a lap lost each lap on {name}"
    return f"{name} {-f['per_lap']:.2f} s a lap quicker each lap"


def _deg(v: float) -> str:
    # halves rounded up, as the app rounds the same figure (0.25 is 0.3 in both)
    return f"{math.floor(abs(v) * 10 + 0.5) / 10:.1f}°"


def words(names: dict[str, str], time: dict | None, corrected: bool, phase_rows: list[dict], corner_rows: list[dict],
          fade_row: dict | None, aid_rows: list[dict], too_few: list[str]) -> dict:
    """What the comparison says, in plain lines: the lap time first, then the car."""
    a, b = names["a"], names["b"]
    if too_few:
        return {"headline": f"Too few laps to compare: {' and '.join(too_few)} "
                            f"{'has' if len(too_few) == 1 else 'have'} fewer than {MIN_LAPS} laps in the trend.",
                "car": []}
    if time is None:
        headline = f"No lap times to compare between {a} and {b}."
    else:
        d = time["change"]
        how = ", like with like" if corrected else ""
        if abs(d) < SAME_S:
            headline = f"{b} ran the same pace as {a}{how}."
        else:
            headline = f"{b} was {abs(d):.2f} s a lap {'quicker' if d < 0 else 'slower'} than {a}{how}"
            headline += ": a clear difference." if time["clear"] else (
                f", within the lap-to-lap scatter (±{time['within']:.2f} s): not clear yet.")
    car = []
    moved, same = [], []
    for p in phase_rows:
        bal = p["balance"]
        if bal is None:
            continue
        name = PHASE_WORDS[p["balance_phase"]]
        if bal["clear"] and abs(bal["change"]) >= BALANCE_STEP:
            moved.append(f"{name} {_deg(bal['change'])} towards {'understeer' if bal['change'] > 0 else 'oversteer'}")
        else:
            same.append(name)
    if moved:
        line = "Balance moved: " + ", ".join(moved)
        car.append(line + (f"; {' and '.join(same)} about the same." if same else "."))
    elif same:
        listed = ", ".join(same[:-1]) + " and " + same[-1] if len(same) > 1 else same[0]
        car.append(f"Balance about the same on {listed}.")
    if corner_rows:
        car.append("Most moved in: " + ", ".join(
            f"{c['code']} {PHASE_WORDS[c['phase']]} {_deg(c['change'])} towards "
            f"{'understeer' if c['change'] > 0 else 'oversteer'}" for c in corner_rows) + ".")
    grip = [f"{p['label'].lower()} {'up' if p['grip']['change'] > 0 else 'down'} {abs(p['grip']['pct']):.1f} %"
            for p in phase_rows if p["grip"] and p["grip"]["clear"] and p["grip"].get("pct") is not None]
    if grip:
        car.append("Grip: " + ", ".join(grip) + ".")
    if fade_row is not None and (fade_row["a"]["clear"] or fade_row["b"]["clear"]):
        car.append(f"Tyres: {_fade_words(b, fade_row['b'])}; {_fade_words(a, fade_row['a'])}.")
    for x in aid_rows:
        if x["clear"]:
            car.append(f"{x['label']} {abs(x['change']):.1f} s a lap {'more' if x['change'] > 0 else 'less'}.")
    return {"headline": headline, "car": car}
