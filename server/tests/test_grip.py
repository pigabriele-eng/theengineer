"""Grip use and traction control on synthetic runs: quicker laps use more grip, and TC that grows with the rear
tyre temperature on one corner exit."""
import json

import numpy as np
import pytest

from app.analysis.grip import GripStudy, _runs_of, partial, tc_words
from app.analysis.laps import load_session
from app.importers.motec import read_ld
from tests.synthetic import simulate, write_ld

PACES = [0.97, 0.985, 1.0, 0.975, 0.99, 0.965, 0.995, 0.98, 0.97, 0.99]  # every lap clean, no two alike
TC_FROM_M = 720.0  # TC cuts in on the exit of the second corner (apex at 700 m) ...
TC_GROWTH_M = 6.0  # ... for 6 m more on every lap, as the rear tyres warm up


def with_tc(channels: dict, lap_times: list[float]) -> dict:
    """Add a TC flag on the second corner's exit, wheel speeds and rear tyre temperatures rising lap by lap."""
    v = channels["vCar"][2]
    hz = 100
    t = np.arange(len(v)) / hz
    starts = np.r_[0.0, np.cumsum(lap_times)]
    lap = np.clip(np.searchsorted(starts, t, side="right") - 1, 0, len(lap_times) - 1)
    dist = np.cumsum(v / 3.6 / hz)
    within = dist - np.interp(starts[lap], t, dist)
    flying = (lap >= 1) & (lap <= len(lap_times) - 2)
    reach = TC_FROM_M + TC_GROWTH_M * (lap - 1)
    tc = (flying & (within >= TC_FROM_M) & (within < reach)).astype(float)
    wheel = v / 3.6 / 0.33
    out = dict(channels)
    out["BInterventionCauseTC"] = (hz, "", tc)
    for w in ("FL", "FR"):
        out[f"nWheel{w}"] = (hz, "rad/s", wheel)
    for w in ("RL", "RR"):
        out[f"nWheel{w}"] = (hz, "rad/s", wheel * (1 + 0.08 * tc))
    temp = 55.0 + 1.5 * lap  # °C, one step per lap
    for w in ("RL", "RR"):
        out[f"TTyre{w}"] = (10, "C", temp[::10])
    return out


@pytest.fixture(scope="module")
def run():
    channels, lap_times = simulate(PACES)
    return with_tc(channels, lap_times)


@pytest.fixture(scope="module")
def report(run):
    ld = read_ld(write_ld(run))
    study = GripStudy()
    data = load_session(ld)
    study.add("Run 1", data, ld)
    assert "tyre_p_fl" not in data.channels and "phase" in data.channels  # what the report doesn't need is gone
    return study.report()


def test_report_is_plain_json(report):
    json.dumps(report, allow_nan=False)
    assert report["available"] and report["clean_laps"] == len(PACES)
    assert report["numbering"] == "detected"
    assert [s["code"] for s in report["sections"]] == ["C1", "C2"]


def test_quicker_laps_use_more_grip(report):
    g = report["grip"]
    assert g["vs_time"]["r"] < -0.9 and g["vs_time"]["n"] == len(PACES)
    assert g["s_per_pct"] < 0  # more grip use, quicker lap
    laps = sorted(report["laps"], key=lambda r: r["time"])
    assert laps[0]["grip_use"] == max(r["grip_use"] for r in laps)
    assert report["fastest"]["time"] == laps[0]["time"]
    assert report["headlines"][0]["key"] == "grip_vs_time"
    for s in report["sections"]:
        assert s["r"] < -0.5 and s["note"]
        assert set(s["phases"]) == {"braking", "trail", "mid", "exit"}


def test_grip_limit_and_gg(report):
    lim = report["limits"]
    assert len(lim["directions_deg"]) == 19 and len(lim["envelope_g"]) == len(lim["speeds_kmh"])
    assert len(lim["bands_kmh"]) == len(lim["speeds_kmh"]) and lim["bands_kmh"][-1][1] is None
    gg = report["gg"]["fastest"]
    assert len(gg["ax"]) == len(gg["ay"]) == len(gg["speed"]) > 50
    assert max(abs(a) for a in gg["ay"]) == pytest.approx(1.4, abs=0.15)  # the corners' lateral g
    assert report["map"] is not None and len(report["map"]["x"]) == len(report["map"]["grip_use"])


def test_traction_control_zone_and_tyre_temperature(report):
    tc = report["tc"]
    assert tc["available"] and tc["channel"] == "BInterventionCauseTC"
    zone = next(z for z in tc["zones"] if z["start_m"] < 760 < z["end_m"])
    assert zone["where"] == "C2 exit"
    assert abs(zone["start_m"] - TC_FROM_M) < 25
    assert zone["slip_pct"] > 4  # the rear wheels spin up while TC works
    w = tc["vs_rear_temp_within"]
    assert w["r"] > 0.9 and w["slope"] > 0
    assert any(h["key"] == "tc_temp" for h in report["headlines"])
    # the synthetic log has no engine torque or TC switch: said so, not failed
    assert report["channels"]["engine_torque"] is None and tc["switch"] is None
    assert any("MEngine" in n for n in tc["notes"])


def test_logs_without_tc_say_so():
    channels, _ = simulate(PACES)
    ld = read_ld(write_ld(channels))
    study = GripStudy()
    study.add("No TC", load_session(ld), ld)
    r = study.report()
    assert r["available"] and not r["tc"]["available"]
    assert "no traction control channel" in r["tc"]["notes"][0]
    assert all(h["key"] not in ("tc_cost", "tc_temp") for h in r["headlines"])


def test_runs_are_read_one_at_a_time_onto_one_line(run):
    study = GripStudy()
    quick, slow = simulate([0.99, 1.0, 0.995])[0], simulate([0.97, 0.975, 0.98])[0]
    for name, channels in (("Slow", slow), ("Quick", quick)):
        ld = read_ld(write_ld(channels))
        study.add(name, load_session(ld), ld)
    r = study.report()
    assert r["clean_laps"] == 6 and r["fastest"]["run"] == "Quick"
    assert {x["run"] for x in r["laps"]} == {"Slow", "Quick"}
    assert r["length_m"] == pytest.approx(1000, abs=15)


def test_no_clean_laps():
    channels, _ = simulate([0.6])  # out-lap, one slow lap, in-lap: nothing quick
    study = GripStudy()
    ld = read_ld(write_ld(channels))
    data = load_session(ld)
    for lap in data.laps:
        lap.clean = False
    study.add("Garage", data, ld)
    r = study.report()
    assert not r["available"] and "No clean laps" in r["notes"][0]


def test_helpers():
    assert _runs_of(np.array([0, 1, 1, 0, 1, 1, 1, 0, 0, 0, 0, 1], bool), 3, 2) == [(1, 7)]
    rng = np.random.default_rng(1)
    z = rng.normal(size=60)
    x = rng.normal(size=60)
    y = 2.0 * x + 3.0 * z + rng.normal(scale=0.1, size=60)
    p = partial(y, x, z)
    assert p["coef"] == pytest.approx(2.0, abs=0.1) and p["r"] > 0.9
    assert partial(y[:5], x[:5], z[:5]) is None
    zone = {"verdict": "cost", "quick_share": 0.9, "tc_s": 1.1, "slip_pct": 13.0, "speed_per_tc_s": -0.8,
            "time_per_tc_s": 0.16, "time_cost_s": 0.18, "kerb_g": 0.1, "steer_tc": 69.0, "steer_no_tc": 65.0,
            "steer_unit": "°", "pedal_s_tc": 0.66, "pedal_s_no_tc": 0.75}
    note, advice = tc_words(zone)
    assert "0.18 s each time" in note
    assert advice.startswith("Unwind about 4° more steering") and "0.75 s" in advice
    note, advice = tc_words({**zone, "kerb_g": 0.8})
    assert "kerb" in note and "kerb" in advice


def test_grip_endpoint(client, run):
    import app.routers.report_grip as rg

    ev = client.post("/events", json={"name": "Test day"}).json()
    ids = []
    for name in ("Run 1", "Run 2"):
        s = client.post("/sessions", json={"name": name, "event_id": ev["id"]}).json()
        up = client.post(f"/sessions/{s['id']}/files", files={"file": ("run.ld", write_ld(run))})
        assert up.status_code == 201
        ids.append(s["id"])
    r = client.get(f"/report/grip?session={ids[0]}")
    assert r.status_code == 200, r.text
    one = r.json()
    assert one["available"] and one["clean_laps"] == len(PACES) and one["tc"]["available"]
    r = client.get(f"/report/grip?event={ev['id']}")
    assert r.status_code == 200, r.text
    both = r.json()
    assert both["clean_laps"] == 2 * len(PACES)
    assert {x["run"] for x in both["laps"]} == {"Run 1", "Run 2"}
    assert ("event", ev["id"]) in rg._cache
    assert client.get(f"/report/grip?event={ev['id']}").json() == both  # from the cache
    assert client.get("/report/grip").status_code == 422
    assert client.get(f"/report/grip?session={ids[0]}&event={ev['id']}").status_code == 422
    assert client.get("/report/grip?session=999").status_code == 404
    assert client.get("/report/grip?event=999").status_code == 404
