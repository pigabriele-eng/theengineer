"""Our runs named after the official session they ran in: "FP1 run 1", "FP1 run 2", "Q1", "Race 1", "Test 3".

Each run's log start and length (the logger's date, time of day and duration) are laid on the round's official
timetable (results/: every session's start; its end is the next session's start or the usual length of its kind).
The logger's clock can be off or set to another time zone, so the whole event is tried at whole-hour offsets of up
to three hours and the one that puts the most runs squarely in a session is kept (no offset on a tie).

A run that sits squarely in one session is named after it; one that overlaps two, or barely touches one, becomes a
question ("if you are not sure, ask"): GET /results/events/{id}/run-names lists them, POST /results/run-names/{id}
answers one with a tap. A name typed by hand is never changed again (``RunNameMark.by_hand``); a run whose name is
still the one the upload gave it (the logger's session name, the file's or the folder's name) or one given here
before is renamed. The kind of run (practice, qualifying, race, test) follows the session.
"""
from __future__ import annotations

import logging
import re
from datetime import datetime, timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session

from app import models
from app.results import models as rm

log = logging.getLogger(__name__)

OFFSETS_H = (0, -1, 1, -2, 2, -3, 3)  # logger clock against the official one, tried in this order
SLACK = timedelta(minutes=10)  # a run may start a little before the green flag or end after the chequered flag
USUAL_MIN = {"FP": 60, "PQ": 30, "Q": 30, "R": 70, "T": 60}  # a session's length when the next one doesn't bound it
SURE = 0.6  # share of a run inside one session to name it without asking
CLEAR = 0.25  # ... while no other session holds more than this share of it
KINDS = {"FP": models.SessionKind.practice, "PQ": models.SessionKind.practice, "Q": models.SessionKind.qualifying,
         "R": models.SessionKind.race, "T": models.SessionKind.test}
NONE = "none"


def prefix(code: str) -> str:
    return re.match(r"[A-Z]+", code).group(0) if re.match(r"[A-Z]+", code) else code


def label(code: str) -> str:
    """'FP1', 'Q2', 'Race 1', 'Test 3', 'Pre-qualifying'."""
    p, n = prefix(code), code[len(prefix(code)):]
    return {"R": f"Race {n}".strip(), "T": f"Test {n}".strip(), "PQ": "Pre-qualifying"}.get(p, code)


# ---------- times ----------

def _log_time(text: str | None, day: str | None) -> datetime | None:
    from app.routers.imports import _date  # the importer's own reading of a logger's date

    d = _date(day or "")
    m = re.match(r"(\d{1,2}):(\d{2})(?::(\d{2}))?", (text or "").strip())
    if d is None or m is None:
        return None
    return datetime(d.year, d.month, d.day, int(m.group(1)), int(m.group(2)), int(m.group(3) or 0))


def run_window(s: models.RunSession) -> tuple[datetime, datetime] | None:
    """When the run's main log started and ended, by the logger's clock."""
    f = max(s.files, key=lambda f: (f.meta or {}).get("duration_s") or 0, default=None)
    if f is None:
        return None
    start = _log_time((f.meta or {}).get("time"), (f.meta or {}).get("date"))
    length = (f.meta or {}).get("duration_s")
    if start is None or not length:
        return None
    return start, start + timedelta(seconds=float(length))


def timetable(rnd: rm.ResultRound) -> list[tuple[str, datetime, datetime]]:
    """(code, start, end) of each official session with a start time, in time order."""
    starts = []
    for s in rnd.sessions:
        try:
            starts.append((s.code, datetime.fromisoformat((s.starts_at or "")[:19])))
        except ValueError:
            continue
    starts.sort(key=lambda x: x[1])
    out = []
    for i, (code, t0) in enumerate(starts):
        end = t0 + timedelta(minutes=USUAL_MIN.get(prefix(code), 60))
        later = [t for _, t in starts[i + 1:] if t > t0]
        if later and later[0] < end:
            end = later[0]
        out.append((code, t0, end))
    return out


def _shares(win: tuple[datetime, datetime], table: list, offset: timedelta) -> list[tuple[float, str]]:
    """Share of the run inside each session, largest first."""
    a, b = win[0] + offset, win[1] + offset
    length = max((b - a).total_seconds(), 1.0)
    out = []
    for code, t0, t1 in table:
        inside = (min(b, t1 + SLACK) - max(a, t0 - SLACK)).total_seconds()
        if inside > 0:
            out.append((min(inside / length, 1.0), code))
    return sorted(out, reverse=True)


def _verdict(shares: list[tuple[float, str]]) -> tuple[str | None, list[str]]:
    """(the session when sure, else None; the sessions to ask between)."""
    if not shares:
        return NONE, []
    best, code = shares[0]
    other = shares[1][0] if len(shares) > 1 else 0.0
    if best >= SURE and other <= CLEAR:
        return code, []
    return None, [c for _, c in shares[:3]]


def place(runs: list[tuple[int, tuple[datetime, datetime]]], table: list) -> tuple[int, dict[int, tuple]]:
    """The clock offset (hours) that puts the most runs squarely in a session, and each run's verdict."""
    best_h, best, best_n = 0, {}, -1
    for h in OFFSETS_H:
        verdicts = {rid: _verdict(_shares(win, table, timedelta(hours=h))) for rid, win in runs}
        n = sum(1 for v in verdicts.values() if v[0] not in (None, NONE))
        if n > best_n:
            best_h, best, best_n = h, verdicts, n
    return best_h, best


# ---------- names ----------

def _plain_name(name: str | None) -> str:
    return re.sub(r"\s*\(\d+\)$", "", (name or "").strip())


def looks_given(s: models.RunSession, mark: rm.RunNameMark | None) -> bool:
    """Whether the run still has the name the upload (or this naming) gave it, so it may be renamed."""
    if mark is not None and mark.by_hand:
        return False
    name = _plain_name(s.name)
    if not name or (mark is not None and mark.auto_name and name == _plain_name(mark.auto_name)):
        return True
    for f in s.files:
        meta = f.meta or {}
        stem = re.sub(r"\.[A-Za-z0-9]+$", "", f.filename or "")
        session = (meta.get("event_session") or "").strip()
        if name in {stem, session} or (session and re.fullmatch(rf"\d{{1,3}}[ _-]+{re.escape(session)}", name)):
            return True
    return bool(re.fullmatch(r"\d{1,3}[ _-]+\S+", name))  # a numbered folder: "01_D1S1", "03_Q"


def _hinted(s: models.RunSession, table: list, rnd: rm.ResultRound, number: str | None
            ) -> tuple[str | None, list[str]]:
    """For a run whose log time can't be trusted: the session its names say (the logger's session name "R1", a
    folder "03_Q"), told apart by our car's official best lap when they say only the kind (Q: Q1 or Q2)."""
    from app.results import summary  # the results' reading of a session name

    codes = [c for c, _, _ in table]
    names = [(f.meta or {}).get("event_session") for f in s.files] + [s.name]
    kind, code = next((h for h in map(summary._hint, names) if h[0]), (None, None))
    if code in codes:
        return code, []
    want = {"practice": ("FP", "PQ"), "qualifying": ("Q",), "race": ("R",), "test": ("T",)}.get(kind or "", ())
    cands = [c for c in codes if prefix(c) in want]
    if len(cands) == 1:
        return cands[0], []
    best = min((lap.time_s for lap in s.laps if lap.clean), default=None)
    if best and number:
        near = []
        for sess in rnd.sessions:
            car = summary.find_car(sess, number) if sess.code in cands else None
            if car is not None and car.best_lap_s and abs(car.best_lap_s - best) <= MATCH_S:
                near.append(sess.code)
        if len(near) == 1:
            return near[0], []
    return None, cands


MATCH_S = 0.3  # our logged best lap this close to our car's official best lap: that session


def _clashing(windows: dict[int, tuple[datetime, datetime]]) -> set[int]:
    """Runs whose log times overlap another run's: one car can't run two at once, so those times are when the logs
    were saved or downloaded, not when the car ran."""
    out = set()
    items = sorted(windows.items(), key=lambda x: x[1][0])
    for i, (a, (_, a1)) in enumerate(items):
        for b, (b0, _) in items[i + 1:]:
            if b0 >= a1 - timedelta(seconds=60):
                break
            out |= {a, b}
    return out


def name_runs(db: Session, event_id: int, rnd: rm.ResultRound, number: str | None = None) -> dict:
    """Name the event's runs after the official sessions of ``rnd`` (only runs with laps: a log of a few seconds
    keeps its name); returns what was named and what to ask."""
    table = timetable(rnd)
    runs = [r for r in db.scalars(select(models.RunSession).where(models.RunSession.event_id == event_id)).all()
            if r.laps]
    marks = {m.session_id: m for m in db.scalars(select(rm.RunNameMark)
                                                .where(rm.RunNameMark.session_id.in_([r.id for r in runs])))}
    windows = {r.id: w for r in runs if (w := run_window(r)) is not None}
    out: dict = {"offset_h": 0, "named": [], "questions": []}
    if not table or not runs:
        return out
    timed = {k: w for k, w in windows.items() if k not in _clashing(windows)}
    h, verdicts = place(list(timed.items()), table) if timed else (0, {})
    out["offset_h"] = h
    codes: dict[int, str] = {}
    order: dict[int, datetime] = {}
    for r in runs:
        m = marks.get(r.id)
        order[r.id] = windows.get(r.id, (r.created_at.replace(tzinfo=None),))[0]
        if m is not None and m.answered and m.code:
            codes[r.id] = m.code
            continue
        code, ask = verdicts[r.id] if r.id in verdicts else _hinted(r, table, rnd, number)
        if code is not None:
            codes[r.id] = code
        elif ask and looks_given(r, m):
            out["questions"].append({"session_id": r.id, "name": r.name,
                                     "starts": (windows[r.id][0] + timedelta(hours=h)).isoformat()
                                     if r.id in timed else None,
                                     "options": [{"code": c, "label": label(c)} for c in ask]})
    by_code: dict[str, list[models.RunSession]] = {}
    for r in runs:
        if codes.get(r.id) and codes[r.id] != NONE:
            by_code.setdefault(codes[r.id], []).append(r)
    changed = False
    for code, group in by_code.items():
        group.sort(key=lambda r: (order[r.id], r.id))
        for i, r in enumerate(group, 1):
            want = label(code) if len(group) == 1 else f"{label(code)} run {i}"
            m = marks.get(r.id)
            if not looks_given(r, m):
                continue
            if m is None:
                m = marks[r.id] = rm.RunNameMark(session_id=r.id)
                db.add(m)
            m.code, m.auto_name = code, want
            kind = KINDS.get(prefix(code))
            if r.name != want or (kind and r.kind != kind):
                r.name = want
                if kind:
                    r.kind = kind
                changed = True
            out["named"].append({"session_id": r.id, "name": want, "code": code})
    db.commit()
    if changed:
        from app.routers import events  # a run's name and kind are part of its event's report

        events._refresh(db, {event_id})
    return out


def answer(db: Session, session_id: int, code: str | None) -> rm.RunNameMark:
    """The user's tap: the run ran in ``code`` (None or "none": in no official session)."""
    m = db.scalar(select(rm.RunNameMark).where(rm.RunNameMark.session_id == session_id))
    if m is None:
        m = rm.RunNameMark(session_id=session_id)
        db.add(m)
    m.code, m.answered = (code or NONE), True
    db.commit()
    return m


def typed_by_hand(db: Session, session_id: int) -> None:
    """A name typed by hand: never renamed from the timetable again."""
    m = db.scalar(select(rm.RunNameMark).where(rm.RunNameMark.session_id == session_id))
    if m is None:
        db.add(rm.RunNameMark(session_id=session_id, by_hand=True))
    else:
        m.by_hand = True
    db.commit()
