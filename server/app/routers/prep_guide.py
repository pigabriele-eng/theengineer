"""GET /prep/events/{id}/guide?car=<key>: the lap guide of a coming weekend (app/prep/guide.py), the gear map and the
corner-by-corner passes of the race weekend's Before view.

From the past events at the venue with the same car, as the prep report picks them (app/prep/plan.py), and the
report's compact lap traces of their sessions: no log is read, so it needs neither the heavy-work lock nor much
memory (one session's traces at a time, a few MB). While some of those traces are still being made (the report's own
background work, started here when needed) the answer is "working"; the client asks again. A finished answer is kept
in page_cache with a signature of the sessions' traces, names, the track's corners and the car, so it opens at once
the next time.
"""
from __future__ import annotations

import statistics

import numpy as np

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from app import heavy, models, page_cache, storage
from app.analysis import compact
from app.db import get_db
from app.prep import guide
from app.prep import plan as prep_plan
from app.routers import reports
from app.routers.sessions import official_corners
from app.timing import read_file

router = APIRouter(prefix="/prep")


def _traces(db: Session, s: models.RunSession) -> tuple[str, models.SessionTraces | None, models.Track | None]:
    """Whether the session's compact traces are made and up to date: ready, working, failed or no laps."""
    f = reports._main_file(s)
    if f is None or not any(l.clean and l.file_id == f.id for l in s.laps):
        return "no laps", None, None
    track = reports._track_of(db, s, f)
    rec = db.scalar(select(models.SessionTraces).where(models.SessionTraces.session_id == s.id))
    if rec is None or rec.signature != reports._traces_signature(s, f, track):
        return "working", None, track
    if rec.error or rec.path is None:
        return "failed", rec, track
    return "ready", rec, track


def _load(rec: models.SessionTraces) -> compact.CompactSession | None:
    try:
        return compact.from_file(storage.local_path(rec.path))
    except (FileNotFoundError, ValueError, OSError, storage.StorageError):
        return None  # gone from storage or an older format: the report makes it again


def _first_gear(s: models.RunSession, cs: compact.CompactSession, lap: int) -> int | None:
    """The value the session's log gives first gear (guide.first_gear), from its gear, speed and revs channels only
    (the log is memory-mapped: a few MB), under the heavy-work lock. None when it can't be told: gears as logged."""
    lowest = guide.lowest_gear(cs, lap)
    names = cs.sources
    f = reports._main_file(s)
    if lowest is None or f is None or not names.get("gear") or not names.get("speed"):
        return None
    with heavy.lock:
        try:
            ld = read_file(f)
        except (OSError, ValueError, storage.StorageError):
            return None
        gear, speed = ld.channel(names["gear"]), ld.channel(names["speed"])
        rpm = ld.channel(names["rpm"]) if names.get("rpm") else None
        if gear is None or speed is None:
            return None
        series = [(ch.times(), ch.values()) if ch is not None else None for ch in (gear, speed, rpm)]
        del ld, gear, speed, rpm
    return guide.first_gear(series[0], series[1], series[2], lowest)


def _none(p: prep_plan.Plan | None, reason: str) -> dict:
    return {"status": "none", "reason": reason, "car": p.car if p else None}


@router.get("/events/{event_id}/guide")
def prep_guide(event_id: int, car: str | None = None, db: Session = Depends(get_db)):
    """The gear map of the best lap at this event's venue and each corner's best and typical pass there."""
    p = prep_plan.plan(db, event_id, car)
    if p is None:
        raise HTTPException(404, "Event not found")
    if p.error or not p.past:
        return _none(p, p.error or "No past event here to learn from.")
    pool = [(pe, s) for pe in p.past for s in pe.sessions]
    states = {s.id: _traces(db, s) for _, s in pool}
    working = [pe for pe, s in pool if states[s.id][0] == "working"]
    if working:
        for pe in {pe.id: pe for pe in working}.values():
            reports.report_for(db, "event", pe.id)  # makes the traces, one log at a time, in its own background job
        return {"status": "working", "reason": "The past events' laps are being read.", "car": p.car}
    ready = [(pe, s, states[s.id][1], states[s.id][2]) for pe, s in pool if states[s.id][0] == "ready"]
    if not ready:
        return _none(p, "No lap traces could be made from the past events' logs.")

    # the laps that count: clean, and not a pit log's stub (prep/plan.py's rule)
    clean = {s.id: [l.time_s for l in prep_plan.clean_laps(s) if l.time_s] for _, s, _, _ in ready}
    every = [t for v in clean.values() for t in v]
    floor = prep_plan.PLAUSIBLE * statistics.median(every) if every else 0.0
    best = min(((t, s_id) for s_id, ts in clean.items() for t in ts if t >= floor), default=None)
    if best is None:
        return _none(p, "No clean lap at the past events here.")
    ref_row = next(r for r in ready if r[1].id == best[1])
    corners = official_corners(ref_row[3])

    sig = page_cache.digest(["guide", guide.GUIDE_VERSION, p.car, corners,
                             [[pe.id, pe.info.event.name, pe.info.start, s.id, s.name,
                               s.driver.name if s.driver else None, rec.signature, rec.path]
                              for pe, s, rec, _ in ready]])
    scope = f"event:{event_id}|guide|{p.car}"[:160]
    hit = page_cache.lookup(db, scope, sig)
    if hit is not None and hit[0] == 200:
        return hit[1]

    def source(pe: prep_plan.PastEvent, s: models.RunSession) -> guide.Source:
        return guide.Source(s.id, s.name, s.driver.name if s.driver else None, pe.id, pe.info.event.name,
                            pe.info.start[:4] if pe.info.start else None)

    cs = _load(ref_row[2])
    if cs is None or not cs.n_laps:
        return _none(p, "The best lap's traces couldn't be read.")
    lap = int(np.argmin(np.where(cs.times >= floor, cs.times, np.inf)))
    db.commit()  # hands the database connection back while the log waits for the heavy-work lock
    g = guide.Guide(source(ref_row[0], ref_row[1]), cs, lap, corners, _first_gear(ref_row[1], cs, lap))
    del cs
    for pe, s, rec, _ in ready:
        if s.id == ref_row[1].id:
            continue
        other = _load(rec)
        if other is not None:
            g.add(source(pe, s), other, floor)
        del other
    out = {"status": "ready", "reason": None, "car": p.car, **g.result()}
    page_cache.store(db, scope, sig, out)
    return page_cache.plain(out)
