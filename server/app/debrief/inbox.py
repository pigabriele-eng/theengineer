"""Debriefs recorded before their run is in: straight out of the car, before the log is downloaded and uploaded.

The recording is kept as a DebriefRecording with the time it was recorded (the phone's clock, local time). It joins
the run that ended just before it (the log's date and time plus its length, the logger's clock, local time too):
right away when that run is already uploaded, else after the upload that brings it (routers/imports.py). The user
sees which run it joined, with a Confirm and a Change; until they confirm, an upload that brings a run ending closer
before the recording moves it there. A recording no run matches waits on the Debrief page for the user to pick one.

Joining makes it a Debrief of the run, processed as any recording (pipeline.py). Moving it to another run at the same
track keeps the transcript and points; to another track it is processed again, so its corners are that track's.
"""
from __future__ import annotations

import logging
import threading
from datetime import datetime, timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session

from app import models
from app.debrief.pipeline import process_debrief
from app.importers.window import DATE_FORMATS, TIME_FORMATS

log = logging.getLogger(__name__)

# How long after a run ended a debrief of it may start: a debrief is recorded right after the run, and the next run
# of a weekend seldom ends sooner than this before it (a recording no run matches waits for the user to pick one).
AFTER_RUN = timedelta(minutes=60)
# The logger's and the phone's clocks are not set from one source: a recording that starts a little before the
# logged end (the logger still running in the pit lane, a slow clock) still belongs to that run.
CLOCKS = timedelta(minutes=5)


def _parse(text: str | None, formats: tuple[str, ...]) -> datetime | None:
    for fmt in formats:
        try:
            return datetime.strptime((text or "").strip(), fmt)
        except ValueError:
            pass
    return None


def run_end(meta: dict) -> datetime | None:
    """When a log ended, from its header's date and time and its length; None when the header doesn't say."""
    day, at = _parse(meta.get("date"), DATE_FORMATS), _parse(meta.get("time"), TIME_FORMATS)
    if day is None or at is None:
        return None
    return datetime.combine(day.date(), at.time()) + timedelta(seconds=float(meta.get("duration_s") or 0))


def run_for(db: Session, recorded_at: datetime) -> tuple[models.RunSession, datetime] | None:
    """The run that ended last before the recording started, no more than AFTER_RUN before it, and when it ended."""
    lo, hi = recorded_at - AFTER_RUN, recorded_at + CLOCKS
    best: tuple[int, datetime] | None = None
    for sid, meta in db.execute(select(models.LoggerFile.session_id, models.LoggerFile.meta)):
        end = run_end(meta or {})
        if end is not None and lo <= end <= hi and (best is None or end > best[1]):
            best = (sid, end)
    if best is None:
        return None
    s = db.get(models.RunSession, best[0])
    return (s, best[1]) if s is not None else None


def _track(s: models.RunSession | None) -> int | None:
    return s.event.track_id if s is not None and s.event is not None else None


def _process(debrief_id: int) -> None:
    threading.Thread(target=process_debrief, args=(debrief_id,), name=f"debrief-{debrief_id}", daemon=True).start()


def move(db: Session, d: models.Debrief, s: models.RunSession) -> None:
    """The debrief goes with run s: processed again when the track changed, so its corners are that track's.
    Commits."""
    moved_track = _track(d.session) != _track(s)
    d.session = s
    again = moved_track and d.audio_path is not None and d.status != models.DebriefStatus.processing
    if again:
        d.status, d.error = models.DebriefStatus.queued, None
    db.commit()
    if again:
        _process(d.id)


def link(db: Session, rec: models.DebriefRecording, s: models.RunSession, by: str) -> models.Debrief:
    """The recording becomes a debrief of run s, processed in the background, or its debrief moves there.
    Commits."""
    rec.linked_by, rec.confirmed = by, by == "user"
    if rec.debrief is not None:
        move(db, rec.debrief, s)
        return rec.debrief
    d = models.Debrief(session=s, mode=rec.mode, language=rec.language, audio_path=rec.audio_path,
                       status=models.DebriefStatus.queued)
    db.add(d)
    rec.debrief = d
    db.commit()
    _process(d.id)
    return d


def place(db: Session, rec: models.DebriefRecording) -> models.Debrief | None:
    """Joins the recording to the run that ended just before it, if that run is in; None when it waits."""
    found = run_for(db, rec.recorded_at)
    if found is None:
        return None
    return link(db, rec, found[0], "time")


def after_upload(db: Session) -> None:
    """After an upload: the recordings still waiting join their run if it came in now, and those joined by time but
    not confirmed move to a run that ended closer before them."""
    try:
        recs = db.scalars(select(models.DebriefRecording).where(
            (models.DebriefRecording.debrief_id.is_(None))
            | ((models.DebriefRecording.linked_by == "time") & models.DebriefRecording.confirmed.is_(False)))).all()
        for rec in recs:
            found = run_for(db, rec.recorded_at)
            if found is None or (rec.debrief is not None and rec.debrief.session_id == found[0].id):
                continue
            link(db, rec, found[0], "time")
            log.warning("Debrief recording %s (recorded %s) joined run %s by time", rec.id, rec.recorded_at,
                        found[0].id)
    except Exception:
        db.rollback()
        log.exception("Joining the waiting debrief recordings to their runs after an upload failed")


def describe(rec: models.DebriefRecording | None) -> dict | None:
    """How a debrief came to its run, for the app: found by time (with how long after the run ended), or picked."""
    if rec is None:
        return None
    out = {"recording_id": rec.id, "by": rec.linked_by, "confirmed": rec.confirmed,
           "recorded_at": rec.recorded_at.isoformat(timespec="seconds")}
    d = rec.debrief
    if d is not None and d.session is not None:
        ends = [run_end(f.meta or {}) for f in d.session.files]
        ends = [e for e in ends if e is not None]
        if ends:
            out["minutes_after_run"] = round((rec.recorded_at - max(ends)).total_seconds() / 60)
    return out
