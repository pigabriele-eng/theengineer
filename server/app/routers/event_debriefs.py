"""The debriefs of an event's runs in one call, for the race weekend page's Debriefs list: one line per run, so the
page needn't ask once per run. Light: no transcript, no points, only what the line says."""
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app import models
from app.db import get_db

router = APIRouter()


def state_of(status: models.DebriefStatus, has_transcript: bool, points: int) -> str:
    """What the weekend page says of a debrief: 'ready' once its transcript or points are there, 'failed' when
    processing failed (the recording is kept), else 'recorded' (saved, being transcribed)."""
    if status == models.DebriefStatus.ready and (has_transcript or points):
        return "ready"
    if status == models.DebriefStatus.failed:
        return "failed"
    return "recorded"


@router.get("/events/{event_id}/debriefs")
def event_debriefs(event_id: int, db: Session = Depends(get_db)):
    """Every debrief of the event's runs, newest first: its id, run, state ('recorded', 'ready', 'failed'), whether it
    has a recording, how many points it holds and when it was made."""
    if db.get(models.Event, event_id) is None:
        raise HTTPException(404, "Event not found")
    points = (select(models.DebriefPoint.debrief_id, func.count(models.DebriefPoint.id).label("n"))
              .group_by(models.DebriefPoint.debrief_id).subquery())
    rows = db.execute(
        select(models.Debrief.id, models.Debrief.session_id, models.Debrief.status, models.Debrief.created_at,
               models.Debrief.transcript.is_not(None), models.Debrief.audio_path.is_not(None),
               func.coalesce(points.c.n, 0))
        .join(models.RunSession, models.RunSession.id == models.Debrief.session_id)
        .outerjoin(points, points.c.debrief_id == models.Debrief.id)
        .where(models.RunSession.event_id == event_id)
        .order_by(models.Debrief.created_at.desc(), models.Debrief.id.desc())
    ).all()
    return [{"id": i, "session_id": s, "state": state_of(status, bool(text), int(n)), "has_audio": bool(audio),
             "points": int(n), "created_at": at}
            for i, s, status, at, text, audio, n in rows]
