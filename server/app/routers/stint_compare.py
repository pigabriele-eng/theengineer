"""The stint tool's comparison of two stints, to see whether a setup change worked (Gabriele, 2026-10-09: "in the stint
analysis, add stint comparison to validate setup changes").

GET /stint/compare?files=<the ticked logs>&a=<stint key>&b=<stint key>: two stints of the stint view of those logs
(routers/stint.py, kept once worked out; this reads no log of its own when the page has just shown that view), side by
side (analysis/stint_compare.py): what changed on the setup sheets between their runs, how like with like they are
(driver, tyres, session), the lap time with each lap taken to one tyre age and fuel load (analysis/like_for_like.py,
as the report's Drivers section does it), grip and balance per phase, the corners where the balance moved, the tyre
fade and the driver aids. Without a and b: the latest stint against the one before it, by the same driver on the same
tyres where there is one.
"""
from __future__ import annotations

import json
import re

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from app import models, page_cache, run_labels, run_parts, run_tyres
from app.analysis import like_for_like, stint_compare
from app.db import get_db
from app.routers import report_drivers, stint
from app.setup import sheet
from app.setup.templates import TEMPLATES, diff

router = APIRouter()

TRIED = re.compile(r"Tried on this run: ([^.]+)\.")


def _view(db: Session, ids: list[int]) -> dict:
    view = stint.stint_view(db, ids)
    return json.loads(view.body) if isinstance(view, page_cache.RawJSON) else view


def _choices(db: Session, stints: list[dict]) -> tuple[list[dict], dict[int, models.RunSession]]:
    """Every stint in view as the pickers list it, in the order they were driven."""
    runs = {sid: db.get(models.RunSession, sid) for sid in {s["session_id"] for s in stints if s.get("session_id")}}
    runs = {k: v for k, v in runs.items() if v is not None}
    labels = run_labels.labels_for(db, list(runs.values()))
    tyres = run_tyres.for_runs(db, list(runs.values()))
    per_file: dict[str, int] = {}
    for s in stints:
        per_file[s["file_key"]] = per_file.get(s["file_key"], 0) + 1
    out = []
    for s in stints:
        r = runs.get(s.get("session_id"))
        if r is None or s["fitted_laps"] < 2:  # no laps in its trend to compare
            continue
        name = labels[r.id].name if r.id in labels else s["run"]
        t = tyres.get(r.id) or {}
        out.append({"key": s["key"], "session_id": r.id, "file_id": s.get("file_id"), "number": s["number"],
                    "name": f"{name} · Stint {s['number']}" if per_file[s["file_key"]] > 1 else name,
                    "run": name, "driver": r.driver.name if r.driver else None,
                    "tyres": t.get("tyres"), "tyres_label": t.get("label"), "tyres_sure": bool(t.get("sure")),
                    "laps": s["fitted_laps"], "best": s.get("best"),
                    "_order": (sheet._order(r), s["number"])})
    out.sort(key=lambda c: c["_order"])
    for i, c in enumerate(out):
        c["order"] = i
        del c["_order"]
    return out, runs


def default_pair(choices: list[dict]) -> tuple[dict, dict, str]:
    """The latest stint, and the one before it to compare it with: by the same driver on the same tyres where there
    is one, else by the same driver, else the one just before."""
    usable = [c for c in choices if c["laps"] >= stint_compare.MIN_LAPS]
    if len(usable) < 2:
        return choices[-2], choices[-1], "The last two stints."
    b = usable[-1]
    before = usable[:-1]
    same = [c for c in before if c["driver"] and c["driver"] == b["driver"]]
    alike = [c for c in same if c["tyres"] and c["tyres"] == b["tyres"]]
    if alike:
        a = alike[-1]
        why = f"The latest stint against the last one {b['driver']} drove on {(b['tyres_label'] or '').lower()} tyres."
    elif same:
        a = same[-1]
        why = f"The latest stint against the last one {b['driver']} drove before it."
    else:
        a = before[-1]
        why = "The latest stint against the one before it."
    return a, b, why


def _setup(db: Session, ra: models.RunSession, rb: models.RunSession, na: str, nb: str) -> dict:
    """What the setup sheets say changed from a's run to b's."""
    if ra.id == rb.id:
        return {"same_run": True, "a_sheet": False, "b_sheet": False, "changes": [], "tried": [], "missing": []}
    own = {"a": sheet.setup_of(db, ra.id), "b": sheet.setup_of(db, rb.id)}
    changes = []
    if own["a"] is not None and own["b"] is not None and own["a"].template == own["b"].template \
            and own["a"].template in TEMPLATES:
        changes = [{k: c[k] for k in ("key", "label", "unit", "from", "to", "delta", "text")}
                   for c in diff(TEMPLATES[own["a"].template], own["a"].values, own["b"].values)]
    tried = TRIED.findall(own["b"].notes or "") if own["b"] is not None else []
    return {"same_run": False, "a_sheet": own["a"] is not None, "b_sheet": own["b"] is not None,
            "changes": changes, "tried": tried,
            "missing": [n for side, n in (("a", na), ("b", nb)) if own[side] is None]}


def _fuel_runs(db: Session, runs: list[models.RunSession], stints: list[dict]
               ) -> tuple[list[like_for_like.Run], dict[int, run_parts.Part]]:
    """Every run of these runs' events as the tyre and fuel correction needs it, and each run's official session."""
    out: list[like_for_like.Run] = []
    session_of: dict[int, run_parts.Part] = {}
    seen: set[int | None] = set()
    tyres = run_tyres.for_runs(db, runs)
    for r in runs:
        key = r.event_id if r.event_id is not None else -r.id
        if key in seen:
            continue
        seen.add(key)
        event = run_labels.event_runs(db, r)
        labs = run_labels.label_runs(event)
        found = run_parts.parts(event, labs)
        session_of.update({lab.id: p for p in found for lab in p.runs})
        part_of = {lab.id: p for p in run_parts.blocks(found) for lab in p.runs}
        for x in report_drivers._fuel_runs(stints, event, labs, part_of, tyres):
            x.part = f"{key}:{x.part}"  # a race of one event never carries on into another's
            out.append(x)
    return out, session_of


@router.get("/stint/compare")
def compare_stints(files: str = Query(..., description="The ticked logger file ids, comma-separated"),
                   a: str | None = None, b: str | None = None, db: Session = Depends(get_db)):
    """Two stints of the ticked logs side by side: setup changes, like with like, lap time on one tyre age and fuel
    load, grip and balance per phase and per corner, tyre fade and driver aids, and what it says in plain words."""
    try:
        ids = [int(x) for x in files.split(",") if x.strip()]
    except ValueError as e:
        raise HTTPException(422, "files: comma-separated log ids") from e
    view = _view(db, ids)
    choices, runs = _choices(db, view["stints"])
    if len(choices) < 2:
        raise HTTPException(422, "Only one stint with laps to compare here: add another run to compare two stints.")
    by_key = {c["key"]: c for c in choices}
    if a is None or b is None:
        ca, cb, why = default_pair(choices)
    else:
        if a not in by_key or b not in by_key:
            raise HTTPException(404, "That stint isn't in view any more: pick it again.")
        if a == b:
            raise HTTPException(422, "Pick two different stints.")
        ca, cb, why = by_key[a], by_key[b], None
    st = {s["key"]: s for s in view["stints"]}
    sa, sb = st[ca["key"]], st[cb["key"]]
    ra, rb = runs[ca["session_id"]], runs[cb["session_id"]]
    names = {"a": ca["name"], "b": cb["name"]}

    # the lap times on one tyre age and one fuel load
    fit = {side: [r for r in s["laps"] if r.get("in_fit")] for side, s in (("a", sa), ("b", sb))}
    fuel_runs, session_of = _fuel_runs(db, list({ra.id: ra, rb.id: rb}.values()), view["stints"])
    laps = [(ca["session_id"], r["lap"], r["time"]) for r in fit["a"]] + \
           [(cb["session_id"], r["lap"], r["time"]) for r in fit["b"]]
    every = [r["time"] for s in (sa, sb) for r in s["laps"] if r.get("in_fit")]
    fade = like_for_like.fade_from_stints(view["stints"]) or (
        like_for_like.fade_for_track(view.get("track"), float(sorted(every)[len(every) // 2])) if every else None)
    c = like_for_like.correct(laps, fuel_runs, fade)
    n = len(fit["a"])
    times = {"a": c.times[:n], "b": c.times[n:]}
    races = any(r.kind == "race" for r in fuel_runs if r.session_id in (ra.id, rb.id))
    time = stint_compare.lap_time(times["a"], times["b"])
    if time is not None:
        time["best"] = {"a": min((r["time"] for r in fit["a"]), default=None),
                        "b": min((r["time"] for r in fit["b"]), default=None)}

    # like with like
    checks = []
    da, dbr = ca["driver"], cb["driver"]
    if da and dbr:
        checks.append({"ok": da == dbr, "text": f"Same driver: {da}." if da == dbr else
                       f"Different drivers, {da} and {dbr}: part of the difference is the driver's."})
    else:
        unset = " and ".join(names[s] for s, d in (("a", da), ("b", dbr)) if not d)
        checks.append({"ok": False, "text": f"Driver not set on {unset}."})
    ta, tb = ca["tyres_label"], cb["tyres_label"]
    if ta and tb:
        checks.append({"ok": ta == tb, "text": f"Both on {ta.lower()} tyres." if ta == tb else
                       f"{ta} tyres on {names['a']}, {tb.lower()} on {names['b']}."})
    pa, pb = session_of.get(ra.id), session_of.get(rb.id)
    if ra.id == rb.id or (pa is not None and pb is not None and pa.code == pb.code and ra.event_id == rb.event_id):
        checks.append({"ok": True, "text": f"Same session{f' ({pa.title})' if pa else ''}."})
    else:
        temps = ""
        if ra.track_temp_c is not None and rb.track_temp_c is not None:
            temps = f" Track {ra.track_temp_c:g} °C on {names['a']}, {rb.track_temp_c:g} °C on {names['b']}."
        checks.append({"ok": False, "text": "Different sessions: the track changes between them and that can't be "
                                            f"corrected.{temps}"})

    too_few = [names[side] for side in ("a", "b") if len(fit[side]) < stint_compare.MIN_LAPS]
    phase_rows = stint_compare.phases(sa, sb)
    corner_rows = stint_compare.corners(sa, sb)
    fade_row = stint_compare.fade(sa, sb)
    aid_rows = stint_compare.aids(sa, sb)
    said = stint_compare.words(names, time, c.tyres or c.fuel_done, phase_rows, corner_rows, fade_row, aid_rows,
                               too_few)

    def side(choice: dict, rows: list[dict], fixed: list[float], ages: list[float | None]) -> dict:
        known = [x for x in ages if x is not None]
        return {**choice, "laps_in_trend": len(rows),
                "tyre_age": round(sorted(known)[len(known) // 2], 1) if known else None,
                "times": [{"lap": r["lap"], "tyre_lap": r["tyre_lap"], "time": r["time"], "corrected": t}
                         for r, t in zip(rows, fixed, strict=True)]}

    return {
        "track": view.get("track"), "file_ids": view.get("file_ids"),
        "choices": choices,
        "picked": {"a": ca["key"], "b": cb["key"], "default": why is not None, "why": why},
        "a": side(ca, fit["a"], times["a"], c.ages[:n]), "b": side(cb, fit["b"], times["b"], c.ages[n:]),
        "setup": _setup(db, ra, rb, names["a"], names["b"]),
        "like_for_like": checks,
        "lap_time": time,
        "correction": {"tyres": c.tyres, "fuel": c.fuel_done, "words": like_for_like.words(c, fade, races),
                       "tyre_age": c.age_ref},
        "phases": phase_rows, "corners": corner_rows, "fade": fade_row, "aids": aid_rows,
        "understeer_per_g": view.get("understeer_per_g"),
        "words": said,
    }
