"""The official results at the venue, for the prep report: where we finished there each year and in what weather,
whether it is a strong or a weak track for us, how the makes compared, and the prediction for the coming round with
how far such predictions missed before.

Read live from the official results tables (app/results/): a quick database read, so it is not kept with the report
and new results show as soon as they load. "Us" is a car number: set by hand for this event, else the garage's
number for the car, else set for the latest past event here or found from its logged laps when it was the official
meeting, else any event's number set by hand; with none, the screen asks for it.
"""
from __future__ import annotations

import logging
import threading
from collections import Counter
from datetime import date, timedelta

from sqlalchemy import func, select
from sqlalchemy.orm import Session, selectinload

from app import garage
from app.analysis.advice import lap_text
from app.prep.plan import PastEvent, Plan, lap_times
from app.results import models as rm
from app.results import predict, summary, sync
from app.results.venues import venue_key

log = logging.getLogger(__name__)
YEARS_SHOWN = 4  # past years at the venue in the table
MAKES_SHOWN = 5
MIN_MATCHES = 2  # sessions whose official best lap must match ours to name our car
FAR_PLACES = 3  # a quali position this far off on average is said plainly
_trust: dict[tuple, dict] = {}  # (car number, team, results loaded) -> the backtest's verdict: it predicts every round
_trust_lock = threading.Lock()


def _pct(v: float | None) -> str:
    return f"{v:.2f} %" if v is not None else ""


def car_number(db: Session, p: Plan, venue: str | None) -> tuple[str | None, str | None]:
    """Our car number for the official results and where it came from: set by hand for this event, else the garage's
    number for the car record the runs belong to, else set by hand for the latest past event here or found from its
    logged laps, else the last one set by hand on any event."""
    ids = [p.target.event.id] + [pe.id for pe in p.past]
    links = {link.event_id: link for link in db.scalars(select(rm.EventResultLink)
                                                        .where(rm.EventResultLink.event_id.in_(ids)))}
    mine = links.get(p.target.event.id)
    if mine is not None and mine.by_hand and mine.car_number:
        return mine.car_number, "set for this event"
    if p.car.startswith("car:"):  # the car record the runs belong to, with its number in the garage
        info = db.scalar(select(garage.CarInfo).where(garage.CarInfo.car_id == int(p.car.split(":", 1)[1])))
        if info is not None and info.number:
            return info.number.strip().lstrip("#"), "from the garage"
    for pe in reversed(p.past):
        link = links.get(pe.id)
        if link is not None and link.by_hand:
            if link.car_number:
                return link.car_number, f"set for {pe.info.event.name}"
            continue
        number = from_laps(db, pe, venue, sync.series_of_event(db, pe.id))
        if number:
            return number, f"found from the logged laps of {pe.info.event.name}"
    last = db.scalars(select(rm.EventResultLink).where(rm.EventResultLink.by_hand == 1,
                                                       rm.EventResultLink.car_number.is_not(None))
                      .order_by(rm.EventResultLink.updated_at.desc())).first()
    if last is not None:
        return last.car_number, "set on another event"
    return None, None


def from_laps(db: Session, pe: PastEvent, venue: str | None, series: str = sync.DEFAULT_SERIES) -> str | None:
    """Our car at a past event that was the official meeting here: the car whose official best laps match our
    logged best laps in at least two sessions (one match can be chance in a field of thirty). A test day here
    matches the year's round by track and year, but not by date."""
    if venue is None or not pe.info.start:
        return None
    rnd = db.scalars(select(rm.ResultRound)
                     .where(rm.ResultRound.series == series, rm.ResultRound.year == int(pe.info.start[:4]),
                            rm.ResultRound.venue == venue)
                     .options(selectinload(rm.ResultRound.sessions).selectinload(rm.ResultSession.rows))).first()
    if rnd is None or not _same_meeting([{"starts_at": s.starts_at} for s in rnd.sessions], pe.info.start,
                                        pe.info.end):
        return None
    bests = [times[0] for times in lap_times(pe.sessions).values() if times]
    if not bests:
        return None
    score: Counter[str] = Counter()  # official sessions in which a car's best lap is one of ours
    for sess in rnd.sessions:
        for r in sess.rows:
            if r.best_lap_s and min(abs(r.best_lap_s - b) for b in bests) <= summary.MATCH_S:
                score[r.car_number] += 1
    top = score.most_common(2)
    if not top or top[0][1] < MIN_MATCHES or (len(top) > 1 and top[1][1] == top[0][1]):
        return None  # too few matches, or another car matches as often: ask rather than guess
    return top[0][0]


def _same_meeting(sessions: list[dict], start: str | None, end: str | None) -> bool:
    """Whether the official sessions were held during the event (a day either side)."""
    if not start:
        return False
    lo = date.fromisoformat(start) - timedelta(days=1)
    hi = date.fromisoformat(end or start) + timedelta(days=1)
    return any((d := _day(s.get("starts_at"))) is not None and lo <= d <= hi for s in sessions)


def logged_best(p: Plan) -> tuple[float | None, str | None]:
    """Our best clean lap at the latest past event here with this car, for the prediction: (seconds, event)."""
    for pe in reversed(p.past):
        times = [t for v in lap_times(pe.sessions).values() for t in v]
        if times:
            return round(min(times), 3), pe.info.event.name
    return None, None


def _place(us: dict | None) -> str:
    if not us:
        return "not in the results"
    if us.get("position") is None:
        return (us.get("status") or "no result").upper()
    return f"P{us['position']}"


def before(h: dict, start: str | None, year: int) -> dict:
    """The history without the rounds held at or after the event's start (its own meeting among them): the prep
    report looks back."""
    def past(y: dict) -> bool:
        if not start:
            return y["year"] < year
        days = [d for s in y["sessions"] if (d := _day(s.get("starts_at"))) is not None]
        return min(days) < date.fromisoformat(start) if days else y["year"] < year

    years = [y for y in h.get("years", []) if past(y)]
    kept = {y["year"] for y in years}
    return {**h, "years": years, "brands": [b for b in h.get("brands", []) if b["year"] in kept]}


def years_table(h: dict) -> list[dict]:
    """Each past year at the venue, newest first: our place, class place and gap to the fastest in each session, and
    the session's official weather."""
    out = []
    for y in h.get("years", [])[:YEARS_SHOWN]:
        rows = []
        for s in y["sessions"]:
            us, w = s.get("us"), s.get("weather") or {}
            rows.append({
                "code": s["code"], "title": s["title"], "dry": s["dry"], "cars": s["cars"], "place": _place(us),
                "position": (us or {}).get("position"), "class_position": (us or {}).get("class_position"),
                "class_cars": (us or {}).get("class_cars"), "car_class": (us or {}).get("car_class"),
                "best_lap_s": (us or {}).get("best_lap_s"), "fastest_s": s.get("fastest_s"),
                "to_fastest_pct": (us or {}).get("to_fastest_pct"), "starts_at": s.get("starts_at"),
                "weather": {"air_c": w.get("air_c_start"), "track_c": w.get("track_c_start"),
                            "conditions": w.get("conditions_start"), "conditions_end": w.get("conditions_end")},
            })
        out.append({"year": y["year"], "name": y["name"], "round": y["round"], "sessions": rows})
    return out


def year_line(y: dict) -> str:
    """'2026: Q1 P6 (0.29 % off the fastest), Q2 P18 (wet), R1 P7, R2 P3.'"""
    parts = []
    for s in y["sessions"]:
        bits = []
        if not s["dry"]:
            bits.append("wet")
        elif s["code"].startswith("Q") and s["to_fastest_pct"] is not None:
            bits.append(f"{_pct(s['to_fastest_pct'])} off the fastest")
        parts.append(f"{s['code']} {s['place']}" + (f" ({', '.join(bits)})" if bits else ""))
    return f"{y['year']}: " + ", ".join(parts) + "."


def track_verdict(h: dict, venue: str | None) -> dict | None:
    """Whether this is a strong or a weak track for us over every year: our dry qualifying gap to the fastest here
    against our usual gap that season, and the strongest and weakest tracks for comparison."""
    circuits = h.get("circuits") or []
    here = next((c for c in circuits if c["venue"] == venue), None)
    judged = [c for c in circuits if c["verdict"]]
    strong = [c["name"] for c in judged if c["verdict"] == "strong"][:3]
    weak = [c["name"] for c in reversed(judged) if c["verdict"] == "weak"][:3]
    if here is None:
        return None
    text = None
    if here["verdict"] and here["quali_offset_pct"] is not None:
        off = here["quali_offset_pct"]
        word = {"strong": "a strong track for us", "weak": "a weak track for us",
                "average": "an average track for us"}[here["verdict"]]
        side = "closer to" if off < 0 else "further from"
        visits = f"{here['visits']} year{'s' if here['visits'] != 1 else ''}"
        text = (f"{here['name']} is {word}: in dry qualifying we were {abs(off):.2f} % {side} the fastest here than "
                f"our usual that season, over {visits}.")
    if here["avg_race_pos"] is not None:
        text = (text + " " if text else "") + f"Average race finish here: P{here['avg_race_pos']:.0f}."
    return {"verdict": here["verdict"], "offset_pct": here["quali_offset_pct"], "visits": here["visits"],
            "avg_quali_pos": here["avg_quali_pos"], "avg_race_pos": here["avg_race_pos"], "text": text,
            "strongest": strong, "weakest": weak}


def makes(h: dict, our_brand: str | None) -> dict | None:
    """How the makes compared in the latest dry qualifying here: each make's best lap, its gap to the fastest and its
    best place; ours always shown."""
    latest = next((b for b in h.get("brands", []) if b["dry"] and b["code"].startswith("Q")), None)
    if latest is None:
        return None
    rows = [{**b, "ours": bool(our_brand) and b["brand"] == our_brand} for b in latest["brands"]]
    shown = rows[:MAKES_SHOWN] + [r for r in rows[MAKES_SHOWN:] if r["ours"]]
    ours = next((r for r in rows if r["ours"]), None)
    text = None
    if ours is not None and ours["best_s"] is not None:
        rank = rows.index(ours) + 1
        when, best = f"In {latest['year']} {latest['code']}", f"{ours['best_car']} at {lap_text(ours['best_s'])}"
        if rank == 1:
            text = f"{when} {ours['brand']} was the quickest of {len(rows)} makes: {best}."
        else:
            text = (f"{when} the quickest {ours['brand']} was {best}, {_pct(ours['to_fastest_pct'] or 0)} off the "
                    f"fastest: make {rank} of {len(rows)}.")
            if rows[0]["best_s"] is not None:
                text += f" Quickest make: {rows[0]['brand']} ({lap_text(rows[0]['best_s'])})."
    return {"year": latest["year"], "code": latest["code"], "rows": shown, "makes": len(rows), "text": text}


def _day(starts_at: str | None) -> date | None:
    try:
        return date.fromisoformat((starts_at or "")[:10])
    except ValueError:
        return None


def weather_by_event(table: list[dict], past: list[dict]) -> dict[str, list[dict]]:
    """The official weather of the sessions held during each past event (by its dates, a day either side)."""
    out: dict[str, list[dict]] = {}
    for ev in past:
        if not ev.get("start"):
            continue
        lo = date.fromisoformat(ev["start"]) - timedelta(days=1)
        hi = date.fromisoformat(ev.get("end") or ev["start"]) + timedelta(days=1)
        rows = [{"code": s["code"], "dry": s["dry"], **s["weather"]} for y in table for s in y["sessions"]
                if (d := _day(s["starts_at"])) is not None and lo <= d <= hi]
        if rows:
            out[str(ev["id"])] = rows
    return out


def _range(r: list | None, fmt) -> str | None:
    return f"{fmt(r[0])}-{fmt(r[1])}" if r and r[0] is not None and r[1] is not None else None


def prediction_line(pred: dict) -> str | None:
    """'Q1 around P8 (likely P5-P12), Q2 around P9 (P6-P13); R1 about P7 (P4-P10), R2 about P6 (P3-P9), if dry and
    if we finish.'"""
    s = pred.get("sessions") or {}
    q = [f"{c} around P{s[c]['position']} (likely P{s[c]['position_range'][0]}-P{s[c]['position_range'][1]})"
         for c in ("Q1", "Q2") if (s.get(c) or {}).get("position") is not None]
    r = [f"{c} about P{s[c]['position']} (P{s[c]['position_range'][0]}-P{s[c]['position_range'][1]})"
         for c in ("R1", "R2") if (s.get(c) or {}).get("position") is not None]
    if not q and not r:
        return None
    lap = next((s[c] for c in ("Q1", "Q2") if (s.get(c) or {}).get("our_time_s")), None)
    t = f" with a {lap_text(lap['our_time_s'])}" if lap else ""
    return "; ".join(x for x in (", ".join(q) + t if q else "", ", ".join(r)) if x) + \
        ", in the dry" + (" and if we finish." if r else ".")


def _and(items: list[str]) -> str:
    return items[0] if len(items) == 1 else ", ".join(items[:-1]) + " and " + items[-1]


def trust_line(bt: dict) -> str | None:
    """How far the predictions missed when every past round was predicted from what was known before it, against a
    simple guess (the same session at the last visit; our average place so far)."""
    t = (bt.get("overall") or {}).get("all") or {}
    years = bt.get("years") or []
    q_pos = (t.get("q_pos") or {}).get("model_mae")
    far = q_pos is not None and q_pos >= FAR_PLACES  # said on its own: the honest caveat
    better, worse = [], []
    for key, what, unit, nd in (("pole_s", "pole", " s", 2), ("time_s", "our quali lap", " s", 2),
                                ("q_pos", "quali position", " places", 1), ("r_pos", "race finish", " places", 1)):
        m, b = (t.get(key) or {}).get("model_mae"), (t.get(key) or {}).get("baseline_mae")
        if m is None or b is None or (key == "q_pos" and far):
            continue
        sep = " s" if unit == " s" else ""
        (better if m < b else worse).append(f"{what} ({m:.{nd}f}{sep} against {b:.{nd}f}{unit})")
    if not better and not worse and not far:
        return None
    span = f"{years[0]}-{years[-1]}" if len(years) > 1 else (str(years[0]) if years else "past seasons")
    parts = []
    if better:
        parts.append("beat a simple guess on " + _and(better))
    if worse:
        parts.append("did no better than one on " + _and(worse))
    text = f"How far to trust it: predicting each round of {span} from what was known before it, the model " + \
        (" and ".join(parts) if parts else "was checked")
    if far:
        text += f", but our quali position was still about {q_pos:.0f} places off on average"
    return text + "."


def _loaded(db: Session) -> tuple:
    return tuple(db.execute(select(func.count(rm.ResultSession.id), func.max(rm.ResultSession.fetched_at))).one())


def backtest_verdict(db: Session, sessions: list[dict], number: str, team: str | None) -> dict | None:
    """The backtest's overall verdict, worked out once per car and set of loaded results (it predicts every round)."""
    key = (number, team, len(sessions), _loaded(db))
    with _trust_lock:
        if key in _trust:
            return _trust[key]
    years = sorted({int(s["year"]) for s in sessions})
    years = [y for y in years if y >= years[0] + 1][-4:] if years else []
    if not years:
        return None
    bt = predict.backtest(sessions, car_number=number, team=team, years=years)
    out = {"years": years, "overall": {"all": bt["overall"]["all"]}, "summary": bt["summary"]}
    out["text"] = trust_line({**out, "years": years})
    with _trust_lock:
        _trust.clear()  # one car at a time is plenty
        _trust[key] = out
    return out


def official(db: Session, p: Plan, today: date | None = None) -> dict:
    """Everything the official results say for the prep report (see the module's docstring)."""
    track = p.target.track or next((pe.info.track for pe in reversed(p.past) if pe.info.track), None)
    venue = venue_key(track.name) if track is not None else None
    year = int(p.target.start[:4]) if p.target.start else (today or date.today()).year
    series = sync.series_of_event(db, p.target.event.id)
    number, source = car_number(db, p, venue)
    best, best_from = logged_best(p)
    out: dict = {"series": series, "venue": venue, "track": track.name if track is not None else None, "year": year,
                 "car_number": number, "car_number_from": source, "team": None, "brand": None, "loaded": False,
                 "years": [], "lines": [], "track_verdict": None, "makes": None, "weather": {}, "prediction": None,
                 "trust": None, "note": None}
    if venue is None:
        out["note"] = "This event has no track yet, so there are no official results to look back on."
        return out
    h = summary.history(db, venue=venue, series=series, car_number=number, year=year)
    h = before(h, p.target.start, year)
    if h.get("note"):
        out["note"] = (f"{h['note']}: the server loads them from the series' site (the Results panel on an event "
                       "page fetches its round).")
        return out
    out["loaded"] = True
    out["team"] = h.get("team")
    table = years_table(h)
    out["years"] = table
    brand = next((s["us"]["brand"] for y in h.get("years", []) for s in y["sessions"] if s.get("us")), None)
    out["brand"] = brand
    out["track_verdict"] = track_verdict(h, venue)
    out["makes"] = makes(h, brand)
    out["weather"] = weather_by_event(table, [{"id": pe.id, "start": pe.info.start, "end": pe.info.end}
                                              for pe in p.past])
    if not table:
        out["note"] = f"No official results at {track.name} yet."
    if number is None:
        out["note"] = ((out["note"] + " ") if out["note"] else "") + \
            "Which car number is ours? Set it to see our places, the makes and the prediction."
        return out
    out["lines"] = [year_line(y) for y in table[:2]]
    if out["track_verdict"] and out["track_verdict"]["text"]:
        out["lines"].append(out["track_verdict"]["text"])
    sessions = summary.model_sessions(db, series)
    try:
        pred = predict.predict_round(sessions, venue, year, car_number=number, team=out["team"], logged_best_s=best)
        pred["logged_best"] = {"time_s": best, "event": best_from} if best else None
        pred["line"] = prediction_line(pred)
        if not out["brand"] and pred.get("brand"):  # no past result here to tell our make: the prediction's
            out["brand"] = pred["brand"]
            out["makes"] = makes(h, pred["brand"])
        out["prediction"] = pred
        out["trust"] = backtest_verdict(db, sessions, number, out["team"])
    except Exception:  # the results and places above still stand
        log.exception("prediction for %s %s failed", venue, year)
        out["note"] = "The prediction could not be worked out from the results loaded."
    return out
