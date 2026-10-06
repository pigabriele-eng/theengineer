"""Planned events: made by hand (name, venue, days) or from the racing calendar (calendar_sync.py), usually before
there is any data. An upload whose log was recorded at a planned event's venue on one of its days, or the day before
(travel, setup, a test day), goes into it: the import asks planned_for() for each log it isn't told where to put.
"""
from __future__ import annotations

import re
import unicodedata
from datetime import date, timedelta

from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session

from app import models

DAY_BEFORE = timedelta(days=1)

# words that say nothing about which track it is
_STOP = {
    "circuit", "circuito", "circuits", "autodromo", "autódromo", "raceway", "speedway", "motorsport", "motorsports",
    "international", "internacional", "racing", "race", "races", "track", "park", "grand", "prix", "street", "strasse",
    "the", "and", "van", "von", "der", "des", "del", "della", "de", "di", "du", "la", "le", "les", "het",
    "test", "testing", "day", "days", "weekend", "round", "event", "series", "gt4", "gt3", "gt2", "cup",
    "germany", "deutschland", "netherlands", "nederland", "belgium", "belgique", "france", "italy", "italia",
    "spain", "espana", "austria", "osterreich", "hungary", "portugal", "united", "kingdom", "england", "czech",
    "republic", "poland", "switzerland", "sweden", "denmark", "usa", "emirates",
}


def _plain(text: str | None) -> str:
    """Lower case, without accents, words separated by single spaces."""
    ascii_text = unicodedata.normalize("NFKD", text or "").encode("ascii", "ignore").decode().lower()
    return " ".join(re.split(r"[^a-z0-9]+", ascii_text)).strip()


def _words(text: str | None) -> set[str]:
    return {w for w in _plain(text).split() if len(w) >= 3 and not w.isdigit() and w not in _STOP}


def same_venue(a: str | None, b: str | None) -> bool:
    """Whether two ways of writing a place name the same track: one written out whole in the other ("Test Track" in
    "Test Track, Somewhere"), a word in common, or one word the start of the other (Hockenheim and Hockenheimring)."""
    pa, pb = _plain(a), _plain(b)
    if not pa or not pb:
        return False
    if (len(pa) >= 3 and f" {pa} " in f" {pb} ") or (len(pb) >= 3 and f" {pb} " in f" {pa} "):
        return True
    for x in _words(pa):
        for y in _words(pb):
            if x == y or (min(len(x), len(y)) >= 5 and (x.startswith(y) or y.startswith(x))):
                return True
    return False


def any_same_venue(these: list[str | None], those: list[str | None]) -> bool:
    return any(same_venue(a, b) for a in these if a for b in those if b)


def short_venue(location: str | None) -> str | None:
    """A calendar location's first part: "Circuit Zandvoort" of "Circuit Zandvoort, Burgemeester van ... 108"."""
    if not location:
        return None
    return location.split(",")[0].strip()[:120] or None


def session_counts(db: Session, event_ids: list[int]) -> dict[int, int]:
    if not event_ids:
        return {}
    rows = db.execute(select(models.RunSession.event_id, func.count(models.RunSession.id))
                      .where(models.RunSession.event_id.in_(event_ids)).group_by(models.RunSession.event_id)).all()
    return {eid: n for eid, n in rows}


def has_data(db: Session, event_id: int) -> bool:
    return db.scalar(select(models.RunSession.id).where(models.RunSession.event_id == event_id).limit(1)) is not None


def event_days(db: Session, ev: models.Event) -> tuple[date | None, date | None]:
    """The event's days as the app shows them: set by hand (or by the calendar), else its logs' first and last."""
    row = db.scalar(select(models.EventDates).where(models.EventDates.event_id == ev.id))
    if row is not None and (row.start or row.end):
        return row.start or row.end, row.end or row.start
    from app.routers.imports import _date  # here: the import uses this module
    metas = db.scalars(select(models.LoggerFile.meta).join(models.RunSession)
                       .where(models.RunSession.event_id == ev.id)).all()
    days = sorted(d for m in metas if (d := _date((m or {}).get("date") or "")))
    if days:
        return days[0], days[-1]
    return ev.date, ev.date


def set_days(db: Session, ev: models.Event, start: date | None, end: date | None) -> None:
    """Set the event's days (as the events router does when they're set by hand)."""
    row = db.scalar(select(models.EventDates).where(models.EventDates.event_id == ev.id))
    if row is None:
        row = models.EventDates(event_id=ev.id)
        db.add(row)
    row.start, row.end = start, end
    ev.date = start or end


def create(db: Session, name: str, venue: str | None, start: date | None, end: date | None) -> models.Event:
    """A new planned event: the event, its days and its venue. The caller commits."""
    ev = models.Event(name=name[:160], date=start or end)
    db.add(ev)
    db.flush()
    if start or end:
        set_days(db, ev, start or end, end or start)
    db.add(models.EventPlan(event_id=ev.id, venue=(venue or "").strip()[:255] or None))
    db.flush()
    return ev


def plan_of(db: Session, event_id: int) -> models.EventPlan | None:
    return db.scalar(select(models.EventPlan).where(models.EventPlan.event_id == event_id))


def ensure_plan(db: Session, event_id: int, venue: str | None) -> None:
    """Make an event planned (uploads at its venue on its days go into it), keeping a venue it already has."""
    plan = plan_of(db, event_id)
    if plan is None:
        db.add(models.EventPlan(event_id=event_id, venue=venue))
    elif not plan.venue and venue:
        plan.venue = venue


def remove(db: Session, ev: models.Event) -> None:
    """Delete an event that has no sessions, and what was kept for it. The caller checks and commits."""
    scope = f"event:{ev.id}"
    db.execute(delete(models.EventDates).where(models.EventDates.event_id == ev.id))
    db.execute(delete(models.ReportCache).where(models.ReportCache.scope == scope))
    db.execute(delete(models.TechniqueCache).where(models.TechniqueCache.scope == scope))
    db.execute(delete(models.EventPlan).where(models.EventPlan.event_id == ev.id))
    db.delete(ev)
    db.flush()


def planned_for(db: Session, meta: dict) -> models.Event | None:
    """The planned event a log belongs to: one whose days (or the day before) hold the day it was recorded, at the
    same venue. A plan without a venue, or a log without one, goes by the day alone; a venue match wins over that,
    then the shortest event."""
    from app.routers.imports import _date  # here: the import uses this module
    day = _date((meta or {}).get("date") or "")
    if day is None:
        return None
    venue = ((meta or {}).get("venue") or "").strip()
    best: tuple[tuple, models.Event] | None = None
    for plan in db.scalars(select(models.EventPlan)).all():
        ev = db.get(models.Event, plan.event_id)
        if ev is None:
            continue
        start, end = event_days(db, ev)
        if start is None or not (start - DAY_BEFORE <= day <= (end or start)):
            continue
        where = [w for w in (plan.venue, ev.track.name if ev.track else None) if _plain(w)]
        said = bool(_plain(venue)) and bool(where)
        if said and not any_same_venue([venue], [*where, ev.name]):
            continue
        rank = (said, -((end or start) - start).days, ev.id)
        if best is None or rank > best[0]:
            best = (rank, ev)
    return best[1] if best else None
