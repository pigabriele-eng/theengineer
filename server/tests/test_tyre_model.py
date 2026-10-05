"""The accumulating tyre model: summaries of synthetic logs, pooled fits, grip against conditions and the API.
All data are made up here: a bicycle model with known axle curves, or summaries drawn from those curves."""
import math

import numpy as np
import pytest

from app.analysis.laps import MASTER_HZ, Lap
from app.vehicle.model import Vehicle
from app.vehicle.tyre_data import Entry, fit_model, summarise
from app.vehicle.tyre_fit import NotEnoughData, fit_tyres
from tests.synthetic import simulate, write_ld
from tests.test_vehicle import CAR, FRONT, REAR, _inverse, bicycle_session

# ---------- one log -> summary ----------


def _with_laps_and_tpms(data, lap_s=27.0, first=9.0):
    """Lap crossings every lap_s seconds from first, and TPMS temperature and pressure rising through the run."""
    end = len(data.t) / MASTER_HZ
    starts = np.arange(first, end - lap_s, lap_s)
    data.laps = [Lap(number=i + 1, start=float(s), end=float(s + lap_s), time=lap_s, clean=True)
                 for i, s in enumerate(starts)]
    data.lap_source = "marker"
    for w in ("fl", "fr", "rl", "rr"):
        front = w[0] == "f"
        data.channels[f"tyre_t_{w}"] = (40.0 if front else 35.0) + 0.2 * data.t
        data.channels[f"tyre_p_{w}"] = (1.50 if front else 1.40) + 0.002 * data.t
    return data


@pytest.fixture(scope="module")
def lapped():
    return _with_laps_and_tpms(bicycle_session())


def test_summary_of_a_log_lap_by_lap(lapped):
    s = summarise(lapped, Vehicle(**CAR), set_starts=[0.0])
    laps = s["laps"]
    # the out-lap before the first crossing, nine laps, the in-lap after the last
    assert [x["lap"] for x in laps] == [None, *range(1, 10), None]
    assert [x["tyre_lap"] for x in laps] == list(range(1, 12))  # all on the set that went out at 0 s
    assert sum(x["samples"] for x in laps) == s["samples"] > 5000
    assert s["corners"] == 30 and sum(x["corners"] for x in laps) == 30  # three corners a lap, none split
    assert s["yaw_rate_scale"] == pytest.approx(1 / 0.9, abs=0.01)
    lap1 = laps[1]
    assert lap1["start_s"] == 9.0 and lap1["time_s"] == 27.0
    # medians over the lap: the TPMS channels at its middle, 22.5 s
    assert lap1["front"]["temp_c"] == pytest.approx(44.5, abs=0.2)
    assert lap1["rear"]["temp_c"] == pytest.approx(39.5, abs=0.2)
    assert lap1["front"]["bar"] == pytest.approx(1.545, abs=0.002)
    for x in laps:
        for axle in ("front", "rear"):
            d = x[axle]
            assert len(d["b"]) == len(d["n"]) == len(d["mu"]) == len(d["a"]) == len(d["q"])
            assert sum(d["n"]) == x["samples"]
            assert all(b * 0.05 <= m < (b + 1) * 0.05 for b, m in zip(d["b"], d["mu"], strict=True))
    assert len(str(s)) < 40_000  # small: the model never opens the log again


def test_model_of_one_log_matches_the_single_log_fit(lapped):
    car = Vehicle(**CAR)
    single = fit_tyres([lapped], car)["axles"]["front"]
    model = fit_model([Entry(summarise(lapped, car), session_id=1, name="Run 1")])
    front = model["axles"]["front"]
    assert front["peak_reached"]
    assert front["peak_mu"] == pytest.approx(FRONT[0], abs=0.06)
    assert front["peak_mu"] == pytest.approx(single["peak_mu"], abs=0.03)
    assert front["slip_at_peak_deg"] == pytest.approx(single["slip_at_peak_deg"], abs=0.4)
    assert model["basis"]["sessions"] == 1 and model["basis"]["laps"] == 11
    assert model["advice"][0].startswith(f"Front: grip peaks at mu {front['peak_mu']:.2f}")
    assert "not in the data yet" in model["advice"][1]  # the rear never got near its peak
    # one session: no group of laps has a range, so no window is claimed
    assert all(model["conditions"][c][ax]["window"] is None for c in ("temperature", "pressure", "tyre_laps")
               for ax in ("front", "rear"))
    with pytest.raises(NotEnoughData):
        fit_model([])


# ---------- many summaries -> model ----------

LOADS = {"mass_kg": CAR["mass_kg"], "front_weight_fraction": CAR["front_weight_fraction"], "cog_height_mm": 450,
         "wheelbase_mm": 2800, "downforce_n": 0, "aero_balance_front": 0.5, "aero_ref_speed_kmh": 200}


def fake_summary(rng, laps=10, offset=0.0, grip=None, rear_top=0.85, per_band=40) -> dict:
    """A summary drawn from the axle curves FRONT and REAR, as a log's would be: per lap and band of mu, the
    median slip angle with a little scatter. offset: the body-slip estimate's error in this log (deg). grip(bar,
    temp) scales the curves of a lap. The rear stops at rear_top of its peak, as on the real car."""
    rows = []
    for k in range(laps):
        bar, temp = round(float(rng.uniform(1.60, 2.00)), 3), round(float(rng.uniform(70, 100)), 1)
        scale = grip(bar, temp) if grip else 1.0
        row = {"lap": k + 1, "start_s": 100.0 * k, "time_s": 100.0, "clean": True, "tyre_lap": k + 1,
               "samples": 0, "corners": 12}
        for axle, curve, top in (("front", FRONT, 0.99), ("rear", REAR, rear_top)):
            peak = curve[0] * scale
            d = {"temp_c": temp, "bar": bar, "b": [], "n": [], "mu": [], "a": [], "q": []}
            for b in range(6, 40):
                mu = (b + 0.5) * 0.05
                if mu > top * peak:
                    break
                alpha = math.degrees(_inverse((peak, curve[1], curve[2]), mu)) + offset + rng.normal(0, 0.05)
                for key, value in (("b", b), ("n", per_band), ("mu", round(mu, 4)), ("a", round(alpha, 3)),
                                   ("q", 0.4)):
                    d[key].append(value)
            row[axle] = d
        row["samples"] = sum(row["front"]["n"])
        rows.append(row)
    return {"version": 1, "samples": sum(r["samples"] for r in rows), "corners": 12 * laps, "corners_dropped": 0,
            "yaw_rate_scale": 1.1, "steering": {"source": "entered", "ratio": 15.0}, "speed_kmh": [80, 210],
            "lap_source": "beacons", "loads": LOADS, "laps": rows}


OFFSETS = (-0.4, 0.3, 0.0, 0.2, -0.2, 0.1)


def test_pooling_lines_sessions_up_and_finds_the_curve():
    rng = np.random.default_rng(1)
    entries = [Entry(fake_summary(rng, offset=o), session_id=i + 1, name=f"Run {i + 1}", track="Test Track",
                     date=f"2026-07-0{i + 1}", ambient_c=15.0 + i)
               for i, o in enumerate(OFFSETS)]
    model = fit_model(entries)
    basis = model["basis"]
    assert basis["sessions"] == 6 and basis["laps"] == 60 and basis["with_tpms"] == basis["with_tyre_laps"] == 60
    assert basis["tracks"] == ["Test Track"] and basis["dates"] == ["2026-07-01", "2026-07-06"]
    assert basis["ambient_c"] == [15.0, 20.0]
    mean = sum(OFFSETS) / len(OFFSETS)
    for s, o in zip(model["sessions"], OFFSETS, strict=True):
        assert s["slip_shift_deg"]["front"] == pytest.approx(o - mean, abs=0.05)
        assert s["slip_shift_deg"]["rear"] == pytest.approx(o - mean, abs=0.05)
    front, rear = model["axles"]["front"], model["axles"]["rear"]
    assert front["peak_reached"] and front["peak_mu"] == pytest.approx(FRONT[0], abs=0.02)
    assert front["slip_at_peak_deg"] == pytest.approx(math.degrees(FRONT[1]), abs=0.3)
    assert front["peak_mu_range"][0] <= front["peak_mu"] <= front["peak_mu_range"][1]
    assert not rear["peak_reached"]
    assert rear["mu_observed_max"] == pytest.approx(1.325, abs=0.01)
    assert model["advice"][1] == (f"Rear: the peak is not in the data yet: at the most grip seen, mu "
                                  f"{rear['mu_observed_max']:.2f}, it ran {rear['slip_at_mu_max_deg']:.1f}° of slip "
                                  "and grip was still rising.")
    # grip does not depend on any condition here, so none is claimed
    for c in ("temperature", "pressure", "tyre_laps"):
        for ax in ("front", "rear"):
            w = model["conditions"][c][ax]["window"]
            assert w is None or w["confidence"] == "none", (c, ax, w)
    assert len(model["curves"]["alpha_deg"]) == len(model["curves"]["front"]) == 61


def test_grip_against_pressure_shows_the_window():
    rng = np.random.default_rng(2)

    def grip(bar, _temp):
        return 1.0 if bar < 1.80 else 0.94  # 6 % less grip at the same slip angle above 1.80 bar

    entries = [Entry(fake_summary(rng, laps=12, offset=o, grip=grip), session_id=i + 1, name=f"Run {i + 1}")
               for i, o in enumerate(OFFSETS)]
    model = fit_model(entries)
    pressure = model["conditions"]["pressure"]
    assert pressure["unit"] == "bar" and pressure["note"]
    for ax in ("front", "rear"):
        bins = pressure[ax]["bins"]
        assert len(bins) >= 3 and all(b["sessions"] >= 3 for b in bins)
        low = [b["grip"] for b in bins if b["to"] <= 1.80]
        high = [b["grip"] for b in bins if b["from"] >= 1.80]
        assert np.mean(low) - np.mean(high) == pytest.approx(0.06, abs=0.025)
        w = pressure[ax]["window"]
        assert w["confidence"] == "high" and w["from"] == 1.60 and 1.74 <= w["to"] <= 1.82 and w["open"] == "low"
        assert bins[0]["grip"] - bins[-1]["grip"] == pytest.approx(0.06, abs=0.01)  # all laps below, all above
        assert 0.03 < w["gain"] <= 0.07  # against every group clearly worse, one of them part below 1.80
        assert w["text"].startswith(f"{ax.capitalize()}: most grip at ") and "bar hot or less" in w["text"]
        assert w["text"] in model["advice"]
    # temperature had nothing to do with it
    for ax in ("front", "rear"):
        w = model["conditions"]["temperature"][ax]["window"]
        assert w is None or w["confidence"] == "none"


# ---------- the API ----------

def _bicycle_ld() -> bytes:
    """A short bicycle-model log as a MoTeC file, with TPMS."""
    data = bicycle_session(levels=(0.5, 0.7, 0.9, 1.1, 1.25, 1.33), speeds=(100.0, 140.0))
    c = data.channels
    t1 = np.arange(0, len(data.t) / MASTER_HZ, 1.0)
    channels = {"vCar": (MASTER_HZ, "km/h", c["speed"]), "gLat": (MASTER_HZ, "G", c["g_lat"]),
                "gLong": (MASTER_HZ, "G", c["g_long"]), "nYaw": (MASTER_HZ, "deg/s", c["yaw"]),
                "aSteerWheel": (MASTER_HZ, "deg", c["steer_wheel"])}
    for w in ("FL", "FR", "RL", "RR"):
        channels[f"TPMS Temp {w}"] = (1, "C", 60 + 0.3 * t1)
        channels[f"TPMS Press {w}"] = (1, "bar", 1.7 + 0.001 * t1)
    return write_ld(channels)


def _summarise_now():
    from app.vehicle import tyre_store
    tyre_store.run_pending()  # the background job does the same a moment later
    return tyre_store


def test_tyre_model_api(client):
    a = client.post("/sessions", json={"name": "Run A"}).json()
    r = client.post(f"/sessions/{a['id']}/files", files={"file": ("a.ld", _bicycle_ld())})
    assert r.status_code < 300, r.text
    b = client.post("/sessions", json={"name": "Run B"}).json()
    channels, _ = simulate()  # laps on a circle: no steady cornering to summarise
    client.post(f"/sessions/{b['id']}/files", files={"file": ("b.ld", write_ld(channels))})
    _summarise_now()

    status = client.get("/tyre-model/status").json()
    assert (status["pending"], status["summarised"], status["without_cornering"], status["failed"]) == (0, 1, 1, 0)
    cars = client.get("/tyre-model/cars").json()["cars"]
    assert len(cars) == 1
    car = cars[0]
    assert car["key"] == "logger:12345" and car["label"] == "BMW M4 GT4 EVO (G82), logger 12345"
    assert car["sessions"] == 1 and car["tyres"] == [{"name": "Pirelli P Zero DHG", "sessions": 1}]

    model = client.get("/tyre-model", params={"car": car["key"]})
    assert model.status_code == 200, model.text
    m = model.json()
    assert m["tyre"] == "Pirelli P Zero DHG" and m["basis"]["sessions"] == 1
    assert m["sessions"][0]["name"] == "Run A" and m["basis"]["with_tpms"] == m["basis"]["laps"]
    assert m["advice"][0].startswith("Front: ")
    # no lap timing in this log: one lap, too few to group by a condition
    assert m["basis"]["laps"] == 1 and m["conditions"]["pressure"]["front"] == {"bins": [], "window": None}
    assert client.get("/tyre-model", params={"car": "logger:1"}).status_code == 404
    r = client.get("/tyre-model", params={"car": car["key"], "ambient_min": 30}).json()
    assert "matches" in r["empty"] and "axles" not in r and r["filters"]["ambient_min"] == 30

    # another tyre on the same car is kept apart
    r = client.patch(f"/tyre-model/sessions/{a['id']}", json={"tyre": "Pirelli P Zero DHH"})
    assert r.status_code == 200 and r.json()["tyre"] == "Pirelli P Zero DHH"
    m = client.get("/tyre-model", params={"car": car["key"]}).json()
    assert m["tyre"] == "Pirelli P Zero DHH" and m["sessions"][0]["tyre"] == "Pirelli P Zero DHH"
    r = client.get("/tyre-model", params={"car": car["key"], "tyre": "Pirelli P Zero DHG"}).json()
    assert r["empty"] and r["choices"]["tyres"] == [{"name": "Pirelli P Zero DHH", "sessions": 1}]
    assert client.patch(f"/tyre-model/sessions/{a['id']}", json={"tyre": ""}).json()["tyre"] == "Pirelli P Zero DHG"
    assert client.patch(f"/tyre-model/sessions/{b['id']}", json={"tyre": "X"}).status_code == 200  # no cornering
    c = client.post("/sessions", json={}).json()
    assert client.patch(f"/tyre-model/sessions/{c['id']}", json={"tyre": "X"}).status_code == 409

    # a session of a named car counts for that car, not its logger
    new_car = client.post("/cars", json={"name": "GT4 #7"}).json()
    d = client.post("/sessions", json={"name": "Run D", "car_id": new_car["id"]}).json()
    client.post(f"/sessions/{d['id']}/files", files={"file": ("d.ld", _bicycle_ld())})
    _summarise_now()
    cars = client.get("/tyre-model/cars").json()["cars"]
    assert sorted(x["key"] for x in cars) == sorted([f"car:{new_car['id']}", "logger:12345"])
    assert {x["label"] for x in cars} == {"GT4 #7", "BMW M4 GT4 EVO (G82), logger 12345"}


def test_summaries_are_made_again_when_out_of_date(client):
    from app import db, models

    s = client.post("/sessions", json={}).json()
    client.post(f"/sessions/{s['id']}/files", files={"file": ("a.ld", _bicycle_ld())})
    tyre_store = _summarise_now()
    with db.SessionLocal() as d:
        row = d.query(models.TyreData).one()
        first = row.updated_at
        row.version = "0:old"
        d.commit()
    status = client.get("/tyre-model/status").json()
    assert status["pending"] == 1 and status["summarised"] == 0  # an old summary isn't used
    _summarise_now()
    with db.SessionLocal() as d:
        row = d.query(models.TyreData).one()
        assert row.version == tyre_store.version() and row.status == "ok" and row.updated_at > first
        # the log re-timed from another start/finish line: its laps changed, so its summary is made again
        f = d.get(models.LoggerFile, row.file_id)
        f.meta = {**f.meta, "lap_source": "gps", "timed_line": {"lat": 49.33, "lon": 8.57, "heading": 90.0}}
        d.commit()
    assert client.get("/tyre-model/status").json()["pending"] == 1
    _summarise_now()
    with db.SessionLocal() as d:
        row = d.query(models.TyreData).one()
        assert row.lap_source.startswith("gps:") and len(row.lap_source) <= 16
    assert client.get("/tyre-model/status").json()["pending"] == 0
