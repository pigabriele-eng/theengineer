"""Run sessions: logger uploads, lap lists, analysis and voice debriefs for one run."""
import uuid
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, UploadFile
from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from app import models, schemas
from app.analysis.laps import analyze, compare_laps, load_session
from app.db import STORAGE_DIR, get_db
from app.importers.motec import LdFormatError, read_ld

router = APIRouter(prefix="/sessions")

SUPPORTED = {".ld": "motec"}


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
async def upload_file(session_id: int, file: UploadFile, db: Session = Depends(get_db)):
    s = _get(db, session_id)
    ext = Path(file.filename or "").suffix.lower()
    logger = SUPPORTED.get(ext)
    if logger is None:
        raise HTTPException(415, f"Unsupported file type '{ext}'. Supported now: MoTeC .ld")
    raw = await file.read()
    try:
        ld = read_ld(raw)
        data = load_session(ld, _channel_map(s))
    except (LdFormatError, ValueError) as e:
        raise HTTPException(422, str(e)) from e

    STORAGE_DIR.mkdir(parents=True, exist_ok=True)
    path = STORAGE_DIR / f"{uuid.uuid4().hex}{ext}"
    path.write_bytes(raw)
    rec = models.LoggerFile(
        session=s, logger=logger, filename=file.filename or path.name, path=str(path),
        meta={"event": ld.event_name, "device_serial": ld.device_serial, "date": ld.date,
              "time": ld.time, "duration_s": round(ld.duration, 1), "channels": len(ld.channels),
              "mapped_channels": data.sources},
    )
    db.add(rec)
    db.flush()
    for lap in data.laps:
        db.add(models.Lap(session=s, file_id=rec.id, number=lap.number, time_s=lap.time,
                          start_s=lap.start, clean=lap.clean))
    db.commit()
    db.refresh(s)
    return _with_best(s)


def _channel_map(s: models.RunSession) -> dict[str, tuple[str, ...]] | None:
    if s.car and s.car.channel_map:
        return {role: tuple(names) for role, names in s.car.channel_map.items()}
    return None


@router.get("/{session_id}/analysis")
def session_analysis(session_id: int, file_id: int | None = None, reference_lap: int | None = None,
                     db: Session = Depends(get_db)):
    s = _get(db, session_id)
    files = [f for f in s.files if file_id is None or f.id == file_id]
    if not files:
        raise HTTPException(404, "No logger file uploaded for this session")
    f = max(files, key=lambda f: f.meta.get("duration_s", 0))
    data = load_session(read_ld(f.path), _channel_map(s))
    return {"file_id": f.id, **analyze(data, reference_lap)}


@router.get("/{session_id}/compare")
def session_compare(session_id: int, lap: int, reference_lap: int | None = None, file_id: int | None = None,
                    step: float = 5.0, db: Session = Depends(get_db)):
    """Speed, throttle, brake and time delta of one lap against the reference lap, for charts."""
    s = _get(db, session_id)
    files = [f for f in s.files if file_id is None or f.id == file_id]
    if not files:
        raise HTTPException(404, "No logger file uploaded for this session")
    f = max(files, key=lambda f: f.meta.get("duration_s", 0))
    data = load_session(read_ld(f.path), _channel_map(s))
    try:
        return {"file_id": f.id, **compare_laps(data, lap, reference_lap, max(1.0, min(step, 50.0)))}
    except ValueError as e:
        raise HTTPException(404, str(e)) from e
