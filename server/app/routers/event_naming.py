"""Naming the events an upload made, and joining one to the race weekend it belongs to.

A zip makes an event named after the zip (routers/imports.py), so a race weekend uploaded as three zips (03_Q, 04_R1,
05_R2) lands as three events. GET /imports/{id}/events lists the events an import made, each with a name taken from
its logs' headers (the championship's event name and the venue, e.g. "GT4_ES_R05 Zandvoort"; else the zip's name),
the days its logs were recorded, and the events already there that look like the same weekend: the same venue and
header event name, or the same venue on overlapping or back-to-back days. POST /events/{id}/merge puts every session
of an event into another one and removes the event left empty. Renaming is PATCH /events/{id} (routers/events.py).
Neither reads a log.
"""
from __future__ import annotations

from collections import Counter
from datetime import date, timedelta

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import delete, select
from sqlalchemy.orm import Session, selectinload

from app import models
from app.db import get_db
from app.routers import events

router = APIRouter()

MAX_MATCHES = 3
SLACK = timedelta(days=1)  # a Saturday zip and a Sunday zip are the same weekend
NAME_MAX = 160  # events.name


class MergeIn(BaseModel):
    into: int


def suggest(log_event: str | None, venue: str | None, fallback: str) -> str:
    """The header's event name and the venue ("GT4_ES_R05 Zandvoort"; the venue once when the event name holds it),
    else the fallback (the zip's name)."""
    if not log_event:
        return fallback[:NAME_MAX]
    if venue and venue.lower() not in log_event.lower():
        return f"{log_event} {venue}"[:NAME_MAX]
    return log_event[:NAME_MAX]


def _text(value) -> str:
    return value.strip() if isinstance(value, str) else ""


def _common(values: list[str]) -> str | None:
    """The value most logs give, blank ones left out (a tie goes to the first seen)."""
    counts = Counter(v for v in values if v)
    return counts.most_common(1)[0][0] if counts else None


def _facts(ev: models.Event, sessions: list[models.RunSession], dates: models.EventDates | None) -> dict:
    """An event as a folder (its name, dates, track, sessions, best lap) with the venue and header event name its
    logs give."""
    files = [f for s in sessions for f in s.files]
    venues = [_text(f.meta.get("venue")) for f in files]
    names = [_text(f.meta.get("event")) for f in files]
    track = ev.track.name if ev.track is not None else None
    return {"folder": events._folder(ev, sessions, dates), "venue": _common(venues) or track,
            "venues": {v.lower() for v in [*venues, track or ""] if v}, "log_event": _common(names),
            "log_events": {n.lower() for n in names if n}, "session_ids": {s.id for s in sessions}}


def _span(folder: dict) -> tuple[date, date] | None:
    if not folder["start"]:
        return None
    return date.fromisoformat(folder["start"]), date.fromisoformat(folder["end"] or folder["start"])


def _why(new: dict, other: dict) -> str | None:
    """Why the other event looks like the same weekend: "event" (same venue and header event name), "dates" (same
    venue, overlapping or back-to-back days), or None."""
    if not new["venue"] or new["venue"].lower() not in other["venues"]:
        return None
    if new["log_event"] and new["log_event"].lower() in other["log_events"]:
        return "event"
    a, b = _span(new["folder"]), _span(other["folder"])
    if a and b and a[0] <= b[1] + SLACK and b[0] <= a[1] + SLACK:
        return "dates"
    return None


def _summary(folder: dict) -> dict:
    keep = ("id", "key", "name", "track", "start", "end", "dates_by_hand", "sessions", "clean_laps", "best_lap_s")
    return {k: folder[k] for k in keep}


@router.get("/imports/{job_id}/events")
def new_events(job_id: int, db: Session = Depends(get_db)):
    """The events this import made (one per zip, in upload order) that are still there, each with a suggested name
    from its logs, the days they were recorded and up to three events that look like the same race weekend (the
    same header event name first)."""
    job = db.get(models.ImportJob, job_id)
    if job is None:
        raise HTTPException(404, "Import not found")
    made = db.scalars(select(models.ImportEvent).where(models.ImportEvent.job_id == job_id)
                      .order_by(models.ImportEvent.id)).all()
    if not made:
        return {"job_id": job_id, "status": job.status, "events": []}
    sessions = db.scalars(select(models.RunSession).options(
        selectinload(models.RunSession.laps), selectinload(models.RunSession.files),
        selectinload(models.RunSession.driver))).all()
    by_event: dict[int | None, list[models.RunSession]] = {}
    for s in sessions:
        by_event.setdefault(s.event_id, []).append(s)
    dates = {d.event_id: d for d in db.scalars(select(models.EventDates)).all()}
    facts = {ev.id: _facts(ev, by_event.get(ev.id, []), dates.get(ev.id))
             for ev in db.scalars(select(models.Event).options(selectinload(models.Event.track))).all()}
    imported = set(job.session_ids or [])
    out, seen = [], set()
    for row in made:
        new = facts.get(row.event_id)
        # gone (merged or deleted), or an id the database handed out again to an event this import didn't make
        if new is None or row.event_id in seen or not new["session_ids"] & imported:
            continue
        seen.add(row.event_id)
        start = _span(new["folder"])
        matches = []
        for eid, other in facts.items():
            why = None if eid == row.event_id else _why(new, other)
            if why is None:
                continue
            gap = abs((_span(other["folder"])[0] - start[0]).days) if start and _span(other["folder"]) else 9999
            matches.append(((why != "event", gap, -eid), {**_summary(other["folder"]), "why": why}))
        matches.sort(key=lambda m: m[0])
        fallback = row.archive or new["folder"]["name"]
        out.append({**_summary(new["folder"]), "zip": row.archive, "venue": new["venue"],
                    "log_event": new["log_event"], "suggested_name": suggest(new["log_event"], new["venue"], fallback),
                    "matches": [m for _, m in matches[:MAX_MATCHES]]})
    return {"job_id": job_id, "status": job.status, "events": out}


@router.post("/events/{event_id}/merge")
def merge(event_id: int, body: MergeIn, db: Session = Depends(get_db)):
    """Put every session of this event into another event and remove this one, left empty. Dates set by hand on the
    other event widen to take in the days of the sessions it gains; its report is worked out again."""
    if body.into == event_id:
        raise HTTPException(422, "Pick another event to put the sessions into")
    events._event(db, event_id)
    target = events._event(db, body.into)
    moved = events._sessions(db, event_id)
    days = [d for s in moved if (d := events._when(s)[0])]
    for s in moved:
        s.event_id = target.id
    db.flush()
    if target.track is None:
        events._settle_track(db, target)
    row = events._dates_row(db, target.id)
    if row is not None and days and (row.start or row.end):
        row.start, row.end = min(row.start or row.end, *days), max(row.end or row.start, *days)
    if days:
        target.date = min(d for d in (target.date, *days, row.start if row else None) if d)
    db.execute(delete(models.ImportEvent).where(models.ImportEvent.event_id == event_id))
    events.delete_folder(event_id, db)  # empty now: removes its dates and caches, and commits
    events._refresh(db, {target.id})
    return {"merged": event_id, "moved": [s.id for s in moved], "into": events.folder(str(target.id), db)}
