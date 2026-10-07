"""Driver habits: each driver's recurring technique mistakes over every event, getting better or worse, and drivers
side by side (analysis/habit_track.py says how).

GET /drivers/habits answers from what is already kept: every event's technique check (routers/technique.py, worked
out after each upload by the prebuild), who drove each run now (whoever set it: a person, the season's drivers or the
driving style), and the drivers' style fingerprints (app/driver_prints.py). Nothing reads a log. The answer is kept
(app/page_cache.py) until any of those change, and each event's corner types (from the speeds of the event's fastest
lap, in the check's file) are kept with the event.
"""
from __future__ import annotations

import logging
from datetime import date

import numpy as np
from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.orm import Session

from app import driver_prints, models, page_cache
from app.analysis import habit_track as ht
from app.db import get_db
from app.run_labels import driver_code
from app.routers.imports import _date

router = APIRouter()
log = logging.getLogger(__name__)

VERSION = 2  # raise when the answer changes, so the kept one is worked out again
SCOPE = "drivers|habits"


def _types(db: Session, row: models.TechniqueCache, result: dict) -> dict[str, str]:
    """The event's corner types by section code, kept with the event until its check changes."""
    scope = f"{row.scope}|corner-types"
    sig = page_cache.digest(["corner-types", VERSION, row.result_signature, row.details])
    hit = page_cache.lookup(db, scope, sig)
    if hit is not None and hit[0] == 200:
        return hit[1]
    from app.routers import technique  # looked up when used: the tests reload it
    ref = result.get("reference") or {}
    lap = next((x for x in result.get("laps") or [] if x["key"] == ref.get("key")), None)
    try:
        trace = ((technique._detail(row, lap["detail"]) or {}).get("trace") or {}) if lap else {}
    except Exception:  # storage out of reach: the corner types wait for the next time
        log.warning("Habits: the fastest lap of %s couldn't be read", row.scope, exc_info=True)
        trace = {}
    out = ht.section_types(result.get("sections") or [], trace.get("driven"), int(trace.get("step_m") or 0))
    if out:
        page_cache.store(db, scope, sig, out)
    return out


def _days(db: Session, events: dict[int, models.Event]) -> dict[int, date | None]:
    """Each event's first day as the event list has it: set by hand, else its first log's, else the event's date."""
    ids = list(events)
    by_hand = {r.event_id: r.start or r.end for r in db.scalars(select(models.EventDates)
                                                               .where(models.EventDates.event_id.in_(ids)))}
    logged: dict[int, date] = {}
    for eid, meta in db.execute(select(models.RunSession.event_id, models.LoggerFile.meta)
                                .join(models.LoggerFile, models.LoggerFile.session_id == models.RunSession.id)
                                .where(models.RunSession.event_id.in_(ids))):
        d = _date((meta or {}).get("date") or "")
        if d is not None and (eid not in logged or d < logged[eid]):
            logged[eid] = d
    return {i: by_hand.get(i) or logged.get(i) or events[i].date for i in ids}


def _labels(events: list[models.Event], days: dict[int, date | None]) -> dict[int, str]:
    """The track's name for each event (its own name without a track), with the year where a track comes twice."""
    base = {e.id: e.track.name if e.track else e.name for e in events}
    seen: dict[str, int] = {}
    for b in base.values():
        seen[b] = seen.get(b, 0) + 1
    return {i: f"{b} {days[i].year}" if seen[b] > 1 and days.get(i) else b for i, b in base.items()}


def _styles(db: Session, event_ids: set[int], driver_of: dict[int, int]) -> dict[int, dict[int, dict[str, float]]]:
    """Each driver's fingerprint by kind at each event (the mean over their laps there), for drivers with
    MIN_EVENT_LAPS laps or more."""
    out: dict[int, dict[int, dict[str, float]]] = {}
    for eid, ep in driver_prints.stored(db).items():
        if eid not in event_ids or not len(ep.sessions):
            continue
        by = np.array([driver_of.get(int(s), -1) for s in ep.sessions])
        for d in sorted({int(x) for x in by if x >= 0}):
            mine = by == d
            if mine.sum() >= ht.MIN_EVENT_LAPS:
                out.setdefault(eid, {})[d] = dict(zip(ep.kinds, ep.v[mine].mean(0).tolist(), strict=True))
    return out


@router.get("/drivers/habits")
def driver_habits(db: Session = Depends(get_db)):
    """Every driver's recurring mistakes over every event checked: by area (braking, mid-corner, throttle and exits,
    shifting), by corner type and habit by habit, each with how often (share of the corners driven), what it costs a
    lap and whether it is getting better or worse; and how two drivers' styles differ every time they share the car."""
    tc = models.TechniqueCache
    checks = db.execute(select(tc.id, tc.scope, tc.result_signature, tc.status)
                        .where(tc.scope.like("event:%"))).all()
    ids = {int(c.scope.split(":")[1]) for c in checks}
    events = {e.id: e for e in db.scalars(select(models.Event).where(models.Event.id.in_(ids)))} if ids else {}
    done = sorted((c.id, int(c.scope.split(":")[1]), c.result_signature) for c in checks
                  if c.result_signature and int(c.scope.split(":")[1]) in events)
    checking = sorted(int(c.scope.split(":")[1]) for c in checks
                      if c.status in ("queued", "running") and int(c.scope.split(":")[1]) in events)
    runs = [list(r) for r in db.execute(select(models.RunSession.id, models.RunSession.event_id,
                                               models.RunSession.driver_id)
                                        .where(models.RunSession.event_id.in_(list(events)))
                                        .order_by(models.RunSession.id))] if events else []
    names = {d.id: d.name for d in db.scalars(select(models.Driver))}
    days = _days(db, events) if events else {}
    prints = [list(r) for r in db.execute(select(driver_prints.StylePrint.event_id, driver_prints.StylePrint.signature)
                                          .order_by(driver_prints.StylePrint.event_id))]
    sig = page_cache.digest(["habits", VERSION, [list(x) for x in done], runs, sorted(names.items()),
                             [[i, e.name, e.track.name if e.track else None, str(days.get(i))]
                              for i, e in sorted(events.items())], prints, checking])
    hit = page_cache.lookup(db, SCOPE, sig)
    if hit is not None and hit[0] == 200:
        return hit[1]

    driver_of = {int(sid): int(did) for sid, _, did in runs if did is not None}
    done.sort(key=lambda x: (days.get(x[1]) or date.max, x[1]))
    labels = _labels([events[e] for _, e, _ in done], days)
    evs: list[ht.Event] = []
    for row_id, eid, _ in done:
        row = db.get(tc, row_id)
        result = row.result if row is not None else None
        if not result:
            continue
        types = _types(db, row, result)
        tallies = ht.tally_event(result, driver_of, types)
        db.expunge(row)  # one event's laps in memory at a time
        del result
        if tallies:
            evs.append(ht.Event(eid, labels[eid], tallies))
    out = ht.tracker(evs, names, {d: driver_code(n) for d, n in names.items()},
                     {e.id: e.label for e in evs}, _styles(db, {e.id for e in evs}, driver_of))
    out = {"status": "checking" if checking else "ready", "checking": [events[e].name for e in checking],
           **out,
           "events": [{"id": e.id, "name": events[e.id].name, "track": e.label,
                       "date": days[e.id].isoformat() if days.get(e.id) else None,
                       "laps": {str(d): t.laps for d, t in e.tallies.items() if t.laps}} for e in evs]}
    body = page_cache.plain(out)
    page_cache.store(db, SCOPE, sig, body)
    return body
