"""Official results kept in the database: whole seasons loaded once, the round of a current event kept fresh.

One job runs at a time, in a background thread. A season's sync reads the series site's list of rounds and, for
each round, its list of session PDFs; a PDF is downloaded and read only when its address is new (the site gives a
corrected classification a new file name, "..._ResultList_2.0.PDF"), unless the sync is forced. Reading a PDF
takes the heavy lock so it never runs beside a log being analysed.

On the live server, start() at startup loads, for every series, each season from the series' first year that isn't
loaded yet, and checks the current season, this year's and next year's calendars and the entry lists once a day;
while one of our events linked to a round is on (from the day before it to two days after), that round is fetched
again every REFRESH_MINUTES.
"""
from __future__ import annotations

import logging
import sys
import threading
import time
from collections.abc import Callable
from datetime import UTC, date, datetime, timedelta

import httpx
from sqlalchemy import select
from sqlalchemy.orm import Session

from app import db as app_db  # SessionLocal is looked up when used: the tests swap the database
from app import heavy, models
from app.results import adac, gt4europe
from app.results import models as rm
from app.results.resultlist import ResultList, brand_of, class_name, parse_pdf
from app.results.venues import venue_key

log = logging.getLogger(__name__)

ADAPTERS = {gt4europe.SERIES: gt4europe, adac.SERIES: adac}
DEFAULT_SERIES = gt4europe.SERIES
FIRST_YEAR = 2021  # two seasons before the first one predictions are tested on (a series can start later)
REFRESH_MINUTES = 10
PAUSE_S = 0.5  # between downloads, to go easy on the series' site


class _State:
    """A lane of background jobs: one runs at a time, the others wait their turn in order (a job asked for while
    another runs is queued, never dropped; the same job asked for twice is queued once). Results and calendars have
    a lane each, so reading a calendar never waits behind a whole season's results."""

    def __init__(self, name: str) -> None:
        self.name = name
        self.lock = threading.Lock()
        self.thread: threading.Thread | None = None
        self.queue: list[tuple[tuple, Callable[[], None]]] = []
        self.current: tuple | None = None  # the key of the job running
        self.running = False
        self.what: str | None = None
        self.done = 0
        self.total = 0
        self.errors: list[str] = []
        self.finished_at: datetime | None = None

    def pending(self, key: tuple) -> bool:
        """Whether this job is running or waiting its turn."""
        with self.lock:
            return self.current == key or any(k == key for k, _ in self.queue)

    def add(self, job: Callable[[], None], key: tuple) -> bool:
        """Queue a job; False when the same job is already running or waiting."""
        with self.lock:
            if self.current == key or any(k == key for k, _ in self.queue):
                return False
            self.queue.append((key, job))
            if self.thread is None:  # the worker clears it, under the lock, only once the queue is empty
                self.running = True
                self.thread = threading.Thread(target=self._work, name=f"results-{self.name}", daemon=True)
                self.thread.start()
        return True

    def _work(self) -> None:
        while True:
            with self.lock:
                if not self.queue:
                    self.running, self.current, self.what, self.thread = False, None, None, None
                    self.finished_at = datetime.now(UTC)
                    return
                key, job = self.queue.pop(0)
                self.current, self.running = key, True
                self.done, self.total, self.errors, self.what = 0, 0, [], "starting"
            try:
                job()
            except Exception as e:
                log.exception("results %s job failed", self.name)
                self.errors.append(str(e))

    def join(self, timeout: float) -> None:
        t = self.thread
        if t is not None:
            t.join(timeout)

    def as_dict(self) -> dict:
        return {"running": self.running, "what": self.what, "done": self.done, "total": self.total,
                "queued": len(self.queue), "errors": self.errors[-10:],
                "finished_at": self.finished_at.isoformat() if self.finished_at else None}


state = _State("sync")  # seasons and rounds of results
cal_state = _State("calendar")  # calendars and entry lists


def first_year(series: str) -> int:
    return getattr(ADAPTERS[series], "FIRST_YEAR", FIRST_YEAR)


def _client(series: str) -> httpx.Client:
    """A connection to the series' site (some need a certificate the site itself leaves out)."""
    make = getattr(ADAPTERS[series], "client", None)
    return make() if make else httpx.Client()


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


def kind_of(code: str) -> str:
    """Q1 qualifying, R2 race, FP1 and PQ (pre-qualifying) practice, T1 an official test session."""
    return ("practice" if code.startswith(("FP", "PQ")) else "qualifying" if code.startswith("Q")
            else "race" if code.startswith("R") else "test" if code.startswith("T") else "practice")


def store_session(db: Session, rnd: rm.ResultRound, code: str, title: str, url: str, data: bytes) -> rm.ResultSession:
    """Read one result PDF into the round, replacing what was there for that session."""
    with heavy.lock:
        parsed = parse_pdf(data, kind_of(code))
    return store_parsed(db, rnd, code, title, url, parsed)


def _with_weather(client: httpx.Client, adapter, link, parsed: ResultList) -> ResultList:
    """A classification read from the site's table, with the weather and track of its PDF when that can be read
    (the table has neither). Best effort: the table alone is kept when the PDF can't be fetched or read."""
    if not getattr(link, "pdf_url", None):
        return parsed
    try:
        with heavy.lock:
            sheet = parse_pdf(adapter.fetch(client, link.pdf_url))
    except Exception as e:
        log.info("results: no weather from %s: %s", link.pdf_url, e)
        return parsed
    parsed.weather = sheet.weather or parsed.weather
    parsed.track, parsed.length_m = sheet.track or parsed.track, sheet.length_m or parsed.length_m
    return parsed


def store_parsed(db: Session, rnd: rm.ResultRound, code: str, title: str, url: str,
                 parsed: ResultList) -> rm.ResultSession:
    """One classification into the round, replacing what was there for that session."""
    s = next((x for x in rnd.sessions if x.code == code), None)
    if s is None:
        s = rm.ResultSession(code=code, title=title, kind=kind_of(code), source_url=url)
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
            result = getattr(link, "result", None)
            if result is not None:  # already read from the site's own table
                store_parsed(db, rnd, link.code, link.title, link.url, _with_weather(client, adapter, link, result))
            else:
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
    """Load seasons (all from the series' first year when years is None), or one round of one season."""
    adapter = ADAPTERS[series]
    own = client is None
    client = client or _client(series)
    try:
        with app_db.SessionLocal() as db:
            ids = adapter.seasons(client)
            todo = sorted(y for y in ids if (years is None and first_year(series) <= y <= date.today().year)
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
    """Run a sync in the background, after the ones already asked for; False when the same one is already waiting."""
    key = ("results", series, tuple(years) if years is not None else None, round_id, force)
    return state.add(lambda: sync(series, years, round_id, force), key)


def calendar_key(series: str, year: int) -> tuple:
    return ("calendar", series, year)


def start_calendar(series: str, year: int) -> bool:
    """Read a season's calendar and entry lists in the background (its own lane: never behind a results sync)."""
    return cal_state.add(lambda: sync_calendar(series, year), calendar_key(series, year))


def run_job(job: Callable[[], None], key: tuple | None = None) -> bool:
    """Queue any results job in the background."""
    return state.add(job, key or ("job", id(job)))


def sync_calendar(series: str, year: int, client: httpx.Client | None = None) -> None:
    """A season's calendar (every round, run or still to come, with its dates) and the entry lists published so
    far. A round's entries are replaced each time its list is read, so late changes come through."""
    adapter = ADAPTERS[series]
    own = client is None
    client = client or _client(series)
    try:
        ids = adapter.seasons(client)
        if year not in ids:
            raise ValueError(f"{adapter.NAME} has no {year} season on its site yet")
        with app_db.SessionLocal() as db:
            cal_state.what = f"{year} calendar"
            rounds = adapter.calendar(client, ids[year])
            urls = adapter.entry_list_urls(client, ids[year])
            cal_state.total = len(rounds) + len(urls)
            have = {r.round_id: r for r in db.scalars(select(rm.ResultCalendarRound).where(
                rm.ResultCalendarRound.series == series, rm.ResultCalendarRound.year == year)).all()}
            now = datetime.now(UTC)
            for r in rounds:
                row = have.get(r.round_id) or rm.ResultCalendarRound(series=series, year=year, round_id=r.round_id)
                row.name, row.venue, row.order, row.start, row.end = (r.name, venue_key(r.name), r.order,
                                                                      r.start, r.end)
                row.fetched_at = now
                db.add(row)
                have[r.round_id] = row
                cal_state.done += 1
            db.flush()
            for url in urls:
                cal_state.what = f"{year} entry list {url.rsplit('/', 1)[-1]}"
                try:
                    meeting, entries = adapter.entry_list(client, url)
                except Exception as e:
                    log.warning("results: entry list %s: %s", url, e)
                    cal_state.errors.append(f"{url}: {e}")
                    continue
                row = have.get(meeting or "")
                if row is not None and entries:
                    row.entry_list_url = url
                    row.entries = [rm.ResultEntry(car_number=e.car_number, drivers=e.drivers, team=e.team,
                                                    car_model=e.car_model, brand=brand_of(e.car_model),
                                                    car_class=class_name(e.car_class) if e.car_class else None)
                                   for e in entries]
                cal_state.done += 1
                time.sleep(PAUSE_S)
            db.commit()
    finally:
        if own:
            client.close()


def wait_idle(timeout: float = 120) -> None:
    """Until both lanes have run every job asked for so far (or the time is up)."""
    state.join(timeout)
    cal_state.join(timeout)


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


def calendar_years(series: str) -> list[int]:
    """The seasons whose calendar the daily check reads: this year's and next year's always (dates move, entry lists
    come out), earlier ones from the series' first year once, while they aren't loaded (a past season made from
    its calendar, or an upload matched to a past round, needs them)."""
    this = date.today().year
    with app_db.SessionLocal() as db:
        have = set(db.scalars(select(rm.ResultCalendarRound.year).where(rm.ResultCalendarRound.series == series)
                              .distinct()).all())
    return [y for y in range(first_year(series), this) if y not in have] + [this, this + 1]


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
                for series in ADAPTERS:
                    start(series)  # seasons not loaded yet, and new sheets of the current one
                    wait_idle(3600)
                    for year in calendar_years(series):  # calendars and new entry lists
                        start_calendar(series, year)
                        wait_idle(600)
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


def series_key(text: str | None) -> str | None:
    """The results source a series name means: 'ADAC GT4 Germany 2026' -> 'adac-gt4-germany'."""
    low = (text or "").lower()
    if not low:
        return None
    for key, adapter in ADAPTERS.items():
        if key in low or adapter.NAME.lower() in low:
            return key
    if "adac" in low or "germany" in low:
        return adac.SERIES
    if "europe" in low or "gt4 european" in low:
        return gt4europe.SERIES
    return None


def season_round_of_event(db: Session, event_id: int):
    """(season, its round) when the event is a round of one of our seasons of a series the app reads, else None."""
    from app import seasons  # seasons builds on the results module, not the other way round

    row = db.execute(select(seasons.Season, seasons.SeasonRound)
                     .join(seasons.SeasonRound, seasons.SeasonRound.season_id == seasons.Season.id)
                     .where(seasons.SeasonRound.event_id == event_id, seasons.Season.series.in_(list(ADAPTERS)))
                     ).first()
    return (row[0], row[1]) if row else None


def series_of_event(db: Session, event_id: int) -> str:
    """Which series' results an event belongs to: its season's series, else what its series name says, else the
    default one."""
    from app import seasons

    found = season_round_of_event(db, event_id)
    season = found[0] if found else None
    if season is None:
        info = db.scalar(select(seasons.EventInfo).where(seasons.EventInfo.event_id == event_id))
        if info is not None and info.season_id:
            season = db.get(seasons.Season, info.season_id)
    if season is not None and season.series in ADAPTERS:
        return season.series
    ev = db.get(models.Event, event_id)
    return series_key(ev.series if ev else None) or DEFAULT_SERIES
