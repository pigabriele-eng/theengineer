"""Coaching: the three things for the next run, and whether the run after fixed them."""
import time

from app import coaching
from tests.synthetic import simulate, write_ld

CORNERS = [("T1", 300.0, None), ("T2", 700.0, None)]


def _habit(key, cost, laps=3, of=3):
    code, kind = key.split(":")
    return {"key": key, "kind": kind, "code": code, "phase": "braking", "title": kind, "laps": laps, "of": of,
            "cost_per_lap_s": cost, "value": None, "unit": None}


class FakeRun:
    def __init__(self, habits, laps=()):
        self.habits, self.laps = habits, list(laps)

    def advice(self, key):
        return {"do": f"do {key}"}


def test_three_things_one_per_corner_most_costly_first():
    run = FakeRun([_habit("T1:brake_early", 0.3), _habit("T1:coasting", 0.2), _habit("T4:exit_lift", 0.15),
                   _habit("T2:late_throttle", 0.1), _habit("T3:min_speed", 0.05)])
    things = coaching.top_things(run)
    assert [(t["rank"], t["code"], t["kind"]) for t in things] == [
        (1, "T1", "brake_early"), (2, "T4", "exit_lift"), (3, "T2", "late_throttle")]
    assert things[0]["gain_s"] == 0.3 and things[0]["do"] == "do T1:brake_early"


def test_did_we_fix_it_compares_the_previous_runs_three_things():
    before = FakeRun([_habit("T1:brake_early", 0.30), _habit("T4:exit_lift", 0.20), _habit("T2:late_throttle", 0.10)])
    # T1 gone, T4 halved, T2 the same; a one-lap T1 slip still counts against it
    after_laps = [{"mistakes": [{"key": "T1:brake_early", "cost_s": 0.06}]}, {"mistakes": []}, {"mistakes": []}]
    after = FakeRun([_habit("T4:exit_lift", 0.10, laps=2), _habit("T2:late_throttle", 0.10)], after_laps)
    out = {t["code"]: t for t in coaching.fixed_things(before, after)}
    assert out["T1"]["verdict"] == "fixed" and out["T1"]["after"] == {"cost_s": 0.02, "laps": 1, "of": 3,
                                                                       "value": None}
    assert out["T1"]["gained_s"] == 0.28
    assert out["T4"]["verdict"] == "better" and out["T4"]["gained_s"] == 0.1
    assert out["T2"]["verdict"] == "not yet" and out["T2"]["gained_s"] == 0.0


def _wait(client, url, timeout=180):
    t0 = time.monotonic()
    while time.monotonic() - t0 < timeout:
        body = client.get(url).json()
        if body["status"] not in ("queued", "running"):
            return body
        time.sleep(0.2)
    raise AssertionError(f"{url} still working after {timeout} s")


def test_coaching_api(client):
    track = client.post("/tracks", json={"name": "Test ring", "corners": [
        {"code": code, "apex_m": at, "sector": sector} for code, at, sector in CORNERS]}).json()
    event = client.post("/events", json={"name": "Test day", "track_id": track["id"]}).json()
    ids = []
    for name, paces in (("Run 1", (0.95, 0.96, 0.95)), ("Run 2", (0.98, 0.99, 0.985))):
        s = client.post("/sessions", json={"event_id": event["id"], "name": name}).json()
        r = client.post(f"/sessions/{s['id']}/files", files={"file": ("run.ld", write_ld(simulate(paces=paces)[0]))})
        assert r.status_code == 201, r.text
        ids.append(s["id"])

    top = _wait(client, f"/coaching/sessions/{ids[0]}/top")
    assert top["status"] == "ready" and top["session"]["laps"] == 3
    assert 1 <= len(top["things"]) <= 3
    assert len({t["code"] for t in top["things"]}) == len(top["things"])  # one per corner
    for t in top["things"]:
        assert t["code"] in {"T1", "T2"} and t["gain_s"] > 0 and t["do"] and t["what"]
    assert top["gain_s"] == round(sum(t["gain_s"] for t in top["things"]), 3)

    fixed = _wait(client, f"/coaching/sessions/{ids[1]}/fixed")
    assert fixed["previous"]["id"] == ids[0]  # the run before, at the same track
    assert [t["key"] for t in fixed["things"]] == [t["key"] for t in top["things"]]
    for t in fixed["things"]:
        assert t["verdict"] in {"fixed", "better", "not yet"}
        assert t["gained_s"] == round(t["before"]["cost_s"] - t["after"]["cost_s"], 3)

    first = client.get(f"/coaching/sessions/{ids[0]}/fixed").json()
    assert first["previous"] is None and first["things"] == [] and first["note"]
    picked = client.get(f"/coaching/sessions/{ids[0]}/fixed", params={"previous": ids[1]}).json()
    assert picked["previous"]["id"] == ids[1]
    assert client.get("/coaching/sessions/9999/top").status_code == 404
    assert client.get(f"/coaching/sessions/{ids[0]}/fixed", params={"previous": 9999}).status_code == 404


def test_a_check_still_pending_after_it_finished_reads_ready(client, monkeypatch):
    """The worker marks the row done a moment before it leaves _pending: the answer is ready then, never 'done'."""
    from app.routers import technique

    track = client.post("/tracks", json={"name": "Test ring", "corners": [
        {"code": code, "apex_m": at, "sector": sector} for code, at, sector in CORNERS]}).json()
    event = client.post("/events", json={"name": "Test day", "track_id": track["id"]}).json()
    s = client.post("/sessions", json={"event_id": event["id"], "name": "Run 1"}).json()
    client.post(f"/sessions/{s['id']}/files", files={"file": ("run.ld", write_ld(simulate(paces=(0.95, 0.96))[0]))})
    assert _wait(client, f"/coaching/sessions/{s['id']}/top")["status"] == "ready"

    class Always(set):
        def __contains__(self, scope):
            return True

    monkeypatch.setattr(technique, "_pending", Always())
    assert client.get(f"/coaching/sessions/{s['id']}/top").json()["status"] == "ready"
