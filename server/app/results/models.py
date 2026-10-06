"""Official series results: new tables only (create_all adds them); nothing on the existing tables changes."""
from __future__ import annotations

from datetime import UTC, datetime

from sqlalchemy import JSON, DateTime, Float, ForeignKey, Integer, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db import Base


def _now() -> datetime:
    return datetime.now(UTC)


class ResultRound(Base):
    """One round of a series' season as its results site lists it, with or without results yet."""
    __tablename__ = "result_rounds"
    __table_args__ = (UniqueConstraint("series", "year", "round_id"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    series: Mapped[str] = mapped_column(String(40))  # an adapter key, e.g. "gt4-europe"
    year: Mapped[int] = mapped_column(Integer, index=True)
    round_id: Mapped[str] = mapped_column(String(40))  # the site's own id for the meeting
    name: Mapped[str] = mapped_column(String(120))  # as the site names it ("Zandvoort")
    venue: Mapped[str | None] = mapped_column(String(60), index=True)  # venues.venue_key
    order: Mapped[int] = mapped_column(Integer, default=0)  # place in the season, 1 first
    fetched_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    sessions: Mapped[list[ResultSession]] = relationship(back_populates="round", cascade="all, delete-orphan",
                                                         order_by="ResultSession.code")


class ResultSession(Base):
    """One official classification (a qualifying or a race) of a round."""
    __tablename__ = "result_sessions"
    __table_args__ = (UniqueConstraint("round_pk", "code"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    round_pk: Mapped[int] = mapped_column(ForeignKey("result_rounds.id", ondelete="CASCADE"), index=True)
    code: Mapped[str] = mapped_column(String(8))  # Q1, Q2, R1, R2
    title: Mapped[str] = mapped_column(String(60))  # "Qualifying 1"
    kind: Mapped[str] = mapped_column(String(16))  # qualifying, race
    starts_at: Mapped[str | None] = mapped_column(String(40))  # as printed: "19 September 2026 11:15:00"
    track: Mapped[str | None] = mapped_column(String(120))
    length_m: Mapped[int | None] = mapped_column(Integer)
    weather: Mapped[dict] = mapped_column(JSON, default=dict)
    fastest: Mapped[str | None] = mapped_column(String(80))
    source_url: Mapped[str] = mapped_column(String(512))
    fetched_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
    round: Mapped[ResultRound] = relationship(back_populates="sessions")
    rows: Mapped[list[ResultRow]] = relationship(back_populates="session", cascade="all, delete-orphan",
                                                 order_by="ResultRow.id")


class ResultRow(Base):
    """One car in an official classification."""
    __tablename__ = "result_rows"
    id: Mapped[int] = mapped_column(primary_key=True)
    session_pk: Mapped[int] = mapped_column(ForeignKey("result_sessions.id", ondelete="CASCADE"), index=True)
    position: Mapped[int | None] = mapped_column(Integer)  # none for cars not classified
    status: Mapped[str] = mapped_column(String(12))  # classified, nc, dns, dnf, dsq
    car_number: Mapped[str] = mapped_column(String(8), index=True)
    drivers: Mapped[list] = mapped_column(JSON, default=list)
    team: Mapped[str | None] = mapped_column(String(160))
    entrant: Mapped[str | None] = mapped_column(String(160))
    car_class: Mapped[str | None] = mapped_column(String(20))
    car_model: Mapped[str | None] = mapped_column(String(80))
    brand: Mapped[str | None] = mapped_column(String(40))
    laps: Mapped[int | None] = mapped_column(Integer)
    best_lap_s: Mapped[float | None] = mapped_column(Float)
    best_lap_no: Mapped[int | None] = mapped_column(Integer)
    total_time_s: Mapped[float | None] = mapped_column(Float)
    gap_s: Mapped[float | None] = mapped_column(Float)
    gap_laps: Mapped[int | None] = mapped_column(Integer)
    diff_s: Mapped[float | None] = mapped_column(Float)
    kph: Mapped[float | None] = mapped_column(Float)
    session: Mapped[ResultSession] = relationship(back_populates="rows")


class EventResultLink(Base):
    """Which round of which series an event of ours is, and our car's number there."""
    __tablename__ = "event_result_links"
    id: Mapped[int] = mapped_column(primary_key=True)
    event_id: Mapped[int] = mapped_column(ForeignKey("events.id", ondelete="CASCADE"), unique=True, index=True)
    series: Mapped[str] = mapped_column(String(40))
    year: Mapped[int] = mapped_column(Integer)
    round_id: Mapped[str | None] = mapped_column(String(40))
    car_number: Mapped[str | None] = mapped_column(String(8))
    by_hand: Mapped[int] = mapped_column(Integer, default=0)  # 1 when the user set it, so matching leaves it alone
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now, onupdate=_now)
