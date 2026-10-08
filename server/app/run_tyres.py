"""A run's tyres, New, Fresh, Used or Very used, so every page compares laps only with laps on similar tyres.

Gabriele (2026-10-08): qualifying is always on a new set with low fuel; the races run on the qualifying set, so
always Fresh, never New; in paid tests and practice a new set shows as a much quicker lap at the start of a run
(after a warm-up lap of heavy braking on the straights). The logs hold no tyre set, so each run is guessed from the
event's laps in the order they ran: a practice run that starts with a lap as quick as qualifying, or clearly quicker
than anything on the set before, or whose out lap has the warm-up's hard stops on the straights followed by a lap
quicker than the set's or near qualifying's, starts a new set; the runs after it on that set step down to Fresh,
Used and Very used as its laps add up. Before any new set is seen the set's age is unknown: Used, guessed. The
driver's pick (RunTyres, at upload or later with one tap) always wins, and a guess is shown as one, never taken
silently.
"""
from __future__ import annotations

import re
from dataclasses import dataclass

from sqlalchemy import select
from sqlalchemy.orm import Session

from app import models, warm_up

NEW, FRESH, USED, WORN = "new", "fresh", "used", "worn"  # stored as these (RunTyres.tyres, 8 characters)
LEVELS = (NEW, FRESH, USED, WORN)
LABEL = {NEW: "New", FRESH: "Fresh", USED: "Used", WORN: "Very used"}
FRESH_UNDER = 10  # laps already on the set when the run starts: under 10 Fresh...
USED_UNDER = 25  # ...under 25 Used, 25 or more Very used
NEW_WITHIN = 0.004  # a run's early lap within this share of qualifying's best: a new set...
NEW_GAIN = 0.004  # ...or this share quicker than any lap on the set before
EARLY_LAPS = 3  # "at the start of a run": its first three laps
WARM_UP_STOPS = 2  # hard stops on the straights of the out lap (warm_up.py): the warm-up for a new set...
WARM_UP_LAPS = 4  # ...then, in the run's first four laps, a lap quicker than any on the set before...
WARM_UP_WITHIN = 0.01  # ...or within this share of qualifying's best
ORDER_PREFIX = re.compile(r"^\d+[_\- ]+")  # a folder's order in front of its name: "03_Q" -> "Q"
QUALI_NAME = re.compile(r"^(q\d*|qualifying|quali)\b", re.I)
RACE_NAME = re.compile(r"^(r\d*|race)\b", re.I)


def pair(level: str) -> str:
    """New or not: the two-way view of the technique check and the Laps tab (qualifying's grip kept apart)."""
    return NEW if level == NEW else USED


@dataclass
class RunLaps:
    """What the guess reads of a run: its kind (SessionKind), its name, its clean laps' times and, when known, their
    lap numbers and how many laps the run did in all (out and in laps too: the set's mileage)."""
    session_id: int
    kind: str
    name: str | None
    times: list[float]
    numbers: list[int] | None = None
    laps: int | None = None
    warm_up: int | None = None  # hard stops on the straights of its out lap (warm_up.py); None: not counted
    driver: str | None = None  # who drove it: pace is measured against their own laps only


def kind_of(kind: str, name: str | None) -> str:
    """qualifying, race or practice (tests too), from the run's kind or, where that was left as a test, its name (a
    folder's order in front of it left out: "03_Q", "04_R1")."""
    if kind in ("qualifying", "race"):
        return kind
    text = ORDER_PREFIX.sub("", (name or "").strip())
    if QUALI_NAME.match(text):
        return "qualifying"
    if RACE_NAME.match(text):
        return "race"
    return "practice"


def _out(level: str, sure: bool, why: str, on_set: int | None = None) -> dict:
    return {"tyres": level, "label": LABEL[level], "pair": pair(level), "sure": sure, "why": why, "set_laps": on_set}


def _step(on_set: int) -> str:
    return FRESH if on_set < FRESH_UNDER else USED if on_set < USED_UNDER else WORN


def guess(runs: list[RunLaps]) -> dict[int, dict]:
    """Each run's tyres by session id, the runs given in the order they ran (an event's): {"tyres": level, "label",
    "pair": new|used, "sure", "why", "set_laps": laps on the set when the run started, when known}.

    Pace is only ever measured against the driver on the tyres (Gabriele: two drivers can be far apart): a lap against
    that driver's own qualifying best and their own laps on the set before. The set's laps add up whoever drove
    them."""
    kinds = {r.session_id: kind_of(r.kind, r.name) for r in runs}
    quali = [min(r.times) for r in runs if kinds[r.session_id] == "qualifying" and r.times]
    q_all = min(quali) if quali else None
    # each driver's own qualifying best; a driver who didn't qualify has none (their own quickest lap would only
    # measure a run against itself): their runs go by their own laps on the set before
    refs: dict[str | None, float | None] = {}
    for d in {r.driver for r in runs if r.driver is not None}:
        q = [min(r.times) for r in runs if r.driver == d and r.times and kinds[r.session_id] == "qualifying"]
        refs[d] = min(q) if q else None
    out: dict[int, dict] = {}
    on_set: int | None = None  # laps on the practice set so far; None: its age unknown
    set_best: dict[str | None, float] = {}  # each driver's quickest lap on it (its age unknown: in practice so far)
    seen = 0  # laps on it seen here, whoever drove them (its age unknown: in practice so far)
    for r in runs:
        k = kinds[r.session_id]
        if k == "qualifying":
            out[r.session_id] = _out(NEW, True, "qualifying: always a new set")
            continue
        if k == "race":
            out[r.session_id] = _out(FRESH, True, "race: on the qualifying set")
            continue
        ref = refs.get(r.driver) if r.driver is not None else q_all
        own = set_best.get(r.driver)
        numbers = r.numbers if r.numbers is not None else list(range(1, len(r.times) + 1))
        early = [t for n, t in zip(numbers, r.times, strict=False) if n <= EARLY_LAPS]
        quick = min(early) if early else None
        as_quali = (quick is not None and ref is not None and quick <= ref * (1 + NEW_WITHIN)
                    and (on_set is None or on_set >= FRESH_UNDER))  # a run as quick on a set still fresh stays on it
        # quicker than the driver's own laps on the set so far, once it has done enough laps that the track's own
        # grip coming up through the first runs isn't taken for a new set
        beats_set = (quick is not None and own is not None and seen >= FRESH_UNDER
                     and quick <= own * (1 - NEW_GAIN))
        # the warm-up (hard stops on the straights of the out lap), then a quick lap early in the run
        warm = [t for n, t in zip(numbers, r.times, strict=False) if n <= WARM_UP_LAPS]
        after_warm_up = (r.warm_up is not None and r.warm_up >= WARM_UP_STOPS and bool(warm)
                         and ((ref is not None and min(warm) <= ref * (1 + WARM_UP_WITHIN))
                              or (own is not None and min(warm) < own)))
        done = r.laps if r.laps is not None else len(r.times) + 2  # its out and in laps too
        whose = f"{r.driver}'s " if r.driver else ""
        if as_quali or beats_set or after_warm_up:
            why = (f"a lap at the start of the run as quick as {whose}qualifying" if as_quali
                   else (f"a lap at the start of the run clearly quicker than {whose}laps on the set before" if r.driver
                    else "a lap at the start of the run clearly quicker than any on the set before")
                   if beats_set else
                   f"the warm-up on the out lap ({r.warm_up} hard stops on the straights), then a quick lap")
            out[r.session_id] = _out(NEW, False, why, 0)
            on_set, seen = done, done
            set_best = {r.driver: min(r.times)} if r.times else {}
            continue
        if on_set is None:
            out[r.session_id] = _out(USED, False, "no new set seen before it: how old the set is isn't known")
        else:
            out[r.session_id] = _out(_step(on_set), False, f"{on_set} laps on the set before this run", on_set)
            on_set += done
        seen += done
        if r.times:
            set_best[r.driver] = min(r.times) if own is None else min(own, min(r.times))
    return out


def stored(db: Session, session_ids: list[int]) -> dict[int, str]:
    """The tyres the driver set, by session id."""
    if not session_ids:
        return {}
    return {r.session_id: r.tyres for r in db.scalars(select(models.RunTyres).where(
        models.RunTyres.session_id.in_(session_ids)))}


def resolve(db: Session, runs: list[RunLaps]) -> dict[int, dict]:
    """Each run's tyres: the driver's where set (sure), else the guess."""
    out = guess(runs)
    for sid, tyres in stored(db, [r.session_id for r in runs]).items():
        if sid in out and tyres in LABEL:
            out[sid] = {**_out(tyres, True, "set by you"), "guess": out[sid]["tyres"]}
    return out


def event_runs(db: Session, sessions: list[models.RunSession]) -> list[list[RunLaps]]:
    """Every run of these runs' events, an event at a time, in the order they ran (as the event page lists them)."""
    from app import run_labels  # here: run_labels reaches the importer, which reaches the reports

    out: list[list[RunLaps]] = []
    seen: set[int] = set()
    for s in sessions:
        if s.id in seen:
            continue
        group = run_labels.event_runs(db, s)
        by_id = {x.id: x for x in group}
        runs = []
        for lab in run_labels.label_runs(group):
            x = by_id[lab.id]
            seen.add(x.id)
            f = run_labels._main_file(x)
            laps = sorted((lap for lap in x.laps if f is not None and lap.file_id == f.id), key=lambda lap: lap.number)
            clean = [lap for lap in laps if lap.clean]
            runs.append(RunLaps(x.id, x.kind.value, x.name, [float(lap.time_s) for lap in clean],
                                [lap.number for lap in clean], len(laps), warm_up.of(x),
                                x.driver.name if x.driver else None))
        out.append(runs)
    return out


def for_runs(db: Session, sessions: list[models.RunSession]) -> dict[int, dict]:
    """These runs' tyres and every other run's of their events: the driver's, else guessed among the event's runs in
    the order they ran."""
    out: dict[int, dict] = {}
    for runs in event_runs(db, sessions):
        out.update(resolve(db, runs))
    return out


def set_tyres(db: Session, session_id: int, tyres: str) -> None:
    row = db.scalar(select(models.RunTyres).where(models.RunTyres.session_id == session_id))
    if row is None:
        db.add(models.RunTyres(session_id=session_id, tyres=tyres))
    else:
        row.tyres = tyres
    db.commit()
