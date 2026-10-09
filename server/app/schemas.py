"""Request and response bodies. Text fields are no longer than their database columns, which Postgres enforces."""
import datetime as dt
from typing import Self

from pydantic import BaseModel, ConfigDict, Field

from app.models import CornerPhase, DebriefMode, DebriefStatus, SessionKind


class Orm(BaseModel):
    model_config = ConfigDict(from_attributes=True)


class CornerIn(BaseModel):
    code: str = Field(max_length=16)
    name: str | None = Field(None, max_length=120)
    apex_m: float | None = None
    sector: str | None = Field(None, max_length=32)  # e.g. "T2-T5" on T2, T3, T4 and T5 to time them as one section


class CornerOut(CornerIn, Orm):
    id: int


class TrackIn(BaseModel):
    name: str = Field(max_length=120)
    length_m: float | None = None
    corners: list[CornerIn] = []


class TrackOut(Orm):
    id: int
    name: str
    length_m: float | None
    corners: list[CornerOut]


class DriverIn(BaseModel):
    name: str = Field(max_length=120)


class DriverOut(DriverIn, Orm):
    id: int


class CarIn(BaseModel):
    name: str = Field(max_length=120)
    team: str | None = Field(None, max_length=120)
    channel_map: dict[str, list[str]] | None = None


class CarOut(CarIn, Orm):
    id: int


class EventIn(BaseModel):
    name: str = Field(max_length=160)
    series: str | None = Field(None, max_length=80)
    track_id: int | None = None
    date: dt.date | None = None


class EventOut(EventIn, Orm):
    id: int


class SessionIn(BaseModel):
    event_id: int | None = None
    kind: SessionKind = SessionKind.test
    name: str | None = Field(None, max_length=120)
    car_id: int | None = None
    driver_id: int | None = None
    track_temp_c: float | None = None
    ambient_temp_c: float | None = None
    tyre_set: str | None = Field(None, max_length=60)


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
    event_name: str | None = None
    track_name: str | None = None  # the event's track, else the venue in the log header


class SessionDetail(SessionOut):
    files: list[LoggerFileOut]
    laps: list[LapOut]


class ImportJobOut(Orm):
    id: int
    filename: str
    status: str  # queued, running, done, failed
    total: int  # logs found (0 until the upload has been unpacked)
    done: int
    current: str | None
    session_ids: list[int]
    errors: list[dict]  # {"file", "error"}
    skipped: list[dict]  # {"file", "reason"}: files that aren't logs, logs with no laps (empty runs) and logs already
    # uploaded ({"already": true, "session_id": the run it is in}), left out before they are read
    already_uploaded: int = 0  # how many of skipped were already uploaded
    untimed: list[dict] = []  # {"session_id", "name", "file", "title", "reason", "fix", ...}: kept, laps not timed
    eta: dict | None = None  # while it runs: {"stage", "stage_s", "total_s"}, seconds left (app/import_rates.py)
    message: str | None
    created_at: dt.datetime
    finished_at: dt.datetime | None


class DebriefPointIn(BaseModel):
    section: str = Field(max_length=40)
    text: str
    speaker_driver_id: int | None = None
    corner_id: int | None = None
    phase: CornerPhase | None = None
    audio_start_s: float | None = None
    speaker: str | None = Field(None, max_length=16)
    corner_code: str | None = Field(None, max_length=16)


class DebriefPointOut(DebriefPointIn, Orm):
    id: int


class DebriefIn(BaseModel):
    mode: DebriefMode = DebriefMode.individual
    language: str = Field("en", max_length=8)
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
    # recorded before its run was picked: how it came to this run (debrief/inbox.py describe)
    linked: dict | None = None

    @classmethod
    def of(cls, d) -> Self:
        from app.debrief.inbox import describe  # here: it imports the models and the pipeline

        out = cls.model_validate(d)
        out.has_audio = d.audio_path is not None
        out.linked = describe(d.recording)
        return out
