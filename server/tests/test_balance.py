"""Car balance and setup direction: the understeer angle, the time split and the advice, on synthetic data."""
import math

import numpy as np
import pytest

from app.analysis.balance import (
    HOCKENHEIM_STEERING_RATIO,
    Geometry,
    balance_channel,
    car_geometry,
    throttle_lifts,
)
from app.analysis.channels import math_channels
from app.analysis.setup_advice import advise, bar_model, car_limits, describe, where_car_loses
from app.vehicle.presets import preset_detail
from app.vehicle.tyre_fit import NotEnoughData
from tests.test_vehicle import CAR, FRONT, REAR, _inverse, bicycle_session

LEVELS = (0.35, 0.5, 0.65, 0.8, 0.95, 1.1, 1.2, 1.28, 1.34, 1.37)  # bicycle_session's corners, 3 speeds each
SPEEDS = 3
BLOCK = 900  # samples per corner: 3 s straight, 1 s turn-in, 4 s holding, 1 s unwinding


def _session(**kw):
    data = bicycle_session(**kw)
    math_channels(data)
    return data


def _geometry(ratio: float | None = 15.0) -> Geometry:
    return Geometry(CAR["wheelbase_mm"], "test car", "published", ratio, "test car" if ratio else "none",
                    "published" if ratio else "unknown")


def _held(us: np.ndarray, level_index: int, speed_index: int) -> float:
    """The understeer angle in the middle of a corner's steady hold."""
    start = (level_index * SPEEDS + speed_index) * BLOCK
    return float(np.median(us[start + 500:start + 750]))


def _truth(level: float) -> float:
    """In a steady corner the understeer angle is front slip minus rear slip (delta - L / R = alpha_f - alpha_r)."""
    return math.degrees(_inverse(FRONT, level) - _inverse(REAR, level))


@pytest.fixture(scope="module")
def bicycle():
    return _session()


def test_understeer_angle_matches_the_bicycle_model(bicycle):
    info = balance_channel(bicycle, _geometry())
    assert info["yaw_scale"] == pytest.approx(1 / 0.9, abs=0.01)  # the gyro reads 10 % low: found and corrected
    assert info["steering"]["ratio"] == 15.0 and info["steering"]["confidence"] == "published"
    us = bicycle.channels["understeer"]
    for li, level in enumerate(LEVELS):
        for si in range(SPEEDS):
            # signed by the turn: positive although the corners alternate left and right; without the gyro
            # correction the hardest corners would read up to 0.3 degrees too much understeer
            assert _held(us, li, si) == pytest.approx(_truth(level), abs=0.05)


def test_logged_road_wheel_angle_is_used_and_its_ratio_measured():
    data = _session()
    data.channels["steer"] = data.channels["steer_wheel"] / 15.0  # a logger recording the road wheel angle too
    info = balance_channel(data, _geometry(None))
    assert info["steering"]["ratio"] == pytest.approx(15.0, abs=0.1)
    assert info["steering"]["confidence"] == "measured"
    assert _held(data.channels["understeer"], 5, 1) == pytest.approx(_truth(LEVELS[5]), abs=0.05)


def test_without_a_ratio_the_hockenheim_value_is_used_and_flagged_as_an_estimate():
    data = _session()
    info = balance_channel(data, _geometry(None))
    assert info["steering"] == {"ratio": HOCKENHEIM_STEERING_RATIO, "confidence": "estimate",
                                "source": "the BMW M4 GT4 value measured at Hockenheim (no ratio in the car data)"}
    # the logged ratio is 15, so the estimate reads the steering 4 % short: less understeer than the truth
    assert _held(data.channels["understeer"], 9, 0) < _truth(LEVELS[9]) - 0.1


def test_a_single_steering_channel_is_told_apart_by_its_size():
    wheel = _session()
    wheel.channels["steer"] = wheel.channels.pop("steer_wheel")  # the only channel, and it is a steering wheel
    assert balance_channel(wheel, _geometry(None))["steering"]["confidence"] == "estimate"
    road = _session()
    road.channels["steer"] = road.channels.pop("steer_wheel") / 15.0  # the only channel is a road wheel angle
    info = balance_channel(road, _geometry(None))
    assert info["steering"]["confidence"] == "measured" and info["steering"]["ratio"] is None
    assert _held(road.channels["understeer"], 5, 1) == pytest.approx(_truth(LEVELS[5]), abs=0.05)


def test_no_yaw_rate_means_no_balance():
    data = _session()
    del data.channels["yaw"]
    with pytest.raises(NotEnoughData):
        balance_channel(data, _geometry())


def test_car_geometry_from_the_preset_or_the_fallback():
    bmw = car_geometry(preset_detail("bmw-m4-gt4-evo"))
    assert bmw.wheelbase_mm == 2857 and bmw.wheelbase_confidence == "published"
    assert bmw.steering_ratio is None and bmw.ratio_confidence == "unknown"  # not published for this car
    none = car_geometry(None)
    assert none.wheelbase_mm == 2857 and none.wheelbase_confidence == "estimate"


def test_throttle_lifts():
    assert throttle_lifts(np.array([0, 50, 100, 100, 70, 100, 100, 30, 40, 100])) == 2
    assert throttle_lifts(np.array([0, 100, 85, 100, 90, 100])) == 0  # small corrections are not lifts
    assert throttle_lifts(np.array([10, 15, 0, 5])) == 0  # never on the throttle


def test_describe_thresholds():
    assert describe(None) is None
    assert describe(0.2) == {"kind": "normal", "strength": None}
    assert describe(0.3) == {"kind": "understeer", "strength": "slight"}
    assert describe(-0.8) == {"kind": "oversteer", "strength": "clear"}
    assert describe(1.6) == {"kind": "understeer", "strength": "strong"}


# ---------- the advice, on analyse()-shaped results ----------

def _row(code, min_speed, entry=None, mid=None, exit_=None, car=0.0, where="exit", tc=0.0, slip=3.0, brake=None):
    phases = {"braking": 0.0, "trail": 0.0, "mid": 0.0, "exit": 0.0, "power": 0.0}
    phases[where] = car
    bal = {p: {"value": v, "quick": None, "laps": 10} for p, v in (("entry", entry), ("mid", mid), ("exit", exit_))
           if v is not None}
    return {"code": code, "min_speed_kmh": min_speed, "balance": bal, "car": car, "driving": 0.05, "optimism": 0.1,
            "car_by_phase": phases, "tc_s": {"typical": tc, "quick": tc}, "rear_slip_exit": {"typical": slip,
            "quick": slip}, "peak_brake": brake, "min_speed": {"typical": min_speed, "quick": min_speed + 1},
            "held_grip": None}


def _analysis(sections, table, tc_per_lap=0.5, spread=0.5):
    return {"reference": {"run": "Run 1", "lap": 3, "time": 100.0}, "laps": 20, "held_share": 0.95,
            "ideal_lap": 99.4, "held_lap": 98.9, "theoretical_lap": 98.0,
            "gradient": {"per_g": 1.0, "fit_slope": 2.0, "fit_offset": -1.0, "by_g": [], "spread": spread,
                         "notes": [], "table": [{"speed": s, "range_kmh": [0, 1], "entry": e, "mid": m, "exit": x}
                                                for s, e, m, x in table]},
            "diagnostics": {"traction_control_s_per_lap": tc_per_lap, "abs_share_of_braking": 0.3,
                            "tyres": {"temperature": {"fl": 90, "fr": 92, "rl": 66, "rr": 70,
                                                      "front_minus_rear": 23}}},
            "sections": sections, "focus": None}


def test_power_oversteer_asks_for_a_softer_rear_bar_first():
    a = _analysis([_row("T6", 70, mid=2.0, exit_=-1.2, car=0.13, tc=0.8, slip=11),
                   _row("T8/T9", 75, mid=1.5, exit_=0.1, car=0.05, tc=0.6),
                   _row("T15-T17", 108, mid=0.7, exit_=-0.4, car=0.29, tc=1.3)],
                  [("slow", 0.2, 1.5, -0.3), ("medium", 0.1, 0.4, 0.0), ("fast", 0.0, 0.3, 0.2)], tc_per_lap=5.9)
    adv = advise(a, bar_model("bmw-m4-gt4-evo"))
    assert adv["headline"].startswith("One weakness runs through the data: the rear won't take power")
    assert "softer on the rear anti-roll bar" in adv["headline"]
    keys = [r["key"] for r in adv["recommendations"]]
    assert keys[:2] == ["rear_bar_softer", "rear_bump_softer"]
    assert "rear_wing" in keys  # T15-T17 is a fast exit where the car loses on the throttle
    assert keys[-1] == "front_grip_slow"  # the slow corners push mid-corner: camber or toe, not the front bar
    rear = adv["recommendations"][0]
    assert rear["sections"][0] == "T6"
    assert "0.47 s on the throttle" in rear["expect"]
    model = rear["model"]
    assert (model["from"], model["to"]) == (3, 2)
    assert model["llt_front_share"][1] > model["llt_front_share"][0]  # softer rear: load transfer moves forward
    labels = {c["label"]: c["value"] for c in adv["checks"]}
    assert labels["Traction control per lap"] == "5.9 s"
    assert labels["Rear wheel slip out of T6"] == "11 %"


def test_a_neutral_car_gets_no_setup_change():
    a = _analysis([_row("T1", 80, entry=0.1, mid=0.2, exit_=-0.1), _row("T2", 150, entry=0.0, mid=0.1, exit_=0.1)],
                  [("slow", 0.1, 0.2, -0.1), ("medium", 0.0, 0.1, 0.1), ("fast", None, None, None)])
    adv = advise(a, bar_model("bmw-m4-gt4-evo"))
    assert adv["recommendations"] == []
    assert adv["headline"].startswith("No part of the corner stands out")


def test_entry_understeer_moves_the_brake_balance_rearward():
    a = _analysis([_row("T1", 80, entry=1.3, mid=0.2, exit_=0.0)],
                  [("slow", 1.2, 0.2, 0.0), ("medium", 0.2, 0.1, 0.0), ("fast", None, None, None)])
    adv = advise(a, bar_model("bmw-m4-gt4-evo"))
    assert [r["key"] for r in adv["recommendations"]] == ["brake_bias_rear"]
    assert "rearward on the brake balance" in adv["headline"]


def test_braking_where_the_quickest_passes_brake_harder_is_no_setup_change():
    brake = {"typical": 90.0, "quick": 97.0}
    a = _analysis([_row("T2-T5", 76, car=0.15, where="braking", brake=brake),
                   _row("T6", 49, car=0.13, where="trail", brake=brake)],
                  [("slow", 0.1, 0.2, 0.0), ("medium", None, None, None), ("fast", None, None, None)])
    notes = advise(a, bar_model(None))["notes"]
    assert notes == ["Brakes need no setup change. Into T2-T5 and T6 the car's share is in the braking, but the "
                     "quickest passes there use 7 bar more pressure: the time is in how hard the pedal goes on. ABS "
                     "works in 30 % of all braking."]


def test_no_balance_still_gives_the_time_split():
    a = _analysis([_row("T1", 80)], [])
    a["gradient"] = None
    adv = advise(a, bar_model(None))
    assert "can't be read" in adv["headline"] and adv["recommendations"] == []


def test_bar_model_needs_a_preset():
    assert bar_model(None)("rear", -1) is None
    assert bar_model("bmw-m4-gt4-evo")("rear", -5) is None  # no setting that soft


def test_car_limits_split_the_lap():
    a = _analysis([_row("T1", 80, car=0.2, where="braking"), _row("T2", 120, car=-0.05), _row("T3", 90, car=0.01)],
                  [])
    out = car_limits(a)
    assert out["lap"] == {"reference": 100.0, "ideal": 99.4, "held": 98.9, "theoretical": 98.0, "driving": 0.6,
                          "car": 0.5, "optimism": 0.9}
    assert [s["car"] for s in out["sections"]] == [0.2, 0.0, 0.01]  # beating the target is not a car loss
    assert [s["where"] for s in out["sections"]] == ["braking", None, None]  # too small to say where
    assert out["total_car"] == 0.21
    assert "2.00 s off the theoretical lap: 0.60 s is driving" in out["text"]
    assert "In T2 the quickest passes already beat the 95 % target." in out["text"]


def test_where_the_car_loses_groups_the_phases():
    row = _row("T1", 80)
    row["car_by_phase"] = {"braking": 0.02, "trail": 0.03, "mid": 0.01, "exit": 0.01, "power": 0.0}
    assert where_car_loses(row) == "braking"
    row["car_by_phase"] = {"braking": 0.0, "trail": 0.0, "mid": 0.0, "exit": 0.01, "power": 0.0}
    assert where_car_loses(row) is None


# ---------- the endpoint ----------

def _upload(client, name, event_id, paces):
    from tests.synthetic import simulate, write_ld

    s = client.post("/sessions", json={"name": name, "event_id": event_id}).json()
    r = client.post(f"/sessions/{s['id']}/files", files={"file": (f"{name}.ld", write_ld(simulate(paces)[0]))})
    assert r.status_code == 201, r.text
    return s["id"]


def test_balance_endpoint_for_a_session_and_an_event(client):
    import app.routers.balance as router

    track = client.post("/tracks", json={"name": "Test Track", "corners": [
        {"code": "T1", "apex_m": 300.0}, {"code": "T2", "apex_m": 700.0}]}).json()
    event = client.post("/events", json={"name": "Test day", "track_id": track["id"]}).json()
    first = _upload(client, "Run 1", event["id"], (0.97, 1.0, 0.98))
    _upload(client, "Run 2", event["id"], (0.95, 0.96, 0.97))

    one = client.get(f"/report/balance?session={first}")
    assert one.status_code == 200, one.text
    body = one.json()
    assert body["scope"] == {"kind": "session", "id": first, "name": "Run 1", "track": "Test Track"}
    assert body["laps"] == 3
    assert [s["code"] for s in body["car_limits"]["sections"]] == ["T1", "T2"]  # official numbers, never names
    assert body["method"]["steering_ratio"]["confidence"] == "estimate"  # one channel and no ratio for this car
    for key in ("headline", "recommendations", "notes", "balance", "checks"):
        assert key in body

    ev = client.get(f"/report/balance?event={event['id']}").json()
    assert ev["scope"]["kind"] == "event" and ev["laps"] == 6
    assert [s["name"] for s in ev["sessions"]] == ["Run 1", "Run 2"]  # the quickest first: its fastest lap is the line
    assert ev["reference"]["run"] == "Run 1" and ev["reference"]["lap"] == 2
    assert len(router._cache) == 2
    assert client.get(f"/report/balance?event={event['id']}").json() == ev  # served from the cache
    assert len(router._cache) == 2

    assert client.get("/report/balance").status_code == 422
    assert client.get(f"/report/balance?session={first}&event={event['id']}").status_code == 422
    assert client.get("/report/balance?event=999").status_code == 404
    assert client.get("/report/balance?session=999").status_code == 404
    empty = client.post("/events", json={"name": "Nothing yet"}).json()
    assert client.get(f"/report/balance?event={empty['id']}").status_code == 422


def test_an_unreadable_log_is_left_out_of_an_event(client, monkeypatch):
    import app.routers.balance as router

    event = client.post("/events", json={"name": "Test day"}).json()
    _upload(client, "Good", event["id"], (0.97, 1.0, 0.98))
    broken = _upload(client, "Broken", event["id"], (0.99, 1.0, 0.98))  # the quickest run, read first
    real = router.load_main_file

    def flaky(db, s):
        if s.name == "Broken":
            raise ValueError("bad log")
        return real(db, s)

    monkeypatch.setattr(router, "load_main_file", flaky)
    body = client.get(f"/report/balance?event={event['id']}").json()
    assert body["laps"] == 3 and body["reference"]["run"] == "Good"
    assert {"name": "Broken", "session_id": broken, "laps": 0, "note": "Could not read the log; left out"} in \
        body["sessions"]
    with pytest.raises(ValueError):  # one session asked for on its own: the error is not hidden
        client.get(f"/report/balance?session={broken}")


def test_the_report_is_built_under_the_shared_log_lock_and_served_from_cache_without_it(client, monkeypatch):
    import threading

    import app.routers.balance as router
    from app import heavy

    event = client.post("/events", json={"name": "Test day"}).json()
    _upload(client, "Run 1", event["id"], (0.97, 1.0, 0.98))
    held: list[bool] = []
    real = router._build

    def probe():  # from another thread: is the shared lock taken?
        got = heavy.lock.acquire(blocking=False)
        if got:
            heavy.lock.release()
        held.append(not got)

    def spy(*args, **kwargs):
        t = threading.Thread(target=probe)
        t.start()
        t.join()
        return real(*args, **kwargs)

    monkeypatch.setattr(router, "_build", spy)
    assert client.get(f"/report/balance?event={event['id']}").status_code == 200
    assert held == [True]
    with heavy.lock:  # another job is reading a log: a cached report doesn't wait for it
        done = []
        t = threading.Thread(target=lambda: done.append(client.get(f"/report/balance?event={event['id']}")))
        t.start()
        t.join(timeout=10)
        assert done and done[0].status_code == 200
    assert held == [True]
