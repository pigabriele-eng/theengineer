"""Check what the driver said in a debrief against what the logger recorded, and suggest how to drive it.

Each debrief point is read for a claim (understeer, oversteer, traction, lock-ups, tyres...), the corner and
the phase. The data then says whether that corner really stands out that way against the car's other
corners in the same session. Balance is judged corner against corner, not against an absolute number: the
car has no "correct" steering angle, but a corner that needs much more steering than the rest does stand out.
"""
from __future__ import annotations

import re
from dataclasses import dataclass

import numpy as np

from app.analysis.insights import (
    CornerSpec,
    Prepared,
    RunInput,
    Section,
    _trend_rows,
    _within,
    corr,
    prepare,
    section_metrics,
)

NEG = re.compile(r"\b(no|not|never|without|non|senza|kein\w*|nicht|ohne)\b[\w' ]{0,20}$", re.I)
CLAIMS: list[tuple[str, re.Pattern]] = [  # first match wins, so the specific ones come first
    ("braking_stability", re.compile(r"unstable (under|on the|in|when) brak|moving (around )?under brak|"
                                     r"instabile in frenata|instabil\w* beim brems|unruhig beim brems", re.I)),
    ("lock_up", re.compile(r"\block(ing|s|ed|-up| up)?\b|flat ?spot|bloccag|blocca|blockier", re.I)),
    ("abs", re.compile(r"\babs\b", re.I)),
    ("traction", re.compile(r"traction|wheel ?spin|spinning up|power down|\btc\b|trazion|pattin|slittament|"
                            r"traktion|durchdreh", re.I)),
    ("understeer", re.compile(r"under ?steer|\bpush(es|ing|y)?\b|wash(es|ing)? (out|wide)|no front|lack of front|"
                              r"front (doesn'?t|does not|won'?t) (turn|bite)|sottosterz|non (gira|entra)|"
                              r"untersteu|schiebt", re.I)),
    ("oversteer", re.compile(r"over ?steer|\bloose\b|rear (steps|stepping|comes|coming|snaps) (out|round|around)|"
                             r"\bsnap|nervous rear|rear (is |was )?(unstable|nervous|loose)|sovrasterz|"
                             r"posteriore (scappa|nervos|instabil)|übersteu|heck (kommt|bricht|unruhig)", re.I)),
    ("tyre_drop", re.compile(r"degrad|drop[- ]?off|grip (goes|going|went) away|tyres? (gone|finished)|overheat|"
                             r"\bcalo\b|gomme (finite|andate)|surriscald|abbau|nachlass|überhitz", re.I)),
    ("tyre_warmup", re.compile(r"cold tyres?|warm[- ]?up|to (come in|switch on)|gomme fredde|riscald|"
                               r"kalte reifen|aufwärm", re.I)),
]
PHASE_WORDS = [
    ("braking", re.compile(r"brak|frenat|brems", re.I)),
    ("entry", re.compile(r"entry|turn[- ]?in|ingresso|inserimento|eingang|einlenk", re.I)),
    ("mid", re.compile(r"\bmid|apex|middle|centro|corda|scheitel|mitte", re.I)),
    ("exit", re.compile(r"exit|on the way out|out of the corner|uscita|ausgang", re.I)),
]
CLAIM_LABEL = {
    "understeer": "understeer", "oversteer": "oversteer", "traction": "traction / wheelspin",
    "lock_up": "locking wheels", "braking_stability": "unstable under braking", "abs": "ABS",
    "tyre_drop": "tyres dropping off", "tyre_warmup": "slow tyre warm-up",
}
SUGGEST = {
    ("understeer", "entry"): "Release the brake more progressively as you turn in so the front keeps its load, "
                             "and wait for the front to bite instead of adding steering.",
    ("understeer", "mid"): "Be patient with the throttle and aim for a slightly later apex: a little less speed "
                           "at the apex costs less than a front that is pushing.",
    ("understeer", "exit"): "Unwind the steering earlier and use a straighter exit before going to full throttle.",
    ("oversteer", "entry"): "Finish the heavy braking a touch earlier and release the brake more smoothly so the "
                            "rear stays planted at turn-in.",
    ("oversteer", "mid"): "Hold a light, steady throttle through the middle of the corner to settle the rear.",
    ("oversteer", "exit"): "Squeeze the throttle in more progressively and open the steering before full throttle.",
    ("traction", None): "Squeeze the throttle in more progressively and straighten the car before full throttle; "
                        "TC trimming a little wheelspin is fine, cutting the drive is not.",
    ("lock_up", None): "Build the brake pressure a fraction more progressively and release smoothly; if it "
                       "happens in every heavy stop, look at brake balance.",
    ("braking_stability", None): "Do the heavy braking in a straight line, then trail off smoothly as you turn in.",
    ("abs", None): "Ease the peak pressure slightly so ABS works less; it is lengthening the stop.",
    ("tyre_drop", None): "Look after the tyres in the first laps of the run: smoother exits and less sliding.",
    ("tyre_warmup", None): "Use the out-lap harder: firm braking and acceleration bring the temperature up "
                           "faster than weaving.",
}
OPPOSITE = {
    "understeer": "looser (it needs less steering) than", "oversteer": "pushing more (it needs more steering) than",
    "traction": "putting the power down better than", "lock_up": "locking less than",
    "braking_stability": "more stable under braking than", "abs": "using less ABS than",
}
FIXED_PHASE = {"traction": "exit", "lock_up": "braking", "braking_stability": "braking", "abs": "braking"}
Z_CONFIRM, Z_PARTLY = 0.75, 0.25


@dataclass
class Claim:
    kind: str | None
    negated: bool
    phase: str | None


def read_claim(text: str, phase: str | None = None) -> Claim:
    kind, negated = None, False
    for name, rx in CLAIMS:
        m = rx.search(text)
        if m:
            kind, negated = name, bool(NEG.search(text[:m.start()]))
            break
    if phase is None:
        phase = next((p for p, rx in PHASE_WORDS if rx.search(text)), None)
    return Claim(kind, negated, phase)


def _codes(label: str) -> list[str]:
    """T2-T4 -> T2, T3, T4; T8/T9 -> T8, T9."""
    m = re.fullmatch(r"([A-Z]+)(\d+)-[A-Z]+(\d+)", label)
    if m:
        return [f"{m[1]}{i}" for i in range(int(m[2]), int(m[3]) + 1)]
    return label.split("/")


def section_for(code: str | None, sections: list[Section]) -> Section | None:
    if not code:
        return None
    code = code.strip().upper()
    return next((s for s in sections if code in _codes(s.code)), None)


def _z(metric: str, section: Section, per: dict[str, list[dict]]) -> tuple[float | None, float | None, float | None]:
    """How far this section's median sits from the typical section, in units of the spread between sections."""
    meds = {}
    for code, ms in per.items():
        vals = [m.get(metric) for m in ms if m.get(metric) is not None]
        if len(vals) >= 2:
            meds[code] = float(np.median(vals))
    if section.code not in meds or len(meds) < 3:
        return None, None, None
    others = np.array([v for c, v in meds.items() if c != section.code])
    typical = float(np.median(others))
    spread = max(float(np.median(np.abs(others - typical))) * 1.4826, 1e-6)
    return (meds[section.code] - typical) / spread, meds[section.code], typical


def _verdict(z: float | None, negated: bool = False) -> str:
    if z is None:
        return "cannot check"
    if negated:
        z = -z
    if z >= Z_CONFIRM:
        return "confirmed"
    if z >= Z_PARTLY:
        return "partly"
    if z <= -Z_CONFIRM:
        return "contradicted"
    return "not seen"


def _metric_phase(phase: str | None) -> list[str]:
    if phase == "braking":
        return ["entry"]
    return [phase] if phase in ("entry", "mid", "exit") else ["entry", "mid", "exit"]


def check_point(text: str, corner: str | None, phase: str | None, prep: Prepared,
                per: dict[str, list[dict]], trends: dict[str, list[dict]]) -> dict:
    claim = read_claim(text, phase)
    sec = section_for(corner, prep.sections)
    out = {"claim": claim.kind, "claim_label": CLAIM_LABEL.get(claim.kind), "negated": claim.negated,
           "phase": claim.phase, "section": sec.code if sec else None}
    if claim.kind is None:
        return {**out, "verdict": "cannot check", "evidence": "No checkable claim found in this point."}
    if claim.kind in ("tyre_drop", "tyre_warmup"):
        return {**out, **_tyres(claim, prep)}
    if sec is None:
        return {**out, "verdict": "cannot check",
                "evidence": "No corner given, and this claim is checked corner against corner."}
    best = None
    for ph in _metric_phase(claim.phase):
        metric, sign, label = {
            "understeer": (f"understeer_{ph}", 1, f"steering beyond the path's need ({ph})"),
            "oversteer": (f"understeer_{ph}", -1, f"steering beyond the path's need ({ph})"),
            "traction": ("rear_slip_exit", 1, "rear wheelspin on exit (%)"),
            "lock_up": ("front_lock", 1, "front wheel slip under braking (%)"),
            "braking_stability": ("rear_rotation_braking", 1, "rear rotation under braking (°/s)"),
            "abs": ("abs", 1, "ABS working (s)"),
        }[claim.kind]
        z, val, typ = _z(metric, sec, per)
        if z is None and claim.kind == "traction":
            metric, label = "tc", "traction control working (s)"
            z, val, typ = _z(metric, sec, per)
        if z is not None and (best is None or sign * z > best[0]):
            best = (sign * z, metric, label, val, typ, ph)
    if best is None:
        return {**out, "verdict": "cannot check", "evidence": "The logger has no channel that shows this here."}
    z, metric, label, val, typ, ph = best
    balance = claim.kind in ("understeer", "oversteer")
    phase_out = claim.phase if balance else FIXED_PHASE.get(claim.kind, claim.phase)
    verdict = _verdict(z, claim.negated)
    evidence = (f"{sec.code}: {label} {val:.2f} against {typ:.2f} in the car's other corners "
                f"({len(per[sec.code])} laps).")
    if verdict == "contradicted":
        advice = ("The data does show it here, more than in the car's other corners." if claim.negated else
                  "The data points the other way here: this corner is " + OPPOSITE[claim.kind] + " the car's others.")
    elif verdict == "not seen":
        advice = ("The data does not single this corner out for that; check whether it was one lap (traffic, a "
                  "kerb) or how the car feels rather than what it does.")
    else:
        advice = SUGGEST.get((claim.kind, ph if balance else None), "")
    trend = next(iter(trends.get(sec.code, [])), None)
    if trend:
        advice += (f" The quick laps here differ most in {trend['label'].lower()}: {_fmt(trend['quick_laps_value'])}"
                   f" against {_fmt(trend['median'])}{' ' + trend['unit'] if trend['unit'] else ''} typical, "
                   f"worth about {trend['gain_s']:.2f} s.")
    return {**out, "phase": phase_out or (ph if balance else None), "verdict": verdict, "evidence": evidence,
            "z": round(z, 2), "suggestion": advice.strip()}


def _fmt(v: float) -> str:
    return f"{v:.0f}" if abs(v) >= 100 else f"{v:.1f}" if abs(v) >= 10 else f"{v:.2f}"


def _tyres(claim: Claim, prep: Prepared) -> dict:
    """Tyre claims are checked on lap times through each run."""
    rows = []
    for run in dict.fromkeys(x.run for x in prep.laps):
        laps = sorted((x for x in prep.laps if x.run == run), key=lambda x: x.index_in_run)
        rows += [(run, x.index_in_run, x.time) for x in laps]
    if len(rows) < 6:
        return {"verdict": "cannot check", "evidence": "Too few clean laps to see a trend."}
    runs = [r[0] for r in rows]
    if claim.kind == "tyre_warmup":
        slow_start = []
        for run in dict.fromkeys(runs):
            ts = [t for r, _, t in rows if r == run]
            best = min(ts)
            slow_start.append(next(i for i, t in enumerate(ts) if t <= best * 1.005))
        n = float(np.median(slow_start))
        verdict = _verdict(1.0 if n >= 2 else (0.3 if n >= 1 else -1.0), claim.negated)
        return {"verdict": verdict, "evidence": f"Laps before the pace came in (within 0.5 % of the run's best): "
                                                f"{n:.0f} in a typical run.",
                "suggestion": SUGGEST[("tyre_warmup", None)]}
    late = [(r, i, t) for r, i, t in rows if i >= 2]  # past the warm-up laps
    c = corr(_within(np.array([i for _, i, _ in late], float), [r for r, _, _ in late]),
             _within(np.array([t for _, _, t in late]), [r for r, _, _ in late])) if len(late) >= 8 else None
    if c is None:
        return {"verdict": "cannot check", "evidence": "Runs are too short to see the tyres drop off."}
    z = 1.0 if c["slope"] > 0.05 and c["p"] < 0.05 else (0.3 if c["slope"] > 0.02 else -0.3)
    return {"verdict": _verdict(z, claim.negated),
            "evidence": f"After the warm-up laps, lap time changes {c['slope']:+.2f} s per lap within a run "
                        f"(r {c['r']:+.2f}, {c['n']} laps).",
            "suggestion": SUGGEST[("tyre_drop", None)]}


def check_debrief(points: list[dict], runs: list[RunInput], corners: list[CornerSpec] | None = None, *,
                  drop_channels: bool = False) -> dict:
    """points: [{"id", "text", "corner_code", "phase"}]. Returns a verdict per point."""
    prep = prepare(runs, corners, drop_channels=drop_channels)
    if prep is None:
        return {"points": [], "error": "No clean laps in this session to check against"}
    per = {s.code: [section_metrics(x, s, prep.limits, prep.sim) for x in prep.laps] for s in prep.sections}
    trends = {code: _trend_rows(prep.laps, ms) for code, ms in per.items()}
    out = [{"id": p.get("id"), "text": p["text"], "corner": p.get("corner_code"),
            **check_point(p["text"], p.get("corner_code"), p.get("phase"), prep, per, trends)} for p in points]
    counts: dict[str, int] = {}
    for r in out:
        counts[r["verdict"]] = counts.get(r["verdict"], 0) + 1
    return {"numbering": prep.numbering, "sections": [s.to_dict() for s in prep.sections], "laps": len(prep.laps),
            "summary": counts, "points": out}
