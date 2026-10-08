"""Two drivers in a report (the report's Drivers section, app/components/report/DriversCompare.tsx), over each one's
runs on one tyre level: how each takes every corner, their lap times put on the same tyre age and fuel load, the car's
balance as each of them drove it, and the mistakes the technique check finds again and again in each one's laps.

GET /report/drivers/corners?a=<run ids>&b=<run ids>: like with like first. Where both drove in the same sessions
(run_parts.py: R1, FP2; a day's qualifying sessions count as one, as each driver has their own, back to back), only
those runs are compared, as the track changes between sessions; else every run, and the answer says so. Each corner
group (official corner numbers) with each driver's passes ranked as the report ranks its sections' passes, against the
same corner on the laps either side in their own stint (analysis/advice.py), and split into the top 10%, the middle
tenth and the bottom 10%; per group the median speed, brake and throttle through the corner every 5 m with the technique
numbers that go with them (analysis/driver_corners.py). The laps are read from their lap packs (compare._read, the log
only where a pack is missing), one run at a time under the heavy-work lock. Then each lap's time taken to one tyre age
and one fuel load (analysis/like_for_like.py, from the event's stint view): each driver's best and typical lap, raw and
corrected, and what was corrected and what wasn't. Kept in the database under the event and the run ids.

GET /report/drivers/balance?a=<run ids>&b=<run ids>: understeer or oversteer per section on entry, mid-corner and
exit for each side (analysis/balance.py, read as the report's Car balance section reads it). Every run of both sides is
read once, one log at a time under the server's heavy-work lock, onto one line; both sides are then measured against
the same normal (the car's understeer gradient over all of their cornering), so a difference between the two is the
drivers', not two different yardsticks. Kept in the database (app/page_cache.py) under the event and the run ids.
Balance only: no setup advice (that is the setup tool's, on demand).

GET /report/drivers/flags?a=<run ids>&b=<run ids>: the technique check's repeated mistakes (routers/technique.py) of
each side's laps, from the event's check as it is kept; it never starts a check.
"""
from __future__ import annotations

import gc
import json
from dataclasses import replace

import numpy as np

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app import models, page_cache, run_labels, run_parts, run_tyres
from app.analysis import compare, driver_corners, like_for_like
from app.analysis.balance import Collected, _section_rows, car_geometry, collect, gradient, prepared
from app.analysis.quickest import keep_quickest, lap_cap
from app.analysis.setup_advice import describe
from app.analysis.technique import habits
from app.db import get_db
from app.routers import stint, technique
from app.routers.balance import preset_for
from app.routers.insights import Side, compare_sources
from app.routers.sessions import _get, load_main_file, official_corners
from app.vehicle.presets import preset_detail

router = APIRouter(prefix="/report/drivers")

SIDES = ("a", "b")
BALANCE_VERSION = 1  # raise when what /balance answers changes, so every kept answer is worked out again
CORNERS_VERSION = 1  # the same for /corners
PHASES = ("entry", "mid", "exit")
SCOPE_LEN = 150  # page_cache.scope is 160 characters


def _ids(text: str, side: str) -> list[int]:
    try:
        ids = sorted({int(x) for x in text.split(",") if x.strip()})
    except ValueError:
        raise HTTPException(422, f"?{side}= takes run ids separated by commas") from None
    if not ids:
        raise HTTPException(422, f"Give the runs of side {side} (?{side}=1,2)")
    return ids


def _sides(db: Session, a: str, b: str) -> tuple[dict[str, list[models.RunSession]], int]:
    """Each side's runs, after checking they can be compared: no run on both sides, all of one event."""
    ids = {"a": _ids(a, "a"), "b": _ids(b, "b")}
    if set(ids["a"]) & set(ids["b"]):
        raise HTTPException(422, "A run can't be on both sides")
    runs = {side: [_get(db, i) for i in ids[side]] for side in SIDES}
    events = {s.event_id for side in SIDES for s in runs[side]}
    if len(events) != 1 or None in events:
        raise HTTPException(422, "Compare runs of one event")
    return runs, events.pop()


def _best_clean(s: models.RunSession) -> float | None:
    return min((l.time_s for l in s.laps if l.clean), default=None)


def _label(runs: list[models.RunSession], side: str) -> str:
    names = list(dict.fromkeys(s.driver.name for s in runs if s.driver))
    return " and ".join(names) if names else f"Side {side.upper()}"


@router.get("/balance")
def drivers_balance(a: str, b: str, db: Session = Depends(get_db)):
    """Each side's balance per section and phase, against one normal for both."""
    runs, event_id = _sides(db, a, b)
    usable = {side: [s for s in runs[side] if s.files and _best_clean(s) is not None] for side in SIDES}
    labels = {side: _label(runs[side], side) for side in SIDES}
    for side in SIDES:
        if not usable[side]:
            raise HTTPException(422, f"No clean laps for {labels[side]}")
    every = [s for side in SIDES for s in runs[side]]
    names = run_labels.labels_for(db, every)
    ids = ["-".join(str(s.id) for s in runs[side]) for side in SIDES]
    scope = f"event:{event_id}|balance-drivers:{ids[0]}:{ids[1]}"
    if len(scope) > SCOPE_LEN:  # many runs: the ids by their digest
        scope = f"event:{event_id}|balance-drivers:{page_cache.digest(ids)}"
    kept = [s for side in SIDES for s in usable[side]]

    def signature() -> str:
        return page_cache.digest(["balance-drivers", BALANCE_VERSION, labels, ids,
                                  page_cache.sessions_part(db, kept), *run_labels.renamed(names[s.id] for s in every)])

    return page_cache.RawJSON(page_cache.cached(
        db, scope, signature, lambda: _build(db, usable, labels, {s.id: names[s.id].name for s in every}), raw=True))


def _build(db: Session, runs: dict[str, list[models.RunSession]], labels: dict[str, str],
           names: dict[int, str]) -> dict:
    """Both sides' laps on one line, one log at a time (as routers/balance.py reads an event), then each side's
    balance per section against the car's gradient over all of them."""
    every = [s for side in SIDES for s in runs[side]]
    preset = preset_for([s.car for s in every if s.car])
    geo = car_geometry(preset_detail(preset) if preset else None)
    side_of = {names[s.id]: side for side in SIDES for s in runs[side]}
    col = Collected()
    track = None
    for s in sorted(every, key=_best_clean):  # the quickest first: its fastest lap sets the line
        label = names[s.id]
        before = (len(col.laps), len(col.sessions), col.line, col.length)
        data = None
        try:
            _, data, t = load_main_file(db, s)
            if track is not None and t is not None and t.id != track.id:
                col.sessions.append({"name": label, "session_id": s.id, "laps": 0, "note": "Driven at another track"})
                continue
            collect(label, data, geo, col, driver=s.driver.name if s.driver else None, meta={"session_id": s.id})
            # a long weekend keeps each side's quickest laps (analysis/quickest.py): neither crowds the other out
            col.laps = [x for side in SIDES for x in keep_quickest([y for y in col.laps if side_of[y.run] == side])]
            track = track or t
        except Exception:  # one unreadable log leaves that run out, not the comparison
            del col.laps[before[0]:], col.sessions[before[1]:]
            col.line, col.length = before[2], before[3]
            col.sessions.append({"name": label, "session_id": s.id, "laps": 0,
                                 "note": "Could not read the log; left out"})
        finally:
            del data
            gc.collect()  # free the run's channels and close its log before the next one
    corners = official_corners(track)
    prep = prepared(col, corners)
    if prep is None:
        raise HTTPException(422, "No clean laps to compare")
    grad = gradient(prep)  # one normal for both sides: the car's own, over all their cornering
    k = grad["per_g"] if grad else None
    rows, laps = {}, {}
    for side in SIDES:
        mine = [x for x in prep.laps if side_of[x.run] == side]
        laps[side] = len(mine)
        rows[side] = {r["code"]: r for r in _section_rows(replace(prep, laps=mine), prep.realistic, k)} if mine else {}

    def cells(side: str, code: str) -> dict:
        found = (rows[side].get(code) or {}).get("balance") or {}
        return {p: {**found[p], **describe(found[p]["value"])} if p in found else None for p in PHASES}

    out = {
        "track": track.name if track else None,
        "labels": labels,
        "laps": laps,
        "per_g": grad["per_g"] if grad else None,
        "numbering": prep.numbering,
        "sections": [{"code": s.code, "corners": s.corners, "a": cells("a", s.code), "b": cells("b", s.code)}
                     for s in prep.sections],
        "runs": col.sessions,
    }
    if (cap := lap_cap(len(col.laps), sum(x["laps"] for x in col.sessions))) is not None:
        out["quickest_laps"] = cap
    return out


@router.get("/flags")
def drivers_flags(a: str, b: str, db: Session = Depends(get_db)):
    """The mistakes the technique check finds on at least two of each side's laps, per corner and kind, most costly
    first: from the event's check as it is kept (status "none" while there is none; nothing is started here)."""
    runs, event_id = _sides(db, a, b)
    res = technique._current(technique._row(db, f"event:{event_id}"))
    if res is None:
        return {"status": "none", "a": [], "b": []}
    out: dict = {"status": "ready"}
    for side in SIDES:
        ids = {s.id for s in runs[side]}
        mine = [x["obvious"] for x in res["laps"] if x["session_id"] in ids]
        out[side] = [{k: h[k] for k in ("key", "kind", "code", "phase", "title", "laps", "of", "share",
                                         "cost_per_lap_s", "value", "unit")} for h in habits(mine)]
    return out


@router.get("/corners")
def drivers_corners(a: str, b: str, db: Session = Depends(get_db)):
    """Each side's passes through every corner, by group, and its lap times on one tyre age and fuel load."""
    runs, event_id = _sides(db, a, b)
    labels = {side: _label(runs[side], side) for side in SIDES}
    if labels["a"] == labels["b"]:
        labels = {side: f"{labels[side]} ({side.upper()})" for side in SIDES}
    event = run_labels.event_runs(db, runs["a"][0])
    labs = run_labels.label_runs(event)
    found = run_parts.blocks(run_parts.parts(event, labs))  # a day's qualifying sessions as one: Q1 + Q2
    part_of = {lab.id: p for p in found for lab in p.runs}
    mine = {side: [p.code for p in found if any(part_of.get(s.id) is p for s in runs[side])] for side in SIDES}
    shared = [c for c in mine["a"] if c in mine["b"]]
    use = {side: [s for s in runs[side] if s.files and _best_clean(s) is not None
                  and (not shared or part_of[s.id].code in shared)] for side in SIDES}
    for side in SIDES:
        if not use[side]:
            raise HTTPException(422, f"No clean laps for {labels[side]}")
    ids = ["-".join(str(s.id) for s in runs[side]) for side in SIDES]
    scope = f"event:{event_id}|drivers-corners:{ids[0]}:{ids[1]}"
    if len(scope) > SCOPE_LEN:
        scope = f"event:{event_id}|drivers-corners:{page_cache.digest(ids)}"
    files = [db.get(models.LoggerFile, i) for i in stint.event_files(db, event_id)]

    def signature() -> str:
        tyres = run_tyres.for_runs(db, event)
        return page_cache.digest(["drivers-corners", CORNERS_VERSION, labels, ids,
                                  page_cache.sessions_part(db, event), *run_labels.renamed(labs),
                                  sorted((k, v["tyres"], v["set_laps"]) for k, v in tyres.items()),
                                  [stint._view_signature(db, f) for f in files]])

    def work() -> dict:
        out = _corners(db, use, labels, event, labs, part_of, files)
        names = {p.code: p.title for p in found}
        out["matched"] = {
            "same_sessions": bool(shared),
            "parts": [names[c] for c in shared],
            "by_side": {side: [names[c] for c in mine[side]] for side in SIDES},
            "runs": {side: [s.id for s in use[side]] for side in SIDES},
            # the runs in a session only one of the two drove in
            "left_out": [{"session_id": s.id, "name": part_of[s.id].title, "side": side} for side in SIDES
                         for s in runs[side] if shared and s.id in part_of and part_of[s.id].code not in shared],
        }
        return out

    return page_cache.RawJSON(page_cache.cached(db, scope, signature, work, raw=True))


def _stints(db: Session, files: list[models.LoggerFile]) -> tuple[list[dict], dict]:
    """The event's stints as the report's quick laps read them (kept once worked out), or none when they can't be,
    and the units of the logs' channels."""
    if not files or None in files:
        return [], {}
    try:
        view = stint.stint_view(db, [f.id for f in files])
    except HTTPException:
        return [], {}
    data = json.loads(view.body) if isinstance(view, page_cache.RawJSON) else view
    return data.get("stints", []), data.get("units") or {}


def _fuel_runs(stints: list[dict], event: list[models.RunSession], labs: list, part_of: dict,
               tyres: dict) -> list[like_for_like.Run]:
    """Every run of the event as the tyre and fuel correction needs it, in the order they ran."""
    order = {lab.id: k for k, lab in enumerate(labs)}
    out = []
    for s in event:
        f = page_cache.main_file(s)
        mine = [x for x in stints if x.get("session_id") == s.id]
        fuel = {r["lap"]: r["fuel_kg"] for x in mine for r in x.get("laps", []) if r.get("fuel_kg") is not None}
        rates = [x["fuel"] for x in mine if x.get("fuel")]
        kg = [r["kg_per_lap"] for r in rates if r.get("kg_per_lap") is not None]
        cost = [r["s_per_10kg"] / 10 for r in rates if r.get("s_per_10kg") is not None]
        t = tyres.get(s.id) or {}
        out.append(like_for_like.Run(
            s.id, part_of[s.id].code if s.id in part_of else s.name or str(s.id), order.get(s.id, len(order)),
            run_tyres.kind_of(s.kind.value, s.name), t.get("tyres"), t.get("set_laps"),
            sum(1 for lap in s.laps if f is not None and lap.file_id == f.id), fuel,
            float(np.median(kg)) if kg else None, float(np.median(cost)) if cost else None,
            "estimate" if any(r.get("source") == "estimate" for r in rates) else ("log" if rates else None)))
    return out


def _lap(sid: int, number: int, time: float) -> dict:
    return {"session_id": sid, "lap": number, "time": round(time, 3)}


def _corners(db: Session, use: dict[str, list[models.RunSession]], labels: dict[str, str],
             event: list[models.RunSession], labs: list, part_of: dict, files: list) -> dict:
    sources, track = compare_sources(db, Side(label=labels["a"], session_ids=[s.id for s in use["a"]]),
                                     Side(label=labels["b"], session_ids=[s.id for s in use["b"]]))
    ref, passes, _ = compare._read(sources, official_corners(track), None, driver_corners.summarise, ("gear",))
    gc.collect()
    by = {side: [p for p in passes if p.side == side] for side in SIDES}
    if ref is None or not by["a"] or not by["b"]:
        missing = [labels[side] for side in SIDES if not by[side]]
        raise HTTPException(422, f"No clean laps for {' and '.join(missing) or 'either driver'}")
    corners = driver_corners.corner_view(passes, ref.sections)

    stints, units = _stints(db, files)
    fade = like_for_like.fade_from_stints(stints) or like_for_like.fade_for_track(
        track.name if track else None, float(np.median([p.time for p in passes])))
    fuel_runs = _fuel_runs(stints, event, labs, part_of, run_tyres.for_runs(db, event))
    c = like_for_like.correct([(p.session_id, p.number, p.time) for p in passes], fuel_runs, fade)
    used = {p.session_id for p in passes}
    races = any(r.kind == "race" for r in fuel_runs if r.session_id in used)
    sides: dict = {}
    for side in SIDES:
        idx = [i for i, p in enumerate(passes) if p.side == side]
        raw = sorted(idx, key=lambda i: (passes[i].time, i))
        fixed = sorted(idx, key=lambda i: (c.times[i], i))
        typ, typ_c = raw[len(raw) >> 1], fixed[len(fixed) >> 1]
        ages = [c.ages[i] for i in idx if c.ages[i] is not None]
        sides[side] = {
            "label": labels[side], "laps": len(idx), "runs": sorted({passes[i].session_id for i in idx}),
            "best": _lap(passes[raw[0]].session_id, passes[raw[0]].number, passes[raw[0]].time),
            "typical": _lap(passes[typ].session_id, passes[typ].number, passes[typ].time),
            "typical_corrected": {**_lap(passes[typ_c].session_id, passes[typ_c].number, passes[typ_c].time),
                                  "corrected": c.times[typ_c]},
            "tyre_age": float(np.median(ages)) if ages else None,
            "fuel_kg": round(float(np.median([c.fuel[i] for i in idx])), 1) if c.fuel_done else None,
        }
    return {
        "track": track.name if track else None, "labels": labels, "numbering": ref.numbering,
        "brake_unit": units.get("brake") or None,
        "sides": sides,
        "gap": {
            "best": round(sides["a"]["best"]["time"] - sides["b"]["best"]["time"], 3),
            "typical": round(sides["a"]["typical"]["time"] - sides["b"]["typical"]["time"], 3),
            "typical_corrected": round(sides["a"]["typical_corrected"]["corrected"]
                                       - sides["b"]["typical_corrected"]["corrected"], 3),
        },
        "correction": {
            "tyres": c.tyres, "fuel": c.fuel_done, "words": like_for_like.words(c, fade, races),
            "fade_s_per_lap": round(fade.per_lap, 3) if fade else None, "fade_source": fade.source if fade else None,
            "tyre_age": c.age_ref, "kg_per_lap": round(c.kg_per_lap, 2) if c.kg_per_lap is not None else None,
            "s_per_10kg": round(10 * c.s_per_kg, 3) if c.s_per_kg is not None else None,
            "fuel_source": c.fuel_source,
        },
        "corners": corners,
    }
