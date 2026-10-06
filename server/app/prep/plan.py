"""What a prep report is made from: the venue's past events and, in each, the sessions of the same car. Nothing here
reads a log.

The venue is the event's track (else the venue its logs name, else the track a planned event's venue as written
names); two track records count as one venue when they are the same known circuit ("Hockenheimring" and "Hockenheim
GP") or share a name. Past means an event that started before this one (all of them when this one has no date yet).

The same car: the car record a session is linked to; a session without one counts for the car its logs come from,
by the logger's serial (a dash stays in its car), else the vehicle its logs name. That is the tyre model's choice
too (routers/tyre_model.py). An event with sessions is prepared for its own car; an upcoming event for the car
driven most recently that has data at the venue, and any other car with data there can be picked instead, or every
car at once ("any").
"""
from __future__ import annotations

import re
import statistics
from collections import Counter
from dataclasses import dataclass, field
from datetime import date

from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from app import models
from app.known_tracks import known_track
from app.plans import same_venue, short_venue
from app.routers.events import _folder
from app.routers.imports import _date
from app.vehicle.tyre_store import logger_identity

ANY = "any"  # every car with data at the venue
PLAUSIBLE = 0.8  # a clean lap quicker than this share of the median lap is a stub (a pit log's few seconds)
UNKNOWN = "unknown"
QUALI = re.compile(r"^(?:\d+[_\s.-]+)?(q\d*|qp|quali\w*|qualifying)\b", re.I)  # "Q", "03_Q", "Qualifying 1"
RACE = re.compile(r"^(?:\d+[_\s.-]+)?(r\d+|race\s*\d*|rennen\s*\d*|gara\s*\d*)\b", re.I)  # "R1", "04_R1"


def main_file(s: models.RunSession) -> models.LoggerFile | None:
    """The log the analysis reads for a session: the longest."""
    return max(s.files, key=lambda f: f.meta.get("duration_s", 0)) if s.files else None


def clean_laps(s: models.RunSession) -> list[models.Lap]:
    f = main_file(s)
    return [l for l in s.laps if f is not None and l.file_id == f.id and l.clean]


def lap_times(sessions: list[models.RunSession]) -> dict[int, list[float]]:
    """Each session's clean lap times, quickest first, without the impossible ones: a "lap" far quicker than the
    median lap of all these sessions is a stub (a pit log's few seconds), not a lap."""
    raw = {s.id: [lap.time_s for lap in clean_laps(s) if lap.time_s] for s in sessions}
    every = [t for v in raw.values() for t in v]
    floor = PLAUSIBLE * statistics.median(every) if every else 0.0
    return {k: sorted(t for t in v if t >= floor) for k, v in raw.items()}


def car_of(s: models.RunSession) -> tuple[str, str]:
    """The car a session counts for: its car record, else its logger, else the vehicle its logs name."""
    if s.car_id is not None:
        return f"car:{s.car_id}", (s.car.name if s.car else f"Car {s.car_id}")
    f = main_file(s)
    if f is not None:
        key, label = logger_identity(f)
        if key != UNKNOWN:
            return key, label
    return UNKNOWN, "Car not named in the logs"


def session_kind(s: models.RunSession) -> str:
    """qualifying, race or other: the kind set in the app, else what the session's or its log's name says (Q, R1)."""
    if s.kind in (models.SessionKind.qualifying, models.SessionKind.race):
        return s.kind.value
    f = main_file(s)
    for text in ((f.meta.get("event_session") if f else None), s.name):
        text = (text or "").strip()
        if QUALI.match(text):
            return "qualifying"
        if RACE.match(text):
            return "race"
    return "other"


def run_day(s: models.RunSession) -> date | None:
    f = main_file(s)
    return _date(f.meta.get("date") or "") if f is not None else None


def venue_key(name: str | None) -> str | None:
    if not name or not name.strip():
        return None
    known = known_track(name)
    return (known[0] if known else name).strip().lower()


@dataclass
class EventInfo:
    event: models.Event
    sessions: list[models.RunSession]
    start: str | None  # ISO dates, as the event list shows them
    end: str | None
    venue: str | None
    track: models.Track | None


@dataclass
class PastEvent:
    info: EventInfo
    sessions: list[models.RunSession]  # this car's sessions with clean laps
    other_cars: bool  # the event also holds sessions of other cars

    @property
    def id(self) -> int:
        return self.info.event.id


@dataclass
class Plan:
    target: EventInfo
    car: str
    car_label: str
    cars: list[dict] = field(default_factory=list)  # every car with past data here: key, label, events, latest
    past: list[PastEvent] = field(default_factory=list)  # oldest first
    error: str | None = None

    @property
    def scope(self) -> str:
        return f"event:{self.target.event.id}|car:{self.car}"[:160]


def index(db: Session) -> list[EventInfo]:
    """Every event with its sessions, dates and venue (one query per table)."""
    sessions = db.scalars(select(models.RunSession).where(models.RunSession.event_id.is_not(None)).options(
        selectinload(models.RunSession.laps), selectinload(models.RunSession.files),
        selectinload(models.RunSession.driver), selectinload(models.RunSession.car))).all()
    by_event: dict[int, list[models.RunSession]] = {}
    for s in sessions:
        by_event.setdefault(s.event_id, []).append(s)
    dates = {d.event_id: d for d in db.scalars(select(models.EventDates)).all()}
    tracks = {t.name.strip().lower(): t for t in db.scalars(select(models.Track)).all()}
    planned = {p.event_id: p.venue for p in db.scalars(select(models.EventPlan)).all() if p.venue}
    out = []
    for ev in db.scalars(select(models.Event).options(selectinload(models.Event.track))).all():
        mine = by_event.get(ev.id, [])
        folder = _folder(ev, mine, dates.get(ev.id))
        venue = folder["track"]
        track = ev.track or (tracks.get(venue.strip().lower()) if venue else None)
        if venue is None and ev.id in planned:
            # a planned event (by hand or from the calendar) has only the venue as written: the track it names
            track = next((t for t in tracks.values() if same_venue(planned[ev.id], t.name)), None)
            venue = track.name if track is not None else short_venue(planned[ev.id])
        out.append(EventInfo(ev, mine, folder["start"], folder["end"], venue, track))
    return out


def _timed(info: EventInfo) -> list[models.RunSession]:
    return [s for s in info.sessions if clean_laps(s)]


def _before(a: EventInfo, target: EventInfo) -> bool:
    if target.start is None or a.start is None:
        return True
    return a.start < target.start


def past_events_here(infos: list[EventInfo], target: EventInfo) -> list[EventInfo]:
    """The events at the target's venue that started before it and have clean laps, oldest first."""
    key = venue_key(target.venue)
    if key is None:
        return []
    here = [i for i in infos if i.event.id != target.event.id and venue_key(i.venue) == key and _before(i, target)
            and _timed(i)]
    return sorted(here, key=lambda i: (i.start or "", i.event.id))


def _latest_run(infos: list[EventInfo]) -> dict[str, date]:
    """The last day each car was driven, anywhere."""
    out: dict[str, date] = {}
    for i in infos:
        for s in _timed(i):
            day = run_day(s) or (date.fromisoformat(i.start) if i.start else None)
            key = car_of(s)[0]
            if day is not None and (key not in out or day > out[key]):
                out[key] = day
    return out


def plan(db: Session, event_id: int, car: str | None = None, infos: list[EventInfo] | None = None) -> Plan | None:
    """The prep report's plan for an event, or None when there is no such event."""
    infos = infos if infos is not None else index(db)
    target = next((i for i in infos if i.event.id == event_id), None)
    if target is None:
        return None
    here = past_events_here(infos, target)
    cars: dict[str, dict] = {}
    for i in here:
        for s in _timed(i):
            key, label = car_of(s)
            c = cars.setdefault(key, {"key": key, "label": label, "events": set(), "sessions": 0})
            c["events"].add(i.event.id)
            c["sessions"] += 1
    latest = _latest_run(infos)
    listed = sorted(({**c, "events": len(c["events"]), "latest": latest[k].isoformat() if k in latest else None}
                     for k, c in cars.items()), key=lambda c: (c["latest"] or "", c["events"]), reverse=True)
    own = Counter(car_of(s)[0] for s in _timed(target)) or Counter(car_of(s)[0] for s in target.sessions if s.files)
    if car is None or (car != ANY and car not in cars and car not in own):
        car = own.most_common(1)[0][0] if own else (listed[0]["key"] if listed else UNKNOWN)
    if car == ANY:
        label = "every car with data here"
    else:
        label = next((c["label"] for c in listed if c["key"] == car), None) or next(
            (car_of(s)[1] for s in target.sessions if car_of(s)[0] == car), car)
    p = Plan(target, car, label, listed)
    if venue_key(target.venue) is None:
        p.error = "This event has no track yet, so there is nothing to look back on."
        return p
    for i in here:
        timed = _timed(i)
        mine = [s for s in timed if car == ANY or car_of(s)[0] == car]
        if mine:
            p.past.append(PastEvent(i, mine, len(mine) < len(timed)))
    return p


def availability(db: Session) -> dict[int, dict]:
    """For the event list: every event whose venue has past data, how many past events and of which years, and
    whether its own car has any."""
    infos = index(db)
    out = {}
    for target in infos:
        here = past_events_here(infos, target)
        if not here:
            continue
        own = {car_of(s)[0] for s in _timed(target)}
        same = [i for i in here if not own or any(car_of(s)[0] in own for s in _timed(i))]
        years = sorted({i.start[:4] for i in here if i.start})
        out[target.event.id] = {"events": len(here), "same_car_events": len(same), "years": years,
                                "upcoming": not target.sessions}
    return out
