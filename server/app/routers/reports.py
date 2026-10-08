"""The report: how to go faster, for a whole event (every session of a test), for one official session of it (FP1,
Q1, R1: every run of that session, both drivers' stints; app/run_parts.py) or for one run.

Logs are big and the hosted server has 512 MB, so the report never opens them all at once. Each session is reduced
once, in the background and one session at a time, to compact lap traces (analysis/compact.py) kept in file storage
(table session_traces). The report is then worked out from those and kept in the database (table report_cache),
with a signature of everything it was made from. When a session changes (another log, new lap times, a different
channel map or corner list), the signature no longer matches and the next request starts the work again; while it
runs, the screen shows its progress and the last report, if there is one.

GET /reports/events/{id}, GET /reports/events/{id}/sessions/{code} and GET /reports/sessions/{id} answer at once:
the report when it is up to date, otherwise its progress. POST .../refresh tries again after a failure. GET
/reports/events/{id}/parts lists the event's official sessions with their runs and whether each one's report is ready.

A session's report is made like the event's from the same compact traces, so once the event's report exists it only
works the report out from the traces of that session's runs. A session of a single run is that run's own report
(scope "session:<run id>"), worked out once for both.
"""
from __future__ import annotations

import hashlib
import json
import logging
import math
import queue
import threading
import time
from dataclasses import dataclass, field

import httpx
import numpy as np
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app import heavy, models, page_cache, run_labels, run_parts, run_tyres, storage
from app.analysis import compact
from app.analysis.advice import build_report
from app.db import SessionLocal, get_db
from app.routers.sessions import _channel_map, _line, official_corners, read_file

router = APIRouter(prefix="/reports")
log = logging.getLogger(__name__)

REPORT_VERSION = 10  # raise when the advice or the sections change, so every kept report is worked out again
TRACES_VERSION = compact.FORMAT  # raise (in compact.py) when the reduction changes
IMPORT_WAIT_S = 1800  # longest the report waits for an import that is reading logs
MAX_LAPS = 250  # the quickest laps of an event the report works from, to keep within the server's memory
SCOPE_LEN = 40  # report_cache.scope's length: a session's scope with a longer name keeps a hash of the name

_jobs: queue.Queue[str] = queue.Queue()
_pending: set[str] = set()  # scopes queued or being worked on in this process
_lock = threading.Lock()
_worker: threading.Thread | None = None


# ---------- what a report is made from ----------

@dataclass
class Item:
    session: models.RunSession
    name: str  # the run's label (run_labels.py): its own name, unique within the report, never a position
    file: models.LoggerFile | None
    signature: str | None  # of the session's compact traces


@dataclass
class Plan:
    scope: str
    kind: str  # event, part (one official session of an event: id is the event's) or session
    id: int
    title: str
    track: models.Track | None
    items: list[Item] = field(default_factory=list)
    error: str | None = None
    signature: str = ""
    labels: list[run_labels.RunLabel] = field(default_factory=list)  # the event's runs, in the event page's order
    part: str | None = None  # the official session's code ("FP1", "Q1", "03_Q") of a part's report


def _hash(payload) -> str:
    return hashlib.sha256(json.dumps(payload, sort_keys=True, default=str).encode()).hexdigest()[:40]


def _main_file(s: models.RunSession) -> models.LoggerFile | None:
    return max(s.files, key=lambda f: f.meta.get("duration_s", 0)) if s.files else None


def _track_of(db: Session, s: models.RunSession, f: models.LoggerFile | None) -> models.Track | None:
    """The session's track as the session page finds it, without reading the log: the event's, else the venue its
    log names."""
    if s.event and s.event.track:
        return s.event.track
    venue = ((f.meta.get("venue") or "") if f else "")[:120]
    return db.scalar(select(models.Track).where(models.Track.name == venue)) if venue else None


def _traces_signature(s: models.RunSession, f: models.LoggerFile, track: models.Track | None) -> str:
    laps = [(l.number, l.time_s, l.start_s, l.clean) for l in s.laps if l.file_id == f.id]
    return _hash([TRACES_VERSION, s.id, f.id, f.path, f.meta.get("beacons"), _channel_map(s),
                  track.timing_line if track else None, laps])


def plan_for(db: Session, kind: str, id_: int, part: str | None = None) -> Plan:
    """What the report of an event, of one of its official sessions (kind "part", id_ the event's, ``part`` its code)
    or of one run is made from."""
    if kind == "event":
        ev = db.get(models.Event, id_)
        if ev is None:
            raise HTTPException(404, "Event not found")
        sessions = db.scalars(select(models.RunSession).where(models.RunSession.event_id == id_)).all()
        labels = run_labels.label_runs(sessions)
        return _fill(db, Plan(f"event:{id_}", kind, id_, ev.name, ev.track, labels=labels), sessions)
    if kind == "part":
        ev, sessions, labels, found = _event_parts(db, id_)
        p = next((p for p in found if part_scope(id_, p.code) == part_scope(id_, part or "")), None)
        if p is None:
            raise HTTPException(404, "No runs of that session in this event")
        return part_plan(db, ev, sessions, labels, p)
    s = db.get(models.RunSession, id_)
    if s is None:
        raise HTTPException(404, "Session not found")
    # called as in its event's report, so its label is worked out among the event's runs
    labels = run_labels.label_runs(run_labels.event_runs(db, s))
    return _fill(db, Plan(f"session:{id_}", kind, id_, next(lab.name for lab in labels if lab.id == s.id), None,
                          labels=labels), [s])


def part_scope(event_id: int, code: str) -> str:
    """An official session's report: "part:<event id>:<code>", with a hash of a name too long for the column."""
    scope = f"part:{event_id}:{code}"
    if len(scope) <= SCOPE_LEN:
        return scope
    return f"part:{event_id}:#{hashlib.sha256(code.encode()).hexdigest()[:16]}"


def _event_parts(db: Session, event_id: int) -> tuple[models.Event, list[models.RunSession],
                                                      list[run_labels.RunLabel], list[run_parts.Part]]:
    ev = db.get(models.Event, event_id)
    if ev is None:
        raise HTTPException(404, "Event not found")
    sessions = list(db.scalars(select(models.RunSession).where(models.RunSession.event_id == event_id)).all())
    labels = run_labels.label_runs(sessions)
    return ev, sessions, labels, run_parts.parts(sessions, labels)


def part_plan(db: Session, ev: models.Event, sessions: list[models.RunSession], labels: list[run_labels.RunLabel],
              p: run_parts.Part) -> Plan:
    """An official session's report: the event's plan with only that session's runs, called by their labels among
    all the event's runs (as on the event page). A session of one run is that run's own report: the same scope and
    signature as plan_for("session", run), so it is worked out and kept once."""
    mine = [s for s in sessions if s.id in set(p.ids)]
    if len(mine) == 1:
        plan = Plan(f"session:{mine[0].id}", "part", ev.id, p.title, None, labels=labels, part=p.code)
    else:
        plan = Plan(part_scope(ev.id, p.code), "part", ev.id, p.title, ev.track, labels=labels, part=p.code)
    return _fill(db, plan, mine)


def _fill(db: Session, plan: Plan, sessions: list[models.RunSession]) -> Plan:
    """The plan's runs in the event page's order (by day, then the time of day), each called by its label, and the
    signature of everything the report is made from."""
    labels = plan.labels
    label_of = {lab.id: (k, lab) for k, lab in enumerate(labels)}
    tracks: dict[int | None, models.Track | None] = {}
    for s in sorted(sessions, key=lambda s: label_of[s.id][0]):
        f = _main_file(s)
        name = label_of[s.id][1].name
        if f is None or not any(l.clean and l.file_id == f.id for l in s.laps):
            plan.items.append(Item(s, name, f, None))  # nothing to analyse: listed, not used
            continue
        track = _track_of(db, s, f)
        tracks[track.id if track else None] = track
        plan.items.append(Item(s, name, f, _traces_signature(s, f, track)))
    if len(tracks) > 1:
        plan.error = "These sessions were driven at different tracks, so they can't share one report"
    plan.track = plan.track or next(iter(tracks.values()), None)
    corners = official_corners(plan.track)
    # the tyres the driver set on its runs: the report compares laps on the same tyres only
    tyres = sorted(run_tyres.stored(db, [i.session.id for i in plan.items if i.signature]).items())
    plan.signature = _hash([REPORT_VERSION, plan.scope, corners,
                            [(i.session.id, i.name, i.session.driver.name if i.session.driver else None, i.signature)
                             for i in plan.items if i.signature], tyres])
    return plan


def _used(plan: Plan) -> list[Item]:
    return [i for i in plan.items if i.signature]


# ---------- the answer ----------

def traces_of(db: Session, session_ids: list[int]) -> dict[int, models.SessionTraces]:
    """The compact traces rows of these sessions, by session, in one query."""
    if not session_ids:
        return {}
    rows = db.scalars(select(models.SessionTraces).where(models.SessionTraces.session_id.in_(session_ids)))
    return {r.session_id: r for r in rows}


def _sessions_out(db: Session, plan: Plan) -> list[dict]:
    out = []
    label_of = {lab.id: lab for lab in plan.labels}
    traces = traces_of(db, [i.session.id for i in plan.items])
    for i in plan.items:
        s = i.session
        clean = [l.time_s for l in s.laps if l.clean and i.file is not None and l.file_id == i.file.id]
        rec = traces.get(s.id)
        note = None
        if i.file is None:
            note = "No logger file"
        elif not clean:
            note = "No clean lap"
        elif rec is not None and rec.signature == i.signature and rec.error:
            note = rec.error
        lab = label_of.get(s.id)
        out.append({"id": s.id, "name": i.name, "short": lab.short if lab else i.name,
                    "day": lab.day if lab else None, "driver": s.driver.name if s.driver else None,
                    "clean_laps": len(clean), "best": min(clean) if clean else None,
                    "included": i.signature is not None and note is None, "note": note})
    return out


def _answer(db: Session, plan: Plan, row: models.ReportCache | None, status: str, brief: bool = False) -> dict:
    fresh = row is not None and row.result is not None and row.result_signature == plan.signature
    working = status in ("queued", "running")
    head = {
        "scope": plan.kind, "id": plan.id, "title": plan.title,
        "part": plan.part,  # a part's report: the official session's code ("FP1", "Q1", "03_Q")
        "track": plan.track.name if plan.track else None,
        "status": status,  # ready, queued, running, failed, empty
        "progress": {"done": row.done, "total": row.total, "current": row.current} if working and row else None,
        "error": (plan.error or (row.error if row else None)) if status == "failed" else None,
        "stale": row is not None and row.result is not None and not fresh,
    }
    if brief:  # how far it is, without the report: what a page waiting for it asks for again and again
        return head
    return {
        **head,
        "report": row.result if row is not None else None,
        "sessions": _sessions_out(db, plan),
        # every run of the event (for one run's report too) by its label, in the event page's order: what the
        # report calls its runs, and what a report kept from before a run was renamed is called by, through the
        # session ids it holds
        "runs": [lab.out() for lab in plan.labels],
    }


def _status(plan: Plan, row: models.ReportCache | None) -> str | None:
    """Where the plan's report is: ready, queued, running, failed or empty; None when it hasn't been asked for these
    inputs yet (asking queues it)."""
    if plan.error:
        return "failed"
    if not _used(plan):
        return "empty"
    if row is not None and row.signature == plan.signature and plan.scope in _pending:
        # being worked out (again, after a refresh); "done" is the moment between the job saving its result and
        # letting go of the scope: the report is ready
        return "ready" if row.status == "done" else row.status
    if row is not None and row.result is not None and row.result_signature == plan.signature:
        return "ready"
    if row is not None and row.signature == plan.signature and row.status == "failed":
        return "failed"  # tried for these very inputs: POST refresh to try again
    return None


def report_for(db: Session, kind: str, id_: int, part: str | None = None, brief: bool = False) -> dict:
    plan = plan_for(db, kind, id_, part)
    row = db.scalar(select(models.ReportCache).where(models.ReportCache.scope == plan.scope))
    status = _status(plan, row)
    if status is None:
        row = _queue(db, plan, row)
        status = "queued"
    return _answer(db, plan, row, status, brief)


def _queue(db: Session, plan: Plan, row: models.ReportCache | None) -> models.ReportCache:
    for _ in range(2):
        if row is None:
            row = models.ReportCache(scope=plan.scope)
            db.add(row)
        row.signature, row.status, row.error = plan.signature, "queued", None
        row.done, row.total, row.current = 0, len(_used(plan)) + 1, "Waiting to start"
        try:
            db.commit()
            break
        except IntegrityError:  # another request made the row a moment ago: use that one
            db.rollback()
            row = db.scalar(select(models.ReportCache).where(models.ReportCache.scope == plan.scope))
    schedule(plan.scope)
    return row


@router.get("/events/{event_id}")
def event_report(event_id: int, brief: bool = False, db: Session = Depends(get_db)):
    """How to go faster across every session of an event (a test): the report when it is up to date, otherwise the
    progress of the one being worked out (and the last report, marked stale). Written out as JSON here: FastAPI's own
    encoder took twice as long over the report's 80 kB (app/page_cache.py RawJSON). ?brief=true: only the status and
    progress, without the report and its runs, for a page that asks again until the report is ready."""
    return page_cache.RawJSON(page_cache.as_json(report_for(db, "event", event_id, brief=brief)))


@router.get("/events/{event_id}/sessions/{code:path}")
def event_part_report(event_id: int, code: str, brief: bool = False, db: Session = Depends(get_db)):
    """The same for one official session of the event ("FP1", "Q1", "R1", or a log folder's name like "03_Q"; see
    GET /reports/events/{id}/parts): every run of that session, called as on the event page. ?brief=true as above."""
    return page_cache.RawJSON(page_cache.as_json(report_for(db, "part", event_id, code, brief=brief)))


@router.get("/sessions/{session_id}")
def session_report(session_id: int, brief: bool = False, db: Session = Depends(get_db)):
    """The same for one session's laps."""
    return page_cache.RawJSON(page_cache.as_json(report_for(db, "session", session_id, brief=brief)))


def _refresh(db: Session, kind: str, id_: int, part: str | None = None) -> dict:
    plan = plan_for(db, kind, id_, part)
    if plan.error or not _used(plan):
        return report_for(db, kind, id_, part)
    row = db.scalar(select(models.ReportCache).where(models.ReportCache.scope == plan.scope))
    if plan.scope not in _pending:
        for i in _used(plan):  # a failed reduction is tried again too
            rec = db.scalar(select(models.SessionTraces).where(models.SessionTraces.session_id == i.session.id))
            if rec is not None and rec.error:
                db.delete(rec)
        row = _queue(db, plan, row)
    return _answer(db, plan, row, row.status if row else "queued")


@router.post("/events/{event_id}/refresh")
def refresh_event_report(event_id: int, db: Session = Depends(get_db)):
    return _refresh(db, "event", event_id)


@router.post("/events/{event_id}/sessions/{code:path}/refresh")
def refresh_event_part_report(event_id: int, code: str, db: Session = Depends(get_db)):
    return _refresh(db, "part", event_id, code)


@router.post("/sessions/{session_id}/refresh")
def refresh_session_report(session_id: int, db: Session = Depends(get_db)):
    return _refresh(db, "session", session_id)


# ---------- an event's official sessions ----------

def _clean_laps(s: models.RunSession) -> list[float]:
    f = _main_file(s)
    return [l.time_s for l in s.laps if l.clean and f is not None and l.file_id == f.id]


def _event_dates(db: Session, ev: models.Event, labels: list[run_labels.RunLabel]) -> tuple[str | None, str | None]:
    """The event's first and last day, as the event page has them (routers/events.py _folder): the dates set by
    hand, else the days its logs were recorded, else the event's date."""
    dates = db.scalar(select(models.EventDates).where(models.EventDates.event_id == ev.id))
    if dates is not None and (dates.start is not None or dates.end is not None):
        return (dates.start or dates.end).isoformat(), (dates.end or dates.start).isoformat()
    logged = sorted({lab.date for lab in labels if lab.date})
    if logged:
        return logged[0], logged[-1]
    day = ev.date.isoformat() if ev.date else None
    return day, day


def parts_of(db: Session, event_id: int) -> dict:
    """The event's official sessions in the order they ran, each with its runs, drivers, best lap and where its
    report is (from the database only: nothing is queued or read here)."""
    ev, sessions, labels, found = _event_parts(db, event_id)
    by_id = {s.id: s for s in sessions}
    plans = [part_plan(db, ev, sessions, labels, p) for p in found]
    rows = {r.scope: r for r in db.scalars(select(models.ReportCache)
                                           .where(models.ReportCache.scope.in_([pl.scope for pl in plans])))}
    out = []
    for p, plan in zip(found, plans, strict=True):
        row = rows.get(plan.scope)
        runs = []
        for lab in p.runs:
            clean = _clean_laps(by_id[lab.id])
            runs.append({"id": lab.id, "name": lab.name, "short": lab.short, "driver": lab.driver,
                         "clean_laps": len(clean), "best": min(clean) if clean else None})
        drivers = list(dict.fromkeys(r["driver"] for r in runs if r["driver"]))
        timed = [r for r in runs if r["best"] is not None]
        best = min(timed, key=lambda r: r["best"]) if timed else None
        first = p.runs[0]
        status = _status(plan, row)
        out.append({"code": p.code, "title": p.title, "official": p.official, "runs": runs,
                    "drivers": drivers, "driver_codes": [run_labels.driver_code(d) for d in drivers],
                    "clean_laps": sum(r["clean_laps"] for r in runs),
                    "best": best["best"] if best else None, "best_run": best["id"] if best else None,
                    "day": first.day, "date": first.date, "time": first.time,
                    "status": status or "not started", "ready": status == "ready",
                    "stale": row is not None and row.result is not None and status != "ready"})
    start, end = _event_dates(db, ev, labels)
    return {"event_id": ev.id, "title": ev.name, "start": start, "end": end, "parts": out}


@router.get("/events/{event_id}/parts")
def event_parts(event_id: int, db: Session = Depends(get_db)):
    """The event's official sessions (FP1, Q1, R1 stint 1 and 2 together...) in the order they ran: each one's code
    (for GET /reports/events/{id}/sessions/{code}), runs, drivers and best lap, and whether its report is ready
    ("status": ready, queued, running, failed, empty or "not started": opening it starts it). "start" and "end": the
    event's first and last day."""
    return parts_of(db, event_id)


# ---------- the background work ----------

def schedule(scope: str) -> None:
    global _worker
    with _lock:
        if scope in _pending:
            return
        _pending.add(scope)
        _jobs.put(scope)
        if _worker is None or not _worker.is_alive():
            _worker = threading.Thread(target=_work, name="reports", daemon=True)
            _worker.start()


def schedule_sessions(db: Session, session_ids: list[int]) -> None:
    """Start on the reports these sessions belong to (after an import), so they are ready when opened: their events',
    then the reports of the official sessions that got these runs (cheap once the event's has made the traces)."""
    asks: list[tuple] = []
    for sid in session_ids:
        s = db.get(models.RunSession, sid)
        if s is not None:
            asks.append(("event", s.event_id) if s.event_id else ("session", s.id))
    events = [ask[1] for ask in dict.fromkeys(asks) if ask[0] == "event"]
    for eid in events:
        asks += [("part", eid, code) for code in parts_with(db, eid, session_ids)]
    for ask in dict.fromkeys(asks):
        try:
            report_for(db, *ask)
        except HTTPException:
            pass


def parts_with(db: Session, event_id: int, session_ids: list[int]) -> list[str]:
    """The codes of the event's official sessions that hold any of these runs, in the order they ran."""
    want = set(session_ids)
    try:
        found = _event_parts(db, event_id)[3]
    except HTTPException:
        return []
    return [p.code for p in found if want & set(p.ids)]


def _work() -> None:
    jobs = _jobs
    while True:
        scope = jobs.get()
        try:
            run_job(scope)
        except Exception:
            log.exception("Report %s failed", scope)
        finally:
            with _lock:
                _pending.discard(scope)
            heavy.release_memory()
            jobs.task_done()


def prebuild(kind: str, id_: int, part: str | None = None) -> str:
    """For the prebuild (app/prebuild.py): work the report out now, on the calling thread, unless it is up to date,
    failed for these very inputs, or is queued or being worked out already. What it did."""
    with SessionLocal() as db:
        try:
            plan = plan_for(db, kind, id_, part)
        except HTTPException:
            return "gone"
        if plan.error or not _used(plan):
            return "nothing to do"
        row = db.scalar(select(models.ReportCache).where(models.ReportCache.scope == plan.scope))
        if row is not None and row.result is not None and row.result_signature == plan.signature:
            return "up to date"
        if row is not None and row.signature == plan.signature and row.status == "failed":
            return "failed before"
    if not claim(_lock, _pending, plan.scope):
        return "queued already"
    try:
        run_job(plan.scope)
    finally:
        with _lock:
            _pending.discard(plan.scope)
    return "done"


def claim(lock: threading.Lock, pending: set[str], scope: str) -> bool:
    """Mark the scope as being worked out (a request then answers with its progress, and doesn't queue it again);
    False when it is queued or being worked out already."""
    with lock:
        if scope in pending:
            return False
        pending.add(scope)
        return True


def prebuild_traces(session_id: int) -> str:
    """For the prebuild: the session's compact lap traces, one log, unless they are up to date."""
    with SessionLocal() as db:
        try:
            plan = plan_for(db, "session", session_id)
        except HTTPException:
            return "gone"
        used = _used(plan)
        if not used:
            return "nothing to do"
        rec = db.scalar(select(models.SessionTraces).where(models.SessionTraces.session_id == session_id))
        if rec is not None and rec.signature == used[0].signature:
            return "up to date"
        ensure_traces(db, used[0], plan.track)
        return "done"


def wait_idle(timeout: float = 120) -> bool:
    """Wait until every report asked for is worked out (for tests). True when nothing is left."""
    deadline = time.monotonic() + timeout
    while _jobs.unfinished_tasks and time.monotonic() < deadline:
        time.sleep(0.05)
    return not _jobs.unfinished_tasks


def _wait_for_imports(db: Session, row: models.ReportCache) -> None:
    """An import reads its logs in the background too; the report waits until it is done."""
    t0 = time.monotonic()
    busy = (models.ImportStatus.queued, models.ImportStatus.running)
    while time.monotonic() - t0 < IMPORT_WAIT_S:
        db.expire_all()
        if db.scalar(select(models.ImportJob.id).where(models.ImportJob.status.in_(busy)).limit(1)) is None:
            return
        if row.current != "Waiting for an upload to finish importing":
            row.current = "Waiting for an upload to finish importing"
            db.commit()
        time.sleep(2)


def plan_of_scope(db: Session, scope: str) -> Plan:
    """The plan a report's scope names: "event:3", "session:12", "part:3:FP1" (or "part:3:#<hash>")."""
    kind, rest = scope.split(":", 1)
    if kind == "part":
        eid, code = rest.split(":", 1)
        return plan_for(db, kind, int(eid), code)
    return plan_for(db, kind, int(rest))


def run_job(scope: str) -> None:
    kind = scope.split(":", 1)[0]
    with SessionLocal() as db:
        row = db.scalar(select(models.ReportCache).where(models.ReportCache.scope == scope))
        try:
            plan = plan_of_scope(db, scope)
        except HTTPException:
            return  # the event or session is gone
        if plan.scope != scope:
            return  # a session left with one run: its report is that run's, asked for under the run's scope
        if row is None:
            row = models.ReportCache(scope=scope, signature=plan.signature)
            db.add(row)
        items = _used(plan)
        row.signature, row.status, row.error = plan.signature, "running", None
        row.done, row.total = 0, len(items) + 1
        db.commit()
        try:
            if plan.error:
                raise ReportError(plan.error)
            _wait_for_imports(db, row)
            for n, item in enumerate(items):
                row.current = f"Reading {item.name} ({n + 1} of {len(items)})"
                db.commit()
                ensure_traces(db, item, plan.track)
                row.done = n + 1
                db.commit()
            row.current = "Working out the report"
            db.commit()
            # the logs were read one per turn of the lock above; working out the report from the compact traces
            # takes about 100 MB for a whole test, so it waits its turn too
            with heavy.lock:
                result = compute(db, plan)
            row.result, row.result_signature = result, plan.signature
            row.status, row.current, row.done = "done", None, row.total
        except Exception as e:
            log.exception("Report %s failed", scope)
            db.rollback()
            row.status, row.current = "failed", None
            row.error = str(e) if isinstance(e, ReportError) else f"The report couldn't be worked out: {e}"
        db.commit()
        if kind == "event" and row.status == "done":  # its lap traces are all made: the driver fingerprints follow
            from app import driver_prints
            driver_prints.refresh_in_background()


class ReportError(Exception):
    pass


def ensure_traces(db: Session, item: Item, track: models.Track | None) -> models.SessionTraces:
    """The session's compact traces, made from its log unless the ones kept are still up to date."""
    rec = db.scalar(select(models.SessionTraces).where(models.SessionTraces.session_id == item.session.id))
    if rec is not None and rec.signature == item.signature:
        return rec
    db.commit()  # hands the database connection back while this waits its turn: the pool is small
    with heavy.lock:
        # another job (the prebuild, a report, a technique check) may have made them while this one waited its turn
        rec = db.scalars(select(models.SessionTraces).where(models.SessionTraces.session_id == item.session.id)
                         .execution_options(populate_existing=True)).first()
        if rec is not None and rec.signature == item.signature:
            return rec
        if rec is None:
            rec = models.SessionTraces(session_id=item.session.id)
            db.add(rec)
        old = rec.path
        rec.signature, rec.error, rec.path, rec.laps = item.signature, None, None, 0
        try:
            s, f = item.session, item.file
            ld = read_file(f)
            cs = compact.reduce_log(ld, item.name, _channel_map(s), beacons=f.meta.get("beacons"), line=_line(track))
            del ld
            if cs.n_laps:
                rec.path = storage.save(compact.to_bytes(cs), ".npz")
                rec.laps = cs.n_laps
            del cs
        except (storage.StorageError, httpx.HTTPError) as e:  # storage down or slow for a moment: tried again later
            rec.error, rec.signature = f"Its log couldn't be downloaded: {e}", ""
        except (FileNotFoundError, ValueError) as e:  # missing, or not a log it can read
            rec.error = f"Its log couldn't be read: {e}"
        except Exception as e:  # one log that trips the reduction leaves that session out, not the whole report
            log.exception("Reducing session %s failed", item.session.id)
            rec.error = f"Its log couldn't be analysed: {e}"
        finally:
            heavy.release_memory()
        db.commit()  # before the lock is let go, so the next job that waited for it finds them made
    forget_file(old, rec.path)
    return rec


def forget_file(old: str | None, new: str | None) -> None:
    """Delete a stored file that a row no longer names (its traces or details were made again), so it stops taking
    storage. After the commit; a reader that still had the old name finds it gone and makes or skips it again."""
    if old and old != new:
        try:
            storage.delete(old)
        except Exception as e:  # a file left behind only takes space
            log.warning("Couldn't delete the replaced stored file %s: %s", old, e)


def _load(db: Session, item: Item, track: models.Track | None) -> compact.CompactSession | None:
    rec = ensure_traces(db, item, track)
    if rec.path is None:
        return None
    try:
        cs = compact.from_file(storage.local_path(rec.path))
    except (FileNotFoundError, ValueError, OSError):  # gone from storage, or an older format: make it again
        rec.signature = ""
        db.commit()
        rec = ensure_traces(db, item, track)
        if rec.path is None:
            return None
        cs = compact.from_file(storage.local_path(rec.path))
    cs.name = item.name
    cs.driver = item.session.driver.name if item.session.driver else None
    return cs


def compute(db: Session, plan: Plan) -> dict:
    """The report, comparing laps on the same tyres only (run_tyres): qualifying's new tyres and low fuel are a
    condition of their own, so a used-tyre lap is never measured against them. With both, the report leads with the
    used-tyre laps (the race's condition) and carries the new-tyre laps' own report under condition.other."""
    corners = official_corners(plan.track)
    sessions = []
    for item in _used(plan):
        cs = _load(db, item, plan.track)
        if cs is not None and cs.n_laps:
            sessions.append((item.session, cs))
    if not sessions:
        raise ReportError("No clean laps to analyse")
    tyres = run_tyres.resolve(db, [run_tyres.RunLaps(s.id, s.kind.value, s.name, [float(t) for t in cs.times])
                                   for s, cs in sessions])
    groups = {g: [(s.id, cs) for s, cs in sessions if tyres[s.id]["tyres"] == g] for g in CONDITIONS}
    groups = {g: xs for g, xs in groups.items() if xs}
    del sessions
    lead = run_tyres.USED if run_tyres.USED in groups else run_tyres.NEW
    out = None
    other = None
    for g in sorted(groups, key=lambda g: g != lead):
        try:
            rep = _report_of(groups.pop(g), corners)
        except ReportError:
            if g == lead and groups:  # too little to go on: the other tyres lead
                lead = next(iter(groups))
                continue
            raise
        rep["condition"] = {"tyres": g, "label": CONDITIONS[g], "laps": rep["laps_analysed"],
                            "runs": sorted(sid for sid, t in tyres.items() if t["tyres"] == g)}
        if out is None:
            out = rep
        else:
            other = rep
    if out is None:
        raise ReportError("No clean laps to analyse")
    out["condition"]["other"] = other
    for rep in (out, other) if other else ():  # two reports: each says which laps it compares
        rep["summary"] = f"{rep['condition']['label']}: {rep['summary']}"
    return _plain(out)


CONDITIONS = {run_tyres.USED: "On used tyres (practice and races)", run_tyres.NEW: "On new tyres (qualifying)"}


def _report_of(sessions: list[tuple[int, compact.CompactSession]], corners) -> dict:
    """The report of these runs' laps, all on the same tyres."""
    sessions, left_out = _quickest(sessions)
    prepared = compact.prepare_compact(sessions, corners, consume=True)
    del sessions
    if prepared is None:
        raise ReportError("No clean laps to analyse")
    prep, extras = prepared
    out = build_report(prep, extras, corners)
    out["corners"] = [{"code": c[0], "at_m": c[1]} for c in corners or []]
    out["laps_left_out"] = left_out
    return out


def _quickest(sessions: list[tuple[int, compact.CompactSession]]) -> tuple[list, int]:
    """At most MAX_LAPS laps, the quickest of all, so a long event fits in memory: each lap on the reference line
    takes about 0.7 MB while the report is worked out."""
    times = np.sort(np.concatenate([cs.times for _, cs in sessions]))
    if len(times) <= MAX_LAPS:
        return sessions, 0
    limit = times[MAX_LAPS - 1]
    kept = [(sid, compact.keep_laps(cs, cs.times <= limit)) for sid, cs in sessions]
    kept = [(sid, cs) for sid, cs in kept if cs.n_laps]
    return kept, len(times) - sum(cs.n_laps for _, cs in kept)


_PLAIN = frozenset((float, int, str, type(None)))  # exactly these types (not bool, a kind of int, nor numpy's)


def _plain(x):
    """JSON that Postgres and the API both take: plain numbers, and no NaN or infinity (None instead)."""
    if type(x) is list and all(type(v) in _PLAIN for v in x):
        # a trace: most of what a check holds, so done in one pass (x - x is NaN for NaN and infinity alike)
        return [None if type(v) is float and v - v != 0 else v for v in x]
    if isinstance(x, dict):
        return {str(k): _plain(v) for k, v in x.items()}
    if isinstance(x, list | tuple):
        return [_plain(v) for v in x]
    if isinstance(x, bool | np.bool_):
        return bool(x)
    if isinstance(x, int | np.integer):
        return int(x)
    if isinstance(x, float | np.floating):
        return float(x) if math.isfinite(x) else None
    return x
