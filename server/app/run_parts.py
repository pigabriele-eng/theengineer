"""An event's runs by the official session they ran in ("FP1", "Q1", "R1", "PT2"): the parts of a weekend, each with
a report of its own (routers/reports.py, scope "part:<event id>:<code>").

A run's session is the timetable code its name starts with: the official timetable names runs "FP1 stint 1",
"PT1 stint 2", "Q1", "R1 stint 2", "Pre-qualifying stint 1" (results/run_names.py), so they are FP1, PT1, Q1, R1, PQ.
A run whose name isn't a timetable name (a log folder like "03_Q", a name typed by hand) is a session of its own name
as the report calls it without the importer's numbering (run_labels.base_name, then " (2)" dropped): "03_Q" and
"03_Q (2)" are one session "03_Q", "PTS 1" and "PTS 1 (2)" one session "PTS 1". Such a name met on more than one day
of the event is a session per day ("Day 2 · PTS 1"), as the labels tell those runs apart.

The sessions come in the order they ran: by their first run in the event page's order (by day, then the time the log
started), which is the timetable's order whatever the series (ADAC runs Q1, R1, Q2, R2).
"""
from __future__ import annotations

import re
from collections.abc import Iterable
from dataclasses import dataclass, field

from app import models, run_labels

TIMETABLE = re.compile(r"^(?:(?:FP|PT|Q|R)\d+|PQ)\b")  # on the short form: "Race 1 stint 2" is "R1 S2"
NUMBERED = re.compile(r"\s*\(\d+\)$")  # the importer's " (2)" for a second run of the same name


@dataclass
class Part:
    code: str  # "FP1", "Q1", "PQ", "03_Q", "Day 2 · PTS 1": unique in the event
    title: str  # "FP1", "Pre-qualifying", "03_Q"
    official: bool  # named after the official timetable
    runs: list[run_labels.RunLabel] = field(default_factory=list)  # in the event page's order

    @property
    def ids(self) -> list[int]:
        return [lab.id for lab in self.runs]


def code_of(name: str) -> tuple[str, bool]:
    """The session a run's base name (run_labels.base_name) says: (code, whether it is an official one)."""
    m = TIMETABLE.match(run_labels.short_name(name.strip()))
    if m:
        return m.group(0), True
    return NUMBERED.sub("", name.strip()) or name.strip(), False


def title_of(code: str) -> str:
    return "Pre-qualifying" if code == "PQ" else code


def parts(sessions: Iterable[models.RunSession], labels: list[run_labels.RunLabel]) -> list[Part]:
    """The event's sessions (``labels``: its runs' labels, run_labels.label_runs), in the order they ran."""
    by_id = {s.id: s for s in sessions}
    found: dict[str, tuple[bool, list[run_labels.RunLabel]]] = {}
    for lab in labels:  # in the event page's order
        s = by_id.get(lab.id)
        if s is None:
            continue
        code, official = code_of(run_labels.base_name(s))
        found.setdefault(code, (official, []))[1].append(lab)
    out: list[Part] = []
    for code, (official, runs) in found.items():
        days = list(dict.fromkeys(lab.day for lab in runs))
        if official or len(days) < 2:
            out.append(Part(code, title_of(code), official, runs))
            continue
        for day in days:  # the same folder name on two days: two sessions
            name = f"Day {day} · {code}" if day else code
            out.append(Part(name, name, False, [lab for lab in runs if lab.day == day]))
    order = {lab.id: k for k, lab in enumerate(labels)}
    out.sort(key=lambda p: order[p.runs[0].id])
    return out


def find(found: list[Part], code: str) -> Part | None:
    return next((p for p in found if p.code == code), None)
