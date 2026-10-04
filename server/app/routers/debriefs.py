"""Debriefs: typed points, and voice recordings that are transcribed and structured in the background."""
import uuid
from pathlib import Path

from fastapi import APIRouter, BackgroundTasks, Depends, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session

from app import models, schemas
from app.db import STORAGE_DIR, get_db
from app.debrief.pipeline import process_debrief
from app.debrief.transcribe import LANGUAGES
from app.routers.sessions import _get as get_session

router = APIRouter()

AUDIO = {".m4a", ".mp3", ".wav", ".webm", ".ogg", ".aac", ".caf", ".mp4", ".flac"}


def _get(db: Session, debrief_id: int) -> models.Debrief:
    d = db.get(models.Debrief, debrief_id)
    if d is None:
        raise HTTPException(404, "Debrief not found")
    return d


@router.post("/sessions/{session_id}/debriefs", response_model=schemas.DebriefOut, status_code=201)
def create_debrief(session_id: int, body: schemas.DebriefIn, db: Session = Depends(get_db)):
    s = get_session(db, session_id)
    d = models.Debrief(session=s, mode=body.mode, language=body.language, transcript=body.transcript,
                       points=[models.DebriefPoint(**p.model_dump()) for p in body.points])
    db.add(d)
    db.commit()
    return schemas.DebriefOut.of(d)


@router.post("/sessions/{session_id}/debriefs/audio", response_model=schemas.DebriefOut, status_code=202)
async def record_debrief(session_id: int, audio: UploadFile, background: BackgroundTasks,
                         mode: models.DebriefMode = Form(models.DebriefMode.individual),
                         language: str = Form("en"), db: Session = Depends(get_db)):
    """Saves the recording first, then transcribes and structures it in the background.

    If processing fails (for example the API keys are not set yet), the recording is kept and
    POST /debriefs/{id}/process runs it again.
    """
    s = get_session(db, session_id)
    ext = Path(audio.filename or "").suffix.lower()
    if ext not in AUDIO:
        raise HTTPException(415, f"Unsupported audio type '{ext}'. Supported: {', '.join(sorted(AUDIO))}")
    if language not in LANGUAGES:
        raise HTTPException(422, f"Language must be one of {', '.join(LANGUAGES)}")
    STORAGE_DIR.mkdir(parents=True, exist_ok=True)
    path = STORAGE_DIR / f"{uuid.uuid4().hex}{ext}"
    path.write_bytes(await audio.read())
    d = models.Debrief(session=s, mode=mode, language=language, audio_path=str(path),
                       status=models.DebriefStatus.queued)
    db.add(d)
    db.commit()
    background.add_task(process_debrief, d.id)
    return schemas.DebriefOut.of(d)


@router.get("/sessions/{session_id}/debriefs", response_model=list[schemas.DebriefOut])
def list_debriefs(session_id: int, db: Session = Depends(get_db)):
    return [schemas.DebriefOut.of(d) for d in get_session(db, session_id).debriefs]


@router.get("/debriefs/{debrief_id}", response_model=schemas.DebriefOut)
def get_debrief(debrief_id: int, db: Session = Depends(get_db)):
    return schemas.DebriefOut.of(_get(db, debrief_id))


@router.post("/debriefs/{debrief_id}/process", response_model=schemas.DebriefOut, status_code=202)
def reprocess_debrief(debrief_id: int, background: BackgroundTasks, db: Session = Depends(get_db)):
    d = _get(db, debrief_id)
    if d.audio_path is None:
        raise HTTPException(409, "This debrief has no recording")
    if d.status == models.DebriefStatus.processing:
        raise HTTPException(409, "This debrief is already being processed")
    d.status, d.error = models.DebriefStatus.queued, None
    db.commit()
    background.add_task(process_debrief, d.id)
    return schemas.DebriefOut.of(d)


@router.get("/debriefs/{debrief_id}/audio")
def debrief_audio(debrief_id: int, db: Session = Depends(get_db)):
    d = _get(db, debrief_id)
    if d.audio_path is None or not Path(d.audio_path).exists():
        raise HTTPException(404, "No recording for this debrief")
    return FileResponse(d.audio_path)
