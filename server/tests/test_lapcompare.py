import numpy as np
import pytest

from app.analysis import lapcompare
from app.analysis.align import track_line
from app.analysis.channels import BRAKE, MID
from app.analysis.lapcompare import PHASE_NAMES, Pick, compare_picks, differences
from app.analysis.laps import load_session
from app.importers.motec import read_ld
from tests import synthetic
from tests.synthetic import simulate, write_ld

CORNERS = [("T1", 300, None), ("T2", 700, None)]


def _run(paces, monkeypatch=None, speed=None):
    if speed is not None:
        monkeypatch.setattr(synthetic, "speed_at", speed)
    channels, times = simulate(paces=paces)
    if speed is not None:
        monkeypatch.undo()
    return load_session(read_ld(write_ld(channels))), times


def _early_braker(d, pace):
    """The synthetic lap, but braking for T2 starts earlier: a wider dip on the way into the corner."""
    width = np.where(d < 700, 75.0, 45.0)
    v = 150.0 - 100.0 * np.exp(-((d - 300) / 45.0) ** 2) - 80.0 * np.exp(-((d - 700) / width) ** 2)
    return v * pace


def _loader(runs, calls):
    def load(name):
        calls.append(name)
        data, _ = runs[name]
        return data
    return load


def test_laps_from_different_runs_on_one_line(monkeypatch):
    runs = {"quick": _run((1.0, 0.99)), "early": _run((1.0, 0.98), monkeypatch, _early_braker)}
    calls, lines = [], []

    def line_of(data, lap):
        lines.append(lap.number)
        return track_line(data, lap)

    monkeypatch.setattr(lapcompare, "track_line", line_of)
    picks = [Pick("early", 1, runs["early"][1][1], {"session": "Early"}), Pick("quick", 2, runs["quick"][1][2]),
             Pick("quick", 1, runs["quick"][1][1])]
    res = compare_picks(picks, _loader(runs, calls), CORNERS)

    assert calls == ["quick", "early"]  # each run read once, the quickest lap's first
    assert lines == [1]  # every lap is placed on the quickest lap's path, whatever the order of the picks
    assert res["numbering"] == "official" and [s["code"] for s in res["sections"]] == ["T1", "T2"]
    assert res["reference"] == 2 and res["laps"][0]["session"] == "Early"
    assert [x["lap"] for x in res["laps"]] == [1, 2, 1]
    for s in res["sections"]:
        assert len(s["times"]) == 3 and s["times"][s["best"]] == min(s["times"])
    # the ideal lap is the quickest of each section, never slower than any lap
    assert res["ideal"]["time"] == pytest.approx(sum(min(s["times"]) for s in res["sections"]), abs=0.002)
    assert res["ideal"]["time"] <= min(x["time"] for x in res["laps"]) + 0.01

    # the early braker loses at T2, braking, because it brakes earlier
    early = res["opportunities"][0]
    top = early["sections"][0]
    assert top["code"] == "T2" and top["loss_s"] > 0.05 and top["versus"] == 2
    assert top["phase"] == "braking" and top["phase_loss_s"] == max(top["by_phase"].values())
    assert top["differences"][0]["metric"] == "brake_point"
    assert top["differences"][0]["text"].startswith("brakes ") and top["differences"][0]["text"].endswith("m earlier")
    assert top["where_m"][0] < 700 < top["where_m"][1] + 100
    assert early["to_ideal"] == pytest.approx(res["laps"][0]["to_ideal"])
    assert set(PHASE_NAMES.values()) == set(top["by_phase"])

    tr = res["traces"]
    assert tr["distance"][0] == 0 and tr["distance"][-1] == res["length_m"]
    assert {"speed", "throttle", "brake", "steer"} <= set(tr["roles"])
    for lap in [*tr["laps"], tr["ideal"]]:
        assert len(lap["t"]) == len(tr["distance"]) and len(lap["speed"]) == len(tr["distance"])
        assert np.all(np.diff(lap["t"]) > 0)
    assert tr["ideal"]["t"][-1] == pytest.approx(res["ideal"]["time"], abs=0.002)
    assert res["aligned_by"] == "gps" and res["channels"]["speed"] == "vCar"
    assert [c["code"] for c in res["track_corners"]] == ["T1", "T2"]


def test_each_run_is_read_under_the_guard():
    runs = {"a": _run((1.0, 0.99)), "b": _run((1.0, 0.98))}
    events = []

    class Guard:  # stands in for the server's one-log-at-a-time lock
        held = False

        def __enter__(self):
            self.held = True
            events.append("take")

        def __exit__(self, *exc):
            self.held = False
            events.append("let go")

    guard = Guard()

    def load(name):
        assert guard.held  # a log is only read while the guard is held
        events.append(name)
        return runs[name][0]

    picks = [Pick("a", 2, runs["a"][1][2]), Pick("b", 1, runs["b"][1][1])]
    compare_picks(picks, load, CORNERS, guard=guard)
    first, second = (p.run for p in sorted(picks, key=lambda p: p.time))
    assert events == ["take", first, "let go", "take", second, "let go"]  # one run at a time, let go in between


def test_lap_picks_are_checked():
    runs = {"a": _run((1.0, 0.99))}
    with pytest.raises(ValueError, match="no lap 9"):
        compare_picks([Pick("a", 1, 50.0), Pick("a", 9, 49.0)], _loader(runs, []))
    with pytest.raises(ValueError, match="2 to 6"):
        compare_picks([Pick("a", 1, 50.0)], _loader(runs, []))


def test_differences_in_plain_words():
    lap = {"brake_point": 2400, "peak_brake": 60.0, "grip_braking": 0.80, "min_speed": 98.0, "throttle_on": 2520,
           "full_throttle": 2600, "coasting": 0.5, "grip_mid": 0.85, "steering_activity": 9.0}
    quicker = {"brake_point": 2412, "peak_brake": 70.0, "grip_braking": 0.86, "min_speed": 101.5, "throttle_on": 2505,
               "full_throttle": 2560, "coasting": 0.1, "grip_mid": 0.85, "steering_activity": 8.0}
    words = [d["text"] for d in differences(lap, quicker, BRAKE)]
    assert words == ["brakes 12 m earlier", "brakes 14 % less hard", "uses 6 % less of the car's grip braking"]
    words = [d["text"] for d in differences(lap, quicker, MID)]
    assert words[:2] == ["minimum speed 4 km/h lower", "coasts 0.4 s longer (off both pedals)"]
    # the quicker lap's own choices are not held against it
    assert differences(quicker, lap, BRAKE) == []
    # in a section of several corners the minimum speed is told for the corner where it is lowest
    lap["corner_min"], quicker["corner_min"] = {"T15": 110.0, "T16": 108.0}, {"T15": 109.0, "T16": 113.0}
    assert differences(lap, quicker, MID)[0]["text"] == "minimum speed in T16 5 km/h lower"


def _upload(client, session, paces):
    r = client.post(f"/sessions/{session['id']}/files", files={"file": ("run.ld", write_ld(simulate(paces=paces)[0]))})
    assert r.status_code == 201, r.text


def test_compare_endpoints(client):
    track = client.post("/tracks", json={"name": "Test ring", "corners": [
        {"code": "T1", "apex_m": 300}, {"code": "T2", "apex_m": 700}]}).json()
    event = client.post("/events", json={"name": "Test day", "track_id": track["id"]}).json()
    anna = client.post("/drivers", json={"name": "Anna"}).json()
    mine = client.post("/sessions", json={"event_id": event["id"], "name": "Run 1"}).json()
    hers = client.post("/sessions", json={"event_id": event["id"], "name": "Run 2", "driver_id": anna["id"]}).json()
    elsewhere = client.post("/sessions", json={"name": "Other track"}).json()  # its log names "Test Track"
    empty = client.post("/sessions", json={"event_id": event["id"], "name": "No log"}).json()
    for s, paces in ((mine, (0.97, 0.98)), (hers, (1.0, 0.99)), (elsewhere, (1.0,))):
        _upload(client, s, paces)

    groups = client.get("/compare/sessions").json()["tracks"]
    by_track = {g["track"]: g for g in groups}
    assert set(by_track) == {"Test ring", "Test Track"}
    ring = {s["name"]: s for s in by_track["Test ring"]["sessions"]}
    assert set(ring) == {"Run 1", "Run 2"}  # the session without a log has no laps to pick
    assert ring["Run 2"]["driver"] == "Anna" and ring["Run 1"]["driver"] is None
    assert ring["Run 2"]["best_lap"] == 1 and [l["number"] for l in ring["Run 2"]["laps"]] == [1, 2]

    picks = [{"session_id": mine["id"], "lap": 2}, {"session_id": hers["id"], "lap": 1},
             {"session_id": hers["id"], "lap": 2}]
    r = client.post("/compare/laps", json={"laps": picks})
    assert r.status_code == 200, r.text
    res = r.json()
    assert res["track"] == "Test ring" and [s["code"] for s in res["sections"]] == ["T1", "T2"]
    assert [(x["session"], x["lap"], x["driver"]) for x in res["laps"]] == [
        ("Run 1", 2, None), ("Run 2", 1, "Anna"), ("Run 2", 2, "Anna")]
    assert res["reference"] == 1 and res["opportunities"][0]["sections"]

    def post(laps):
        return client.post("/compare/laps", json={"laps": laps})

    assert post(picks[:1]).status_code == 422  # one lap alone
    assert post([picks[0], picks[0]]).status_code == 422
    assert post([picks[0], {"session_id": elsewhere["id"], "lap": 1}]).status_code == 422
    assert post([picks[0], {"session_id": hers["id"], "lap": 7}]).status_code == 404
    assert post([picks[0], {"session_id": empty["id"], "lap": 1}]).status_code == 404
