"""Import many logger files at once, e.g. a zip of a whole test: one session per log, in the background.

POST /imports takes the files and answers at once with an import job; one worker thread imports the logs one at a
time (a log can take a while to analyse, and one at a time keeps memory low), and GET /imports/{id} follows it.
Jobs that were queued or running when the server stopped are marked failed when it starts again.

By default the logs of each uploaded zip go into a new event named after the zip, and loose logs into no event; with
event_id every log goes into that event (picked or made in the app before the upload). Without one, a log recorded at
a planned event's venue on one of its days goes into that event (plans.planned_for). The events an import made are
remembered (ImportEvent), so the app can offer to name them or join them to the race weekend they belong to.
"""
import ctypes
import gc
import logging
import queue
import shutil
import tempfile
import threading
import zipfile
import zlib
from datetime import UTC, date, datetime
from pathlib import Path, PurePosixPath

from fastapi import APIRouter, Depends, Form, HTTPException, UploadFile
from sqlalchemy import inspect, select, update
from sqlalchemy.orm import Session

from app import empty_runs, heavy, models, plans, schemas, storage
from app.analysis.emptyrun import NoLaps
from app.db import SessionLocal, get_db
from app.importers import archive
from app.importers.motec import read_ldx_beacons
from app.routers import reports
from app.routers.sessions import add_log
from app.vehicle import tyre_store

router = APIRouter(prefix="/imports")
log = logging.getLogger(__name__)

INTERRUPTED = "The server restarted before the import finished; upload the files again."
DATE_FORMATS = ("%d/%m/%Y", "%Y-%m-%d", "%d.%m.%Y", "%d/%m/%y")  # MoTeC writes 05/05/2025

_jobs: queue.Queue = queue.Queue()
_worker: threading.Thread | None = None
_worker_lock = threading.Lock()


def _now() -> datetime:
    return datetime.now(UTC)


@router.post("", response_model=schemas.ImportJobOut, status_code=202)
def start_import(files: list[UploadFile], event_id: int | None = Form(None), db: Session = Depends(get_db)):
    """Upload several files in one go, in any mix: MoTeC .ld logs and their .ldx, CSV exports (.csv, .txt) and
    .zip files (logs in folders at any depth, a zip inside a zip). Each log becomes a session of its own, in the event
    event_id when it is given (otherwise a zip's logs make an event named after the zip)."""
    if event_id is not None and db.get(models.Event, event_id) is None:
        raise HTTPException(404, "Event not found")
    names = [PurePosixPath((f.filename or "").replace("\\", "/")).name or f"file{i}" for i, f in enumerate(files)]
    if not any(archive.suffix(n) in archive.ACCEPTED for n in names):
        raise HTTPException(415, "Nothing to import: upload MoTeC .ld logs (with their .ldx), CSV exports "
                                 "(.csv, .txt) or a .zip of them")
    folder = Path(tempfile.mkdtemp(prefix="theengineer-import-"))
    try:
        uploads, total = [], 0
        for i, (f, name) in enumerate(zip(files, names, strict=True)):
            dest = folder / f"upload-{i}{archive.suffix(name)}"
            with dest.open("wb") as out:
                while chunk := f.file.read(storage.CHUNK_BYTES):
                    total += len(chunk)
                    if total > archive.MAX_UPLOAD_BYTES:
                        raise HTTPException(413, f"The upload is more than {archive.MAX_UPLOAD_BYTES / 1024**3:g} "
                                                 "GB; send it in parts")
                    out.write(chunk)
            uploads.append((name, dest))
        job = models.ImportJob(filename=", ".join(names)[:255], status=models.ImportStatus.queued,
                               session_ids=[], errors=[], skipped=[])
        db.add(job)
        db.commit()
    except BaseException:
        shutil.rmtree(folder, ignore_errors=True)
        raise
    _jobs.put((job.id, folder, uploads, event_id))
    _start_worker()
    return job


@router.get("/{job_id}", response_model=schemas.ImportJobOut)
def get_import(job_id: int, db: Session = Depends(get_db)):
    job = db.get(models.ImportJob, job_id)
    if job is None:
        raise HTTPException(404, "Import not found")
    # with the runs kept whose laps couldn't be timed (a missing lap beacon), and why
    return {**schemas.ImportJobOut.model_validate(job).model_dump(), "untimed": empty_runs.untimed(db, job.session_ids)}


def fail_interrupted() -> None:
    """On startup: imports that were waiting or running died with the server that ran them."""
    with SessionLocal() as db:
        db.execute(update(models.ImportJob)
                   .where(models.ImportJob.status.in_([models.ImportStatus.queued, models.ImportStatus.running]))
                   .values(status=models.ImportStatus.failed, message=INTERRUPTED, current=None, finished_at=_now()))
        db.commit()


def _start_worker() -> None:
    global _worker
    with _worker_lock:
        if _worker is None or not _worker.is_alive():
            _worker = threading.Thread(target=_work, name="imports", daemon=True)
            _worker.start()


def _work() -> None:
    while True:
        job_id, folder, uploads, event_id = _jobs.get()
        try:
            run_import(job_id, folder, uploads, event_id)
        except Exception:
            log.exception("Import %s failed", job_id)
        finally:
            shutil.rmtree(folder, ignore_errors=True)
            _jobs.task_done()
            tyre_store.kick()  # summarise the new logs for the tyre model


def run_import(job_id: int, folder: Path, uploads: list[tuple[str, Path]], event_id: int | None = None) -> None:
    with SessionLocal() as db:
        job = db.get(models.ImportJob, job_id)
        if job is None:
            return
        job.status = models.ImportStatus.running
        db.commit()
        try:
            with archive.Upload(uploads, folder) as upload:
                found = upload.walk()
                ldx_for, unmatched = archive.pair_ldx(found.logs, found.ldx)
                job.total = len(found.logs)
                job.errors = found.errors
                job.skipped = [*found.skipped, *({"file": x.label, "reason": "no .ld log of the same name"}
                                                 for x in unmatched)]
                job.message = found.stopped
                db.commit()
                run = _Run(db, job, found.archives, folder, event_id)
                for i, item in enumerate(found.logs):
                    with heavy.lock:  # one log in memory at a time, across imports and requests
                        run.add(item, ldx_for.get(i))
                    job.done = i + 1
                    db.commit()
                run.finish_events()
            job.status = models.ImportStatus.done
        except Exception as e:
            log.exception("Import %s failed", job_id)
            db.rollback()
            job.status = models.ImportStatus.failed
            job.message = f"The import stopped: {e}"
        job.current = None
        job.finished_at = _now()
        db.commit()
        try:  # work out the reports of what was imported now, so they are ready when opened
            reports.schedule_sessions(db, list(job.session_ids or []))
        except Exception:
            log.exception("Couldn't start the reports of import %s", job_id)


class _Run:
    """Turns each log into a session; logs from one uploaded zip share an event named after the zip, unless the
    upload names the event every log goes into."""

    def __init__(self, db: Session, job: models.ImportJob, archives: list[str], folder: Path,
                 event_id: int | None = None):
        self.db, self.job, self.archives, self.folder = db, job, archives, folder
        self.target = event_id
        self.events: dict[int, models.Event] = {}
        self.names: set[str] = set()
        if event_id is not None:  # names stay unique within the event the logs go into
            self.names = set(db.scalars(select(models.RunSession.name)
                                        .where(models.RunSession.event_id == event_id)).all()) - {None}

    def add(self, item: archive.Item, ldx: archive.Item | None) -> None:
        db, job = self.db, self.job
        job.current = item.label[:255]
        db.commit()
        errors, copies = [], []
        try:
            beacons = None
            if ldx is not None:
                try:
                    copies.append(p := ldx.extract(self.folder))
                    beacons = read_ldx_beacons(p.read_bytes())
                except Exception as e:  # the log still imports, timed without the beacons
                    errors.append({"file": ldx.label, "error": f"Its beacons couldn't be read: {_plain(e)}"})
            path = item.extract(self.folder)
            if item.path is None:
                copies.append(path)
            s = models.RunSession(kind=models.SessionKind.test)
            db.add(s)
            db.flush()
            rec = add_log(db, s, path, item.name, beacons)
            # no event picked: a planned event at the log's venue on its day, if there is one
            target = db.get(models.Event, self.target) if self.target is not None else plans.planned_for(db, rec.meta)
            if target is not None and target.id != self.target:
                self.names |= set(db.scalars(select(models.RunSession.name)
                                             .where(models.RunSession.event_id == target.id)).all()) - {None}
            s.name = self._unique(item.folder or rec.meta.get("event_session") or item.stem)
            if target is not None:  # gone if it was deleted during the import: then as without one
                s.event = target
                db.flush()
                by_hand = db.scalar(select(models.EventDates.id).where(models.EventDates.event_id == target.id))
                self._settle(target, keep_track=True, keep_date=by_hand is not None)
            elif item.archive is not None:
                s.event = self._event(item.archive)
                db.flush()
                self._settle(s.event)  # now, not only at the end: the server may restart before the import ends
            db.commit()
            self.names.add(s.name)
            job.session_ids = [*job.session_ids, s.id]
        except Exception as e:
            db.rollback()
            self.events = {k: ev for k, ev in self.events.items() if inspect(ev).persistent}
            if isinstance(e, NoLaps):  # an empty run isn't kept: listed with the reason
                job.skipped = [*job.skipped, {"file": item.label, "reason": e.reason}]
            else:
                errors.append({"file": item.label, "error": _plain(e)})
        finally:
            for p in copies:
                p.unlink(missing_ok=True)
            _release_memory()
        if errors:
            job.errors = [*job.errors, *errors]

    def _unique(self, name: str) -> str:
        name = name.strip()[:110] or "Imported run"
        n, out = 1, name
        while out in self.names:
            n += 1
            out = f"{name} ({n})"
        return out

    def _event(self, index: int) -> models.Event:
        if index not in self.events:
            ev = models.Event(name=self.archives[index][:160] or "Imported runs")
            self.db.add(ev)
            self.db.flush()
            # remembered, so the app can offer to name it when the upload ends (routers/event_naming.py)
            self.db.add(models.ImportEvent(job_id=self.job.id, event_id=ev.id, archive=self.archives[index][:255]))
            self.events[index] = ev
        return self.events[index]

    def finish_events(self) -> None:
        for ev in self.events.values():
            self._settle(ev)
        self.db.commit()

    def _settle(self, ev: models.Event, keep_track: bool = False, keep_date: bool = False) -> None:
        """The event's date is its first log's, and its track the one all its logs were driven at. An event picked
        for the upload keeps the track it has, and the date when its dates were set by hand."""
        files = self.db.scalars(select(models.LoggerFile).join(models.RunSession)
                                .where(models.RunSession.event_id == ev.id)).all()
        venues = {f.meta.get("venue", "")[:120] for f in files}
        venue = venues.pop() if len(venues) == 1 else ""
        if not (keep_track and ev.track is not None):
            ev.track = self.db.scalar(select(models.Track).where(models.Track.name == venue)) if venue else None
        if not (keep_date and ev.date is not None):
            ev.date = min(filter(None, (_date(f.meta.get("date", "")) for f in files)), default=None)


def _release_memory() -> None:
    """Free one log's arrays before the next is read, and hand the freed memory back to the system (glibc keeps
    it for the thread otherwise, and the server has 512 MB on Render)."""
    gc.collect()
    try:
        ctypes.CDLL("libc.so.6").malloc_trim(0)
    except (OSError, AttributeError):  # not glibc
        pass


def _date(text: str) -> date | None:
    for fmt in DATE_FORMATS:
        try:
            return datetime.strptime(text.strip(), fmt).date()
        except ValueError:
            pass
    return None


def _plain(e: Exception) -> str:
    """What went wrong with one file, in words for the app."""
    if isinstance(e, HTTPException):
        return str(e.detail)
    if isinstance(e, storage.StorageError):
        return f"File storage failed: {e}"
    if isinstance(e, (NotImplementedError, RuntimeError, EOFError, zipfile.BadZipFile, zlib.error)):
        return archive.unpack_error(e)
    return str(e) or type(e).__name__
