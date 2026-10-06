"""The track's shape for the map: height along the lap, banked corners, crests and compressions.

A banked corner shows more lateral g than the same tyres give on a flat road, and a crest less; the shape says
where the track does that, so the grip there is read as the track's and not the driver's. It is worked out from
the quick laps' logs (analysis/track_shape.py) on the line the map is drawn from, and each feature is labelled
with the corner it falls in, exactly as the map numbers its sections.
"""
from __future__ import annotations

import threading
from collections import OrderedDict
from dataclasses import dataclass

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from app import heavy, models
from app.analysis.align import aligned_trace, track_line
from app.analysis.channels import math_channels
from app.analysis.insights import LIMIT_LAPS_WITHIN, MIN_LIMIT_LAPS
from app.analysis.laps import corner_sections, lap_length, lap_trace, load_session, make_sections
from app.analysis.track_shape import track_shape
from app.db import get_db
from app.routers.sessions import _channel_map, _get, _line, _track_for, official_corners, read_file
from app.routers.trackmap import _known_track, _main_file

router = APIRouter()

CACHE_SIZE = 16  # a shape is about 20 KB
EVENT_LAPS = 6  # an event's shape is learned from at least this many of its quick laps, when it has them,
EVENT_SESSIONS = 3  # reading at most this many logs (the quickest laps' sessions)
NO_SHAPE = "The logs can't tell the track's shape here"

_cache: OrderedDict[tuple, dict | str] = OrderedDict()
_cache_lock = threading.Lock()


@dataclass
class _Use:
    session: models.RunSession
    file: models.LoggerFile
    laps: list[int]  # the quick laps' numbers in this log


def _clean_laps(s: models.RunSession) -> list[tuple[float, int]]:
    """(time, number) of the clean laps in the session's main log, as stored."""
    f = _main_file(s)
    return [(l.time_s, l.number) for l in s.laps if f is not None and l.file_id == f.id and l.clean]


def _quick(laps: list[tuple[float, models.RunSession, int]]) -> list[tuple[float, models.RunSession, int]]:
    """The laps that show the track at speed, as the analysis picks the laps it learns the car's limits from:
    within LIMIT_LAPS_WITHIN of the quickest, and at least the MIN_LIMIT_LAPS quickest."""
    quick = sorted(laps, key=lambda x: x[0])
    cut = quick[0][0] * (1 + LIMIT_LAPS_WITHIN)
    return [x for i, x in enumerate(quick) if x[0] <= cut or i < MIN_LIMIT_LAPS]


def _plan(sessions: list[models.RunSession], max_sessions: int, enough: int) -> list[_Use]:
    """Which logs to read and which of their laps to use: the session with the quickest lap first (its fastest lap
    is the line the map is drawn on), then the sessions holding the most quick laps, until there are enough."""
    laps = [(t, s, n) for s in sessions for t, n in _clean_laps(s)]
    if not laps:
        return []
    quick = _quick(laps)
    ref = quick[0][1]
    per: dict[int, list[tuple[float, models.RunSession, int]]] = {}
    for x in quick:
        per.setdefault(x[1].id, []).append(x)
    others = sorted((sid for sid in per if sid != ref.id), key=lambda sid: (-len(per[sid]), per[sid][0][0]))
    order = [ref.id, *others]
    out, total = [], 0
    for sid in order[:max_sessions]:
        if out and total >= enough:
            break
        s = per[sid][0][1]
        out.append(_Use(s, _main_file(s), sorted(n for _, _, n in per[sid])))
        total += len(per[sid])
    return out


def _key(db: Session, kind: str, id_: int, uses: list[_Use]) -> tuple:
    """Everything the shape depends on: each log read, its laps as stored, the car's channels, and the track's
    corners and start/finish line (which the reference session's track gives)."""
    ref = uses[0]
    track = _known_track(db, ref.session, ref.file)
    corners = tuple(official_corners(track) or ())
    line = tuple(sorted((track.timing_line or {}).items())) if track else ()
    logs = tuple((u.session.id, u.file.id, u.file.path, tuple(u.file.meta.get("beacons") or ()),
                  tuple((l.number, l.start_s, l.time_s, l.clean) for l in u.session.laps if l.file_id == u.file.id),
                  tuple(sorted((r, tuple(v)) for r, v in (_channel_map(u.session) or {}).items())), tuple(u.laps))
                 for u in uses)
    return (kind, id_, logs, track.id if track else None, corners, line)


def corner_of(sections: list, start_m: float, end_m: float, length: int) -> str | None:
    """The section (named as the map names it) that holds the middle of a stretch of the lap. A stretch through the
    timing line starts after it ends."""
    mid = ((start_m + end_m + (length if start_m > end_m else 0)) / 2) % length
    for s in sections:
        if s.start <= mid < s.end:
            return s.code
    return sections[-1].code if sections else None


def banked_note(features: list[dict]) -> str | None:
    """One plain line naming the banked corners in lap order, or None when there are none."""
    bank: dict[str, float] = {}
    for f in features:
        if f["kind"] == "banked" and f.get("corner"):
            bank[f["corner"]] = max(bank.get(f["corner"], 0.0), abs(float(f["value"])))
    if not bank:
        return None
    codes, degrees = list(bank), [str(round(v)) for v in bank.values()]

    def listed(xs: list[str]) -> str:
        return xs[0] if len(xs) == 1 else f"{', '.join(xs[:-1])} and {xs[-1]}"

    if len(codes) == 1:
        return f"{codes[0]} is banked (about {degrees[0]} degrees): its grip isn't compared with flat corners."
    if len(set(degrees)) == 1:
        about = f"{'both' if len(codes) == 2 else 'all'} about {degrees[0]}"
    else:
        about = f"about {listed(degrees)}"
    return f"{listed(codes)} are banked ({about} degrees): their grip isn't compared with flat corners."


def _work_out(db: Session, uses: list[_Use]) -> dict | str:
    """Read each log in turn, keep only its quick laps on the reference line (its full-rate channels are freed
    before the next log is read), then work out the shape. A string when the logs can't tell it. The caller holds
    the log lock."""
    traces: list[dict] = []
    line = length = sections = labelled = numbering = None
    ref_lap = None
    used = 0  # logs that gave laps
    for u in uses:
        first = u is uses[0]
        ld = read_file(u.file)
        track = _track_for(db, u.session, ld) if first else _known_track(db, u.session, u.file)
        data = load_session(ld, _channel_map(u.session), beacons=u.file.meta.get("beacons"), line=_line(track))
        del ld
        math_channels(data)
        if first:
            clean = [l for l in data.laps if l.clean]
            if not clean:
                return NO_SHAPE
            ref = min(clean, key=lambda l: l.time)  # the map's reference lap
            ref_lap = ref.number
            length = round(lap_length(data, ref))
            line = track_line(data, ref, length)
            trace = lap_trace(data, ref, length)  # numbered exactly as the map numbers its sections
            corners = official_corners(track)
            sections, numbering = make_sections(trace, corners)
            labelled, _ = corner_sections(trace, corners)
            del trace
        mine = [aligned_trace(data, lap, line, length) for lap in data.laps if lap.number in u.laps and lap.clean]
        traces += mine
        used += bool(mine)
        del data, mine
        heavy.release_memory()
    if not traces or length is None:
        return NO_SHAPE
    laps = len(traces)
    shape = track_shape(traces)
    del traces
    if shape is None:
        return NO_SHAPE
    out = shape.to_dict()
    for f in out["features"]:
        f["corner"] = corner_of(sections, f["start_m"], f["end_m"], length)
    return {
        "session_id": uses[0].session.id,
        "reference_lap": ref_lap,
        "length_m": length,
        "numbering": numbering,
        "laps": laps,  # how many it was learned from
        "sessions": used,
        **out,
        # the map's corners (its sections), each with its slowest point
        "corners": [{"code": c.code, "apex_m": int(c.apex), "start_m": int(c.start), "end_m": int(c.end)}
                    for c in labelled],
        "banked_note": banked_note(out["features"]),
    }


def shape_for(db: Session, kind: str, id_: int, sessions: list[models.RunSession], max_sessions: int,
              enough: int) -> dict:
    uses = _plan(sessions, max_sessions, enough)
    if not uses:
        raise HTTPException(404, "No clean lap to learn the track's shape from")
    key = _key(db, kind, id_, uses)
    with _cache_lock:
        out = _cache.get(key)
        if out is not None:
            _cache.move_to_end(key)
    if out is None:
        # one log-reading job at a time; a request that waited its turn may find this one worked out meanwhile
        with heavy.lock:
            with _cache_lock:
                out = _cache.get(key)
            if out is None:
                out = _work_out(db, uses)
                with _cache_lock:
                    _cache[key] = out
                    while len(_cache) > CACHE_SIZE:
                        _cache.popitem(last=False)
    if isinstance(out, str):
        raise HTTPException(404, out)
    return out


@router.get("/sessions/{session_id}/shape")
def get_session_shape(session_id: int, db: Session = Depends(get_db)):
    """The track's shape from the session's quick laps, on the line its map is drawn from (its fastest clean lap):
    height along the lap (m above the lowest point), road bank (degrees, + toward the inside of the corner) and
    vertical load (g), one value every step_m metres from the start/finish line, and the banked corners, crests
    and compressions found, each labelled with the corner it falls in as the map numbers them."""
    s = _get(db, session_id)
    return shape_for(db, "session", s.id, [s], 1, 0)


@router.get("/events/{event_id}/shape")
def get_event_shape(event_id: int, db: Session = Depends(get_db)):
    """The same from the event's quick laps, on the line of its fastest lap (the event map's): the log holding that
    lap, then the logs holding the most other quick laps, until EVENT_LAPS laps or EVENT_SESSIONS logs."""
    if db.get(models.Event, event_id) is None:
        raise HTTPException(404, "Event not found")
    sessions = db.scalars(select(models.RunSession).where(models.RunSession.event_id == event_id)).all()
    return shape_for(db, "event", event_id, list(sessions), EVENT_SESSIONS, EVENT_LAPS)
