import math
from functools import cache

import numpy as np
import pytest

from app.analysis.laps import MASTER_HZ, SessionData
from app.vehicle.model import Change, Vehicle, compute, what_if
from app.vehicle.presets import preset_vehicle
from app.vehicle.tyre_fit import NotEnoughData, fit_tyres, magic_formula

G = 9.81

# A simple car for hand calculation: 1000 kg, 50 % front, 2.5 m wheelbase, 1.5 m tracks, CoG 500 mm,
# front spring 100 N/mm at MR 0.8 (wheel rate 64 N/mm) and a 20 N/mm bar at MR 1 (40 N/mm at the wheel in roll),
# rear spring 80 N/mm at MR 1, no rear bar, tyres 256 N/mm, roll centres on the ground, no unsprung mass.
TEXTBOOK = dict(mass_kg=1000, front_weight_fraction=0.5, cog_height_mm=500, wheelbase_mm=2500, track_front_mm=1500,
                track_rear_mm=1500, spring_front_n_per_mm=100, spring_mr_front=0.8, arb_front_n_per_mm=20,
                spring_rear_n_per_mm=80, tyre_vertical_front_n_per_mm=256, tyre_vertical_rear_n_per_mm=256,
                braking_g=1.5)


def test_ride_frequency_textbook_case():
    res = compute(Vehicle(**TEXTBOOK))
    front, rear = res["axles"]["front"], res["axles"]["rear"]
    assert front["wheel_rate_n_per_mm"] == pytest.approx(64.0)
    # ride rate 64 * 256 / (64 + 256) = 51.2 N/mm on 250 kg: sqrt(51200 / 250) / 2 pi = 2.2776 Hz
    assert front["ride_rate_n_per_mm"] == pytest.approx(51.2)
    assert front["ride_frequency_hz"] == pytest.approx(2.2776, abs=1e-3)
    # rear: 80 * 256 / 336 = 60.95 N/mm: 2.4851 Hz; the bar does not act in heave
    assert rear["ride_frequency_hz"] == pytest.approx(2.4851, abs=1e-3)
    assert res["ride_frequency_ratio"] == pytest.approx(2.4851 / 2.2776, abs=1e-3)


def test_roll_stiffness_distribution_and_load_transfer_textbook_case():
    res = compute(Vehicle(**TEXTBOOK))
    front, rear = res["axles"]["front"], res["axles"]["rear"]
    # front: (64 + 40) kN/m * 1.5^2 / 2 = 117000 Nm/rad, in series with the tyres' 256 kN/m * 1.125 = 288000
    # = 83200 Nm/rad = 1452.1 Nm/deg; rear: 90000 in series with 288000 = 68571 Nm/rad = 1196.8 Nm/deg
    assert front["roll_stiffness_nm_per_deg"] == pytest.approx(1452.1, abs=0.1)
    assert rear["roll_stiffness_nm_per_deg"] == pytest.approx(1196.8, abs=0.1)
    assert res["roll_stiffness_front_share"] == pytest.approx(0.5482, abs=1e-4)
    # roll gradient W H / (K_f + K_r - W H) = 4905 / (151771 - 4905) rad/g = 1.9135 deg/g
    assert res["roll_gradient_deg_per_g"] == pytest.approx(1.9135, abs=1e-3)
    # all elastic with roll centres on the ground: K_f phi / t = 1852.5 N/g front, 1526.8 N/g rear
    llt_f, llt_r = front["lateral_load_transfer_n_per_g"], rear["lateral_load_transfer_n_per_g"]
    assert llt_f["elastic"] == pytest.approx(1852.5, abs=0.2)
    assert llt_r["elastic"] == pytest.approx(1526.8, abs=0.2)
    assert llt_f["geometric"] == llt_f["unsprung"] == 0
    assert res["lateral_load_transfer_front_share"] == pytest.approx(0.5482, abs=1e-4)
    # longitudinal: W h / L = 9810 * 0.5 / 2.5 = 1962 N/g; 2943 N to the front at 1.5 g braking
    assert res["longitudinal"]["per_g_n"] == pytest.approx(1962.0)
    assert res["longitudinal"]["braking_front_gain_n"] == pytest.approx(2943.0)


def test_geometric_and_unsprung_load_transfer():
    res = compute(Vehicle(**{**TEXTBOOK, "roll_centre_front_mm": 100, "roll_centre_rear_mm": 100}))
    llt_f = res["axles"]["front"]["lateral_load_transfer_n_per_g"]
    # half the 9810 N sprung weight acts at a 0.1 m roll centre on a 1.5 m track: 327 N/g; the roll arm drops
    # to 0.4 m: phi = 3924 / (151771 - 3924) = 1.5207 deg/g, elastic front 83200 * 0.026541 / 1.5 = 1472.1 N/g
    assert llt_f["geometric"] == pytest.approx(327.0, abs=0.1)
    assert res["roll_gradient_deg_per_g"] == pytest.approx(1.5207, abs=1e-3)
    assert llt_f["elastic"] == pytest.approx(1472.1, abs=0.2)
    assert res["lateral_load_transfer_front_share"] == pytest.approx(0.5388, abs=1e-4)

    res = compute(Vehicle(**{**TEXTBOOK, "unsprung_front_kg": 25, "unsprung_rear_kg": 25, "tyre_radius_mm": 300}))
    # 50 kg per axle at 0.3 m on a 1.5 m track: 98.1 N/g; sprung CoG (500 - 30) / 900 = 0.5222 m
    assert res["axles"]["front"]["lateral_load_transfer_n_per_g"]["unsprung"] == pytest.approx(98.1, abs=0.1)
    assert res["sprung_cog_height_mm"] == pytest.approx(522.2, abs=0.1)
    assert res["roll_gradient_deg_per_g"] == pytest.approx(1.7951, abs=1e-3)
    assert res["axles"]["front"]["ride_frequency_hz"] == pytest.approx(2.4008, abs=1e-3)  # 225 kg per corner


def test_balance_reading():
    neutral = compute(Vehicle(**TEXTBOOK))["balance"]
    assert neutral["difference"] == pytest.approx(0.0482, abs=1e-4)  # 54.8 % of the transfer, 50 % of the load
    assert "understeer" in neutral["reading"]
    loose = compute(Vehicle(**{**TEXTBOOK, "arb_front_n_per_mm": 0, "arb_rear_n_per_mm": 40}))["balance"]
    assert loose["difference"] < -0.05 and "oversteer" in loose["reading"]
    aero = compute(Vehicle(**{**TEXTBOOK, "downforce_n": 2000, "aero_balance_front": 0.7}))["balance"]
    # (4905 + 1400) / (9810 + 2000) = 53.4 % of the load on the front at speed: closer to neutral
    assert aero["front_load_share_at_speed"] == pytest.approx(0.5339, abs=1e-4)
    assert aero["difference_at_speed"] < neutral["difference"]


def test_what_if_softer_rear_bar_moves_load_transfer_forward():
    base = preset_vehicle("bmw-m4-gt4-evo")
    res = what_if(base, [Change(field="arb_rear_setting", add=-1)])
    deltas = {d["key"]: d for d in res["deltas"]}
    assert deltas["llt_rear_n_per_g"]["delta"] < 0
    assert deltas["llt_front_share"]["delta"] > 0
    assert deltas["roll_stiffness_front_share"]["delta"] > 0
    assert deltas["roll_gradient_deg_per_g"]["delta"] > 0
    assert deltas["ride_frequency_rear_hz"]["delta"] == 0
    assert "to the front" in res["summary"] and "more understeer" in res["summary"]

    stiffer_front = what_if(base, [Change(field="spring_front_n_per_mm", percent=10)])
    deltas = {d["key"]: d for d in stiffer_front["deltas"]}
    assert deltas["ride_frequency_front_hz"]["delta"] > 0 and deltas["llt_front_share"]["delta"] > 0

    softer_front_bar = what_if(base, [Change(field="arb_front_setting", add=-2)])
    assert "to the rear" in softer_front_bar["summary"]
    with pytest.raises(ValueError, match="outside 1-5"):
        what_if(base, [Change(field="arb_rear_setting", add=-3)])
    with pytest.raises(ValueError, match="not a setup value"):
        what_if(base, [Change(field="colour", set=1)])


def test_bar_settings_map_to_rates():
    car = Vehicle(**{**TEXTBOOK, "arb_front_settings_n_per_mm": [10, 20, 30], "arb_front_setting": 2})
    assert car.arb_rate("front") == 20
    assert compute(car)["roll_stiffness_front_share"] == pytest.approx(0.5482, abs=1e-4)
    with pytest.raises(ValueError):
        Vehicle(**{**TEXTBOOK, "arb_front_settings_n_per_mm": [10, 20, 30], "arb_front_setting": 4})


# Tyre fit: a nonlinear bicycle model drives corners with known axle curves; the fit must recover them.
CAR = dict(mass_kg=1500, front_weight_fraction=0.52, cog_height_mm=450, wheelbase_mm=2800, track_front_mm=1600,
           track_rear_mm=1600, spring_front_n_per_mm=150, spring_rear_n_per_mm=150)
FRONT = (1.40, math.radians(6.0), 1.4)  # peak mu, slip at peak, shape: the front limits this car
REAR = (1.60, math.radians(5.0), 1.3)


def _inverse(curve: tuple, mu: float) -> float:
    """Slip angle (rad) below the peak where the curve gives mu."""
    lo, hi = 0.0, curve[1]
    for _ in range(60):
        mid = (lo + hi) / 2
        lo, hi = (mid, hi) if magic_formula(np.array(mid), *curve) < mu else (lo, mid)
    return lo


_L, _WF = CAR["wheelbase_mm"] / 1000, CAR["front_weight_fraction"]
_AXLES = (_L * (1 - _WF), _L * _WF)  # CoG to front axle, CoG to rear axle (m)


def _bicycle(vy: float, r: float, delta: float, u: float) -> tuple[float, float, float]:
    """d(lateral velocity)/dt, d(yaw rate)/dt and lateral acceleration of the bicycle model at speed u."""
    m, (a, b) = CAR["mass_kg"], _AXLES
    fyf = magic_formula(np.array(delta - math.atan2(vy + a * r, u)), *FRONT) * m * G * _WF
    fyr = magic_formula(np.array(-math.atan2(vy - b * r, u)), *REAR) * m * G * (1 - _WF)
    ay = (fyf * math.cos(delta) + fyr) / m
    return ay - u * r, (a * fyf * math.cos(delta) - b * fyr) / (m * a * b), ay


def bicycle_session(levels=(0.35, 0.5, 0.65, 0.8, 0.95, 1.1, 1.2, 1.28, 1.34, 1.37),
                    speeds=(90.0, 120.0, 150.0), ratio=15.0, yaw_scale=0.9, seed=0) -> SessionData:
    """Corners at each lateral g and speed, entered and left from a straight, driven by a nonlinear bicycle
    model with the axle curves FRONT and REAR. The yaw gyro reads yaw_scale of the truth, like a real one can.

    The model is worked out once per test process for each set of arguments (seconds of Python each time); every
    call gets its own copy of the arrays, so a test may change its session freely."""
    t, distance, channels = _bicycle_log(tuple(levels), tuple(speeds), ratio, yaw_scale, seed)
    channels = {k: v.copy() for k, v in channels.items()}
    return SessionData(t=t.copy(), distance=distance.copy(), channels=channels, sources={k: k for k in channels})


@cache
def _bicycle_log(levels: tuple, speeds: tuple, ratio: float, yaw_scale: float,
                 seed: int) -> tuple[np.ndarray, np.ndarray, dict[str, np.ndarray]]:
    a, b = _AXLES
    dt, sub = 0.002, 5  # 500 Hz integration, logged at 100 Hz
    rng = np.random.default_rng(seed)
    log: dict[str, list[float]] = {k: [] for k in ("speed", "g_lat", "g_long", "yaw", "steer_wheel")}
    vy = r = 0.0
    u = 100 / 3.6
    side = 1.0
    for level in levels:
        for kmh in speeds:
            # steady state of this corner (both axles at mu = level): the steering that holds it
            u1 = kmh / 3.6
            rr = level * G / u1
            beta = b * rr / u1 - _inverse(REAR, level)
            delta0 = side * (_inverse(FRONT, level) + beta + a * rr / u1)
            # 3 s straight changing speed, 1 s turn-in, 4 s holding, 1 s unwinding
            phases = [(3.0, 0.0, 0.0), (1.0, 0.0, delta0), (4.0, delta0, delta0), (1.0, delta0, 0.0)]
            u0 = u
            for k, (dur, d0, d1) in enumerate(phases):
                steps = round(dur / dt)
                for i in range(steps):
                    x = i / steps
                    delta = d0 + (d1 - d0) * (x - math.sin(2 * math.pi * x) / (2 * math.pi))
                    u_dot = (u1 - u0) / 3.0 if k == 0 else 0.0
                    u = u0 + (u1 - u0) * x if k == 0 else u1
                    k1v, k1r, ay = _bicycle(vy, r, delta, u)
                    k2v, k2r, _ = _bicycle(vy + dt * k1v, r + dt * k1r, delta, u)
                    vy, r = vy + dt * (k1v + k2v) / 2, r + dt * (k1r + k2r) / 2
                    if i % sub == 0:
                        log["speed"].append(u * 3.6)
                        log["g_lat"].append(ay / G + rng.normal(0, 0.005))
                        log["g_long"].append(u_dot / G + rng.normal(0, 0.005))
                        log["yaw"].append(math.degrees(r) * yaw_scale + rng.normal(0, 0.05))
                        log["steer_wheel"].append(math.degrees(delta) * ratio + rng.normal(0, 0.1))
            side = -side
    for _ in range(3 * MASTER_HZ):  # a last straight to close the last corner
        for k in log:
            log[k].append(log[k][-1] if k == "speed" else 0.0)
    channels = {k: np.array(v) for k, v in log.items()}
    t = np.arange(len(channels["speed"])) / MASTER_HZ
    distance = np.concatenate([[0.0], np.cumsum(channels["speed"][1:] / 3.6 / MASTER_HZ)])
    return t, distance, channels


@pytest.fixture(scope="module")
def bicycle():
    return bicycle_session()


def test_tyre_fit_recovers_the_curve_of_a_bicycle_model(bicycle):
    res = fit_tyres([bicycle], Vehicle(**CAR), steering_ratio=15.0)
    assert res["corners"] == 30 and res["samples"] > 5000
    assert res["sessions"][0]["yaw_rate_scale"] == pytest.approx(1 / 0.9, abs=0.01)  # the gyro's error found
    front, rear = res["axles"]["front"], res["axles"]["rear"]
    assert front["peak_reached"] and front["shape_fitted"]
    assert front["peak_mu"] == pytest.approx(FRONT[0], abs=0.03)
    assert front["slip_at_peak_deg"] == pytest.approx(6.0, abs=0.4)
    assert front["shape"] == pytest.approx(FRONT[2], abs=0.1)
    assert abs(front["slip_offset_deg"]) < 0.3
    assert front["r2"] > 0.98
    # the rear never gets past mu 1.37 of its 1.6 peak: it is extrapolated and says so, but the curve still
    # matches where there are data
    assert not rear["peak_reached"] and rear["note"]
    alpha = np.radians(np.linspace(0.5, rear["slip_range_deg"][1], 20))
    fitted = magic_formula(alpha, rear["peak_mu"], math.radians(rear["slip_at_peak_deg"]), rear["shape"],
                           math.radians(rear["slip_offset_deg"]))
    assert np.max(np.abs(fitted - magic_formula(alpha, *REAR))) < 0.05


def test_tyre_fit_infers_the_steering_ratio(bicycle):
    res = fit_tyres([bicycle], Vehicle(**CAR))
    steering = res["sessions"][0]["steering"]
    assert steering["source"] == "data"
    assert steering["ratio"] == pytest.approx(15.0, rel=0.05)
    assert res["axles"]["front"]["peak_mu"] == pytest.approx(FRONT[0], abs=0.06)


def test_tyre_fit_refuses_without_enough_cornering():
    short = bicycle_session(levels=(0.8, 1.2), speeds=(120.0,))
    with pytest.raises(NotEnoughData, match=r"Not enough quasi-steady cornering.*in 2 corners"):
        fit_tyres([short], Vehicle(**CAR), steering_ratio=15.0)
    no_yaw = bicycle_session(levels=(0.8,), speeds=(120.0,))
    del no_yaw.channels["yaw"]
    with pytest.raises(NotEnoughData, match="no yaw rate"):
        fit_tyres([no_yaw], Vehicle(**CAR), steering_ratio=15.0)


def test_vehicle_api(client):
    presets = client.get("/vehicle/presets").json()
    assert presets[0]["key"] == "bmw-m4-gt4-evo"
    preset = client.get("/vehicle/presets/bmw-m4-gt4-evo").json()
    assert preset["values"]["wheelbase_mm"]["confidence"] == "published"
    assert preset["values"]["cog_height_mm"]["confidence"] == "estimate"
    assert preset["steering_ratio"]["value"] is None

    model = client.post("/vehicle/model", json=preset["vehicle"])
    assert model.status_code == 200, model.text
    assert 2.0 < model.json()["axles"]["front"]["ride_frequency_hz"] < 3.0

    r = client.post("/vehicle/what-if", json={"baseline": preset["vehicle"],
                                              "changes": [{"field": "arb_rear_setting", "add": -1}]})
    assert r.status_code == 200 and "to the front" in r.json()["summary"]
    r = client.post("/vehicle/what-if", json={"baseline": preset["vehicle"],
                                              "changes": [{"field": "arb_rear_setting", "add": -5}]})
    assert r.status_code == 422

    from tests.synthetic import simulate, write_ld

    channels, _ = simulate()
    s = client.post("/sessions", json={}).json()
    client.post(f"/sessions/{s['id']}/files", files={"file": ("run.ld", write_ld(channels))})
    r = client.post("/vehicle/tyre-fit", json={"session_ids": [s["id"]], "steering_ratio": 15})
    assert r.status_code == 422
    assert "Not enough" in r.json()["detail"] or "steady cornering" in r.json()["detail"]


def test_vehicle_tool_per_garage_vehicle(client):
    """The vehicle model takes a garage vehicle's stored specs, the rest from the preset its name points to; a
    session's setup goes on top of its vehicle's specs."""
    bmw = client.post("/catalog/vehicles", json={"name": "BMW M4 GT4 Evo (G82)", "specs": {
        "mass_kg": 1600, "track_front_mm": 1660, "weight_note": "on scales, May"}}).json()
    other = client.post("/catalog/vehicles", json={"name": "Other GT4", "specs": {"mass_kg": 1500}}).json()
    listed = client.get("/vehicle/vehicles").json()
    assert [(v["name"], v["template"]) for v in listed["vehicles"]] == [
        ("BMW M4 GT4 Evo (G82)", "bmw-m4-gt4-evo"), ("Other GT4", "generic")]
    assert listed["session_vehicle_id"] is None

    d = client.get(f"/vehicle/vehicles/{bmw['id']}").json()
    assert d["vehicle"]["mass_kg"] == 1600 and d["values"]["mass_kg"]["confidence"] == "stored"
    assert d["vehicle"]["wheelbase_mm"] == 2857 and d["values"]["wheelbase_mm"]["confidence"] == "published"
    assert d["base"]["key"] == "bmw-m4-gt4-evo" and d["missing"] == [] and d["stored"] == ["mass_kg", "track_front_mm"]
    assert client.post("/vehicle/model", json=d["vehicle"]).status_code == 200
    o = client.get(f"/vehicle/vehicles/{other['id']}").json()
    assert o["base"] is None and o["vehicle"]["mass_kg"] == 1500 and "wheelbase_mm" in o["missing"]
    assert o["vehicle"]["roll_centre_front_mm"] == 0.0  # the model's default, marked as such
    assert o["values"]["roll_centre_front_mm"]["confidence"] == "unknown"
    assert client.get("/vehicle/vehicles/999").status_code == 404

    # the tool's inputs saved as the vehicle's specs; anything else in them stays
    saved = client.put(f"/vehicle/vehicles/{bmw['id']}/specs", json={**d["vehicle"], "cog_height_mm": 450}).json()
    assert saved["vehicle"]["cog_height_mm"] == 450 and saved["values"]["cog_height_mm"]["confidence"] == "stored"
    raw = next(v for v in client.get("/catalog/vehicles").json() if v["id"] == bmw["id"])
    assert raw["specs"]["weight_note"] == "on scales, May" and raw["specs"]["cog_height_mm"] == 450

    # a session's vehicle is its car's; its setup sheet goes on top of that vehicle's specs
    car = client.post("/cars", json={"name": "BMW M4 GT4 #21"}).json()
    client.put(f"/catalog/cars/{car['id']}/vehicle", json={"vehicle_model_id": bmw["id"]})
    s = client.post("/sessions", json={"name": "Run 1", "car_id": car["id"]}).json()
    assert client.get("/vehicle/vehicles", params={"session_id": s["id"]}).json()["session_vehicle_id"] == bmw["id"]
    sheet = client.put(f"/sessions/{s['id']}/setup", json={"values": {"arb_front": 2, "spring_rate_front": 150}})
    assert sheet.json()["template"] == "bmw-m4-gt4-evo"
    v = client.get(f"/sessions/{s['id']}/setup/vehicle").json()
    assert v["vehicle_model"] == {"id": bmw["id"], "name": "BMW M4 GT4 Evo (G82)"}
    assert (v["vehicle"]["track_front_mm"], v["vehicle"]["cog_height_mm"]) == (1660, 450)
    assert (v["vehicle"]["arb_front_setting"], v["vehicle"]["spring_front_n_per_mm"]) == (2, 150)
    # another vehicle picked: its specs, or why they can't be used yet
    r = client.get(f"/sessions/{s['id']}/setup/vehicle", params={"vehicle_model_id": other["id"]})
    assert r.status_code == 404 and "Other GT4 has no" in r.json()["detail"]
    r = client.get(f"/sessions/{s['id']}/setup/suggestions", params={"vehicle_model_id": other["id"]})
    assert r.status_code == 200
