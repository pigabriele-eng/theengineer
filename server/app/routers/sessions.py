"""Run sessions: logger uploads, lap lists, analysis and voice debriefs for one run."""
import shutil
import tempfile
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, UploadFile
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app import garage, heavy, models, page_cache, schemas, storage
from app.analysis.emptyrun import NoLaps, judge
from app.analysis.laps import CornerSpec, LapTiming, SessionData, analyze, compare_laps, load_session, time_laps
from app.db import get_db
from app.heavy import one_at_a_time
from app.importers.csvlog import CsvLog, read_csv_log
from app.importers.motec import LdFile, LdFormatError, read_ld, read_ldx_beacons
from app.importers.window import beacons_in
from app.known_tracks import fill_corners
from app.timing import read_file, store_laps, track_line

_line = track_line  # the track's start/finish line for lap timing (other routers import it by this name)

router = APIRouter(prefix="/sessions")

# .csv and .txt are logger exports (MoTeC i2, AiM Race Studio, Pi Toolbox); the logger is read from the file
SUPPORTED = {".ld": "motec", ".ldx": "motec", ".csv": "csv", ".txt": "csv"}
LOG_FILES = (".ld", ".csv", ".txt")  # logs themselves; a .ldx only adds beacons to its .ld


def _get(db: Session, session_id: int) -> models.RunSession:
    s = db.get(models.RunSession, session_id)
    if s is None:
        raise HTTPException(404, "Session not found")
    return s


SESSION_COLUMNS = ("id", "created_at", *schemas.SessionIn.model_fields)  # SessionOut's own


def _with_best(s: models.RunSession) -> dict:
    clean = [l.time_s for l in s.laps if l.clean]
    out = schemas.SessionDetail.model_validate(s).model_dump()
    out["best_lap_s"] = min(clean) if clean else None
    out["event_name"] = s.event.name if s.event else None
    out["track_name"] = track_name(s)
    return out


def track_name(s: models.RunSession) -> str | None:
    """Where the session was driven: its event's track, else the venue in its logs' headers."""
    if s.event and s.event.track:
        return s.event.track.name
    return next((f.meta["venue"] for f in s.files if f.meta.get("venue")), None)


@router.post("", response_model=schemas.SessionOut, status_code=201)
def create_session(body: schemas.SessionIn, db: Session = Depends(get_db)):
    s = models.RunSession(**body.model_dump())
    db.add(s)
    db.commit()
    return s


@router.get("", response_model=list[schemas.SessionOut])
def list_sessions(db: Session = Depends(get_db)):
    """Every session, newest first, as _with_best has it less its files and laps: read column by column, the best
    lap by the database, and the files' headers only for the sessions whose event has no track."""
    S, E, T = models.RunSession, models.Event, models.Track
    rows = db.execute(select(*(getattr(S, c) for c in SESSION_COLUMNS), E.name, T.name)
                      .outerjoin(E, S.event_id == E.id).outerjoin(T, E.track_id == T.id)
                      .order_by(S.created_at.desc())).all()
    best = dict(db.execute(select(models.Lap.session_id, func.min(models.Lap.time_s))
                           .where(models.Lap.clean.is_(True)).group_by(models.Lap.session_id)).all())
    no_track = [r.id for r in rows if r[-1] is None]
    venues: dict[int, str] = {}
    for i in range(0, len(no_track), 500):
        for sid, meta in db.execute(select(models.LoggerFile.session_id, models.LoggerFile.meta)
                                    .where(models.LoggerFile.session_id.in_(no_track[i:i + 500]))
                                    .order_by(models.LoggerFile.id)):
            if sid not in venues and meta.get("venue"):
                venues[sid] = meta["venue"]
    return [{**{c: r[j] for j, c in enumerate(SESSION_COLUMNS)}, "best_lap_s": best.get(r.id), "event_name": r[-2],
             "track_name": r[-1] if r[-1] is not None else venues.get(r.id)} for r in rows]


@router.get("/{session_id}", response_model=schemas.SessionDetail)
def get_session(session_id: int, db: Session = Depends(get_db)):
    return _with_best(_get(db, session_id))


@router.post("/{session_id}/files", response_model=schemas.SessionDetail, status_code=201)
@one_at_a_time
def upload_file(session_id: int, file: UploadFile, db: Session = Depends(get_db)):
    """Upload a MoTeC .ld log, the .ldx i2 saved next to it (its beacons give exact lap times), or a CSV export
    from MoTeC i2, AiM Race Studio or Pi Toolbox."""
    s = _get(db, session_id)
    name = file.filename or ""
    ext = Path(name).suffix.lower()
    if ext not in SUPPORTED:
        raise HTTPException(415, f"Unsupported file type '{ext}'. Supported now: MoTeC .ld and .ldx, "
                                 "and CSV exports from MoTeC i2, AiM Race Studio and Pi Toolbox (.csv, .txt)")
    # a plain def (run in a worker thread), so parsing a big log doesn't stall other requests
    if ext == ".ldx":
        return _attach_ldx(db, s, name, file.file.read())
    with tempfile.TemporaryDirectory(prefix="theengineer-upload-") as tmp:
        path = Path(tmp) / f"log{ext}"
        with path.open("wb") as out:
            shutil.copyfileobj(file.file, out, storage.CHUNK_BYTES)
        try:
            rec = add_log(db, s, path, name)
        except NoLaps as e:  # the session stays as it was; nothing is stored
            raise HTTPException(422, f"{name} wasn't added ({e.reason}).") from e
        _attach_track(db, s, rec)
    db.commit()
    if s.event_id is not None:
        from app import season_match  # here: it uses the seasons, which use this module's importers

        season_match.safely("a log was added", season_match.after_import, db, [s.id])
    _prebuild(db, s)
    db.refresh(s)
    return _with_best(s)


def _prebuild(db: Session, s: models.RunSession) -> None:
    """Work out the run's pages and its event's in the background now (app/prebuild.py), so they open at once."""
    from app import prebuild  # here: it uses the routers, which use this module

    prebuild.after_upload(db, [s.id])


def _attach_track(db: Session, s: models.RunSession, rec: models.LoggerFile) -> None:
    """Put the session at the track its log was driven at: a session with no event joins the event named in the
    log header (made if it's new), and an event with no track gets this one. A zip import does this for the event
    it makes."""
    venue = (rec.meta.get("venue") or "")[:120]
    track = db.scalar(select(models.Track).where(models.Track.name == venue)) if venue else None
    if track is None:
        return
    if s.event is None:
        from app.routers.imports import _date  # imports.py imports this module

        name = ((rec.meta.get("event") or "").strip() or venue)[:160]
        day = _date(rec.meta.get("date") or "")
        same = select(models.Event).where(models.Event.name == name, models.Event.track_id == track.id,
                                          models.Event.date == day)
        s.event = db.scalars(same.order_by(models.Event.id)).first() or models.Event(name=name, track=track, date=day)
    elif s.event.track is None:
        s.event.track = track


def add_log(db: Session, s: models.RunSession, path: Path, name: str,
            ldx_beacons: list[float] | None = None) -> models.LoggerFile:
    """Read a logger file on the local disk (a MoTeC .ld log or a CSV export), store it and time its laps for the
    session. The single-file upload and the import of many files both come through here. ldx_beacons are the
    line crossings from the log's .ldx, when there is one. Flushed, not committed; HTTPException 422 when the file
    can't be read, NoLaps (before anything is stored) when it gives no laps and the car did none: a log of a car that
    did laps it can't time (a missing lap beacon) is kept, marked "untimed" in its meta (analysis/emptyrun.py)."""
    ext = Path(name).suffix.lower()
    try:
        ld = read_ld(path) if ext == ".ld" else read_csv_log(path)
        garage.fill_from_log(db, s, ld.device_serial, ld.driver)  # the car its logger is in, a known driver
        beacons = ld.beacons if isinstance(ld, CsvLog) and len(ld.beacons) >= 2 else None
        if ldx_beacons and len(ldx_beacons) >= 2:
            beacons = ldx_beacons
        track = _track_for(db, s, ld)
        data = load_session(ld, _channel_map(s), beacons=beacons, line=track_line(track))
        verdict = None
        if not data.laps:
            verdict = judge(ld, data, ldx_beacons or getattr(ld, "beacons", None), track_line(track),
                            track.length_m if track else None)
            if not verdict.keep:
                raise NoLaps(verdict.reason)
    except (LdFormatError, ValueError) as e:
        raise HTTPException(422, str(e)) from e

    key = storage.save_file(path, ext)
    logger = SUPPORTED[ext]
    meta = {"event": ld.event_name, "event_session": ld.event_session, "venue": ld.venue,
            "device_serial": ld.device_serial, "date": ld.date, "time": ld.time,
            "duration_s": round(ld.duration, 1), "channels": len(ld.channels), "mapped_channels": data.sources}
    if isinstance(ld, CsvLog):
        logger = ld.logger
        meta.update({"format": "csv", "layout": ld.layout, "driver": ld.driver, "vehicle": ld.vehicle})
    if beacons:
        meta["beacons"] = beacons
    if verdict is not None:
        meta["untimed"] = verdict.note()
    rec = models.LoggerFile(session=s, logger=logger, filename=(name or key)[:255], path=key, meta=meta)
    db.add(rec)
    db.flush()
    store_laps(db, s, rec, LapTiming(data.laps, data.lap_source, data.timing_line), track)
    return rec


def _attach_ldx(db: Session, s: models.RunSession, name: str, raw: bytes) -> dict:
    try:
        beacons = read_ldx_beacons(raw)
    except LdFormatError as e:
        raise HTTPException(422, str(e)) from e
    stem = Path(name).stem.lower()
    logs = [f for f in s.files if f.filename.lower().endswith(".ld")]
    rec = next((f for f in logs if Path(f.filename).stem.lower() == stem), None) or (logs[-1] if logs else None)
    if rec is None:
        raise HTTPException(409, "Upload the .ld log first, then its .ldx")
    if w := rec.meta.get("window"):  # a run split from a longer log (run_split.py): the crossings in its part
        beacons = beacons_in(beacons, w[0], w[1])
    if len(beacons) >= 2:
        rec.meta = {**rec.meta, "beacons": beacons}
        ld = read_file(rec)
        track = _track_for(db, s, ld)
        store_laps(db, s, rec, time_laps(ld, beacons, track_line(track)), track)
        del ld
        db.commit()
        _prebuild(db, s)  # its laps were timed again
    db.commit()
    db.refresh(s)
    return _with_best(s)


def _track_for(db: Session, s: models.RunSession, ld: LdFile) -> models.Track | None:
    """The session's track, or the one named in the log header (created if it's new)."""
    if s.event and s.event.track:
        return s.event.track
    venue = ld.venue[:120]  # as long as Track.name can be
    if not venue:
        return None
    track = db.scalar(select(models.Track).where(models.Track.name == venue))
    if track is None:
        track = models.Track(name=venue)
        fill_corners(track)
        db.add(track)
        db.flush()
    return track


def official_corners(track: models.Track | None) -> list[CornerSpec] | None:
    """The track's official corner numbers, where their position on the lap is known."""
    if track is None:
        return None
    fill_corners(track)  # a track stored before we knew its corners gets them now, saved with the next commit
    known = [(c.code, c.apex_m, c.sector) for c in track.corners if c.apex_m is not None]
    return known or None


def _channel_map(s: models.RunSession) -> dict[str, tuple[str, ...]] | None:
    if s.car and s.car.channel_map:
        return {role: tuple(names) for role, names in s.car.channel_map.items()}
    return None


def load_main_file(db: Session, s: models.RunSession,
                   file_id: int | None = None) -> tuple[models.LoggerFile, SessionData, models.Track | None]:
    """The session's logger file to analyse (the one asked for, else the longest) and the track it is from."""
    files = [f for f in s.files if file_id is None or f.id == file_id]
    if not files:
        raise HTTPException(404, "No logger file uploaded for this session")
    f = max(files, key=lambda f: f.meta.get("duration_s", 0))
    ld = read_file(f)
    track = _track_for(db, s, ld)
    return f, load_session(ld, _channel_map(s), beacons=f.meta.get("beacons"), line=track_line(track)), track


@router.get("/{session_id}/analysis")
def session_analysis(session_id: int, file_id: int | None = None, reference_lap: int | None = None,
                     db: Session = Depends(get_db)):
    """Every clean lap against the reference lap, corner by corner. Corners carry the track's official numbers
    when it has them (numbering "official"); otherwise they are the slow points of the speed trace, numbered
    C1, C2... in lap order (numbering "detected"). The session page's view (its main log against its best lap) is
    kept once worked out (app/page_cache.py)."""
    s = _get(db, session_id)

    def work() -> dict:
        f, data, track = load_main_file(db, s, file_id)
        return {"file_id": f.id, **analyze(data, reference_lap, official_corners(track))}

    main = max(s.files, key=lambda f: f.meta.get("duration_s", 0)) if s.files else None
    if main is None or reference_lap is not None or file_id not in (None, main.id):
        with heavy.lock:
            return work()
    return page_cache.RawJSON(page_cache.cached(
        db, f"session:{s.id}|analysis", lambda: page_cache.session_signature(db, "analysis", s, main), work, raw=True))


@router.get("/{session_id}/compare")
def session_compare(session_id: int, lap: int, reference_lap: int | None = None, file_id: int | None = None,
                    step: float = 5.0, db: Session = Depends(get_db)):
    """Speed, throttle, brake and time delta of one lap against the reference lap, for charts, with the
    reference lap's corners numbered as in the analysis. Each view of a lap of one of its logs (against the lap
    picked, at the step asked) is kept once worked out (app/page_cache.py), so picking it again reads no log."""
    s = _get(db, session_id)
    step = max(1.0, min(step, 50.0))

    def work() -> dict:
        f, data, track = load_main_file(db, s, file_id)
        try:
            return {"file_id": f.id, **compare_laps(data, lap, reference_lap, step, official_corners(track))}
        except ValueError as e:
            raise HTTPException(404, str(e)) from e

    files = [f for f in s.files if file_id is None or f.id == file_id]
    f = max(files, key=lambda f: f.meta.get("duration_s", 0)) if files else None  # the one load_main_file reads
    numbers = {l.number for l in s.laps if f is not None and l.file_id == f.id}
    if f is None or lap not in numbers or (reference_lap is not None and reference_lap not in numbers):
        with heavy.lock:  # no such log or lap (or the fastest lap stands in for the reference): as before
            return work()
    # the session page's view (its main log, 5 m steps) keeps the scope it always had: the prebuild makes it
    view = "" if f.id == page_cache.main_file(s).id and step == 5.0 else f"|{f.id}|{step!r}"
    return page_cache.RawJSON(page_cache.cached(
        db, f"session:{s.id}|compare|{lap}|{reference_lap}{view}",
        lambda: page_cache.session_signature(db, "compare", s, f), work, raw=True))


def default_reference_lap(s: models.RunSession, f: models.LoggerFile) -> int | None:
    """The lap the analysis compares against by default, from the laps as stored: the log's fastest clean lap."""
    clean = [l for l in s.laps if l.file_id == f.id and l.clean]
    return min(clean, key=lambda l: l.time_s).number if clean else None


def default_compare(s: models.RunSession) -> tuple[int, int] | None:
    """The pair the session page opens its lap comparison on: the next-fastest clean lap of the main log against the
    fastest (components/LapCompare.tsx)."""
    f = page_cache.main_file(s)
    ref = default_reference_lap(s, f) if f is not None else None
    others = [l for l in s.laps if l.file_id == f.id and l.clean and l.number != ref] if ref is not None else []
    return (min(others, key=lambda l: l.time_s).number, ref) if others else None
