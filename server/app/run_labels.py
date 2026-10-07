"""Each run's name as the report shows it: the run's own name, the one the event page shows ("FP1 stint 1", "Q1",
"Race 1 stint 2", or the name the upload gave it until the official timetable names it), never a position.

- A run whose name is only a number ("1", "02", "1 (2)": the folder a zip held it in, like 01_PTS/1) takes the folder
  above it, else the logger's session name, in front: "PTS 1", "PTS 1 (2)".
- Runs of the same name are told apart by what differs between them: the day ("Day 2 · FP2 stint 1"), then the driver
  ("Q1 · Piana"), then the time the log started ("FP1 stint 1 · 10:42"); only runs alike in all of these are numbered
  as the importer numbers them ("FP1 stint 1 (2)").
- Each name has a short form for narrow places: "FP1 S1", "PT2 S1", "Q1", "R1 S2", "D2 FP2 S1", "Q1 PIA".
- The runs come in the event page's order (routers/events.py, _days): by day, then by the time the log started.
"""
from __future__ import annotations

import re
from collections import defaultdict
from collections.abc import Iterable
from dataclasses import dataclass

from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from app import models

NUMBER = re.compile(r"\d+(?: \(\d+\))?")  # "1", "02", "1 (2)"
ORDER_PREFIX = re.compile(r"^\d+[_\- ]+")  # "01_PTS" -> "PTS"


@dataclass(frozen=True)
class RunLabel:
    id: int
    name: str  # unique among the runs labelled together
    short: str  # the same in a few characters, for a chip, a cell or a chart
    stored: str  # the run's name as stored (what the event page shows)
    day: int | None  # the day of the event the log was recorded on (1, 2, ...), when it ran over more than one
    date: str | None  # ISO
    time: str | None  # HH:MM
    driver: str | None

    def out(self) -> dict:
        return {"id": self.id, "name": self.name, "short": self.short, "day": self.day, "date": self.date,
                "time": self.time, "driver": self.driver}


def _main_file(s: models.RunSession) -> models.LoggerFile | None:
    """The log the analysis reads: the longest (as reports._main_file)."""
    return max(s.files, key=lambda f: (f.meta or {}).get("duration_s", 0)) if s.files else None


def _when(s: models.RunSession) -> tuple[str | None, str | None]:
    """The day the run's log was recorded (ISO) and the time it started (HH:MM), as the event page reads them."""
    from app.routers.imports import _date  # here: the importer's routers import the reports, which import this

    f = _main_file(s)
    meta = (f.meta or {}) if f is not None else {}
    day = _date(meta.get("date") or "")
    t = (meta.get("time") or "").strip()[:5]
    return (day.isoformat() if day else None), (t or None)


def _natural(text: str) -> tuple:
    """As the event page sorts names (routers/events.py): "FP1 stint 2" before "FP1 stint 10"."""
    return tuple(int(p) if p.isdigit() else p.lower() for p in re.split(r"(\d+)", text))


def stored_name(s: models.RunSession) -> str:
    return s.name or f"Session {s.id}"


def base_name(s: models.RunSession) -> str:
    """The run's name, with the folder above it (or the logger's session name) in front when it is only a number."""
    name = stored_name(s).strip()
    if not NUMBER.fullmatch(name):
        return name
    f = _main_file(s)
    meta = (f.meta or {}) if f is not None else {}
    folders = [p for p in str(meta.get("folder") or "").split("/") if p]  # "Data/01_PTS/1": the run's is the last
    above = (ORDER_PREFIX.sub("", folders[-2]) or folders[-2]) if len(folders) >= 2 else ""
    context = above or str(meta.get("event_session") or "").strip()
    return f"{context} {name}" if context and not NUMBER.fullmatch(context) else f"Run {name}"


def short_name(name: str) -> str:
    """"FP1 stint 1" -> "FP1 S1", "Race 1 stint 2" -> "R1 S2", "Race 2" -> "R2", "Pre-qualifying" -> "PQ"."""
    out = re.sub(r"\bRace (\d+)", r"R\1", name)
    out = re.sub(r"\bQualifying (\d+)", r"Q\1", out)
    out = re.sub(r"\bstint (\d+)", r"S\1", out)
    return out.replace("Pre-qualifying", "PQ")


def driver_code(name: str) -> str:
    """"Gabriele Piana" -> "PIA"; a name of three or four letters stays as it is."""
    words = name.split()
    if not words:
        return name
    last = words[-1]
    return last if len(name) <= 4 else last[:3].upper()


def _key(s: models.RunSession, when: tuple[str | None, str | None]) -> tuple:
    """The event page's order: by day (runs without a log date last), then the time the log started, then name."""
    day, at = when
    return (day is None, day or "", at or "99:99", _natural(stored_name(s)), s.id)


def label_runs(sessions: Iterable[models.RunSession]) -> list[RunLabel]:
    """The runs labelled together (an event's), in the event page's order, each with a name unique among them."""
    rows = [(s, _when(s)) for s in sessions]
    rows.sort(key=lambda r: _key(*r))
    days = sorted({w[0] for _, w in rows if w[0]})
    day_of = {d: i + 1 for i, d in enumerate(days)} if len(days) > 1 else {}
    bases = {s.id: base_name(s) for s, _ in rows}
    drivers = {s.id: (s.driver.name.strip() if s.driver and s.driver.name else None) for s, _ in rows}

    groups: dict[str, list] = defaultdict(list)
    for s, w in rows:
        groups[bases[s.id]].append((s, w))
    parts: dict[int, dict] = {}
    for base, members in groups.items():
        alike = len(members) > 1
        by_day = alike and len({day_of.get(w[0]) for _, w in members}) > 1
        by_driver = alike and len({drivers[s.id] for s, _ in members}) > 1
        codes = {s.id: driver_code(drivers[s.id]) if drivers[s.id] else None for s, _ in members}
        if len(set(codes.values())) < len({drivers[s.id] for s, _ in members}):
            codes = {s.id: drivers[s.id] for s, _ in members}  # two drivers of the same initials: the names
        for s, w in members:
            parts[s.id] = {"base": base, "day": day_of.get(w[0]) if by_day else None,
                           "driver": drivers[s.id] if by_driver else None, "code": codes[s.id] if by_driver else None,
                           "time": None}
        # still alike in day and driver: the time the log started, when that tells them apart
        same: dict[tuple, list] = defaultdict(list)
        for s, w in members:
            same[(parts[s.id]["day"], parts[s.id]["driver"])].append((s, w))
        for group in same.values():
            if len(group) > 1 and len({w[1] for _, w in group}) > 1:
                for s, w in group:
                    parts[s.id]["time"] = w[1]

    named = []
    for s, _ in rows:
        p = parts[s.id]
        name = " · ".join(x for x in (f"Day {p['day']}" if p["day"] else None, p["base"], p["driver"], p["time"]) if x)
        short = " ".join(x for x in (f"D{p['day']}" if p["day"] else None, short_name(p["base"]), p["code"],
                                     p["time"]) if x)
        named.append((name, short))
    out, used, every = [], set(), {n for n, _ in named}
    for (s, (date, at)), (name, short) in zip(rows, named, strict=True):
        if name in used:  # alike in everything the runs say: numbered as the importer numbers them
            k = 2
            while f"{name} ({k})" in used or f"{name} ({k})" in every:
                k += 1
            name, short = f"{name} ({k})", f"{short} ({k})"
        used.add(name)
        out.append(RunLabel(s.id, name, short, stored_name(s), day_of.get(date), date, at, drivers[s.id]))
    return out


def renamed(labels: Iterable[RunLabel]) -> list:
    """For the signature of a kept page that names runs: the runs whose label isn't their stored name. Such pages
    called every run by its stored name before, so one whose runs all keep theirs is still right and isn't worked out
    again (nothing is added to its signature then)."""
    diff = sorted((lab.id, lab.name) for lab in labels if lab.name != lab.stored)
    return [diff] if diff else []


def event_runs(db: Session, s: models.RunSession) -> list[models.RunSession]:
    """The runs a run is labelled with: its event's, or itself when it is in no event."""
    if s.event_id is None:
        return [s]
    return list(db.scalars(select(models.RunSession).where(models.RunSession.event_id == s.event_id)
                           .options(selectinload(models.RunSession.files), selectinload(models.RunSession.driver)))
                .all())


def labels_for(db: Session, sessions: list[models.RunSession]) -> dict[int, RunLabel]:
    """These runs' labels, each among the runs of its event (so a run is called the same in its own report as in
    its event's)."""
    out: dict[int, RunLabel] = {}
    seen: set[int | None] = set()
    for s in sessions:
        if s.id in out:
            continue
        key = s.event_id if s.event_id is not None else -s.id
        if key in seen:
            continue
        seen.add(key)
        for lab in label_runs(event_runs(db, s)):
            out[lab.id] = lab
    return out
