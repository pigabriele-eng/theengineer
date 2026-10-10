"""Two stints side by side in the stint tool, to see whether a setup change worked (analysis/stint_compare.py,
routers/stint_compare.py)."""
import pytest

from app.analysis import stint_compare
from app.routers.stint_compare import default_pair
from tests.synthetic import simulate, write_ld

# ---------- the numbers ----------


def test_a_difference_is_clear_only_beyond_the_scatter():
    d = stint_compare.difference([100.0, 100.2, 99.9, 100.1], [99.6, 99.8, 99.5, 99.7])
    assert d["change"] == -0.4 and d["clear"] and 0 < d["within"] < 0.4
    noisy = stint_compare.difference([100.0, 101.0, 99.0, 100.5], [99.9, 100.8, 99.2, 100.1])
    assert not noisy["clear"]
    assert stint_compare.difference([100.0], [99.0, 99.1]) is None  # one lap: no scatter to judge by


def _stint(times, balance_mid, grip_exit, sections=()):
    return {"laps": [{"in_fit": True, "time": t, "grip": {"exit": g}, "balance": {"mid": b}, "tc_s": 1.0,
                      "abs_s": 0.0} for t, b, g in zip(times, balance_mid, grip_exit, strict=True)]
            + [{"in_fit": False, "time": 130.0, "grip": {"exit": 0.1}, "balance": {"mid": 9.0}}],
            "sections": list(sections), "fits": {"corrected_time": {"per_lap": 0.05, "within": 0.02, "clear": True}}}


def test_balance_grip_and_corners_say_what_moved():
    a = _stint([100.0, 100.1, 100.2, 100.1], [0.5, 0.6, 0.55, 0.5], [1.20, 1.21, 1.19, 1.20],
               [{"code": "T6", "corner": True, "mid": {"early": 0.8, "late": 1.0}},
                {"code": "T2", "corner": True, "mid": {"early": 0.2, "late": 0.2}}])
    b = _stint([99.8, 99.85, 99.9, 99.8], [0.1, 0.0, 0.05, 0.1], [1.25, 1.26, 1.24, 1.25],
               [{"code": "T6", "corner": True, "mid": {"early": 0.1, "late": 0.1}},
                {"code": "T2", "corner": True, "mid": {"early": 0.3, "late": 0.2}}])
    rows = stint_compare.phases(a, b)
    mid = next(r for r in rows if r["key"] == "mid")
    assert mid["balance"]["change"] == pytest.approx(-0.475, abs=0.01) and mid["balance"]["clear"]
    exit_ = next(r for r in rows if r["key"] == "exit")
    assert exit_["grip"]["clear"] and exit_["grip"]["pct"] == 4.2
    corners = stint_compare.corners(a, b)
    assert [(c["code"], c["phase"]) for c in corners] == [("T6", "mid")]  # T2 moved too little to show
    time = stint_compare.lap_time([r["time"] for r in a["laps"] if r["in_fit"]],
                                  [r["time"] for r in b["laps"] if r["in_fit"]])
    said = stint_compare.words({"a": "FP1", "b": "FP2"}, time, True, rows, corners, stint_compare.fade(a, b),
                               stint_compare.aids(a, b), [])
    assert said["headline"].startswith("FP2 was 0.26 s a lap quicker than FP1, like with like: a clear")
    assert any("mid-corner 0.5° towards oversteer" in line for line in said["car"])
    assert any(line.startswith("Most moved in: T6 mid-corner 0.8° towards oversteer") for line in said["car"])
    assert any("exit up 4.2 %" in line for line in said["car"])
    few = stint_compare.words({"a": "FP1", "b": "FP2"}, time, True, rows, corners, None, [], ["FP2"])
    assert few["headline"].startswith("Too few laps to compare: FP2 has fewer than 3")


def _choice(key, driver, tyres, laps=6):
    return {"key": key, "driver": driver, "tyres": tyres, "tyres_label": tyres.title() if tyres else None,
            "laps": laps}


def test_the_latest_stint_against_the_last_like_it():
    choices = [_choice("1", "PIA", "used"), _choice("2", "PIA", "new"), _choice("3", "RAC", "used"),
               _choice("4", "PIA", "used"), _choice("5", "PIA", "used", laps=1)]
    a, b, why = default_pair(choices)
    assert (a["key"], b["key"]) == ("1", "4") and "used tyres" in why  # 5 has too few laps, 2 other tyres
    a, b, why = default_pair([*choices[:3], _choice("4", "PIA", "worn")])
    assert (a["key"], b["key"]) == ("2", "4") and "PIA drove before it" in why
    a, b, _ = default_pair([_choice("1", "RAC", "used"), _choice("2", "PIA", "used")])
    assert (a["key"], b["key"]) == ("1", "2")


# ---------- the endpoint ----------


def _log(paces, stops=None) -> bytes:
    return write_ld(simulate(paces, stops=stops)[0])


def _run(client, event_id: int, name: str, paces) -> tuple[int, int]:
    s = client.post("/sessions", json={"event_id": event_id, "name": name}).json()
    up = client.post(f"/sessions/{s['id']}/files", files={"file": ("run.ld", _log(paces))})
    assert up.status_code == 201, up.text
    client.post("/drivers/assign", json={"driver_name": "Anna", "session_ids": [s["id"]]})
    return s["id"], up.json()["files"][0]["id"]


def test_two_runs_with_a_setup_change_between_them(client):
    track = client.post("/tracks", json={"name": "Test ring", "corners": [
        {"code": "T1", "apex_m": 300}, {"code": "T2", "apex_m": 690}]}).json()
    event = client.post("/events", json={"name": "Test day", "track_id": track["id"]}).json()["id"]
    fp1, f1 = _run(client, event, "FP1", (0.95, 0.952, 0.949, 0.951, 0.95, 0.948))
    fp2, f2 = _run(client, event, "FP2", (0.98, 0.979, 0.981, 0.98, 0.982, 0.978))
    for sid, bar, notes in ((fp1, 3, None), (fp2, 2, "Tried on this run: front anti-roll bar softer.")):
        r = client.put(f"/sessions/{sid}/setup", json={"template": "bmw-m4-gt4-evo", "values": {"arb_front": bar},
                                                       "notes": notes})
        assert r.status_code == 200, r.text

    r = client.get(f"/stint/compare?files={f1},{f2}")
    assert r.status_code == 200, r.text
    res = r.json()
    assert [c["run"] for c in res["choices"]] == ["FP1", "FP2"]
    assert res["picked"]["default"] and res["a"]["session_id"] == fp1 and res["b"]["session_id"] == fp2
    assert [c["text"] for c in res["setup"]["changes"]] == ["Anti-roll bar front 3 → 2"]
    assert res["setup"]["tried"] == ["front anti-roll bar softer"]
    assert res["lap_time"]["change"] < -0.5 and res["lap_time"]["clear"]
    assert res["words"]["headline"].startswith("FP2 was ")
    texts = [c["text"] for c in res["like_for_like"]]
    assert "Same driver: Anna." in texts and any(t.startswith("Different sessions") for t in texts)
    assert len(res["a"]["times"]) >= 3 and {"lap", "tyre_lap", "time", "corrected"} <= set(res["a"]["times"][0])

    # picked the other way round: FP2 first
    a, b = res["picked"]["b"], res["picked"]["a"]
    flipped = client.get(f"/stint/compare?files={f1},{f2}&a={a}&b={b}").json()
    assert not flipped["picked"]["default"] and flipped["lap_time"]["change"] > 0.5
    assert [c["text"] for c in flipped["setup"]["changes"]] == ["Anti-roll bar front 2 → 3"]
    assert client.get(f"/stint/compare?files={f1},{f2}&a={a}&b={a}").status_code == 422
    assert client.get(f"/stint/compare?files={f1},{f2}&a={a}&b=nope").status_code == 404
    single = client.get(f"/stint/compare?files={f1}")
    assert single.status_code == 422 and "add another run" in single.json()["detail"]


def test_two_stints_of_one_run(client):
    s = client.post("/sessions", json={"name": "Long run"}).json()
    paces = (0.95, 0.951, 0.949, 0.95, 0.6, 0.6, 0.97, 0.971, 0.969, 0.97)  # in-lap, 40 s stop, out-lap between
    up = client.post(f"/sessions/{s['id']}/files", files={"file": ("run.ld", _log(paces, stops={5: 40.0}))})
    fid = up.json()["files"][0]["id"]
    r = client.get(f"/stint/compare?files={fid}")
    assert r.status_code == 200, r.text
    res = r.json()
    assert [c["name"] for c in res["choices"]] == ["Long run · Stint 1", "Long run · Stint 2"]
    assert res["setup"]["same_run"] and res["setup"]["changes"] == []
    assert any(c["text"].startswith("Same session") for c in res["like_for_like"])
    assert res["lap_time"]["change"] < 0  # the second stint is quicker
