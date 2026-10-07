"""How long an upload takes to import, from how long the past ones took: the app shows the time left.

Each import keeps a few measurements as it goes, from clocks and the sizes the walk of the upload already knows (no
log is read for them): how long the server took to take the upload in (stage "receive"), to find the logs in it
("unpack", with how many MB of logs its zips held), to check them against the logs already in the app ("check",
upload_dupes.py), to read each new log ("log"), and to finish its events ("finish").
The latest of them give the rates (rates()): a log takes `log_s` plus `log_s_per_mb` for each MB of it, fitted on the
latest logs read. Before any log has been timed so, the time per log comes from the imports this server already did
(their jobs' start, end and number of logs); with none, FALLBACK's guesses stand in.

Before an import job exists the app works out the time from the upload's size and these rates (GET /imports/rates;
before() is the same sum). While the import runs, GET /imports/{id} carries the seconds left of the stage it is at and
of the whole import (eta()), from the sizes of the logs still to read; when this import's logs take longer or shorter
than the rates said, the rest are scaled by as much.
"""
from __future__ import annotations

import logging
import threading
import time
from dataclasses import asdict, dataclass, field, replace
from datetime import UTC, datetime

from sqlalchemy import BigInteger, DateTime, Float, Integer, String, delete, select
from sqlalchemy.orm import Mapped, mapped_column

from app import models, upload_dupes
from app.db import Base, SessionLocal

log = logging.getLogger(__name__)

MB = 1e6
KEEP = 200  # rows kept per stage; older ones are deleted
LOGS_FITTED = 100  # the latest logs the rate per log and per MB is fitted on
OTHERS = 20  # the latest uploads the other rates are the mean of
MIN_FIT = 6  # logs before the rate per log is fitted rather than taken from FALLBACK
PRIOR_S = 20.0  # how much this import's own logs must have taken before they count as much as the history


def _now() -> datetime:
    return datetime.now(UTC)


class ImportRate(Base):
    """One measurement of an import: a stage of it, how much it worked through and how long it took."""
    __tablename__ = "import_rates"
    id: Mapped[int] = mapped_column(primary_key=True)
    stage: Mapped[str] = mapped_column(String(16), index=True)  # receive, unpack, check, log, finish
    # receive: the upload; unpack: its zips; check: the logs checked; log: the log
    bytes: Mapped[int] = mapped_column(BigInteger, default=0)
    out_bytes: Mapped[int] = mapped_column(BigInteger, default=0)  # unpack: the logs' bytes inside the zips
    items: Mapped[int] = mapped_column(Integer, default=0)  # files sent, logs found
    seconds: Mapped[float] = mapped_column(Float)
    finished_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)


@dataclass(frozen=True)
class Rates:
    receive_s_per_mb: float  # taking the upload in once it has been sent, per MB sent
    unpack_s: float  # finding the logs in an upload
    zip_expansion: float  # MB of logs in each MB of zip
    check_s_per_mb: float  # checking the logs against those in the app, per MB of log (0: not checked)
    log_s: float  # reading a log: this much for each log ...
    log_s_per_mb: float  # ... and this much for each MB of it
    mean_log_mb: float  # a log's size, on average: how many logs an upload of a size holds
    finish_s: float  # after the last log: the events' track and dates, and their season
    measured: int = 0  # logs the rates were fitted on (0: FALLBACK's)

    def log_seconds(self, size: int) -> float:
        return self.log_s + self.log_s_per_mb * size / MB


# Guesses for the hosted server (a tenth of a CPU, about fifteen times slower than a laptop), until it has imported
# something.
FALLBACK = Rates(receive_s_per_mb=0.02, unpack_s=1.0, zip_expansion=9.0, check_s_per_mb=0.04, log_s=2.0,
                 log_s_per_mb=0.3, mean_log_mb=25.0, finish_s=2.0)

_cache: Rates | None = None
_lock = threading.Lock()


def record(stage: str, seconds: float, bytes: int = 0, out_bytes: int = 0, items: int = 0) -> None:
    """Keep one measurement (in a database session of its own); never fails the import it measures."""
    global _cache
    try:
        with SessionLocal() as db:
            db.add(ImportRate(stage=stage, bytes=int(bytes), out_bytes=int(out_bytes), items=int(items),
                              seconds=max(0.0, float(seconds))))
            db.flush()
            oldest = db.scalars(select(ImportRate.id).where(ImportRate.stage == stage)
                                .order_by(ImportRate.id.desc()).offset(KEEP - 1).limit(1)).first()
            if oldest is not None:
                db.execute(delete(ImportRate).where(ImportRate.stage == stage, ImportRate.id < oldest))
            db.commit()
    except Exception:
        log.exception("Couldn't keep the %s time of an import", stage)
    with _lock:
        _cache = None


def rates() -> Rates:
    """The rates from the latest measurements (kept in memory until the next one)."""
    global _cache
    with _lock:
        if _cache is not None:
            return _cache
    try:
        with SessionLocal() as db:
            rows = {stage: db.execute(select(ImportRate.bytes, ImportRate.out_bytes, ImportRate.seconds)
                                      .where(ImportRate.stage == stage).order_by(ImportRate.id.desc())
                                      .limit(LOGS_FITTED if stage == "log" else OTHERS)).all()
                    for stage in ("receive", "unpack", "check", "log", "finish")}
            jobs = [] if rows["log"] else _past_jobs(db)
    except Exception:
        log.exception("Couldn't read the import times")
        return FALLBACK
    out = fit(rows["receive"], rows["unpack"], rows["check"], rows["log"], rows["finish"], jobs)
    if not upload_dupes.enabled():
        out = replace(out, check_s_per_mb=0.0)
    with _lock:
        _cache = out
    return out


def _past_jobs(db) -> list[tuple[float, int]]:
    """(seconds, logs) of the latest imports done, from their jobs' start and end."""
    rows = db.execute(select(models.ImportJob.created_at, models.ImportJob.finished_at, models.ImportJob.total)
                      .where(models.ImportJob.status == models.ImportStatus.done, models.ImportJob.total > 0,
                             models.ImportJob.finished_at.is_not(None))
                      .order_by(models.ImportJob.id.desc()).limit(OTHERS)).all()
    return [((end - start).total_seconds(), n) for start, end, n in rows if end > start]


def fit(receive: list, unpack: list, check: list, logs: list, finish: list, jobs: list | None = None) -> Rates:
    """The rates from measurements, each (bytes, out_bytes, seconds), and with no log timed yet the imports done
    before, each (seconds, logs); FALLBACK's where there are none."""
    f = FALLBACK
    sent = sum(r[0] for r in receive)
    checked = sum(r[0] for r in check)
    zips = [r for r in unpack if r[0] > 0 and r[1] > 0]
    log_s, per_mb = _per_log(logs)
    if not logs and jobs:  # a log of the usual size took the imports' mean time per log: FALLBACK's split of it
        each = sum(s for s, _ in jobs) / sum(n for _, n in jobs)
        share = f.log_s / f.log_seconds(int(f.mean_log_mb * MB))
        log_s, per_mb = each * share, each * (1 - share) / f.mean_log_mb
    return Rates(
        receive_s_per_mb=sum(r[2] for r in receive) / (sent / MB) if sent > MB else f.receive_s_per_mb,
        unpack_s=_mean([r[2] for r in unpack], f.unpack_s),
        zip_expansion=sum(r[1] for r in zips) / sum(r[0] for r in zips) if zips else f.zip_expansion,
        check_s_per_mb=sum(r[2] for r in check) / (checked / MB) if checked > MB else f.check_s_per_mb,
        log_s=log_s,
        log_s_per_mb=per_mb,
        mean_log_mb=_mean([r[0] / MB for r in logs], f.mean_log_mb),
        finish_s=_mean([r[2] for r in finish], f.finish_s),
        measured=len(logs),
    )


def _mean(values: list[float], default: float) -> float:
    return sum(values) / len(values) if values else default


def _per_log(logs: list) -> tuple[float, float]:
    """(seconds per log, seconds per MB): a straight line through the logs' sizes and times when there are enough
    of them, of different sizes; with fewer, FALLBACK's time per log and the rest per MB."""
    if not logs:
        return FALLBACK.log_s, FALLBACK.log_s_per_mb
    mbs = [r[0] / MB for r in logs]
    secs = [r[2] for r in logs]
    n = len(logs)
    if n >= MIN_FIT:
        mx, my = sum(mbs) / n, sum(secs) / n
        sxx = sum((x - mx) ** 2 for x in mbs)
        if sxx > 0 and sxx / n > (0.3 * mx) ** 2:  # sizes spread enough to tell the two apart
            per_mb = sum((x - mx) * (y - my) for x, y in zip(mbs, secs, strict=True)) / sxx
            each = my - per_mb * mx
            if per_mb > 0:  # a line through zero when it would start below it
                return (each, per_mb) if each >= 0 else (0.0, sum(secs) / max(sum(mbs), 1e-6))
    each = min(FALLBACK.log_s, 0.5 * sum(secs) / n)  # never more than half of what a log took
    return each, max(0.0, sum(secs) - each * n) / max(sum(mbs), 1e-6)


def before(rates: Rates, upload_bytes: int, zip_bytes: int) -> float:
    """Seconds the server takes for an upload before its logs are known, once it has been taken in: finding the logs,
    checking them, reading them (as many as an upload of this size holds, all of them new) and finishing. The app
    does the same sum (lib/uploadEta.ts)."""
    log_mb = max(0, upload_bytes - zip_bytes) / MB + zip_bytes / MB * rates.zip_expansion
    logs = max(1.0, log_mb / max(rates.mean_log_mb, 0.1))
    return (rates.unpack_s + log_mb * rates.check_s_per_mb + logs * rates.log_s + log_mb * rates.log_s_per_mb
            + rates.finish_s)


# ---------- the imports running now ----------

@dataclass
class Progress:
    """How far one import has got, kept in memory while it runs (the worker thread is in this process)."""
    upload_bytes: int
    zip_bytes: int
    # waiting (for the import before it), unpacking, checking, logs, finishing (shown as logs)
    stage: str = "waiting"
    stage_at: float = field(default_factory=time.monotonic)
    sizes: list[int | None] = field(default_factory=list)  # the logs found, in order; None: left out, not read
    index: int = 0  # the log being checked or read now ...
    log_at: float = 0.0  # ... since then (0: none yet in this stage)
    checked: int = 0  # bytes of logs checked so far ...
    check_took: float = 0.0  # ... and the seconds that took
    read: list[int] = field(default_factory=list)  # the sizes of the logs read so far ...
    took: float = 0.0  # ... and the seconds they took

    def to(self, stage: str) -> None:
        self.stage, self.stage_at = stage, time.monotonic()
        self.index, self.log_at = 0, 0.0

    def pace(self, r: Rates) -> float:
        """How much slower (above 1) or faster this import has gone than the rates say, so far: the server may be
        busier now than it was. The rates count this import's logs already; PRIOR_S of history weighs against it."""
        expected = sum(r.log_seconds(s) for s in self.read) + r.check_s_per_mb * self.checked / MB
        return (self.took + self.check_took + PRIOR_S) / (expected + PRIOR_S)


_running: dict[int, Progress] = {}


def queued(job_id: int, upload_bytes: int, zip_bytes: int) -> None:
    _running[job_id] = Progress(upload_bytes, zip_bytes)


def progress(job_id: int) -> Progress | None:
    return _running.get(job_id)


def ended(job_id: int) -> None:
    _running.pop(job_id, None)


def checking(job_id: int, index: int) -> None:
    """The check of the upload's logs against those in the app (upload_dupes.py) has got to this one."""
    p = _running.get(job_id)
    if p is not None and p.stage == "checking":
        p.index, p.log_at = index, time.monotonic()
        p.checked, p.check_took = sum(s or 0 for s in p.sizes[:index]), p.log_at - p.stage_at


def checked(p: Progress | None, seconds: float) -> None:
    """Every log has been checked."""
    if p is not None:
        p.checked, p.check_took = sum(s or 0 for s in p.sizes), seconds


def log_started(p: Progress | None, index: int) -> None:
    if p is not None:
        p.index, p.log_at = index, time.monotonic()


def log_read(p: Progress | None, size: int, seconds: float) -> None:
    """A log was read: kept for the rates, and this import's pace for the logs still to read."""
    if p is not None:
        p.read.append(size)
        p.took += seconds
    record("log", seconds, bytes=size, items=1)


def eta(job_id: int, now: float | None = None) -> dict | None:
    """{"stage", "stage_s", "total_s"}: seconds left of the stage the import is at and of all of it; None when it
    isn't running here (or the estimate failed: the import's progress is answered all the same)."""
    p = _running.get(job_id)
    if p is None:
        return None
    try:
        return _eta(job_id, p, time.monotonic() if now is None else now)
    except Exception:
        log.exception("Couldn't estimate the time left of import %s", job_id)
        return None


def _eta(job_id: int, p: Progress, now: float) -> dict:
    r = rates()
    if p.stage == "waiting":  # behind the imports sent before it: their time left first
        ahead = sum((eta(i, now) or {}).get("total_s") or 0.0 for i in list(_running) if i < job_id)
        own = before(r, p.upload_bytes, p.zip_bytes)
        return _out("waiting", ahead, ahead + own)
    if p.stage == "unpacking":
        left = max(0.0, r.unpack_s - (now - p.stage_at))
        return _out("unpacking", left, left + before(r, p.upload_bytes, p.zip_bytes) - r.unpack_s)
    pace = p.pace(r)
    if p.stage == "checking":  # the logs from the one being checked on; then every log is read, as far as is known
        left = max(0.0, r.check_s_per_mb * sum(s or 0 for s in p.sizes[p.index:]) / MB * pace
                   - (now - (p.log_at or p.stage_at)))
        return _out("checking", left, left + _reading(r, p.sizes, pace) + r.finish_s)
    if p.stage == "finishing":  # every log read: the events are being finished
        left = max(0.0, r.finish_s - (now - p.stage_at))
        return _out("logs", left, left)
    now_reading = 0.0
    if p.log_at and p.index < len(p.sizes) and p.sizes[p.index] is not None:
        now_reading = max(0.0, r.log_seconds(p.sizes[p.index]) * pace - (now - p.log_at))
    left = now_reading + _reading(r, p.sizes[p.index + 1 if p.log_at else 0:], pace) + r.finish_s
    return _out("logs", left, left)


def _reading(r: Rates, sizes: list[int | None], pace: float) -> float:
    return sum(r.log_seconds(s) for s in sizes if s is not None) * pace


def _out(stage: str, stage_s: float, total_s: float) -> dict:
    return {"stage": stage, "stage_s": round(stage_s, 1), "total_s": round(max(total_s, stage_s), 1)}


def as_json(r: Rates) -> dict:
    return asdict(r)
