"""The setup log, kept by itself (Gabriele, 2026-10-08: "the tool should automatically ingest all data and keep track
of the changes and the effects").

When a run's logs come in (the prebuild's warm-up, after an upload), for a run uploaded in the last few days:
1. its setup sheet, if it has none, is carried over from the run before it at the same event: the setup is taken as
   unchanged unless someone says otherwise, so only what changed ever needs typing;
2. the changes the engineer said they are trying on the next run (the setup tool's "Trying it next run") go on that
   sheet: the new values where the sheet had one to step from, else a line in its notes;
3. the run's lap times and balance are worked out once (app.setup.results, one log under the heavy-work lock);
4. the setup tool's conversation for the event says what each change did against the run before: best lap,
   the three best laps and the balance in each phase, and asks whether it helped.
Older runs are left as they are: their sheets are what was logged, and their summaries are worked out when a page
asks.
"""
from __future__ import annotations

import logging
from datetime import UTC, datetime, timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session

from app import db as app_db
from app import models, prebuild
from app.setup import chat, results, sheet
from app.setup.models import SessionSetup, SetupChat

log = logging.getLogger(__name__)

RECENT_DAYS = 3  # a run created within this many days is new enough to carry a setup over to
BALANCE_STEP = 0.05  # a phase's balance moved when it changed by at least this much (the summary's units)
CARRIED = "Carried over from {run} automatically when its logs came in: change what was changed."


def _recent(s: models.RunSession, now: datetime | None = None) -> bool:
    made = s.created_at
    if made is None:
        return False
    if made.tzinfo is None:
        made = made.replace(tzinfo=UTC)
    return (now or datetime.now(UTC)) - made <= timedelta(days=RECENT_DAYS)


def chat_row(db: Session, event_id: int | None) -> SetupChat | None:
    return db.scalars(select(SetupChat).where(
        SetupChat.event_id.is_(None) if event_id is None else SetupChat.event_id == event_id)).first()


def carry_over(db: Session, s: models.RunSession) -> SessionSetup | None:
    """The run's sheet copied from the run before it at the same event, with the changes being tried put on it.
    None when it has a sheet already or there is nothing to copy."""
    if sheet.setup_of(db, s.id) is not None:
        return None
    prev = sheet.previous_setup(db, s)
    if prev is None or prev[0].event_id != s.event_id:
        return None
    before, st = prev
    values, notes = dict(st.values), [CARRIED.format(run=before.name or f"run {before.id}")]
    row = chat_row(db, s.event_id)
    state = {**chat.new_state(), **(row.state if row else {})}
    applied = []
    for p in state["pending"]:
        values.update(p.get("fields") or {})
        if not p.get("fields"):
            notes.append(f"Tried on this run: {', '.join(p.get('changes') or [p['title']])}.")
        applied.append({**p, "session_id": s.id, "run": s.name or f"Run {s.id}", "reported": False})
    own = SessionSetup(session_id=s.id, template=st.template, values=values, copied_from_session_id=before.id,
                       notes=" ".join(notes))
    db.add(own)
    if row is not None and applied:
        state["pending"] = []
        state["applied"] = [*state["applied"], *applied][-40:]
        chat._say(state, "tool", f"Logged on {applied[0]['run']} (the rest carried over from "
                                 f"{before.name or 'the run before'}): "
                                 + "; ".join(", ".join(a.get("changes") or [a["title"]]) for a in applied)
                                 + ". I'll say what it did once its laps are read.")
        row.state = state
    db.commit()
    return own


def _moved(balance: dict | None) -> list[str]:
    words = []
    for phase, name in (("entry", "entry"), ("mid", "mid-corner"), ("exit", "exit")):
        d = (balance or {}).get(phase)
        if d is not None and abs(d) >= BALANCE_STEP:
            words.append(f"{name} towards {'understeer' if d > 0 else 'oversteer'}")
    return words


def effect_text(applied: dict, row: dict) -> str:
    """'FP2 with front anti-roll bar softer, against FP1: best lap -0.21 s, three best -0.15 s; the balance moved
    mid-corner towards oversteer.'"""
    d = row.get("deltas") or {}
    base = (row.get("compared_with") or {}).get("name") or "the run before"
    parts = []
    for key, label in (("best_s", "best lap"), ("top3_s", "three best")):
        v = d.get(key)
        if v is not None:
            parts.append(f"{label} {'+' if v > 0 else chat.MINUS if v < 0 else '±'}{abs(v):.2f} s")
    moved = _moved(d.get("balance"))
    text = f"{applied['run']} with {chat._lc(applied['title'])}, against {base}: " + (
        ", ".join(parts) if parts else "no lap times to compare")
    text += f"; the balance moved {', '.join(moved)}." if moved else (
        "; the balance stayed about the same." if d.get("balance") else ".")
    return text + " Tyres, fuel and track change between runs too. Did it help?"


def report_effects(db: Session, s: models.RunSession) -> bool:
    """Say in the event's conversation what the changes tried on this run did, once its laps can be compared.
    True when something was said."""
    row = chat_row(db, s.event_id)
    if row is None:
        return False
    state = {**chat.new_state(), **row.state}
    todo = [a for a in state["applied"] if a.get("session_id") == s.id and not a.get("reported")]
    if not todo:
        return False
    h = next((r for r in sheet.history(db, s)["runs"] if r["session_id"] == s.id), None)
    if h is None or h.get("deltas") is None:
        return False  # no clean laps on one side yet: said when they come
    for a in todo:
        a["reported"] = True
        lever = chat.BY_KEY.get(a["lever"])
        current = {"lever": a["lever"], "title": a["title"], "changes": a.get("changes") or [],
                   "why": "", "expected": lever.expected if lever else "", "watch": "", "another_way": False,
                   "limits": [], "on_run": a["run"]}
        state["current"] = current
        chat._say(state, "tool", effect_text(a, h))
    state["applied"] = list(state["applied"])
    row.state = state
    db.commit()
    return True


def track(db: Session, s: models.RunSession) -> None:
    """Everything above for one run whose logs just came in."""
    if not _recent(s):
        return
    carry_over(db, s)
    prev = sheet.previous_setup(db, s)
    for r in (s, prev[0] if prev else None):  # the balance on both sides of the change
        if r is not None and r.files and any(lap.clean for lap in r.laps):
            results.run_summary(db, r)
    report_effects(db, s)


@prebuild.register
def warm(session_ids: list[int]) -> None:
    """The prebuild's warm-up: the setup log of these runs, on the prebuild's thread."""
    with app_db.SessionLocal() as db:
        for sid in session_ids:
            s = db.get(models.RunSession, sid)
            if s is None:
                continue
            try:
                track(db, s)
            except Exception:  # one run's setup log must not stop the others'
                log.exception("Setup log of run %s failed", sid)
                db.rollback()
