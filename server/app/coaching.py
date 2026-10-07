"""Coaching: the three things to change on the next run, and whether the run after did change them.

Both read the technique check (routers/technique.py), which costs every mistake of every clean lap against perfect
driving and keeps, per session, the mistakes that repeat (its habits): per corner and kind, in how many laps and what
they cost a lap on average.

GET /coaching/sessions/{id}/top: the run's three costliest repeated mistakes, each at a different corner, with what
to do instead and the time it is worth. GET /coaching/sessions/{id}/fixed: the previous run's three things checked on
this run (by default the latest earlier run at the same track by the same driver; ?previous=<id> picks another): what
each costs now against before, the time gained and a verdict (fixed, better, not yet).
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from app import models
from app.db import get_db
from app.routers import technique
from app.setup.sheet import run_time

router = APIRouter(prefix="/coaching")

TOP_N = 3
FIXED_SHARE = 0.3  # what it costs a lap now, against before, at or under which a mistake counts as fixed
BETTER_SHARE = 0.7  # ... and at or under which it counts as better


class _Run:
    """A session's technique check as far as coaching reads it."""

    def __init__(self, db: Session, s: models.RunSession):
        self.session = s
        kind, id_ = technique._scope_of(s)
        plan, self.row, self.status = technique._state(db, kind, id_)
        self.head = technique._head(plan, self.row, self.status)
        res = self.row.result if self.row is not None else None
        self.laps = [x for x in res["laps"] if x["session_id"] == s.id] if res else []
        self.habits = res["habits"]["sessions"].get(str(s.id), []) if res else []

    @property
    def ready(self) -> bool:
        return self.row is not None and self.row.result is not None

    def out(self) -> dict:
        s = self.session
        best = min((x["time"] for x in self.laps), default=None)
        return {"id": s.id, "name": s.name or f"Session {s.id}", "driver": s.driver.name if s.driver else None,
                "laps": len(self.laps), "best": best}

    def advice(self, key: str) -> dict:
        """What the mistake is and what to do instead, from the lap where it cost the most."""
        worst = max(((m["cost_s"], x) for x in self.laps for m in x["mistakes"] if m["key"] == key),
                    key=lambda p: p[0], default=None)
        if worst is None or self.row is None:
            return {}
        detail = technique._detail(self.row, worst[1]["detail"]) or {}
        m = next((m for m in detail.get("mistakes", []) if m["key"] == key), None)
        return {"what": m.get("what"), "do": m.get("do"), "lap": worst[1]["number"]} if m else {}


def _session(db: Session, session_id: int) -> models.RunSession:
    s = db.get(models.RunSession, session_id)
    if s is None:
        raise HTTPException(404, "Session not found")
    return s


def top_things(run: _Run, n: int = TOP_N) -> list[dict]:
    """The run's costliest repeated mistakes, one per corner, most costly first."""
    out, corners = [], set()
    for h in run.habits:  # most costly per lap first
        if h["code"] in corners or h["cost_per_lap_s"] <= 0:
            continue
        corners.add(h["code"])
        out.append({"rank": len(out) + 1, "key": h["key"], "code": h["code"], "kind": h["kind"],
                    "phase": h["phase"], "title": h["title"], "laps": h["laps"], "of": h["of"],
                    "gain_s": h["cost_per_lap_s"], "value": h["value"], "unit": h["unit"], **run.advice(h["key"])})
        if len(out) == n:
            break
    return out


@router.get("/sessions/{session_id}/top")
def session_top(session_id: int, db: Session = Depends(get_db)):
    """The three things for the next run: the run's costliest repeated mistakes, each at a different corner, with
    what to do instead and what it is worth a lap (on average over the run's clean laps)."""
    run = _Run(db, _session(db, session_id))
    things = top_things(run) if run.ready else []
    return {**run.head, "session": run.out(), "things": things,
            "gain_s": round(sum(t["gain_s"] for t in things), 3)}


def _track_key(s: models.RunSession) -> object:
    if s.event is not None and s.event.track_id is not None:
        return s.event.track_id
    f = max(s.files, key=lambda f: f.meta.get("duration_s", 0)) if s.files else None
    return ((f.meta.get("venue") or "").strip().lower() or None) if f is not None else None


def previous_run(db: Session, s: models.RunSession) -> models.RunSession | None:
    """The latest run before this one at the same track, by the same driver when the run has one: its own event's
    runs first, then any."""
    track = _track_key(s)
    if track is None:
        return None
    when = (run_time(s), s.id)
    rows = db.scalars(select(models.RunSession).where(models.RunSession.id != s.id)).all()
    same = [r for r in rows if _track_key(r) == track and (s.driver_id is None or r.driver_id == s.driver_id)
            and any(l.clean for l in r.laps) and (run_time(r), r.id) < when]
    if not same:
        return None
    here = [r for r in same if s.event_id is not None and r.event_id == s.event_id]
    return max(here or same, key=lambda r: (run_time(r), r.id))


def verdict(before_s: float, now_s: float) -> str:
    if now_s <= before_s * FIXED_SHARE:
        return "fixed"
    if now_s <= before_s * BETTER_SHARE:
        return "better"
    return "not yet"


def fixed_things(before: _Run, after: _Run) -> list[dict]:
    """The previous run's three things, each as it costs on this run."""
    now = {h["key"]: h for h in after.habits}
    # a mistake on a single lap of this run doesn't make a habit: it still counts against the fix
    once: dict[str, float] = {}
    for x in after.laps:
        for m in x["mistakes"]:
            once[m["key"]] = once.get(m["key"], 0.0) + m["cost_s"]
    n = max(len(after.laps), 1)
    out = []
    for t in top_things(before):
        h = now.get(t["key"])
        cost = h["cost_per_lap_s"] if h else round(once.get(t["key"], 0.0) / n, 3)
        laps = h["laps"] if h else sum(1 for x in after.laps if any(m["key"] == t["key"] for m in x["mistakes"]))
        out.append({**{k: t[k] for k in ("rank", "key", "code", "kind", "phase", "title", "do")},
                    "before": {"cost_s": t["gain_s"], "laps": t["laps"], "of": t["of"], "value": t["value"]},
                    "after": {"cost_s": cost, "laps": laps, "of": len(after.laps), "value": h["value"] if h else None},
                    "gained_s": round(t["gain_s"] - cost, 3), "verdict": verdict(t["gain_s"], cost),
                    "unit": t["unit"]})
    return out


@router.get("/sessions/{session_id}/fixed")
def session_fixed(session_id: int, previous: int | None = None, db: Session = Depends(get_db)):
    """Did we fix it: the previous run's three things checked on this run. ?previous=<session id> picks the run to
    compare with; by default the latest earlier run at the same track by the same driver."""
    s = _session(db, session_id)
    p = _session(db, previous) if previous is not None else previous_run(db, s)
    after = _Run(db, s)
    out = {**after.head, "session": after.out(), "previous": None, "things": [], "gained_s": None}
    if p is None:
        out["note"] = "No earlier run at this track to compare with."
        return out
    before = _Run(db, p)
    out["previous"] = before.out()
    if not before.ready or not after.ready:
        out["status"] = after.status if not after.ready else before.status
        return out
    things = fixed_things(before, after)
    out["things"] = things
    out["gained_s"] = round(sum(t["gained_s"] for t in things), 3)
    return out
