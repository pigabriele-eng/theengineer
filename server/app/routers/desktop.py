"""What only the desktop app asks for (desktop/ui): logs and videos read from the computer's own folders, and the
library of tracks and events its home screen lists (Gabriele, 2026-10-22: "desktop app with access to local files").

POST /desktop/import imports logs where they are on the computer: the files given, and every log in the folders
given (MoTeC .ld with its .ldx, CSV and Pi exports, VBOX .vbo, zips of them), as an upload of them would (the same
import job, routers/imports.py), skipping logs read from the same place before. Videos found beside them wait for
the import and then join the run whose log was in their folder (GET /desktop/import/{job} links them).

Videos (app/videos.py): linked to a run, put on its clock by the VBOX Video clock or the camera's own GPS speed when
they can be, else by the frame where the car crosses the start/finish line (PUT /desktop/videos/{id}/start-line).
The desktop app plays them from where they are; nothing is copied.
"""
from __future__ import annotations

import logging
import struct
import tempfile
import threading
from pathlib import Path

import numpy as np
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from app import local_files, models, videos
from app.analysis.laps import DEFAULT_CHANNEL_MAP
from app.db import get_db
from app.importers import archive
from app.page_cache import main_file
from app.routers import imports
from app.routers.sessions import _channel_map, _get
from app.timing import read_file

router = APIRouter(prefix="/desktop")
log = logging.getLogger(__name__)

MAX_FILES = 2000  # files looked at in one import: a whole season's folder, not a whole disk
_pending: dict[int, list[str]] = {}  # import job -> the videos waiting for its runs
_pending_lock = threading.Lock()


# ---------- import from the computer ----------

class ImportIn(BaseModel):
    paths: list[str] = Field(min_length=1, max_length=MAX_FILES)
    event_id: int | None = None


def _walk(paths: list[str]) -> tuple[list[Path], list[Path], list[Path]]:
    """(the roots given, the logs, the videos) under the paths given."""
    roots, logs, vids = [], [], []
    seen = 0
    for raw in paths:
        p = Path(raw).expanduser()
        if not p.exists():
            continue
        roots.append(p)
        for f in sorted(p.rglob("*")) if p.is_dir() else [p]:
            if not f.is_file() or any(part.startswith(".") for part in f.parts[-3:]):
                continue
            seen += 1
            if seen > MAX_FILES:
                raise HTTPException(413, f"More than {MAX_FILES} files there: pick the event's folder, "
                                         "not a whole disk")
            ext = f.suffix.lower()
            if ext in archive.ACCEPTED:
                logs.append(f)
            elif ext in videos.VIDEO_SUFFIXES:
                vids.append(f)
    return roots, logs, vids


def _known_sources(db: Session) -> set[str]:
    return {m.get("source_path") for m in db.scalars(select(models.LoggerFile.meta)) if m and m.get("source_path")}


@router.post("/import", status_code=202)
def import_local(body: ImportIn, db: Session = Depends(get_db)):
    """Import the logs in these files and folders from where they are, and link the videos beside them."""
    if body.event_id is not None and db.get(models.Event, body.event_id) is None:
        raise HTTPException(404, "Event not found")
    roots, logs, vids = _walk(body.paths)
    if not roots:
        raise HTTPException(404, "None of those files or folders is there any more")
    known = _known_sources(db)
    ldx = [p for p in logs if p.suffix.lower() == archive.LDX]
    new = [p for p in logs if p.suffix.lower() != archive.LDX and str(p.resolve()) not in known]
    # an .ldx goes with its log: only when the log is imported now
    stems = {(p.parent, p.stem.lower()) for p in new}
    new += [p for p in ldx if (p.parent, p.stem.lower()) in stems]
    known_videos = {v for v in db.scalars(select(videos.VideoLink.path))}
    vids = [v for v in vids if str(v.resolve()) not in known_videos]
    if not new:
        linked = _link_videos(db, [str(v.resolve()) for v in vids]) if vids else {"linked": [], "unmatched": []}
        return {"job": None, "logs": 0, "videos": linked}
    base = _common_parent(roots)
    uploads = [(_label(p, base), p) for p in new]
    local_files.add(new)
    job = models.ImportJob(filename=", ".join(dict.fromkeys(r.name for r in roots))[:255],
                           status=models.ImportStatus.queued, session_ids=[], errors=[], skipped=[])
    db.add(job)
    db.commit()
    imports.import_rates.queued(job.id, sum(p.stat().st_size for p in new), 0)
    folder = Path(tempfile.mkdtemp(prefix="theengineer-import-"))  # zips are unpacked here; the logs stay put
    if vids:
        with _pending_lock:
            _pending[job.id] = [str(v.resolve()) for v in vids]
    imports._jobs.put((job.id, folder, uploads, body.event_id))
    imports._start_worker()
    return {"job": job.id, "logs": sum(1 for p in new if p.suffix.lower() != archive.LDX), "videos": len(vids)}


def _common_parent(roots: list[Path]) -> Path:
    parents = [r.resolve().parent for r in roots]
    common = parents[0]
    for p in parents[1:]:
        while common not in (p, *p.parents):
            common = common.parent
    return common


def _label(p: Path, base: Path) -> str:
    """The file's path below the folder holding what was picked: "Hockenheim 2026/05_R1/run.ld", so a folder's
    logs are grouped and named as a zip of it would be."""
    try:
        return p.resolve().relative_to(base).as_posix()
    except ValueError:
        return p.name


@router.get("/import/{job_id}")
def import_status(job_id: int, db: Session = Depends(get_db)):
    """The import, as GET /imports/{id} has it, and once it is done the videos that waited for it, linked."""
    job = db.get(models.ImportJob, job_id)
    if job is None:
        raise HTTPException(404, "Import not found")
    out = imports._out(db, job)
    if job.status in (models.ImportStatus.done, models.ImportStatus.failed):
        with _pending_lock:
            waiting = _pending.pop(job_id, [])
        if waiting:
            out["videos"] = _link_videos(db, waiting)
    return out


# ---------- the library ----------

@router.get("/library")
def library(db: Session = Depends(get_db)):
    """Tracks, the events at each (newest first) and how many runs and videos each holds, for the home screen."""
    runs = db.scalars(select(models.RunSession)).all()
    vids: dict[int, int] = {}
    for sid in db.scalars(select(videos.VideoLink.session_id)):
        vids[sid] = vids.get(sid, 0) + 1
    events: dict[int, dict] = {}
    loose = []
    for s in runs:
        f = main_file(s)
        laps = [l for l in s.laps if f is not None and l.file_id == f.id]
        clean = [l.time_s for l in laps if l.clean]
        row = {"id": s.id, "name": s.name, "driver": s.driver.name if s.driver else None, "laps": len(laps),
               "best": min(clean) if clean else None, "logger": f.logger if f else None, "videos": vids.get(s.id, 0),
               "date": (f.meta or {}).get("date") if f else None}
        if s.event is None:
            loose.append(row)
            continue
        e = events.setdefault(s.event_id, {
            "id": s.event_id, "name": s.event.name, "series": s.event.series,
            "date": s.event.date.isoformat() if s.event.date else None,
            "track": (s.event.track.name if s.event.track else (f.meta or {}).get("venue") if f else None) or None,
            "runs": [], "videos": 0, "best": None, "loggers": set()})
        e["runs"].append(row)
        e["videos"] += row["videos"]
        if row["best"] is not None and (e["best"] is None or row["best"] < e["best"]):
            e["best"] = row["best"]
        if row["logger"]:
            e["loggers"].add(row["logger"])
    tracks: dict[str, dict] = {}
    for e in sorted(events.values(), key=lambda e: (e["date"] or "", e["id"]), reverse=True):
        e["loggers"] = sorted(e["loggers"])
        tracks.setdefault(e["track"] or "", {"name": e["track"], "events": []})["events"].append(e)
    ordered = sorted(tracks.values(), key=lambda t: (t["name"] is None, -max(
        (ev["id"] for ev in t["events"]), default=0)))
    return {"tracks": ordered, "loose": loose}


@router.get("/runs/{session_id}/laps")
def run_laps(session_id: int, db: Session = Depends(get_db)):
    """The run's laps with where each starts on its main log's clock: what the videos are played against."""
    s = _get(db, session_id)
    f = main_file(s)
    return {"id": s.id, "name": s.name, "driver": s.driver.name if s.driver else None,
            "logger": f.logger if f else None,
            "laps": [{"number": l.number, "start": round(l.start_s, 3), "time": round(l.time_s, 3), "clean": l.clean}
                     for l in s.laps if f is not None and l.file_id == f.id],
            "videos": [_video_out(v) for v in _videos_of(db, s.id)]}


# ---------- videos ----------

def _videos_of(db: Session, session_id: int) -> list[videos.VideoLink]:
    return list(db.scalars(select(videos.VideoLink).where(videos.VideoLink.session_id == session_id)
                           .order_by(videos.VideoLink.path)))


def _video_out(v: videos.VideoLink) -> dict:
    return {"id": v.id, "session_id": v.session_id, "path": v.path, "name": Path(v.path).name, "start": v.start_s,
            "method": v.method, "score": None if v.score is None else round(v.score, 3), "duration": v.duration_s,
            "camera": v.camera, "exists": Path(v.path).exists()}


def _log_speed(s: models.RunSession, f: models.LoggerFile) -> tuple[np.ndarray, np.ndarray] | None:
    ld = read_file(f)
    cmap = {**DEFAULT_CHANNEL_MAP, **(_channel_map(s) or {})}
    ch = ld.channel(*cmap["speed"])
    if ch is None:
        return None
    v = ch.values()
    t = getattr(ch, "times", None)
    t = np.asarray(t() if callable(t) else t) if t is not None else np.arange(len(v)) / ch.freq
    return t[:len(v)], v[:len(t)]


def _vbox_clock(s: models.RunSession, f: models.LoggerFile, name: str) -> float | None:
    """The VBOX Video file's first frame on the run's clock, when the run's log is the .vbo that recorded it."""
    if f.logger != "vbox" or not (f.meta or {}).get("video"):
        return None
    number = videos.video_number(name)
    if number is None:
        return None
    ld = read_file(f)
    idx, sync = ld.channel("avifileindex"), ld.channel("avisynctime")
    if idx is None or sync is None:
        return None
    vi, vs = idx.values(), sync.values()
    t = getattr(sync, "times", None)
    t = np.asarray(t() if callable(t) else t) if t is not None else np.arange(len(vs)) / sync.freq
    n = min(len(vi), len(vs), len(t))
    return videos.vbox_start(t[:n], vi[:n], vs[:n], number)


def _sync(db: Session, v: videos.VideoLink, s: models.RunSession) -> None:
    """Put the video on the run's clock if it can be done without the driver: VBOX Video's own clock, else the
    camera's GPS speed matched to the log's."""
    f = main_file(s)
    if f is None:
        return
    try:
        start = _vbox_clock(s, f, Path(v.path).name)
        if start is not None:
            v.start_s, v.method, v.score = start, "vbox", 1.0
            return
        mp4 = videos.Mp4(v.path)
        v.duration_s, v.camera = mp4.duration_s, mp4.camera
        cam = videos.gps_speed(mp4)
        speed = _log_speed(s, f) if cam is not None else None
        if cam is not None and speed is not None:
            got = videos.match_speed(cam[0], cam[1], speed[0], speed[1])
            if got is not None:
                v.score = got[1]
                if got[1] >= videos.GOOD_MATCH:
                    v.start_s, v.method = got[0], "gps"
    except (OSError, ValueError, struct.error) as e:
        log.warning("Couldn't sync %s: %s", v.path, e)


def _gps_score(s: models.RunSession, cam) -> float:
    f = main_file(s)
    speed = _log_speed(s, f) if f is not None else None
    got = videos.match_speed(cam[0], cam[1], speed[0], speed[1]) if speed is not None else None
    return got[1] if got else -1.0


def _link_videos(db: Session, paths: list[str]) -> dict:
    """Each video joined to the run whose log was in its folder (of several, the VBOX log that recorded it, else
    the one its GPS speed matches); a video no run can be told for is listed, for the driver to pick."""
    by_folder: dict[str, list[models.RunSession]] = {}
    for f in db.scalars(select(models.LoggerFile)):
        src = (f.meta or {}).get("source_path")
        if src:
            by_folder.setdefault(str(Path(src).parent), []).append(f.session)
    linked, unmatched = [], []
    for p in paths:
        runs = list({s.id: s for s in by_folder.get(str(Path(p).parent), [])}.values())
        pick = None
        if len(runs) == 1:
            pick = runs[0]
        elif runs:
            vbox = [s for s in runs if (f := main_file(s)) is not None and _vbox_clock(s, f, Path(p).name) is not None]
            if len(vbox) == 1:
                pick = vbox[0]
            else:
                try:
                    cam = videos.gps_speed(videos.Mp4(p))
                except (OSError, ValueError):
                    cam = None
                if cam is not None:
                    scored = sorted(((_gps_score(s, cam), s) for s in runs), key=lambda x: -x[0])
                    if scored and scored[0][0] >= videos.GOOD_MATCH:
                        pick = scored[0][1]
        if pick is None:
            unmatched.append(p)
            continue
        v = videos.VideoLink(session_id=pick.id, path=p, meta={}, size=Path(p).stat().st_size)
        _sync(db, v, pick)
        db.add(v)
        db.commit()
        linked.append(_video_out(v))
    return {"linked": linked, "unmatched": unmatched}


class VideoIn(BaseModel):
    session_id: int
    path: str


@router.post("/videos", status_code=201)
def add_video(body: VideoIn, db: Session = Depends(get_db)):
    """A video on the computer joined to a run, put on its clock when that can be done on its own."""
    s = _get(db, body.session_id)
    p = Path(body.path).expanduser()
    if not p.is_file():
        raise HTTPException(404, "That video isn't there")
    if p.suffix.lower() not in videos.VIDEO_SUFFIXES:
        raise HTTPException(415, "Pick an .mp4 or .mov video")
    v = videos.VideoLink(session_id=s.id, path=str(p.resolve()), meta={}, size=p.stat().st_size)
    _sync(db, v, s)
    db.add(v)
    db.commit()
    return _video_out(v)


class StartLineIn(BaseModel):
    video_s: float = Field(ge=0)  # the frame where the car crosses the start/finish line
    lap: int  # starting this lap


@router.put("/videos/{video_id}/start-line")
def start_line(video_id: int, body: StartLineIn, db: Session = Depends(get_db)):
    """The video on the run's clock from one frame: the car crossing the line at the start of this lap."""
    v = db.get(videos.VideoLink, video_id)
    if v is None:
        raise HTTPException(404, "Video not found")
    s = _get(db, v.session_id)
    f = main_file(s)
    lap = next((l for l in s.laps if f is not None and l.file_id == f.id and l.number == body.lap), None)
    if lap is None:
        raise HTTPException(404, f"This run has no lap {body.lap}")
    v.start_s, v.method, v.score = lap.start_s - body.video_s, "start-line", None
    db.commit()
    return _video_out(v)


class NudgeIn(BaseModel):
    start: float


@router.put("/videos/{video_id}")
def nudge(video_id: int, body: NudgeIn, db: Session = Depends(get_db)):
    """The video moved on the run's clock by hand (a frame or two either way)."""
    v = db.get(videos.VideoLink, video_id)
    if v is None:
        raise HTTPException(404, "Video not found")
    v.start_s = body.start
    v.method = v.method or "start-line"
    db.commit()
    return _video_out(v)


@router.get("/videos/{video_id}/file")
def video_file(video_id: int, db: Session = Depends(get_db)):
    """The video itself, from where it is on the computer, in parts as the player asks for them."""
    v = db.get(videos.VideoLink, video_id)
    if v is None:
        raise HTTPException(404, "Video not found")
    p = Path(v.path)
    if not p.is_file():
        raise HTTPException(404, f"The video isn't at {p} any more")
    return FileResponse(p, media_type="video/quicktime" if p.suffix.lower() == ".mov" else "video/mp4")


@router.delete("/videos/{video_id}", status_code=204)
def remove_video(video_id: int, db: Session = Depends(get_db)):
    """The video taken off its run (the file itself stays where it is)."""
    v = db.get(videos.VideoLink, video_id)
    if v is not None:
        db.delete(v)
        db.commit()
