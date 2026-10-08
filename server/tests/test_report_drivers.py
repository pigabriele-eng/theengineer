"""The report's Drivers section: two drivers' laps put on one tyre age and fuel load, their corners by group, their
balance and the same comparison asked for twice (routers/report_drivers.py, routers/comparisons.py)."""
import json
import time

import numpy as np

from app.analysis import driver_corners, like_for_like
from app.analysis.laps import Section
from app.analysis.like_for_like import Fade, Run
from tests.test_driver_trends import FAST, SLOW, _two_drivers, _upload

# ---------- tyre age and fuel ----------


def _race(sid: int, order: int, laps: int = 10) -> Run:
    return Run(sid, "R1", order, "race", "fresh", None, laps, {n: 2.0 for n in range(1, laps + 1)}, 2.0, 0.01, "log")


def test_a_race_stint_carries_on_from_the_one_before():
    # one pace all race: a lap loses 0.1 s for each lap on the set and gains 0.01 s for each kg burnt
    laps = []
    for sid, before in ((1, 0), (2, 10)):
        for n in range(2, 10):
            laps.append((sid, n, 100 + 0.1 * (before + n) - 0.01 * 2.0 * (before + n - 1)))
    fade = Fade(0.1, "stints", 4, 40)
    c = like_for_like.correct(laps, [_race(2, 1), _race(1, 0)], fade)
    assert c.tyres and c.fuel_done and not c.unknown_age
    assert c.ages[0] == 2 and c.ages[8] == 12  # the second stint's lap 2 is the set's 12th lap
    assert c.fuel[8] == -22.0  # 20 kg burnt in the first stint, 2 kg on its own first lap
    assert np.ptp(c.times) < 1e-6  # the same lap, once on the same tyres and fuel
    assert c.age_ref == 10.5 and c.kg_per_lap == 2.0 and c.s_per_kg == 0.01
    words = like_for_like.words(c, fade, races=True)
    assert words[0] == ("Corrected for tyre age (0.10 s per lap on the set, from this weekend's 4 long stints) and "
                        "fuel (2.0 kg a lap, 0.10 s per 10 kg). Not corrected: track grip between sessions.")
    assert "no refuelling or tyre change at the driver change" in words[1] and "assumed" not in words[1]


def test_a_set_of_unknown_age_is_not_corrected_for_tyres():
    runs = [Run(1, "FP1", 0, "practice", "used", None, 8, {}, 2.0, 0.01, "estimate"),
            Run(2, "FP1", 1, "practice", "new", None, 8, {}, 2.0, 0.01, "estimate")]
    c = like_for_like.correct([(1, 3, 101.0), (2, 3, 100.0)], runs, Fade(0.1, "track"))
    assert not c.tyres and c.unknown_age == [1] and c.fuel_done
    assert c.ages == [None, 3.0]  # a new set starts at none
    words = like_for_like.words(c, Fade(0.1, "track"), races=False)
    assert words[0].startswith("Corrected for fuel (2.0 kg a lap")
    assert "Not corrected: tyre age (how old some sets were isn't known), track grip between sessions." in words[0]
    assert words[-1].startswith("Fuel estimated from the time at full throttle")


def test_nothing_known_nothing_corrected():
    runs = [Run(1, "Q", 0, "qualifying", "new", 0, 5), Run(2, "Q", 1, "qualifying", "new", 0, 5)]
    c = like_for_like.correct([(1, 2, 100.0), (2, 2, 100.5)], runs, None)
    assert c.times == [100.0, 100.5] and not c.tyres and not c.fuel_done
    assert like_for_like.words(c, None, races=False) == [
        "Not corrected: fuel (no fuel figures for these runs), tyre age (no tyre fade known here), track grip "
        "between sessions."]


def test_fade_from_the_long_stints_or_the_track():
    def stint(n: int, per_lap: float, level: float) -> dict:
        return {"laps": [{"tyre_lap": k, "in_fit": True, "corrected_time": level + per_lap * k} for k in range(1, n)]
                + [{"tyre_lap": n, "in_fit": False, "corrected_time": 999.0}]}
    fade = like_for_like.fade_from_stints([stint(12, 0.05, 100), stint(10, 0.05, 101), stint(5, 1.0, 100)])
    assert fade.source == "stints" and fade.stints == 2 and abs(fade.per_lap - 0.05) < 1e-6  # the short one left out
    assert like_for_like.fade_from_stints([stint(5, 0.05, 100)]) is None
    assert like_for_like.fade_from_stints([stint(12, -0.02, 100)]).per_lap == 0.0  # the track coming in: no fade
    zandvoort = like_for_like.fade_for_track("Circuit Zandvoort", 100.0)
    assert zandvoort.source == "track" and abs(zandvoort.per_lap - 0.072) < 1e-9
    assert like_for_like.fade_for_track("Nowhere ring", 100.0) is None


# ---------- corners ----------


def test_passes_ranked_against_the_laps_around_them():
    # run 2 is a second slower all through (older tyres, say): its passes still count by what they beat their own
    # neighbours by
    times = np.array([10.0, 10.0, 9.7, 10.0, 10.0, 11.0, 11.0, 10.5, 11.0, 11.0, 10.0, 10.3])
    runs = ["1"] * 5 + ["2"] * 5 + ["1"] * 2
    index = np.array([1, 2, 3, 4, 5, 1, 2, 3, 4, 5, 6, 7])
    g = driver_corners.groups(times, runs, index)
    assert set(g["top"].tolist()) >= {2, 7}  # the dip in each run, the slower run's too
    assert 11 in g["bottom"].tolist() and len(g["top"]) == len(g["median"]) == len(g["bottom"]) == 3


def _pass(side: str, number: int, time_s: float, bp: int, apex_speed: float) -> driver_corners.Pass:
    rows, traces = [], []
    for start, end, flat in ((0, 400, False), (400, 700, True)):
        rows.append({"time": time_s, "min_speed": apex_speed, "min_speed_at": 200 if not flat else 520,
                     "exit_speed": apex_speed + 50, "brake_point": None if flat else bp,
                     "peak_brake": None if flat else 80.0, "trail_share": None if flat else 0.5,
                     "throttle_on": None if flat else 210, "full_throttle": None if flat else 260,
                     "brake_off": None if flat else 190, "gear": 3.0,
                     **{f"time_{p}": time_s / 5 for p in ("braking", "trail", "mid", "exit", "power")}})
        x = np.arange(start, end + 1, driver_corners.STEP_M)
        throttle = np.full(len(x), np.nan) if side == "b" and flat else np.where(x > 210, 100.0, 0.0)
        brake = np.where(x < 190, 50.0, 0.0)
        traces.append(np.stack([np.full(len(x), apex_speed), brake, throttle]).astype(np.float32))
    return driver_corners.Pass(side, 1 if side == "a" else 2, number, 100.0, rows, traces)


def test_corner_view_on_one_window_from_the_apex():
    passes = [_pass("a", n, 5.0 + 0.01 * n, 120, 80.0) for n in range(1, 11)]
    passes += [_pass("b", n, 5.2 + 0.01 * n, 110, 78.0) for n in range(1, 11)]
    sections = [Section("T1", 0, 400, 200, ["T1"], [200]), Section("T2", 400, 700, None, ["T2"], [520])]
    t1, t2 = driver_corners.corner_view(passes, sections)
    assert (t1["code"], t1["apex_m"], t1["flat"], t2["apex_m"], t2["flat"]) == ("T1", 200, False, 520, True)
    assert t1["faster"] == "a" and t1["delta_s"] == -0.2 and t1["beats"] == t1["of"] == 10
    med = t1["groups"]["median"]
    assert med["a"]["brake_point"] == -80 and med["b"]["brake_point"] == -90  # metres before the apex
    assert med["a"]["throttle_on"] == 10 and med["a"]["min_speed"] == 80.0 and med["a"]["gear"] == 3
    # from 40 m before the earliest braking point to 40 m past the latest full throttle (or 150 m past the apex)
    assert t1["from_m"] == -130
    n = len(med["a"]["speed"])
    assert n == len(med["b"]["brake"]) == len(t1["groups"]["top"]["b"]["throttle"]) == (350 - 70) // 5 + 1
    assert t2["groups"]["top"]["a"]["brake_point"] is None  # taken flat
    assert t2["groups"]["top"]["b"]["throttle"][0] is None  # a channel the log hasn't: nulls


# ---------- the endpoints ----------


def _named(client, event_id: int, name: str, driver: str, paces) -> int:
    s = client.post("/sessions", json={"event_id": event_id, "name": name}).json()
    _upload(client, s["id"], paces)
    client.post("/drivers/assign", json={"driver_name": driver, "session_ids": [s["id"]]})
    return s["id"]


def test_corners_compare_the_sessions_both_drove(client):
    track = client.post("/tracks", json={"name": "Test ring", "corners": [
        {"code": "T1", "apex_m": 300}, {"code": "T2", "apex_m": 690}]}).json()
    event = client.post("/events", json={"name": "Test day", "track_id": track["id"]}).json()["id"]
    anna = [_named(client, event, "FP1 stint 1", "Anna", SLOW[:4]),
            _named(client, event, "FP1 stint 2", "Anna", SLOW[4:]),
            _named(client, event, "FP2 stint 1", "Anna", SLOW[:4])]
    ben = [_named(client, event, "FP1 stint 3", "Ben", FAST[:4]), _named(client, event, "FP1 stint 4", "Ben", FAST[4:])]
    a, b = ",".join(map(str, anna)), ",".join(map(str, ben))

    r = client.get(f"/report/drivers/corners?a={a}&b={b}")
    assert r.status_code == 200, r.text
    res = r.json()
    assert res["labels"] == {"a": "Anna", "b": "Ben"} and res["numbering"] == "official"
    m = res["matched"]
    assert m["same_sessions"] and m["parts"] == ["FP1"] and m["runs"] == {"a": anna[:2], "b": ben}
    assert m["left_out"] == [{"session_id": anna[2], "name": "FP2", "side": "a"}]  # Ben didn't drive in FP2
    assert res["sides"]["a"]["laps"] == res["sides"]["b"]["laps"] == 8
    assert res["gap"]["typical"] > 0.5 and res["gap"]["best"] > 0.5  # Anna is slower
    assert "track grip between sessions" in res["correction"]["words"][0]
    assert [c["code"] for c in res["corners"]] == ["T1", "T2"]
    for c in res["corners"]:
        assert c["faster"] == "b" and c["delta_s"] > 0
        for group in driver_corners.GROUPS:
            sides = c["groups"][group]
            assert len(sides["a"]["speed"]) == len(sides["b"]["speed"]) == len(sides["a"]["throttle"]) > 10
            assert sides["a"]["passes"] == 3
    assert client.get(f"/report/drivers/corners?a={a}&b={b}").content == r.content  # kept

    assert client.get(f"/report/drivers/corners?a={a}&b={anna[0]}").status_code == 422  # a run on both sides
    elsewhere = client.post("/events", json={"name": "Elsewhere", "track_id": track["id"]}).json()["id"]
    other = _named(client, elsewhere, "FP1", "Ben", FAST[:4])
    assert client.get(f"/report/drivers/corners?a={a}&b={other}").status_code == 422  # two events


def test_corners_say_when_the_sessions_differ(client):
    _, ids = _two_drivers(client)  # Anna's runs and Ben's are sessions of their own
    r = client.get(f"/report/drivers/corners?a={','.join(map(str, ids['Anna']))}&b={','.join(map(str, ids['Ben']))}")
    assert r.status_code == 200, r.text
    m = r.json()["matched"]
    assert not m["same_sessions"] and m["parts"] == [] and m["left_out"] == []
    assert m["by_side"] == {"a": ["Anna 1", "Anna 2"], "b": ["Ben 1", "Ben 2"]}


def test_balance_per_driver_without_setup_advice(client):
    _, ids = _two_drivers(client)
    a, b = ",".join(map(str, ids["Anna"])), ",".join(map(str, ids["Ben"]))
    r = client.get(f"/report/drivers/balance?a={a}&b={b}")
    assert r.status_code == 200, r.text
    res = r.json()
    assert res["labels"] == {"a": "Anna", "b": "Ben"} and res["laps"]["a"] > 0 and res["laps"]["b"] > 0
    assert [s["code"] for s in res["sections"]] == ["T1", "T2"]
    for s in res["sections"]:
        for side in ("a", "b"):
            assert set(s[side]) == {"entry", "mid", "exit"}
            for cell in s[side].values():
                assert cell is None or {"value", "kind", "strength"} <= set(cell)
    text = json.dumps(res).lower()
    assert "setup" not in text and "advice" not in text
    flags = client.get(f"/report/drivers/flags?a={a}&b={b}").json()
    assert flags == {"status": "none", "a": [], "b": []}  # no technique check yet: none started here


def test_the_same_comparison_gets_its_job_again(client):
    _, ids = _two_drivers(client)
    body = {"a": {"label": "Anna", "session_ids": ids["Anna"]}, "b": {"label": "Ben", "session_ids": ids["Ben"]}}
    first = client.post("/compare/drivers/jobs", json=body).json()
    again = client.post("/compare/drivers/jobs", json={"a": {"label": " Anna ", "session_ids": ids["Anna"][::-1]},
                                                        "b": {"label": "Ben", "session_ids": ids["Ben"][::-1]}})
    assert again.json()["id"] == first["id"]  # in any order
    other = client.post("/compare/drivers/jobs", json={**body, "b": {"label": "Benedikt", "session_ids": ids["Ben"]}})
    assert other.json()["id"] != first["id"]
    for _ in range(300):
        job = client.get(f"/compare/drivers/jobs/{first['id']}").json()
        if job["status"] in ("done", "failed"):
            break
        time.sleep(0.1)
    assert job["status"] == "done", job["error"]
    assert client.post("/compare/drivers/jobs", json=body).json()["id"] == first["id"]  # kept finished: that one
    from app.routers import comparisons
    comparisons._jobs[first["id"]]["status"] = "failed"
    assert client.post("/compare/drivers/jobs", json=body).json()["id"] != first["id"]  # a failed one: started again
