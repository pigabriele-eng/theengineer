"""The start/finish line a track's laps are timed from, and re-timing stored logs when it changes.

A track learns its line from its logs: from the dash's S/F marker if one has it, else from .ldx beacons. The dash's
marker is the better source: i2's "Auto GPS" beacons can sit tens of metres from the dash's line (and miss laps),
and the official corner positions are measured from the dash's line. So a log with the marker replaces a line
learned from beacons, and the track's other logs are then re-timed in the background: one worker thread, one log at
a time under heavy.lock (so never alongside a request or import that reads a log), reading only the channels lap
timing needs (speed, marker, lap time, GPS), which keeps memory low.

Each log keeps the line it was timed from (meta "timed_line") and the version of the lap timing that timed it
(meta "timing_version", laps.TIMING_VERSION), so it is re-timed only when its track's line has changed since, or
when the lap timing itself has (before version 2 a double pulse of the dash's marker made a 3 s "lap"). On startup
every track, and the logs at no track, are checked once the same way; a line saved before its source was recorded
is replaced by the one from a marker log of that track, so a database timed by older code corrects itself.

What depends on a log's laps follows a re-timing: the report, lap traces, technique check and the other cached
results carry a signature of the laps they were made from, so they are worked out again; the tyre-data summary of
a log whose laps changed is made again; and a session an import made that is left with no laps is checked as an
empty run (empty_runs.py: removed, unless a missing lap beacon explains it or the user entered something on it).
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
from app.analysis.laps import TIMING_VERSION, LapTiming, TimingLine, time_laps
from app.importers.csvlog import read_log
from app.importers.motec import LdFile
from app.importers.window import window

log = logging.getLogger(__name__)

RANK = {"marker": 2, "beacons": 1}  # sources a track's line is learned from, best last
SAME_LINE_M = 1.0  # lines closer than this (and within SAME_HEADING_DEG) time laps the same
SAME_HEADING_DEG = 2.0
_PENDING = "retime_tracks"  # Session.info key: tracks to re-time once the session commits

NO_TRACK = None  # scheduled like a track: the logs at no track (no event track, no venue in the header)

_queue: queue.Queue[int | None] = queue.Queue()
_queued: set[int | None] = set()
_lock = threading.Lock()
_worker: threading.Thread | None = None


def read_file(f: models.LoggerFile) -> LdFile:
    """An uploaded log, read from wherever it is stored. A run split from a longer log (run_split.py) reads its part
    of the stored log (meta "window"), from 0 at the part's start."""
    ld = read_log(storage.local_path(f.path))
    w = (f.meta or {}).get("window")
    return window(ld, w[0], w[1]) if w else ld


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
               track: models.Track | None) -> bool:
    """Replace the log's laps. A log with a better source than the track's line so far (the dash's marker over
    beacons) teaches the track its line, and the track's other logs are re-timed once this is committed. Returns
    whether the log's laps changed; when they did, its tyre-data summary is made again."""
    old = [l for l in s.laps if l.file_id == rec.id]
    before = [(l.number, l.start_s, l.time_s, l.clean) for l in old]
    for lap in old:
        s.laps.remove(lap)
    db.flush()
    for lap in timing.laps:
        db.add(models.Lap(session=s, file_id=rec.id, number=lap.number, time_s=lap.time,
                          start_s=lap.start, clean=lap.clean))
    changed = not _same_laps(before, [(l.number, l.start, l.time, l.clean) for l in timing.laps])
    if changed:  # the tyre data job (vehicle/tyre_store.py) summarises the log again when this doesn't match
        for row in db.scalars(select(models.TyreData).where(models.TyreData.file_id == rec.id)):
            row.lap_source = None
    meta = {**rec.meta, "lap_source": timing.source, "timing_version": TIMING_VERSION}
    if timing.laps:
        meta.pop("untimed", None)  # a log kept with laps it couldn't time (empty_runs.py) is timed now
    rec.meta = meta
    if track is None:
        return changed
    if timing.source in RANK and timing.line is not None and RANK[timing.source] > _rank(track.timing_line):
        track.timing_line = asdict(timing.line)
        retime_after_commit(db, track)
    rec.meta = {**rec.meta, "timed_line": dict(track.timing_line) if track.timing_line else None}
    return changed


def _same_laps(a: list[tuple], b: list[tuple]) -> bool:
    """(number, start, time, clean) of two timings, alike to the millisecond."""
    return len(a) == len(b) and all(
        n == m and abs(s - t) < 1e-3 and abs(x - y) < 1e-3 and bool(c) == bool(d)
        for (n, s, x, c), (m, t, y, d) in zip(a, b, strict=True))


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


def schedule(track_id: int | None) -> None:
    """Check the track's line and re-time its logs timed from an older one or by older lap timing, in the
    background. NO_TRACK: the logs at no track."""
    global _worker
    with _lock:
        if track_id not in _queued:
            _queued.add(track_id)
            _queue.put(track_id)
        if _worker is None or not _worker.is_alive():
            _worker = threading.Thread(target=_work, name="retime", daemon=True)
            _worker.start()


def check_all_tracks() -> None:
    """On startup: every track and the logs at no track, in the background (a database timed by older code
    corrects itself). The logs are read from the database once and grouped by track: only the tracks with a log to
    re-time or a line to learn are scheduled (check_track would find nothing to do at the others)."""
    with app_db.SessionLocal() as db:
        tracks = db.scalars(select(models.Track).order_by(models.Track.id)).all()
        by_track = _files_by_track(db)
        due = [t.id for t in tracks if _has_work(t, by_track.get(t.id, []))]
        if _has_work(None, by_track.get(NO_TRACK, [])):
            due.append(NO_TRACK)
    for track_id in due:
        schedule(track_id)


def _has_work(track: models.Track | None, files: list[models.LoggerFile]) -> bool:
    """Whether check_track has anything to do for these logs at the track: a marker log to learn the line from, or a
    log that isn't up to date."""
    if track is not None and (track.timing_line or {}).get("source") != "marker" \
            and any(f.meta.get("lap_source") == "marker" for f in files):
        return True
    return not all(_up_to_date(f, track) for f in files)


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


def check_track(track_id: int | None) -> None:
    """Re-time the track's logs (NO_TRACK: the logs at no track) that aren't up to date, one at a time; then check
    the sessions an import made that this left with no laps, as empty runs."""
    changed: set[int] = set()
    with app_db.SessionLocal() as db:
        track = db.get(models.Track, track_id) if track_id is not NO_TRACK else None
        if track is None and track_id is not NO_TRACK:
            return
        files = files_at(db, track)
        if track is not None and (track.timing_line or {}).get("source") != "marker":
            _learn_from_marker_log(db, track, [f for f in files if f.meta.get("lap_source") == "marker"])
        for f in files:
            if _up_to_date(f, track):
                continue
            with heavy.lock:  # one log at a time, across this worker, imports and requests
                try:
                    if track is not None:
                        db.refresh(track)  # what's stored now: a request may have changed them while this waited
                    db.refresh(f)
                    if _up_to_date(f, track):
                        continue
                    ld = read_file(f)
                    if store_laps(db, f.session, f, time_laps(ld, f.meta.get("beacons"), track_line(track)), track):
                        changed.add(f.session_id)
                    del ld
                    db.commit()
                except Exception:
                    log.exception("Re-timing log %s failed", f.id)
                    db.rollback()
                finally:
                    _release_memory()
    if changed:
        from app import empty_runs  # imported here: it reads logs through this module

        empty_runs.cleanup(only=changed)


def _up_to_date(f: models.LoggerFile, track: models.Track | None) -> bool:
    """Timed by this version of the lap timing, and by the dash's own marker or from the track's line as it is
    now."""
    if f.meta.get("timing_version") != TIMING_VERSION:
        return False
    line = track.timing_line if track is not None else None
    return f.meta.get("lap_source") == "marker" or same_line(f.meta.get("timed_line"), line)


def files_at(db: Session, track: models.Track | None) -> list[models.LoggerFile]:
    """The logs driven at the track, as the sessions router finds a log's track: its session's event's track,
    else the venue in its header (track None: the logs at no track). Read from the database only, no log is
    opened."""
    return _files_by_track(db).get(track.id if track is not None else NO_TRACK, [])


def _files_by_track(db: Session) -> dict[int | None, list[models.LoggerFile]]:
    """Every log by the id of the track it was driven at (files_at), NO_TRACK for the logs at no track; in id order."""
    rows = db.scalars(select(models.LoggerFile).order_by(models.LoggerFile.id)
                      .options(selectinload(models.LoggerFile.session).selectinload(models.RunSession.event))).all()
    ids = {name: tid for tid, name in db.execute(select(models.Track.id, models.Track.name))}  # names are unique
    out: dict[int | None, list[models.LoggerFile]] = {}
    for f in rows:
        ev = f.session.event
        if ev is not None and ev.track_id is not None:
            at = ev.track_id
        else:
            at = ids.get((f.meta.get("venue") or "")[:120], NO_TRACK)
        out.setdefault(at, []).append(f)
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
