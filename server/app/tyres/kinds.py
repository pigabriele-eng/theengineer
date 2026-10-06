"""The garage's tyres (catalog.TyreKind) in the tyre tools: which tyre each session ran, and a tyre's P-Book pressures.

A session's tyre is the one its event names (seasons.tyre_kind_for_session: the event's own information, else its
season's entry). Different tyres are kept apart: the pressure calculator learns its pressure rise only from the
sessions on the tyre picked, and the tyre model is fitted per car and tyre. A session whose event names no tyre is
"not set": it counts for no tyre, and the tools ask for the tyre to be set on its event.

A tyre's P-Book pressures (minimum cold and hot, target hot, front and rear) live in its specs. Where none are
entered yet, the minimums entered for that tyre by name in the older per-series table (tyre_minimums) stand in.
"""
from __future__ import annotations

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app import catalog, models, seasons

NOT_SET = "Tyre not set"
AXLES = ("front", "rear")
PBOOK_KEYS = ("cold_min_bar", "hot_min_bar", "hot_target_bar")


def label(t: catalog.TyreKind) -> str:
    return catalog.tyre_label(t)


def tyres_of(db: Session, session_ids) -> dict[int, int | None]:
    """The tyre kind each session ran, None where its event doesn't say. A session's tyre is its event's
    (seasons.tyre_kind_for_session), so it is asked once per event: working an event's tyre out takes a dozen
    queries, and an event has many sessions."""
    ids = list(dict.fromkeys(session_ids))
    events = dict(db.execute(select(models.RunSession.id, models.RunSession.event_id)
                             .where(models.RunSession.id.in_(ids))).all()) if ids else {}
    per_event: dict[int, int | None] = {}
    out: dict[int, int | None] = {}
    for sid in ids:
        eid = events.get(sid)
        if eid is None:
            out[sid] = None
            continue
        if eid not in per_event:
            per_event[eid] = seasons.tyre_kind_for_session(db, sid)
        out[sid] = per_event[eid]
    return out


def sessions_on(db: Session, tyre_kind_id: int, car_id: int | None = None) -> list[int]:
    """The sessions on that tyre (of that car, when one is named), oldest first."""
    q = select(models.RunSession.id).order_by(models.RunSession.created_at, models.RunSession.id)
    if car_id is not None:
        q = q.where(models.RunSession.car_id == car_id)
    ids = list(db.scalars(q).all())
    kinds = tyres_of(db, ids)
    return [sid for sid in ids if kinds[sid] == tyre_kind_id]


def unset_events(db: Session, session_ids: list[int]) -> list[dict]:
    """The events of these sessions (those with no tyre known), with how many of the sessions each has: where to
    set the tyre. Sessions in no event are counted under event None."""
    counts: dict[int | None, int] = {}
    for eid in db.scalars(select(models.RunSession.event_id).where(models.RunSession.id.in_(session_ids))).all():
        counts[eid] = counts.get(eid, 0) + 1
    names = dict(db.execute(select(models.Event.id, models.Event.name)
                            .where(models.Event.id.in_([e for e in counts if e is not None]))).all())
    out = [{"event_id": eid, "name": names.get(eid) if eid is not None else None, "sessions": n}
           for eid, n in counts.items()]
    return sorted(out, key=lambda e: (e["event_id"] is None, -(e["event_id"] or 0)))


def _bar(v) -> float | None:
    return float(v) if isinstance(v, int | float) and not isinstance(v, bool) and 0 < v < 10 else None


def pbook(db: Session, t: catalog.TyreKind) -> dict:
    """The tyre's P-Book pressures, per axle: {"cold_min_bar": {"front", "rear"}, "hot_min_bar", "hot_target_bar",
    "source", "origin"}. origin: "tyre" (its specs), "series" (the older per-series minimums naming it) or None."""
    specs = t.specs or {}
    out: dict = {k: {a: _bar((specs.get(k) or {}).get(a)) if isinstance(specs.get(k), dict) else None
                     for a in AXLES} for k in PBOOK_KEYS}
    if any(v is not None for k in PBOOK_KEYS for v in out[k].values()):
        return {**out, "source": specs.get("source") or None, "origin": "tyre"}
    rows = db.scalars(select(models.TyreMinimum)
                      .where(func.lower(models.TyreMinimum.tyre) == label(t).lower())
                      .order_by(models.TyreMinimum.id)).all()
    for r in rows:
        for k in ("cold_min_bar", "hot_min_bar"):
            v = _bar(getattr(r, k))
            if v is not None and r.axle in AXLES and (out[k][r.axle] is None or v > out[k][r.axle]):
                out[k][r.axle] = v
    if rows and any(v is not None for k in PBOOK_KEYS for v in out[k].values()):
        series = sorted({r.series for r in rows})
        sources = sorted({r.source for r in rows if r.source})
        return {**out, "source": "; ".join(sources) or None, "origin": "series", "series": series}
    return {**out, "source": specs.get("source") or None, "origin": None}


def minimum_rows(t: catalog.TyreKind, p: dict) -> list[dict]:
    """The P-Book minimums as the pressure plan checks them (tyres/pressure.py limits_for)."""
    return [{"tyre": label(t), "axle": a, "cold_min_bar": p["cold_min_bar"][a], "hot_min_bar": p["hot_min_bar"][a],
             "source": p["source"]}
            for a in AXLES if p["cold_min_bar"][a] is not None or p["hot_min_bar"][a] is not None]


def listing(db: Session) -> dict:
    """Every tyre with its P-Book pressures and how many sessions ran on it, most first; and the sessions whose
    event names no tyre, by event."""
    ids = list(db.scalars(select(models.RunSession.id)).all())
    kinds = tyres_of(db, ids)
    counts: dict[int, int] = {}
    for k in kinds.values():
        if k is not None:
            counts[k] = counts.get(k, 0) + 1
    tyres = [{**catalog.tyre_row(t), "sessions": counts.get(t.id, 0), "pbook": pbook(db, t)}
             for t in db.scalars(select(catalog.TyreKind)).all()]
    tyres.sort(key=lambda x: (-x["sessions"], x["label"].lower(), x["id"]))
    unset = [sid for sid, k in kinds.items() if k is None]
    return {"tyres": tyres, "not_set": {"sessions": len(unset), "events": unset_events(db, unset)}}
