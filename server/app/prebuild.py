"""The prebuild: right after logs are uploaded, the server works out in the background what the app's pages will ask
for, so they open at once instead of working it out while Gabriele waits.

For each uploaded run and the event it is in, in this order (the pages that ask for it in brackets):
1. the run's compact lap traces, one log at a time (Report, Technique, Track grip, the event's side by side);
2. the event's report, track map and shape, track grip, grip use, balance and its main logs' stint view (Report; the
   session page's best section times);
3. the run's lap analysis, stint view, track map and track shape (the session page);
4. the event's technique check, or the run's when it is in no event (Technique);
5. the run's tyre prep (Quali), and its own report, grip use and balance (Report of one run);
6. the prep report of each event at the venue that draws on this one (Prep), after the past events it uses;
7. the warm-ups other modules add (warm(), register()).
Insights (GET /sessions/{id}/insights) are kept once asked for (app/page_cache.py) but not made here: no page of the
app asks for them. Track grip and prep are also made from the logs' tyre data, which the tyre data job
(vehicle/tyre_store.py) summarises at quiet moments: while it still has these runs' logs to do they wait, and the job
queues them again once it has done them (after_tyre_data).

Each piece is the page's own code and cache: a piece whose answer is kept and up to date takes milliseconds; the work
itself runs exactly as it would for the page, under the heavy-work lock, one log at a time.

Gabriele's clicks come first. The pieces run one at a time on one thread, as background work (heavy.background()):
it takes the heavy-work lock only when no request or other job is waiting for it, and between pieces it waits while
one is. A page opened meanwhile waits at most for the one piece already running (the longest is an event's technique
check), and a page whose answer is kept doesn't wait at all.

On server start (Render starts it again after each deploy, and when it wakes from sleep), once the start-up checks
are done, every event (newest first), then the runs in no event and the prep reports, go through the same pieces at
the lowest priority: whatever is missing or out of date (after a new version of a page, say) is worked out again.

PREBUILD=off turns it off (the tests do, except their own): an import then queues only its reports, as before.
"""
from __future__ import annotations

import itertools
import logging
import os
import queue
import threading
import time
from collections.abc import Callable

from fastapi import APIRouter, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from app import heavy, models

log = logging.getLogger(__name__)
router = APIRouter(prefix="/prebuild")

UPLOAD, START = 0, 1  # priorities: the pieces for an upload go before the start-up's
START_DELAY_S = 15  # after start-up before the start-up pass looks for work (the first requests go first)
SETTLE_WAIT_S = 900  # longest the start-up pass waits for the start-up checks (re-timing, empty runs) to finish
RECENT = 50  # pieces remembered for GET /prebuild

Piece = tuple[str, tuple]  # (what, its arguments)

_queue: queue.PriorityQueue = queue.PriorityQueue()
_queued: set[tuple[int, Piece]] = set()
_lock = threading.Lock()
_order = itertools.count()
_worker: threading.Thread | None = None
_state: dict = {"current": None, "done": 0, "worked": 0, "recent": []}
_warmers: list[Callable[[list[int]], None]] = []


def enabled() -> bool:
    return os.environ.get("PREBUILD", "on").strip().lower() not in ("off", "0", "false", "no")


# ---------- what to make ----------

def after_upload(db: Session, session_ids: list[int]) -> None:
    """Logs were added to these runs (an import, or an upload to a run): work out their pages and their events' in the
    background, before anything the start-up pass queued."""
    if not enabled():
        return
    try:
        _put(UPLOAD, pieces(db, session_ids))
    except Exception:  # never fails the upload: the pages are then worked out when opened, as before
        log.exception("Couldn't queue the prebuild of runs %s", session_ids)


def pieces(db: Session, session_ids: list[int], prep: bool = True) -> list[Piece]:
    """The pieces for these runs and their events, in the order they are made (see the module's notes)."""
    runs = [s for sid in dict.fromkeys(session_ids) if (s := db.get(models.RunSession, sid)) is not None]
    sids = [s.id for s in runs]
    events = list(dict.fromkeys(s.event_id for s in runs if s.event_id is not None))
    out: list[Piece] = [("traces", (sid,)) for sid in sids]
    for e in events:
        out += [("report", ("event", e)), ("event map", (e,)), ("event shape", (e,)), ("track grip", (e,)),
                ("grip", ("event", e)), ("balance", ("event", e)), ("event stint", (e,))]
    for sid in sids:
        out += [("analysis", (sid,)), ("stint", (sid,)), ("map", (sid,)), ("shape", (sid,))]
    out += [("technique", ("event", e)) for e in events]
    out += [("technique", ("session", s.id)) for s in runs if s.event_id is None]
    for sid in sids:
        out += [("tyre prep", (sid,)), ("report", ("session", sid)), ("grip", ("session", sid)),
                ("balance", ("session", sid))]
    if prep:
        out += [("prep", (t,)) for t in prep_targets(db, events)]
    if sids:
        out.append(("warm", (tuple(sids),)))
    return out


def after_tyre_data(session_ids: list[int]) -> None:
    """The tyre data job summarised these runs' logs: their events' track grip and the prep reports drawing on them
    are worked out again (they waited for it)."""
    if not enabled():
        return
    from app.db import SessionLocal

    with SessionLocal() as db:
        runs = [s for sid in session_ids if (s := db.get(models.RunSession, sid)) is not None]
        events = list(dict.fromkeys(s.event_id for s in runs if s.event_id is not None))
        _put(UPLOAD, [("track grip", (e,)) for e in events] + [("prep", (t,)) for t in prep_targets(db, events)])


def _tyre_data_pending(db: Session, session_ids: list[int] | None = None) -> bool:
    """Whether the tyre data job still has logs of these runs (of any run, without session_ids) to summarise."""
    from app.vehicle import tyre_store

    todo = tyre_store._todo(db)
    if not todo or session_ids is None:
        return bool(todo)
    return db.scalar(select(models.LoggerFile.id).where(models.LoggerFile.id.in_(todo),
                                                        models.LoggerFile.session_id.in_(session_ids))
                     .limit(1)) is not None


def prep_targets(db: Session, event_ids: list[int]) -> list[int]:
    """The events whose prep report draws on these (they are among its past events), and these themselves when they
    have past events at their venue."""
    if not event_ids:
        return []
    from app.prep import plan as prep_plan

    infos = prep_plan.index(db)
    out = []
    for target in infos:
        past = prep_plan.past_events_here(infos, target)
        if past and (target.event.id in event_ids or any(p.event.id in event_ids for p in past)):
            out.append(target.event.id)
    return out


# ---------- the pieces ----------

def _quietly(fn, *args) -> None:
    """A page's answer, for its cache: a 404 or 422 is an answer too (no lap, no GPS)."""
    try:
        fn(*args)
    except HTTPException as e:
        if e.status_code not in (404, 422):
            raise


def _with_db(fn: Callable[[Session], object]) -> None:
    from app.db import SessionLocal

    with SessionLocal() as db:
        fn(db)


def _session(db: Session, sid: int) -> models.RunSession | None:
    return db.get(models.RunSession, sid)


def _analysis(sid: int) -> None:
    from app.routers import sessions
    _with_db(lambda db: _quietly(sessions.session_analysis, sid, None, None, db))


def _stint(sid: int) -> None:
    from app.routers import stint
    _with_db(lambda db: _quietly(stint.session_stint, sid, db))


def _map(sid: int) -> None:
    from app.routers import trackmap
    _with_db(lambda db: _quietly(trackmap.get_session_map, sid, None, db))


def _shape(sid: int) -> None:
    from app.routers import trackshape
    _with_db(lambda db: _quietly(trackshape.get_session_shape, sid, db))


def _event_map(eid: int) -> None:
    from app.routers import trackmap
    _with_db(lambda db: _quietly(trackmap.get_event_map, eid, db))


def _event_shape(eid: int) -> None:
    from app.routers import trackshape
    _with_db(lambda db: _quietly(trackshape.get_event_shape, eid, db))


def _grip(kind: str, id_: int) -> None:
    from app.routers import report_grip
    _with_db(lambda db: _quietly(report_grip.grip_report, *((id_, None) if kind == "session" else (None, id_)), db))


def _balance(kind: str, id_: int) -> None:
    from app.routers import balance
    _with_db(lambda db: _quietly(balance.balance_report, *((id_, None) if kind == "session" else (None, id_)), db))


def _event_stint(eid: int) -> None:
    from app.routers import stint

    def go(db: Session) -> None:
        if files := stint.event_files(db, eid):
            _quietly(stint.stint_view, db, files)
    _with_db(go)


def _tyre_prep(sid: int) -> None:
    from app.routers import tyreprep

    def go(db: Session) -> None:
        if (s := _session(db, sid)) is not None:
            tyreprep._reduce(db, s)
    _with_db(go)


def _track_grip(eid: int) -> None:
    from app.routers import track_grip

    def go(db: Session) -> None:
        sids = list(db.scalars(select(models.RunSession.id).where(models.RunSession.event_id == eid)))
        if not _tyre_data_pending(db, sids):  # else the tyre data job queues it again once it has them
            _quietly(track_grip.event_track_grip, db, eid, None)
    _with_db(go)


def _traces(sid: int) -> None:
    from app.routers import reports
    reports.prebuild_traces(sid)


def _report(kind: str, id_: int) -> None:
    from app.routers import reports
    reports.prebuild(kind, id_)


def _technique(kind: str, id_: int) -> None:
    from app.routers import technique
    technique.prebuild(kind, id_)


def _prep(eid: int) -> None:
    from app.db import SessionLocal
    from app.routers import prep

    with SessionLocal() as db:
        if _tyre_data_pending(db):  # the tyre data job queues it again once it has done them
            return
    prep.prebuild(eid)


def warm(session_ids: list[int]) -> None:
    """Other modules' warm-ups for these runs, last of their pieces."""
    # ===== Other per-session warm-ups go here. =====
    # Runs on the prebuild's thread as background work: each heavy.lock it takes waits for the requests and jobs
    # waiting for it.
    from app import lappacks  # here: it imports the routers, which import this module

    lappacks.warm_sessions(session_ids)  # the lap packs the lap and driver comparisons read instead of the logs
    for fn in list(_warmers):
        try:
            fn(session_ids)
        except Exception:
            log.exception("Prebuild warm-up %s of runs %s failed", getattr(fn, "__name__", fn), session_ids)


def register(fn: Callable[[list[int]], None]) -> Callable[[list[int]], None]:
    """Add a per-session warm-up: fn(session_ids) runs after the other pieces of an upload, and in the start-up pass."""
    if fn not in _warmers:
        _warmers.append(fn)
    return fn


RUN: dict[str, Callable] = {
    "traces": _traces, "report": _report, "analysis": _analysis, "stint": _stint, "map": _map, "shape": _shape,
    "event map": _event_map, "event shape": _event_shape, "technique": _technique, "track grip": _track_grip,
    "tyre prep": _tyre_prep, "prep": _prep, "grip": _grip, "balance": _balance, "event stint": _event_stint,
    "warm": lambda sids: warm(list(sids)),
}


# ---------- the queue ----------

def _put(priority: int, items: list[Piece]) -> None:
    global _worker
    with _lock:
        for p in items:
            if (priority, p) not in _queued:
                _queued.add((priority, p))
                _queue.put((priority, next(_order), p))
        if _worker is None or not _worker.is_alive():
            _worker = threading.Thread(target=_work, name="prebuild", daemon=True)
            _worker.start()


def _work() -> None:
    with heavy.background():
        while True:
            priority, _, piece = _queue.get()
            with _lock:
                _queued.discard((priority, piece))
            try:
                heavy.lock.wait_for_others()  # a request or job waiting for the heavy-work lock goes first
                run(piece)
            except Exception:
                log.exception("Prebuild %s failed", piece)
            finally:
                _queue.task_done()


def run(piece: Piece) -> None:
    what, args = piece
    _state["current"] = f"{what} {args}"
    t0 = time.monotonic()
    try:
        RUN[what](*args)
    finally:
        took = time.monotonic() - t0
        _state["current"] = None
        _state["done"] += 1
        if took >= 0.2:  # did some work: a piece found up to date takes milliseconds
            _state["worked"] += 1
            _state["recent"] = [*_state["recent"][-(RECENT - 1):], {"piece": f"{what} {args}", "s": round(took, 2)}]
            log.info("Prebuild: %s %s in %.1f s", what, args, took)


def wait_idle(timeout: float = 300) -> bool:
    """Until every piece queued is done (for tests). True when nothing is left."""
    deadline = time.monotonic() + timeout
    while _queue.unfinished_tasks and time.monotonic() < deadline:
        time.sleep(0.05)
    return not _queue.unfinished_tasks


@router.get("")
def prebuild_status():
    """What the prebuild is doing: the piece in hand, how many are queued, and the last pieces that did work."""
    return {"enabled": enabled(), "current": _state["current"], "queued": _queue.unfinished_tasks,
            "done": _state["done"], "worked": _state["worked"], "recent": _state["recent"][::-1]}


# ---------- on start-up ----------

def start() -> None:
    """On server start: look for anything missing or out of date, at the lowest priority, in the background."""
    if not enabled():
        return
    threading.Thread(target=_start_pass, name="prebuild-start", daemon=True).start()


def _settled() -> bool:
    """The start-up checks are done: logs timed from an older line re-timed, runs with no laps removed (both change
    what the pages show)."""
    from app import empty_runs, timing

    thread = getattr(empty_runs, "_thread", None)
    return not timing._queue.unfinished_tasks and not (thread is not None and thread.is_alive())


def _start_pass() -> None:
    time.sleep(START_DELAY_S)
    deadline = time.monotonic() + SETTLE_WAIT_S
    while not _settled() and time.monotonic() < deadline:
        time.sleep(2)
    try:
        from app.db import SessionLocal

        with SessionLocal() as db:
            _put(START, everything(db))
    except Exception:
        log.exception("Prebuild: the start-up pass couldn't look for work")


def everything(db: Session) -> list[Piece]:
    """Every event's pieces (newest first), then the runs in no event, then every prep report."""
    from app.prep import plan as prep_plan

    events = db.execute(select(models.Event.id, models.Event.date)).all()
    out: list[Piece] = []
    for eid, _ in sorted(events, key=lambda e: (e.date is not None, e.date, e.id), reverse=True):
        sids = db.scalars(select(models.RunSession.id).where(models.RunSession.event_id == eid)
                          .order_by(models.RunSession.id)).all()
        if sids:
            out += pieces(db, list(sids), prep=False)
    loose = db.scalars(select(models.RunSession.id).where(models.RunSession.event_id.is_(None))
                       .order_by(models.RunSession.id.desc())).all()
    if loose:
        out += pieces(db, list(loose), prep=False)
    out += [("prep", (eid,)) for eid in prep_plan.availability(db)]
    return out
