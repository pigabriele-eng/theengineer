"""Official series results (GT4 European Series first): loading them, and what they say about our events.

GET /results/status says what is loaded and whether a sync is running; POST /results/sync loads seasons (or one
round) in the background. GET /results/events/{id} is an event's official sessions with our car's result in each
(position, class position, gaps, best lap against the fastest and the class best, where our logged best would have
placed); the event is matched to a round by circuit and year and our car by its number, which is found from our
logged best laps until it is set by hand (PUT /results/events/{id}/link). POST /results/events/{id}/fetch is the
"Get results" button. GET /results/runs/{session_id} is the same for one of our sessions. GET /results/history is
the prep report's view: past years at a circuit, strong and weak circuits, makes compared.
"""
from __future__ import annotations

from datetime import date

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.orm import Session, selectinload

from app import models
from app.db import get_db
from app.results import models as rm
from app.results import predict, summary, sync
from app.results.venues import venue_key

router = APIRouter(prefix="/results")


class SyncIn(BaseModel):
    series: str = sync.DEFAULT_SERIES
    years: list[int] | None = None
    round_id: str | None = Field(default=None, max_length=40)
    force: bool = False


class LinkIn(BaseModel):
    series: str = sync.DEFAULT_SERIES
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
    return {"venue": venue_key(folder["track"]), "track": folder["track"],
            "year": int(start[:4]) if start else (ev.date.year if ev.date else None), "rows": rows}


def _round(db: Session, series: str, year: int | None, venue: str | None,
           round_id: str | None = None) -> rm.ResultRound | None:
    if year is None or (venue is None and round_id is None):
        return None
    q = (select(rm.ResultRound).where(rm.ResultRound.series == series, rm.ResultRound.year == year)
         .options(selectinload(rm.ResultRound.sessions).selectinload(rm.ResultSession.rows)))
    q = q.where(rm.ResultRound.round_id == round_id) if round_id else q.where(rm.ResultRound.venue == venue)
    return db.scalars(q).first()


def _link(db: Session, event_id: int) -> rm.EventResultLink | None:
    return db.scalar(select(rm.EventResultLink).where(rm.EventResultLink.event_id == event_id))


def event_overview(db: Session, ev: models.Event) -> dict:
    facts = _event_facts(db, ev)
    link = _link(db, ev.id)
    series = link.series if link and link.by_hand else sync.series_of_event(db, ev.id)
    year = (link.year if link and link.by_hand else None) or facts["year"]
    rnd = _round(db, series, year, facts["venue"], link.round_id if link and link.by_hand else None)
    out: dict = {"event_id": ev.id, "series": series, "year": year, "venue": facts["venue"], "track": facts["track"],
                 "round": None, "car_number": None, "car_number_from": None, "sessions": [],
                 "sync": sync.state.as_dict()}
    if link is not None and link.by_hand and link.car_number:  # known before any round is loaded
        out["car_number"], out["car_number_from"] = link.car_number, "set"
    if rnd is None:
        out["note"] = ("No official results for this circuit and year yet" if year and facts["venue"]
                       else "This event has no circuit or date to match official results to")
        return out
    out["round"] = {"year": rnd.year, "round": rnd.order, "round_id": rnd.round_id, "name": rnd.name,
                    "fetched_at": rnd.fetched_at.isoformat() if rnd.fetched_at else None}
    bests = [r["best_lap_s"] for r in facts["rows"] if r["best_lap_s"]]
    number = link.car_number if link and link.car_number and link.series == series else None
    if number:
        out["car_number_from"] = "set" if link.by_hand else "logged laps"
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
    db.commit()
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


@router.post("/events/{event_id}/fetch", status_code=202)
def fetch_event(event_id: int, db: Session = Depends(get_db)):
    """The "Get results" button: read this event's round again from the series' site (its whole season when the
    round isn't known yet)."""
    ev = _event(db, event_id)
    facts = _event_facts(db, ev)
    link = _link(db, ev.id)
    series = link.series if link and link.by_hand else sync.series_of_event(db, ev.id)
    year = (link.year if link and link.by_hand else None) or facts["year"]
    if year is None:
        raise HTTPException(422, "This event has no date, so its season isn't known")
    rnd = _round(db, series, year, facts["venue"], link.round_id if link and link.by_hand else None)
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
    if link is None:
        link = rm.EventResultLink(event_id=event_id, series=_series(body.series), year=body.year or 0)
        db.add(link)
    facts = _event_facts(db, _event(db, event_id))
    link.series = _series(body.series)
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
        team, _ = summary.team_of(rounds, car_number, None)
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
    started = sync.run_job(lambda: sync.sync_calendar(series, year))
    return {"started": started, "sync": sync.state.as_dict()}


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
    status = "syncing" if sync.state.running else "loaded" if rows else "not loaded"
    return {"series": series, "year": year, "status": status, "sync": sync.state.as_dict(),
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
