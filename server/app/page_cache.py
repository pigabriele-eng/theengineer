"""Answers of the pages that read a log, kept in the database (table page_cache) so they open at once.

A session's insights, lap analysis, lap comparisons, stint view, track map and track shape, an event's track shape and
each session's tyre prep reduction and each log's tyre pressure runs are worked out from the logs: seconds each on a
fast machine, far longer on the hosted server, which also has to download the log first. Each answer is kept with a
signature of everything it was made from (the log and its stored path, its laps as stored, the car's channel map, the
track's start/finish line and corners, and the page's version below); the next request with the same signature
answers from here, without reading the log and without waiting for the server's heavy-work lock (app/heavy.py). When
anything changes the signature no longer matches, and the answer is worked out again as before and kept. The prebuild
(app/prebuild.py) fills this in the background right after logs are uploaded.

Rows are keyed by a scope that starts with the run or event they belong to ("session:7|analysis", "event:1|shape"),
so deleting an event or a run (app/event_delete.py) deletes them with it.
"""
from __future__ import annotations

import hashlib
import json
import logging
import math
import zlib
from collections.abc import Callable
from contextlib import nullcontext
from datetime import UTC, datetime

from fastapi import HTTPException
from fastapi.responses import Response
from sqlalchemy import DateTime, Integer, LargeBinary, String, delete, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Mapped, Session, mapped_column

from app import heavy, models
from app.db import Base

log = logging.getLogger(__name__)

# Raise a page's version when what it answers changes, so every kept answer of that page is worked out again.
VERSIONS = {"insights": 1, "analysis": 1, "compare": 1, "stint": 1, "map": 1, "shape": 1, "tyreprep": 1, "grip": 1,
            "balance": 1, "tyreruns": 1}
KEPT_ERRORS = (404, 422)  # answers that say what a log can't give (no lap, no GPS): the same log gives the same answer


def _now() -> datetime:
    return datetime.now(UTC)


class PageCache(Base):
    """The last answer of a page for a run or an event, and the signature of what it was made from."""
    __tablename__ = "page_cache"
    id: Mapped[int] = mapped_column(primary_key=True)
    scope: Mapped[str] = mapped_column(String(160), unique=True, index=True)  # "session:7|analysis", "event:1|shape"
    signature: Mapped[str] = mapped_column(String(64))
    status: Mapped[int] = mapped_column(Integer, default=200)  # 200, or the 404 or 422 the page answered
    body: Mapped[bytes] = mapped_column(LargeBinary)  # the answer (or the error's detail) as zlib-compressed JSON
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now, onupdate=_now)


def digest(payload) -> str:
    return hashlib.sha256(json.dumps(payload, sort_keys=True, default=str).encode()).hexdigest()[:40]


def log_part(s: models.RunSession, f: models.LoggerFile | None) -> list:
    """What every answer read from one of a session's logs depends on in the session: the log as stored, its laps
    as stored (they change when it is timed again), the car's channel map, the run's name and driver."""
    if f is None:
        return [s.id, None]
    laps = sorted((l.number, l.start_s, l.time_s, l.clean) for l in s.laps if l.file_id == f.id)
    return [s.id, s.name, s.driver.name if s.driver else None, f.id, f.path, f.meta.get("beacons"), laps,
            s.car.channel_map if s.car else None]


def track_part(track: models.Track | None) -> list:
    """The track's part: its start/finish line and its official corners."""
    from app.routers.sessions import official_corners  # here: the routers import this module

    if track is None:
        return [None]
    return [track.id, track.name, track.timing_line, official_corners(track)]


def signature(page: str, *parts) -> str:
    return digest([page, VERSIONS[page], *parts])


def known_track(db: Session, s: models.RunSession, f: models.LoggerFile | None) -> models.Track | None:
    """The track a page reading the log finds, without opening it: the event's, else the one its log names."""
    if s.event and s.event.track:
        return s.event.track
    venue = ((f.meta.get("venue") or "") if f else "")[:120]
    return db.scalar(select(models.Track).where(models.Track.name == venue)) if venue else None


def session_signature(db: Session, page: str, s: models.RunSession, f: models.LoggerFile | None, *extra) -> str:
    """The signature of a page read from one of a session's logs: the log, the session and the track's parts."""
    return signature(page, log_part(s, f), track_part(known_track(db, s, f)), *extra)


def main_file(s: models.RunSession) -> models.LoggerFile | None:
    """The log the pages read for a session: the longest."""
    return max(s.files, key=lambda f: f.meta.get("duration_s", 0)) if s.files else None


def sessions_part(db: Session, sessions: list[models.RunSession]) -> list:
    """For a page read from several sessions' main logs: each one's log and track parts, and its car."""
    return [[log_part(s, f), track_part(known_track(db, s, f)), s.car_id, s.car.name if s.car else None]
            for s in sessions for f in [main_file(s)]]


class RawJSON(Response):
    """An answer sent as the JSON text it is kept as. Returned as a plain value, the kept text would be read back into
    Python, FastAPI would run every value through its encoder and write it out again, in the event loop every other
    request waits on: a quarter of a second for the report's grip use (110 kB) on a tenth of a CPU, against a
    hundredth of that to unpack the text."""
    media_type = "application/json"


def as_json(x) -> bytes:
    """The answer as the JSON text it is kept and sent as (UTF-8 as FastAPI writes it; NaN and infinity as null)."""
    return json.dumps(_finite(x), separators=(",", ":"), ensure_ascii=False, default=_plain).encode()


def with_fields(text: bytes, **fields) -> bytes:
    """The JSON object text with these fields added at its end (a copy of a kept answer with a field of its own)."""
    more = as_json(fields)[1:-1]
    head = text.rstrip()[:-1]  # without its closing brace
    return text if not more else head + (b"" if head.rstrip().endswith(b"{") else b",") + more + b"}"


def _pack(x) -> bytes:
    return zlib.compress(as_json(x), 6)


def _plain(x):
    if hasattr(x, "tolist"):  # numpy numbers and arrays
        return x.tolist()
    return str(x)


def _finite(x):
    """NaN and infinity as None: the API answers without them (a kept NaN would fail every request after)."""
    if isinstance(x, dict):
        return {k: _finite(v) for k, v in x.items()}
    if isinstance(x, list | tuple):
        return [_finite(v) for v in x]
    if isinstance(x, float):
        return x if math.isfinite(x) else None
    if hasattr(x, "tolist"):  # numpy numbers and arrays
        return _finite(x.tolist())
    return x


def plain(x):
    """The value as it reads back from here (lists for tuples and arrays, string keys, None for NaN)."""
    return json.loads(json.dumps(_finite(x), default=_plain))


def lookup(db: Session, scope: str, sig: str, raw: bool = False) -> tuple[int, object] | None:
    """(status, answer) kept for scope when it was made from these inputs, else None. raw: a kept answer (status 200)
    as its JSON text, not read back into Python."""
    row = db.execute(select(PageCache.signature, PageCache.status, PageCache.body)
                     .where(PageCache.scope == scope)).first()
    if row is None or row.signature != sig:
        return None
    try:
        text = zlib.decompress(row.body)
        return row.status, (text if raw and row.status == 200 else json.loads(text))
    except (zlib.error, ValueError) as e:
        log.warning("Kept answer %s couldn't be read (%s): worked out again", scope, e)
        return None


def store(db: Session, scope: str, sig: str, value, status: int = 200) -> bytes:
    """Keep the answer (committed with whatever else the request has pending); its JSON text, as kept."""
    text = as_json(value)
    body = zlib.compress(text, 6)
    for _ in range(2):
        row = db.scalar(select(PageCache).where(PageCache.scope == scope))
        if row is None:
            row = PageCache(scope=scope)
            db.add(row)
        row.signature, row.status, row.body = sig, status, body
        try:
            db.commit()
            return text
        except IntegrityError:  # another request kept it a moment ago: overwrite that one
            db.rollback()
    return text


def _answer(hit: tuple[int, object]):
    status, value = hit
    if status != 200:
        raise HTTPException(status, value)
    return value


def cached(db: Session, scope: str, sig: Callable[[], str], work: Callable[[], object], locked: bool = True,
           raw: bool = False):
    """The page's answer: the one kept for scope when sig() still matches (no log read, no wait for the heavy-work
    lock), else work() under the lock, kept for next time. Under the lock it looks again first: another request or
    the prebuild may have just worked it out. locked=False for work that takes the lock itself only when it reads a
    log (it has answers in memory too). sig() is asked again after work(), which can find the track a log names, so
    the answer is kept under the signature the next request will ask with. A 404 or 422 is kept too.

    raw: the answer as its JSON text, kept or just worked out (bytes; an endpoint sends it as RawJSON): the same text
    either way, read and written once."""
    hit = lookup(db, scope, sig(), raw)
    if hit is not None:
        return _answer(hit)
    if locked:
        db.commit()  # hands the database connection back while this waits its turn: the pool is small
    with heavy.lock if locked else nullcontext():
        if locked:
            hit = lookup(db, scope, sig(), raw)
            if hit is not None:
                return _answer(hit)
        try:
            out = work()
        except HTTPException as e:
            if e.status_code in KEPT_ERRORS and isinstance(e.detail, str):
                store(db, scope, sig(), e.detail, e.status_code)
            raise
        # kept before the lock is let go: an event deleted meanwhile (it takes the lock) leaves no answer behind
        text = store(db, scope, sig(), out)
    return text if raw else out


def fresh(db: Session, scope: str, sig: str) -> bool:
    """Whether an answer made from these inputs is kept (for the prebuild: nothing to do)."""
    return db.execute(select(PageCache.id).where(PageCache.scope == scope, PageCache.signature == sig)).first() \
        is not None


def forget_session(db: Session, session_id: int) -> None:
    """Drop what is kept for a run that is being deleted (not committed)."""
    db.execute(delete(PageCache).where(PageCache.scope.like(f"session:{session_id}|%")))
