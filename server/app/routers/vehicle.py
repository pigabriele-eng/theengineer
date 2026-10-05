"""Vehicle tools: the steady-state vehicle model, setup what-ifs, car presets and the tyre fit from logs."""
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.db import get_db
from app.routers.sessions import _get, load_main_file
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
