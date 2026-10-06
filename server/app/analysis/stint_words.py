"""The stint in plain words: where the fade is, what the car does, and how the driver adapts.

What the car does (tyre fade with fuel burn taken out, grip per phase, balance shift) is kept apart from what the
driver does in response (brake points, trail braking, steering, throttle, traction control, shifting, lines). Only
changes clearer than the lap-to-lap scatter (outside the trend's 95 % band) and big enough to matter are said; the
driver is "you".
"""
from __future__ import annotations

from app.analysis.stint import BALANCE_PHASES, COMPONENTS, DRIVER, GRIP, MIN_FIT_LAPS

# smallest change over a stint worth saying, by measure (brake pressure and steering depend on the channel)
MIN_CHANGE = {"brake_point": 3.0, "trail_share": 5.0, "min_speed": 1.0, "apex_at": 5.0, "throttle_on": 3.0,
              "full_throttle": 5.0, "offset_in": 1.0, "tc_s": 0.5, "abs_s": 0.5, "coast_s": 0.3, "shift_rpm": 100.0}
MIN_BRAKE = {"bar": 2.0, "psi": 30.0, "kpa": 200.0}
MIN_STEER = {"wheel": 2.0, "road": 0.15}  # degrees of steering wheel, or of road wheel
MIN_GRIP_PCT = 1.0  # % of the phase's g
MIN_BALANCE = 0.15  # degrees of understeer angle
MIN_FADE = 0.005  # s a lap: a phase whose fade is below this holds up
PHASE_WORDS = {"braking": "braking", "trail": "trail braking", "mid": "mid-corner", "exit": "the exit",
               "power": "traction"}
BALANCE_WORDS = {"entry": "Entry", "mid": "Mid-corner", "exit": "Exit"}
GRIP_WHERE = {"braking": "in braking", "trail": "in trail braking", "mid": "mid-corner", "exit": "on the exit",
              "power": "in traction"}


def _join(items: list[str]) -> str:
    if len(items) <= 1:
        return "".join(items)
    return ", ".join(items[:-1]) + " and " + items[-1]


def _s(v: float) -> str:
    return f"{v:.2f} s"


def fade_ranking(fits: dict, sections: list[dict]) -> list[dict]:
    """The tyre fade split by phase, biggest loss first, with the corners where most of each is lost."""
    rows = []
    for key, _, label, grip in COMPONENTS:
        t = fits.get(f"fade_{key}")
        if t is None:
            continue
        where = sorted(((s["fade"][key], s["code"]) for s in sections
                        if s["fade"].get(key) is not None and s["fade"][key] > MIN_FADE / 2), reverse=True)
        g = fits.get(f"grip_{grip}")
        rows.append({"key": key, "label": label, "per_lap": t["per_lap"], "within": t["within"], "clear": t["clear"],
                     "corners": [{"code": c, "per_lap": round(v, 3)} for v, c in where[:3]],
                     "grip_change": g["change"] if g else None,
                     "grip_pct": round(100 * g["change"] / g["level"], 1) if g and g.get("level") else None})
    rows.sort(key=lambda r: -r["per_lap"])
    return rows


def _corner_list(rows: list[dict], n: int = 2) -> str:
    return _join([r["code"] for r in rows[:n]])


def _headline(fits: dict, fade: list[dict], scope: str) -> str:
    raw, cor = fits.get("time"), fits.get("corrected_time")
    t = cor or raw
    if t is None:
        return f"Too few flying laps for a trend in {scope} (it takes {MIN_FIT_LAPS})."
    taken = " once fuel burn is taken out" if cor else ""
    losing = [r for r in fade if r["clear"] and r["per_lap"] > MIN_FADE]
    holding = [r for r in fade if r["per_lap"] <= MIN_FADE or not r["clear"]]
    gaining = sorted((r for r in fade if r["clear"] and r["per_lap"] < -MIN_FADE), key=lambda r: r["per_lap"])
    hold = ""
    if holding and losing:
        hold = f"; {_join([r['label'].lower() for r in holding[:2]])} hold{'s' if len(holding[:2]) == 1 else ''} up"
    back = ""
    if gaining and losing:
        g = gaining[0]
        coming = ", as its grip comes in" if (g["grip_pct"] or 0) >= MIN_GRIP_PCT else ""
        back = f" {g['label']} gains {_s(-g['per_lap'])} a lap back{coming}."
    if t["clear"] and t["per_lap"] > 0:
        out = f"The tyres fade {_s(t['per_lap'])} a lap{taken}"
        if losing:
            top = losing[0]
            share = 100 * top["per_lap"] / t["per_lap"] if t["per_lap"] > 0 else 0
            where = f", mostly {_corner_list(top['corners'])}" if top["corners"] else ""
            most = "Most of it" if share >= 50 else "The biggest part"
            out += f". {most} is {top['label'].lower()}: {_s(top['per_lap'])} a lap{where}{hold}.{back}"
        elif fade and fade[0]["per_lap"] > MIN_FADE:
            top = fade[0]
            where = f", mostly {_corner_list(top['corners'])}" if top["corners"] else ""
            out += (f", spread over the lap: the biggest part is {top['label'].lower()} ({_s(top['per_lap'])} a lap"
                    f"{where}), but no one phase stands clear of the lap-to-lap scatter.")
        else:
            out += ", spread over the lap with no one phase standing out."
        return out
    if t["clear"]:
        return (f"The car gets quicker through {scope} even{taken}: {_s(-t['per_lap'])} a lap. The tyres are still "
                "coming in (or the track is), so there is no fade to manage yet.")
    out = (f"No clear tyre fade in {scope}{taken}: lap times hold within ±{_s(t['within'])} a lap over "
           f"{t['laps']} laps.")
    if losing:
        top = losing[0]
        where = f" ({_corner_list(top['corners'])})" if top["corners"] else ""
        one = "The one clear loss" if len(losing) == 1 else "The biggest clear loss"
        out += f" {one} is {top['label'].lower()}{where}: {_s(top['per_lap'])} a lap.{back}"
    return out


def _fuel(fits: dict, fuel: dict | None) -> str | None:
    if not fuel or fuel.get("kg_per_lap") is None:
        return None
    src = "from the log" if fuel["source"] == "log" else "estimated, no fuel channel"
    out = (f"Fuel: {fuel['kg_per_lap']:.2f} kg a lap ({src}). Each 10 kg costs {fuel['s_per_10kg']:.2f} s a lap here "
           f"(worked out from this lap's full-throttle running), so burning it off makes the car "
           f"{_s(-fuel['fuel_s_per_lap'])} a lap quicker.")
    raw, cor = fits.get("time"), fits.get("corrected_time")
    if raw and cor:
        out += (f" Raw lap times {raw['per_lap']:+.2f} s a lap = tyres {cor['per_lap']:+.2f} + fuel "
                f"{raw['per_lap'] - cor['per_lap']:+.2f}.")
    return out


def _pct(t: dict) -> float | None:
    return 100 * t["change"] / t["level"] if t.get("level") else None


def _car(fits: dict, sections: list[dict]) -> list[str]:
    out = []
    falls, rises, holds = [], [], []
    for key, label, _ in GRIP:
        t = fits.get(f"grip_{key}")
        if t is None:
            continue
        pct = _pct(t)
        if t["clear"] and pct is not None and abs(pct) >= MIN_GRIP_PCT:
            (falls if pct < 0 else rises).append((pct, key, t))
        else:
            holds.append(label.lower())
    falls.sort()
    if falls:
        pct, key, t = falls[0]
        s = (f"Grip falls most {GRIP_WHERE[key]}: {t['change']:+.2f} g ({pct:+.1f} %) from the first to the last lap"
             if key != "power" else
             f"Traction falls most: {t['change']:+.2f} g forward at full throttle ({pct:+.1f} %) over the stint")
        if len(falls) > 1:
            s += "; also " + _join([f"{GRIP_WHERE[k]} ({p:+.1f} %)" for p, k, _ in falls[1:]])
        out.append(s + ".")
    if rises:
        out.append("Grip rises " + _join([f"{GRIP_WHERE[k]} ({p:+.1f} %)" for p, k, _ in rises])
                   + ": tyres or brakes still coming in.")
    if holds and (falls or rises):
        out.append(f"{_join(holds).capitalize()} grip hold{'s' if len(holds) == 1 else ''}.")
    elif holds:
        out.append("Grip holds in every phase: no clear change in the g the car pulls.")
    moved, held = [], []
    for _, name in BALANCE_PHASES:
        t = fits.get(f"balance_{name}")
        if t is None:
            continue
        if t["clear"] and abs(t["change"]) >= MIN_BALANCE:
            way = "understeer" if t["change"] > 0 else "oversteer"
            where = sorted((s for s in sections if s.get(name) and s[name]["shift"] * t["change"] > 0
                            and abs(s[name]["shift"]) >= MIN_BALANCE), key=lambda s: -abs(s[name]["shift"]))
            at = (", most at " + _join([f"{s['code']} ({s[name]['shift']:+.1f}°)" for s in where[:2]])) if where else ""
            moved.append(f"{BALANCE_WORDS[name]} balance moves {abs(t['change']):.2f}° towards {way}{at}")
        else:
            held.append(BALANCE_WORDS[name].lower())
    if moved:
        s = "; ".join(moved)
        if held:
            s += f"; {_join(held)} hold{'s' if len(held) == 1 else ''}"
        out.append(s + ".")
    elif held:
        out.append("The balance holds through the stint in every phase.")
    p = fits.get("tyre_pressure")
    if p is not None and p["change"] > 0.1:
        out.append(f"The tyres were still coming in: average pressure rose {p['change']:.2f} bar over these laps, so "
                   "part of the change is warm-up, not wear.")
    return out


def _corners_for(sections: list[dict], key: str, sign: float, least: float) -> str:
    rows = sorted((s for s in sections if (d := s["driver"].get(key)) and d["clear"] and d["change"] * sign > 0
                   and abs(d["change"]) >= least), key=lambda s: -abs(s["driver"][key]["change"]))
    if not rows:
        return ""
    unit = DRIVER[key][1]
    unit = " m" if unit == "m" else " km/h" if unit == "km/h" else ""
    return ", most at " + _join([f"{s['code']} ({abs(s['driver'][key]['change']):.0f}{unit})" for s in rows[:2]])


def _driver(fits: dict, sections: list[dict], units: dict) -> list[str]:
    out = []

    def clear(key: str, least: float) -> dict | None:
        t = fits.get(key)
        return t if t is not None and t["clear"] and abs(t["change"]) >= least else None

    brake_unit = (units.get("brake") or "").lower()
    bp, pb = clear("brake_point", MIN_CHANGE["brake_point"]), clear("peak_brake", MIN_BRAKE.get(brake_unit, 0.0))
    if bp or pb:
        parts = []
        if bp:
            parts.append(f"brake {abs(bp['change']):.0f} m {'earlier' if bp['change'] < 0 else 'later'}")
        if pb:
            way = "softer" if pb["change"] < 0 else "harder"
            unit = units.get("brake") or ""
            parts.append(f"press {abs(pb['change']):.0f} {unit} {way}".replace("  ", " "))
        where = _corners_for(sections, "brake_point", bp["change"], 3) if bp else ""
        out.append("You " + " and ".join(parts) + f" by the end of the stint{where}.")
    ts = clear("trail_share", MIN_CHANGE["trail_share"])
    if ts:
        more = ts["change"] > 0
        why = ""
        if not more and (b := fits.get("balance_entry")) and b["clear"] and b["change"] > 0:
            why = ", as the front pushes more on entry"
        out.append(f"You carry {'more' if more else 'less'} brake into the corners: {abs(ts['change']):.0f} points "
                   f"{'more' if more else 'less'} of the braking is done while turning{why}.")
    wheel = units.get("steer_role") == "steer_wheel"
    st = clear("steer_mid", MIN_STEER["wheel" if wheel else "road"])
    if st:
        why = ""
        b = fits.get("balance_mid")
        if st["change"] > 0 and b and b["clear"] and b["change"] > 0:
            why = ", because the front pushes more"
        elif st["change"] < 0 and b and b["clear"] and b["change"] < 0:
            why = ", as the rear gets looser"
        deg = "° of steering wheel" if wheel else f" {units.get('steer') or '°'} of steering"
        out.append(f"You use {abs(st['change']):.1f}{deg} {'more' if st['change'] > 0 else 'less'} mid-corner{why}.")
    ms = clear("min_speed", MIN_CHANGE["min_speed"])
    ap = clear("apex_at", MIN_CHANGE["apex_at"])
    if ms or ap:
        parts = []
        if ms:
            parts.append(f"minimum speed {'rises' if ms['change'] > 0 else 'drops'} {abs(ms['change']):.1f} km/h"
                         f"{_corners_for(sections, 'min_speed', ms['change'], 1)}")
        if ap:
            later = ap["change"] > 0
            parts.append(f"the slowest point moves {abs(ap['change']):.0f} m {'later' if later else 'earlier'}"
                         f" ({'a later' if later else 'an earlier'} apex)")
        s = "; ".join(parts)
        out.append(s[0].upper() + s[1:] + ".")
    th, ft = clear("throttle_on", MIN_CHANGE["throttle_on"]), clear("full_throttle", MIN_CHANGE["full_throttle"])
    if th or ft:
        why = ""
        b, g, tc = fits.get("balance_exit"), fits.get("grip_exit"), fits.get("tc_s")
        later = (th or ft)["change"] > 0
        if later and ((b and b["clear"] and b["change"] < 0) or (g and g["clear"] and g["change"] < 0)
                      or (tc and tc["clear"] and tc["change"] > 0)):
            why = ", as the rear gives less traction"
        parts = []
        if th:
            parts.append(f"{'wait' if th['change'] > 0 else 'pick up the throttle'} {abs(th['change']):.0f} m "
                         f"{'longer for the throttle' if th['change'] > 0 else 'sooner'}")
        if ft:
            parts.append(f"reach full throttle {abs(ft['change']):.0f} m {'later' if ft['change'] > 0 else 'sooner'}")
        where = _corners_for(sections, "throttle_on", th["change"], 3) if th else ""
        out.append("You " + " and ".join(parts) + f" on the exits{why}{where}.")
    tc = clear("tc_s", MIN_CHANGE["tc_s"])
    if tc:
        g = fits.get("grip_exit") or fits.get("grip_power")
        why = " as the rear grip goes" if tc["change"] > 0 and g and g["clear"] and g["change"] < 0 else ""
        out.append(f"You lean on the traction control {'more' if tc['change'] > 0 else 'less'}: "
                   f"{tc['change']:+.1f} s a lap of TC by the end{why}.")
    ab = clear("abs_s", MIN_CHANGE["abs_s"])
    if ab:
        out.append(f"ABS works {abs(ab['change']):.1f} s a lap {'more' if ab['change'] > 0 else 'less'} by the end.")
    co = clear("coast_s", MIN_CHANGE["coast_s"])
    if co:
        out.append(f"You coast (off both pedals) {abs(co['change']):.1f} s a lap "
                   f"{'more' if co['change'] > 0 else 'less'}.")
    sh = clear("shift_rpm", MIN_CHANGE["shift_rpm"])
    if sh:
        out.append(f"You {'short-shift' if sh['change'] < 0 else 'shift later'}: upshifts come {abs(sh['change']):.0f} "
                   f"rpm {'lower' if sh['change'] < 0 else 'higher'} by the end.")
    li = clear("offset_in", MIN_CHANGE["offset_in"])
    if li:
        out.append(f"The line at the apex moves {abs(li['change']):.1f} m {'tighter' if li['change'] > 0 else 'wider'} "
                   f"(GPS){_corners_for(sections, 'offset_in', li['change'], 1)}.")
    if not out:
        out.append("Your driving holds steady: brake points, trail braking, steering, throttle pick-up and lines "
                   "don't change clearly through the stint.")
    return out


ADVICE = {
    "braking": "Where to look: braking{at}. The stopping power fades there; brake a touch earlier late in the stint "
               "rather than later and harder.",
    "trail": "Where to look: the turn-in{at}, where trail braking loses grip. Come off the brake a little earlier "
             "and turn in on a lighter brake as the fronts fade.",
    "mid": "Where to look: mid-corner{at}. Rather than adding steering as the front washes out, slow the entry a "
           "touch and let the car roll.",
    "exit": "Where to look: the exits{at}. The rears fade there first; a smoother, progressive throttle pick-up "
            "saves them and loses less than the wheelspin does.",
    "power": "Where to look: full-throttle acceleration{at}. Traction fades; short-shift or squeeze the throttle in "
             "the low gears to keep the rears from spinning.",
}


def _advice(fade: list[dict], fits: dict) -> str | None:
    t = fits.get("corrected_time") or fits.get("time")
    losing = [r for r in fade if r["clear"] and r["per_lap"] > MIN_FADE]
    if not losing:
        return None
    top = losing[0]
    at = f" into and through {_corner_list(top['corners'])}" if top["key"] in ("braking", "trail") and top[
        "corners"] else f" of {_corner_list(top['corners'])}" if top["corners"] else ""
    if top["key"] == "mid" and top["corners"]:
        at = f" in {_corner_list(top['corners'])}"
    if t is not None and not (t["clear"] and t["per_lap"] > 0):
        return ADVICE[top["key"]].format(at=at).replace("Where to look", "Worth a look")
    return ADVICE[top["key"]].format(at=at)


def _left_out(rows: list[dict]) -> str | None:
    left = []
    for r in rows:
        if r["in_fit"]:
            continue
        why = {"out": "out-lap", "in": "in-lap", "pit": "pit stop", "slow": "slow lap"}.get(r["kind"])
        if r.get("tag"):
            why = {"sc": "safety car", "fcy": "FCY", "traffic": "traffic"}[r["tag"]]
        elif r["outlier"]:
            why = f"{r['off_trend_s']:+.1f} s off the trend"
        left.append(f"lap {r['lap']} ({why})")
    return ("Left out of the trends: " + ", ".join(left) + ".") if left else None


def stint_words(st: dict, units: dict) -> dict:
    """One stint: headline, advice, fuel, the car, the driver, and the laps left out."""
    st["fade"] = fade_ranking(st["fits"], st["sections"])
    return {"headline": _headline(st["fits"], st["fade"], "this stint"), "advice": _advice(st["fade"], st["fits"]),
            "fuel": _fuel(st["fits"], st["fuel"]), "car": _car(st["fits"], st["sections"]),
            "driver": _driver(st["fits"], st["sections"], units), "left_out": _left_out(st["laps"])}


def overall_words(overall: dict, stints: list[dict], units: dict) -> dict:
    """Every stint in view together (each keeps its own level; the change per lap is shared)."""
    overall["fade"] = fade_ranking(overall["fits"], overall["sections"])
    n = overall["stints"]
    if n <= 1:
        one = next((s for s in stints if s["fitted_laps"] >= 2), None)
        scope = f"{one['run']} stint {one['number']}" if one else "these logs"
    else:
        scope = f"the {n} stints in view ({overall['fitted_laps']} flying laps)"
    sections = overall["sections"]
    return {"scope": scope, "headline": _headline(overall["fits"], overall["fade"], scope),
            "advice": _advice(overall["fade"], overall["fits"]), "fuel": _fuel(overall["fits"], overall["fuel"]),
            "car": _car(overall["fits"], sections), "driver": _driver(overall["fits"], sections, units)}
