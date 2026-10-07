"""The garage (app/garage.py): teams, cars and drivers made, changed and removed in one place, and a run's driver and
car set with one call.

GET /garage is everything at once (a few rows each): teams, cars with their number, model, team, loggers and drivers,
drivers with their team and cars, and the loggers seen in the logs with the car each is fitted to. PATCH
/garage/runs/{id} sets a run's driver (an existing one, or a new one by name) and car.
"""
from __future__ import annotations

from collections import Counter

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import delete, func, select, update
from sqlalchemy.orm import Session

from app import garage, models
from app.db import get_db
from app.routers import drivers as driver_tags
from app.routers.imports import _date

router = APIRouter(prefix="/garage")

MODELS = ["BMW M4 GT4 Evo (G82)"]  # offered when a car is added, with the models already in the garage


class TeamIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)


class CarIn(BaseModel):
    """Only the fields sent change. A team by id, or by name (an existing team of that name, else a new one)."""
    number: str | None = Field(None, max_length=8)
    model: str | None = Field(None, max_length=100)
    team_id: int | None = None
    team_name: str | None = Field(None, max_length=120)
    loggers: list[int] | None = Field(None, max_length=20)  # serial numbers of the loggers fitted to it
    driver_ids: list[int] | None = Field(None, max_length=200)


class DriverIn(BaseModel):
    """Only the fields sent change."""
    name: str | None = Field(None, min_length=1, max_length=120)
    team_id: int | None = None
    team_name: str | None = Field(None, max_length=120)
    car_ids: list[int] | None = Field(None, max_length=200)


class RunIn(BaseModel):
    """Only the fields sent change: a driver by id or by name (an existing driver of that name, else a new one;
    driver_id null clears it), and a car by id (null clears it)."""
    driver_id: int | None = None
    driver_name: str | None = Field(None, max_length=120)
    car_id: int | None = None


# ---------- reading ----------

@router.get("")
def everything(db: Session = Depends(get_db)):
    """Teams, cars, drivers and the loggers seen in the logs, for the garage screen and the run pickers."""
    teams = db.scalars(select(garage.Team).order_by(func.lower(garage.Team.name))).all()
    team_name = {t.id: t.name for t in teams}
    infos = {i.car_id: i for i in db.scalars(select(garage.CarInfo)).all()}
    dinfos = {i.driver_id: i for i in db.scalars(select(garage.DriverInfo)).all()}
    loggers = db.execute(select(garage.CarLogger.serial, garage.CarLogger.car_id)).all()
    pairs = db.execute(select(garage.DriverCar.driver_id, garage.DriverCar.car_id).order_by(garage.DriverCar.id)).all()
    car_runs = Counter(dict(db.execute(select(models.RunSession.car_id, func.count())
                                       .group_by(models.RunSession.car_id)).all()))
    driver_runs = Counter(dict(db.execute(select(models.RunSession.driver_id, func.count())
                                          .group_by(models.RunSession.driver_id)).all()))

    cars = []
    for c in db.scalars(select(models.Car)).all():
        info = infos.get(c.id)
        tid = info.team_id if info else None
        cars.append({"id": c.id, "name": c.name, "number": info.number if info else None,
                     "model": info.model if info else None, "team_id": tid, "team": team_name.get(tid, c.team),
                     "loggers": sorted(s for s, cid in loggers if cid == c.id),
                     "driver_ids": [d for d, cid in pairs if cid == c.id], "runs": car_runs.get(c.id, 0)})
    cars.sort(key=lambda c: (_number_key(c["number"]), c["name"].lower()))
    drivers = []
    for d in db.scalars(select(models.Driver).order_by(func.lower(models.Driver.name))).all():
        tid = dinfos[d.id].team_id if d.id in dinfos else None
        drivers.append({"id": d.id, "name": d.name, "team_id": tid, "team": team_name.get(tid),
                        "car_ids": [cid for did, cid in pairs if did == d.id], "runs": driver_runs.get(d.id, 0)})
    out_teams = [{"id": t.id, "name": t.name, "car_ids": [c["id"] for c in cars if c["team_id"] == t.id],
                  "driver_ids": [d["id"] for d in drivers if d["team_id"] == t.id]} for t in teams]
    known = {c["model"] for c in cars if c["model"]}
    return {"teams": out_teams, "cars": cars, "drivers": drivers, "loggers": _loggers(db, dict(loggers)),
            "models": sorted(known | set(MODELS))}


def _number_key(number: str | None) -> tuple:
    digits = "".join(ch for ch in number or "" if ch.isdigit())
    return (0, int(digits), number) if digits else (1, 0, number or "")


def _loggers(db: Session, fitted: dict[int, int]) -> list[dict]:
    """Every logger serial in the logs, newest first: its runs, where and when it last logged, its car."""
    seen: dict[int, dict] = {}
    for sid, meta in db.execute(select(models.LoggerFile.session_id, models.LoggerFile.meta)).all():
        serial = (meta or {}).get("device_serial")
        if not serial:
            continue
        row = seen.setdefault(int(serial), {"serial": int(serial), "runs": set(), "last": None, "venue": None})
        row["runs"].add(sid)
        day = _date(meta.get("date") or "")
        if day is not None and (row["last"] is None or day.isoformat() > row["last"]):
            row["last"], row["venue"] = day.isoformat(), (meta.get("venue") or None)
    for serial in fitted:  # linked by hand before any log of it came in
        seen.setdefault(serial, {"serial": serial, "runs": set(), "last": None, "venue": None})
    out = [{**r, "runs": len(r["runs"]), "car_id": fitted.get(r["serial"])} for r in seen.values()]
    return sorted(out, key=lambda r: (r["last"] or "", r["serial"]), reverse=True)


# ---------- teams ----------

def _team(db: Session, team_id: int) -> garage.Team:
    t = db.get(garage.Team, team_id)
    if t is None:
        raise HTTPException(404, "Team not found")
    return t


def _team_by_name(db: Session, name: str) -> garage.Team:
    name = _text(name, "team")
    same = select(garage.Team).where(func.lower(garage.Team.name) == name.lower()).order_by(garage.Team.id)
    t = db.scalars(same).first()
    if t is None:
        t = garage.Team(name=name)
        db.add(t)
        db.flush()
    return t


def _team_of(db: Session, body: CarIn | DriverIn) -> tuple[bool, int | None]:
    """Whether the team was sent, and which (None: no team)."""
    sent = body.model_fields_set
    if (body.team_name or "").strip():
        return True, _team_by_name(db, body.team_name).id
    if "team_id" in sent:
        return True, _team(db, body.team_id).id if body.team_id is not None else None
    return False, None


@router.post("/teams", status_code=201)
def create_team(body: TeamIn, db: Session = Depends(get_db)):
    """A new team (an existing team of that name is given back instead of a second one)."""
    t = _team_by_name(db, body.name)
    db.commit()
    return {"id": t.id, "name": t.name}


@router.patch("/teams/{team_id}")
def rename_team(team_id: int, body: TeamIn, db: Session = Depends(get_db)):
    t = _team(db, team_id)
    t.name = _text(body.name, "team")
    for c in _team_cars(db, t.id):
        c.team = t.name
    db.commit()
    return {"id": t.id, "name": t.name}


@router.delete("/teams/{team_id}", status_code=204)
def delete_team(team_id: int, db: Session = Depends(get_db)):
    """Remove a team: its cars and drivers stay, without a team."""
    t = _team(db, team_id)
    for c in _team_cars(db, t.id):
        c.team = None
    db.execute(update(garage.CarInfo).where(garage.CarInfo.team_id == t.id).values(team_id=None))
    db.execute(update(garage.DriverInfo).where(garage.DriverInfo.team_id == t.id).values(team_id=None))
    db.delete(t)
    db.commit()


def _team_cars(db: Session, team_id: int) -> list[models.Car]:
    return list(db.scalars(select(models.Car).join(garage.CarInfo, garage.CarInfo.car_id == models.Car.id)
                           .where(garage.CarInfo.team_id == team_id)).all())


# ---------- cars ----------

def _car(db: Session, car_id: int) -> models.Car:
    c = db.get(models.Car, car_id)
    if c is None:
        raise HTTPException(404, "Car not found")
    return c


def _check_drivers(db: Session, ids: list[int]) -> list[int]:
    ids = list(dict.fromkeys(ids))
    found = set(db.scalars(select(models.Driver.id).where(models.Driver.id.in_(ids))).all()) if ids else set()
    if missing := [i for i in ids if i not in found]:
        raise HTTPException(404, f"Driver not found: {missing[0]}")
    return ids


def _check_cars(db: Session, ids: list[int]) -> list[int]:
    ids = list(dict.fromkeys(ids))
    found = set(db.scalars(select(models.Car.id).where(models.Car.id.in_(ids))).all()) if ids else set()
    if missing := [i for i in ids if i not in found]:
        raise HTTPException(404, f"Car not found: {missing[0]}")
    return ids


def _save_car(db: Session, car: models.Car | None, body: CarIn) -> dict:
    sent = body.model_fields_set
    info = garage.car_info(db, car.id) if car is not None else None
    number = (body.number or "").strip() or None if "number" in sent else (info.number if info else None)
    model = (body.model or "").strip() or None if "model" in sent else (info.model if info else None)
    if car is None and not (number or model):
        raise HTTPException(422, "Give the car a number or a model")
    if any(serial <= 0 for serial in body.loggers or []):
        raise HTTPException(422, "A logger serial number is a whole number above zero")
    team_sent, team_id = _team_of(db, body)
    drivers = _check_drivers(db, body.driver_ids) if body.driver_ids is not None else None
    if car is None:
        car = models.Car(name=garage.car_name(number, model))
        db.add(car)
        db.flush()
    if info is None:
        info = garage.CarInfo(car_id=car.id)
        db.add(info)
    if "number" in sent or "model" in sent:
        info.number, info.model = number, model
        if number or model:  # a car from before the garage keeps its name until it gets a number or model
            car.name = garage.car_name(number, model)
    if team_sent:
        info.team_id = team_id
        car.team = db.get(garage.Team, team_id).name if team_id is not None else None
    db.flush()
    filled: list[int] = []
    if body.loggers is not None:
        keep = set(body.loggers)
        db.execute(delete(garage.CarLogger).where(garage.CarLogger.car_id == car.id,
                                                  garage.CarLogger.serial.not_in(list(keep))))
        have = set(db.scalars(select(garage.CarLogger.serial).where(garage.CarLogger.car_id == car.id)).all())
        for serial in sorted(keep - have):
            filled += garage.link_logger(db, serial, car.id)
    if drivers is not None:
        garage.set_car_drivers(db, car.id, drivers)
    db.commit()
    row = next(c for c in everything(db)["cars"] if c["id"] == car.id)
    return {"car": row, "filled": sorted(set(filled))}


@router.post("/cars", status_code=201)
def create_car(body: CarIn, db: Session = Depends(get_db)):
    """A new car: its number, model, team, the loggers fitted to it (their runs without a car get it; filled lists
    them) and its drivers."""
    return _save_car(db, None, body)


@router.patch("/cars/{car_id}")
def update_car(car_id: int, body: CarIn, db: Session = Depends(get_db)):
    return _save_car(db, _car(db, car_id), body)


@router.delete("/cars/{car_id}", status_code=204)
def delete_car(car_id: int, db: Session = Depends(get_db)):
    """Remove a car: its runs stay, without a car; its loggers are no longer linked to a car."""
    c = _car(db, car_id)
    db.execute(update(models.RunSession).where(models.RunSession.car_id == c.id).values(car_id=None))
    db.execute(delete(garage.DriverCar).where(garage.DriverCar.car_id == c.id))
    db.execute(delete(garage.CarLogger).where(garage.CarLogger.car_id == c.id))
    db.execute(delete(garage.CarInfo).where(garage.CarInfo.car_id == c.id))
    db.delete(c)
    db.commit()


# ---------- drivers ----------

def _driver_row(db: Session, driver_id: int) -> dict:
    return next(d for d in everything(db)["drivers"] if d["id"] == driver_id)


@router.post("/drivers", status_code=201)
def create_driver(body: DriverIn, db: Session = Depends(get_db)):
    """A new driver with their team and cars (an existing driver of that name gets them instead of a second one)."""
    name = _text(body.name or "", "driver")
    d = garage.find_driver(db, name)
    if d is None:
        d = models.Driver(name=name)
        db.add(d)
        db.flush()
    return _save_driver(db, d, body)


@router.patch("/drivers/{driver_id}")
def update_driver(driver_id: int, body: DriverIn, db: Session = Depends(get_db)):
    d = db.get(models.Driver, driver_id)
    if d is None:
        raise HTTPException(404, "Driver not found")
    if "name" in body.model_fields_set and body.name is not None:
        d.name = _text(body.name, "driver")
    return _save_driver(db, d, body)


def _save_driver(db: Session, d: models.Driver, body: DriverIn) -> dict:
    team_sent, team_id = _team_of(db, body)
    if team_sent:
        garage.set_driver_team(db, d.id, team_id)
    if body.car_ids is not None:
        garage.set_driver_cars(db, d.id, _check_cars(db, body.car_ids))
    db.commit()
    return _driver_row(db, d.id)


@router.delete("/drivers/{driver_id}", status_code=204)
def delete_driver(driver_id: int, db: Session = Depends(get_db)):
    """Remove a driver (a typo, a duplicate): their runs and debrief points stay, without a driver."""
    if db.get(models.Driver, driver_id) is None:
        raise HTTPException(404, "Driver not found")
    garage.forget_driver(db, driver_id)
    driver_tags.delete_driver(driver_id, db)


# ---------- a run's driver and car ----------

@router.patch("/runs/{session_id}")
def set_run(session_id: int, body: RunIn, db: Session = Depends(get_db)):
    """Set a run's driver and car. A logger of the run that no car has yet is fitted to the car set, and its other
    runs without a car get the car too (filled). A driver set on a run of a car is counted as one of the car's
    drivers (offered first on its runs from then on); a driver made here joins the car's team."""
    s = db.get(models.RunSession, session_id)
    if s is None:
        raise HTTPException(404, "Session not found")
    sent = body.model_fields_set
    filled, linked = [], None
    if "car_id" in sent:
        filled, linked = garage.put_car(db, s, _car(db, body.car_id).id if body.car_id is not None else None)
    if "driver_id" in sent or (body.driver_name or "").strip():
        d, new = _pick_driver(db, body)
        s.driver_id = d.id if d else None
        db.flush()
        if d is not None and s.car_id is not None:
            garage.link_driver(db, d.id, s.car_id)
            info = garage.car_info(db, s.car_id)
            if new and info is not None and info.team_id is not None:
                garage.set_driver_team(db, d.id, info.team_id)
    db.commit()
    if "driver_id" in sent or (body.driver_name or "").strip():
        from app import driver_prints  # a tag teaches the driver fingerprints; looked up when used (tests reload it)
        driver_prints.refresh_in_background()
    driver = db.get(models.Driver, s.driver_id) if s.driver_id else None
    car = db.get(models.Car, s.car_id) if s.car_id else None
    return {"id": s.id, "driver_id": s.driver_id, "driver": driver.name if driver else None, "car_id": s.car_id,
            "car": car.name if car else None, "filled": filled, "logger": linked}


def _pick_driver(db: Session, body: RunIn) -> tuple[models.Driver | None, bool]:
    """The driver asked for, and whether it was made now."""
    name = (body.driver_name or "").strip()
    if name:
        d = garage.find_driver(db, name)
        if d is not None:
            return d, False
        d = models.Driver(name=name)
        db.add(d)
        db.flush()
        return d, True
    if body.driver_id is None:
        return None, False
    d = db.get(models.Driver, body.driver_id)
    if d is None:
        raise HTTPException(404, "Driver not found")
    return d, False


def _text(value: str, what: str) -> str:
    value = value.strip()
    if not value:
        raise HTTPException(422, f"Give the {what} a name")
    return value
