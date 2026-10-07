"""Who drove each session: tag one session, a selection or whole events with a driver."""
from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import BaseModel, Field
from sqlalchemy import func, select, update
from sqlalchemy.orm import Session

from app import models, schemas
from app.db import get_db

router = APIRouter()


def main_file(s: models.RunSession) -> models.LoggerFile | None:
    """The log the analysis reads for a session: the longest."""
    return max(s.files, key=lambda f: f.meta.get("duration_s", 0)) if s.files else None


def session_track(db: Session, s: models.RunSession) -> models.Track | None:
    """The session's track as stored: its event's, or the one named in its log header (no log is read)."""
    if s.event and s.event.track:
        return s.event.track
    f = main_file(s)
    venue = (f.meta.get("venue") or "")[:120] if f else ""
    return db.scalar(select(models.Track).where(models.Track.name == venue)) if venue else None


def _driver(db: Session, driver_id: int) -> models.Driver:
    d = db.get(models.Driver, driver_id)
    if d is None:
        raise HTTPException(404, "Driver not found")
    return d


class DriverPick(BaseModel):
    """A driver by id, or by name (an existing driver of that name, else a new one). Neither clears the driver."""
    driver_id: int | None = None
    driver_name: str | None = Field(None, max_length=120)


def _pick(db: Session, body: DriverPick) -> models.Driver | None:
    if body.driver_id is not None:
        return _driver(db, body.driver_id)
    name = (body.driver_name or "").strip()
    if not name:
        return None
    same = select(models.Driver).where(func.lower(models.Driver.name) == name.lower()).order_by(models.Driver.id)
    d = db.scalars(same).first()
    if d is None:
        d = models.Driver(name=name)
        db.add(d)
        db.flush()
    return d


class AssignIn(DriverPick):
    session_ids: list[int] = []
    event_ids: list[int] = []  # every session of these events


class AssignOut(BaseModel):
    driver: schemas.DriverOut | None
    session_ids: list[int]


@router.post("/drivers/assign", response_model=AssignOut)
def assign_driver(body: AssignIn, db: Session = Depends(get_db)):
    """Set the driver of many sessions at once: a selection, whole events, or both."""
    ids = set(body.session_ids)
    found = set(db.scalars(select(models.RunSession.id).where(models.RunSession.id.in_(ids))).all()) if ids else set()
    if ids - found:
        raise HTTPException(404, f"Session not found: {', '.join(map(str, sorted(ids - found)))}")
    for eid in body.event_ids:
        if db.get(models.Event, eid) is None:
            raise HTTPException(404, f"Event not found: {eid}")
    if body.event_ids:
        ids |= set(db.scalars(select(models.RunSession.id)
                              .where(models.RunSession.event_id.in_(body.event_ids))).all())
    if not ids:
        raise HTTPException(422, "Pick at least one session or event")
    d = _pick(db, body)
    _by_person(db, sorted(ids), d)
    db.commit()
    _style_learns()
    return {"driver": d, "session_ids": sorted(ids)}


@router.put("/sessions/{session_id}/driver", response_model=AssignOut)
def set_session_driver(session_id: int, body: DriverPick, db: Session = Depends(get_db)):
    """Set (or clear) the driver of one session: the call for a run's driver Change (it teaches the fingerprints)."""
    s = db.get(models.RunSession, session_id)
    if s is None:
        raise HTTPException(404, "Session not found")
    d = _pick(db, body)
    _by_person(db, [s.id], d)
    db.commit()
    _style_learns()
    return {"driver": d, "session_ids": [s.id]}


def _by_person(db: Session, ids: list[int], d: models.Driver | None) -> None:
    """A person's pick: the runs get the driver and it teaches the fingerprints (driver_prints.picked)."""
    from app import driver_prints  # looked up when used: the tests reload it
    driver_prints.picked(db, ids, d.id if d else None)


def _style_learns() -> None:
    """A tag teaches the driver fingerprints: the runs elsewhere the style is now sure of get their driver."""
    from app import driver_prints  # looked up when used: the tests reload it
    driver_prints.learn()


class DriverName(BaseModel):
    name: str = Field(min_length=1, max_length=120)


@router.patch("/drivers/{driver_id}", response_model=schemas.DriverOut)
def rename_driver(driver_id: int, body: DriverName, db: Session = Depends(get_db)):
    d = _driver(db, driver_id)
    d.name = body.name.strip() or d.name
    db.commit()
    return d


@router.delete("/drivers/{driver_id}", status_code=204)
def delete_driver(driver_id: int, db: Session = Depends(get_db)):
    """Remove a driver (a typo, a duplicate): their sessions and debrief points are kept, without a driver."""
    d = _driver(db, driver_id)
    db.execute(update(models.RunSession).where(models.RunSession.driver_id == d.id).values(driver_id=None))
    db.execute(update(models.DebriefPoint).where(models.DebriefPoint.speaker_driver_id == d.id)
               .values(speaker_driver_id=None))
    db.delete(d)
    db.commit()
    return Response(status_code=204)
