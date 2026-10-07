"""The same run uploaded twice in one event ("20260919-2658003.ld" and its copy "20260919-2658003 2.ld", or one zip
uploaded again) is kept once.

Two runs are the same when their logs started at the same time of day and they have the same laps, every lap time
equal to the logger's precision; a run is a piece of another when two or more of its laps, in a row and each to the
millisecond, are laps of the other's longer log (a log saved partway through a session). Anything else keeps both.
The run kept is the most complete one, then the one with what was set by hand (a typed name, a driver, debriefs, a
setup, lap tags), then the older; whatever the copy had of those that the kept run hasn't goes over to it. The copy
then goes as a run deleted from the event's page does (run_delete.py): with its logs, stored files and everything
kept for it.

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


def _part_of(a: models.RunSession, b: models.RunSession) -> bool:
    """Whether run a is the same run as b or a piece of it: a log saved partway through, whose laps (two or more,
    each to the millisecond) run on in b's longer log (Misano 2026: three paid-test logs of 7, 5 and 3 laps whose
    laps are all in the day's 30-lap log)."""
    if len(a.laps) > len(b.laps) or not a.laps:
        return False
    if len(a.laps) == len(b.laps) and _same(a, b):
        return True
    if len(a.laps) < 2:
        return False
    x, y = [lap.time_s for lap in a.laps], [lap.time_s for lap in b.laps]
    return any(all(abs(p - q) <= PRECISION_S for p, q in zip(x, y[i:i + len(x)], strict=True))
               for i in range(len(y) - len(x) + 1))


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
    # the most complete log first (then the one with what was set by hand, then the older): pieces go into it
    weights = {r.id: _weight(db, r) for r in runs}
    kept: list[models.RunSession] = []
    for r in sorted(runs, key=lambda r: (-len(r.laps), tuple(not w for w in weights[r.id]), r.id)):
        host = next((k for k in kept if _part_of(r, k)), None)
        if host is None:
            kept.append(r)
        else:
            _move(db, r, host)
            copies.append(r.id)
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
