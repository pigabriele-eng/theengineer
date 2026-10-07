"""Our car in a season, remembered and put on its events (Gabriele, 2026-10-07: "the app should remember the car from
the season and automatically add it to the events").

A season knows our car from, in this order:
- its own entry: the car set on it, else the garage car its entry describes (car_like: by drivers, team and model; by
  its number only when that car is no other year's season's car);
- the runs of its events: the car most of them were in (by their logger, or set by hand);
- a round's entry list (else its results): our car's row there, by the season's number (the same year) or by our
  drivers' names (season_match._numbers_of), and the garage car of that row (car_like), else one made from it.
What is found is remembered: on the season's entry (its blanks: car, number, team, vehicle, drivers) and on the car (its
blank number, model and team). Numbers change from season to season, so a car is never told by its number alone, and
an event shows the number of its season (seasons.info_for_event).

Every event of the season then has it: the event's car comes from its season unless the event sets one, and its runs
without a car get the event's car (season_match.fill_runs, which records what it filled, so a "no" undoes it). A car
set by hand on an event or a run stays. It is put on when an event joins a season, at an import (season_match.consider),
and when a season is saved, a question answered, and once at startup (season_match.scan -> put_on_events).
Nothing here reads a log; no table of its own.
"""
from __future__ import annotations

from collections import Counter

from sqlalchemy import select

from app import garage, models, plans, seasons

MAX_GARAGE = 200  # garage cars looked through
MAX_RUNS = 500
MAX_ROUNDS = 6  # linked rounds whose entry lists are read


def _plain_number(number: str | None) -> str:
    return (number or "").strip().lstrip("#").strip()


def _model_words(text: str | None) -> set[str]:
    return set(plans._plain(text).split())


def car_like(db, number: str | None, drivers: list[str], team: str | None, model: str | None,
             year: int | None) -> int | None:
    """The garage car an entry describes (number, drivers' names, team, car model), never by its number alone across
    seasons: a car whose team and model aren't others, that one of the drivers drives (by its runs or the garage) with
    the same team, model or number, or that has the same number and team, or the same number when no season of
    another year has that car. The likeliest (more of the drivers, then the team, the model, the number); None when
    two are as likely."""
    number, team_p, model_w = _plain_number(number), plans._plain(team), _model_words(model)
    names = [n for n in drivers or [] if isinstance(n, str) and n.strip()]
    cars = db.scalars(select(models.Car.id).order_by(models.Car.id).limit(MAX_GARAGE)).all()
    if not cars:
        return None
    infos = {i.car_id: i for i in db.scalars(select(garage.CarInfo).where(garage.CarInfo.car_id.in_(cars))).all()}
    teams = {t.id: t.name for t in db.scalars(select(garage.Team)).all()}
    crews: dict[int, set[int]] = {}
    pairs = [*db.execute(select(garage.DriverCar.car_id, garage.DriverCar.driver_id)
                         .where(garage.DriverCar.car_id.in_(cars))).all(),
             *db.execute(select(models.RunSession.car_id, models.RunSession.driver_id).distinct()
                         .where(models.RunSession.car_id.in_(cars), models.RunSession.driver_id.is_not(None))).all()]
    for cid, did in pairs:
        crews.setdefault(cid, set()).add(did)
    who = {d.id: d.name for d in db.scalars(select(models.Driver).where(
        models.Driver.id.in_({d for c in crews.values() for d in c})))} if crews else {}
    other_years = {seasons.entry_row(s.entry)["car_id"] for s in db.scalars(select(seasons.Season)).all()
                   if year is None or s.year != year}
    from app.season_match import same_person  # here: season_match uses this module

    hits = []
    for cid in cars:
        info = infos.get(cid)
        theirs = plans._plain(teams.get(info.team_id)) if info is not None and info.team_id else ""
        if team_p and theirs and theirs != team_p:
            continue
        their_model = _model_words(info.model if info is not None else None)
        if model_w and their_model and not (their_model <= model_w or model_w <= their_model):
            continue
        crew = sum(1 for n in names if any(same_person(n, who.get(d)) for d in crews.get(cid, ())))
        same_team = bool(team_p and theirs == team_p)
        same_model = bool(model_w and their_model)
        same_number = bool(number and info is not None and _plain_number(info.number) == number)
        if (crew and (same_team or same_model or same_number)) \
                or (same_number and (same_team or cid not in other_years)):
            hits.append(((crew, same_team, same_model, same_number), cid))
    hits.sort(key=lambda h: h[0], reverse=True)
    if not hits or (len(hits) > 1 and hits[0][0] == hits[1][0]):
        return None
    return hits[0][1]


def _fill_car(db, car_id: int, number: str, model: str | None, team: str | None) -> None:
    """The car's blank number, model and team, from the entry list."""
    car = db.get(models.Car, car_id)
    if car is None:
        return
    info = garage.car_info(db, car_id)
    if info is None:
        info = garage.CarInfo(car_id=car_id)
        db.add(info)
    named = False
    if not (info.number or "").strip() and number:
        info.number, named = number[:8], True
    if not (info.model or "").strip() and (model or "").strip():
        info.model, named = model.strip()[:100], True
    if named:
        car.name = garage.car_name(info.number, info.model)
    if info.team_id is None and (team or "").strip():
        t = seasons._team_named(db, team.strip())
        info.team_id, car.team = t.id, t.name
    db.flush()


def remember(db, season: seasons.Season, row: dict, with_drivers: bool = True) -> int:
    """Our car's row on the season's entry list (car_number, drivers, team, car_model) on the season: the car (the
    entry's, else the garage's like it, else made from the row) with its blanks filled, and the entry's blanks (its
    drivers too only with_drivers: the drivers are the season's own business). The car."""
    from app import season_match  # here: it uses this module

    number = _plain_number(row.get("car_number"))
    drivers = [d for d in row.get("drivers") or [] if isinstance(d, str) and d.strip()][:10]
    team, model = (row.get("team") or "").strip() or None, (row.get("car_model") or "").strip() or None
    entry = seasons.entry_row(season.entry)
    car = seasons._exists(db, models.Car, entry["car_id"]) or car_like(db, number, drivers, team, model, season.year)
    if car is None:
        car = season_match._make_car(db, number, model, team)
    else:
        _fill_car(db, car, number, model, team)
    season.entry = {**entry, "car_id": car}
    seasons.fill_entry(db, season, seasons.EntryRowIn(car_number=number[:8] or None,
                                                       drivers=drivers if with_drivers else [],
                                                       team=team[:200] if team else None,
                                                       car_model=model[:200] if model else None))
    db.flush()
    return car


def _events(db, season: seasons.Season) -> list[int]:
    return sorted(eid for eid, s in seasons.seasons_of_events(db).items() if s["id"] == season.id)


def _from_runs(db, events: list[int]) -> int | None:
    """The car of the season's events' runs: one car on at least half of them, and on more than any other (a run or
    two put in another car by hand don't make it the season's)."""
    if not events:
        return None
    cars = Counter(db.scalars(select(models.RunSession.car_id).where(
        models.RunSession.event_id.in_(events)).limit(MAX_RUNS)).all())
    total = sum(cars.values())
    top = [(c, n) for c, n in cars.most_common() if c is not None][:2]
    if not top or top[0][1] * 2 < total or (len(top) == 2 and top[0][1] == top[1][1]):
        return None
    return top[0][0]


def _from_entry_list(db, season: seasons.Season) -> dict | None:
    """Our car's row on the entry list (else in the results) of a round of the season: by its number, else by our
    drivers on one car (season_match._numbers_of, sure ones only)."""
    from app import season_match

    if not season.series:
        return None
    rounds = [r for r in seasons.rounds_of(db, season.id) if r.round_id][::-1]
    linked = [r for r in rounds if r.event_id is not None][:MAX_ROUNDS]
    number = _plain_number(season.car_number)
    if number:
        e = season_match._entry_row(db, season.series, season.year, linked[0].round_id if linked else None, number)
        if e is not None:
            return {"car_number": number, "drivers": e.drivers, "team": e.team, "car_model": e.car_model}
        for r in linked:
            for car in season_match._round_cars(db, season.series, season.year, r.round_id):
                if _plain_number(car["car_number"]) == number:
                    return car
        return None
    for r in linked:
        ev = db.get(models.Event, r.event_id)
        if ev is None:
            continue
        found, sure = season_match._numbers_of(db, ev, season.series, season.year, r.round_id)
        if len(found) == 1 and sure:
            return found[0]
    return None


def car_of(db, season: seasons.Season, cache: dict | None = None) -> int | None:
    """Our car in the season (see the module's notes), remembered on its entry when found another way."""
    if cache is not None and season.id in cache:
        return cache[season.id]
    entry = seasons.entry_row(season.entry)
    car = seasons._exists(db, models.Car, entry["car_id"])
    if car is None:
        names = [d.name for i in entry["drivers"] if (d := db.get(models.Driver, i)) is not None]
        team = db.get(garage.Team, entry["team_id"]) if entry["team_id"] is not None else None
        from app import catalog

        vehicle = db.get(catalog.VehicleModel, entry["vehicle_model_id"]) \
            if entry["vehicle_model_id"] is not None else None
        car = car_like(db, season.car_number, names, team.name if team else None, vehicle.name if vehicle else None,
                       season.year) or _from_runs(db, _events(db, season))
        if car is not None:
            season.entry = {**entry, "car_id": car}
            db.flush()
        elif (row := _from_entry_list(db, season)) is not None:
            car = remember(db, season, row, with_drivers=False)
    if cache is not None:
        cache[season.id] = car
    return car


def for_event(db, ev: models.Event, season: seasons.Season, cache: dict | None = None) -> int | None:
    """The car of an event's runs: the one set on the event, else its season's."""
    own = seasons.own_info(db, ev.id)
    return seasons._exists(db, models.Car, own.car_id if own is not None else None) or car_of(db, season, cache)


def number_in(season: seasons.Season | None, car_id: int | None) -> str | None:
    """The car's number in the season when it is the season's car (numbers change from season to season)."""
    if season is None or car_id is None or seasons.entry_row(season.entry)["car_id"] != car_id:
        return None
    return _plain_number(season.car_number) or None


def set_on(db, car_id: int, season: seasons.Season | None, runs: int) -> str:
    """"Car #12 BMW M4 GT4 Evo (G82), Hofor Racing, set on 11 runs.": the car with its season's number, its model and
    team."""
    car, info = db.get(models.Car, car_id), garage.car_info(db, car_id)
    number = number_in(season, car_id) or (_plain_number(info.number) if info is not None else None)
    model = info.model if info is not None else None
    team = db.get(garage.Team, info.team_id) if info is not None and info.team_id else None
    what = " ".join(x for x in (f"#{number}" if number else None, model) if x) or (car.name if car else "")
    return f"Car {what}{f', {team.name},' if team is not None else ''} set on {runs} run{'' if runs == 1 else 's'}."


def put_on_events(db) -> None:
    """Every season's car on its events' runs, where it changed since it was last put on (season_match.fill_runs:
    only runs without a car get it). The caller holds calendar_sync._lock and commits."""
    from app import season_match

    cache: dict = {}
    for eid, s in sorted(seasons.seasons_of_events(db).items()):
        row = season_match._link_record(db, eid, s["id"])
        if row is None or row.status == "no":
            continue
        ev, season = db.get(models.Event, eid), db.get(seasons.Season, s["id"])
        if ev is None or season is None:
            continue
        if (row.done or {}).get("entry") != season_match._entry_now(db, ev, season, cache):
            season_match.fill_runs(db, ev, season, None, row)
    db.flush()
