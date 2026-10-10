"""The runs a debrief talks about. A driver often debriefs once, at the end of a session run in several stints
("FP1 stint 1", "FP1 stint 2", "FP1 stint 3"): the debrief joins the last stint, but it covers all of them. When the
setup changed between stints, the stints before and after the change are checked against the data apart
(routers/insights.py debrief_check), so a point gets a verdict for each setup.

Worked out unless the user set them (DebriefRun rows): the debrief's run and the earlier runs of the same event with
the same session name before "stint"/"run", that ended before it and are no other debrief's run. A new setup group
starts where the setup sheet differs from the run before (setup/models.py SessionSetup).
"""
from __future__ import annotations

import re

from sqlalchemy import select
from sqlalchemy.orm import Session

from app import models
from app.debrief.inbox import run_end
from app.setup import models as setup_models  # looked up when used: the tests reload the models

STINT = re.compile(r"^(.*?)\s+(?:stint|run|part)\b.*$", re.IGNORECASE)
MOST = 4  # runs one check reads (the server reads their logs together)


def session_of(name: str | None) -> str | None:
    """'FP1 stint 3' -> 'FP1'; None for a name with no stint in it."""
    m = STINT.match((name or "").strip())
    return m.group(1).strip().lower() if m else None


def end_of(s: models.RunSession):
    ends = [run_end(f.meta or {}) for f in s.files]
    ends = [e for e in ends if e is not None]
    return max(ends) if ends else None


def worked_out(db: Session, d: models.Debrief) -> list[tuple[models.RunSession, int]]:
    s = d.session
    base = session_of(s.name)
    if s.event_id is None or base is None:
        return [(s, 0)]
    others = set(db.scalars(select(models.Debrief.session_id).where(models.Debrief.id != d.id)))
    mine = end_of(s)
    runs = []
    for r in db.scalars(select(models.RunSession).where(models.RunSession.event_id == s.event_id)):
        if r.id != s.id and (session_of(r.name) != base or r.id in others):
            continue
        end = end_of(r)
        if r.id != s.id and mine is not None and (end is None or end > mine):
            continue
        runs.append((end, r.id, r))
    runs.sort(key=lambda x: (x[0] is None, x[0] or 0, x[1]))
    picked = [r for _, _, r in runs][-MOST:]
    sheets = {x.session_id: x.values or {} for x in db.scalars(
        select(setup_models.SessionSetup).where(setup_models.SessionSetup.session_id.in_([r.id for r in picked])))}
    out, group, before = [], 0, None
    for r in picked:
        now = sheets.get(r.id)
        if before is not None and now is not None and now != before:
            group += 1
        before = now if now is not None else before
        out.append((r, group))
    return out


def covers(db: Session, d: models.Debrief) -> tuple[list[tuple[models.RunSession, int]], bool]:
    """The runs the debrief covers with their setup group, in order, and whether the user set them."""
    rows = db.scalars(select(models.DebriefRun).where(models.DebriefRun.debrief_id == d.id)).all()
    if not rows:
        return worked_out(db, d), False
    runs = [(db.get(models.RunSession, x.session_id), x.group) for x in rows]
    runs = [(r, g) for r, g in runs if r is not None]
    runs.sort(key=lambda x: (end_of(x[0]) is None, end_of(x[0]) or 0, x[0].id))
    return runs or [(d.session, 0)], True


def describe(db: Session, d: models.Debrief) -> dict:
    runs, set_by_user = covers(db, d)
    return {"runs": [{"session_id": r.id, "name": r.name or f"Session {r.id}", "group": g} for r, g in runs],
            "set_by_user": set_by_user}
