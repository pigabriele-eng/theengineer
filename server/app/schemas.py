import datetime as dt
from typing import Self

from pydantic import BaseModel, ConfigDict

from app.models import CornerPhase, DebriefMode, DebriefStatus, SessionKind


class Orm(BaseModel):
    model_config = ConfigDict(from_attributes=True)


class CornerIn(BaseModel):
    code: str
    name: str | None = None
    apex_m: float | None = None


class CornerOut(CornerIn, Orm):
    id: int


class TrackIn(BaseModel):
    name: str
    length_m: float | None = None
    corners: list[CornerIn] = []


class TrackOut(Orm):
    id: int
    name: str
    length_m: float | None
    corners: list[CornerOut]


class DriverIn(BaseModel):
    name: str


class DriverOut(DriverIn, Orm):
    id: int


class CarIn(BaseModel):
    name: str
    team: str | None = None
    channel_map: dict[str, list[str]] | None = None


class CarOut(CarIn, Orm):
    id: int


class EventIn(BaseModel):
    name: str
    series: str | None = None
    track_id: int | None = None
    date: dt.date | None = None


class EventOut(EventIn, Orm):
    id: int


class SessionIn(BaseModel):
    event_id: int | None = None
    kind: SessionKind = SessionKind.test
    name: str | None = None
    car_id: int | None = None
    driver_id: int | None = None
    track_temp_c: float | None = None
    tyre_set: str | None = None


class LapOut(Orm):
    number: int
    time_s: float
    clean: bool
    file_id: int


class LoggerFileOut(Orm):
    id: int
    logger: str
    filename: str
    meta: dict
    uploaded_at: dt.datetime


class SessionOut(SessionIn, Orm):
    id: int
    created_at: dt.datetime
    best_lap_s: float | None = None


class SessionDetail(SessionOut):
    files: list[LoggerFileOut]
    laps: list[LapOut]


class DebriefPointIn(BaseModel):
    section: str
    text: str
    speaker_driver_id: int | None = None
    corner_id: int | None = None
    phase: CornerPhase | None = None
    audio_start_s: float | None = None
    speaker: str | None = None
    corner_code: str | None = None


class DebriefPointOut(DebriefPointIn, Orm):
    id: int


class DebriefIn(BaseModel):
    mode: DebriefMode = DebriefMode.individual
    language: str = "en"
    transcript: str | None = None
    points: list[DebriefPointIn] = []


class DebriefOut(Orm):
    id: int
    session_id: int
    mode: DebriefMode
    language: str
    status: DebriefStatus
    error: str | None
    summary: str | None
    speakers: dict | None
    transcript: str | None
    segments: list | None
    has_audio: bool = False
    created_at: dt.datetime
    points: list[DebriefPointOut]

    @classmethod
    def of(cls, d) -> Self:
        out = cls.model_validate(d)
        out.has_audio = d.audio_path is not None
        return out
