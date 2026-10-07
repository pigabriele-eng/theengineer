"""Runs with no laps: left out of an import, refused by the upload, and cleared from the server once at startup.

analysis/emptyrun.py tells from the log itself whether a log that gives no laps is an empty run (the pit lane, the
garage, an out-lap and an in-lap) or a run whose laps couldn't be timed because the lap beacon is missing. An empty
run is never kept: routers/sessions.add_log raises NoLaps before the file is stored, so the import lists the log as
skipped with the reason and the single-file upload refuses it. A run with untimed laps is kept and its log marked
(LoggerFile.meta "untimed", dropped once its laps are timed); the session page and the import result say why and
what fixes it.

Runs already on the server are checked in the background at startup (start()): the sessions an import made that
have no laps and nothing entered by hand. Each log is read under heavy.lock, one at a time and only its speed and
GPS. An empty run is removed with everything kept for it: laps, file record, stored file, and its rows in the
report, technique, lap-trace, tyre-data and setup caches. A run with untimed laps is marked, so it isn't read again.
Each removal is logged. A run that loses its laps later, when timing.py times its log again (newer lap timing found
its only "lap" was a double pulse of the dash's marker), is checked the same way right after.
"""
from __future__ import annotations

import logging
import threading
from collections.abc import Collection
from pathlib import Path

from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from app import db as app_db  # SessionLocal is looked up when used: the tests swap the database
from app import heavy, models, page_cache, storage
from app.analysis.emptyrun import UNTIMED, Verdict, judge
from app.analysis.laps import load_session
from app.routers import sessions, trackmap
from app.setup import models as setup_models  # looked up when used: the tests reload the models
from app.timing import read_file, track_line
from app.vehicle import tyre_store

log = logging.getLogger(__name__)

ROLES = {"speed", "lat", "lon"}  # all a verdict reads from a log

_thread: threading.Thread | None = None


def entered_by_hand(db: Session, s: models.RunSession) -> str | None:
    """What the user put on the session, if anything: such a session is never removed. An import makes a session
    of kind test with no driver, car, conditions or tyres; the app has no way to rename one."""
    if s.debriefs:
        return "a debrief"
    if db.scalar(select(setup_models.SessionSetup.id).where(setup_models.SessionSetup.session_id == s.id)) is not None:
        return "a setup sheet"
    if s.driver_id is not None:
        return "a driver"
    if s.car_id is not None:
        return "a car"
    if s.kind != models.SessionKind.test:
        return f"the kind {s.kind}"
    if s.track_temp_c is not None or s.ambient_temp_c is not None:
        return "temperatures"
    if s.tyre_set:
        return "a tyre set"
    tyres = db.execute(select(models.TyreData.tyre, models.TyreData.preset)
                       .where(models.TyreData.session_id == s.id)).all()
    if any(tyre != tyre_store.PRESET_TYRES.get(preset) for tyre, preset in tyres):
        return "a tyre named for it"
    return None


def _made_by_import(db: Session) -> set[int]:
    return {int(i) for ids in db.scalars(select(models.ImportJob.session_ids)) for i in (ids or [])}


def candidates(db: Session) -> list[int]:
    """Sessions an import made that have no laps (a session made by hand is the user's own)."""
    made = _made_by_import(db)
    lapless = db.scalars(select(models.RunSession.id)
                         .where(models.RunSession.id.not_in(select(models.Lap.session_id)))
                         .order_by(models.RunSession.id)).all()
    return [i for i in lapless if i in made]


def _track(db: Session, s: models.RunSession, f: models.LoggerFile) -> models.Track | None:
    """The track the log was timed at, without making one: the event's, else the venue in its header."""
    if s.event and s.event.track:
        return s.event.track
    venue = (f.meta.get("venue") or "")[:120]
    return db.scalar(select(models.Track).where(models.Track.name == venue)) if venue else None


def _judge_file(db: Session, s: models.RunSession, f: models.LoggerFile) -> Verdict | None:
    """The log's verdict; None when it gives laps now (the re-timing in timing.py stores them)."""
    track = _track(db, s, f)
    line, beacons = track_line(track), f.meta.get("beacons")
    ld = read_file(f)
    try:
        data = load_session(ld, sessions._channel_map(s), beacons=beacons, line=line, roles=ROLES)
        return None if data.laps else judge(ld, data, beacons, line, track.length_m if track else None)
    finally:
        del ld


def check_session(session_id: int) -> str | None:
    """Remove the session if it is an empty run ("removed"), or mark its untimed laps ("kept"); None when it is
    left as it is (it has laps, something entered by hand, or a log that can't be read)."""
    keys: list[str] = []
    with heavy.lock, app_db.SessionLocal() as db:  # one log at a time, across imports, requests and other jobs
        s = db.get(models.RunSession, session_id)
        if s is None or s.laps:
            return None
        logs = [f for f in s.files if Path(f.filename).suffix.lower() in sessions.LOG_FILES]
        if not logs or any("untimed" in f.meta for f in logs):
            return None
        name = s.name or f"Session {s.id}"
        hand = entered_by_hand(db, s)
        if hand:
            log.warning("Run %r (session %s) has no laps; kept: it has %s", name, s.id, hand)
            return None
        verdicts = []
        for f in logs:
            try:
                v = _judge_file(db, s, f)
            except Exception as e:  # missing from storage, or unreadable: nothing to judge it by
                log.warning("Run %r (session %s) has no laps; kept: its log %s can't be read (%s)", name, s.id,
                            f.filename, e)
                return None
            if v is None:
                return None
            verdicts.append((f, v))
        untimed = [(f, v) for f, v in verdicts if v.keep]
        for f, v in untimed:
            f.meta = {**f.meta, "untimed": v.note()}
        if untimed:
            db.commit()
            log.warning("Run %r (session %s) kept, %s: %s", name, s.id, UNTIMED.lower(), untimed[0][1].reason)
            return "kept"
        reason = max(verdicts, key=lambda x: x[0].meta.get("duration_s", 0))[1].reason
        files = ", ".join(f.filename for f in logs)
        keys = remove_session(db, s)
        db.commit()
        log.warning("Removed empty run %r (session %s, %s): %s", name, session_id, files, reason)
    for key in keys:  # after the commit: a file left behind is harmless, a record of a missing file is not
        try:
            storage.delete(key)
        except Exception as e:
            log.warning("Couldn't delete the stored file %s: %s", key, e)
    return "removed"


def remove_session(db: Session, s: models.RunSession) -> list[str]:
    """Delete the session with its laps and files, and every cached result made from it. Returns the storage keys
    to delete once this is committed. Not committed."""
    sid, eid = s.id, s.event_id
    file_ids = [f.id for f in s.files]
    keys = [f.path for f in s.files]
    for row in db.scalars(select(models.TyreData).where(or_(models.TyreData.session_id == sid,
                                                            models.TyreData.file_id.in_(file_ids)))):
        db.delete(row)
    summaries = setup_models.SetupRunSummary
    for row in db.scalars(select(summaries).where(summaries.session_id == sid)):
        db.delete(row)
    for model in (models.SessionTraces, models.LapPackFile):
        for row in db.scalars(select(model).where(model.session_id == sid)):
            keys += [row.path] if row.path else []
            db.delete(row)
    for model in (models.ReportCache, models.TechniqueCache):
        for row in db.scalars(select(model).where(model.scope == f"session:{sid}")):
            keys += [row.details] if getattr(row, "details", None) else []
            db.delete(row)
        event_row = db.scalar(select(model).where(model.scope == f"event:{eid}")) if eid is not None else None
        if event_row is not None and _mentions(event_row.result, sid):  # worked out again without it
            event_row.result, event_row.result_signature, event_row.signature = None, None, ""
    page_cache.forget_session(db, sid)
    db.delete(s)
    db.flush()
    with trackmap._cache_lock:
        for key in [k for k in trackmap._cache if k[0] in file_ids]:
            del trackmap._cache[key]
    return keys


def _mentions(x, sid: int) -> bool:
    """Whether a cached result refers to the session: by "session_id", or as a key of "sessions"."""
    if isinstance(x, dict):
        if x.get("session_id") == sid or (isinstance(x.get("sessions"), dict) and str(sid) in x["sessions"]):
            return True
        return any(_mentions(v, sid) for v in x.values())
    if isinstance(x, list):
        return any(_mentions(v, sid) for v in x)
    return False


def cleanup(only: Collection[int] | None = None) -> dict[str, list[int]]:
    """Check every session an import made that has no laps (or those of only), one at a time."""
    with app_db.SessionLocal() as db:
        ids = [i for i in candidates(db) if only is None or i in only]
    out: dict[str, list[int]] = {"removed": [], "kept": []}
    for sid in ids:
        try:
            what = check_session(sid)
        except Exception:
            log.exception("Checking run %s for laps failed", sid)
            continue
        if what:
            out[what].append(sid)
    return out


def untimed(db: Session, session_ids: list[int]) -> list[dict]:
    """The logs of these sessions kept with laps that couldn't be timed, and why (for the import's result)."""
    if not session_ids:
        return []
    timed = set(db.scalars(select(models.Lap.file_id).where(models.Lap.session_id.in_(session_ids)).distinct()))
    out = []
    for f in db.scalars(select(models.LoggerFile).where(models.LoggerFile.session_id.in_(session_ids))
                        .order_by(models.LoggerFile.id)):
        note = f.meta.get("untimed")
        if note and f.id not in timed:
            out.append({"session_id": f.session_id, "name": f.session.name, "file": f.filename, **note})
    return out


def start() -> None:
    """On startup: the runs with no laps already on the server, in the background."""
    global _thread
    _thread = threading.Thread(target=_run, name="empty-runs", daemon=True)
    _thread.start()


def _run() -> None:
    try:
        cleanup()
    except Exception:
        log.exception("Checking the runs with no laps failed")


def wait_idle(timeout: float = 60) -> None:
    """Until the startup check is done (for tests)."""
    if _thread is not None:
        _thread.join(timeout)
