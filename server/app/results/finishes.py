"""Our car's official finishes for many events at once (the home list): its race results (R1, R2...) and qualifying
results (Q1, Q2...) in each event's linked round, read from the stored results only.

Each event's round and car are the ones its results overview last matched (``EventRound``, written whenever the
overview runs: for every event on server start and daily). Our car in a round is that car number; when that number
isn't in the round (it changes from season to season), the car of our driver: the surname shared by our car's crews
in the other events."""
from __future__ import annotations

import re
from collections import Counter

from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from app.results import models as rm
from app.results.predict import _surname
from app.results.run_names import label
from app.results.summary import _num


def _row(car: rm.ResultRow, s: rm.ResultSession) -> dict:
    mates = sorted((r for r in s.rows if r.car_class == car.car_class and r.position is not None),
                   key=lambda r: r.position)
    return {"code": s.code, "label": label(s.code), "position": car.position, "class": car.car_class,
            "class_position": next((i for i, r in enumerate(mates, 1) if r is car), None) if car.car_class else None,
            "status": car.status, "car_number": car.car_number}


def finishes(db: Session, event_ids: list[int] | None = None) -> dict:
    q = select(rm.EventRound)
    if event_ids is not None:
        q = q.where(rm.EventRound.event_id.in_(event_ids))
    links = db.scalars(q).all()
    keys = {(lk.series, lk.year, lk.round_id) for lk in links}
    rounds = {}
    if keys:
        found = db.scalars(select(rm.ResultRound)
                           .where(rm.ResultRound.series.in_({k[0] for k in keys}),
                                  rm.ResultRound.year.in_({k[1] for k in keys}),
                                  rm.ResultRound.round_id.in_({k[2] for k in keys}))
                           .options(selectinload(rm.ResultRound.sessions).selectinload(rm.ResultSession.rows))).all()
        rounds = {(r.series, r.year, r.round_id): r for r in found}

    def by_number(rnd: rm.ResultRound, n: str | None) -> dict[str, rm.ResultRow]:
        return {s.code: c for s in rnd.sessions for c in s.rows if n and _num(c.car_number) == _num(n)}

    # our driver: the surname most often in our car's crews across the linked rounds
    crews: Counter[str] = Counter()
    for lk in links:
        if (rnd := rounds.get((lk.series, lk.year, lk.round_id))) is not None:
            for c in by_number(rnd, lk.car_number).values():
                crews.update({_surname(d) for d in c.drivers or []} - {""})
    driver = crews.most_common(1)[0][0] if crews else None

    out: dict = {}
    for lk in links:
        rnd = rounds.get((lk.series, lk.year, lk.round_id))
        if rnd is None:
            continue
        cars = by_number(rnd, lk.car_number)
        if not cars and driver:
            cars = {s.code: c for s in rnd.sessions for c in s.rows
                    if driver in {_surname(d) for d in c.drivers or []}}
        races, qualis = [], []
        for s in sorted(rnd.sessions, key=lambda s: (s.starts_at or "", s.code)):
            if s.code in cars and re.fullmatch(r"R\d*", s.code):
                races.append(_row(cars[s.code], s))
            elif s.code in cars and re.fullmatch(r"Q\d*", s.code):
                qualis.append(_row(cars[s.code], s))
        if races or qualis:
            out[str(lk.event_id)] = {"races": races, "qualifying": qualis}
    return {"events": {k: v["races"] for k, v in out.items() if v["races"]},
            "qualifying": {k: v["qualifying"] for k, v in out.items() if v["qualifying"]}}
