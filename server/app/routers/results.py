"""Official series results (GT4 European Series first): loading them, and what they say about our events.

GET /results/status says what is loaded and whether a sync is running; POST /results/sync loads seasons (or one
round) in the background. GET /results/events/{id} is an event's official sessions with our car's result in each
(position, class position, gaps, best lap against the fastest and the class best, where our logged best would have
placed); the event is matched to a round by circuit and year and our car by its number, which is found from our
logged best laps until it is set by hand (PUT /results/events/{id}/link). POST /results/events/{id}/fetch is the
"Get results" button. GET /results/runs/{session_id} is the same for one of our sessions. GET /results/history is
the prep report's view: past years at a circuit, strong and weak circuits, makes compared.
GET /results/events/{id}/prediction is the event's Prediction tab and, once the round has results, Predicted vs actual.
"""
from __future__ import annotations

import logging
import re
from datetime import date, timedelta

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.orm import Session, selectinload

from app import models, plans
from app.db import get_db
from app.results import models as rm
from app.results import finishes, predict, run_names, summary, sync
from app.results.venues import venue_key

log = logging.getLogger(__name__)
router = APIRouter(prefix="/results")


class SyncIn(BaseModel):
    series: str = sync.DEFAULT_SERIES
    years: list[int] | None = None
    round_id: str | None = Field(default=None, max_length=40)
    force: bool = False


class LinkIn(BaseModel):
    series: str | None = None  # the event's own series when not sent
    year: int | None = None
    round_id: str | None = Field(default=None, max_length=40)
    car_number: str | None = Field(default=None, max_length=8)


def _series(series: str) -> str:
    if series not in sync.ADAPTERS:
        raise HTTPException(404, f"No results source for {series}")
    return series


@router.get("/status")
def status(db: Session = Depends(get_db)):
    rows = db.execute(select(rm.ResultRound.series, rm.ResultRound.year, func.count(rm.ResultSession.id))
                      .join(rm.ResultSession, isouter=True).group_by(rm.ResultRound.series, rm.ResultRound.year)
                      ).all()
    return {"sync": sync.state.as_dict(), "sources": [{"series": k, "name": a.NAME} for k, a in sync.ADAPTERS.items()],
            "loaded": [{"series": s, "year": y, "sessions": n} for s, y, n in sorted(rows)]}


@router.post("/sync", status_code=202)
def start_sync(body: SyncIn):
    started = sync.start(_series(body.series), body.years, body.round_id, body.force)
    return {"started": started, "sync": sync.state.as_dict()}


@router.get("/rounds")
def rounds(year: int | None = None, series: str = sync.DEFAULT_SERIES, db: Session = Depends(get_db)):
    q = (select(rm.ResultRound).where(rm.ResultRound.series == _series(series))
         .options(selectinload(rm.ResultRound.sessions)).order_by(rm.ResultRound.year, rm.ResultRound.order))
    if year is not None:
        q = q.where(rm.ResultRound.year == year)
    return [{"year": r.year, "round": r.order, "round_id": r.round_id, "name": r.name, "venue": r.venue,
             "sessions": [summary.session_dict(s) for s in r.sessions]} for r in db.scalars(q).all()]


@router.get("/sessions/{result_session_id}")
def result_session(result_session_id: int, db: Session = Depends(get_db)):
    s = db.get(rm.ResultSession, result_session_id)
    if s is None:
        raise HTTPException(404, "Official session not found")
    return {**summary.session_dict(s, rows=True), "round": s.round.name, "year": s.round.year,
            "brands": summary.brand_table(s)}


# --- our events --------------------------------------------------------------------------------------------------

def _event_facts(db: Session, ev: models.Event) -> dict:
    """The event's circuit, year and our sessions with their logged best laps."""
    from app.routers import events  # its folder view has the event's dates and each session's best lap

    sessions = events._sessions(db, ev.id)
    rows = [events.session_row(s) for s in sessions]
    folder = events._folder(ev, sessions, events._dates_row(db, ev.id), rows)
    start = folder["start"]
    track = folder["track"]
    if not track:  # a planned event (a season's round, before any log): the venue it was planned at
        plan = plans.plan_of(db, ev.id)
        track = plan.venue if plan is not None and plan.venue else None
    year = int(start[:4]) if start else (ev.date.year if ev.date else None)
    if year is None:
        first, _ = plans.event_days(db, ev)
        year = first.year if first else None
    return {"venue": venue_key(track), "track": track, "year": year, "rows": rows, "start": start,
            "end": folder["end"]}


def _target(db: Session, ev: models.Event, facts: dict, link: rm.EventResultLink | None) -> tuple:
    """(series, year, the round's id or None, our car number or None) the event's results come from: set by hand,
    else the season round it is (the series' own round), else its series, circuit and year."""
    if link is not None and link.by_hand:
        # the app sets only the car number by hand: the series is the event's own (an older link may hold the
        # default series), and a round set by hand counts only in that series
        series = sync.series_of_event(db, ev.id)
        return series, link.year or facts["year"], link.round_id if link.series == series else None, link.car_number
    found = sync.season_round_of_event(db, ev.id)
    if found is not None:
        season, rnd = found
        if not facts["venue"] and rnd.venue:  # the round's own venue when the event has none yet
            facts["venue"], facts["track"] = venue_key(rnd.venue), facts["track"] or rnd.venue
        return season.series, season.year, rnd.round_id, season.car_number
    series = sync.series_of_event(db, ev.id)
    return series, facts["year"], None, _season_number(db, series, facts["year"])


def _season_number(db: Session, series: str, year: int | None) -> str | None:
    """Our car number in one of our seasons of this series and year: a test day there is with that car."""
    from app import seasons

    if year is None:
        return None
    s = db.scalars(select(seasons.Season).where(seasons.Season.series == series, seasons.Season.year == year,
                                                seasons.Season.car_number.is_not(None))).first()
    return s.car_number.strip().lstrip("#") if s is not None and s.car_number else None


def _same_weekend(rnd: rm.ResultRound, start: str | None, end: str | None) -> bool:
    """Whether the round ran on the event's days (a day either side): a test at the circuit months before the
    series came there is not that round. True when either side has no dates."""
    days = {s.starts_at[:10] for s in rnd.sessions if s.starts_at and len(s.starts_at) >= 10}
    if not start or not days:
        return True
    try:
        lo = date.fromisoformat(start[:10]) - timedelta(days=1)
        hi = date.fromisoformat((end or start)[:10]) + timedelta(days=1)
        return any(lo <= date.fromisoformat(d) <= hi for d in days)
    except ValueError:
        return True


def _round(db: Session, series: str, year: int | None, venue: str | None, round_id: str | None = None,
           start: str | None = None, end: str | None = None) -> rm.ResultRound | None:
    """The round set by id, else the one at the event's circuit that year and on the event's days."""
    if year is None or (venue is None and round_id is None):
        return None
    q = (select(rm.ResultRound).where(rm.ResultRound.series == series, rm.ResultRound.year == year)
         .options(selectinload(rm.ResultRound.sessions).selectinload(rm.ResultSession.rows)))
    if round_id:
        return db.scalars(q.where(rm.ResultRound.round_id == round_id)).first()
    return next((r for r in db.scalars(q.where(rm.ResultRound.venue == venue)).all()
                 if _same_weekend(r, start, end)), None)


def _link(db: Session, event_id: int) -> rm.EventResultLink | None:
    return db.scalar(select(rm.EventResultLink).where(rm.EventResultLink.event_id == event_id))


def event_overview(db: Session, ev: models.Event) -> dict:
    facts = _event_facts(db, ev)
    link = _link(db, ev.id)
    series, year, round_id, season_number = _target(db, ev, facts, link)
    rnd = _round(db, series, year, facts["venue"], round_id, facts["start"], facts["end"])
    out: dict = {"event_id": ev.id, "series": series, "year": year, "venue": facts["venue"], "track": facts["track"],
                 "round": None, "car_number": None, "car_number_from": None, "sessions": [],
                 "sync": sync.state.as_dict()}
    if link is not None and link.by_hand and link.car_number:  # known before any round is loaded
        out["car_number"], out["car_number_from"] = link.car_number, "set"
    elif season_number:
        out["car_number"], out["car_number_from"] = season_number, "the season"
    if rnd is None:
        seen = db.scalar(select(rm.EventRound).where(rm.EventRound.event_id == ev.id))
        if seen is not None:  # matched to no round any more
            db.delete(seen)
            db.commit()
        out["note"] = ("No official results for this circuit on the event's days yet" if year and facts["venue"]
                       else "This event has no circuit or date to match official results to")
        return out
    out["round"] = {"year": rnd.year, "round": rnd.order, "round_id": rnd.round_id, "name": rnd.name,
                    "fetched_at": rnd.fetched_at.isoformat() if rnd.fetched_at else None}
    bests = [r["best_lap_s"] for r in facts["rows"] if r["best_lap_s"]]
    number = link.car_number if link and link.car_number and (link.by_hand or link.series == series) else None
    if number:
        out["car_number_from"] = "set" if link.by_hand else "logged laps"
    elif season_number:
        number, out["car_number_from"] = season_number, "the season"
    else:
        number, matches = summary.infer_car(rnd, bests)
        if matches < summary.MIN_MATCHES:  # one match can be another car on a busy day
            number = None
        out["car_number_from"] = f"logged laps ({matches} matching)" if number else None
    out["car_number"] = number
    if link is None:
        db.add(rm.EventResultLink(event_id=ev.id, series=series, year=rnd.year, round_id=rnd.round_id,
                                  car_number=number))
    elif not link.by_hand:
        link.series, link.year, link.round_id, link.car_number = series, rnd.year, rnd.round_id, number
    elif link.series != series:  # a car number set by hand on an event first matched to another series
        link.series, link.year, link.round_id = series, rnd.year, rnd.round_id
    seen = db.scalar(select(rm.EventRound).where(rm.EventRound.event_id == ev.id))
    if seen is None:
        seen = rm.EventRound(event_id=ev.id)
        db.add(seen)
    seen.series, seen.year, seen.round_id, seen.car_number = series, rnd.year, rnd.round_id, number
    db.commit()
    try:  # our runs named after the official session each ran in (FP1 stint 2, Q1, R1 stint 1)
        out["run_names"] = run_names.name_runs(db, ev.id, rnd, number)
        facts = _event_facts(db, ev)
    except Exception:
        db.rollback()
        log.exception("naming the runs of event %s failed", ev.id)
    matched: dict[int, list[dict]] = {}
    for r in facts["rows"]:
        s = summary.match_session(rnd, number, [r["name"], r["log_session"]], r["kind"], r["best_lap_s"])
        if s is not None:
            matched.setdefault(s.id, []).append(r)
    for s in sorted(rnd.sessions, key=lambda x: (x.starts_at or "", x.code)):
        ours = matched.get(s.id, [])
        logged = min((r["best_lap_s"] for r in ours if r["best_lap_s"]), default=None)
        out["sessions"].append({**summary.car_summary(s, summary.find_car(s, number), logged),
                                "our_sessions": [{"id": r["id"], "name": r["name"]} for r in ours],
                                "brands": summary.brand_table(s)[:8]})
    return out


def _event(db: Session, event_id: int) -> models.Event:
    ev = db.get(models.Event, event_id)
    if ev is None:
        raise HTTPException(404, "Event not found")
    return ev


@router.get("/events/{event_id}")
def event_results(event_id: int, db: Session = Depends(get_db)):
    return event_overview(db, _event(db, event_id))


@router.get("/events/{event_id}/prediction")
def event_prediction(event_id: int, db: Session = Depends(get_db)):
    """The event's Prediction and, once its round has official qualifying or race results, Predicted vs actual.

    The prediction reads only rounds before this one (the same no-lookahead rule as the backtest), so a finished
    event is compared with what the model would have said beforehand. Before any result is in, our best logged lap
    of the event (practice, a test) is blended in, as in the prep report."""
    from app.prep.official import backtest_verdict, prediction_line  # the prep report's wording and trust line

    ev = _event(db, event_id)
    overview = event_overview(db, ev)  # the round, the circuit and our car number, as the Results section has them
    series, year, venue = overview["series"], overview["year"], overview["venue"]
    number = overview["car_number"]
    out: dict = {"event_id": ev.id, "series": series, "series_name": getattr(sync.ADAPTERS.get(series), "NAME", series),
                 "year": year, "venue": venue, "track": overview["track"], "round": overview["round"],
                 "car_number": number, "car_number_from": overview["car_number_from"], "team": None, "driver": None,
                 "finished": False, "prediction": None, "line": None, "trust": None, "comparison": None, "note": None}
    if year is None or venue is None:
        out["note"] = "This event has no circuit or date yet, so there is nothing to predict."
        return out
    if number is None:
        out["note"] = ("Which car is ours? Set our car number in the Results section of the event (or on its "
                       "season) to see the prediction.")
        return out
    sessions = summary.model_sessions(db, series)
    if not sessions:
        out["note"] = "No official results loaded yet: the server is still reading them from the series' site."
        return out
    rid = (overview["round"] or {}).get("round_id")
    rnd = _round(db, series, year, venue, rid) if rid else None  # the round run on the event's days, if any
    if rnd is not None:
        venue = rnd.venue or venue
    order = rnd.order if rnd is not None else None
    team, _ = summary.team_of(summary._rounds(db, series), number, year)
    driver = summary.our_driver(db, series, number, year)  # earlier seasons: wherever our driver raced
    out["team"], out["driver"] = team, driver
    out["finished"] = order is not None and any(
        s["venue"] == venue and int(s["year"]) == year and s["order"] == order for s in sessions)
    bests = [] if out["finished"] else [r["best_lap_s"] for r in _event_facts(db, ev)["rows"] if r["best_lap_s"]]
    try:
        pred = predict.predict_round(sessions, venue, year, car_number=number, team=team, before_order=order,
                                     logged_best_s=min(bests) if bests else None, driver=driver)
        pred["line"] = out["line"] = prediction_line(pred)
        pred["logged_best"] = {"time_s": min(bests), "event": ev.name} if bests else None
        out["prediction"] = pred
        if out["finished"]:
            actual = predict.actual_round(sessions, venue, year, car_number=number, team=team, order=order,
                                          driver=driver)
            out["comparison"] = predict.compare(pred, actual)
        out["trust"] = backtest_verdict(db, sessions, number, team, driver)
    except Exception:  # what was worked out above still stands
        log.exception("prediction for event %s failed", ev.id)
        out["note"] = out["note"] or "The prediction could not be worked out from the results loaded."
    return out


class RunNameIn(BaseModel):
    code: str | None = Field(default=None, max_length=8)  # the official session (FP1, Q2, R1); None: none of them


@router.get("/events/{event_id}/run-names")
def event_run_names(event_id: int, db: Session = Depends(get_db)):
    """The event's runs named after the official session each ran in, and the questions about runs that don't sit
    clearly in one (each with the sessions to pick from)."""
    overview = event_overview(db, _event(db, event_id))
    return overview.get("run_names") or {"offset_h": 0, "named": [], "questions": [],
                                         "note": overview.get("note") or "No official timetable for this event"}


@router.get("/finishes")
def our_finishes(event_ids: str | None = None, db: Session = Depends(get_db)):
    """Our car's official race results (and, under "qualifying", its qualifying results) for every event linked to an
    official round, or only ``event_ids`` ("1,2,3"); events without official results are left out."""
    ids = None
    if event_ids:
        try:
            ids = [int(x) for x in event_ids.split(",") if x.strip()]
        except ValueError:
            raise HTTPException(422, "event_ids: numbers separated by commas") from None
    return finishes.finishes(db, ids)


@router.post("/run-names/{session_id}")
def answer_run_name(session_id: int, body: RunNameIn, db: Session = Depends(get_db)):
    """One tap on a question: the run ran in this official session (or in none); the event's runs are named again."""
    s = db.get(models.RunSession, session_id)
    if s is None:
        raise HTTPException(404, "Run not found")
    if body.code is not None and not re.fullmatch(r"(FP|PQ|Q|R|T)\d?", body.code):
        raise HTTPException(422, "Not an official session")
    run_names.answer(db, session_id, body.code)
    return event_run_names(s.event_id, db) if s.event_id is not None else {"named": [], "questions": []}


@router.post("/events/{event_id}/fetch", status_code=202)
def fetch_event(event_id: int, db: Session = Depends(get_db)):
    """The "Get results" button: read this event's round again from the series' site (its whole season when the
    round isn't known yet)."""
    ev = _event(db, event_id)
    facts = _event_facts(db, ev)
    link = _link(db, ev.id)
    series, year, round_id, _ = _target(db, ev, facts, link)
    if year is None:
        raise HTTPException(422, "This event has no date, so its season isn't known")
    rnd = _round(db, series, year, facts["venue"], round_id, facts["start"], facts["end"])
    started = sync.start(series, [year], rnd.round_id if rnd else None, force=rnd is not None)
    return {"started": started, "sync": sync.state.as_dict()}


@router.put("/events/{event_id}/link")
def set_link(event_id: int, body: LinkIn, db: Session = Depends(get_db)):
    """Set the round and our car number by hand; an empty body goes back to matching them automatically."""
    _event(db, event_id)
    link = _link(db, event_id)
    if body.year is None and body.round_id is None and not body.car_number:
        if link is not None:
            db.delete(link)
            db.commit()
        return event_overview(db, _event(db, event_id))
    series = _series(body.series) if body.series else sync.series_of_event(db, event_id)
    if link is None:
        link = rm.EventResultLink(event_id=event_id, series=series, year=body.year or 0)
        db.add(link)
    facts = _event_facts(db, _event(db, event_id))
    link.series = series
    link.year = body.year or facts["year"] or 0
    link.round_id = body.round_id or link.round_id
    link.car_number = (body.car_number or "").strip().lstrip("#") or None
    link.by_hand = 1
    db.commit()
    return event_overview(db, _event(db, event_id))


@router.get("/runs/{session_id}")
def run_results(session_id: int, db: Session = Depends(get_db)):
    """The official session one of our sessions was, with our result in it."""
    s = db.get(models.RunSession, session_id)
    if s is None:
        raise HTTPException(404, "Session not found")
    if s.event_id is None:
        return {"session_id": session_id, "official": None, "note": "This session isn't in an event"}
    overview = event_overview(db, _event(db, s.event_id))
    official = next((o for o in overview["sessions"] if any(x["id"] == session_id for x in o["our_sessions"])),
                    None)
    return {"session_id": session_id, "event_id": s.event_id, "round": overview["round"],
            "car_number": overview["car_number"], "car_number_from": overview["car_number_from"],
            "official": official, "note": overview.get("note")}


@router.get("/history")
def history(venue: str | None = None, car_number: str | None = None, year: int | None = None,
            team: str | None = None, series: str = sync.DEFAULT_SERIES, db: Session = Depends(get_db)):
    """Past official results for the prep report: by year at one circuit (venue: a circuit name or key such as
    "Zandvoort"), our strong and weak circuits over all years, and the makes compared in each session."""
    return summary.history(db, venue_key(venue) if venue else None, _series(series), car_number, year, team)


@router.get("/predict")
def prediction(venue: str, year: int, car_number: str | None = None, team: str | None = None,
               logged_best_s: float | None = None, series: str = sync.DEFAULT_SERIES, driver: str | None = None,
               db: Session = Depends(get_db)):
    """Qualifying times and places and race finishes predicted for a round (venue: a circuit name or key) from
    earlier official results only, with a likely range from how far recent predictions missed. "Us" is the car
    number (with its team), or a driver (a surname is enough) followed through every team and number."""
    sessions = summary.model_sessions(db, _series(series))
    if not sessions:
        raise HTTPException(409, "No official results loaded yet")
    driver = driver or summary.our_driver(db, series, car_number, year)  # numbers change between seasons
    return predict.predict_round(sessions, venue_key(venue), year, car_number=car_number, team=team,
                                 logged_best_s=logged_best_s, driver=driver)


@router.get("/backtest")
def backtest(car_number: str = "12", team: str | None = None, series: str = sync.DEFAULT_SERIES,
             driver: str | None = None, db: Session = Depends(get_db)):
    """Each round from the second season loaded (2023 at the earliest) predicted from what was known before it,
    against what happened and a naive guess."""
    sessions = summary.model_sessions(db, _series(series))
    if not sessions:
        raise HTTPException(409, "No official results loaded yet")
    if team is None and not driver:
        rounds = summary._rounds(db, series)
        team, year = summary.team_of(rounds, car_number, None)
        driver = summary.our_driver(db, series, car_number, year)  # our driver, followed through every number
    years = range(max(2023, sync.first_year(series) + 1), date.today().year + 1)
    return predict.backtest(sessions, car_number=car_number, team=team, driver=driver, years=years)


# --- seasons set up ahead: calendar and entry lists --------------------------------------------------------------

def _years(series: str) -> list[int]:
    """The years whose calendar can be read: from the first season results are kept for to next year."""
    return list(range(sync.first_year(series), date.today().year + 2))


@router.get("/series")
def series_list():
    """The series whose calendars, entry lists and results the app reads."""
    return [{"key": k, "name": a.NAME, "years": _years(k)} for k, a in sync.ADAPTERS.items()]


@router.post("/calendar/sync", status_code=202)
def calendar_sync(year: int, series: str = sync.DEFAULT_SERIES):
    """Read a season's calendar (dates of every round, including those still to come) and the entry lists
    published so far, in the background; follow it with GET /results/calendar or /results/status."""
    _series(series)
    started = sync.start_calendar(series, year)
    return {"started": started, "sync": sync.cal_state.as_dict()}


def _entry(e: rm.ResultEntry) -> dict:
    return {"car_number": e.car_number, "drivers": e.drivers, "team": e.team, "car_model": e.car_model,
            "brand": e.brand, "car_class": e.car_class}


@router.get("/calendar")
def season_calendar(year: int, series: str = sync.DEFAULT_SERIES, db: Session = Depends(get_db)):
    """A season's rounds with their first and last day; entries is the number of cars on the round's entry list
    (0 until the series publishes one)."""
    rows = db.scalars(select(rm.ResultCalendarRound).where(rm.ResultCalendarRound.series == _series(series),
                                                     rm.ResultCalendarRound.year == year)
                      .options(selectinload(rm.ResultCalendarRound.entries)).order_by(rm.ResultCalendarRound.order)).all()
    fetched = max((r.fetched_at for r in rows if r.fetched_at), default=None)
    status = ("syncing" if sync.cal_state.pending(sync.calendar_key(series, year)) else "loaded" if rows
              else "not loaded")
    return {"series": series, "year": year, "status": status, "sync": sync.cal_state.as_dict(),
            "fetched_at": fetched.isoformat() if fetched else None,
            "rounds": [{"round_id": r.round_id, "name": r.name, "venue": r.venue, "order": r.order,
                        "start": r.start.isoformat() if r.start else None,
                        "end": r.end.isoformat() if r.end else None, "entries": len(r.entries),
                        "entry_list_url": r.entry_list_url} for r in rows]}


@router.get("/entries")
def entries(year: int, round_id: str, series: str = sync.DEFAULT_SERIES, db: Session = Depends(get_db)):
    """The published entry list of one round (empty until the series publishes it)."""
    row = db.scalar(select(rm.ResultCalendarRound).where(rm.ResultCalendarRound.series == _series(series),
                                                   rm.ResultCalendarRound.year == year,
                                                   rm.ResultCalendarRound.round_id == round_id))
    return [_entry(e) for e in row.entries] if row else []
