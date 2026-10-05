"""The start/finish line a track's laps are timed from, and re-timing stored logs when it changes.

A track learns its line from its logs: from the dash's S/F marker if one has it, else from .ldx beacons. The dash's
marker is the better source: i2's "Auto GPS" beacons can sit tens of metres from the dash's line (and miss laps),
and the official corner positions are measured from the dash's line. So a log with the marker replaces a line
learned from beacons, and the track's other logs are then re-timed in the background: one worker thread, one log at
a time under heavy.lock (so never alongside a request or import that reads a log), reading only the channels lap
timing needs (speed, marker, lap time, GPS), which keeps memory low.

Each log keeps the line it was timed from (meta "timed_line"), so it is re-timed only when its track's line has
changed since. On startup every track is checked once the same way; a line saved before its source was recorded is
replaced by the one from a marker log of that track, so a database timed by older code corrects itself.
"""
from __future__ import annotations

import ctypes
import gc
import logging
import math
import queue
import threading
from dataclasses import asdict

from sqlalchemy import event, select
from sqlalchemy.orm import Session, selectinload

from app import db as app_db  # SessionLocal is looked up when used: the tests swap the database
from app import heavy, models, storage
from app.analysis.laps import LapTiming, TimingLine, time_laps
from app.importers.csvlog import read_log
from app.importers.motec import LdFile

log = logging.getLogger(__name__)

RANK = {"marker": 2, "beacons": 1}  # sources a track's line is learned from, best last
SAME_LINE_M = 1.0  # lines closer than this (and within SAME_HEADING_DEG) time laps the same
SAME_HEADING_DEG = 2.0
_PENDING = "retime_tracks"  # Session.info key: tracks to re-time once the session commits

_queue: queue.Queue[int] = queue.Queue()
_queued: set[int] = set()
_lock = threading.Lock()
_worker: threading.Thread | None = None


def read_file(f: models.LoggerFile) -> LdFile:
    """An uploaded log, read from wherever it is stored."""
    return read_log(storage.local_path(f.path))


def track_line(track: models.Track | None) -> TimingLine | None:
    return TimingLine(**track.timing_line) if track and track.timing_line else None


def _rank(line: dict | None) -> int:
    if not line:
        return 0
    # a line saved before its source was recorded came from beacons or a marker: a marker log replaces it
    return RANK.get(line.get("source", ""), 1)


def same_line(a: dict | None, b: dict | None) -> bool:
    if not a or not b:
        return not a and not b
    if a.get("source", "") != b.get("source", ""):
        return False
    lat = math.radians(a["lat"])
    dx = math.radians(b["lon"] - a["lon"]) * 6_371_000 * math.cos(lat)
    dy = math.radians(b["lat"] - a["lat"]) * 6_371_000
    turn = abs((b["heading"] - a["heading"] + 180) % 360 - 180)
    return math.hypot(dx, dy) < SAME_LINE_M and turn < SAME_HEADING_DEG


def store_laps(db: Session, s: models.RunSession, rec: models.LoggerFile, timing: LapTiming,
               track: models.Track | None) -> None:
    """Replace the log's laps. A log with a better source than the track's line so far (the dash's marker over
    beacons) teaches the track its line, and the track's other logs are re-timed once this is committed."""
    for old in [l for l in s.laps if l.file_id == rec.id]:
        s.laps.remove(old)
    db.flush()
    for lap in timing.laps:
        db.add(models.Lap(session=s, file_id=rec.id, number=lap.number, time_s=lap.time,
                          start_s=lap.start, clean=lap.clean))
    rec.meta = {**rec.meta, "lap_source": timing.source}
    if track is None:
        return
    if timing.source in RANK and timing.line is not None and RANK[timing.source] > _rank(track.timing_line):
        track.timing_line = asdict(timing.line)
        retime_after_commit(db, track)
    rec.meta = {**rec.meta, "timed_line": dict(track.timing_line) if track.timing_line else None}


def retime_after_commit(db: Session, track: models.Track) -> None:
    """Re-time the track's logs in the background once db commits (not before: the worker reads what's committed)."""
    if _PENDING not in db.info:
        db.info[_PENDING] = set()
        event.listen(db, "after_commit", _schedule_pending)  # this session's commits only
    db.info[_PENDING].add(track.id)


def _schedule_pending(db: Session) -> None:
    pending = db.info[_PENDING]
    while pending:
        schedule(pending.pop())


def schedule(track_id: int) -> None:
    """Check the track's line and re-time its logs timed from an older one, in the background."""
    global _worker
    with _lock:
        if track_id not in _queued:
            _queued.add(track_id)
            _queue.put(track_id)
        if _worker is None or not _worker.is_alive():
            _worker = threading.Thread(target=_work, name="retime", daemon=True)
            _worker.start()


def check_all_tracks() -> None:
    """On startup: every track, in the background (a database timed by older code corrects itself)."""
    with app_db.SessionLocal() as db:
        ids = db.scalars(select(models.Track.id).order_by(models.Track.id)).all()
    for track_id in ids:
        schedule(track_id)


def wait_idle() -> None:
    """Until every scheduled track has been checked (for tests)."""
    _queue.join()


def _work() -> None:
    while True:
        track_id = _queue.get()
        with _lock:
            _queued.discard(track_id)  # scheduled again while it's checked: checked again after
        try:
            check_track(track_id)
        except Exception:
            log.exception("Re-timing the logs of track %s failed", track_id)
        finally:
            _queue.task_done()


def check_track(track_id: int) -> None:
    with app_db.SessionLocal() as db:
        track = db.get(models.Track, track_id)
        if track is None:
            return
        files = files_at(db, track)
        if (track.timing_line or {}).get("source") != "marker":
            _learn_from_marker_log(db, track, [f for f in files if f.meta.get("lap_source") == "marker"])
        for f in files:
            if _up_to_date(f, track):
                continue
            with heavy.lock:  # one log at a time, across this worker, imports and requests
                try:
                    db.refresh(track)  # what's stored now: a request may have changed them while this waited
                    db.refresh(f)
                    if _up_to_date(f, track):
                        continue
                    ld = read_file(f)
                    store_laps(db, f.session, f, time_laps(ld, f.meta.get("beacons"), track_line(track)), track)
                    del ld
                    db.commit()
                except Exception:
                    log.exception("Re-timing log %s failed", f.id)
                    db.rollback()
                finally:
                    _release_memory()


def _up_to_date(f: models.LoggerFile, track: models.Track) -> bool:
    """Timed by the dash's own marker, or from the track's line as it is now."""
    return f.meta.get("lap_source") == "marker" or same_line(f.meta.get("timed_line"), track.timing_line)


def files_at(db: Session, track: models.Track) -> list[models.LoggerFile]:
    """The logs driven at the track, as the sessions router finds a log's track: its session's event's track,
    else the venue in its header. Read from the database only, no log is opened."""
    rows = db.scalars(select(models.LoggerFile).order_by(models.LoggerFile.id)
                      .options(selectinload(models.LoggerFile.session).selectinload(models.RunSession.event))).all()
    out = []
    for f in rows:
        ev = f.session.event
        if ev is not None and ev.track_id is not None:
            if ev.track_id == track.id:
                out.append(f)
        elif (f.meta.get("venue") or "")[:120] == track.name:
            out.append(f)
    return out


def _learn_from_marker_log(db: Session, track: models.Track, marker_logs: list[models.LoggerFile]) -> None:
    """The track's line from the first of its logs with the dash's marker that can be read."""
    for f in marker_logs:
        with heavy.lock:
            try:
                db.refresh(track)
                if (track.timing_line or {}).get("source") == "marker":  # an upload taught it while this waited
                    return
                timing = time_laps(read_file(f))
            except Exception:
                log.exception("Reading log %s for its start/finish line failed", f.id)
                db.rollback()
                continue
            finally:
                _release_memory()
            if timing.source == "marker" and timing.line is not None:
                track.timing_line = asdict(timing.line)
                db.commit()
                return


def _release_memory() -> None:
    """Free one log before the next is read, and hand the memory back to the system (glibc keeps it otherwise)."""
    gc.collect()
    try:
        ctypes.CDLL("libc.so.6").malloc_trim(0)
    except (OSError, AttributeError):  # not glibc
        pass
