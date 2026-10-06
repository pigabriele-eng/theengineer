"""The prep report's tables. New tables only (create_all adds them); nothing on the existing tables changes."""
from __future__ import annotations

from datetime import UTC, datetime

from sqlalchemy import JSON, DateTime, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base


def _now() -> datetime:
    return datetime.now(UTC)


class PrepCache(Base):
    """The last prep report worked out for an event and a car, and the progress of the one being worked out."""
    __tablename__ = "prep_cache"
    id: Mapped[int] = mapped_column(primary_key=True)
    scope: Mapped[str] = mapped_column(String(160), unique=True, index=True)  # "event:7|car:logger:26724"
    signature: Mapped[str] = mapped_column(String(64))  # the inputs the work in progress (or last done) is for
    status: Mapped[str] = mapped_column(String(16), default="queued")  # queued, running, done, failed
    done: Mapped[int] = mapped_column(Integer, default=0)
    total: Mapped[int] = mapped_column(Integer, default=0)
    current: Mapped[str | None] = mapped_column(String(255))
    error: Mapped[str | None] = mapped_column(Text)
    result: Mapped[dict | None] = mapped_column(JSON)  # the last finished report, kept while a newer one is made
    result_signature: Mapped[str | None] = mapped_column(String(64))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now, onupdate=_now)


class WeatherCache(Base):
    """Weather fetched for a place and days: the past (kept) or a forecast (fetched again after a while)."""
    __tablename__ = "prep_weather"
    id: Mapped[int] = mapped_column(primary_key=True)
    key: Mapped[str] = mapped_column(String(120), unique=True, index=True)  # "archive|52.39|4.54|2025-05-05|.."
    data: Mapped[dict | None] = mapped_column(JSON)
    fetched_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
