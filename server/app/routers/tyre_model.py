"""The accumulating tyre model: one car and tyre's sessions pooled from their summaries (vehicle/tyre_data.py).

Different tyres are different models: the tyre is the one each session's event names (tyres/kinds.py), and a model
pools one car's sessions on one tyre. Sessions whose event names no tyre are pooled apart as "Tyre not set", and
the app asks for the tyre to be set on their events.
"""
from collections import Counter, OrderedDict
from threading import Lock

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from app import catalog, models
from app.db import get_db
from app.tyres import kinds as tyre_kinds
from app.vehicle import tyre_store
from app.vehicle.tyre_data import Entry, fit_model
from app.vehicle.tyre_fit import NotEnoughData

router = APIRouter(prefix="/tyre-model")

_cache: OrderedDict = OrderedDict()  # fitted models by their inputs; a summary added or changed makes a new key
_cache_lock = Lock()
CACHE_SIZE = 8
NOT_SET = "none"  # the tyre_kind parameter for the sessions with no tyre set


def _listing(db: Session) -> list[dict]:
    """Every summarised log of the current method, without its summary: which car it counts for (the session's
    car when it has one, else the logger it came from), the tyre its event names (kind None: not set), its track
    and date."""
    q = (select(models.TyreData.id, models.TyreData.car_key, models.TyreData.car_label, models.TyreData.track,
                models.TyreData.session_id, models.TyreData.logged_on, models.Car.id, models.Car.name,
                models.RunSession.event_id)
         .join(models.RunSession, models.RunSession.id == models.TyreData.session_id)
         .outerjoin(models.Car, models.Car.id == models.RunSession.car_id)
         .where(models.TyreData.status == tyre_store.OK, models.TyreData.version == tyre_store.version()))
    rows = db.execute(q).all()
    kinds = tyre_kinds.tyres_of(db, [r[4] for r in rows])
    labels = {t.id: tyre_kinds.label(t) for t in db.scalars(select(catalog.TyreKind)).all()}
    out = []
    for rid, key, label, track, sid, day, car_id, car_name, event_id in rows:
        if car_id is not None:
            key, label = f"car:{car_id}", car_name
        kind = kinds[sid]
        out.append({"id": rid, "car": key, "label": label, "kind": kind,
                    "tyre": labels[kind] if kind is not None else tyre_kinds.NOT_SET, "track": track,
                    "session_id": sid, "event_id": event_id, "date": day})
    return out


def _not_set(db: Session, mine: list[dict]) -> dict:
    """The car's sessions with no tyre set, and their events: where to set it."""
    sids = sorted({x["session_id"] for x in mine if x["kind"] is None})
    return {"sessions": len(sids), "events": tyre_kinds.unset_events(db, sids) if sids else []}


def _tyres(mine: list[dict]) -> list[dict]:
    """The car's tyres with how many sessions each, most first; "Tyre not set" last."""
    sessions: dict[int | None, set] = {}
    names: dict[int | None, str] = {}
    for x in mine:
        sessions.setdefault(x["kind"], set()).add(x["session_id"])
        names[x["kind"]] = x["tyre"]
    out = [{"id": k, "name": names[k], "sessions": len(s)} for k, s in sessions.items()]
    return sorted(out, key=lambda t: (t["id"] is None, -t["sessions"], t["name"].lower()))


@router.get("/cars")
def cars(db: Session = Depends(get_db)):
    """Every car with summarised logs: its tyres (and its sessions with no tyre set) and tracks with how many
    sessions each, most data first; and how far the background summaries have got."""
    out: dict[str, dict] = {}
    for x in _listing(db):
        c = out.setdefault(x["car"], {"key": x["car"], "label": x["label"], "rows": [], "tracks": {}, "dates": []})
        c["rows"].append(x)
        if x["track"]:
            c["tracks"].setdefault(x["track"], set()).add(x["session_id"])
        if x["date"]:
            c["dates"].append(x["date"].isoformat())
    listed = []
    for c in out.values():
        listed.append({
            "key": c["key"], "label": c["label"], "sessions": len({x["session_id"] for x in c["rows"]}),
            "tyres": _tyres(c["rows"]),
            "not_set": _not_set(db, c["rows"]),
            "tracks": sorted(({"name": t, "sessions": len(s)} for t, s in c["tracks"].items()),
                             key=lambda x: -x["sessions"]),
            "dates": [min(c["dates"]), max(c["dates"])] if c["dates"] else [],
        })
    listed.sort(key=lambda c: -c["sessions"])
    return {"cars": listed, "status": tyre_store.status(db)}


@router.get("/status")
def summaries_status(db: Session = Depends(get_db)):
    """How far the background summaries have got."""
    return tyre_store.status(db)


def _pick(tyre_kind: str | None, tyres: list[dict]) -> int | None:
    """The tyre asked for (an id, or "none" for not set), else the one with most sessions (not set only when no
    session of the car has a tyre)."""
    if tyre_kind is None:
        return tyres[0]["id"]  # sorted: most sessions first, not set last
    if tyre_kind == NOT_SET:
        return None
    try:
        return int(tyre_kind)
    except ValueError:
        raise HTTPException(422, f'tyre_kind is a tyre id or "{NOT_SET}"') from None


@router.get("")
def tyre_model(car: str, tyre_kind: str | None = None, track: str | None = None, ambient_min: float | None = None,
               ambient_max: float | None = None, db: Session = Depends(get_db)):
    """The tyre model of every summarised session of one car on one tyre (the tyre with most sessions unless one is
    named; "none": the sessions with no tyre set), optionally only at one track or within an ambient temperature
    range: the curve per axle, grip against TPMS temperature, hot pressure and laps on the tyre, advice first, and
    what it all rests on. When there is nothing to fit, "empty" says why instead."""
    mine = [x for x in _listing(db) if x["car"] == car]
    if not mine:
        raise HTTPException(404, "No summarised session of this car yet")
    label = mine[0]["label"]
    tyres = _tyres(mine)
    kind = _pick(tyre_kind, tyres)
    on = [x for x in mine if x["kind"] == kind]
    name = next((t["name"] for t in tyres if t["id"] == kind), None)
    if name is None and kind is not None:  # a tyre this car has no session on
        t = db.get(catalog.TyreKind, kind)
        if t is None:
            raise HTTPException(404, "Tyre not found")
        name = tyre_kinds.label(t)
    name = name or tyre_kinds.NOT_SET
    rows = db.execute(select(models.TyreData, models.RunSession)
                      .join(models.RunSession, models.RunSession.id == models.TyreData.session_id)
                      .where(models.TyreData.id.in_([x["id"] for x in on]))
                      .order_by(models.TyreData.logged_on, models.TyreData.file_id)).all() if on else []
    tracks = sorted({r.track for r, _ in rows if r.track})
    if track:
        rows = [(r, s) for r, s in rows if r.track == track]
    files_per_session = Counter(s.id for _, s in rows)
    entries, stamps, events = [], [], {}
    for r, s in rows:
        ambient = s.ambient_temp_c if s.ambient_temp_c is not None else r.ambient_c
        if ambient_min is not None and (ambient is None or ambient < ambient_min):
            continue
        if ambient_max is not None and (ambient is None or ambient > ambient_max):
            continue
        session_name = s.name or f"Session {s.id}"
        if files_per_session[s.id] > 1:
            session_name = f"{session_name} (log {r.file_id})"
        day = r.logged_on or (s.created_at.date() if s.created_at else None)
        entries.append(Entry(summary=r.summary, session_id=s.id, name=session_name, track=r.track,
                             date=day.isoformat() if day else None, ambient_c=ambient, tyre=name))
        stamps.append((r.file_id, r.updated_at.isoformat()))
        events[s.id] = s.event_id
    head = {"car": {"key": car, "label": label}, "tyre": name,
            "tyre_kind": {"id": kind, "label": name} if kind is not None else None,
            "filters": {"track": track, "ambient_min": ambient_min, "ambient_max": ambient_max},
            "choices": {"tyres": tyres, "tracks": tracks}, "not_set": _not_set(db, mine),
            "status": tyre_store.status(db)}
    # nothing to fit is an answer, not an error: the app says why and keeps its filters
    if not entries:
        return {**head, "empty": "No session of this car on this tyre matches those filters."}
    key = (tuple(stamps), tuple((e.name, e.ambient_c, e.tyre, e.track, e.date) for e in entries))
    with _cache_lock:
        model = _cache.get(key)
        if model is not None:
            _cache.move_to_end(key)
    if model is None:
        try:
            model = fit_model(entries)
        except NotEnoughData as e:
            return {**head, "empty": str(e)}
        with _cache_lock:
            _cache[key] = model
            while len(_cache) > CACHE_SIZE:
                _cache.popitem(last=False)
    sessions = [{**s, "event_id": events.get(s["session_id"])} for s in model["sessions"]]
    return {**head, **model, "sessions": sessions}
