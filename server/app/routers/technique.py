"""Technique check: one lap's driving mistakes against perfect driving, and the ones that repeat lap after lap.

Worked out in the background from the same compact lap traces as the report (reports.py makes them, one log at a
time), for an event (every session of it) or for a session that belongs to no event. Every clean lap is checked
(analysis/technique.py) against perfect driving on its own line, at the car's limits as the whole event shows them.
Each lap's summary and the habits are kept in the database (table technique_cache), and the full check of every
lap (its mistakes in words and its speed traces) in one file in storage, read a lap at a time.

GET /technique/sessions/{id}?lap=N answers at once: the session's laps, lap N's check (by default the session's
quickest clean lap) and the mistakes that repeat across the session's and the event's clean laps; or, while the
check is worked out, its progress. GET /technique/events/{id}: the event's sessions, its quickest lap and its habits.
POST .../refresh tries again after a failure.
"""
from __future__ import annotations

import io
import json
import logging
import queue
import threading
import time
from collections import OrderedDict

import numpy as np
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app import heavy, models, storage
from app.analysis import compact
from app.analysis.technique import check_lap, habits
from app.db import SessionLocal, get_db
from app.routers import reports
from app.routers.sessions import official_corners

router = APIRouter(prefix="/technique")
log = logging.getLogger(__name__)

TECHNIQUE_VERSION = 3  # raise when the check changes, so every kept one is worked out again
TRACES_WAIT_S = 3600  # longest the check waits for the logs to be read into lap traces
HABITS_SHOWN = 12
DETAILS_KEPT = 16  # laps' full checks kept in memory
SUMMARY_KEYS = ("key", "kind", "code", "phase", "start_m", "end_m", "cost_s", "cost_perfect_s", "title", "value",
                "unit")

_jobs: queue.Queue[str] = queue.Queue()
_pending: set[str] = set()
_lock = threading.Lock()
_worker: threading.Thread | None = None
_details: OrderedDict[tuple[str, str], dict] = OrderedDict()
_details_lock = threading.Lock()


class TechniqueError(Exception):
    pass


# ---------- what a check is made from ----------

def _plan(db: Session, kind: str, id_: int) -> tuple[reports.Plan, str]:
    plan = reports.plan_for(db, kind, id_)
    return plan, reports._hash([TECHNIQUE_VERSION, plan.signature])


def _row(db: Session, scope: str) -> models.TechniqueCache | None:
    return db.scalar(select(models.TechniqueCache).where(models.TechniqueCache.scope == scope))


def _state(db: Session, kind: str, id_: int) -> tuple[reports.Plan, models.TechniqueCache | None, str]:
    """The check's status, queued when it is missing or out of date."""
    plan, sig = _plan(db, kind, id_)
    row = _row(db, plan.scope)
    if plan.error:
        return plan, row, "failed"
    if not reports._used(plan):
        return plan, row, "empty"
    if row is not None and row.signature == sig and plan.scope in _pending:
        return plan, row, row.status
    if row is not None and row.result is not None and row.result_signature == sig:
        return plan, row, "ready"
    if row is not None and row.signature == sig and row.status == "failed":
        return plan, row, "failed"  # tried for these very inputs: POST refresh to try again
    return plan, _queue(db, plan, sig, row), "queued"


def _queue(db: Session, plan: reports.Plan, sig: str, row: models.TechniqueCache | None) -> models.TechniqueCache:
    for _ in range(2):
        if row is None:
            row = models.TechniqueCache(scope=plan.scope)
            db.add(row)
        row.signature, row.status, row.error = sig, "queued", None
        row.done, row.total, row.current = 0, len(reports._used(plan)), "Waiting to start"
        try:
            db.commit()
            break
        except IntegrityError:  # another request made the row a moment ago: use that one
            db.rollback()
            row = _row(db, plan.scope)
    schedule(plan.scope)
    return row


def _head(plan: reports.Plan, row: models.TechniqueCache | None, status: str) -> dict:
    working = status in ("queued", "running")
    sig = reports._hash([TECHNIQUE_VERSION, plan.signature])
    return {
        "scope": plan.kind, "id": plan.id, "title": plan.title,
        "track": plan.track.name if plan.track else None,
        "status": status,  # ready, queued, running, failed, empty
        "progress": {"done": row.done, "total": row.total, "current": row.current} if working and row else None,
        "error": (plan.error or (row.error if row else None)) if status == "failed" else None,
        "stale": row is not None and row.result is not None and row.result_signature != sig,
    }


def _scope_of(s: models.RunSession) -> tuple[str, int]:
    """A session of an event is checked with the whole event: the car's limits from all of it, and its habits."""
    return ("event", s.event_id) if s.event_id else ("session", s.id)


# ---------- the answers ----------

def _detail(row: models.TechniqueCache, member: str) -> dict | None:
    """One lap's full check, from the file of every lap's."""
    key = (row.details or "", member)
    with _details_lock:
        if key in _details:
            _details.move_to_end(key)
            return _details[key]
    if not row.details:
        return None
    try:
        with np.load(storage.local_path(row.details)) as z:
            out = json.loads(z[member].tobytes())
    except (FileNotFoundError, KeyError, ValueError, OSError):
        log.warning("Technique check %s: lap %s not found in %s", row.scope, member, row.details)
        return None
    with _details_lock:
        _details[key] = out
        while len(_details) > DETAILS_KEPT:
            _details.popitem(last=False)
    return out


def _lap_row(x: dict) -> dict:
    return {"number": x["number"], "time": x["time"], "gap_s": x["gap"], "mistakes_s": x["budget"]["mistakes"],
            "count": len(x["mistakes"]), "top": x["mistakes"][0]["title"] if x["mistakes"] else None,
            "top_code": x["mistakes"][0]["code"] if x["mistakes"] else None, "in_lap": x.get("pit_from_m") is not None}


def _lap_out(row: models.TechniqueCache, x: dict, session_habits: list[dict]) -> dict:
    detail = _detail(row, x["detail"]) or {}
    repeats = {h["key"]: {"laps": h["laps"], "of": h["of"]} for h in session_habits}
    mistakes = [{**m, "repeats": repeats.get(m["key"])} for m in detail.get("mistakes", x["mistakes"])]
    out = {k: v for k, v in x.items() if k not in ("detail", "mistakes")}
    return {**out, "mistakes": mistakes, "trace": detail.get("trace")}


@router.get("/sessions/{session_id}")
def session_technique(session_id: int, lap: int | None = None, db: Session = Depends(get_db)):
    """The technique check of one lap of a session (?lap=<number>; by default its quickest clean lap): its mistakes
    against perfect driving, most costly first, what each costs, how the gap to the perfect lap splits, and its speed
    against perfect driving's; with the session's laps and the mistakes that repeat across them and the event."""
    s = db.get(models.RunSession, session_id)
    if s is None:
        raise HTTPException(404, "Session not found")
    kind, id_ = _scope_of(s)
    plan, row, status = _state(db, kind, id_)
    out = _head(plan, row, status)
    out["session"] = {"id": s.id, "name": s.name or f"Session {s.id}", "driver": s.driver.name if s.driver else None}
    out["event"] = {"id": s.event_id, "name": s.event.name} if s.event_id and s.event else None
    out["map"] = {"event": s.event_id} if kind == "event" else {"session": s.id}
    res = row.result if row is not None else None
    out.update(laps=[], lap=None, lap_note=None, habits=None)
    if not res:
        return out
    laps = sorted((x for x in res["laps"] if x["session_id"] == s.id), key=lambda x: x["number"])
    session_habits = res["habits"]["sessions"].get(str(s.id), [])
    out["laps"] = [_lap_row(x) for x in laps]
    out["best_lap"] = min(laps, key=lambda x: x["time"])["number"] if laps else None
    chosen = next((x for x in laps if x["number"] == lap), None) if lap is not None else None
    if lap is not None and chosen is None:
        out["lap_note"] = (f"Lap {lap} isn't one of this session's clean laps. Only clean laps are checked: out-laps, "
                           "in-laps and laps off the pace say little about technique.")
    if chosen is None and lap is None and laps:
        chosen = min(laps, key=lambda x: x["time"])
    if chosen is not None:
        out["lap"] = _lap_out(row, chosen, session_habits)
    out["habits"] = {"session": session_habits[:HABITS_SHOWN], "session_laps": len(laps),
                     "event": res["habits"]["event"][:HABITS_SHOWN] if kind == "event" else None,
                     "event_laps": len(res["laps"]) if kind == "event" else None}
    out.update({k: res[k] for k in ("sections", "corners", "length_m", "numbering")})
    return out


@router.get("/events/{event_id}")
def event_technique(event_id: int, db: Session = Depends(get_db)):
    """The event's sessions with their clean laps checked, the event's quickest lap (where the check opens) and the
    mistakes that repeat across all of the event's clean laps."""
    plan, row, status = _state(db, "event", event_id)
    out = _head(plan, row, status)
    res = row.result if row is not None else None
    sessions = []
    for item in plan.items:
        laps = [x for x in (res["laps"] if res else []) if x["session_id"] == item.session.id]
        best = min(laps, key=lambda x: x["time"]) if laps else None
        sessions.append({"id": item.session.id, "name": item.name,
                         "driver": item.session.driver.name if item.session.driver else None, "laps": len(laps),
                         "best": {"number": best["number"], "time": best["time"], "gap_s": best["gap"]}
                         if best else None})
    out["sessions"] = sessions
    quickest = min(res["laps"], key=lambda x: x["time"]) if res and res["laps"] else None
    out["best"] = ({"session_id": quickest["session_id"], "number": quickest["number"], "time": quickest["time"]}
                   if quickest else None)
    out["habits"] = res["habits"]["event"][:HABITS_SHOWN] if res else None
    out["laps_checked"] = len(res["laps"]) if res else 0
    return out


def _refresh(db: Session, kind: str, id_: int) -> None:
    plan, sig = _plan(db, kind, id_)
    if plan.error or not reports._used(plan) or plan.scope in _pending:
        return
    if reports.report_for(db, kind, id_)["status"] == "failed":
        reports._refresh(db, kind, id_)  # a log that couldn't be read is tried again too
    _queue(db, plan, sig, _row(db, plan.scope))


@router.post("/sessions/{session_id}/refresh")
def refresh_session_technique(session_id: int, db: Session = Depends(get_db)):
    s = db.get(models.RunSession, session_id)
    if s is None:
        raise HTTPException(404, "Session not found")
    _refresh(db, *_scope_of(s))
    return session_technique(session_id, None, db)


@router.post("/events/{event_id}/refresh")
def refresh_event_technique(event_id: int, db: Session = Depends(get_db)):
    _refresh(db, "event", event_id)
    return event_technique(event_id, db)


# ---------- the background work ----------

def schedule(scope: str) -> None:
    global _worker
    with _lock:
        if scope in _pending:
            return
        _pending.add(scope)
        _jobs.put(scope)
        if _worker is None or not _worker.is_alive():
            _worker = threading.Thread(target=_work, name="technique", daemon=True)
            _worker.start()


def _work() -> None:
    jobs = _jobs
    while True:
        scope = jobs.get()
        try:
            run_job(scope)
        except Exception:
            log.exception("Technique check %s failed", scope)
        finally:
            with _lock:
                _pending.discard(scope)
            heavy.release_memory()
            jobs.task_done()


def wait_idle(timeout: float = 120) -> bool:
    """Wait until every check asked for is worked out (for tests). True when nothing is left."""
    deadline = time.monotonic() + timeout
    while _jobs.unfinished_tasks and time.monotonic() < deadline:
        time.sleep(0.05)
    return not _jobs.unfinished_tasks


def _wait_for_traces(db: Session, plan: reports.Plan, row: models.TechniqueCache) -> None:
    """The lap traces come from the report's work, which reads the logs one at a time: wait until every session's
    are made (asking for the report gets that going)."""
    items = reports._used(plan)
    t0 = time.monotonic()
    while time.monotonic() - t0 < TRACES_WAIT_S:
        db.expire_all()
        ids = [i.session.id for i in items]
        recs = {r.session_id: r for r in db.scalars(select(models.SessionTraces)
                                                    .where(models.SessionTraces.session_id.in_(ids)))}
        made = sum(1 for i in items if (r := recs.get(i.session.id)) is not None and r.signature == i.signature)
        if made == len(items):
            return
        ans = reports.report_for(db, plan.kind, plan.id)
        if ans["status"] == "ready":
            return  # made for these very sessions; one gone from storage is made again as it is read
        if ans["status"] in ("failed", "empty"):
            raise TechniqueError(ans["error"] or "The logs couldn't be read")
        current = (ans.get("progress") or {}).get("current")
        text = f"Reading the logs: {current}" if current else "Waiting for the logs to be read"
        if (row.done, row.current) != (made, text[:255]):
            row.done, row.current = made, text[:255]
            db.commit()
        time.sleep(1)
    raise TechniqueError("Reading the logs took too long; try again")


def run_job(scope: str) -> None:
    kind, id_ = scope.split(":")
    with SessionLocal() as db:
        row = _row(db, scope)
        try:
            plan, sig = _plan(db, kind, int(id_))
        except HTTPException:
            return  # the event or session is gone
        if row is None:
            row = models.TechniqueCache(scope=scope, signature=sig)
            db.add(row)
        row.signature, row.status, row.error = sig, "running", None
        row.done, row.total, row.current = 0, len(reports._used(plan)), "Starting"
        db.commit()
        try:
            if plan.error:
                raise TechniqueError(plan.error)
            _wait_for_traces(db, plan, row)
            # every clean lap of the event on one line takes about 0.7 MB while it is checked: one job at a time
            with heavy.lock:
                result, blob = compute(db, plan, row)
            row.details = storage.save(blob, ".npz")
            del blob
            row.result, row.result_signature = result, sig
            row.status, row.current, row.done = "done", None, row.total
        except Exception as e:
            log.exception("Technique check %s failed", scope)
            db.rollback()
            row.status, row.current = "failed", None
            row.error = str(e) if isinstance(e, TechniqueError) else f"The technique check couldn't be worked out: {e}"
        db.commit()


def compute(db: Session, plan: reports.Plan, row: models.TechniqueCache) -> tuple[dict, bytes]:
    """Every clean lap checked: their summaries and habits (kept in the database) and every lap's full check (a
    compressed file with one member per lap, so one lap is read without the rest)."""
    corners = official_corners(plan.track)
    sessions = []
    for item in reports._used(plan):
        cs = reports._load(db, item, plan.track)
        if cs is not None and cs.n_laps:
            sessions.append((item.session.id, cs))
    if not sessions:
        raise TechniqueError("No clean laps to check")
    sessions, left_out = reports._quickest(sessions)
    prepared = compact.prepare_compact(sessions, corners)
    del sessions
    if prepared is None:
        raise TechniqueError("No clean laps to check")
    prep, extras = prepared
    row.done, row.total = 0, len(prep.laps)
    laps, blobs = [], {}
    for i, x in enumerate(prep.laps):
        if i % 10 == 0:
            row.done, row.current = i, f"Checking lap {i + 1} of {len(prep.laps)}"
            db.commit()
        out = reports._plain(check_lap(x.trace, prep.perfect, prep.held, prep.sections, lap_time=x.time,
                                       units=extras.units,
                                       calibrations=(prep.calibration, prep.held_calibration)))
        member = f"l{i}"
        laps.append({"key": x.key, "session_id": extras.session_of[x.key], "run": x.run, "number": x.number,
                     "time": x.time, "driver": x.driver, "perfect": out["perfect"], "realistic": out["realistic"],
                     "gap": out["gap"], "pit_from_m": out["pit_from_m"], "budget": out["budget"],
                     "mistakes": [{k: m[k] for k in SUMMARY_KEYS} for m in out["mistakes"]], "detail": member})
        blobs[member] = np.frombuffer(json.dumps({"mistakes": out["mistakes"], "trace": out["trace"]}).encode(),
                                      np.uint8)
    by_session: dict[int, list[list[dict]]] = {}
    for x in laps:
        by_session.setdefault(x["session_id"], []).append(x["mistakes"])
    result = {
        "length_m": prep.length - 1,  # metres: the trace has a point at both ends
        "numbering": prep.numbering,
        "sections": [{**s.to_dict(), "corners": s.corners} for s in prep.sections],
        "corners": [{"code": c[0], "at_m": c[1]} for c in corners or []],
        "reference": {"key": prep.reference.key, "session_id": extras.session_of[prep.reference.key],
                      "number": prep.reference.number, "time": prep.reference.time},
        "theoretical": prep.sim.time,
        "laps": laps,
        "habits": {"event": habits([x["mistakes"] for x in laps]),
                   "sessions": {str(sid): habits(m) for sid, m in by_session.items()}},
        "laps_left_out": left_out,
    }
    del prep, extras
    buf = io.BytesIO()
    np.savez_compressed(buf, **blobs)
    del blobs
    return reports._plain(result), buf.getvalue()
