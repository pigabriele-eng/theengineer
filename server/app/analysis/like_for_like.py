"""Like with like for two drivers' laps (the report's Drivers section, routers/report_drivers.py): each clean lap's time
taken to one tyre age and one fuel load, so a driver isn't quicker only for driving on newer tyres or with less fuel
(Gabriele, 2026-10-08: "the difference might be caused by tire degredation, fuel level or track condition").

- Tyres: a lap's age on its set is the laps on the set when its run started plus its number in the run. A race runs
  one set from start to finish (GT4 European and ADAC GT4, Gabriele, 2026-10-08), so a race's later stint carries on
  from the earlier stints' laps; its first stint is counted from the start of the race (its qualifying laps on the set
  are left out: the same for both drivers of one race). A run on a new set starts at none; a practice run on a set of
  unknown age can't be put on the same age, and then no lap is. The fade per lap on the set is the event's own:
  pooled over its long stints, fuel burn taken out (analysis/stint.py), else the track's figure from the team's notes
  (TRACK_FADE_PCT), else none.
- Fuel: what is burnt on each lap is the log's (analysis/fuel.py, its own estimate from full-throttle time where a log
  has no fuel channel), its cost per kilogram the stint analysis's (fuel.py mass_cost). What is in the tank isn't
  logged: every run starts full, but a race's later stints carry on from the earlier stints' fuel (no refuelling at the
  driver change: Gabriele, 2026-10-08, "tire and fuel stay as they are").
- Track grip between sessions can't be corrected: the drivers are compared in the sessions both drove, where there
  are any (the caller picks those runs).

Pure numbers in and out, so the tests run it on made-up laps.
"""
from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np

from app.analysis.stint import pooled_trend

LONG_STINT_LAPS = 8  # laps of a stint in its fit before its fade counts
# Tyre fade by track, % of lap time per 10 laps on one set with the fuel burn taken out (BMW M4 GT4 Evo, Pirelli DHG):
# /mnt/project-files/notes/tyre-degradation-by-track.md, worked out on 8 Oct 2026 from the team's logs. For a track
# whose own long stints can't measure it.
TRACK_FADE_PCT = {"monza": 0.0, "misano": 0.34, "hockenheim": 0.30, "paul ricard": 0.71, "zandvoort": 0.72,
                  "spa": 0.85}


@dataclass
class Run:
    """One run of the event, what the correction needs of it."""
    session_id: int
    part: str  # the official session it ran in ("R1", "04_R1")
    order: int  # its place in the event's order (by day, then the time its log started)
    kind: str  # "race", "qualifying" or "practice" (run_tyres.kind_of)
    tyres: str | None  # its tyre level: "new", "fresh", "used", "worn"
    set_laps: int | None  # laps on the set when it started, when known (run_tyres)
    laps: int  # every lap of its log, out and in laps too
    fuel: dict[int, float] = field(default_factory=dict)  # kg burnt on each lap, by lap number
    kg_per_lap: float | None = None  # its usual lap's
    s_per_kg: float | None = None  # what a kilogram on board costs a lap here
    fuel_source: str | None = None  # "log" or "estimate"


@dataclass
class Fade:
    per_lap: float  # seconds a lap loses for each lap on the set
    source: str  # "stints" (this event's) or "track" (the team's notes)
    stints: int = 0
    laps: int = 0


def fade_from_stints(stints: list[dict]) -> Fade | None:
    """The tyre fade per lap pooled over the event's long stints (the stint view's, analysis/stint.assemble): each
    stint's fitted laps' times with the fuel they had burnt put back, against their laps on the set. None when no
    long stint has fuel to take out. A car that got quicker through its stints (the track coming in) shows no fade."""
    groups = []
    for s in stints:
        rows = [r for r in s.get("laps", []) if r.get("in_fit") and r.get("corrected_time") is not None]
        if len(rows) >= LONG_STINT_LAPS:
            groups.append((np.array([r["tyre_lap"] for r in rows], float),
                           np.array([r["corrected_time"] for r in rows], float)))
    t = pooled_trend(groups)
    if t is None:
        return None
    return Fade(max(0.0, float(t["per_lap"])), "stints", int(t["stints"]), int(t["laps"]))


def fade_for_track(track: str | None, lap_time: float) -> Fade | None:
    """The track's fade from the team's notes, for a lap of this time."""
    name = (track or "").lower()
    pct = next((v for k, v in TRACK_FADE_PCT.items() if k in name), None)
    return None if pct is None else Fade(pct / 100 * lap_time / 10, "track")


def _bases(runs: list[Run]) -> dict[int, tuple[float | None, float]]:
    """Each run's tyre age (laps on its set) and fuel burnt (kg) when it started: a race's later stints carry on
    from its earlier ones."""
    out: dict[int, tuple[float | None, float]] = {}
    for r in sorted(runs, key=lambda r: r.order):
        if r.kind == "race":
            before = [x for x in runs if x.kind == "race" and x.part == r.part and x.order < r.order]
            age = float(sum(x.laps for x in before))
            burnt = float(sum(sum(x.fuel.values()) if x.fuel else (x.kg_per_lap or 0.0) * x.laps for x in before))
            out[r.session_id] = (age, burnt)
        elif r.tyres == "new":
            out[r.session_id] = (float(r.set_laps or 0), 0.0)
        else:
            out[r.session_id] = (None if r.set_laps is None else float(r.set_laps), 0.0)
    return out


@dataclass
class Corrected:
    times: list[float]  # each lap's time at the common age and load, in the order given
    ages: list[float | None]
    fuel: list[float]  # kg on board against a full tank (minus: burnt)
    tyres: bool  # corrected for tyre age
    fuel_done: bool  # corrected for fuel
    age_ref: float | None
    fuel_ref: float | None
    s_per_kg: float | None
    kg_per_lap: float | None
    fuel_source: str | None
    unknown_age: list[int]  # runs whose tyres' age isn't known


def correct(laps: list[tuple[int, int, float]], runs: list[Run], fade: Fade | None) -> Corrected:
    """laps: (session id, lap number, time) of the laps compared, both drivers'. Each lap taken to the median tyre
    age and the median fuel load of them all."""
    by_id = {r.session_id: r for r in runs}
    bases = _bases(runs)
    ages: list[float | None] = []
    fuel: list[float] = []
    for sid, number, _ in laps:
        r = by_id[sid]
        age0, burnt0 = bases[sid]
        ages.append(None if age0 is None else age0 + number)
        burnt = burnt0 + sum(r.fuel.get(n, r.kg_per_lap or 0.0) for n in range(1, number))
        fuel.append(-burnt)
    used = {sid for sid, _, _ in laps}
    unknown = sorted(sid for sid in used if bases[sid][0] is None)
    tyres = fade is not None and not unknown and bool(laps)
    age_ref = float(np.median([a for a in ages if a is not None])) if tyres else None
    rates = [by_id[s].s_per_kg for s in used if by_id[s].s_per_kg is not None]
    s_per_kg = float(np.median(rates)) if rates else None
    kgs = [by_id[s].kg_per_lap for s in used if by_id[s].kg_per_lap is not None]
    fuel_done = s_per_kg is not None and bool(laps) and all(by_id[s].kg_per_lap is not None or by_id[s].fuel
                                                            for s in used)
    fuel_ref = float(np.median(fuel)) if fuel_done else None
    out = []
    for (_, _, time), age, kg in zip(laps, ages, fuel, strict=True):
        t = time
        if tyres:
            t -= fade.per_lap * (age - age_ref)
        if fuel_done:
            t -= s_per_kg * (kg - fuel_ref)
        out.append(round(t, 3))
    sources = {by_id[s].fuel_source for s in used if by_id[s].fuel_source}
    return Corrected(out, ages, [round(f, 2) for f in fuel], tyres, fuel_done, age_ref, fuel_ref, s_per_kg,
                     float(np.median(kgs)) if kgs else None,
                     "estimate" if "estimate" in sources else ("log" if sources else None), unknown)


def words(c: Corrected, fade: Fade | None, races: bool) -> list[str]:
    """What was corrected and what wasn't, in a few short lines."""
    done, notes = [], []
    if c.tyres:
        where = (f"from this weekend's {fade.stints} long stints" if fade.source == "stints"
                 else "the track's figure from the team's notes")
        done.append(f"tyre age ({fade.per_lap:.2f} s per lap on the set, {where})")
    if c.fuel_done:
        done.append(f"fuel ({c.kg_per_lap:.1f} kg a lap, {10 * c.s_per_kg:.2f} s per 10 kg)")
    missing = ["track grip between sessions"]
    if not c.tyres:
        missing.insert(0, "tyre age (no tyre fade known here)" if fade is None
                       else "tyre age (how old some sets were isn't known)")
    if not c.fuel_done:
        missing.insert(0, "fuel (no fuel figures for these runs)")
    head = f"Corrected for {' and '.join(done)}. " if done else ""
    notes.append(f"{head}Not corrected: {', '.join(missing)}.")
    if c.fuel_done and races:
        notes.append("Every run taken to start full; a race's second stint carries on from the first stint's fuel "
                     "and tyres, as the series runs it (no refuelling or tyre change at the driver change).")
    elif c.fuel_done:
        notes.append("Every run taken to start full: what was in the tank isn't logged.")
    if c.fuel_done and c.fuel_source == "estimate":
        notes.append("Fuel estimated from the time at full throttle: no fuel channel in some of these logs.")
    elif not c.fuel_done and races and c.tyres:
        notes.append("A race's second stint runs on the first stint's tyres, as the series does.")
    return notes
