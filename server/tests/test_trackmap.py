import numpy as np
import pytest

from app.analysis.laps import analyze, load_session
from app.analysis.trackmap import STEP_M, NoGpsError, NoLapError, track_map
from app.importers.motec import read_ld
from tests.synthetic import TRACK_M, simulate, write_ld

# laid out like Hockenheim: a flat T1, a sector of four corners counted as one section, two corners close together
SECTORED = [("T1", 100, None), ("T2", 280, "T2-T5"), ("T3", 300, "T2-T5"), ("T4", 320, "T2-T5"),
            ("T5", 520, "T2-T5"), ("T6", 690, None), ("T7", 740, None)]
R = TRACK_M / (2 * np.pi)  # the synthetic track is a circle driven anticlockwise from its southern point


@pytest.fixture(scope="module")
def data():
    return load_session(read_ld(write_ld(simulate()[0])))


def test_map_is_the_reference_lap_in_metres(data):
    m = track_map(data, SECTORED)
    ref = min((l for l in data.laps if l.clean), key=lambda l: l.time)
    assert m["reference_lap"] == ref.number and m["lap_time"] == ref.time
    assert m["step_m"] == STEP_M and len(m["x"]) == len(m["y"]) == len(m["speed"]) == -(-m["length_m"] // STEP_M)
    x, y = np.array(m["x"]), np.array(m["y"])
    # a circle of the track's radius around the lap's mean position, closed from the last point to the first
    assert np.abs(np.hypot(x - x.mean(), y - y.mean()) - R).max() < 2.0
    assert np.hypot(x[-1] - x[0], y[-1] - y[0]) < STEP_M * 1.5
    assert not m["clockwise"]
    # the line is at the southern point and the car crosses it heading east
    start = m["start"]
    assert (start["x"], start["y"]) == (x[0], y[0]) and abs(start["y"] - y.min()) < 1.0
    assert start["dx"] > 0.99 and abs(start["heading"] - 90) < 3
    # slowest where the corners are
    speed = np.array(m["speed"])
    assert abs(np.argmin(speed[: len(speed) // 2]) * STEP_M - 300) < 20


def test_map_sections_are_the_analysis_sections(data):
    m = track_map(data, SECTORED)
    res = analyze(data, corners=SECTORED)
    assert m["numbering"] == res["numbering"] == "official"
    assert [(s["code"], s["start_m"], s["end_m"], s["apex_m"]) for s in m["sections"]] == [
        (c["code"], c["start_m"], c["end_m"], c["apex_m"]) for c in res["corners"]]
    assert [s["code"] for s in m["sections"]] == ["T1", "T2-T5", "T6/T7"]
    ref = res["reference_lap"]
    assert [(s["time"], s["min_speed"]) for s in m["sections"]] == [
        (c["laps"][ref]["time"], c["laps"][ref]["min_speed"]) for c in res["corners"]]
    assert m["sections"][1]["corners"] == ["T2", "T3", "T4", "T5"]
    # labels sit at the analysis' apex, on the path
    for s in m["sections"]:
        i = round(s["apex_m"] / STEP_M)
        assert np.hypot(s["apex"]["x"] - m["x"][i], s["apex"]["y"] - m["y"][i]) < STEP_M
    # each official corner on its own, at its official distance round the circle
    assert [c["code"] for c in m["corners"]] == [c[0] for c in SECTORED]
    t6 = next(c for c in m["corners"] if c["code"] == "T6")
    i = round(690 / STEP_M)
    assert np.hypot(t6["x"] - m["x"][i], t6["y"] - m["y"][i]) < STEP_M


def test_map_without_official_numbers(data):
    m = track_map(data)
    assert m["numbering"] == "detected"
    assert [s["code"] for s in m["sections"]] == [c["code"] for c in analyze(data)["corners"]] == ["C1", "C2"]
    assert m["corners"] == []


def test_map_of_another_lap_and_missing_laps(data):
    assert track_map(data, ref_number=3)["reference_lap"] == 3
    with pytest.raises(NoLapError):
        track_map(data, ref_number=99)
    no_gps = {k: v for k, v in simulate()[0].items() if not k.startswith("GPS")}
    with pytest.raises(NoGpsError):
        track_map(load_session(read_ld(write_ld(no_gps))))


def test_the_event_map_comes_from_the_quickest_session_that_can_draw_it(client, monkeypatch):
    """The event map is drawn from the event's fastest clean lap. At Zandvoort that was a pit log's 3 s "lap" (two
    marker pulses in the pit lane, fixed in the lap timing), which has no lap of GPS path: the whole event's map
    answered 422. One session whose log can't draw the track no longer leaves the event without a map."""
    import app.routers.trackmap as trackmap

    event = client.post("/events", json={"name": "Race weekend"}).json()
    sessions = {}
    for name, paces, gps in (("Quickest, no GPS", (0.95, 1.0, 0.97), False), ("With GPS", (0.9, 0.95), True)):
        channels = simulate(paces=paces)[0]
        if not gps:
            channels = {k: v for k, v in channels.items() if not k.startswith("GPS")}
        s = client.post("/sessions", json={"event_id": event["id"], "name": name}).json()
        assert client.post(f"/sessions/{s['id']}/files", files={"file": ("run.ld", write_ld(channels))}).status_code \
            == 201
        sessions[name] = s["id"]

    assert client.get(f"/sessions/{sessions['Quickest, no GPS']}/map").status_code == 422
    r = client.get(f"/events/{event['id']}/map")
    assert r.status_code == 200, r.text
    m = r.json()
    assert m["session_id"] == sessions["With GPS"] and len(m["x"]) > 100
    assert m["event_fastest"] is False  # so the map doesn't call its lap the event's fastest
    # asked again: neither log is read, the one without GPS included
    with monkeypatch.context() as mp:
        mp.setattr(trackmap, "read_file", lambda f: pytest.fail("a log was read again"))
        assert client.get(f"/events/{event['id']}/map").json() == m
        assert client.get(f"/sessions/{sessions['Quickest, no GPS']}/map").status_code == 422


def test_session_and_event_map_endpoints(client, monkeypatch):
    import app.routers.trackmap as trackmap

    track = client.post("/tracks", json={"name": "Test ring", "corners": [
        {"code": code, "apex_m": m, "sector": sector} for code, m, sector in SECTORED]}).json()
    event = client.post("/events", json={"name": "Test day", "track_id": track["id"]}).json()
    slow = client.post("/sessions", json={"event_id": event["id"], "name": "Run 1"}).json()
    fast = client.post("/sessions", json={"event_id": event["id"], "name": "Run 2"}).json()
    empty = client.post("/sessions", json={"event_id": event["id"], "name": "No log"}).json()
    for s, paces in ((slow, (0.9, 0.95)), (fast, (0.95, 1.0, 0.97))):
        log = write_ld(simulate(paces=paces)[0])
        assert client.post(f"/sessions/{s['id']}/files", files={"file": ("run.ld", log)}).status_code == 201

    m = client.get(f"/sessions/{fast['id']}/map")
    assert m.status_code == 200, m.text
    m = m.json()
    assert m["session_id"] == fast["id"] and m["numbering"] == "official"
    analysis = client.get(f"/sessions/{fast['id']}/analysis").json()
    assert [(s["code"], s["start_m"], s["end_m"]) for s in m["sections"]] == [
        (c["code"], c["start_m"], c["end_m"]) for c in analysis["corners"]]
    assert m["reference_lap"] == analysis["reference_lap"]

    # served again without reading the log
    with monkeypatch.context() as mp:
        mp.setattr(trackmap, "read_file", lambda f: pytest.fail("the log was read again"))
        assert client.get(f"/sessions/{fast['id']}/map").json() == m

    ev = client.get(f"/events/{event['id']}/map").json()
    assert ev["session_id"] == fast["id"] and ev["reference_lap"] == m["reference_lap"] and ev["event_fastest"]
    assert "event_fastest" not in client.get(f"/sessions/{fast['id']}/map").json()
    assert client.get(f"/sessions/{slow['id']}/map", params={"reference_lap": 2}).json()["reference_lap"] == 2

    assert client.get(f"/sessions/{empty['id']}/map").status_code == 404
    assert client.get(f"/sessions/{slow['id']}/map", params={"reference_lap": 42}).status_code == 404
    assert client.get("/events/999/map").status_code == 404
    other = client.post("/events", json={"name": "Nothing yet"}).json()
    assert client.get(f"/events/{other['id']}/map").status_code == 404
