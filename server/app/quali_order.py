"""Who drove qualifying and the races, from the series' qualifying order (Gabriele, 2026-10-09: "The driving style
between SYL and PIA is apparently too similar for the app to recognize. ADAC GT4 Q1 always PIA, Q2 always SYL", and
"Hockenheimring 2026 is special event with 1 free practice, 3 qualifying sessions Q1/Q3 PIA and Q2 SYL and 3 races
R1/R3 PIA starts, R2 SYL starts").

Each driver has a qualifying of their own (results/run_names.py names the runs Q1 and Q2, one per driver), and the
Q1 driver starts Race 1, the Q2 driver Race 2 (as the official results of the app's 2026 GT4 European weekends
show, and as run_names.py already names the runs). So in an event where the order is known, the runs named Q1 get
the Q1 driver, Q2 the Q2 driver, R1 stint 1 and R2 stint 2 the Q1 driver, R1 stint 2 and R2 stint 1 the Q2 driver.
With a third of each (Hockenheim 2026) the order goes round again: Q3 is the Q1 driver's, who also starts Race 3.

Drivers set this way are the app's (driver_prints.StyleTag, source "quali" or "race": "Driver set from the
qualifying order", with a way to change it), but unlike a guess they teach the fingerprints and anchor the driving
style of the event's other runs (driver_prints.tags_of), the way a person's pick does: they come from what Gabriele
said, not from the style. A person's pick, change or clear always stands. A run renamed out of Q1, Q2 or a race stint
goes back to the driving style.

The order is known for an ADAC GT4 Germany event (its season's series, else its name or its official results)
whose drivers are PIA and SYL: the event's own driver list, else its season's, else the drivers the garage has in
its car, else every driver.
"""
from __future__ import annotations

import re

from sqlalchemy import select
from sqlalchemy.orm import Session

from app import models

SAID = {"adac": ("PIA", "SYL")}  # series (run_tyres.new_set_rule) -> (Q1 driver's code, Q2 driver's code)
SOURCES = ("quali", "race")  # driver_prints.StyleTag sources of a driver set here
Q = re.compile(r"^\s*(?:q|quali(?:fying)?)\s*([1-9])\b", re.I)
R = re.compile(r"^\s*(?:r|race)\s*([1-9])\b", re.I)
CODE = re.compile(r"(Q|R)([1-9])")
STINT = re.compile(r"\bstint\s*(\d)\b", re.I)


def _series(db: Session, event_id: int) -> str | None:
    """The event's series as run_tyres knows it ("adac" for ADAC GT4 Germany and its Sachsenring round)."""
    from app import run_tyres, seasons
    from app.results import adac
    from app.results import models as rm

    ev = db.get(models.Event, event_id)
    if ev is None:
        return None
    season, _ = seasons.season_of_event(db, event_id, seasons.own_info(db, event_id))
    link = db.scalar(select(rm.EventResultLink).where(rm.EventResultLink.event_id == event_id))
    texts = [(season.series, season.name)] if season is not None else []
    texts += [(link.series if link is not None else None, None), (ev.series, ev.name)]
    for series, name in texts:
        if series == adac.SERIES:
            return "adac"
        rule = run_tyres.new_set_rule(series, name)
        if rule is not None:
            return "adac" if rule.startswith("adac") else rule
    return None


def order_for(db: Session, event_id: int) -> tuple[int, int] | None:
    """(the Q1 driver's id, the Q2 driver's id) of the event, when known."""
    from app import driver_prints
    from app.run_labels import driver_code

    said = SAID.get(_series(db, event_id) or "")
    if said is None:
        return None
    pool = (driver_prints.entry_drivers(db, event_id) or driver_prints._car_drivers(db, event_id)
            or list(db.scalars(select(models.Driver.id).order_by(models.Driver.id))))
    names = dict(db.execute(select(models.Driver.id, models.Driver.name).where(models.Driver.id.in_(pool))).all())
    found = []
    for code in said:
        ids = [i for i in pool if i in names and driver_code(names[i]).upper() == code]
        if len(ids) != 1:
            return None
        found.append(ids[0])
    return (found[0], found[1]) if found[0] != found[1] else None


def session_of(run: models.RunSession, mark) -> tuple[str | None, int | None]:
    """The run's official session ("Q1", "R2"; from its naming, else its name) and its stint in a race."""
    name = run.name or ""
    code = None
    if mark is not None and mark.code and mark.code != "none" and not mark.by_hand:
        code = mark.code
    elif (m := Q.match(name)) is not None:
        code = f"Q{m.group(1)}"
    elif (m := R.match(name)) is not None:
        code = f"R{m.group(1)}"
    elif mark is not None and mark.code and mark.code != "none":
        code = mark.code
    stint = STINT.search(name)
    return code, int(stint.group(1)) if stint else None


def first_driver(code: str | None, order: tuple[int, int]) -> int | None:
    """The driver of a qualifying ("Q3"), or who starts a race ("R2"): the order's first driver in the odd ones, its
    second in the even ones."""
    m = CODE.fullmatch(code or "")
    return (order[0] if int(m.group(2)) % 2 else order[1]) if m else None


def driver_of(code: str | None, stint: int | None, order: tuple[int, int]) -> tuple[int, str] | None:
    """(driver, source) the order gives a run of that session and stint: a qualifying's driver (first_driver); a
    race's starter in its first stint, the other driver after the stop."""
    d = first_driver(code, order)
    if d is None:
        return None
    if code.startswith("Q"):
        return d, "quali"
    if stint in (1, 2):
        return (d if stint == 1 else order[1] if d == order[0] else order[0]), "race"
    return None


def apply(db: Session, event_id: int) -> int:
    """The event's Q and race runs get their driver from the order (not committed); a run the order no longer
    names (renamed, or the order isn't known any more) goes back to the driving style. A person's pick, change or
    clear stands. How many runs changed."""
    from app import driver_prints, garage
    from app.results import models as rm

    runs = db.scalars(select(models.RunSession).where(models.RunSession.event_id == event_id)
                      .order_by(models.RunSession.id)).all()
    if not runs:
        return 0
    auto = driver_prints.set_by_style(db, [r.id for r in runs])
    order = order_for(db, event_id)
    if order is None and not any(st.source in SOURCES for st in auto.values()):
        return 0
    marks = {m.session_id: m for m in db.scalars(select(rm.RunNameMark)
                                                .where(rm.RunNameMark.session_id.in_([r.id for r in runs])))}
    n = 0
    for r in runs:
        st = auto.get(r.id)
        if (st is None and r.driver_id is not None) or (st is not None and st.driver_id != r.driver_id):
            continue  # a person's pick, change or clear
        want = driver_of(*session_of(r, marks.get(r.id)), order) if order is not None else None
        if want is None:
            if st is not None and st.source in SOURCES:
                r.driver_id = None
                db.delete(st)
                n += 1
            continue
        driver, source = want
        if r.driver_id == driver and st is not None and st.source == source:
            continue
        r.driver_id = driver
        driver_prints.set_by_app(db, r, driver, source)
        if r.car_id is not None:
            garage.link_driver(db, driver, r.car_id)
        n += 1
    db.flush()
    return n


def set_by_app(db: Session, runs: list[models.RunSession]) -> set[int]:
    """The runs whose driver the app set. In an event with a known order, naming them (run_names.py) goes by the
    clock, not by these drivers, which may have come from that naming (Q1, R1 stint 2) or from a style that can't
    tell the drivers apart."""
    from app import driver_prints

    auto = driver_prints.set_by_style(db, [r.id for r in runs])
    return {r.id for r in runs if r.id in auto and auto[r.id].driver_id == r.driver_id}
