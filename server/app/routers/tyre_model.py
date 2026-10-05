"""The accumulating tyre model: one car and tyre's sessions pooled from their summaries (vehicle/tyre_data.py)."""
from collections import Counter, OrderedDict
from threading import Lock

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from app import models
from app.db import get_db
from app.routers.sessions import _get
from app.vehicle import tyre_store
from app.vehicle.tyre_data import Entry, fit_model
from app.vehicle.tyre_fit import NotEnoughData

router = APIRouter(prefix="/tyre-model")

_cache: OrderedDict = OrderedDict()  # fitted models by their inputs; a summary added or changed makes a new key
_cache_lock = Lock()
CACHE_SIZE = 8


def _listing(db: Session) -> list[dict]:
    """Every summarised log of the current method, without its summary: which car it counts for (the session's
    car when it has one, else the logger it came from), its tyre, track and date."""
    q = (select(models.TyreData.id, models.TyreData.car_key, models.TyreData.car_label, models.TyreData.tyre,
                models.TyreData.track, models.TyreData.session_id, models.TyreData.logged_on, models.Car.id,
                models.Car.name)
         .join(models.RunSession, models.RunSession.id == models.TyreData.session_id)
         .outerjoin(models.Car, models.Car.id == models.RunSession.car_id)
         .where(models.TyreData.status == tyre_store.OK, models.TyreData.version == tyre_store.version()))
    out = []
    for rid, key, label, tyre, track, sid, day, car_id, car_name in db.execute(q):
        if car_id is not None:
            key, label = f"car:{car_id}", car_name
        out.append({"id": rid, "car": key, "label": label, "tyre": tyre, "track": track, "session_id": sid,
                    "date": day})
    return out


@router.get("/cars")
def cars(db: Session = Depends(get_db)):
    """Every car with summarised logs: its tyres and tracks with how many sessions each, most data first; and how
    far the background summaries have got."""
    out: dict[str, dict] = {}
    for x in _listing(db):
        c = out.setdefault(x["car"], {"key": x["car"], "label": x["label"], "sessions": set(), "tyres": {},
                                      "tracks": {}, "dates": []})
        c["sessions"].add(x["session_id"])
        c["tyres"].setdefault(x["tyre"], set()).add(x["session_id"])
        if x["track"]:
            c["tracks"].setdefault(x["track"], set()).add(x["session_id"])
        if x["date"]:
            c["dates"].append(x["date"].isoformat())
    listed = []
    for c in out.values():
        listed.append({
            "key": c["key"], "label": c["label"], "sessions": len(c["sessions"]),
            "tyres": sorted(({"name": t, "sessions": len(s)} for t, s in c["tyres"].items()),
                            key=lambda x: -x["sessions"]),
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


@router.get("")
def tyre_model(car: str, tyre: str | None = None, track: str | None = None, ambient_min: float | None = None,
               ambient_max: float | None = None, db: Session = Depends(get_db)):
    """The tyre model of every summarised session of one car and tyre (the tyre with most sessions unless one is
    named), optionally only at one track or within an ambient temperature range: the curve per axle, grip against
    TPMS temperature, hot pressure and laps on the tyre, advice first, and what it all rests on."""
    mine = [x for x in _listing(db) if x["car"] == car]
    if not mine:
        raise HTTPException(404, "No summarised session of this car yet")
    label = mine[0]["label"]
    rows = db.execute(select(models.TyreData, models.RunSession)
                      .join(models.RunSession, models.RunSession.id == models.TyreData.session_id)
                      .where(models.TyreData.id.in_([x["id"] for x in mine]))
                      .order_by(models.TyreData.logged_on, models.TyreData.file_id)).all()
    tyres = Counter({t: len({s.id for r, s in rows if r.tyre == t}) for t in {r.tyre for r, _ in rows}})
    tyre = tyre if tyre is not None else tyres.most_common(1)[0][0]
    rows = [(r, s) for r, s in rows if r.tyre == tyre]
    tracks = sorted({r.track for r, _ in rows if r.track})
    if track:
        rows = [(r, s) for r, s in rows if r.track == track]
    files_per_session = Counter(s.id for _, s in rows)
    entries, stamps = [], []
    for r, s in rows:
        ambient = s.ambient_temp_c if s.ambient_temp_c is not None else r.ambient_c
        if ambient_min is not None and (ambient is None or ambient < ambient_min):
            continue
        if ambient_max is not None and (ambient is None or ambient > ambient_max):
            continue
        name = s.name or f"Session {s.id}"
        if files_per_session[s.id] > 1:
            name = f"{name} (log {r.file_id})"
        day = r.logged_on or (s.created_at.date() if s.created_at else None)
        entries.append(Entry(summary=r.summary, session_id=s.id, name=name, track=r.track,
                             date=day.isoformat() if day else None, ambient_c=ambient, tyre=r.tyre))
        stamps.append((r.file_id, r.updated_at.isoformat()))
    head = {"car": {"key": car, "label": label}, "tyre": tyre,
            "filters": {"track": track, "ambient_min": ambient_min, "ambient_max": ambient_max},
            "choices": {"tyres": [{"name": t, "sessions": n} for t, n in tyres.most_common()], "tracks": tracks},
            "status": tyre_store.status(db)}
    if not entries:
        raise HTTPException(422, "No session of this car and tyre matches those filters")
    key = (tuple(stamps), tuple((e.name, e.ambient_c) for e in entries))
    with _cache_lock:
        model = _cache.get(key)
        if model is not None:
            _cache.move_to_end(key)
    if model is None:
        try:
            model = fit_model(entries)
        except NotEnoughData as e:
            raise HTTPException(422, str(e)) from e
        with _cache_lock:
            _cache[key] = model
            while len(_cache) > CACHE_SIZE:
                _cache.popitem(last=False)
    return {**head, **model}


class TyreIn(BaseModel):
    tyre: str | None = Field(None, max_length=80, description="The tyre the session ran; empty for the car's usual")


@router.patch("/sessions/{session_id}")
def set_tyre(session_id: int, body: TyreIn, db: Session = Depends(get_db)):
    """Name the tyre a session ran, so the model keeps it apart from other tyres on the same car."""
    _get(db, session_id)
    rows = db.scalars(select(models.TyreData).where(models.TyreData.session_id == session_id)).all()
    if not rows:
        raise HTTPException(409, "This session's logs are not summarised yet; try again in a minute")
    name = (body.tyre or "").strip() or tyre_store.PRESET_TYRES.get(rows[0].preset)
    for r in rows:
        r.tyre = name
    db.commit()
    return {"session_id": session_id, "tyre": name, "logs": len(rows)}
