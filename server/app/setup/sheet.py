"""Setup sheets across runs: the order runs were driven in, the previous run's setup, what changed from run to run
next to what the lap times and balance did, and a session's setup turned into the vehicle model's inputs."""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime

from sqlalchemy import select
from sqlalchemy.orm import Session

from app import models
from app.routers.imports import _date
from app.setup import results
from app.setup.models import SessionSetup
from app.setup.templates import TEMPLATES, Template, diff, format_value, template_for_car, warnings
from app.vehicle.model import Vehicle
from app.vehicle.presets import PRESETS, preset_vehicle


def run_time(s: models.RunSession) -> datetime:
    """When the run was driven: its main log's date and time (local, from the logger), else when the session was
    created. Naive, so every session compares."""
    f = max(s.files, key=lambda f: f.meta.get("duration_s", 0)) if s.files else None
    if f is not None:
        day = _date(f.meta.get("date") or "")
        if day is not None:
            try:
                t = datetime.strptime((f.meta.get("time") or "00:00:00").strip(), "%H:%M:%S").time()
            except ValueError:
                t = datetime.min.time()
            return datetime.combine(day, t)
    return s.created_at.replace(tzinfo=None)


def _order(s: models.RunSession) -> tuple:
    return run_time(s), s.id


def setup_of(db: Session, session_id: int) -> SessionSetup | None:
    return db.scalar(select(SessionSetup).where(SessionSetup.session_id == session_id))


def template_of(db: Session, s: models.RunSession, setup: SessionSetup | None = None) -> Template:
    """The session's own template, else the previous run's, else the one its car's name points to."""
    if setup is not None and setup.template in TEMPLATES:
        return TEMPLATES[setup.template]
    prev = previous_setup(db, s)
    if prev is not None and prev[1].template in TEMPLATES:
        return TEMPLATES[prev[1].template]
    return TEMPLATES[template_for_car(s.car.name if s.car else None)]


def previous_setup(db: Session, s: models.RunSession) -> tuple[models.RunSession, SessionSetup] | None:
    """The setup of the last run before this one that has a sheet (the same car's, when the session names one)."""
    rows = db.execute(select(models.RunSession, SessionSetup)
                      .join(SessionSetup, SessionSetup.session_id == models.RunSession.id)
                      .where(models.RunSession.id != s.id)).all()
    me = _order(s)
    earlier = [(r, st) for r, st in rows if _order(r) < me and (s.car_id is None or r.car_id in (None, s.car_id))]
    return max(earlier, key=lambda x: _order(x[0])) if earlier else None


def related_sessions(db: Session, s: models.RunSession) -> list[models.RunSession]:
    """The runs to compare this one with, in the order they were driven: its event's, else the sessions without
    an event at the same venue."""
    if s.event_id is not None:
        rows = db.scalars(select(models.RunSession).where(models.RunSession.event_id == s.event_id)).all()
    else:
        venue = _venue(s)
        rows = [r for r in db.scalars(select(models.RunSession).where(models.RunSession.event_id.is_(None))).all()
                if _venue(r) == venue]
    return sorted(rows, key=_order)


def _venue(s: models.RunSession) -> str:
    return next((f.meta.get("venue") or "" for f in s.files), "")


def sheet(db: Session, s: models.RunSession) -> dict:
    """The session's setup sheet for the app: its values, the previous run's, and what changed."""
    own = setup_of(db, s.id)
    template = template_of(db, s, own)
    prev = previous_setup(db, s)
    values = own.values if own else {}
    prev_values = prev[1].values if prev and prev[1].template == template.key else None
    return {
        "session_id": s.id,
        "exists": own is not None,
        "template": template.key,
        "values": values,
        "notes": own.notes if own else None,
        "copied_from_session_id": own.copied_from_session_id if own else None,
        "updated_at": own.updated_at if own else None,
        "previous": {"session_id": prev[0].id, "name": prev[0].name, "values": prev[1].values,
                     "template": prev[1].template} if prev else None,
        "changes": diff(template, prev_values, values) if own and prev_values is not None else [],
        "warnings": warnings(template, values),
    }


def _num(a: float | None, b: float | None, nd: int = 3) -> float | None:
    return round(b - a, nd) if a is not None and b is not None else None


def _deltas(before: dict, after: dict) -> dict:
    """Lap times and balance of one run against another (after - before)."""
    out = {"best_s": _num(before["laps"]["best_s"], after["laps"]["best_s"]),
           "top3_s": _num(before["laps"]["top3_s"], after["laps"]["top3_s"])}
    a, b = (before.get("summary") or {}), (after.get("summary") or {})
    ba, bb = a.get("balance") or {}, b.get("balance") or {}
    out["balance"] = {k: _num(ba.get(k), bb.get(k)) for k in ("entry", "mid", "exit", "gradient_per_g")}
    out["tc_s_per_lap"] = _num(a.get("tc_s_per_lap"), b.get("tc_s_per_lap"), 2)
    out["abs_s_per_lap"] = _num(a.get("abs_s_per_lap"), b.get("abs_s_per_lap"), 2)
    return out


def history(db: Session, s: models.RunSession) -> dict:
    """Every run of the session's event in order: its setup, what changed from the run it is compared with, and
    what the lap times and balance did. A run is compared with the last run before it that has a sheet and clean
    laps (else just a sheet). Balance numbers appear once a run's summary has been worked out
    (GET /sessions/{id}/setup/results)."""
    runs = related_sessions(db, s)
    setups = {st.session_id: st for st in
              db.scalars(select(SessionSetup).where(SessionSetup.session_id.in_([r.id for r in runs]))).all()}
    rows = []
    for r in runs:
        st = setups.get(r.id)
        rows.append({"session_id": r.id, "name": r.name, "run_time": run_time(r).isoformat(),
                     "track_temp_c": r.track_temp_c, "ambient_temp_c": r.ambient_temp_c, "tyre_set": r.tyre_set,
                     "has_setup": st is not None, "template": st.template if st else None,
                     "values": st.values if st else None, "laps": results.lap_times(r.laps),
                     "summary": results.cached(db, r), "needs_summary": False,
                     "compared_with": None, "changes": [], "deltas": None})
        rows[-1]["needs_summary"] = rows[-1]["summary"] is None and rows[-1]["laps"]["clean_laps"] > 0
    for i, row in enumerate(rows):
        if not row["has_setup"]:
            continue
        earlier = [x for x in rows[:i] if x["has_setup"] and x["template"] == row["template"]]
        base = next((x for x in reversed(earlier) if x["laps"]["clean_laps"]), None) or \
            (earlier[-1] if earlier else None)
        if base is None:
            continue
        row["compared_with"] = {"session_id": base["session_id"], "name": base["name"]}
        row["changes"] = diff(TEMPLATES[row["template"]], base["values"], row["values"])
        if row["laps"]["clean_laps"] and base["laps"]["clean_laps"]:
            row["deltas"] = _deltas(base, row)
    return {"session_id": s.id, "event_id": s.event_id, "runs": rows}


# ---------- the vehicle model ----------

@dataclass(frozen=True)
class VehicleLink:
    """How a car's sheet sets its vehicle model preset: the mass from fuel and ballast, the CoG from the ride
    heights."""
    base_mass_kg: float  # the car without driver and fuel
    driver_kg: float
    default_ballast_kg: float  # what the preset's mass assumes when the sheet has no ballast
    fuel_density: float  # kg/L
    ride_height_ref_mm: tuple[float, float]  # front, rear: where the preset's CoG height applies
    note: str


VEHICLE_LINKS = {
    "bmw-m4-gt4-evo": VehicleLink(
        1480.0, 85.0, 30.0, 0.75, (155.0, 160.0),
        "Mass = 1480 kg SRO minimum (without driver and fuel) + ballast + 85 kg driver (the ADAC minimum average) "
        "+ fuel at 0.75 kg/L. The CoG moves with the average ride height from the BoP minimums (155.0 / 160.0 mm)."),
}


def to_vehicle(template: Template, values: dict) -> dict:
    """The vehicle model's inputs for this setup: the car's preset with what the sheet sets on top, and a list of
    what was taken from the sheet and what the model can't use."""
    if template.vehicle_preset not in PRESETS:
        raise LookupError(f"The {template.name} sheet has no vehicle model preset yet")
    car = preset_vehicle(template.vehicle_preset).model_dump()
    link = VEHICLE_LINKS.get(template.vehicle_preset)
    rows = template.rows
    applied: list[dict] = []
    notes: list[str] = []

    def put(field: str, value: float, source: str) -> None:
        car[field] = value
        applied.append({"field": field, "value": value, "from": source})

    for axle in ("front", "rear"):
        pos = values.get(f"arb_{axle}")
        rates = car.get(f"arb_{axle}_settings_n_per_mm")
        if pos is not None and rates and 1 <= pos <= len(rates):
            put(f"arb_{axle}_setting", int(pos), f"Anti-roll bar {axle} {pos}")
        rate = values.get(f"spring_rate_{axle}")
        if rate:
            put(f"spring_{axle}_n_per_mm", float(rate), f"Spring rate {axle} {rate:g} N/mm")
        elif values.get(f"spring_{axle}") is not None and "spring" in rows:
            notes.append(f"Spring {axle}: {format_value(rows['spring'], values[f'spring_{axle}'])} on the sheet, but "
                         f"the H&R rates are not public, so the model keeps its {car[f'spring_{axle}_n_per_mm']:g} "
                         "N/mm estimate. Enter the rate on the sheet to use it.")
    if link is not None:
        fuel, ballast = values.get("fuel"), values.get("ballast")
        if fuel is not None or ballast is not None:
            b = ballast if ballast is not None else link.default_ballast_kg
            f = fuel if fuel is not None else (car["mass_kg"] - link.base_mass_kg - link.default_ballast_kg
                                               - link.driver_kg) / link.fuel_density
            mass = link.base_mass_kg + b + link.driver_kg + f * link.fuel_density
            put("mass_kg", round(mass, 1), f"{b:g} kg ballast, {f:.0f} L fuel")
        rf, rr = values.get("ride_height_front"), values.get("ride_height_rear")
        if rf is not None and rr is not None:
            shift = (rf + rr) / 2 - sum(link.ride_height_ref_mm) / 2
            put("cog_height_mm", round(car["cog_height_mm"] + shift, 1), f"Ride heights {rf:g} / {rr:g} mm")
        notes.append(link.note)
    if values.get("wing") is not None:
        notes.append("Rear wing: no aero map is public, so the model's downforce and aero balance don't change "
                     "with the wing position.")
    return {"preset": template.vehicle_preset, "vehicle": Vehicle.model_validate(car).model_dump(),
            "applied": applied, "notes": notes}
