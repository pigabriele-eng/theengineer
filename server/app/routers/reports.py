"""The report: how to go faster, for a whole event (every session of a test) or for one session.

Logs are big and the hosted server has 512 MB, so the report never opens them all at once. Each session is reduced
once, in the background and one session at a time, to compact lap traces (analysis/compact.py) kept in file storage
(table session_traces). The report is then worked out from those and kept in the database (table report_cache),
with a signature of everything it was made from. When a session changes (another log, new lap times, a different
channel map or corner list), the signature no longer matches and the next request starts the work again; while it
runs, the screen shows its progress and the last report, if there is one.

GET /reports/events/{id} and GET /reports/sessions/{id} answer at once: the report when it is up to date, otherwise
its progress. POST .../refresh tries again after a failure.
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

import numpy as np
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app import heavy, models, storage
from app.analysis import compact
from app.analysis.advice import build_report
from app.db import SessionLocal, get_db
from app.routers.sessions import _channel_map, _line, official_corners, read_file

router = APIRouter(prefix="/reports")
log = logging.getLogger(__name__)

REPORT_VERSION = 3  # raise when the advice changes, so every kept report is worked out again
TRACES_VERSION = compact.FORMAT  # raise (in compact.py) when the reduction changes
IMPORT_WAIT_S = 1800  # longest the report waits for an import that is reading logs
MAX_LAPS = 250  # the quickest laps of an event the report works from, to keep within the server's memory

_jobs: queue.Queue[str] = queue.Queue()
_pending: set[str] = set()  # scopes queued or being worked on in this process
_lock = threading.Lock()
_worker: threading.Thread | None = None


# ---------- what a report is made from ----------

@dataclass
class Item:
    session: models.RunSession
    name: str  # unique within the report
    file: models.LoggerFile | None
    signature: str | None  # of the session's compact traces


@dataclass
class Plan:
    scope: str
    kind: str  # event or session
    id: int
    title: str
    track: models.Track | None
    items: list[Item] = field(default_factory=list)
    error: str | None = None
    signature: str = ""


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


def plan_for(db: Session, kind: str, id_: int) -> Plan:
    if kind == "event":
        ev = db.get(models.Event, id_)
        if ev is None:
            raise HTTPException(404, "Event not found")
        sessions = db.scalars(select(models.RunSession).where(models.RunSession.event_id == id_)
                              .order_by(models.RunSession.name, models.RunSession.id)).all()
        plan = Plan(f"event:{id_}", kind, id_, ev.name, ev.track)
    else:
        s = db.get(models.RunSession, id_)
        if s is None:
            raise HTTPException(404, "Session not found")
        sessions = [s]
        plan = Plan(f"session:{id_}", kind, id_, s.name or f"Session {s.id}", None)
    tracks: dict[int | None, models.Track | None] = {}
    names: set[str] = set()
    for s in sessions:
        f = _main_file(s)
        name = s.name or f"Session {s.id}"
        if name in names:
            name = f"{name} #{s.id}"
        names.add(name)
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
    plan.signature = _hash([REPORT_VERSION, plan.scope, corners,
                            [(i.session.id, i.name, i.session.driver.name if i.session.driver else None, i.signature)
                             for i in plan.items if i.signature]])
    return plan


def _used(plan: Plan) -> list[Item]:
    return [i for i in plan.items if i.signature]


# ---------- the answer ----------

def _sessions_out(db: Session, plan: Plan) -> list[dict]:
    out = []
    for i in plan.items:
        s = i.session
        clean = [l.time_s for l in s.laps if l.clean and i.file is not None and l.file_id == i.file.id]
        rec = db.scalar(select(models.SessionTraces).where(models.SessionTraces.session_id == s.id))
        note = None
        if i.file is None:
            note = "No logger file"
        elif not clean:
            note = "No clean lap"
        elif rec is not None and rec.signature == i.signature and rec.error:
            note = rec.error
        out.append({"id": s.id, "name": i.name, "driver": s.driver.name if s.driver else None,
                    "clean_laps": len(clean), "best": min(clean) if clean else None,
                    "included": i.signature is not None and note is None, "note": note})
    return out


def _answer(db: Session, plan: Plan, row: models.ReportCache | None, status: str) -> dict:
    fresh = row is not None and row.result is not None and row.result_signature == plan.signature
    working = status in ("queued", "running")
    return {
        "scope": plan.kind, "id": plan.id, "title": plan.title,
        "track": plan.track.name if plan.track else None,
        "status": status,  # ready, queued, running, failed, empty
        "progress": {"done": row.done, "total": row.total, "current": row.current} if working and row else None,
        "error": (plan.error or (row.error if row else None)) if status == "failed" else None,
        "stale": row is not None and row.result is not None and not fresh,
        "report": row.result if row is not None else None,
        "sessions": _sessions_out(db, plan),
    }


def report_for(db: Session, kind: str, id_: int) -> dict:
    plan = plan_for(db, kind, id_)
    row = db.scalar(select(models.ReportCache).where(models.ReportCache.scope == plan.scope))
    if plan.error:
        return _answer(db, plan, row, "failed")
    if not _used(plan):
        return _answer(db, plan, row, "empty")
    if row is not None and row.signature == plan.signature and plan.scope in _pending:
        return _answer(db, plan, row, row.status)  # being worked out (again, after a refresh)
    if row is not None and row.result is not None and row.result_signature == plan.signature:
        return _answer(db, plan, row, "ready")
    if row is not None and row.signature == plan.signature and row.status == "failed":
        return _answer(db, plan, row, "failed")  # tried for these very inputs: POST refresh to try again
    row = _queue(db, plan, row)
    return _answer(db, plan, row, "queued")


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
def event_report(event_id: int, db: Session = Depends(get_db)):
    """How to go faster across every session of an event (a test): the report when it is up to date, otherwise the
    progress of the one being worked out (and the last report, marked stale)."""
    return report_for(db, "event", event_id)


@router.get("/sessions/{session_id}")
def session_report(session_id: int, db: Session = Depends(get_db)):
    """The same for one session's laps."""
    return report_for(db, "session", session_id)


def _refresh(db: Session, kind: str, id_: int) -> dict:
    plan = plan_for(db, kind, id_)
    if plan.error or not _used(plan):
        return report_for(db, kind, id_)
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


@router.post("/sessions/{session_id}/refresh")
def refresh_session_report(session_id: int, db: Session = Depends(get_db)):
    return _refresh(db, "session", session_id)


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
    """Start on the reports these sessions belong to (after an import), so they are ready when opened."""
    scopes = []
    for sid in session_ids:
        s = db.get(models.RunSession, sid)
        if s is not None:
            scopes.append(f"event:{s.event_id}" if s.event_id else f"session:{s.id}")
    for scope in dict.fromkeys(scopes):
        kind, id_ = scope.split(":")
        try:
            report_for(db, kind, int(id_))
        except HTTPException:
            pass


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


def run_job(scope: str) -> None:
    kind, id_ = scope.split(":")
    with SessionLocal() as db:
        row = db.scalar(select(models.ReportCache).where(models.ReportCache.scope == scope))
        try:
            plan = plan_for(db, kind, int(id_))
        except HTTPException:
            return  # the event or session is gone
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


class ReportError(Exception):
    pass


def ensure_traces(db: Session, item: Item, track: models.Track | None) -> models.SessionTraces:
    """The session's compact traces, made from its log unless the ones kept are still up to date."""
    rec = db.scalar(select(models.SessionTraces).where(models.SessionTraces.session_id == item.session.id))
    if rec is not None and rec.signature == item.signature:
        return rec
    if rec is None:
        rec = models.SessionTraces(session_id=item.session.id)
        db.add(rec)
    rec.signature, rec.error, rec.path, rec.laps = item.signature, None, None, 0
    with heavy.lock:
        try:
            s, f = item.session, item.file
            ld = read_file(f)
            cs = compact.reduce_log(ld, item.name, _channel_map(s), beacons=f.meta.get("beacons"), line=_line(track))
            del ld
            if cs.n_laps:
                rec.path = storage.save(compact.to_bytes(cs), ".npz")
                rec.laps = cs.n_laps
            del cs
        except (FileNotFoundError, ValueError, storage.StorageError) as e:  # missing, or not a log it can read
            rec.error = f"Its log couldn't be read: {e}"
        except Exception as e:  # one log that trips the reduction leaves that session out, not the whole report
            log.exception("Reducing session %s failed", item.session.id)
            rec.error = f"Its log couldn't be analysed: {e}"
        finally:
            heavy.release_memory()
    db.commit()
    return rec


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
    corners = official_corners(plan.track)
    sessions = []
    for item in _used(plan):
        cs = _load(db, item, plan.track)
        if cs is not None and cs.n_laps:
            sessions.append((item.session.id, cs))
    if not sessions:
        raise ReportError("No clean laps to analyse")
    sessions, left_out = _quickest(sessions)
    prepared = compact.prepare_compact(sessions, corners)
    del sessions
    if prepared is None:
        raise ReportError("No clean laps to analyse")
    prep, extras = prepared
    out = build_report(prep, extras, corners)
    out["corners"] = [{"code": c[0], "at_m": c[1]} for c in corners or []]
    out["laps_left_out"] = left_out
    return _plain(out)


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


def _plain(x):
    """JSON that Postgres and the API both take: plain numbers, and no NaN or infinity (None instead)."""
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
