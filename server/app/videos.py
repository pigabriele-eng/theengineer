"""Onboard videos on a run's clock (Gabriele, 2026-10-22: "I have also video onboards that I would like to
integrate"). A video is never copied: the desktop app keeps where it is on the computer and when its first frame
was on the log's clock (`start_s`: the log's time, in seconds from the start of the run's main log, at the video's
0 s). Every frame then has a lap and a distance into it, and two laps play side by side locked by distance.

How a video is put on the clock, the first that works:

- "vbox": a VBOX Video unit wrote the log and the video together, and every sample of its .vbo says which video file
  and how far into it the sample was recorded (avifileindex, avisynctime: importers/vbox.py). Exact.
- "gps": a GoPro (and other cameras writing GoPro's GPMF metadata) keeps its own GPS speed inside the .mp4. That
  speed is slid along the log's speed until the two match best (gps_speed, match_speed).
- "start-line": the driver steps to the frame where the car crosses the start/finish line on one lap and says which
  lap: that lap's start on the log's clock is that frame.

New table only (create_all adds it).
"""
from __future__ import annotations

import logging
import re
import struct
from datetime import UTC, datetime
from pathlib import Path

import numpy as np
from sqlalchemy import JSON, DateTime, Float, ForeignKey, Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base

log = logging.getLogger(__name__)

VIDEO_SUFFIXES = (".mp4", ".mov", ".m4v")
MATCH_HZ = 10.0  # the speeds are matched at this rate
MIN_OVERLAP_S = 60.0  # a match needs this much of the video over the log
GOOD_MATCH = 0.8  # correlation of the two speeds at the best offset that counts as a match


def _now() -> datetime:
    return datetime.now(UTC)


class VideoLink(Base):
    __tablename__ = "video_links"
    id: Mapped[int] = mapped_column(primary_key=True)
    session_id: Mapped[int] = mapped_column(ForeignKey("run_sessions.id", ondelete="CASCADE"), index=True)
    path: Mapped[str] = mapped_column(String(1024))  # where it is on the computer
    start_s: Mapped[float | None] = mapped_column(Float)  # the log's time at the video's first frame; None: not synced
    method: Mapped[str | None] = mapped_column(String(20))  # vbox, gps, start-line
    score: Mapped[float | None] = mapped_column(Float)  # how well the speeds matched (gps)
    duration_s: Mapped[float | None] = mapped_column(Float)
    camera: Mapped[str | None] = mapped_column(String(60))
    meta: Mapped[dict] = mapped_column(JSON, default=dict)
    size: Mapped[int | None] = mapped_column(Integer)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)


# ---------- MP4 boxes ----------

CONTAINERS = {b"moov", b"trak", b"mdia", b"minf", b"stbl", b"udta", b"edts", b"dinf"}


def _boxes(f, start: int, end: int):
    """(type, payload start, payload end) of each box between start and end."""
    pos = start
    while pos + 8 <= end:
        f.seek(pos)
        head = f.read(8)
        if len(head) < 8:
            return
        size, kind = struct.unpack(">I4s", head)
        hdr = 8
        if size == 1:
            size = struct.unpack(">Q", f.read(8))[0]
            hdr = 16
        elif size == 0:
            size = end - pos
        if size < hdr:
            return
        yield kind, pos + hdr, pos + size
        pos += size


def _find(f, start: int, end: int, kind: bytes):
    return next(((s, e) for k, s, e in _boxes(f, start, end) if k == kind), None)


def _read(f, s: int, e: int) -> bytes:
    f.seek(s)
    return f.read(e - s)


class Mp4:
    """What the desktop app needs from an .mp4: its length, its camera, and the samples of its GPMF track."""

    def __init__(self, path: str | Path):
        self.path = Path(path)
        self.duration_s: float | None = None
        self.camera: str | None = None
        self.created: datetime | None = None
        self.gpmf: list[tuple[float, float, bytes]] = []  # (start s, duration s, payload)
        with self.path.open("rb") as f:
            f.seek(0, 2)
            size = f.tell()
            moov = _find(f, 0, size, b"moov")
            if moov is None:
                raise ValueError("Not a video file this app can read (no moov box)")
            self._moov(f, *moov)

    def _moov(self, f, s: int, e: int) -> None:
        for kind, ps, pe in _boxes(f, s, e):
            if kind == b"mvhd":
                b = _read(f, ps, min(pe, ps + 32))
                if b[0] == 1:
                    created, _, scale, dur = struct.unpack(">QQIQ", b[4:32])
                else:
                    created, _, scale, dur = struct.unpack(">IIII", b[4:20])
                self.duration_s = dur / scale if scale else None
                if created:
                    self.created = datetime.fromtimestamp(created - 2082844800, UTC)  # seconds from 1904
            elif kind == b"udta":
                for k, us, ue in _boxes(f, ps, pe):
                    if k == b"FIRM":
                        self.camera = _read(f, us, ue).decode("latin-1").strip("\x00 ")[:60] or self.camera
            elif kind == b"trak":
                self._trak(f, ps, pe)

    def _trak(self, f, s: int, e: int) -> None:
        mdia = _find(f, s, e, b"mdia")
        if mdia is None:
            return
        mdhd = _find(f, *mdia, b"mdhd")
        minf = _find(f, *mdia, b"minf")
        stbl = _find(f, *minf, b"stbl") if minf else None
        if mdhd is None or stbl is None:
            return
        stsd = _find(f, *stbl, b"stsd")
        if stsd is None or _read(f, stsd[0] + 12, stsd[0] + 16) != b"gpmd":
            return
        b = _read(f, *mdhd)
        scale = struct.unpack(">I", b[20:24] if b[0] == 1 else b[12:16])[0] or 1
        tables = {k: _read(f, ps, pe) for k, ps, pe in _boxes(f, *stbl) if k in (b"stts", b"stsz", b"stco", b"co64",
                                                                                b"stsc")}
        sizes = _stsz(tables.get(b"stsz", b""))
        offsets = _offsets(tables, len(sizes))
        times = _stts(tables.get(b"stts", b""), len(sizes))
        for i, (size, off) in enumerate(zip(sizes, offsets, strict=False)):
            f.seek(off)
            start, dur = times[i]
            self.gpmf.append((start / scale, dur / scale, f.read(size)))


def _stsz(b: bytes) -> list[int]:
    if len(b) < 12:
        return []
    fixed, n = struct.unpack(">II", b[4:12])
    return [fixed] * n if fixed else list(struct.unpack(f">{n}I", b[12:12 + 4 * n]))


def _stts(b: bytes, n: int) -> list[tuple[int, int]]:
    out, t = [], 0
    if len(b) >= 8:
        (entries,) = struct.unpack(">I", b[4:8])
        for k in range(entries):
            count, delta = struct.unpack(">II", b[8 + 8 * k:16 + 8 * k])
            for _ in range(count):
                out.append((t, delta))
                t += delta
    while len(out) < n:
        out.append((t, 0))
    return out


def _offsets(tables: dict, n: int) -> list[int]:
    """Each sample's place in the file, from the chunk offsets and the samples per chunk."""
    if b"co64" in tables:
        b = tables[b"co64"]
        (count,) = struct.unpack(">I", b[4:8])
        chunks = list(struct.unpack(f">{count}Q", b[8:8 + 8 * count]))
    else:
        b = tables.get(b"stco", b"\x00" * 8)
        (count,) = struct.unpack(">I", b[4:8])
        chunks = list(struct.unpack(f">{count}I", b[8:8 + 4 * count]))
    sc = tables.get(b"stsc", b"")
    runs = []
    if len(sc) >= 8:
        (entries,) = struct.unpack(">I", sc[4:8])
        runs = [struct.unpack(">III", sc[8 + 12 * k:20 + 12 * k]) for k in range(entries)]
    per = []
    for ci in range(len(chunks)):
        spc = 1
        for first, samples, _ in runs:
            if ci + 1 >= first:
                spc = samples
        per.append(spc)
    sizes = _stsz(tables.get(b"stsz", b""))
    out, k = [], 0
    for ci, off in enumerate(chunks):
        for _ in range(per[ci]):
            if k >= n:
                return out
            out.append(off)
            off += sizes[k]
            k += 1
    return out


# ---------- GPMF ----------

_TYPES = {"b": "b", "B": "B", "s": "h", "S": "H", "l": "i", "L": "I", "f": "f", "d": "d", "j": "q", "J": "Q"}


def _klv(b: bytes):
    """(key, type, struct size, repeat, payload) of each GPMF entry."""
    pos = 0
    while pos + 8 <= len(b):
        key = b[pos:pos + 4].decode("latin-1")
        typ = chr(b[pos + 4])
        ssize, repeat = b[pos + 5], struct.unpack(">H", b[pos + 6:pos + 8])[0]
        n = ssize * repeat
        yield key, typ, ssize, repeat, b[pos + 8:pos + 8 + n]
        pos += 8 + ((n + 3) & ~3)


def _values(typ: str, ssize: int, repeat: int, data: bytes, struct_type: str | None) -> list[tuple]:
    if typ == "?" and struct_type:
        fmt = ">" + "".join(_TYPES.get(c, "x") for c in struct_type)
    elif typ in _TYPES:
        each = struct.calcsize(_TYPES[typ])
        fmt = ">" + _TYPES[typ] * max(1, ssize // each)
    else:
        return []
    size = struct.calcsize(fmt)
    if size != ssize:
        return []
    return [struct.unpack(fmt, data[k * size:(k + 1) * size]) for k in range(repeat)]


def _gps_rows(payload: bytes) -> list[float]:
    """The 2D speeds (m/s) of one GPMF payload's GPS stream, in order."""
    out: list[float] = []
    for key, _, _, _, devc in _klv(payload):
        if key != "DEVC":
            continue
        for k2, _, _, _, strm in _klv(devc):
            if k2 != "STRM":
                continue
            scal: list[float] = []
            stype = None
            for k3, typ, ssize, repeat, data in _klv(strm):
                if k3 == "SCAL":
                    scal = [float(v[0]) for v in _values(typ, ssize, repeat, data, None)] or \
                           [float(x) for v in _values(typ, ssize, 1, data, None) for x in v]
                elif k3 == "TYPE":
                    stype = data.decode("latin-1").strip("\x00")
                elif k3 in ("GPS5", "GPS9"):
                    rows = _values(typ, ssize, repeat, data, stype if typ == "?" else None)
                    for r in rows:
                        s = scal[3] if len(scal) > 3 else (scal[0] if scal else 1.0)
                        out.append(r[3] / s if s else 0.0)
    return out


def gps_speed(mp4: Mp4) -> tuple[np.ndarray, np.ndarray] | None:
    """The camera's own GPS speed (km/h) against the video's time (s), or None when it has none."""
    ts, vs = [], []
    for start, dur, payload in mp4.gpmf:
        rows = _gps_rows(payload)
        if not rows:
            continue
        step = dur / len(rows) if dur else 1 / 18
        ts.extend(start + step * k for k in range(len(rows)))
        vs.extend(v * 3.6 for v in rows)
    if len(ts) < 20:
        return None
    return np.asarray(ts), np.asarray(vs)


def match_speed(video_t: np.ndarray, video_v: np.ndarray, log_t: np.ndarray, log_v: np.ndarray
                ) -> tuple[float, float] | None:
    """The log's time at the video's 0 s that lines the two speeds up best, and how well they match (correlation,
    1 at best); None when they overlap too little. Both are taken at MATCH_HZ and normalised, and every offset is
    tried at once (cross-correlation)."""
    dt = 1 / MATCH_HZ
    vt = np.arange(video_t[0], video_t[-1], dt)
    lt = np.arange(log_t[0], log_t[-1], dt)
    if len(vt) < MIN_OVERLAP_S * MATCH_HZ or len(lt) < MIN_OVERLAP_S * MATCH_HZ:
        return None
    a = np.interp(vt, video_t, video_v)
    b = np.interp(lt, log_t, log_v)
    a = (a - a.mean()) / (a.std() or 1)
    b = (b - b.mean()) / (b.std() or 1)
    n = len(a) + len(b) - 1
    size = 1 << (n - 1).bit_length()
    corr = np.fft.irfft(np.fft.rfft(b, size) * np.conj(np.fft.rfft(a, size)), size)
    # corr[k] lines the video's sample 0 up with the log's sample k (k < 0 wrapped to the end)
    lags = np.r_[np.arange(0, len(b)), np.arange(-(len(a) - 1), 0)]
    corr = np.r_[corr[:len(b)], corr[size - (len(a) - 1):]]
    overlap = np.minimum(len(b) - lags, len(a)) - np.maximum(0, -lags)
    ok = overlap >= MIN_OVERLAP_S * MATCH_HZ
    if not ok.any():
        return None
    score = np.where(ok, corr / np.maximum(overlap, 1), -np.inf)
    k = int(np.argmax(score))
    start = lt[0] + lags[k] * dt - vt[0]
    # finer than one step: the peak's parabola
    if 0 < k < len(score) - 1 and np.isfinite(score[k - 1]) and np.isfinite(score[k + 1]):
        y0, y1, y2 = score[k - 1], score[k], score[k + 1]
        d = y0 - 2 * y1 + y2
        if d:
            start += 0.5 * (y0 - y2) / d * dt
    return float(start), float(score[k])


# ---------- VBOX Video ----------

_INDEX = re.compile(r"(\d+)(?!.*\d)")


def vbox_start(sync_t: np.ndarray, index: np.ndarray, video_s: np.ndarray, file_number: int) -> float | None:
    """The log's time at the first frame of the VBOX Video file numbered file_number."""
    on = (np.round(index) == file_number) & np.isfinite(video_s)
    if np.count_nonzero(on) < 2:
        return None
    return float(np.median(sync_t[on] - video_s[on]))


def video_number(name: str) -> int | None:
    """The file number in a VBOX Video file's name ("VBOX0001_0003.mp4" is 3)."""
    m = _INDEX.search(Path(name).stem)
    return int(m.group(1)) if m else None
