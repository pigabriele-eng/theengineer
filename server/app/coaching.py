"""Coaching: the three things to change on the next run, and whether the run after did change them.

Both read the technique check (routers/technique.py), which finds every clean lap's obvious mistakes, each with the
time it cost, and keeps, per session, the ones that repeat (its habits): per corner and kind, in how many laps and
what they cost a lap on average. Never a comparison with a perfect lap.

GET /coaching/sessions/{id}/top: the run's three costliest repeated mistakes, each at a different corner, with what
to do instead and the time it is worth, over the laps picked (Gabriele, 2026-10-08: "let me quick pick which laps and
sessions i want to use for comparison"; ?laps=<session id>:<lap number>,...). By default each driver's best lap in
the event's latest session, compared with each other ("default to the best of each driver in the latest uploaded
session"). The answer lists what can be picked: the event's runs, each with its driver, tyres and clean laps.
GET /coaching/sessions/{id}/fixed: the previous run's three things checked on this run (by default the latest earlier
run at the same track by the same driver; ?previous=<id> picks another): what each costs now against before, the time
gained and a verdict (fixed, better, not yet).
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from app import models, run_labels, run_parts, run_tyres
from app.analysis.technique import HABITS, habits
from app.db import get_db
from app.routers import technique
from app.setup.sheet import run_time

router = APIRouter(prefix="/coaching")

TOP_N = 3
FIXED_SHARE = 0.3  # what it costs a lap now, against before, at or under which a mistake counts as fixed
BETTER_SHARE = 0.7  # ... and at or under which it counts as better


class _Run:
    """A session's technique check as far as coaching reads it."""

    def __init__(self, db: Session, s: models.RunSession, pick: set[tuple[int, int]] | None = None):
        self.session = s
        kind, id_ = technique._scope_of(s)
        plan, self.row, self.status = technique._state(db, kind, id_)
        self.head = technique._head(plan, self.row, self.status)
        self.res = res = self.row.result if self.row is not None else None
        every = res["laps"] if res else []
        # each run's driver as set now (the check keeps what its logs said when it ran: a Change since isn't in it)
        ids = {x["session_id"] for x in every} | {s.id}
        self.driver_of = {r.id: r.driver.name if r.driver else None
                          for r in db.scalars(select(models.RunSession).where(models.RunSession.id.in_(ids)))}
        self.driver = self.driver_of.get(s.id)
        # by default the run's own laps (all on one set of tyres); picked: the driver's laps among those picked, from
        # any run of the check, and the other drivers' picked laps to compare with
        picked = [x for x in every if (x["session_id"], x["number"]) in pick] if pick is not None else []
        self.laps = ([x for x in picked if self.of(x) == self.driver] if pick is not None
                     else [x for x in every if x["session_id"] == s.id])
        self.others = [x for x in picked if self.of(x) != self.driver]
        self.picked = picked if pick is not None else self.laps
        # the obvious mistakes that repeat (on one lap: that lap's), each at the time it really cost (an obvious
        # mistake has no size of its own nor a cost against perfect driving, which habits() reads)
        self.habits = habits([[{"unit": None, "cost_perfect_s": 0.0, **m} for m in x.get("obvious") or []]
                              for x in self.laps]) if self.laps else []

    def of(self, lap: dict) -> str | None:
        """The lap's driver."""
        return self.driver_of.get(lap["session_id"])

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
        worst = max(((m["cost_s"], m, x) for x in self.laps for m in x.get("obvious") or [] if m["key"] == key),
                    key=lambda p: p[0], default=None)
        if worst is None:
            return {}
        _, m, lap = worst
        out = {"what": m.get("what"), "do": m.get("do"), "lap": lap["number"], "lap_session": lap["session_id"]}
        if m["kind"] not in HABITS and m.get("title"):  # a kind with no habit name of its own: the mistake's title
            out["title"] = m["title"]
        return out


def _labelled(db: Session, ids: list[int]) -> tuple[list[models.RunSession], list[run_labels.RunLabel]]:
    runs = list(db.scalars(select(models.RunSession).where(models.RunSession.id.in_(ids))))
    return runs, run_labels.label_runs(runs)


def choices(db: Session, run: _Run) -> list[dict]:
    """What can be picked: the runs of the run's check (its event's), every driver's, in the order they ran, each
    with its driver, tyres and clean laps."""
    if not run.res:
        return []
    laps = run.res["laps"]
    order = list(dict.fromkeys(x["session_id"] for x in laps))
    # each called as the event page calls it ("FP1 stint 2"), in the order they ran
    runs, ordered = _labelled(db, order)
    labels = run_labels.labels_for(db, runs)
    names = {r.id: labels[r.id].name if r.id in labels else r.name or f"Session {r.id}" for r in runs}
    at = {lab.id: i for i, lab in enumerate(ordered)}
    order.sort(key=lambda sid: at.get(sid, len(at)))
    tyres = run.res.get("run_tyres") or {}
    out = []
    for sid in order:
        t = tyres.get(str(sid)) or {}
        mine = [x for x in laps if x["session_id"] == sid]
        out.append({"id": sid, "name": names.get(sid, f"Session {sid}"), "driver": run.of(mine[0]),
                    "tyres": t.get("tyres"), "tyres_label": run_tyres.LABEL.get(t.get("tyres")),
                    "tyres_sure": t.get("sure"), "laps": [{"number": x["number"], "time": x["time"]} for x in mine]})
    return out


def default_pick(db: Session, run: _Run) -> tuple[set[tuple[int, int]], str | None]:
    """The laps the three things open on (Gabriele, 2026-10-08: "default to the best of each driver in the latest
    uploaded session"): each driver's best lap in the event's latest official session (FP1, Q, R2...), compared
    with each other; the driver's best lap of this run too when they didn't drive in it. Never a lap against the
    best of the event: the tyres' mileage can be very different. With the session's title."""
    laps = (run.res or {}).get("laps") or []
    if not laps:
        return set(), None
    runs, labels = _labelled(db, list({x["session_id"] for x in laps}))
    found = run_parts.parts(runs, labels)
    last = found[-1] if found else None
    ids = set(last.ids) if last else {run.session.id}
    best: dict[object, dict] = {}
    for x in laps:
        d = run.of(x)
        if x["session_id"] in ids and (d not in best or x["time"] < best[d]["time"]):
            best[d] = x
    if run.driver not in best:
        own = [x for x in laps if x["session_id"] == run.session.id]
        if own:
            best[run.driver] = min(own, key=lambda x: x["time"])
    return {(x["session_id"], x["number"]) for x in best.values()}, last.title if last else None


def against(run: _Run, key: str) -> list[dict]:
    """What a mistake costs the other drivers on their picked laps: per driver, a lap on average."""
    out: dict[object, dict] = {}
    for x in run.others:
        d = run.of(x)
        o = out.setdefault(d, {"driver": d, "laps": 0, "cost_s": 0.0})
        o["laps"] += 1
        o["cost_s"] += sum(m["cost_s"] for m in x.get("obvious") or [] if m["key"] == key)
    return [{**o, "cost_s": round(o["cost_s"] / o["laps"], 3)} for o in out.values()]


def parse_laps(text: str | None) -> set[tuple[int, int]] | None:
    """?laps=12:3,12:4,13:1 -> {(12, 3), (12, 4), (13, 1)}; nothing given: None (the automatic choice)."""
    if not text:
        return None
    try:
        return {(int(a), int(b)) for a, b in (p.split(":") for p in text.split(",") if p)}
    except ValueError:
        raise HTTPException(422, "laps: <session id>:<lap number>, comma separated") from None


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
                    "gain_s": h["cost_per_lap_s"], "value": h.get("value"), "unit": h.get("unit"),
                    **run.advice(h["key"])})
        if len(out) == n:
            break
    return out


@router.get("/sessions/{session_id}/top")
def session_top(session_id: int, laps: str | None = None, db: Session = Depends(get_db)):
    """The three things for the next run: the run's costliest repeated mistakes, each at a different corner, with
    what to do instead and what it is worth a lap. Over the laps picked (?laps=<session id>:<lap number>,...; by
    default each driver's best lap in the event's latest session): the driver's own picked laps give the three
    things, the other drivers' give what each costs them ("others"). "choices" lists the laps that can be picked,
    "picked" the laps used."""
    run = _Run(db, _session(db, session_id))
    pick, title = parse_laps(laps), None
    automatic = pick is None
    if automatic and run.ready:
        pick, title = default_pick(db, run)
    if pick is not None:
        run = _Run(db, run.session, pick)
    things = [{**t, "others": against(run, t["key"])} for t in top_things(run)] if run.ready else []
    return {**run.head, "session": run.out(), "things": things,
            "gain_s": round(sum(t["gain_s"] for t in things), 3), "driver": run.driver,
            "choices": choices(db, run), "picked": [[x["session_id"], x["number"]] for x in run.picked],
            "automatic": automatic, "default_title": title}


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
        for m in x.get("obvious") or []:
            once[m["key"]] = once.get(m["key"], 0.0) + m["cost_s"]
    n = max(len(after.laps), 1)
    out = []
    for t in top_things(before):
        h = now.get(t["key"])
        cost = h["cost_per_lap_s"] if h else round(once.get(t["key"], 0.0) / n, 3)
        laps = h["laps"] if h else sum(1 for x in after.laps
                                       if any(m["key"] == t["key"] for m in x.get("obvious") or []))
        out.append({**{k: t.get(k) for k in ("rank", "key", "code", "kind", "phase", "title", "do")},
                    "before": {"cost_s": t["gain_s"], "laps": t["laps"], "of": t["of"], "value": t["value"]},
                    "after": {"cost_s": cost, "laps": laps, "of": len(after.laps),
                              "value": h.get("value") if h else None},
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
