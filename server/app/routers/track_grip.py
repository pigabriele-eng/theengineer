"""The track's grip level session by session at an event, apart from the tyres' state (analysis/track_grip.py).

GET /track-grip/events/{id}?car=<key> answers from its cache (table track_grip_cache) when nothing it was made from
has changed: the event's sessions and their compact lap traces (through the report's signature of them), the tyre
data summaries the pooled tyre model is fitted from, and the sessions' kinds, drivers and temperatures. Otherwise it
is worked out there and then from the compact lap traces the report keeps, never from the logs: until the report has
read every log, it answers "waiting" and gets the report going. The work takes the server's heavy-work lock
(app/heavy.py) and holds one log's traces at a time plus the event's quick laps on one line (about 0.1 MB a lap).

One car at a time: the event's sessions of the car with the most of them, unless ?car= names another (the same car
keys as the tyre model and the prep report).
"""
from __future__ import annotations

import logging
import re
import statistics
from collections import Counter
from datetime import UTC, datetime

import numpy as np
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import JSON, DateTime, String, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Mapped, Session, mapped_column

from app import heavy, models
from app.analysis import compact
from app.analysis import track_grip as tg
from app.analysis.insights import LapRecord
from app.db import Base, get_db
from app.prep.plan import UNKNOWN, car_of, session_kind
from app.routers import reports
from app.routers import tyre_model as tyre_model_router
from app.routers.imports import _date
from app.vehicle import tyre_store

router = APIRouter(prefix="/track-grip")
log = logging.getLogger(__name__)

TRACK_GRIP_VERSION = 1  # raise when the method or the answer changes, so every kept one is worked out again
MAX_SESSION_LAPS = 60  # a log's quickest laps kept on the line: a long race's are plenty with these
WET_CHANNELS = ("wiper",)  # logger switches (0/1) that say the track was wet (a rain light can be on in the dry)
SAME_SESSION_S = 3600  # logs naming the same session that start within this of each other are one session


def _now() -> datetime:
    return datetime.now(UTC)


class TrackGripCache(Base):
    """The last track grip worked out for an event and a car, with the signature of what it was made from."""
    __tablename__ = "track_grip_cache"
    id: Mapped[int] = mapped_column(primary_key=True)
    scope: Mapped[str] = mapped_column(String(160), unique=True, index=True)  # "event:7|car:logger:26724"
    signature: Mapped[str] = mapped_column(String(64))
    result: Mapped[dict | None] = mapped_column(JSON)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now, onupdate=_now)


class Plan:
    def __init__(self, event: models.Event, car: str, label: str, items: list[reports.Item],
                 track: models.Track | None, others: int, signature: str):
        self.event, self.car, self.label, self.items, self.track = event, car, label, items, track
        self.others, self.signature = others, signature

    @property
    def scope(self) -> str:
        return f"event:{self.event.id}|car:{self.car}"[:160]


def _plan(db: Session, event_id: int, car: str | None) -> Plan:
    ev = db.get(models.Event, event_id)
    if ev is None:
        raise HTTPException(404, "Event not found")
    rp = reports.plan_for(db, "event", event_id)
    used = reports._used(rp)
    counts = Counter(car_of(i.session)[0] for i in used)
    if car is None or car not in counts:
        car = counts.most_common(1)[0][0] if counts else UNKNOWN
    items = [i for i in used if car_of(i.session)[0] == car]
    label = car_of(items[0].session)[1] if items else car
    # the car's pooled tyre model changes whenever one of its summaries does (the car as the tyre model counts it:
    # the session's car, else the logger's)
    pool = db.execute(select(models.TyreData.file_id, models.TyreData.updated_at, models.TyreData.tyre,
                             models.TyreData.car_key, models.RunSession.car_id)
                      .join(models.RunSession, models.RunSession.id == models.TyreData.session_id)
                      .where(models.TyreData.version == tyre_store.version(),
                             models.TyreData.status == tyre_store.OK)
                      .order_by(models.TyreData.file_id)).all()
    sig = reports._hash([TRACK_GRIP_VERSION, car, rp.track.id if rp.track else None,
                         [(i.session.id, i.name, i.signature, i.session.kind.value, i.session.driver_id,
                           i.session.ambient_temp_c, i.session.track_temp_c) for i in items],
                         [(a, str(b), c) for a, b, c, key, car_id in pool
                          if (f"car:{car_id}" if car_id is not None else key) == car]])
    return Plan(ev, car, label, items, rp.track, len(used) - len(items), sig)


def _row(db: Session, scope: str) -> TrackGripCache | None:
    return db.scalar(select(TrackGripCache).where(TrackGripCache.scope == scope))


def _answer(p: Plan, status: str, result: dict | None = None, reason: str | None = None) -> dict:
    return {"event": {"id": p.event.id, "name": p.event.name}, "car": {"key": p.car, "label": p.label},
            "status": status,  # ready, waiting, empty
            "reason": reason, "result": result}


def event_track_grip(db: Session, event_id: int, car: str | None = None) -> dict:
    """The answer of GET /track-grip/events/{id} (also the prep report's, for each past event)."""
    p = _plan(db, event_id, car)
    if not p.items:
        return _answer(p, "empty", reason="No clean laps at this event yet, so the track's grip can't be told.")
    row = _row(db, p.scope)
    if row is not None and row.signature == p.signature and row.result is not None:
        return _answer(p, "ready", row.result)
    if not _traces_ready(db, p):
        rep = reports.report_for(db, "event", event_id)  # the report reads the logs into the traces this uses
        if rep["status"] in ("failed", "empty"):
            return _answer(p, "empty", reason=rep.get("error") or "The logs of this event couldn't be read.")
        return _answer(p, "waiting", reason="The report is still reading the logs; the track grip follows it.")
    with heavy.lock:  # the event's laps on one line, and the tyre model's fit: one heavy job at a time
        db.expire_all()
        row = _row(db, p.scope)
        if row is not None and row.signature == p.signature and row.result is not None:
            return _answer(p, "ready", row.result)  # worked out while this request waited for the lock
        result = reports._plain(compute(db, p))
    for _ in range(2):
        if row is None:
            row = TrackGripCache(scope=p.scope)
            db.add(row)
        row.signature, row.result = p.signature, result
        try:
            db.commit()
            break
        except IntegrityError:  # another request stored it a moment ago: overwrite that one
            db.rollback()
            row = _row(db, p.scope)
    return _answer(p, "ready", result)


def _traces_ready(db: Session, p: Plan) -> bool:
    ids = [i.session.id for i in p.items]
    recs = {r.session_id: r for r in db.scalars(select(models.SessionTraces)
                                                .where(models.SessionTraces.session_id.in_(ids)))}
    return all((r := recs.get(i.session.id)) is not None and r.signature == i.signature for i in p.items)


@router.get("/events/{event_id}")
def track_grip(event_id: int, car: str | None = None, db: Session = Depends(get_db)):
    """The track's grip level session by session at an event, in time order and against the first session, with the
    tyres' state taken out by the pooled tyre model, and a plain-words read of how it evolved."""
    return event_track_grip(db, event_id, car)


# ---------- the work ----------

def _start(s: models.RunSession, f: models.LoggerFile | None) -> str | None:
    """When the session's log started, ISO: the sessions are taken in this order."""
    meta = (f.meta if f is not None else None) or {}
    day = _date(meta.get("date") or "")
    if day is None:
        return s.created_at.isoformat() if s.created_at else None
    t = (meta.get("time") or "").strip()
    return f"{day.isoformat()}T{t}" if t else day.isoformat()


def _states(db: Session, f: models.LoggerFile | None) -> dict[int, dict]:
    """Each lap's tyre state (TPMS temperature and hot pressure per axle) from the log's tyre data summary."""
    row = db.scalar(select(models.TyreData).where(models.TyreData.file_id == f.id)) if f is not None else None
    if row is None or not row.summary:
        return {}
    out = {}
    for lap in row.summary.get("laps", []):
        if lap.get("lap") is not None:
            out[int(lap["lap"])] = {f"{ax}_{k}": v for ax in ("front", "rear")
                                    for k, src in (("c", "temp_c"), ("bar", "bar"))
                                    if (v := (lap.get(ax) or {}).get(src)) is not None}
    return out


def _ambient(db: Session, group: list[reports.Item]) -> float | None:
    """The air temperature: as entered for the session, else the loggers' (at racing speed)."""
    entered = [i.session.ambient_temp_c for i in group if i.session.ambient_temp_c is not None]
    if entered:
        return statistics.median(entered)
    ids = [i.session.id for i in group]
    vals = [a for (a,) in db.execute(select(models.TyreData.ambient_c).where(models.TyreData.session_id.in_(ids)))
            if a is not None]
    return statistics.median(vals) if vals else None


def _wet(cs: compact.CompactSession) -> np.ndarray:
    """Per lap: the logger's wiper switch on for most of it."""
    wet = np.zeros(cs.n_laps, bool)
    for name, (_unit, med, _sd) in cs.channels.items():
        if any(w in name.lower() for w in WET_CHANNELS) and len(med) == cs.n_laps:
            vals = np.nan_to_num(np.asarray(med, float))
            if vals.max(initial=0) <= 1.0:  # a switch, not a wiper speed or a rotary switch's position
                wet |= vals > 0.5
    return wet


def _parse(iso: str | None) -> datetime | None:
    try:
        return datetime.fromisoformat(iso) if iso else None
    except ValueError:
        return None


def _groups(items: list[reports.Item], starts: dict[int, str | None]) -> list[list[reports.Item]]:
    """The logs of one official session together: the same session in the log header (Q, R1, D1S2) on the same day,
    starting within SAME_SESSION_S of the first; a log whose header names none is a session of its own."""
    groups: list[tuple[tuple, datetime | None, list]] = []
    for item in sorted(items, key=lambda i: (starts[i.session.id] or "", i.session.id)):
        start = starts[item.session.id]
        name = ((item.file.meta or {}).get("event_session") or "").strip().lower()
        key, when = (name, start[:10] if start else None), _parse(start)
        hit = next((g for g in groups if name and g[0] == key and g[1] is not None and when is not None
                    and abs((when - g[1]).total_seconds()) <= SAME_SESSION_S), None)
        if hit is None:
            groups.append((key, when, [item]))
        else:
            hit[2].append(item)
    return [g[2] for g in groups]


def _name(group: list[reports.Item]) -> str:
    """The session's name: its logs' shortest, without the " (2)" an import adds to a second log of the same name."""
    return min((re.sub(r"\s*\(\d+\)$", "", i.name) or i.name for i in group), key=lambda n: (len(n), n))


def compute(db: Session, p: Plan) -> dict:
    """Every session's quick laps on one line, their grip at the limit, the tyre model's share and the evolution."""
    best = {i.session.id: min(l.time_s for l in i.session.laps if l.clean and l.file_id == i.file.id)
            for i in p.items}
    starts = {i.session.id: _start(i.session, i.file) for i in p.items}
    before, total = {}, 0  # laps the car had driven before each log, for "most of it in the first y laps"
    for i in sorted(p.items, key=lambda i: (starts[i.session.id] or "", i.session.id)):
        before[i.session.id] = total
        total += sum(1 for l in i.session.laps if l.file_id == i.file.id)
    line, length = None, None
    laps: list[LapRecord] = []
    per_log: dict[int, list[tg.LapIn]] = {}
    unread = []
    # the quickest lap's log lays down the line every lap is put on; then one log's traces at a time
    for item in sorted(p.items, key=lambda i: best[i.session.id]):
        s = item.session
        cs = reports._load(db, item, p.track)
        if cs is None or not cs.n_laps:
            rec = db.scalar(select(models.SessionTraces).where(models.SessionTraces.session_id == s.id))
            if rec is not None and rec.error:
                unread.append(item.name)
            continue
        keep = cs.times <= cs.times.min() * (1 + tg.QUICK_WITHIN)  # only the quick laps are ever used
        keep &= np.argsort(np.argsort(cs.times)) < MAX_SESSION_LAPS
        cs = compact.keep_laps(cs, keep)
        cs.traces = {k: v for k, v in cs.traces.items() if k == "t" or k in tg.TRACE_ROLES}
        wet = _wet(cs)
        cs.channels = {}
        if line is None and length is None:
            line, length = cs.line, cs.length
        position = {n: k + 1 for k, n in enumerate(sorted(l.number for l in s.laps if l.file_id == item.file.id))}
        states = _states(db, item.file)
        mine = per_log.setdefault(s.id, [])
        for k, tr in enumerate(compact.laps_on(cs, line, length)):
            number, time = int(cs.numbers[k]), float(cs.times[k])
            tr.pop("t", None)
            tr.pop("distance", None)
            x = LapRecord(str(s.id), number, time, None, tr, int(cs.index_in_run[k]))
            laps.append(x)
            mine.append(tg.LapIn(x.key, number, time, before[s.id] + position.get(number, number),
                                 **states.get(number, {}), wet=bool(wet[k])))
        del cs
        heavy.trim()
    measured = tg.lap_grip(laps) if laps else None
    del laps
    heavy.release_memory()
    notes = []
    if unread:
        notes.append(f"Left out, their logs couldn't be read: {', '.join(unread)}.")
    if p.others:
        notes.append(f"{p.others} session{'s' if p.others > 1 else ''} of another car at this event left out: the "
                     "track grip is one car's.")
    if measured is None:
        return {"available": False, "sessions": [], "laps": [], "read": [], "headline": None, "method": tg.METHOD,
                "notes": [*notes, "The laps never ride at the car's grip limit for long enough to compare them, so "
                          "the track's grip can't be told."]}
    sessions = []
    for group in _groups([i for i in p.items if i.session.id in per_log], starts):
        ids = [i.session.id for i in group]
        track_c = [i.session.track_temp_c for i in group if i.session.track_temp_c is not None]
        sessions.append(tg.SessionIn(
            f"s{ids[0]}", _name(group), ids, starts[ids[0]], session_kind(group[0].session),
            sorted({i.session.driver.name for i in group if i.session.driver}), _ambient(db, group),
            statistics.median(track_c) if track_c else None, [lap for i in ids for lap in per_log[i]]))
    model, conditions = _tyre_model(db, p.car)
    out = tg.evolution(sessions, measured.grip, conditions, model)
    out["basis"] = {"limit_m": measured.limit_m, "length_m": measured.length_m, "road_load": measured.road_load,
                    "laps": len(measured.grip)}
    out["method"] = tg.METHOD
    out["notes"] = [*out.get("notes", []), *notes]
    out["track"] = p.track.name if p.track else None
    return out


def _tyre_model(db: Session, car: str) -> tuple[dict | None, dict | None]:
    """The pooled tyre model of the car (every track, its usual tyre): what it rests on, and its conditions."""
    # tyre-kind hook: once sessions carry a tyre kind (seasons.tyre_kind_for_session), fit the pool of that kind here
    try:
        m = tyre_model_router.tyre_model(car=car, tyre_kind=None, track=None, ambient_min=None, ambient_max=None, db=db)
    except HTTPException:  # no summarised session of this car yet
        return None, None
    if m.get("empty") or not m.get("conditions"):
        return None, None
    basis = m.get("basis") or {}
    return {"sessions": basis.get("sessions"), "laps": basis.get("laps"), "tyre": m.get("tyre")}, m["conditions"]
