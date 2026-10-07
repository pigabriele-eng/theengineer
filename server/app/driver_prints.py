"""The driver fingerprint database: every event's lap fingerprints (analysis/driver_style.py), kept per event.

An event's fingerprints are worked out from the report's compact lap traces (routers/reports.py), so no log is read
again: in the background after every report of an event (each upload starts one), and for any event still missing
them when the fingerprints page or an event's driver suggestions are asked for. A row is worked out again when the
event's lap traces change (signature).

Which driver a lap is comes from the runs' driver tags at the time it is asked, never from the stored row, so a tag
counts at once. Only tagged runs teach the database a driver's fingerprint; suggestions never do, so a wrong one
can't spread.

A new table (create_all adds it; nothing on the existing tables changes). No foreign key: the row of an event that
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
from sqlalchemy import JSON, DateTime, Integer, String, select
from sqlalchemy.orm import Mapped, Session, mapped_column

from app import db as app_db  # SessionLocal is looked up when used: the tests swap the database
from app import heavy, models, storage
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
    """Every event whose fingerprints are missing or out of date, until none is (asked again meanwhile: once more)."""
    while True:
        _bg["again"] = False
        with app_db.SessionLocal() as db:
            for ev_id in stale(db):
                try:
                    refresh(db, ev_id)
                except Exception:
                    db.rollback()
                    log.exception("Driver fingerprints of event %s failed", ev_id)
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


def tags_of(db: Session, ep: ds.EventPrint) -> dict[int, int | None]:
    ids = sorted(set(ep.sessions))
    rows = db.execute(select(models.RunSession.id, models.RunSession.driver_id)
                      .where(models.RunSession.id.in_(ids))).all()
    return {sid: did for sid, did in rows}


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
