"""The lap guide of a coming weekend (app/prep/guide.py, GET /prep/events/{id}/guide): the gear map of the best lap at
the venue and each corner's best and typical pass, on synthetic logs."""
import numpy as np

from app import heavy
from app.analysis import compact
from app.analysis.laps import load_session
from app.importers.motec import read_ld
from app.prep import guide
from tests.test_events import CORNERS, _wait, log

SPEEDS = (40, 75, 115, 150, 190)  # where a gear's speed range ends, km/h: first gear below 40, sixth above 190


def _raw_gear(speed: np.ndarray, offset: int = 0) -> np.ndarray:
    return (np.searchsorted(SPEEDS, speed) + 1 + offset).astype(np.int8)


def _with_gears(cs: compact.CompactSession, offset: int) -> compact.CompactSession:
    """The synthetic logs have no gear channel: gears from the speed, with an offset (first gear = 1 + offset)."""
    cs.traces["gear"] = _raw_gear(cs.traces["speed"], offset)
    return cs


def _source(i: int, name: str) -> guide.Source:
    return guide.Source(i, name, "Anna", 1, "Test ring 2025", "2025")


def test_first_gear_is_the_gear_the_car_pulls_away_in():
    # the pit lane and the lap of a dash that logs neutral as 3, first gear as 5 (the BMW M4 GT4's NGearPos)
    t = np.arange(0, 600, 0.1)
    speed = np.concatenate([np.zeros(300), np.linspace(0, 55, 600), np.full(1100, 58), np.linspace(58, 230, 4000)])
    ratio = {5: 140, 6: 80, 7: 54, 8: 43, 9: 33, 10: 25}  # revs per km/h in each logged gear
    gear = np.where(speed < 2, 3, _raw_gear(speed, 4))
    gear[gear == 5] = np.where(speed[gear == 5] < 45, 5, 6)  # first gear up to 45 km/h, then second (not 40)
    rpm = np.array([ratio.get(int(g), 0) * v for g, v in zip(gear, speed, strict=True)])
    lap_lowest = 6  # second gear: the slowest corner of the lap
    assert guide.first_gear((t, gear.astype(float)), (t, speed), (t, rpm), lap_lowest) == 5
    # without the revs it reads the same
    assert guide.first_gear((t, gear.astype(float)), (t, speed), None, lap_lowest) == 5
    # a log that starts on the track: nothing below the lap's lowest gear is driven, so that one counts as first
    on_track = speed > 60
    assert guide.first_gear((t[on_track], gear[on_track].astype(float)), (t[on_track], speed[on_track]),
                            (t[on_track], rpm[on_track]), lap_lowest) == 6
    # a value below the lap's lowest gear, driven, but with no more revs per km/h than that gear: not a gear below
    idle = np.where(gear == 5, 900, rpm)  # rolling in neutral at idle
    assert guide.first_gear((t, gear.astype(float)), (t, speed), (t, idle), lap_lowest) == 6


def test_the_gear_map_and_each_corners_best_and_typical_pass():
    runs = [_with_gears(compact.reduce_session(load_session(read_ld(log(p))), n), 4)
            for n, p in (("a", (0.95, 0.96, 0.97)), ("b", (0.99, 1.0, 0.98)))]
    ref_cs = runs[1]
    lap = int(np.argmin(ref_cs.times))
    assert guide.lowest_gear(ref_cs, lap) >= 5  # as logged
    g = guide.Guide(_source(2, "b"), ref_cs, lap, CORNERS, first=5)
    g.add(_source(1, "a"), runs[0])
    out = g.result()

    assert out["numbering"] == "official" and out["laps"] == runs[0].n_laps + runs[1].n_laps
    assert out["best_lap"]["session"] == "b" and out["best_lap"]["time"] == round(float(ref_cs.times.min()), 3)
    assert out["gears"] == {"first_logged_as": 5, "as_logged": False}
    m = out["map"]
    assert m is not None and len(m["x"]) == len(m["y"]) == len(m["gear"]) == len(range(0, m["length_m"], 10))
    held = {x for x in m["gear"] if x is not None}
    assert held and min(held) >= 1 and max(held) <= 6  # numbered from first gear, not as logged
    assert [c["code"] for c in m["corners"]] == ["T1", "T2"]
    for c in m["corners"]:  # the lowest gear through each corner: the gear its slowest speed is in
        assert c["gear"] in held
    assert m["braking"] and all(b["gear_out"] <= b["gear_in"] for b in m["braking"] if b["gear_in"] and b["gear_out"])

    codes = [c["code"] for c in out["corners"]]
    assert set(codes) == {"T1", "T2"} or codes == [s.code for s in g.ref.sections]
    for c in out["corners"]:
        best, typical = c["best"], c["typical"]
        assert c["passes"] == out["laps"]
        assert best["time"] <= typical["time"] and c["gain_s"] == round(typical["time"] - best["time"], 3)
        n = len(best["speed"])
        assert n == len(typical["speed"]) == len(best["throttle"]) == len(best["brake"]) == len(best["gear"])
        assert c["x0_m"] >= c["start_m"] and c["x0_m"] + (n - 1) * out["step_m"] <= c["end_m"]
        assert min(best["speed"]) > 30
        # the best pass is the quickest of every lap through the section: one of the quick session b's laps here
        assert best["session"] == "b"
    marks = [k["code"] for c in out["corners"] for k in c["marks"]]
    assert marks == ["T1", "T2"]


def test_guide_endpoint_from_past_events(client, monkeypatch):
    held = []  # whether the heavy-work lock is held while the guide is made
    result = guide.Guide.result
    monkeypatch.setattr(guide.Guide, "result",
                        lambda self: held.append(getattr(heavy.lock._held, "depth", 0)) or result(self))
    track = client.post("/tracks", json={"name": "Test ring", "corners": [
        {"code": c, "apex_m": m, "sector": s} for c, m, s in CORNERS]}).json()
    past = client.post("/events", json={"name": "Test ring 2025", "track_id": track["id"]}).json()
    for n, paces in enumerate(((0.95, 0.97, 0.96), (0.99, 1.0, 0.98))):
        s = client.post("/sessions", json={"event_id": past["id"], "name": f"Run {n + 1}"}).json()
        r = client.post(f"/sessions/{s['id']}/files", files={"file": ("run.ld", log(paces))})
        assert r.status_code == 201, r.text
    client.patch(f"/events/{past['id']}", json={"start": "2025-05-05", "end": "2025-05-06"})
    coming = client.post("/events", json={"name": "Test ring 2027", "track_id": track["id"]}).json()
    client.patch(f"/events/{coming['id']}", json={"start": "2027-05-03", "end": "2027-05-04"})

    body = _wait(client, f"/prep/events/{coming['id']}/guide")
    assert body["status"] == "ready", body
    assert held and all(held)
    assert body["numbering"] == "official"
    assert body["best_lap"]["session"] == "Run 2" and body["best_lap"]["year"] == "2025"
    assert [c["code"] for c in body["corners"]] and all(c["best"] for c in body["corners"])
    # the synthetic logs have no gear channel: the map is drawn without gears
    assert body["map"]["gear"] is None and body["gears"]["as_logged"]
    assert client.get(f"/prep/events/{coming['id']}/guide").json() == body  # kept

    alone = client.post("/events", json={"name": "Somewhere new"}).json()
    assert client.get(f"/prep/events/{alone['id']}/guide").json()["status"] == "none"
    assert client.get("/prep/events/9999/guide").status_code == 404
