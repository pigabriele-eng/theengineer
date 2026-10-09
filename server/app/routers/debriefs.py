"""Debriefs: typed points, and voice recordings that are transcribed and structured in the background."""
import json
from datetime import datetime
from pathlib import Path

from fastapi import APIRouter, BackgroundTasks, Depends, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from app import models, schemas, storage
from app.db import get_db
from app.analysis.laps import analyze
from app.debrief import inbox
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
                   language: str = Form("en"), live_transcript: str | None = Form(None),
                   db: Session = Depends(get_db)):
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
    live = _live(live_transcript)
    key = storage.save(audio.file.read(), ext)  # a plain def: storing may be a network call
    _keep_live(db, key, live)
    d = models.Debrief(session=s, mode=mode, language=language, audio_path=key, status=models.DebriefStatus.queued)
    db.add(d)
    db.commit()
    background.add_task(process_debrief, d.id)
    return schemas.DebriefOut.of(d)


def _live(text: str | None) -> list[dict] | None:
    """What the phone wrote down while recording: [{"start", "end", "text"}], seconds into the recording."""
    if not text:
        return None
    try:
        rows = json.loads(text)
        out = [{"start": round(float(r.get("start") or 0), 2), "end": round(float(r.get("end") or 0), 2),
                "text": str(r["text"]).strip()[:2000]} for r in rows if str(r.get("text") or "").strip()]
    except (ValueError, TypeError, KeyError, AttributeError):
        raise HTTPException(422, "Can't read what the phone wrote down while recording") from None
    return out[:2000] or None


def _keep_live(db: Session, key: str, live: list[dict] | None) -> None:
    if live:
        db.add(models.LiveTranscript(audio_path=key, segments=live))


def _when(text: str | None) -> datetime:
    """The recording's time as the phone gave it (local, no zone), else now on the server's clock."""
    if not text:
        return datetime.now()
    try:
        return datetime.fromisoformat(text).replace(tzinfo=None)
    except ValueError:
        raise HTTPException(422, f"Can't read the recording time '{text}'") from None


def _recording(db: Session, recording_id: int) -> models.DebriefRecording:
    rec = db.get(models.DebriefRecording, recording_id)
    if rec is None:
        raise HTTPException(404, "Recording not found")
    return rec


def _waiting_out(rec: models.DebriefRecording) -> dict:
    return {"id": rec.id, "recorded_at": rec.recorded_at.isoformat(timespec="seconds"), "mode": rec.mode,
            "language": rec.language, "filename": rec.filename}


@router.post("/debriefs/audio", status_code=202)
def record_for_last_run(audio: UploadFile, mode: models.DebriefMode = Form(models.DebriefMode.individual),
                        language: str = Form("en"), recorded_at: str | None = Form(None),
                        live_transcript: str | None = Form(None), db: Session = Depends(get_db)):
    """A recording for the run that ended just before it (debrief/inbox.py): it joins that run now if its log is
    in, else waits and joins it after the upload that brings it. recorded_at: when the recording started, local
    time on the phone ("2026-10-09T14:32:05"); now when not given.

    Returns {"debrief": the debrief, when it joined a run} or {"waiting": the recording}.
    """
    ext = Path(audio.filename or "").suffix.lower()
    if ext not in AUDIO:
        raise HTTPException(415, f"Unsupported audio type '{ext}'. Supported: {', '.join(sorted(AUDIO))}")
    if language not in LANGUAGES:
        raise HTTPException(422, f"Language must be one of {', '.join(LANGUAGES)}")
    when = _when(recorded_at)
    live = _live(live_transcript)
    key = storage.save(audio.file.read(), ext)
    _keep_live(db, key, live)
    rec = models.DebriefRecording(audio_path=key, filename=(audio.filename or "")[:255] or None, mode=mode,
                                  language=language, recorded_at=when)
    db.add(rec)
    db.commit()
    d = inbox.place(db, rec)
    return {"debrief": schemas.DebriefOut.of(d)} if d is not None else {"waiting": _waiting_out(rec)}


@router.get("/debriefs/waiting")
def waiting_recordings(db: Session = Depends(get_db)):
    """Recordings no run has been found for yet, newest first."""
    recs = db.scalars(select(models.DebriefRecording).where(models.DebriefRecording.debrief_id.is_(None))
                      .order_by(models.DebriefRecording.recorded_at.desc())).all()
    return [_waiting_out(r) for r in recs]


class RunPick(BaseModel):
    session_id: int


@router.post("/debriefs/waiting/{recording_id}/run", response_model=schemas.DebriefOut)
def pick_run_for_recording(recording_id: int, body: RunPick, db: Session = Depends(get_db)):
    """The user picks the run a waiting recording goes with: it becomes that run's debrief and is processed."""
    rec = _recording(db, recording_id)
    return schemas.DebriefOut.of(inbox.link(db, rec, get_session(db, body.session_id), "user"))


@router.delete("/debriefs/waiting/{recording_id}")
def delete_waiting_recording(recording_id: int, db: Session = Depends(get_db)):
    """A waiting recording the user doesn't want: it and its audio go. One that joined a run stays with it."""
    rec = _recording(db, recording_id)
    if rec.debrief_id is not None:
        raise HTTPException(409, "This recording is a debrief of a run already")
    key = rec.audio_path
    db.delete(rec)
    db.commit()
    try:
        storage.delete(key)
    except Exception:  # a file left behind is harmless
        pass
    return {"deleted": recording_id}


@router.post("/debriefs/{debrief_id}/run", response_model=schemas.DebriefOut)
def set_debrief_run(debrief_id: int, body: RunPick, db: Session = Depends(get_db)):
    """Confirms the run a debrief joined by time (the same run), or moves the debrief to another one. Either way it
    stays there: a later upload no longer moves it."""
    d = _get(db, debrief_id)
    s = get_session(db, body.session_id)
    rec = d.recording
    if rec is None:  # recorded or typed for a picked run: a plain move
        if d.session_id != s.id:
            inbox.move(db, d, s)
    elif d.session_id == s.id:
        rec.confirmed = True
        db.commit()
    else:
        inbox.link(db, rec, s, "user")
    db.refresh(d)
    return schemas.DebriefOut.of(d)


@router.get("/sessions/{session_id}/debriefs", response_model=list[schemas.DebriefOut])
def list_debriefs(session_id: int, db: Session = Depends(get_db)):
    return [schemas.DebriefOut.of(d) for d in get_session(db, session_id).debriefs]


@router.get("/debriefs/{debrief_id}", response_model=schemas.DebriefOut)
def get_debrief(debrief_id: int, db: Session = Depends(get_db)):
    return schemas.DebriefOut.of(_get(db, debrief_id))


@router.post("/debriefs/{debrief_id}/process", response_model=schemas.DebriefOut, status_code=202)
def reprocess_debrief(debrief_id: int, background: BackgroundTasks, language: str | None = None,
                      db: Session = Depends(get_db)):
    """Runs the recording through speech to text and sorting again; ?language= redoes it in another language (an
    older debrief sent as English that was spoken in Italian or mixed)."""
    d = _get(db, debrief_id)
    if language is not None and language not in LANGUAGES:
        raise HTTPException(422, f"Language must be one of {', '.join(LANGUAGES)}")
    if d.audio_path is None:
        raise HTTPException(409, "This debrief has no recording")
    if d.status == models.DebriefStatus.processing:
        raise HTTPException(409, "This debrief is already being processed")
    if language is not None:
        d.language = language
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
