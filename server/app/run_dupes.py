"""The same run uploaded twice in one event ("20260919-2658003.ld" and its copy "20260919-2658003 2.ld", or one zip
uploaded again) is kept once.

Two runs are the same when their logs started at the same time of day and they have the same laps, every lap time
equal to the logger's precision; anything different keeps both. The run kept is the one with what was set by hand (a
typed name, a driver, debriefs, a setup, lap tags), else the older one; whatever the copy had of those that the kept
run hasn't goes over to it. The copy then goes as a run deleted from the event's page does (run_delete.py): with its
logs, stored files and everything kept for it.

On every upload (routers/imports.py, once it is done) and for every event on server start and daily (before its runs
are named from the timetable: results/sync.py).
"""
from __future__ import annotations

import logging
import os

from sqlalchemy import select
from sqlalchemy.orm import Session

from app import laptags, models
from app.results import models as rm
from app.results.run_names import run_window
from app.setup import models as setup_models

log = logging.getLogger(__name__)

def enabled() -> bool:
    """RUN_DUPES=off leaves copies alone (the tests do, except their own: they upload one sample log many times)."""
    return os.environ.get("RUN_DUPES", "on").strip().lower() not in ("off", "0", "false", "no")


PRECISION_S = 0.0015  # lap times this close are the same lap (the logger's millisecond)


def _same(a: models.RunSession, b: models.RunSession) -> bool:
    wa, wb = run_window(a), run_window(b)
    if wa is None or wb is None or wa[0] != wb[0] or not a.laps or len(a.laps) != len(b.laps):
        return False
    return all(abs(x.time_s - y.time_s) <= PRECISION_S for x, y in zip(a.laps, b.laps, strict=True))


def _weight(db: Session, s: models.RunSession) -> tuple:
    """What was set by hand on a run: the one with more of it is kept."""
    mark = db.scalar(select(rm.RunNameMark).where(rm.RunNameMark.session_id == s.id))
    debriefs = db.scalar(select(models.Debrief.id).where(models.Debrief.session_id == s.id).limit(1))
    setup = db.scalar(select(setup_models.SessionSetup.id).where(setup_models.SessionSetup.session_id == s.id))
    tags = db.scalar(select(laptags.LapTag.id).where(laptags.LapTag.session_id == s.id).limit(1))
    return (bool(mark and mark.by_hand), s.driver_id is not None, debriefs is not None, setup is not None,
            tags is not None)


def _move(db: Session, copy: models.RunSession, keep: models.RunSession) -> None:
    """What the copy had set by hand and the kept run hasn't goes over to it."""
    if keep.driver_id is None and copy.driver_id is not None:
        keep.driver_id = copy.driver_id
    marks = {m.session_id: m for m in db.scalars(select(rm.RunNameMark)
                                                .where(rm.RunNameMark.session_id.in_([copy.id, keep.id])))}
    if marks.get(copy.id) and marks[copy.id].by_hand and not (marks.get(keep.id) and marks[keep.id].by_hand):
        keep.name = copy.name
        if marks.get(keep.id) is None:
            db.add(rm.RunNameMark(session_id=keep.id, by_hand=True))
        else:
            marks[keep.id].by_hand = True
    for d in db.scalars(select(models.Debrief).where(models.Debrief.session_id == copy.id)):
        d.session_id = keep.id
    if db.scalar(select(setup_models.SessionSetup.id).where(setup_models.SessionSetup.session_id == keep.id)) is None:
        for st in db.scalars(select(setup_models.SessionSetup).where(setup_models.SessionSetup.session_id == copy.id)):
            st.session_id = keep.id
    # lap tags are by log and lap: onto the kept run's log of the same start
    files = {(f.meta or {}).get("time"): f.id for f in keep.files}
    had = {(t.file_id, t.lap) for t in db.scalars(select(laptags.LapTag).where(laptags.LapTag.session_id == keep.id))}
    for t in db.scalars(select(laptags.LapTag).where(laptags.LapTag.session_id == copy.id)):
        src = next((f for f in copy.files if f.id == t.file_id), None)
        target = files.get((src.meta or {}).get("time")) if src is not None else None
        if target is not None and (target, t.lap) not in had:
            t.session_id, t.file_id = keep.id, target
            had.add((target, t.lap))
    db.commit()


def merge_event(db: Session, event_id: int) -> list[int]:
    """Keep each run of the event once; returns the ids of the copies removed."""
    from app import run_delete  # here: it imports the routers

    if not enabled():
        return []
    runs = db.scalars(select(models.RunSession).where(models.RunSession.event_id == event_id)
                      .order_by(models.RunSession.id)).all()
    copies: list[int] = []
    left = list(runs)
    while left:
        first = left.pop(0)
        same = [first, *(r for r in left if _same(first, r))]
        if len(same) == 1:
            continue
        left = [r for r in left if r not in same]
        keep = max(same, key=lambda r: (_weight(db, r), -r.id))
        for copy in same:
            if copy is not keep:
                _move(db, copy, keep)
                copies.append(copy.id)
    if copies:
        run_delete.delete_runs(ids=",".join(map(str, copies)), db=db)
        log.warning("event %s: %s duplicate runs removed (%s)", event_id, len(copies), copies)
    return copies


def merge_runs(db: Session, session_ids: list[int]) -> list[int]:
    """After an upload: the events these runs went into, each run kept once; returns the copies removed."""
    events = set(db.scalars(select(models.RunSession.event_id).where(models.RunSession.id.in_(session_ids),
                                                                      models.RunSession.event_id.is_not(None))))
    gone: list[int] = []
    for e in sorted(events):
        try:
            gone += merge_event(db, e)
        except Exception:
            db.rollback()
            log.exception("merging the duplicate runs of event %s failed", e)
    return gone
