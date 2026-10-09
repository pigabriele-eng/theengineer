"""Who drove qualifying and the races, from the series' qualifying order (Gabriele, 2026-10-09: "ADAC GT4 Q1 always
PIA, Q2 always SYL"; Hockenheim 2026: "3 qualifying sessions Q1/Q3 PIA and Q2 SYL and 3 races R1/R3 PIA starts, R2 SYL
starts"), and the runs asked about one by one when two drivers drive too alike to tell apart."""
import time
from datetime import datetime

import numpy as np

from app import models, quali_order
from app.analysis import driver_style as ds
from app.results import models as rm
from app.results import run_names
from tests.test_driver_style import _event, _weekend
from tests.test_run_names import _round

PIA, SYL = 1, 2


def test_odd_sessions_are_the_first_driver_s_and_the_other_driver_takes_over_after_the_stop():
    order = (PIA, SYL)
    assert [quali_order.driver_of(c, None, order) for c in ("Q1", "Q2", "Q3")] == \
        [(PIA, "quali"), (SYL, "quali"), (PIA, "quali")]
    assert [quali_order.driver_of(c, s, order)[0] for c in ("R1", "R2", "R3") for s in (1, 2)] == \
        [PIA, SYL, SYL, PIA, PIA, SYL]
    assert quali_order.driver_of("R1", None, order) is None  # a race run whose stint isn't known
    assert quali_order.driver_of("FP1", 1, order) is None and quali_order.driver_of(None, None, order) is None

    def run(name):
        return models.RunSession(id=1, name=name)

    # the timetable's naming first, else the name: typed ones too
    assert quali_order.session_of(run("R2 stint 1"), rm.RunNameMark(code="R2")) == ("R2", 1)
    assert quali_order.session_of(run("Quali 3"), None) == ("Q3", None)
    assert quali_order.session_of(run("Race 1 stint 2"), None) == ("R1", 2)
    assert quali_order.session_of(run("My Q run"), rm.RunNameMark(code="Q2", by_hand=True)) == ("Q2", None)
    assert quali_order.session_of(run("Q 004"), None) == (None, None)  # a logger's session number, not Q4


def test_naming_follows_the_order_with_three_qualifyings():
    # Hockenheim 2026: Q2 and Q3 on the Sunday morning, one download after both
    table = run_names.timetable(_round(("Q1", "2026-09-19T11:15:00"), ("Q2", "2026-09-20T09:00:00"),
                                       ("Q3", "2026-09-20T09:30:00")))
    t = datetime(2026, 9, 20, 10, 5)
    a, b = models.RunSession(id=1, driver_id=PIA), models.RunSession(id=2, driver_id=SYL)
    order = {1: (t, 0), 2: (t, 400)}
    moves, ask = run_names._quali_per_driver([a, b], {1: "Q2", 2: "Q2"}, order, table, set(), None, (PIA, SYL))
    assert moves == {1: "Q3"} and ask == {}  # PIA ran first, but Q2 is SYL's
    # the drivers the app set don't count: the run that ran first takes the first session
    hide = {1: None, 2: None}
    assert run_names._quali_per_driver([a, b], {1: "Q2", 2: "Q2"}, order, table, set(), hide, (PIA, SYL)) == \
        ({2: "Q3"}, {})
    # a run asked about between three: told by its driver only when one fits
    asks = {1: ["Q1", "Q2", "Q3"], 2: ["Q1", "Q2", "Q3"]}
    assert run_names._by_driver([a, b], {}, asks, order, None, (PIA, SYL)) == {2: "Q2"}  # PIA: Q1 or Q3, asked


def test_alike_drivers_are_not_told_apart_by_their_style():
    # two drivers of one style: their tagged laps separate no better than chance
    ep = ds.event_print(_event([(1, ["smooth"] * 6), (2, ["smooth"] * 6), (3, ["smooth"] * 5), (4, ["sharp"] * 5)]))
    g = ds.guess(ep, {1: 11, 2: 22})
    assert g.mode == "alike" and [grp.driver_id for grp in g.groups] == [11, 22]
    assert all(ds.confidence(g, g.groups[s.group], s.share) == "likely" for s in g.sessions)
    # two styles: as before
    ep = ds.event_print(_event([(1, ["smooth"] * 6), (2, ["sharp"] * 6), (3, ["smooth"] * 5)]))
    assert ds.guess(ep, {1: 11, 2: 22}).mode == "tagged"


def _adac(client, names=("Gabriele Piana", "Tom Sylt"), series="adac-gt4-germany"):
    drivers = [client.post("/garage/drivers", json={"name": n}).json()["id"] for n in names]
    season = client.post("/seasons", json={"name": "ADAC GT4 Germany 2026", "series": series, "year": 2026,
                                           "entry": {"drivers": drivers}}).json()
    ev = client.post("/events/folders", json={"name": "Hockenheim"}).json()
    assert client.put(f"/events/{ev['id']}/info", json={"season_id": season["id"]}).status_code == 200
    return ev["id"], drivers


def test_q_and_race_runs_get_their_drivers_from_the_order(client):
    from app import driver_prints
    from app.db import SessionLocal

    ev, (pia, syl) = _adac(client)
    names = ["FP1 stint 1", "Q1", "Q2", "Q3", "R1 stint 1", "R1 stint 2", "R2 stint 1", "R2 stint 2", "R3 stint 1"]
    ids = {n: client.post("/sessions", json={"event_id": ev, "name": n}).json()["id"] for n in names}
    with SessionLocal() as db:
        assert quali_order.order_for(db, ev) == (pia, syl)
        assert quali_order.apply(db, ev) == 8
        db.commit()
        got = {n: db.get(models.RunSession, i).driver_id for n, i in ids.items()}
        assert got == {"FP1 stint 1": None, "Q1": pia, "Q2": syl, "Q3": pia, "R1 stint 1": pia, "R1 stint 2": syl,
                       "R2 stint 1": syl, "R2 stint 2": pia, "R3 stint 1": pia}
        tags = driver_prints.set_by_style(db, list(ids.values()))
        assert tags[ids["Q2"]].source == "quali" and tags[ids["R2 stint 1"]].source == "race"
        # they teach and anchor the style like a person's tags; the style's own guesses don't
        sids = [ids["Q1"], ids["FP1 stint 1"]]
        ep = ds.EventPrint(sids, [1, 1], [100.0, 100.0], [], np.zeros((2, 0)), [], np.zeros((2, 0)))
        assert driver_prints.tags_of(db, ep) == {ids["Q1"]: pia, ids["FP1 stint 1"]: None}
        assert quali_order.apply(db, ev) == 0  # nothing new

    # a person's pick stands; a run renamed out of the races goes back to the style
    assert client.put(f"/sessions/{ids['Q2']}/driver", json={"driver_id": pia}).status_code == 200
    assert client.patch(f"/sessions/{ids['R3 stint 1']}", json={"name": "Shakedown"}).status_code == 200
    with SessionLocal() as db:
        assert quali_order.apply(db, ev) in (0, 1)  # 0 when the background pass (driver_prints) got there first
        db.commit()
        assert db.get(models.RunSession, ids["Q2"]).driver_id == pia
        assert db.get(models.RunSession, ids["R3 stint 1"]).driver_id is None
        assert ids["R3 stint 1"] not in driver_prints.set_by_style(db, [ids["R3 stint 1"]])


def test_no_order_without_both_drivers_or_outside_the_adac(client):
    from app.db import SessionLocal

    other, _ = _adac(client, ("Gabriele Piana", "Ben Rackl"))
    euro, _ = _adac(client, ("Gabi Piana", "Tim Sylt"), series="gt4-europe")
    client.post("/sessions", json={"event_id": other, "name": "Q1"})
    with SessionLocal() as db:
        assert quali_order.order_for(db, other) is None and quali_order.order_for(db, euro) is None
        assert quali_order.apply(db, other) == 0


def test_alike_drivers_runs_are_asked_one_by_one(client, monkeypatch):
    from app import driver_prints
    from app.routers import reports

    smooth, sharp = (1.0, 0.99, 0.995, 0.985, 0.99), (0.99, 0.985, 0.99, 0.98, 0.995)
    w = _weekend(client, "Weekend", {"A1": (smooth, False), "B1": (sharp, True), "A2": (smooth, False),
                                     "B2": (sharp, True)}, 10)
    t0, url = time.monotonic(), f"/events/{w['event']}/driver-guess"
    while client.get(url).json()["status"] == "working" and time.monotonic() - t0 < 120:
        time.sleep(0.2)
    assert reports.wait_idle()
    for run, driver in (("A1", "Anna"), ("B1", "Ben")):
        assert client.put(f"/sessions/{w[run]}/driver", json={"driver_name": driver}).status_code == 200
    driver_prints.wait_idle()
    got = {s["session_id"]: s for s in client.get(f"/events/{w['event']}/driver-guess").json()["sessions"]}
    assert got[w["A2"]]["auto"]["source"] == "tag" and got[w["B2"]]["auto"]["source"] == "tag"

    # the same, but the two drive too alike to tell apart: the style's drivers are taken back, and asked run by run
    monkeypatch.setattr(ds, "told_apart", lambda *a: False)
    driver_prints.refresh_in_background()
    driver_prints.wait_idle()
    body = client.get(f"/events/{w['event']}/driver-guess").json()
    assert body["mode"] == "alike"
    got = {s["session_id"]: s for s in body["sessions"]}
    assert got[w["A2"]]["driver_id"] is None and got[w["B2"]]["driver_id"] is None
    assert got[w["A2"]]["suggestion"]["driver"] is None and got[w["A1"]]["driver_id"] is not None
    (q,) = client.get("/season-match/pending", params={"event_id": w["event"]}).json()["questions"]
    assert q["prompt"] == "Who drove A2?" and q["runs"] == 1  # the first of them to run
    assert q["why"].startswith("Anna and Ben drive too alike here")
    ben = next(o for o in q["options"] if o["label"] == "Ben")
    assert client.post(f"/season-match/{q['id']}", json={"answer": ben["key"]}).status_code == 200
    driver_prints.wait_idle()
    (q,) = client.get("/season-match/pending", params={"event_id": w["event"]}).json()["questions"]
    assert q["prompt"] == "Who drove B2?"
