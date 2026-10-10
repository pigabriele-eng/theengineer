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


class ImportStatus(enum.StrEnum):
    queued = "queued"
    running = "running"
    done = "done"  # every log was tried; see ImportJob.errors for the ones that didn't import
    failed = "failed"  # see ImportJob.message


class Track(Base):
    __tablename__ = "tracks"
    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(120), unique=True)
    length_m: Mapped[float | None] = mapped_column(Float)
    # start/finish line for GPS lap timing, learned from the first log with a lap marker: {lat, lon, heading}
    timing_line: Mapped[dict | None] = mapped_column(JSON)
    corners: Mapped[list[Corner]] = relationship(back_populates="track", order_by="Corner.apex_m",
                                                 cascade="all, delete-orphan", lazy="selectin")


class Corner(Base):
    """A named corner on a track, shared by debrief points and data analysis."""
    __tablename__ = "corners"
    id: Mapped[int] = mapped_column(primary_key=True)
    track_id: Mapped[int] = mapped_column(ForeignKey("tracks.id"), index=True)
    code: Mapped[str] = mapped_column(String(16))  # T1, T2, ...
    name: Mapped[str | None] = mapped_column(String(120))  # Grundig hairpin
    apex_m: Mapped[float | None] = mapped_column(Float)
    sector: Mapped[str | None] = mapped_column(String(32))  # corners with the same sector are analysed as one section
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
    track: Mapped[Track | None] = relationship(lazy="joined")


class RunSession(Base):
    __tablename__ = "run_sessions"
    id: Mapped[int] = mapped_column(primary_key=True)
    event_id: Mapped[int | None] = mapped_column(ForeignKey("events.id"), index=True)
    kind: Mapped[SessionKind] = mapped_column(Enum(SessionKind), default=SessionKind.test)
    name: Mapped[str | None] = mapped_column(String(120))  # "FP2", "Run 3"
    car_id: Mapped[int | None] = mapped_column(ForeignKey("cars.id"), index=True)
    driver_id: Mapped[int | None] = mapped_column(ForeignKey("drivers.id"), index=True)
    track_temp_c: Mapped[float | None] = mapped_column(Float)
    ambient_temp_c: Mapped[float | None] = mapped_column(Float)
    tyre_set: Mapped[str | None] = mapped_column(String(60))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)

    event: Mapped[Event | None] = relationship(lazy="joined")
    car: Mapped[Car | None] = relationship(lazy="joined")
    driver: Mapped[Driver | None] = relationship(lazy="joined")
    files: Mapped[list[LoggerFile]] = relationship(back_populates="session", cascade="all, delete-orphan",
                                                   lazy="selectin")
    laps: Mapped[list[Lap]] = relationship(back_populates="session", order_by="Lap.number",
                                           cascade="all, delete-orphan", lazy="selectin")
    debriefs: Mapped[list[Debrief]] = relationship(back_populates="session", cascade="all, delete-orphan")


class LoggerFile(Base):
    __tablename__ = "logger_files"
    id: Mapped[int] = mapped_column(primary_key=True)
    session_id: Mapped[int] = mapped_column(ForeignKey("run_sessions.id"), index=True)
    logger: Mapped[str] = mapped_column(String(20))  # motec, vbox, windarab
    filename: Mapped[str] = mapped_column(String(255))
    path: Mapped[str] = mapped_column(String(512))
    meta: Mapped[dict] = mapped_column(JSON, default=dict)
    uploaded_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
    session: Mapped[RunSession] = relationship(back_populates="files")


class Lap(Base):
    __tablename__ = "laps"
    id: Mapped[int] = mapped_column(primary_key=True)
    session_id: Mapped[int] = mapped_column(ForeignKey("run_sessions.id"), index=True)
    file_id: Mapped[int] = mapped_column(ForeignKey("logger_files.id"), index=True)
    number: Mapped[int] = mapped_column(Integer)
    time_s: Mapped[float] = mapped_column(Float)
    start_s: Mapped[float] = mapped_column(Float)  # seconds from the start of the logger file
    clean: Mapped[bool] = mapped_column(default=True)
    session: Mapped[RunSession] = relationship(back_populates="laps")


class Debrief(Base):
    __tablename__ = "debriefs"
    id: Mapped[int] = mapped_column(primary_key=True)
    session_id: Mapped[int] = mapped_column(ForeignKey("run_sessions.id"), index=True)
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
    # how it came to its run, when it was recorded before the run was picked (DebriefRecording)
    recording: Mapped[DebriefRecording | None] = relationship(viewonly=True, uselist=False)


class DebriefPoint(Base):
    """One statement from a debrief, tagged so it can be compared with data and other debriefs."""
    __tablename__ = "debrief_points"
    id: Mapped[int] = mapped_column(primary_key=True)
    debrief_id: Mapped[int] = mapped_column(ForeignKey("debriefs.id"), index=True)
    section: Mapped[str] = mapped_column(String(40))  # balance, tyres, brakes, ... (report sections)
    text: Mapped[str] = mapped_column(Text)
    speaker_driver_id: Mapped[int | None] = mapped_column(ForeignKey("drivers.id"))
    speaker: Mapped[str | None] = mapped_column(String(16))  # transcript speaker label, e.g. S0
    corner_code: Mapped[str | None] = mapped_column(String(16))  # as said or matched, even without a track map
    corner_id: Mapped[int | None] = mapped_column(ForeignKey("corners.id"))
    phase: Mapped[CornerPhase | None] = mapped_column(Enum(CornerPhase))
    audio_start_s: Mapped[float | None] = mapped_column(Float)
    debrief: Mapped[Debrief] = relationship(back_populates="points")


class DebriefRecording(Base):
    """A voice debrief recorded before the run is picked, or before its log is uploaded (debrief/inbox.py).

    It waits here with the time it was recorded until the run that ended just before it is in, or the user picks
    the run; then it becomes a Debrief of that run (debrief_id). A run found by time is shown with a Confirm and a
    Change until the user confirms it, and a better match from a later upload can still take it.
    """
    __tablename__ = "debrief_recordings"
    id: Mapped[int] = mapped_column(primary_key=True)
    audio_path: Mapped[str] = mapped_column(String(512))
    filename: Mapped[str | None] = mapped_column(String(255))
    mode: Mapped[DebriefMode] = mapped_column(Enum(DebriefMode), default=DebriefMode.individual)
    language: Mapped[str] = mapped_column(String(8), default="en")
    # when it was recorded, on the phone's clock: local time with no zone, as the logger's own date and time are
    recorded_at: Mapped[datetime] = mapped_column(DateTime)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
    debrief_id: Mapped[int | None] = mapped_column(ForeignKey("debriefs.id", ondelete="CASCADE"), index=True)
    linked_by: Mapped[str | None] = mapped_column(String(8))  # "time" (found by when it was recorded) or "user"
    confirmed: Mapped[bool] = mapped_column(default=False)
    debrief: Mapped[Debrief | None] = relationship()


class DebriefRun(Base):
    """A run a debrief talks about, as the user set them (debrief/covers.py works them out when there are none): a
    debrief at the end of a session covers its stints. group: the setup the car ran (0, 1, ...), so a change between
    stints is checked against the data before and after it apart."""
    __tablename__ = "debrief_runs"
    id: Mapped[int] = mapped_column(primary_key=True)
    debrief_id: Mapped[int] = mapped_column(ForeignKey("debriefs.id", ondelete="CASCADE"), index=True)
    session_id: Mapped[int] = mapped_column(ForeignKey("run_sessions.id", ondelete="CASCADE"), index=True)
    group: Mapped[int] = mapped_column(Integer, default=0)


class LiveTranscript(Base):
    """What the phone's own speech recognition wrote down while a debrief was recorded (free, no speaker labels):
    the transcript used when the server has no speech to text key (debrief/pipeline.py). Keyed by the recording's
    storage key, which its DebriefRecording and its Debrief share."""
    __tablename__ = "live_transcripts"
    id: Mapped[int] = mapped_column(primary_key=True)
    audio_path: Mapped[str] = mapped_column(String(512), unique=True)
    segments: Mapped[list] = mapped_column(JSON)  # [{"start", "end", "text"}], seconds into the recording


class TyreMinimum(Base):
    """A P-Book minimum tyre pressure for one series, tyre and axle: cold, hot or both (gauge bar)."""
    __tablename__ = "tyre_minimums"
    id: Mapped[int] = mapped_column(primary_key=True)
    series: Mapped[str] = mapped_column(String(80))
    tyre: Mapped[str | None] = mapped_column(String(80))  # "Pirelli P Zero DHG"
    axle: Mapped[str] = mapped_column(String(8))  # front, rear
    cold_min_bar: Mapped[float | None] = mapped_column(Float)
    hot_min_bar: Mapped[float | None] = mapped_column(Float)
    source: Mapped[str | None] = mapped_column(String(255))  # P-Book edition and page


class ImportJob(Base):
    """One upload of several files (logs, .ldx, zips) imported in the background: a session per log."""
    __tablename__ = "import_jobs"
    id: Mapped[int] = mapped_column(primary_key=True)
    filename: Mapped[str] = mapped_column(String(255))  # the uploaded files' names
    # an ImportStatus; a plain string column, so a new status needs no database migration
    status: Mapped[str] = mapped_column(String(16), default=ImportStatus.queued)
    total: Mapped[int] = mapped_column(Integer, default=0)  # logs found in the upload
    done: Mapped[int] = mapped_column(Integer, default=0)  # logs tried so far, imported or not
    current: Mapped[str | None] = mapped_column(String(255))  # the log being imported now
    session_ids: Mapped[list] = mapped_column(JSON, default=list)  # the sessions created
    errors: Mapped[list] = mapped_column(JSON, default=list)  # [{"file", "error"}]: files that didn't import
    skipped: Mapped[list] = mapped_column(JSON, default=list)  # [{"file", "reason"}]: files that aren't logs
    message: Mapped[str | None] = mapped_column(Text)  # why the import failed or stopped early
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class TyreData(Base):
    """One log file's tyre data, binned small (vehicle/tyre_data.py): the accumulating tyre model is fitted from
    these, never from the logs. Made in the background (vehicle/tyre_store.py)."""
    __tablename__ = "tyre_data"
    id: Mapped[int] = mapped_column(primary_key=True)
    file_id: Mapped[int] = mapped_column(ForeignKey("logger_files.id", ondelete="CASCADE"), unique=True)
    session_id: Mapped[int] = mapped_column(ForeignKey("run_sessions.id", ondelete="CASCADE"), index=True)
    version: Mapped[str] = mapped_column(String(64))  # summary method and car values it was made with
    status: Mapped[str] = mapped_column(String(16))  # ok, none (no steady cornering) or failed (see message)
    message: Mapped[str | None] = mapped_column(Text)
    # how the file's laps were timed when it was summarised: source and line (tyre_store.timing_key)
    lap_source: Mapped[str | None] = mapped_column(String(16))
    car_key: Mapped[str] = mapped_column(String(80), index=True)  # car:<id>, logger:<serial> or vehicle:<name>
    car_label: Mapped[str] = mapped_column(String(160))
    preset: Mapped[str] = mapped_column(String(40))  # the car values the summary was made with
    tyre: Mapped[str | None] = mapped_column(String(80))
    track: Mapped[str | None] = mapped_column(String(120))
    logged_on: Mapped[date | None] = mapped_column(Date)
    ambient_c: Mapped[float | None] = mapped_column(Float)  # the logger's, at racing speed
    samples: Mapped[int] = mapped_column(Integer, default=0)
    summary: Mapped[dict | None] = mapped_column(JSON)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)


# ---------- the report (routers/reports.py): caches, so a whole test is never read from its logs at once ----------

class SessionTraces(Base):
    """A session's clean laps reduced to compact traces (analysis/compact.py), kept in file storage. The report reads
    these instead of the log. signature says what they were made from; when it no longer matches, they are made
    again."""
    __tablename__ = "session_traces"
    id: Mapped[int] = mapped_column(primary_key=True)
    # no foreign key: the row of a session that no longer exists is simply never read
    session_id: Mapped[int] = mapped_column(Integer, unique=True, index=True)
    signature: Mapped[str] = mapped_column(String(64))
    path: Mapped[str | None] = mapped_column(String(512))  # storage key; None when the session has no clean lap
    laps: Mapped[int] = mapped_column(Integer, default=0)
    error: Mapped[str | None] = mapped_column(Text)  # why the log couldn't be reduced
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)


class LapPackFile(Base):
    """A session's lap pack (analysis/lappack.py) in file storage: its clean laps' samples the comparisons read, so laps
    are compared without reading the log (app/lappacks.py). signature says what it was made from; when it no longer
    matches, it is made again."""
    __tablename__ = "lap_packs"
    id: Mapped[int] = mapped_column(primary_key=True)
    session_id: Mapped[int] = mapped_column(Integer, unique=True, index=True)  # no foreign key, as session_traces
    signature: Mapped[str] = mapped_column(String(64))
    path: Mapped[str | None] = mapped_column(String(512))  # storage key; None when the session has no clean lap
    laps: Mapped[int] = mapped_column(Integer, default=0)
    error: Mapped[str | None] = mapped_column(Text)  # why the log couldn't be read
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)


class ReportCache(Base):
    """The last report worked out for an event or a session, and the progress of the one being worked out."""
    __tablename__ = "report_cache"
    id: Mapped[int] = mapped_column(primary_key=True)
    scope: Mapped[str] = mapped_column(String(40), unique=True, index=True)  # "event:3" or "session:12"
    signature: Mapped[str] = mapped_column(String(64))  # the inputs the work in progress (or last done) is for
    status: Mapped[str] = mapped_column(String(16), default="queued")  # queued, running, done, failed
    done: Mapped[int] = mapped_column(Integer, default=0)  # steps done: one per session, then the report itself
    total: Mapped[int] = mapped_column(Integer, default=0)
    current: Mapped[str | None] = mapped_column(String(255))  # what it is doing now
    error: Mapped[str | None] = mapped_column(Text)
    result: Mapped[dict | None] = mapped_column(JSON)  # the last finished report, kept while a newer one is made
    result_signature: Mapped[str | None] = mapped_column(String(64))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now, onupdate=_now)


class RunTyres(Base):
    """A run's tyres as the driver set them: "new" or "used" (run_tyres.py guesses the rest from the logs). The
    perfect lap and the best technique of a lap only take laps on the same tyres."""
    __tablename__ = "run_tyres"
    id: Mapped[int] = mapped_column(primary_key=True)
    session_id: Mapped[int] = mapped_column(ForeignKey("run_sessions.id", ondelete="CASCADE"), unique=True,
                                            index=True)
    tyres: Mapped[str] = mapped_column(String(8))  # new, used
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now, onupdate=_now)


class TechniqueCache(Base):
    """The technique check of every clean lap of an event or a session (routers/technique.py), and the progress of
    the one being worked out. The full check of each lap is kept in file storage (details)."""
    __tablename__ = "technique_cache"
    id: Mapped[int] = mapped_column(primary_key=True)
    scope: Mapped[str] = mapped_column(String(40), unique=True, index=True)  # "event:3" or "session:12"
    signature: Mapped[str] = mapped_column(String(64))  # the inputs the work in progress (or last done) is for
    status: Mapped[str] = mapped_column(String(16), default="queued")  # queued, running, done, failed
    done: Mapped[int] = mapped_column(Integer, default=0)
    total: Mapped[int] = mapped_column(Integer, default=0)
    current: Mapped[str | None] = mapped_column(String(255))
    error: Mapped[str | None] = mapped_column(Text)
    result: Mapped[dict | None] = mapped_column(JSON)  # every lap's summary and the habits
    details: Mapped[str | None] = mapped_column(String(512))  # storage key of every lap's full check
    result_signature: Mapped[str | None] = mapped_column(String(64))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now, onupdate=_now)


class EventDates(Base):
    """An event's first and last day when they were set by hand (routers/events.py). An event without a row runs
    from its sessions' first log date to their last."""
    __tablename__ = "event_dates"
    id: Mapped[int] = mapped_column(primary_key=True)
    event_id: Mapped[int] = mapped_column(ForeignKey("events.id", ondelete="CASCADE"), unique=True, index=True)
    start: Mapped[date | None] = mapped_column(Date)
    end: Mapped[date | None] = mapped_column(Date)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now, onupdate=_now)


class ImportEvent(Base):
    """An event an import made for an uploaded zip (routers/imports.py), so the app can offer to name it, or to put its
    sessions into an event that already holds the same race weekend, when the upload ends (routers/event_naming.py)."""
    __tablename__ = "import_events"
    id: Mapped[int] = mapped_column(primary_key=True)
    # no foreign keys: the row of an import or event that no longer exists is simply never read
    job_id: Mapped[int] = mapped_column(Integer, index=True)
    event_id: Mapped[int] = mapped_column(Integer)
    archive: Mapped[str | None] = mapped_column(String(255))  # the zip it was made for, as uploaded


# ---------- planned events and the racing calendar (routers/planned.py) ----------
# Their event ids have no foreign key: the events router deletes events without knowing these tables, and a row whose
# event is gone is simply not read (and cleared at the next calendar sync).

class EventPlan(Base):
    """A planned event, made by hand with its venue or from the calendar. Uploads whose log date and venue match it
    go into it."""
    __tablename__ = "event_plans"
    id: Mapped[int] = mapped_column(primary_key=True)
    event_id: Mapped[int] = mapped_column(Integer, unique=True, index=True)
    venue: Mapped[str | None] = mapped_column(String(255))  # as typed, or the calendar entry's location
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)


class CalendarFeed(Base):
    """The racing calendar the server reads now and then. Its secret iCal address is never sent back to the app in
    full and never logged."""
    __tablename__ = "calendar_feeds"
    id: Mapped[int] = mapped_column(primary_key=True)
    url: Mapped[str] = mapped_column(Text)
    auto_add: Mapped[bool] = mapped_column(default=True)  # new calendar entries become events without asking
    name: Mapped[str | None] = mapped_column(String(160))  # the calendar's own name
    checked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))  # the last try
    synced_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))  # the last one that worked
    error: Mapped[str | None] = mapped_column(Text)  # what went wrong with the last try, in words
    summary: Mapped[dict | None] = mapped_column(JSON)  # what the last sync changed
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)


class CalendarEntry(Base):
    """One calendar entry and the event it is in the app. Title, location and days are the calendar's as last read,
    so a change made in the calendar is told apart from one made in the app."""
    __tablename__ = "calendar_entries"
    id: Mapped[int] = mapped_column(primary_key=True)
    uid: Mapped[str] = mapped_column(String(255), unique=True, index=True)  # the calendar event's UID
    title: Mapped[str] = mapped_column(String(160))
    location: Mapped[str | None] = mapped_column(String(255))
    start: Mapped[date] = mapped_column(Date)
    end: Mapped[date] = mapped_column(Date)  # the last day
    included: Mapped[bool] = mapped_column(default=True)  # off: no event for it, until switched on again
    event_id: Mapped[int | None] = mapped_column(Integer, index=True)
    made_event: Mapped[bool] = mapped_column(default=False)  # the sync made the event (not one already there)
    named: Mapped[str | None] = mapped_column(String(160))  # the name the sync gave the event; another: renamed by hand
    seen_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
