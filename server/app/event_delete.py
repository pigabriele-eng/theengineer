"""Deleting an event with everything in it, to free storage: its runs, their logs, and all that was worked out or
entered for them.

DELETE /events/{id}?runs=delete (routers/events.py hands it here; without runs=delete only the folder goes and its
runs stay, under "Not in an event"); DELETE /loose-runs deletes the runs in no event the same way. GET /events/{id}/size
(and GET /loose-runs/size) says first what it would remove: the runs, their laps,
their logs, the stored files and the bytes they take in storage (as stored: logs are compressed on Supabase).

What goes is found from the tables' own description (the SQLAlchemy metadata), not from a list kept by hand, so a
table added later is covered too:
- a row whose foreign key points at a row that goes, goes (the event's runs; their log files, laps, debriefs and their
  points, tyre data, setup sheets and summaries; the event's dates and results link), unless the key is
  ON DELETE SET NULL: then it is cleared;
- columns without a foreign key are matched by name: event_id or *_event_id names an event, session_id or
  *_session_id a run, file_id or *_file_id a log file, job_id an import (lap tags, lap traces, event info, import
  events, planned-event venues);
- cache rows keyed by a scope ("event:3", "session:12", "event:3|car:...") of what goes, go; a cached result of
  something that stays which names a run or the event that goes (a prep report drawing on past events, say) is
  emptied, so it is worked out again;
- an import's list of the runs it made loses those runs; an import whose runs all go, goes.
Rows that only point at the event and belong to something that stays keep the row with the pointer cleared (KEEP):
a season's round (unlinked, as when its event is gone), a calendar entry (left out of later syncs, as when a planned
event is removed) and a setup copied from a run that goes. Drivers, cars, teams, tracks and official results stay.

The database part is one transaction; the stored files (logs, compact lap traces, lap packs, technique details,
debrief recordings) are deleted after its commit: a file left behind is harmless, a row naming a missing file is not,
and a file already missing is logged. A stored log that a log file row which stays still names (runs split from one
log share it: run_split.py) stays. It all runs under heavy.lock, so no analysis is reading a log as it goes. An
analysis job that had already started on the event's runs may still write a row for them once the lock is let go; when
such jobs are running, the same search runs again once they are done (sweep) and removes what they left.
"""
from __future__ import annotations

import logging
import threading
import time
from collections.abc import Iterable
from dataclasses import dataclass, field

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import Column, Table, delete, or_, select, update
from sqlalchemy.orm import Session

from app import db as app_db  # its Base and SessionLocal are looked up when used: the tests load a fresh one
from app import heavy, models, storage

router = APIRouter()
log = logging.getLogger(__name__)

# columns without a foreign key, by name (or a name ending in _<name>), and the table whose ids they hold
BY_NAME = {"event_id": "events", "session_id": "run_sessions", "file_id": "logger_files", "job_id": "import_jobs"}
# rows that point at what goes but belong to something that stays: the values they are given instead
KEEP: dict[tuple[str, str], dict] = {
    ("season_rounds", "event_id"): {"event_id": None, "plan_id": None, "made_event": False},
    ("calendar_entries", "event_id"): {"event_id": None, "made_event": False, "named": None, "included": False},
    ("session_setups", "copied_from_session_id"): {"copied_from_session_id": None},
}
STORED = {"logger_files": ("path",), "debriefs": ("audio_path",), "session_traces": ("path",),
          "lap_packs": ("path",), "technique_cache": ("details",)}  # columns holding storage keys
SCOPES = ("event", "session")  # scope parts naming an event or a run: "event:3", "session:12", "event:3|car:..."
SCOPE_TABLES = {"event": "events", "session": "run_sessions"}
MENTION_KEYS = {"event_id": "events", "session_id": "run_sessions", "file_id": "logger_files"}
CHUNK = 500  # ids per IN (...)
SWEEP_WAIT_S = 1800  # longest the sweep waits for running analysis jobs


@dataclass
class Found:
    doomed: dict[str, set[int]]  # table -> ids of the rows that go
    cleared: dict[tuple[str, str], set[int]] = field(default_factory=dict)  # (table, column) -> ids kept, cleared
    trimmed: dict[str, dict[int, list]] = field(default_factory=dict)  # table -> {id: its session_ids without them}
    reset: dict[str, set[int]] = field(default_factory=dict)  # cache table -> ids of results to work out again
    keys: list[str] = field(default_factory=list)  # storage keys of the files that go

    def ids(self, table: str) -> set[int]:
        return self.doomed.get(table, set())


# ---------- finding what goes ----------

def _tables() -> list[Table]:
    return list(app_db.Base.metadata.sorted_tables)


def _pk(t: Table) -> Column | None:
    cols = list(t.primary_key.columns)
    return cols[0] if len(cols) == 1 else None


def target_of(col: Column) -> str | None:
    """The table whose ids the column holds: its foreign key's, else by its name (BY_NAME). None for the others and
    for a primary key that is no foreign key (an event's mode is keyed by its event: event_modes.py)."""
    if col.primary_key and not col.foreign_keys:
        return None
    for fk in col.foreign_keys:
        return fk.column.table.name
    for name, table in BY_NAME.items():
        if col.name == name or col.name.endswith(f"_{name}"):
            return table
    return None


def _chunks(ids: Iterable[int]) -> Iterable[list[int]]:
    ids = sorted(ids)
    for i in range(0, len(ids), CHUNK):
        yield ids[i:i + CHUNK]


def _select_ids(db: Session, pk: Column, col: Column, values: set[int]) -> set[int]:
    out: set[int] = set()
    for part in _chunks(values):
        out.update(db.scalars(select(pk).where(col.in_(part))))
    return out


def scope_named(scope: str | None, doomed: dict[str, set[int]]) -> bool:
    """Whether a cache scope names an event or a run that goes: "event:3", "session:12", "event:3|car:logger:7"."""
    for part in (scope or "").split("|"):
        kind, _, value = part.partition(":")
        if kind in SCOPE_TABLES and value.isdigit() and int(value) in doomed.get(SCOPE_TABLES[kind], ()):
            return True
    return False


def mentions(x, doomed: dict[str, set[int]]) -> bool:
    """Whether a cached result names an event, a run or a log that goes: by "event_id", "session_id" or "file_id",
    or as a key of "sessions" (the technique check's habits per run)."""
    if isinstance(x, dict):
        for key, table in MENTION_KEYS.items():
            v = x.get(key)
            if isinstance(v, int) and not isinstance(v, bool) and v in doomed.get(table, ()):
                return True
        runs = x.get("sessions")
        if isinstance(runs, dict) and any(k.isdigit() and int(k) in doomed.get("run_sessions", ()) for k in runs):
            return True
        return any(mentions(v, doomed) for v in x.values())
    if isinstance(x, list):
        return any(mentions(v, doomed) for v in x)
    return False


def find(db: Session, start: dict[str, set[int]], reset: bool = True) -> Found:
    """Every row that goes with the rows in start (table -> ids), until nothing more is found, and the rows that are
    cleared or trimmed instead. reset: also the cached results of what stays that name what goes (read one at a
    time; the size preview leaves them out)."""
    f = Found(doomed={k: set(v) for k, v in start.items() if v})
    tables = _tables()
    grew = True
    while grew:
        grew = False
        for t in tables:
            pk = _pk(t)
            if pk is None:
                continue
            new: set[int] = set()
            for col in t.columns:
                target = target_of(col)
                if target is None or not f.ids(target):
                    continue
                rows = _select_ids(db, pk, col, f.ids(target))
                if (t.name, col.name) in KEEP or any(fk.ondelete and fk.ondelete.upper() == "SET NULL"
                                                     for fk in col.foreign_keys):
                    f.cleared.setdefault((t.name, col.name), set()).update(rows)
                else:
                    new |= rows
            if "scope" in t.c:
                named = db.execute(select(pk, t.c.scope).where(or_(*(t.c.scope.like(f"{k}:%") for k in SCOPES))))
                new |= {i for i, scope in named if scope_named(scope, f.doomed)}
            if "session_ids" in t.c and f.ids("run_sessions"):
                for i, ids in db.execute(select(pk, t.c.session_ids)):
                    ids = [x for x in (ids or []) if isinstance(x, int)]
                    left = [x for x in ids if x not in f.ids("run_sessions")]
                    if ids and not left:
                        new.add(i)
                    elif len(left) < len(ids):
                        f.trimmed.setdefault(t.name, {})[i] = left
            new -= f.ids(t.name)
            if new:
                f.doomed.setdefault(t.name, set()).update(new)
                grew = True
    for (table, _), rows in f.cleared.items():
        rows -= f.ids(table)
    for table, rows in f.trimmed.items():
        for i in [i for i in rows if i in f.ids(table)]:
            del rows[i]
    if reset:
        _find_resets(db, f, tables)
    for t in tables:
        pk = _pk(t)
        for name in STORED.get(t.name, ()):
            for part in _chunks(f.ids(t.name)):
                f.keys += [k for k in db.scalars(select(t.c[name]).where(pk.in_(part))) if k]
    shared = _shared_logs(db, f, tables)
    f.keys = [k for k in dict.fromkeys(f.keys) if k not in shared]
    return f


def _shared_logs(db: Session, f: Found, tables: list[Table]) -> set[str]:
    """Stored logs that a log file row which stays still names: runs split from one log share it (run_split.py)."""
    t = next((t for t in tables if t.name == "logger_files"), None)
    gone = f.ids("logger_files")
    if t is None or not gone:
        return set()
    out: set[str] = set()
    for part in _chunks(f.keys):
        out |= {path for i, path in db.execute(select(t.c.id, t.c.path).where(t.c.path.in_(part))) if i not in gone}
    return out


def _find_resets(db: Session, f: Found, tables: list[Table]) -> None:
    """Cache rows that stay but whose result names what goes: each result read on its own (they can be large)."""
    for t in tables:
        pk = _pk(t)
        if pk is None or "scope" not in t.c or "result" not in t.c:
            continue
        for i in db.scalars(select(pk).where(t.c.result.is_not(None))).all():
            if i in f.ids(t.name):
                continue
            if mentions(db.scalar(select(t.c.result).where(pk == i)), f.doomed):
                f.reset.setdefault(t.name, set()).add(i)


# ---------- removing it ----------

def _apply(db: Session, f: Found) -> dict[str, int]:
    """Clear, trim and reset the rows that stay, then delete the rows that go, those that point at others first.
    Not committed. Rows deleted per table."""
    tables = {t.name: t for t in _tables()}
    for (table, column), rows in f.cleared.items():
        t = tables[table]
        values = {k: v for k, v in KEEP.get((table, column), {column: None}).items() if k in t.c}
        for part in _chunks(rows):
            db.execute(update(t).where(_pk(t).in_(part)).values(**values))
    for table, rows in f.trimmed.items():
        t = tables[table]
        for i, left in rows.items():
            db.execute(update(t).where(_pk(t) == i).values(session_ids=left))
    for table, rows in f.reset.items():
        t = tables[table]
        values = {k: v for k, v in (("result", None), ("result_signature", None), ("signature", "")) if k in t.c}
        for part in _chunks(rows):
            db.execute(update(t).where(_pk(t).in_(part)).values(**values))
    gone: dict[str, int] = {}
    for t in reversed(_tables()):
        rows = f.ids(t.name)
        for part in _chunks(rows):
            db.execute(delete(t).where(_pk(t).in_(part)))
        if rows:
            gone[t.name] = len(rows)
    return gone


def _sizes(keys: list[str]) -> dict[str, int] | None:
    try:
        return storage.sizes(keys)
    except Exception as e:  # the counts still stand without the bytes
        log.warning("Couldn't look up the stored files' sizes: %s", e)
        return None


def _delete_files(keys: list[str], sizes: dict[str, int] | None) -> tuple[int, int]:
    """Delete the stored files; a failure is logged (the rows are gone already). Each is deleted even when the
    listing didn't show it (deleting a missing file does nothing), so a listing that missed one never leaves it
    taking space. How many that were listed were deleted, and the bytes they took."""
    n, freed = 0, 0
    for key in keys:
        try:
            storage.delete(key)
        except Exception as e:
            log.warning("Couldn't delete the stored file %s: %s", key, e)
            continue
        if sizes is None or key in sizes:
            n += 1
            freed += (sizes or {}).get(key, 0)
        else:
            log.warning("Stored file %s was already missing", key)
    return n, freed


def _forget(folder: str, file_ids: set[int], keys: list[str]) -> None:
    """Answers kept in memory for the folder (an event's id, or "none") or its logs."""
    from app.routers import events, technique, trackmap  # here: events.py uses this module
    for module, gone in ((trackmap, lambda k: k[0] in file_ids), (events, lambda k: k[0] == folder)):
        with module._cache_lock:
            for k in [k for k in module._cache if gone(k)]:
                del module._cache[k]
    with technique._details_lock:
        for k in [k for k in technique._details if k[0] in keys]:
            del technique._details[k]


def _busy() -> bool:
    """Analysis jobs queued or running (they may have read the event's runs before it went)."""
    from app import prebuild
    from app.routers import prep, reports, technique
    return any(m._jobs.unfinished_tasks for m in (reports, technique, prep)) or bool(prebuild._queue.unfinished_tasks)


def _event_or_404(db: Session, event_id: int) -> models.Event:
    ev = db.get(models.Event, event_id)
    if ev is None:
        raise HTTPException(404, "Event not found")
    return ev


def _not_importing(db: Session) -> None:
    """An import adds runs to events as it goes: none is deleted meanwhile."""
    busy = (models.ImportStatus.queued, models.ImportStatus.running)
    if db.scalar(select(models.ImportJob.id).where(models.ImportJob.status.in_(busy)).limit(1)) is not None:
        raise HTTPException(409, "An upload is still being imported: delete once it is done")


def counts(f: Found, sizes: dict[str, int] | None) -> dict:
    return {"runs": len(f.ids("run_sessions")), "laps": len(f.ids("laps")), "logs": len(f.ids("logger_files")),
            "files": len(f.keys) if sizes is None else sum(1 for k in f.keys if k in sizes),
            "bytes": None if sizes is None else sum(sizes.get(k, 0) for k in f.keys)}


@router.get("/events/{event_id}/size")
def size(event_id: int, db: Session = Depends(app_db.get_db)):
    """What deleting the event with its runs would remove: runs, laps, logs, stored files and their bytes (null
    when storage can't say)."""
    ev = _event_or_404(db, event_id)
    f = find(db, {"events": {event_id}}, reset=False)
    return {"event_id": event_id, "name": ev.name, **counts(f, _sizes(f.keys))}


def delete_event(db: Session, event_id: int) -> dict:
    """Delete the event with its runs, their logs and everything kept for them (see the module's notes)."""
    name = _event_or_404(db, event_id).name
    _not_importing(db)

    def start() -> dict[str, set[int]]:
        _event_or_404(db, event_id)
        return {"events": {event_id}}
    return {"deleted": event_id, **_delete(db, start, name, str(event_id))}


def _loose_ids(db: Session) -> set[int]:
    """The runs in no event (the Sessions list's "Not in an event")."""
    return set(db.scalars(select(models.RunSession.id).where(models.RunSession.event_id.is_(None))))


@router.get("/loose-runs/size")
def loose_size(db: Session = Depends(app_db.get_db)):
    """What deleting every run in no event would remove, as GET /events/{id}/size says it for an event."""
    f = find(db, {"run_sessions": _loose_ids(db)}, reset=False)
    return {"event_id": None, "name": LOOSE_NAME, **counts(f, _sizes(f.keys))}


@router.delete("/loose-runs")
def delete_loose(db: Session = Depends(app_db.get_db)):
    """Delete every run in no event, with their logs and everything kept for them, as an event's runs go."""
    _not_importing(db)
    return {"deleted": None, **_delete(db, lambda: {"run_sessions": _loose_ids(db)}, LOOSE_NAME, "none")}


LOOSE_NAME = "Not in an event"


def _delete(db: Session, start, name: str, folder: str) -> dict:
    """Delete what start() names (read again once the locks are held) and everything that goes with it."""
    from app import calendar_sync  # here: it imports the routers, which import this module

    with heavy.lock:  # no analysis reads a log while it goes
        with calendar_sync._lock:  # calendar entries and season rounds change one at a time
            db.expire_all()
            first = start()
            _not_importing(db)  # again: one may have started while this waited for the lock
            f = find(db, first)
            sizes = _sizes(f.keys)
            try:
                rows = _apply(db, f)
                db.commit()
            except Exception:
                db.rollback()
                raise
        files, freed = _delete_files(f.keys, sizes)
    _forget(folder, f.ids("logger_files"), f.keys)
    out = {**counts(f, sizes), "files": files, "bytes": None if sizes is None else freed}
    log.warning("Deleted %r (%s) with %s runs, %s laps and %s stored files (%s bytes); rows: %s; cleared: %s",
                name, folder, out["runs"], out["laps"], files, out["bytes"], rows,
                {f"{t}.{c}": len(v) for (t, c), v in f.cleared.items() if v})
    if _busy():
        _sweep_later({k: set(f.ids(k)) for k in ("events", "run_sessions", "logger_files")})
    return {"name": name, **out, "rows": rows,
            "cleared": {f"{t}.{c}": len(v) for (t, c), v in f.cleared.items() if v}}


# ---------- what running jobs leave behind ----------

_sweeps: list[threading.Thread] = []


def _sweep_later(gone: dict[str, set[int]]) -> None:
    sessions = app_db.SessionLocal  # this database, even if the module is reloaded meanwhile (tests)
    t = threading.Thread(target=_sweep, args=(gone, sessions), name="event-delete-sweep", daemon=True)
    _sweeps.append(t)
    t.start()


def _sweep(gone: dict[str, set[int]], sessions) -> None:
    """Once the analysis jobs are done, remove what they wrote for the event, runs and logs that went."""
    deadline = time.monotonic() + SWEEP_WAIT_S
    while _busy() and time.monotonic() < deadline:
        time.sleep(2)
    try:
        sweep(gone, sessions)
    except Exception:
        log.exception("Clearing what was left of a deleted event failed")


def sweep(gone: dict[str, set[int]], sessions=None) -> dict[str, int]:
    """Rows and files that still refer to an event, runs or logs deleted earlier. Ids that are in use again (SQLite
    can give a deleted id to a new row) are left alone."""
    with heavy.lock, (sessions or app_db.SessionLocal)() as db:
        tables = {t.name: t for t in _tables()}
        start = {}
        for name, ids in gone.items():
            t = tables[name]
            live = _select_ids(db, _pk(t), _pk(t), ids)
            start[name] = ids - live
        f = find(db, start)
        for name in start:
            f.doomed.pop(name, None)  # not there any more: nothing to delete
        if not any(f.doomed.values()) and not f.reset and not f.cleared and not f.trimmed:
            return {}
        rows = _apply(db, f)
        db.commit()
        sizes = _sizes(f.keys)
        _delete_files(f.keys, sizes)
    if rows:
        log.warning("Removed what analysis jobs left of a deleted event: %s", rows)
    return rows


def wait_idle(timeout: float = 120) -> None:
    """Until every sweep started is done (for tests)."""
    deadline = time.monotonic() + timeout
    for t in list(_sweeps):
        t.join(max(0.0, deadline - time.monotonic()))
