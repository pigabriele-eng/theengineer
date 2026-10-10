"""The grip use and traction control part of the report, for one session or a whole event."""
import threading
from collections import OrderedDict

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from app import heavy, models, page_cache, prebuild, run_labels
from app.analysis import grip
from app.analysis.grip import GripStudy
from app.analysis.laps import SessionData, load_session
from app.analysis.quickest import keep_quickest, lap_cap
from app.db import get_db
from app.importers.motec import LdFile
from app.routers.sessions import _channel_map, _get, _line, _track_for, official_corners, read_file

router = APIRouter(prefix="/report")

CACHE_SIZE = 8
FEW_LAPS = 8  # version 1 kept the reports of fewer clean laps than this with a part of their own (TC from one lap)
_cache: OrderedDict[tuple, tuple[tuple, bytes]] = OrderedDict()  # its JSON text, as sent
_cache_lock = threading.Lock()


def _fingerprint(sessions: list[models.RunSession], track: models.Track | None, names: dict[int, str]) -> tuple:
    """Changes whenever a log, a lap, a run's name or the track's corners change, so a cached report is never
    stale."""
    runs = tuple((s.id, names.get(s.id), tuple(sorted(f.id for f in s.files)),
                  tuple((l.number, l.time_s, l.clean) for l in s.laps)) for s in sessions)
    corners = tuple((c.code, c.apex_m, c.sector) for c in track.corners) if track else ()
    return runs, corners, repr(track.timing_line) if track else None


def _clean_best(s: models.RunSession) -> float | None:
    return min((l.time_s for l in s.laps if l.clean), default=None)


@router.get("/grip")
def grip_report(session: int | None = None, event: int | None = None, db: Session = Depends(get_db)):
    """Grip use and traction control for one session (?session=<id>) or every session of an event (?event=<id>):
    see grip_text."""
    return page_cache.RawJSON(grip_text(db, session, event, earlier="show"))


def grip_text(db: Session, session: int | None = None, event: int | None = None, earlier: str = "build") -> bytes:
    """Grip use and traction control for one session (?session=<id>) or every session of an event (?event=<id>).

    The car's grip limit (98th percentile of combined g in each direction and speed band), the g-g diagram with
    it, grip use per lap, per corner and per phase, lap time against grip use, where the quick laps use more grip
    than the slow ones, and traction control: where it cuts in on the exits, what it costs, and how it follows
    the rear tyre temperature. The logs are read one at a time, so an event needs no more memory than one log, and
    a long event works from its quickest laps only (analysis/quickest.py): quickest_laps then says how many of how
    many clean laps.

    earlier: what to do with an answer kept by the page's version before this one (the TC level on the dash and the
    EVO's TC override, 2026-10-09, changed every report): "show" sends it, marked updating, while the prebuild works
    out the new one, which the page asks for again; "keep" leaves it (the prebuild's start-up pass: a restart reads
    only the logs of the reports opened, not every log); "build" works the new one out now.
    """
    if (session is None) == (event is None):
        raise HTTPException(422, "Give either ?session=<id> or ?event=<id>")
    if session is not None:
        sessions = [_get(db, session)]
        if not sessions[0].files:
            raise HTTPException(404, "No logger file uploaded for this session")
        track = sessions[0].event.track if sessions[0].event else None
        key = ("session", session)
    else:
        ev = db.get(models.Event, event)
        if ev is None:
            raise HTTPException(404, "Event not found")
        sessions = list(db.scalars(select(models.RunSession).where(models.RunSession.event_id == event)
                                   .order_by(models.RunSession.id)).all())
        track = ev.track
        key = ("event", event)
    # each run called as the report calls it (run_labels.py): its own name, never a number
    labels = run_labels.labels_for(db, sessions)
    names = {s.id: labels[s.id].name for s in sessions}
    fp = _fingerprint(sessions, track, names)
    with _cache_lock:
        hit = _cache.get(key)
        if hit is not None and hit[0] == fp:
            _cache.move_to_end(key)
            return hit[1]
    # kept in the database too (app/page_cache.py); else built under heavy.lock, one log-reading job at a time (each
    # holds a whole log in memory while it reads it): a request that waited on the lock may find it built meanwhile
    scope = f"{key[0]}:{key[1]}|grip"
    parts = lambda: [page_cache.sessions_part(db, sessions), page_cache.track_part(track),  # noqa: E731
                     *run_labels.renamed(labels[s.id] for s in sessions)]
    if earlier != "build" and not page_cache.fresh(db, scope, page_cache.signature("grip", *parts())):
        few = ["tc from one lap"] if sum(l.clean for s in sessions for l in s.laps) < FEW_LAPS else []
        old = page_cache.lookup(db, scope, page_cache.earlier_signature("grip", *parts(), *few), raw=True)
        if old is not None and old[0] == 200:
            if earlier == "keep":
                return old[1]
            if prebuild.enabled():
                prebuild.refresh([("grip now", key)])
                return page_cache.with_fields(old[1], updating=True)
    result = page_cache.cached(db, scope, lambda: page_cache.signature("grip", *parts()),
                               lambda: _build(db, sessions, track, names), raw=True)
    with _cache_lock:
        _cache[key] = (fp, result)
        _cache.move_to_end(key)
        while len(_cache) > CACHE_SIZE:
            _cache.popitem(last=False)
    return result


def _build(db: Session, sessions: list[models.RunSession], track: models.Track | None,
           labels: dict[int, str] | None = None) -> dict:
    """labels: each run's name, unique among them (else its stored name)."""
    def name_of(s: models.RunSession) -> str:
        return (labels or {}).get(s.id) or s.name or f"Session {s.id}"
    # the session with the quickest lap goes first: its quickest lap lays down the track line all laps are put on
    timed = sorted((s for s in sessions if s.files and _clean_best(s) is not None), key=_clean_best)
    skipped = [name_of(s) for s in sessions if s not in timed]
    study = GripStudy(official_corners(track))
    names: set[str] = set()
    unread: list[str] = []
    for s in timed:
        name = name_of(s)
        if name in names:  # only without labels: two runs of the same stored name
            name = f"{name} #{s.id}"
        names.add(name)
        try:
            ld, data, run_track = _read(db, s)
        except Exception:  # one unreadable log leaves that session out, not the whole event
            unread.append(name)
            heavy.release_memory()
            continue
        if study.corners is None and run_track is not None:
            study.corners = official_corners(run_track)
        study.read_log(data, ld)
        del ld  # the log's pages are let go before the math channels are made
        study.add_laps(name, data, s.driver.name if s.driver else None)
        del data
        _keep_quickest(study)
        heavy.release_memory()
    result = study.report()
    if (cap := lap_cap(len(study.laps), sum(r["clean_laps"] for r in study.runs))) is not None:
        result["quickest_laps"] = cap
    notes = result.setdefault("notes", [])
    if skipped:
        n = len(skipped)
        notes.append(f"{n} session{'s' if n > 1 else ''} without a clean lap left out: {', '.join(skipped)}.")
    if unread:
        notes.append(f"Could not read the log of {', '.join(unread)}; left out.")
    heavy.release_memory()
    return result


def _keep_quickest(study: GripStudy) -> None:
    """A long event keeps only its quickest laps (analysis/quickest.py), with their state."""
    kept = keep_quickest(study.laps)
    if kept is not study.laps:
        keys = {x.key for x in kept}
        study.laps = kept
        study.state = {k: v for k, v in study.state.items() if k in keys}


def _read(db: Session, s: models.RunSession) -> tuple[LdFile, SessionData, models.Track | None]:
    """The session's main log (the longest), its laps and only the channels the grip study reads, and the track it was
    driven on."""
    f = max(s.files, key=lambda f: f.meta.get("duration_s", 0))
    ld = read_file(f)
    track = _track_for(db, s, ld)
    data = load_session(ld, _channel_map(s), beacons=f.meta.get("beacons"), line=_line(track), roles=grip.ROLES)
    return ld, data, track
