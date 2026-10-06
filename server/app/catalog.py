"""The garage's lists of vehicles and tyres, kept by hand.

A vehicle is a car model ("BMW M4 GT4 Evo (G82)") with what the Vehicle tool needs to know about it (specs: mass,
wheelbase, track widths, motion ratios, ...; may be empty). Each car of the garage picks its vehicle from this list
(car_models): a linked vehicle wins over the model typed on the car, which stays as it is.

A tyre is a brand and compound ("Pirelli P Zero DHG"), with its size and the P-Book's pressures when known (specs):
minimum cold and hot pressures front and rear, the target hot pressures and where they come from. Different tyres are
different kinds: the pressure calculator works per tyre kind.

New tables only (create_all adds them); no column of an existing table changes. Removing a vehicle or a tyre leaves
the events and seasons that named it without one (seasons.py reads a missing id as not set).
"""
from __future__ import annotations

import json
from datetime import UTC, datetime
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field, field_validator
from sqlalchemy import JSON, DateTime, ForeignKey, Integer, String, Text, delete, func, select
from sqlalchemy.orm import Mapped, Session, mapped_column

from app import models
from app.db import Base, get_db

MAX_SPECS = 20_000  # characters of JSON: a few dozen numbers and notes, never a log


def _now() -> datetime:
    return datetime.now(UTC)


class VehicleModel(Base):
    """A car model the garage knows, e.g. "BMW M4 GT4 Evo (G82)"."""
    __tablename__ = "vehicle_models"
    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(120), unique=True)
    maker: Mapped[str | None] = mapped_column(String(80))  # "BMW"
    car_class: Mapped[str | None] = mapped_column(String(40))  # "GT4"
    specs: Mapped[dict] = mapped_column(JSON, default=dict)  # what the Vehicle tool needs; may be empty
    notes: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)


class TyreKind(Base):
    """A tyre: brand and compound (its label), size, and the P-Book's pressures in specs."""
    __tablename__ = "tyre_kinds"
    id: Mapped[int] = mapped_column(primary_key=True)
    brand: Mapped[str] = mapped_column(String(80))  # "Pirelli"
    compound: Mapped[str] = mapped_column(String(80))  # "P Zero DHG"
    size: Mapped[str | None] = mapped_column(String(40))
    notes: Mapped[str | None] = mapped_column(Text)
    # {"cold_min_bar": {"front": x, "rear": y}, "hot_min_bar": {...}, "hot_target_bar": {...}, "source": "..."}
    specs: Mapped[dict] = mapped_column(JSON, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)


class CarModel(Base):
    """The vehicle a garage car is (one per car)."""
    __tablename__ = "car_models"
    id: Mapped[int] = mapped_column(primary_key=True)
    car_id: Mapped[int] = mapped_column(ForeignKey("cars.id", ondelete="CASCADE"), unique=True, index=True)
    vehicle_model_id: Mapped[int] = mapped_column(Integer, ForeignKey("vehicle_models.id", ondelete="CASCADE"))


# ---------- reading, for this router and seasons.py ----------

def tyre_label(t: TyreKind) -> str:
    return " ".join(p for p in ((t.brand or "").strip(), (t.compound or "").strip()) if p)


def vehicle_row(v: VehicleModel, car_ids: list[int] | None = None) -> dict:
    out = {"id": v.id, "name": v.name, "maker": v.maker, "car_class": v.car_class, "specs": v.specs or {},
           "notes": v.notes}
    if car_ids is not None:
        out["car_ids"] = car_ids
    return out


def tyre_row(t: TyreKind) -> dict:
    return {"id": t.id, "brand": t.brand, "compound": t.compound, "label": tyre_label(t), "size": t.size,
            "specs": t.specs or {}, "notes": t.notes}


def vehicle_of_car(db: Session, car_id: int | None) -> int | None:
    """The vehicle a car is linked to, if it still exists."""
    if car_id is None:
        return None
    return db.scalar(select(CarModel.vehicle_model_id).join(VehicleModel, VehicleModel.id == CarModel.vehicle_model_id)
                     .where(CarModel.car_id == car_id))


# ---------- the API ----------

router = APIRouter(prefix="/catalog")


class VehicleIn(BaseModel):
    """Only the fields sent change (a new vehicle needs a name)."""
    name: str | None = Field(None, min_length=1, max_length=120)
    maker: str | None = Field(None, max_length=80)
    car_class: str | None = Field(None, max_length=40)
    specs: dict[str, Any] | None = None
    notes: str | None = Field(None, max_length=4000)

    @field_validator("specs")
    @classmethod
    def _small(cls, v):
        if v is not None and len(json.dumps(v)) > MAX_SPECS:
            raise ValueError("specs are too long")
        return v


class Axle(BaseModel):
    front: float | None = Field(None, ge=0, le=10)
    rear: float | None = Field(None, ge=0, le=10)


class TyreSpecs(BaseModel):
    """The P-Book's pressures in bar; every part optional. Other keys are kept as sent."""
    model_config = ConfigDict(extra="allow")
    cold_min_bar: Axle | None = None
    hot_min_bar: Axle | None = None
    hot_target_bar: Axle | None = None
    source: str | None = Field(None, max_length=200)


class TyreIn(BaseModel):
    """Only the fields sent change (a new tyre needs a brand and a compound)."""
    brand: str | None = Field(None, min_length=1, max_length=80)
    compound: str | None = Field(None, min_length=1, max_length=80)
    size: str | None = Field(None, max_length=40)
    specs: TyreSpecs | None = None
    notes: str | None = Field(None, max_length=4000)

    @field_validator("specs")
    @classmethod
    def _small(cls, v):
        if v is not None and len(v.model_dump_json()) > MAX_SPECS:
            raise ValueError("specs are too long")
        return v


class CarVehicleIn(BaseModel):
    vehicle_model_id: int | None  # null: the car no longer has a vehicle


def _text(value: str | None, what: str) -> str:
    value = (value or "").strip()
    if not value:
        raise HTTPException(422, f"Give the {what}")
    return value


def _blank(value: str | None) -> str | None:
    return (value or "").strip() or None


def _vehicle(db: Session, vehicle_id: int) -> VehicleModel:
    v = db.get(VehicleModel, vehicle_id)
    if v is None:
        raise HTTPException(404, "Vehicle not found")
    return v


def _tyre(db: Session, tyre_id: int) -> TyreKind:
    t = db.get(TyreKind, tyre_id)
    if t is None:
        raise HTTPException(404, "Tyre not found")
    return t


def _cars_of(db: Session) -> dict[int, list[int]]:
    there = select(models.Car.id)
    out: dict[int, list[int]] = {}
    for car_id, vid in db.execute(select(CarModel.car_id, CarModel.vehicle_model_id)
                                  .where(CarModel.car_id.in_(there)).order_by(CarModel.car_id)).all():
        out.setdefault(vid, []).append(car_id)
    return out


@router.get("/vehicles")
def list_vehicles(db: Session = Depends(get_db)):
    """Every vehicle by name, with the garage cars linked to it."""
    cars = _cars_of(db)
    rows = db.scalars(select(VehicleModel).order_by(func.lower(VehicleModel.name))).all()
    return [vehicle_row(v, cars.get(v.id, [])) for v in rows]


def _save_vehicle(db: Session, v: VehicleModel, body: VehicleIn) -> dict:
    sent = body.model_fields_set
    if "name" in sent or v.id is None:
        name = _text(body.name, "vehicle a name")
        same = select(VehicleModel.id).where(func.lower(VehicleModel.name) == name.lower())
        if v.id is not None:
            same = same.where(VehicleModel.id != v.id)
        if db.scalar(same) is not None:
            raise HTTPException(409, f"There is already a vehicle called {name}")
        v.name = name
    if "maker" in sent:
        v.maker = _blank(body.maker)
    if "car_class" in sent:
        v.car_class = _blank(body.car_class)
    if "specs" in sent:
        v.specs = body.specs or {}
    if "notes" in sent:
        v.notes = _blank(body.notes)
    if v.id is None:
        db.add(v)
    db.commit()
    return vehicle_row(v, _cars_of(db).get(v.id, []))


@router.post("/vehicles", status_code=201)
def create_vehicle(body: VehicleIn, db: Session = Depends(get_db)):
    return _save_vehicle(db, VehicleModel(specs={}), body)


@router.put("/vehicles/{vehicle_id}")
def update_vehicle(vehicle_id: int, body: VehicleIn, db: Session = Depends(get_db)):
    return _save_vehicle(db, _vehicle(db, vehicle_id), body)


@router.delete("/vehicles/{vehicle_id}", status_code=204)
def delete_vehicle(vehicle_id: int, db: Session = Depends(get_db)):
    """Remove a vehicle: its cars stay, without a vehicle."""
    v = _vehicle(db, vehicle_id)
    db.execute(delete(CarModel).where(CarModel.vehicle_model_id == v.id))
    db.delete(v)
    db.commit()


@router.get("/tyres")
def list_tyres(db: Session = Depends(get_db)):
    """Every tyre by brand and compound."""
    rows = db.scalars(select(TyreKind).order_by(func.lower(TyreKind.brand), func.lower(TyreKind.compound),
                                                TyreKind.id)).all()
    return [tyre_row(t) for t in rows]


def _save_tyre(db: Session, t: TyreKind, body: TyreIn) -> dict:
    sent = body.model_fields_set
    if "brand" in sent or t.id is None:
        t.brand = _text(body.brand, "tyre a brand")
    if "compound" in sent or t.id is None:
        t.compound = _text(body.compound, "tyre a compound")
    if "size" in sent:
        t.size = _blank(body.size)
    if "specs" in sent:
        t.specs = body.specs.model_dump(exclude_none=True) if body.specs is not None else {}
    if "notes" in sent:
        t.notes = _blank(body.notes)
    if t.id is None:
        db.add(t)
    db.commit()
    return tyre_row(t)


@router.post("/tyres", status_code=201)
def create_tyre(body: TyreIn, db: Session = Depends(get_db)):
    return _save_tyre(db, TyreKind(specs={}), body)


@router.put("/tyres/{tyre_id}")
def update_tyre(tyre_id: int, body: TyreIn, db: Session = Depends(get_db)):
    return _save_tyre(db, _tyre(db, tyre_id), body)


@router.delete("/tyres/{tyre_id}", status_code=204)
def delete_tyre(tyre_id: int, db: Session = Depends(get_db)):
    """Remove a tyre: events and seasons that named it are left without one."""
    db.delete(_tyre(db, tyre_id))
    db.commit()


@router.put("/cars/{car_id}/vehicle")
def set_car_vehicle(car_id: int, body: CarVehicleIn, db: Session = Depends(get_db)):
    """Link a garage car to its vehicle (or unlink it). The model typed on the car is left as it is."""
    if db.get(models.Car, car_id) is None:
        raise HTTPException(404, "Car not found")
    row = db.scalar(select(CarModel).where(CarModel.car_id == car_id))
    if body.vehicle_model_id is None:
        if row is not None:
            db.delete(row)
    else:
        _vehicle(db, body.vehicle_model_id)
        if row is None:
            db.add(CarModel(car_id=car_id, vehicle_model_id=body.vehicle_model_id))
        else:
            row.vehicle_model_id = body.vehicle_model_id
    db.commit()
    return {"car_id": car_id, "vehicle_model_id": body.vehicle_model_id}
