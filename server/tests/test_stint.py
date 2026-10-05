"""Stints from a synthetic run with a pit stop and a known fade built in."""
import numpy as np
import pytest

from app.analysis.insights import RunInput
from app.analysis.laps import load_session
from app.analysis.stint import outliers, stint_analysis, trend
from app.importers.motec import read_ld
from tests.synthetic import simulate, write_ld

FADE = 0.002  # each lap of a stint is 0.2 % slower than the one before
STINT_1, STINT_2 = 8, 6
SLOW_LAP = 4  # the fifth lap of the first stint is a mistake, 3 % off


def paces(n: int, slow: int | None = None) -> list[float]:
    return [(0.97 if i == slow else 1.0) / (1 + FADE * i) for i in range(n)]


@pytest.fixture(scope="module")
def stint_run():
    # out-lap, stint 1, in-lap with a 40 s stop at its end, out-lap, stint 2, in-lap
    channels, lap_times = simulate([*paces(STINT_1, SLOW_LAP), 0.6, 0.6, *paces(STINT_2)], stops={STINT_1 + 1: 40.0})
    t = np.arange(0, len(channels["vCar"][2]) / 100, 0.1)
    for w in ("FL", "FR", "RL", "RR"):  # tyre pressures coming up to temperature
        channels[f"pTyre{w}"] = (10, "bar", 1.6 + 0.3 * (1 - np.exp(-t / 150)))
    return channels, lap_times


@pytest.fixture(scope="module")
def result(stint_run):
    ld = read_ld(write_ld(stint_run[0]))
    return stint_analysis(RunInput("stints", load_session(ld), ld=ld))


def test_stints_split_at_the_pit_stop(result):
    assert len(result["stops"]) == 1 and result["stops"][0]["duration_s"] == pytest.approx(40, abs=0.1)
    one, two = result["stints"]
    assert [r["kind"] for r in one["laps"]] == ["flying"] * STINT_1 + ["pit"]
    assert [r["kind"] for r in two["laps"]] == ["out"] + ["flying"] * STINT_2
    assert [r["tyre_lap"] for r in two["laps"]] == list(range(1, STINT_2 + 2))
    assert [r["lap"] for r in one["laps"] if r["outlier"]] == [SLOW_LAP + 1]
    assert sum(r["in_fit"] for r in one["laps"]) == STINT_1 - 1
    assert "lap 5 (+" in one["notes"][-1] and "lap 9 (pit stop)" in one["notes"][-1]


def test_fade_is_recovered(result, stint_run):
    lap_times = stint_run[1]
    fresh = lap_times[1]  # the quickest lap: pace 1.0 on new tyres
    for stint in result["stints"]:
        t = stint["fits"]["time"]
        assert t["per_lap"] == pytest.approx(fresh * FADE, rel=0.1)  # seconds per lap
        assert t["clear"] and t["per_lap"] > 3 * t["se"]
        assert "Lap time rises" in stint["notes"][0]
        g = stint["fits"]["grip_use"]
        # lateral and braking g scale with speed squared, so grip in use falls about twice as fast as pace
        mean_grip = np.mean([r["grip_use"] for r in stint["laps"] if r["in_fit"]])
        assert g["per_lap"] == pytest.approx(-2 * FADE * mean_grip, rel=0.3)
        assert stint["fits"]["sustained_lat_g"]["per_lap"] < 0


def test_lap_rows(result):
    row = result["stints"][0]["laps"][0]
    assert 1.2 < row["sustained_lat_g"] <= row["peak_lat_g"] < 1.6  # the synthetic corners pull 1.4 g
    assert 50 < row["grip_use"] <= 125
    assert set(row["balance"]) == {"entry", "mid", "exit"}
    assert set(row["tyres"]["pressure_bar"]) == {"fl", "fr", "rl", "rr"}
    assert row["tc_s"] is None  # no traction control channel in this log
    assert result["understeer_gradient"] is not None and result["steer_channel"] == "aSteer"
    assert result["stints"][0]["fits"]["tyre_pressure"]["per_lap"] > 0
    assert any("still coming in" in n for n in result["stints"][0]["notes"])


def test_robust_line_finds_outliers():
    x = np.arange(1.0, 9.0)
    y = 100 + 0.05 * x + np.array([0, 0.1, -0.1, 0, 1.5, 0.05, -0.05, 0])
    assert outliers(x, y).tolist() == [False] * 4 + [True] + [False] * 3
    fit = trend(x[~outliers(x, y)], y[~outliers(x, y)])
    assert fit["per_lap"] == pytest.approx(0.05, abs=0.03) and fit["laps"] == 7
    assert trend(x[:3], y[:3]) is None  # too few laps for a trend


def test_stint_endpoint(client, stint_run):
    s = client.post("/sessions", json={"name": "Long run"}).json()
    up = client.post(f"/sessions/{s['id']}/files", files={"file": ("run.ld", write_ld(stint_run[0]))})
    assert up.status_code == 201
    r = client.get(f"/sessions/{s['id']}/stint")
    assert r.status_code == 200, r.text
    body = r.json()
    assert [len(st["laps"]) for st in body["stints"]] == [STINT_1 + 1, STINT_2 + 1]
    assert body["stints"][1]["fits"]["time"]["per_lap"] > 0
    assert client.get("/sessions/999/stint").status_code == 404
