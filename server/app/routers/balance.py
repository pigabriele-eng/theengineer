"""The report's car balance and setup direction section, for one session or a whole event."""
from __future__ import annotations

import gc
import threading
from collections import OrderedDict

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from app import models, page_cache, run_labels
from app.analysis.balance import Collected, analyse, car_geometry, collect, prepared
from app.analysis.quickest import keep_quickest, lap_cap
from app.analysis.setup_advice import report
from app.db import get_db
from app.routers.sessions import _get, load_main_file, official_corners
from app.vehicle.presets import PRESETS, preset_detail

router = APIRouter()

CACHE_SIZE = 8
_cache: OrderedDict[tuple, dict] = OrderedDict()
_cache_lock = threading.Lock()  # guards the cache only; the work itself runs under app.heavy.lock

# Words in a car's name that pick its vehicle preset. A session with no car is taken to be the team's car, the one
# preset there is so far; a named car that matches no preset gets no vehicle model.
PRESET_WORDS = {"bmw-m4-gt4-evo": ("m4",)}
DEFAULT_PRESET = "bmw-m4-gt4-evo"


def preset_for(cars: list[models.Car]) -> str | None:
    if not cars:
        return DEFAULT_PRESET if DEFAULT_PRESET in PRESETS else None
    name = cars[0].name.lower()
    return next((key for key, words in PRESET_WORDS.items() if all(w in name for w in words)), None)


def _best_clean(s: models.RunSession) -> float | None:
    times = [l.time_s for l in s.laps if l.clean]
    return min(times) if times else None


def _scope(db: Session, session: int | None, event: int | None) -> tuple[str, int, str, list[models.RunSession]]:
    if (session is None) == (event is None):
        raise HTTPException(422, "Give either ?session=<id> or ?event=<id>")
    if session is not None:
        s = _get(db, session)
        return "session", s.id, s.name or f"Session {s.id}", [s]  # named by its label below
    ev = db.get(models.Event, event)
    if ev is None:
        raise HTTPException(404, "Event not found")
    rows = db.scalars(select(models.RunSession).where(models.RunSession.event_id == ev.id)
                      .order_by(models.RunSession.id)).all()
    return "event", ev.id, ev.name, list(rows)


def _key(kind: str, sid: int, sessions: list[models.RunSession], names: dict[int, str]) -> tuple:
    """Changes whenever a log is added, its laps are re-timed or a run is renamed, so a cached result is never
    stale."""
    return (kind, sid, tuple((s.id, names.get(s.id), tuple(sorted(f.id for f in s.files)), len(s.laps),
                              _best_clean(s)) for s in sessions))


@router.get("/report/balance")
def balance_report(session: int | None = None, event: int | None = None, db: Session = Depends(get_db)):
    """Car balance and setup direction, advice first: the setup changes to try, each with its reason and expected
    effect; where the car, not the driver, limits the lap and by how much; and the balance (understeer or
    oversteer, and how strong) per section on entry, mid-corner and exit.

    For an event, every session with clean laps is read one at a time and reduced to its laps' few channels before
    the next is loaded, so the whole event fits in a small server's memory; a long event works from its quickest
    laps only (analysis/quickest.py): quickest_laps then says how many of how many clean laps."""
    kind, sid, name, sessions = _scope(db, session, event)
    usable = [s for s in sessions if s.files and _best_clean(s) is not None]
    if not usable:
        raise HTTPException(422, f"No clean laps to analyse in this {kind}")
    # each run called as the report calls it (run_labels.py): its own name, never a number
    labels = run_labels.labels_for(db, sessions)
    names = {s.id: labels[s.id].name for s in sessions}
    if kind == "session":
        name = names[sid]
    key = _key(kind, sid, sessions, names)
    with _cache_lock:
        if key in _cache:
            _cache.move_to_end(key)
            return _cache[key]
    # kept in the database too (app/page_cache.py); else built under heavy.lock, one log-reading job at a time across
    # the server (each holds a whole log while it reads it): a request that waited its turn may find it built meanwhile
    result = page_cache.cached(
        db, f"{kind}:{sid}|balance",
        lambda: page_cache.signature("balance", name, page_cache.sessions_part(db, usable),
                                     *run_labels.renamed(labels[s.id] for s in usable)),
        lambda: _build(db, kind, sid, name, usable, names))
    with _cache_lock:
        _cache[key] = result
        while len(_cache) > CACHE_SIZE:
            _cache.popitem(last=False)
    return result


def _build(db: Session, kind: str, sid: int, name: str, sessions: list[models.RunSession],
           names: dict[int, str] | None = None) -> dict:
    preset = preset_for([s.car for s in sessions if s.car])
    geo = car_geometry(preset_detail(preset) if preset else None)
    sessions = sorted(sessions, key=_best_clean)  # the quickest first: its fastest lap sets the line
    col = Collected()
    track = None
    for s in sessions:
        label = (names or {}).get(s.id) or s.name or f"Session {s.id}"
        before = (len(col.laps), len(col.sessions), col.line, col.length)
        data = None
        try:
            _, data, t = load_main_file(db, s)
            if track is not None and t is not None and t.id != track.id:
                col.sessions.append({"name": label, "session_id": s.id, "laps": 0, "note": "Driven at another track"})
                continue
            collect(label, data, geo, col, driver=s.driver.name if s.driver else None, meta={"session_id": s.id})
            col.laps = keep_quickest(col.laps)
            track = track or t
        except Exception:
            if kind == "session":
                raise
            # one unreadable log leaves that session out, not the whole event
            del col.laps[before[0]:], col.sessions[before[1]:]
            col.line, col.length = before[2], before[3]
            col.sessions.append({"name": label, "session_id": s.id, "laps": 0,
                                 "note": "Could not read the log; left out"})
        finally:
            del data
            gc.collect()  # free the session's channels and close its log before the next one
    corners = official_corners(track)
    prep = prepared(col, corners)
    if prep is None:
        raise HTTPException(422, f"No clean laps to analyse in this {kind}")
    out = report(analyse(prep, corners), geo.to_dict(), col.sessions, preset)
    result = {"scope": {"kind": kind, "id": sid, "name": name, "track": track.name if track else None}, **out}
    if (cap := lap_cap(len(col.laps), sum(x["laps"] for x in col.sessions))) is not None:
        result["quickest_laps"] = cap
    return result
