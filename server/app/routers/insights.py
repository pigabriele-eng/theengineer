"""Engine views over one or more sessions: opportunities, trends, setup, scores, driver comparison,
debrief check."""
from collections.abc import Callable
from dataclasses import replace
from functools import partial

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app import lappacks, models, page_cache
from app.analysis.balance import car_geometry
from app.analysis.compare import ROLES as COMPARE_ROLES
from app.analysis.compare import RunSource, compare_groups
from app.analysis.insights import LazyRun, RunInput, analyze_lazily, analyze_runs
from app.analysis.laps import load_session
from app.db import get_db
from app.debrief.check import check_debrief
from app.debrief.covers import covers
from app.vehicle.presets import preset_detail
from app.heavy import one_at_a_time
from app.routers.balance import preset_for
from app.routers.drivers import main_file, session_track
from app.routers.sessions import _channel_map, _get, _line, _track_for, official_corners, read_file

router = APIRouter()


def _run(db: Session, s: models.RunSession, name: str | None = None) -> tuple[RunInput, models.Track | None]:
    """The session's main log (the longest), ready for the engine, and the track it was driven on."""
    if not s.files:
        raise HTTPException(404, f"No logger file uploaded for session {s.id}")
    f = max(s.files, key=lambda f: f.meta.get("duration_s", 0))
    ld = read_file(f)
    track = _track_for(db, s, ld)
    data = load_session(ld, _channel_map(s), beacons=f.meta.get("beacons"), line=_line(track))
    run = RunInput(name or s.name or f"Session {s.id}", data, s.driver.name if s.driver else None,
                   {"session_id": s.id, "file_id": f.id}, ld)
    return run, track


def _runs(db: Session, session_ids: list[int]) -> tuple[list[RunInput], models.Track | None]:
    runs, tracks = [], {}
    for sid in dict.fromkeys(session_ids):
        s = _get(db, sid)
        name = s.name or f"Session {s.id}"
        if any(r.name == name for r in runs):
            name = f"{name} #{s.id}"
        run, track = _run(db, s, name)
        runs.append(run)
        tracks[track.id if track else None] = track
    if len(tracks) > 1:
        raise HTTPException(422, "These sessions are from different tracks; compare sessions from one track")
    return runs, next(iter(tracks.values()))


def _lazy_runs(db: Session, session_ids: list[int]) -> tuple[list[LazyRun], Callable[[], models.Track | None]]:
    """_runs() as runs to read one at a time (analyze_lazily), and their track once they are read."""
    runs, names, tracks = [], [], {}

    def load(s: models.RunSession, name: str) -> RunInput:
        run, track = _run(db, s, name)
        tracks[track.id if track else None] = track
        if len(tracks) > 1:
            raise HTTPException(422, "These sessions are from different tracks; compare sessions from one track")
        return run

    for sid in dict.fromkeys(session_ids):
        s = _get(db, sid)
        if not s.files:
            raise HTTPException(404, f"No logger file uploaded for session {s.id}")
        name = s.name or f"Session {s.id}"
        if name in names:
            name = f"{name} #{s.id}"
        names.append(name)
        f = main_file(s)
        clean = [l.time_s for l in s.laps if l.file_id == f.id and l.clean]
        runs.append(LazyRun(partial(load, s, name), min(clean, default=None)))
    return runs, lambda: next(iter(tracks.values()), None)


@router.get("/sessions/{session_id}/insights")
def session_insights(session_id: int, db: Session = Depends(get_db)):
    """Lap time opportunities, driving trends, setup checks and driver scores for one session; kept once worked
    out (app/page_cache.py)."""
    s = _get(db, session_id)

    def work() -> dict:
        runs, track = _runs(db, [s.id])
        return analyze_runs(runs, official_corners(track), drop_channels=True)

    return page_cache.RawJSON(page_cache.cached(
        db, f"session:{s.id}|insights", lambda: page_cache.session_signature(db, "insights", s, main_file(s)), work,
        raw=True))


class InsightsIn(BaseModel):
    session_ids: list[int] = Field(min_length=1)


@router.post("/insights")
@one_at_a_time
def multi_insights(body: InsightsIn, db: Session = Depends(get_db)):
    """The same across several sessions at one track (a test day, an event): the car's limits come from all. The
    sessions' logs are read one at a time, so many fit in the server's memory."""
    runs, track = _lazy_runs(db, body.session_ids)
    return analyze_lazily(runs, lambda: official_corners(track()))


class LapPick(BaseModel):
    session_id: int
    laps: list[int]


class Side(BaseModel):
    label: str = Field(min_length=1, max_length=120)
    session_ids: list[int] = []
    laps: list[LapPick] = []  # only these laps; for a log where both drivers shared the car


class CompareIn(BaseModel):
    a: Side
    b: Side


def _picked_run(db: Session, session_id: int, name: str, picks: set[int] | None) -> RunInput:
    """A session's main log with only the channels the comparison reads, and only the picked laps counted clean."""
    s = _get(db, session_id)
    f = main_file(s)
    ld = read_file(f)
    data = load_session(ld, _channel_map(s), beacons=f.meta.get("beacons"), line=_line(_track_for(db, s, ld)),
                        roles=COMPARE_ROLES)
    if picks is not None:
        data.laps = [replace(l, clean=l.clean and l.number in picks) for l in data.laps]
    lappacks.missed(db, [s])  # read from its log this time: from its lap pack next time
    return RunInput(name, data, s.driver.name if s.driver else None, {"session_id": s.id, "file_id": f.id})


def compare_sources(db: Session, a: Side, b: Side) -> tuple[list[RunSource], models.Track | None]:
    """The sessions of both sides as runs to read one at a time, after checking they can be compared: one track,
    one car, and a session on both sides only when each side has its own laps of it."""
    if not a.label.strip() or not b.label.strip():
        raise HTTPException(422, "Give each side a name")
    if a.label.strip() == b.label.strip():
        raise HTTPException(422, "Give the two sides different names")
    picked = {key: {p.session_id: set(p.laps) for p in side.laps} for key, side in (("a", a), ("b", b))}
    ids = {key: list(dict.fromkeys([*side.session_ids, *picked[key]])) for key, side in (("a", a), ("b", b))}
    for sid in set(ids["a"]) & set(ids["b"]):
        if sid not in picked["a"] or sid not in picked["b"]:
            raise HTTPException(422, f"Session {sid} is on both sides; pick which of its laps go on each side")
    sources, tracks, cars = [], {}, set()
    for key, side in (("a", a), ("b", b)):
        for sid in ids[key]:
            s = _get(db, sid)
            f = main_file(s)
            if f is None:
                raise HTTPException(404, f"No logger file uploaded for session {sid}")
            track = session_track(db, s)
            tracks[track.id if track else None] = track
            cars.add(s.car_id)
            picks = picked[key].get(sid)
            clean = [l.time_s for l in s.laps if l.file_id == f.id and l.clean and (picks is None or l.number in picks)]
            name = f"{side.label}: {s.name or 'Session'} #{sid}"
            sources.append(RunSource(name, key, partial(_picked_run, db, sid, name, picks), min(clean, default=None),
                                     {"session_id": sid, "session": s.name or f"Session {sid}"},
                                     partial(lappacks.packed_run, db, s, track, None, picks)))
    if not ids["a"] or not ids["b"]:
        raise HTTPException(422, "Pick at least one session or lap for each side")
    if len(tracks) > 1:
        raise HTTPException(422, "These sessions are from different tracks; compare sessions from one track")
    if len(cars - {None}) > 1:
        raise HTTPException(422, "These sessions are from different cars; compare sessions in one car")
    return sources, next(iter(tracks.values()))


@router.post("/compare/drivers")
@one_at_a_time
def compare_drivers(body: CompareIn, db: Session = Depends(get_db)):
    """Two drivers or two groups of runs on one car and track, over all their clean laps: where each gains or loses
    and how consistently, the technique behind it and each driver's habits that repeat lap after lap. Runs are read
    one at a time and reduced to per-lap metrics, so many sessions fit in the server's memory."""
    sources, track = compare_sources(db, body.a, body.b)
    result = compare_groups(sources, {"a": body.a.label.strip(), "b": body.b.label.strip()}, official_corners(track))
    if result.get("error"):
        raise HTTPException(422, result["error"])
    result["track"] = track.name if track else None
    return result


@router.get("/debriefs/{debrief_id}/check")
@one_at_a_time
def debrief_check(debrief_id: int, db: Session = Depends(get_db)):
    """Each debrief point against the session's data: confirmed, partly, not seen, contradicted or cannot check."""
    d = db.get(models.Debrief, debrief_id)
    if d is None:
        raise HTTPException(404, "Debrief not found")
    covered, set_by_user = covers(db, d)
    groups: dict[int, list] = {}
    for r, g in covered:
        groups.setdefault(g, []).append(r)
    runs, track = _runs(db, [r.id for r, _ in covered])
    by_id = dict(zip([r.id for r, _ in covered], runs, strict=True))
    corners = {c.id: c.code for c in track.corners} if track else {}
    points = [{"id": p.id, "text": p.text, "corner_code": p.corner_code or corners.get(p.corner_id),
               "phase": p.phase.value if p.phase else None} for p in d.points]
    s = _get(db, d.session_id)
    preset = preset_for([s.car] if s.car else [])  # the car's steering ratio and wheelbase, as the report reads them
    geo = car_geometry(preset_detail(preset) if preset else None)
    # one check per setup: a point said about the whole session gets a verdict for each, the last setup's first
    results = [(g, rs, check_debrief(points, [by_id[r.id] for r in rs], official_corners(track),
                                     drop_channels=True, geo=geo)) for g, rs in sorted(groups.items())]
    out = next((res for _, _, res in reversed(results) if not res.get("error")), results[-1][2])
    out["covers"] = {"runs": [{"session_id": r.id, "name": r.name or f"Session {r.id}", "group": g}
                              for r, g in covered], "set_by_user": set_by_user}
    if len(results) > 1:
        out["groups"] = [{"label": f"Setup {i + 1}", "runs": [r.name or f"Session {r.id}" for r in rs],
                          "laps": res.get("laps", 0), "summary": res.get("summary", {}), "error": res.get("error")}
                         for i, (_, rs, res) in enumerate(results)]
        for p in out.get("points", []):
            p["by_group"] = [next(({"verdict": q["verdict"], "agreement": q["agreement"], "line": q.get("line")}
                                   for q in res.get("points", []) if q.get("id") == p.get("id")), None)
                             for _, _, res in results]
    return out
