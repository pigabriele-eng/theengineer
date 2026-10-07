"""Tyre and qualifying preparation report over one session or a whole event: GET /report/tyre-prep."""
import logging
import threading
from collections import OrderedDict
from datetime import datetime
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from app import heavy, models
from app.analysis.laps import split_laps
from app.analysis.tyreprep import aggregate, log_channels, reduce_session
from app.db import get_db
from app.importers.motec import LdFormatError
from app.routers.sessions import LOG_FILES, _channel_map, _get, _line, read_file
from app.routers.tyres import logged_runs, minimum_rows
from app.tyres.tpms import logger_conditions

router = APIRouter()
log = logging.getLogger(__name__)

# Reduced sessions, so a report over an event doesn't read every log again. Keyed by what the reduction depends
# on: a new upload, new beacons, a learned timing line, a changed channel map or ambient makes a new key.
CACHE_SIZE = 64
_cache: OrderedDict[tuple, dict] = OrderedDict()
_cache_lock = threading.Lock()


def _track(db: Session, s: models.RunSession, f: models.LoggerFile) -> models.Track | None:
    """The session's track, or the one named in the log header (the one the lap timing used)."""
    if s.event and s.event.track:
        return s.event.track
    venue = (f.meta.get("venue") or "")[:120]
    return db.scalar(select(models.Track).where(models.Track.name == venue)) if venue else None


def _key(s: models.RunSession, logs: list[models.LoggerFile], main: models.LoggerFile, line) -> tuple:
    cmap = _channel_map(s)
    return (s.id, tuple((f.id, f.path) for f in logs), main.id, repr(main.meta.get("beacons")),
            repr(line), repr(sorted(cmap.items()) if cmap else None), s.ambient_temp_c, s.track_temp_c)


def _summarise(s: models.RunSession, main: models.LoggerFile, line) -> dict | None:
    """Read the log and reduce it; the log and its 10 Hz channels are let go when this returns."""
    ld = read_file(main)
    laps, _ = split_laps(ld, main.meta.get("beacons"), line)
    ch = log_channels(ld, _channel_map(s))
    if ch is None:
        return None
    ambient = s.ambient_temp_c if s.ambient_temp_c is not None else logger_conditions(ld).get("ambient_c")
    out = reduce_session(ch, laps, ambient)
    return {**out, "day": main.meta.get("date") or "", "time": main.meta.get("time") or ""}


def _reduce(db: Session, s: models.RunSession) -> tuple[dict | None, str | None]:
    """The session's main log (the longest) reduced to its summary, with the cold-to-hot pressure runs of all its
    logs; or why it can't be."""
    logs = [f for f in s.files if Path(f.filename).suffix.lower() in LOG_FILES]
    if not logs:
        return None, "no logger file"
    main = max(logs, key=lambda f: f.meta.get("duration_s", 0))
    line = _line(_track(db, s, main))
    key = _key(s, logs, main, line)
    with _cache_lock:
        if key in _cache:
            _cache.move_to_end(key)
            return _cache[key], None
    # one log in memory at a time across every request and import; letting go hands its memory back
    with heavy.lock:
        with _cache_lock:  # a request that waited its turn may find this session reduced already
            if key in _cache:
                return _cache[key], None
        try:
            out = _summarise(s, main, line)
            if out is None:
                return None, "no speed channel"
            out["pressure_runs"] = logged_runs(db, session_ids=[s.id])
        except (LdFormatError, OSError, ValueError) as e:
            return None, f"the log can't be read ({e})"
        except Exception:  # one log the analysis trips on leaves that session out, not the whole event
            log.exception("Tyre prep: session %s left out", s.id)
            return None, "the analysis couldn't make sense of this log"
    with _cache_lock:
        _cache[key] = out
        while len(_cache) > CACHE_SIZE:
            _cache.popitem(last=False)
    return out, None


def _when(r: dict) -> tuple:
    """Sessions in the order they ran: logs date them dd/mm/yyyy, so by the date itself, then the time of day."""
    try:
        day = datetime.strptime(r["day"], "%d/%m/%Y").date().isoformat()
    except ValueError:
        day = r["day"]
    return day, r["time"], r["session_id"]


@router.get("/report/tyre-prep")
def tyre_prep(session: int | None = None, event: int | None = None, db: Session = Depends(get_db)):
    """Tyre and qualifying preparation over one session or every session of an event: the quali-style runs found
    in the logs and how their warm-ups compare, when the tyres were ready to push and peaked, each tyre's
    pressure and temperature window on the fastest laps, the cold pressures that land in it and the long-run
    fade."""
    if (session is None) == (event is None):
        raise HTTPException(422, "Pass either session or event")
    if session is not None:
        rows = [_get(db, session)]
        ev = rows[0].event
    else:
        ev = db.get(models.Event, event)
        if ev is None:
            raise HTTPException(404, "Event not found")
        rows = db.scalars(select(models.RunSession).where(models.RunSession.event_id == event)).all()
    reduced, skipped = [], []
    for s in rows:
        name = s.name or f"Session {s.id}"
        out, why = _reduce(db, s)
        if out is None:
            skipped.append({"session_id": s.id, "session": name, "reason": why})
            continue
        reduced.append({**out, "session_id": s.id, "name": name, "kind": s.kind.value if s.kind else None})
    if not reduced:
        raise HTTPException(404, "No readable logger file in " + ("this session" if session else "this event"))
    reduced.sort(key=_when)
    series = ev.series if ev else None
    minimums, origin = minimum_rows(db, series)
    report = aggregate(reduced, [r for s in reduced for r in s["pressure_runs"]], minimums)
    report["scope"] = {"session": session, "event": event, "event_name": ev.name if ev else None, "series": series}
    report["minimums_origin"] = origin
    report["skipped"] = skipped
    return report
