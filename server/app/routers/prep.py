"""The prep report: one tap before a weekend turns every past event at the venue with the same car into a short,
actionable briefing (app/prep/).

GET /prep/events lists the events whose venue has past data (for the event list's button). GET
/prep/events/{id}?car=<key> answers at once: the report when it is up to date, otherwise the progress of the one being
worked out (and the last one, marked stale), or "none" with the reason when there is nothing to look back on.
POST .../refresh tries again after a failure. GET /prep/events/{id}/weather is the weather at each past event and the
forecast for this one, fetched by the server and kept a while. GET /prep/events/{id}/results is what the official
results say there (our places, strong or weak track, the makes, the prediction for this round), read live.

The work runs in one background thread, one report at a time. It reads no log itself: it asks for each past event's
report and technique check and waits for their own jobs, and the tyre prep and run balance it needs read one log at
a time under the server's heavy-work lock (app/heavy.py), as does each past event's track grip (from the traces
its report kept; app/prep/track_grip.py). The finished report is kept in the database (prep_cache)
with a signature of everything it was made from; when any of that changes, the next request works it out again.
"""
from __future__ import annotations

import logging
import queue
import threading
import time
from datetime import date

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app import heavy, models
from app.db import SessionLocal, get_db
from app.prep import brief, gather
from app.prep import official as prep_official
from app.prep import plan as prep_plan
from app.prep import track_grip as prep_track_grip
from app.prep import weather as prep_weather
from app.prep.models import PrepCache
from app.routers import reports, technique
from app.routers import track_grip as track_grip_router
from app.setup import results
from app.setup.models import SessionSetup

router = APIRouter(prefix="/prep")
log = logging.getLogger(__name__)

PREP_VERSION = 3  # raise when the report changes, so every kept one is worked out again
STEPS_PER_EVENT = 4  # report, technique check, tyre prep, setups and balance

_jobs: queue.Queue[str] = queue.Queue()
_pending: set[str] = set()
_lock = threading.Lock()
_worker: threading.Thread | None = None


# ---------- what a report is made from ----------

def _plan(db: Session, event_id: int, car: str | None) -> prep_plan.Plan:
    p = prep_plan.plan(db, event_id, car)
    if p is None:
        raise HTTPException(404, "Event not found")
    return p


def signature(db: Session, p: prep_plan.Plan) -> str:
    """Everything the report is made from: the past events' sessions (through their report's signature), the
    sessions' kinds, drivers and conditions, setup sheets, debriefs and tyre data."""
    ids = [s.id for pe in p.past for s in pe.sessions]
    events = []
    for pe in p.past:
        rp = reports.plan_for(db, "event", pe.id)
        events.append([pe.id, pe.info.event.name, pe.info.event.series, pe.info.start, pe.info.end, rp.signature,
                       [(s.id, s.kind.value, s.name, s.driver_id, s.track_temp_c, s.ambient_temp_c, s.tyre_set)
                        for s in pe.sessions]])
    sheets = db.execute(select(SessionSetup.session_id, SessionSetup.updated_at)
                        .where(SessionSetup.session_id.in_(ids))).all() if ids else []
    debriefs = db.execute(select(models.Debrief.id, models.Debrief.status, func.count(models.DebriefPoint.id),
                                 func.max(models.DebriefPoint.id))
                          .outerjoin(models.DebriefPoint, models.DebriefPoint.debrief_id == models.Debrief.id)
                          .where(models.Debrief.session_id.in_(ids)).group_by(models.Debrief.id)).all() if ids else []
    tyres = db.execute(select(func.count(models.TyreData.id), func.max(models.TyreData.updated_at))
                       .where(models.TyreData.session_id.in_(ids))).one() if ids else None
    return reports._hash([PREP_VERSION, technique.TECHNIQUE_VERSION, track_grip_router.TRACK_GRIP_VERSION,
                          results.VERSION, p.scope, p.target.start,
                          p.target.end, events, sorted((a, str(b)) for a, b in sheets),
                          sorted((a, str(b), c, d) for a, b, c, d in debriefs), [str(x) for x in tyres or ()]])


def _row(db: Session, scope: str) -> PrepCache | None:
    return db.scalar(select(PrepCache).where(PrepCache.scope == scope))


def _target(p: prep_plan.Plan) -> dict:
    t = p.target
    today = date.today().isoformat()
    return {"id": t.event.id, "name": t.event.name, "series": t.event.series, "start": t.start, "end": t.end,
            "track": t.venue, "sessions": len(t.sessions),
            "upcoming": not t.sessions or (t.start is not None and t.start > today)}


def _answer(db: Session, p: prep_plan.Plan, row: PrepCache | None, status: str, sig: str | None) -> dict:
    working = status in ("queued", "running")
    fresh = row is not None and row.result is not None and row.result_signature == sig
    none_reason = None
    if status == "none":
        none_reason = p.error or (
            f"No past event at {p.target.venue} with {p.car_label}." if p.cars else
            f"No past event at {p.target.venue or 'this track'} has clean laps yet, so there is nothing to learn from.")
    return {
        "event": _target(p), "car": {"key": p.car, "label": p.car_label}, "cars": p.cars,
        "past_events": [{"id": pe.id, "name": pe.info.event.name, "start": pe.info.start, "end": pe.info.end,
                         "sessions": len(pe.sessions), "other_cars": pe.other_cars} for pe in p.past],
        "status": status,  # ready, queued, running, failed, none
        "reason": none_reason,
        "progress": {"done": row.done, "total": row.total, "current": row.current} if working and row else None,
        "error": row.error if status == "failed" and row else None,
        "stale": row is not None and row.result is not None and not fresh,
        "report": row.result if row is not None and status != "none" else None,
    }


def prep_for(db: Session, event_id: int, car: str | None) -> dict:
    p = _plan(db, event_id, car)
    if p.error or not p.past:
        return _answer(db, p, None, "none", None)
    sig = signature(db, p)
    row = _row(db, p.scope)
    if row is not None and row.signature == sig and p.scope in _pending:
        return _answer(db, p, row, row.status, sig)
    if row is not None and row.result is not None and row.result_signature == sig:
        return _answer(db, p, row, "ready", sig)
    if row is not None and row.signature == sig and row.status == "failed":
        return _answer(db, p, row, "failed", sig)
    row = _queue(db, p, sig, row)
    return _answer(db, p, row, "queued", sig)


def _queue(db: Session, p: prep_plan.Plan, sig: str, row: PrepCache | None) -> PrepCache:
    for _ in range(2):
        if row is None:
            row = PrepCache(scope=p.scope)
            db.add(row)
        row.signature, row.status, row.error = sig, "queued", None
        row.done, row.total, row.current = 0, STEPS_PER_EVENT * len(p.past) + 1, "Waiting to start"
        try:
            db.commit()
            break
        except IntegrityError:  # another request made the row a moment ago: use that one
            db.rollback()
            row = _row(db, p.scope)
    schedule(p.scope)
    return row


# ---------- the endpoints ----------

@router.get("/events")
def prep_events(db: Session = Depends(get_db)):
    """The events whose venue has past data, for the Prep report button: per event id, how many past events (with
    the event's own car, when it has run already) and their years."""
    return {"events": {str(k): v for k, v in prep_plan.availability(db).items()}}


@router.get("/events/{event_id}")
def prep_report(event_id: int, car: str | None = None, db: Session = Depends(get_db)):
    """The prep report for an event: what every past event at its venue with the same car learned, as a briefing for
    the coming weekend (car=<key> picks another car with data there, car=any every car)."""
    return prep_for(db, event_id, car)


@router.post("/events/{event_id}/refresh")
def refresh_prep(event_id: int, car: str | None = None, db: Session = Depends(get_db)):
    p = _plan(db, event_id, car)
    if p.error or not p.past or p.scope in _pending:
        return prep_for(db, event_id, car)
    for pe in p.past:  # a past event whose report failed is tried again too
        if reports.report_for(db, "event", pe.id)["status"] == "failed":
            reports._refresh(db, "event", pe.id)
    sig = signature(db, p)
    row = _queue(db, p, sig, _row(db, p.scope))
    return _answer(db, p, row, "queued", sig)


@router.get("/events/{event_id}/weather")
def prep_weather_endpoint(event_id: int, car: str | None = None, db: Session = Depends(get_db)):
    """The weather at each past event (Open-Meteo's archive) and the forecast for this one, at the track."""
    p = _plan(db, event_id, car)
    track = p.target.track or next((pe.info.track for pe in reversed(p.past) if pe.info.track), None)
    line = (track.timing_line or {}) if track is not None else {}
    place = {"lat": line["lat"], "lon": line["lon"], "track": track.name} if "lat" in line and "lon" in line \
        else None
    past = [{"id": pe.id, "start": pe.info.start, "end": pe.info.end,
             "year": pe.info.start[:4] if pe.info.start else None} for pe in p.past]
    return prep_weather.venue_weather(db, place, past, {"start": p.target.start, "end": p.target.end})


@router.get("/events/{event_id}/results")
def prep_results_endpoint(event_id: int, car: str | None = None, db: Session = Depends(get_db)):
    """The official results at the track: our places there each year and the sessions' official weather, whether
    it is a strong or a weak track for us, the makes compared, and the prediction for this round."""
    return prep_official.official(db, _plan(db, event_id, car))


# ---------- the background work ----------

def schedule(scope: str) -> None:
    global _worker
    with _lock:
        if scope in _pending:
            return
        _pending.add(scope)
        _jobs.put(scope)
        if _worker is None or not _worker.is_alive():
            _worker = threading.Thread(target=_work, name="prep", daemon=True)
            _worker.start()


def _work() -> None:
    jobs = _jobs
    while True:
        scope = jobs.get()
        try:
            run_job(scope)
        except Exception:
            log.exception("Prep report %s failed", scope)
        finally:
            with _lock:
                _pending.discard(scope)
            heavy.release_memory()
            jobs.task_done()


def wait_idle(timeout: float = 120) -> bool:
    """Wait until every prep report asked for is worked out (for tests). True when nothing is left."""
    deadline = time.monotonic() + timeout
    while _jobs.unfinished_tasks and time.monotonic() < deadline:
        time.sleep(0.05)
    return not _jobs.unfinished_tasks


def _parse(scope: str) -> tuple[int, str]:
    ev, car = scope.split("|", 1)
    return int(ev.removeprefix("event:")), car.removeprefix("car:")


def run_job(scope: str) -> None:
    event_id, car = _parse(scope)
    with SessionLocal() as db:
        p = prep_plan.plan(db, event_id, car)
        if p is None or p.scope != scope or not p.past:
            return  # the event is gone, or the car no longer has data there
        sig = signature(db, p)
        row = _row(db, scope)
        if row is None:
            row = PrepCache(scope=scope, signature=sig)
            db.add(row)
        row.signature, row.status, row.error = sig, "running", None
        row.done, row.total, row.current = 0, STEPS_PER_EVENT * len(p.past) + 1, "Starting"
        db.commit()

        def progress(text: str) -> None:
            text = text[:255]
            if row.current != text:
                row.current = text
                db.commit()

        def step() -> None:
            row.done += 1
            db.commit()

        try:
            result = compute(db, p, progress, step)
            row.result, row.result_signature = reports._plain(result), sig
            row.status, row.current, row.done = "done", None, row.total
        except Exception as e:
            log.exception("Prep report %s failed", scope)
            db.rollback()
            row.status, row.current = "failed", None
            row.error = f"The prep report couldn't be worked out: {e}"
        db.commit()


def compute(db: Session, p: prep_plan.Plan, progress, step) -> dict:
    """Gather every past event, one at a time, then write the report. Each event's report and technique check are
    asked for only when their turn comes (waiting for one asks for it), so no other job of ours holds its memory while
    this one reads a log."""
    events, observations, summaries = [], [], []
    for pe in p.past:
        year = pe.info.start[:4] if pe.info.start else "undated"
        ev = {"id": pe.id, "name": pe.info.event.name, "start": pe.info.start, "end": pe.info.end, "year": year,
              "other_cars": pe.other_cars, "sessions": gather.session_rows(db, pe)}
        rep, ev["report_note"] = gather.wait_report(db, pe, progress)
        ev["report"] = brief.trim_report(rep)
        del rep
        step()
        tech, ev["technique_note"] = gather.wait_technique(db, pe, progress)
        ev["technique"] = gather.driver_habits(tech, pe)
        del tech
        step()
        progress(f"Tyre and quali prep of {gather.label(pe)}")
        ev["tyreprep"], ev["tyreprep_note"] = gather.tyre_prep(db, pe)
        step()
        ev["runs"], ev["remarks"], sums, obs = gather.setups(db, pe, progress)
        observations += obs
        summaries += [(year, sid, s) for sid, s in sums.items()]
        step()
        events.append(ev)
    progress("The pooled tyre model")
    tracks = list(dict.fromkeys(pe.info.track.name for pe in reversed(p.past) if pe.info.track))
    tyre_model = gather.pooled_tyre_model(db, p, tracks)
    grip = prep_track_grip.summarise(prep_track_grip.gather(db, p, progress))
    progress("Writing the report")
    setup = gather.recommend_setup(p, events, observations, summaries)
    out = brief.build(_target(p), {"key": p.car, "label": p.car_label}, events, tyre_model, setup)
    out["track_grip"] = grip
    return out
