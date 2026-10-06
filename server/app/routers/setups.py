"""Setup sheets: a setup per session on its car's template, run-to-run changes against lap time and balance, the
setup in the vehicle model, and one ranked list of setup changes from the driver's debrief and the balance report."""
import logging
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from app import models
from app.db import get_db
from app.routers.sessions import _get
from app.setup import data as balance_data
from app.setup import results, sheet
from app.setup.models import SessionSetup
from app.setup.suggest import Observation, _speed_of, data_observations, driver_observations, observation_dict, suggest
from app.setup.templates import TEMPLATES, InvalidSetup, clean_values
from app.vehicle import specs as vehicle_specs
from app.vehicle.model import Vehicle

log = logging.getLogger(__name__)
router = APIRouter()


@router.get("/setup/templates")
def list_templates():
    return [{"key": t.key, "name": t.name} for t in TEMPLATES.values()]


@router.get("/setup/templates/{key}")
def get_template(key: str):
    """Groups of rows: what can be set on the car, in its own positions and units, and where each comes from."""
    if key not in TEMPLATES:
        raise HTTPException(404, "No such setup template")
    return TEMPLATES[key].to_dict()


@router.get("/setups")
def list_setups(db: Session = Depends(get_db)):
    """The sessions that have a setup sheet, most recent run first."""
    rows = db.execute(select(models.RunSession, SessionSetup)
                      .join(SessionSetup, SessionSetup.session_id == models.RunSession.id)).all()
    rows = sorted(rows, key=lambda x: sheet._order(x[0]), reverse=True)
    return [{"session_id": s.id, "name": s.name, "event_id": s.event_id, "template": st.template,
             "run_time": sheet.run_time(s).isoformat(), "updated_at": st.updated_at} for s, st in rows]


@router.get("/sessions/{session_id}/setup")
def get_setup(session_id: int, db: Session = Depends(get_db)):
    """The session's setup sheet (exists=false and no values when there is none yet), the previous run's sheet to
    copy from, what changed from it, and values outside the car's positions or limits."""
    return sheet.sheet(db, _get(db, session_id))


class SetupIn(BaseModel):
    template: str | None = Field(None, max_length=40)  # default: the sheet's own, else the previous run's
    values: dict[str, float | int | None] = {}
    notes: str | None = Field(None, max_length=4000)


@router.put("/sessions/{session_id}/setup")
def save_setup(session_id: int, body: SetupIn, db: Session = Depends(get_db)):
    """Store the session's whole sheet: fields left out or blank are not recorded. Notes are kept unless sent."""
    s = _get(db, session_id)
    own = sheet.setup_of(db, s.id)
    key = body.template or sheet.template_of(db, s, own).key
    if key not in TEMPLATES:
        raise HTTPException(422, f"No setup template '{key}'")
    try:
        values = clean_values(TEMPLATES[key], body.values)
    except InvalidSetup as e:
        raise HTTPException(422, str(e)) from e
    if own is None:
        own = SessionSetup(session_id=s.id)
        db.add(own)
    own.template, own.values = key, values
    if "notes" in body.model_fields_set:
        own.notes = (body.notes or "").strip() or None
    db.commit()
    return sheet.sheet(db, s)


@router.post("/sessions/{session_id}/setup/copy-previous")
def copy_previous(session_id: int, db: Session = Depends(get_db)):
    """Quick entry: this session's sheet becomes a copy of the previous run's, ready to change a few fields."""
    s = _get(db, session_id)
    prev = sheet.previous_setup(db, s)
    if prev is None:
        raise HTTPException(409, "No earlier run has a setup sheet to copy")
    own = sheet.setup_of(db, s.id)
    if own is None:
        own = SessionSetup(session_id=s.id)
        db.add(own)
    own.template, own.values, own.copied_from_session_id = prev[1].template, dict(prev[1].values), prev[0].id
    db.commit()
    return sheet.sheet(db, s)


@router.get("/sessions/{session_id}/setup/history")
def setup_history(session_id: int, db: Session = Depends(get_db)):
    """The event's runs in order, each with its setup, the changes from the run it is compared with and what
    the lap times and balance did. Runs with needs_summary=true get their balance from /setup/results."""
    return sheet.history(db, _get(db, session_id))


@router.get("/sessions/{session_id}/setup/results")
def setup_results(session_id: int, db: Session = Depends(get_db)):
    """The run's lap times and its balance by corner phase and speed (read from its log once, then kept)."""
    s = _get(db, session_id)
    return {"session_id": s.id, "laps": results.lap_times(s.laps), "summary": results.run_summary(db, s)}


def _base(db: Session, s: models.RunSession, vehicle_model_id: int | None) -> tuple[dict | None, dict | None]:
    """The vehicle model inputs a setup goes on top of: the vehicle named, else the session's (its event's, else
    its car's), from its specs; None (the sheet's preset) when there is neither. LookupError when the vehicle's
    specs are incomplete."""
    vid = vehicle_model_id if vehicle_model_id is not None else vehicle_specs.session_vehicle(db, s.id)
    if vid is None:
        return None, None
    base, v = vehicle_specs.vehicle_inputs(db, vid)
    return base, {"id": v.id, "name": v.name}


@router.get("/sessions/{session_id}/setup/vehicle")
def setup_vehicle(session_id: int, vehicle_model_id: int | None = None, db: Session = Depends(get_db)):
    """The session's setup as vehicle model inputs: the vehicle's (the one named, else the session's, else the
    sheet's preset) with the sheet's bars, spring rates, fuel, ballast and ride heights, plus what the model can't
    take from the sheet."""
    s = _get(db, session_id)
    own = sheet.setup_of(db, s.id)
    if own is None:
        raise HTTPException(404, "This session has no setup sheet yet")
    try:
        base, vehicle = _base(db, s, vehicle_model_id)
        return {"session_id": s.id, "name": s.name, "vehicle_model": vehicle,
                **sheet.to_vehicle(sheet.template_of(db, s, own), own.values, base)}
    except LookupError as e:
        raise HTTPException(404, str(e)) from e


class ObservationIn(BaseModel):
    kind: Literal["understeer", "oversteer", "traction", "braking_stability", "lock_up", "ride"]
    phase: Literal["braking", "entry", "mid", "exit"] | None = None
    corner: str | None = Field(None, max_length=16)
    speed: Literal["slow", "medium", "fast"] | None = None
    weight: float = Field(1.0, ge=0, le=10)
    source: Literal["driver", "data"] = "data"
    text: str = Field("", max_length=500)
    time_s: float | None = None


class SuggestIn(BaseModel):
    observations: list[ObservationIn] = Field([], max_length=200)


def _suggestions(db: Session, s: models.RunSession, extra: list[Observation],
                 vehicle_model_id: int | None = None) -> dict:
    own = sheet.setup_of(db, s.id)
    template = sheet.template_of(db, s, own)
    values = own.values if own else {}
    notes = []
    summary = None
    if s.files and any(l.clean for l in s.laps):
        try:
            summary = results.run_summary(db, s)  # the balance report's analysis of this run, kept
        except Exception as e:  # an unreadable log leaves the driver's side standing
            log.exception("Balance analysis failed for session %s", s.id)
            db.rollback()
            notes.append(f"The logger data is left out: {getattr(e, 'detail', None) or e}")
    if summary is not None and "sections" not in summary:
        summary = None
    corners = (summary or {}).get("corners", [])
    points = [p for d in s.debriefs if d.status == models.DebriefStatus.ready for p in d.points]
    driver, skipped = driver_observations(points, corners)
    for o in driver:
        o.check = balance_data.check(o, summary)
    sources, source_notes = data_observations(db, s)
    notes += source_notes
    for o in [*sources, *extra]:
        o.speed = o.speed or _speed_of(o.corner, corners)
    observations = [*driver, *sources, *extra]
    measured = balance_data.measured(summary)
    advice = (summary or {}).get("advice") or {}
    vehicle = None
    try:
        base, _ = _base(db, s, vehicle_model_id)
    except LookupError:  # the vehicle's specs aren't complete yet: the sheet's preset, as without a vehicle
        base = None
    if base is not None or template.vehicle_preset:
        try:
            vehicle = Vehicle.model_validate(sheet.to_vehicle(template, values, base)["vehicle"])
        except (LookupError, ValueError):
            vehicle = None
    ranked = suggest(template, values, observations, vehicle, advice=advice.get("recommendations"),
                     measured=measured)
    notes += ranked["notes"]
    if not points:
        notes.append("No debrief for this session yet: record or type one, and its points about balance, traction, "
                     "braking and kerbs are ranked here with the data.")
    if summary is None and not any(n.startswith("The logger data") for n in notes):
        notes.append("No log with clean laps for this session, so the suggestions come from the debrief only.")
    if own is None:
        notes.append("This session has no setup sheet, so the changes are given as steps from wherever the car is.")
    return {"session_id": s.id, "template": template.key, "has_setup": own is not None,
            "observations": [observation_dict(o) for o in observations],
            "measured": [observation_dict(m) for m in measured], "skipped_points": skipped,
            "suggestions": ranked["suggestions"], "notes": notes,
            "data": {"headline": advice.get("headline"), "notes": advice.get("notes") or [],
                     "checks": advice.get("checks") or [], "lap_split": summary.get("lap_split")}
            if summary is not None else None}


@router.get("/sessions/{session_id}/setup/suggestions")
def setup_suggestions(session_id: int, vehicle_model_id: int | None = None, db: Session = Depends(get_db)):
    """Ranked setup changes to try, in one list from the session's debrief and the balance report's analysis of
    its log: each with its reason, what to expect and what to watch, whether driver and data agree, and where they
    disagree. Driver remarks carry the data's check of them. The vehicle model behind them is the vehicle named,
    else the session's."""
    return _suggestions(db, _get(db, session_id), [], vehicle_model_id)


@router.post("/sessions/{session_id}/setup/suggestions")
def setup_suggestions_with(session_id: int, body: SuggestIn, vehicle_model_id: int | None = None,
                           db: Session = Depends(get_db)):
    """The same, with extra observations from the caller (for example another analysis's findings)."""
    extra = [Observation(**o.model_dump()) for o in body.observations]
    return _suggestions(db, _get(db, session_id), extra, vehicle_model_id)
