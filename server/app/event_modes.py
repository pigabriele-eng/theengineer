"""What an event is for: a race weekend or a coaching day (Gabriele, 2026-10-07: a race weekend and coaching clients
"are related but not all equivalent or identical"). The app opens each on its own page.

GET /events/{id}/mode answers {"mode": "weekend" | "coaching"}; an event never set is a race weekend. PUT
/events/{id}/mode {"mode": ...} sets it. GET /events/folders says every event's mode (modes_of_events: one read).

New table (create_all adds it; nothing on the existing tables changes), one row per event that was set. Deleting the
event deletes its row (event_delete.py follows the foreign key; routers/events.py when only the folder goes; plans.py
when a planned event is removed).
"""
from __future__ import annotations

from datetime import UTC, datetime
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import DateTime, ForeignKey, String, delete, select
from sqlalchemy.orm import Mapped, Session, mapped_column

from app import models
from app.db import Base, get_db

router = APIRouter()

Mode = Literal["weekend", "coaching"]
DEFAULT: Mode = "weekend"


def _now() -> datetime:
    return datetime.now(UTC)


class EventMode(Base):
    """An event's mode, when it was set."""
    __tablename__ = "event_modes"
    event_id: Mapped[int] = mapped_column(ForeignKey("events.id", ondelete="CASCADE"), primary_key=True)
    mode: Mapped[str] = mapped_column(String(16))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now, onupdate=_now)


class ModeIn(BaseModel):
    mode: Mode


def modes_of_events(db: Session) -> dict[int, str]:
    """Every event that was set: {event id: mode}. The others are race weekends (DEFAULT)."""
    return dict(db.execute(select(EventMode.event_id, EventMode.mode)).all())


def forget(db: Session, event_id: int) -> None:
    """The event's row, as the event goes (not committed)."""
    db.execute(delete(EventMode).where(EventMode.event_id == event_id))


def _event_or_404(db: Session, event_id: int) -> None:
    if db.get(models.Event, event_id) is None:
        raise HTTPException(404, "Event not found")


@router.get("/events/{event_id}/mode")
def get_mode(event_id: int, db: Session = Depends(get_db)):
    _event_or_404(db, event_id)
    row = db.get(EventMode, event_id)
    return {"mode": row.mode if row is not None else DEFAULT}


@router.put("/events/{event_id}/mode")
def set_mode(event_id: int, body: ModeIn, db: Session = Depends(get_db)):
    _event_or_404(db, event_id)
    row = db.get(EventMode, event_id)
    if row is None:
        db.add(EventMode(event_id=event_id, mode=body.mode))
    else:
        row.mode = body.mode
    db.commit()
    return {"mode": body.mode}
