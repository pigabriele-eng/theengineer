"""The Compare screen: any laps from any sessions at one track (a driver's own runs, a teammate's, a client's)."""
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from app import heavy, models
from app.analysis.lapcompare import MAX_LAPS, MIN_LAPS, Pick, compare_picks
from app.analysis.laps import SessionData, load_session
from app.db import get_db
from app.routers.imports import _date
from app.routers.sessions import _channel_map, _get, official_corners
from app.timing import read_file, track_line

router = APIRouter(prefix="/compare")


def _main_file(s: models.RunSession) -> models.LoggerFile | None:
    """The log a session is analysed from, as everywhere else: the longest."""
    return max(s.files, key=lambda f: f.meta.get("duration_s", 0)) if s.files else None


def _tracks_by_name(db: Session) -> dict[str, models.Track]:
    return {t.name: t for t in db.scalars(select(models.Track)).all()}


def _track(s: models.RunSession, by_name: dict[str, models.Track]) -> tuple[str, str | None, models.Track | None]:
    """The session's track without reading its log (its event's, or the venue its log header names): a key to
    group by, the name to show and the track."""
    if s.event and s.event.track:
        return f"track {s.event.track.id}", s.event.track.name, s.event.track
    f = _main_file(s)
    venue = ((f.meta.get("venue") if f else None) or "")[:120]
    if venue in by_name:
        return f"track {by_name[venue].id}", venue, by_name[venue]
    return (f"venue {venue}", venue, None) if venue else ("unknown", None, None)


def _driver(s: models.RunSession) -> str | None:
    driver = getattr(s, "driver", None)
    return getattr(driver, "name", None) or None


def _name(s: models.RunSession) -> str:
    return s.name or f"Session {s.id}"


@router.get("/sessions")
def comparable_sessions(db: Session = Depends(get_db)):
    """Every session with timed laps, grouped by track, for picking laps: only laps from one track compare."""
    rows = db.scalars(select(models.RunSession).options(
        selectinload(models.RunSession.laps), selectinload(models.RunSession.files),
        selectinload(models.RunSession.event).selectinload(models.Event.track),
        selectinload(models.RunSession.driver))).all()
    by_name = _tracks_by_name(db)
    groups: dict[str, dict] = {}
    for s in sorted(rows, key=lambda s: (-(s.event_id or 0), _name(s))):
        f = _main_file(s)
        laps = [l for l in s.laps if f is not None and l.file_id == f.id]
        clean = [l for l in laps if l.clean]
        if not clean:  # pit and garage running: nothing to compare
            continue
        key, track_name, _ = _track(s, by_name)
        best = min(clean, key=lambda l: l.time_s)
        day = _date(f.meta.get("date") or "") or (s.event.date if s.event else None)
        groups.setdefault(key, {"key": key, "track": track_name, "sessions": []})["sessions"].append({
            "id": s.id, "name": _name(s), "driver": _driver(s), "event": s.event.name if s.event else None,
            "date": day.isoformat() if day else None,
            "best_lap": best.number, "best_time": best.time_s,
            "laps": [{"number": l.number, "time": l.time_s, "clean": l.clean} for l in laps],
        })
    return {"tracks": list(groups.values())}


class LapRef(BaseModel):
    session_id: int
    lap: int


class CompareLapsIn(BaseModel):
    laps: list[LapRef] = Field(min_length=MIN_LAPS, max_length=MAX_LAPS)
    step_m: float = Field(5.0, ge=1.0, le=50.0)


@router.post("/laps")
def compare_laps(body: CompareLapsIn, db: Session = Depends(get_db)):
    """Two to six laps from any sessions at one track, placed on one GPS line: section times against the quickest
    in each section and the ideal lap made of them, where each lap loses time (the phase, and the technique
    difference behind it in plain words), and the traces every step_m metres for charts.

    The sessions' logs are read one at a time and let go once their picked laps are traced.
    """
    if len({(p.session_id, p.lap) for p in body.laps}) < len(body.laps):
        raise HTTPException(422, "Each lap can only be picked once")
    by_name = _tracks_by_name(db)
    sessions: dict[int, models.RunSession] = {}
    tracks: dict[str, models.Track | None] = {}
    picks = []
    for p in body.laps:
        s = sessions.setdefault(p.session_id, _get(db, p.session_id))
        f = _main_file(s)
        if f is None:
            raise HTTPException(404, f"{_name(s)} has no logger file")
        lap = next((l for l in s.laps if l.file_id == f.id and l.number == p.lap), None)
        if lap is None:
            raise HTTPException(404, f"{_name(s)} has no lap {p.lap}")
        key, _, track = _track(s, by_name)
        tracks[key] = track
        picks.append(Pick(str(s.id), p.lap, lap.time_s, {
            "session_id": s.id, "session": _name(s), "driver": _driver(s),
            "event": s.event.name if s.event else None}))
    if len(tracks) > 1:
        raise HTTPException(422, "These laps are from different tracks; compare laps from one track")
    track = next(iter(tracks.values()))

    def load(run: str) -> SessionData:
        s = sessions[int(run)]
        f = _main_file(s)
        # timed with the same start/finish line as when its laps were stored, so lap numbers match
        return load_session(read_file(f), _channel_map(s), beacons=f.meta.get("beacons"), line=track_line(track))

    try:
        # each session's log is read and traced under the shared lock, one session at a time; letting go of the
        # lock between sessions hands the last one's memory back before the next is read
        result = compare_picks(picks, load, official_corners(track), body.step_m, guard=heavy.lock)
    except ValueError as e:
        raise HTTPException(422, str(e)) from e
    finally:
        heavy.release_memory()
    return {"track": track.name if track else None, **result}
