"""Setup direction from the balance analysis: what to try first, why, and what it should do.

Each rule reads the measured balance and the time the car leaves on the table (app.analysis.balance.analyse) and
words one change, with the evidence behind it, the effect to expect and what to watch. Bar changes carry what the
steady-state vehicle model (app.vehicle.model) says they do to the balance on the car's preset. Corners are named
by their official numbers only.

Balance values are degrees of steering against the car's own normal at the same cornering g: positive is more
understeer than normal, negative more oversteer.
"""
from __future__ import annotations

from collections.abc import Callable
from dataclasses import asdict, dataclass

from app.vehicle.model import Change, what_if
from app.vehicle.presets import PRESETS, preset_vehicle

STRENGTH = ((1.5, "strong"), (0.8, "clear"), (0.3, "slight"))  # |degrees| from the car's normal
NOTABLE = 0.8  # a balance this far from normal is worth a setup change
SWING = 0.8  # mid-corner to exit, degrees: the throttle changing the balance
TC_PER_LAP = 2.0  # s of traction control a lap that says the rear can't take the power
HIGH_SLIP = 8.0  # % rear wheel slip on the exit (90th percentile)
REAR_COOL = 10.0  # °C the rear tyres run cooler than the fronts
CAR_SHARE_MIN = 0.03  # s: below this a section's car share is noise
BRAKE_MORE = 5.0  # bar (and %) more peak pressure on the quickest passes
SLOW_KMH = 160  # sections slower than this at their slowest point count as slow and medium corners

PHASE_GROUP = {"braking": "braking", "trail": "braking", "mid": "mid-corner", "exit": "on the throttle",
               "power": "on the throttle"}

ModelFn = Callable[[str, int], dict | None]
MINUS, DASH, TIMES = "\u2212", "\u2013", "\u00d7"  # typeset minus, range dash and multiplication sign


@dataclass
class Recommendation:
    key: str
    title: str
    why: str
    expect: str
    watch: str | None = None
    model: dict | None = None
    sections: list[str] | None = None


def deg(v: float) -> str:
    """Signed degrees with a typeset minus sign, as +1.5° or -0.3° (with MINUS)."""
    return f"{'+' if v >= 0 else MINUS}{abs(v):.1f}°"


def listed(items: list[str]) -> str:
    items = list(dict.fromkeys(items))
    if len(items) <= 1:
        return "".join(items)
    return f"{', '.join(items[:-1])} and {items[-1]}"


def describe(v: float | None) -> dict | None:
    """How a balance value reads: understeer or oversteer, and how strong."""
    if v is None:
        return None
    shown = round(abs(v), 1)  # as printed, so two values that read the same are described the same
    strength = next((name for limit, name in STRENGTH if shown >= limit), None)
    return {"kind": "normal" if strength is None else "understeer" if v > 0 else "oversteer", "strength": strength}


def where_car_loses(row: dict) -> str | None:
    """The part of the corner where the quickest pass is furthest from the car holding 95 % of its grip."""
    groups: dict[str, float] = {}
    for phase, s in row["car_by_phase"].items():
        groups[PHASE_GROUP[phase]] = groups.get(PHASE_GROUP[phase], 0.0) + s
    top = max(groups, key=groups.get)
    return top if groups[top] > CAR_SHARE_MIN / 2 else None


def bar_model(preset: str | None) -> ModelFn:
    """A function giving what one bar step does on the car's preset (None when there is no preset or no room)."""
    def run(axle: str, step: int) -> dict | None:
        if preset not in PRESETS:
            return None
        base = preset_vehicle(preset)
        rates, at = getattr(base, f"arb_{axle}_settings_n_per_mm"), getattr(base, f"arb_{axle}_setting")
        if not rates or at is None or not 1 <= at + step <= len(rates):
            return None
        res = what_if(base, [Change(field=f"arb_{axle}_setting", add=step)])
        a, b = res["baseline"], res["changed"]
        values = PRESETS[preset][1]
        estimated = values[f"arb_{axle}_settings_n_per_mm"].confidence != "published"
        return {
            "preset": preset, "car": PRESETS[preset][0], "axle": axle, "from": at, "to": at + step,
            "positions": len(rates),
            "llt_front_share": [round(100 * a["lateral_load_transfer_front_share"], 1),
                                round(100 * b["lateral_load_transfer_front_share"], 1)],
            "roll_gradient": [a["roll_gradient_deg_per_g"], b["roll_gradient_deg_per_g"]],
            "summary": res["summary"],
            "note": (f"The model starts from setting {at} of {len(rates)}"
                     + (" with estimated bar rates" if estimated else "")
                     + ": set the car's real bars in the vehicle model to check."),
        }
    return run


def _sections(a: dict) -> dict[str, dict]:
    return {s["code"]: s for s in a["sections"]}


def _bal(s: dict, phase: str) -> float | None:
    return (s.get("balance") or {}).get(phase, {}).get("value")


def _power_oversteer(a: dict, model: ModelFn, recs: list[Recommendation]) -> str | None:
    """The rear won't take power while the car is still turning. Returns the headline when it fires."""
    g, diag = a["gradient"], a["diagnostics"]
    if not g:
        return None
    slow_rows = [r for r in g["table"] if r["speed"] != "fast" and r["mid"] is not None and r["exit"] is not None]
    band = max(slow_rows, key=lambda r: r["mid"] - r["exit"], default=None)
    swing_band = band if band and band["mid"] - band["exit"] >= max(g["spread"], SWING) else None
    secs = a["sections"]
    swings = sorted(((s["code"], _bal(s, "mid") - _bal(s, "exit")) for s in secs if s["min_speed_kmh"] < SLOW_KMH
                     and _bal(s, "mid") is not None and _bal(s, "exit") is not None
                     and _bal(s, "mid") - _bal(s, "exit") >= max(g["spread"], SWING)), key=lambda x: -x[1])
    loose = [(s["code"], _bal(s, "exit")) for s in secs if (_bal(s, "exit") or 0) <= -NOTABLE]
    tc = diag.get("traction_control_s_per_lap")
    tc_secs = sorted((s for s in secs if s.get("tc_s")), key=lambda s: -s["tc_s"]["typical"])
    slips = sorted((s for s in secs if s.get("rear_slip_exit") and s["rear_slip_exit"]["typical"] >= HIGH_SLIP),
                   key=lambda s: -s["rear_slip_exit"]["typical"])
    temps = (diag.get("tyres") or {}).get("temperature")
    if not (swing_band or loose) or not ((tc or 0) >= TC_PER_LAP or slips):
        return None

    evidence = []
    if swing_band:
        evidence.append(f"the balance moving {swing_band['mid'] - swing_band['exit']:.1f}° towards oversteer once the "
                        f"throttle goes on in {swing_band['speed']} corners ({deg(swing_band['mid'])} mid-corner, "
                        f"{deg(swing_band['exit'])} on the throttle)")
    if loose:
        evidence.append(f"the rear sliding on the throttle out of {listed([c for c, _ in loose])} "
                        f"({', '.join(deg(v) for _, v in loose)})")
    if (tc or 0) >= TC_PER_LAP and tc_secs:
        top = tc_secs[0]
        evidence.append(f"traction control working {tc:.1f} s a lap, most in {top['code']} "
                        f"({top['tc_s']['typical']:.1f} s per pass)")
    if slips:
        evidence.append(f"the rear wheels slipping {slips[0]['rear_slip_exit']['typical']:.0f} % out of "
                        f"{slips[0]['code']}")
    if temps and temps["front_minus_rear"] >= REAR_COOL:
        evidence.append(f"the rear tyres running about {temps['front_minus_rear']:.0f} °C cooler than the fronts")
    on_power = [s for s in secs if s["car"] >= CAR_SHARE_MIN and where_car_loses(s) == "on the throttle"]
    on_power.sort(key=lambda s: -s["car"])
    cost = sum(s["car"] for s in on_power)
    out_of = [c for c, _ in swings[:4]] or [c for c, _ in loose]

    expect = f"Less oversteer on the throttle out of {listed(out_of)}"
    if tc_secs and (tc or 0) >= TC_PER_LAP:
        expect += f" and less traction control, most of all in {tc_secs[0]['code']}"
    expect += "."
    if on_power:
        expect += (f" The car leaves {cost:.2f} s on the throttle against its own grip in "
                   f"{listed([s['code'] for s in on_power])}: that is what this change goes after.")
    pushes = sorted(((s["code"], _bal(s, "mid")) for s in secs if s["min_speed_kmh"] < SLOW_KMH
                     and (_bal(s, "mid") or 0) >= NOTABLE), key=lambda x: -x[1])
    watch = ("Mid-corner understeer. The car already needs more steering than normal in the middle of "
             f"{listed([c for c, _ in pushes[:3]])} ({', '.join(deg(v) for _, v in pushes[:3])}), and moving roll "
             "stiffness forward adds a little to it." if pushes
             else "More understeer mid-corner, most of all in the fast corners.")
    rear, front = model("rear", -1), model("front", 1)
    why = ("The rear won't take power while the car is still turning. Moving roll stiffness forward takes load "
           "transfer off the rear axle, so the inside rear tyre keeps more load and puts the power down.")
    if front:
        why += (f" One step stiffer on the front bar does the same job (front share of load transfer "
                f"{front['llt_front_share'][0]:.1f} % to {front['llt_front_share'][1]:.1f} %) if the rear is "
                "already at its softest.")
    recs.append(Recommendation("rear_bar_softer", "Rear anti-roll bar one step softer", why, expect, watch, rear,
                               out_of))
    recs.append(Recommendation(
        "rear_bump_softer", "If that is not enough: rear low-speed bump one click softer",
        "Softer low-speed bump damping at the rear lets the car squat and load the rear tyres as the throttle goes "
        "on. Damping only acts while the car moves, so the steady-state vehicle model can't show it.",
        "Traction control cuts in later and less in the first metres on the throttle.",
        "Too soft and the rear wallows over kerbs and in quick direction changes. One click at a time."))
    fast_power = [s["code"] for s in on_power if s["min_speed_kmh"] >= 100]
    if fast_power:
        recs.append(Recommendation(
            "rear_wing", "Rear wing one step up, only if both fail",
            f"More rear downforce helps the rear take the power where the exits are fast: {listed(fast_power)}.",
            f"Less traction control and more exit speed out of {listed(fast_power)}.",
            "It costs top speed on every straight. Check the straight-line speed against this test."))
    return ("One weakness runs through the data: the rear won't take power while the car is still turning. "
            f"It shows as {listed(evidence)}. The first change to try is one step softer on the rear anti-roll bar.")


def _slow_mid_understeer(a: dict, model: ModelFn, recs: list[Recommendation], rear_first: bool) -> str | None:
    g = a["gradient"]
    slow = next((r for r in g["table"] if r["speed"] == "slow"), None) if g else None
    if not slow or (slow["mid"] or 0) < NOTABLE:
        return None
    pushes = sorted(((s["code"], _bal(s, "mid"), (s["balance"].get("mid") or {}).get("quick"))
                     for s in a["sections"] if s["min_speed_kmh"] < 110 and (_bal(s, "mid") or 0) >= NOTABLE),
                    key=lambda x: -x[1])
    if not pushes:
        return None
    codes = [c for c, _, _ in pushes]
    why = (f"In the slow corners the car needs more steering than normal mid-corner: "
           f"{', '.join(f'{c} {deg(v)}' for c, v, _ in pushes)}.")
    harder = [c for c, v, q in pushes if q is not None and q > v + 0.3]
    if harder:
        why += f" The quickest passes push even more in {listed(harder)}: they carry more speed into the same limit."
    if rear_first:
        recs.append(Recommendation(
            "front_grip_slow", "Then: more front grip in slow corners, without the bars",
            why + " Look for front grip that doesn't move roll stiffness: a little more front negative camber or "
            "front toe-out. A softer front bar would undo the rear-bar change.",
            f"Less steering mid-corner in {listed(codes)} and a little more speed at the slowest point.",
            "Sharper turn-in, and front tyre wear on the inside shoulder with more camber.", None, codes))
        return None
    recs.append(Recommendation(
        "front_bar_softer", "Front anti-roll bar one step softer",
        why + " A softer front bar moves load transfer to the rear, so the front tyres share the load more evenly.",
        f"Less steering mid-corner in {listed(codes)}.", "The rear on the throttle out of the same corners.",
        model("front", -1), codes))
    return (f"The car pushes in the middle of the slow corners ({listed(codes)}). The first change to try is one "
            "step softer on the front anti-roll bar.")


def _entry(a: dict, recs: list[Recommendation]) -> str | None:
    g = a["gradient"]
    if not g:
        return None
    for r in g["table"]:
        e, m = r["entry"], r["mid"]
        if e is None or m is None:
            continue
        if e >= NOTABLE and e - m >= g["spread"]:
            recs.append(Recommendation(
                "brake_bias_rear", "Brake balance one step rearward",
                f"In {r['speed']} corners the car pushes on the way in, while still braking ({deg(e)} against "
                f"{deg(m)} mid-corner).", "The car turns in on the brakes with less steering.",
                "The rear under braking, and ABS working on the rear axle."))
            return f"The car pushes on entry in {r['speed']} corners. Try one step rearward on the brake balance."
        if e <= -NOTABLE and m - e >= g["spread"]:
            recs.append(Recommendation(
                "brake_bias_front", "Brake balance one step forward",
                f"In {r['speed']} corners the rear slides on the way in, while still braking ({deg(e)} against "
                f"{deg(m)} mid-corner).", "A calmer rear on turn-in.",
                "More understeer on entry and the fronts locking (more ABS on the front)."))
            return f"The rear is loose on entry in {r['speed']} corners. Try one step forward on the brake balance."
    return None


def _exit_understeer(a: dict, model: ModelFn, recs: list[Recommendation]) -> str | None:
    g = a["gradient"]
    if not g:
        return None
    for r in g["table"]:
        x, m = r["exit"], r["mid"]
        if x is not None and m is not None and x >= NOTABLE and x - m >= g["spread"]:
            recs.append(Recommendation(
                "rear_bar_stiffer", "Rear anti-roll bar one step stiffer",
                f"In {r['speed']} corners the car pushes once the throttle is on ({deg(x)} against {deg(m)} "
                "mid-corner). A stiffer rear bar moves load transfer to the rear and frees the front.",
                "Less steering on the exits.", "Traction control and the rear on the throttle.", model("rear", 1)))
            return (f"The car pushes on the throttle in {r['speed']} corners. Try one step stiffer on the rear "
                    "anti-roll bar.")
    return None


def _aero(a: dict, recs: list[Recommendation]) -> None:
    g = a["gradient"]
    rows = {r["speed"]: r for r in g["table"]} if g else {}
    slow, fast = (rows.get("slow") or {}).get("mid"), (rows.get("fast") or {}).get("mid")
    if slow is None or fast is None:
        return
    gap = max(g["spread"], NOTABLE)
    if fast - slow >= gap and fast >= NOTABLE:
        recs.append(Recommendation(
            "aero_front", "More front aero, or a step less rear wing",
            f"The car pushes more in fast corners than slow ones mid-corner ({deg(fast)} against {deg(slow)}): "
            "that is the aero balance, not the bars.", "Less steering in the fast corners.",
            "The rear in the fast corners, and top speed if the wing goes up."))
    elif slow - fast >= gap and fast <= -NOTABLE:
        recs.append(Recommendation(
            "aero_rear", "A step more rear wing",
            f"The car is looser in fast corners than slow ones mid-corner ({deg(fast)} against {deg(slow)}): that "
            "is the aero balance, not the bars.", "A calmer rear in the fast corners.",
            "Top speed on the straights."))


def _braking_note(a: dict) -> str | None:
    """Where the car's share is in the braking but the quickest passes simply brake harder: no setup change."""
    found = []
    for s in a["sections"]:
        pb = s.get("peak_brake")
        if s["car"] < CAR_SHARE_MIN or where_car_loses(s) != "braking" or not pb or pb["quick"] is None:
            continue
        more = pb["quick"] - pb["typical"]
        if more >= BRAKE_MORE and more >= 0.05 * pb["typical"]:
            found.append((s["code"], more))
    if not found:
        return None
    abs_share = a["diagnostics"].get("abs_share_of_braking")
    more = _span([m for _, m in found], ".0f").replace(DASH, " to ")
    text = (f"Brakes need no setup change. Into {listed([c for c, _ in found])} the car's share is in the braking, "
            f"but the quickest passes there use {more} bar more pressure: the time is in how hard the pedal goes on")
    if abs_share is not None:
        text += f". ABS works in {abs_share * 100:.0f} % of all braking"
    return text + "."


def checks(a: dict) -> list[dict]:
    """The numbers to compare after a change, from this data."""
    out = []
    diag, secs, focus = a["diagnostics"], a["sections"], a.get("focus")
    tc = diag.get("traction_control_s_per_lap")
    if tc is not None:
        out.append({"label": "Traction control per lap", "value": f"{tc:.1f} s"})
    tc_secs = sorted((s for s in secs if s.get("tc_s")), key=lambda s: -s["tc_s"]["typical"])
    if tc_secs and tc_secs[0]["tc_s"]["typical"] > 0:
        out.append({"label": f"Traction control in {tc_secs[0]['code']}",
                    "value": f"{tc_secs[0]['tc_s']['typical']:.2f} s per pass"})
    g = a.get("gradient")
    slow = next((r for r in g["table"] if r["speed"] == "slow"), None) if g else None
    if slow and slow["exit"] is not None and slow["mid"] is not None:
        out.append({"label": "Balance on the throttle, slow corners",
                    "value": f"{deg(slow['exit'])} (mid-corner {deg(slow['mid'])})"})
    slips = sorted((s for s in secs if s.get("rear_slip_exit")), key=lambda s: -s["rear_slip_exit"]["typical"])
    if slips:
        out.append({"label": f"Rear wheel slip out of {slips[0]['code']}",
                    "value": f"{slips[0]['rear_slip_exit']['typical']:.0f} %"})
    if focus:
        ms = next(s for s in secs if s["code"] == focus["code"]).get("min_speed")
        if ms and ms["quick"] is not None:
            out.append({"label": f"Minimum speed in {focus['code']}",
                        "value": f"{ms['typical']:.0f} km/h typical, {ms['quick']:.0f} quick"})
    temps = (diag.get("tyres") or {}).get("temperature")
    if temps:
        out.append({"label": "Rear tyre temperature",
                    "value": f"{_span([temps['rl'], temps['rr']], '.0f')} °C "
                             f"(fronts {_span([temps['fl'], temps['fr']], '.0f')})"})
    return out


def advise(a: dict, model: ModelFn) -> dict:
    """The headline, the setup changes to try in order, notes and the checks, from analyse()'s output."""
    recs: list[Recommendation] = []
    heads = [_power_oversteer(a, model, recs)]
    heads.append(_slow_mid_understeer(a, model, recs, rear_first=heads[0] is not None))
    heads.append(_exit_understeer(a, model, recs) if heads[0] is None else None)
    heads.append(_entry(a, recs))
    _aero(a, recs)
    notes = [n for n in (_braking_note(a),) if n]
    if a.get("gradient") is None:
        headline = ("This log has no usable steering or yaw rate channel, so the balance can't be read. The time "
                    "split below still shows where the car, not the driver, limits the lap.")
    else:
        headline = next((h for h in heads if h), None) or (
            "No part of the corner stands out from the car's normal balance by more than the usual lap-to-lap "
            "scatter, so there is no clear setup change to make from this data.")
    return {"headline": headline, "recommendations": [asdict(r) for r in recs], "notes": notes, "checks": checks(a)}


# ---------- the report section ----------

def lap_time(s: float) -> str:
    m = int(s // 60)
    return f"{m}:{s - 60 * m:06.3f}" if m else f"{s:.3f}"


def lap_name(key: str) -> str:
    run, _, number = key.rpartition("#")
    return f"{run} lap {number}"


def car_limits(a: dict) -> dict:
    """Where the car, not the driver, limits the lap: per section and for the whole lap."""
    ref, ideal, held, theo = a["reference"]["time"], a["ideal_lap"], a["held_lap"], a["theoretical_lap"]
    rows = [{"code": s["code"], "car": round(max(s["car"], 0.0), 3), "driving": s["driving"],
             "optimism": s["optimism"], "where": where_car_loses(s) if s["car"] >= CAR_SHARE_MIN else None,
             "tc_s": (s.get("tc_s") or {}).get("typical"),
             "rear_slip_exit": (s.get("rear_slip_exit") or {}).get("typical"),
             "held_grip": (s.get("held_grip") or {}).get("max")} for s in a["sections"]]
    beaten = [s["code"] for s in a["sections"] if s["car"] < -CAR_SHARE_MIN]
    text = (f"The fastest lap is {ref - theo:.2f} s off the theoretical lap: {ref - ideal:.2f} s is driving (the "
            f"fastest lap against the best of every section), {ideal - held:.2f} s is the car (the best sections "
            f"against the car holding {a['held_share'] * 100:.0f} % of its peak grip) and {held - theo:.2f} s is the "
            "theoretical lap asking for more grip than any lap held.")
    if beaten:
        text += f" In {listed(beaten)} the quickest passes already beat the {a['held_share'] * 100:.0f} % target."
    return {"lap": {"reference": ref, "ideal": ideal, "held": held, "theoretical": theo,
                    "driving": round(ref - ideal, 3), "car": round(ideal - held, 3),
                    "optimism": round(held - theo, 3)},
            "total_car": round(sum(r["car"] for r in rows), 3), "sections": rows, "text": text}


def focus_text(a: dict) -> list[dict]:
    """Why the focus section is so far from the theoretical lap: driving, car, theoretical."""
    f = a.get("focus")
    if not f:
        return []
    s = next(x for x in a["sections"] if x["code"] == f["code"])
    r, b = f["reference"], f["best"]
    same_run = r["lap"].rpartition("#")[0] == b["lap"].rpartition("#")[0]
    drive = (f"The quickest pass ({lap_name(b['lap'])}) carried {b['min_speed_kmh']:.0f} km/h at the slowest point "
             f"against {r['min_speed_kmh']:.0f} on the fastest lap ({lap_name(r['lap'])})")
    if "throttle_lifts" in r and "throttle_lifts" in b and b["throttle_lifts"] < r["throttle_lifts"]:
        drive += f", and lifted off the throttle {b['throttle_lifts']} times against {r['throttle_lifts']}"
    drive += "." + (" Same run, same tyres: the car could do it." if same_run else "")
    car = "Even the quickest pass doesn't hold the car's grip through the section"
    hg = f.get("held_grip")
    if hg:
        car += (f": the most cornering g any lap held over 40 m here is {hg['max'] * 100:.0f} % of the car's peak, and "
                f"{hg['p98'] * 100:.0f} % is usual for the best of them")
    car += "."
    extra = []
    if s.get("tc_s") and s["tc_s"]["typical"] > 0:
        extra.append(f"traction control works {s['tc_s']['typical']:.1f} s per pass here"
                     + (f" ({r['tc_s']:.1f} s on the fastest lap)" if r.get("tc_s") is not None else ""))
    ex = _bal(s, "exit")
    if ex is not None and describe(ex)["kind"] != "normal":
        extra.append(f"the balance on the throttle is {deg(ex)} against the car's normal")
    if s.get("rear_slip_exit"):
        extra.append(f"the rear wheels slip {s['rear_slip_exit']['typical']:.0f} % on the way out")
    if extra:
        car += " " + listed(extra)[0].upper() + listed(extra)[1:] + "."
    low_r, low_b = r.get("balance_low"), b.get("balance_low")
    if low_r is not None and low_r <= -1.5:
        car += (f" On the fastest lap the steering drops to {abs(low_r):.1f}° below the car's normal at one point: "
                "the rear stepping out.")
        if low_b is not None and low_b > low_r + 0.5:
            car += f" The quickest pass had less of it ({abs(low_b):.1f}°), but not none." if low_b <= -0.5 else \
                " The quickest pass had almost none of it."
    theo = (f"The theoretical lap holds the car's peak, {f['theoretical_peak_g']:.2f} g, all the way through. Held to "
            f"{a['held_share'] * 100:.0f} % of it, {f['code']} takes {f['held_time']:.2f} s and the whole lap "
            f"{lap_time(a['held_lap'])}.")
    return [{"part": "driving", "seconds": f["driving"], "text": drive},
            {"part": "car", "seconds": f["car"], "text": car},
            {"part": "theoretical", "seconds": f["optimism"], "text": theo}]


def balance_section(a: dict) -> dict:
    """Balance per section and phase, and by corner speed, each described as understeer or oversteer."""
    def cell(v: dict | None) -> dict | None:
        return None if v is None else {**v, **describe(v["value"])}

    g = a.get("gradient")
    return {
        "sections": [{"code": s["code"], "min_speed_kmh": s["min_speed_kmh"],
                      **{p: cell((s.get("balance") or {}).get(p)) for p in ("entry", "mid", "exit")}}
                     for s in a["sections"]],
        "by_speed": [{**r, **{p: None if r[p] is None else {"value": r[p], **describe(r[p])}
                              for p in ("entry", "mid", "exit")}} for r in g["table"]] if g else [],
        "per_g": g["per_g"] if g else None,
        "by_g": g["by_g"] if g else [],
        "spread": g["spread"] if g else None,
        "notes": g["notes"] if g else [],
    }


def _span(values: list[float], fmt: str) -> str:
    lo, hi = min(values), max(values)
    return format(lo, fmt) if format(lo, fmt) == format(hi, fmt) else f"{format(lo, fmt)}{DASH}{format(hi, fmt)}"


CONFIDENCE = {"published": "published", "measured": "measured in these logs", "estimate": "an estimate",
              "unknown": "not known"}


def method(a: dict, geometry: dict, sessions: list[dict], preset: str | None) -> dict:
    """The numbers the balance is built on, each with where it came from, and how to read the section."""
    read = [s for s in sessions if "yaw_scale" in s]
    ratios = [s["steering"]["ratio"] for s in read if s["steering"].get("ratio")]
    steering = read[0]["steering"] if read else None
    wb = geometry["wheelbase_mm"]
    notes = []
    if steering and ratios:
        notes.append(f"Understeer angle = steering wheel angle ÷ {_span(ratios, '.1f')} {MINUS} {wb / 1000:.3f} m "
                     f"{TIMES} yaw rate ÷ speed, signed by the turn: positive when the front pushes, negative when the "
                     "rear slides.")
    if read:
        scales = [s["yaw_scale"] for s in read]
        off = [100 * (x - 1) for x in scales]
        notes.append(f"The yaw gyro reads {_span([abs(x) for x in off], '.0f')} % "
                     f"{'low' if min(off) >= 0 else 'high' if max(off) <= 0 else 'off'} against the accelerometer in "
                     f"steady corners, so it is scaled by {_span(scales, '.3f')} first, as the tyre fit does.")
    g = a.get("gradient")
    if g:
        notes.append("Every car understeers a little more the harder it corners. This car's normal is "
                     f"{g['per_g']:.2f}° of steering per g (fitted on all its cornering; the Hockenheim reports used "
                     "1° per g). Each balance value is the steering beyond that normal amount at the same g.")
        notes.append("Entry is braking while turning, mid is turning off both pedals, exit is on the throttle while "
                     "turning, all above 0.5 g. Values are the median over the clean laps; quick is the quickest "
                     "tenth of passes. Within ±0.3° is normal, slight to 0.8°, clear to 1.5°, strong beyond. "
                     f"Differences under {g['spread']:.1f}° are within the usual lap-to-lap scatter.")
    notes.append("Driving, car and theoretical: in each section the fastest lap against the quickest pass is "
                 "driving, since the car has shown it can do better. The quickest pass against the theoretical lap "
                 f"with the car holding {a['held_share'] * 100:.0f} % of its peak grip is the car's share. The rest, "
                 "down to the theoretical lap at full grip, is the theoretical asking for more than any lap held.")
    if preset in PRESETS:
        notes.append(f"Bar changes are run through the steady-state vehicle model on the {PRESETS[preset][0]} "
                     "preset. Its bar rates are estimates and it assumes the middle settings: enter the car's real "
                     "bars in the vehicle model to check a change.")
    notes.append("Read from the data alone: treat each change as something to try and check on the next run.")
    ratio_conf = steering.get("confidence") if steering else geometry["steering_ratio_confidence"]
    return {
        "steering_ratio": {"value": round(sum(ratios) / len(ratios), 1) if ratios else geometry["steering_ratio"],
                           "range": [min(ratios), max(ratios)] if ratios else None,
                           "source": steering["source"] if steering else geometry["steering_ratio_source"],
                           "confidence": ratio_conf, "reads": CONFIDENCE.get(ratio_conf, ratio_conf)},
        "wheelbase_mm": {"value": wb, "source": geometry["wheelbase_source"],
                         "confidence": geometry["wheelbase_confidence"],
                         "reads": CONFIDENCE.get(geometry["wheelbase_confidence"], geometry["wheelbase_confidence"])},
        "yaw_scale": [min(s["yaw_scale"] for s in read), max(s["yaw_scale"] for s in read)] if read else None,
        "notes": notes,
    }


def report(a: dict, geometry: dict, sessions: list[dict], preset: str | None) -> dict:
    """The car balance and setup direction section, advice first."""
    adv = advise(a, bar_model(preset))
    focus = a.get("focus")
    return {
        "reference": {**a["reference"], "lap_time": lap_time(a["reference"]["time"])},
        "laps": a["laps"],
        "headline": adv["headline"],
        "recommendations": adv["recommendations"],
        "notes": adv["notes"],
        "car_limits": car_limits(a),
        "focus": {**{k: v for k, v in focus.items() if k != "held_grip"}, "explain": focus_text(a)} if focus else None,
        "balance": balance_section(a),
        "checks": adv["checks"],
        "method": method(a, geometry, sessions, preset),
        "sessions": sessions,
    }
