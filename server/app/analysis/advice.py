"""How to go faster: the report's advice, worked out from any set of clean laps at any track.

Built on the engine's preparation (every lap on one line, the car's limits, the theoretical lap). For each section of
the lap it compares the quickest passes with a typical pass: where in the corner the time goes (braking, entry,
mid-corner, exit, full throttle), what the quick passes do differently, and how strongly each habit goes with a
quicker section lap to lap within the same run. It then ranks the sections by the time a typical lap can gain.

The ladder from the fastest lap down: the ideal lap (the best pass of every section), a realistic target (the car
holding 95 % of its peak grip, as no car holds its peak through a long corner) and the theoretical lap (the car's
peak limits on the fastest lap's line everywhere).

Corners are named only by their official numbers (or C1, C2... where the track has none).
"""
from __future__ import annotations

import re
from dataclasses import dataclass, replace
from itertools import pairwise

import numpy as np

from app.analysis.channels import PHASES
from app.analysis.compact import Extras
from app.analysis.insights import (
    MIN_LAPS_FOR_TRENDS,
    SIGNIFICANT_P,
    LapRecord,
    Prepared,
    _closed_sim,
    _dt,
    _within,
    consistency,
    corr,
    lap_correlations,
    lap_scores,
    section_metrics,
)
from app.analysis.laps import Section
from app.analysis.scan import scan_medians

QUICK_SHARE = 0.1  # the quick passes are the quickest tenth of all passes of a section
MIN_QUICK = 3
REALISTIC_GRIP = 0.95
TOP_GAINS = 3
MAX_ADVICE = 3
MAX_SPEED_ADVICE = 2  # of those, at most this many are "carry more speed"
TRACE_STEP_M = 5
CORNER_WINDOW_M = 40  # an official corner's speed is the lowest within this distance of its position
SPLIT_GAP_M = 200  # corners of one section further apart than this get a speed check on the way between them
MIN_RELATION_S = 0.05  # a lap-time relation worth less than this over the range seen is left out
MIN_WORTH_S = 0.02  # a habit worth less than this in a section is not advice, however clearly it is linked
# What the driver is doing, in the words of the report: the engine's phases of a lap
WHERE = {"braking": "braking", "trail": "entry", "mid": "mid-corner", "exit": "exit", "power": "full throttle"}
LINK_STRONG, LINK_CLEAR = 0.6, 0.3
PHASE_ORDER = ("braking", "entry", "mid", "exit", "power")
# smallest difference between quick and typical passes worth a word (brake pressure: 4 % of typical)
MIN_DIFF = {"m": 3.0, "km/h": 1.0, "s": 0.03, "%": 1.0, "": 0.3}


@dataclass
class Habit:
    key: str
    label: str
    unit: str  # m (from the line), km/h, s, %, "brake" (the logger's brake unit) or "" (a count)
    phase: str  # where in the corner: one of PHASE_ORDER
    outcome: bool = False  # a result of other habits rather than something to do
    corner: str | None = None  # the official corner a speed is measured at
    at: int | None = None  # the metre a speed is measured at


HABITS = [
    Habit("brake_point", "Brake point", "m", "braking"),
    Habit("brake_on_speed", "Speed when braking starts", "km/h", "braking", outcome=True),
    Habit("peak_brake", "Peak brake pressure", "brake", "braking"),
    Habit("abs", "ABS working", "s", "braking"),
    Habit("trail_share", "Braking done while turning", "%", "entry"),
    Habit("release_at", "Off the brake at", "m", "entry"),
    Habit("speed_at_release", "Speed when off the brake", "km/h", "entry"),
    Habit("min_speed", "Minimum speed", "km/h", "mid"),
    Habit("coasting", "Coasting", "s", "mid"),
    Habit("overlap", "Brake and throttle together", "s", "mid"),
    Habit("throttle_on", "Throttle pick-up at", "m", "exit"),
    Habit("full_throttle", "Full throttle at", "m", "exit"),
    Habit("lifts", "Lifts before full throttle", "", "exit"),
    Habit("tc", "Traction control working", "s", "exit"),
    Habit("rear_slip_exit", "Rear wheelspin on exit", "%", "exit"),
    Habit("exit_speed", "Exit speed", "km/h", "power", outcome=True),
]
FLAT_HABITS = [
    Habit("entry_speed", "Speed at the start", "km/h", "power", outcome=True),
    Habit("throttle_on", "Throttle back on at", "m", "exit"),
    Habit("full_throttle", "Full throttle at", "m", "exit"),
    Habit("lifts", "Lifts before full throttle", "", "exit"),
    Habit("coasting", "Coasting", "s", "mid"),
    Habit("exit_speed", "Exit speed", "km/h", "power", outcome=True),
]


# ---------- per pass ----------

def _first(mask: np.ndarray) -> int | None:
    i = np.flatnonzero(mask)
    return int(i[0]) if len(i) else None


def section_points(s: Section, corner_at: dict[str, int], ref: dict[str, np.ndarray]) -> list[Habit]:
    """Speeds worth checking inside a section of several official corners: at each corner away from the slowest
    point, and on the way between two corners far apart (the exit of the first). A corner the fastest lap takes
    flat out is only a result of the one before it."""
    codes = [c for c in s.corners if c in corner_at and s.start <= corner_at[c] <= s.end]
    if len(codes) < 2:
        return []
    out = []
    for c in codes:
        at = corner_at[c]
        if s.apex is not None and abs(at - s.apex) <= CORNER_WINDOW_M:
            continue  # the section's slowest point: its minimum speed
        near = slice(max(at - CORNER_WINDOW_M, 0), at + CORNER_WINDOW_M)
        flat = "throttle" in ref and float(ref["throttle"][near].min()) > 95
        out.append(Habit(f"corner_speed_{c}", f"Speed at {c}", "km/h", "mid", outcome=flat, corner=c, at=at))
    for c1, c2 in pairwise(codes):
        if corner_at[c2] - corner_at[c1] > SPLIT_GAP_M:
            m = (corner_at[c1] + corner_at[c2]) // 2
            out.append(Habit(f"after_{c1}", f"Speed after {c1}, at {m} m", "km/h", "exit", corner=c1, at=m))
    return out


def pass_extras(tr: dict[str, np.ndarray], s: Section, points: list[Habit] = ()) -> dict:
    """What section_metrics doesn't measure: where the brake comes off and at what speed, the speed when braking
    starts, how cleanly the throttle goes down on the way out, and the speed at the section's other corners."""
    a, b = s.start, s.end
    v = tr["speed"][a:b]
    out: dict = {}
    if len(v) < 10:
        return out
    imin = int(np.argmin(v))
    out["min_at"] = a + imin
    if s.apex is not None and "brake" in tr:
        br = tr["brake"][a:b]
        braking = tr["braking"][a:b] > 0.5
        pk = int(np.argmax(br[:imin + 1]))
        if br[pk] > 0 and braking[pk]:
            rel = _first(br[pk:min(imin + 40, len(br))] < 0.1 * br[pk])
            if rel is not None:
                out["release_at"] = a + pk + rel
                out["speed_at_release"] = float(v[pk + rel])
            on = _first(br[:pk + 1] > 0.1 * br[pk])
            if on is not None:
                out["brake_on_speed"] = float(v[on])
    if "throttle" in tr:
        th = tr["throttle"][a + max(imin - 40, 0):b]
        on = _first(th > 20)
        if on is not None:
            full = _first(th[on:] > 95)
            seg = th[on:on + full] if full is not None else th[on:]
            dip = (np.maximum.accumulate(seg) - seg) > 15 if len(seg) > 1 else np.zeros(1, bool)
            out["lifts"] = int(np.count_nonzero(np.diff(dip.astype(int)) == 1))  # the throttle falls back
    sp = tr["speed"]
    for h in points:
        if h.key.startswith("corner_speed_"):
            out[h.key] = float(sp[max(h.at - CORNER_WINDOW_M, a):min(h.at + CORNER_WINDOW_M, b) + 1].min())
        else:
            out[h.key] = float(sp[h.at])
    return out


def _pass_rows(prep: Prepared, s: Section, points: list[Habit]) -> list[dict]:
    rows = []
    for x in prep.laps:
        m = section_metrics(x, s, prep.limits, prep.sim)
        m.update(pass_extras(x.trace, s, points))
        if m.get("trail_share") is not None:
            m["trail_share"] *= 100
        rows.append(m)
    return rows


# ---------- per section ----------

def _quick(times: np.ndarray) -> np.ndarray:
    k = max(MIN_QUICK, round(len(times) * QUICK_SHARE))
    return np.argsort(times)[:min(k, len(times))]


def _link(r: float | None, p: float | None) -> str | None:
    if r is None:
        return None
    if p is not None and p > SIGNIFICANT_P:
        return "weak"
    return "strong" if abs(r) >= LINK_STRONG else "clear" if abs(r) >= LINK_CLEAR else "weak"


def _habit_stats(rows: list[dict], key: str, times: np.ndarray, runs: list[str], quick: np.ndarray) -> dict | None:
    vals = np.array([r[key] if r.get(key) is not None else np.nan for r in rows], float)
    ok = ~np.isnan(vals)
    if ok.sum() < max(3, 0.7 * len(vals)) or not ok[quick].any():
        return None
    use_mean = key == "lifts"  # a count: the median hides the difference
    typical = float(np.nanmean(vals) if use_mean else np.nanmedian(vals))
    q = float(np.nanmean(vals[quick]) if use_mean else np.nanmedian(vals[quick]))
    idx = np.flatnonzero(ok)
    c = corr(_within(vals[ok], [runs[i] for i in idx]), _within(times[ok], [runs[i] for i in idx]))
    return {"typical": typical, "quick": q, "r": c["r"] if c else None, "p": c["p"] if c else None,
            "seconds_per_unit": c["slope"] if c else None, "values": vals}


def _theoretical_values(prep: Prepared, s: Section, points: list[Habit]) -> dict:
    sv = prep.sim.speed
    out = {"entry_speed": float(sv[s.start]), "exit_speed": float(sv[s.end])}
    if s.apex is not None:
        seg = sv[s.start:s.end]
        imin = int(np.argmin(seg))
        out["min_speed"] = float(seg[imin])
        out["min_at"] = s.start + imin
        braking = prep.sim.limited_by[s.start:s.start + imin] == 2
        if braking.any():
            out["brake_point"] = s.start + int(np.argmax(braking))
    for h in points:
        if h.key.startswith("corner_speed_"):
            out[h.key] = float(sv[max(h.at - CORNER_WINDOW_M, s.start):min(h.at + CORNER_WINDOW_M, s.end) + 1].min())
        else:
            out[h.key] = float(sv[h.at])
    return out


def _phase_split(prep: Prepared, s: Section, quick: np.ndarray, gain: float) -> dict[str, float]:
    """Where a typical pass loses to the quick ones: metre by metre, the typical time against the quick passes'
    time, added up by what the quickest pass was doing there; scaled to the gap between their section times."""
    a, b = s.start, s.end
    dts = np.array([_dt(x.trace)[a:b] for x in prep.laps])
    loss = np.median(dts, 0) - np.median(dts[quick], 0)
    best = prep.laps[int(quick[0])]
    phase = np.rint(best.trace["phase"][a:b]).astype(int)
    split = {WHERE[PHASES[p]]: float(loss[phase == p].sum()) for p in range(len(PHASES))}
    total = sum(split.values())
    if gain > 0.005 and total > 0.005:
        split = {k: v * gain / total for k, v in split.items()}
    return {k: round(v, 3) for k, v in split.items()}


def _fmt(v: float, unit: str, brake_unit: str) -> str:
    if unit == "m":
        return f"{v:.0f} m"
    if unit == "km/h":
        return f"{v:.1f} km/h"
    if unit == "s":
        return f"{v:.2f} s"
    if unit == "%":
        return f"{v:.0f}%" if abs(v) >= 10 else f"{v:.1f}%"
    if unit == "brake":
        return f"{v:.0f} {brake_unit}".strip()
    return f"{v:.1f}"


def _sentence(h: Habit, t: float, q: float, th: float | None, brake_unit: str, prev: str | None) -> str:
    """One thing to do, in the driver's words, with the numbers that back it."""
    def f(v):
        return _fmt(v, h.unit, brake_unit)
    key = h.key
    d = abs(q - t)
    more = q > t
    theo = f", theoretical {th:.1f}" if th is not None else ""
    if key.startswith("corner_speed_"):
        return (f"Carry {q:.1f} km/h through {h.corner} (typical {t:.1f}{theo})" if more
                else f"Take {h.corner} slower, {q:.1f} km/h against {t:.1f}, to set up what follows")
    if key.startswith("after_"):
        return f"Leave {h.corner} faster: {q:.1f} km/h at {h.at} m against {t:.1f}{theo}"
    if key == "brake_point":
        return f"Brake {d:.0f} m {'later' if more else 'earlier'}, at {q:.0f} m"
    if key == "peak_brake":
        return f"Brake {'harder' if more else 'lighter'}: {f(q)} at the peak against {f(t)}"
    if key == "abs":
        return (f"Brake closer to the limit: ABS working {f(q)} against {f(t)}" if more
                else f"Stay off the ABS: {f(q)} against {f(t)}")
    if key == "trail_share":
        return (f"Carry the brake further into the turn: {f(q)} of the braking done while turning against {f(t)}"
                if more else f"Do more of the braking in a straight line: {f(q)} while turning against {f(t)}")
    if key == "release_at":
        return (f"Come off the brake {d:.0f} m sooner, at {q:.0f} m" if not more
                else f"Stay on the brake {d:.0f} m longer, to {q:.0f} m")
    if key == "speed_at_release":
        return f"Let the brake go at {q:.0f} km/h, not {t:.0f}"
    if key == "min_speed":
        return (f"Carry {q:.1f} km/h at the slowest point (typical {t:.1f}{theo})" if more
                else f"Slow the car more: {q:.1f} km/h at the slowest point against {t:.1f}, for a better exit")
    if key == "coasting":
        return (f"Coast less between brake and throttle: {f(q)} against {f(t)}" if not more
                else f"Give the car a moment between brake and throttle: {f(q)} against {f(t)}")
    if key == "overlap":
        return (f"Keep brake and throttle apart: {f(q)} together against {f(t)}" if not more
                else f"Overlap brake and throttle a little more: {f(q)} against {f(t)}")
    if key == "throttle_on":
        return (f"Pick up the throttle {d:.0f} m sooner, at {q:.0f} m" if not more
                else f"Wait {d:.0f} m longer for the throttle, to {q:.0f} m, then commit")
    if key == "full_throttle":
        return (f"Full throttle {d:.0f} m sooner, at {q:.0f} m" if not more
                else f"Build the throttle more gently: full at {q:.0f} m against {t:.0f} m")
    if key == "lifts":
        return (f"Lift less on the way out: {q:.1f} lifts before full throttle against {t:.1f}" if not more
                else f"Feed the throttle in: {q:.1f} lifts before full throttle against {t:.1f}")
    if key == "tc":
        return (f"Commit to the throttle on the way out: traction control working {f(q)} against {f(t)}" if more
                else f"Less traction control on the way out: {f(q)} against {f(t)}; squeeze the throttle on")
    if key == "rear_slip_exit":
        return (f"Commit to the throttle on the way out: {f(q)} rear wheel slip against {f(t)}" if more
                else f"Less wheelspin on the way out: {f(q)} against {f(t)}")
    if key == "exit_speed":
        return f"Drive out at {q:.1f} km/h (typical {t:.1f}{theo})"
    if key == "entry_speed":
        where = f"the exit of {prev}" if prev else "the corner before"
        return f"Flat out: its time is set by {where}. The quick passes start it at {q:.1f} km/h against {t:.1f}"
    return f"{h.label}: {q:.1f} against {t:.1f}"


def _merge_release(chosen: list[dict]) -> list[dict]:
    """'Come off the brake sooner' and 'at a higher speed' are one instruction."""
    keys = [c["key"] for c in chosen]
    if "release_at" in keys and "speed_at_release" in keys:
        r = chosen[keys.index("release_at")]
        v = chosen[keys.index("speed_at_release")]
        r["text"] += f", letting it go at {v['quick']:.0f} km/h, not {v['typical']:.0f}"
        chosen = [c for c in chosen if c is not v]
    return chosen


def _section(prep: Prepared, s: Section, prev: str | None, realistic, brake_unit: str,
             corner_at: dict[str, int]) -> dict:
    points = section_points(s, corner_at, prep.reference.trace)
    rows = _pass_rows(prep, s, points)
    laps = prep.laps
    runs = [x.run for x in laps]
    times = np.array([r["time"] for r in rows])
    quick = _quick(times)
    typical_t = float(np.median(times))
    quick_t = float(np.median(times[quick]))
    gain = max(typical_t - quick_t, 0.0)
    ref_i = laps.index(prep.reference)
    best_i = int(np.argmin(times))
    flat = s.apex is None
    theo = _theoretical_values(prep, s, points)
    catalogue = (FLAT_HABITS if flat else HABITS) + points
    habits, actions = [], []
    for h in catalogue:
        st = _habit_stats(rows, h.key, times, runs, quick)
        if st is None:
            continue
        t, q, r = st["typical"], st["quick"], st["r"]
        diff = q - t
        need = max(0.04 * abs(t), 1e-6) if h.unit == "brake" else MIN_DIFF.get(h.unit, 0.3)
        link = _link(r, st["p"])
        agrees = r is not None and r * diff < 0  # moving towards the quick passes goes with a quicker section
        worth = abs(st["seconds_per_unit"] * diff) if st["seconds_per_unit"] is not None and agrees else None
        fastest = st["values"][ref_i]
        row = {"key": h.key, "label": h.label, "unit": brake_unit if h.unit == "brake" else h.unit,
               "phase": WHERE[{"entry": "trail"}.get(h.phase, h.phase)],
               "typical": round(t, 3), "quick": round(q, 3),
               "fastest_lap": round(float(fastest), 3) if np.isfinite(fastest) else None,
               "theoretical": round(theo[h.key], 3) if h.key in theo else None,
               "r": r, "link": link, "worth_s": round(min(worth, gain), 3) if worth is not None else None,
               "used": False}
        habits.append(row)
        big = abs(diff) >= need
        linked = agrees and link in ("strong", "clear") and (worth is None or worth >= MIN_WORTH_S)
        unlinked = r is None  # too few laps to measure a link: the difference alone
        if big and (linked or unlinked) and (not h.outcome or h.key in ("exit_speed", "entry_speed")):
            actions.append({"key": h.key, "phase": h.phase, "worth": worth, "typical": t, "quick": q, "row": row,
                            "text": _sentence(h, t, q, theo.get(h.key), brake_unit, prev)})
    by_phase = _phase_split(prep, s, quick, gain)
    # the most telling habits, told in the order they happen in the corner
    ranked = sorted(actions, key=lambda a: (-(a["worth"] or 0), PHASE_ORDER.index(a["phase"])))
    technique, speeds = [], 0
    for a in ranked:
        if a["key"] in ("exit_speed", "entry_speed"):
            continue
        if a["key"] == "min_speed" or a["key"].startswith("corner_speed_"):
            speeds += 1
            if speeds > MAX_SPEED_ADVICE:  # say how to get the speed, not only what speed
                continue
        technique.append(a)
    if flat:
        chosen = [a for a in ranked if a["key"] == "entry_speed"][:1] + technique[:MAX_ADVICE - 1]
    else:
        chosen = technique[:MAX_ADVICE]
    chosen = chosen or [a for a in ranked if a["key"] == "exit_speed"][:1]
    top = chosen[0] if chosen else None  # the most telling one
    chosen.sort(key=lambda a: PHASE_ORDER.index(a["phase"]))
    for a in chosen:
        a["row"]["used"] = True
    chosen = _merge_release(chosen)
    if top is not None and top not in chosen:  # merged into "come off the brake sooner"
        top = next(a for a in chosen if a["key"] == "release_at")
    main = max(by_phase.items(), key=lambda kv: kv[1])[0] if gain > 0 else None
    if top is not None:
        headline = top["text"]
    elif main is not None and gain >= 0.05:
        place = {"braking": "under braking", "entry": "on entry", "mid-corner": "mid-corner", "exit": "on the exit",
                 "full throttle": "on the straight after it"}[main]
        headline = (f"The quick passes gain {gain:.2f} s here, most of it {place}, with no one habit standing out: "
                    "compare the speed traces")
    else:
        headline = None
    habits.sort(key=lambda h: (not h["used"], {"strong": 0, "clear": 1}.get(h["link"], 2), -(h["worth_s"] or 0)))
    sim_t = float(prep.sim.t[s.end] - prep.sim.t[s.start])
    real_t = float(realistic.t[s.end] - realistic.t[s.start])
    fast_t = float(times[ref_i])
    best_t = float(times[best_i])
    return {
        **s.to_dict(), "corners": s.corners, "flat": flat,
        "times": {"fastest_lap": round(fast_t, 3), "best": round(best_t, 3), "best_lap": laps[best_i].key,
                  "typical": round(typical_t, 3), "quick": round(quick_t, 3), "realistic": round(real_t, 3),
                  "theoretical": round(sim_t, 3)},
        "quick_passes": len(quick),
        "gain_s": round(gain, 3),
        "where": by_phase,
        "main_phase": main,
        # the fastest lap to the theoretical, step by step
        "ladder": {"driving": round(fast_t - best_t, 3), "car": round(best_t - real_t, 3),
                   "theoretical": round(real_t - sim_t, 3)},
        "headline": headline,
        "advice": [a["text"] for a in chosen],
        "habits": habits,
        "spread_s": round(float(np.percentile(times, 75) - np.percentile(times, 25)), 3),
        "_quick": quick,
        "_rows": rows,
    }


def _loss_line(sec: dict) -> str:
    parts = sorted(((k, v) for k, v in sec["where"].items() if v >= 0.02), key=lambda kv: -kv[1])
    if not parts:
        return "A typical pass is as quick as the quick passes here."
    return "A typical pass loses " + ", ".join(f"{v:.2f} s on {k}" for k, v in parts) + " to the quick passes."


# ---------- what goes with lap time ----------

def _sure(p: float) -> str:
    return "very sure" if p < 1e-6 else "sure" if p < 1e-3 else "fairly sure"


WHEEL = {"fl": "front left", "fr": "front right", "rl": "rear left", "rr": "rear right"}
LAP_FEATURES = {  # lap_correlations metric -> how to say it
    "lap_in_run": "laps into the run",
    "tc": "traction control working",
    "abs": "ABS working",
    "coasting": "coasting",
    "overlap": "brake and throttle together",
}
OBVIOUS = {"grip_use"}  # a quicker lap uses more of the grip: true, and no help
# channel scan categories worth reporting: tyres come from the engine's own tyre state, and "other" channels
# (electrics, air conditioning, debug values) are rarely about the car's pace
SCAN_CATEGORIES = ("brakes", "fuel", "powertrain", "conditions")
UNIT_WORDS = {"C": "°C", "degC": "°C", "deg C": "°C", "F": "°F", "degF": "°F"}
PREFIX_WORDS = {"T": "temperature", "P": "pressure"}  # the loggers' short names: TGearbox, POil


def channel_words(name: str) -> str:
    """A logger channel's name as words: "TGearbox" -> "the gearbox temperature", "FuelLevel" -> "the fuel level";
    short capitals (FL, ECU) stay as they are."""
    m = re.fullmatch(r"([TP])((?:[A-Z][a-z]+)+)", name)
    if m:
        return f"the {' '.join(re.findall(r'[A-Z][a-z]+', m[2])).lower()} {PREFIX_WORDS[m[1]]}"
    tokens = re.findall(r"[A-Z]?[a-z]+|[A-Z]+(?![a-z])|\d+", name)
    if not tokens:
        return name
    return "the " + " ".join(t.lower() if t[1:].islower() else t for t in tokens)


def _feature(key: str, prep: Prepared, per_lap: dict[str, list[dict]], tyres: dict[str, dict[str, float]]
             ) -> np.ndarray:
    """A lap_correlations measure, lap by lap, as it computes it."""
    laps = prep.laps
    if key.startswith("tyre_"):
        return np.array([tyres.get(x.key, {}).get(key, np.nan) for x in laps])
    if key == "lap_in_run":
        return np.array([x.index_in_run for x in laps], float)
    return np.array([sum(ms[i].get(key) or 0.0 for ms in per_lap.values()) for i in range(len(laps))])


def _relation(label: str, unit: str, vals: np.ndarray, runs: list[str], slope: float, r: float, n: int, p: float,
              within: bool, source: str, digits: int, window: dict | None = None) -> dict | None:
    """One relationship in plain words, sized over the spread of values seen: from lap to lap within a run when
    that is what was compared, else across all laps."""
    ok = np.isfinite(vals)
    v = _within(vals[ok], [runs[i] for i in np.flatnonzero(ok)]) if within else vals[ok]
    lo, hi = float(np.percentile(v, 10)), float(np.percentile(v, 90))
    span = hi - lo
    size = abs(slope * span)
    if size < MIN_RELATION_S or span <= 0:
        return None
    more = slope < 0  # more of it goes with a quicker lap

    def amount(x):
        return f"{x:.{digits}f} {unit}".strip()
    if within:
        what = (f"with {amount(span)} {'more' if more else 'less'} {label}" if unit == "s"
                else f"where {label} was {amount(span)} {'higher' if more else 'lower'}")
        text = f"Within a run, laps {what} were {size:.2f} s quicker"
    else:
        fast, slow = (hi, lo) if more else (lo, hi)
        text = f"Laps with {label} at {amount(fast)} were {size:.2f} s quicker than at {amount(slow)}"
    if window and window.get("quicker_by_s", 0) > 0:
        text += f"; quickest between {amount(window['from'])} and {amount(window['to'])}"
    return {"label": label, "unit": unit, "text": text + ".", "seconds": round(size, 3), "r": round(r, 3), "n": n,
            "p": p, "sure": _sure(p), "compared": "lap to lap within each run" if within else "across all laps",
            "source": source}


WARM_UP_LAPS = 2


def _only_warm_up(vals: np.ndarray, times: np.ndarray, runs: list[str], index: np.ndarray, r: float) -> bool:
    """True when a relation within runs is carried by each run's first laps (tyres and brakes coming up to
    temperature): without them it is no longer clear."""
    keep = (np.asarray(index) >= WARM_UP_LAPS) & np.isfinite(vals)
    if keep.sum() < MIN_LAPS_FOR_TRENDS:
        return False
    rr = [runs[i] for i in np.flatnonzero(keep)]
    c = corr(_within(vals[keep], rr), _within(np.asarray(times, float)[keep], rr))
    return c is None or c["p"] > SIGNIFICANT_P or c["r"] * r <= 0


def lap_time_relations(prep: Prepared, per_lap: dict[str, list[dict]], extras: Extras | None) -> list[dict]:
    """What goes with lap time across all the laps: the engine's lap measures and the car's state lap by lap
    (lap_correlations), and the other slow channels the logger recorded (the channel scan). Strongest first, each
    with its size in seconds over the spread seen and how sure it is; weak and obvious ones left out. These show
    what goes with a quicker lap, not what causes it."""
    if len(prep.laps) < MIN_LAPS_FOR_TRENDS:
        return []
    tyres = extras.tyres if extras else {}
    runs = [x.run for x in prep.laps]
    times = np.array([x.time for x in prep.laps])
    index = np.array([x.index_in_run for x in prep.laps])
    # lap_correlations reads the tyre state as each lap's median: hand it the medians the cache kept
    view = replace(prep, laps=[LapRecord(x.run, x.number, x.time, x.driver,
                                         {k: np.array([v]) for k, v in tyres.get(x.key, {}).items()},
                                         x.index_in_run) for x in prep.laps])
    out = []
    best_tyre: dict[str, dict] = {}
    for c in lap_correlations(view, per_lap, with_state=True):
        key = c["metric"]
        if key in OBVIOUS:
            continue
        if key.startswith("tyre_"):
            kind = "pressure" if key.startswith("tyre_p") else "temperature"
            label, digits = f"the {WHEEL[key[-2:]]} tyre {kind}", 2 if kind == "pressure" else 0
        else:
            label, digits = LAP_FEATURES.get(key, c["label"].lower()), 0 if key == "lap_in_run" else 1
        within = c["compared"] == "lap to lap within runs"
        vals = _feature(key, prep, per_lap, tyres)
        rel = _relation(label, c["unit"], vals, runs, c["seconds_per_unit"], c["r"], c["n"], c["p"], within, "lap",
                        digits)
        if rel is None:
            continue
        if key == "lap_in_run":
            s = c["seconds_per_unit"]
            rel["text"] = (f"Lap times {'fell' if s < 0 else 'rose'} {abs(s):.2f} s a lap through a run, "
                           f"{rel['seconds']:.2f} s over the run: tyres and fuel load.")
        elif within and _only_warm_up(vals, times, runs, index, c["r"]):
            rel["warm_up"] = True  # only over each run's first laps, while the car warms up
        if key.startswith("tyre_"):  # one per axle for pressure and for temperature: the wheels move together
            group = key[:6] + ("front" if key[-2] == "f" else "rear")
            if group not in best_tyre or rel["p"] < best_tyre[group]["p"]:
                best_tyre[group] = rel
            continue
        out.append(rel)
    out += best_tyre.values()
    for f in scan_medians(extras.scan) if extras and extras.scan else []:
        if f["category"] not in SCAN_CATEGORIES:
            continue
        name = f["channel"]
        vals = np.concatenate([m[name][1] if name in m else np.full(len(ts), np.nan) for _, ts, m in extras.scan])
        if not f["unit"] and np.nanmin(vals) >= 0 and np.nanmax(vals) <= 1:
            continue  # an on/off flag (a switch, a relay): no help in words
        scan_runs = [run for run, ts, _ in extras.scan for _ in ts]
        spread = float(np.nanpercentile(vals, 90) - np.nanpercentile(vals, 10)) if np.isfinite(vals).any() else 0
        digits = 0 if spread >= 20 else 1 if spread >= 2 else 2 if spread >= 0.2 else 3
        unit = UNIT_WORDS.get(f["unit"], f["unit"])
        rel = _relation(channel_words(name), unit, vals.astype(float), scan_runs, f["seconds_per_unit"], f["r"],
                        int(np.isfinite(vals).sum()), f["p"], True, f"channel ({f['category']})", digits,
                        f.get("window"))
        if rel is None:
            continue
        scan_times = np.array([t for _, ts, _ in extras.scan for t in ts])
        scan_index = np.array([i for _, ts, _ in extras.scan for i in range(len(ts))])
        if _only_warm_up(vals.astype(float), scan_times, scan_runs, scan_index, f["r"]):
            rel["warm_up"] = True  # only over each run's first laps, while the car warms up
        out.append(rel)
    # what holds once the car is warm first: that is what can be changed; then the strongest first
    for rel in out:
        rel.setdefault("warm_up", False)
    out.sort(key=lambda r: (r["warm_up"], -abs(r["r"])))
    return out


# ---------- the whole report ----------

def _realistic(prep: Prepared):
    lim = prep.limits
    held = replace(lim, envelope=lim.envelope * REALISTIC_GRIP)
    return _closed_sim(prep.reference.trace["curvature"], held)


def _profiles(prep: Prepared, sections: list[dict], realistic) -> dict:
    """Speed every few metres: a typical pass (median of all laps), the quick passes of each section, the fastest
    lap, the realistic target and the theoretical lap, for the section charts."""
    speeds = np.array([x.trace["speed"] for x in prep.laps])
    typical = np.median(speeds, 0)
    quick = typical.copy()
    for sec in sections:
        a, b = sec["start_m"], sec["end_m"] + 1
        quick[a:b] = np.median(speeds[sec["_quick"], a:b], 0)
    step = TRACE_STEP_M

    def pack(v):
        return np.round(np.asarray(v, float)[::step], 1).tolist()

    return {"step_m": step, "typical": pack(typical), "quick": pack(quick),
            "fastest_lap": pack(prep.reference.trace["speed"]), "realistic": pack(realistic.speed),
            "theoretical": pack(prep.sim.speed)}


def lap_text(s: float) -> str:
    m = int(s // 60)
    return f"{m}:{s - 60 * m:05.2f}" if m else f"{s:.2f}"


def build_report(prep: Prepared, extras: Extras | None = None, corners: list | None = None) -> dict:
    """Everything the report screen shows about going faster, from the prepared laps. corners: the track's official
    corners as given to the engine, to check the speed at each corner of a section that holds several."""
    laps = prep.laps
    realistic = _realistic(prep)
    brake_unit = (extras.units.get("brake", "") if extras else "")
    corner_at = {c[0]: int(c[1]) for c in corners or [] if c[1] is not None} if prep.numbering == "official" else {}
    secs = prep.sections
    sections = []
    for i, s in enumerate(secs):
        sections.append(_section(prep, s, secs[i - 1].code if len(secs) > 1 else None, realistic, brake_unit,
                                 corner_at))
    for sec in sections:
        sec["loss_line"] = _loss_line(sec)

    times = np.array([x.time for x in laps])
    fastest = prep.reference
    ideal = sum(sec["times"]["best"] for sec in sections)
    score = lap_scores(fastest, prep)
    score.pop("own_line_extraction", None)
    typical_lap = float(np.median(times))
    gains = []
    for sec in sorted(sections, key=lambda s: -s["gain_s"])[:TOP_GAINS]:
        if sec["gain_s"] < 0.02:
            break
        gains.append({"code": sec["code"], "seconds": sec["gain_s"], "main_phase": sec["main_phase"],
                      "action": sec["headline"], "advice": sec["advice"],
                      "fastest_lap_to_best": sec["ladder"]["driving"]})
    where_total = {k: round(sum(sec["where"][k] for sec in sections), 3) for k in WHERE.values()}

    # trends and consistency
    by_run: dict[str, list[LapRecord]] = {}
    for x in laps:
        by_run.setdefault(x.run, []).append(x)
    runs = []
    for name, xs in by_run.items():
        best = min(xs, key=lambda x: x.time)
        ts = [x.time for x in xs]
        runs.append({"run": name, "session_id": extras.session_of.get(best.key) if extras else None,
                     "driver": xs[0].driver, "clean_laps": len(xs), "best": best.time, "best_lap": best.number,
                     "median": round(float(np.median(ts)), 3), "consistency": consistency(ts),
                     "extraction": round(100 * prep.sim.time / best.time, 2)})
    relations = lap_time_relations(prep, {sec["code"]: sec["_rows"] for sec in sections}, extras)
    lap_rows = [{"run": x.run, "lap": x.number, "time": x.time, "index_in_run": x.index_in_run,
                 "extraction": round(100 * prep.sim.time / x.time, 2)} for x in laps]
    spread = sorted(({"code": sec["code"], "spread_s": sec["spread_s"]} for sec in sections),
                    key=lambda r: -r["spread_s"])

    summary = _summary(fastest, score, round(typical_lap, 3), round(ideal, 3), round(realistic.time, 3), gains,
                       where_total, len(laps))  # the numbers as the screen shows them
    trace = _profiles(prep, sections, realistic)
    for sec in sections:
        del sec["_quick"], sec["_rows"]
    return {
        "length_m": prep.length - 1,
        "numbering": prep.numbering,
        "laps_analysed": len(laps),
        "runs_analysed": len(by_run),
        "headline": {
            "fastest": {"time": fastest.time, "run": fastest.run, "lap": fastest.number,
                        "session_id": extras.session_of.get(fastest.key) if extras else None},
            "ideal": round(ideal, 3),
            "realistic": round(realistic.time, 3),
            "theoretical": round(prep.sim.time, 3),
            "typical": round(typical_lap, 3),
            "score": {**score, "realistic_extraction": round(100 * realistic.time / fastest.time, 2)},
        },
        "summary": summary,
        "gains": gains,
        "where_total": where_total,
        "sections": sections,
        "trace": trace,
        "lap_time_relations": relations,
        "trends": {"runs": runs, "laps": lap_rows, "spread": spread, "consistency": consistency(list(times))},
        "method": METHOD,
    }


def _summary(fastest: LapRecord, score: dict, typical: float, ideal: float, realistic: float, gains: list[dict],
             where_total: dict[str, float], n_laps: int) -> str:
    medal = score.get("medal")
    nxt = score.get("next_medal")
    out = (f"The fastest lap, {fastest.run} lap {fastest.number} ({lap_text(fastest.time)}), took "
           f"{score['extraction']:.1f}% of the car's theoretical pace")
    if medal:
        out += f": a {medal} score"
        if nxt:
            gap = nxt["seconds_to_find"]
            out += f", {gap:.2f} s from {nxt['medal']}." if gap >= 0.01 else f", on the edge of {nxt['medal']}."
        else:
            out += "."
    else:
        out += "."
    if ideal < fastest.time - 0.01:
        out += (f" The best pass of every section adds up to {lap_text(ideal)}, and the realistic target with the car "
                f"holding 95% of its grip is {lap_text(realistic)}.")
    if gains:
        names = ", ".join(f"{g['code']} ({g['seconds']:.2f} s)" for g in gains)
        out += (f" A typical lap ({lap_text(typical)}) gains most by driving like the quickest passes in {names}")
        main = max(where_total.items(), key=lambda kv: kv[1])
        out += f"; across the lap, most of that time is on {main[0]}." if main[1] > 0 else "."
    if n_laps < MIN_LAPS_FOR_TRENDS:
        out += (f" With {n_laps} clean laps the link between each habit and the time can't be measured yet, so the "
                "advice compares the quickest passes with the rest.")
    return out


METHOD = [
    "Every clean lap is lined up on the fastest lap by position (GPS, with wheel-speed distance between fixes) and "
    "timed line to line.",
    "The car's limits are the 98th percentile of the grip it used in every direction and at every speed on the laps "
    "within 2% of the quickest. The theoretical lap is the fastest lap's line driven at those limits everywhere.",
    "No car holds its peak grip all the way through a long corner, so the realistic target is the same lap with the "
    "car holding 95% of it.",
    "Sections run from the fast point before a corner to the same point before the next one, so each holds the "
    "braking, the corner and the straight after it. They carry the track's official corner numbers.",
    "Quick passes are the quickest tenth of all passes of a section (at least three). Typical is the median pass. "
    "Distances are metres from the start/finish line.",
    "The link says how strongly a habit goes with a quicker section lap to lap within the same run, so tyre and "
    "fuel changes through a run don't count: strong above 0.6, clear from 0.3. It shows what goes with a quicker "
    "pass, not what causes it.",
    "Where the time goes splits the gap between a typical pass and the quick passes by what the quickest pass was "
    "doing at each metre: braking in a straight line, braking into the turn (entry), mid-corner, on the throttle "
    "while turning (exit) and full throttle.",
    "What goes with lap time compares every clean lap's time with the engine's measures of the lap and with every "
    "slow channel the logger recorded, lap to lap within each run and across all laps. Only clear relationships "
    "are kept; each is sized over the range of values seen. One that is no longer clear once each run's first two "
    "laps are left out is shown apart: it comes from the car warming up.",
]
