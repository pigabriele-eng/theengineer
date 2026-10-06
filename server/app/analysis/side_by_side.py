"""Sessions of one event side by side, worked out from their compact lap traces (analysis/compact.py): no log is
opened, so it answers in a moment and needs a few MB.

The sections are the report's: the track's official corner numbers on the reference lap (the quickest clean lap
of the sessions it is given), split where the speed trace has its fast points. Every clean lap of each session is
placed on the reference line the way the report places it, and timed through each section. Per session it keeps
small numbers only: each section's best time, the lap those best sections add up to, the top speed, and the tyre
and condition medians the traces keep.
"""
from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np

from app.analysis import compact
from app.analysis.event import CONDITIONS
from app.analysis.laps import CornerSpec, Section, make_sections

# the condition channels worth seeing next to lap times (labels as in analysis/event.py), median of the clean laps
CONDITION_LABELS = ("Ambient temp", "Brake balance")
TYRE_WHEELS = ("fl", "fr", "rl", "rr")


@dataclass
class Reference:
    """The line every session is placed on and the sections it is split into."""
    session_id: int
    lap: int
    time: float
    line: object  # compact.TrackLine | None
    length: int
    sections: list[Section]
    numbering: str


@dataclass
class SessionSummary:
    session_id: int
    sections: list[float | None]  # each section's best time over the session's clean laps
    section_laps: list[int | None]  # the lap each best section time came from
    top_speed: float | None  # km/h, the highest over its clean laps
    tyres: dict[str, dict[str, float]] = field(default_factory=dict)  # "pressure"/"temp" -> wheel -> median
    tyre_units: dict[str, str] = field(default_factory=dict)
    conditions: list[dict] = field(default_factory=list)  # [{"label", "unit", "value"}]


def reference_of(session_id: int, cs: compact.CompactSession, corners: list[CornerSpec] | None) -> Reference:
    """The session's quickest clean lap as the reference: its line, and the report's sections on it."""
    i = int(np.argmin(cs.times))
    speed = cs.traces["speed"][i, cs.pad:cs.pad + cs.length + 1].astype(float)
    sections, numbering = make_sections({"speed": speed}, corners)
    return Reference(session_id, int(cs.numbers[i]), float(cs.times[i]), cs.line, cs.length, sections, numbering)


def summarise(session_id: int, cs: compact.CompactSession, ref: Reference) -> SessionSummary:
    """One session's clean laps on the reference line, reduced to its best section times and medians."""
    if not cs.n_laps:
        return SessionSummary(session_id, [None] * len(ref.sections), [None] * len(ref.sections), None)
    j = compact.positions_on(cs, ref.line, ref.length) + cs.pad
    base = np.arange(cs.traces["t"].shape[1], dtype=float)
    starts = np.array([s.start for s in ref.sections])
    ends = np.array([s.end for s in ref.sections])
    times = np.empty((cs.n_laps, len(ref.sections)))
    for i in range(cs.n_laps):
        t = np.interp(j, base, cs.traces["t"][i])
        times[i] = t[ends] - t[starts]
    times[~np.isfinite(times)] = np.inf  # a lap that can't be timed through a section doesn't count there
    best = np.argmin(times, axis=0)
    speed = cs.traces["speed"][:, cs.pad:cs.pad + cs.length + 1]
    top = float(np.max(speed[np.isfinite(speed)])) if np.isfinite(speed).any() else None
    out = SessionSummary(
        session_id,
        [round(float(times[b, k]), 3) if np.isfinite(times[b, k]) else None for k, b in enumerate(best)],
        [int(cs.numbers[b]) if np.isfinite(times[b, k]) else None for k, b in enumerate(best)],
        round(top, 1) if top is not None else None,
    )
    for kind, key in (("pressure", "p"), ("temp", "t")):
        wheels = {}
        for w in TYRE_WHEELS:
            v = cs.tyres.get(f"tyre_{key}_{w}")
            if v is not None and np.isfinite(v).any():
                wheels[w] = round(float(np.nanmedian(v)), 2 if kind == "pressure" else 1)
                out.tyre_units[kind] = cs.units.get(f"tyre_{key}_{w}", "")
        if wheels:
            out.tyres[kind] = wheels
    for label, unit, names, _ in CONDITIONS:
        if label not in CONDITION_LABELS:
            continue
        name = next((n for n in names if n in cs.channels), None)
        if name is None:
            continue
        med = cs.channels[name][1]
        if np.isfinite(med).any():
            out.conditions.append({"label": label, "unit": unit, "value": round(float(np.nanmedian(med)), 1)})
    return out


def best_index(values: list[float | None]) -> int | None:
    """Where the quickest of the values is, among those known."""
    known = [(v, i) for i, v in enumerate(values) if v is not None]
    return min(known)[1] if known else None
