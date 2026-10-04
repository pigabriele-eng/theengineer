"""Shared data model: one history for voice debriefs and logger data.

Everything hangs off a RunSession (one car on track for one session), so a
debrief and the logger files for the same run always meet in one place.
"""
from __future__ import annotations

import enum
from datetime import UTC, date, datetime

from sqlalchemy import JSON, Date, DateTime, Enum, Float, ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db import Base


def _now() -> datetime:
    return datetime.now(UTC)


class SessionKind(enum.StrEnum):
    test = "test"
    practice = "practice"
    qualifying = "qualifying"
    race = "race"


class DebriefMode(enum.StrEnum):
    individual = "individual"
    group = "group"


class DebriefStatus(enum.StrEnum):
    ready = "ready"  # typed debriefs, and voice debriefs once structured
    queued = "queued"  # audio saved, waiting to be processed
    processing = "processing"
    failed = "failed"  # see Debrief.error; the audio is kept so it can be processed again


class CornerPhase(enum.StrEnum):
    braking = "braking"
    entry = "entry"
    mid = "mid"
    exit = "exit"


class Track(Base):
    __tablename__ = "tracks"
    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(120), unique=True)
    length_m: Mapped[float | None] = mapped_column(Float)
    # start/finish line for GPS lap timing, learned from the first log with a lap marker: {lat, lon, heading}
    timing_line: Mapped[dict | None] = mapped_column(JSON)
    corners: Mapped[list[Corner]] = relationship(back_populates="track", order_by="Corner.apex_m",
                                                 cascade="all, delete-orphan")


class Corner(Base):
    """A named corner on a track, shared by debrief points and data analysis."""
    __tablename__ = "corners"
    id: Mapped[int] = mapped_column(primary_key=True)
    track_id: Mapped[int] = mapped_column(ForeignKey("tracks.id"))
    code: Mapped[str] = mapped_column(String(16))  # T1, T2, ...
    name: Mapped[str | None] = mapped_column(String(120))  # Grundig hairpin
    apex_m: Mapped[float | None] = mapped_column(Float)
    track: Mapped[Track] = relationship(back_populates="corners")


class Driver(Base):
    __tablename__ = "drivers"
    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(120))


class Car(Base):
    __tablename__ = "cars"
    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(120))  # "BMW M2 Cup #21"
    team: Mapped[str | None] = mapped_column(String(120))
    # role -> logger channel names, overriding the defaults (e.g. a car with brake pressure sensors)
    channel_map: Mapped[dict | None] = mapped_column(JSON)


class Event(Base):
    __tablename__ = "events"
    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(160))
    series: Mapped[str | None] = mapped_column(String(80))  # GTWC, NLS, GT4 Germany, ...
    track_id: Mapped[int | None] = mapped_column(ForeignKey("tracks.id"))
    date: Mapped[date | None] = mapped_column(Date)
    track: Mapped[Track | None] = relationship()


class RunSession(Base):
    __tablename__ = "run_sessions"
    id: Mapped[int] = mapped_column(primary_key=True)
    event_id: Mapped[int | None] = mapped_column(ForeignKey("events.id"))
    kind: Mapped[SessionKind] = mapped_column(Enum(SessionKind), default=SessionKind.test)
    name: Mapped[str | None] = mapped_column(String(120))  # "FP2", "Run 3"
    car_id: Mapped[int | None] = mapped_column(ForeignKey("cars.id"))
    driver_id: Mapped[int | None] = mapped_column(ForeignKey("drivers.id"))
    track_temp_c: Mapped[float | None] = mapped_column(Float)
    tyre_set: Mapped[str | None] = mapped_column(String(60))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)

    event: Mapped[Event | None] = relationship()
    car: Mapped[Car | None] = relationship()
    driver: Mapped[Driver | None] = relationship()
    files: Mapped[list[LoggerFile]] = relationship(back_populates="session", cascade="all, delete-orphan")
    laps: Mapped[list[Lap]] = relationship(back_populates="session", order_by="Lap.number",
                                           cascade="all, delete-orphan")
    debriefs: Mapped[list[Debrief]] = relationship(back_populates="session", cascade="all, delete-orphan")


class LoggerFile(Base):
    __tablename__ = "logger_files"
    id: Mapped[int] = mapped_column(primary_key=True)
    session_id: Mapped[int] = mapped_column(ForeignKey("run_sessions.id"))
    logger: Mapped[str] = mapped_column(String(20))  # motec, vbox, windarab
    filename: Mapped[str] = mapped_column(String(255))
    path: Mapped[str] = mapped_column(String(512))
    meta: Mapped[dict] = mapped_column(JSON, default=dict)
    uploaded_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
    session: Mapped[RunSession] = relationship(back_populates="files")


class Lap(Base):
    __tablename__ = "laps"
    id: Mapped[int] = mapped_column(primary_key=True)
    session_id: Mapped[int] = mapped_column(ForeignKey("run_sessions.id"))
    file_id: Mapped[int] = mapped_column(ForeignKey("logger_files.id"))
    number: Mapped[int] = mapped_column(Integer)
    time_s: Mapped[float] = mapped_column(Float)
    start_s: Mapped[float] = mapped_column(Float)  # seconds from the start of the logger file
    clean: Mapped[bool] = mapped_column(default=True)
    session: Mapped[RunSession] = relationship(back_populates="laps")


class Debrief(Base):
    __tablename__ = "debriefs"
    id: Mapped[int] = mapped_column(primary_key=True)
    session_id: Mapped[int] = mapped_column(ForeignKey("run_sessions.id"))
    mode: Mapped[DebriefMode] = mapped_column(Enum(DebriefMode), default=DebriefMode.individual)
    language: Mapped[str] = mapped_column(String(8), default="en")
    status: Mapped[DebriefStatus] = mapped_column(Enum(DebriefStatus), default=DebriefStatus.ready)
    error: Mapped[str | None] = mapped_column(Text)
    transcript: Mapped[str | None] = mapped_column(Text)
    # timestamped, speaker-labelled transcript segments: [{"speaker", "start", "end", "text"}]
    segments: Mapped[list | None] = mapped_column(JSON)
    # who each speaker label is: {"S0": {"role": "driver", "name": "Gabriele"}}
    speakers: Mapped[dict | None] = mapped_column(JSON)
    summary: Mapped[str | None] = mapped_column(Text)
    audio_path: Mapped[str | None] = mapped_column(String(512))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
    session: Mapped[RunSession] = relationship(back_populates="debriefs")
    points: Mapped[list[DebriefPoint]] = relationship(back_populates="debrief", cascade="all, delete-orphan")


class DebriefPoint(Base):
    """One statement from a debrief, tagged so it can be compared with data and other debriefs."""
    __tablename__ = "debrief_points"
    id: Mapped[int] = mapped_column(primary_key=True)
    debrief_id: Mapped[int] = mapped_column(ForeignKey("debriefs.id"))
    section: Mapped[str] = mapped_column(String(40))  # balance, tyres, brakes, ... (report sections)
    text: Mapped[str] = mapped_column(Text)
    speaker_driver_id: Mapped[int | None] = mapped_column(ForeignKey("drivers.id"))
    speaker: Mapped[str | None] = mapped_column(String(16))  # transcript speaker label, e.g. S0
    corner_code: Mapped[str | None] = mapped_column(String(16))  # as said or matched, even without a track map
    corner_id: Mapped[int | None] = mapped_column(ForeignKey("corners.id"))
    phase: Mapped[CornerPhase | None] = mapped_column(Enum(CornerPhase))
    audio_start_s: Mapped[float | None] = mapped_column(Float)
    debrief: Mapped[Debrief] = relationship(back_populates="points")
