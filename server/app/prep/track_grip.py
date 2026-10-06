"""The prep report's track grip: how the track's grip started and evolved at each past event at the venue with the
car (GET /track-grip, analysis/track_grip.py), and what to expect from it this weekend.

Each past event's numbers are against its own first session: one event's levels can't be set against another's
(another line, setup and tyres), but how far the track came in, and when, can. With one past event that is said, and
every number carries its own 90 % range; with more, the guidance is their middle with the range they spanned.
"""
from __future__ import annotations

import logging
import statistics

from sqlalchemy.orm import Session

from app.prep.plan import ANY, PastEvent, Plan
from app.routers import track_grip as track_grip_router

log = logging.getLogger(__name__)

STATE_C = 3.0  # a first session's tyres this much cooler (TPMS, °C) than later is worth saying
STATE_BAR = 0.03  # logged hot pressures this far from what the temperature alone gives: the cold ones changed
ATM_BAR = 1.013


def _r(v: float | None, nd: int = 1) -> float | None:
    return None if v is None else round(float(v), nd)


def _num(x: float) -> str:
    x = abs(x)
    return f"{x:.0f}" if x >= 2 else f"{x:.1f}"


def _signed(x: float) -> str:
    return ("+" if x > 0 else "\u2212" if x < 0 else "") + _num(x)


def _signed_bar(x: float) -> str:
    return ("+" if x > 0 else "\u2212" if x < 0 else "") + f"{abs(x):.2f} bar"


def _pm(pm: float | None) -> str:
    return f" ± {_num(pm)} %" if pm else ""


def _year(pe: PastEvent) -> str:
    return pe.info.start[:4] if pe.info.start else "undated"


def gather(db: Session, p: Plan, progress) -> list[dict]:
    """Each past event's track grip (worked out there and then when not kept; the event's report is done by now)."""
    out = []
    for pe in p.past:
        progress(f"Track grip of {pe.info.event.name} ({_year(pe)})")
        try:
            ans = track_grip_router.event_track_grip(db, pe.id, None if p.car == ANY else p.car)
        except Exception as e:  # one event's track grip failing leaves the rest of the report standing
            log.exception("Track grip of event %s failed", pe.id)
            db.rollback()
            ans = {"status": "empty", "reason": f"It couldn't be worked out: {e}", "result": None}
        out.append(event_summary(pe.id, pe.info.event.name, _year(pe), ans))
    return out


def event_summary(event_id: int, name: str, year: str, ans: dict) -> dict:
    """One past event cut down to what the guidance needs: where the grip started against its best, by qualifying,
    the races, when most of it came, overnight, and the tyres' state in the first session against later."""
    out = {"id": event_id, "name": name, "year": year, "available": False, "note": None}
    res = ans.get("result") or {}
    if ans.get("status") != "ready" or not res.get("available"):
        out["note"] = ans.get("reason") or next(iter(res.get("notes") or []), None) or \
            "Its laps couldn't be compared at the grip limit."
        return out
    rows = res["sessions"]
    base = next(r for r in rows if r["base"])
    dry = [r for r in rows if r["pm"] is not None and not r["wet"]]
    after = [r for r in dry if r["start"] and base["start"] and r["start"] > base["start"]]
    practice = [r for r in after if r["kind"] != "race"]
    quali = [r for r in after if r["kind"] == "qualifying"]
    races = [r for r in dry if r["kind"] == "race"]
    peak = max(practice, key=lambda r: r["track"]) if practice else None
    q = quali[-1] if quali else (base if base["kind"] == "qualifying" else None)

    def point(r: dict | None, against: dict | None = None) -> dict | None:
        if r is None:
            return None
        if against is None or against is base:
            return {"session": r["name"], "pct": r["track"], "pm": r["pm"]}
        return {"session": r["name"], "pct": _r(r["track"] - against["track"]),
                "pm": _r((r["pm"] ** 2 + against["pm"] ** 2) ** 0.5) if r["pm"] and against["pm"] else None}

    headline = res.get("headline") or {}
    out.update({
        "available": True, "base": base["name"], "base_kind": base["kind"], "base_wet": base["wet"],
        "sessions": [{"name": r["name"], "kind": r["kind"], "start": r["start"], "track": r["track"], "pm": r["pm"],
                      "range": r["range"], "wet": r["wet"], "ambient_c": r["ambient_c"], "track_c": r["track_c"]}
                     for r in rows],
        "peak": point(peak) if peak is not None and peak["track"] > 0 else None,
        "quali": point(q) if q is not None and q is not base else None,
        "races_vs_quali": [point(r, q) for r in races] if q is not None else [],
        "by_lap": headline.get("by_lap") if headline.get("sure") and (headline.get("change_pct") or 0) > 0 else None,
        "wet": [r["name"] for r in rows if r["wet"]],
        "tyre_model": bool((res.get("tyre_model") or {}).get("used")),
        "first_tyres": _first_tyres(base, practice),
        "read": res.get("read") or [],
    })
    return out


def _first_tyres(base: dict, later: list[dict]) -> dict | None:
    """The first session's tyre state against the later sessions' middle, per axle: TPMS °C (axle_c) and hot bar
    (axle_bar), and what the temperature alone does to the hot pressure at the same cold pressure (axle_gas_bar:
    the gas law, absolute pressure in proportion to absolute temperature)."""
    if not later:
        return None
    out = {}
    for axle in ("front", "rear"):
        mid = {}
        for k in ("c", "bar"):
            mine = (base.get("state") or {}).get(f"{axle}_{k}")
            rest = [r["state"][f"{axle}_{k}"] for r in later if (r.get("state") or {}).get(f"{axle}_{k}") is not None]
            if mine is not None and rest:
                mid[k] = statistics.median(rest)
                out[f"{axle}_{k}"] = _r(mine - mid[k], 3 if k == "bar" else 1)
        if "c" in mid and "bar" in mid:
            out[f"{axle}_gas_bar"] = _r((mid["bar"] + ATM_BAR) * out[f"{axle}_c"] / (mid["c"] + 273.15), 3)
    return out or None


def _spread(vals: list[float]) -> str:
    lo, hi = min(vals), max(vals)
    return f"{_signed(lo)} to {_signed(hi)} %" if hi - lo >= 0.5 else f"{_signed(lo)} %"


def summarise(events: list[dict]) -> dict | None:
    """The guidance for the weekend from the past events' track grip (oldest first), with how sure each part is."""
    if not events:
        return None
    ok = [e for e in events if e["available"]]
    notes = [f"{e['name']} ({e['year']}): its track grip is left out: {e['note']}" for e in events if e["note"]]
    if not ok:
        return {"events": events, "guidance": [], "sureness": None, "notes": notes}
    one = len(ok) == 1
    where = f"{ok[0]['name']} {ok[0]['year']}" if one else f"{len(ok)} past events"
    guidance = []

    starts = [e for e in ok if e["peak"] and e["base_kind"] != "qualifying" and not e["base_wet"]]
    if starts:
        vals = [e["peak"]["pct"] for e in starts]
        if one:
            e = starts[0]
            guidance.append(f"Expect the first runs about {_num(vals[0])} %{_pm(e['peak']['pm'])} down on grip: at "
                            f"{where} {e['base']} was that far below the best the track got to "
                            f"({e['peak']['session']}).")
        else:
            guidance.append(f"Expect the first runs about {_num(statistics.median(vals))} % down on grip: the first "
                            f"session was {_spread([-v for v in vals])} against the best the track got to, over "
                            f"{len(vals)} events.")
    else:
        first_q = [f"{e['name']} {e['year']}" for e in ok if e["base_kind"] == "qualifying"]
        if first_q:
            guidance.append(f"Qualifying is the first session logged at {', '.join(first_q)}: how far the track comes "
                            "in before it can't be told from these logs.")
    laps = [e["by_lap"] for e in ok if e["by_lap"]]
    if laps:
        n = statistics.median(laps)
        guidance.append(f"Most of it comes in the car's first {n:.0f} laps of the weekend" +
                        (f" ({min(laps)}-{max(laps)} over {len(laps)} events)" if len(laps) > 1 else "") +
                        ": don't read the first run's balance or lap time as the car's; judge changes against the "
                        "track's evolution, not the first session.")
    quali = [e for e in ok if e["quali"]]
    if quali:
        vals = [e["quali"]["pct"] for e in quali]
        if len(vals) == 1:
            e = quali[0]
            guidance.append(f"By qualifying the track was {_signed(vals[0])} %{_pm(e['quali']['pm'])} on "
                            f"{e['base']} at {e['name']} {e['year']}.")
        else:
            guidance.append(f"By qualifying the track was {_spread(vals)} on the first session over {len(vals)} "
                            "events.")
    races = [x["pct"] for e in ok for x in e["races_vs_quali"] if x and x["pct"] is not None]
    if races:
        guidance.append(f"The races ran {_spread(races)} against qualifying: fuel, worn tyres and traffic more than "
                        "the track, but expect the grip in the race that much below qualifying's.")
    tyres = [(e, e["first_tyres"]) for e in starts if e["first_tyres"]]
    if tyres:
        guidance.append(_tyre_guidance(tyres))
    wet = [f"{', '.join(e['wet'])} ({e['year']})" for e in ok if e["wet"]]
    if wet:
        guidance.append(f"The wiper was on in {'; '.join(wet)}: those sessions are read as wet and left out of the "
                        "numbers above.")
    if one:
        sureness = (f"From one past event only ({where}): each number is good to about the ± shown (90 % range), "
                    "but one weekend is a first guess, not a pattern.")
    else:
        sureness = (f"From {len(ok)} past events: each number is their middle, with the range they spanned; the "
                    "weekends' own ranges are about ± " +
                    _num(statistics.median([s["pm"] for e in ok for s in e["sessions"] if s["pm"]] or [0])) + " %.")
    if not any(e["tyre_model"] for e in ok):
        sureness += " The tyre model couldn't tell the tyres' share there, so the levels are the grip as measured."
    return {"events": events, "guidance": guidance, "sureness": sureness, "notes": notes}


def _tyre_guidance(tyres: list[tuple[dict, dict]]) -> str:
    """How the first runs' tyres differed (cooler, lower hot pressures) and what to do about it."""
    def mid(key: str) -> float | None:
        vals = [t[key] for _, t in tyres if t.get(key) is not None]
        return statistics.median(vals) if vals else None

    parts, changed, cooler = [], [], False
    for axle in ("front", "rear"):
        c, bar, gas = mid(f"{axle}_c"), mid(f"{axle}_bar"), mid(f"{axle}_gas_bar")
        if c is None or abs(c) < STATE_C:
            continue
        cooler |= c < 0
        text = f"the {axle}s ran {_num(c)} °C {'cooler' if c < 0 else 'hotter'}"
        if gas is not None and abs(gas) >= 0.01:
            text += f" (about {abs(gas):.2f} bar {'lower' if gas < 0 else 'higher'} hot at the same cold pressures)"
        parts.append(text)
        if bar is not None and gas is not None and abs(bar - gas) >= STATE_BAR:
            changed.append(f"{axle}s {_signed_bar(bar)} where the temperature alone gives {_signed_bar(gas)}")
    where = ", ".join(f"{e['base']} {e['year']}" for e, _ in tyres)
    if not parts:
        return (f"The tyres' TPMS temperatures in the first session ({where}) were within {STATE_C:.0f} °C of the "
                "later sessions': expect the hot pressures where the rubbered-in track puts them.")
    text = f"Against the later sessions, in the first ({where}) {' and '.join(parts)}."
    if changed:
        text += (f" The logged hot pressures ({'; '.join(changed)}) say the cold pressures were set differently "
                 "then.")
    if cooler:
        text += (" A green track works the tyres less: give the first run a lap more to come in, and set the cold "
                 "pressures for the rubbered-in track rather than chasing the first run's hot pressures.")
    return text
