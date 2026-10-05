"""Engine views over one or more sessions: opportunities, trends, setup, scores, stints, driver comparison,
debrief check."""
from dataclasses import replace

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app import models
from app.analysis.compare import compare_groups
from app.analysis.insights import RunInput, analyze_runs
from app.analysis.laps import load_session
from app.analysis.stint import stint_analysis
from app.db import get_db
from app.debrief.check import check_debrief
from app.heavy import one_at_a_time
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


@router.get("/sessions/{session_id}/insights")
@one_at_a_time
def session_insights(session_id: int, db: Session = Depends(get_db)):
    """Lap time opportunities, driving trends, setup checks and driver scores for one session."""
    runs, track = _runs(db, [session_id])
    return analyze_runs(runs, official_corners(track), drop_channels=True)


@router.get("/sessions/{session_id}/stint")
@one_at_a_time
def session_stint(session_id: int, db: Session = Depends(get_db)):
    """Each stint (split at pit stops) lap by lap: grip in use, lateral g, balance by corner phase, TC and ABS,
    tyres; and how the car fades through it (seconds and grip per lap) with the understeer gradient."""
    run, _ = _run(db, _get(db, session_id))
    return stint_analysis(run)


class InsightsIn(BaseModel):
    session_ids: list[int] = Field(min_length=1)


@router.post("/insights")
@one_at_a_time
def multi_insights(body: InsightsIn, db: Session = Depends(get_db)):
    """The same across several sessions at one track (a test day, an event): the car's limits come from all."""
    runs, track = _runs(db, body.session_ids)
    return analyze_runs(runs, official_corners(track), drop_channels=True)


class LapPick(BaseModel):
    session_id: int
    laps: list[int]


class Side(BaseModel):
    label: str
    session_ids: list[int] = []
    laps: list[LapPick] = []  # only these laps; for a log where both drivers shared the car


class CompareIn(BaseModel):
    a: Side
    b: Side


@router.post("/compare/drivers")
@one_at_a_time
def compare_drivers(body: CompareIn, db: Session = Depends(get_db)):
    """Two drivers or two stints on one car and track: where the time goes and which technique explains it."""
    if body.a.label == body.b.label:
        raise HTTPException(422, "Give the two sides different labels")
    runs, group_of = [], {}
    track_ids = set()
    track = None
    for key, side in (("a", body.a), ("b", body.b)):
        picks = {p.session_id: set(p.laps) for p in side.laps}
        for sid in dict.fromkeys([*side.session_ids, *picks]):
            s = _get(db, sid)
            run, t = _run(db, s, f"{side.label}: {s.name or 'Session'} #{sid}")
            if sid in picks:
                laps = [replace(l, clean=l.clean and l.number in picks[sid]) for l in run.data.laps]
                run = replace(run, data=replace(run.data, laps=laps))
            runs.append(run)
            group_of[run.name] = key
            track_ids.add(t.id if t else None)
            track = track or t
    if not runs or set(group_of.values()) != {"a", "b"}:
        raise HTTPException(422, "Pick at least one session or lap for each side")
    if len(track_ids) > 1:
        raise HTTPException(422, "These sessions are from different tracks")
    result = compare_groups(runs, group_of, {"a": body.a.label, "b": body.b.label}, official_corners(track),
                            drop_channels=True)
    if result.get("error"):
        raise HTTPException(422, result["error"])
    return result


@router.get("/debriefs/{debrief_id}/check")
@one_at_a_time
def debrief_check(debrief_id: int, db: Session = Depends(get_db)):
    """Each debrief point against the session's data: confirmed, partly, not seen, contradicted or cannot check."""
    d = db.get(models.Debrief, debrief_id)
    if d is None:
        raise HTTPException(404, "Debrief not found")
    runs, track = _runs(db, [d.session_id])
    corners = {c.id: c.code for c in track.corners} if track else {}
    points = [{"id": p.id, "text": p.text, "corner_code": p.corner_code or corners.get(p.corner_id),
               "phase": p.phase.value if p.phase else None} for p in d.points]
    return check_debrief(points, runs, official_corners(track), drop_channels=True)
