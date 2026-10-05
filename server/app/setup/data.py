"""The logger-data side of the setup suggestions: the balance report's analysis of the run (app.analysis.balance
and app.analysis.setup_advice, kept in the run summary by app.setup.results), set against the driver's debrief.

Three things come from it:
- what the data measures, as Observations: each corner's balance on entry, mid-corner and exit where it is clearly
  away from the car's normal (the report's "clear" and "strong", 0.8 degrees and more), and the corners where
  traction control or rear wheel slip says the rear can't take the power;
- a check of each driver remark against the same numbers: the data agrees, leans the same way, reads normal, says
  the opposite, or doesn't measure it;
- the report's own ranked setup changes, which suggest() maps onto the levers of the car's sheet (ADVICE_LEVERS).
"""
from __future__ import annotations

from app.analysis.setup_advice import HIGH_SLIP, TC_PER_LAP, deg, describe
from app.debrief.check import _codes
from app.setup.suggest import PHASE_LABEL, Observation

STRENGTH_WEIGHT = {"clear": 1.0, "strong": 1.5}
TC_PER_PASS = 0.5  # s of traction control in one pass of a corner that says the rear can't take the power there


def _phase(o: Observation) -> str:
    return {"braking": "entry", None: "mid"}.get(o.phase, o.phase)


def section_for(corner: str | None, summary: dict) -> dict | None:
    """The run's section holding this official corner number (T6 is in "T6", T3 in "T2-T5")."""
    if not corner:
        return None
    code = corner.strip().upper()
    return next((s for s in summary.get("sections") or [] if code == s["code"].upper() or code in _codes(s["code"])),
                None)


def measured(summary: dict | None) -> list[Observation]:
    """What the run's data shows that a setup change could address, as data Observations."""
    out: list[Observation] = []
    for s in (summary or {}).get("sections") or []:
        for phase in ("entry", "mid", "exit"):
            v = s.get(phase)
            d = describe(v)
            if d is None or d["strength"] not in STRENGTH_WEIGHT:
                continue
            out.append(Observation(
                kind=d["kind"], phase=phase, corner=s["code"], speed=s["speed"], weight=STRENGTH_WEIGHT[d["strength"]],
                source="data", text=f"{s['code']} {PHASE_LABEL[phase]}: {deg(v)} against the car's normal "
                                    f"({d['strength']} {d['kind']})", ref={"section": s["code"], "phase": phase}))
        tc, slip = s.get("tc_s") or 0.0, s.get("rear_slip_exit") or 0.0
        if tc >= TC_PER_PASS or slip >= HIGH_SLIP:
            said = [f"traction control {tc:.1f} s per pass"] if tc >= TC_PER_PASS else []
            said += [f"rear wheel slip {slip:.0f} % on exit"] if slip >= HIGH_SLIP else []
            out.append(Observation(kind="traction", phase="exit", corner=s["code"], speed=s["speed"], source="data",
                                   text=f"{s['code']}: {' and '.join(said)}", ref={"section": s["code"]}))
    return out


def check(o: Observation, summary: dict | None) -> dict | None:
    """What the run's data says about one remark: verdict agree (clear, the same way), slight (leans the same way),
    normal, disagree (the other way) or unmeasured, with the number it reads. None for what the balance analysis
    doesn't measure (lock-ups, braking stability, kerbs)."""
    if summary is None or o.kind not in ("understeer", "oversteer", "traction"):
        return None
    sec = section_for(o.corner, summary)
    if o.corner and sec is None:
        return {"verdict": "unmeasured", "text": f"The data has no section for {o.corner}."}
    if o.kind == "traction":
        if sec is not None:
            tc, slip = sec.get("tc_s"), sec.get("rear_slip_exit")
            if tc is None and slip is None:
                return {"verdict": "unmeasured", "text": f"No traction control or wheel slip channel at {sec['code']}."}
            seen = (tc or 0) >= TC_PER_PASS or (slip or 0) >= HIGH_SLIP
            parts = ([f"traction control {tc:.1f} s per pass"] if tc is not None else []) + \
                ([f"rear wheel slip {slip:.0f} %"] if slip is not None else [])
            return {"verdict": "agree" if seen else "normal", "text": f"{sec['code']}: {' and '.join(parts)}."}
        tc = summary.get("tc_s_per_lap")
        if tc is None:
            return {"verdict": "unmeasured", "text": "No traction control channel in this log."}
        return {"verdict": "agree" if tc >= TC_PER_LAP else "normal",
                "text": f"Traction control works {tc:.1f} s a lap."}
    phase = _phase(o)
    bal = summary.get("balance")
    if bal is None:
        return {"verdict": "unmeasured", "text": "This log has no balance (no steering or yaw rate channel)."}
    if sec is not None:
        v, label = sec.get(phase), f"{sec['code']} {PHASE_LABEL[phase]}"
    elif o.speed:
        v = next((r.get(phase) for r in bal["by_speed"] if r["speed"] == o.speed), None)
        label = f"{PHASE_LABEL[phase].capitalize()} in {o.speed} corners"
    else:
        v, label = bal.get(phase), f"{PHASE_LABEL[phase].capitalize()} over all corners"
    if v is None:
        return {"verdict": "unmeasured", "text": f"{label}: not enough cornering to read the balance."}
    d = describe(v)
    reads = f"{deg(v)} against the car's normal, " + ("normal" if d["kind"] == "normal" else
                                                       f"{d['strength']} {d['kind']}")
    verdict = "normal" if d["kind"] == "normal" else "disagree" if d["kind"] != o.kind else \
        "slight" if d["strength"] == "slight" else "agree"
    return {"verdict": verdict, "value": v, "where": label, "reads": reads, "text": f"{label}: {reads}."}
