"""Seasons made ahead of time, and what each event was run with (event info).

A season is a year of a series (by hand, or a series the results module can read: `series` is its adapter key) with
our car number and our entry: car, vehicle, team, tyre and drivers 1 to 4. Its rounds become planned events (plans.py),
or are linked to an event already there on the same days at the same venue, so uploads at a round go into its event.

Event info is what an event was run with: tyre, car, team, vehicle and drivers 1 to 4. A field the event doesn't set
comes from its season's entry; after that the car and drivers come from the event's runs, and the team and vehicle
from the car. info_for_event() gives the result and the checklist of what is still missing ("tyre brand",
"compound", "car", "team", "drivers"); tyre_kind_for_session() and vehicle_for_session() are what other code asks.

New tables only (create_all adds them); no column of an existing table changes. Event, car, team and driver ids are
kept without foreign keys (the events and garage routers delete those rows without knowing these tables): an id whose
row is gone reads as not set.
"""
from __future__ import annotations

from collections import Counter
from datetime import UTC, date, datetime
from types import SimpleNamespace

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import JSON, Boolean, Date, DateTime, ForeignKey, Integer, String, delete, func, select, update
from sqlalchemy.orm import Mapped, Session, mapped_column

from app import calendar_sync, catalog, garage, models, plans
from app.db import Base, get_db

MAX_DRIVERS = 4
MAX_ROUNDS = 40
MAX_LOOKBACK = 30  # earlier events looked through for the previous event of the same car
MAX_RUNS = 500
MISSING = ("tyre brand", "compound", "car", "team", "drivers")  # the checklist, in the order the app shows it


def _now() -> datetime:
    return datetime.now(UTC)


class Season(Base):
    """A year of a series, with our car number and our entry:
    {"car_id", "team_id", "vehicle_model_id", "tyre_kind_id", "drivers": [driver ids, up to 4, in order]}."""
    __tablename__ = "seasons"
    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(160))  # "GT4 European Series 2026"
    series: Mapped[str | None] = mapped_column(String(40))  # the results adapter key ("gt4-europe"); null: by hand
    year: Mapped[int] = mapped_column(Integer)
    car_number: Mapped[str | None] = mapped_column(String(8))  # our entry's number
    entry: Mapped[dict] = mapped_column(JSON, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)


class SeasonRound(Base):
    """A round of a season and the event it is in the app."""
    __tablename__ = "season_rounds"
    id: Mapped[int] = mapped_column(primary_key=True)
    season_id: Mapped[int] = mapped_column(ForeignKey("seasons.id", ondelete="CASCADE"), index=True)
    order: Mapped[int] = mapped_column(Integer, default=0)  # place in the season, 1 first
    name: Mapped[str] = mapped_column(String(160))
    venue: Mapped[str | None] = mapped_column(String(255))
    start: Mapped[date | None] = mapped_column(Date)
    end: Mapped[date | None] = mapped_column(Date)
    round_id: Mapped[str | None] = mapped_column(String(40))  # the series site's id; null for a round typed in
    event_id: Mapped[int | None] = mapped_column(Integer, index=True)  # null until linked (or its event was deleted)
    plan_id: Mapped[int | None] = mapped_column(Integer)  # event_plans.id of its event
    made_event: Mapped[bool] = mapped_column(Boolean, default=False)  # the season made the event (not one there before)


class EventInfo(Base):
    """What an event was run with. A field left null comes from the season's entry."""
    __tablename__ = "event_info"
    id: Mapped[int] = mapped_column(primary_key=True)
    event_id: Mapped[int] = mapped_column(Integer, unique=True, index=True)
    season_id: Mapped[int | None] = mapped_column(Integer)
    tyre_kind_id: Mapped[int | None] = mapped_column(Integer)
    car_id: Mapped[int | None] = mapped_column(Integer)
    team_id: Mapped[int | None] = mapped_column(Integer)
    vehicle_model_id: Mapped[int | None] = mapped_column(Integer)
    drivers: Mapped[list | None] = mapped_column(JSON)  # driver ids, up to 4, in order
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now, onupdate=_now)


# ---------- event info: what an event was run with ----------

FIELDS = ("tyre_kind_id", "car_id", "team_id", "vehicle_model_id")


def _ids(value) -> list[int]:
    return [int(i) for i in (value or []) if isinstance(i, int) and not isinstance(i, bool)][:MAX_DRIVERS]


def own_info(db: Session, event_id: int) -> EventInfo | None:
    return db.scalar(select(EventInfo).where(EventInfo.event_id == event_id))


def season_of_event(db: Session, event_id: int, own: EventInfo | None = None) -> tuple[Season | None,
                                                                                         SeasonRound | None]:
    """The event's season: the one its info names, else the season with a round linked to it (the newest)."""
    rnd = db.scalars(select(SeasonRound).where(SeasonRound.event_id == event_id)
                     .order_by(SeasonRound.season_id.desc(), SeasonRound.id)).first()
    if own is not None and own.season_id is not None:
        season = db.get(Season, own.season_id)
        if season is not None:
            return season, rnd if rnd is not None and rnd.season_id == season.id else None
    if rnd is None:
        return None, None
    return db.get(Season, rnd.season_id), rnd


def _exists(db: Session, model, ident: int | None) -> int | None:
    return ident if ident is not None and db.get(model, ident) is not None else None


def _resolve(db: Session, event_id: int) -> dict:
    """Every field's id and where it came from: "event", "season", "runs" (the event's runs) or "car" (the car's
    team or vehicle)."""
    own = own_info(db, event_id)
    season, rnd = season_of_event(db, event_id, own)
    entry = season.entry or {} if season is not None else {}
    kinds = {"tyre_kind_id": catalog.TyreKind, "car_id": models.Car, "team_id": garage.Team,
             "vehicle_model_id": catalog.VehicleModel}
    ids: dict = {}
    came: dict = {}
    for f in FIELDS:
        for source, value in (("event", getattr(own, f, None)), ("season", entry.get(f))):
            if (found := _exists(db, kinds[f], value)) is not None:
                ids[f], came[f] = found, source
                break
        else:
            ids[f], came[f] = None, None
    drivers, came["drivers"] = [], None
    for source, value in (("event", own.drivers if own else None), ("season", entry.get("drivers"))):
        drivers = [d for d in _ids(value) if db.get(models.Driver, d) is not None]
        if drivers:
            came["drivers"] = source
            break
    runs = db.execute(select(models.RunSession.car_id, models.RunSession.driver_id)
                      .where(models.RunSession.event_id == event_id).order_by(models.RunSession.id)).all()
    if ids["car_id"] is None:
        cars = Counter(c for c, _ in runs if c is not None)
        if cars:
            ids["car_id"], came["car_id"] = cars.most_common(1)[0][0], "runs"
    if not drivers:
        drivers = list(dict.fromkeys(d for _, d in runs if d is not None))[:MAX_DRIVERS]
        came["drivers"] = "runs" if drivers else None
    ids["drivers"] = drivers
    if ids["car_id"] is not None:
        info = garage.car_info(db, ids["car_id"])
        if ids["team_id"] is None and info is not None and _exists(db, garage.Team, info.team_id) is not None:
            ids["team_id"], came["team_id"] = info.team_id, "car"
        if ids["vehicle_model_id"] is None and (vid := catalog.vehicle_of_car(db, ids["car_id"])) is not None:
            ids["vehicle_model_id"], came["vehicle_model_id"] = vid, "car"
    return {"ids": ids, "from": came, "own": own, "season": season, "round": rnd}


def _car(db: Session, car_id: int | None) -> dict | None:
    car = db.get(models.Car, car_id) if car_id is not None else None
    if car is None:
        return None
    info = garage.car_info(db, car.id)
    return {"id": car.id, "name": car.name, "number": info.number if info else None,
            "model": info.model if info else None}


def own_row(own: EventInfo | None) -> dict:
    return {"season_id": own.season_id if own else None, **{f: getattr(own, f, None) for f in FIELDS},
            "drivers": _ids(own.drivers) if own else []}


def entry_row(entry: dict | None) -> dict:
    entry = entry or {}
    return {**{f: entry.get(f) for f in FIELDS}, "drivers": _ids(entry.get("drivers"))}


def _previous(db: Session, event_id: int, car_id: int | None) -> dict | None:
    """What the latest earlier event with info of its own was run with: of the same car when the car is known."""
    ev = db.get(models.Event, event_id)
    rows = db.scalars(select(EventInfo).where(EventInfo.event_id != event_id)).all()
    events = {e.id: e for e in db.scalars(select(models.Event).where(
        models.Event.id.in_([r.event_id for r in rows])))} if rows else {}
    earlier = [e for e in events.values() if not (ev and ev.date and e.date and e.date > ev.date)]
    earlier.sort(key=lambda e: (e.date or date.min, e.id), reverse=True)
    for e in earlier[:MAX_LOOKBACK]:
        ids = _resolve(db, e.id)["ids"]
        if car_id is None or ids["car_id"] == car_id:
            return {"event_id": e.id, "event_name": e.name, **ids}
    return None


def info_for_event(db: Session, event_id: int, suggest: bool = False) -> dict:
    """What the event was run with (resolved: each field from the event, else its season, else its runs and car),
    what it sets itself (own), its season and the checklist of what is missing. With suggest, also what the
    previous event of the same car was run with (previous), to fill the event's form from."""
    r = _resolve(db, event_id)
    ids = r["ids"]
    tyre = db.get(catalog.TyreKind, ids["tyre_kind_id"]) if ids["tyre_kind_id"] is not None else None
    team = db.get(garage.Team, ids["team_id"]) if ids["team_id"] is not None else None
    vehicle = db.get(catalog.VehicleModel, ids["vehicle_model_id"]) if ids["vehicle_model_id"] is not None else None
    drivers = [{"id": d.id, "name": d.name} for i in ids["drivers"] if (d := db.get(models.Driver, i)) is not None]
    car = _car(db, ids["car_id"])
    missing = []
    if tyre is None or not (tyre.brand or "").strip():
        missing.append("tyre brand")
    if tyre is None or not (tyre.compound or "").strip():
        missing.append("compound")
    if car is None and vehicle is None:
        missing.append("car")
    if team is None:
        missing.append("team")
    if not drivers:
        missing.append("drivers")
    season, rnd = r["season"], r["round"]
    ev = db.get(models.Event, event_id)
    return {
        "event_id": event_id,
        "event_name": ev.name if ev is not None else None,
        "resolved": {
            "tyre_kind": catalog.tyre_row(tyre) if tyre is not None else None,
            "car": car,
            "team": {"id": team.id, "name": team.name} if team is not None else None,
            "vehicle_model": catalog.vehicle_row(vehicle) if vehicle is not None else None,
            "drivers": drivers,
        },
        "from": {"tyre_kind": r["from"]["tyre_kind_id"], "car": r["from"]["car_id"], "team": r["from"]["team_id"],
                 "vehicle_model": r["from"]["vehicle_model_id"], "drivers": r["from"]["drivers"]},
        "own": own_row(r["own"]),
        "season": None if season is None else {
            "id": season.id, "name": season.name, "series": season.series, "year": season.year,
            "car_number": season.car_number, "entry": entry_row(season.entry),
            "round": None if rnd is None else {"id": rnd.id, "order": rnd.order, "name": rnd.name}},
        "missing": missing,
        **({"previous": _previous(db, event_id, ids["car_id"])} if suggest else {}),
    }


def tyre_kind_for_session(db: Session, session_id: int) -> int | None:
    """The tyre a run was on: its event's (or the event's season's)."""
    s = db.get(models.RunSession, session_id)
    if s is None or s.event_id is None:
        return None
    return _resolve(db, s.event_id)["ids"]["tyre_kind_id"]


def vehicle_for_session(db: Session, session_id: int) -> int | None:
    """The vehicle a run was in: its car's, else its event's (set on the event, its season, or its car's)."""
    s = db.get(models.RunSession, session_id)
    if s is None:
        return None
    if (vid := catalog.vehicle_of_car(db, s.car_id)) is not None:
        return vid
    if s.event_id is None:
        return None
    return _resolve(db, s.event_id)["ids"]["vehicle_model_id"]


# ---------- seasons and their rounds ----------

def _round_row(r: SeasonRound, events: dict[int, models.Event], counts: dict[int, int]) -> dict:
    ev = events.get(r.event_id) if r.event_id is not None else None
    return {"id": r.id, "order": r.order, "name": r.name, "venue": r.venue,
            "start": r.start.isoformat() if r.start else None, "end": r.end.isoformat() if r.end else None,
            "round_id": r.round_id, "event_id": ev.id if ev else None, "event_name": ev.name if ev else None,
            "has_data": counts.get(ev.id, 0) > 0 if ev else False, "plan_id": r.plan_id if ev else None,
            "made_event": r.made_event if ev else False}


def rounds_of(db: Session, season_id: int) -> list[SeasonRound]:
    return list(db.scalars(select(SeasonRound).where(SeasonRound.season_id == season_id)
                           .order_by(SeasonRound.order, SeasonRound.start, SeasonRound.id)).all())


def season_row(db: Session, s: Season) -> dict:
    rounds = rounds_of(db, s.id)
    eids = sorted({r.event_id for r in rounds if r.event_id is not None})
    events = {e.id: e for e in db.scalars(select(models.Event).where(models.Event.id.in_(eids))).all()} if eids else {}
    counts = plans.session_counts(db, sorted(events))
    return {"id": s.id, "name": s.name, "series": s.series, "year": s.year, "car_number": s.car_number,
            "entry": entry_row(s.entry), "created_at": s.created_at.isoformat() if s.created_at else None,
            "rounds": [_round_row(r, events, counts) for r in rounds]}


def _event_alive(db: Session, r: SeasonRound) -> models.Event | None:
    return db.get(models.Event, r.event_id) if r.event_id is not None else None


def event_name(season: Season, round_name: str) -> str:
    """The name of the planned event a round makes: "Zandvoort · GT4 European Series 2026"."""
    return f"{round_name} · {season.name}"[:160]


def _attach(db: Session, season: Season, r: SeasonRound, taken: set[int], index) -> None:
    """Link a new round to an event already there on its days at its venue, else make its planned event."""
    ev = None
    if r.start is not None:
        probe = SimpleNamespace(start=r.start, end=r.end or r.start, location=r.venue, title=r.name)
        ev = index.match(probe, taken)
    if ev is not None:
        plans.ensure_plan(db, ev.id, r.venue)
        r.event_id, r.made_event = ev.id, False
    else:
        ev = plans.create(db, event_name(season, r.name), r.venue, r.start or r.end, r.end or r.start)
        ev.series = season.name[:80]
        r.event_id, r.made_event = ev.id, True
    db.flush()
    plan = plans.plan_of(db, ev.id)
    r.plan_id = plan.id if plan is not None else None
    taken.add(ev.id)


def _follow(db: Session, season: Season, r: SeasonRound, name: str, venue: str | None, start: date | None,
            end: date | None) -> None:
    """A round that changed changes the planned event the season made for it (days, venue, and its name unless
    renamed in the app); an event that was there before is left as it is."""
    ev = _event_alive(db, r)
    if ev is not None and r.made_event:
        if (start, end) != (r.start, r.end) and (start or end):
            plans.set_days(db, ev, start or end, end or start)
        if name != r.name and ev.name == event_name(season, r.name):
            ev.name = event_name(season, name)
        if venue != r.venue:
            plan = plans.plan_of(db, ev.id)
            if plan is not None and plan.venue == r.venue:
                plan.venue = venue
    r.name, r.venue, r.start, r.end = name, venue, start, end


def _let_go(db: Session, r: SeasonRound) -> bool:
    """Forget a round: the planned event the season made for it goes when it has no data and no calendar entry
    holds it. Whether an event went."""
    ev = _event_alive(db, r)
    db.delete(r)
    if ev is None or not r.made_event or plans.has_data(db, ev.id):
        return False
    if db.scalar(select(models.CalendarEntry.id).where(models.CalendarEntry.event_id == ev.id)) is not None:
        return False
    if db.scalar(select(SeasonRound.id).where(SeasonRound.event_id == ev.id, SeasonRound.id != r.id)) is not None:
        return False
    db.execute(delete(EventInfo).where(EventInfo.event_id == ev.id))
    plans.remove(db, ev)
    return True


class RoundIn(BaseModel):
    name: str = Field(min_length=1, max_length=160)
    venue: str | None = Field(None, max_length=255)
    start: date | None = None
    end: date | None = None
    round_id: str | None = Field(None, max_length=40)
    order: int | None = Field(None, ge=0, le=1000)


def set_rounds(db: Session, season: Season, incoming: list[RoundIn]) -> int:
    """Make the season's rounds these: a round is the same as one already there with the same site id, else the
    same name; new rounds get their event, changed ones change the planned event made for them, rounds no longer
    listed go (with the planned event made for them, when it has no data). The caller holds calendar_sync._lock and
    commits. How many planned events went."""
    have = rounds_of(db, season.id)
    used: set[int] = set()
    pairs: list[tuple[RoundIn, SeasonRound | None]] = []
    for rin in incoming:
        rid = (rin.round_id or "").strip() or None
        row = next((r for r in have if r.id not in used and rid and r.round_id == rid), None)
        if row is None:
            row = next((r for r in have if r.id not in used and r.name.strip().lower() == rin.name.strip().lower()
                        and (not rid or not r.round_id)), None)
        if row is not None:
            used.add(row.id)
        pairs.append((rin, row))
    gone = sum(_let_go(db, r) for r in have if r.id not in used)
    db.flush()
    taken = {r.event_id for r in have if r.id in used and r.event_id is not None}
    index = None
    for i, (rin, row) in enumerate(pairs):
        name, venue = rin.name.strip()[:160], (rin.venue or "").strip()[:255] or None
        start, end = rin.start or rin.end, rin.end or rin.start
        order = rin.order if rin.order is not None else i + 1
        rid = (rin.round_id or "").strip() or None
        if row is not None:
            _follow(db, season, row, name, venue, start, end)
            row.order, row.round_id = order, rid or row.round_id
            continue
        row = SeasonRound(season_id=season.id, order=order, name=name, venue=venue, start=start, end=end,
                          round_id=rid)
        db.add(row)
        db.flush()
        index = index or calendar_sync._Events(db)
        _attach(db, season, row, taken, index)
    db.flush()
    return gone


class EntryIn(BaseModel):
    car_id: int | None = None
    team_id: int | None = None
    vehicle_model_id: int | None = None
    tyre_kind_id: int | None = None
    drivers: list[int] = Field(default_factory=list, max_length=MAX_DRIVERS)


class SeasonIn(BaseModel):
    """Only the fields sent change (a new season needs a name and a year). rounds, when sent, are the season's
    rounds from now on."""
    name: str | None = Field(None, min_length=1, max_length=160)
    series: str | None = Field(None, max_length=40)
    year: int | None = Field(None, ge=1950, le=2100)
    car_number: str | None = Field(None, max_length=8)
    entry: EntryIn | None = None
    rounds: list[RoundIn] | None = Field(None, max_length=MAX_ROUNDS)


def _check(db: Session, *, car_id=None, team_id=None, vehicle_model_id=None, tyre_kind_id=None,
           drivers=None) -> None:
    for ident, model, what in ((car_id, models.Car, "Car"), (team_id, garage.Team, "Team"),
                               (vehicle_model_id, catalog.VehicleModel, "Vehicle"),
                               (tyre_kind_id, catalog.TyreKind, "Tyre")):
        if ident is not None and db.get(model, ident) is None:
            raise HTTPException(404, f"{what} not found")
    for d in drivers or []:
        if db.get(models.Driver, d) is None:
            raise HTTPException(404, f"Driver not found: {d}")


def _check_rounds(rounds: list[RoundIn] | None) -> None:
    for r in rounds or []:
        if r.start and r.end and r.end < r.start:
            raise HTTPException(422, f"{r.name}: the last day is before the first day")


def _entry(body: EntryIn) -> dict:
    return {"car_id": body.car_id, "team_id": body.team_id, "vehicle_model_id": body.vehicle_model_id,
            "tyre_kind_id": body.tyre_kind_id, "drivers": list(dict.fromkeys(body.drivers))[:MAX_DRIVERS]}


def _season(db: Session, season_id: int) -> Season:
    s = db.get(Season, season_id)
    if s is None:
        raise HTTPException(404, "Season not found")
    return s


def _save(db: Session, s: Season, body: SeasonIn) -> dict:
    sent = body.model_fields_set
    new = s.id is None
    if new and not ((body.name or "").strip() and body.year is not None):
        raise HTTPException(422, "Give the season a name and a year")
    if "name" in sent:
        name = (body.name or "").strip()
        if not name:
            raise HTTPException(422, "Give the season a name")
        s.name = name
    if "series" in sent:
        s.series = (body.series or "").strip() or None
    if "year" in sent and body.year is not None:
        s.year = body.year
    if "car_number" in sent:
        s.car_number = (body.car_number or "").strip() or None
    if body.entry is not None:
        _check(db, **body.entry.model_dump())
        s.entry = _entry(body.entry)
    elif new:
        s.entry = _entry(EntryIn())
    _check_rounds(body.rounds)
    gone = 0
    with calendar_sync._lock:
        if new:
            db.add(s)
            db.flush()
        if body.rounds is not None:
            gone = set_rounds(db, s, body.rounds)
        db.commit()
    return {**season_row(db, s), "events_removed": gone}


router = APIRouter()


@router.get("/seasons")
def list_seasons(db: Session = Depends(get_db)):
    """Every season, newest year first, with its rounds."""
    rows = db.scalars(select(Season).order_by(Season.year.desc(), Season.name, Season.id)).all()
    return [season_row(db, s) for s in rows]


@router.post("/seasons", status_code=201)
def create_season(body: SeasonIn, db: Session = Depends(get_db)):
    """A new season; its rounds (when sent) become planned events, or are linked to the events already there."""
    return _save(db, Season(), body)


@router.get("/seasons/{season_id}")
def get_season(season_id: int, db: Session = Depends(get_db)):
    return season_row(db, _season(db, season_id))


@router.put("/seasons/{season_id}")
def update_season(season_id: int, body: SeasonIn, db: Session = Depends(get_db)):
    return _save(db, _season(db, season_id), body)


@router.delete("/seasons/{season_id}")
def delete_season(season_id: int, db: Session = Depends(get_db)):
    """Delete a season: the planned events it made that have no data go; events with data stay, without a season."""
    s = _season(db, season_id)
    with calendar_sync._lock:
        gone = sum(_let_go(db, r) for r in rounds_of(db, s.id))
        db.execute(update(EventInfo).where(EventInfo.season_id == s.id).values(season_id=None))
        db.delete(s)
        db.commit()
    return {"deleted": season_id, "events_removed": gone}


# ---------- our entry from the series' entry list ----------

class EntryRowIn(BaseModel):
    """Our car's row on a round's entry list (GET /results/entries)."""
    car_number: str | None = Field(None, max_length=8)
    drivers: list[str] = Field(default_factory=list, max_length=10)
    team: str | None = Field(None, max_length=200)  # as the entry list writes it; a garage team keeps 120 characters
    car_model: str | None = Field(None, max_length=200)


def _words(text: str | None) -> set[str]:
    return set(plans._plain(text).split())


def _driver_named(db: Session, name: str) -> models.Driver:
    """The garage's driver of that name (whatever its capitals), else the only one whose name is part of it or the
    other way round ("Gabriele" for "Gabriele Rossi"), else a new driver."""
    found = garage.find_driver(db, name)
    if found is not None:
        return found
    words = _words(name)
    like = [d for d in db.scalars(select(models.Driver)).all()
            if (w := _words(d.name)) and words and (w <= words or words <= w)]
    if len(like) == 1:
        return like[0]
    d = models.Driver(name=name[:120])
    db.add(d)
    db.flush()
    return d


def _team_named(db: Session, name: str) -> garage.Team:
    name = name[:120]
    same = select(garage.Team).where(func.lower(garage.Team.name) == name.lower()).order_by(garage.Team.id)
    t = db.scalars(same).first()
    if t is None:
        t = garage.Team(name=name)
        db.add(t)
        db.flush()
    return t


def _vehicle_like(db: Session, car_model: str) -> int | None:
    """The only vehicle named like the entry list's car model ("BMW M4 GT4 EVO" for "BMW M4 GT4 Evo (G82)")."""
    words = _words(car_model)
    like = [v.id for v in db.scalars(select(catalog.VehicleModel)).all()
            if (w := _words(v.name)) and words and (words <= w or w <= words)]
    return like[0] if len(like) == 1 else None


def fill_entry(db: Session, s: Season, row: EntryRowIn) -> list[str]:
    """Fill what our entry leaves blank from our car's row on the entry list: the drivers and team (found in the
    garage by name, else added), the car (the garage car with our number) and the vehicle (the one named like the
    row's car model). What is set already stays. What was filled."""
    entry = entry_row(s.entry)
    filled = []
    names = [n.strip() for n in row.drivers if n and n.strip()][:MAX_DRIVERS]
    if not entry["drivers"] and names:
        entry["drivers"] = list(dict.fromkeys(_driver_named(db, n).id for n in names))
        filled.append("drivers")
    if entry["team_id"] is None and (row.team or "").strip():
        entry["team_id"] = _team_named(db, row.team.strip()).id
        filled.append("team")
    number = (row.car_number or s.car_number or "").strip()
    if entry["car_id"] is None and number:
        car_id = db.scalar(select(garage.CarInfo.car_id).where(garage.CarInfo.number == number)
                           .order_by(garage.CarInfo.id))
        if car_id is not None:
            entry["car_id"] = car_id
            filled.append("car")
    if entry["vehicle_model_id"] is None and (row.car_model or "").strip():
        if (vid := _vehicle_like(db, row.car_model)) is not None:
            entry["vehicle_model_id"] = vid
            filled.append("vehicle")
    s.entry = entry
    if not s.car_number and number:
        s.car_number = number[:8]
    return filled


@router.post("/seasons/{season_id}/fill-entry")
def fill_season_entry(season_id: int, body: EntryRowIn, db: Session = Depends(get_db)):
    """Our entry's blanks filled from our car's row on a round's entry list."""
    s = _season(db, season_id)
    filled = fill_entry(db, s, body)
    db.commit()
    return {**season_row(db, s), "filled": filled}


# ---------- event info API ----------

class InfoIn(BaseModel):
    """Only the fields sent change; null (or no drivers) means: take it from the season."""
    season_id: int | None = None
    tyre_kind_id: int | None = None
    car_id: int | None = None
    team_id: int | None = None
    vehicle_model_id: int | None = None
    drivers: list[int] | None = Field(None, max_length=MAX_DRIVERS)


def _event(db: Session, event_id: int) -> models.Event:
    ev = db.get(models.Event, event_id)
    if ev is None:
        raise HTTPException(404, "Event not found")
    return ev


@router.get("/events/{event_id}/info")
def get_event_info(event_id: int, db: Session = Depends(get_db)):
    """What the event was run with, the checklist of what is missing, and what the previous event of the same car
    was run with (to fill the form from)."""
    _event(db, event_id)
    return info_for_event(db, event_id, suggest=True)


@router.get("/event-info/for-runs")
def info_for_runs(ids: str = Query(max_length=6000), db: Session = Depends(get_db)):
    """The event info of the events these runs are in (e.g. the runs an upload just made), each event once."""
    try:
        run_ids = [int(x) for x in ids.split(",") if x.strip()][:MAX_RUNS]
    except ValueError:
        raise HTTPException(422, "ids is a comma separated list of run ids") from None
    found = db.execute(select(models.RunSession.id, models.RunSession.event_id)
                       .where(models.RunSession.id.in_(run_ids))).all() if run_ids else []
    of = dict(found)
    events = list(dict.fromkeys(of[i] for i in run_ids if of.get(i) is not None))
    return [info_for_event(db, eid, suggest=True) for eid in events if db.get(models.Event, eid) is not None]


@router.put("/events/{event_id}/info")
def put_event_info(event_id: int, body: InfoIn, db: Session = Depends(get_db)):
    """Set what the event was run with (tyre, car, team, vehicle, drivers 1 to 4, its season)."""
    _event(db, event_id)
    sent = body.model_fields_set
    _check(db, **{f: getattr(body, f) for f in FIELDS}, drivers=body.drivers)
    if body.season_id is not None:
        _season(db, body.season_id)
    own = own_info(db, event_id)
    if own is None:
        own = EventInfo(event_id=event_id)
        db.add(own)
    for f in ("season_id", *FIELDS):
        if f in sent:
            setattr(own, f, getattr(body, f))
    if "drivers" in sent:
        own.drivers = list(dict.fromkeys(body.drivers or []))[:MAX_DRIVERS] or None
    db.commit()
    return info_for_event(db, event_id)


def bind_models() -> None:
    """Put this module's tables, and catalog.py's, on the current database's metadata. The tests load a fresh app.db
    for every test; the server loads it once, so this does nothing there."""
    import importlib
    import sys

    from app import db

    for name in ("app.catalog", "app.seasons"):
        module = sys.modules[name]
        if module.Base is not db.Base:
            importlib.reload(module)
