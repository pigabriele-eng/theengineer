"""Official results kept in the database: whole seasons loaded once, the round of a current event kept fresh.

One job runs at a time, in a background thread. A season's sync reads the series site's list of rounds and, for
each round, its list of session PDFs; a PDF is downloaded and read only when its address is new (the site gives a
corrected classification a new file name, "..._ResultList_2.0.PDF"), unless the sync is forced. Reading a PDF
takes the heavy lock so it never runs beside a log being analysed.

On the live server, start() at startup loads every season from FIRST_YEAR that isn't loaded yet and checks the
current season once a day; while one of our events linked to a round is on (from the day before it to two days
after), that round is fetched again every REFRESH_MINUTES.
"""
from __future__ import annotations

import logging
import sys
import threading
import time
from datetime import UTC, date, datetime, timedelta

import httpx
from sqlalchemy import select
from sqlalchemy.orm import Session

from app import db as app_db  # SessionLocal is looked up when used: the tests swap the database
from app import heavy, models
from app.results import gt4europe
from app.results import models as rm
from app.results.resultlist import parse_pdf
from app.results.venues import venue_key

log = logging.getLogger(__name__)

ADAPTERS = {gt4europe.SERIES: gt4europe}
DEFAULT_SERIES = gt4europe.SERIES
FIRST_YEAR = 2021  # two seasons before the first one predictions are tested on
REFRESH_MINUTES = 10
PAUSE_S = 0.5  # between downloads, to go easy on the series' site


class _State:
    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.thread: threading.Thread | None = None
        self.running = False
        self.what: str | None = None
        self.done = 0
        self.total = 0
        self.errors: list[str] = []
        self.finished_at: datetime | None = None

    def as_dict(self) -> dict:
        return {"running": self.running, "what": self.what, "done": self.done, "total": self.total,
                "errors": self.errors[-10:],
                "finished_at": self.finished_at.isoformat() if self.finished_at else None}


state = _State()


def _round_row(db: Session, series: str, year: int, round_id: str, name: str, order: int) -> rm.ResultRound:
    r = db.scalar(select(rm.ResultRound).where(rm.ResultRound.series == series, rm.ResultRound.year == year,
                                               rm.ResultRound.round_id == round_id))
    if r is None:
        r = rm.ResultRound(series=series, year=year, round_id=round_id, name=name, venue=venue_key(name),
                           order=order)
        db.add(r)
    else:
        r.name, r.venue, r.order = name, venue_key(name), order
    return r


def store_session(db: Session, rnd: rm.ResultRound, code: str, title: str, url: str, data: bytes) -> rm.ResultSession:
    """Read one result PDF into the round, replacing what was there for that session."""
    with heavy.lock:
        parsed = parse_pdf(data)
    s = next((x for x in rnd.sessions if x.code == code), None)
    if s is None:
        s = rm.ResultSession(code=code, title=title, kind="qualifying" if code.startswith("Q") else "race",
                             source_url=url)
        rnd.sessions.append(s)
    s.title, s.source_url, s.fetched_at = parsed.title or title, url, datetime.now(UTC)
    s.starts_at, s.track, s.length_m = parsed.date, parsed.track, parsed.length_m
    s.weather, s.fastest = parsed.weather, parsed.fastest
    s.rows = [rm.ResultRow(**{k: v for k, v in vars(r).items()}) for r in parsed.rows]
    return s


def sync_round(db: Session, client: httpx.Client, series: str, year: int, season_id: str, round_id: str,
               name: str, order: int, force: bool = False) -> int:
    """Fetch one round's classifications; the number of sessions read."""
    adapter = ADAPTERS[series]
    rnd = _round_row(db, series, year, round_id, name, order)
    db.flush()
    read = 0
    for link in adapter.round_sessions(client, season_id, round_id):
        have = next((x for x in rnd.sessions if x.code == link.code), None)
        if have is not None and have.source_url == link.url and not force:
            continue
        try:
            store_session(db, rnd, link.code, link.title, link.url, adapter.fetch(client, link.url))
            read += 1
        except Exception as e:  # one unreadable sheet (a scan, a broken file) shouldn't stop the season
            log.warning("results: %s %s %s: %s", series, year, link.code, e)
            state.errors.append(f"{year} {name} {link.title}: {e}")
        time.sleep(PAUSE_S)
    rnd.fetched_at = datetime.now(UTC)
    db.commit()
    return read


def sync(series: str = DEFAULT_SERIES, years: list[int] | None = None, round_id: str | None = None,
         force: bool = False, client: httpx.Client | None = None) -> None:
    """Load seasons (all from FIRST_YEAR when years is None), or one round of one season."""
    adapter = ADAPTERS[series]
    own = client is None
    client = client or httpx.Client()
    try:
        with app_db.SessionLocal() as db:
            ids = adapter.seasons(client)
            todo = sorted(y for y in ids if (years is None and FIRST_YEAR <= y <= date.today().year)
                          or (years is not None and y in years))
            plan = []
            for y in todo:
                rounds = adapter.rounds(client, ids[y])
                plan += [(y, rid, name, i + 1) for i, (rid, name) in enumerate(rounds)
                         if round_id is None or rid == round_id]
            state.total = len(plan)
            for y, rid, name, order in plan:
                state.what = f"{y} {name}"
                sync_round(db, client, series, y, ids[y], rid, name, order, force)
                state.done += 1
    finally:
        if own:
            client.close()


def start(series: str = DEFAULT_SERIES, years: list[int] | None = None, round_id: str | None = None,
          force: bool = False) -> bool:
    """Run a sync in the background; False when one is already running."""
    with state.lock:
        if state.running:
            return False
        state.running, state.done, state.total, state.errors, state.what = True, 0, 0, [], "starting"

    def run() -> None:
        try:
            sync(series, years, round_id, force)
        except Exception as e:
            log.exception("results sync failed")
            state.errors.append(str(e))
        finally:
            state.running, state.what, state.finished_at = False, None, datetime.now(UTC)

    state.thread = threading.Thread(target=run, name="results-sync", daemon=True)
    state.thread.start()
    return True


def wait_idle(timeout: float = 120) -> None:
    t = state.thread
    if t is not None:
        t.join(timeout)


def _event_days(db: Session, event_id: int) -> tuple[date | None, date | None]:
    from app.routers import events  # the events router knows an event's dates (set by hand, else its logs')

    ev = db.get(models.Event, event_id)
    if ev is None:
        return None, None
    folder = events._folder(ev, events._sessions(db, event_id), events._dates_row(db, event_id))
    start, end = folder["start"], folder["end"]
    return (date.fromisoformat(start) if start else None, date.fromisoformat(end) if end else None)


def current_links(db: Session, today: date | None = None) -> list[rm.EventResultLink]:
    """Links of events that are on now: from the day before their first day to two days after their last."""
    today = today or date.today()
    out = []
    for link in db.scalars(select(rm.EventResultLink).where(rm.EventResultLink.round_id.is_not(None))).all():
        start, end = _event_days(db, link.event_id)
        if start and today >= start - timedelta(days=1) and today <= (end or start) + timedelta(days=2):
            out.append(link)
    return out


def _loop() -> None:
    last_season_check = 0.0
    while True:
        try:
            with app_db.SessionLocal() as db:
                links = [(l.series, l.year, l.round_id) for l in current_links(db)]
            for series, year, rid in links:
                start(series, [year], rid, force=True)
                wait_idle(600)
            if time.monotonic() - last_season_check > 24 * 3600:
                last_season_check = time.monotonic()
                start()  # seasons not loaded yet, and new sheets of the current one
                wait_idle(3600)
        except Exception:
            log.exception("results refresh failed")
        time.sleep(REFRESH_MINUTES * 60)


_loop_thread: threading.Thread | None = None


def start_background() -> None:
    """At server startup. Not under the tests, which must never reach the series' site."""
    global _loop_thread
    if "pytest" in sys.modules or _loop_thread is not None:
        return
    _loop_thread = threading.Thread(target=_loop, name="results-refresh", daemon=True)
    _loop_thread.start()
