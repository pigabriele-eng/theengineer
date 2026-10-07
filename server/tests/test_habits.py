"""Driver habits: each driver's recurring technique mistakes over every event, getting better or worse."""
from datetime import date

import numpy as np
import pytest

from app.analysis import driver_style as ds
from app.analysis import habit_track as ht

SECTIONS = [{"code": "T1", "start_m": 0, "end_m": 400, "apex_m": 200},
            {"code": "T2", "start_m": 400, "end_m": 800, "apex_m": 600},
            {"code": "T3", "start_m": 800, "end_m": 1000, "apex_m": None}]


def _m(kind: str, code: str, cost: float = 0.1, phase: str = "exit") -> dict:
    return {"key": f"{code}:{kind}", "kind": kind, "code": code, "phase": phase, "cost_s": cost}


def _lap(session_id: int, obvious: list[dict], perfect: list[dict] | None = None, key: str = "") -> dict:
    """A checked lap: its obvious mistakes, and the pieces of its gap to the perfect lap (which never count)."""
    return {"key": key or f"{session_id}:{len(obvious)}", "session_id": session_id, "mistakes": perfect or [],
            "obvious": obvious, "time": 90.0}


def test_corner_types_come_from_the_slowest_point():
    speed = [150.0] * 41 + [80.0] + [150.0] * 79 + [130.0] + [200.0] * 80  # every 5 m
    types = ht.section_types(SECTIONS, speed, 5)
    assert types == {"T1": "slow", "T2": "medium", "T3": "flat"}
    assert ht.section_types(SECTIONS, None, 5) == {}
    assert [ht.corner_type(v) for v in (99, 100, 150, 151, None)] == ["slow", "medium", "medium", "fast", "flat"]


def test_one_kind_at_one_corner_counts_once_and_only_obvious_mistakes_count():
    res = {"sections": SECTIONS, "laps": [
        _lap(1, [_m("exit_lift", "T1", 0.2), _m("exit_lift", "T1", 0.3), _m("on_off_throttle", "T1", 0.25)],
             [_m("min_speed", "T3", 0.5, "mid-corner")]),  # a piece of the gap to the perfect lap: left out
        _lap(1, [_m("brake_early", "T2", 0.1, "braking")]),
        _lap(2, [_m("exit_lift", "T2", 0.4)]),
        _lap(9, [_m("exit_lift", "T2", 0.4)]),  # a run nobody is named for: left out
    ]}
    t = ht.tally_event(res, {1: 11, 2: 22}, {"T1": "slow", "T2": "fast", "T3": "flat"})
    assert set(t) == {11, 22}
    a = t[11]
    assert a.laps == 2 and a.passes == 6
    assert a.hits["exit_lift"] == 1 and a.cost["exit_lift"] == pytest.approx(0.3)
    # two throttle findings at T1 on one lap: one corner pass of the throttle group, at the larger cost
    assert a.group_hits["throttle"] == 1 and a.group_cost["throttle"] == pytest.approx(0.3)
    assert a.group_hits["braking"] == 1
    assert a.type_hits == {"slow": 1, "fast": 1} and a.type_passes["slow"] == 2
    assert t[22].hits["exit_lift"] == 1
    assert "min_speed" not in a.hits


def test_a_habit_getting_better_worse_or_the_same():
    better = ht.trend([(60, 300, "Zandvoort"), (24, 300, "Misano")])
    assert better["dir"] == "better"
    assert better["words"] == "Better: from 20% of corners at Zandvoort to 8% at Misano."
    worse = ht.trend([(15, 300, "Paul Ricard"), (18, 300, "Monza"), (36, 300, "Spa")])
    assert worse["dir"] == "worse" and "at Paul Ricard to 9% at Monza and Spa" in worse["words"]
    assert ht.trend([(30, 300, "A"), (33, 300, "B")])["dir"] == "steady"
    assert ht.trend([(30, 300, "A")]) is None
    # small rates: a change of less than two corners in a hundred is the same
    assert ht.trend([(4, 300, "A"), (0, 300, "B")])["dir"] == "steady"
    # a big change on a few corners is luck, not a trend; on a handful there's too little to say
    assert ht.trend([(3, 40, "A"), (0, 40, "B")])["dir"] == "steady"
    assert ht.trend([(4, 12, "A"), (0, 12, "B")]) is None


def test_corner_types_count_only_corners_where_the_mistakes_cost():
    res = {"sections": SECTIONS, "laps": [
        _lap(1, [_m("exit_lift", "T1", 0.04), _m("brake_early", "T1", 0.07, "braking"), _m("lift", "T2", 0.03)]),
    ]}
    t = ht.tally_event(res, {1: 11}, {"T1": "slow", "T2": "fast", "T3": "flat"})[11]
    assert t.type_hits == {"slow": 1}  # 0.11 s at T1; 0.03 s at T2 is the small stuff every lap has
    assert t.type_cost["slow"] == pytest.approx(0.11) and t.type_cost["fast"] == pytest.approx(0.03)


def _events() -> list[ht.Event]:
    types = {"T1": "slow", "T2": "fast", "T3": "flat"}
    first = {"sections": SECTIONS, "laps":
             [_lap(1, [_m("exit_lift", "T1")]) for _ in range(12)] + [_lap(2, []) for _ in range(12)]}
    second = {"sections": SECTIONS, "laps":
              [_lap(3, []) for _ in range(10)] + [_lap(3, [_m("exit_lift", "T1")]) for _ in range(2)] +
              [_lap(4, [_m("late_shift", "T2", 0.05)]) for _ in range(12)]}
    drivers = {1: 11, 2: 22, 3: 11, 4: 22}
    return [ht.Event(1, "Zandvoort", ht.tally_event(first, drivers, types)),
            ht.Event(2, "Misano", ht.tally_event(second, drivers, types))]


def test_the_tracker_follows_each_driver_over_the_events():
    out = ht.tracker(_events(), {11: "Gabriele Piana", 22: "Max Rackl"}, {11: "PIA", 22: "RAC"},
                     {1: "Zandvoort", 2: "Misano"})
    assert [d["code"] for d in out["drivers"]] == ["PIA", "RAC"]
    assert out["drivers"][0]["laps"] == 24 and out["drivers"][0]["events"] == 2
    lift = next(h for h in out["habits"] if h["kind"] == "exit_lift")
    pia = lift["drivers"]["11"]
    assert lift["label"] == "Lifting on the way out" and lift["group"] == "throttle" and lift["do"]
    assert pia["rate"] == pytest.approx(14 / 72, abs=1e-4)
    assert pia["trend"]["dir"] == "better"  # every lap at Zandvoort, one in six at Misano
    assert [e["event_id"] for e in pia["by_event"]] == [1, 2]
    assert pia["corners"][0] == {"code": "T1", "event_id": 1, "track": "Zandvoort", "rate": 1.0}
    assert pia["types"]["slow"] == pytest.approx(14 / 24, abs=1e-4)
    assert lift["drivers"]["22"]["rate"] == 0.0
    shift = next(h for h in out["habits"] if h["kind"] == "late_shift")
    assert shift["group"] == "shifting" and shift["drivers"]["22"]["trend"]["dir"] == "worse"
    groups = {g["key"]: g for g in out["groups"]}
    assert list(groups) == ["braking", "corner", "throttle", "shifting"]
    assert groups["throttle"]["drivers"]["11"]["rate"] == pia["rate"]
    assert {t["key"] for t in out["corner_types"]} == {"slow", "fast", "flat"}
    # most costly first
    assert out["habits"][0]["kind"] == "exit_lift"


def test_two_drivers_styles_differ_the_same_way_every_time():
    kinds = list(ds.KINDS)
    a = {k: 0.0 for k in kinds} | {"brake_on": 0.8, "coast": -0.5}
    b = {k: 0.0 for k in kinds} | {"brake_on": -0.8, "coast": 0.5}
    styles = {1: {11: a, 22: b}, 2: {11: a | {"coast": 0.6}, 22: b | {"coast": -0.6}}}
    (pair,) = ht.style_pairs(styles, [22, 11])
    assert (pair["a"], pair["b"], pair["events"]) == (11, 22, 2)
    by = {t["kind"]: t for t in pair["traits"]}
    assert by["brake_on"]["words"] == "brakes later" and by["brake_on"]["words_b"] == "brakes earlier"
    assert by["brake_on"]["agree"] == 2 and by["brake_on"]["group"] == "braking"
    assert "coast" not in by  # one way at one event, the other way at the next


def test_the_habits_page(client):
    from app import models
    from app.db import SessionLocal

    def event(name: str, day: str, runs: list[str]) -> tuple[int, list[int]]:
        with SessionLocal() as db:
            ev = models.Event(name=name, track=models.Track(name=name.split()[0]), date=date.fromisoformat(day))
            db.add(ev)
            db.flush()
            ids = []
            for i, driver in enumerate(runs):
                d = db.query(models.Driver).filter_by(name=driver).first() or models.Driver(name=driver)
                s = models.RunSession(event_id=ev.id, name=f"Run {i + 1}", driver=d)
                db.add(s)
                db.flush()
                ids.append(s.id)
            db.commit()
            return ev.id, ids

    def checked(event_id: int, laps: list[dict], status: str = "done") -> None:
        with SessionLocal() as db:
            db.add(models.TechniqueCache(scope=f"event:{event_id}", signature="s", status=status,
                                         result={"sections": SECTIONS, "laps": laps, "reference": None},
                                         result_signature=f"r{event_id}"))
            db.commit()

    later, (c, d) = event("Misano 2026", "2026-09-20", ["Gabriele Piana", "Max Rackl"])
    early, (a, b) = event("Zandvoort 2026", "2026-06-10", ["Gabriele Piana", "Max Rackl"])
    checked(early, [_lap(a, [_m("exit_lift", "T1")]) for _ in range(12)] + [_lap(b, []) for _ in range(12)])
    checked(later, [_lap(c, []) for _ in range(12)] + [_lap(d, [_m("exit_lift", "T2")]) for _ in range(12)])

    body = client.get("/drivers/habits").json()
    assert body["status"] == "ready" and body["checking"] == []
    assert [e["name"] for e in body["events"]] == ["Zandvoort 2026", "Misano 2026"]  # oldest first
    assert body["events"][0]["track"] == "Zandvoort" and body["events"][0]["date"] == "2026-06-10"
    codes = {x["code"]: str(x["id"]) for x in body["drivers"]}
    lift = next(h for h in body["habits"] if h["kind"] == "exit_lift")
    assert lift["drivers"][codes["PIA"]]["trend"]["dir"] == "better"
    assert lift["drivers"][codes["RAC"]]["trend"]["dir"] == "worse"
    assert client.get("/drivers/habits").json() == body  # kept

    # a driver changed: worked out again
    assert client.put(f"/sessions/{d}/driver", json={"driver_name": "Gabriele Piana"}).status_code == 200
    body = client.get("/drivers/habits").json()
    lift = next(h for h in body["habits"] if h["kind"] == "exit_lift")
    assert lift["drivers"][codes["PIA"]]["by_event"][-1]["rate"] == pytest.approx(12 / 72, abs=1e-4)

    # a check still being worked out says so
    third, _ = event("Spa 2026", "2026-07-01", ["Max Rackl"])
    with SessionLocal() as db:
        db.add(models.TechniqueCache(scope=f"event:{third}", signature="s", status="running"))
        db.commit()
    body = client.get("/drivers/habits").json()
    assert body["status"] == "checking" and body["checking"] == ["Spa 2026"]


def test_no_checks_yet(client):
    body = client.get("/drivers/habits").json()
    assert body["drivers"] == [] and body["habits"] == [] and body["events"] == [] and body["pairs"] == []
    assert np.isfinite(len(body["groups"]))
