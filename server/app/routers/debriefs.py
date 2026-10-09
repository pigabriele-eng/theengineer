"""Debriefs: typed points, and voice recordings that are transcribed and structured in the background."""
from pathlib import Path

from fastapi import APIRouter, BackgroundTasks, Depends, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session

from app import models, schemas, storage
from app.db import get_db
from app.analysis.laps import analyze
from app.debrief.corners import corner_data
from app.debrief.pipeline import process_debrief
from app.debrief.transcribe import LANGUAGES
from app.heavy import one_at_a_time
from app.routers.sessions import _get as get_session
from app.routers.sessions import load_main_file, official_corners

router = APIRouter()
# The recording is played by URL, where the app can't set headers: its sign-in may come as ?access_token=
media_router = APIRouter()

# Recordings Deepgram reads, phone voice notes included: WhatsApp's .opus, Android's .amr and .3gp, .weba from a
# browser, .m4b (an .m4a by another name)
AUDIO = {".m4a", ".mp3", ".wav", ".webm", ".weba", ".ogg", ".opus", ".aac", ".caf", ".mp4", ".m4b", ".flac", ".amr",
         ".3gp"}


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
def record_debrief(session_id: int, audio: UploadFile, background: BackgroundTasks,
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
    key = storage.save(audio.file.read(), ext)  # a plain def: storing may be a network call
    d = models.Debrief(session=s, mode=mode, language=language, audio_path=key, status=models.DebriefStatus.queued)
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


@media_router.get("/debriefs/{debrief_id}/audio")
def debrief_audio(debrief_id: int, db: Session = Depends(get_db)):
    d = _get(db, debrief_id)
    try:
        path = storage.local_path(d.audio_path) if d.audio_path else None
    except FileNotFoundError:
        path = None
    if path is None:
        raise HTTPException(404, "No recording for this debrief")
    return FileResponse(path)


@router.get("/debriefs/{debrief_id}/corners")
@one_at_a_time
def debrief_corners(debrief_id: int, db: Session = Depends(get_db)):
    """Logged data for each corner the debrief mentions, keyed by the corner as tagged on the points."""
    d = _get(db, debrief_id)
    s = d.session
    if not s.files or not any(p.corner_code for p in d.points):
        return {"corners": {}}
    f, data, track = load_main_file(db, s)
    analysis = analyze(data, corners=official_corners(track))
    return {"file_id": f.id, "reference_lap": analysis.get("reference_lap"),
            "corners": corner_data(d.points, analysis)}
