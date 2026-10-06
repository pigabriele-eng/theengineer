"""Vehicle tools: the steady-state vehicle model, setup what-ifs, car presets and the tyre fit from logs."""
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app import catalog
from app.db import get_db
from app.heavy import one_at_a_time
from app.routers.sessions import _get, load_main_file
from app.vehicle import specs as vehicle_specs
from app.vehicle.model import Change, Vehicle, compute, what_if
from app.vehicle.presets import PRESETS, preset_detail, preset_vehicle
from app.vehicle.tyre_fit import NotEnoughData, fit_tyres

router = APIRouter(prefix="/vehicle")


@router.get("/presets")
def list_presets():
    return [{"key": k, "name": name} for k, (name, _, _) in PRESETS.items()]


@router.get("/presets/{key}")
def get_preset(key: str):
    """The preset's setup, ready for /vehicle/model, and where each value comes from (published or estimate)."""
    if key not in PRESETS:
        raise HTTPException(404, "No such car preset")
    return preset_detail(key)


@router.get("/vehicles")
def list_vehicles(session_id: int | None = None, db: Session = Depends(get_db)):
    """The garage's vehicles for the Vehicle tool, and the vehicle of the session named (its event's, else its
    car's)."""
    return {"vehicles": vehicle_specs.listing(db),
            "session_vehicle_id": vehicle_specs.session_vehicle(db, _get(db, session_id).id)
            if session_id is not None else None}


def _vehicle(db: Session, vehicle_id: int) -> catalog.VehicleModel:
    v = db.get(catalog.VehicleModel, vehicle_id)
    if v is None:
        raise HTTPException(404, "Vehicle not found")
    return v


@router.get("/vehicles/{vehicle_id}")
def get_vehicle(vehicle_id: int, db: Session = Depends(get_db)):
    """The vehicle's inputs for /vehicle/model, like a preset: its stored specs, the rest from the preset its name
    points to, and which it still needs."""
    return vehicle_specs.detail(_vehicle(db, vehicle_id))


@router.put("/vehicles/{vehicle_id}/specs")
def save_vehicle_specs(vehicle_id: int, body: Vehicle, db: Session = Depends(get_db)):
    """Store these inputs as the vehicle's specs (anything else in its specs is kept)."""
    v = _vehicle(db, vehicle_id)
    v.specs = {**(v.specs or {}), **body.model_dump()}
    db.commit()
    return vehicle_specs.detail(v)


@router.post("/model")
def vehicle_model(body: Vehicle):
    """Wheel rates, ride frequencies, roll stiffness and its distribution, roll gradient, load transfer, balance."""
    try:
        return compute(body)
    except ValueError as e:
        raise HTTPException(422, str(e)) from e


class WhatIfIn(BaseModel):
    baseline: Vehicle
    changes: list[Change] = Field(min_length=1)


@router.post("/what-if")
def vehicle_what_if(body: WhatIfIn):
    """A baseline and a change (e.g. rear bar one setting softer, front spring +10 %): the deltas and a sentence."""
    try:
        return what_if(body.baseline, body.changes)
    except ValueError as e:
        raise HTTPException(422, str(e)) from e


class TyreFitIn(BaseModel):
    session_ids: list[int] = Field(min_length=1)
    preset: str = "bmw-m4-gt4-evo"
    vehicle: Vehicle | None = None  # replaces the preset
    steering_ratio: float | None = Field(None, gt=0, description="Steering wheel deg per road wheel deg")


@router.post("/tyre-fit")
@one_at_a_time
def tyre_fit(body: TyreFitIn, db: Session = Depends(get_db)):
    """A simplified lateral tyre curve per axle (peak mu, slip at peak, shape) fitted from the sessions' logs."""
    if body.vehicle is None and body.preset not in PRESETS:
        raise HTTPException(404, "No such car preset")
    car = body.vehicle or preset_vehicle(body.preset)
    sessions = [load_main_file(db, _get(db, sid))[1] for sid in dict.fromkeys(body.session_ids)]
    try:
        out = fit_tyres(sessions, car, body.steering_ratio)
    except NotEnoughData as e:
        raise HTTPException(422, str(e)) from e
    for s in out["skipped"]:
        s["session_id"] = body.session_ids[s.pop("index")]
    return out
