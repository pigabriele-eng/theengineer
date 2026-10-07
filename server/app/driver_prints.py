"""The driver fingerprint database: every event's lap fingerprints (analysis/driver_style.py), kept per event.

An event's fingerprints are worked out from the report's compact lap traces (routers/reports.py), so no log is read
again: in the background after every report of an event (each upload starts one), and for any event still missing
them when the fingerprints page or an event's driver suggestions are asked for. A row is worked out again when the
event's lap traces change (signature).

Which driver a lap is comes from the runs' driver tags at the time it is asked, never from the stored row, so a tag
counts at once. Only runs a person tagged teach the database a driver's fingerprint; suggestions and drivers set from
the style never do, so a wrong one can't spread.

Drivers set by themselves (Gabriele, 2026-10-07: "add a function for the fingerprinter to add drivers automatically",
"when uploading the session, the app should automatically suggest the driver instead of asking"): once an event's
fingerprints are worked out, and whenever a person tags a run (what the database knows changes), every untagged run
the style is sure of gets its driver (StyleTag keeps that it was the style, for the run's line and so a person's
change or removal stands). Who could have driven comes from the event's or its season's driver list, when there is
one: a style named after one of two drivers makes the other style the other driver. The season's question of who
drove (season_match) waits for this, and is then asked only about the runs left, with the style's suggestion first.

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
from app import garage, heavy, models, storage
from app.analysis import compact
from app.analysis import driver_style as ds
from app.db import Base

log = logging.getLogger(__name__)

ROLES = ("t", "speed", "throttle", "brake", "steer", "gear")
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
    """A run's driver set from the driving style, not by a person."""
    __tablename__ = "style_tags"
    id: Mapped[int] = mapped_column(primary_key=True)
    session_id: Mapped[int] = mapped_column(Integer, unique=True, index=True)
    event_id: Mapped[int] = mapped_column(Integer, index=True)
    driver_id: Mapped[int] = mapped_column(Integer)
    source: Mapped[str] = mapped_column(String(16))  # the style group's name came from: tag, fingerprint, entry
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
    for item in reports._used(plan):
        rec = db.scalar(select(models.SessionTraces).where(models.SessionTraces.session_id == item.session.id))
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


def stale(db: Session) -> list[int]:
    """Events whose fingerprints are missing or out of date and can be worked out now (their traces are made)."""
    out = []
    rows = {r.event_id: r.signature for r in db.scalars(select(StylePrint)).all()}
    for ev_id in db.scalars(select(models.Event.id).order_by(models.Event.id.desc())).all():
        ready, signature, _ = _ready(db, ev_id)
        if ready and rows.get(ev_id) != signature:
            out.append(ev_id)
    return out


def refresh_all() -> None:
    """Every event whose fingerprints are missing or out of date, until none is (asked again meanwhile: once more);
    then every event's runs get the drivers the style is sure of."""
    while True:
        _bg["again"] = False
        with app_db.SessionLocal() as db:
            for ev_id in stale(db):
                try:
                    refresh(db, ev_id)
                except Exception:
                    db.rollback()
                    log.exception("Driver fingerprints of event %s failed", ev_id)
            try:
                settle_all(db)
            except Exception:
                db.rollback()
                log.exception("Setting drivers from the driving style failed")
        if not _bg["again"]:
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


def wait_idle(timeout: float = 60) -> None:
    t = _bg["thread"]
    if t is not None:
        t.join(timeout)


def busy() -> bool:
    t = _bg["thread"]
    return t is not None and t.is_alive()


# ---------- the database ----------

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


def tags_of(db: Session, ep: ds.EventPrint, people_only: bool = True) -> dict[int, int | None]:
    """The event's runs' drivers: those a person set (people_only), or as they are now."""
    ids = sorted(set(ep.sessions))
    rows = db.execute(select(models.RunSession.id, models.RunSession.driver_id)
                      .where(models.RunSession.id.in_(ids))).all()
    if not people_only:
        return {sid: did for sid, did in rows}
    auto = set_by_style(db, ids)
    return {sid: None if sid in auto and auto[sid].driver_id == did else did for sid, did in rows}


def taught(db: Session, prints: dict[int, ds.EventPrint]) -> dict[int, list[tuple[int, dict[str, float], int]]]:
    """What the tagged runs teach: driver id -> (event id, the driver's fingerprint by kind there, laps) for every
    event with a tagged run of theirs whose laps show more than one style (relative fingerprints need a teammate)."""
    out: dict[int, list] = {}
    for ev_id, ep in prints.items():
        tags = tags_of(db, ep)
        if not any(tags.values()):
            continue
        g = ds.guess(ep, tags)
        if g.mode not in ("tagged", "groups"):
            continue
        for grp in g.groups:
            if grp.source == "tag" and grp.driver_id is not None and grp.v is not None and grp.laps:
                out.setdefault(grp.driver_id, []).append((ev_id, dict(zip(ep.kinds, grp.v.tolist(), strict=True)),
                                                          grp.laps))
    return out


def known_for(learned: dict[int, list], kinds: list[str], exclude_event: int | None = None) -> dict[int, np.ndarray]:
    """Each driver's fingerprint from the other events, as a vector in the order of kinds (every event counts once)."""
    out = {}
    for did, rows in learned.items():
        rows = [v for ev_id, v, _ in rows if ev_id != exclude_event]
        if rows:
            out[did] = np.array([np.mean([r.get(k, 0.0) for r in rows]) for k in kinds])
    return out


# ---------- drivers set by themselves ----------

def entry_drivers(db: Session, event_id: int) -> list[int]:
    """Who could have driven the event's car: the event's own driver list, else its season's entry (not the runs':
    those are what is being worked out)."""
    from app import seasons
    r = seasons._resolve(db, event_id)
    return list(r["ids"]["drivers"]) if r["from"].get("drivers") in ("event", "season") else []


def _name_from_entry(g: ds.Guess, entry: list[int]) -> None:
    """Two drivers in the car and one style named after one of them: the other style is the other driver."""
    if g.mode != "groups" or len(g.groups) != 2 or len(set(entry)) != 2:
        return
    named = [grp for grp in g.groups if grp.driver_id is not None]
    if len(named) != 1 or named[0].driver_id not in entry:
        return
    other = next(grp for grp in g.groups if grp.driver_id is None)
    other.driver_id, other.source = next(d for d in entry if d != named[0].driver_id), "entry"


def guess_for(db: Session, event_id: int, ep: ds.EventPrint, learned: dict, entry: list[int] | None = None) -> ds.Guess:
    """The event's style groups, named from the runs a person tagged, the fingerprints learned elsewhere and the
    event's driver list."""
    g = ds.guess(ep, tags_of(db, ep), known_for(learned, ep.kinds, exclude_event=event_id))
    _name_from_entry(g, entry_drivers(db, event_id) if entry is None else entry)
    return g


def will_look(db: Session, event_id: int) -> bool:
    """Whether the style will be checked for the event: its runs have enough laps."""
    n = db.scalar(select(func.count(models.Lap.id))
                  .join(models.RunSession, models.Lap.session_id == models.RunSession.id)
                  .where(models.RunSession.event_id == event_id))
    return (n or 0) >= ds.MIN_LAPS


def settle(db: Session, event_id: int, ep: ds.EventPrint | None, learned: dict) -> int:
    """The event's untagged runs the style is sure of get their driver; the season's question of who drove is then
    asked about the rest, with the style's suggestion, or, when the runs split into two styles nobody is known in,
    which style is which of the car's two drivers (season_match.style_checked). Commits. How many were set."""
    picks: dict[int, int] = {}
    splits: list[dict[int, int]] = []
    n = 0
    if ep is not None:
        entry = entry_drivers(db, event_id)
        g = guess_for(db, event_id, ep, learned, entry)
        now = tags_of(db, ep, people_only=False)
        before = set_by_style(db, list(now))
        open_runs = [s for s in g.sessions if now.get(s.session_id) is None and len(s.stints) == 1]
        if g.mode == "groups" and len(g.groups) == 2 and len(set(entry)) == 2 \
                and all(grp.driver_id is None for grp in g.groups) and open_runs:
            # two styles and two drivers, neither known yet: one tap says which is whose (and teaches both)
            a, b = entry[0], next(d for d in entry if d != entry[0])
            splits = [{s.session_id: (a, b)[s.group] for s in open_runs},
                      {s.session_id: (b, a)[s.group] for s in open_runs}]
        for s in g.sessions if g.mode in ("tagged", "groups") else []:
            grp = g.groups[s.group]
            if now.get(s.session_id) is not None or grp.driver_id is None or len(s.stints) > 1:
                continue
            if (entry and grp.driver_id not in entry) or db.get(models.Driver, grp.driver_id) is None:
                continue
            if ds.confidence(g, grp, s.share) != "sure" or s.session_id in before:
                picks[s.session_id] = grp.driver_id  # not sure, or a person took it back: asked
                continue
            run = db.get(models.RunSession, s.session_id)
            run.driver_id = grp.driver_id
            if run.car_id is not None:
                garage.link_driver(db, grp.driver_id, run.car_id)
            db.add(StyleTag(session_id=run.id, event_id=event_id, driver_id=grp.driver_id, source=grp.source,
                            match=round(grp.match, 3) if grp.match is not None else None))
            n += 1
        db.flush()
    from app import calendar_sync, season_match  # looked up when used: the tests reload them
    with calendar_sync._lock:
        season_match.style_checked(db, event_id, picks, splits)
        db.commit()
    return n


def settle_all(db: Session) -> int:
    """settle() for every event whose fingerprints are up to date and whose runs all have their lap traces."""
    db.execute(delete(StyleTag).where(StyleTag.session_id.not_in(select(models.RunSession.id))))
    rows = db.scalars(select(StylePrint).order_by(StylePrint.event_id)).all()
    prints = {r.event_id: ep for r in rows if (ep := ds.EventPrint.from_json(r.payload or {})) is not None}
    learned = taught(db, prints)
    n = 0
    for r in rows:
        if db.get(models.Event, r.event_id) is None:
            continue
        _, signature, pending = _ready(db, r.event_id)
        if pending or signature != r.signature:
            continue  # still being read: settled when it is done
        n += settle(db, r.event_id, prints.get(r.event_id), learned)
    return n
