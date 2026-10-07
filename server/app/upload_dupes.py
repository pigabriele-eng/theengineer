"""A weekend uploaded again to add the runs or sessions that were missing: the logs already in the app are left out
before anything is read, timed or stored, and the new ones go into the event the others are in.

A log is already in the app when a stored log has the same bytes (its SHA-256, kept in log_prints for every log
imported from now on), or, for logs stored before that, the same MoTeC header: the same logger, the same date and
time to the second and the same length to a tenth of a second (a log split into one run per driver is matched by
the log it was split from). Logs read from a CSV export are matched by their bytes only. A log saved partway through
a session (a piece of a longer log) isn't caught here: run_dupes.py merges it after the import, as before.
"""
from __future__ import annotations

import hashlib
import os
from dataclasses import dataclass

from sqlalchemy import ForeignKey, Integer, String, select
from sqlalchemy.orm import Mapped, Session, mapped_column

from app import models
from app.db import Base
from app.importers import motec

HEAD_BYTES = 4 * 1024**2  # the start of a log kept while it is hashed: its header and channel list are in it
CHUNK_BYTES = 1024**2


def enabled() -> bool:
    """UPLOAD_DUPES=off imports every log (the tests do, except their own: they upload one sample log many times)."""
    return os.environ.get("UPLOAD_DUPES", "on").strip().lower() not in ("off", "0", "false", "no")


class LogPrint(Base):
    """The bytes of a stored log, as a SHA-256: the same file uploaded again is known without reading it."""
    __tablename__ = "log_prints"
    id: Mapped[int] = mapped_column(primary_key=True)
    file_id: Mapped[int] = mapped_column(ForeignKey("logger_files.id", ondelete="CASCADE"), unique=True, index=True)
    sha256: Mapped[str] = mapped_column(String(64), index=True)
    size: Mapped[int] = mapped_column(Integer)


@dataclass
class Print:
    sha256: str
    size: int
    key: tuple | None  # (logger serial, date, time, length in s to 0.1) from a MoTeC header; None: not one


def of(item) -> Print:
    """The print of a log in the upload (an archive.Item), read once from start to end without unpacking it."""
    h, size, head = hashlib.sha256(), 0, bytearray()
    with (item.path.open("rb") if item.path is not None else item._open()) as src:
        while chunk := src.read(CHUNK_BYTES):
            h.update(chunk)
            size += len(chunk)
            if len(head) < HEAD_BYTES:
                head += chunk[:HEAD_BYTES - len(head)]
    return Print(h.hexdigest(), size, header_key(bytes(head)) if item.ext == ".ld" else None)


def header_key(head: bytes) -> tuple | None:
    """Who logged it, when and for how long, from the start of a MoTeC .ld log: the length as the import works it out
    (the longest readable channel), without the samples. None when the header can't be read from what is there."""
    try:
        if len(head) < motec.HEADER.size:
            return None
        h = motec.HEADER.unpack_from(head, 0)
        if h[0] != motec.LD_MARKER:
            return None
        longest, seen, p = 0.0, set(), h[1]
        while p and p not in seen:
            if p + motec.CHANNEL.size > len(head):
                return None  # the channel list runs past the part kept: can't tell its length
            seen.add(p)
            (_prev, nxt, _data, count, _counter, dtype_a, dtype, freq, *_rest) = motec.CHANNEL.unpack_from(head, p)
            types = motec._FLOAT_TYPES if dtype_a == 0x07 else motec._INT_TYPES if dtype_a in (0, 3, 5) else {}
            if types.get(dtype) is not None and count > 0 and freq > 0:
                longest = max(longest, count / freq)
            p = nxt
        date, time = motec._text(h[12]), motec._text(h[13])
        if not date or not time:
            return None
        return (int(h[7]), date, time, round(longest, 1))
    except Exception:
        return None


def _stored_key(meta: dict) -> tuple | None:
    m = meta.get("unsplit") or meta  # a run split per driver: the log it came from
    if meta.get("format") == "csv" or not m.get("date") or not m.get("time") or m.get("duration_s") is None:
        return None
    try:
        return (int(meta.get("device_serial") or 0), m["date"], m["time"], round(float(m["duration_s"]), 1))
    except (TypeError, ValueError):
        return None


class Known:
    """The logs already in the app: by their bytes, and by their MoTeC header for logs stored before the bytes were
    kept. Each answer is a run the log is in (the first, for a log split into several runs)."""

    def __init__(self, db: Session):
        self.by_sha: dict[str, int] = {}
        self.by_key: dict[tuple, int] = {}
        rows = db.execute(select(LogPrint.sha256, models.LoggerFile.session_id)
                          .join(models.LoggerFile, models.LoggerFile.id == LogPrint.file_id)
                          .order_by(models.LoggerFile.id))
        for sha, sid in rows:
            self.by_sha.setdefault(sha, sid)
        for meta, sid in db.execute(select(models.LoggerFile.meta, models.LoggerFile.session_id)
                                    .where(models.LoggerFile.logger == "motec").order_by(models.LoggerFile.id)):
            if (k := _stored_key(meta or {})) is not None:
                self.by_key.setdefault(k, sid)

    def run_of(self, p: Print) -> int | None:
        return self.by_sha.get(p.sha256) or (self.by_key.get(p.key) if p.key is not None else None)

    def add(self, p: Print, session_id: int) -> None:
        """A log of this upload: the same file further on in it is left out too."""
        self.by_sha.setdefault(p.sha256, session_id)
        if p.key is not None:
            self.by_key.setdefault(p.key, session_id)


def remember(db: Session, file: models.LoggerFile, p: Print) -> None:
    db.add(LogPrint(file_id=file.id, sha256=p.sha256, size=p.size))

