"""Events as folders: the sessions of a test or a race weekend together, by day, and sessions moved between them.

GET /events/folders lists every event with its dates (set by hand, else its logs' first and last day), its track, how
many sessions it holds and its best lap; sessions in no event make a folder of their own (key "none"). GET
/events/{key} is one folder with its sessions grouped by the day their logs were recorded. Events are made, renamed,
re-dated and deleted here (deleting one keeps its sessions, unless asked to delete them too: event_delete.py), and
sessions are moved in and out, several at once.
PATCH /sessions/{id} renames a session, changes its kind or moves it.

GET /events/{key}/compare?sessions=1,2 puts sessions of one folder side by side from the report's compact lap traces
(analysis/side_by_side.py): no log is read. A session whose traces aren't made yet gets the report's background work
going, and the answer says so until they are.

Moving a session changes what the event's report, technique check and maps are made from: their caches are keyed by
the sessions they hold, so they are worked out again; the reports of the events a move touches are started at once.
"""
from __future__ import annotations

import logging
import re
import threading
from collections import OrderedDict
from datetime import date
from typing import Annotated, Literal

import numpy as np
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import delete, select
from sqlalchemy.orm import Session, selectinload

from app import event_delete, models, storage
from app.analysis import compact
from app.analysis.insights import consistency
from app.analysis.side_by_side import Reference, best_index, reference_of, summarise
from app.db import get_db
from app.routers import reports, technique
from app.routers.imports import _date
from app.routers.sessions import official_corners

router = APIRouter()
log = logging.getLogger(__name__)

NONE = "none"  # the folder of sessions in no event
NONE_NAME = "Not in an event"
MAX_COMPARED = 6
CACHE_SIZE = 16  # side-by-side answers kept, a few kB each

_cache: OrderedDict[tuple, dict] = OrderedDict()
_cache_lock = threading.Lock()


class FolderIn(BaseModel):
    name: str = Field(min_length=1, max_length=160)
    series: str | None = Field(None, max_length=80)
    start: date | None = None
    end: date | None = None


class FolderPatch(BaseModel):
    """Only the fields sent change. start and end both null: the dates come from the logs again."""
    name: str | None = Field(None, min_length=1, max_length=160)
    series: str | None = Field(None, max_length=80)
    start: date | None = None
    end: date | None = None


class MoveIn(BaseModel):
    session_ids: list[int] = Field(min_length=1, max_length=500)


class SessionPatch(BaseModel):
    """Only the fields sent change; event_id null takes the session out of its event."""
    name: str | None = Field(None, min_length=1, max_length=120)
    kind: models.SessionKind | None = None
    event_id: int | None = None


# ---------- reading ----------

def _main_laps(s: models.RunSession) -> list[models.Lap]:
    """The laps of the log the analysis reads (the longest), as the report and Compare laps time them."""
    f = reports._main_file(s)
    return [l for l in s.laps if f is not None and l.file_id == f.id]


def _when(s: models.RunSession) -> tuple[date | None, str | None, str | None]:
    """The day the session's log was recorded, the time it started (HH:MM) and the session it names (D1S1)."""
    f = reports._main_file(s)
    if f is None:
        return None, None, None
    t = (f.meta.get("time") or "").strip()
    return _date(f.meta.get("date") or ""), t[:5] or None, (f.meta.get("event_session") or "").strip() or None


def session_row(s: models.RunSession) -> dict:
    laps = _main_laps(s)
    clean = [l for l in laps if l.clean]
    best = min(clean, key=lambda l: l.time_s) if clean else None
    times = [l.time_s for l in clean]
    day, at, logged = _when(s)
    return {"id": s.id, "name": s.name or f"Session {s.id}", "kind": s.kind.value, "event_id": s.event_id,
            "driver": s.driver.name if s.driver else None, "driver_id": s.driver_id, "car_id": s.car_id,
            "date": day.isoformat() if day else None, "time": at,
            "log_session": logged, "laps": len(laps), "clean_laps": len(clean),
            "best_lap_s": best.time_s if best else None, "best_lap": best.number if best else None,
            "typical_s": round(float(np.median(times)), 3) if times else None,
            "consistency": consistency(times), "has_log": bool(s.files)}


def _sessions(db: Session, event_id: int | None) -> list[models.RunSession]:
    q = select(models.RunSession).options(selectinload(models.RunSession.laps), selectinload(models.RunSession.files),
                                          selectinload(models.RunSession.driver))
    col = models.RunSession.event_id
    q = q.where(col == event_id if event_id is not None else col.is_(None))
    return list(db.scalars(q.order_by(models.RunSession.id)).all())


def _dates_row(db: Session, event_id: int) -> models.EventDates | None:
    return db.scalar(select(models.EventDates).where(models.EventDates.event_id == event_id))


def _track_name(ev: models.Event | None, sessions: list[models.RunSession]) -> str | None:
    if ev is not None and ev.track is not None:
        return ev.track.name
    venues = {f.meta.get("venue") for s in sessions for f in s.files if f.meta.get("venue")}
    return venues.pop() if len(venues) == 1 else None


def _folder(ev: models.Event | None, sessions: list[models.RunSession], dates: models.EventDates | None,
            rows: list[dict] | None = None) -> dict:
    rows = rows if rows is not None else [session_row(s) for s in sessions]
    logged = sorted({r["date"] for r in rows if r["date"]})
    by_hand = dates is not None and (dates.start is not None or dates.end is not None)
    if by_hand:
        start = (dates.start or dates.end).isoformat()
        end = (dates.end or dates.start).isoformat()
    else:
        fallback = ev.date.isoformat() if ev is not None and ev.date else None
        start, end = (logged[0], logged[-1]) if logged else (fallback, fallback)
    timed = [r for r in rows if r["best_lap_s"] is not None]
    best = min(timed, key=lambda r: r["best_lap_s"]) if timed else None
    return {"id": ev.id if ev else None, "key": str(ev.id) if ev else NONE, "name": ev.name if ev else NONE_NAME,
            "series": ev.series if ev else None, "track": _track_name(ev, sessions), "start": start, "end": end,
            "dates_by_hand": by_hand, "log_start": logged[0] if logged else None,
            "log_end": logged[-1] if logged else None, "sessions": len(rows),
            "clean_laps": sum(r["clean_laps"] for r in rows),
            "best_lap_s": best["best_lap_s"] if best else None, "best_session_id": best["id"] if best else None,
            "best_session": best["name"] if best else None}


def _days(rows: list[dict]) -> list[dict]:
    """Sessions by the day their log was recorded, in order through the day; sessions without a log date last."""
    def order(r: dict):
        return (r["time"] or "99:99", _natural(r["name"]), r["id"])
    days: dict[str | None, list[dict]] = {}
    for r in rows:
        days.setdefault(r["date"], []).append(r)
    keys = sorted((d for d in days if d), key=str) + ([None] if None in days else [])
    return [{"date": d, "sessions": sorted(days[d], key=order)} for d in keys]


def _natural(text: str) -> tuple:
    return tuple(int(p) if p.isdigit() else p.lower() for p in re.split(r"(\d+)", text))


def _event(db: Session, event_id: int) -> models.Event:
    ev = db.get(models.Event, event_id)
    if ev is None:
        raise HTTPException(404, "Event not found")
    return ev


def _key_event(db: Session, key: str) -> models.Event | None:
    """The event a folder key names: an event id, or "none" for the sessions in no event (None)."""
    if key == NONE:
        return None
    if not key.isdigit():
        raise HTTPException(404, "Event not found")
    return _event(db, int(key))


@router.get("/events/folders")
def list_folders(db: Session = Depends(get_db)):
    """Every event as a folder (newest first), and the sessions in no event as one more folder when there are
    any (first, so they are filed)."""
    sessions = db.scalars(select(models.RunSession).options(
        selectinload(models.RunSession.laps), selectinload(models.RunSession.files),
        selectinload(models.RunSession.driver))).all()
    by_event: dict[int | None, list[models.RunSession]] = {}
    for s in sessions:
        by_event.setdefault(s.event_id, []).append(s)
    dates = {d.event_id: d for d in db.scalars(select(models.EventDates)).all()}
    events = db.scalars(select(models.Event).options(selectinload(models.Event.track))).all()
    out = [_folder(ev, by_event.get(ev.id, []), dates.get(ev.id)) for ev in events]
    out.sort(key=lambda f: (f["end"] or f["start"] or "", f["id"]), reverse=True)
    if by_event.get(None):
        out.insert(0, _folder(None, by_event[None], None))
    return out


@router.post("/events/folders", status_code=201)
def create_folder(body: FolderIn, db: Session = Depends(get_db)):
    """A new, empty event with a name and, when known, its first and last day."""
    _check_dates(body.start, body.end)
    ev = models.Event(name=_text(body.name, "event"), series=body.series, date=body.start or body.end)
    db.add(ev)
    db.flush()
    if body.start or body.end:
        db.add(models.EventDates(event_id=ev.id, start=body.start, end=body.end))
    db.commit()
    return folder(str(ev.id), db)


@router.get("/events/{key}")
def folder(key: str, db: Session = Depends(get_db)):
    """One folder: the event (or the sessions in no event) with its sessions grouped by day."""
    ev = _key_event(db, key)
    sessions = _sessions(db, ev.id if ev else None)
    rows = [session_row(s) for s in sessions]
    out = _folder(ev, sessions, _dates_row(db, ev.id) if ev else None, rows)
    out["days"] = _days(rows)
    return out


@router.patch("/events/{event_id}")
def update_folder(event_id: int, body: FolderPatch, db: Session = Depends(get_db)):
    """Rename an event or set its dates; dates sent as null go back to the logs' dates."""
    ev = _event(db, event_id)
    sent = body.model_fields_set
    if "name" in sent and body.name is not None:
        ev.name = _text(body.name, "event")
    if "series" in sent:
        ev.series = body.series
    if "start" in sent or "end" in sent:
        row = _dates_row(db, event_id)
        start = body.start if "start" in sent else (row.start if row else None)
        end = body.end if "end" in sent else (row.end if row else None)
        _check_dates(start, end)
        if start is None and end is None:
            if row is not None:
                db.delete(row)
            logged = [d for s in _sessions(db, event_id) if (d := _when(s)[0])]
            ev.date = min(logged) if logged else ev.date
        else:
            if row is None:
                row = models.EventDates(event_id=event_id)
                db.add(row)
            row.start, row.end = start, end
            ev.date = start or end
    db.commit()
    return folder(str(event_id), db)


@router.delete("/events/{event_id}")
def delete_folder(event_id: int, db: Session = Depends(get_db),
                  runs: Annotated[Literal["keep", "delete"], Query()] = "keep"):
    """Delete the event, not its sessions: they go to the sessions in no event. With runs=delete the event goes with
    its sessions, their logs and everything kept for them (event_delete.py)."""
    if runs == "delete":
        return event_delete.delete_event(db, event_id)
    ev = _event(db, event_id)
    sessions = _sessions(db, event_id)
    for s in sessions:
        s.event_id = None
    db.flush()  # the sessions let go of the event before it goes (a foreign key)
    db.execute(delete(models.EventDates).where(models.EventDates.event_id == event_id))
    scope = f"event:{event_id}"
    db.execute(delete(models.ReportCache).where(models.ReportCache.scope == scope))
    db.execute(delete(models.TechniqueCache).where(models.TechniqueCache.scope == scope))
    db.delete(ev)
    db.commit()
    return {"deleted": event_id, "sessions_kept": [s.id for s in sessions]}


@router.post("/events/{key}/sessions")
def move_into(key: str, body: MoveIn, db: Session = Depends(get_db)):
    """Move sessions into this event (or, with key "none", out of their events), several at once."""
    target = _key_event(db, key)
    ids = list(dict.fromkeys(body.session_ids))
    rows = {s.id: s for s in db.scalars(select(models.RunSession).where(models.RunSession.id.in_(ids))).all()}
    missing = [i for i in ids if i not in rows]
    if missing:
        raise HTTPException(404, f"Session {missing[0]} not found")
    move(db, [rows[i] for i in ids], target)
    return folder(key, db)


@router.patch("/sessions/{session_id}")
def update_session(session_id: int, body: SessionPatch, db: Session = Depends(get_db)):
    """Rename a session (a short label such as FP1 or Race), change its kind or move it to another event."""
    s = db.get(models.RunSession, session_id)
    if s is None:
        raise HTTPException(404, "Session not found")
    sent = body.model_fields_set
    moving = "event_id" in sent and body.event_id != s.event_id
    target = _event(db, body.event_id) if moving and body.event_id is not None else None
    renamed = "name" in sent and body.name is not None and _text(body.name, "session") != s.name
    if renamed:
        s.name = _text(body.name, "session")
    if "kind" in sent and body.kind is not None:
        s.kind = body.kind
    db.commit()
    if moving:
        move(db, [s], target)
    elif renamed and s.event_id is not None:
        _refresh(db, {s.event_id})  # a session's name is part of its event's report
    return session_row(s)


# ---------- moving ----------

def move(db: Session, sessions: list[models.RunSession], target: models.Event | None) -> None:
    """Put the sessions in the target event (None: in no event), then start on the reports of every event the move
    touched, so none of them still shows the sessions it lost."""
    target_id = target.id if target is not None else None
    touched = {s.event_id for s in sessions if s.event_id != target_id} | {target_id}
    for s in sessions:
        s.event_id = target_id
    db.flush()
    if target is not None and target.track is None:
        _settle_track(db, target)
    db.commit()
    _refresh(db, {e for e in touched if e is not None})


def _settle_track(db: Session, ev: models.Event) -> None:
    """An event without a track takes the one all its logs were driven at."""
    files = db.scalars(select(models.LoggerFile).join(models.RunSession)
                       .where(models.RunSession.event_id == ev.id)).all()
    venues = {(f.meta.get("venue") or "")[:120] for f in files}
    if len(venues) == 1 and (venue := venues.pop()):
        ev.track = db.scalar(select(models.Track).where(models.Track.name == venue))


def _refresh(db: Session, event_ids: set[int]) -> None:
    """The event caches are keyed by the sessions they hold: ask for each report (it starts again when its sessions
    changed), and for each technique check that has been worked out before."""
    for eid in sorted(event_ids):
        if db.get(models.Event, eid) is None:
            continue
        try:
            reports.report_for(db, "event", eid)
            if db.scalar(select(models.TechniqueCache.id).where(models.TechniqueCache.scope == f"event:{eid}")):
                technique._state(db, "event", eid)
        except Exception:  # the move is done; the caches are still worked out again when next opened
            log.exception("Couldn't start the caches of event %s again", eid)


def _text(value: str, what: str) -> str:
    value = value.strip()
    if not value:
        raise HTTPException(422, f"Give the {what} a name")
    return value


def _check_dates(start: date | None, end: date | None) -> None:
    if start is not None and end is not None and end < start:
        raise HTTPException(422, "The last day is before the first day")


# ---------- side by side ----------

def _parse_ids(text: str) -> list[int]:
    try:
        ids = list(dict.fromkeys(int(x) for x in text.split(",") if x.strip()))
    except ValueError:
        raise HTTPException(422, "sessions: give session ids separated by commas, e.g. 3,12") from None
    if not 2 <= len(ids) <= MAX_COMPARED:
        raise HTTPException(422, f"Pick 2 to {MAX_COMPARED} sessions to compare")
    return ids


def _traces_state(db: Session, s: models.RunSession) -> tuple[str, models.SessionTraces | None, models.Track | None]:
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


@router.get("/events/{key}/compare")
def compare_sessions(key: str, sessions: str = Query(..., description="session ids, e.g. 3,12"),
                     db: Session = Depends(get_db)):
    """Two to six sessions of one folder side by side: best and typical lap, consistency, the best time in each
    section (official corner numbers, as in the report) and the lap they add up to, top speed, and the tyre and
    condition medians of their clean laps. From the report's compact lap traces only; while some are still being
    made the answer has status "working" and its progress, with the lap times already known."""
    ev = _key_event(db, key)
    ids = _parse_ids(sessions)
    rows = {s.id: s for s in db.scalars(select(models.RunSession).options(
        selectinload(models.RunSession.laps), selectinload(models.RunSession.files),
        selectinload(models.RunSession.driver)).where(models.RunSession.id.in_(ids))).all()}
    event_id = ev.id if ev else None
    for i in ids:
        if i not in rows or rows[i].event_id != event_id:
            raise HTTPException(404, f"Session {i} isn't in this {'event' if ev else 'folder'}")
    picked = [rows[i] for i in ids]
    states = {s.id: _traces_state(db, s) for s in picked}
    tracks = {t.id if t else None for st, _, t in states.values() if st != "no laps"}
    if len(tracks) > 1:
        raise HTTPException(422, "These sessions were driven at different tracks; compare sessions from one track")
    track = next((t for _, _, t in states.values() if t is not None), None)

    progress = None
    if any(st == "working" for st, _, _ in states.values()):
        answer = None  # get the report's work going: it makes every session's traces, one log at a time
        for s in picked:
            if states[s.id][0] == "working":
                answer = reports.report_for(db, "event", event_id) if ev else reports.report_for(db, "session", s.id)
                if ev:
                    break
        progress = (answer or {}).get("progress")

    ready = {sid: rec for sid, (st, rec, _) in states.items() if st == "ready"}
    ref_id, ref_rec = _reference(db, ev, picked, ready, track)
    corners = official_corners(track)
    cache_key = (key, tuple((sid, ready[sid].signature) for sid in ids if sid in ready),
                 (ref_id, ref_rec.signature if ref_rec else None), tuple(corners or ()))
    with _cache_lock:
        hit = _cache.get(cache_key)
        if hit is not None:
            _cache.move_to_end(cache_key)
    if hit is None:
        hit = _side_by_side(ids, ready, ref_id, ref_rec, corners)
        with _cache_lock:
            _cache[cache_key] = hit
            while len(_cache) > CACHE_SIZE:
                _cache.popitem(last=False)
    working = any(st == "working" for st, _, _ in states.values())
    notes = {"working": "Its laps are being read for the report; the sections follow when that is done.",
             "failed": "Its log couldn't be read into lap traces; see its report.",
             "no laps": "No clean lap to compare."}
    out_sessions = []
    for s in picked:
        st = states[s.id][0]
        summary = hit["by_session"].get(s.id)
        if st == "ready" and summary is None:
            st = "failed"
        row = session_row(s)
        out_sessions.append({**row, "state": st, "note": notes.get(st), **(summary or {
            "ideal_s": None, "top_speed_kmh": None, "tyres": {}, "tyre_units": {}, "conditions": []})})
    return {"status": "working" if working else "ready", "progress": progress if working else None,
            "track": track.name if track else None, "numbering": hit["numbering"], "length_m": hit["length_m"],
            "reference": hit["reference"], "sessions": out_sessions, "sections": hit["sections"]}


def _reference(db: Session, ev: models.Event | None, picked: list[models.RunSession],
               ready: dict[int, models.SessionTraces], track: models.Track | None
               ) -> tuple[int | None, models.SessionTraces | None]:
    """The session whose quickest lap the sections are drawn on, as in the report: the event's quickest whose traces
    are made (so every comparison in an event uses the same sections), else the quickest of the sessions picked."""
    pool = picked
    if ev is not None:
        pool = _sessions(db, ev.id)
    best: tuple[float, int, models.SessionTraces] | None = None
    for s in pool:
        rec = ready.get(s.id)
        if rec is None and s not in picked:
            st, rec, t = _traces_state(db, s)
            if st != "ready" or (t.id if t else None) != (track.id if track else None):
                continue
        if rec is None:
            continue
        times = [l.time_s for l in _main_laps(s) if l.clean]
        if times and (best is None or min(times) < best[0]):
            best = (min(times), s.id, rec)
    return (best[1], best[2]) if best else (None, None)


def _side_by_side(ids: list[int], ready: dict[int, models.SessionTraces], ref_id: int | None,
                  ref_rec: models.SessionTraces | None, corners) -> dict:
    """The sections and each session's summary; one session's traces in memory at a time."""
    out = {"numbering": None, "length_m": None, "reference": None, "sections": [], "by_session": {}}
    if ref_rec is None:
        return out
    cs = _load(ref_rec)
    if cs is None or not cs.n_laps:
        return out
    ref: Reference = reference_of(ref_id, cs, corners)
    summaries = {}
    if ref_id in ready and ref_id in ids:
        summaries[ref_id] = summarise(ref_id, cs, ref)
    del cs
    for sid in ids:
        if sid in summaries or sid not in ready:
            continue
        other = _load(ready[sid])
        if other is not None:
            summaries[sid] = summarise(sid, other, ref)
        del other
    sections = []
    for k, sec in enumerate(ref.sections):
        times = [summaries[sid].sections[k] if sid in summaries else None for sid in ids]
        laps = [summaries[sid].section_laps[k] if sid in summaries else None for sid in ids]
        sections.append({"code": sec.code, "corners": sec.corners, "start_m": sec.start, "end_m": sec.end,
                         "apex_m": sec.apex, "times": times, "laps": laps, "best": best_index(times)})
    by_session = {}
    for sid, sm in summaries.items():
        known = [t for t in sm.sections if t is not None]
        by_session[sid] = {"ideal_s": round(sum(known), 3) if len(known) == len(sm.sections) and known else None,
                           "top_speed_kmh": sm.top_speed, "tyres": sm.tyres, "tyre_units": sm.tyre_units,
                           "conditions": sm.conditions}
    return {"numbering": ref.numbering, "length_m": ref.length,
            "reference": {"session_id": ref.session_id, "lap": ref.lap, "time": ref.time},
            "sections": sections, "by_session": by_session}
