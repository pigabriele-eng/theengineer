"""Our runs named after the official session they ran in: "FP1 stint 2", "Q1", "R1 stint 1", "PT2 stint 1".

Each run's log start and length (the logger's date, time of day and duration) are laid on the round's official
timetable (results/: every session's start; its end is the next session's start or the usual length of its kind).
The logger's clock can be off or set to another time zone, so the whole event is tried at whole-hour offsets of up
to three hours and the one that puts the most runs squarely in a session is kept (no offset on a tie).

What the run's names say comes first: its folders ("05_R1", "01_PTS/02") and the logger's session name ("R1",
"PTS"). A name that gives the session ("R1", "FP2") names the run; a paid test is numbered by its folder ("01_PTS/02",
"02_PTS2": PT2) even when the official timetable lists fewer tests than were run. A name that gives only the kind ("FP",
"Q") leaves the time to tell: logs whose times overlap another's were saved or downloaded after the session, so the
session is the last one of that kind to start before the log's time (with any earlier one of that kind the same day,
told apart by our car's official best lap: Q1 or Q2).

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
    """'FP1', 'Q2', 'R1', 'PT3' (a paid test), 'Pre-qualifying'."""
    p, n = prefix(code), code[len(prefix(code)):]
    return {"T": f"PT{n}", "PQ": "Pre-qualifying"}.get(p, code)


def run_name(code: str, i: int, of: int) -> str:
    """A run is always "FP1 stint 2", "PT1 stint 1", "R1 stint 1" (a race it didn't finish too); a qualifying run
    is "Q1", with a stint number only when it has company."""
    if of == 1 and prefix(code) == "Q":
        return label(code)
    return f"{label(code)} stint {i}"


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


def place(runs: list[tuple[int, tuple[datetime, datetime]]], table: list, kinds: dict[int, tuple] | None = None
          ) -> tuple[int, dict[int, tuple]]:
    """The clock offset (hours) that puts the most runs squarely in a session, and each run's verdict. ``kinds``: the
    sessions (codes, or kinds as prefixes) a run's names allow; a run put in another counts against the offset."""
    kinds = kinds or {}
    best_h, best, best_n = 0, {}, -1
    for h in OFFSETS_H:
        verdicts = {rid: _verdict(_shares(win, table, timedelta(hours=h))) for rid, win in runs}
        n = sum((1 if not kinds.get(rid) or v[0] in kinds[rid] or prefix(v[0]) in kinds[rid] else -1)
                for rid, v in verdicts.items() if v[0] not in (None, NONE))
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
    return bool(re.fullmatch(r"\d{1,3}([ _-]+\S+)?", name))  # a numbered folder: "01_D1S1", "03_Q", "02"


WANT = {"practice": ("FP", "PQ"), "qualifying": ("Q",), "race": ("R",), "test": ("T",)}
TEST = re.compile(r"\b(?:pts?|paid ?tests?)\s*(\d)?\b")


def _hint(text: str | None) -> tuple[str | None, str | None]:
    """'05_R1' -> ('race', 'R1'), '01_PTS' -> ('test', None), 'PTS2' -> ('test', 'T2'), 'FP' -> ('practice', None)."""
    from app.results import summary  # the results' reading of a session name

    t = re.sub(r"[_\-.]+", " ", text or "").lower()
    kind, code = summary._hint(t)
    if kind:
        return kind, code
    m = TEST.search(t)
    return ("test", f"T{m.group(1)}" if m.group(1) else None) if m else (None, None)


def _folders(s: models.RunSession) -> list[str]:
    return next(((f.meta or {}).get("folder") or "" for f in s.files if (f.meta or {}).get("folder")), "").split("/")


def hint(s: models.RunSession, mark: rm.RunNameMark | None) -> tuple[str | None, str | None]:
    """What the run's names say it was: (kind, session code or None). Its folders first, innermost out, then the
    logger's session name, then its own name while that is still the upload's (not one given here)."""
    own = _plain_name(s.name)
    mine = not (mark is not None and mark.auto_name and own == _plain_name(mark.auto_name))
    texts = [*reversed(_folders(s)), *((f.meta or {}).get("event_session") for f in s.files),
             *([own] if mine and looks_given(s, mark) else [])]
    kind, code = next((h for h in map(_hint, texts) if h[0]), (None, None))
    if kind == "test" and code is None:  # a test's folder numbered inside a test folder: "01_PTS/02" is PT2
        folders = [x for x in _folders(s) if x] or ([own] if mine else [])
        if folders and re.fullmatch(r"\d{1,2}", folders[-1]) and int(folders[-1]) > 0:
            code = f"T{int(folders[-1])}"
    return kind, code


def _by_time(t: datetime, kind: str, table: list) -> list[str]:
    """The sessions a log of ``kind`` saved at ``t`` can hold: the last of that kind to start before ``t``, with the
    ones of that kind just before it on the same day (no other session between)."""
    out: list[str] = []
    for code, t0, _ in sorted((x for x in table if x[1] <= t + SLACK), key=lambda x: x[1], reverse=True):
        if prefix(code) in WANT[kind]:
            if out and t0.date() != table_start(table, out[-1]).date():
                break
            out.append(code)
        elif out:
            break
    return out


def table_start(table: list, code: str) -> datetime:
    return next(t0 for c, t0, _ in table if c == code)


def _by_lap(s: models.RunSession, cands: list[str], rnd: rm.ResultRound, number: str | None) -> str | None:
    """The one session among ``cands`` whose official best lap for our car is our logged best lap."""
    from app.results import summary

    best = min((lap.time_s for lap in s.laps if lap.clean), default=None)
    if not (best and number):
        return None
    near = []
    for sess in rnd.sessions:
        car = summary.find_car(sess, number) if sess.code in cands else None
        if car is not None and car.best_lap_s and abs(car.best_lap_s - best) <= MATCH_S:
            near.append(sess.code)
    return near[0] if len(near) == 1 else None


def _hinted(s: models.RunSession, kind: str | None, t: datetime | None, table: list, rnd: rm.ResultRound,
            number: str | None) -> tuple[str | None, list[str]]:
    """For a run whose log time isn't when the car ran: the session of the kind its names say, by when the log was
    saved, else by our car's official best lap (Q: Q1 or Q2); else the sessions to ask between."""
    codes = [c for c, _, _ in table]
    cands = [c for c in codes if prefix(c) in WANT.get(kind or "", ())]
    if t is not None and kind in WANT:
        cands = _by_time(t, kind, table) or cands
    if len(cands) == 1:
        return cands[0], []
    if (code := _by_lap(s, cands, rnd, number)) is not None:
        return code, []
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


def _by_driver(runs: list[models.RunSession], codes: dict[int, str], asks: dict[int, list[str]],
               order: dict[int, datetime]) -> dict[int, str]:
    """Qualifying runs the lap times can't tell apart (Q1 or Q2), told by who drove: the Q1 driver starts Race 1,
    so the run of the driver of Race 1's first stint is Q1 and a run of the other driver Q2."""
    open_q = [r for r in runs if r.id in asks and set(asks[r.id]) <= {"Q1", "Q2"} and r.driver_id]
    r1 = sorted((r for r in runs if codes.get(r.id) == "R1" and r.driver_id), key=lambda r: (order[r.id], r.id))
    if not open_q or not r1:
        return {}
    starter = r1[0].driver_id
    return {r.id: "Q1" if r.driver_id == starter else "Q2" for r in open_q}


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
    hints = {r.id: hint(r, marks.get(r.id)) for r in runs}
    timed = {k: w for k, w in windows.items() if k not in _clashing(windows)}
    allowed = {k: (hints[k][1],) if hints[k][1] else WANT.get(hints[k][0] or "", ()) for k in timed}
    h, verdicts = place(list(timed.items()), table, allowed) if timed else (0, {})
    out["offset_h"] = h
    codes_in = {c for c, _, _ in table}
    codes: dict[int, str] = {}
    order: dict[int, datetime] = {}
    asks: dict[int, list[str]] = {}
    for r in runs:
        m = marks.get(r.id)
        # by when its first lap began: two runs split from one log (one per driver) keep their order
        first = min((lap.start_s for lap in r.laps), default=0.0)
        order[r.id] = windows.get(r.id, (r.created_at.replace(tzinfo=None),))[0] + timedelta(seconds=first)
        if m is not None and m.answered and m.code:
            codes[r.id] = m.code
            continue
        kind, said = hints[r.id]
        verdict = verdicts.get(r.id)
        if said and (said in codes_in or kind == "test"):  # its names say which session (a test: which test)
            code, ask = said, []
        elif verdict and verdict[0] and (kind is None or verdict[0] == NONE or prefix(verdict[0]) in WANT[kind]):
            code, ask = verdict
        elif kind is None and verdict:
            code, ask = verdict
        else:
            t = windows[r.id][0] + timedelta(hours=h) if r.id in windows else None
            code, ask = _hinted(r, kind, t, table, rnd, number)
        if code is not None:
            codes[r.id] = code
        elif ask and looks_given(r, m):
            asks[r.id] = ask
    for rid, code in _by_driver(runs, codes, asks, order).items():
        codes[rid] = code
        del asks[rid]
    for r in runs:
        if r.id in asks:
            out["questions"].append({"session_id": r.id, "name": r.name,
                                     "starts": (windows[r.id][0] + timedelta(hours=h)).isoformat()
                                     if r.id in timed else None,
                                     "options": [{"code": c, "label": label(c)} for c in asks[r.id]]})
    by_code: dict[str, list[models.RunSession]] = {}
    for r in runs:
        if codes.get(r.id) and codes[r.id] != NONE:
            by_code.setdefault(codes[r.id], []).append(r)
    changed = False
    for code, group in by_code.items():
        group.sort(key=lambda r: (order[r.id], r.id))
        for i, r in enumerate(group, 1):
            want = run_name(code, i, len(group))
            m = marks.get(r.id)
            if not looks_given(r, m):
                continue
            if m is None:
                m = marks[r.id] = rm.RunNameMark(session_id=r.id)
                db.add(m)
            if r.name != want and not _folders(r)[0] and re.fullmatch(r"\d{1,3}([ _-]+\S+)?", _plain_name(r.name)):
                for f in r.files:  # the folder it came in goes with the name: what the run was, on later namings
                    f.meta = {**(f.meta or {}), "folder": _plain_name(r.name)}
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
