"""The stint tool: the logs to choose from, the stint analysis of the ones ticked, and the lap tags.

Each log is reduced once (analysis/stint.reduce_run, a few seconds and under 150 MB while it runs, under the server's
heavy-work lock, one log at a time) and the reduction (about 1 MB) is kept in memory, so ticking another log reads
only that one, and tagging a lap answers at once.
"""
from __future__ import annotations

import threading
from collections import OrderedDict

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from app import heavy, models, page_cache
from app.analysis.balance import car_geometry
from app.analysis.fuel import FUEL_DENSITY
from app.analysis.insights import RunInput
from app.analysis.laps import load_session
from app.analysis.stint import COUNT_TAG, PIT_NOT_COUNTED, ROLES, VERSION, LogSummary, assemble, reduce_run
from app.db import get_db
from app.laptags import TAGS, LapTag, set_tag, tag_row, tags_for_files, to_dict
from app.routers.balance import preset_for
from app.routers.drivers import main_file, session_track
from app.routers.sessions import _channel_map, _get, _line, _track_for, official_corners, read_file
from app.setup.models import SessionSetup
from app.setup.sheet import VEHICLE_LINKS
from app.timing import picks_part
from app.vehicle.presets import preset_detail

router = APIRouter()

MAX_LOGS = 12  # ticked in one view of the stint tool (an event's main logs, for the report, may be more)
CACHE_BYTES = 48 * 1024**2
_cache: OrderedDict[tuple, LogSummary] = OrderedDict()
_cache_lock = threading.Lock()  # guards the cache only; reading logs runs under app.heavy.lock
# in the signature of an event's view: the ones kept before it read every main log (a refusal over 12 logs) are
# worked out again
EVENT_VIEW = "every main log"


def _cached(key: tuple) -> LogSummary | None:
    with _cache_lock:
        hit = _cache.get(key)
        if hit is not None:
            _cache.move_to_end(key)
        return hit


def _keep(key: tuple, log: LogSummary) -> None:
    with _cache_lock:
        _cache[key] = log
        while len(_cache) > 1 and sum(x.nbytes() for x in _cache.values()) > CACHE_BYTES:
            _cache.popitem(last=False)


def _car(db: Session, s: models.RunSession) -> tuple[str | None, tuple[float, str], float]:
    """The car's preset, its mass with driver and fuel (from the session's setup sheet when it says), and the fuel's
    density."""
    preset = preset_for([s.car] if s.car else [])
    link = VEHICLE_LINKS.get(preset) if preset else None
    density = link.fuel_density if link else FUEL_DENSITY
    sheet = db.scalar(select(SessionSetup).where(SessionSetup.session_id == s.id))
    values = sheet.values if sheet else {}
    if link is not None and (values.get("fuel") is not None or values.get("ballast") is not None):
        detail = preset_detail(preset)
        base = float(detail["values"]["mass_kg"]["value"])
        ballast = values.get("ballast") if values.get("ballast") is not None else link.default_ballast_kg
        fuel = values.get("fuel")
        if fuel is None:
            fuel = (base - link.base_mass_kg - link.default_ballast_kg - link.driver_kg) / link.fuel_density
        mass = link.base_mass_kg + ballast + link.driver_kg + fuel * link.fuel_density
        return preset, (mass, f"the setup sheet ({fuel:g} L fuel, {ballast:g} kg ballast), driver "
                              f"{link.driver_kg:g} kg"), density
    if preset is not None:
        detail = preset_detail(preset)
        return preset, (float(detail["values"]["mass_kg"]["value"]),
                        f"the {detail['name']} car data (an estimate with driver and about 40 kg fuel)"), density
    return None, (1635.0, "a GT4 estimate with driver and fuel (no car data)"), density


def _signature(f: models.LoggerFile, s: models.RunSession, preset: str | None, mass: tuple[float, str]) -> tuple:
    """Changes when the log is replaced, its laps are timed again or the car's values change."""
    laps = tuple((l.number, round(l.start_s, 2), round(l.time_s, 3), l.clean) for l in s.laps if l.file_id == f.id)
    return (VERSION, f.id, f.path, laps, s.car_id, preset, round(mass[0], 1), s.name, *map(str, picks_part(f)))


def _label(s: models.RunSession, f: models.LoggerFile) -> str:
    name = s.name or f"Session {s.id}"
    return name if len(s.files) <= 1 else f"{name} · {f.filename}"


def reduced(db: Session, f: models.LoggerFile) -> tuple[LogSummary, models.Track | None]:
    """The log reduced for the stint view: from memory when it has been read already."""
    s = f.session
    preset, mass, density = _car(db, s)
    key = _signature(f, s, preset, mass)
    hit = _cached(key)
    if hit is not None:
        return hit, session_track(db, s)
    with heavy.lock:  # one log-reading job at a time across the server
        hit = _cached(key)  # read while this request waited its turn
        if hit is not None:
            return hit, session_track(db, s)
        ld = read_file(f)
        track = _track_for(db, s, ld)
        data = load_session(ld, _channel_map(s), beacons=f.meta.get("beacons"), line=_line(track), roles=ROLES)
        run = RunInput(_label(s, f), data, s.driver.name if s.driver else None,
                       {"session_id": s.id, "file_id": f.id, "session": s.name or f"Session {s.id}",
                        "filename": f.filename}, ld)
        geo = car_geometry(preset_detail(preset) if preset else None)
        log = reduce_run(run, official_corners(track), geo, mass, density)
        del run, data, ld
    _keep(key, log)
    return log, track


def stint_view(db: Session, file_ids: list[int]) -> dict | page_cache.RawJSON:
    """The stints of the logs. Two views are kept once worked out (app/page_cache.py), with their lap tags in their
    signature, and sent as the JSON they are kept as: one log's (the session page's) and an event's main logs together
    (the report's quick laps). The event's view reads every main log, however many: a race weekend has twenty or
    more, and its logs are read one at a time and kept reduced (about 1 MB each), so the number of logs doesn't add to
    the memory a read takes."""
    ids = list(dict.fromkeys(file_ids))
    files = [db.get(models.LoggerFile, i) for i in ids]
    if ids and None not in files:
        if len(files) == 1:
            f = files[0]
            return page_cache.RawJSON(page_cache.cached(
                db, f"session:{f.session_id}|stint|file:{f.id}", lambda: _view_signature(db, f),
                lambda: _stint_view(db, ids), locked=False, raw=True))
        events = {f.session.event_id for f in files}
        if len(events) == 1 and None not in events:
            mains = event_files(db, (eid := events.pop()))
            if sorted(ids) == mains:
                return page_cache.RawJSON(page_cache.cached(
                    db, f"event:{eid}|stint",
                    lambda: page_cache.signature("stint", sorted(_view_signature(db, f) for f in files), EVENT_VIEW),
                    lambda: _stint_view(db, ids, limit=False), locked=False, raw=True))
            if set(ids) <= set(mains):  # some of them: the report's list of an event a moment old, say
                return _stint_view(db, ids, limit=False)
    return _stint_view(db, ids)


def event_files(db: Session, event_id: int) -> list[int]:
    """The logs the report's quick laps read for an event (the app asks for these): each session's main log, when
    it has laps."""
    out = []
    for s in db.scalars(select(models.RunSession).where(models.RunSession.event_id == event_id)):
        f = main_file(s)
        if f is not None and any(l.file_id == f.id for l in s.laps):
            out.append(f.id)
    return sorted(out)


def _view_signature(db: Session, f: models.LoggerFile) -> str:
    s = f.session
    preset, mass, density = _car(db, s)
    track = session_track(db, s)
    return page_cache.session_signature(db, "stint", s, f, preset, mass, density, s.car_id, len(s.files),
                                        f.filename, track.name if track else None,
                                        sorted(tags_for_files(db, [f.id]).get(f.id, {}).items()))


def _stint_view(db: Session, file_ids: list[int], limit: bool = True) -> dict:
    ids = list(dict.fromkeys(file_ids))
    if not ids:
        raise HTTPException(422, "Tick at least one log")
    if limit and len(ids) > MAX_LOGS:
        raise HTTPException(422, f"Tick at most {MAX_LOGS} logs at once")
    files = []
    for fid in ids:
        f = db.get(models.LoggerFile, fid)
        if f is None:
            raise HTTPException(404, f"Log {fid} not found")
        files.append(f)
    tracks = {}
    for f in files:
        t = session_track(db, f.session)
        tracks[t.id if t else None] = t
    if len(set(tracks) - {None}) > 1:
        raise HTTPException(422, "These logs are from different tracks; tick logs from one track")
    files.sort(key=lambda f: (f.session_id, f.id))
    logs = [reduced(db, f)[0] for f in files]
    tags = {(str(fid), lap): tag for fid, laps in tags_for_files(db, [f.id for f in files]).items()
            for lap, tag in laps.items()}
    out = assemble(logs, tags)
    track = next((t for t in tracks.values() if t is not None), None)
    out["track"] = track.name if track else None
    out["file_ids"] = [f.id for f in files]
    return out


@router.get("/stint")
def stint(files: str = Query(..., description="Logger file ids, comma-separated"), db: Session = Depends(get_db)):
    """The stints of the ticked logs, lap by lap: grip and balance per phase, the driver's inputs, fuel burn and tyre
    fade apart, the fade split by phase, suggested and tagged slow laps, and what it says in plain words."""
    try:
        ids = [int(x) for x in files.split(",") if x.strip()]
    except ValueError as e:
        raise HTTPException(422, "files: comma-separated log ids") from e
    return stint_view(db, ids)


@router.get("/sessions/{session_id}/stint")
def session_stint(session_id: int, db: Session = Depends(get_db)):
    """The stints of a session's main log (the longest)."""
    f = main_file(_get(db, session_id))
    if f is None:
        raise HTTPException(404, f"No logger file uploaded for session {session_id}")
    return stint_view(db, [f.id])


@router.get("/stint/logs")
def stint_logs(db: Session = Depends(get_db)):
    """Every log to choose from, by event and session (newest event first), with its laps and best lap."""
    sessions = db.scalars(select(models.RunSession).options(
        selectinload(models.RunSession.files), selectinload(models.RunSession.laps),
        selectinload(models.RunSession.event).selectinload(models.Event.track))).all()
    events: dict[int | None, dict] = {}
    for s in sessions:
        ev = s.event
        e = events.setdefault(ev.id if ev else None, {
            "id": ev.id if ev else None, "name": ev.name if ev else "Sessions without an event",
            "track": ev.track.name if ev and ev.track else None,
            "date": ev.date.isoformat() if ev and ev.date else None, "sessions": [], "_newest": s.created_at})
        e["_newest"] = max(e["_newest"], s.created_at)
        files = []
        for f in sorted(s.files, key=lambda f: f.id):
            laps = [l for l in s.laps if l.file_id == f.id]
            clean = [l.time_s for l in laps if l.clean]
            files.append({"id": f.id, "filename": f.filename, "duration_s": f.meta.get("duration_s"),
                          "laps": len(laps), "clean_laps": len(clean), "best_lap_s": min(clean) if clean else None,
                          "main": len(s.files) == 1 or f is main_file(s)})
        e["sessions"].append({"id": s.id, "name": s.name or f"Session {s.id}",
                              "driver": s.driver.name if s.driver else None, "files": files})
    out = sorted(events.values(), key=lambda e: (e["id"] is not None, e["date"] or "", e["_newest"]), reverse=True)
    for e in out:
        del e["_newest"]
        e["sessions"].sort(key=lambda s: (s["name"].lower(), s["id"]))
    return {"events": out}


class TagIn(BaseModel):
    file_id: int
    lap: int
    tag: str


@router.get("/lap-tags")
def list_tags(session_id: int | None = None, file_id: int | None = None, db: Session = Depends(get_db)):
    """The lap tags of a session or a log."""
    if (session_id is None) == (file_id is None):
        raise HTTPException(422, "Give either ?session_id=<id> or ?file_id=<id>")
    q = select(LapTag).where(LapTag.session_id == session_id if session_id is not None else LapTag.file_id == file_id)
    return [to_dict(r) for r in db.scalars(q.order_by(LapTag.file_id, LapTag.lap)).all()]


@router.put("/lap-tags")
def put_tag(body: TagIn, db: Session = Depends(get_db)):
    """Tag a lap: sc (safety car), fcy, traffic, none (looked at: no reason to leave it out), or count (the lap joins
    the stint's trends although the analysis leaves it out: an out-lap, in-lap, slow lap or outlier; not a pit lap)."""
    if body.tag not in TAGS:
        raise HTTPException(422, f"tag: one of {', '.join(TAGS)}")
    f = db.get(models.LoggerFile, body.file_id)
    if f is None:
        raise HTTPException(404, "Log not found")
    lap = db.scalar(select(models.Lap).where(models.Lap.file_id == f.id, models.Lap.number == body.lap))
    if lap is None:
        raise HTTPException(404, f"No lap {body.lap} in this log")
    if body.tag == COUNT_TAG:
        # where the stops are comes from the log's reduction (in memory once the stint view has read the log)
        log, _ = reduced(db, f)
        if any(l.number == lap.number and l.kind == "pit" for l in log.laps):
            raise HTTPException(422, PIT_NOT_COUNTED)
    row = set_tag(db, f.id, f.session_id, lap, body.tag)
    db.commit()
    return to_dict(row)


@router.delete("/lap-tags", status_code=204)
def delete_tag(file_id: int, lap: int, db: Session = Depends(get_db)):
    """Clear a lap's tag (its suggestion, if any, comes back)."""
    timed = db.scalar(select(models.Lap).where(models.Lap.file_id == file_id, models.Lap.number == lap))
    row = (tag_row(db, file_id, timed) if timed is not None
           else db.scalar(select(LapTag).where(LapTag.file_id == file_id, LapTag.lap == lap)))
    if row is not None:
        db.delete(row)
        db.commit()
