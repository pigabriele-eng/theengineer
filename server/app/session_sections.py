"""Every lap of the latest session, section by section, against the session's fastest lap (Gabriele, 2026-10-08: the
During tab "should open on: full comparison of the session uploaded latest with traces; full comparison should flag
laps that have better sections").

GET /events/{id}/latest-session/sections: the official session (FP1, Q1, R1..., as run_parts groups the runs; a log
folder's name such as "05_R2" when the runs aren't named after the timetable) that holds the most recently uploaded
timed run, with every clean lap of it by stint (run) in the order they ran, and each lap's time in each section of the
lap comparison. The app puts each lap against the fastest one and flags the sections where it was quicker.

The latest upload: a run's upload is the import it came in (every run of one zip counts as uploaded at once), else
the time its log was stored; of the runs uploaded last, the one driven last. Out-laps, in-laps and laps off the pace
are not clean and are left out (counted in "left_out"). Real laps only: never a theoretical or ideal lap.

The section times come from the lap comparison itself (analysis/lapcompare.py compare_picks, as POST /compare/laps
works them out), which takes at most six laps: the laps go in chunks of five, each with the session's fastest lap
first, so every chunk is placed on the same line (the fastest lap's) and cut into the same sections. A chunk whose
sections don't match the first one's (codes and bounds) is left out, its laps without section times. The laps are
traced from the runs' lap packs (lappacks.py, no log read); a run without a pack is read from its log under
heavy.lock, as the comparison always does.

It is worked out in a thread of its own while the app asks again ("status": "working", the laps already listed), then
kept in page_cache under a signature of the session's runs and laps, so the next visit answers at once. After an upload
the prebuild works it out for an event that is on now or just finished (warm()).
"""
from __future__ import annotations

import copy
import logging
import threading
import time
from datetime import date, datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from app import db as app_db  # SessionLocal is looked up when used: the tests swap the database
from app import heavy, lappacks, models, page_cache, prebuild, run_labels, run_parts
from app.analysis.lapcompare import MAX_LAPS, Pick, compare_picks
from app.analysis.laps import SessionData, load_session
from app.db import get_db
from app.routers.lapcompare import _track, _tracks_by_name
from app.routers.sessions import _channel_map, official_corners
from app.timing import read_file, track_line

router = APIRouter()
log = logging.getLogger(__name__)

VERSION = 1  # raise when what is answered changes, so every kept answer is worked out again
CHUNK = MAX_LAPS - 1  # laps per comparison beside the session's fastest
STEP_M = 50.0  # the comparison's traces aren't used here: as few points as it takes
RECENT_DAYS = 3  # the prebuild works it out for events whose newest run is this recent


# ---------- the session ----------

def _main_file(s: models.RunSession) -> models.LoggerFile | None:
    return page_cache.main_file(s)


def _laps(s: models.RunSession) -> list[models.Lap]:
    """The laps of the run's main log, in order."""
    f = _main_file(s)
    return sorted((l for l in s.laps if f is not None and l.file_id == f.id), key=lambda l: l.number)


def _timed(s: models.RunSession) -> bool:
    return any(l.clean for l in _laps(s))


def _sessions(db: Session, event_id: int) -> list[models.RunSession]:
    return list(db.scalars(select(models.RunSession).where(models.RunSession.event_id == event_id).options(
        selectinload(models.RunSession.laps), selectinload(models.RunSession.files),
        selectinload(models.RunSession.driver)).order_by(models.RunSession.id)).all())


def upload_times(db: Session, sessions: list[models.RunSession]) -> dict[int, datetime]:
    """When each run was uploaded: the time the import it came in started (every run of one zip at once), else the
    time its log was stored (its import's start when it was stored while an import ran)."""
    ids = {s.id for s in sessions}
    jobs = [j for j in db.execute(select(models.ImportJob.id, models.ImportJob.created_at,
                                         models.ImportJob.finished_at, models.ImportJob.session_ids)).all()
            if j.created_at is not None]
    came_in: dict[int, datetime] = {}
    for j in sorted(jobs, key=lambda j: j.id):  # the latest import a run came in wins
        for sid in j.session_ids or []:
            if sid in ids:
                came_in[sid] = j.created_at
    out = {}
    for s in sessions:
        if s.id in came_in:
            out[s.id] = came_in[s.id]
            continue
        f = _main_file(s)
        at = f.uploaded_at if f is not None else s.created_at
        during = [j for j in jobs if j.created_at <= at and (j.finished_at is None or at <= j.finished_at)]
        out[s.id] = max(during, key=lambda j: j.id).created_at if during else at
    return out


def latest_part(db: Session, sessions: list[models.RunSession]
                ) -> tuple[run_parts.Part | None, list[run_labels.RunLabel]]:
    """The official session holding the most recently uploaded timed run (of the runs uploaded last, the one driven
    last), and the event's runs' labels; None without a timed run."""
    labels = run_labels.label_runs(sessions)
    timed = [s for s in sessions if _timed(s)]
    if not timed:
        return None, labels
    when = upload_times(db, timed)
    order = {lab.id: k for k, lab in enumerate(labels)}
    latest = max(timed, key=lambda s: (when[s.id], order.get(s.id, -1)))
    part = next((p for p in run_parts.parts(sessions, labels) if latest.id in p.ids), None)
    return part, labels


def _signature(db: Session, event_id: int, part: run_parts.Part, by_id: dict[int, models.RunSession]) -> str:
    """Everything the answer is made from: the session, its runs' labels, logs, laps, drivers and car, and the
    track's start/finish line and corners (page_cache.sessions_part)."""
    mine = [by_id[lab.id] for lab in part.runs]
    return page_cache.digest(["latest-session-sections", VERSION, event_id, part.code, part.title,
                              [(lab.id, lab.name, lab.short) for lab in part.runs],
                              page_cache.sessions_part(db, mine)])


def _scope(event_id: int) -> str:
    return f"event:{event_id}|latest-session-sections"  # "event:<id>|...": deleted with the event


def base(event_id: int, part: run_parts.Part, by_id: dict[int, models.RunSession]) -> dict:
    """The answer without the section times: the session, its clean laps by stint in the order they ran, how many
    laps aren't clean, and its fastest lap (the first set on a tie)."""
    runs, left_out = [], 0
    for lab in part.runs:
        s = by_id[lab.id]
        laps = _laps(s)
        clean = [l for l in laps if l.clean]
        left_out += len(laps) - len(clean)
        if clean:
            runs.append({"id": s.id, "name": lab.name, "short": lab.short,
                         "driver": s.driver.name if s.driver else None, "driver_id": s.driver_id,
                         "laps": [{"number": l.number, "time": round(l.time_s, 3), "sections": None} for l in clean]})
    every = [(r["id"], l) for r in runs for l in r["laps"]]
    best = min(every, key=lambda x: x[1]["time"]) if every else None
    return {"event_id": event_id, "status": "working", "session": {"code": part.code, "title": part.title},
            "runs": runs, "left_out": left_out,
            "fastest": {"session_id": best[0], "lap": best[1]["number"], "time": best[1]["time"]} if best else None,
            "sections": None, "numbering": None, "progress": None, "note": None}


def _empty(event_id: int) -> dict:
    return {"event_id": event_id, "status": "empty", "session": None, "runs": [], "left_out": 0, "fastest": None,
            "sections": None, "numbering": None, "progress": None, "note": None}


# ---------- the section times ----------

def chunks(laps: list[tuple[int, int]], fastest: tuple[int, int], size: int = CHUNK) -> list[list[tuple[int, int]]]:
    """The laps compared together: each chunk the fastest lap first, then up to `size` others in the order they ran."""
    others = [x for x in laps if x != fastest]
    return [[fastest, *others[i:i + size]] for i in range(0, len(others), size)]


def layout(result: dict) -> list[tuple]:
    """A comparison's sections as they must match from one chunk to the next: codes, bounds and corners."""
    return [(s["code"], s["start_m"], s["end_m"], tuple(s.get("corners") or ())) for s in result["sections"]]


def work_out(db: Session, answer: dict, progress: dict | None = None) -> dict:
    """The section times of every lap of the answer (base()), filled in place, one comparison of up to six laps at a
    time; then the answer is ready. progress, when given, counts the chunks done."""
    laps = [(r["id"], l["number"]) for r in answer["runs"] for l in r["laps"]]
    if len(laps) < 2:
        answer["status"] = "ready"
        if laps:
            answer["note"] = "One clean lap: nothing to put against it yet."
        return answer
    fastest = (answer["fastest"]["session_id"], answer["fastest"]["lap"])
    sessions = {sid: db.get(models.RunSession, sid) for sid in dict.fromkeys(sid for sid, _ in laps)}
    time_of = {(r["id"], l["number"]): l["time"] for r in answer["runs"] for l in r["laps"]}
    by_name = _tracks_by_name(db)
    track = _track(sessions[fastest[0]], by_name)[2]
    corners = official_corners(track)
    read: list[models.RunSession] = []

    def load(run: str) -> SessionData:
        s = sessions[int(run)]
        f = _main_file(s)
        read.append(s)
        # timed with the same start/finish line as when its laps were stored, so lap numbers match
        return load_session(read_file(f), _channel_map(s), beacons=f.meta.get("beacons"), line=track_line(track))

    def packed_for(numbers_of: dict[str, list[int]]):
        def packed(run: str):
            s, numbers = sessions[int(run)], numbers_of[run]
            got = lappacks.packed_run(db, s, track, numbers)
            if got is None and lappacks.traces_ready(db, s, track):
                lappacks.ensure_pack(db, s.id)  # as the lap comparison does: made now, kept for next time
                got = lappacks.packed_run(db, s, track, numbers)
            return got
        return packed

    plan = chunks(laps, fastest)
    if progress is not None:
        progress.update(done=0, total=len(plan))
    times: dict[tuple[int, int], list[float]] = {}
    first = None
    try:
        for chunk in plan:
            if heavy.in_background():
                heavy.lock.wait_for_others()  # the pages' requests first
            picks = [Pick(str(sid), n, time_of[(sid, n)], {"session_id": sid}) for sid, n in chunk]
            numbers_of: dict[str, list[int]] = {}
            for p in picks:
                numbers_of.setdefault(p.run, []).append(p.number)
            try:
                res = compare_picks(picks, load, corners, STEP_M, guard=heavy.lock, packed=packed_for(numbers_of))
            except Exception:  # a lap not in its log (timed again since), a log gone: these laps go without
                log.exception("Latest session of event %s: laps %s not compared", answer["event_id"], chunk)
                res = None
            if res is not None and res["reference"] != 0:
                log.warning("Latest session of event %s: %s is quicker than the fastest lap %s", answer["event_id"],
                            chunk[res["reference"]], fastest)
            elif res is not None:
                if first is None:
                    first = layout(res)
                    answer["sections"] = [{k: s[k] for k in ("code", "start_m", "end_m", "apex_m", "corners")}
                                          for s in res["sections"]]
                    answer["numbering"] = res["numbering"]
                if layout(res) == first:
                    for i, x in enumerate(chunk):
                        times[x] = [s["times"][i] for s in res["sections"]]
                else:
                    log.warning("Latest session of event %s: laps %s were cut into other sections",
                                answer["event_id"], chunk)
            if progress is not None:
                progress["done"] += 1
    finally:
        if read:
            heavy.release_memory()
    if read:
        lappacks.missed(db, read)
    for r in answer["runs"]:
        for lap in r["laps"]:
            lap["sections"] = times.get((r["id"], lap["number"]))
    answer["status"] = "ready"
    if first is None:
        answer["note"] = "The laps couldn't be placed on one line, so their sections can't be compared."
    elif any(lap["sections"] is None for r in answer["runs"] for lap in r["laps"]):
        answer["note"] = "Some laps couldn't be placed on the fastest lap's line: they show without sections."
    return answer


# ---------- the answer ----------

_lock = threading.Lock()
_working: dict[str, dict] = {}  # scope -> {"sig", "progress", "thread"}


def _finish(db: Session, scope: str, sig: str, answer: dict, progress: dict | None = None) -> dict:
    out = work_out(db, answer, progress)
    out["progress"] = None
    page_cache.store(db, scope, sig, out)
    return out


def _job(scope: str, sig: str, answer: dict, progress: dict) -> None:
    try:
        with heavy.background(), app_db.SessionLocal() as db:  # requests waiting for the lock go first
            _finish(db, scope, sig, answer, progress)
    except Exception:
        log.exception("Latest session sections (%s) failed", scope)
    finally:
        with _lock:
            job = _working.get(scope)
            if job is not None and job["thread"] is threading.current_thread():
                del _working[scope]


@router.get("/events/{event_id}/latest-session/sections")
def latest_session_sections(event_id: int, db: Session = Depends(get_db)):
    """The latest session's clean laps by stint, each with its time in each section of the lap comparison (in
    "sections" order; null while worked out, or when it couldn't be placed on the fastest lap's line). "status":
    "working" while the section times are worked out (the laps listed already; ask again), "ready" once they are,
    "empty" when the event has no timed run."""
    if db.get(models.Event, event_id) is None:
        raise HTTPException(404, "Event not found")
    sessions = _sessions(db, event_id)
    part, _ = latest_part(db, sessions)
    if part is None:
        return _empty(event_id)
    by_id = {s.id: s for s in sessions}
    sig = _signature(db, event_id, part, by_id)
    scope = _scope(event_id)
    hit = page_cache.lookup(db, scope, sig)
    if hit is not None and hit[0] == 200:
        return hit[1]
    answer = base(event_id, part, by_id)
    with _lock:
        job = _working.get(scope)
        if job is None or not job["thread"].is_alive():  # (one at a time: after one for older laps, the next ask)
            progress = {"done": 0, "total": 0}
            thread = threading.Thread(target=_job, args=(scope, sig, copy.deepcopy(answer), progress),
                                      name="latest-session-sections", daemon=True)
            job = _working[scope] = {"sig": sig, "progress": progress, "thread": thread}
            thread.start()
        answer["progress"] = dict(job["progress"]) if job["sig"] == sig else {"done": 0, "total": 0}
    return answer


def wait_idle(timeout: float = 120) -> bool:
    """Wait until nothing is being worked out here (for tests). True when nothing is."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        with _lock:
            threads = [j["thread"] for j in _working.values()]
        if not any(t.is_alive() for t in threads):
            return True
        time.sleep(0.05)
    return False


# ---------- after an upload ----------

@prebuild.register
def warm(session_ids: list[int]) -> None:
    """The prebuild's warm-up: the latest session's section times of these runs' events that are on now or just
    finished (an older event's are worked out when its page asks), here, on the prebuild's thread."""
    with app_db.SessionLocal() as db:
        events = set(db.scalars(select(models.RunSession.event_id).where(
            models.RunSession.id.in_(session_ids), models.RunSession.event_id.is_not(None))).all())
        since = (date.today() - timedelta(days=RECENT_DAYS)).isoformat()
        for event_id in sorted(events):
            sessions = _sessions(db, event_id)
            part, labels = latest_part(db, sessions)
            days = [lab.date for lab in labels if lab.date]
            if part is None or not days or max(days) < since:
                continue
            by_id = {s.id: s for s in sessions}
            sig, scope = _signature(db, event_id, part, by_id), _scope(event_id)
            if page_cache.fresh(db, scope, sig):
                continue
            with _lock:  # the page asked first: its thread works it out
                job = _working.get(scope)
                if job is not None and job["thread"].is_alive() and job["sig"] == sig:
                    continue
                me = _working[scope] = {"sig": sig, "progress": {"done": 0, "total": 0},
                                        "thread": threading.current_thread()}
            try:
                _finish(db, scope, sig, base(event_id, part, by_id), me["progress"])
            finally:
                with _lock:
                    if _working.get(scope) is me:
                        del _working[scope]
