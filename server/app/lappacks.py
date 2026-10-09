"""Lap packs (analysis/lappack.py) in file storage, one per session (table lap_packs), and the runs the comparisons
trace from them instead of reading the logs.

Comparing laps (POST /compare/laps) or drivers (POST /compare/drivers/jobs) used to read the log of every session in
it, each time: a few seconds a session on the hosted server, plus downloading the log. Now each session's log is read
once into its lap pack (0.1 to 0.8 MB), and a comparison traces the laps from the pack and the session's compact
traces (the report's, routers/reports.py), without opening a log or waiting for heavy.lock. A session whose pack or
compact traces are missing or out of date is read from its log as before; its pack is then made in the background for
next time, and the report's work (which makes the compact traces) is started.

warm_sessions(ids) makes the packs of the sessions given that are missing or out of date: one log at a time, each
under heavy.lock, skipping (without taking the lock) those already made. The prebuild (app/prebuild.py) calls it
after an upload, once it has made the runs' compact traces, and on server start for every run.
"""
from __future__ import annotations

import hashlib
import json
import logging
import queue
import threading
import time
from collections import OrderedDict

from sqlalchemy import select
from sqlalchemy.orm import Session

from app import db as app_db  # SessionLocal is looked up when used: the tests load a fresh one
from app import heavy, models, storage
from app.analysis import compact, lappack
from app.analysis.channels import math_channels
from app.analysis.compare import ROLES as COMPARE_ROLES
from app.analysis.laps import load_session
from app.routers import reports
from app.routers.sessions import _channel_map, _line, read_file

log = logging.getLogger(__name__)

READ_ROLES = (*COMPARE_ROLES, "gear")  # what a pack is made from: what its math channels need, and the gear
PACKS_KEPT_BYTES = 24 * 1024**2  # packs held in memory (up to about 4 MB a session, as whole numbers)
TRACES_KEPT_BYTES = 16 * 1024**2  # compact traces held in memory, the roles read from them (about 1.5 MB a session)

_cache_lock = threading.Lock()
_packs: OrderedDict[str, lappack.LapPack] = OrderedDict()  # by storage key: a stored file never changes
_owns: OrderedDict[str, lappack.OwnTraces] = OrderedDict()


def main_file(s: models.RunSession) -> models.LoggerFile | None:
    """The log a session is analysed from, as everywhere else: the longest."""
    return max(s.files, key=lambda f: f.meta.get("duration_s", 0)) if s.files else None


def signature(s: models.RunSession, f: models.LoggerFile, track: models.Track | None) -> str:
    """What a session's pack is made from: its log, how it is read and timed, and its laps as stored."""
    laps = [(l.number, l.time_s, l.start_s, l.clean) for l in s.laps if l.file_id == f.id]
    # 2: the lap timing's version these signatures were first made with, kept so a new version (which changes only
    # some logs' laps, and the laps are in here) doesn't make every pack again from its log
    payload = [lappack.FORMAT, 2, s.id, f.id, f.path, f.meta.get("beacons"), _channel_map(s),
               track.timing_line if track else None, laps]
    return hashlib.sha256(json.dumps(payload, sort_keys=True, default=str).encode()).hexdigest()[:40]


def _row(db: Session, session_id: int) -> models.LapPackFile | None:
    return db.scalar(select(models.LapPackFile).where(models.LapPackFile.session_id == session_id))


# ---------- reading ----------

def _pack(key: str) -> lappack.LapPack:
    with _cache_lock:
        if key in _packs:
            _packs.move_to_end(key)
            return _packs[key]
    pack = lappack.from_bytes(storage.local_path(key).read_bytes())
    with _cache_lock:
        _packs[key] = pack
        while len(_packs) > 1 and sum(p.nbytes for p in _packs.values()) > PACKS_KEPT_BYTES:
            _packs.popitem(last=False)
    return pack


def _own(key: str) -> lappack.OwnTraces:
    with _cache_lock:
        if key in _owns:
            _owns.move_to_end(key)
            return _owns[key]
    own = lappack.own_traces(storage.local_path(key), lappack.FROM_COMPACT, compact.FORMAT)
    with _cache_lock:
        _owns[key] = own
        while len(_owns) > 1 and sum(o.nbytes() for o in _owns.values()) > TRACES_KEPT_BYTES:
            _owns.popitem(last=False)
    return own


def traces_ready(db: Session, s: models.RunSession, track: models.Track | None) -> bool:
    """Whether the session's compact traces (the report's) are up to date: with its pack, its laps trace without
    the log."""
    f = main_file(s)
    if f is None:
        return False
    rec = db.scalar(select(models.SessionTraces).where(models.SessionTraces.session_id == s.id))
    return rec is not None and rec.path is not None and not rec.error and \
        rec.signature == reports._traces_signature(s, f, track)


def packed_run(db: Session, s: models.RunSession, track: models.Track | None, numbers: list[int] | None = None,
               only: set[int] | None = None) -> lappack.PackedRun | None:
    """The session's clean laps ready to trace without its log, when its pack and compact traces are both up to date
    (made with this track's timing line) and hold the laps asked for (numbers; None: every clean lap). only: the
    laps that count as its clean laps (a pick of them), None for all. None when the log has to be read."""
    f = main_file(s)
    if f is None:
        return None
    row = _row(db, s.id)
    if row is None or row.path is None or row.signature != signature(s, f, track):
        return None
    rec = db.scalar(select(models.SessionTraces).where(models.SessionTraces.session_id == s.id))
    if rec is None or rec.path is None or rec.error or rec.signature != reports._traces_signature(s, f, track):
        return None
    try:
        run = lappack.PackedRun(_pack(row.path), _own(rec.path), frozenset(only) if only is not None else None)
    except (OSError, ValueError, KeyError):  # gone from storage (StorageError included), or another format
        return None
    clean = {l.number for l in s.laps if l.file_id == f.id and l.clean}
    if not lappack.matches(run.pack, run.own) or set(run.pack.laps) != clean:
        return None
    return run if run.holds(clean if numbers is None else numbers) else None


def missed(db: Session, sessions: list[models.RunSession]) -> None:
    """After a comparison read these sessions' logs: their packs are made in the background, and the report's work is
    started for those whose compact traces are out of date (it makes them), so the next comparison reads neither."""
    for s in sessions:
        f = main_file(s)
        if f is None or not any(l.clean and l.file_id == f.id for l in s.laps):
            continue
        schedule([s.id])
        try:
            track = reports._track_of(db, s, f)
            rec = db.scalar(select(models.SessionTraces).where(models.SessionTraces.session_id == s.id))
            if rec is None or rec.signature != reports._traces_signature(s, f, track):
                if s.event_id is not None:
                    reports.report_for(db, "event", s.event_id)
                else:
                    reports.report_for(db, "session", s.id)
        except Exception:  # the comparison is answered: the traces are made when the report is next opened
            log.exception("Couldn't start the report for session %s", s.id)


# ---------- making ----------

def ensure_pack(db: Session, session_id: int) -> models.LapPackFile | None:
    """The session's pack row, made from its log unless the one kept is up to date (then nothing is read and
    heavy.lock is not taken). None when the session or its log is gone."""
    s = db.get(models.RunSession, session_id)
    f = main_file(s) if s is not None else None
    if f is None:
        return None
    track = reports._track_of(db, s, f)
    sig = signature(s, f, track)
    row = _row(db, session_id)
    if row is not None and row.signature == sig:
        return row
    with heavy.lock:
        db.commit()  # see what another thread made while this one waited for the lock
        row = _row(db, session_id)
        if row is not None and row.signature == sig:
            return row
        if row is None:
            row = models.LapPackFile(session_id=session_id)
            db.add(row)
        old = row.path
        row.signature, row.error, row.path, row.laps = sig, None, None, 0
        if any(l.clean and l.file_id == f.id for l in s.laps):
            try:
                ld = read_file(f)
                data = load_session(ld, _channel_map(s), beacons=f.meta.get("beacons"), line=_line(track),
                                    roles=READ_ROLES)
                del ld
                math_channels(data)
                pack = lappack.build(data)
                del data
                if pack.laps:
                    row.path = storage.save(lappack.to_bytes(pack), ".npz")
                    row.laps = len(pack.laps)
                del pack
            except (FileNotFoundError, ValueError, storage.StorageError) as e:  # missing, or not a log it can read
                row.error = f"Its log couldn't be read: {e}"
            except Exception as e:
                log.exception("Packing session %s failed", session_id)
                row.error = f"Its log couldn't be packed: {e}"
        db.commit()
    reports.forget_file(old, row.path)
    return row


def warm_sessions(session_ids: list[int]) -> None:
    """Make the lap packs of these sessions that are missing or out of date, one log at a time, each under
    heavy.lock; those already up to date are skipped without reading anything. For a background thread."""
    for sid in dict.fromkeys(session_ids):
        try:
            with app_db.SessionLocal() as db:
                ensure_pack(db, sid)
        except Exception:  # one session that can't be packed is read from its log when compared, as before
            log.exception("Couldn't make the lap pack of session %s", sid)


# ---------- in the background ----------

_jobs: queue.Queue[int] = queue.Queue()
_pending: set[int] = set()
_lock = threading.Lock()
_worker: threading.Thread | None = None


def schedule(session_ids: list[int]) -> None:
    """warm_sessions in this module's own background thread."""
    global _worker
    with _lock:
        for sid in session_ids:
            if sid not in _pending:
                _pending.add(sid)
                _jobs.put(sid)
        if _worker is None or not _worker.is_alive():
            _worker = threading.Thread(target=_work, name="lap-packs", daemon=True)
            _worker.start()


def _work() -> None:
    jobs = _jobs
    while True:
        sid = jobs.get()
        try:
            with heavy.background():  # requests and other jobs waiting for heavy.lock go first
                warm_sessions([sid])
        finally:
            with _lock:
                _pending.discard(sid)
            jobs.task_done()


def wait_idle(timeout: float = 120) -> bool:
    """Wait until every pack asked for is made (for tests). True when nothing is left."""
    deadline = time.monotonic() + timeout
    while _jobs.unfinished_tasks and time.monotonic() < deadline:
        time.sleep(0.05)
    return not _jobs.unfinished_tasks
