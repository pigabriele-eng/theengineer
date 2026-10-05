"""Import many logger files at once, e.g. a zip of a whole test: one session per log, in the background.

POST /imports takes the files and answers at once with an import job; one worker thread imports the logs one at a
time (a log can take a while to analyse, and one at a time keeps memory low), and GET /imports/{id} follows it.
Jobs that were queued or running when the server stopped are marked failed when it starts again.
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

from fastapi import APIRouter, Depends, HTTPException, UploadFile
from sqlalchemy import inspect, select, update
from sqlalchemy.orm import Session

from app import heavy, models, schemas, storage
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
def start_import(files: list[UploadFile], db: Session = Depends(get_db)):
    """Upload several files in one go, in any mix: MoTeC .ld logs and their .ldx, CSV exports (.csv, .txt) and
    .zip files (logs in folders at any depth, a zip inside a zip). Each log becomes a session of its own."""
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
    _jobs.put((job.id, folder, uploads))
    _start_worker()
    return job


@router.get("/{job_id}", response_model=schemas.ImportJobOut)
def get_import(job_id: int, db: Session = Depends(get_db)):
    job = db.get(models.ImportJob, job_id)
    if job is None:
        raise HTTPException(404, "Import not found")
    return job


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
        job_id, folder, uploads = _jobs.get()
        try:
            run_import(job_id, folder, uploads)
        except Exception:
            log.exception("Import %s failed", job_id)
        finally:
            shutil.rmtree(folder, ignore_errors=True)
            _jobs.task_done()
            tyre_store.kick()  # summarise the new logs for the tyre model


def run_import(job_id: int, folder: Path, uploads: list[tuple[str, Path]]) -> None:
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
                run = _Run(db, job, found.archives, folder)
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
    """Turns each log into a session; logs from one uploaded zip share an event named after the zip."""

    def __init__(self, db: Session, job: models.ImportJob, archives: list[str], folder: Path):
        self.db, self.job, self.archives, self.folder = db, job, archives, folder
        self.events: dict[int, models.Event] = {}
        self.names: set[str] = set()

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
            s.name = self._unique(item.folder or rec.meta.get("event_session") or item.stem)
            if item.archive is not None:
                s.event = self._event(item.archive)
                db.flush()
                self._settle(s.event)  # now, not only at the end: the server may restart before the import ends
            db.commit()
            self.names.add(s.name)
            job.session_ids = [*job.session_ids, s.id]
        except Exception as e:
            db.rollback()
            self.events = {k: ev for k, ev in self.events.items() if inspect(ev).persistent}
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
            self.events[index] = models.Event(name=self.archives[index][:160] or "Imported runs")
            self.db.add(self.events[index])
        return self.events[index]

    def finish_events(self) -> None:
        for ev in self.events.values():
            self._settle(ev)
        self.db.commit()

    def _settle(self, ev: models.Event) -> None:
        """The event's date is its first log's, and its track the one all its logs were driven at."""
        files = self.db.scalars(select(models.LoggerFile).join(models.RunSession)
                                .where(models.RunSession.event_id == ev.id)).all()
        venues = {f.meta.get("venue", "")[:120] for f in files}
        venue = venues.pop() if len(venues) == 1 else ""
        ev.track = self.db.scalar(select(models.Track).where(models.Track.name == venue)) if venue else None
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
