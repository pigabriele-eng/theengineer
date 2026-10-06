import numpy as np
import pytest

from app.analysis.laps import Section
from tests.synthetic import simulate, write_ld
from tests.test_trackmap import SECTORED


class FakeShape:
    """What track_shape returns, as the endpoints use it: features on the line, in metres."""

    def __init__(self, n: int, features: list[dict]):
        self.n, self.features = n, features

    def to_dict(self) -> dict:
        k = -(-self.n // 5)
        return {"step_m": 5, "elevation_m": [0.0] * k, "bank_deg": [None] * k, "load_g": [1.0] * k,
                "features": [dict(f) for f in self.features]}


def test_corner_of_names_the_section_holding_the_middle():
    from app.routers.trackshape import corner_of

    sections = [Section("T1", 0, 200, 100), Section("T2-T5", 200, 600, 300), Section("T6/T7", 600, 999, 700)]
    assert corner_of(sections, 250, 330, 1000) == "T2-T5"
    assert corner_of(sections, 150, 290, 1000) == "T2-T5"  # mostly before T2-T5 starts, but its middle is in it
    assert corner_of(sections, 0, 40, 1000) == "T1"
    assert corner_of(sections, 990, 999, 1000) == "T6/T7"  # the last metre belongs to the last section
    # through the timing line: from 900 m to 60 m of the next lap, its middle at 980 m
    assert corner_of(sections, 900, 60, 1000) == "T6/T7"
    assert corner_of(sections, 960, 80, 1000) == "T1"
    assert corner_of([], 10, 20, 1000) is None


def test_banked_note_names_banked_corners_by_number():
    from app.routers.trackshape import banked_note

    crest = {"kind": "crest", "start_m": 10, "end_m": 30, "value": 0.7, "corner": "C1"}
    assert banked_note([crest]) is None
    one = [crest, {"kind": "banked", "start_m": 800, "end_m": 900, "value": 14.6, "corner": "C3"}]
    assert banked_note(one) == "C3 is banked (about 15 degrees): its grip isn't compared with flat corners."
    two = [*one, {"kind": "banked", "start_m": 3600, "end_m": 3700, "value": 17.8, "corner": "C9"},
           {"kind": "banked", "start_m": 905, "end_m": 920, "value": 9.0, "corner": "C3"}]  # C3 again: its most
    assert banked_note(two) == ("C3 and C9 are banked (about 15 and 18 degrees): their grip isn't compared with flat "
                                "corners.")
    three = [*two, {"kind": "banked", "start_m": 3900, "end_m": 3950, "value": 6.2, "corner": "T14"}]
    assert banked_note(three).startswith("C3, C9 and T14 are banked (about 15, 18 and 6 degrees)")


def _setup(client):
    track = client.post("/tracks", json={"name": "Test ring", "corners": [
        {"code": code, "apex_m": m, "sector": sector} for code, m, sector in SECTORED]}).json()
    event = client.post("/events", json={"name": "Test day", "track_id": track["id"]}).json()
    slow = client.post("/sessions", json={"event_id": event["id"], "name": "Run 1"}).json()
    fast = client.post("/sessions", json={"event_id": event["id"], "name": "Run 2"}).json()
    # the fast run holds the quickest lap and the third quickest; the slow run the second quickest
    for s, paces in ((slow, (0.99, 0.9)), (fast, (0.95, 1.0, 0.97))):
        log = write_ld(simulate(paces=paces)[0])
        assert client.post(f"/sessions/{s['id']}/files", files={"file": ("run.ld", log)}).status_code == 201
    return event, slow, fast


def test_shape_endpoints_label_features_with_the_map_corners(client, monkeypatch):
    import app.routers.trackshape as trackshape

    event, slow, fast = _setup(client)
    seen: list[list[dict]] = []

    def fake(traces):
        seen.append(traces)
        n = len(traces[0]["speed"]) - 1
        return FakeShape(n, [{"kind": "banked", "start_m": 280, "end_m": 330, "value": 12.4},
                             {"kind": "crest", "start_m": 680, "end_m": 700, "value": 0.71}])

    monkeypatch.setattr(trackshape, "track_shape", fake)
    m = client.get(f"/sessions/{fast['id']}/map").json()
    r = client.get(f"/sessions/{fast['id']}/shape")
    assert r.status_code == 200, r.text
    s = r.json()
    # on the map's line: its reference lap and length, its sections as the corners
    assert (s["session_id"], s["reference_lap"], s["length_m"]) == (fast["id"], m["reference_lap"], m["length_m"])
    assert s["numbering"] == m["numbering"] == "official"
    assert [(c["code"], c["start_m"], c["end_m"]) for c in s["corners"]] == [
        (x["code"], x["start_m"], x["end_m"]) for x in m["sections"]]
    assert [c["apex_m"] for c in s["corners"]] == [x["apex_m"] for x in m["sections"]]
    assert len(s["elevation_m"]) == len(m["x"])
    # each feature labelled with the section it falls in, as the map numbers them
    assert [(f["kind"], f["corner"]) for f in s["features"]] == [("banked", "T2-T5"), ("crest", "T6/T7")]
    assert s["banked_note"] == "T2-T5 is banked (about 12 degrees): its grip isn't compared with flat corners."
    # the session's clean laps (pace 1.0 and 0.97; 0.95 is more than 5 % off), every one on the same line and
    # grid, with the math channels
    (traces,) = seen
    assert s["laps"] == len(traces) == 2 and s["sessions"] == 1
    assert {len(tr["speed"]) for tr in traces} == {m["length_m"] + 1}
    assert {"ax", "ay", "curvature", "distance", "t"} <= set(traces[0])

    # served again without reading the log or working it out again
    with monkeypatch.context() as mp:
        mp.setattr(trackshape, "read_file", lambda f: pytest.fail("the log was read again"))
        assert client.get(f"/sessions/{fast['id']}/shape").json() == s
    assert len(seen) == 1

    # the event: the fast run's line (the event map's), its two quick laps and the slow run's quick one
    ev_map = client.get(f"/events/{event['id']}/map").json()
    ev = client.get(f"/events/{event['id']}/shape").json()
    assert ev["session_id"] == ev_map["session_id"] == fast["id"]
    assert ev["reference_lap"] == ev_map["reference_lap"] and ev["length_m"] == ev_map["length_m"]
    assert (ev["laps"], ev["sessions"]) == (3, 2)
    assert {len(tr["speed"]) for tr in seen[-1]} == {ev_map["length_m"] + 1}
    # at most EVENT_SESSIONS logs read
    monkeypatch.setattr(trackshape, "EVENT_SESSIONS", 1)
    trackshape._cache.clear()
    ev1 = client.get(f"/events/{event['id']}/shape").json()
    assert (ev1["laps"], ev1["sessions"]) == (2, 1)

    assert client.get(f"/sessions/{slow['id']}/shape").json()["session_id"] == slow["id"]
    assert client.get("/sessions/999/shape").status_code == 404
    assert client.get("/events/999/shape").status_code == 404
    other = client.post("/events", json={"name": "Nothing yet"}).json()
    assert client.get(f"/events/{other['id']}/shape").status_code == 404


def test_shape_the_logs_cant_tell(client, monkeypatch):
    import app.routers.trackshape as trackshape

    _, _, fast = _setup(client)
    calls = []
    monkeypatch.setattr(trackshape, "track_shape", lambda traces: calls.append(1))
    r = client.get(f"/sessions/{fast['id']}/shape")
    assert r.status_code == 404 and "can't tell" in r.json()["detail"]
    # remembered: the logs are not read again to find the same
    with monkeypatch.context() as mp:
        mp.setattr(trackshape, "read_file", lambda f: pytest.fail("the log was read again"))
        assert client.get(f"/sessions/{fast['id']}/shape").status_code == 404
    assert len(calls) == 1


def test_shape_with_the_detection_module(client):
    """The real detection on synthetic laps (a flat circle): whatever it finds, it answers on the map's grid."""
    _, _, fast = _setup(client)
    m = client.get(f"/sessions/{fast['id']}/map").json()
    r = client.get(f"/sessions/{fast['id']}/shape")
    assert r.status_code in (200, 404), r.text
    if r.status_code == 200:
        s = r.json()
        assert s["step_m"] == 5 and s["length_m"] == m["length_m"]
        assert len(s["elevation_m"]) == len(s["bank_deg"]) == len(s["load_g"]) == len(m["x"])
        assert all(f["kind"] in ("banked", "crest", "compression") and f["corner"] for f in s["features"])
        assert np.isfinite([v for v in s["elevation_m"] if v is not None]).all()
