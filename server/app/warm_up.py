"""The warm-up before a new set of tyres: hard stops on the straights of the out lap.

Gabriele (2026-10-08): a new set "normally is a much faster lap starting a new run ... after a 'warm up' procedure
where there is a lot of braking in a straight line where normally the car drives flat out". A flying lap brakes only
for corners, so a hard stop at speed with the wheel straight before, during and for three seconds after it is the
warm-up's mark. Counted on each run's out lap (the log before its first lap starts), kept in its log's meta
(``warm_up_stops``) so it is read once per log, and read by run_tyres.py's guess.
"""
from __future__ import annotations

import logging

import numpy as np
from sqlalchemy import select
from sqlalchemy.orm import Session

from app import heavy, models
from app.analysis.laps import MASTER_HZ, load_session

log = logging.getLogger(__name__)

KEY = "warm_up_stops"
HARD = 0.35  # brake past this share of the log's hardest braking...
MIN_S = 0.2  # ...for this long...
MIN_KMH = 90  # ...from this speed...
STRAIGHT = 0.15  # ...with the wheel within this share of the log's biggest steering
AFTER_S = 3.0  # from a second before the stop to this long after it (a corner's braking turns in by then)
OUT_LAP_S = 30  # a log whose first lap starts this soon has its out lap as that first lap


def stops(brake: np.ndarray, speed: np.ndarray, steer: np.ndarray, hard: float, wheel: float) -> int:
    """How many hard stops at speed with the wheel straight these samples hold (100 Hz)."""
    on = brake > HARD * hard
    n, i, count = len(on), 0, 0
    while i < n:
        if not on[i]:
            i += 1
            continue
        j = i
        while j < n and on[j]:
            j += 1
        around = np.abs(steer[max(0, i - MASTER_HZ):min(n, j + int(AFTER_S * MASTER_HZ))])
        if (j - i) / MASTER_HZ >= MIN_S and speed[i] > MIN_KMH and around.size and around.max() < STRAIGHT * wheel:
            count += 1
        i = j
    return count


def out_lap_stops(ld, beacons: list[float] | None = None) -> int | None:
    """The hard straight-line stops on the log's out lap; None when it can't tell (no brake or steering channel, no
    laps)."""
    sd = load_session(ld, beacons=beacons, roles=("speed", "brake", "steer"))
    if "brake" not in sd.channels or "steer" not in sd.channels or not sd.laps:
        return None
    brake, steer, speed = sd.channels["brake"], sd.channels["steer"], sd.channels["speed"]
    hard = float(np.nanpercentile(brake, 99.5))
    wheel = float(np.nanpercentile(np.abs(steer), 99))
    if not hard > 0 or not wheel > 0:
        return None
    first = sd.laps[0]
    end = int((first.start if first.start > OUT_LAP_S else first.end) * MASTER_HZ)
    return stops(np.nan_to_num(brake[:end]), np.nan_to_num(speed[:end]), np.nan_to_num(steer[:end]), hard, wheel)


def _main_file(s: models.RunSession) -> models.LoggerFile | None:
    return max(s.files, key=lambda f: (f.meta or {}).get("duration_s", 0)) if s.files else None


def of(s: models.RunSession) -> int | None:
    """The run's warm-up stops as counted (None: not counted yet, or can't tell)."""
    f = _main_file(s)
    return (f.meta or {}).get(KEY) if f is not None else None


def uncounted(sessions: list[models.RunSession]) -> list[models.RunSession]:
    """The runs with a log whose out lap hasn't been looked at yet."""
    return [s for s in sessions if (f := _main_file(s)) is not None and KEY not in (f.meta or {})]


def ensure(db: Session, sessions: list[models.RunSession]) -> int:
    """Count the out-lap stops of the runs whose logs haven't been counted yet (one log at a time, under the heavy
    lock); how many were counted."""
    from app.routers.sessions import read_file  # here: the routers import run_tyres, which reads this

    done = 0
    for s in sessions:
        f = _main_file(s)
        if f is None or KEY in (f.meta or {}):
            continue
        value = None
        with heavy.lock:
            try:
                ld = read_file(f)
                value = out_lap_stops(ld, (f.meta or {}).get("beacons"))
                del ld
            except Exception as e:  # a log it can't read is left uncounted, never in the way of the report
                log.warning("Couldn't count the warm-up stops of session %s: %s", s.id, e)
            finally:
                heavy.release_memory()
            # the log's meta as it is now, with the count, written under the lock: a re-timing (timing.py) reads,
            # changes and writes the meta under it too, so neither writes back what the other replaced
            f = db.scalars(select(models.LoggerFile).where(models.LoggerFile.id == f.id)
                           .execution_options(populate_existing=True)).first()
            if f is None:
                continue
            f.meta = {**(f.meta or {}), KEY: value}
            db.commit()
        done += 1
    return done
