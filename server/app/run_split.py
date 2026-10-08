"""A run in which the driver changed, split into one run per driver (Gabriele, 2026-10-07: "When in a single run the
driver changes multiple times, split the runs automatically").

Where: the driving style (analysis/driver_style.py) cuts a run into stints; two stints next to each other in different
style groups had a driver change between them. The cut goes in the middle of the longest stop (slower than STOP_KMH)
between the end of the earlier stint's last lap and the start of the later stint's first lap, read from the log's
speed channel, on a whole second. Only a stop of MIN_STOP_S or more is a driver change: two styles without one are a
driver on other tyres, not two drivers (the stops found are kept in memory, so such a run's log isn't read again on
every pass). In a race, a stop longer than a pit stop (RED_FLAG_S standing in all) is a red flag, not a driver change.
Each part keeps driver_style.MIN_STINT_LAPS clean laps or more, a run becomes MAX_PARTS runs at most, and only a run
whose laps are all on its main log is split.

How: each part is a run of its own (RunSession) with a LoggerFile row that points at the same stored log, meta
"window" [from_s, to_s] in seconds of the stored log; timing.read_file hands every reader its part, from 0 at the
part's start (importers/window.py). Nothing is copied or deleted, and the deletes keep a stored log while a row still
names it (event_delete.py, empty_runs.py). The run itself is part 1: it keeps its id, its debriefs and everything
entered on it, and its meta before the split is kept under "unsplit" (with the parts' ids), so a split can be undone.
Each part's meta is the run's with its window, its own length, the header's date and time moved on to the part's start
(the timetable naming places a run in the day by them), the beacons in it on its own clock, and split_from (the run's
id). Its laps are timed from its window just as a later re-timing (timing.py) times them, numbered from 1: the lap
with the stop never crosses the line in either part, so it drops out. Lap tags follow their laps.

Who: a driver a person set on the run goes to the parts of the style group that driver's laps are in, and a part of
another style gets none (the style names it on the next pass); when that can't be told, the run keeps its driver and
the new parts get none. A driver the style set, or none: every part starts without one, for the style to name. Names:
a name typed by hand never changes, and the parts are "<name> (2)", typed too; a name the upload or the timetable gave
goes to the parts as "<name> (2)" (or "<the log's name> (2)"), and the timetable naming then names every stint ("Race
1 stint 2"). Car, event, kind, temperatures, tyre set and setup sheet go to every part.

After a split, what was kept for the run without being signed with its laps goes (its tyre-data summary, setup
summary and kept pages); the event's runs are named from the timetable again and its report and pages are started
again, so the parts get their lap traces. The fingerprints made from those find one stint in each part, so a part is
not split again. driver_prints calls split_event for every event on each background pass: runs already in the app are
split on the first pass.
"""
from __future__ import annotations

import logging
import math
import re
import threading
from collections import OrderedDict
from itertools import pairwise
from types import SimpleNamespace

import numpy as np
from sqlalchemy import select
from sqlalchemy.orm import Session

from app import heavy, laptags, models, page_cache, storage, timing
from app.analysis import driver_style as ds
from app.analysis.laps import DEFAULT_CHANNEL_MAP, time_laps
from app.importers.csvlog import read_log
from app.importers.window import beacons_in, shift_clock, window
from app.setup import models as setup_models

log = logging.getLogger(__name__)

STOP_KMH = 5.0  # slower than this, the car stands
MIN_STOP_S = 20.0  # a stop at least this long between two styles is a driver change
# ... but in a race, standing longer than a pit stop (about 1.5 minutes) in all is a red flag, not a driver change
# (Gabriele, 2026-10-08: "any interruption during the race that is longer than a pitstop is a red flag")
RED_FLAG_S = 150.0
MAX_PARTS = 4
MODES = ("groups", "tagged")  # guesses that tell drivers apart
SEEN = 512  # stops looked for, kept: every background pass asks again about a run with two styles and no stop

# (file, path, window, from, to) -> the longest stop's start and end, and the time standing in all
_seen: OrderedDict[tuple, tuple[float, float, float] | None] = OrderedDict()
_seen_lock = threading.Lock()


# ---------- where ----------

def driver_changes(db: Session, event_id: int, g: ds.Guess | None) -> dict[int, list[float]]:
    """The event's runs with a driver change by the style guess g: session id -> the times to cut it at (seconds into
    its log)."""
    out: dict[int, list[float]] = {}
    for sg in g.sessions if g is not None and g.mode in MODES else []:
        if len(sg.stints) < 2:
            continue
        s = db.get(models.RunSession, sg.session_id)
        if s is not None and s.event_id == event_id and (cuts := _cuts(s, sg.stints)):
            out[s.id] = cuts
    return out


def _cuts(s: models.RunSession, stints: list[ds.Stint]) -> list[float]:
    f = page_cache.main_file(s)
    if f is None or any(l.file_id != f.id for l in s.laps):
        return []
    laps = {l.number: l for l in s.laps}
    if any(n not in laps or not laps[n].clean for st in stints for n in st.laps):
        return []  # a guess from before the run's laps changed (it was split, or timed again)
    w = tuple(f.meta.get("window") or ())
    keys = [(f.id, f.path, w, round(laps[a.laps[-1]].start_s + laps[a.laps[-1]].time_s, 3),
             round(laps[b.laps[0]].start_s, 3)) for a, b in pairwise(stints) if a.group != b.group]
    if not keys:
        return []
    with _seen_lock:
        todo = [k for k in keys if k not in _seen]
    if todo:
        with heavy.lock:  # one log in memory at a time; only its speed is read
            try:
                speed = timing.read_file(f).channel(*_speed_names(s))
                t, v = (speed.times(), speed.values()) if speed is not None else (np.zeros(0), np.zeros(0))
            except (ValueError, OSError) as e:  # missing from storage, or unreadable: not split
                log.warning("Run %s: its log %s can't be read for its stops (%s)", s.id, f.filename, e)
                return []
            finally:
                speed = None
        with _seen_lock:
            for k in todo:
                _seen[k] = _stop(t, v, k[3], k[4])
            while len(_seen) > SEEN:
                _seen.popitem(last=False)
    with _seen_lock:
        stops = [x for k in keys if (x := _seen.get(k)) is not None and len(x) == 3 and x[1] - x[0] >= MIN_STOP_S]
    if stops and _race(s):
        stops = [x for x in stops if x[2] <= RED_FLAG_S]
    stops = sorted(sorted(stops, key=lambda x: x[0] - x[1])[:MAX_PARTS - 1])  # the longest
    return _enough([l for l in s.laps if l.clean], [float(round((a + b) / 2)) for a, b, _ in stops])


def _race(s: models.RunSession) -> bool:
    from app import run_labels, run_tyres  # here: they import the routers

    return run_tyres.kind_of(s.kind.value, run_labels.base_name(s)) == "race"


def _speed_names(s: models.RunSession) -> tuple[str, ...]:
    own = (s.car.channel_map or {}).get("speed") if s.car else None
    return tuple(own) if own else DEFAULT_CHANNEL_MAP["speed"]


def _stop(t: np.ndarray, v: np.ndarray, a: float, b: float) -> tuple[float, float, float] | None:
    """The longest stretch slower than STOP_KMH from a to b (seconds into the log): when it began and ended; and the
    time spent slower than that from a to b in all (a red flag's queue moves up now and then)."""
    i = np.flatnonzero((t >= a) & (t <= b))
    if not len(i):
        return None
    edges = np.diff(np.r_[0, (np.abs(v[i]) < STOP_KMH).astype(np.int8), 0])
    first, last = np.flatnonzero(edges == 1), np.flatnonzero(edges == -1) - 1
    if not len(first):
        return None
    k = int(np.argmax(t[i[last]] - t[i[first]]))
    return float(t[i[first[k]]]), float(t[i[last[k]]]), float(np.sum(t[i[last]] - t[i[first]]))


def _enough(clean: list[models.Lap], cuts: list[float]) -> list[float]:
    """The cuts that leave every part MIN_STINT_LAPS clean laps or more."""
    def held(a: float, b: float) -> int:
        return sum(1 for l in clean if a <= l.start_s and l.start_s + l.time_s <= b)

    while cuts:
        bounds = [-math.inf, *cuts, math.inf]
        short = next((i for i in range(len(cuts) + 1) if held(bounds[i], bounds[i + 1]) < ds.MIN_STINT_LAPS), None)
        if short is None:
            break
        del cuts[min(short, len(cuts) - 1)]  # joined to the next part (the last one: to the one before)
    return cuts


# ---------- the split ----------

def split_run(db: Session, session_id: int, cuts: list[float], g: ds.Guess | None = None) -> list[int]:
    """Split the run at these times (seconds into its log) into runs of their own, itself the first (see the module's
    notes; g, the style guess the cuts came from, says who drove which part). The new runs' ids, [] when it can't be
    split. Flushed, not committed."""
    s = db.get(models.RunSession, session_id)
    f = page_cache.main_file(s) if s is not None else None
    if f is None or any(l.file_id != f.id for l in s.laps):
        return []
    with heavy.lock:  # one log in memory at a time: each part reads its window of it
        try:
            whole = read_log(storage.local_path(f.path))
        except (ValueError, OSError) as e:  # missing from storage, or unreadable: not split
            log.warning("Run %s: its log %s can't be read to split it (%s)", s.id, f.filename, e)
            return []
        w = f.meta.get("window")
        start, end = (float(w[0]), float(w[1])) if w else (0.0, whole.duration)
        length = window(whole, start, end).duration if w else whole.duration
        cuts = sorted({float(c) for c in cuts if 0 < c < length})[:MAX_PARTS - 1]
        if not cuts or any(o.meta.get("duration_s", 0) >= cuts[0] for o in s.files if o is not f):
            return []  # (another file of the run would become its main log)
        bounds = [0.0, *cuts, length]
        wins = [[round(start + a, 3), round(start + b, 3)] for a, b in pairwise(bounds)]
        wins[-1][1] = round(end, 3)
        old = {l.number: l.start_s for l in s.laps}
        drivers = _drivers(db, s, _groups(s, bounds, g), g)
        names, typed = _names(db, s, f, len(wins) - 1)
        meta = {k: v for k, v in f.meta.items() if k != "unsplit"}
        parts, recs = [s], [f]
        for k in range(1, len(wins)):
            p = models.RunSession(event_id=s.event_id, kind=s.kind, name=names[k - 1], car_id=s.car_id,
                                  driver_id=drivers[k], track_temp_c=s.track_temp_c, ambient_temp_c=s.ambient_temp_c,
                                  tyre_set=s.tyre_set, created_at=s.created_at)
            rec = models.LoggerFile(session=p, logger=f.logger, filename=f.filename, path=f.path,
                                    meta=_part_meta(meta, s.id, bounds[k], bounds[k + 1], wins[k]),
                                    uploaded_at=f.uploaded_at)
            db.add_all([p, rec])
            parts.append(p)
            recs.append(rec)
        db.flush()
        unsplit = f.meta.get("unsplit") or {k: f.meta.get(k) for k in ("window", "duration_s", "date", "time",
                                                                        "beacons")}
        unsplit = {**unsplit, "parts": [*unsplit.get("parts", []), *(p.id for p in parts[1:])]}
        f.meta = {**_part_meta(meta, s.id, bounds[0], bounds[1], wins[0]), "unsplit": unsplit}
        s.driver_id = drivers[0]
        track = page_cache.known_track(db, s, f)
        for p, rec, (a, b) in zip(parts, recs, wins, strict=True):
            ld = window(whole, a, b)
            timing.store_laps(db, p, rec, time_laps(ld, rec.meta.get("beacons"), timing.track_line(track)), track)
            del ld
        del whole
        db.flush()
    _move_tags(db, f, old, bounds, parts, recs)
    _carry(db, s, f, parts[1:], typed)
    db.flush()
    ids = [p.id for p in parts[1:]]
    log.warning("Run %r (session %s) split at %s s of its log, a driver change at each: runs %s", s.name, s.id,
                cuts, ids)
    return ids


def _part_meta(meta: dict, sid: int, a: float, b: float, win: list[float]) -> dict:
    """The run's log meta for its part from a to b (seconds into its log), win in seconds of the stored log."""
    out = {**meta, "window": win, "split_from": sid, "duration_s": round(b - a, 1)}
    if "date" in meta or "time" in meta:
        out["date"], out["time"] = shift_clock(meta.get("date"), meta.get("time"), a)
    beacons = beacons_in(meta.get("beacons"), a, b)
    if beacons:
        out["beacons"] = beacons
    else:
        out.pop("beacons", None)
    return out


def _groups(s: models.RunSession, bounds: list[float], g: ds.Guess | None) -> list[int | None]:
    """Each part's style group: the one of the stint most of whose laps it holds (None when g doesn't say)."""
    sg = next((x for x in g.sessions if x.session_id == s.id), None) if g is not None and g.mode in MODES else None
    starts = {l.number: l.start_s for l in s.laps}
    out = []
    for a, b in pairwise(bounds):
        held = [(sum(1 for n in st.laps if a <= starts.get(n, -1.0) < b), st.group) for st in (sg.stints if sg else [])]
        n, group = max(held, default=(0, None))
        out.append(group if n else None)
    return out


def _drivers(db: Session, s: models.RunSession, groups: list[int | None], g: ds.Guess | None) -> list[int | None]:
    """Each part's driver. A person's goes to the parts of the style their laps are in (the run keeps it when that
    can't be told); one the style set, or none, goes nowhere: the style names each part."""
    from app import driver_prints  # here: it uses this module

    st = db.scalar(select(driver_prints.StyleTag).where(driver_prints.StyleTag.session_id == s.id))
    if s.driver_id is None or (st is not None and st.driver_id == s.driver_id):
        return [None] * len(groups)
    group = None
    if g is not None and g.mode in MODES:
        group = next((i for i, grp in enumerate(g.groups) if grp.driver_id == s.driver_id), None)
    if group is None or group not in groups:
        return [s.driver_id] + [None] * (len(groups) - 1)
    return [s.driver_id if x == group else None for x in groups]


def _names(db: Session, s: models.RunSession, f: models.LoggerFile, n: int) -> tuple[list[str], bool]:
    """The new parts' names, unique in the event, and whether the run's name was typed by hand."""
    from app.results import models as rm
    from app.results import run_names

    mark = db.scalar(select(rm.RunNameMark).where(rm.RunNameMark.session_id == s.id))
    typed = not run_names.looks_given(s, mark)
    stem = re.sub(r"\.[A-Za-z0-9]+$", "", f.filename or "") or "Run"
    if typed:
        base = (s.name or "").strip() or stem
    else:  # named like the run while the timetable naming still sees the upload's name in it
        plain = run_names._plain_name(s.name)
        base = plain if plain and run_names.looks_given(SimpleNamespace(name=plain, files=[f]), None) else stem
    taken = set(db.scalars(select(models.RunSession.name).where(models.RunSession.event_id == s.event_id)))
    out, k = [], 2
    for _ in range(n):
        while (name := f"{base[:110]} ({k})") in taken:
            k += 1
        out.append(name)
        taken.add(name)
        k += 1
    return out, typed


def _move_tags(db: Session, f: models.LoggerFile, old: dict[int, float], bounds: list[float],
               parts: list[models.RunSession], recs: list[models.LoggerFile]) -> None:
    """Each lap tag to its lap in the part that holds it (found by when it started); a tag of a lap no part has
    (the one with the stop) goes."""
    laps = [[l for l in p.laps if l.file_id == rec.id] for p, rec in zip(parts, recs, strict=True)]
    for r in db.scalars(select(laptags.LapTag).where(laptags.LapTag.file_id == f.id)).all():
        at = r.lap_start_s if r.lap_start_s is not None else old.get(r.lap)
        if at is None:
            continue
        k = next((i for i, (a, b) in enumerate(pairwise(bounds)) if a <= at < b), len(parts) - 1)
        lap = next((l for l in laps[k] if abs(l.start_s - (at - bounds[k])) <= laptags.MATCH_S), None)
        if lap is None:
            db.delete(r)
        else:
            r.session_id, r.file_id, r.lap, r.lap_start_s = parts[k].id, recs[k].id, lap.number, lap.start_s


def _carry(db: Session, s: models.RunSession, f: models.LoggerFile, new: list[models.RunSession], typed: bool) -> None:
    """The setup sheet and a typed name's mark go to the new parts; what was kept for the run and isn't signed with
    its laps goes, and so does the style's mark on its driver (each part's driver is settled anew)."""
    from app import driver_prints
    from app.results import models as rm

    sheet = db.scalar(select(setup_models.SessionSetup).where(setup_models.SessionSetup.session_id == s.id))
    for p in new:
        if sheet is not None:
            db.add(setup_models.SessionSetup(session_id=p.id, template=sheet.template, values=dict(sheet.values or {}),
                                             notes=sheet.notes, copied_from_session_id=s.id))
        if typed:
            db.add(rm.RunNameMark(session_id=p.id, by_hand=True))
    gone = [*db.scalars(select(models.TyreData).where(models.TyreData.file_id == f.id)),
            *db.scalars(select(setup_models.SetupRunSummary).where(setup_models.SetupRunSummary.session_id == s.id)),
            *db.scalars(select(driver_prints.StyleTag).where(driver_prints.StyleTag.session_id == s.id))]
    for row in gone:
        db.delete(row)
    page_cache.forget_session(db, s.id)


# ---------- an event ----------

def split_event(db: Session, event_id: int, g: ds.Guess | None) -> list[int]:
    """Split every run of the event that had a driver change (by the style guess g) into one run per driver, then
    name the event's runs from the official timetable again and start its report and pages again. Commits after each
    run (call it with nothing else pending: a split that fails is rolled back). The new runs' ids; g no longer
    describes the runs split, so its suggestions for them wait for the next pass."""
    new: list[int] = []
    split: list[int] = []
    for sid, cuts in driver_changes(db, event_id, g).items():
        try:
            ids = split_run(db, sid, cuts, g)
            db.commit()
        except Exception:
            db.rollback()
            log.exception("Splitting run %s at its driver changes failed", sid)
            continue
        if ids:
            new += ids
            split.append(sid)
    if new:
        _after(db, event_id, [*split, *new])
    return new


def _after(db: Session, event_id: int, session_ids: list[int]) -> None:
    from app import prebuild
    from app.routers import events, results
    from app.vehicle import tyre_store

    try:  # each part named after the session it ran in; an event without an official round answers with a note
        results.event_run_names(event_id, db)
    except Exception:
        db.rollback()
        log.exception("Naming the runs of event %s after a split failed", event_id)
    events._refresh(db, {event_id})  # the report makes the parts' lap traces
    prebuild.after_upload(db, session_ids)
    tyre_store.kick()
