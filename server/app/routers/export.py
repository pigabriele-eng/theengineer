"""Everything uploaded, in one download (Gabriele, 2026-10-22: "create a link for me to download ALL data i uploaded
to The Engineer to date"), before the online version is switched off.

GET /export/everything.zip streams one zip: each log as it was uploaded (MoTeC .ld, CSV, Pi export, VBOX .vbo) under
Track/Event/Session/, the voice debriefs' recordings beside their session, the recordings not yet given a session in
Voice recordings/, and the-engineer.json with what was set in the app (event names, series, dates, run names,
drivers, tyres, temperatures, laps with their clean/not-clean marks, the .ldx line crossings, debrief transcripts and
points), which the desktop app can read back. ?event_id= (or ?event_id=0 for the runs in no event) makes the same zip
of one event, so a big archive can be fetched over several days when Backblaze's free daily download cap is reached.
A file that can't be read today is listed in MISSING.txt rather than stopping the download.

The logs are read from storage a piece at a time and never cached, so a download of gigabytes fits the free server's
memory and disk. The zip is written as it is sent (no size known in advance) with light compression.
"""
from __future__ import annotations

import io
import json
import logging
import re
import zipfile
from collections.abc import Iterator
from datetime import UTC, datetime
from pathlib import PurePosixPath

import httpx
from fastapi import APIRouter, Depends, Query
from fastapi.responses import StreamingResponse
from sqlalchemy import select
from sqlalchemy.orm import Session

from app import models, storage
from app.db import get_db

router = APIRouter(prefix="/export", tags=["export"])
# The download is opened by URL, where the app can't set headers: its sign-in may come as ?access_token=
media_router = APIRouter(prefix="/export", tags=["export"])
log = logging.getLogger(__name__)

ROOT = "The Engineer"
FLUSH_BYTES = 1024**2  # sent once this much of the zip is written
UNSAFE = re.compile(r'[<>:"/\\|?*\x00-\x1f]+')


def _part(name: str | None, fallback: str) -> str:
    """A folder or file name Windows takes."""
    out = UNSAFE.sub(" ", name or "").strip(" .")[:90].strip(" .")
    return out or fallback


def _track(e: models.Event | None, files: list[models.LoggerFile]) -> str:
    if e is not None and e.track is not None:
        return e.track.name
    venue = next(((f.meta or {}).get("venue") for f in files if (f.meta or {}).get("venue")), None)
    return venue or "Track not known"


class _Pipe(io.RawIOBase):
    """Where the zip is written as it is sent: it can tell how much was written but not seek back."""

    def __init__(self) -> None:
        self.buf = bytearray()
        self.pos = 0

    def writable(self) -> bool:
        return True

    def write(self, b) -> int:
        self.buf += b
        self.pos += len(b)
        return len(b)

    def tell(self) -> int:
        return self.pos

    def take(self) -> bytes:
        out = bytes(self.buf)
        self.buf.clear()
        return out


def _plan(db: Session, event_id: int | None) -> tuple[list[tuple[str, str]], dict]:
    """(path in the zip, storage key) for every stored file, and the manifest, read from the database now: the zip is
    sent after the request's database session is closed."""
    q = select(models.RunSession).order_by(models.RunSession.id)
    if event_id == 0:
        q = q.where(models.RunSession.event_id.is_(None))
    elif event_id is not None:
        q = q.where(models.RunSession.event_id == event_id)
    files: list[tuple[str, str]] = []
    taken: set[str] = set()
    stored: dict[str, str] = {}  # storage key -> its path in the zip (a log split into several runs is sent once)

    def place(path: str, key: str) -> str:
        if key in stored:
            return stored[key]
        p, n = PurePosixPath(path), 2
        while str(p).lower() in taken:
            p = PurePosixPath(path).with_stem(f"{PurePosixPath(path).stem} ({n})")
            n += 1
        taken.add(str(p).lower())
        stored[key] = str(p)
        files.append((str(p), key))
        return str(p)

    events: dict[int | None, dict] = {}
    for s in db.scalars(q):
        e = s.event
        if e is not None and e.id not in events:
            events[e.id] = {"id": e.id, "name": e.name, "series": e.series, "date": e.date and e.date.isoformat(),
                            "track": _track(e, list(s.files)), "sessions": []}
        elif e is None and None not in events:
            events[None] = {"id": None, "name": "Runs in no event", "series": None, "date": None,
                            "track": None, "sessions": []}
        ev = events[e.id if e is not None else None]
        folder = (f"{ROOT}/{_part(ev['track'], 'Track not known')}/{_part(ev['name'], f'Event {e.id}')}" if e
                  else f"{ROOT}/Runs in no event")
        name = s.name or f"{s.kind.value.title()} {s.id}"
        here = f"{folder}/{_part(name, f'Run {s.id}')} ({s.id})"
        out_files = []
        for f in s.files:
            meta = f.meta or {}
            out_files.append({
                "file": place(f"{here}/{_part(f.filename, f'log {f.id}')}", f.path), "filename": f.filename,
                "logger": f.logger, "uploaded_at": f.uploaded_at and f.uploaded_at.isoformat(),
                **{k: meta[k] for k in ("beacons", "window", "venue", "source_path") if k in meta}})
        debriefs = []
        for d in s.debriefs:
            audio = (place(f"{here}/Debrief {d.id}{PurePosixPath(d.audio_path).suffix}", d.audio_path)
                     if d.audio_path else None)
            debriefs.append({
                "id": d.id, "mode": d.mode.value, "language": d.language, "created_at": d.created_at.isoformat(),
                "recording": audio, "transcript": d.transcript, "summary": d.summary, "segments": d.segments,
                "speakers": d.speakers,
                "points": [{"section": p.section, "text": p.text, "corner": p.corner_code,
                            "phase": p.phase and p.phase.value, "speaker": p.speaker,
                            "audio_start_s": p.audio_start_s} for p in d.points]})
        ev["sessions"].append({
            "id": s.id, "name": s.name, "kind": s.kind.value, "driver": s.driver and s.driver.name,
            "car": s.car and s.car.name, "tyre_set": s.tyre_set, "track_temp_c": s.track_temp_c,
            "ambient_temp_c": s.ambient_temp_c, "created_at": s.created_at.isoformat(), "files": out_files,
            "laps": [{"number": lap.number, "time_s": lap.time_s, "start_s": lap.start_s, "clean": lap.clean}
                     for lap in s.laps],
            "debriefs": debriefs})
    recordings = []
    if event_id is None:
        for r in db.scalars(select(models.DebriefRecording).order_by(models.DebriefRecording.id)):
            stem = _part(PurePosixPath(r.filename or "").stem, f"Recording {r.id}")
            path = place(f"{ROOT}/Voice recordings/{stem}{PurePosixPath(r.audio_path).suffix}", r.audio_path)
            recordings.append({"id": r.id, "file": path, "filename": r.filename, "mode": r.mode.value,
                               "language": r.language, "recorded_at": r.recorded_at.isoformat()})
    manifest = {"made_at": datetime.now(UTC).isoformat(timespec="seconds"), "from": "The Engineer (online)",
                "events": list(events.values()), "voice_recordings": recordings}
    return files, manifest


README = """Everything uploaded to The Engineer online, as it was uploaded.

Each folder is a track, then an event, then a run with its log files (MoTeC .ld, CSV and Pi exports, VBOX .vbo) and
the recordings of its voice debriefs. The-engineer.json keeps what was set in the app: event names, run names,
drivers, tyres, laps marked not clean, debrief transcripts and points.

To use the logs in the desktop app, unzip this file and press Import folder on the unzipped folder.
"""


def _zip(files: list[tuple[str, str]], manifest: dict) -> Iterator[bytes]:
    pipe = _Pipe()
    missing: list[str] = []
    with zipfile.ZipFile(pipe, "w", zipfile.ZIP_DEFLATED, compresslevel=1, allowZip64=True) as z:
        z.writestr(f"{ROOT}/README.txt", README)
        z.writestr(f"{ROOT}/the-engineer.json", json.dumps(manifest, indent=1, ensure_ascii=False))
        yield pipe.take()
        for path, key in files:
            try:
                with storage.open_chunks(key) as chunks:
                    info = zipfile.ZipInfo(path, datetime.now().timetuple()[:6])
                    info.compress_type = zipfile.ZIP_DEFLATED
                    with z.open(info, "w", force_zip64=True) as w:
                        try:
                            for chunk in chunks:
                                w.write(chunk)
                                if len(pipe.buf) >= FLUSH_BYTES:
                                    yield pipe.take()
                        except (OSError, httpx.HTTPError) as e:  # cut off half way: what came is kept, and said
                            log.warning("Export: %s cut off: %s", key, e)
                            missing.append(f"{path} (only part of it: {e})")
            except (OSError, httpx.HTTPError) as e:  # FileNotFoundError and StorageError included
                log.warning("Export: %s not read: %s", key, e)
                missing.append(f"{path} ({e})")
            yield pipe.take()
        if missing:
            z.writestr(f"{ROOT}/MISSING.txt", (
                "These files couldn't be read today. Backblaze's free daily download limit is the likely reason: it "
                "starts again at midnight UTC (2 am in summer, 1 am in winter, Italian time). Download again then, "
                "or download only their event from Settings.\n\n" + "\n".join(missing) + "\n"))
    yield pipe.take()


@media_router.get("/everything.zip")
def everything(event_id: int | None = Query(None, description="one event only; 0 = the runs in no event"),
               db: Session = Depends(get_db)):
    files, manifest = _plan(db, event_id)
    day = datetime.now(UTC).date().isoformat()
    if event_id is None:
        name = f"The Engineer - everything - {day}.zip"
    else:
        ev = manifest["events"][0] if manifest["events"] else {"name": "nothing"}
        name = f"The Engineer - {_part(ev['name'], 'event')} - {day}.zip"
    return StreamingResponse(_zip(files, manifest), media_type="application/zip",
                             headers={"Content-Disposition": f'attachment; filename="{name}"'})


@router.get("/events")
def events(db: Session = Depends(get_db)) -> dict:
    """What a download holds, event by event: its runs and files and their stored size (logs are kept compressed, so
    the zip is about this size)."""
    files, manifest = _plan(db, None)
    sizes = storage.sizes([key for _, key in files])
    by_path = {path: sizes.get(key) for path, key in files}
    out = []
    for ev in manifest["events"]:
        paths = [f["file"] for s in ev["sessions"] for f in s["files"]]
        paths += [d["recording"] for s in ev["sessions"] for d in s["debriefs"] if d["recording"]]
        mb = sum(by_path.get(p) or 0 for p in set(paths)) / 1024**2
        out.append({"id": ev["id"] if ev["id"] is not None else 0, "name": ev["name"], "track": ev["track"],
                    "date": ev["date"], "runs": len(ev["sessions"]), "files": len(set(paths)), "mb": round(mb, 1)})
    total = sum(v or 0 for v in sizes.values()) / 1024**2
    return {"events": out, "files": len(files), "mb": round(total, 1)}
