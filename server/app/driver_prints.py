"""The driver fingerprint database: every event's lap fingerprints (analysis/driver_style.py), kept per event.

An event's fingerprints are worked out from the report's compact lap traces (routers/reports.py), so no log is read
again: in the background after every report of an event (each upload starts one), and for any event still missing
them when the fingerprints page or an event's driver suggestions are asked for. A row is worked out again when the
event's lap traces change (signature).

Which driver a lap is comes from the runs' driver tags at the time it is asked, never from the stored row, so a tag
counts at once. Only a person's picks teach the database a driver's fingerprint, from the laps of the runs they put
the driver on: every pick refines it (an event counts by its laps), a run moved to another driver leaves the old
one's at once, and drivers the app set (from the style, or from the season's drivers: StyleTag) never teach, so its
own guesses aren't fed back into it (Gabriele, 2026-10-07: "the fingerprint should be refined with every driver's
pick to make it more and more accurate"). Every place a person sets a driver goes through picked().

Drivers set by themselves (Gabriele, 2026-10-07: "add a function for the fingerprinter to add drivers automatically",
then "I want it to be fully automatic based on fingerprinting", "I want the app to ask me, but now it's unhelpful the
way it asks"): once an event's fingerprints are worked out, and whenever a person tags a run (what the database knows
changes), every run whose style is a driver the app knows gets that driver (StyleTag keeps that it was the style, for
the run's line and so a person's change or removal stands): a style named after a tagged run of the event, a
fingerprint learned elsewhere that matches well (SURE_MATCH), or, of two drivers in the car's entry, the other one. A
style nobody is known by is asked about (season_match: "New driver found in Q2 and Race 2 run 1: who is this?"), the
likely names first: the driver it is somewhat like, the car's entry list, the garage's drivers of the car and the
official results' crew (which list both drivers in every session, so they say who could have driven, not who drove
which). One answer names every run of that style and teaches the fingerprint. A run in which the driver changed at a
stop is split into one run per driver first (run_split.py: "when in a single run the driver changes multiple times,
split the runs automatically"). An event splits into at most as many
styles as its car has drivers (two when that isn't known), so a third style is never a third driver of a pair.

The season's drivers (Gabriele, 2026-10-07: "for a season, the app can automatically revert to the drivers of the
season... every outing that is not PIA must be RAC"): an event's drivers (its own list, else its season's entry) are
the only ones its runs can be. With two, the style only has to say which way round (ds.pair_names): never a question
once one of them has a fingerprint. Asked only when the style can't tell: three or more drivers, no drivers listed,
or a pair the app knows neither of yet.

Qualifying and the races (app/quali_order.py, Gabriele, 2026-10-09: "ADAC GT4 Q1 always PIA, Q2 always SYL"): where
the series' qualifying order is known, the Q runs and race stints get their drivers from it (StyleTag "quali" and
"race"), before the style is looked at. Those runs teach and anchor the event's style like a person's tags. When the
tagged drivers' laps don't separate (ds.told_apart: "too similar for the app to recognize"), the style sets no
driver (the ones it had set are taken back) and the runs left are asked about one at a time.

What the pages ask is kept (app/page_cache.py): what the tagged runs teach ("drivers|learned") and the fingerprints
page's answer ("drivers|fingerprints"), each under a signature of the stored fingerprints, the runs' drivers and the
names it shows, read from a few small queries. The background pass ends by working both out, so the page answers at
once after an upload or a tag; on server start a pass catches up on events that have no fingerprints yet.

New tables (create_all adds them; nothing on the existing tables changes). No foreign key: the row of an event that
is deleted is never read again, and is removed with it when the event goes (event_delete removes rows by event id
where it knows the table; this one is cleared here when its event is missing).
"""
from __future__ import annotations

import hashlib
import json
import logging
import threading
from datetime import UTC, datetime

import numpy as np
from sqlalchemy import JSON, DateTime, Float, Integer, String, delete, func, select
from sqlalchemy.orm import Mapped, Session, mapped_column

from app import db as app_db  # SessionLocal is looked up when used: the tests swap the database
from app import garage, heavy, models, page_cache, quali_order, storage
from app.analysis import compact
from app.analysis import driver_style as ds
from app.db import Base

log = logging.getLogger(__name__)

ROLES = ("t", "speed", "throttle", "brake", "steer", "gear")
LEARNED, PAGE = "drivers|learned", "drivers|fingerprints"  # page_cache scopes
START_DELAY_S = 60  # after server start, before the catch-up pass (the first requests and the prebuild go first)
MAX_LAPS = 250  # the quickest laps of an event, as the report: each on the reference line while it is worked out


def _now() -> datetime:
    return datetime.now(UTC)


class StylePrint(Base):
    __tablename__ = "style_prints"
    id: Mapped[int] = mapped_column(primary_key=True)
    event_id: Mapped[int] = mapped_column(Integer, unique=True, index=True)
    signature: Mapped[str] = mapped_column(String(64))
    payload: Mapped[dict] = mapped_column(JSON)  # EventPrint.to_json(); no laps when the event has too few
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now, onupdate=_now)


class StyleTag(Base):
    """A run's driver set by the app (from the driving style, from the season's drivers: source "season", or from
    the qualifying order: "quali" and "race", quali_order.py), not by a person: it doesn't teach the fingerprints
    (the qualifying order's do: it is what Gabriele said, not a guess), and the style may set it again (not the
    qualifying order's)."""
    __tablename__ = "style_tags"
    id: Mapped[int] = mapped_column(primary_key=True)
    session_id: Mapped[int] = mapped_column(Integer, unique=True, index=True)
    event_id: Mapped[int] = mapped_column(Integer, index=True)
    driver_id: Mapped[int] = mapped_column(Integer)
    source: Mapped[str] = mapped_column(String(16))  # tag, fingerprint, entry, pair, season, quali, race
    match: Mapped[float | None] = mapped_column(Float, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)


def _reports():
    from app.routers import reports  # looked up when used: the tests reload it
    return reports


def _ready(db: Session, event_id: int) -> tuple[list, str, int]:
    """The event's sessions whose compact traces are made: (item, traces row) pairs, the signature of the set, and
    how many sessions with laps are still waiting for theirs."""
    reports = _reports()
    try:
        plan = reports.plan_for(db, "event", event_id)
    except Exception:  # the event is gone
        return [], "", 0
    if plan.error:
        return [], "", 0
    ready, pending = [], 0
    used = reports._used(plan)
    traces = reports.traces_of(db, [item.session.id for item in used])
    for item in used:
        rec = traces.get(item.session.id)
        if rec is None or rec.signature != item.signature:
            pending += 1
        elif rec.path is not None:
            ready.append((item, rec))
    key = [ds.VERSION, sorted((item.session.id, rec.signature) for item, rec in ready)]
    return ready, hashlib.sha1(json.dumps(key).encode()).hexdigest(), pending


def _compute(ready: list) -> ds.EventPrint | None:
    sessions = []
    for item, rec in ready:
        try:
            sessions.append((item.session.id, compact.from_file(storage.local_path(rec.path))))
        except (FileNotFoundError, ValueError, OSError, storage.StorageError):
            continue  # gone from storage or an older format: the next report makes it again
    sessions = [(sid, cs) for sid, cs in sessions if cs.n_laps]
    if not sessions:
        return None
    times = np.sort(np.concatenate([cs.times for _, cs in sessions]))
    if len(times) > MAX_LAPS:
        limit = times[MAX_LAPS - 1]
        sessions = [(sid, compact.keep_laps(cs, cs.times <= limit)) for sid, cs in sessions]
        sessions = [(sid, cs) for sid, cs in sessions if cs.n_laps]
    _, ref = min(sessions, key=lambda p: float(p[1].times.min()))
    line, length = ref.line, ref.length
    laps = []
    for sid, cs in sessions:
        for i, tr in enumerate(compact.laps_on(cs, line, length)):
            laps.append(ds.EventLap(sid, int(cs.numbers[i]), float(cs.times[i]),
                                    {r: np.asarray(tr[r], float) for r in ROLES if r in tr}))
        cs.traces = {}
    return ds.event_print(laps)


def refresh(db: Session, event_id: int) -> tuple[ds.EventPrint | None, int]:
    """The event's fingerprints, worked out again when its lap traces changed; and how many of its sessions are
    still waiting for their lap traces."""
    ready, signature, pending = _ready(db, event_id)
    row = db.scalar(select(StylePrint).where(StylePrint.event_id == event_id))
    if row is not None and row.signature == signature:
        return ds.EventPrint.from_json(row.payload), pending
    ep = None
    if ready:
        with heavy.lock:
            ep = _compute(ready)
    if row is None:
        row = StylePrint(event_id=event_id, signature=signature, payload={})
        db.add(row)
    row.signature = signature
    row.payload = ep.to_json() if ep is not None else {"version": ds.VERSION, "numbers": []}
    db.commit()
    return ep, pending


# ---------- every event ----------

_bg: dict = {"thread": None, "again": False}
_bg_lock = threading.Lock()


def stale(db: Session, state: dict | None = None) -> list[int]:
    """Events whose fingerprints are missing or out of date and can be worked out now (their traces are made).
    state, when given, gets every event's (signature, sessions still waiting for their traces)."""
    out = []
    rows = dict(db.execute(select(StylePrint.event_id, StylePrint.signature)).all())
    for ev_id in db.scalars(select(models.Event.id).order_by(models.Event.id.desc())).all():
        ready, signature, pending = _ready(db, ev_id)
        if state is not None:
            state[ev_id] = (signature, pending)
        if ready and rows.get(ev_id) != signature:
            out.append(ev_id)
    return out


def refresh_all() -> None:
    """Every event whose fingerprints are missing or out of date, until none is (asked again meanwhile: once more);
    then every event's runs get the drivers the style is sure of."""
    while True:
        _bg["again"] = False
        with app_db.SessionLocal() as db, heavy.background():
            state: dict = {}
            for ev_id in stale(db, state):
                try:
                    refresh(db, ev_id)
                    state[ev_id] = _ready(db, ev_id)[1:]
                except Exception:
                    db.rollback()
                    log.exception("Driver fingerprints of event %s failed", ev_id)
            try:
                settle_all(db, state)
            except Exception:
                db.rollback()
                log.exception("Setting drivers from the driving style failed")
            try:
                from app.routers import driver_style  # here: the router imports this module
                driver_style.keep_page(db)
            except Exception:
                db.rollback()
                log.exception("The driver fingerprints page failed")
        with _bg_lock:  # a call that comes in from here on starts a new pass
            if not _bg["again"]:
                _bg["thread"] = None
                return


def refresh_in_background() -> bool:
    """Work out the missing fingerprints in the background (one job at a time). True while it runs."""
    with _bg_lock:
        _bg["again"] = True
        t = _bg["thread"]
        if t is not None and t.is_alive():
            return True
        t = threading.Thread(target=refresh_all, name="driver-prints", daemon=True)
        _bg["thread"] = t
        t.start()
        return True


def start() -> None:
    """On server start, with the prebuild on: a catch-up pass a little later (events without fingerprints yet)."""
    from app import prebuild
    if prebuild.enabled():
        t = threading.Timer(START_DELAY_S, refresh_in_background)
        t.daemon = True
        t.start()


def wait_idle(timeout: float = 60) -> None:
    t = _bg["thread"]
    if t is not None:
        t.join(timeout)


def busy() -> bool:
    t = _bg["thread"]
    return t is not None and t.is_alive()


def checking(event_ids: list[int]) -> bool:
    """Whether these events' drivers are still to be checked by their style: a pass is running, or an event's
    report (which makes the lap traces the style is read from) is still being worked out."""
    pending = _reports()._pending
    return busy() or any(f"event:{e}" in pending for e in event_ids)


# ---------- the database ----------

def _state(db: Session) -> list:
    """What the learned fingerprints are made from, in a few small queries: the stored fingerprints' signatures, the
    drivers of their events' runs and the runs whose driver the style set."""
    prints = [list(r) for r in db.execute(select(StylePrint.event_id, StylePrint.signature)
                                          .order_by(StylePrint.event_id)).all()]
    evs = [e for e, _ in prints]
    runs = [list(r) for r in db.execute(select(models.RunSession.id, models.RunSession.driver_id)
                                        .where(models.RunSession.event_id.in_(evs))
                                        .order_by(models.RunSession.id)).all()] if evs else []
    auto = [list(r) for r in db.execute(select(StyleTag.session_id, StyleTag.driver_id, StyleTag.source)
                                        .order_by(StyleTag.session_id)).all()]
    return [ds.VERSION, prints, runs, auto]


def page_signature(db: Session) -> str:
    """What the fingerprints page shows is made from: _state, and the names and driver lists it uses."""
    from app import seasons
    state = _state(db)
    evs = [e for e, _ in state[1]]
    names = [list(r) for r in db.execute(select(models.Driver.id, models.Driver.name).order_by(models.Driver.id))]
    events = [[e, n, str(d)] for e, n, d in db.execute(select(models.Event.id, models.Event.name, models.Event.date)
                                                        .where(models.Event.id.in_(evs)).order_by(models.Event.id))]
    info = [[e, s, d] for e, s, d in db.execute(select(seasons.EventInfo.event_id, seasons.EventInfo.season_id,
                                                       seasons.EventInfo.drivers).order_by(seasons.EventInfo.event_id))]
    entries = [[i, e] for i, e in db.execute(select(seasons.Season.id, seasons.Season.entry)
                                             .order_by(seasons.Season.id))]
    rounds = [list(r) for r in db.execute(select(seasons.SeasonRound.season_id, seasons.SeasonRound.event_id)
                                          .where(seasons.SeasonRound.event_id.in_(evs))
                                          .order_by(seasons.SeasonRound.id))] if evs else []
    runs = [list(r) for r in db.execute(select(models.RunSession.id, models.RunSession.name)
                                        .where(models.RunSession.event_id.in_(evs))
                                        .order_by(models.RunSession.id))] if evs else []  # the page names runs
    return page_cache.digest(["page", *state, names, events, info, entries, rounds, runs])


def learned(db: Session) -> dict[int, list[tuple[int, dict[str, float], int]]]:
    """taught() of every stored fingerprint, kept until the fingerprints or the runs' drivers change."""
    sig = page_cache.digest(["learned", *_state(db)])
    hit = page_cache.lookup(db, LEARNED, sig)
    if hit is not None and hit[0] == 200:
        return {int(k): [(int(e), v, int(n)) for e, v, n in rows] for k, rows in hit[1].items()}
    out = taught(db, stored(db))
    page_cache.store(db, LEARNED, sig, {str(k): [[e, v, n] for e, v, n in rows] for k, rows in out.items()})
    return out


def stored(db: Session) -> dict[int, ds.EventPrint]:
    out = {}
    for r in db.scalars(select(StylePrint)).all():
        ep = ds.EventPrint.from_json(r.payload or {})
        if ep is not None:
            out[r.event_id] = ep
    return out


def set_by_style(db: Session, session_ids: list[int]) -> dict[int, StyleTag]:
    """The runs whose driver the style set (or once did: a person may have changed or cleared it since)."""
    if not session_ids:
        return {}
    return {t.session_id: t for t in db.scalars(select(StyleTag).where(StyleTag.session_id.in_(session_ids)))}


def set_by_person(db: Session, session_ids: list[int], driver_id: int | None) -> None:
    """A person set these runs' driver (not committed): one the app had set becomes theirs, so it teaches now. A
    clear keeps the app's mark, so the style doesn't set it again."""
    if driver_id is not None and session_ids:
        db.execute(delete(StyleTag).where(StyleTag.session_id.in_(list(session_ids))))


def picked(db: Session, session_ids: list[int], driver_id: int | None) -> None:
    """A person picked these runs' driver (None clears it): the runs get it, their cars count it as one of their
    drivers, and from then on it teaches the fingerprints (set_by_person). Every place a person sets a driver goes
    through here: the question after an upload, "This is…" on the fingerprints page, a run's Change. Not committed;
    after the commit, learn()."""
    for sid in session_ids:
        s = db.get(models.RunSession, sid)
        if s is None:
            continue
        s.driver_id = driver_id
        if driver_id is not None and s.car_id is not None:
            garage.link_driver(db, driver_id, s.car_id)
    set_by_person(db, session_ids, driver_id)
    db.flush()


def learn() -> None:
    """After a person's pick is committed: what the fingerprints know changed, so every event's runs are looked at
    again (the ones the style is now sure of get their driver)."""
    refresh_in_background()


def set_by_app(db: Session, run: models.RunSession, driver_id: int, source: str, match: float | None = None) -> None:
    """The app set this run's driver (not committed): marked, so it never teaches and the style may change it."""
    st = db.scalar(select(StyleTag).where(StyleTag.session_id == run.id))
    if st is None:
        db.add(StyleTag(session_id=run.id, event_id=run.event_id or 0, driver_id=driver_id, source=source,
                        match=match))
    else:
        st.event_id, st.driver_id, st.source, st.match = run.event_id or 0, driver_id, source, match


def unmark(db: Session, session_ids: list[int]) -> None:
    """The app's driver of these runs was taken back (not committed): the style may set them again."""
    if session_ids:
        db.execute(delete(StyleTag).where(StyleTag.session_id.in_(list(session_ids))))


def tags_of(db: Session, ep: ds.EventPrint, people_only: bool = True) -> dict[int, int | None]:
    """The event's runs' drivers: those a person set or the qualifying order gave (people_only), or as they are
    now."""
    ids = sorted(set(ep.sessions))
    rows = db.execute(select(models.RunSession.id, models.RunSession.driver_id)
                      .where(models.RunSession.id.in_(ids))).all()
    if not people_only:
        return {sid: did for sid, did in rows}
    auto = set_by_style(db, ids)
    return {sid: None if sid in auto and auto[sid].driver_id == did and auto[sid].source not in quali_order.SOURCES
            else did for sid, did in rows}


def taught(db: Session, prints: dict[int, ds.EventPrint]) -> dict[int, list[tuple[int, dict[str, float], int]]]:
    """What a person's picks teach: driver id -> (event id, the driver's fingerprint by kind there, laps) for every
    event whose laps show more than one style (relative fingerprints need a teammate), from the laps of the runs a
    person (or the qualifying order) put that driver on, and only those: laps the app guessed a driver for never
    teach."""
    out: dict[int, list] = {}
    for ev_id, ep in prints.items():
        tags = tags_of(db, ep)
        if not any(tags.values()):
            continue
        if ds.guess(ep, tags).mode not in ("tagged", "alike", "groups"):
            continue
        by = np.array([tags.get(int(sid)) or -1 for sid in ep.sessions])
        for did in sorted({int(d) for d in by if d >= 0}):
            mine = by == did
            out.setdefault(did, []).append((ev_id, dict(zip(ep.kinds, ep.v[mine].mean(0).tolist(), strict=True)),
                                            int(mine.sum())))
    return out


EVENT_LAPS = 30  # an event's fingerprint of a driver counts by its laps, up to this many


def known_for(learned: dict[int, list], kinds: list[str], exclude_event: int | None = None) -> dict[int, np.ndarray]:
    """Each driver's fingerprint from the other events, as a vector in the order of kinds: the events' averaged by
    their laps (up to EVENT_LAPS each, so one long event doesn't drown the others), so every pick refines it."""
    out = {}
    for did, rows in learned.items():
        rows = [(v, n) for ev_id, v, n in rows if ev_id != exclude_event]
        if rows:
            w = np.array([max(1, min(n, EVENT_LAPS)) for _, n in rows], float)
            out[did] = np.array([np.average([r.get(k, 0.0) for r, _ in rows], weights=w) for k in kinds])
    return out


# ---------- drivers set by themselves, and the question about a new one ----------

SURE_MATCH = 0.5  # a style this close (cosine) to a known driver's fingerprint is that driver: set by itself
MAX_NAMES = 3  # run names in a question, then "and 2 more"


def entry_drivers(db: Session, event_id: int) -> list[int]:
    """Who could have driven the event's car: the event's own driver list, else its season's entry (not the runs':
    those are what is being worked out)."""
    from app import seasons
    r = seasons._resolve(db, event_id)
    return list(r["ids"]["drivers"]) if r["from"].get("drivers") in ("event", "season") else []


def max_groups(entry: list[int]) -> int:
    """How many driving styles an event can split into: as many as the car's drivers when three or more are known,
    else two (in a two-driver car a third group is one of them on other tyres, or in the wet)."""
    return min(3, max(2, len(set(entry))))


def guess_for(db: Session, event_id: int, ep: ds.EventPrint, learned: dict, entry: list[int] | None = None) -> ds.Guess:
    """The event's style groups, named from the runs a person tagged, the fingerprints learned elsewhere and the
    event's drivers (its own list, else its season's): with drivers listed, only they can be named, and with two the
    styles are those two (ds.pair_names). Otherwise a style only somewhat like a known driver's (below SURE_MATCH)
    isn't named: that driver is its hint, the first name offered when it is asked about."""
    entry = list(dict.fromkeys(entry_drivers(db, event_id) if entry is None else entry))
    known = known_for(learned, ep.kinds, exclude_event=event_id)
    if entry:
        known = {did: v for did, v in known.items() if did in entry}
    pair = (entry[0], entry[1]) if len(entry) == 2 else None
    g = ds.guess(ep, tags_of(db, ep), known, max_groups(entry), pair)
    for grp in g.groups:
        if grp.source == "fingerprint" and (grp.match or 0) < SURE_MATCH:
            grp.hint, grp.driver_id, grp.source = grp.driver_id, None, ""
    return g


def will_look(db: Session, event_id: int) -> bool:
    """Whether the style will be checked for the event: its runs have enough laps."""
    n = db.scalar(select(func.count(models.Lap.id))
                  .join(models.RunSession, models.Lap.session_id == models.RunSession.id)
                  .where(models.RunSession.event_id == event_id))
    return (n or 0) >= ds.MIN_LAPS


def _car_drivers(db: Session, event_id: int) -> list[int]:
    """The drivers of the cars the event's runs were in (the garage's driver and car links)."""
    cars = select(models.RunSession.car_id).where(models.RunSession.event_id == event_id,
                                                  models.RunSession.car_id.is_not(None))
    return list(dict.fromkeys(db.scalars(select(garage.DriverCar.driver_id).where(garage.DriverCar.car_id.in_(cars))
                                         .order_by(garage.DriverCar.id)).all()))


def official_crew(db: Session, event_id: int) -> list[str]:
    """Our car's drivers in the official results of the event's round, as the results print them ("G.Piana"). Every
    session lists the car's whole crew, so they say who could have driven, not who drove which session."""
    from app.results import models as rm
    from app.results import summary
    from app.season_match import same_person
    link = db.scalar(select(rm.EventResultLink).where(rm.EventResultLink.event_id == event_id))
    if link is None or not link.car_number or not link.round_id:
        return []
    rnd = db.scalar(select(rm.ResultRound).where(rm.ResultRound.series == link.series, rm.ResultRound.year == link.year,
                                                 rm.ResultRound.round_id == link.round_id))
    out: list[str] = []
    for sess in rnd.sessions if rnd is not None else []:
        row = summary.find_car(sess, link.car_number)
        for name in (row.drivers or []) if row is not None else []:
            if isinstance(name, str) and name.strip() and not any(same_person(name, n) for n in out):
                out.append(name.strip())
    return out


def _options(db: Session, event_id: int, entry: list[int], taken: set[int], hint: int | None) -> list[dict]:
    """The names a new driver most likely has, best first: the driver the style is somewhat like, the car's entry
    list, the drivers the garage has in the car, and the official results' crew of our car; with an entry list, only
    its drivers (the season's drivers are the only ones it can be). Drivers who are another style of the event already
    are left out."""
    from app.season_match import MAX_OPTIONS, same_person
    drivers = {d.id: d for d in db.scalars(select(models.Driver)).all()}
    out: list[dict] = []

    def add(driver_id: int | None, name: str, why: str) -> None:
        if driver_id in taken or any(o["driver_id"] == driver_id for o in out if driver_id is not None):
            return
        if any(same_person(name, o["label"]) for o in out):
            return
        key = f"driver:{driver_id}" if driver_id is not None else f"name:{len(out)}"
        out.append({"key": key, "label": name[:120], "why": why, "driver_id": driver_id})

    if hint in drivers and (not entry or hint in entry):
        add(hint, drivers[hint].name, "Drives most like them of the drivers the app knows")
    for i in entry:
        if i in drivers:
            add(i, drivers[i].name, "In the car's entry list")
    if entry:
        return out[:MAX_OPTIONS]
    for i in _car_drivers(db, event_id):
        if i in drivers:
            add(i, drivers[i].name, "Has driven this car")
    for name in official_crew(db, event_id):
        hit = next((d for d in drivers.values() if same_person(name, d.name)), None)
        add(hit.id if hit else None, hit.name if hit else name, "In the official results")
    return out[:MAX_OPTIONS]


def runs_text(db: Session, ids: list[int]) -> str:
    """"FP1 run 2, Q2 and Race 2 run 1", or "FP1 run 2, Q2, Race 1 and 2 more"."""
    runs = sorted((s for i in ids if (s := db.get(models.RunSession, i)) is not None), key=lambda s: s.id)
    names = [s.name or f"Run {s.id}" for s in runs]
    if len(names) > MAX_NAMES + 1:
        return f"{', '.join(names[:MAX_NAMES])} and {len(names) - MAX_NAMES} more"
    return names[0] if len(names) == 1 else f"{', '.join(names[:-1])} and {names[-1]}"


def _question(db: Session, event_id: int, g: ds.Guess | None, entry: list[int], now: dict[int, int | None],
              auto: dict[int, StyleTag]) -> dict | None:
    """What to ask about the event's runs nobody could name: the largest style the app doesn't know yet ("New driver
    found in Q2 and Race 2 run 1: who is this?"), or, when the style can't tell (too few laps), who drove the runs
    left. Runs a person cleared aren't asked about again. None when every run has its driver."""
    def left(sid: int) -> bool:
        return now.get(sid) is None and sid not in auto

    if g is not None and g.mode == "one style":  # no second style to tell it from: who it is, is asked
        runs = [s.session_id for s in g.sessions if left(s.session_id)]
        hint = g.groups[0].driver_id or g.groups[0].hint
        return {"prompt": f"Who drove {runs_text(db, runs)}?",
                "why": "The app finds one driving style in them, so one answer names them all. If someone else "
                       "drove one of them, set that run's driver on the event page.",
                "options": _options(db, event_id, entry, set(), hint), "runs": runs} if runs else None
    if g is not None and g.mode == "groups":
        unnamed = [(i, [s.session_id for s in g.sessions if s.group == i and left(s.session_id)])
                   for i, grp in enumerate(g.groups) if grp.driver_id is None]
        unnamed = [(i, runs) for i, runs in unnamed if runs]
        if not unnamed:
            return None
        i, runs = max(unnamed, key=lambda x: (len(x[1]), g.groups[x[0]].laps))
        taken = {grp.driver_id for j, grp in enumerate(g.groups) if j != i and grp.driver_id is not None}
        taken |= {d for s in g.sessions if s.group != i and (d := now.get(s.session_id)) is not None}
        why = (f"A driving style that matches no driver the app knows yet. One answer names "
               f"{'this run' if len(runs) == 1 else f'all {len(runs)} runs'}, and later uploads know this driver by "
               "their style.")
        if len(g.groups) == 2 and len(set(entry)) == 2 and all(grp.driver_id is None for grp in g.groups):
            why += " The other runs then go to the car's other driver."
        return {"prompt": f"New driver found in {runs_text(db, runs)}: who is this?", "why": why,
                "options": _options(db, event_id, entry, taken, g.groups[i].hint), "runs": runs}
    if g is not None and g.mode == "alike":  # each run on its own: one answer can't be told to fit the others
        runs = [s.session_id for s in g.sessions if left(s.session_id)]
        if not runs:
            return None
        run = min(runs, key=lambda sid: (*_run_order(db, sid), sid))
        names = [d.name for grp in g.groups if (d := db.get(models.Driver, grp.driver_id)) is not None]
        why = (f"{' and '.join(names) if len(names) == 2 else 'The drivers'} drive too alike here for the app to tell "
               "apart by their style, so it asks run by run.")
        if quali_order.order_for(db, event_id) is not None:
            why += " Qualifying and the races take their drivers from the qualifying order."
        from app.season_match import MAX_OPTIONS
        tagged = [{"key": f"driver:{d.id}", "label": d.name[:120], "why": "Drove other runs of this event",
                   "driver_id": d.id} for grp in g.groups if (d := db.get(models.Driver, grp.driver_id)) is not None]
        options = [*(o for o in tagged if not entry or o["driver_id"] in entry),
                   *(o for o in _options(db, event_id, entry, set(), None)
                     if o["driver_id"] not in {t["driver_id"] for t in tagged})][:MAX_OPTIONS]
        return {"prompt": f"Who drove {runs_text(db, [run])}?", "why": why, "options": options, "runs": [run]}
    if g is not None and g.mode == "tagged":
        return None
    with_laps = set(db.scalars(select(models.Lap.session_id).distinct()
                               .join(models.RunSession, models.Lap.session_id == models.RunSession.id)
                               .where(models.RunSession.event_id == event_id)).all())
    runs = sorted(sid for sid in now if sid in with_laps and left(sid))
    if not runs:
        return None
    return {"prompt": f"Who drove {runs_text(db, runs)}?",
            "why": "Too few laps to tell drivers apart by their style: one answer names them all, or set each run's "
                   "driver on the event page.",
            "options": _options(db, event_id, entry, set(), None), "runs": runs}


def _run_order(db: Session, session_id: int) -> tuple:
    """When the run's log started (runs without a time last), for asking about runs in the order they ran."""
    from app.results import run_names  # looked up when used: it uses the results

    s = db.get(models.RunSession, session_id)
    win = run_names.run_window(s) if s is not None else None
    return (win is None, win[0] if win else 0)


STYLE_SOURCES = ("tag", "fingerprint", "entry", "pair")  # StyleTag sources of a driver the style set


def settle(db: Session, event_id: int, ep: ds.EventPrint | None, learned: dict) -> int:
    """Every run of the event whose driving style is a driver the app knows gets that driver by itself (StyleTag:
    shown as set from the style, with a way to change it), whether the style was named after a tagged run here, a
    fingerprint learned elsewhere (SURE_MATCH), the car's other driver, or which way round the car's two drivers fit.
    A person's tag, change or clear stands. A run whose driver changed at a stop is first split into one run per
    driver (run_split.py); its parts are settled on a later pass.
    A style nobody knows is then asked about (season_match.ask_new_driver), with the likely names. Runs whose driver
    came from the qualifying order (quali_order.py) keep it. When the tagged drivers drive too alike to tell apart
    (ds mode "alike"), the drivers the style set are taken back and each run left is asked about. Commits. How
    many runs were set."""
    n = 0
    entry = entry_drivers(db, event_id)
    g = guess_for(db, event_id, ep, learned, entry) if ep is not None else None
    if g is not None:
        from app import run_split  # here: it uses this module
        db.commit()  # nothing of this pass pending: a split commits run by run
        if run_split.split_event(db, event_id, g):
            return 0  # the parts are settled on a later pass, once the report has made their lap traces
    now = dict(db.execute(select(models.RunSession.id, models.RunSession.driver_id)
                          .where(models.RunSession.event_id == event_id)).all())
    auto = set_by_style(db, list(now))
    for s in g.sessions if g is not None and g.mode == "alike" else []:  # the style's guesses don't hold here
        st = auto.get(s.session_id)
        if st is not None and st.source in STYLE_SOURCES and st.driver_id == now.get(s.session_id):
            run = db.get(models.RunSession, s.session_id)
            if run is not None:
                run.driver_id = now[run.id] = None
            db.delete(st)
    for s in g.sessions if g is not None and g.mode in ("tagged", "groups") else []:
        grp, st, current = g.groups[s.group], auto.get(s.session_id), now.get(s.session_id)
        if (st is None and current is not None) or (st is not None and st.driver_id != current):
            continue  # a person's tag, change or clear stands
        if st is not None and st.source in quali_order.SOURCES:
            continue  # the qualifying order's
        if grp.driver_id is None or grp.driver_id == current or db.get(models.Driver, grp.driver_id) is None:
            continue
        run = db.get(models.RunSession, s.session_id)
        if run is None:  # deleted since the fingerprints were worked out
            continue
        run.driver_id = now[run.id] = grp.driver_id
        if run.car_id is not None:
            garage.link_driver(db, grp.driver_id, run.car_id)
        set_by_app(db, run, grp.driver_id, grp.source, round(grp.match, 3) if grp.match is not None else None)
        n += 1
    db.flush()
    auto = set_by_style(db, list(now))
    question = _question(db, event_id, g, entry, now, auto)
    from app import calendar_sync, season_match  # looked up when used: the tests reload them
    with calendar_sync._lock:
        season_match.ask_new_driver(db, event_id, question)
        db.commit()
    return n


def settle_all(db: Session, state: dict | None = None) -> int:
    """settle() for every event whose fingerprints are up to date and whose runs all have their lap traces (state:
    each event's (signature, sessions waiting), as stale() found them)."""
    db.execute(delete(StyleTag).where(StyleTag.session_id.not_in(select(models.RunSession.id))))
    db.commit()  # before waiting for the lock: a write held while waiting would lock out the one holding it
    from app import calendar_sync, season_match  # looked up when used: the tests reload them
    with calendar_sync._lock:
        season_match.mark_filled(db)
        db.commit()
    for ev_id in db.scalars(select(models.Event.id).order_by(models.Event.id)).all():
        try:  # Q and race runs from the qualifying order, before the style is looked at
            if quali_order.apply(db, ev_id):
                db.commit()
        except Exception:
            db.rollback()
            log.exception("Setting the drivers of event %s from the qualifying order failed", ev_id)
    rows = db.scalars(select(StylePrint).order_by(StylePrint.event_id)).all()
    prints = {r.event_id: ep for r in rows if (ep := ds.EventPrint.from_json(r.payload or {})) is not None}
    knows = learned(db)
    n = 0
    for r in rows:
        if db.get(models.Event, r.event_id) is None:
            continue
        signature, pending = state[r.event_id] if state and r.event_id in state else _ready(db, r.event_id)[1:]
        if pending or signature != r.signature:
            continue  # still being read: settled when it is done
        try:  # one event that fails doesn't stop the others
            n += settle(db, r.event_id, prints.get(r.event_id), knows)
        except Exception:
            db.rollback()
            log.exception("Setting the drivers of event %s from the driving style failed", r.event_id)
    return n
