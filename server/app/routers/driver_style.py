"""Driver fingerprints: who drove each run of an event, from driving style alone, and every driver's fingerprint.

GET /events/{id}/driver-guess suggests a driver for the event's runs (and a driver change inside a run), to be
confirmed with a tap, and says which runs had their driver set from the style (driver_prints.settle);
GET /drivers/fingerprints is the database: each driver's style in words, the events it was learned from with the pace
against teammates, which ways of driving go with quicker laps in all the data, and the style groups still waiting for
a name. See analysis/driver_style.py for how, app/driver_prints.py for what is kept.
"""
from __future__ import annotations

import json
import zlib

import numpy as np
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from app import driver_prints, models, page_cache
from app.analysis import driver_style as ds
from app.db import get_db

router = APIRouter()

def _names(db: Session) -> dict[int, str]:
    return {d.id: d.name for d in db.scalars(select(models.Driver)).all()}


def _label(i: int, grp: ds.Group, names: dict[int, str]) -> str:
    if grp.driver_id is not None and grp.driver_id in names:
        return names[grp.driver_id]
    return "New driver"  # never a letter: the driver is asked about (driver_prints.settle)


def _pace(times: list[float]) -> dict:
    t = sorted(times)
    return {"best_s": round(t[0], 3), "typical_s": round(float(np.mean(t[:3])), 3)} if t else {}


@router.get("/events/{event_id}/driver-guess")
def event_guess(event_id: int, db: Session = Depends(get_db)):
    """Who drove each run of the event by style: a suggestion per run (with how sure, and the stints when the
    driver changed at a stop), and the event's style groups with their traits."""
    ev = db.get(models.Event, event_id)
    if ev is None:
        raise HTTPException(404, "Event not found")
    ep, pending = driver_prints.refresh(db, event_id)
    if pending:
        from app.routers import reports  # looked up when used: the tests reload it
        reports.report_for(db, "event", event_id)  # makes the lap traces; the fingerprints follow when it's done
    status = "working" if pending else "ready"
    if ep is None:
        return {"status": status, "mode": "too few laps", "separation": None, "groups": [], "sessions": []}
    names = _names(db)
    tags = driver_prints.tags_of(db, ep, people_only=False)
    by_style = driver_prints.set_by_style(db, list(tags))
    g = driver_prints.guess_for(db, event_id, ep, driver_prints.learned(db))
    times = np.array(ep.times)
    groups = []
    for i, grp in enumerate(g.groups):
        groups.append({"index": i, "label": _label(i, grp, names), "driver_id": grp.driver_id,
                       "driver": names.get(grp.driver_id) if grp.driver_id is not None else None,
                       "source": grp.source, "match": round(grp.match, 2) if grp.match is not None else None,
                       "laps": grp.laps, **_pace(times[g.labels == i].tolist()),
                       "traits": ds.traits(grp.v, ep.kinds, 4) if grp.v is not None and len(g.groups) > 1 else []})
    out = []
    for s in g.sessions:
        grp = g.groups[s.group]
        current = tags.get(s.session_id)
        suggestion = {"group": s.group, "label": groups[s.group]["label"], "driver_id": grp.driver_id,
                      "driver": groups[s.group]["driver"], "confidence": ds.confidence(g, grp, s.share),
                      "share": round(s.share, 2), "laps": s.laps}
        stints = []
        if len(s.stints) > 1:
            stints = [{"first_lap": st.laps[0], "last_lap": st.laps[-1], "laps": len(st.laps), "group": st.group,
                       "label": groups[st.group]["label"], "driver_id": g.groups[st.group].driver_id}
                      for st in s.stints]
        agrees = None
        if current is not None and grp.driver_id is not None:
            agrees = current == grp.driver_id
        st = by_style.get(s.session_id)
        auto = {"source": st.source, "match": st.match} if st is not None and st.driver_id == current else None
        out.append({"session_id": s.session_id, "driver_id": current, "suggestion": suggestion, "agrees": agrees,
                    "stints": stints, "auto": auto})
    return {"status": status, "mode": g.mode,
            "separation": round(g.separation, 2) if g.separation is not None else None,
            "groups": groups, "sessions": out}


def _advice(vec: dict[str, float], links: list[dict]) -> list[dict]:
    """A driver's style against what goes with quicker laps in all the data: room to gain, or a strength."""
    out = []
    for link in links:
        if link["outcome"] or abs(link["r"]) < 0.25:
            continue
        x = vec.get(link["kind"])
        if x is None or abs(x) < ds.TRAIT_AT:
            continue
        k = ds.KINDS[link["kind"]]
        quicker_more = link["r"] < 0
        if (x > 0) == quicker_more:
            out.append({"kind": link["kind"], "type": "strength", "label": k.label, "r": link["r"],
                        "words": f"On quicker laps a driver {k.more if quicker_more else k.less}, "
                                 "and this driver already does that more than their teammates."})
        else:
            out.append({"kind": link["kind"], "type": "gain", "label": k.label, "r": link["r"],
                        "words": f"On quicker laps a driver {k.more if quicker_more else k.less}, "
                                 f"but this driver {k.more if x > 0 else k.less} than their teammates."})
    return out


@router.get("/drivers/fingerprints")
def fingerprints(db: Session = Depends(get_db)):
    """The fingerprint database, as kept after the last upload or tag (driver_prints.refresh_all keeps it). When
    something changed since, the kept answer comes at once with "updating" (ask again shortly) while it is worked
    out again in the background; only the very first time is it worked out while the request waits."""
    sig = driver_prints.page_signature(db)
    hit = page_cache.lookup(db, driver_prints.PAGE, sig)
    if hit is not None and hit[0] == 200:
        return {**hit[1], "updating": driver_prints.busy()}
    driver_prints.refresh_in_background()
    kept = db.scalar(select(page_cache.PageCache).where(page_cache.PageCache.scope == driver_prints.PAGE))
    if kept is not None and kept.status == 200:
        try:
            return {**json.loads(zlib.decompress(kept.body)), "updating": True}
        except (zlib.error, ValueError):
            pass
    out = page_cache.plain(build_page(db))
    page_cache.store(db, driver_prints.PAGE, sig, out)
    return {**out, "updating": driver_prints.busy()}


def keep_page(db: Session) -> None:
    """Work the page out and keep it, unless what is kept is up to date (the background pass ends with this)."""
    sig = driver_prints.page_signature(db)
    if not page_cache.fresh(db, driver_prints.PAGE, sig):
        page_cache.store(db, driver_prints.PAGE, sig, page_cache.plain(build_page(db)))


def build_page(db: Session) -> dict:
    """The fingerprint database: each driver's style, events, advice and where they were found; what goes with
    quicker laps; the styles waiting for a name; what is measured."""
    prints = {e: p for e, p in driver_prints.stored(db).items() if db.get(models.Event, e) is not None}
    names = _names(db)
    events = {e.id: e for e in db.scalars(select(models.Event).where(models.Event.id.in_(list(prints)))).all()}
    learned = driver_prints.learned(db)
    # what goes with quicker laps: every run's laps against the run's own typical lap, all events pooled
    rows = []
    all_kinds = sorted({k for p in prints.values() for k in p.kinds})
    for ep in prints.values():
        idx = {k: j for j, k in enumerate(ep.kinds)}
        sid, t = np.array(ep.sessions), np.array(ep.times)
        v = np.array([[ep.v[i, idx[k]] if k in idx else 0.0 for k in all_kinds] for i in range(len(t))])
        for s in set(ep.sessions):
            m = sid == s
            rows.append((t[m], v[m]))
    links = ds.lap_time_links(rows, all_kinds)

    found: dict[int, list[dict]] = {}  # driver -> events where their fingerprint names an untagged style group
    unnamed = []
    per_event: dict[int, tuple[ds.EventPrint, ds.Guess]] = {}
    for ev_id, ep in prints.items():
        g = driver_prints.guess_for(db, ev_id, ep, learned)
        per_event[ev_id] = (ep, g)
        ev = events.get(ev_id)
        for i, grp in enumerate(g.groups):
            if grp.source == "fingerprint" and grp.driver_id is not None:
                found.setdefault(grp.driver_id, []).append({
                    "event_id": ev_id, "event": ev.name if ev else None, "laps": grp.laps,
                    "match": round(grp.match or 0, 2)})
            elif grp.driver_id is None and g.mode == "groups":
                runs = [s.session_id for s in g.sessions if s.group == i]
                unnamed.append({"event_id": ev_id, "event": ev.name if ev else None,
                                "label": driver_prints.runs_text(db, runs) if runs else _label(i, grp, names),
                                "laps": grp.laps})

    drivers = []
    for did, rows_ in learned.items():
        vec = {k: float(np.mean([v.get(k, 0.0) for _, v, _ in rows_])) for k in all_kinds}
        arr = np.array([vec[k] for k in all_kinds])
        evs = []
        for ev_id, _, laps in rows_:
            ep, g = per_event[ev_id]
            t = np.array(ep.times)
            mine = [i for i, grp in enumerate(g.groups) if grp.driver_id == did]
            others = [i for i, grp in enumerate(g.groups) if grp.driver_id != did]
            pace = _pace(t[np.isin(g.labels, mine)].tolist())
            mates = _pace(t[np.isin(g.labels, others)].tolist())
            ev = events.get(ev_id)
            evs.append({"event_id": ev_id, "event": ev.name if ev else None,
                        "date": ev.date.isoformat() if ev and ev.date else None, "laps": laps, **pace,
                        "teammates": sorted({names.get(g.groups[i].driver_id) or _label(i, g.groups[i], names)
                                             for i in others}),
                        "gap_to_teammates_s": round(pace["typical_s"] - mates["typical_s"], 3)
                        if pace and mates else None})
        drivers.append({"driver_id": did, "driver": names.get(did, f"Driver {did}"),
                        "laps": sum(n for _, _, n in rows_), "events": sorted(evs, key=lambda e: e["date"] or ""),
                        "traits": ds.traits(arr, all_kinds), "advice": _advice(vec, links),
                        "also_found": found.get(did, [])})
    drivers.sort(key=lambda d: -d["laps"])
    return {"events": len(prints), "drivers": drivers, "links": links, "unnamed": unnamed,
            "kinds": [{"kind": k, "label": v.label, "explain": v.explain} for k, v in ds.KINDS.items()]}
