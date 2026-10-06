"""Planned events and the racing calendar, for the event list's Past / Current / Upcoming filter.

POST /planned-events makes a planned event by hand (name, venue, days); DELETE /planned-events/{id} removes one that
has no data (an entry of the calendar it came from then stays out of later syncs).

GET /calendar is what the app shows of the calendar: the address as its host and last four characters only, when it
was last read and what changed, its entries with an on/off each, and the venue of every planned event. It starts a
sync in the background when the last one is older than calendar_sync.STALE. PUT /calendar connects a calendar (read
at once, so a wrong address is told straight away), PATCH sets whether new entries become events by themselves,
DELETE disconnects, POST /calendar/sync reads it now, PATCH /calendar/entries/{id} switches one entry on or off.
"""
from __future__ import annotations

from datetime import date, timedelta

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from app import calendar_sync, models, plans
from app.db import get_db
from app.routers import events

router = APIRouter()


class PlanIn(BaseModel):
    name: str = Field(min_length=1, max_length=160)
    venue: str | None = Field(None, max_length=255)
    start: date | None = None
    end: date | None = None


class FeedIn(BaseModel):
    url: str  # checked by calendar_sync.clean_url, so a refusal never repeats the secret address back
    auto_add: bool = True


class FeedPatch(BaseModel):
    auto_add: bool


class EntryPatch(BaseModel):
    included: bool


def state(db: Session, note: str | None = None) -> dict:
    feed = calendar_sync.feed_of(db)
    today = date.today()
    entries = db.scalars(select(models.CalendarEntry).order_by(models.CalendarEntry.start,
                                                               models.CalendarEntry.id)).all()
    shown = [e for e in entries if e.end >= today - timedelta(days=calendar_sync.PAST_DAYS) or e.event_id]
    plan_rows = db.scalars(select(models.EventPlan)).all()
    ids = {p.event_id for p in plan_rows} | {e.event_id for e in shown if e.event_id is not None}
    there = set(db.scalars(select(models.Event.id).where(models.Event.id.in_(ids)))) if ids else set()
    counts = plans.session_counts(db, sorted(there))
    from_calendar = {e.event_id for e in entries if e.event_id is not None}
    out_feed = None
    if feed is not None:
        out_feed = {**calendar_sync.masked(feed.url), "name": feed.name, "auto_add": feed.auto_add,
                    "checked_at": _iso(feed.checked_at), "synced_at": _iso(feed.synced_at), "error": feed.error,
                    "summary": feed.summary or {}, "syncing": calendar_sync.syncing()}
    return {
        "feed": out_feed,
        "entries": [{"id": e.id, "title": e.title, "location": e.location, "venue": plans.short_venue(e.location),
                     "start": e.start.isoformat(), "end": e.end.isoformat(), "included": e.included,
                     "event_id": e.event_id if e.event_id in there else None,
                     "has_data": counts.get(e.event_id, 0) > 0} for e in shown],
        "plans": [{"event_id": p.event_id, "venue": plans.short_venue(p.venue),
                   "from_calendar": p.event_id in from_calendar} for p in plan_rows if p.event_id in there],
        "note": note,
    }


def _iso(t) -> str | None:
    t = calendar_sync._aware(t)
    return t.isoformat() if t is not None else None


@router.get("/calendar")
def get_calendar(db: Session = Depends(get_db)):
    calendar_sync.kick(calendar_sync.feed_of(db))
    return state(db)


@router.put("/calendar")
def connect(body: FeedIn, db: Session = Depends(get_db)):
    """Connect the calendar (or another one in its place): it is read now, and its entries brought in."""
    try:
        url = calendar_sync.clean_url(body.url)
    except ValueError as e:
        raise HTTPException(422, str(e)) from None
    try:
        cal = calendar_sync.read(url)
    except calendar_sync.FeedError as e:
        raise HTTPException(422, str(e)) from None
    with calendar_sync._lock:
        feed = calendar_sync.feed_of(db)
        if feed is None:
            feed = models.CalendarFeed(url=url)
            db.add(feed)
        feed.url, feed.auto_add = url, body.auto_add
        summary = calendar_sync.apply(db, cal, body.auto_add)
        now = calendar_sync._now()
        feed.name, feed.checked_at, feed.synced_at, feed.error, feed.summary = cal.name, now, now, None, summary
        db.commit()
    return state(db)


@router.patch("/calendar")
def set_auto_add(body: FeedPatch, db: Session = Depends(get_db)):
    feed = calendar_sync.feed_of(db)
    if feed is None:
        raise HTTPException(404, "No calendar connected")
    feed.auto_add = body.auto_add
    db.commit()
    return state(db)


@router.delete("/calendar")
def disconnect(db: Session = Depends(get_db)):
    """Forget the calendar's address and entries; its planned events that have no data go too."""
    with calendar_sync._lock:
        gone = calendar_sync.disconnect(db)
        db.commit()
    return state(db, f"Disconnected; {gone} planned event{'' if gone == 1 else 's'} without data removed."
                 if gone else "Disconnected.")


@router.post("/calendar/sync")
def sync(db: Session = Depends(get_db)):
    if calendar_sync.feed_of(db) is None:
        raise HTTPException(404, "No calendar connected")
    calendar_sync.sync_now(db)
    db.expire_all()
    return state(db)


@router.patch("/calendar/entries/{entry_id}")
def switch_entry(entry_id: int, body: EntryPatch, db: Session = Depends(get_db)):
    """Switch a calendar entry on (it becomes an event) or off (its planned event goes unless it has data, and the
    entry stays out of later syncs until switched on again)."""
    with calendar_sync._lock:
        row = db.get(models.CalendarEntry, entry_id)
        if row is None:
            raise HTTPException(404, "Calendar entry not found")
        happened = calendar_sync.set_included(db, row, body.included)
        db.commit()
    note = "Kept its event: it has data. Delete it from its page if you want it gone." if happened == "kept" else None
    return state(db, note)


@router.post("/planned-events", status_code=201)
def make_planned(body: PlanIn, db: Session = Depends(get_db)):
    """A planned event made by hand: logs uploaded later at its venue on its days (or the day before) go into it."""
    if body.start and body.end and body.end < body.start:
        raise HTTPException(422, "The last day is before the first day")
    name = body.name.strip()
    if not name:
        raise HTTPException(422, "Give the event a name")
    ev = plans.create(db, name, body.venue, body.start or body.end, body.end or body.start)
    db.commit()
    return events.folder(str(ev.id), db)


@router.delete("/planned-events/{event_id}")
def remove_planned(event_id: int, db: Session = Depends(get_db)):
    """Remove a planned event that has no data yet."""
    with calendar_sync._lock:
        ev = db.get(models.Event, event_id)
        if ev is None:
            raise HTTPException(404, "Event not found")
        if plans.has_data(db, event_id):
            raise HTTPException(409, "This event has sessions: delete it from its page, which keeps them")
        calendar_sync.remove_planned(db, ev)
        db.commit()
    return {"deleted": event_id}
