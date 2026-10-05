"""Run sessions: logger uploads, lap lists, analysis and voice debriefs for one run."""
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, UploadFile
from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from app import models, schemas, storage
from app.analysis.laps import SessionData, TimingLine, analyze, compare_laps, load_session
from app.db import get_db
from app.importers.csvlog import CsvLog, read_csv_log, read_log
from app.importers.motec import LdFile, LdFormatError, read_ld, read_ldx_beacons
from app.known_tracks import fill_corners

router = APIRouter(prefix="/sessions")

# .csv and .txt are logger exports (MoTeC i2, AiM Race Studio, Pi Toolbox); the logger is read from the file
SUPPORTED = {".ld": "motec", ".ldx": "motec", ".csv": "csv", ".txt": "csv"}
LOG_FILES = (".ld", ".csv", ".txt")  # logs themselves; a .ldx only adds beacons to its .ld


def _get(db: Session, session_id: int) -> models.RunSession:
    s = db.get(models.RunSession, session_id)
    if s is None:
        raise HTTPException(404, "Session not found")
    return s


def _with_best(s: models.RunSession) -> dict:
    clean = [l.time_s for l in s.laps if l.clean]
    out = schemas.SessionDetail.model_validate(s).model_dump()
    out["best_lap_s"] = min(clean) if clean else None
    return out


@router.post("", response_model=schemas.SessionOut, status_code=201)
def create_session(body: schemas.SessionIn, db: Session = Depends(get_db)):
    s = models.RunSession(**body.model_dump())
    db.add(s)
    db.commit()
    return s


@router.get("", response_model=list[schemas.SessionOut])
def list_sessions(db: Session = Depends(get_db)):
    rows = db.scalars(select(models.RunSession).options(selectinload(models.RunSession.laps))
                      .order_by(models.RunSession.created_at.desc())).all()
    return [_with_best(s) for s in rows]


@router.get("/{session_id}", response_model=schemas.SessionDetail)
def get_session(session_id: int, db: Session = Depends(get_db)):
    return _with_best(_get(db, session_id))


@router.post("/{session_id}/files", response_model=schemas.SessionDetail, status_code=201)
def upload_file(session_id: int, file: UploadFile, db: Session = Depends(get_db)):
    """Upload a MoTeC .ld log, the .ldx i2 saved next to it (its beacons give exact lap times), or a CSV export
    from MoTeC i2, AiM Race Studio or Pi Toolbox."""
    s = _get(db, session_id)
    name = file.filename or ""
    ext = Path(name).suffix.lower()
    logger = SUPPORTED.get(ext)
    if logger is None:
        raise HTTPException(415, f"Unsupported file type '{ext}'. Supported now: MoTeC .ld and .ldx, "
                                 "and CSV exports from MoTeC i2, AiM Race Studio and Pi Toolbox (.csv, .txt)")
    raw = file.file.read()  # a plain def (run in a worker thread), so parsing a big log doesn't stall other requests
    if ext == ".ldx":
        return _attach_ldx(db, s, name, raw)
    try:
        ld = read_ld(raw) if ext == ".ld" else read_csv_log(raw)
        beacons = ld.beacons if isinstance(ld, CsvLog) and len(ld.beacons) >= 2 else None
        track = _track_for(db, s, ld)
        data = load_session(ld, _channel_map(s), beacons=beacons, line=_line(track))
    except (LdFormatError, ValueError) as e:
        raise HTTPException(422, str(e)) from e

    key = storage.save(raw, ext)
    meta = {"event": ld.event_name, "event_session": ld.event_session, "venue": ld.venue,
            "device_serial": ld.device_serial, "date": ld.date, "time": ld.time,
            "duration_s": round(ld.duration, 1), "channels": len(ld.channels), "mapped_channels": data.sources}
    if isinstance(ld, CsvLog):
        logger = ld.logger
        meta.update({"format": "csv", "layout": ld.layout, "driver": ld.driver, "vehicle": ld.vehicle})
        if beacons:
            meta["beacons"] = beacons
    rec = models.LoggerFile(session=s, logger=logger, filename=(name or key)[:255], path=key, meta=meta)
    db.add(rec)
    db.flush()
    _store_laps(db, s, rec, data, track)
    db.commit()
    db.refresh(s)
    return _with_best(s)


def _attach_ldx(db: Session, s: models.RunSession, name: str, raw: bytes) -> dict:
    try:
        beacons = read_ldx_beacons(raw)
    except LdFormatError as e:
        raise HTTPException(422, str(e)) from e
    stem = Path(name).stem.lower()
    logs = [f for f in s.files if f.filename.lower().endswith(".ld")]
    rec = next((f for f in logs if Path(f.filename).stem.lower() == stem), None) or (logs[-1] if logs else None)
    if rec is None:
        raise HTTPException(409, "Upload the .ld log first, then its .ldx")
    if len(beacons) >= 2:
        rec.meta = {**rec.meta, "beacons": beacons}
        ld = read_file(rec)
        track = _track_for(db, s, ld)
        _store_laps(db, s, rec, load_session(ld, _channel_map(s), beacons=beacons, line=_line(track)), track)
    db.commit()
    db.refresh(s)
    return _with_best(s)


def _store_laps(db: Session, s: models.RunSession, rec: models.LoggerFile, data: SessionData,
                track: models.Track | None) -> None:
    for old in [l for l in s.laps if l.file_id == rec.id]:
        s.laps.remove(old)
    db.flush()
    for lap in data.laps:
        db.add(models.Lap(session=s, file_id=rec.id, number=lap.number, time_s=lap.time,
                          start_s=lap.start, clean=lap.clean))
    rec.meta = {**rec.meta, "lap_source": data.lap_source}
    # learn the start/finish line from a log that has a lap marker, so later logs without one get GPS timing
    learnable = data.timing_line is not None and data.lap_source in ("beacons", "marker")
    if track is not None and track.timing_line is None and learnable:
        tl = data.timing_line
        track.timing_line = {"lat": tl.lat, "lon": tl.lon, "heading": tl.heading}
        _retime_counter_logs(db, track)


def _retime_counter_logs(db: Session, track: models.Track) -> None:
    """Logs from this track that only had the 1 Hz lap counter get GPS lap times now that the line is known."""
    for f in db.scalars(select(models.LoggerFile)).all():
        if f.meta.get("lap_source") != "counter":
            continue
        ld = read_file(f)
        if _track_for(db, f.session, ld) is not track:
            continue
        data = load_session(ld, _channel_map(f.session), beacons=f.meta.get("beacons"), line=_line(track))
        if data.lap_source == "gps":
            _store_laps(db, f.session, f, data, track)


def read_file(f: models.LoggerFile) -> LdFile:
    """An uploaded log, read from wherever it is stored."""
    return read_log(storage.local_path(f.path))


def _track_for(db: Session, s: models.RunSession, ld: LdFile) -> models.Track | None:
    """The session's track, or the one named in the log header (created if it's new)."""
    if s.event and s.event.track:
        return s.event.track
    venue = ld.venue[:120]  # as long as Track.name can be
    if not venue:
        return None
    track = db.scalar(select(models.Track).where(models.Track.name == venue))
    if track is None:
        track = models.Track(name=venue)
        fill_corners(track)
        db.add(track)
        db.flush()
    return track


def _line(track: models.Track | None) -> TimingLine | None:
    return TimingLine(**track.timing_line) if track and track.timing_line else None


def _channel_map(s: models.RunSession) -> dict[str, tuple[str, ...]] | None:
    if s.car and s.car.channel_map:
        return {role: tuple(names) for role, names in s.car.channel_map.items()}
    return None


def load_main_file(db: Session, s: models.RunSession,
                   file_id: int | None = None) -> tuple[models.LoggerFile, SessionData]:
    """The session's logger file to analyse: the one asked for, else the longest."""
    files = [f for f in s.files if file_id is None or f.id == file_id]
    if not files:
        raise HTTPException(404, "No logger file uploaded for this session")
    f = max(files, key=lambda f: f.meta.get("duration_s", 0))
    ld = read_file(f)
    track = _track_for(db, s, ld)
    return f, load_session(ld, _channel_map(s), beacons=f.meta.get("beacons"), line=_line(track))


@router.get("/{session_id}/analysis")
def session_analysis(session_id: int, file_id: int | None = None, reference_lap: int | None = None,
                     db: Session = Depends(get_db)):
    f, data = load_main_file(db, _get(db, session_id), file_id)
    return {"file_id": f.id, **analyze(data, reference_lap)}


@router.get("/{session_id}/compare")
def session_compare(session_id: int, lap: int, reference_lap: int | None = None, file_id: int | None = None,
                    step: float = 5.0, db: Session = Depends(get_db)):
    """Speed, throttle, brake and time delta of one lap against the reference lap, for charts."""
    f, data = load_main_file(db, _get(db, session_id), file_id)
    try:
        return {"file_id": f.id, **compare_laps(data, lap, reference_lap, max(1.0, min(step, 50.0)))}
    except ValueError as e:
        raise HTTPException(404, str(e)) from e
