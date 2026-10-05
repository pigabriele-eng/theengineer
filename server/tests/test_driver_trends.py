"""Driver tagging and the driver comparison over many laps: synthetic data only."""
import threading
import time

import numpy as np

from app import heavy
from app.analysis.compare import SIDES, LapSummary, RunSource, _habit_flags, _habits, compare_groups
from app.analysis.insights import RunInput
from app.analysis.laps import load_session
from app.importers.motec import read_ld
from tests.synthetic import simulate, write_ld

FAST = (1.0, 0.99, 0.995, 0.985, 0.99, 0.992, 0.988, 0.996)
SLOW = (0.96, 0.95, 0.955, 0.958, 0.952, 0.957, 0.954, 0.953)


def _log(paces) -> bytes:
    return write_ld(simulate(paces=paces)[0])


def test_many_laps_compared_one_run_at_a_time():
    logs = {"slow 1": _log(SLOW), "slow 2": _log(SLOW[::-1]), "fast 1": _log(FAST), "fast 2": _log(FAST[::-1])}
    loaded: list[RunInput] = []

    def load(name):
        def run() -> RunInput:
            # every run read before this one has already been reduced to its laps and freed
            assert all(r.data.channels == {} and r.ld is None for r in loaded)
            assert not _free(heavy.lock)  # and no other request or job can read a log meanwhile
            r = RunInput(name, load_session(read_ld(logs[name])))
            loaded.append(r)
            return r
        return run

    sources = [RunSource(name, "a" if name.startswith("slow") else "b", load(name),
                         best=0.0 if name == "fast 2" else None, meta={"session": name}) for name in logs]
    seen = []
    res = compare_groups(sources, {"a": "Anna", "b": "Ben"}, [("T1", 300), ("T2", 690)],
                         progress=lambda done, current: seen.append((done, current)))
    assert seen[0] == (0, "fast 2")  # the quickest run is read first: its best lap is the reference
    assert [d for d, _ in seen] == [0, 1, 2, 3]
    assert res["numbering"] == "official" and [s["code"] for s in res["sections"]] == ["T1", "T2"]
    assert res["summary"]["a"]["laps"] == res["summary"]["b"]["laps"] == 16
    assert res["summary"]["a"]["label"] == "Anna" and res["summary"]["a"]["runs"] == 2
    assert res["median_gap_s"] > 0.5  # Anna is slower
    for s in res["sections"]:
        assert s["faster"] == "b" and s["delta_s"] > 0
        assert s["consistency"] == 1.0 and s["beats"]["a"] == 0.0  # every one of Ben's laps beats Anna's median
        assert s["clear"] and s["main_phase"] in ("braking", "trail", "mid", "exit", "power")
        assert len(s["times"]["a"]) == len(s["times"]["b"]) == 16
        rows = {r["metric"]: r for r in s["technique"]}
        assert rows["min_speed"]["a"] < rows["min_speed"]["b"]  # Ben carries more speed
        assert rows["brake_point"]["a"] < 0 < rows["throttle_on"]["b"] + 60  # metres from the apex
    assert {w["faster"] for w in res["where_time_goes"]} == {"b"}
    assert set(res["habits"]) == {"a", "b"}
    assert len(res["laps"]) == 32 and {r["session"] for r in res["runs"]} == set(logs)
    assert set(res["top_speeds"][0]["groups"]) == {"a", "b"}
    n = len(res["delta_trace"]["gap_s"])
    assert n == len(res["speed_trace"]["a"]) == len(res["speed_trace"]["b"]) > 100
    assert res["delta_trace"]["gap_s"][-1] > 0.5
    assert _free(heavy.lock)  # released once the runs are read


def _free(lock) -> bool:
    """Whether another thread could take the lock now."""
    got = []

    def take():
        if lock.acquire(blocking=False):
            got.append(True)
            lock.release()
    t = threading.Thread(target=take)
    t.start()
    t.join()
    return bool(got)


def test_a_side_without_clean_laps_is_reported():
    log = _log(FAST)
    sources = [RunSource("a run", "a", lambda: RunInput("a run", load_session(read_ld(log)))),
               RunSource("b run", "b", lambda: _no_laps("b run"))]
    res = compare_groups(sources, {"a": "Anna", "b": "Ben"})
    assert res["error"] == "No clean laps for Ben"


def _no_laps(name: str) -> RunInput:
    data = load_session(read_ld(_log(FAST)))
    data.laps = []
    return RunInput(name, data)


def _lap(side: str, i: int, time_s: float, **metrics) -> LapSummary:
    z = np.zeros(10, np.float32)
    return LapSummary(side, f"{side} run {i % 2}", i, 100.0, i, [{"time": time_s, **metrics}], z, z, z, z,
                      np.zeros(10, np.int8), z)


def test_habits_are_counted_and_costed():
    laps = []
    for i in range(10):  # Anna coasts before turn-in on 6 laps of 10 and those laps are 0.2 s slower
        coasts = i < 6
        laps.append(_lap("a", i, 10.5 if coasts else 10.3, coast_turn_in=0.4 if coasts else 0.02,
                         brake_point=400.0 + (25 if i % 2 else -25) * (i < 4), throttle_on=520.0))
    for i in range(10):  # Ben never coasts and brakes at the same point every lap
        laps.append(_lap("b", 10 + i, 10.1 + 0.01 * i, coast_turn_in=0.0, brake_point=405.0, throttle_on=515.0))
    sides = np.array([x.side for x in laps])
    times = np.array([x.sections[0]["time"] for x in laps])
    quick = times <= np.percentile(times, 25)
    flags = _habit_flags(laps, 0, quick, sides)
    assert int(np.nansum(flags["coast_turn_in"][0][sides == "a"])) == 6
    found = _habits([("T6", times, flags)], sides)
    assert set(found) == set(SIDES) and found["b"] == []
    coast = next(h for h in found["a"] if h["kind"] == "coast_turn_in")
    assert coast["label"] == "Coasting before turn-in"
    (t6,) = coast["sections"]
    assert (t6["code"], t6["laps"], t6["of"], t6["share"]) == ("T6", 6, 10, 0.6)
    assert t6["cost_s"] == 0.2 and t6["basis"] == "own laps" and coast["per_lap_s"] == 0.12
    assert t6["value"] == 0.4  # seconds coasting on the laps it happens
    assert found["a"][0]["per_lap_s"] >= found["a"][-1]["per_lap_s"]  # worst habit first


def _upload(client, session_id: int, paces) -> None:
    r = client.post(f"/sessions/{session_id}/files", files={"file": ("run.ld", _log(paces))})
    assert r.status_code == 201, r.text


def test_drivers_are_set_on_sessions_one_at_a_time_or_many(client):
    event = client.post("/events", json={"name": "Test day"}).json()
    ids = [client.post("/sessions", json={"event_id": event["id"], "name": f"Run {i}"}).json()["id"] for i in range(3)]
    other = client.post("/sessions", json={"name": "Elsewhere"}).json()["id"]

    r = client.post("/drivers/assign", json={"driver_name": " Anna ", "event_ids": [event["id"]]})
    assert r.status_code == 200, r.text
    anna = r.json()["driver"]
    assert anna["name"] == "Anna" and r.json()["session_ids"] == ids
    # the same name again is the same driver, whatever the case
    r = client.post("/drivers/assign", json={"driver_name": "anna", "session_ids": [other]}).json()
    assert r["driver"]["id"] == anna["id"]
    assert [d["name"] for d in client.get("/drivers").json()] == ["Anna"]
    rows = {s["id"]: s["driver_id"] for s in client.get("/sessions").json()}
    assert all(rows[i] == anna["id"] for i in [*ids, other])

    ben = client.post("/drivers", json={"name": "Ben"}).json()
    r = client.put(f"/sessions/{ids[1]}/driver", json={"driver_id": ben["id"]})
    assert r.status_code == 200 and r.json()["driver"]["name"] == "Ben"
    assert client.get(f"/sessions/{ids[1]}").json()["driver_id"] == ben["id"]
    r = client.post("/drivers/assign", json={"session_ids": [ids[2]]})  # no driver given: cleared
    assert r.json()["driver"] is None and client.get(f"/sessions/{ids[2]}").json()["driver_id"] is None

    assert client.post("/drivers/assign", json={"driver_id": ben["id"]}).status_code == 422
    assert client.post("/drivers/assign", json={"driver_id": ben["id"], "session_ids": [999]}).status_code == 404
    assert client.post("/drivers/assign", json={"driver_id": 999, "session_ids": [ids[0]]}).status_code == 404
    assert client.put(f"/sessions/{ids[0]}/driver", json={"driver_id": 999}).status_code == 404

    assert client.patch(f"/drivers/{ben['id']}", json={"name": "Benedikt"}).json()["name"] == "Benedikt"
    assert client.delete(f"/drivers/{ben['id']}").status_code == 204
    assert client.get(f"/sessions/{ids[1]}").json()["driver_id"] is None  # the session stays, without a driver
    assert [d["name"] for d in client.get("/drivers").json()] == ["Anna"]


def _two_drivers(client):
    track = client.post("/tracks", json={"name": "Test ring", "corners": [
        {"code": "T1", "apex_m": 300}, {"code": "T2", "apex_m": 690}]}).json()
    event = client.post("/events", json={"name": "Test day", "track_id": track["id"]}).json()
    out = {}
    for name, paces in (("Anna", SLOW), ("Ben", FAST)):
        ids = []
        for half in (paces[:4], paces[4:]):
            s = client.post("/sessions", json={"event_id": event["id"], "name": f"{name} {len(ids) + 1}"}).json()
            _upload(client, s["id"], half)
            ids.append(s["id"])
        client.post("/drivers/assign", json={"driver_name": name, "session_ids": ids})
        out[name] = ids
    return track, out


def test_compare_options_and_jobs(client):
    track, ids = _two_drivers(client)
    client.post("/sessions", json={"name": "No log yet"})
    (group,) = client.get("/compare/options").json()
    assert group["track"] == "Test ring" and group["track_id"] == track["id"] and group["car_id"] is None
    assert [(d["name"], d["sessions"], d["laps"]) for d in group["drivers"]] == [("Anna", 2, 8), ("Ben", 2, 8)]
    assert len(group["sessions"]) == 4 and group["laps"] == 16  # the session without a log is left out
    assert {s["driver"] for s in group["sessions"]} == {"Anna", "Ben"}

    body = {"a": {"label": "Anna", "session_ids": ids["Anna"]}, "b": {"label": "Ben", "session_ids": ids["Ben"]}}
    job = client.post("/compare/drivers/jobs", json=body)
    assert job.status_code == 202, job.text
    job = job.json()
    assert job["total"] == 4 and job["status"] in ("queued", "running", "done")
    for _ in range(300):
        job = client.get(f"/compare/drivers/jobs/{job['id']}").json()
        if job["status"] in ("done", "failed"):
            break
        time.sleep(0.1)
    assert job["status"] == "done", job["error"]
    res = job["result"]
    assert res["track"] == "Test ring" and res["numbering"] == "official"
    assert [s["code"] for s in res["sections"]] == ["T1", "T2"]
    assert res["summary"]["a"]["label"] == "Anna" and res["summary"]["b"]["laps"] == 8
    assert all(s["faster"] == "b" for s in res["sections"])
    assert client.get("/compare/drivers/jobs/nope").status_code == 404

    same = client.post("/compare/drivers", json={**body, "b": {"label": "Anna", "session_ids": ids["Ben"]}})
    assert same.status_code == 422
    both = client.post("/compare/drivers/jobs", json={**body, "b": {"label": "Ben", "session_ids": ids["Anna"]}})
    assert both.status_code == 422 and "both sides" in both.json()["detail"]
    empty = client.post("/compare/drivers/jobs", json={**body, "b": {"label": "Ben"}})
    assert empty.status_code == 422


def test_compare_refuses_sessions_from_two_tracks(client):
    _, ids = _two_drivers(client)
    other = client.post("/tracks", json={"name": "Other ring"}).json()
    event = client.post("/events", json={"name": "Elsewhere", "track_id": other["id"]}).json()
    s = client.post("/sessions", json={"event_id": event["id"]}).json()
    _upload(client, s["id"], FAST)
    r = client.post("/compare/drivers", json={"a": {"label": "Anna", "session_ids": ids["Anna"]},
                                              "b": {"label": "Ben", "session_ids": [s["id"]]}})
    assert r.status_code == 422 and "different tracks" in r.json()["detail"]
    groups = client.get("/compare/options").json()
    assert sorted(g["track"] for g in groups) == ["Other ring", "Test ring"]
