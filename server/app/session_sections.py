"""Every lap of the latest session, section by section, against the session's fastest lap (Gabriele, 2026-10-08: the
During tab "should open on: full comparison of the session uploaded latest with traces; full comparison should flag
laps that have better sections").

GET /events/{id}/latest-session/sections: the official session (FP1, Q1, R1..., as run_parts groups the runs; a log
folder's name such as "05_R2" when the runs aren't named after the timetable) that holds the most recently uploaded
timed run, with every clean lap of it by stint (run) in the order they ran, and each lap's time in each section of the
lap comparison. The app puts each lap against the fastest one and flags the sections where it was quicker. A day's
qualifying sessions are one session here ("Q1 + Q2", run_parts.blocks): each driver has a qualifying of their own,
and the two are compared with each other.

Another session instead, and stints of other sessions mixed in (Gabriele, 2026-10-08: "quickly select other sessions or
runs to compare. Standard it should open the latest session but should be possible to tap the session and change it"):
?part=<code> and ?add=<run ids>. Every answer lists the event's sessions to pick from ("sessions", in the order they
ran, each with its stints) and which one is the latest.

The latest upload: a run's upload is the import it came in (every run of one zip counts as uploaded at once), else
the time its log was stored; of the runs uploaded last, the one driven last. Real laps only: never a theoretical or
ideal lap.

Every lap driven, not only the clean ones (Gabriele, 2026-10-09, of a qualifying run: "one slow build lap, first push,
second push, third push that turns into pit in"; "it should also pick sectors from the other laps and indicate if
there are faster sectors in all driven laps, including outlaps and inlaps"): a lap that isn't clean is listed with what
it is (lap_kinds: the out-lap, a build lap, the in-lap, a slow lap) and its section times like any other, so a quicker
section on it is flagged too. The fastest lap is still the fastest clean one. A lap that isn't clean and is quicker
than it is only part of a lap (a crossing of the line in the pit lane) and is left out ("left_out"); a section of a
lap that isn't clean timed under MIN_SHARE of the fastest lap's there is a stretch it didn't drive on the line, and
goes without a time.

The section times come from the lap comparison itself (analysis/lapcompare.py compare_picks, as POST /compare/laps
works them out), which takes at most six laps: the laps go in chunks of five, each with the session's fastest lap
first, so every chunk is placed on the same line (the fastest lap's) and cut into the same sections. The clean laps
first, traced from the runs' lap packs (lappacks.py, no log read); then the others, a run at a time: a pack holds only
clean laps, so their run is read from its log under heavy.lock, as the comparison always does. The fastest lap traced
from its log can put a section's ends a metre from where its pack does: a chunk's times go by section code. A chunk
the comparison can't make is tried again a lap at a time, so one lap it can't place doesn't take the others' times.

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

from fastapi import APIRouter, Depends, HTTPException, Query
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

VERSION = 2  # raise when what is answered changes, so every kept answer is worked out again
CHUNK = MAX_LAPS - 1  # laps per comparison beside the session's fastest
STEP_M = 50.0  # the comparison's traces aren't used here: as few points as it takes
RECENT_DAYS = 3  # the prebuild works it out for events whose newest run is this recent
MIN_SHARE = 0.9  # a lap that isn't clean: a section timed under this share of the fastest lap's there isn't timed


# ---------- the session ----------

def _main_file(s: models.RunSession) -> models.LoggerFile | None:
    return page_cache.main_file(s)


def _laps(s: models.RunSession) -> list[models.Lap]:
    """The laps of the run's main log, in order."""
    f = _main_file(s)
    return sorted((l for l in s.laps if f is not None and l.file_id == f.id), key=lambda l: l.number)


def _timed(s: models.RunSession) -> bool:
    return any(l.clean for l in _laps(s))


def lap_kinds(laps: list[models.Lap]) -> dict[int, str | None]:
    """What each lap of a run (in order) is when it isn't clean: its first lap the out-lap, the others before its
    first clean lap build laps, its last lap after its last clean one the in-lap, any other a slow lap. None for a
    clean lap."""
    clean = [i for i, l in enumerate(laps) if l.clean]
    first, last = (clean[0], clean[-1]) if clean else (len(laps), -1)
    out: dict[int, str | None] = {}
    for i, l in enumerate(laps):
        if l.clean:
            out[l.number] = None
        elif i == 0:
            out[l.number] = "out"
        elif i < first:
            out[l.number] = "build"
        elif i == len(laps) - 1 and i > last:
            out[l.number] = "in"
        else:
            out[l.number] = "slow"
    return out


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
    part = next((p for p in run_parts.blocks(run_parts.parts(sessions, labels)) if latest.id in p.ids), None)
    return part, labels


def _signature(db: Session, event_id: int, part: run_parts.Part, by_id: dict[int, models.RunSession]) -> str:
    """Everything the answer is made from: the session, its runs' labels, logs, laps, drivers and car, and the
    track's start/finish line and corners (page_cache.sessions_part)."""
    mine = [by_id[lab.id] for lab in part.runs]
    return page_cache.digest(["latest-session-sections", VERSION, event_id, part.code, part.title,
                              [(lab.id, lab.name, lab.short) for lab in part.runs],
                              page_cache.sessions_part(db, mine)])


def _scope(event_id: int, picked: str | None = None, add: tuple[int, ...] = ()) -> str:
    """Where the answer is kept ("event:<id>|...": deleted with the event): the latest session's in one place, another
    session's or a mix's in its own."""
    if picked is None and not add:
        return f"event:{event_id}|latest-session-sections"
    return f"event:{event_id}|session-sections|{picked or ''}|{','.join(map(str, add))}"


def timed_parts(sessions: list[models.RunSession], labels: list[run_labels.RunLabel]) -> list[run_parts.Part]:
    """The event's sessions with a timed run, in the order they ran, each with its timed runs only (a day's
    qualifying sessions as one: run_parts.blocks)."""
    by_id = {s.id: s for s in sessions}
    out = []
    for p in run_parts.blocks(run_parts.parts(sessions, labels)):
        runs = [lab for lab in p.runs if lab.id in by_id and _timed(by_id[lab.id])]
        if runs:
            out.append(run_parts.Part(p.code, p.title, p.official, runs))
    return out


def choices(parts: list[run_parts.Part], by_id: dict[int, models.RunSession]) -> list[dict]:
    """The sessions to pick from, in the order they ran: each with its clean laps, its drivers and its stints."""
    out = []
    for p in parts:
        runs = []
        for lab in p.runs:
            s = by_id[lab.id]
            runs.append({"id": s.id, "name": lab.name, "short": lab.short,
                         "driver": s.driver.name if s.driver else None,
                         "laps": sum(1 for l in _laps(s) if l.clean)})
        drivers = list(dict.fromkeys(r["driver"] for r in runs if r["driver"]))
        out.append({"code": p.code, "title": p.title, "laps": sum(r["laps"] for r in runs), "drivers": drivers,
                    "runs": runs})
    return out


def mixed(part: run_parts.Part, parts: list[run_parts.Part], add: list[int]) -> tuple[run_parts.Part, list[int]]:
    """The session with the stints of other sessions added after its own, in the order they ran; the ids added (runs
    of the session itself or without a timed lap left out)."""
    own, wanted = set(part.ids), set(add)
    extra = [lab for p in parts for lab in p.runs if lab.id in wanted and lab.id not in own]
    return run_parts.Part(part.code, part.title, part.official, [*part.runs, *extra]), [lab.id for lab in extra]


def base(event_id: int, part: run_parts.Part, by_id: dict[int, models.RunSession],
         session_of: dict[int, str] | None = None) -> dict:
    """The answer without the section times: the session, every lap of its stints with a clean lap, by stint in the
    order they ran (each with whether it is clean and, when not, what it is: lap_kinds), how many laps are left out
    (part laps, quicker than the fastest; the laps of stints without a clean lap), and its fastest lap (the quickest
    clean one, the first set on a tie). session_of: each run's session ("FP1"), for the stints of other sessions mixed
    in."""
    timed = [(lab, _laps(by_id[lab.id])) for lab in part.runs]
    quickest = min((l.time_s for _, laps in timed for l in laps if l.clean), default=None)
    runs, left_out = [], 0
    for lab, laps in timed:
        s = by_id[lab.id]
        kinds = lap_kinds(laps)
        kept = [l for l in laps if l.clean or (quickest is not None and l.time_s >= quickest)]
        if not any(l.clean for l in kept):
            kept = []
        left_out += len(laps) - len(kept)
        if kept:
            runs.append({"id": s.id, "name": lab.name, "short": lab.short,
                         "driver": s.driver.name if s.driver else None, "driver_id": s.driver_id,
                         "session": (session_of or {}).get(s.id, part.title),
                         "laps": [{"number": l.number, "time": round(l.time_s, 3), "clean": l.clean,
                                   "kind": kinds[l.number], "sections": None} for l in kept]})
    every = [(r["id"], l) for r in runs for l in r["laps"] if l["clean"]]
    best = min(every, key=lambda x: x[1]["time"]) if every else None
    return {"event_id": event_id, "status": "working", "session": {"code": part.code, "title": part.title},
            "runs": runs, "left_out": left_out,
            "fastest": {"session_id": best[0], "lap": best[1]["number"], "time": best[1]["time"]} if best else None,
            "sections": None, "numbering": None, "progress": None, "note": None}


def _empty(event_id: int) -> dict:
    return {"event_id": event_id, "status": "empty", "session": None, "runs": [], "left_out": 0, "fastest": None,
            "sections": None, "numbering": None, "progress": None, "note": None, "added": [], "latest": None,
            "sessions": []}


# ---------- the section times ----------

def chunks(laps: list[tuple[int, int]], fastest: tuple[int, int], size: int = CHUNK) -> list[list[tuple[int, int]]]:
    """The laps compared together: each chunk the fastest lap first, then up to `size` others in the order they ran."""
    others = [x for x in laps if x != fastest]
    return [[fastest, *others[i:i + size]] for i in range(0, len(others), size)]


def plan_chunks(answer: dict) -> list[list[tuple[int, int]]]:
    """The comparisons to make: the clean laps' chunks first (their runs' packs hold them: no log read), then each
    run's other laps in chunks of their own (their run's log is read once a chunk)."""
    fastest = (answer["fastest"]["session_id"], answer["fastest"]["lap"])
    clean = [(r["id"], l["number"]) for r in answer["runs"] for l in r["laps"] if l["clean"]]
    plan = chunks(clean, fastest)
    for r in answer["runs"]:
        plan += chunks([fastest, *[(r["id"], l["number"]) for l in r["laps"] if not l["clean"]]], fastest)
    return plan


def by_code(codes: list[str], result: dict, lap: int) -> list[float | None]:
    """A lap's time in each of `codes` (the first comparison's sections), from a comparison it was in (its place
    `lap`): by section code, None for a code that comparison doesn't have."""
    mine = {s["code"]: s["times"][lap] for s in result["sections"]}
    return [mine.get(c) for c in codes]


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
    dirty = {(r["id"], l["number"]) for r in answer["runs"] for l in r["laps"] if not l["clean"]}
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

    plan = plan_chunks(answer)
    if progress is not None:
        progress.update(done=0, total=len(plan))
    times: dict[tuple[int, int], list[float | None]] = {}
    codes: list[str] | None = None
    try:
        while plan:
            chunk = plan.pop(0)
            if heavy.in_background():
                heavy.lock.wait_for_others()  # the pages' requests first
            picks = [Pick(str(sid), n, time_of[(sid, n)], {"session_id": sid}) for sid, n in chunk]
            numbers_of: dict[str, list[int]] = {}
            for p in picks:
                numbers_of.setdefault(p.run, []).append(p.number)
            try:
                res = compare_picks(picks, load, corners, STEP_M, guard=heavy.lock, packed=packed_for(numbers_of))
            except Exception:  # a lap not in its log (timed again since), a log gone, a lap it can't place
                log.exception("Latest session of event %s: laps %s not compared", answer["event_id"], chunk)
                res = None
                if len(chunk) > 2:  # a lap at a time: the one it can't place goes without, not the others
                    plan[:0] = [[fastest, x] for x in chunk[1:]]
                    if progress is not None:
                        progress["total"] += len(chunk) - 1
            if res is not None and res["reference"] != 0:
                log.warning("Latest session of event %s: %s is quicker than the fastest lap %s", answer["event_id"],
                            chunk[res["reference"]], fastest)
            elif res is not None:
                if codes is None:
                    codes = [s["code"] for s in res["sections"]]
                    answer["sections"] = [{k: s[k] for k in ("code", "start_m", "end_m", "apex_m", "corners")}
                                          for s in res["sections"]]
                    answer["numbering"] = res["numbering"]
                    times[fastest] = by_code(codes, res, 0)
                for i, x in enumerate(chunk[1:], 1):
                    mine = by_code(codes, res, i)
                    if x in dirty:  # quicker than the fastest lap by that much: a stretch it didn't drive
                        mine = [t if t is None or f is None or t >= f * MIN_SHARE else None
                                for t, f in zip(mine, times[fastest], strict=True)]
                    times[x] = mine
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
    if codes is None:
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
def latest_session_sections(event_id: int, part: str | None = None,
                            add: str | None = Query(None, description="runs of other sessions to mix in, e.g. 3,12"),
                            db: Session = Depends(get_db)):
    """The latest session's laps by stint, out-laps and in-laps included (?part=<code>: that session's instead; ?add=:
    with these runs of other sessions after its own), each with whether it is clean, what it is when not ("out",
    "build", "in", "slow") and its time in each section of the lap comparison (in "sections" order; null while worked
    out, or when it couldn't be placed on the fastest lap's line; a section null when it wasn't driven on the line).
    "status": "working" while the section times are worked out (the laps listed already; ask again), "ready" once they
    are, "empty" when the event has no timed run. "sessions": the event's sessions to pick from, in the order they ran;
    "latest": the latest one's code; "added": the runs mixed in."""
    if db.get(models.Event, event_id) is None:
        raise HTTPException(404, "Event not found")
    try:
        wanted = sorted({int(x) for x in (add or "").split(",") if x.strip()})
    except ValueError:
        raise HTTPException(422, "add: run ids separated by commas, e.g. 3,12") from None
    sessions = _sessions(db, event_id)
    latest, labels = latest_part(db, sessions)
    if latest is None:
        return _empty(event_id)
    by_id = {s.id: s for s in sessions}
    parts = timed_parts(sessions, labels)
    if part is None or part == latest.code:
        chosen = next((p for p in parts if p.code == latest.code), latest)
    else:
        chosen = run_parts.find_block(parts, part)
        if chosen is None:
            raise HTTPException(404, f"No session {part} with a timed run in this event")
    if not wanted and chosen.code == latest.code:
        picked, added, scope = latest, [], _scope(event_id)
    else:
        picked, added = mixed(chosen, parts, wanted)
        scope = _scope(event_id, chosen.code, tuple(added))
    extra = {"added": added, "latest": latest.code, "sessions": choices(parts, by_id)}
    sig = _signature(db, event_id, picked, by_id)
    hit = page_cache.lookup(db, scope, sig)
    if hit is not None and hit[0] == 200:
        return {**hit[1], **extra}
    session_of = {lab.id: p.title for p in run_parts.parts(sessions, labels) for lab in p.runs}  # its own: "Q2"
    answer = {**base(event_id, picked, by_id, session_of), **extra}
    with _lock:
        job = _working.get(scope)
        if job is None or not job["thread"].is_alive():  # (one at a time: after one for older laps, the next ask)
            progress = {"done": 0, "total": 0}
            kept = {k: v for k, v in answer.items() if k not in extra}  # the pickers are read afresh each time
            thread = threading.Thread(target=_job, args=(scope, sig, copy.deepcopy(kept), progress),
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
