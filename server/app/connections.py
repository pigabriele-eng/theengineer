"""Requests waiting their turn for the heavy-work lock hand their database connection back first.

A request that has read from the database holds one of the pool's connections until it ends (the hosted database
allows the server ten). Requests that then wait for the heavy-work lock (app/heavy.py) while a log is read would
hold one each: with a report's figures and a few runs' pages asked for at once, they held them all, and the next
request, even one answered from what is kept, found no connection for 30 s and failed. So before a thread waits for
that lock, the read-only transactions its sessions have open are ended (a commit with nothing to write: what they
loaded stays usable) and their connections go back to the pool; the next query takes one again.

Imported once by app.db (never reloaded, so the listeners are registered once).
"""
from __future__ import annotations

import logging
import threading
import weakref

from sqlalchemy import event
from sqlalchemy.orm import Session

from app import heavy

log = logging.getLogger(__name__)

_threads = threading.local()


def _mine() -> weakref.WeakSet:
    sessions = getattr(_threads, "sessions", None)
    if sessions is None:
        sessions = _threads.sessions = weakref.WeakSet()
    return sessions


@event.listens_for(Session, "after_begin")
def _began(session: Session, transaction, connection) -> None:
    _mine().add(session)  # the thread that runs the first query of a transaction is the one that waits


@event.listens_for(Session, "after_flush")
def _flushed(session: Session, context) -> None:
    session.info["wrote"] = True  # written, not committed yet: left alone


@event.listens_for(Session, "do_orm_execute")
def _executed(state) -> None:
    if not state.is_select:  # an insert, update or delete sent as a statement: written too
        state.session.info["wrote"] = True


@event.listens_for(Session, "after_transaction_end")
def _ended(session: Session, transaction) -> None:
    if transaction.parent is None:
        session.info.pop("wrote", None)
        _mine().discard(session)


def hand_back() -> None:
    """End the read-only transactions of this thread's sessions, so their connections go back to the pool."""
    for s in list(_mine()):
        if not s.in_transaction() or s.in_nested_transaction() or s.info.get("wrote") or s.new or s.dirty or s.deleted:
            continue
        try:
            s.commit()
        except Exception:  # never fails the request: it then just keeps its connection while it waits
            log.warning("Couldn't hand back a database connection before waiting", exc_info=True)


if hand_back not in heavy.before_waiting:
    heavy.before_waiting.append(hand_back)
