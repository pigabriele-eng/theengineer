"""Tyre tools on synthetic data: gas law, TPMS cold and hot pressures, the learned rise, minimums, pyrometer rules."""
import numpy as np
import pytest

from app.importers.motec import read_ld
from app.tyres.gaslaw import cold_from_hot, hot_from_cold
from app.tyres.pressure import Observation, fit_rise, pressure_plan
from app.tyres.temps import analyze_temps, ir_readings
from app.tyres.tpms import CORNERS, measure_runs
from tests.synthetic import write_ld

TAU_S = 180.0  # how quickly the synthetic tyres warm up


def tpms_log(total_s: float, moving: list[tuple[float, float, float]], pressure, temp,
             silent: list[tuple[float, float]], extra: dict | None = None) -> bytes:
    """A log with speed and TPMS channels; moving is (from, to, km/h). pressure(t) and temp(t) give the tyre's
    state; the sensors log 0 bar and -50 °C while silent, and -33 °C for a moment after waking, like the real ones."""
    t100, t50, t20 = (np.arange(0, total_s, 1 / hz) for hz in (100, 50, 20))
    v = np.zeros_like(t100)
    for a, b, kmh in moving:
        v[(t100 >= a) & (t100 < b)] = kmh
    channels = {"vCar": (100, "km/h", v)}
    for c in CORNERS:
        p, tt = pressure(t50).astype(float), temp(t20).astype(float)
        for a, b in silent:
            p[(t50 >= a) & (t50 < b)] = 0.0
            tt[(t20 >= a) & (t20 < b)] = -50.0
            tt[(t20 >= b) & (t20 < b + 0.5)] = -33.0
        channels[f"pTyre{c}"] = (50, "bar", p)
        channels[f"TTyre{c}"] = (20, "C", tt)
    return write_ld({**channels, **(extra or {})})


def warming(t: np.ndarray, start: float) -> np.ndarray:
    return np.where(t > start, 1 - np.exp(-(t - start) / TAU_S), 0.0)


def one_run(cold_bar: float, cold_c: float, rise_bar: float, hot_c: float = 80.0) -> bytes:
    """Stand for a minute, a minute down the pit lane (the sensors wake 10 s in), 20 minutes at speed, stop."""
    return tpms_log(1440, [(60, 120, 50.0), (120, 1320, 150.0)],
                    lambda t: cold_bar + rise_bar * warming(t, 120),
                    lambda t: cold_c + (hot_c - cold_c) * warming(t, 120),
                    silent=[(0, 70)])


def test_gas_law_round_trip_in_absolute_pressure_and_kelvin():
    hot = hot_from_cold(1.30, 20.0, 80.0)
    assert hot == pytest.approx((1.30 + 1.013) * 353.15 / 293.15 - 1.013)
    assert cold_from_hot(hot, 80.0, 20.0) == pytest.approx(1.30)
    # at altitude the same gauge pressure holds less air, so it rises less
    assert hot_from_cold(1.30, 20.0, 80.0, atmospheric_bar=0.9) < hot
    assert cold_from_hot(1.9, 20.0, 20.0) == pytest.approx(1.9)


def test_tpms_cold_start_and_settled_hot_pressure():
    runs = measure_runs(read_ld(one_run(1.25, 18.0, 0.6)))
    assert len(runs) == 1
    fl = runs[0]["corners"]["FL"]
    assert fl["used"], fl["note"]
    assert fl["cold_bar"] == pytest.approx(1.25, abs=0.01)
    assert fl["cold_c"] == pytest.approx(18.0, abs=0.5)  # not the -33 °C the sensor reads as it wakes
    assert fl["hot_bar"] == pytest.approx(1.85, abs=0.01)
    assert fl["rise_bar"] == pytest.approx(0.6, abs=0.01)


def test_tpms_rules_for_bled_stops_late_sensors_and_new_tyres():
    # air let out at a stop after 8 minutes, before the pressure settled: no hot pressure from this run
    def bled(t):
        return np.where(t < 600, 1.25 + 0.6 * warming(t, 60), 1.25 + 0.6 * warming(t, 60) - 0.15)
    runs = measure_runs(read_ld(tpms_log(1700, [(60, 540, 150.0), (600, 1600, 150.0)], bled,
                                         lambda t: 20 + 60 * warming(t, 60), silent=[(0, 70)])))
    assert not runs[0]["corners"]["FL"]["used"]
    assert "let out" in runs[0]["corners"]["FL"]["note"]

    # a sensor that wakes after two minutes at speed missed the cold pressure
    late = measure_runs(read_ld(tpms_log(1360, [(60, 1260, 150.0)], lambda t: 1.25 + 0.6 * warming(t, 60),
                                         lambda t: 20 + 60 * warming(t, 60), silent=[(0, 180)])))
    assert "missed the cold pressure" in late[0]["corners"]["FL"]["note"]

    # new tyres at a stop: the sensors fall silent and wake up cold again, which starts a second run
    def two_sets(t, first, second):
        return np.where(t < 1300, first(t), second(t))
    runs = measure_runs(read_ld(tpms_log(
        2800, [(60, 1260, 150.0), (1360, 1420, 50.0), (1420, 2620, 150.0)],
        lambda t: two_sets(t, lambda x: 1.25 + 0.6 * warming(x, 60), lambda x: 1.10 + 0.55 * warming(x, 1420)),
        lambda t: two_sets(t, lambda x: 20 + 60 * warming(x, 60), lambda x: 22 + 58 * warming(x, 1420)),
        silent=[(0, 70), (1300, 1370)])))
    assert [r["set"] for r in runs] == [0, 1]
    second = runs[1]["corners"]["RR"]
    assert second["used"]
    assert second["cold_bar"] == pytest.approx(1.10, abs=0.01)
    assert second["rise_bar"] == pytest.approx(0.55, abs=0.01)


def known_rise(cold_c: float, track_c: float) -> float:
    return 0.60 - 0.008 * (cold_c - 20) + 0.005 * (track_c - 30)


CONDITIONS = [(12.0, 22.0), (16.0, 41.0), (20.0, 30.0), (24.0, 45.0), (28.0, 25.0), (32.0, 36.0), (18.0, 38.0)]


def test_empirical_fit_recovers_a_known_rise():
    obs = [Observation(c, known_rise(c, tr), track_c=tr) for c, tr in CONDITIONS]
    fit = fit_rise(obs, {"cold": 22.0, "track": 35.0})
    assert fit.terms == ["cold", "track"]
    assert fit.slopes["cold"] == pytest.approx(-0.008, abs=1e-6)
    assert fit.slopes["track"] == pytest.approx(0.005, abs=1e-6)
    assert fit.predict({"cold": 22.0, "track": 35.0}) == pytest.approx(known_rise(22.0, 35.0))
    # without today's track temperature, or with too few runs, the fit falls back to fewer terms
    assert fit_rise(obs, {"cold": 22.0}).terms == ["cold"]
    assert fit_rise(obs[:3], {"cold": 22.0, "track": 35.0}).terms == []


def test_pressure_plan_flags_settings_below_the_minimums():
    runs = [{"corners": {c: {"used": True, "cold_c": 20.0, "rise_bar": 0.6, "hot_c": 80.0, "hot_bar": 1.9,
                             "gas_law_hot_bar": 1.8} for c in CORNERS}, "ambient_c": 20.0, "track_c": None}]
    minimums = [{"axle": "front", "cold_min_bar": 1.4, "hot_min_bar": None, "source": "P-Book p. 1"},
                {"axle": "rear", "cold_min_bar": None, "hot_min_bar": 2.0, "source": "P-Book p. 1"}]
    plan = pressure_plan({"FL": 1.9, "RL": 1.9}, runs, minimums, set_c=20.0, ambient_c=20.0)
    fl, rl = plan["corners"]
    assert fl["data"]["cold_bar"] == pytest.approx(1.30)
    assert fl["gas_law"]["hot_c"] == 80.0  # the logged runs' typical hot temperature
    assert any("below the P-Book cold minimum of 1.40 bar (P-Book p. 1)" in f for f in fl["flags"])
    assert any("below the P-Book hot minimum of 2.00 bar" in f for f in rl["flags"])
    assert not pressure_plan({"FL": 1.9}, runs, [], set_c=20.0)["corners"][0]["flags"]


def test_pressure_calculator_learns_from_uploaded_logs(client):
    car = client.post("/cars", json={"name": "BMW M4 GT4 Evo"}).json()
    for i, (cold_c, track_c) in enumerate(CONDITIONS):
        s = client.post("/sessions", json={"name": f"Run {i + 1}", "car_id": car["id"]}).json()
        log = one_run(1.30 - 0.01 * i, cold_c, known_rise(cold_c, track_c))
        assert client.post(f"/sessions/{s['id']}/files", files={"file": (f"run{i}.ld", log)}).status_code == 201
        r = client.patch(f"/sessions/{s['id']}/conditions", json={"track_temp_c": track_c})
        assert r.json()["track_temp_c"] == track_c

    runs = client.get("/tyres/runs", params={"car_id": car["id"]}).json()
    assert runs["summary"]["FL"]["runs"] == len(CONDITIONS)

    r = client.get("/tyres/minimums", params={"series": "Test Cup"}).json()
    assert r["rows"] == [] and "not public" in r["message"]
    assert "not the DHG P_Book" in r["reference"]["text"]  # the older booklet is only shown as a reference
    client.put("/tyres/minimums", json={"series": "Test Cup", "rows": [
        {"axle": "front", "cold_min_bar": 1.35, "source": "Test Cup P-Book 2026"}]})

    body = {"targets": {"FL": 1.9, "RR": 2.0}, "set_c": 25, "track_c": 35, "car_id": car["id"],
            "series": "Test Cup", "hot_c": {"FL": 85}}
    plan = client.post("/tyres/pressures", json=body).json()
    fl, rr = plan["corners"]
    assert fl["data"]["runs"] == len(CONDITIONS)
    # the sensors' settled reading is a little short of the full rise; the fit sees what the logs show
    assert fl["data"]["cold_bar"] == pytest.approx(1.9 - known_rise(25, 35), abs=0.02)
    assert fl["gas_law"]["cold_bar"] == pytest.approx(cold_from_hot(1.9, 85, 25), abs=0.005)
    assert any("P-Book cold minimum of 1.35 bar" in f for f in fl["flags"])
    assert not rr["flags"]  # no rear minimum entered


def test_pyrometer_rules():
    readings = {
        "FL": {"inside": 98, "middle": 92, "outside": 82, "camber_deg": -3.5},  # spread 16: too much camber
        "FR": {"inside": 90, "middle": 92, "outside": 80, "pressure_bar": 1.9},  # spread 10; middle 7 over edges
        "RL": {"inside": 80, "middle": 72, "outside": 79},  # spread 1, middle 7.5 under the edges
        "RR": {"inside": 76, "middle": 80, "outside": 81},  # outside hotter than inside
    }
    out = {t["corner"]: t for t in analyze_temps(readings)["tyres"]}
    assert out["FL"]["camber"]["verdict"] == "less negative camber"
    assert out["FL"]["camber"]["suggested_camber_deg"] == -3.25
    assert out["FL"]["pressure"]["verdict"] == "ok"
    assert out["FR"]["camber"]["verdict"] == "ok"
    assert out["FR"]["pressure"]["verdict"] == "lower"
    assert out["FR"]["pressure"]["suggested_pressure_bar"] == 1.85
    assert out["RL"]["camber"]["verdict"] == "more negative camber"
    assert out["RL"]["pressure"]["verdict"] == "raise"
    assert out["RR"]["camber"]["verdict"] == "more negative camber"
    assert "rolling onto its shoulder" in out["RR"]["camber"]["text"]

    balance = {b["kind"]: b for b in analyze_temps(readings)["balance"]}
    assert balance["axle"]["difference_c"] == pytest.approx(89.0 - 78.0, abs=0.1)
    assert "understeer" in balance["axle"]["text"]
    assert "within" in balance["side"]["text"]

    # a wider target spread makes the front-left camber fine; a hot minimum stops the pressure going lower
    out = analyze_temps(readings, {"front": 14.0}, {"front": 1.88})
    fl, fr = out["tyres"][0], out["tyres"][1]
    assert fl["camber"]["verdict"] == "ok"
    assert fr["pressure"]["below_minimum"]
    with pytest.raises(ValueError):
        analyze_temps({"FL": {"inside": 980, "middle": 92, "outside": 82}})

    # past the older Pirelli GT4 booklet's limits: a reference note, labelled as not the DHG P_Book
    out = analyze_temps({"FL": {"inside": 104, "middle": 92, "outside": 82, "camber_deg": -3.4},
                         "RL": {"inside": 80, "middle": 78, "outside": 78, "camber_deg": -3.0}})
    fl, rl = out["tyres"]
    assert [r["text"].split(" Reference")[0] for r in fl["camber"]["references"]] == [
        "The inside runs more than 20 °C hotter than the outside, the most the booklet allows."]
    assert "-3.25° is more negative than the -3.0° maximum static camber for the rear" in rl["camber"]["references"][0][
        "text"]
    assert all("not the DHG P_Book" in r["text"] for r in fl["camber"]["references"])


def test_ir_sensor_channels_from_a_log(client):
    n = 100 * 120
    v = np.full(n, 150.0)
    v[:1000] = 0  # parked: these samples don't count
    extra = {"vCar": (100, "km/h", v)}
    for pos, temp in (("Inner", 95.0), ("Centre", 90.0), ("Outer", 84.0)):
        extra[f"Tyre Temp FL {pos}"] = (10, "C", np.full(n // 10, temp))
    for i in range(1, 7):  # numbered across the tread, channel 1 on the inside
        extra[f"IR FR {i}"] = (10, "C", np.full(n // 10, 100.0 - 2 * i))
    readings, channels = ir_readings(read_ld(write_ld(extra)))
    assert readings["FL"] == {"inside": 95.0, "middle": 90.0, "outside": 84.0}
    assert channels["FR"]["inside"] == ["IR FR 1", "IR FR 2"]
    assert readings["FR"] == {"inside": 97.0, "middle": 93.0, "outside": 89.0}

    s = client.post("/sessions", json={}).json()
    client.post(f"/sessions/{s['id']}/files", files={"file": ("ir.ld", write_ld(extra))})
    r = client.get(f"/sessions/{s['id']}/tyre-temps").json()
    assert [t["corner"] for t in r["tyres"]] == ["FL", "FR"]

    tpms_only = client.post("/sessions", json={}).json()
    client.post(f"/sessions/{tpms_only['id']}/files", files={"file": ("tpms.ld", one_run(1.25, 18.0, 0.6))})
    r = client.get(f"/sessions/{tpms_only['id']}/tyre-temps")
    assert r.status_code == 422
    assert "TPMS" in r.json()["detail"]
