"""Driver comparisons: what can be compared (sessions and drivers grouped by track and car), and comparisons over
many sessions as background jobs.

A comparison reads every run of both sides, which takes a while on a small server, so the app starts a job and
follows it (runs read so far) until the result is ready. Each run is read under the server's shared lock for log
reading (app.heavy), so a comparison never holds a log in memory while another request or import does. Jobs and
their results live in the server's memory: a restart loses them and the app starts again.
"""
import logging
import threading
import time
import uuid
from datetime import date, datetime

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from app import models
from app.analysis.compare import compare_groups, release_memory
from app.db import SessionLocal, get_db
from app.routers.drivers import main_file, session_track
from app.routers.insights import CompareIn, compare_sources
from app.routers.sessions import official_corners

router = APIRouter()
log = logging.getLogger(__name__)

KEEP_FINISHED = 6  # finished comparisons kept for the app to collect
GONE = "This comparison is no longer on the server (it restarted); start it again"

_jobs: dict[str, dict] = {}


@router.post("/compare/drivers/jobs", status_code=202)
def start_comparison(body: CompareIn, db: Session = Depends(get_db)):
    """Start the same comparison as POST /compare/drivers in the background; follow it with GET
    /compare/drivers/jobs/{id}. The sessions are checked now, so a comparison that can't run fails at once."""
    sources, _ = compare_sources(db, body.a, body.b)
    job = {"id": uuid.uuid4().hex, "status": "queued", "total": len(sources), "done": 0, "current": None,
           "error": None, "result": None, "finished": None}
    _jobs[job["id"]] = job
    threading.Thread(target=_work, args=(job, body), name=f"comparison-{job['id'][:8]}", daemon=True).start()
    return job


@router.get("/compare/drivers/jobs/{job_id}")
def get_comparison(job_id: str):
    """Progress (runs read of the total, the one being read) and, once done, the comparison itself."""
    job = _jobs.get(job_id)
    if job is None:
        raise HTTPException(404, GONE)
    return job


def _work(job: dict, body: CompareIn) -> None:
    try:
        _run(job, body)
    finally:
        release_memory()
        _trim()


def _run(job: dict, body: CompareIn) -> None:
    def progress(done: int, current: str) -> None:
        job.update(done=done, current=current)

    job["status"] = "running"
    try:
        with SessionLocal() as db:
            sources, track = compare_sources(db, body.a, body.b)
            job["total"] = len(sources)
            result = compare_groups(sources, {"a": body.a.label.strip(), "b": body.b.label.strip()},
                                    official_corners(track), progress)
            result["track"] = track.name if track else None
        if result.get("error"):
            job.update(status="failed", error=result["error"])
        else:
            job.update(status="done", result=result, done=job["total"])
    except HTTPException as e:
        job.update(status="failed", error=str(e.detail))
    except Exception as e:
        log.exception("Comparison %s failed", job["id"])
        job.update(status="failed", error=f"The comparison stopped: {e}")
    job.update(current=None, finished=time.time())


def _trim() -> None:
    """Keep the latest finished comparisons only: each result is about 0.1 MB."""
    finished = sorted((j for j in list(_jobs.values()) if j["finished"] is not None), key=lambda j: j["finished"])
    for j in finished[:-KEEP_FINISHED]:
        _jobs.pop(j["id"], None)


def _log_date(text: str | None) -> date | None:
    for fmt in ("%d/%m/%Y", "%Y-%m-%d", "%d.%m.%Y", "%d/%m/%y"):  # MoTeC writes 05/05/2025
        try:
            return datetime.strptime((text or "").strip(), fmt).date()
        except ValueError:
            pass
    return None




@router.get("/compare/options")
def compare_options(db: Session = Depends(get_db)):
    """Sessions with clean laps, grouped by track and car (what can be compared), with the drivers in each group.
    Read from the database only: no log is opened."""
    rows = db.scalars(select(models.RunSession)
                      .options(selectinload(models.RunSession.laps), selectinload(models.RunSession.files),
                               selectinload(models.RunSession.event), selectinload(models.RunSession.driver),
                               selectinload(models.RunSession.car))
                      .order_by(models.RunSession.created_at, models.RunSession.id)).all()
    groups: dict[tuple, dict] = {}
    for s in rows:
        f = main_file(s)
        clean = [l.time_s for l in s.laps if f is not None and l.file_id == f.id and l.clean]
        if not clean:
            continue
        track = session_track(db, s)
        g = groups.setdefault((track.id if track else None, s.car_id), {
            "track_id": track.id if track else None, "track": track.name if track else None,
            "car_id": s.car_id, "car": s.car.name if s.car else None, "sessions": [], "drivers": {}})
        g["sessions"].append({
            "id": s.id, "name": s.name or f"Session {s.id}", "kind": s.kind.value,
            "event_id": s.event_id, "event": s.event.name if s.event else None,
            "date": (day.isoformat() if (day := _log_date(f.meta.get("date")) or (s.event.date if s.event else None))
                     else None),
            "driver_id": s.driver_id, "driver": s.driver.name if s.driver else None,
            "clean_laps": len(clean), "best": min(clean)})
        if s.driver is not None:
            d = g["drivers"].setdefault(s.driver_id, {"id": s.driver_id, "name": s.driver.name, "sessions": 0,
                                                      "laps": 0, "best": None})
            d["sessions"] += 1
            d["laps"] += len(clean)
            d["best"] = min(clean) if d["best"] is None else min(d["best"], min(clean))
    out = []
    for g in groups.values():
        g["drivers"] = sorted(g["drivers"].values(), key=lambda d: d["name"].lower())
        g["laps"] = sum(s["clean_laps"] for s in g["sessions"])
        out.append(g)
    out.sort(key=lambda g: -g["laps"])
    return out
