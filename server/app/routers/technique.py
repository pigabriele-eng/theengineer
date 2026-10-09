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
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app import heavy, models, run_tyres, storage
from app.analysis import compact
from app.analysis.insights import targets
from app.analysis.shifts import ShiftModel
from app.analysis.technique import (
    INPUT_ROLES,
    Pass,
    best_technique,
    check_lap,
    habits,
    mistake_stats,
    mistakes_total,
    pool_stats,
    relative_braking,
    section_times,
)
from app.db import SessionLocal, get_db
from app.routers import reports
from app.routers.sessions import official_corners

router = APIRouter(prefix="/technique")
log = logging.getLogger(__name__)

TECHNIQUE_VERSION = 20  # raise when the check changes, so every kept one is worked out again
# 5: perfect driving on a lap's own line at limits never below that lap's own (local_limits.on_own_line)
# 6: the driver's inputs and perfect driving's phases with each lap's speed trace
# 7: the obvious mistakes (exit lifts, power stepped on, soft straight-line braking); the theoretical lap never quicker
#    than the best real pass through a section; laps off the fastest lap's line left out of the targets
# 8: early and late upshifts against the revs where the next gear drives harder (analysis.shifts)
# 9: the throttle on and off through a corner; the theoretical lap's speed smooth across section joins, and no floor
#    from another lap's pass on a flat-out section
# 10: the speed stalling or dropping on the way out of a corner, whatever the pedal shows
# 11: perfect driving's and the realistic target's inputs (throttle, brake, ideal gear and revs) to lay over the
#     driver's, and the driver's revs among their inputs; the best technique: the driver's quickest clean pass of
#     the event through every section, built where none beats the lap; every obvious mistake's cost measured on the
#     laps (with it against without it), pooled over the track's checks
#     power oversteer (opposite lock on the throttle out of a corner); braking grip left unused up to the turn-in,
#     against the best braking there on the other laps
# 12: perfect driving and the realistic target shift up at the ideal revs (insights.targets)
# 13: a lift from full throttle past the slowest point is a lift on the way out however hard the car corners; the
#     lifts the comparison with the target names are obvious ones too; every obvious mistake counts in the budget
# 14: every lift and on/off throttle counts, however small (10 points off the pedal for 0.08 s), whatever it costs
# 15: perfect driving takes only section passes timed as their own speed says (insights.consistent_passes)
# 16: no perfect lap shown: every lap against laps on the same tyres (run_tyres), the mistakes that repeat are the
#     obvious ones, and each lap's time without its mistakes
# 17: a run imported from a folder ("03_Q", "04_R1") is qualifying or a race for its tyres, as its name says
# 18: the result says its shape (RESULT_FORMAT), so one kept in an older shape is worked out again, never read
# 19: four tyre levels, guessed among the event's runs in the order they ran (run_tyres); new kept apart from the rest
RESULT_FORMAT = 2  # the shape of a kept result the answers read: 2 with each lap's time without its mistakes (16)
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
    # the tyres the driver set on its runs are part of what the check is made from: new or not, as the check groups
    # laps (run_tyres.pair); Fresh, Used or Very used picked among themselves change no lap's group, so no new check
    # (each a full check of the event: minutes on the live server), only the label (_tyres_out reads it as set now)
    plan = reports.plan_for(db, kind, id_, tyres_as=run_tyres.pair)
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
    # still in _pending for a moment after it marks itself done or failed: only queued and running are passed on
    if row is not None and row.signature == sig and plan.scope in _pending and row.status in ("queued", "running"):
        return plan, row, row.status
    if row is not None and _current(row) is not None and row.result_signature == sig:
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
        "stale": _current(row) is not None and row.result_signature != sig,
    }


def _scope_of(s: models.RunSession) -> tuple[str, int]:
    """A session of an event is checked with the whole event: the car's limits from all of it, and its habits."""
    return ("event", s.event_id) if s.event_id else ("session", s.id)


# ---------- the answers ----------

def _current(row: models.TechniqueCache | None) -> dict | None:
    """The kept result, where it is in the shape the answers read; one kept before then is no answer (it is worked
    out again: its signature is an older TECHNIQUE_VERSION's)."""
    res = row.result if row is not None else None
    return res if res and res.get("format") == RESULT_FORMAT else None


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
    ob = x["obvious"]
    return {"number": x["number"], "time": x["time"], "tyres": x.get("tyres"), "mistakes_s": x["mistakes_s"],
            "without_mistakes": x["without_mistakes"], "count": len(ob), "top": ob[0]["title"] if ob else None,
            "top_code": ob[0]["code"] if ob else None, "in_lap": x.get("pit_from_m") is not None}


def _fastest(row: models.TechniqueCache, res: dict, x: dict) -> dict | None:
    """The scope's fastest lap (the reference the report uses), with its inputs to lay over lap x's; none when x is
    that lap."""
    ref = ((res.get("tyres") or {}).get(x.get("tyres")) or {}).get("reference") or res.get("reference")  # same tyres
    lap = next((y for y in res["laps"] if y["key"] == ref["key"]), None) if ref else None
    if lap is None:
        return None
    this = lap["key"] == x["key"]
    trace = None if this else ((_detail(row, lap["detail"]) or {}).get("trace") or {})
    return {"session_id": lap["session_id"], "run": lap["run"], "number": lap["number"], "time": lap["time"],
            "this_lap": this, "inputs": trace.get("inputs") if trace else None}


_others: dict[str, tuple[tuple, list[list[dict]]]] = {}  # track -> (its checks' versions, their mistake_stats)


def _measured(db: Session, row: models.TechniqueCache, res: dict) -> dict[str, dict]:
    """Every obvious mistake's cost measured on the laps (technique.pool_stats): this check's laps pooled with every
    other check at the same track, so it grows as more logs arrive."""
    track = res.get("track")
    own = res.get("mistake_stats") or []
    if not track:
        return pool_stats([own])
    T = models.TechniqueCache
    stamp = tuple(db.execute(select(T.id, T.updated_at).where(T.result.is_not(None), T.id != row.id)
                             .order_by(T.id)).all())
    with _details_lock:
        cached = _others.get(track)
    if cached is None or cached[0] != stamp:
        others = []
        for r in db.scalars(select(T).where(T.result.is_not(None), T.id != row.id)):
            if r.result.get("track") == track and r.result.get("mistake_stats"):
                others.append(r.result["mistake_stats"])
        with _details_lock:
            _others[track] = (stamp, others)
    else:
        others = cached[1]
    return pool_stats([own, *others])


def _lap_out(row: models.TechniqueCache, res: dict, x: dict, session_habits: list[dict],
             measured: dict[str, dict] | None = None) -> dict:
    """One lap's check as the page shows it: its obvious mistakes (each with how often it repeats and what it
    measures on the laps), what the lap would have been without them, and its speed and inputs with the driver's best
    real passes on the same tyres to lay over them. No perfect lap: the targets the check works from stay inside."""
    detail = _detail(row, x["detail"]) or {}
    repeats = {h["key"]: {"laps": h["laps"], "of": h["of"]} for h in session_habits}
    out = {k: v for k, v in x.items() if k not in HIDDEN}
    out["obvious"] = [{**m, "repeats": repeats.get(m["key"]),
                       "measured": (measured or {}).get(f"{m['code']}:{m['kind']}")} for m in x.get("obvious", [])]
    trace = detail.get("trace")
    if trace:
        trace = {k: v for k, v in trace.items() if k not in ("perfect", "realistic", "model_phases")}
        trace["model"] = {k: v for k, v in (trace.get("model") or {}).items() if k in ("best",)}
    return {**out, "trace": trace, "fastest": _fastest(row, res, x)}


HIDDEN = ("detail", "mistakes", "perfect", "realistic", "gap", "budget")  # a lap's parts the page never shows


def live_tyres(res: dict | None, stored: dict[int, str]) -> dict[str, dict]:
    """The runs' tyres as the check kept them, with the driver's picks as they are now (a pick that keeps a run new or
    not leaves the check as it is: _plan)."""
    out = dict((res or {}).get("run_tyres") or {})
    for sid, level in stored.items():
        t = out.get(str(sid))
        if t is not None and level in run_tyres.LABEL and (t.get("tyres") != level or not t.get("sure")):
            out[str(sid)] = {**run_tyres._out(level, True, "set by you"), "guess": t.get("guess", t.get("tyres"))}
    return out


def _tyres_out(res: dict | None, session_id: int, stored: dict[int, str] | None = None) -> dict | None:
    """A run's tyres (run_tyres: the driver's, or guessed and to confirm) and how many laps of the event are on them."""
    t = live_tyres(res, stored or {}).get(str(session_id))
    if t is None:
        return None
    on = ((res or {}).get("tyres") or {}).get(t.get("pair") or run_tyres.pair(t["tyres"])) or {}
    return {**t, "label": run_tyres.LABEL.get(t["tyres"]), "pair": run_tyres.pair(t["tyres"]), "laps": on.get("laps")}


class TyresIn(BaseModel):
    tyres: Literal["new", "fresh", "used", "worn"]  # run_tyres.LEVELS: New, Fresh, Used, Very used


@router.put("/sessions/{session_id}/tyres")
def set_session_tyres(session_id: int, body: TyresIn, db: Session = Depends(get_db)):
    """The run's tyres as the driver says (New, Fresh, Used or Very used): the check is worked out again with every
    lap against laps on similar tyres."""
    s = db.get(models.RunSession, session_id)
    if s is None:
        raise HTTPException(404, "Session not found")
    run_tyres.set_tyres(db, s.id, body.tyres)
    kind, id_ = _scope_of(s)
    _, _, status = _state(db, kind, id_)
    return {"tyres": body.tyres, "status": status}


@router.get("/events/{event_id}/tyres")
def event_tyres(event_id: int, db: Session = Depends(get_db)):
    """Every run of the event with its tyres (run_tyres: the driver's pick, else the guess and why), in the order
    they ran: what the upload and the event page offer to confirm or change with one tap."""
    from app import run_labels

    runs = list(db.scalars(select(models.RunSession).where(models.RunSession.event_id == event_id)))
    if not runs and db.get(models.Event, event_id) is None:
        raise HTTPException(404, "Event not found")
    tyres = run_tyres.for_runs(db, runs)
    return {"levels": [{"key": k, "label": run_tyres.LABEL[k]} for k in run_tyres.LEVELS],
            "runs": [{**lab.out(), "tyres": tyres.get(lab.id)} for lab in run_labels.label_runs(runs)]}


@router.get("/sessions/{session_id}")
def session_technique(session_id: int, lap: int | None = None, db: Session = Depends(get_db), brief: bool = False):
    """The technique check of one lap of a session (?lap=<number>; by default its quickest clean lap): its mistakes
    against perfect driving, most costly first, what each costs, how the gap to the perfect lap splits, and its speed
    against perfect driving's; with the session's laps and the mistakes that repeat across them and the event."""
    s = db.get(models.RunSession, session_id)
    if s is None:
        raise HTTPException(404, "Session not found")
    kind, id_ = _scope_of(s)
    plan, row, status = _state(db, kind, id_)
    out = _head(plan, row, status)
    if brief:  # ?brief=true: how far the check is, without it, for a page that asks again until it is ready
        return out
    out["session"] = {"id": s.id, "name": s.name or f"Session {s.id}", "driver": s.driver.name if s.driver else None}
    out["event"] = {"id": s.event_id, "name": s.event.name} if s.event_id and s.event else None
    out["map"] = {"event": s.event_id} if kind == "event" else {"session": s.id}
    res = _current(row)
    out.update(laps=[], lap=None, lap_note=None, habits=None, measured=None)
    if not res:
        return out
    laps = sorted((x for x in res["laps"] if x["session_id"] == s.id), key=lambda x: x["number"])
    session_habits = res["habits"]["sessions"].get(str(s.id), [])
    out["laps"] = [_lap_row(x) for x in laps]
    out["tyres"] = _tyres_out(res, s.id, run_tyres.stored(db, [s.id]))
    out["best_lap"] = min(laps, key=lambda x: x["time"])["number"] if laps else None
    chosen = next((x for x in laps if x["number"] == lap), None) if lap is not None else None
    if lap is not None and chosen is None:
        out["lap_note"] = (f"Lap {lap} isn't one of this session's clean laps. Only clean laps are checked: out-laps, "
                           "in-laps and laps off the pace say little about technique.")
    if chosen is None and lap is None and laps:
        chosen = min(laps, key=lambda x: x["time"])
    measured = _measured(db, row, res)
    if chosen is not None:
        out["lap"] = _lap_out(row, res, chosen, session_habits, measured)
    # the obvious mistakes ranked by what they really cost, most expensive first (the model's estimate where too few
    # laps measure one)
    out["measured"] = sorted(measured.values(), key=lambda m: (not m["clear"], -m["cost_s"]))[:HABITS_SHOWN]
    out["habits"] = {"session": session_habits[:HABITS_SHOWN], "session_laps": len(laps),
                     "event": res["habits"]["event"][:HABITS_SHOWN] if kind == "event" else None,
                     "event_laps": len(res["laps"]) if kind == "event" else None}
    out.update({k: res[k] for k in ("sections", "corners", "length_m", "numbering", "inputs")})
    return out


@router.get("/events/{event_id}")
def event_technique(event_id: int, db: Session = Depends(get_db), brief: bool = False):
    """The event's sessions with their clean laps checked, the event's quickest lap (where the check opens) and the
    mistakes that repeat across all of the event's clean laps."""
    plan, row, status = _state(db, "event", event_id)
    out = _head(plan, row, status)
    if brief:  # ?brief=true: only how far the check is
        return out
    res = _current(row)
    stored = run_tyres.stored(db, [i.session.id for i in plan.items])
    sessions = []
    for item in plan.items:
        laps = [x for x in (res["laps"] if res else []) if x["session_id"] == item.session.id]
        best = min(laps, key=lambda x: x["time"]) if laps else None
        sessions.append({"id": item.session.id, "name": item.name, "tyres": _tyres_out(res, item.session.id, stored),
                         "driver": item.session.driver.name if item.session.driver else None, "laps": len(laps),
                         "best": {"number": best["number"], "time": best["time"],
                                  "without_mistakes": best["without_mistakes"]}
                         if best else None})
    out["sessions"] = sessions
    quickest = min(res["laps"], key=lambda x: x["time"]) if res and res["laps"] else None
    out["best"] = ({"session_id": quickest["session_id"], "number": quickest["number"], "time": quickest["time"]}
                   if quickest else None)
    out["habits"] = res["habits"]["event"][:HABITS_SHOWN] if res else None
    out["measured"] = (sorted(_measured(db, row, res).values(), key=lambda m: (not m["clear"], -m["cost_s"]))
                       [:HABITS_SHOWN] if res and row is not None else None)
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


def prebuild(kind: str, id_: int) -> str:
    """For the prebuild (app/prebuild.py): work the check out now, on the calling thread, unless it is up to date,
    failed for these very inputs, or is queued or being worked out already. What it did."""
    with SessionLocal() as db:
        try:
            plan, sig = _plan(db, kind, id_)
        except HTTPException:
            return "gone"
        if plan.error or not reports._used(plan):
            return "nothing to do"
        row = _row(db, plan.scope)
        if row is not None and _current(row) is not None and row.result_signature == sig:
            return "up to date"
        if row is not None and row.signature == sig and row.status == "failed":
            return "failed before"
    if not reports.claim(_lock, _pending, plan.scope):
        return "queued already"
    try:
        run_job(plan.scope)
    finally:
        with _lock:
            _pending.discard(plan.scope)
    return "done"


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
            old = row.details
            row.details = storage.save(blob, ".npz")
            del blob
            row.result, row.result_signature = result, sig
            row.status, row.current, row.done = "done", None, row.total
            db.commit()
            reports.forget_file(old, row.details)
        except Exception as e:
            log.exception("Technique check %s failed", scope)
            db.rollback()
            row.status, row.current = "failed", None
            row.error = str(e) if isinstance(e, TechniqueError) else f"The technique check couldn't be worked out: {e}"
        db.commit()


# inputs worked out from a logger channel of another role: the one named for them
INPUT_FROM = {"rear_slip": "wheel_rl", "tc_on": "tc"}


def compute(db: Session, plan: reports.Plan, row: models.TechniqueCache) -> tuple[dict, bytes]:
    """Every clean lap checked: their summaries and habits (kept in the database) and every lap's full check (a
    compressed file with one member per lap, so one lap is read without the rest)."""
    corners = official_corners(plan.track)
    sessions = []
    channels: dict[str, str] = {}  # role -> the logger channel the inputs come from
    for item in reports._used(plan):
        cs = reports._load(db, item, plan.track)
        if cs is not None and cs.n_laps:
            sessions.append((item.session.id, cs))
            for r in INPUT_ROLES:
                src = cs.sources.get(INPUT_FROM.get(r, r))
                if r in cs.traces and src:
                    channels.setdefault(r, src)
    if not sessions:
        raise TechniqueError("No clean laps to check")
    sessions, left_out = reports._quickest(sessions)
    # the car's limits are worked out below, for the laps on each kind of tyres
    prepared = compact.prepare_compact(sessions, corners, consume=True, limits=False)
    del sessions
    if prepared is None:
        raise TechniqueError("No clean laps to check")
    prep, extras = prepared
    shifts = ShiftModel.of([x.trace for x in prep.laps])  # the event's shift points, from its own logs
    # like with like: every lap against perfect driving on the same tyres (run_tyres), never qualifying's grip for a
    # race lap
    runs = {i.session.id: i.session for i in reports._used(plan)}
    times: dict[int, list[float]] = {}
    for x in prep.laps:
        times.setdefault(extras.session_of[x.key], []).append(x.time)
    # each run's tyres guessed among every run of the event in the order they ran; the check keeps new tyres
    # (qualifying's grip) apart from the rest, so each group has laps enough to go on
    every = run_tyres.for_runs(db, list(runs.values()))
    tyres = {sid: every.get(sid) or run_tyres.resolve(db, [run_tyres.RunLaps(sid, "test", None, ts)])[sid]
             for sid, ts in times.items()}
    tyres_of = {x.key: tyres[extras.session_of[x.key]]["pair"] for x in prep.laps}
    groups = {}
    for g in (run_tyres.NEW, run_tyres.USED):
        xs = [x for x in prep.laps if tyres_of[x.key] == g]
        if not xs:
            continue
        ref = min(xs, key=lambda x: x.time)
        if len(xs) == len(prep.laps):
            full = prep.prepared()
            groups[g] = (full.perfect, full.held, full.calibration, full.held_calibration, full.sim.time, ref)
        else:
            row.current = f"Perfect driving on {g} tyres"
            db.commit()
            t = targets(xs, ref.trace, ref.time, prep.sections)
            groups[g] = (t.perfect, t.held, t.calibration, t.held_calibration, t.sim.time, ref)
    row.done, row.total = 0, len(prep.laps)
    laps, details, passes = [], {}, []
    for i, x in enumerate(prep.laps):
        if i % 10 == 0:
            row.done, row.current = i, f"Checking lap {i + 1} of {len(prep.laps)}"
            db.commit()
        perfect, held, cal, held_cal, _, _ = groups[tyres_of[x.key]]
        out = reports._plain(check_lap(x.trace, perfect, held, prep.sections, lap_time=x.time, units=extras.units,
                                       calibrations=(cal, held_cal), shifts=shifts))
        member = f"l{i}"
        laps.append({"key": x.key, "session_id": extras.session_of[x.key], "run": x.run, "number": x.number,
                     "tyres": tyres_of[x.key],
                     "time": x.time, "driver": x.driver, "perfect": out["perfect"], "realistic": out["realistic"],
                     "gap": out["gap"], "pit_from_m": out["pit_from_m"], "budget": out["budget"],
                     "mistakes": [{k: m[k] for k in SUMMARY_KEYS} for m in out["mistakes"]],
                     "obvious": out["obvious"], "detail": member})
        details[member] = {"mistakes": out["mistakes"], "trace": out["trace"]}
        passes.append(Pass(x.run, x.number, x.time, x.driver, section_times(x.trace, prep.sections), out["obvious"],
                           out["trace"], out["braking"]))
    # braking left unused at a corner is a mistake against the best braking there on the other laps on the same tyres
    for g in groups:
        on = [(p, x) for p, x in zip(passes, prep.laps, strict=True) if tyres_of[x.key] == g]
        relative_braking([p.braking for p, _ in on], [p.obvious for p, _ in on])
    # what the lap would have been without its mistakes: its time less what the obvious mistakes cost, each once
    for x in laps:
        x["obvious"].sort(key=lambda o: -o["cost_s"])
        x["mistakes_s"] = mistakes_total(x["obvious"])
        x["without_mistakes"] = round(x["time"] - x["mistakes_s"], 3)
    # every lap's best technique: the driver's quickest clean pass of the event through each section, or built
    blobs = {}
    same = {g: [p for p, x in zip(passes, prep.laps, strict=True) if tyres_of[x.key] == g] for g in groups}
    for i, (p, x) in enumerate(zip(passes, prep.laps, strict=True)):
        member = f"l{i}"
        details[member]["trace"]["model"]["best"] = reports._plain(best_technique(p, same[tyres_of[x.key]],
                                                                                  prep.sections, shifts))
        blobs[member] = np.frombuffer(json.dumps(details[member]).encode(), np.uint8)
    del details
    by_session: dict[int, list[list[dict]]] = {}
    for x in laps:  # the mistakes that repeat: the obvious ones
        by_session.setdefault(x["session_id"], []).append(x["obvious"])
    result = {
        "format": RESULT_FORMAT,
        "length_m": prep.length - 1,  # metres: the trace has a point at both ends
        "numbering": prep.numbering,
        "sections": [{**s.to_dict(), "corners": s.corners} for s in prep.sections],
        "corners": [{"code": c[0], "at_m": c[1]} for c in corners or []],
        "reference": {"key": prep.reference.key, "session_id": extras.session_of[prep.reference.key],
                      "number": prep.reference.number, "time": prep.reference.time},
        # the laps on each tyres and the quickest of them (each lap is compared only with laps on the same tyres)
        "tyres": {g: {"laps": sum(1 for x in prep.laps if tyres_of[x.key] == g),
                      "reference": {"key": v[5].key, "session_id": extras.session_of[v[5].key],
                                    "number": v[5].number, "time": v[5].time}} for g, v in groups.items()},
        "run_tyres": {str(sid): v for sid, v in tyres.items()},
        "shift_points": shifts.to_dict() if shifts is not None else None,
        # the driver's inputs sent with every lap's trace: the logger channel each comes from and its unit
        "inputs": {r: {"channel": channels.get(r), "unit": extras.units.get(r)} for r in INPUT_ROLES},
        "laps": laps,
        "habits": {"event": habits([x["obvious"] for x in laps]),
                   "sessions": {str(sid): habits(m) for sid, m in by_session.items()}},
        "laps_left_out": left_out,
        # what each obvious mistake really cost on these laps, per driver, pooled with the track's other events
        "track": plan.track.name if plan.track else None,
        "mistake_stats": mistake_stats([(x["driver"], p.times, x["obvious"]) for x, p in zip(laps, passes,
                                                                                             strict=True)],
                                       prep.sections),
    }
    del prep, extras, passes
    buf = io.BytesIO()
    np.savez_compressed(buf, **blobs)
    del blobs
    return reports._plain(result), buf.getvalue()
