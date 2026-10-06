"""A garage vehicle (catalog.VehicleModel) as the vehicle model's inputs: the car model is per vehicle.

A vehicle's specs hold the vehicle model's inputs by their names (vehicle/model.py Vehicle: mass_kg, wheelbase_mm,
track_front_mm, spring_mr_front, ...). What its specs leave out comes from the built-in preset its name points to
(vehicle/presets.py, with each value's source and confidence), else from the model's own default where it has one,
else stays empty for the user to fill in. Specs entered for the Vehicle tool replace the preset's estimates.
"""
from __future__ import annotations

from dataclasses import asdict

from pydantic import ValidationError
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app import catalog, seasons
from app.setup.templates import TEMPLATES
from app.vehicle.model import Vehicle
from app.vehicle.presets import PRESETS, STEERING_RATIO, preset_detail

# Words in a vehicle's name that pick its built-in preset (all of them must be there)
PRESET_WORDS = {"bmw-m4-gt4-evo": ("m4", "gt4")}
FIELDS = tuple(Vehicle.model_fields)
LISTS = ("arb_front_settings_n_per_mm", "arb_rear_settings_n_per_mm")
SETTINGS = ("arb_front_setting", "arb_rear_setting")


def preset_for(name: str | None) -> str | None:
    words = (name or "").lower()
    return next((k for k, ws in PRESET_WORDS.items() if k in PRESETS and all(w in words for w in ws)), None)


def template_for(v: catalog.VehicleModel) -> str:
    """The setup sheet that fits the vehicle: the one its name points to, else the plain-numbers sheet."""
    words = f"{v.maker or ''} {v.name}".lower()
    return next((t.key for t in TEMPLATES.values() if t.match and any(m in words for m in t.match)), "generic")


def _value(field: str, v):
    """A stored spec in the form the model takes, or None when it isn't one."""
    if field in LISTS:
        if isinstance(v, list) and v and all(isinstance(x, int | float) and not isinstance(x, bool) for x in v):
            return [float(x) for x in v]
        return None
    if isinstance(v, bool) or not isinstance(v, int | float):
        return None
    return int(v) if field in SETTINGS else float(v)


def stored(v: catalog.VehicleModel) -> dict:
    """The vehicle model inputs in the vehicle's specs (anything else in them is left out)."""
    specs = v.specs or {}
    out = {}
    for f in FIELDS:
        if f in specs and (x := _value(f, specs[f])) is not None:
            out[f] = x
    return out


def detail(v: catalog.VehicleModel) -> dict:
    """Like a preset (routers/vehicle.py /presets/{key}): the inputs, where each comes from, and which the vehicle
    still needs (missing: no stored spec, no preset, no default)."""
    mine = stored(v)
    base_key = preset_for(v.name)
    base = preset_detail(base_key) if base_key else None
    vehicle: dict = {}
    values: dict = {}
    missing: list[str] = []
    for f, info in Vehicle.model_fields.items():
        if f in mine:
            vehicle[f] = mine[f]
            values[f] = {"value": mine[f], "confidence": "stored", "source": None,
                         "note": f"From {v.name}'s specs in the garage."}
        elif base is not None:
            vehicle[f] = base["vehicle"][f]
            if f in base["values"]:
                values[f] = base["values"][f]
        elif not info.is_required():
            vehicle[f] = info.default
            values[f] = {"value": info.default, "confidence": "unknown", "source": None,
                         "note": "Not in the vehicle's specs: the model's default. Enter yours."}
        else:
            vehicle[f] = None
            missing.append(f)
    problem = None
    if not missing:
        try:
            Vehicle.model_validate(vehicle)
        except ValidationError as e:
            problem = "; ".join(f"{'.'.join(map(str, x['loc'])) or 'vehicle'}: {x['msg']}" for x in e.errors())
    return {"key": f"vehicle:{v.id}", "id": v.id, "name": v.name, "vehicle": vehicle, "values": values,
            "steering_ratio": base["steering_ratio"] if base else asdict(STEERING_RATIO),
            "published": sorted(f for f, x in values.items() if x.get("confidence") == "published"),
            "stored": sorted(mine), "missing": missing, "problem": problem,
            "base": {"key": base_key, "name": PRESETS[base_key][0]} if base_key else None,
            "template": template_for(v)}


def vehicle_inputs(db: Session, vehicle_model_id: int) -> tuple[dict, catalog.VehicleModel]:
    """The vehicle's inputs, complete and valid, and the vehicle. LookupError naming what is missing or wrong."""
    v = db.get(catalog.VehicleModel, vehicle_model_id)
    if v is None:
        raise LookupError("Vehicle not found")
    d = detail(v)
    if d["missing"]:
        raise LookupError(f"{v.name} has no {', '.join(d['missing'])} in its specs: enter them in the vehicle model "
                          "and save them to the vehicle")
    if d["problem"]:
        raise LookupError(f"{v.name}'s specs don't add up: {d['problem']}")
    return Vehicle.model_validate(d["vehicle"]).model_dump(), v


def session_vehicle(db: Session, session_id: int) -> int | None:
    """The vehicle a session's car is (its event's, else its car's), if it still exists."""
    vid = seasons.vehicle_for_session(db, session_id)
    return vid if vid is not None and db.get(catalog.VehicleModel, vid) is not None else None


def listing(db: Session) -> list[dict]:
    """Every vehicle by name, with how many of the vehicle model's inputs its specs hold and the sheet it uses."""
    rows = db.scalars(select(catalog.VehicleModel).order_by(func.lower(catalog.VehicleModel.name))).all()
    out = []
    for v in rows:
        d = detail(v)
        out.append({"id": v.id, "name": v.name, "maker": v.maker, "car_class": v.car_class,
                    "stored": len(d["stored"]), "missing": d["missing"], "base": d["base"],
                    "template": d["template"]})
    return out
