"""Tyre tools: cold pressures from a target hot pressure, P-Book minimums, and tyre temperature analysis."""
from pathlib import Path
from typing import Annotated, Literal

import numpy as np
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app import models
from app.db import get_db
from app.importers.csvlog import read_log
from app.importers.motec import LdFormatError
from app.routers.sessions import LOG_FILES, _get
from app.tyres import temps as tyre_temps
from app.tyres.pressure import pressure_plan
from app.tyres.presets import (
    ATMOSPHERIC_BAR,
    OLDER_BOOKLET,
    PBOOK_MINIMUMS,
    PBOOK_NOTE,
    TARGET_SPREAD_C,
    TARGET_SPREAD_SOURCE,
)
from app.tyres.tpms import CORNERS, TEMP_CHANNELS, logger_conditions, measure_runs

router = APIRouter()

Corner = Literal["FL", "FR", "RL", "RR"]
Axle = Literal["front", "rear"]
Bar = Annotated[float, Field(gt=0, lt=6)]
Celsius = Annotated[float, Field(gt=-40, lt=200)]


# ---------- logged runs: the evidence for the pressure model ----------

def _sessions(db: Session, car_id: int | None, session_ids: list[int] | None) -> list[models.RunSession]:
    """The sessions to learn from: the ones named, else the car's, else all of them."""
    if session_ids:
        return [_get(db, sid) for sid in dict.fromkeys(session_ids)]
    q = select(models.RunSession).order_by(models.RunSession.created_at)
    if car_id is not None:
        q = q.where(models.RunSession.car_id == car_id)
    return list(db.scalars(q).all())


def logged_runs(db: Session, car_id: int | None = None, session_ids: list[int] | None = None) -> list[dict]:
    """Every cold start in the sessions' logs with the hot pressure it reached, per corner."""
    out = []
    for s in _sessions(db, car_id, session_ids):
        for f in s.files:
            if Path(f.filename).suffix.lower() not in LOG_FILES:
                continue
            try:
                ld = read_log(f.path)
            except (LdFormatError, OSError):
                continue
            logger = logger_conditions(ld)
            ambient, source = s.ambient_temp_c, "session"
            if ambient is None:
                ambient, source = logger.get("ambient_c"), "logger at speed"
            for r in measure_runs(ld):
                out.append({"session_id": s.id, "session": s.name or f"Session {s.id}", "file_id": f.id,
                            "file": f.filename, **r, "ambient_c": ambient,
                            "ambient_source": source if ambient is not None else None, "track_c": s.track_temp_c,
                            "atmospheric_bar": logger.get("atmospheric_bar")})
    return out


def _summary(runs: list[dict]) -> dict[str, dict]:
    """Per corner: how many runs settled, and their typical cold and hot readings."""
    out = {}
    for corner in CORNERS:
        used = [r["corners"][corner] for r in runs if r["corners"].get(corner, {}).get("used")]
        if not used:
            continue
        row: dict = {"runs": len(used)}
        for k in ("cold_bar", "cold_c", "hot_bar", "hot_c", "rise_bar"):
            vals = [u[k] for u in used if u[k] is not None]
            if vals:
                row[f"median_{k}"] = round(float(np.median(vals)), 3)
        out[corner] = row
    return out


@router.get("/tyres/runs")
def tyre_runs(car_id: int | None = None, session_ids: Annotated[list[int] | None, Query()] = None,
              db: Session = Depends(get_db)):
    """Cold set pressure and settled hot pressure of every logged run, per corner, and why a run is left out."""
    runs = logged_runs(db, car_id, session_ids)
    return {"runs": runs, "summary": _summary(runs)}


class ConditionsIn(BaseModel):
    ambient_temp_c: Celsius | None = None
    track_temp_c: Celsius | None = None


@router.patch("/sessions/{session_id}/conditions")
def set_conditions(session_id: int, body: ConditionsIn, db: Session = Depends(get_db)):
    """Ambient and track temperature of a session: the pressure model learns how they change the rise."""
    s = _get(db, session_id)
    for k in body.model_fields_set:
        setattr(s, k, getattr(body, k))
    db.commit()
    return {"session_id": s.id, "ambient_temp_c": s.ambient_temp_c, "track_temp_c": s.track_temp_c}


# ---------- P-Book minimums ----------

class MinimumRow(BaseModel):
    tyre: str | None = None
    axle: Axle
    cold_min_bar: Bar | None = None
    hot_min_bar: Bar | None = None
    source: str | None = None  # the P-Book edition and page


class MinimumsIn(BaseModel):
    series: str = Field(min_length=1, max_length=80)
    rows: list[MinimumRow]


def _series_rows(series: str):
    return select(models.TyreMinimum).where(func.lower(models.TyreMinimum.series) == series.strip().lower())


def minimum_rows(db: Session, series: str | None, tyre: str | None = None) -> tuple[list[dict], str | None]:
    """The series' minimums as entered, else as shipped in the presets (only with a source); and which."""
    if not series:
        return [], None
    rows = [{"tyre": m.tyre, "axle": m.axle, "cold_min_bar": m.cold_min_bar, "hot_min_bar": m.hot_min_bar,
             "source": m.source}
            for m in db.scalars(_series_rows(series)).all()]
    origin = "entered"
    if not rows:
        rows = [{k: m.get(k) for k in ("tyre", "axle", "cold_min_bar", "hot_min_bar", "source")}
                for m in PBOOK_MINIMUMS if m.get("series", "").lower() == series.lower() and m.get("source")]
        origin = "presets"
    if tyre:
        rows = [r for r in rows if not r["tyre"] or r["tyre"].lower() == tyre.lower()]
    return rows, origin if rows else None


# Older public booklet figures, shown for reference next to the minimums table (never checked against)
PRESSURE_REFERENCE = {
    "text": (f"Older Pirelli GT4 booklet (2018/2019, DH tyre), not the DHG P_Book: minimum inflation "
             f"{OLDER_BOOKLET['min_pressure_bar']:.1f} bar, hot target {OLDER_BOOKLET['hot_target_bar']:.1f} bar. "
             "Check against your P_Book."),
    "source": OLDER_BOOKLET["source"],
}


def _minimums_out(db: Session, series: str | None) -> dict:
    rows, origin = minimum_rows(db, series)
    names = sorted({*db.scalars(select(models.TyreMinimum.series)).all(), *(m["series"] for m in PBOOK_MINIMUMS)})
    out = {"series": series, "rows": rows, "origin": origin, "series_list": names, "reference": PRESSURE_REFERENCE}
    if not rows:
        out["message"] = f"No P-Book minimums for {series or 'this series'} yet. {PBOOK_NOTE}"
    return out


@router.get("/tyres/minimums")
def get_minimums(series: str | None = None, db: Session = Depends(get_db)):
    return _minimums_out(db, series)


@router.put("/tyres/minimums")
def set_minimums(body: MinimumsIn, db: Session = Depends(get_db)):
    """Replace the series' P-Book minimums (rows without any minimum are dropped)."""
    for m in db.scalars(_series_rows(body.series)).all():
        db.delete(m)
    for r in body.rows:
        if r.cold_min_bar is not None or r.hot_min_bar is not None:
            db.add(models.TyreMinimum(series=body.series.strip(), **r.model_dump()))
    db.commit()
    return _minimums_out(db, body.series.strip())


# ---------- pressure calculator ----------

class PressureIn(BaseModel):
    targets: dict[Corner, Bar]  # target hot pressure per corner, gauge bar
    hot_c: dict[Corner, Celsius] = {}  # expected hot tyre temperature; defaults to the logged runs' TPMS reading
    set_c: Celsius | None = None  # tyre temperature when the pressures are set (e.g. in the garage)
    ambient_c: Celsius | None = None
    track_c: Celsius | None = None
    atmospheric_bar: float = Field(ATMOSPHERIC_BAR, gt=0.5, lt=1.2)
    series: str | None = None  # for the P-Book minimums
    tyre: str | None = None
    car_id: int | None = None  # learn from this car's sessions ...
    session_ids: list[int] | None = None  # ... or from these


@router.post("/tyres/pressures")
def pressures(body: PressureIn, db: Session = Depends(get_db)):
    """Cold pressure per corner for a target hot pressure: by the gas law and by this car's logged runs."""
    if not body.targets:
        raise HTTPException(422, "Enter a target hot pressure for at least one tyre")
    runs = logged_runs(db, body.car_id, body.session_ids)
    rows, origin = minimum_rows(db, body.series, body.tyre)
    plan = pressure_plan(body.targets, runs, rows, set_c=body.set_c, ambient_c=body.ambient_c,
                         track_c=body.track_c, hot_c=body.hot_c, atmospheric_bar=body.atmospheric_bar)
    plan["minimums"] = {"series": body.series, "rows": rows, "origin": origin, "reference": PRESSURE_REFERENCE}
    if not rows:
        plan["minimums"]["message"] = (f"No P-Book minimums entered for {body.series or 'this series'}, so nothing "
                                       f"was checked against them. {PBOOK_NOTE}")
    plan["runs_used"] = len({(r["file_id"], r["set"]) for r in runs if any(c["used"] for c in r["corners"].values())})
    return plan


# ---------- tyre temperatures ----------

class Reading(BaseModel):
    inside: Celsius
    middle: Celsius
    outside: Celsius
    pressure_bar: Bar | None = None  # hot, when the temperatures were taken
    camber_deg: Annotated[float, Field(gt=-10, lt=10)] | None = None


class TempsIn(BaseModel):
    readings: dict[Corner, Reading]
    target_spread_c: dict[Axle, Annotated[float, Field(ge=0, lt=40)]] | None = None
    series: str | None = None  # to check suggested pressures against the P-Book hot minimums
    tyre: str | None = None


def _hot_minimums(db: Session, series: str | None, tyre: str | None) -> dict[str, float]:
    rows, _ = minimum_rows(db, series, tyre)
    out: dict[str, float] = {}
    for r in rows:
        if r["hot_min_bar"] is not None:
            out[r["axle"]] = max(out.get(r["axle"], 0.0), r["hot_min_bar"])
    return out


def _analyze(readings: dict, spread: dict | None, hot_min: dict) -> dict:
    try:
        return tyre_temps.analyze_temps(readings, spread, hot_min)
    except ValueError as e:
        raise HTTPException(422, str(e)) from e


@router.get("/tyres/temps/settings")
def temp_settings():
    """The rules' targets and thresholds, so the app can show them."""
    return {"target_spread_c": TARGET_SPREAD_C, "target_spread_source": TARGET_SPREAD_SOURCE,
            "camber_tolerance_c": tyre_temps.CAMBER_TOLERANCE_C,
            "pressure_tolerance_c": tyre_temps.PRESSURE_TOLERANCE_C, "camber_step_deg": tyre_temps.CAMBER_STEP_DEG,
            "pressure_step_bar": tyre_temps.PRESSURE_STEP_BAR, "axle_balance_c": tyre_temps.AXLE_BALANCE_C,
            "side_balance_c": tyre_temps.SIDE_BALANCE_C,
            "reference": {
                "text": (f"Older Pirelli GT4 booklet (2018/2019, DH tyre), not the DHG P_Book: inside no more than "
                         f"{OLDER_BOOKLET['max_inside_outside_c']:.0f} °C hotter than the outside, front and rear "
                         f"within {OLDER_BOOKLET['max_front_rear_c']:.0f} °C, maximum static camber "
                         f"{OLDER_BOOKLET['max_camber_deg']['front']:.1f}° front and "
                         f"{OLDER_BOOKLET['max_camber_deg']['rear']:.1f}° rear. Check against your P_Book."),
                "source": OLDER_BOOKLET["source"]}}


@router.post("/tyres/temps")
def analyze_pyrometer(body: TempsIn, db: Session = Depends(get_db)):
    """Camber and pressure advice per tyre, and the car's balance, from pyrometer readings."""
    readings = {c: r.model_dump() for c, r in body.readings.items()}
    return {"source": "pyrometer",
            **_analyze(readings, body.target_spread_c, _hot_minimums(db, body.series, body.tyre))}


@router.get("/sessions/{session_id}/tyre-temps")
def log_tyre_temps(session_id: int, file_id: int | None = None,
                   numbered_from: Literal["inside", "outside"] = "inside",
                   spread_front: float | None = None, spread_rear: float | None = None,
                   series: str | None = None, db: Session = Depends(get_db)):
    """The same advice from IR tyre sensors in the session's log (its longest file, unless one is named)."""
    s = _get(db, session_id)
    files = [f for f in s.files if Path(f.filename).suffix.lower() in LOG_FILES and file_id in (None, f.id)]
    if not files:
        raise HTTPException(404, "No logger file uploaded for this session")
    f = max(files, key=lambda f: f.meta.get("duration_s", 0))
    ld = read_log(f.path)
    readings, channels = tyre_temps.ir_readings(ld, numbered_from)
    if not readings:
        tpms = [n for c in CORNERS for n in TEMP_CHANNELS[c] if n in ld.channels]
        detail = f"{f.filename} has no IR tyre temperature channels (inside, middle and outside across the tread)."
        if tpms:
            detail += (f" Its {', '.join(tpms)} channels are the TPMS sensors, which measure the air inside the "
                       "tyre and show no spread across it.")
        raise HTTPException(422, detail + " Enter pyrometer readings instead.")
    spread = {k: v for k, v in (("front", spread_front), ("rear", spread_rear)) if v is not None} or None
    return {"source": "ir log", "file_id": f.id, "file": f.filename, "channels": channels,
            "numbered_from": numbered_from, **_analyze(readings, spread, _hot_minimums(db, series, None))}
