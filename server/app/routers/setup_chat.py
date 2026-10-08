"""The setup tool: a conversation per event that proposes one setup change at a time (app.setup.chat), reading the
picked run's debrief, data and setup sheet when there is one."""
import logging
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from app import models
from app.db import get_db
from app.routers.setups import _suggestions
from app.setup import chat, sheet
from app.setup import track as _track  # noqa: F401  (its warm-up keeps the setup log after each upload)
from app.setup.models import SessionSetup, SetupChat
from app.setup.templates import BMW_M4_GT4_EVO

log = logging.getLogger(__name__)
router = APIRouter()


def _row(db: Session, event_id: int | None) -> SetupChat:
    q = select(SetupChat).where(SetupChat.event_id.is_(None) if event_id is None else SetupChat.event_id == event_id)
    row = db.scalars(q).first()
    if row is None:
        row = SetupChat(event_id=event_id, state=chat.new_state())
        db.add(row)
    return row


def _runs(db: Session, event_id: int | None) -> list[models.RunSession]:
    q = select(models.RunSession).where(models.RunSession.event_id.is_(None) if event_id is None
                                        else models.RunSession.event_id == event_id)
    return sorted(db.scalars(q).unique().all(), key=sheet._order, reverse=True)


def _past(db: Session) -> list[dict]:
    """Every logged run-to-run setup change, at every event: what changed and what the lap times and balance did
    (setup/sheet.py history, from kept summaries only: no log is read here)."""
    sheets = db.execute(select(models.RunSession, SessionSetup)
                        .join(SessionSetup, SessionSetup.session_id == models.RunSession.id)).all()
    out, seen = [], set()
    for s, _ in sheets:
        key = s.event_id if s.event_id is not None else ("venue", sheet._venue(s))
        if key in seen:
            continue
        seen.add(key)
        h = sheet.history(db, s)
        event = s.event.name if s.event else "a test"
        out += [{"event": event, "run": r["name"] or f"Run {r['session_id']}", "changes": r["changes"],
                 "deltas": r["deltas"]} for r in h["runs"] if r["changes"]]
    return out


def _out(db: Session, event_id: int | None, state: dict, notes: list[str] | None = None) -> dict:
    event = db.get(models.Event, event_id) if event_id is not None else None
    runs = _runs(db, event_id)
    return {"event_id": event_id, "event": event.name if event else None,
            "runs": [{"id": s.id, "name": s.name or f"Run {s.id}",
                      "debrief": any(d.status == models.DebriefStatus.ready for d in s.debriefs),
                      "data": bool(s.files)} for s in runs],
            **chat.view(state), "notes": notes or []}


@router.get("/setup/chat")
def get_chat(event_id: int | None = None, db: Session = Depends(get_db)):
    """The event's setup conversation: the messages, the problems and limits it knows, the one-tap answers."""
    if event_id is not None and db.get(models.Event, event_id) is None:
        raise HTTPException(404, "Event not found")
    row = db.scalars(select(SetupChat).where(
        SetupChat.event_id.is_(None) if event_id is None else SetupChat.event_id == event_id)).first()
    state = dict(row.state) if row else chat.new_state()
    if state.get("session_id") is None:
        runs = _runs(db, event_id)
        state["session_id"] = runs[0].id if runs else None
    return _out(db, event_id, state)


class TurnIn(BaseModel):
    event_id: int | None = None
    session_id: int | None = None  # the run to read; set_session says whether to change it
    set_session: bool = False
    variant: str | None = Field(None, max_length=20)
    text: str | None = Field(None, max_length=1000)  # a typed reply
    action: dict[str, Any] | None = None  # a tapped answer (from quick_replies or problem_choices)
    said: str | None = Field(None, max_length=200)  # the tapped answer's words, kept in the conversation


@router.post("/setup/chat")
def post_turn(body: TurnIn, db: Session = Depends(get_db)):
    """One answer, typed or tapped, and the tool's next proposal. Changing the run or the car only updates them."""
    if body.event_id is not None and db.get(models.Event, body.event_id) is None:
        raise HTTPException(404, "Event not found")
    row = _row(db, body.event_id)
    state = {**chat.new_state(), **(row.state or {})}
    if body.variant is not None:
        if body.variant not in chat.VARIANTS:
            raise HTTPException(422, "Unknown car variant")
        state["variant"] = body.variant
    if body.set_session:
        state["session_id"] = body.session_id
    if state.get("session_id") is None and not body.set_session:
        runs = _runs(db, body.event_id)
        state["session_id"] = runs[0].id if runs else None

    notes: list[str] = []
    if body.text or body.action:
        template, values, data = BMW_M4_GT4_EVO, {}, None
        s = db.get(models.RunSession, state["session_id"]) if state.get("session_id") else None
        if s is not None:
            own = sheet.setup_of(db, s.id)
            template = sheet.template_of(db, s, own)
            values = dict(own.values) if own else {}
            try:
                extra = chat._observations(chat.problems_after(state, body.text, body.action))
                res = _suggestions(db, s, extra)
                data = res["suggestions"]
                quiet = ("This session has no setup sheet", "No debrief for this session", "No log with clean laps")
                notes = [n for n in res["notes"] if not n.startswith(quiet)]
                if not any(d.status == models.DebriefStatus.ready for d in s.debriefs) and not s.files:
                    notes.append(f"{s.name or 'This run'} has no debrief or logger data yet, so this goes on what "
                                 "you tell me.")
            except Exception:  # the run's data must not stop the conversation
                log.exception("Setup tool: reading session %s failed", s.id)
                db.rollback()
                row = _row(db, body.event_id)
                notes = ["The run's data couldn't be read, so this goes on what you tell me."]
        past = _past(db)
        if body.text:
            state = chat.turn_text(state, body.text, template, values, data, past)
        else:
            state = chat.turn(state, body.action or {}, template, values, data, said=body.said, past=past)
    row.state = state
    db.commit()
    return _out(db, body.event_id, state, notes)
