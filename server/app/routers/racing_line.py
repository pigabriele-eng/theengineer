"""The racing line page: laps of a session (and of the event's other sessions) on one line, for the 3D lap."""
import gzip
import json
import threading
from collections import OrderedDict

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from sqlalchemy.orm import Session

from app import heavy, models
from app.analysis import racing_line as rl
from app.analysis.laps import DEFAULT_CHANNEL_MAP, load_session
from app.analysis.trackmap import NoGpsError as MapNoGps
from app.analysis.trackmap import NoLapError, track_map
from app.db import get_db
from app.routers.sessions import _channel_map, _get, _line, _track_for, official_corners, read_file
from app.routers.trackmap import _main_file

router = APIRouter()

MAX_LAPS = 4
CACHE_SIZE = 6  # about 150 KB each, compressed
_cache: OrderedDict[tuple, bytes] = OrderedDict()
_cache_lock = threading.Lock()


def _channels(s: models.RunSession) -> dict[str, tuple[str, ...]]:
    """The car's channel map cut down to what the line reads: the log's other channels are never read."""
    own = _channel_map(s) or {}
    return {role: tuple(own.get(role) or DEFAULT_CHANNEL_MAP[role]) if role in rl.LOG_ROLES else ()
            for role in {**DEFAULT_CHANNEL_MAP, **own}}


def _picks(laps: str | None, others: str | None, session_id: int) -> tuple[list[int] | None, list[tuple[int, int]]]:
    def number(v: str) -> int:
        try:
            return int(v)
        except ValueError:
            raise HTTPException(400, f"Not a lap number: {v}") from None

    own = [number(v) for v in laps.split(",") if v.strip()] if laps else None
    rest = []
    for part in (others or "").split(","):
        if not part.strip():
            continue
        sid, _, n = part.partition(":")
        if not n:
            raise HTTPException(400, f"Another session's lap is session:lap, not {part}")
        rest.append((number(sid), number(n)))
    rest = [(sid, n) for sid, n in rest if sid != session_id] + [(sid, n) for sid, n in rest if sid == session_id]
    return own, rest


def _driver(s: models.RunSession) -> str | None:
    return s.driver.name if s.driver else None


def _source(db: Session, s: models.RunSession) -> tuple[rl.Source, models.Track | None]:
    f = _main_file(s)
    if f is None:
        raise HTTPException(404, f"No logger file uploaded for {s.name or 'this session'}")
    ld = read_file(f)
    track = _track_for(db, s, ld)
    names = _channels(s)
    data = load_session(ld, names, beacons=f.meta.get("beacons"), line=_line(track))
    fixes = rl.gps_fixes(ld, names.get("lat") or DEFAULT_CHANNEL_MAP["lat"],
                         names.get("lon") or DEFAULT_CHANNEL_MAP["lon"])
    del ld
    heavy.trim()
    if fixes is None:
        raise HTTPException(422, f"{s.name or 'This session'}'s log has no GPS position, so its line can't be drawn")
    return rl.Source(s.id, s.name or f"Session {s.id}", data, fixes, _driver(s)), track


def _key(sessions: list[models.RunSession], own: list[int] | None, rest: list[tuple[int, int]]) -> tuple:
    parts = []
    for s in sessions:
        f = _main_file(s)
        parts.append((s.id, f.id if f else None, f.path if f else None, tuple(sorted((f.meta or {}).get(
            "lap_picks", {}).items())) if f else (), tuple((l.number, l.start_s, l.time_s, l.clean) for l in s.laps),
            tuple(sorted(_channels(s).items()))))
    track = sessions[0].event.track if sessions[0].event and sessions[0].event.track else None
    corners = tuple(official_corners(track) or ()) if track else ()
    return tuple(parts), tuple(own or ()), tuple(rest), corners


def _work(db: Session, s: models.RunSession, own: list[int] | None, rest: list[tuple[int, int]]) -> dict:
    primary, track = _source(db, s)
    numbers = own if own is not None else rl.default_laps(primary.data)
    known = {l.number for l in primary.data.laps}
    for n in numbers:
        if n not in known:
            raise HTTPException(404, f"No lap {n} in {primary.name}")
    picks: list[tuple[rl.Source, int]] = [(primary, n) for n in numbers]
    loaded: dict[int, rl.Source] = {s.id: primary}
    for sid, n in rest:
        if sid not in loaded:
            other = db.get(models.RunSession, sid)
            if other is None:
                raise HTTPException(404, f"Session {sid} not found")
            if s.event_id is None or other.event_id != s.event_id:
                raise HTTPException(400, "Laps from other sessions must be of the same event")
            loaded[sid] = _source(db, other)[0]
        src = loaded[sid]
        if n not in {l.number for l in src.data.laps}:
            raise HTTPException(404, f"No lap {n} in {src.name}")
        picks.append((src, n))
    try:
        m = track_map(primary.data, official_corners(track))
        out = rl.build(primary, picks, m["sections"], m["corners"], m["clockwise"])
    except (NoLapError, MapNoGps, rl.NoGpsError, ValueError) as e:
        raise HTTPException(422, str(e)) from e
    return {"session_id": s.id, "session_name": primary.name, "event_id": s.event_id, **out}


@router.get("/sessions/{session_id}/racing-line")
def get_racing_line(session_id: int, request: Request, laps: str | None = None, others: str | None = None,
                    db: Session = Depends(get_db)):
    """The session's laps on one racing line, for the 3D lap: the road the laps used, each lap's place on it (metres
    left or right of the session's quickest clean lap, every 2 m), its speed, pedals, steering, attitude and tyre
    loads, where it braked, turned in and picked up the throttle in each corner, what differs from the first lap in
    words, and how accurate the line is. laps: this session's lap numbers (default its two quickest clean laps);
    others: laps of the event's other sessions as session:lap. Up to 4 laps in all."""
    s = _get(db, session_id)
    own, rest = _picks(laps, others, session_id)
    if len(own or [None, None]) + len(rest) > MAX_LAPS:
        raise HTTPException(400, f"Up to {MAX_LAPS} laps at a time")
    sessions = [s, *(o for sid in dict.fromkeys(sid for sid, _ in rest)
                     if (o := db.get(models.RunSession, sid)) is not None)]
    key = _key(sessions, own, rest)
    with _cache_lock:
        body = _cache.get(key)
        if body is not None:
            _cache.move_to_end(key)
    if body is None:
        with heavy.lock:
            out = _work(db, s, own, rest)
        body = gzip.compress(json.dumps(out, separators=(",", ":")).encode(), 6)
        with _cache_lock:
            _cache[key] = body
            while len(_cache) > CACHE_SIZE:
                _cache.popitem(last=False)
    if "gzip" in request.headers.get("accept-encoding", ""):
        return Response(body, media_type="application/json", headers={"Content-Encoding": "gzip", "Vary":
                                                                       "Accept-Encoding"})
    return Response(gzip.decompress(body), media_type="application/json")
