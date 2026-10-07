"""A run's tyres, new or used, so the mistake detector and the best real passes compare like with like.

Qualifying is always on new tyres with low fuel, and the races run on the qualifying set: a theoretical race lap
built from qualifying grip is no use. Paid tests and free practice run new tyres sometimes. So every lap is checked
only against laps on the same tyres: qualifying is new and a race used, for sure; a test or practice run is guessed
from its laps (a short run as quick as qualifying was on new tyres, anything else, or any run of an event with no
qualifying, on used ones) until the driver says which (RunTyres), and the guess is shown as one, never taken silently.
"""
from __future__ import annotations

import re
from dataclasses import dataclass

from sqlalchemy import select
from sqlalchemy.orm import Session

from app import models

NEW, USED = "new", "used"
NEW_WITHIN = 0.004  # a test or practice run whose best lap is within this share of qualifying's best...
SHORT_RUN = 3  # ...in this many clean laps or fewer: new tyres (a qualifying run); anything else used
QUALI_NAME = re.compile(r"^(q\d*|qualifying|quali)\b", re.I)
RACE_NAME = re.compile(r"^(r\d*|race)\b", re.I)


@dataclass
class RunLaps:
    """What the guess reads of a run: its kind (SessionKind), its name and its clean laps' times."""
    session_id: int
    kind: str
    name: str | None
    times: list[float]


def kind_of(kind: str, name: str | None) -> str:
    """qualifying, race or practice (tests too), from the run's kind or, where that was left as a test, its name."""
    if kind in ("qualifying", "race"):
        return kind
    if name and QUALI_NAME.match(name.strip()):
        return "qualifying"
    if name and RACE_NAME.match(name.strip()):
        return "race"
    return "practice"


def guess(runs: list[RunLaps]) -> dict[int, dict]:
    """Each run's tyres by session id: {"tyres": new|used, "sure": bool, "why": ...}."""
    kinds = {r.session_id: kind_of(r.kind, r.name) for r in runs}
    # with no qualifying to measure against (a test day), every run is guessed on the same tyres until the driver says
    quali = [min(r.times) for r in runs if kinds[r.session_id] == "qualifying" and r.times]
    best = min(quali) if quali else None
    out = {}
    for r in runs:
        k = kinds[r.session_id]
        if k == "qualifying":
            out[r.session_id] = {"tyres": NEW, "sure": True, "why": "qualifying: new tyres, low fuel"}
        elif k == "race":
            out[r.session_id] = {"tyres": USED, "sure": True, "why": "race: the qualifying set"}
        elif best is not None and r.times and min(r.times) <= best * (1 + NEW_WITHIN) and len(r.times) <= SHORT_RUN:
            out[r.session_id] = {"tyres": NEW, "sure": False,
                                 "why": f"a short run ({len(r.times)} clean lap{'s' if len(r.times) > 1 else ''}) "
                                        "as quick as qualifying"}
        else:
            out[r.session_id] = {"tyres": USED, "sure": False,
                                 "why": "no qualifying to compare with" if best is None
                                 else "not as quick as qualifying" if r.times and min(r.times) > best * (1 + NEW_WITHIN)
                                 else "a long run"}
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
        if sid in out:
            out[sid] = {"tyres": tyres, "sure": True, "why": "set by you"}
    return out


def set_tyres(db: Session, session_id: int, tyres: str) -> None:
    row = db.scalar(select(models.RunTyres).where(models.RunTyres.session_id == session_id))
    if row is None:
        db.add(models.RunTyres(session_id=session_id, tyres=tyres))
    else:
        row.tyres = tyres
    db.commit()
