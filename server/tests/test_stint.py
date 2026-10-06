"""Stints from a synthetic run with a pit stop, a known fade and a fuel channel; and the stint tool's API."""
import numpy as np
import pytest

from app.analysis.channels import BRAKE, EXIT, MID, POWER, TRAIL
from app.analysis.fuel import fuel_from_log, mass_cost
from app.analysis.insights import RunInput
from app.analysis.laps import Section, load_session
from app.analysis.stint import (
    SECTION_KEYS,
    LapSummary,
    LogSummary,
    _split_by_cause,
    _suggest,
    assemble,
    outliers,
    pooled_trend,
    reduce_run,
    stint_analysis,
    trend,
)
from app.analysis.stint_words import _car, _driver
from app.importers.motec import read_ld
from tests.synthetic import simulate, write_ld

FADE = 0.002  # each lap of a stint is 0.2 % slower than the one before
STINT_1, STINT_2 = 8, 6
SLOW_LAP = 4  # the fifth lap of the first stint is a mistake, 3 % off
FUEL_KG_S = 0.02  # burnt every second the car moves


def paces(n: int, slow: int | None = None) -> list[float]:
    return [(0.97 if i == slow else 1.0) / (1 + FADE * i) for i in range(n)]


@pytest.fixture(scope="module")
def stint_run():
    # out-lap, stint 1, in-lap with a 40 s stop at its end, out-lap, stint 2, in-lap
    channels, lap_times = simulate([*paces(STINT_1, SLOW_LAP), 0.6, 0.6, *paces(STINT_2)], stops={STINT_1 + 1: 40.0})
    t = np.arange(0, len(channels["vCar"][2]) / 100, 0.1)
    for w in ("FL", "FR", "RL", "RR"):  # tyre pressures coming up to temperature
        channels[f"pTyre{w}"] = (10, "bar", 1.6 + 0.3 * (1 - np.exp(-t / 150)))
    moving = channels["vCar"][2][::10] > 5
    channels["mFuelUsed"] = (10, "kg", np.cumsum(moving * FUEL_KG_S / 10))
    return channels, lap_times


@pytest.fixture(scope="module")
def result(stint_run):
    ld = read_ld(write_ld(stint_run[0]))
    return stint_analysis(RunInput("stints", load_session(ld), ld=ld))


def test_stints_split_at_the_pit_stop(result):
    stops = result["logs"][0]["stops"]
    assert len(stops) == 1 and stops[0]["duration_s"] == pytest.approx(40, abs=0.1)
    one, two = result["stints"]
    assert [r["kind"] for r in one["laps"]] == ["flying"] * STINT_1 + ["pit"]
    assert [r["kind"] for r in two["laps"]] == ["out"] + ["flying"] * STINT_2
    assert [r["tyre_lap"] for r in two["laps"]] == list(range(1, STINT_2 + 2))
    assert [r["lap"] for r in one["laps"] if r["outlier"]] == [SLOW_LAP + 1]
    assert sum(r["in_fit"] for r in one["laps"]) == STINT_1 - 1
    left = one["words"]["left_out"]
    assert "lap 5 (+" in left and "lap 9 (pit stop)" in left


def test_fade_fuel_and_tyres(result, stint_run):
    fresh = stint_run[1][1]  # the quickest lap: pace 1.0 on new tyres
    for stint in result["stints"]:
        t = stint["fits"]["time"]
        assert t["per_lap"] == pytest.approx(fresh * FADE, rel=0.1)  # seconds per lap
        assert t["clear"] and t["per_lap"] > 3 * t["se"]
        fuel = stint["fuel"]
        assert fuel["source"] == "log" and fuel["kg_per_lap"] == pytest.approx(FUEL_KG_S * fresh, rel=0.1)
        assert 0 < fuel["s_per_10kg"] < 1
        # the lighter car is quicker: put the burnt fuel back on and the laps fade faster than raw
        c = stint["fits"]["corrected_time"]
        assert c["per_lap"] - t["per_lap"] == pytest.approx(-fuel["fuel_s_per_lap"], rel=0.15)
        assert "The tyres fade" in stint["words"]["headline"] and "once fuel burn is taken out" in stint["words"][
            "headline"]
        assert "Fuel: " in stint["words"]["fuel"] and "from the log" in stint["words"]["fuel"]
        # the fade split by phase adds up to the tyre fade on the laps' own clocks
        parts = sum(f["per_lap"] for f in stint["fade"])
        assert parts == pytest.approx(c["per_lap"], abs=0.25 * c["per_lap"])
        assert stint["fade"][0]["per_lap"] >= stint["fade"][-1]["per_lap"]


def test_grip_falls_with_the_fade(result):
    stint = result["stints"][0]
    # cornering g scales with speed squared: grip on the exit falls about twice as fast as pace
    g = stint["fits"]["grip_exit"]
    assert g["per_lap"] < 0 and g["clear"]
    assert g["per_lap"] / g["level"] == pytest.approx(-2 * FADE, rel=0.35)
    row = next(r for r in stint["laps"] if r["in_fit"])
    assert 1.2 < row["grip"]["exit"] < 1.7  # the synthetic corners pull 1.4 g
    assert set(row["balance"]) == {"entry", "mid", "exit"}
    assert set(row["tyres"]["pressure_bar"]) == {"fl", "fr", "rl", "rr"}
    assert row["tc_s"] is None  # no traction control channel in this log
    assert result["understeer_per_g"] is not None and result["steer_channel"] == "aSteer"
    assert stint["fits"]["tyre_pressure"]["per_lap"] > 0
    assert any("still coming in" in n for n in stint["words"]["car"])


def test_tags_leave_laps_out(stint_run):
    ld = read_ld(write_ld(stint_run[0]))
    log = reduce_run(RunInput("stints", load_session(ld), ld=ld))
    out = assemble([log], {("stints", 3): "traffic", ("stints", 5): "none"})
    laps = {r["lap"]: r for r in out["stints"][0]["laps"]}
    assert laps[3]["tag"] == "traffic" and not laps[3]["in_fit"]
    assert laps[5]["tag"] is None and laps[5]["checked"]  # looked at: counts, and no suggestion comes back
    assert laps[5]["suggestion"] is None
    assert out["stints"][0]["fits"]["time"]["laps"] == STINT_1 - 2
    assert "lap 3 (traffic)" in out["stints"][0]["words"]["left_out"]
    # the whole view: one change per lap across both stints, each at its own level
    assert out["overall"]["fits"]["time"]["stints"] == 2
    assert out["overall"]["words"]["headline"]


def test_robust_line_finds_outliers():
    x = np.arange(1.0, 9.0)
    y = 100 + 0.05 * x + np.array([0, 0.1, -0.1, 0, 1.5, 0.05, -0.05, 0])
    assert outliers(x, y).tolist() == [False] * 4 + [True] + [False] * 3
    fit = trend(x[~outliers(x, y)], y[~outliers(x, y)])
    assert fit["per_lap"] == pytest.approx(0.05, abs=0.03) and fit["laps"] == 7
    assert trend(x[:3], y[:3]) is None  # too few laps for a trend


def test_pooled_trend_keeps_each_stint_level():
    x = np.arange(1.0, 7.0)
    one, two = 100 + 0.1 * x, 103 + 0.1 * x  # two stints, same fade, three seconds apart
    t = pooled_trend([(x, one), (x, two)])
    assert t["per_lap"] == pytest.approx(0.1) and t["stints"] == 2 and t["laps"] == 12
    assert trend(np.r_[x, x], np.r_[one, two])["per_lap"] == pytest.approx(0.1)  # same slope here, but:
    assert pooled_trend([(x, one), (x + 6, two - 0.6)])["per_lap"] == pytest.approx(0.1)


def test_mass_costs_time_only_on_full_throttle():
    v = np.r_[np.sqrt(np.linspace(80**2, 200**2, 500)), np.linspace(200, 80, 200)]  # accelerate, then brake
    thr = np.r_[np.full(500, 100.0), np.zeros(200)]
    brk = np.r_[np.zeros(500), np.ones(200)]
    cost = mass_cost(v, thr, brk, 1500.0, 15.0)
    # constant acceleration a over 499 m: a heavier car accelerates a * m / (m + dm)
    v0, v1 = 80 / 3.6, 200 / 3.6
    a = (v1**2 - v0**2) / 2 / 499
    t = lambda acc: (np.sqrt(v0**2 + 2 * acc * 499) - v0) / acc  # noqa: E731
    assert cost.sum() * 15 == pytest.approx(t(a * 1500 / 1515) - t(a), rel=0.1)
    assert cost[520:].sum() < 0.05 * cost.sum()  # braking: it brakes a little later, nothing more
    assert np.all(cost >= 0)


def test_fuel_channel_resets_add_nothing():
    class Ch:
        name, unit = "QFuelUsed", "l"

        def times(self):
            return np.arange(0, 100, 0.1)

        def values(self):
            v = np.arange(0, 100, 0.1) * 0.03
            v[500:] -= v[500]  # the counter reset half way
            return v

    class Log:
        def channel(self, *names):
            return Ch() if "QFuelUsed" in names else None

    f = fuel_from_log(Log(), density=0.75)
    assert f.source == "log" and f.at(99.9) == pytest.approx(0.03 * 99.8 * 0.75, rel=0.02)


def _fake_log(n_laps: int = 8, exit_fade: float = 0.001) -> LogSummary:
    """A log made by hand: each metre is braking, trail braking, mid-corner, exit or full throttle, and only the
    exit metres get slower lap after lap."""
    phase = np.repeat(np.array([POWER, BRAKE, TRAIL, MID, EXIT, POWER], np.int8), 100)
    n = len(phase)
    sections = [Section("T1", 0, 300, 250, ["T1"]), Section("T2", 300, n, 450, ["T2"])]
    laps = []
    for i in range(n_laps):
        dt = np.full(n, 0.02, np.float32)
        dt[phase == EXIT] += exit_fade * i
        sec = {k: np.full(2, np.nan, np.float32) for k in SECTION_KEYS}
        sec["time"] = np.array([dt[:300].sum(), dt[300:].sum()], np.float32)
        values = {"sens_kg": 0.0, "g_p90": 1.4, "trace_time": float(dt.sum())}
        laps.append(LapSummary(i + 1, 100.0 * i, 100.0 * (i + 1), float(dt.sum()), True, 1, i + 1, "flying",
                               values, sec, dt, phase, np.zeros(n, np.float32), None))
    return LogSummary("f", "Run", {}, "marker", n, sections, [], laps)


def test_fade_is_found_in_the_phase_that_fades():
    out = assemble([_fake_log()])
    st = out["stints"][0]
    assert st["fade"][0]["key"] == "exit" and st["fade"][0]["per_lap"] == pytest.approx(0.1, rel=0.01)
    assert st["fade"][0]["clear"] and st["fade"][0]["corners"][0]["code"] == "T2"
    assert all(abs(f["per_lap"]) < 1e-6 for f in st["fade"][1:])
    words = st["words"]["headline"]
    assert words.startswith("The tyres fade 0.10 s a lap") and "Most of it is traction on exit" in words
    assert "mostly T2" in words and st["words"]["advice"].startswith("Where to look: the exits of T2")


def _v2_profile(exit_gain: float) -> tuple[np.ndarray, np.ndarray]:
    """v² metre by metre over a corner and the straight after it, and each metre's phase."""
    steps = [(POWER, 200, 8.0), (BRAKE, 100, -20.0), (TRAIL, 30, -5.0), (MID, 50, 0.0), (EXIT, 80, exit_gain),
             (POWER, 440, 8.0), (BRAKE, 100, -20.0)]
    v2, phase = [900.0], []
    for p, n, gain in steps:
        for _ in range(n):
            v2.append(min(v2[-1] + gain, 2500.0))  # top speed 50 m/s
            phase.append(p)
    return np.array(v2), np.array(phase, np.int8)


def test_speed_lost_on_the_exit_counts_against_the_exit():
    ref_v2, phase = _v2_profile(6.0)
    lap_v2, _ = _v2_profile(5.0)  # less traction: 80 m²/s² short at the end of the exit
    ref_dt = 2 / (np.sqrt(ref_v2[1:]) + np.sqrt(ref_v2[:-1]))
    dt = 2 / (np.sqrt(lap_v2[1:]) + np.sqrt(lap_v2[:-1]))
    section_of = np.r_[np.zeros(600, int), np.ones(400, int)]  # the straight runs on into the next corner's section
    split = _split_by_cause(dt, phase, ref_dt, np.isin(phase, (BRAKE, TRAIL)), section_of, 2)
    lost = float((dt - ref_dt).sum())
    assert lost > 0.1 and split.sum() == pytest.approx(lost)
    assert split[EXIT, 0] == pytest.approx(lost, rel=0.03)  # the straight's time is the exit's
    assert abs(split[POWER].sum()) < 0.03 * lost and abs(split[BRAKE].sum()) < 0.03 * lost
    naive = float((dt - ref_dt)[phase == POWER].sum())
    assert naive > 0.5 * lost  # metre by metre the straight would take the blame


def test_suggestions():
    typ = np.array([10.0, 20.0, 30.0])
    typical = {"time": 60.0, "g_p90": 1.4, "lifts": np.array([1.0, 1, 1]), "coast_s": np.array([0.2, 0.2, 0.2]),
               "full_m": np.array([300.0, 300, 300])}

    def lap(times, g=1.4, lifts=(1, 1, 1), plateau=0.0, kind="flying"):
        sec = {k: np.full(3, np.nan) for k in SECTION_KEYS}
        sec.update(time=np.array(times), lifts=np.array(lifts, float), coast_s=np.full(3, 0.2),
                   full_m=np.full(3, 300.0))
        return LapSummary(1, 0, 1, float(sum(times)), False, 1, 3, kind, {"g_p90": g, "plateau": plateau}, sec)

    codes = ["T1", "T2", "T3"]
    sc = _suggest(lap([13.0, 26.0, 38.0], g=0.8), {}, typical, typ, codes)
    assert sc["tag"] == "sc" and "slow in every corner" in sc["why"]
    fcy = _suggest(lap([13.0, 26.0, 38.0], g=0.8, plateau=0.7), {}, typical, typ, codes)
    assert fcy["tag"] == "fcy" and fcy["options"] == ["fcy", "sc"]
    traffic = _suggest(lap([10.0, 21.5, 30.0], lifts=(1, 3, 1)), {}, typical, typ, codes)
    assert traffic["tag"] == "traffic" and traffic["likely"] and "T2" in traffic["why"]
    mistake = _suggest(lap([10.0, 21.5, 30.0]), {}, typical, typ, codes)
    assert mistake["tag"] == "traffic" and not mistake["likely"] and "mistake" in mistake["why"]
    assert _suggest(lap([10.1, 20.1, 30.1]), {}, typical, typ, codes) is None  # just a slower lap
    assert _suggest(lap([13.0, 26.0, 38.0], g=0.8, kind="out"), {}, typical, typ, codes) is None


def _fit(change: float, clear: bool = True, level: float = 1.0) -> dict:
    return {"per_lap": change / 7, "change": change, "within": 0.0, "clear": clear, "level": level, "laps": 8}


def test_words_keep_the_car_and_the_driver_apart():
    fits = {"grip_exit": _fit(-0.05, level=1.4), "grip_braking": _fit(0.001, clear=False, level=1.4),
            "balance_exit": _fit(-0.4), "balance_entry": _fit(0.02, clear=False),
            "brake_point": _fit(-6.0), "throttle_on": _fit(9.0), "tc_s": _fit(1.5), "shift_rpm": _fit(-250.0),
            "steer_mid": _fit(0.5, clear=False)}
    sections = [{"code": "T6", "exit": {"early": -0.2, "late": -0.8, "shift": -0.6}, "fade": {},
                 "driver": {"throttle_on": {"change": 12.0, "clear": True}}}]
    car = " ".join(_car(fits, sections))
    assert "Grip falls most on the exit" in car and "(-3.6 %)" in car and "Braking grip holds" in car
    assert "Exit balance moves 0.40° towards oversteer, most at T6 (-0.6°)" in car and "entry holds" in car
    driver = _driver(fits, sections, {"brake": "bar", "steer": "deg", "steer_role": "steer_wheel"})
    text = " ".join(driver)
    assert "You brake 6 m earlier" in text
    assert ("You wait 9 m longer for the throttle on the exits, as the rear gives less traction, most at T6 (12 m)"
            in text)
    assert "You lean on the traction control more: +1.5 s a lap of TC by the end as the rear grip goes" in text
    assert "You short-shift: upshifts come 250 rpm lower" in text
    assert "steering" not in text  # not clear: not said
    for w in (" he ", " she ", " his ", " her "):
        assert w not in f" {car} {text} ".lower()


def test_stint_tool_api(client, stint_run):
    s = client.post("/sessions", json={"name": "Long run"}).json()
    up = client.post(f"/sessions/{s['id']}/files", files={"file": ("run.ld", write_ld(stint_run[0]))})
    assert up.status_code == 201
    fid = up.json()["files"][0]["id"]
    logs = client.get("/stint/logs").json()["events"]
    listed = [f for e in logs for x in e["sessions"] for f in x["files"]]
    assert [f["id"] for f in listed] == [fid] and listed[0]["clean_laps"] > 10
    r = client.get(f"/stint?files={fid}")
    assert r.status_code == 200, r.text
    body = r.json()
    assert [len(st["laps"]) for st in body["stints"]] == [STINT_1 + 1, STINT_2 + 1]
    assert body["stints"][1]["fits"]["time"]["per_lap"] > 0
    assert client.get(f"/sessions/{s['id']}/stint").json()["file_ids"] == [fid]
    # tag a lap: it stays in the list, marked, and leaves the trend
    assert client.put("/lap-tags", json={"file_id": fid, "lap": 3, "tag": "sc"}).status_code == 200
    assert client.put("/lap-tags", json={"file_id": fid, "lap": 3, "tag": "nonsense"}).status_code == 422
    assert client.put("/lap-tags", json={"file_id": fid, "lap": 99, "tag": "sc"}).status_code == 404
    tagged = client.get(f"/stint?files={fid}").json()["stints"][0]
    lap3 = next(r for r in tagged["laps"] if r["lap"] == 3)
    assert lap3["tag"] == "sc" and not lap3["in_fit"]
    assert tagged["fits"]["time"]["laps"] == body["stints"][0]["fits"]["time"]["laps"] - 1
    assert client.get(f"/lap-tags?session_id={s['id']}").json()[0]["tag"] == "sc"
    assert client.delete(f"/lap-tags?file_id={fid}&lap=3").status_code == 204
    assert client.get(f"/lap-tags?file_id={fid}").json() == []
    assert client.get("/stint?files=").status_code == 422
    assert client.get("/stint?files=999").status_code == 404
    assert client.get("/sessions/999/stint").status_code == 404


def test_tags_follow_their_lap_when_laps_are_numbered_again(client, stint_run):
    from app import models
    from app.db import SessionLocal
    from app.laptags import tags_for_files

    s = client.post("/sessions", json={"name": "Long run"}).json()
    fid = client.post(f"/sessions/{s['id']}/files", files={"file": ("run.ld", write_ld(stint_run[0]))}).json()[
        "files"][0]["id"]
    client.put("/lap-tags", json={"file_id": fid, "lap": 4, "tag": "fcy"})
    with SessionLocal() as db:
        for lap in db.query(models.Lap).filter(models.Lap.file_id == fid):
            lap.number += 1  # the line was learned again and an extra lap counted at the start
        db.commit()
        assert tags_for_files(db, [fid]) == {fid: {5: "fcy"}}
    # the screen shows it on lap 5 now: tagging and clearing lap 5 reach the same tag
    assert client.put("/lap-tags", json={"file_id": fid, "lap": 5, "tag": "sc"}).status_code == 200
    assert [(t["lap"], t["tag"]) for t in client.get(f"/lap-tags?file_id={fid}").json()] == [(5, "sc")]
    assert client.put("/lap-tags", json={"file_id": fid, "lap": 4, "tag": "traffic"}).status_code == 200
    assert client.delete(f"/lap-tags?file_id={fid}&lap=5").status_code == 204
    assert [(t["lap"], t["tag"]) for t in client.get(f"/lap-tags?file_id={fid}").json()] == [(4, "traffic")]
