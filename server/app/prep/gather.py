"""Gathering what the past events at a venue learned, from the app's own analyses, one event at a time.

Nothing new is worked out from the logs here: each past event's report and technique check come from their own
background jobs (asked for, then waited on), its tyre and quali preparation from the tyre prep's reduction of each
session (one log at a time under heavy.lock, as GET /report/tyre-prep does), each run's balance from the setup
tool's run summary (kept in the database once read) and the pooled tyre model from the summaries the tyre data job
keeps. Each is cut down to what the briefing needs before the next event is gathered, so the job's memory is one
log at a time plus a few hundred kilobytes per event.
"""
from __future__ import annotations

import logging
import statistics
import time
from collections import defaultdict
from collections.abc import Callable

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from app import heavy, models
from app.analysis.technique import habits
from app.analysis.tyreprep import aggregate
from app.prep.plan import ANY, Plan, PastEvent, car_of, lap_times, session_kind
from app.routers import reports, technique
from app.routers import tyre_model as tyre_model_router
from app.routers import tyreprep as tyreprep_router
from app.routers.tyres import minimum_rows
from app.setup import data as balance_data
from app.setup import results, sheet
from app.setup.suggest import Observation, driver_observations, suggest
from app.setup.templates import TEMPLATES, template_for_car
from app.vehicle.model import Vehicle

log = logging.getLogger(__name__)

WAIT_S = 3600  # longest a past event's report or technique check is waited for
POLL_S = 1.5
SIM_KEYS = ("label", "session_id", "kind", "cold_start", "warm_laps", "warm_min", "drag_s", "straight_hard_stops",
            "weaves", "ready_min", "peak_lap", "peak_flying", "peak_from_exit", "peak_time", "gap_day",
            "peak_front", "peak_rear", "peak_pf", "peak_pr")
TYREPREP_KEYS = ("advice", "push", "ready", "fastest", "brake_work", "build", "pressure", "windows", "cold",
                 "has_tpms")
MIN_SHARE = 0.5  # a balance trait the data shows in at least this share of the runs is the car's

Progress = Callable[[str], None]


class GatherError(Exception):
    pass


def _year(pe: PastEvent) -> str:
    return pe.info.start[:4] if pe.info.start else "undated"


def label(pe: PastEvent) -> str:
    return f"{pe.info.event.name} ({_year(pe)})"


# ---------- the report and the technique check, from their own jobs ----------

def wait_report(db: Session, pe: PastEvent, progress: Progress) -> tuple[dict | None, str | None]:
    t0 = time.monotonic()
    while time.monotonic() - t0 < WAIT_S:
        db.expire_all()
        ans = reports.report_for(db, "event", pe.id)
        if ans["status"] == "ready":
            return ans["report"], None
        if ans["status"] in ("failed", "empty"):
            return None, ans["error"] or "No clean laps to analyse"
        current = (ans.get("progress") or {}).get("current")
        progress(f"Report of {label(pe)}" + (f": {current}" if current else ""))
        time.sleep(POLL_S)
    return None, "Its report took too long"


def wait_technique(db: Session, pe: PastEvent, progress: Progress) -> tuple[dict | None, str | None]:
    t0 = time.monotonic()
    while time.monotonic() - t0 < WAIT_S:
        db.expire_all()
        _, row, status = technique._state(db, "event", pe.id)
        if status == "ready":
            return row.result, None
        if status in ("failed", "empty"):
            return None, (row.error if row is not None else None) or "No clean laps to check"
        current = row.current if row is not None else None
        progress(f"Technique check of {label(pe)}" + (f": {current}" if current else ""))
        time.sleep(POLL_S)
    return None, "Its technique check took too long"


def driver_habits(tech: dict | None, pe: PastEvent) -> dict[str, dict]:
    """The mistakes that repeat for each driver at this event (their own laps only): driver -> {laps, habits}."""
    if not tech:
        return {}
    ids = {s.id for s in pe.sessions}
    names = {s.id: s.driver.name if s.driver else None for s in pe.sessions}
    by: dict[str | None, list[list[dict]]] = defaultdict(list)
    for x in tech.get("laps", []):
        if x["session_id"] in ids and x.get("pit_from_m") is None:
            by[names.get(x["session_id"]) or x.get("driver")].append(x["mistakes"])
    return {name or "": {"laps": len(laps), "habits": habits(laps)[:8]} for name, laps in by.items()}


# ---------- tyres and quali preparation ----------

def tyre_prep(db: Session, pe: PastEvent) -> tuple[dict | None, str | None]:
    """The tyre prep report over this car's sessions of the event (GET /report/tyre-prep, the same reduction)."""
    reduced = []
    for s in pe.sessions:
        out, _why = tyreprep_router._reduce(db, s)
        if out is not None:
            reduced.append({**out, "session_id": s.id, "name": s.name or f"Session {s.id}"})
    if not reduced:
        return None, "No log with tyre sensors could be read"
    reduced.sort(key=tyreprep_router._when)
    minimums, _ = minimum_rows(db, pe.info.event.series)
    rep = aggregate(reduced, [r for x in reduced for r in x["pressure_runs"]], minimums)
    del reduced
    out = {k: rep.get(k) for k in TYREPREP_KEYS}
    out["sims"] = [{k: sim.get(k) for k in SIM_KEYS} for sim in rep["sims"]]
    out["long_runs"] = [{"label": x["label"], "session_id": x["session_id"], "flying": x["flying"],
                         "best": x["best"], "median": x["median"], "fade": x["fade"],
                         "times": [r["time"] for r in x["laps"] if r["in_fit"]]} for x in rep["long_runs"]]
    return out, None


# ---------- setups, balance and what the drivers said ----------

def setups(db: Session, pe: PastEvent, progress: Progress) -> tuple[list[dict], list[dict], dict[int, dict],
                                                                   list[Observation]]:
    """Every run of this car at the event in order with its setup, what changed and the balance it showed; what the
    drivers said in their debriefs with the data's check of it; the run summaries; and the driver observations."""
    summaries: dict[int, dict] = {}
    for n, s in enumerate(pe.sessions):
        progress(f"Balance of {label(pe)}: {s.name or s.id} ({n + 1} of {len(pe.sessions)})")
        try:
            summaries[s.id] = results.run_summary(db, s)  # kept in the database once read
        except Exception:  # one log the balance analysis trips on leaves that run's balance out, not the report
            log.exception("Prep report: balance of session %s left out", s.id)
            db.rollback()
    ids = {s.id for s in pe.sessions}
    runs = [r for r in sheet.history(db, pe.sessions[0])["runs"] if r["session_id"] in ids]
    remarks, observations = [], []
    for s in pe.sessions:
        points = [p for d in s.debriefs if d.status == models.DebriefStatus.ready for p in d.points]
        if not points:
            continue
        summary = summaries.get(s.id)
        summary = summary if summary and "sections" in summary else None
        obs, _ = driver_observations(points, (summary or {}).get("corners", []))
        for o in obs:
            o.check = balance_data.check(o, summary)
            o.ref = {**o.ref, "event_id": pe.id, "session_id": s.id}
            observations.append(o)
            remarks.append({"session_id": s.id, "session": s.name or f"Session {s.id}",
                            "driver": s.driver.name if s.driver else None, "text": o.text, "corner": o.corner,
                            "kind": o.kind, "symptom": o.symptom, "label": o.describe(),
                            "verdict": (o.check or {}).get("verdict"), "data": (o.check or {}).get("text")})
    return runs, remarks, summaries, observations


def recurring_data(summaries: list[tuple[str, dict]]) -> list[Observation]:
    """What the data shows run after run (the same balance trait at the same corner, or the rear not taking the
    power), across every past run: the car's, not one run's. summaries: (year, run summary)."""
    with_balance = [(y, s) for y, s in summaries if s and s.get("sections")]
    if not with_balance:
        return []
    seen: dict[tuple, dict] = {}
    for year, s in with_balance:
        keys = set()
        for o in balance_data.measured(s):
            key = (o.kind, o.phase, o.corner)
            if key in keys:
                continue
            keys.add(key)
            g = seen.setdefault(key, {"obs": o, "runs": 0, "years": set()})
            g["runs"] += 1
            g["years"].add(year)
    n = len(with_balance)
    out = []
    for (kind, phase, corner), g in seen.items():
        share = g["runs"] / n
        if share < MIN_SHARE or (n >= 2 and g["runs"] < 2):
            continue
        o = g["obs"]
        years = ", ".join(sorted(g["years"]))
        out.append(Observation(kind=kind, phase=phase, corner=corner, speed=o.speed, weight=round(share, 2),
                               source="data", text=f"{o.describe()} in {g['runs']} of {n} runs ({years})",
                               ref={"recurring": True, "runs": g["runs"], "of": n}))
    out.sort(key=lambda o: -o.weight)
    return out


def recommend_setup(p: Plan, events: list[dict], observations: list[Observation],
                    summaries: list[tuple[str, int, dict]]) -> dict:
    """The setup to open the weekend with: the sheet of the quickest past run that has one (the latest event's
    first), with the changes both the drivers' remarks and the data point to, ranked."""
    base = None
    for ev in reversed(events):
        sheets = [r for r in ev["runs"] if r["has_setup"] and r["laps"]["best_s"]]
        if sheets:
            r = min(sheets, key=lambda r: r["laps"]["best_s"])
            base = {"event_id": ev["id"], "event": ev["name"], "year": ev["year"], "session_id": r["session_id"],
                    "session": r["name"], "template": r["template"], "values": r["values"],
                    "best_s": r["laps"]["best_s"]}
            break
    if base is not None and base["template"] in TEMPLATES:
        template = TEMPLATES[base["template"]]
    else:
        template = TEMPLATES[template_for_car(p.car_label if p.car != ANY else None)]
    values = base["values"] if base else {}
    data_obs = recurring_data([(y, s) for y, _, s in summaries])
    # the latest event's quickest run with a balance: its report's own ranked changes and what it measured
    latest = None
    for ev in reversed(events):
        mine = [(sid, s) for y, sid, s in summaries if s and s.get("sections") and y == ev["year"]
                and any(r["session_id"] == sid for r in ev["runs"])]
        if mine:
            best = {r["session_id"]: r["laps"]["best_s"] or 1e9 for r in ev["runs"]}
            latest = min(mine, key=lambda x: best.get(x[0], 1e9))[1]
            break
    advice = ((latest or {}).get("advice") or {}).get("recommendations") or []
    vehicle = None
    if template.vehicle_preset:
        try:
            vehicle = Vehicle.model_validate(sheet.to_vehicle(template, values)["vehicle"])
        except (LookupError, ValueError):
            vehicle = None
    ranked = suggest(template, values, [*observations, *data_obs], vehicle, limit=4, advice=advice,
                     measured=balance_data.measured(latest))
    keep = ("rank", "title", "changes", "reason", "data_shows", "confirmed", "expected", "watch", "agreement",
            "disagree", "sources", "report")
    return {"baseline": base, "template": template.key, "template_name": template.name,
            "suggestions": [{k: x.get(k) for k in keep} for x in ranked["suggestions"]],
            "recurring": [{"label": o.describe(), "text": o.text, "kind": o.kind, "phase": o.phase,
                           "corner": o.corner, "share": o.weight} for o in data_obs],
            "remarks": len([o for o in observations if o.source == "driver"]), "notes": ranked["notes"]}


# ---------- the pooled tyre model ----------

def pooled_tyre_model(db: Session, p: Plan, tracks: list[str]) -> dict | None:
    """The tyre model of this car's sessions at this venue (all its tracks' when the venue alone has too little),
    cut down to what it says about pressure and temperature."""
    if p.car == ANY:
        return None
    for track in [*tracks, None]:
        try:
            with heavy.lock:  # a fit over many sessions' summaries takes a few seconds and some memory
                m = tyre_model_router.tyre_model(car=p.car, tyre_kind=None, track=track, ambient_min=None,
                                                 ambient_max=None, db=db)
        except HTTPException:
            return None
        if m.get("empty"):
            continue
        cond = m.get("conditions") or {}
        lines = []
        for name in ("pressure", "temperature"):
            for axle in ("front", "rear"):
                w = ((cond.get(name) or {}).get(axle) or {}).get("window")
                if w and w.get("text"):
                    lines.append(w["text"])
        return {"track": track, "tyre": m.get("tyre"), "sessions": m["basis"]["sessions"],
                "laps": m["basis"]["laps"], "lines": lines}
    return None


# ---------- each event's numbers from the database ----------

def _median(vals: list[float]) -> float | None:
    return round(float(statistics.median(vals)), 3) if vals else None


def session_rows(db: Session, pe: PastEvent) -> list[dict]:
    """This car's sessions at the event: kind, driver, laps and the conditions the logs and the app recorded."""
    ids = [s.id for s in pe.sessions]
    tyre_rows = db.scalars(select(models.TyreData).where(models.TyreData.session_id.in_(ids))).all()
    ambient: dict[int, list[float]] = defaultdict(list)
    tyres: dict[int, set[str]] = defaultdict(set)
    for r in tyre_rows:
        if r.ambient_c is not None:
            ambient[r.session_id].append(r.ambient_c)
        if r.tyre:
            tyres[r.session_id].add(r.tyre)
    out = []
    times = lap_times(pe.sessions)
    for s in pe.sessions:
        laps = times[s.id]
        out.append({"id": s.id, "name": s.name or f"Session {s.id}", "kind": session_kind(s),
                    "driver": s.driver.name if s.driver else None, "car": car_of(s)[0],
                    "clean_laps": len(laps), "best": laps[0] if laps else None, "times": laps,
                    "ambient_c": s.ambient_temp_c if s.ambient_temp_c is not None else _median(ambient[s.id]),
                    "ambient_source": "session" if s.ambient_temp_c is not None else "logger"
                    if ambient[s.id] else None,
                    "track_c": s.track_temp_c,
                    "tyre": s.tyre_set or (sorted(tyres[s.id])[0] if tyres[s.id] else None)})
    return out
