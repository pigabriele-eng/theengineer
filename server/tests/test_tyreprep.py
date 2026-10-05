"""Tyre and qualifying preparation on synthetic logs: the 1 km circle of tests/synthetic.py driven at 10 Hz with
TPMS readings that warm lap by lap."""
from itertools import pairwise

import numpy as np
import pytest

from app.analysis import tyreprep as tp
from app.analysis.laps import Lap
from tests.synthetic import ORIGIN, TRACK_M, speed_at, write_ld

HZ = tp.HZ
AMBIENT = 20.0
COLD_BAR = {"front": 1.30, "rear": 1.25}
DRAG_M = ((380, 620), (780, 1000))  # the straights at the out-lap's pace (the fast lap's straights are inside)
WEAVE_M = ((430, 570), (830, 970))
HARD_M = ((495, 508), (895, 908))


def _in(d: np.ndarray, spans) -> np.ndarray:
    return np.any([(d >= a) & (d < b) for a, b in spans], axis=0)


def lap(pace, front=0.0, rear=0.0, clean=True, drag=False, weave=False, hard=False):
    """One lap at a pace (1.0 the quickest); front and rear: °C the TPMS gains over it."""
    return {"lap": pace, "front": front, "rear": rear, "clean": clean, "drag": drag, "weave": weave, "hard": hard}


def stand(seconds, bleed=0.0, cool=0.0):
    """Standing at the line (the pit box): bleed lets this much air out of every tyre, cool drops the temps."""
    return {"stand": seconds, "bleed": bleed, "cool": cool}


def drive(plan, fr_offset=0.0):
    """A 10 Hz session: {role: array} as log_channels gives it, the laps between line crossings (the first lap
    starts at the first crossing), and the S/F marker. fr_offset: the front-right reads this much warmer."""
    rows = {k: [] for k in ("d", "v", "front", "rear", "bleed", "drag", "weave", "hard")}
    temps = {"front": AMBIENT, "rear": AMBIENT}
    bleed, crossings, flags, out_of_garage = 0.0, [], [], True
    for step in plan:
        if "stand" in step:
            n = round(step["stand"] * HZ)
            for axle in temps:
                temps[axle] -= step["cool"]
            bleed += step["bleed"]
            d = np.full(n, TRACK_M)
            v = np.zeros(n)
            seg = {"front": np.full(n, temps["front"]), "rear": np.full(n, temps["rear"])}
        else:
            if not out_of_garage:  # every lap but the very first starts at the line
                crossings.append(len(rows["d"]))
                flags.append(step["clean"])
            out_of_garage = False
            ds, x = [], 0.0
            while x < TRACK_M:
                ds.append(x)
                x += float(speed_at(np.array([x]), step["lap"])[0]) / 3.6 / HZ
            d = np.array(ds)
            v = speed_at(d, step["lap"])
            ramp = np.linspace(0, 1, len(d), endpoint=False)
            seg = {axle: temps[axle] + step[axle] * ramp for axle in temps}
            for axle in temps:
                temps[axle] += step[axle]
        rows["d"].extend(d)
        rows["v"].extend(v)
        for axle in temps:
            rows[axle].extend(seg[axle])
        rows["bleed"].extend([bleed] * len(d))
        for k in ("drag", "weave", "hard"):
            rows[k].extend(_in(d, {"drag": DRAG_M, "weave": WEAVE_M, "hard": HARD_M}[k]) & bool(step.get(k)))
    a = {k: np.array(v, float) for k, v in rows.items()}
    n = len(a["d"])
    t = np.arange(n) / HZ
    accel = np.gradient(a["v"]) * HZ
    brake = np.clip(-accel - 2, 0, None) * 2.5
    brake = np.where(a["drag"] > 0, np.maximum(brake, 6.0), brake)
    brake = np.where(a["hard"] > 0, 60.0, brake)
    throttle = np.where((accel >= 0) | (a["drag"] > 0), 100.0, 0.0)
    throttle[a["v"] == 0] = 0.0
    steer = np.clip(150 - speed_at(a["d"], 1.0), 0, None) * 2 + a["weave"] * 40 * np.sin(2 * np.pi * t)
    r = TRACK_M / (2 * np.pi)
    ang = 2 * np.pi * a["d"] / TRACK_M
    lat = ORIGIN[0] + np.degrees((r - r * np.cos(ang)) / 6_371_000.0)
    lon = ORIGIN[1] + np.degrees(r * np.sin(ang) / (6_371_000.0 * np.cos(np.radians(ORIGIN[0]))))
    ch = {"t": t, "speed": a["v"], "brake": brake, "throttle": throttle, "steer": steer, "lat": lat, "lon": lon,
          "brake_levels": np.array([tp.DRAG_BAR, tp.BRAKING_BAR, tp.HARD_STOP_BAR])}
    for w in ("FL", "FR", "RL", "RR"):
        axle = "front" if w[0] == "F" else "rear"
        temp = a[axle] + (fr_offset if w == "FR" else 0.0)
        ch[f"tyre_t_{w.lower()}"] = temp
        ch[f"tyre_p_{w.lower()}"] = COLD_BAR[axle] * (temp + 273.15) / (AMBIENT + 273.15) - a["bleed"]
    laps = [Lap(number=k + 1, start=c0 / HZ, end=c1 / HZ, time=round((c1 - c0) / HZ, 3), clean=flags[k])
            for k, (c0, c1) in enumerate(pairwise(crossings))]
    marker = np.zeros(n)
    for c in crossings:
        marker[c:c + HZ // 2] = 1.0
    return ch, laps, marker


# A quali sim from cold with the brakes dragged, hard stops and weaving on the out-lap, then a pit stop to bleed
# the pressures and a long run on the same, now warm, tyres.
QUALI_THEN_LONG = [
    stand(60),
    lap(0.6, 12, 6, clean=False, drag=True, weave=True, hard=True), lap(0.6, 12, 6, clean=False, drag=True),
    lap(0.97, 15, 10), lap(0.985, 15, 10), lap(1.0, 10, 8), lap(0.995, 3, 3),
    lap(0.6, -5, -3, clean=False), stand(60, bleed=0.1),
    lap(0.6, 2, 1, clean=False),
    *[lap(0.99 - 0.002 * k, 0.5, 0.3) for k in range(8)],
    lap(0.6, -5, -3, clean=False), stand(20),
]
# A quali sim from cold with nothing done on the out-lap: the tyres come in later.
QUALI_SLOW_WARM = [
    stand(60),
    lap(0.6, 5, 2.5, clean=False), lap(0.6, 5, 2.5, clean=False),
    lap(0.95, 12, 8), lap(0.97, 12, 8), lap(0.98, 12, 8), lap(0.985, 12, 8), lap(0.998, 6, 5), lap(0.997, 2, 2),
    lap(0.6, -5, -3, clean=False), stand(20),
]


def _reduced(plan, name, day="03/07/2026", sid=1, **kw):
    ch, laps, _ = drive(plan, **kw)
    out = tp.reduce_session(ch, laps, AMBIENT)
    out.update(session_id=sid, name=name, day=day)
    return out, ch, laps


def test_pivots_and_events():
    x = np.array([0, 5, 10, 5, 0, 5, 10, 9, 10, 0], float)
    # four swings of 6 or more, each marked where it started; the 10-9-10 wiggle is smaller than a swing
    assert tp._pivots(x, 6) == [0, 2, 4, 6]
    assert tp._pivots(x, 20) == []
    mask = np.zeros(100, bool)
    mask[[10, 11, 12, 25, 26, 50]] = True  # more than a second apart: separate applications
    assert tp._events(mask) == 3
    assert tp._events(np.zeros(5, bool)) == 0


def test_tpms_drops_wake_readings_and_marks_sleep():
    t = np.arange(0, 60, 1 / HZ)
    ct = np.concatenate([np.arange(0, 20, 1.0), np.arange(40, 60, 1.0)])  # asleep from 20 s to 40 s
    cv = np.full(len(ct), 50.0)
    cv[:3] = -33.0  # a waking sensor
    v = tp._tpms("tyre_t_fl", ct, cv, t)
    assert np.isnan(v[(t > 26) & (t < 34)]).all()
    assert np.nanmin(v) == 50.0
    cv[3] = 5.0  # its first reading: a glitch that lasts one sample
    cv[20] = 90.0  # the first after the sleep: a glitch too
    v = tp._tpms("tyre_t_fl", ct, cv, t)
    assert np.nanmin(v) == 50.0 and np.nanmax(v) == 50.0
    kpa = tp._tpms("tyre_p_fl", ct, np.full(len(ct), 180.0), t)
    assert np.nanmax(kpa) == pytest.approx(1.8)


def test_bleed_kind():
    assert tp._bleed_kind({"FL": -0.1, "FR": -0.08, "RL": 0.0, "RR": -0.01}) == "bled"
    assert tp._bleed_kind({"FL": -0.3, "FR": -0.4, "RL": -0.3, "RR": -0.35}) == "changed"
    assert tp._bleed_kind({"FL": 0.01, "FR": -0.02, "RL": 0.0, "RR": None}) == "none"
    assert tp._bleed_kind(None) is None


def test_reduce_finds_runs_warm_up_work_and_bleed():
    s, _, laps = _reduced(QUALI_THEN_LONG, "Q1")
    assert s["has_tpms"] and s["has_map"]
    assert s["best"] == min(l.time for l in laps if l.clean)
    assert len(s["runs"]) == 2
    quali, long = s["runs"]
    assert [f["n"] for f in quali["flying"]] == [2, 3, 4, 5]  # lap 1 is the second warm-up lap
    warm = quali["warm"]
    assert warm["laps"] == 2
    assert 30 <= warm["drag_s"] <= 42  # 460 m a lap at 90 km/h with the brakes on against the throttle
    assert warm["straight_hard_stops"] == 2
    assert warm["weaves"] >= 10  # 1 Hz swings over 280 m of straight
    assert quali["pre_warmed"] is False
    assert quali["bleed"]["FL"] == pytest.approx(-0.1, abs=0.01)
    assert quali["stop_after_s"] == pytest.approx(60, abs=1)
    # the long run's out-lap did nothing special, and its tyres were still warm
    assert long["pre_warmed"] is True
    assert long["warm"]["straight_hard_stops"] == 0
    assert long["warm"]["weaves"] <= 2
    # the long run is a stint with a trend; the quali sim is too short for one
    assert [st["flying"] for st in s["stints"]] == [8]


def test_reduce_reads_the_line_and_axle_average():
    s, *_ = _reduced(QUALI_THEN_LONG, "Q1", fr_offset=4.0)
    first = s["runs"][0]["flying"][0]
    # the warm-up laps added 24 °C to the fronts and the front-right reads 4 °C warmer: axle average 46
    assert tp._axle(first["line"]["t"], "front") == pytest.approx(AMBIENT + 24 + 2, abs=0.6)
    assert tp._axle({"FL": 50.0, "FR": None}, "front") == 50.0  # a sensor that hasn't woken is left out


def test_aggregate_quali_sims_push_ready_and_brake_work():
    a, *_ = _reduced(QUALI_THEN_LONG, "Q1", sid=1)
    b, *_ = _reduced(QUALI_SLOW_WARM, "Q2", sid=2)
    r = tp.aggregate([a, b])
    sims = {s["label"]: s for s in r["sims"]}
    assert set(sims) == {"Q1 run 1", "Q2"}
    q1, q2 = sims["Q1 run 1"], sims["Q2"]
    assert q1["kind"] == "quali" and q2["kind"] == "quali"
    assert q1["cold_start"] and q2["cold_start"]
    assert (q1["peak_lap"], q1["peak_flying"]) == (4, 3)
    assert q2["peak_flying"] == 5
    # the near-best laps (within 0.3 s of the day's best) started from these temperatures at the line
    near = [p for p in r["sims"][0]["points"] + r["sims"][1]["points"] if p["gap"] <= tp.PUSH_GAP_S]
    assert r["push"]["front_c"] == min(p["front"] for p in near)
    assert r["push"]["rear_c"] == min(p["rear"] for p in near)
    assert r["push"]["front_c"] == pytest.approx(AMBIENT + 24 + 15 + 15, abs=1)  # Q1's peak lap started there
    # Q1 got there sooner (it worked the brakes and weaved on its out-lap)
    assert q1["ready_min"] < q2["ready_min"]
    assert r["fastest"]["best"]["label"] == "Q1 run 1"
    assert r["brake_work"]["most"]["label"] == "Q1 run 1"
    assert r["brake_work"]["saved_min"] == pytest.approx(q2["ready_min"] - q1["ready_min"])
    assert q1["hold"]["laps"] == 2  # its peak lap and the one after, within 0.4 s
    assert q1["bleed_kind"] == "bled"
    assert r["build"]["warm_lap"]["front_c"] == pytest.approx((12 + 5) / 2, abs=1.5)  # a warm-up lap's gain
    advice = {x["key"]: x["text"] for x in r["advice"]}
    assert next(iter(advice)) == "plan"
    assert "Warm up like Q1 run 1" in advice["plan"]
    assert {"push", "ready", "build", "brakes", "window", "fade"} <= set(advice)


def test_aggregate_windows_and_long_runs():
    a, *_ = _reduced(QUALI_THEN_LONG, "Q1", sid=1)
    r = tp.aggregate([a])
    w = r["windows"]
    assert w["laps"] >= tp.MIN_WINDOW_LAPS
    fl = w["tyres"]["FL"]
    assert fl["p"][0] <= fl["p"][1] <= fl["p"][2]
    assert fl["t"][0] <= fl["t"][1] <= fl["t"][2]
    assert len(r["long_runs"]) == 1
    lr = r["long_runs"][0]
    assert lr["flying"] == 8
    assert lr["fade"]["per_lap"] > 0  # each lap of the long run 0.2 % slower than the last
    # no pressure runs given: the cold pressures can't be learned yet, and the advice says so
    assert r["cold"]["tyres"][0]["cold_bar"] is None
    assert any(x["key"] == "cold" for x in r["advice"])


def test_no_quali_run_and_no_tpms():
    long_only = [stand(60), lap(0.6, 30, 20, clean=False), *[lap(0.99, 1, 1) for _ in range(7)],
                 lap(0.6, clean=False), stand(20)]
    s, *_ = _reduced(long_only, "L1")
    r = tp.aggregate([s])
    assert r["sims"] == [] and r["push"] is None
    assert r["advice"][0]["key"] == "no_sims"
    ch, laps, _ = drive(long_only)
    for k in [k for k in ch if k.startswith("tyre_")]:
        del ch[k]
    s = tp.reduce_session(ch, laps, AMBIENT)
    s.update(session_id=1, name="L1", day="")
    r = tp.aggregate([s])
    assert [x["key"] for x in r["advice"]] == ["no_tpms"]


def _ld(plan) -> bytes:
    ch, _, marker = drive(plan)
    names = {"speed": ("vCar", "km/h"), "brake": ("pBrakeF", "bar"), "throttle": ("rThrottlePedal", "%"),
             "steer": ("aSteer", "deg"), "lat": ("GPS Latitude", "deg"), "lon": ("GPS Longitude", "deg")}
    channels = {name: (HZ, unit, ch[role]) for role, (name, unit) in names.items()}
    for w in ("FL", "FR", "RL", "RR"):
        channels[f"pTyre{w}"] = (HZ, "bar", ch[f"tyre_p_{w.lower()}"])
        channels[f"TTyre{w}"] = (HZ, "C", ch[f"tyre_t_{w.lower()}"])
    channels["S/F Marker"] = (HZ, "", marker)
    return write_ld(channels)


def test_report_endpoint(client, monkeypatch):
    from app import heavy
    from app.routers import tyreprep

    ev = client.post("/events", json={"name": "Test day", "series": "GT4 Germany"}).json()
    ids = []
    for name, plan in (("Q1", QUALI_THEN_LONG), ("Q2", QUALI_SLOW_WARM)):
        s = client.post("/sessions", json={"name": name, "kind": "test", "event_id": ev["id"]}).json()
        r = client.post(f"/sessions/{s['id']}/files", files={"file": (f"{name}.ld", _ld(plan))})
        assert r.status_code == 201, r.text
        ids.append(s["id"])
    locked = []  # every log is read holding the server-wide lock: one log in memory at a time
    read = tyreprep.read_file
    monkeypatch.setattr(tyreprep, "read_file", lambda f: locked.append(heavy.lock._is_owned()) or read(f))
    r = client.get(f"/report/tyre-prep?event={ev['id']}")
    assert r.status_code == 200, r.text
    assert locked == [True, True]
    rep = r.json()
    assert rep["scope"]["event"] == ev["id"]
    assert [s["name"] for s in rep["sessions"]] == ["Q1", "Q2"]
    assert {s["label"] for s in rep["sims"]} == {"Q1 run 1", "Q2"}
    assert rep["fastest"]["best"]["label"] == "Q1 run 1"
    assert rep["advice"][0]["key"] == "plan"
    assert "axle_c" not in rep["sims"][0]
    one = client.get(f"/report/tyre-prep?session={ids[1]}").json()
    assert [s["label"] for s in one["sims"]] == ["Q2"]
    assert client.get(f"/report/tyre-prep?event={ev['id']}").json() == rep  # from the cache: the same
    assert client.get("/report/tyre-prep").status_code == 422
    assert client.get(f"/report/tyre-prep?session={ids[0]}&event={ev['id']}").status_code == 422
    assert client.get("/report/tyre-prep?event=999").status_code == 404
    assert client.get("/report/tyre-prep?session=999").status_code == 404
    empty = client.post("/sessions", json={"name": "Empty", "kind": "test"}).json()
    assert client.get(f"/report/tyre-prep?session={empty['id']}").status_code == 404
    # a log the analysis trips on leaves its session out of the event, not the whole report
    s = client.post("/sessions", json={"name": "Q3", "kind": "test", "event_id": ev["id"]}).json()
    client.post(f"/sessions/{s['id']}/files", files={"file": ("Q3.ld", _ld(QUALI_SLOW_WARM))})

    def trips(*_):
        raise RuntimeError("unexpected")

    monkeypatch.setattr(tyreprep, "log_channels", trips)
    r = client.get(f"/report/tyre-prep?event={ev['id']}")
    assert r.status_code == 200
    assert [x["session"] for x in r.json()["skipped"]] == ["Q3"]
