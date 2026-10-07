"""Uploads join their season by themselves, and the app asks when it isn't sure (Gabriele, 2026-10-07: "if you detect
an outing belongs to a season, automatically add it to the season and fill in all relevant data (tires, car, drivers,
team)", "if you are not sure, ask").

When an event gets data (an import ends, a log is added to a run), once at startup, and when a season or its rounds
change, every event with data and no season is matched against the rounds of the seasons made in the app:
- Sure: the same track (plans.same_venue, or the same circuit by results.venues.venue_key, so "Le Castellet" is Paul
  Ricard) and all its days inside the round's, allowing a test day or two before (SURE_BEFORE). When exactly one
  round of one season is sure, the event is linked to it (link): the round points at the event (a planned event the
  round made, still empty, hands the event its venue, days, info and calendar link, and goes), event_info.season_id
  is set (tyre, car, team, vehicle and drivers then come from the season's entry), and its runs get the season's car
  (and the car gets the runs' logger, so later logs get it too) and their driver: the one the log names when that is
  one of the season's drivers (whatever the capitals and accents), else the season's only driver.
- Not sure: two rounds are sure, the same track on other days close to a round, or the round's days at a track that
  isn't recognised. A question is kept (SeasonMatch, "pending") for the app to ask, with one option per round.
- No season of ours matches, but a round on a series' published calendar (results module: result_calendar) does, at
  the same track on its days: the question is whether to add that series' season (made from its calendar, our entry
  from its entry list when our car number is known, else the answer gives the number). An unknown number is looked
  for on the round's entry list (else in its results) by our drivers' names (_our_drivers): when they are on one car,
  its number is the answer's; on several, those numbers are one-tap answers; on none, the number is asked for.
- After a link, runs whose driver can't be told (two drivers or more, and the log names none of them): a question of
  who drove, answered with one driver for them all or on the Tag drivers screen. When the runs have laps, it waits
  ("waiting", not shown) for the driving style to be checked (driver_prints.settle): the runs the style is sure of
  get their driver by themselves, and the question is asked only about the rest, with the style's suggestion as the
  first answer (style_checked); after WAIT_FOR_STYLE it is asked anyway.
A "no" is kept, so the same question isn't asked again; a link made by itself can be undone the same way. Nothing
set by hand changes: an event with a season (set on it, or a round linked to it) isn't matched again, and a run keeps
the car and driver it has. Nothing here reads a log: the headers' venue, date, driver and logger serial are in the
database. New table only (create_all adds it).
"""
from __future__ import annotations

import logging
import re
import sys
import threading
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import JSON, DateTime, Integer, String, delete, select
from sqlalchemy.orm import Mapped, Session, mapped_column, selectinload

from app import calendar_sync, garage, models, plans, season_car, seasons
from app import db as app_db  # SessionLocal is looked up when used: the tests swap the database
from app.db import Base, get_db
from app.known_tracks import known_track
from app.results import models as rm
from app.results import venues

log = logging.getLogger(__name__)

SURE_BEFORE = timedelta(days=2)  # a test day or two before a round's first day is still the round
NEAR_BEFORE = timedelta(days=14)  # the same track this close to a round, on other days: asked
NEAR_AFTER = timedelta(days=7)
MAX_OPTIONS = 4
MAX_RUNS = 500
MAX_CARS = 120  # cars read from a round's entry list or results
MAX_LINKS = 10  # earlier result links read for our car's crew
MAX_GARAGE = 200  # garage drivers read when nothing else says who our drivers are
MAX_CREW = 6
WAIT_FOR_STYLE = timedelta(minutes=15)  # a who-drove question waits this long at most for the driving style
MONTHS = ("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")


def _now() -> datetime:
    return datetime.now(UTC)


class SeasonMatch(Base):
    """A question about an event's season (pending, then yes or no), or a link made by itself (linked), with what it
    did (done), so it can be undone."""
    __tablename__ = "season_matches"
    id: Mapped[int] = mapped_column(primary_key=True)
    event_id: Mapped[int] = mapped_column(Integer, index=True)  # no foreign key: a row of a deleted event isn't read
    kind: Mapped[str] = mapped_column(String(12))  # round (ours), official (a series' calendar), drivers
    status: Mapped[str] = mapped_column(String(12), default="pending")  # pending, waiting, linked, yes, no
    prompt: Mapped[str] = mapped_column(String(400))
    why: Mapped[str | None] = mapped_column(String(600))
    options: Mapped[list] = mapped_column(JSON, default=list)  # [{"key", "label", "why", ...}], best first
    answer: Mapped[str | None] = mapped_column(String(120))  # the option picked, or "no"
    done: Mapped[dict] = mapped_column(JSON, default=dict)  # what a link did; a drivers question's runs
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
    answered_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


# ---------- words ----------

def days_text(start: date | None, end: date | None) -> str:
    """"18-20 Sep 2026", "30 Sep - 2 Oct 2026", "19 Sep 2026"."""
    if start is None:
        return "no dates"
    end = end or start
    if start == end:
        return f"{start.day} {MONTHS[start.month - 1]} {start.year}"
    if (start.year, start.month) == (end.year, end.month):
        return f"{start.day}-{end.day} {MONTHS[end.month - 1]} {end.year}"
    if start.year == end.year:
        return f"{start.day} {MONTHS[start.month - 1]} - {end.day} {MONTHS[end.month - 1]} {end.year}"
    return f"{days_text(start, None)} - {days_text(end, None)}"


def _plural(n: int, word: str) -> str:
    return f"{n} {word}{'' if n == 1 else 's'}"


ROUND_NAMED = re.compile(r"^\s*(round|rd|r)\s*\d", re.IGNORECASE)  # "Round 5 Zandvoort", "R5 Zandvoort"


def _round_label(season: seasons.Season, rnd: seasons.SeasonRound) -> str:
    """"GT4 European Series 2026, round 5 Zandvoort"; a round whose name already says its number keeps that name."""
    if ROUND_NAMED.match(rnd.name or ""):
        return f"{season.name}, {rnd.name[0].lower()}{rnd.name[1:]}"
    return f"{season.name}, round {rnd.order} {rnd.name}"


def _series_name(series: str) -> str:
    from app.results import sync  # here: it reaches the series' sites, which the rest of this module never does

    adapter = sync.ADAPTERS.get(series)
    return adapter.NAME if adapter is not None else series.replace("-", " ").title()


# ---------- what an event is: its days and where ----------

@dataclass
class _Facts:
    ev: models.Event
    start: date | None
    end: date | None
    venues: list[str]  # the planned venue, the track and the venues its logs give
    by_name: bool  # no venue known: its name stands in

    @property
    def where(self) -> str:
        return "no track known" if self.by_name else self.venues[0]


def _facts(db: Session, ev: models.Event) -> _Facts:
    start, end = plans.event_days(db, ev)
    metas = db.scalars(select(models.LoggerFile.meta).join(models.RunSession)
                       .where(models.RunSession.event_id == ev.id)).all()
    plan = plans.plan_of(db, ev.id)
    found = [plan.venue if plan else None, ev.track.name if ev.track else None,
             *((m or {}).get("venue") for m in metas)]
    names = list(dict.fromkeys(v.strip() for v in found if isinstance(v, str) and v.strip()))
    return _Facts(ev, start, end, names or [ev.name], not names)


def _circuit(text: str | None) -> str | None:
    """The results module's key of a circuit named in the text ("Le Castellet" is "paul-ricard"): its alias as a
    word, or at the start of a word for a long one ("Hockenheimring"), so "Spanish" isn't Spa."""
    plain = venues.plain(text or "")
    for key, aliases in venues._ALIASES.items():
        for a in aliases:
            if re.search(rf"\b{re.escape(a)}" + (r"" if len(a) >= 6 else r"\b"), plain):
                return key
    return None


def same_track(a: str | None, b: str | None) -> bool:
    """Two ways of writing a place name the same track: plans.same_venue, or the same circuit for the results
    module ("Circuit Paul Ricard" and "Le Castellet")."""
    if not a or not b:
        return False
    if plans.same_venue(a, b):
        return True
    ka = _circuit(a)
    return ka is not None and ka == _circuit(b)


def _known(text: str | None) -> bool:
    """A circuit we know by name (so a different name is a different track, not a spelling)."""
    return bool(text) and (_circuit(text) is not None or known_track(text) is not None)


def _venue_says(f: _Facts, theirs: list[str | None]) -> str:
    """"same", "unknown" (one side says nothing we can go by) or "different" (two tracks we both know)."""
    theirs = [t for t in theirs if t and t.strip()]
    if not theirs:
        return "unknown"
    if any(same_track(a, b) for a in f.venues for b in theirs):
        return "same"
    if f.by_name or not any(_known(v) for v in f.venues) or not any(_known(t) for t in theirs):
        return "unknown"
    return "different"


def _days_say(f: _Facts, start: date | None, end: date | None, year: int | None = None) -> str | None:
    """"sure" (inside the round's days, or a day or two before), "near" (close to them), or None."""
    if f.start is None:
        return None
    ev_end = f.end or f.start
    if start is None:  # a round without days: the same year is as near as it gets
        return "near" if year is not None and f.start.year == year else None
    end = end or start
    if f.start >= start - SURE_BEFORE and ev_end <= end:
        return "sure"
    if f.start <= end + NEAR_AFTER and ev_end >= start - NEAR_BEFORE:
        return "near"
    return None


def _when_words(f: _Facts, start: date | None, end: date | None) -> str:
    if start is None:
        return "the round has no dates yet"
    end = end or start
    if f.start is not None and f.start >= start and (f.end or f.start) <= end:
        return "on the round's days"
    if f.start is not None and f.start < start and (f.end or f.start) <= end:
        n = (start - f.start).days
        return f"{_plural(n, 'day')} before the round"
    return f"{days_text(f.start, f.end)}; the round is {days_text(start, end)}"


# ---------- candidates ----------

@dataclass
class _Cand:
    key: str
    sure: bool
    option: dict


def _round_cands(db: Session, f: _Facts) -> list[_Cand]:
    out = []
    rows = db.execute(select(seasons.SeasonRound, seasons.Season)
                      .join(seasons.Season, seasons.Season.id == seasons.SeasonRound.season_id)
                      .order_by(seasons.Season.year.desc(), seasons.SeasonRound.order, seasons.SeasonRound.id)).all()
    for rnd, season in rows:
        if rnd.event_id == f.ev.id:
            continue
        where = _venue_says(f, [rnd.venue, rnd.name])
        when = _days_say(f, rnd.start, rnd.end, season.year)
        if when is None or where == "different":
            continue
        if where == "same":
            sure = when == "sure"
            why = f"Same track, {_when_words(f, rnd.start, rnd.end)}."
        elif when == "sure":
            sure = False
            why = (f"On the round's days ({days_text(rnd.start, rnd.end)}); the track in the logs, {f.where}, "
                   f"isn't recognised as {rnd.venue or rnd.name}.")
        else:
            continue
        label = f"{_round_label(season, rnd)} ({days_text(rnd.start, rnd.end)})"
        out.append(_Cand(f"round:{rnd.id}", sure, {"key": f"round:{rnd.id}", "label": label, "why": why,
                                                   "season_id": season.id, "round_id": rnd.id}))
    return out


def _known_number(db: Session, series: str, year: int, event_id: int) -> str | None:
    """Our car's number in a series' season: as the results module has it for this event (or as set by hand on it),
    else in our season of the same series and year, else as set by hand on another event's results of that year. Never
    from another year: numbers change from season to season (Gabriele, 2026-10-07), so then our car is looked for on
    the round's entry list by our drivers (_numbers_of)."""
    link = db.scalar(select(rm.EventResultLink).where(rm.EventResultLink.event_id == event_id))
    if link is not None and link.car_number and (link.series == series or link.by_hand):
        return link.car_number
    number = db.scalar(select(seasons.Season.car_number).where(seasons.Season.series == series,
                                                               seasons.Season.year == year,
                                                               seasons.Season.car_number.is_not(None))
                       .order_by(seasons.Season.id.desc()).limit(1))
    if number:
        return number
    return db.scalar(select(rm.EventResultLink.car_number).where(
        rm.EventResultLink.series == series, rm.EventResultLink.year == year, rm.EventResultLink.by_hand == 1,
        rm.EventResultLink.car_number.is_not(None)).order_by(rm.EventResultLink.updated_at.desc()).limit(1))


def _round_cars(db: Session, series: str, year: int, round_id: str | None) -> list[dict]:
    """The cars of a series' round: its published entry list, else the cars in its official results (each car's
    crew over all its sessions). Read only."""
    if not round_id:
        return []
    cal = db.scalar(select(rm.ResultCalendarRound).where(rm.ResultCalendarRound.series == series,
                                                         rm.ResultCalendarRound.year == year,
                                                         rm.ResultCalendarRound.round_id == round_id)
                    .options(selectinload(rm.ResultCalendarRound.entries)))
    if cal is not None and cal.entries:
        return [{"car_number": e.car_number, "drivers": [d for d in e.drivers or [] if isinstance(d, str)],
                 "team": e.team, "car_model": e.car_model} for e in cal.entries[:MAX_CARS]]
    rows = db.scalars(select(rm.ResultRow).join(rm.ResultSession, rm.ResultSession.id == rm.ResultRow.session_pk)
                      .join(rm.ResultRound, rm.ResultRound.id == rm.ResultSession.round_pk)
                      .where(rm.ResultRound.series == series, rm.ResultRound.year == year,
                             rm.ResultRound.round_id == round_id).order_by(rm.ResultRow.id)
                      .limit(MAX_CARS * 8)).all()
    cars: dict[str, dict] = {}
    for r in rows:
        car = cars.setdefault(r.car_number, {"car_number": r.car_number, "drivers": [], "team": None,
                                             "car_model": None})
        car["drivers"] += [d for d in r.drivers or [] if isinstance(d, str) and d not in car["drivers"]]
        car["team"], car["car_model"] = car["team"] or r.team, car["car_model"] or r.car_model
    return list(cars.values())


def _driver_names(db: Session, ids) -> list[str]:
    ids = list(dict.fromkeys(i for i in ids if i is not None))
    return list(db.scalars(select(models.Driver.name).where(models.Driver.id.in_(ids)))) if ids else []


def _our_drivers(db: Session, ev: models.Event, series: str) -> tuple[list[str], bool]:
    """Who our drivers are, to find our car on an entry list, and whether that is sure: the drivers on the event's
    runs, else those who have run with its runs' car (the garage's), else the series' drivers known from before (our
    seasons of it, and our car's crew in its rounds our events were matched to). Else every driver in the garage,
    which is only a guess (it is asked)."""
    on_runs = db.scalars(select(models.RunSession.driver_id).where(models.RunSession.event_id == ev.id,
                                                                   models.RunSession.driver_id.is_not(None))).all()
    if names := _driver_names(db, on_runs):
        return names, True
    cars = set(db.scalars(select(models.RunSession.car_id).where(models.RunSession.event_id == ev.id,
                                                                 models.RunSession.car_id.is_not(None))).all())
    if cars:
        ids = [*db.scalars(select(garage.DriverCar.driver_id).where(garage.DriverCar.car_id.in_(cars))).all(),
               *db.scalars(select(models.RunSession.driver_id).where(models.RunSession.car_id.in_(cars))
                           .limit(MAX_RUNS)).all()]
        if names := _driver_names(db, ids):
            return names, True
    ids = [i for s in db.scalars(select(seasons.Season).where(seasons.Season.series == series)).all()
           for i in seasons.entry_row(s.entry)["drivers"]]
    names = _driver_names(db, ids)
    links = db.scalars(select(rm.EventResultLink).where(rm.EventResultLink.series == series,
                                                        rm.EventResultLink.event_id != ev.id,
                                                        rm.EventResultLink.car_number.is_not(None),
                                                        rm.EventResultLink.round_id.is_not(None))
                       .order_by(rm.EventResultLink.updated_at.desc()).limit(MAX_LINKS)).all()
    for link in links:
        for car in _round_cars(db, series, link.year, link.round_id):
            if car["car_number"] == link.car_number:
                names += [d for d in car["drivers"] if d not in names]
    if names:
        return names, True
    return list(db.scalars(select(models.Driver.name).order_by(models.Driver.id).limit(MAX_GARAGE))), False


def _car_words(car: dict) -> str:
    """"#12 Borusan Otomotiv Motorsport, BMW M4 GT4 EVO (Gabriele Piana, Michael Rackl)"."""
    what = ", ".join(x for x in (car.get("team"), car.get("car_model")) if x)
    crew = ", ".join(car.get("drivers") or [])
    return f"#{car['car_number']}" + (f" {what}" if what else "") + (f" ({crew})" if crew else "")


def _numbers_of(db: Session, ev: models.Event, series: str, year: int,
                round_id: str | None) -> tuple[list[dict], bool]:
    """Our car on the round's entry list (or in its results): the cars our drivers are on, the likeliest first (more
    of our drivers on it, then a number or team of ours from before), and whether our drivers are sure ones."""
    cars = _round_cars(db, series, year, round_id)
    if not cars:
        return [], False
    names, sure = _our_drivers(db, ev, series)
    found = []
    for car in cars:
        hit = [n for n in names if any(same_person(d, n) for d in car["drivers"])]
        if hit:
            found.append({**car, "matched": hit[:MAX_CREW]})
    if len(found) > 1:
        numbers = {n.strip().lstrip("#") for n in [
            *db.scalars(select(garage.CarInfo.number).where(garage.CarInfo.number.is_not(None))).all(),
            *db.scalars(select(seasons.Season.car_number).where(seasons.Season.car_number.is_not(None))).all()] if n}
        teams = {p for t in db.scalars(select(garage.Team.name)).all() if (p := plans._plain(t))}
        found.sort(key=lambda c: (-len(c["matched"]), c["car_number"] not in numbers,
                                  plans._plain(c.get("team")) not in teams))
    return found, sure


def _official_cands(db: Session, f: _Facts) -> list[_Cand]:
    """Rounds on a series' published calendar at the event's track on its days, for a series and year we have no
    season of."""
    if f.start is None or f.by_name:
        return []
    years = {f.start.year, (f.end or f.start).year}
    mine = db.execute(select(seasons.Season.series, seasons.Season.year, seasons.Season.name)).all()
    ours = {(series, year) for series, year, _ in mine if series}
    names = {(name or "").strip().lower() for _, _, name in mine}
    rows = db.scalars(select(rm.ResultCalendarRound).where(rm.ResultCalendarRound.year.in_(years),
                                                           rm.ResultCalendarRound.start.is_not(None))
                      .order_by(rm.ResultCalendarRound.series, rm.ResultCalendarRound.order)).all()
    out = []
    for r in rows:
        if (r.series, r.year) in ours or f"{_series_name(r.series)} {r.year}".lower() in names:
            continue
        if _days_say(f, r.start, r.end) != "sure":
            continue
        if _venue_says(f, [r.venue, r.name]) != "same":
            continue
        key = f"official:{r.series}:{r.year}:{r.round_id}"
        name = _series_name(r.series)
        opt = {"key": key, "label": f"{name} {r.year}, round {r.order} {r.name} ({days_text(r.start, r.end)})",
               "why": f"Same track, {_when_words(f, r.start, r.end)}.", "series": r.series, "series_name": name,
               "year": r.year, "round_id": r.round_id, "order": r.order, "name": r.name,
               "car_number": _known_number(db, r.series, r.year, f.ev.id)}
        if not opt["car_number"]:  # our drivers on the round's entry list: one car is ours, several are asked
            found, sure = _numbers_of(db, f.ev, r.series, r.year, r.round_id)
            if len(found) == 1 and sure:
                opt["car_number"], opt["entry"] = found[0]["car_number"], found[0]
            elif found:
                opt["numbers"] = found[:MAX_OPTIONS]
        out.append(_Cand(key, True, opt))
    return out


# ---------- the questions kept ----------

def _rows(db: Session, event_id: int, status: str | None = None, kind: str | None = None) -> list[SeasonMatch]:
    q = select(SeasonMatch).where(SeasonMatch.event_id == event_id)
    if status is not None:
        q = q.where(SeasonMatch.status == status)
    if kind is not None:
        q = q.where(SeasonMatch.kind == kind)
    return list(db.scalars(q.order_by(SeasonMatch.id)).all())


def _declined(db: Session, event_id: int) -> set[str]:
    """What was answered "no" for the event: its options' keys, and "drivers" when asked who drove."""
    out: set[str] = set()
    for row in _rows(db, event_id, "no"):
        out |= {o.get("key") for o in row.options or []}
        if row.kind == "drivers":
            out.add("drivers")
    return out


def _ask(db: Session, ev: models.Event, kind: str, prompt: str, why: str | None, options: list[dict],
         done: dict | None = None) -> SeasonMatch:
    """Keep the event's pending question of this kind (one at a time): the same one when its options are."""
    for other in ("round", "official"):
        if kind in ("round", "official") and other != kind:
            for row in _rows(db, ev.id, "pending", other):
                db.delete(row)
    rows = _rows(db, ev.id, "pending", kind)
    row = rows[0] if rows else None
    for extra in rows[1:]:
        db.delete(extra)
    if row is None:
        row = SeasonMatch(event_id=ev.id, kind=kind, status="pending")
        db.add(row)
    row.prompt, row.why = prompt[:400], (why or "")[:600] or None
    row.options = options[:MAX_OPTIONS]
    row.done = done or {}
    db.flush()
    return row


def _drop_pending(db: Session, event_id: int, kinds: tuple[str, ...]) -> None:
    db.execute(delete(SeasonMatch).where(SeasonMatch.event_id == event_id,
                                         SeasonMatch.status.in_(("pending", "waiting")), SeasonMatch.kind.in_(kinds)))


def _link_record(db: Session, event_id: int, season_id: int) -> SeasonMatch | None:
    """The event's link to the season: made by itself (linked), answered (yes) or taken back (no)."""
    for row in _rows(db, event_id):
        if row.status in ("linked", "yes", "no") and row.kind in ("round", "official") \
                and (row.done or {}).get("season_id") == season_id:
            return row
    return None


# ---------- linking ----------

def _absorb(db: Session, old: models.Event, ev: models.Event, done: dict) -> None:
    """The planned event a round made, still empty, goes into the event with data: its days (the event then runs
    over both, so the weekend's later logs come into it), venue, info, calendar entry and results link."""
    old_days = db.scalar(select(models.EventDates).where(models.EventDates.event_id == old.id))
    if old_days is not None and (old_days.start or old_days.end):
        start, end = plans.event_days(db, ev)
        row = db.scalar(select(models.EventDates).where(models.EventDates.event_id == ev.id))
        done["dates"] = None if row is None else [d.isoformat() if d else None for d in (row.start, row.end)]
        firsts = [d for d in (start, old_days.start or old_days.end) if d]
        lasts = [d for d in (end, old_days.end or old_days.start) if d]
        plans.set_days(db, ev, min(firsts), max(lasts))
    old_plan = plans.plan_of(db, old.id)
    if old_plan is not None and old_plan.venue:
        if plans.plan_of(db, ev.id) is None:
            done["made_plan"] = True
        plans.ensure_plan(db, ev.id, old_plan.venue)
    for r in db.scalars(select(seasons.SeasonRound).where(seasons.SeasonRound.event_id == old.id)).all():
        r.event_id, r.made_event = ev.id, False
    for c in db.scalars(select(models.CalendarEntry).where(models.CalendarEntry.event_id == old.id)).all():
        c.event_id, c.made_event, c.named = ev.id, False, None
    theirs = seasons.own_info(db, old.id)
    if theirs is not None:
        mine = seasons.own_info(db, ev.id)
        if mine is None:
            mine = seasons.EventInfo(event_id=ev.id)
            db.add(mine)
        for f in ("season_id", *seasons.FIELDS):
            if getattr(mine, f) is None and getattr(theirs, f) is not None:
                setattr(mine, f, getattr(theirs, f))
        if not mine.drivers and theirs.drivers:
            mine.drivers = list(theirs.drivers)
        db.delete(theirs)
    link = db.scalar(select(rm.EventResultLink).where(rm.EventResultLink.event_id == old.id))
    if link is not None:
        if db.scalar(select(rm.EventResultLink.id).where(rm.EventResultLink.event_id == ev.id)) is None:
            link.event_id = ev.id
        else:
            db.delete(link)
    ev.series = ev.series or old.series
    db.execute(delete(SeasonMatch).where(SeasonMatch.event_id == old.id))
    done["dropped"] = {"id": old.id, "name": old.name}
    db.flush()
    plans.remove(db, old)


def _set_season(db: Session, ev: models.Event, season: seasons.Season, done: dict) -> None:
    own = seasons.own_info(db, ev.id)
    if own is None:
        own = seasons.EventInfo(event_id=ev.id)
        db.add(own)
    if own.season_id is None:
        own.season_id = season.id
        done["set_season"] = True
    if not ev.series:
        ev.series = season.name[:80]
        done["set_series"] = True
    db.flush()


def link(db: Session, ev: models.Event, season: seasons.Season, rnd: seasons.SeasonRound | None,
         row: SeasonMatch) -> None:
    """Put the event in the season's round (see the module's notes); what was done goes on the row."""
    done = {**(row.done or {}), "season_id": season.id, "round": rnd.id if rnd is not None else None}
    if rnd is not None:
        other = db.get(models.Event, rnd.event_id) if rnd.event_id is not None else None
        if other is None or other.id == ev.id or not plans.has_data(db, other.id):
            if other is not None and other.id != ev.id:
                _absorb(db, other, ev, done)
            if plans.plan_of(db, ev.id) is None:
                done["made_plan"] = True
            plans.ensure_plan(db, ev.id, rnd.venue)
            rnd.event_id, rnd.made_event = ev.id, False
            db.flush()
            plan = plans.plan_of(db, ev.id)
            rnd.plan_id = plan.id if plan is not None else None
            done["round_linked"] = True
        else:  # the round's event already has data (the weekend's first zip): this one joins the season beside it
            done["beside"] = {"id": other.id, "name": other.name}
    _set_season(db, ev, season, done)
    row.done = done
    fill_runs(db, ev, season, None, row)


def _words_of(text: str | None) -> list[str]:
    return plans._plain(text).split()


def same_person(said: str | None, name: str | None) -> bool:
    """Whether a log header's driver is this driver: the same words whatever the order, capitals and accents
    ("ROSSI Gabriele"), or part of the name ("Gabriele", "G. Rossi")."""
    a, b = _words_of(said), _words_of(name)
    if not a or not b:
        return False
    small, big = (a, b) if len(a) <= len(b) else (b, a)
    hit = False
    for w in small:
        if w in big:
            hit = hit or len(w) >= 3
        elif not (len(w) == 1 and any(x.startswith(w) for x in big)):
            return False
    return hit


def _driver_for(s: models.RunSession, drivers: list[models.Driver]) -> models.Driver | None:
    """The season's driver of a run: the one its log names, else the season's only driver (when the log names
    nobody)."""
    named = {n.strip() for f in s.files if isinstance(n := (f.meta or {}).get("driver"), str) and n.strip()}
    if named:
        hits = {d.id: d for d in drivers for n in named if same_person(n, d.name)}
        return next(iter(hits.values())) if len(hits) == 1 else None
    return drivers[0] if len(drivers) == 1 else None


def _entry_used(car_id: int | None, drivers: list[models.Driver]) -> dict:
    return {"car_id": car_id, "drivers": [d.id for d in drivers]}


def _entry_now(db: Session, ev: models.Event, season: seasons.Season, cache: dict | None = None) -> dict:
    entry = seasons.entry_row(season.entry)
    car_id = season_car.for_event(db, ev, season, cache)
    return _entry_used(car_id, [d for i in entry["drivers"] if (d := db.get(models.Driver, i)) is not None])


def fill_runs(db: Session, ev: models.Event, season: seasons.Season, run_ids: list[int] | None,
              row: SeasonMatch) -> None:
    """The event's runs (or these of them) get the event's car (season_car: set on the event, else the season's), the
    car its runs' logger, and their driver; only what a run doesn't have. Runs whose driver can't be told are asked
    about."""
    entry = seasons.entry_row(season.entry)
    car_id = season_car.for_event(db, ev, season)
    drivers = [d for i in entry["drivers"] if (d := db.get(models.Driver, i)) is not None]
    q = (select(models.RunSession).where(models.RunSession.event_id == ev.id)
         .options(selectinload(models.RunSession.files)).order_by(models.RunSession.id).limit(MAX_RUNS))
    if run_ids is not None:
        q = q.where(models.RunSession.id.in_(run_ids))
    done = dict(row.done or {})
    filled: dict[str, dict] = {k: dict(v) for k, v in (done.get("runs") or {}).items()}
    loggers: list[int] = list(done.get("loggers") or [])
    need = []
    for s in db.scalars(q).all():
        got = filled.get(str(s.id), {})
        if car_id is not None and s.car_id is None:
            s.car_id = got["car_id"] = car_id
            db.flush()
        if car_id is not None and s.car_id == car_id:
            for serial in garage.run_serials(s):
                if db.scalar(select(garage.CarLogger.id).where(garage.CarLogger.serial == serial)) is None:
                    loggers.append(serial)
                    for other in garage.link_logger(db, serial, car_id):  # its runs elsewhere get the car too
                        filled.setdefault(str(other), {})["car_id"] = car_id
        if s.driver_id is None and drivers:
            d = _driver_for(s, drivers)
            if d is None:
                need.append(s.id)
            else:
                s.driver_id = got["driver_id"] = d.id
                db.flush()
                if s.car_id is not None:
                    garage.link_driver(db, d.id, s.car_id)
        if got:
            filled[str(s.id)] = {**filled.get(str(s.id), {}), **got}
    row.done = {**done, "runs": filled, "loggers": sorted(set(loggers)), "car_id": car_id,
                "entry": _entry_used(car_id, drivers)}
    db.flush()
    if need and "drivers" not in _declined(db, ev.id):
        _ask_drivers(db, ev, season, need, drivers)


def _ask_drivers(db: Session, ev: models.Event, season: seasons.Season, need: list[int],
                 drivers: list[models.Driver]) -> None:
    shown = _rows(db, ev.id, "pending", "drivers")
    waiting = _rows(db, ev.id, "waiting", "drivers")
    runs = sorted({*need, *(r for row in [*shown, *waiting] for r in (row.done or {}).get("runs", []))})
    for row in waiting:
        row.status = "pending"  # one question at a time: _ask keeps it
    names = ", ".join(d.name for d in drivers)
    row = _ask(db, ev, "drivers", f"Who drove the runs of {ev.name}?",
               f"Their logs don't say which of {season.name}'s drivers ({names}) drove.",
               [{"key": f"driver:{d.id}", "label": f"All {d.name}", "driver_id": d.id} for d in drivers],
               {"runs": runs, "season_id": season.id})
    from app import driver_prints  # looked up when used: the tests reload it
    if not shown and driver_prints.will_look(db, ev.id):
        row.status = "waiting"
        row.done = {**row.done, "waiting_since": _now().isoformat()}
        driver_prints.refresh_in_background()  # its fingerprints may be worked out already: settled again


def _runs_said(db: Session, picks: dict[int, int]) -> str:
    """"Max: Q1, R2; Gabriele: Q2, R1": who drove which runs, by the runs' names."""
    by: dict[int, list[str]] = {}
    for sid, did in picks.items():
        s = db.get(models.RunSession, sid)
        by.setdefault(did, []).append(s.name if s is not None and s.name else f"run {sid}")
    return "; ".join(f"{db.get(models.Driver, did).name}: {', '.join(sorted(names))}" for did, names in by.items())


def style_checked(db: Session, event_id: int, picks: dict[int, int],
                  splits: list[dict[int, int]] | tuple = ()) -> None:
    """The driving style was checked for the event (driver_prints.settle), and the runs it was sure of have their
    driver: the question of who drove is put away when no run is left, else asked about the rest with the style's
    picks (run -> driver) as the first answer, or, when the runs split into two styles of drivers nobody knows
    yet, the two ways the car's drivers could share them (splits). The caller holds calendar_sync._lock and
    commits."""
    db.flush()
    for row in [*_rows(db, event_id, "waiting", "drivers"), *_rows(db, event_id, "pending", "drivers")]:
        runs = [int(r) for r in (row.done or {}).get("runs", [])][:MAX_RUNS]
        left = set(db.scalars(select(models.RunSession.id).where(
            models.RunSession.id.in_(runs), models.RunSession.event_id == event_id,
            models.RunSession.driver_id.is_(None))).all()) if runs else set()
        if not left:
            row.status, row.answer, row.answered_at = "yes", "style", _now()
            continue
        options = [o for o in row.options or [] if not str(o.get("key")).startswith("style")]
        ways = [{sid: did for sid, did in split.items() if sid in left and db.get(models.Driver, did) is not None}
                for split in splits]
        if len(ways) == 2 and all(ways):
            why = ("The runs split into two driving styles. Pick which is whose: from then on both drivers are "
                   "known by their style.")
            options = [{"key": f"style:{i}", "label": _runs_said(db, way)[:160], "why": why,
                        "picks": {str(k): v for k, v in way.items()}} for i, way in enumerate(ways)] + options
            row.options = options[:MAX_OPTIONS]
            row.status = "pending"
            continue
        mine = {sid: did for sid, did in picks.items() if sid in left and db.get(models.Driver, did) is not None}
        if mine:
            counts: dict[int, int] = {}
            for did in mine.values():
                counts[did] = counts.get(did, 0) + 1
            said = ", ".join(f"{db.get(models.Driver, did).name} {_plural(n, 'run')}" for did, n in counts.items())
            why = "Each run's driving style against the drivers' fingerprints. Nothing is set until you tap."
            if (k := len(left) - len(mine)) > 0:
                why += f" {_plural(k, 'run')} the style can't tell {'stays' if k == 1 else 'stay'} untagged."
            options = [{"key": "style", "label": f"As the driving style says: {said}"[:160], "why": why,
                        "picks": {str(k): v for k, v in mine.items()}}, *options]
        row.options = options[:MAX_OPTIONS]
        row.status = "pending"
    db.flush()


def _release_waiting(db: Session) -> None:
    """Who-drove questions that waited long enough for the driving style are asked anyway."""
    limit = _now() - WAIT_FOR_STYLE
    for row in db.scalars(select(SeasonMatch).where(SeasonMatch.status == "waiting")).all():
        try:
            since = datetime.fromisoformat((row.done or {}).get("waiting_since") or "")
        except ValueError:
            since = None
        if since is None or since.tzinfo is None or since <= limit:
            row.status = "pending"


# ---------- matching an event ----------

def consider(db: Session, ev: models.Event, new_runs: list[int] | None = None) -> SeasonMatch | None:
    """Match one event (see the module's notes). The caller holds calendar_sync._lock and commits. The link made, or
    the question asked, or None."""
    own = seasons.own_info(db, ev.id)
    season, rnd = seasons.season_of_event(db, ev.id, own)
    if season is not None:
        _drop_pending(db, ev.id, ("round", "official"))
        row = _link_record(db, ev.id, season.id)
        if row is None:  # put in it another way: the season was made after it, its logs went into the round's
            if not plans.has_data(db, ev.id):  # planned event, or it was set by hand: its runs are filled once
                return None
            option = {"key": f"round:{rnd.id}" if rnd else f"season:{season.id}",
                      "label": _round_label(season, rnd) if rnd else season.name}
            row = SeasonMatch(event_id=ev.id, kind="round", status="linked", options=[option], answer=option["key"],
                              prompt=f"{ev.name} is in {option['label']}."[:400],
                              done={"season_id": season.id, "round": rnd.id if rnd else None})
            db.add(row)
            fill_runs(db, ev, season, None, row)
        elif new_runs and row.status != "no":
            fill_runs(db, ev, season, new_runs, row)
        return row
    if not plans.has_data(db, ev.id):
        return None
    f = _facts(db, ev)
    declined = _declined(db, ev.id)
    cands = [c for c in _round_cands(db, f) if c.key not in declined]
    sure = [c for c in cands if c.sure]
    if len(sure) == 1:
        opt = sure[0].option
        s, r = db.get(seasons.Season, opt["season_id"]), db.get(seasons.SeasonRound, opt["round_id"])
        _drop_pending(db, ev.id, ("round", "official"))
        row = SeasonMatch(event_id=ev.id, kind="round", status="linked", options=[opt], answer=opt["key"],
                          prompt=f"{ev.name} is in {_round_label(s, r)}."[:400], why=opt["why"][:600])
        db.add(row)
        link(db, ev, s, r, row)
        return row
    if cands:
        cands.sort(key=lambda c: not c.sure)
        what = f"{ev.name} ({days_text(f.start, f.end)}, {f.where})"
        if len(cands) == 1:
            opt = cands[0].option
            return _ask(db, ev, "round", f"Is {what} part of {opt['label']}?", opt["why"], [opt])
        return _ask(db, ev, "round", f"Which round is {what}?",
                    "More than one round of your seasons could be it.", [c.option for c in cands])
    official = [c for c in _official_cands(db, f) if c.key not in declined]
    if official:
        opt = official[0].option
        if len(official) == 1:
            prompt = f"Add to {opt['series_name']} {opt['year']}, round {opt['order']} {opt['name']}?"
        else:
            prompt = f"Which series was {ev.name} ({days_text(f.start, f.end)}, {f.where})?"
        why = (f"{ev.name} was at {f.where} on {days_text(f.start, f.end)}, when the series raced there. Yes makes "
               "the season from the series' calendar, with your entry from its entry list.")
        if len(official) == 1 and opt.get("entry"):
            why += f" Your car there: {_car_words(opt['entry'])}."
        elif len(official) == 1 and opt.get("numbers"):
            names, cars = sorted({n for c in opt["numbers"] for n in c["matched"]}), opt["numbers"]
            why += (f" {' and '.join(names)} {'is' if len(names) == 1 else 'are'} on "
                    + (f"car #{cars[0]['car_number']} of its entry list: is it yours?" if len(cars) == 1
                       else f"{len(cars)} cars of its entry list: which is yours?"))
        return _ask(db, ev, "official", prompt, why, [c.option for c in official])
    _drop_pending(db, ev.id, ("round", "official"))
    return None


def _event_ids_with_data(db: Session) -> list[int]:
    return sorted(set(db.scalars(select(models.RunSession.event_id)
                                 .where(models.RunSession.event_id.is_not(None)).distinct()).all()))


def scan(db: Session, season_id: int | None = None) -> dict:
    """Match every event with data; then the events of every season whose car or drivers changed (a season just made
    or saved: season_id) get them on their runs (only what they lack). Commits. How many were linked and asked."""
    with calendar_sync._lock:
        before = db.scalar(select(SeasonMatch.id).order_by(SeasonMatch.id.desc()).limit(1)) or 0
        for eid in _event_ids_with_data(db):
            ev = db.get(models.Event, eid)
            if ev is not None:
                consider(db, ev)
                db.flush()
        season_car.put_on_events(db)  # every season's car (and drivers) on its events' runs, where it changed
        db.commit()
        made = db.scalars(select(SeasonMatch.status).where(SeasonMatch.id > before)).all()
    return {"linked": made.count("linked"), "asked": made.count("pending")}


def after_import(db: Session, run_ids: list[int]) -> None:
    """The events an upload's runs went into: matched, and the new runs filled from their season. Commits."""
    if not run_ids:
        return
    rows = db.execute(select(models.RunSession.id, models.RunSession.event_id)
                      .where(models.RunSession.id.in_(run_ids[:MAX_RUNS]))).all()
    by_event: dict[int, list[int]] = {}
    for sid, eid in rows:
        if eid is not None:
            by_event.setdefault(eid, []).append(sid)
    with calendar_sync._lock:
        for eid, sids in by_event.items():
            ev = db.get(models.Event, eid)
            if ev is not None:
                consider(db, ev, sids)
        db.commit()


def safely(what: str, fn, *args) -> None:
    """Matching never stops what called it (an import, a season saved): what goes wrong is logged."""
    try:
        fn(*args)
    except Exception:
        log.exception("Matching seasons after %s failed", what)
        try:
            args[0].rollback()
        except Exception:
            pass


_started: threading.Thread | None = None


def start() -> None:
    """On startup, in the background: the events with data and no season are matched once."""
    global _started

    def run() -> None:
        with app_db.SessionLocal() as db:
            safely("startup", scan, db)

    if "pytest" in sys.modules:  # the tests call scan() themselves
        return
    _started = threading.Thread(target=run, name="season-match", daemon=True)
    _started.start()


# ---------- answering ----------

def _season_from_calendar(db: Session, ev: models.Event, opt: dict, number: str) -> tuple[seasons.Season,
                                                                                          seasons.SeasonRound | None]:
    """The series' season made from its published calendar (or ours of it, if made meanwhile), with our entry
    filled from its entry list: the drivers, team, car and vehicle."""
    series, year = opt["series"], int(opt["year"])
    season = db.scalars(select(seasons.Season).where(seasons.Season.series == series, seasons.Season.year == year)
                        .order_by(seasons.Season.id)).first()
    if season is None:
        season = seasons.Season(name=f"{_series_name(series)} {year}"[:160], series=series, year=year,
                                car_number=number[:8], entry=seasons._entry(seasons.EntryIn()))
        db.add(season)
        db.flush()
        cal = db.scalars(select(rm.ResultCalendarRound).where(rm.ResultCalendarRound.series == series,
                                                              rm.ResultCalendarRound.year == year)
                         .order_by(rm.ResultCalendarRound.order, rm.ResultCalendarRound.start)).all()
        rounds = [seasons.RoundIn(name=(r.name or "Round")[:160], venue=r.name, start=r.start, end=r.end,
                                  round_id=r.round_id, order=min(max(r.order or 0, 0), 1000)) for r in cal]
        seasons.set_rounds(db, season, rounds[:seasons.MAX_ROUNDS])
    elif not season.car_number:
        season.car_number = number[:8]
    entry = seasons.entry_row(season.entry)
    if entry["car_id"] is None:  # the car the event's runs were in (by their logger), else the garage's of our number
        cars = {c for c in db.scalars(select(models.RunSession.car_id).where(models.RunSession.event_id == ev.id))
                if c is not None}
        if len(cars) == 1:
            season.entry = {**entry, "car_id": cars.pop()}
    ours = _entry_row(db, series, year, opt.get("round_id"), number)
    if ours is None:  # no entry list: our car as the round's results have it, when the question found it there
        known = next((c for c in [opt.get("entry"), *(opt.get("numbers") or [])]
                      if c and c.get("car_number") == number), None)
        ours = rm.ResultEntry(car_number=number, drivers=known["drivers"], team=known.get("team"),
                              car_model=known.get("car_model")) if known else None
    if ours is not None:  # our car (the garage's like it, else made from the row) and the entry's blanks
        season_car.remember(db, season, {"car_number": number, "drivers": ours.drivers, "team": ours.team,
                                         "car_model": ours.car_model})
    rnd = db.scalars(select(seasons.SeasonRound).where(seasons.SeasonRound.season_id == season.id,
                                                       seasons.SeasonRound.round_id == opt.get("round_id"))).first()
    return season, rnd


def _entry_row(db: Session, series: str, year: int, round_id: str | None, number: str) -> rm.ResultEntry | None:
    """Our car on the round's entry list, else on the latest list of the season that has it."""
    rows = db.execute(select(rm.ResultEntry, rm.ResultCalendarRound)
                      .join(rm.ResultCalendarRound, rm.ResultCalendarRound.id == rm.ResultEntry.calendar_pk)
                      .where(rm.ResultCalendarRound.series == series, rm.ResultCalendarRound.year == year,
                             rm.ResultEntry.car_number == number)
                      .order_by(rm.ResultCalendarRound.order.desc())).all()
    for e, r in rows:
        if r.round_id == round_id:
            return e
    return rows[0][0] if rows else None


def _make_car(db: Session, number: str, model: str | None, team: str | None) -> int:
    """Our car in the garage, as the entry list gives it, when the garage has none like it (season_car.car_like)."""
    model = (model or "").strip()[:100] or None
    car = models.Car(name=garage.car_name(number, model))
    db.add(car)
    db.flush()
    info = garage.CarInfo(car_id=car.id, number=number[:8] or None, model=model)
    if (team or "").strip():
        t = seasons._team_named(db, team.strip())
        info.team_id, car.team = t.id, t.name
    db.add(info)
    db.flush()
    return car.id


def _undo(db: Session, row: SeasonMatch) -> None:
    """Take back a link made by itself: the runs' car and driver it filled (if still the same), the logger it fitted,
    the event's season, and the round (which gets its planned event again)."""
    done = row.done or {}
    ev = db.get(models.Event, row.event_id)
    season = db.get(seasons.Season, done.get("season_id")) if done.get("season_id") else None
    for sid, got in (done.get("runs") or {}).items():
        s = db.get(models.RunSession, int(sid))
        if s is None:
            continue
        if got.get("car_id") is not None and s.car_id == got["car_id"]:
            s.car_id = None
        if got.get("driver_id") is not None and s.driver_id == got["driver_id"]:
            s.driver_id = None
    for serial in done.get("loggers") or []:
        fitted = db.scalar(select(garage.CarLogger).where(garage.CarLogger.serial == serial))
        if fitted is not None and fitted.car_id == done.get("car_id"):
            db.delete(fitted)
    _drop_pending(db, row.event_id, ("drivers",))
    if ev is None:
        return
    own = seasons.own_info(db, ev.id)
    if done.get("set_season") and own is not None and season is not None and own.season_id == season.id:
        own.season_id = None
    if done.get("set_series") and season is not None and ev.series == season.name[:80]:
        ev.series = None
    rnd = db.get(seasons.SeasonRound, done["round"]) if done.get("round_linked") and done.get("round") else None
    if rnd is not None and rnd.event_id == ev.id:
        rnd.event_id, rnd.plan_id, rnd.made_event = None, None, False
        if "dates" in done:
            row_dates = db.scalar(select(models.EventDates).where(models.EventDates.event_id == ev.id))
            if done["dates"] is None:
                if row_dates is not None:
                    db.delete(row_dates)
                db.flush()
                ev.date = plans.event_days(db, ev)[0] or ev.date
            else:
                start, end = (date.fromisoformat(d) if d else None for d in done["dates"])
                plans.set_days(db, ev, start, end)
        if done.get("made_plan") and db.scalar(select(models.CalendarEntry.id).where(
                models.CalendarEntry.event_id == ev.id)) is None:
            db.execute(delete(models.EventPlan).where(models.EventPlan.event_id == ev.id))
        db.flush()
        if season is not None:  # the round gets its planned event again (never this event)
            seasons._attach(db, season, rnd, {ev.id}, calendar_sync._Events(db))
    db.flush()


def _set_drivers(db: Session, row: SeasonMatch, driver_id: int) -> int:
    d = db.get(models.Driver, driver_id)
    if d is None:
        raise HTTPException(409, "That driver isn't in the garage any more")
    n = 0
    for sid in (row.done or {}).get("runs", []):
        s = db.get(models.RunSession, sid)
        if s is not None and s.event_id == row.event_id and s.driver_id is None:
            s.driver_id = d.id
            n += 1
            if s.car_id is not None:
                garage.link_driver(db, d.id, s.car_id)
    return n


def _set_picks(db: Session, row: SeasonMatch, picks: dict) -> int:
    """The style's pick for each run (run id -> driver id), for the runs still without a driver."""
    n = 0
    for sid, did in picks.items():
        s, d = db.get(models.RunSession, int(sid)), db.get(models.Driver, int(did))
        if s is not None and d is not None and s.event_id == row.event_id and s.driver_id is None:
            s.driver_id = d.id
            n += 1
            if s.car_id is not None:
                garage.link_driver(db, d.id, s.car_id)
    return n


def _missing_drivers(db: Session, row: SeasonMatch) -> int:
    runs = [int(r) for r in (row.done or {}).get("runs", [])][:MAX_RUNS]
    if not runs:
        return 0
    return len(db.scalars(select(models.RunSession.id).where(models.RunSession.id.in_(runs),
                                                             models.RunSession.event_id == row.event_id,
                                                             models.RunSession.driver_id.is_(None))).all())


def _still_open(db: Session, row: SeasonMatch) -> bool:
    """Whether a pending question still needs asking; one that doesn't is put away."""
    ev = db.get(models.Event, row.event_id)
    if ev is None:
        db.delete(row)
        return False
    if row.kind == "drivers":
        if _missing_drivers(db, row) == 0:
            row.status, row.answer, row.answered_at = "yes", "tagged", _now()
            return False
        return True
    if seasons.season_of_event(db, ev.id, seasons.own_info(db, ev.id))[0] is not None:
        db.delete(row)
        return False
    if row.kind == "round":
        alive = [o for o in row.options or [] if db.get(seasons.SeasonRound, o.get("round_id") or 0) is not None]
        if not alive:
            db.delete(row)
            return False
        if len(alive) != len(row.options or []):
            row.options = alive
    return True


def _option_json(o: dict) -> dict:
    """An answer; a series' round whose number isn't known yet has the cars our drivers are on as one-tap numbers."""
    out = {"key": o["key"], "label": o.get("label"), "why": o.get("why")}
    if o.get("numbers") and not o.get("car_number"):
        out["numbers"] = [{"car_number": c["car_number"],
                           "label": " ".join(x for x in (f"#{c['car_number']}", c.get("team")) if x),
                           "why": " · ".join(x for x in (c.get("car_model"), ", ".join(c.get("drivers") or [])) if x)
                           or None} for c in o["numbers"]]
    return out


def _json(db: Session, row: SeasonMatch, ev: models.Event | None = None) -> dict:
    ev = ev or db.get(models.Event, row.event_id)
    out = {"id": row.id, "event_id": row.event_id, "event_name": ev.name if ev else None, "kind": row.kind,
           "status": row.status, "prompt": row.prompt, "why": row.why,
           "options": [_option_json(o) for o in row.options or []],
           "needs": [], "created_at": row.created_at.isoformat() if row.created_at else None}
    if row.kind == "official" and row.status == "pending" and not any(o.get("car_number") for o in row.options):
        out["needs"] = ["car_number"]
        out["series_name"] = (row.options or [{}])[0].get("series_name")
    if row.kind == "drivers":
        out["runs"] = _missing_drivers(db, row)
    if row.status in ("linked", "yes") and row.kind in ("round", "official"):
        out["summary"] = _summary(db, row)
        done = row.done or {}
        out["undo"] = row.status == "linked" and bool(done.get("round_linked") or (
            done.get("set_season") and (not done.get("round") or done.get("beside"))))
    return out


def _summary(db: Session, row: SeasonMatch) -> str:
    """What a link did, in words."""
    done = row.done or {}
    season = db.get(seasons.Season, done.get("season_id")) if done.get("season_id") else None
    chosen = next((o for o in row.options or [] if o.get("key") == row.answer), {})
    why = (chosen.get("why") or "").rstrip(".")
    parts = [row.prompt.rstrip(".") + (f" ({why[:1].lower()}{why[1:]})" if why else "") + "."]
    if season is not None:
        parts.append("Tyre, car, team, vehicle and drivers come from the season unless the event sets them.")
    runs = done.get("runs") or {}
    cars = sum(1 for v in runs.values() if v.get("car_id"))
    drivers = sum(1 for v in runs.values() if v.get("driver_id"))
    car = db.get(models.Car, done.get("car_id")) if done.get("car_id") else None
    if cars and car is not None:
        parts.append(season_car.set_on(db, car.id, season, cars))
    if done.get("loggers"):
        parts.append(f"Logger {', '.join(map(str, done['loggers']))} is now fitted to it, so later logs get it too.")
    if drivers:
        parts.append(f"{_plural(drivers, 'run')} got their driver.")
    if done.get("dropped"):
        parts.append(f"Its planned event {done['dropped']['name']} was empty and went into it.")
    if done.get("beside"):
        parts.append(f"The round's event is {done['beside']['name']}: put the sessions there to have one event.")
    return " ".join(parts)


router = APIRouter(prefix="/season-match")


class AnswerIn(BaseModel):
    answer: str = Field(min_length=1, max_length=120)  # an option's key, or "no"
    car_number: str | None = Field(None, max_length=8)


def _event_scope(db: Session, event_id: int | None, runs: str | None) -> set[int] | None:
    if runs is not None:
        try:
            ids = [int(x) for x in runs.split(",") if x.strip()][:MAX_RUNS]
        except ValueError:
            raise HTTPException(422, "runs is a comma separated list of run ids") from None
        found = db.scalars(select(models.RunSession.event_id).where(models.RunSession.id.in_(ids))).all() if ids else []
        return {e for e in found if e is not None} | ({event_id} if event_id is not None else set())
    return {event_id} if event_id is not None else None


def _season_id_of(db: Session, event_id: int) -> int | None:
    season = seasons.season_of_event(db, event_id, seasons.own_info(db, event_id))[0]
    return season.id if season is not None else None


@router.get("/pending")
def pending(event_id: int | None = None, runs: str | None = Query(None, max_length=6000),
            db: Session = Depends(get_db)):
    """The questions waiting for an answer (of one event, or of the events these runs are in), and with event_id or
    runs, the links made by themselves for those events (to say what was done, and undo it)."""
    scope = _event_scope(db, event_id, runs)
    q = select(SeasonMatch).where(SeasonMatch.status == "pending").order_by(SeasonMatch.id)
    if scope is not None:
        q = q.where(SeasonMatch.event_id.in_(sorted(scope)))
    with calendar_sync._lock:
        _release_waiting(db)
        db.flush()
        rows = [r for r in db.scalars(q).all() if _still_open(db, r)]
        db.commit()
    linked = []
    if scope:
        linked = [r for r in db.scalars(select(SeasonMatch).where(SeasonMatch.event_id.in_(sorted(scope)),
                                                                  SeasonMatch.status == "linked")
                                        .order_by(SeasonMatch.id)).all()
                  if (r.done or {}).get("season_id") == _season_id_of(db, r.event_id)]
    events = {e.id: e for e in db.scalars(select(models.Event).where(
        models.Event.id.in_({r.event_id for r in [*rows, *linked]}))).all()} if rows or linked else {}
    return {"count": len(rows), "questions": [_json(db, r, events.get(r.event_id)) for r in rows],
            "linked": [_json(db, r, events.get(r.event_id)) for r in linked if r.event_id in events]}


@router.post("/{match_id}")
def answer(match_id: int, body: AnswerIn, db: Session = Depends(get_db)):
    """Answer a question with one of its options' keys, or "no" (kept: not asked again). "no" on a link made by
    itself undoes it. A yes to a series' round makes the season (car_number: our car's number in the series, when
    the question needs it)."""
    with calendar_sync._lock:
        row = db.get(SeasonMatch, match_id)
        if row is None:
            raise HTTPException(404, "Question not found")
        ev = db.get(models.Event, row.event_id)
        if ev is None:
            raise HTTPException(404, "Event not found")
        key = body.answer.strip()
        words = ""
        if key == "no":
            if row.status == "linked":
                _undo(db, row)
                words = f"{ev.name} is no longer in that season."
            elif row.status != "pending":
                raise HTTPException(409, "That was answered already")
            else:
                words = "Not asked again."
            row.status, row.answer, row.answered_at = "no", "no", _now()
            db.commit()
            return {"done": words, "questions": _open_of(db, ev.id)}
        if row.status != "pending":
            raise HTTPException(409, "That was answered already")
        opt = next((o for o in row.options or [] if o.get("key") == key), None)
        if opt is None:
            raise HTTPException(422, "That isn't one of the answers")
        if row.kind == "drivers" and key.startswith("style"):
            n = _set_picks(db, row, opt.get("picks") or {})
            words = f"{_plural(n, 'run')} of {ev.name} set from the driving style."
        elif row.kind == "drivers":
            n = _set_drivers(db, row, int(opt["driver_id"]))
            words = f"{_plural(n, 'run')} of {ev.name} now driven by {db.get(models.Driver, opt['driver_id']).name}."
        else:
            if seasons.season_of_event(db, ev.id, seasons.own_info(db, ev.id))[0] is not None:
                raise HTTPException(409, f"{ev.name} is in a season already")
            if row.kind == "round":
                season = db.get(seasons.Season, opt["season_id"])
                rnd = db.get(seasons.SeasonRound, opt["round_id"])
                if season is None or rnd is None:
                    raise HTTPException(409, "That round isn't there any more")
            else:
                number = ((body.car_number or "").strip().lstrip("#") or opt.get("car_number") or "").strip()
                if not number:
                    raise HTTPException(422, f"Give your car's number in {opt.get('series_name') or 'the series'}")
                season, rnd = _season_from_calendar(db, ev, opt, number)
            row.done, row.answer = {}, key
            link(db, ev, season, rnd, row)
            row.prompt = f"{ev.name} is in {_round_label(season, rnd) if rnd else season.name}."[:400]
            words = _summary(db, row)
        row.status, row.answer, row.answered_at = "yes", key, _now()
        db.commit()
    if row.kind != "drivers":
        safely("an answer", scan, db)  # a new season (or round) may be what other events were waiting for
    else:
        from app import driver_prints  # the answer teaches the driver fingerprints; looked up when used
        driver_prints.refresh_in_background()
    return {"done": words, "questions": _open_of(db, ev.id)}


def _open_of(db: Session, event_id: int) -> list[dict]:
    rows = db.scalars(select(SeasonMatch).where(SeasonMatch.event_id == event_id, SeasonMatch.status == "pending")
                      .order_by(SeasonMatch.id)).all()
    return [_json(db, r) for r in rows]


def bind_models() -> None:
    """Put this module's table on the current database's metadata (the tests load a fresh app.db for each test;
    the server loads it once, so this does nothing there)."""
    import importlib

    from app import db

    module = sys.modules[__name__]
    if module.Base is not db.Base:
        importlib.reload(module)

