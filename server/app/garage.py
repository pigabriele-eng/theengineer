"""The garage: teams, cars (number, model, team and the loggers fitted to them) and drivers (team and the cars they
drive), and a run's car and driver filled in from what its log says.

The new fields live in tables of their own, linked to the cars and drivers tables runs already hang off (no column of
an existing table changes). A car's name in the cars table is kept as "<model> #<number>": other screens show it, and
the vehicle presets are picked by the words in it (routers/balance.py).

A logger (the dash) stays in its car, so once a car is linked to its logger's serial number every log from that logger
is the car's: new uploads get the car (fill_from_log), and linking a logger gives its earlier runs without a car the
car too.
"""
from __future__ import annotations

from collections.abc import Iterable

from sqlalchemy import BigInteger, ForeignKey, String, UniqueConstraint, delete, func, select
from sqlalchemy.orm import Mapped, Session, mapped_column

from app import models
from app.db import Base


class Team(Base):
    __tablename__ = "teams"
    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(120))


class CarInfo(Base):
    """A car's number, model and team."""
    __tablename__ = "car_info"
    id: Mapped[int] = mapped_column(primary_key=True)
    car_id: Mapped[int] = mapped_column(ForeignKey("cars.id", ondelete="CASCADE"), unique=True, index=True)
    number: Mapped[str | None] = mapped_column(String(8))  # "21", "7B"
    model: Mapped[str | None] = mapped_column(String(100))  # "BMW M4 GT4 Evo (G82)"
    team_id: Mapped[int | None] = mapped_column(ForeignKey("teams.id", ondelete="SET NULL"))


class CarLogger(Base):
    """A logger (dash) by its serial number, and the car it is fitted to: every log from it is that car's."""
    __tablename__ = "car_loggers"
    id: Mapped[int] = mapped_column(primary_key=True)
    serial: Mapped[int] = mapped_column(BigInteger, unique=True, index=True)
    car_id: Mapped[int] = mapped_column(ForeignKey("cars.id", ondelete="CASCADE"), index=True)


class DriverInfo(Base):
    """A driver's team."""
    __tablename__ = "driver_info"
    id: Mapped[int] = mapped_column(primary_key=True)
    driver_id: Mapped[int] = mapped_column(ForeignKey("drivers.id", ondelete="CASCADE"), unique=True, index=True)
    team_id: Mapped[int | None] = mapped_column(ForeignKey("teams.id", ondelete="SET NULL"))


class DriverCar(Base):
    """A car a driver drives (one row per driver and car)."""
    __tablename__ = "driver_cars"
    __table_args__ = (UniqueConstraint("driver_id", "car_id"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    driver_id: Mapped[int] = mapped_column(ForeignKey("drivers.id", ondelete="CASCADE"), index=True)
    car_id: Mapped[int] = mapped_column(ForeignKey("cars.id", ondelete="CASCADE"), index=True)


def car_name(number: str | None, model: str | None) -> str:
    """The name the cars table keeps: "BMW M4 GT4 Evo (G82) #21", "Car #21" or the model alone."""
    number, model = (number or "").strip(), (model or "").strip()
    if model and number:
        return f"{model} #{number}"[:120]
    return model[:120] if model else f"Car #{number}"


def find_driver(db: Session, name: str) -> models.Driver | None:
    """An existing driver of that name, whatever its capitals."""
    same = select(models.Driver).where(func.lower(models.Driver.name) == name.strip().lower())
    return db.scalars(same.order_by(models.Driver.id)).first()


def fill_from_log(db: Session, s: models.RunSession, serial: int | None, driver: str | None) -> None:
    """A new log's run takes the car its logger is fitted to, and the driver its header names when that driver is
    known; a car or driver the run already has stays."""
    if s.car_id is None and serial:
        car_id = db.scalar(select(CarLogger.car_id).where(CarLogger.serial == serial))
        if car_id is not None:
            s.car = db.get(models.Car, car_id)
    if s.driver_id is None and (driver or "").strip():
        found = find_driver(db, driver)
        if found is not None:
            s.driver = found


def run_serials(s: models.RunSession) -> list[int]:
    """The serial numbers of the loggers a run's logs came from (CSV exports have none)."""
    return sorted({int(f.meta["device_serial"]) for f in s.files if f.meta.get("device_serial")})


def link_logger(db: Session, serial: int, car_id: int) -> list[int]:
    """Fit the logger to the car (moving it from any other car), and give the car to its runs that have none.
    Returns the runs given the car."""
    row = db.scalar(select(CarLogger).where(CarLogger.serial == serial))
    if row is None:
        db.add(CarLogger(serial=serial, car_id=car_id))
    else:
        row.car_id = car_id
    files = db.execute(select(models.LoggerFile.session_id, models.LoggerFile.meta)
                       .join(models.RunSession, models.RunSession.id == models.LoggerFile.session_id)
                       .where(models.RunSession.car_id.is_(None))).all()
    ids = sorted({sid for sid, meta in files if (meta or {}).get("device_serial") == serial})
    for s in db.scalars(select(models.RunSession).where(models.RunSession.id.in_(ids))).all() if ids else []:
        s.car_id = car_id
    db.flush()
    return ids


def put_car(db: Session, s: models.RunSession, car_id: int | None) -> tuple[list[int], int | None]:
    """Set (or clear) a run's car. A logger of the run that no car has yet is fitted to this one, and its other runs
    without a car get the car too: tagging one run of a weekend tags them all. Returns those other runs and the
    logger linked."""
    s.car_id = car_id
    db.flush()
    filled: set[int] = set()
    linked = None
    for serial in run_serials(s) if car_id is not None else []:
        if db.scalar(select(CarLogger.id).where(CarLogger.serial == serial)) is None:
            filled.update(link_logger(db, serial, car_id))
            linked = linked or serial
    return sorted(filled - {s.id}), linked


def link_driver(db: Session, driver_id: int, car_id: int) -> None:
    """The driver drives the car (once)."""
    have = select(DriverCar.id).where(DriverCar.driver_id == driver_id, DriverCar.car_id == car_id)
    if db.scalar(have) is None:
        db.add(DriverCar(driver_id=driver_id, car_id=car_id))
        db.flush()


def set_driver_cars(db: Session, driver_id: int, car_ids: Iterable[int]) -> None:
    db.execute(delete(DriverCar).where(DriverCar.driver_id == driver_id))
    for cid in dict.fromkeys(car_ids):
        db.add(DriverCar(driver_id=driver_id, car_id=cid))
    db.flush()


def set_car_drivers(db: Session, car_id: int, driver_ids: Iterable[int]) -> None:
    db.execute(delete(DriverCar).where(DriverCar.car_id == car_id))
    for did in dict.fromkeys(driver_ids):
        db.add(DriverCar(driver_id=did, car_id=car_id))
    db.flush()


def car_info(db: Session, car_id: int) -> CarInfo | None:
    return db.scalar(select(CarInfo).where(CarInfo.car_id == car_id))


def driver_info(db: Session, driver_id: int) -> DriverInfo | None:
    return db.scalar(select(DriverInfo).where(DriverInfo.driver_id == driver_id))


def set_driver_team(db: Session, driver_id: int, team_id: int | None) -> None:
    info = driver_info(db, driver_id)
    if info is None:
        if team_id is None:
            return
        info = DriverInfo(driver_id=driver_id)
        db.add(info)
    info.team_id = team_id
    db.flush()


def forget_driver(db: Session, driver_id: int) -> None:
    """The garage rows of a driver about to be removed."""
    db.execute(delete(DriverCar).where(DriverCar.driver_id == driver_id))
    db.execute(delete(DriverInfo).where(DriverInfo.driver_id == driver_id))
    db.flush()
