"""Track maps: a session's or an event's reference lap drawn with its corners, sections and start/finish line."""
import threading
from collections import OrderedDict

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from app import heavy, models
from app.analysis.laps import DEFAULT_CHANNEL_MAP, load_session
from app.analysis.trackmap import MAP_ROLES, NoGpsError, NoLapError, track_map
from app.db import get_db
from app.routers.sessions import _channel_map, _get, _line, _track_for, official_corners, read_file

router = APIRouter()

CACHE_SIZE = 32  # maps are about 30 KB each
_cache: OrderedDict[tuple, dict] = OrderedDict()
_cache_lock = threading.Lock()


def _main_file(s: models.RunSession) -> models.LoggerFile | None:
    """The log the analysis reads for a session: the longest."""
    return max(s.files, key=lambda f: f.meta.get("duration_s", 0)) if s.files else None


def _map_channels(s: models.RunSession) -> dict[str, tuple[str, ...]]:
    """The car's channel map cut down to speed and GPS: a map needs nothing else, so the log's other channels
    are never read into memory. Laps and distance come out exactly as the analysis has them."""
    own = _channel_map(s) or {}
    return {role: tuple(own.get(role) or DEFAULT_CHANNEL_MAP[role]) if role in MAP_ROLES else ()
            for role in {**DEFAULT_CHANNEL_MAP, **own}}


def _key(s: models.RunSession, f: models.LoggerFile, track: models.Track | None, reference_lap: int | None) -> tuple:
    """Everything the map depends on: the log, its laps as stored (they change when the line is learned and the
    log is timed again), the track's corners and line, and the car's speed and GPS channels."""
    laps = tuple((l.number, l.start_s, l.time_s, l.clean) for l in s.laps if l.file_id == f.id)
    corners = tuple(official_corners(track) or ())
    line = tuple(sorted((track.timing_line or {}).items())) if track else ()
    channels = tuple(sorted((r, v) for r, v in _map_channels(s).items() if v))
    return (f.id, f.path, tuple(f.meta.get("beacons") or ()), laps, track.id if track else None, corners, line,
            channels, reference_lap)


def _known_track(db: Session, s: models.RunSession, f: models.LoggerFile) -> models.Track | None:
    """The track _track_for would find, without opening the log: so a cached map is served without reading it."""
    if s.event and s.event.track:
        return s.event.track
    venue = (f.meta.get("venue") or "")[:120]
    return db.scalar(select(models.Track).where(models.Track.name == venue)) if venue else None


def session_map(db: Session, s: models.RunSession, reference_lap: int | None = None) -> dict:
    f = _main_file(s)
    if f is None:
        raise HTTPException(404, "No logger file uploaded for this session")
    key = _key(s, f, _known_track(db, s, f), reference_lap)
    with _cache_lock:
        if key in _cache:
            _cache.move_to_end(key)
            return _cache[key]
    with heavy.lock:
        ld = read_file(f)
        track = _track_for(db, s, ld)
        data = load_session(ld, _map_channels(s), beacons=f.meta.get("beacons"), line=_line(track))
        del ld
        try:
            out = {"session_id": s.id, "session_name": s.name, "file_id": f.id,
                   **track_map(data, official_corners(track), reference_lap)}
        except NoLapError as e:
            raise HTTPException(404, str(e)) from e
        except NoGpsError as e:
            raise HTTPException(422, str(e)) from e
    with _cache_lock:
        _cache[_key(s, f, track, reference_lap)] = out
        while len(_cache) > CACHE_SIZE:
            _cache.popitem(last=False)
    return out


@router.get("/sessions/{session_id}/map")
def get_session_map(session_id: int, reference_lap: int | None = None, db: Session = Depends(get_db)):
    """The track drawn from the session's reference lap (its best clean lap unless reference_lap is given), in
    metres east (x) and north (y), one point every 5 m from the start/finish line, with the lap's speed, the
    line and the direction of travel, and the corners and sections exactly as the analysis numbers them."""
    return session_map(db, _get(db, session_id), reference_lap)


@router.get("/events/{event_id}/map")
def get_event_map(event_id: int, db: Session = Depends(get_db)):
    """The track drawn from the event's fastest clean lap, the reference lap the event's insights use."""
    if db.get(models.Event, event_id) is None:
        raise HTTPException(404, "Event not found")
    best: tuple[float, models.RunSession] | None = None
    for s in db.scalars(select(models.RunSession).where(models.RunSession.event_id == event_id)).all():
        f = _main_file(s)
        times = [l.time_s for l in s.laps if f is not None and l.file_id == f.id and l.clean]
        if times and (best is None or min(times) < best[0]):
            best = (min(times), s)
    if best is None:
        raise HTTPException(404, "No clean lap in this event to draw the track from")
    return session_map(db, best[1])
