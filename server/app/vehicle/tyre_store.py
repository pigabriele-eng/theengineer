"""The background job that summarises every log for the accumulating tyre model (models.TyreData rows).

A summary (tyre_data.summarise) is a few tens of kilobytes the tyre model is fitted from, so the model never opens
a log. The job runs in one thread of the server and works through the logs that have no summary yet, or an
out-of-date one (a new summary method, other car values, laps timed again), one at a time, then sleeps. It wakes
when a log is uploaded or an import finishes, every POLL_S seconds anyway, and when the server starts, which fills
in the logs uploaded before it existed.

Memory: a summary reads only the channels it needs (speed, accelerations, yaw rate, steering, TPMS): about 80 MB
on top of the server for a 90 MB Hockenheim log, freed before the next. It reads a log only under heavy.lock, taken
per log, so imports and analysis requests take turns with it, and starts one only when no request has been in
flight for QUIET_S, so it fills the gaps while the app is idle.
"""
from __future__ import annotations

import hashlib
import json
import logging
import threading
import time
from datetime import UTC, date, datetime
from pathlib import Path

import numpy as np
from fastapi import Request
from sqlalchemy import select
from sqlalchemy.orm import Session

from app import db as dbmod
from app import heavy
from app import models
from app.analysis.laps import DEFAULT_CHANNEL_MAP, load_session
from app.routers.sessions import LOG_FILES, _channel_map, _track_for
from app.timing import read_file, track_line
from app.tyres.tpms import logger_conditions, measure_runs
from app.vehicle import tyre_data
from app.vehicle.presets import PRESETS, preset_vehicle
from app.vehicle.tyre_fit import NotEnoughData

log = logging.getLogger(__name__)

PRESET = "bmw-m4-gt4-evo"  # the car values summaries are made with (the only preset so far)
# the tyre each preset's car runs: a summary carries it until its session names another
PRESET_TYRES = {"bmw-m4-gt4-evo": "Pirelli P Zero DHG"}
POLL_S = 60.0
QUIET_S = 3.0  # no request for this long before the job opens a log
DATE_FORMATS = ("%d/%m/%Y", "%Y-%m-%d", "%d.%m.%Y", "%d/%m/%y")  # MoTeC writes 05/05/2025
# the channels a summary needs; no other role is read
ROLES = {"speed", "g_lat", "g_long", "g_vert", "yaw", "steer", "steer_wheel",
         *(f"tyre_{k}_{w}" for k in "pt" for w in ("fl", "fr", "rl", "rr"))}
NOT_A_CHANNEL = ("\0",)

OK, NONE, FAILED = "ok", "none", "failed"  # TyreData.status: summarised, no steady cornering, unreadable


def version(preset: str = PRESET) -> str:
    """Changes when the summary method or the preset's car values change, so old summaries are made again."""
    values = json.dumps(preset_vehicle(preset).model_dump(), sort_keys=True)
    return f"{tyre_data.VERSION}:{preset}:{hashlib.sha1(values.encode()).hexdigest()[:10]}"


def logger_identity(f: models.LoggerFile, preset: str = PRESET) -> tuple[str, str]:
    """Which car a log is from, by what the log says: its logger (a dash stays in its car), else the vehicle it
    names. A session given a car counts for that car instead (routers/tyre_model.py)."""
    name = PRESETS[preset][0]
    serial = f.meta.get("device_serial")
    if serial:
        return f"logger:{serial}", f"{name}, logger {serial}"[:160]
    vehicle = (f.meta.get("vehicle") or "").strip()
    if vehicle:
        return f"vehicle:{vehicle.lower()}"[:80], vehicle[:160]
    return "unknown", f"{name}, car not named in the logs"


def _date(text: str | None) -> date | None:
    for fmt in DATE_FORMATS:
        try:
            return datetime.strptime((text or "").strip(), fmt).date()
        except ValueError:
            pass
    return None


def channel_map(s: models.RunSession) -> dict[str, tuple[str, ...]]:
    """The car's channel map for the roles a summary needs, and nothing for the rest (they are not read)."""
    cmap = {**DEFAULT_CHANNEL_MAP, **(_channel_map(s) or {})}
    return {role: (names if role in ROLES else NOT_A_CHANNEL) for role, names in cmap.items()}


def timing_key(meta: dict | None) -> str | None:
    """How a log's laps are timed: the source, and the start/finish line it was timed from. A summary is made
    again when this changes (the log was re-timed), since its laps are the log's laps."""
    meta = meta or {}
    source, line = meta.get("lap_source"), meta.get("timed_line")
    if not line:
        return source
    digest = hashlib.sha1(json.dumps(line, sort_keys=True).encode()).hexdigest()[:8]
    return f"{(source or '')[:7]}:{digest}"


def _row(db: Session, f: models.LoggerFile) -> models.TyreData:
    row = db.scalar(select(models.TyreData).where(models.TyreData.file_id == f.id))
    if row is None:
        row = models.TyreData(file_id=f.id, tyre=PRESET_TYRES.get(PRESET), samples=0)
        db.add(row)
    key, label = logger_identity(f)
    row.session_id, row.version, row.lap_source = f.session_id, version(), timing_key(f.meta)
    row.car_key, row.car_label, row.preset = key, label, PRESET
    row.logged_on, row.updated_at = _date(f.meta.get("date")), datetime.now(UTC)
    return row


def summarise_file(db: Session, f: models.LoggerFile) -> models.TyreData:
    """Summarise one log file into its TyreData row (made, or replaced keeping the tyre named for it). Raises when
    the file can't be read."""
    s = f.session
    ld = read_file(f)
    track = _track_for(db, s, ld)
    data = load_session(ld, channel_map(s), beacons=f.meta.get("beacons"), line=track_line(track))
    sets = [r["start_s"] for r in measure_runs(ld)]
    ambient = logger_conditions(ld).get("ambient_c")
    try:
        with np.errstate(all="ignore"):
            summary = tyre_data.summarise(data, preset_vehicle(PRESET), sets)
        status, message = OK, None
    except NotEnoughData as e:
        summary, status, message = None, NONE, str(e)
    del data, ld
    row = _row(db, f)
    row.status, row.message, row.summary = status, message, summary
    row.samples = summary["samples"] if summary else 0
    row.track = track.name if track else (f.meta.get("venue") or None)
    row.ambient_c = ambient
    return row


def pending(db: Session) -> list[int]:
    """Log files whose summary is missing, out of date or failed before, oldest first."""
    current = version()
    have = {fid: (v, src, st) for fid, v, src, st in db.execute(
        select(models.TyreData.file_id, models.TyreData.version, models.TyreData.lap_source, models.TyreData.status))}
    out = []
    for fid, name, meta in db.execute(select(models.LoggerFile.id, models.LoggerFile.filename,
                                             models.LoggerFile.meta).order_by(models.LoggerFile.id)):
        if Path(name).suffix.lower() not in LOG_FILES:
            continue
        got = have.get(fid)
        if got is None or got[0] != current or got[1] != timing_key(meta) or got[2] == FAILED:
            out.append(fid)
    return out


# ---------- the background job ----------

_wake = threading.Event()
_stop = threading.Event()
_thread: threading.Thread | None = None
_start_lock = threading.Lock()
_state: dict = {"current": None, "unreadable": set()}  # unreadable: failed in this server's run, not tried again
_traffic = {"in_flight": 0, "last": 0.0}  # requests being served, and when the last one ended (monotonic)
_summarised: set[int] = set()  # runs whose tyre data this round of the job made (for the prebuild)


def kick() -> None:
    """A log was added: summarise it soon."""
    _wake.set()


async def track_requests(request: Request, call_next):
    """HTTP middleware: counts the requests in flight, so the job waits for a quiet moment, and wakes the job
    after a log upload."""
    _traffic["in_flight"] += 1
    try:
        return await call_next(request)
    finally:
        _traffic["in_flight"] -= 1
        _traffic["last"] = time.monotonic()
        if request.method == "POST" and request.url.path.endswith("/files"):
            kick()


def _wait_for_quiet() -> None:
    while not _stop.is_set() and (_traffic["in_flight"] > 0 or time.monotonic() - _traffic["last"] < QUIET_S):
        time.sleep(0.5)


def start() -> None:
    """Start the job (on server start-up); it first fills in any logs without a summary."""
    global _thread
    with _start_lock:
        _stop.clear()
        _state["unreadable"] = set()  # tried again once per server start
        if _thread is None or not _thread.is_alive():
            _thread = threading.Thread(target=_run, name="tyre-data", daemon=True)
            _thread.start()
    _wake.set()


def stop(timeout: float = 60) -> None:
    """Stop the job once the log in hand is done (on server shut-down, and between tests)."""
    _stop.set()
    _wake.set()
    if _thread is not None and _thread is not threading.current_thread():
        _thread.join(timeout)


def _todo(db: Session) -> list[int]:
    return [f for f in pending(db) if f not in _state["unreadable"]]


def status(db: Session) -> dict:
    """How far the job has got: logs summarised, without steady cornering, unreadable and still to do."""
    current = version()
    rows = db.execute(select(models.TyreData.status, models.TyreData.version)).all()
    return {
        "summarised": sum(1 for st, v in rows if st == OK and v == current),
        "without_cornering": sum(1 for st, v in rows if st == NONE and v == current),
        "failed": sum(1 for st, _ in rows if st == FAILED),
        "pending": len(_todo(db)),
        "running": _state["current"] is not None,
    }


def process_next(quiet: bool = False) -> bool:
    """Summarise the next pending log, after a quiet moment if asked. False when none is left."""
    if quiet:
        _wait_for_quiet()
        if _stop.is_set():
            return False
    with dbmod.SessionLocal() as db:
        if not _todo(db):  # nothing to do: no need to wait for the lock
            return False
    # one log in memory at a time, across the server; the lock hands the memory back when it is let go
    with heavy.lock, dbmod.SessionLocal() as db:
        todo = _todo(db)  # again: another worker may have done it meanwhile
        if not todo:
            return False
        f = db.get(models.LoggerFile, todo[0])
        if f is None:
            return True
        _state["current"] = f.filename
        try:
            summarise_file(db, f)
            db.commit()
            _summarised.add(f.session_id)
        except Exception as e:  # an unreadable file, storage down: noted, tried again after a restart
            db.rollback()
            log.warning("Tyre data for file %s failed: %s", f.id, e)
            _state["unreadable"].add(f.id)
            _note_failure(db, f, e)
        finally:
            _state["current"] = None
    return True


def _note_failure(db: Session, f: models.LoggerFile, e: Exception) -> None:
    try:
        row = _row(db, f)
        row.status, row.message = FAILED, (str(e) or type(e).__name__)[:2000]
        db.commit()
    except Exception:
        db.rollback()
        log.exception("Couldn't note the tyre data failure for file %s", f.id)


def run_pending() -> int:
    """Summarise every pending log now, one at a time (tests and scripts). Returns how many were tried."""
    n = 0
    while process_next():
        n += 1
    return n


def _run() -> None:
    while not _stop.is_set():
        try:
            while not _stop.is_set() and process_next(quiet=True):
                pass
        except Exception:
            log.exception("The tyre data job stopped on an error; it tries again later")
        _after_round()
        _wake.wait(POLL_S)
        _wake.clear()


def _after_round() -> None:
    """The pages made from the tyre data (track grip, prep) of the runs just summarised are out of date: the
    prebuild (app/prebuild.py) works them out again in the background."""
    if not _summarised:
        return
    ids = sorted(_summarised)
    _summarised.clear()
    try:
        from app import prebuild  # here: it uses the routers, which use this module

        prebuild.after_tyre_data(ids)
    except Exception:
        log.exception("Couldn't queue the prebuild after the tyre data of runs %s", ids)
