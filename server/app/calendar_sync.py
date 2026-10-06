"""The racing calendar: planned events kept in step with a calendar's secret iCal address (in Google Calendar: the
calendar's settings, Integrate calendar, "Secret address in iCal format"), so no Google developer setup is needed.

The address is a secret. It is kept in the database (calendar_feeds), shown back to the app only as its host and last
four characters, and never logged: httpx's request log (which would print it) is turned down, and every error about
the feed is worded here without it.

apply() keeps calendar_entries in step with the feed, keyed by each entry's UID:
- A new entry (ending no more than PAST_DAYS ago, starting within FUTURE_DAYS) is switched on when the feed adds its
  new entries by itself (auto_add, the default), else it waits switched off for Gabriele to pick. Switched on, it is
  linked to an event already there on overlapping days at the same venue (e.g. logs uploaded before the sync), else it
  makes a planned event.
- A changed entry changes its event: the days when the calendar's days changed; the name when the calendar's title
  changed and the event still has the name the sync gave it (a name given in the app is kept); the planned venue.
  Nothing else of an event is ever changed, and no session is ever moved.
- An entry gone from the calendar (or cancelled) removes the planned event it made when that has no data; an event
  with data stays, no longer linked.
- An entry whose event was deleted in the app is switched off, so later syncs don't bring it back.
Switching an entry off (set_included) does what a removed entry does; switching it on links or makes its event again.

The server reads the feed in the background now and then (start()), when the app opens the event list and the last
try is older than STALE (kick()), and on demand (Sync now). Nothing here reads a log.
"""
from __future__ import annotations

import logging
import os
import threading
from collections import Counter
from datetime import UTC, date, datetime, timedelta
from urllib.parse import urlsplit

import httpx
from sqlalchemy import select
from sqlalchemy.orm import Session

from app import db as app_db  # SessionLocal is looked up when used: the tests swap the database
from app import ics, models, plans

log = logging.getLogger(__name__)
logging.getLogger("httpx").setLevel(logging.WARNING)  # its INFO line prints each URL: the calendar's is a secret

PAST_DAYS = 180  # older calendar entries aren't brought in
FUTURE_DAYS = 730
FETCH_TIMEOUT_S = 20
MAX_FEED_BYTES = 5 * 1024 * 1024
MAX_URL = 2048
CHECK_EVERY_S = 600  # the background job wakes up this often...
SYNC_EVERY = timedelta(hours=1)  # ...and reads the feed when it was last tried longer ago than this
STALE = timedelta(minutes=30)  # opening the event list reads a feed last tried longer ago than this

_lock = threading.Lock()  # one change to the entries at a time (a sync, a switch, a removal)
_busy = threading.Lock()  # one feed read at a time
_stop = threading.Event()
_thread: threading.Thread | None = None
_kicked: threading.Thread | None = None


class FeedError(Exception):
    """Why the calendar couldn't be read, in words for the app (never with its address)."""


def _now() -> datetime:
    return datetime.now(UTC)


def _aware(t: datetime | None) -> datetime | None:
    return t.replace(tzinfo=UTC) if t is not None and t.tzinfo is None else t  # SQLite gives times back naive


# ---------- the address ----------

def clean_url(text: str) -> str:
    """The calendar address as pasted, checked: https (webcal:// is the same address), or http on this machine when
    sign-in is off (local tests). Raises ValueError with what to do instead."""
    t = (text or "").strip()
    if not t:
        raise ValueError("Paste the calendar's secret address in iCal format.")
    if len(t) > MAX_URL:
        raise ValueError("That address is too long to be a calendar's iCal address.")
    if t.lower().startswith("webcal://"):
        t = "https://" + t[len("webcal://"):]
    u = urlsplit(t)
    local = u.scheme == "http" and u.hostname in ("localhost", "127.0.0.1") and not os.environ.get("SUPABASE_URL")
    if not (u.scheme == "https" or local) or not u.hostname or "@" in u.netloc:
        raise ValueError("That isn't a calendar address: it starts with https:// and, in Google Calendar, ends in "
                         "basic.ics (the \"Secret address in iCal format\").")
    if u.hostname == "calendar.google.com" and "/ical/" not in u.path:
        raise ValueError("That's a link to the calendar's page, not its iCal address. In the calendar's settings, "
                         "under Integrate calendar, copy the \"Secret address in iCal format\" (it ends in basic.ics).")
    return t


def masked(url: str) -> dict:
    """What the app may show of the address: its host and the last four characters of its secret part."""
    u = urlsplit(url)
    parts = [p for p in u.path.split("/") if p]
    if parts and parts[-1].lower().endswith(".ics") and len(parts) >= 2:
        parts = parts[:-1]
    key = parts[-1] if parts else ""
    return {"host": u.hostname, "ends_with": key[-4:] if len(key) >= 12 else None}


def fetch(url: str) -> bytes:
    """The feed, at most MAX_FEED_BYTES. Raises FeedError."""
    try:
        with (httpx.Client(timeout=FETCH_TIMEOUT_S, follow_redirects=True,
                           headers={"User-Agent": "The Engineer calendar sync"}) as client,
              client.stream("GET", url) as r):
            if r.status_code in (401, 403, 404, 410):
                raise FeedError("The calendar wasn't found at that address. Copy its \"Secret address in iCal "
                                "format\" again: if it was reset in Google Calendar, the old one stopped working.")
            if r.status_code != 200:
                raise FeedError(f"The calendar's server answered {r.status_code}. It will be tried again later.")
            buf = bytearray()
            for chunk in r.iter_bytes():
                buf += chunk
                if len(buf) > MAX_FEED_BYTES:
                    raise FeedError("The calendar is too big to read (more than 5 MB): use a calendar just for "
                                    "racing.")
            return bytes(buf)
    except httpx.TimeoutException:
        raise FeedError("The calendar didn't answer in time. It will be tried again later.") from None
    except (httpx.HTTPError, httpx.InvalidURL, ValueError):  # their messages can hold the address: not passed on
        raise FeedError("Couldn't reach the calendar. It will be tried again later.") from None


def read(url: str) -> ics.Calendar:
    data = fetch(url)
    try:
        return ics.parse(data)
    except ValueError:
        raise FeedError("That address doesn't give a calendar (an iCal file). Copy the \"Secret address in iCal "
                        "format\" from the calendar's settings.") from None


def feed_of(db: Session) -> models.CalendarFeed | None:
    return db.scalar(select(models.CalendarFeed).order_by(models.CalendarFeed.id).limit(1))


# ---------- keeping the entries in step ----------

class _Events:
    """Every event's days and what says where it was (planned venue, track, name), worked out once per sync."""

    def __init__(self, db: Session):
        from app.routers.imports import _date  # here: the import uses plans, which this module uses
        self.events = {ev.id: ev for ev in db.scalars(select(models.Event)).all()}
        hand = {d.event_id: d for d in db.scalars(select(models.EventDates)).all()}
        venues = {p.event_id: p.venue for p in db.scalars(select(models.EventPlan)).all()}
        logged: dict[int, list[date]] = {}
        for eid, meta in db.execute(select(models.RunSession.event_id, models.LoggerFile.meta)
                                    .join(models.LoggerFile).where(models.RunSession.event_id.is_not(None))):
            if d := _date((meta or {}).get("date") or ""):
                logged.setdefault(eid, []).append(d)
        self.days: dict[int, tuple[date, date]] = {}
        self.where: dict[int, list[str | None]] = {}
        for eid, ev in self.events.items():
            h = hand.get(eid)
            if h is not None and (h.start or h.end):
                self.days[eid] = (h.start or h.end, h.end or h.start)
            elif logged.get(eid):
                self.days[eid] = (min(logged[eid]), max(logged[eid]))
            elif ev.date:
                self.days[eid] = (ev.date, ev.date)
            self.where[eid] = [venues.get(eid), ev.track.name if ev.track else None, ev.name]

    def match(self, row: models.CalendarEntry, taken: set[int]) -> models.Event | None:
        """An event already there for this entry: overlapping days (or its logs from the day before) at the same
        venue (the entry's location or title against the event's venue, track or name); the most days in common."""
        best = None
        for eid, (start, end) in self.days.items():
            if eid in taken or end < row.start - plans.DAY_BEFORE or start > row.end:
                continue
            if not plans.any_same_venue([row.location, row.title], self.where[eid]):
                continue
            overlap = (min(end, row.end) - max(start, row.start)).days
            rank = (overlap, eid)
            if best is None or rank > best[0]:
                best = (rank, self.events[eid])
        return best[1] if best else None


def _event_of(db: Session, row: models.CalendarEntry) -> models.Event | None:
    return db.get(models.Event, row.event_id) if row.event_id is not None else None


def _unlink(row: models.CalendarEntry) -> None:
    row.event_id, row.made_event, row.named = None, False, None


def _attach(db: Session, row: models.CalendarEntry, index: _Events | None = None) -> None:
    """Switch the entry on: link it to an event already there for it, else make its planned event."""
    taken = set(db.scalars(select(models.CalendarEntry.event_id).where(models.CalendarEntry.event_id.is_not(None),
                                                                       models.CalendarEntry.id != row.id)))
    ev = (index or _Events(db)).match(row, taken)
    if ev is not None:
        row.event_id, row.made_event = ev.id, False
        row.named = ev.name if ev.name == row.title else None  # a name it had already is never changed
        plans.ensure_plan(db, ev.id, row.location)
    else:
        ev = plans.create(db, row.title, row.location, row.start, row.end)
        row.event_id, row.made_event, row.named = ev.id, True, ev.name
    row.included = True
    db.flush()  # the next entry sees this event taken


def _let_go(db: Session, row: models.CalendarEntry) -> str | None:
    """Unlink the entry from its event, deleting the event when the sync made it and it has no data. What happened
    to the event: "removed", "kept" (it has data, or was there before the calendar) or None (no event)."""
    ev, made = _event_of(db, row), row.made_event
    _unlink(row)
    if ev is None:
        return None
    if made and not plans.has_data(db, ev.id):
        plans.remove(db, ev)
        return "removed"
    return "kept"


def _follow(db: Session, row: models.CalendarEntry, ev: models.Event, e: ics.Entry) -> bool:
    """Bring the calendar's changes to the event: the days, the name unless it was renamed in the app, the venue."""
    changed = False
    if (e.start, e.end) != (row.start, row.end):
        plans.set_days(db, ev, e.start, e.end)
        changed = True
    if e.title != row.title and row.named is not None and ev.name == row.named:
        ev.name = row.named = e.title
        changed = True
    if e.location != row.location:
        plan = plans.plan_of(db, ev.id)
        if plan is not None and plan.venue == row.location:  # the venue the calendar gave it
            plan.venue = e.location
            changed = True
    return changed


def apply(db: Session, cal: ics.Calendar, auto_add: bool, today: date | None = None) -> dict:
    """Keep the entries and their events in step with the calendar just read (see the module's notes). The caller
    holds _lock and commits. Counts of what changed."""
    today = today or date.today()
    n: Counter = Counter()
    wanted: dict[str, ics.Entry] = {}
    for e in cal.entries:
        if e.repeats:
            n["repeating"] += 1
        elif not e.cancelled:
            wanted.setdefault(e.uid, e)
    rows = {r.uid: r for r in db.scalars(select(models.CalendarEntry)).all()}
    for uid, row in rows.items():
        if uid not in wanted:  # deleted (or cancelled) in the calendar
            if _let_go(db, row) == "removed":
                n["removed"] += 1
            db.delete(row)
    db.flush()
    oldest, latest = today - timedelta(days=PAST_DAYS), today + timedelta(days=FUTURE_DAYS)
    index: _Events | None = None
    for uid, e in wanted.items():
        row = rows.get(uid)
        if row is None:
            if e.end < oldest or e.start > latest:
                continue
            row = models.CalendarEntry(uid=uid, title=e.title, location=e.location, start=e.start, end=e.end,
                                       included=False, seen_at=_now())
            db.add(row)
            db.flush()
            if auto_add:
                index = index or _Events(db)
                _attach(db, row, index)
                n["added"] += 1
            else:
                n["waiting"] += 1
            continue
        ev = _event_of(db, row)
        if row.event_id is not None and ev is None:  # its event was deleted in the app: keep it out from now on
            _unlink(row)
            row.included = False
            n["switched_off"] += 1
        elif ev is not None and _follow(db, row, ev, e):
            n["updated"] += 1
        row.title, row.location, row.start, row.end, row.seen_at = e.title, e.location, e.start, e.end, _now()
        if row.included and row.event_id is None:  # switched on but without its event (e.g. a sync that failed)
            _attach(db, row)
    db.flush()
    # plans of events deleted in the app
    known = set(db.scalars(select(models.Event.id)))
    for plan in db.scalars(select(models.EventPlan)).all():
        if plan.event_id not in known:
            db.delete(plan)
    return {k: v for k, v in n.items() if v}


def set_included(db: Session, row: models.CalendarEntry, on: bool) -> str | None:
    """Switch an entry on (its event is linked or made) or off (its planned event goes when it has no data, and the
    entry stays out of later syncs). The caller holds _lock and commits. What happened to the event when off."""
    if on:
        if not row.included or _event_of(db, row) is None:
            _attach(db, row)
        return None
    row.included = False
    return _let_go(db, row)


def remove_planned(db: Session, ev: models.Event) -> None:
    """Delete a planned event with no data; a calendar entry it came from stays out of later syncs. The caller checks
    there is no data, holds _lock and commits."""
    for row in db.scalars(select(models.CalendarEntry).where(models.CalendarEntry.event_id == ev.id)).all():
        _unlink(row)
        row.included = False
    plans.remove(db, ev)


def disconnect(db: Session) -> int:
    """Forget the calendar: its address, its entries and the planned events it made that have no data. The caller
    holds _lock and commits. How many events went."""
    gone = 0
    for row in db.scalars(select(models.CalendarEntry)).all():
        if _let_go(db, row) == "removed":
            gone += 1
        db.delete(row)
    for feed in db.scalars(select(models.CalendarFeed)).all():
        db.delete(feed)
    return gone


# ---------- reading the feed ----------

def run_sync(db: Session) -> None:
    """Read the feed and keep the events in step; the outcome (or what went wrong) is kept on the feed."""
    feed = feed_of(db)
    if feed is None:
        return
    url, feed_id = feed.url, feed.id
    try:
        cal, error = read(url), None
    except FeedError as e:
        cal, error = None, str(e)
    with _lock:
        db.expire_all()
        feed = feed_of(db)
        if feed is None or feed.id != feed_id or feed.url != url:  # disconnected or replaced meanwhile
            return
        feed.checked_at = _now()
        if cal is None:
            feed.error = error
            db.commit()
            return
        try:
            summary = apply(db, cal, feed.auto_add)
        except Exception:
            db.rollback()
            log.exception("Bringing the calendar's entries in failed")
            feed = feed_of(db)
            if feed is not None:
                feed.checked_at, feed.error = _now(), "The calendar was read but its entries couldn't be brought in."
                db.commit()
            return
        feed.name, feed.synced_at, feed.error, feed.summary = cal.name, _now(), None, summary
        db.commit()


def sync_now(db: Session) -> None:
    """Sync now: waits for a sync already running, then reads the feed again."""
    with _busy:
        run_sync(db)


def _sync_if_due(age: timedelta) -> None:
    if not _busy.acquire(blocking=False):
        return
    try:
        with app_db.SessionLocal() as db:
            feed = feed_of(db)
            last = _aware(feed.checked_at) if feed is not None else None
            if feed is not None and (last is None or _now() - last >= age):
                run_sync(db)
    except Exception:
        log.exception("The calendar sync failed")
    finally:
        _busy.release()


def kick(feed: models.CalendarFeed | None) -> bool:
    """Read the feed in the background when it was last tried longer ago than STALE. Whether a sync is running."""
    global _kicked
    if feed is None:
        return False
    last = _aware(feed.checked_at)
    if _busy.locked():
        return True
    if last is not None and _now() - last < STALE:
        return False
    _kicked = threading.Thread(target=_sync_if_due, args=(STALE,), name="calendar-kick", daemon=True)
    _kicked.start()
    return True


def syncing() -> bool:
    return _busy.locked()


def _loop() -> None:
    while not _stop.wait(CHECK_EVERY_S):
        _sync_if_due(SYNC_EVERY)


def start() -> None:
    """On startup: read the calendar now and then, in the background."""
    global _thread
    _stop.clear()
    if _thread is None or not _thread.is_alive():
        _thread = threading.Thread(target=_loop, name="calendar-sync", daemon=True)
        _thread.start()


def stop() -> None:
    _stop.set()


def wait_idle(timeout: float = 30) -> None:
    """Until a background sync started from the app is done (for tests)."""
    if _kicked is not None:
        _kicked.join(timeout)
