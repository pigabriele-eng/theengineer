"""The setup tables. New tables only (create_all adds them); nothing on the existing tables changes."""
from __future__ import annotations

from datetime import UTC, datetime

from sqlalchemy import JSON, DateTime, ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base


def _now() -> datetime:
    return datetime.now(UTC)


class SessionSetup(Base):
    """The setup the car ran in one session, as filled in on its car's template (setup/templates.py)."""
    __tablename__ = "session_setups"
    id: Mapped[int] = mapped_column(primary_key=True)
    session_id: Mapped[int] = mapped_column(ForeignKey("run_sessions.id", ondelete="CASCADE"), unique=True)
    template: Mapped[str] = mapped_column(String(40))  # a key of templates.TEMPLATES
    # field key -> number, e.g. {"arb_front": 3, "camber_fl": -3.2}; a field left out was not recorded
    values: Mapped[dict] = mapped_column(JSON, default=dict)
    notes: Mapped[str | None] = mapped_column(Text)
    copied_from_session_id: Mapped[int | None] = mapped_column(Integer)  # the session it was copied from, if any
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now, onupdate=_now)


class SetupRunSummary(Base):
    """A session's lap times and balance reduced to a few numbers (setup/results.py), kept so the run-by-run
    comparison doesn't read every log again. Recomputed when the signature (log, laps, version) changes."""
    __tablename__ = "setup_run_summaries"
    id: Mapped[int] = mapped_column(primary_key=True)
    session_id: Mapped[int] = mapped_column(ForeignKey("run_sessions.id", ondelete="CASCADE"), unique=True)
    signature: Mapped[str] = mapped_column(String(120))
    data: Mapped[dict] = mapped_column(JSON, default=dict)
    computed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)


class SetupChat(Base):
    """The setup tool's conversation for one event (event_id None: runs outside any event): the car variant, the
    run it reads, the problems, the limits stated ("already at the minimum ride height"), what was tried and the
    messages (app.setup.chat)."""
    __tablename__ = "setup_chats"
    id: Mapped[int] = mapped_column(primary_key=True)
    event_id: Mapped[int | None] = mapped_column(ForeignKey("events.id", ondelete="CASCADE"), unique=True)
    state: Mapped[dict] = mapped_column(JSON, default=dict)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now, onupdate=_now)
