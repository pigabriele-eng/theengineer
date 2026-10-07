"""Laps to compare first, for the night before a race (Gabriele, 2026-10-07: "Compare laps, during the weekend, should
be the standard function that opens when clicking on the event ... the app can suggest which laps to compare or corners
to compare? ... imagine a scenario, driver in the evening in the hotel going through data from FP or Quali before the
race on the next day").

GET /events/{id}/compare/suggestions: up to five pairs of real laps of the event, like with like on tyres, the most
useful first:
  a. teammates head to head on the same tyres: the drivers' best new-tyre (qualifying) laps, then their best used-tyre
     laps;
  b. each driver's progress: their best lap of the latest session against their best of the session before it on the
     same tyres;
  c. each driver's best used-tyre lap against their typical lap of the same stint (the clean lap nearest the stint's
     median), for consistency.
Each pair comes with the corners where most of the gap is: the sections of the lap comparison (POST /compare/laps,
routers/lapcompare.py) where the slower lap loses the most, on the track's official corner numbers.

Tyres (Gabriele, firm): qualifying is on new tyres and low fuel, the races on the qualifying set (used), everything
else on used tyres unless known otherwise: a run's tyres are the ones run_tyres.py gives every page (the driver's
where they set them, else its guess, said as one), and a used-tyre lap is never put against a new-tyre lap. A run's
session type comes from its kind, else from its session's name ("Q1", "03_Q", "R2", "FP1") or the session its log
names ("Q", "R1"), so a weekend imported from folders ("03_Q", "04_R1") still has its qualifying. Real laps only:
clean laps of the run's main log (out-laps, in-laps and laps off the pace are not clean), never a theoretical, ideal
or perfect lap. The drivers are the ones set on the runs (by a person, or by the app from the driving style); with
none set, the runs count as one driver and (a) is left out.

The pairs are picked from the database at once; their corners take one lap comparison each (from the lap packs, a log
read only where a run has none, under heavy.lock as the comparison always does). They are worked out in a thread of
their own while the app asks again ("status": "working", the corners known so far filled in), then kept in page_cache
under a signature of the event's runs, laps, drivers and track, so the next visit answers at once. The comparisons
themselves stay in the lap comparison's own memory, so opening a suggestion answers at once too. After an upload the
prebuild works them out for an event that is on now or just finished (warm()).
"""
from __future__ import annotations

import logging
import re
import statistics
import threading
import time
from dataclasses import dataclass, field
from datetime import date, timedelta

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from app import db as app_db  # SessionLocal is looked up when used: the tests swap the database
from app import heavy, models, page_cache, prebuild, run_labels, run_parts, run_tyres
from app.db import get_db
from app.routers import lapcompare

router = APIRouter()
log = logging.getLogger(__name__)

VERSION = 1  # raise when what is suggested changes, so every kept answer is worked out again
LIMIT = 5  # suggestions at most
PER_TYRES = 2  # teammates' pairs on one tyre state at most (the quickest driver against the next two)
CORNERS_SHOWN = 3
MIN_CORNER_S = 0.03  # a corner losing less than this isn't named (unless it is the only one)
MIN_STINT_LAPS = 4  # clean laps a stint needs for its typical lap to mean something
MIN_TYPICAL_GAP_S = 0.05  # a typical lap this close to the best: nothing to learn from the pair
RECENT_DAYS = 3  # the prebuild works the suggestions out for events whose newest run is this recent

ORDER_PREFIX = re.compile(r"^\d+[_\- ]+")  # "03_Q" -> "Q"
QUALIFYING = re.compile(r"^(?:PQ|Q\d*|QUALI\w*|PRE-QUALI\w*)\b", re.I)
RACE = re.compile(r"^(?:R\d+|RACE)\b", re.I)
PRACTICE = re.compile(r"^(?:FP\d*|PT\d*|PTS\d*|P\d+|FREE PRACTICE|PRACTICE)\b", re.I)


# ---------- the runs, as the suggestions see them ----------

def session_type(kind: str, *names: str | None) -> str:
    """qualifying, race, practice or test: the run's kind when it is one of the first three, else what the names of its
    session say ("Q1", "03_Q", "R2", "FP1"; the import makes every run a test)."""
    if kind in ("qualifying", "race", "practice"):
        return kind
    for name in names:
        text = ORDER_PREFIX.sub("", (name or "").strip())
        if QUALIFYING.match(text):
            return "qualifying"
        if RACE.match(text):
            return "race"
        if PRACTICE.match(text):
            return "practice"
    return "test"


@dataclass
class Run:
    """One run of the event, in the event page's order."""
    id: int
    name: str  # as the event page shows it ("FP1 stint 1", "Q1", "03_Q (2)")
    session: str  # the official session it ran in (run_parts: "FP1", "Q1", "R1", or its log folder's name)
    kind: str  # qualifying, race, practice, test (session_type)
    tyres: str  # new, used (run_tyres)
    driver_id: int | None
    driver: str | None
    laps: list[tuple[int, float]] = field(default_factory=list)  # its clean laps: (number, time)
    tyres_sure: bool = True  # false: run_tyres' guess (a test or practice run nobody said the tyres of)


def _best(run: Run) -> tuple[int, float]:
    return min(run.laps, key=lambda x: (x[1], x[0]))


def _lap(run: Run, number: int, time_s: float, role: str = "best") -> dict:
    return {"session_id": run.id, "lap": number, "time": round(time_s, 3), "run": run.name, "session": run.session,
            "kind": run.kind, "tyres": run.tyres, "tyres_sure": run.tyres_sure, "driver": run.driver,
            "driver_id": run.driver_id, "role": role}


def _pair(kind: str, tyres: str, a: dict, b: dict, **extra) -> dict:
    slower = 0 if a["time"] > b["time"] else 1
    return {"kind": kind, "tyres": tyres, "laps": [a, b], "slower": slower,
            "gap_s": round(abs(a["time"] - b["time"]), 3), "corners": None, **extra}


# ---------- picking the pairs ----------

def _teammates(drivers: list[list[Run]]) -> list[dict]:
    """(a) The drivers' best laps against each other, new tyres first, then used: the quickest against the next."""
    out = []
    for tyres in ("new", "used"):
        bests = []
        for runs in drivers:
            mine = [r for r in runs if r.tyres == tyres and r.laps]
            if mine:
                r = min(mine, key=lambda r: _best(r)[1])
                bests.append((r, *_best(r)))
        bests.sort(key=lambda x: x[2])
        for other in bests[1:1 + PER_TYRES]:
            out.append(_pair("teammates", tyres, _lap(*bests[0]), _lap(*other)))
    return out


def _progress(runs: list[Run]) -> dict | None:
    """(b) One driver's best lap of their latest session against their best of the session before it on the same
    tyres; when the latest session has none such, the session before it, and so on."""
    best: dict[tuple[str, str], tuple[Run, int, float]] = {}
    for r in runs:  # in the order they ran: each (session, tyres) in the order it first ran
        if not r.laps:
            continue
        n, t = _best(r)
        key = (r.session, r.tyres)
        if key not in best or t < best[key][2]:
            best[key] = (r, n, t)
    keys = list(best)
    for i in range(len(keys) - 1, 0, -1):
        latest = keys[i]
        before = next((k for k in reversed(keys[:i]) if k[1] == latest[1] and k[0] != latest[0]), None)
        if before is not None:
            return _pair("progress", latest[1], _lap(*best[latest]), _lap(*best[before]))
    return None


def _consistency(runs: list[Run]) -> dict | None:
    """(c) One driver's best used-tyre lap against their typical lap of the same stint: the clean lap nearest the
    stint's median, never the best lap itself."""
    used = [r for r in runs if r.tyres == "used" and r.laps]
    if not used:
        return None
    run = min(used, key=lambda r: _best(r)[1])
    if len(run.laps) < MIN_STINT_LAPS:
        return None
    n, t = _best(run)
    median = statistics.median(x for _, x in run.laps)
    # the nearest the median (to the millisecond: two laps as near count as one, and the earlier is taken)
    typical = min((x for x in run.laps if x[0] != n), key=lambda x: (round(abs(x[1] - median), 3), x[0]))
    if typical[1] - t < MIN_TYPICAL_GAP_S:
        return None
    return _pair("consistency", "used", _lap(run, n, t), _lap(run, *typical, role="typical"),
                 median_s=round(median, 3), stint_laps=len(run.laps))


def suggest(runs: list[Run], limit: int = LIMIT) -> tuple[list[dict], list[str]]:
    """The pairs to compare, the most useful first (a, b, c: see the module's notes), and what to say about them
    (nothing to suggest yet, drivers not set...)."""
    timed = [r for r in runs if r.laps]
    if not timed:
        return [], ["No clean laps in this event yet: suggestions come with the first run's laps."]
    named = [r for r in timed if r.driver_id is not None]
    notes = []
    if not named:
        drivers = [timed]
        notes.append("No driver is set on the runs, so they count as one driver: set who drove each run to see "
                     "teammates head to head.")
    else:
        by_driver: dict[int, list[Run]] = {}
        for r in named:
            by_driver.setdefault(r.driver_id, []).append(r)
        drivers = sorted(by_driver.values(), key=lambda rs: min(_best(r)[1] for r in rs))
        if len(named) < len(timed):
            notes.append("Runs without a driver set are left out.")
    out = _teammates(drivers) if len(drivers) > 1 else []
    out += [p for p in (_progress(rs) for rs in drivers) if p]
    out += [p for p in (_consistency(rs) for rs in drivers) if p]
    seen, picked = set(), []
    for p in out:
        key = frozenset((x["session_id"], x["lap"]) for x in p["laps"])
        if key not in seen:
            seen.add(key)
            picked.append(p)
    if not picked:
        notes.append("Nothing to compare like with like yet: two clean laps on the same tyres are needed, from two "
                     "drivers, two sessions or one long stint.")
    return picked[:limit], notes


# ---------- the event's runs ----------

def _main_file(s: models.RunSession) -> models.LoggerFile | None:
    return max(s.files, key=lambda f: (f.meta or {}).get("duration_s", 0)) if s.files else None


def _sessions(db: Session, event_id: int) -> list[models.RunSession]:
    return list(db.scalars(select(models.RunSession).where(models.RunSession.event_id == event_id).options(
        selectinload(models.RunSession.laps), selectinload(models.RunSession.files),
        selectinload(models.RunSession.driver)).order_by(models.RunSession.id)).all())


def _runs(db: Session, sessions: list[models.RunSession]) -> tuple[list[Run], list[dict]]:
    """The runs in the event page's order, and the event's sessions (FP1, Q1, R1) with every lap of their runs, for
    picking laps by hand."""
    labels = run_labels.label_runs(sessions)
    parts = run_parts.parts(sessions, labels)
    session_of = {lab.id: p for p in parts for lab in p.runs}
    by_id = {s.id: s for s in sessions}
    runs, laps_of = [], {}
    for lab in labels:
        s = by_id[lab.id]
        f = _main_file(s)
        laps = sorted((l for l in s.laps if f is not None and l.file_id == f.id), key=lambda l: l.number)
        laps_of[s.id] = laps
        part = session_of.get(s.id)
        logged = ((f.meta or {}).get("event_session") or "") if f is not None else ""
        kind = session_type(s.kind.value, part.code if part else None, lab.stored, logged)
        runs.append(Run(s.id, lab.stored, part.title if part else lab.stored, kind, "used", s.driver_id,
                        s.driver.name if s.driver else None, [(l.number, l.time_s) for l in laps if l.clean]))
    # each run's tyres as every page has them: the driver's, else the guess from the session type and the laps
    tyres = run_tyres.resolve(db, [run_tyres.RunLaps(r.id, r.kind, r.name, [t for _, t in r.laps]) for r in runs])
    for r in runs:
        r.tyres, r.tyres_sure = tyres[r.id]["tyres"], tyres[r.id]["sure"]
    by_run = {r.id: r for r in runs}

    def run_out(r: Run) -> dict:
        return {"id": r.id, "name": r.name, "driver": r.driver, "driver_id": r.driver_id, "kind": r.kind,
                "tyres": r.tyres, "tyres_sure": r.tyres_sure,
                "laps": [{"number": l.number, "time": l.time_s, "clean": l.clean} for l in laps_of[r.id]]}

    listed = [{"code": p.code, "title": p.title,
               "runs": [run_out(by_run[lab.id]) for lab in p.runs if laps_of[lab.id]]} for p in parts]
    return runs, [p for p in listed if p["runs"]]


def _signature(db: Session, event_id: int, sessions: list[models.RunSession]) -> str:
    """Everything the answer is made from: each run's log, laps, name, driver and car (page_cache.sessions_part), its
    kind, the session its log names and the tyres the driver set, and the track's start/finish line and corners."""
    own = [(s.id, s.kind.value, s.driver_id, ((_main_file(s).meta or {}).get("event_session") if s.files else None))
           for s in sessions]
    tyres = sorted(run_tyres.stored(db, [s.id for s in sessions]).items())
    return page_cache.digest(["lap-suggestions", VERSION, event_id, page_cache.sessions_part(db, sessions), own,
                              tyres])


def _scope(event_id: int) -> str:
    return f"event:{event_id}|lap-suggestions"  # "event:<id>|...": deleted with the event


# ---------- the corners ----------

def corners_of(result: dict, slower: int) -> list[dict]:
    """The sections where the slower lap of a lap comparison loses the most to the other, biggest first: up to three,
    the small ones left out unless there is no other."""
    opp = result["opportunities"][slower]["sections"]
    top = [o for o in opp if o["loss_s"] >= MIN_CORNER_S][:CORNERS_SHOWN] or opp[:1]
    return [{"code": o["code"], "loss_s": round(o["loss_s"], 3), "phase": o["phase"]} for o in top]


def _with_corners(db: Session, pair: dict) -> dict:
    """The pair with its corners, from the lap comparison (kept in its memory for the app to open at once); an
    "error" instead when the laps can't be compared."""
    body = lapcompare.CompareLapsIn(laps=[{"session_id": x["session_id"], "lap": x["lap"]} for x in pair["laps"]])
    try:
        res = lapcompare.compare_laps(body, db)
    except HTTPException as e:
        return {**pair, "corners": [], "error": str(e.detail)}
    return {**pair, "corners": corners_of(res, pair["slower"]), "numbering": res["numbering"]}


# ---------- the answer ----------

_lock = threading.Lock()
_working: dict[str, dict] = {}  # scope -> {"sig", "pairs" (with the corners known so far), "thread"}


def _answer(event_id: int, status: str, pairs: list[dict], notes: list[str], sessions: list[dict]) -> dict:
    done = sum(p["corners"] is not None for p in pairs)
    return {"event_id": event_id, "status": status, "suggestions": pairs, "notes": notes, "sessions": sessions,
            "progress": {"done": done, "total": len(pairs)} if status == "working" else None}


def work_out(db: Session, event_id: int, sig: str, pairs: list[dict], notes: list[str], sessions: list[dict],
             progress: list[dict] | None = None) -> dict:
    """Each pair's corners, one lap comparison at a time (progress, when given, is filled in as they come), then the
    answer kept in page_cache. A pair whose laps can't be compared is left out."""
    done = []
    for i, p in enumerate(pairs):
        done.append(_with_corners(db, p))
        if progress is not None:
            progress[i] = done[-1]
    kept = [p for p in done if not p.get("error")]
    if not kept and pairs:
        notes = [*notes, "The suggested laps couldn't be placed on one line: pick laps by hand below."]
    out = _answer(event_id, "ready", kept, notes, sessions)
    page_cache.store(db, _scope(event_id), sig, out)
    return out


def _job(event_id: int, sig: str, pairs: list[dict], notes: list[str], sessions: list[dict], progress: list[dict]):
    try:
        with heavy.background(), app_db.SessionLocal() as db:  # requests waiting for the lock go first
            work_out(db, event_id, sig, pairs, notes, sessions, progress)
    except Exception:
        log.exception("Lap suggestions of event %s failed", event_id)
    finally:
        with _lock:
            job = _working.get(_scope(event_id))
            if job is not None and job["thread"] is threading.current_thread():
                del _working[_scope(event_id)]


@router.get("/events/{event_id}/compare/suggestions")
def suggestions(event_id: int, db: Session = Depends(get_db)):
    """Up to five pairs of the event's laps to compare first, each with the corners where most of the gap is, and the
    event's sessions with every lap of their runs (to pick laps by hand). "status": "working" while the corners are
    worked out (those known so far filled in, the others null): ask again; "ready" once all are."""
    if db.get(models.Event, event_id) is None:
        raise HTTPException(404, "Event not found")
    sessions = _sessions(db, event_id)
    sig = _signature(db, event_id, sessions)
    scope = _scope(event_id)
    hit = page_cache.lookup(db, scope, sig)
    if hit is not None and hit[0] == 200:
        return hit[1]
    runs, listed = _runs(db, sessions)
    pairs, notes = suggest(runs)
    if not pairs:
        out = _answer(event_id, "ready", [], notes, listed)
        page_cache.store(db, scope, sig, out)
        return out
    with _lock:
        job = _working.get(scope)
        if job is None or not job["thread"].is_alive():
            progress = list(pairs)
            thread = threading.Thread(target=_job, args=(event_id, sig, pairs, notes, listed, progress),
                                      name="lap-suggestions", daemon=True)
            job = _working[scope] = {"sig": sig, "pairs": progress, "thread": thread}
            thread.start()
        known = job["pairs"] if job["sig"] == sig else pairs
    return _answer(event_id, "working", list(known), notes, listed)


def wait_idle(timeout: float = 120) -> bool:
    """Wait until no suggestions are being worked out (for tests). True when none are."""
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
    """The prebuild's warm-up: the suggestions of these runs' events that are on now or just finished (the runs of an
    older event are compared when its page asks), worked out here, on the prebuild's thread."""
    with app_db.SessionLocal() as db:
        events = set(db.scalars(select(models.RunSession.event_id).where(
            models.RunSession.id.in_(session_ids), models.RunSession.event_id.is_not(None))).all())
        since = (date.today() - timedelta(days=RECENT_DAYS)).isoformat()
        for event_id in sorted(events):
            sessions = _sessions(db, event_id)
            days = [lab.date for lab in run_labels.label_runs(sessions) if lab.date]
            if not days or max(days) < since:
                continue
            sig = _signature(db, event_id, sessions)
            if page_cache.fresh(db, _scope(event_id), sig):
                continue
            runs, listed = _runs(db, sessions)
            pairs, notes = suggest(runs)
            if pairs:
                work_out(db, event_id, sig, pairs, notes, listed)
            else:
                page_cache.store(db, _scope(event_id), sig, _answer(event_id, "ready", [], notes, listed))
