"""Deleting chosen runs, to free storage: the runs ticked on an event's page (or among the runs in no event) go with
their logs and everything worked out or entered for them, exactly as an event's runs go (app/event_delete.py), and the
event stays: its name, dates, info, season links and plans, and its other runs untouched.

GET /runs/size?ids=3,12 says first what it would remove (runs, laps, logs, stored files and their bytes); DELETE
/runs?ids=3,12 deletes them. Both reuse event_delete's search, starting from the runs: their laps, logs, debriefs,
tyre data, setup sheets, lap traces, technique details and the kept pages of each run ("session:12|analysis", ...)
go, with the stored files after the commit, under the heavy-work lock (and swept again when analysis jobs were busy).
A cached result of something that stays that names a run that goes (the event's report, its technique check, a prep
report drawing on it) is emptied, so it is worked out again. The event's own kept pages (map, shape, track grip, ...)
are signed with the runs they were made from, so they no longer match; the prebuild (app/prebuild.py) is queued for
the runs the events keep, so their report and pages are ready again before they are opened.

DELETE /events/{id}/runs deletes every run of an event and keeps the event, empty, for the right logs to be uploaded
into (Gabriele, 2026-10-09: "Give me the ability to delete all data but keep the event in the app"): its name, days,
track, info, season round, calendar entry, results link, plan and setup notes stay. What was worked out for the event
as a whole from its runs goes with them: its report, kept pages, technique check, track grip and driving-style print
(the rows whose scope names it, "event:3|shape", "part:3:FP1", and style_prints), and the questions still open about
its runs or its season. Its prep report stays: it is made from the events before it. GET /events/{id}/size says
first what goes (the same runs, laps, logs and files).
"""
from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select
from sqlalchemy.orm import Session

from app import db as app_db  # looked up when used: the tests load a fresh one
from app import event_delete, models

router = APIRouter()
log = logging.getLogger(__name__)

MAX_RUNS = 500  # ids in one request
IDS = Query(..., description="run (session) ids, e.g. 3,12")
NONE = "none"  # the folder of the runs in no event (routers/events.py)
NOT_FROM_ITS_RUNS = {"prep_cache"}  # kept for an event but made from the events before it: stays when its runs go
PRINTS = "style_prints"  # an event's driving styles, worked out from its runs (driver_prints.py)
OPEN = ("pending", "waiting")  # a question not answered yet (season_match.py)


def _parse(text: str) -> list[int]:
    try:
        ids = list(dict.fromkeys(int(x) for x in text.split(",") if x.strip()))
    except ValueError:
        raise HTTPException(422, "ids: give run ids separated by commas, e.g. 3,12") from None
    if not ids or any(i <= 0 for i in ids):
        raise HTTPException(422, "ids: give run ids separated by commas, e.g. 3,12")
    if len(ids) > MAX_RUNS:
        raise HTTPException(422, f"Delete at most {MAX_RUNS} runs at once")
    return ids


def _runs(db: Session, ids: list[int]) -> list[tuple[int, str | None, int | None]]:
    """(id, name, event id) of each run, in the order asked; 404 for one that doesn't exist."""
    rows = {r.id: (r.id, r.name, r.event_id) for r in db.execute(
        select(models.RunSession.id, models.RunSession.name, models.RunSession.event_id)
        .where(models.RunSession.id.in_(ids)))}
    missing = [i for i in ids if i not in rows]
    if missing:
        raise HTTPException(404, f"Run {missing[0]} not found")
    return [rows[i] for i in ids]


def _name(runs: list[tuple[int, str | None, int | None]]) -> str:
    names = [name or f"run {i}" for i, name, _ in runs]  # a run made without a name has none
    return ", ".join(names[:6]) + (f" and {len(names) - 6} more" if len(names) > 6 else "")


@router.get("/runs/size")
def runs_size(ids: str = IDS, db: Session = Depends(app_db.get_db)):
    """What deleting these runs would remove, as GET /events/{id}/size says it for an event."""
    runs = _runs(db, _parse(ids))
    f = event_delete.find(db, {"run_sessions": {i for i, _, _ in runs}}, reset=False)
    return {"session_ids": [i for i, _, _ in runs], "name": _name(runs),
            **event_delete.counts(f, event_delete._sizes(f.keys))}


@router.delete("/runs")
def delete_runs(ids: str = IDS, db: Session = Depends(app_db.get_db)):
    """Delete these runs with their logs and everything kept for them; their events stay, with their other runs."""
    wanted = _parse(ids)
    runs = _runs(db, wanted)
    event_delete._not_importing(db)
    events: set[int | None] = set()

    def start() -> dict[str, set[int]]:
        now = _runs(db, wanted)  # again, under the locks: a run deleted or moved meanwhile
        events.update(e for _, _, e in now)
        return {"run_sessions": {i for i, _, _ in now}}

    folder = str(runs[0][2]) if runs[0][2] is not None else NONE
    out = event_delete._delete(db, start, _name(runs), folder)
    for e in events:  # the side by side answers kept for each folder the runs were in
        event_delete._forget(str(e) if e is not None else NONE, set(), [])
    kept = sorted(e for e in events if e is not None)
    _rebuild(db, kept)
    return {"deleted": wanted, "events": kept, **out}


def _rebuild(db: Session, event_ids: list[int]) -> None:
    """Queue the prebuild of the runs these events keep: their report, maps, shape, track grip, technique check and
    the prep reports drawing on them are worked out again for them (each piece still up to date takes milliseconds)."""
    from app import prebuild  # here: it imports the routers

    if not event_ids:
        return
    db.expire_all()
    left = list(db.scalars(select(models.RunSession.id).where(models.RunSession.event_id.in_(event_ids))
                           .order_by(models.RunSession.id)))
    if left:
        prebuild.after_upload(db, left)


def _emptied(db: Session, event_id: int) -> dict[str, set[int]]:
    """Every run of the event, and what was worked out for the event as a whole from them: the rows whose scope names
    it (its report, kept pages, technique check, track grip), its driving-style print and the questions still open
    about it (who drove its runs, which season it is: asked again if the next logs need it). Its season link and the
    questions answered stay."""
    from app.season_match import SeasonMatch  # here: it imports the routers

    start = {"run_sessions": set(db.scalars(select(models.RunSession.id).where(
        models.RunSession.event_id == event_id))),
        SeasonMatch.__tablename__: set(db.scalars(select(SeasonMatch.id).where(
            SeasonMatch.event_id == event_id, SeasonMatch.status.in_(OPEN))))}
    named = {"events": {event_id}}
    for t in event_delete._tables():
        pk = event_delete._pk(t)
        if pk is None or t.name in NOT_FROM_ITS_RUNS:
            continue
        if "scope" in t.c:
            ids = {i for i, scope in db.execute(select(pk, t.c.scope)) if event_delete.scope_named(scope, named)}
        elif t.name == PRINTS:
            ids = set(db.scalars(select(pk).where(t.c.event_id == event_id)))
        else:
            continue
        if ids:
            start[t.name] = ids
    return start


@router.delete("/events/{event_id}/runs")
def empty_event(event_id: int, db: Session = Depends(app_db.get_db)):
    """Delete every run of the event with their logs and everything kept for them; the event stays, empty."""
    name = event_delete._event_or_404(db, event_id).name
    event_delete._not_importing(db)

    def start() -> dict[str, set[int]]:
        event_delete._event_or_404(db, event_id)  # again, under the locks
        return _emptied(db, event_id)
    out = event_delete._delete(db, start, name, str(event_id))
    return {"event_id": event_id, "kept": True, **out}
