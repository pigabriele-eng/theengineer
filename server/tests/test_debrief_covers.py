"""One debrief at the end of a session run in several stints covers all of them, checked apart where the setup
changed (debrief/covers.py, routers/insights.py debrief_check). Gabriele, 2026-10-09: FP1 Hockenheim, three stints,
changes made between stint 2 and 3, one debrief at the end."""
from tests.synthetic import simulate, write_ld


def _stint(client, event_id: int, name: str, time: str | None, setup: dict | None = None, log: bytes | None = None):
    from app import models
    from app.db import SessionLocal
    from app.setup.models import SessionSetup

    s = client.post("/sessions", json={"name": name, "event_id": event_id}).json()
    if log is not None:
        r = client.post(f"/sessions/{s['id']}/files", files={"file": (f"{name}.ld", log)})
        assert r.status_code == 201, r.text
    with SessionLocal() as db:
        if time is not None:
            db.add(models.LoggerFile(session_id=s["id"], logger="motec", filename=f"{name}.ld", path=f"{name}.ld",
                                     meta={"date": "03/05/2026", "time": time, "duration_s": 900}))
        if setup is not None:
            db.add(SessionSetup(session_id=s["id"], template="bmw_m4_gt4", values=setup))
        db.commit()
    return s["id"]


def test_one_debrief_covers_the_session_split_where_the_setup_changed(client):
    event = client.post("/events", json={"name": "Hockenheim"}).json()["id"]
    soft = {"arb_front": 3, "camber_fl": -3.2}
    one = _stint(client, event, "FP1 stint 1", "10:00:00", soft)
    two = _stint(client, event, "FP1 stint 2", "10:20:00", soft)
    three = _stint(client, event, "FP1 stint 3", "10:40:00", {**soft, "arb_front": 5})
    _stint(client, event, "FP2 stint 1", "15:00:00", soft)  # another session: not covered
    _stint(client, event, "FP1 stint 4", "11:30:00", soft)  # after the debrief's run: not covered
    d = client.post(f"/sessions/{three}/debriefs", json={"points": [{"section": "balance", "text": "Understeer"}]})
    runs = client.get(f"/debriefs/{d.json()['id']}/runs").json()
    assert [(r["session_id"], r["group"]) for r in runs["runs"]] == [(one, 0), (two, 0), (three, 1)]
    assert runs["set_by_user"] is False
    assert len(runs["choices"]) == 5


def test_the_user_sets_the_runs_and_the_setup_change(client):
    event = client.post("/events", json={"name": "Hockenheim"}).json()["id"]
    one = _stint(client, event, "FP1 stint 1", "10:00:00")
    two = _stint(client, event, "FP1 stint 2", "10:20:00")
    three = _stint(client, event, "FP1 stint 3", "10:40:00")
    d = client.post(f"/sessions/{three}/debriefs", json={"points": [{"section": "balance", "text": "Understeer"}]})
    did = d.json()["id"]
    # no setup sheets: nothing says the setup changed, all three are one setup
    assert {r["group"] for r in client.get(f"/debriefs/{did}/runs").json()["runs"]} == {0}
    got = client.put(f"/debriefs/{did}/runs", json=[{"session_id": two, "group": 0}, {"session_id": three, "group": 1}])
    assert got.status_code == 200, got.text
    assert [(r["session_id"], r["group"]) for r in got.json()["runs"]] == [(two, 0), (three, 1)]
    assert got.json()["set_by_user"] is True
    # the debrief's own run is always covered
    got = client.put(f"/debriefs/{did}/runs", json=[{"session_id": one, "group": 0}]).json()
    assert [r["session_id"] for r in got["runs"]] == [one, three]
    other = client.post("/events", json={"name": "Elsewhere"}).json()["id"]
    far = _stint(client, other, "FP1 stint 1", "10:00:00")
    assert client.put(f"/debriefs/{did}/runs", json=[{"session_id": far, "group": 0}]).status_code == 422
    # an empty list goes back to the worked-out runs; moving the debrief forgets them
    client.put(f"/debriefs/{did}/runs", json=[{"session_id": one, "group": 0}])
    client.post(f"/debriefs/{did}/run", json={"session_id": two})
    assert client.get(f"/debriefs/{did}/runs").json()["set_by_user"] is False
    assert client.put(f"/debriefs/{did}/runs", json=[]).json()["set_by_user"] is False
    assert client.delete(f"/debriefs/{did}").status_code == 200


def test_the_check_gives_a_verdict_for_each_setup(client):
    track = client.post("/tracks", json={"name": "Test ring", "corners": [
        {"code": "T1", "apex_m": 300}, {"code": "T2", "apex_m": 690}]}).json()
    event = client.post("/events", json={"name": "Test day", "track_id": track["id"]}).json()["id"]
    ids = [_stint(client, event, f"FP1 stint {i + 1}", None, {"arb_front": 3 if i < 2 else 5},
                  write_ld(simulate(paces=paces)[0]))
           for i, paces in enumerate(((1.0, 0.99, 0.995), (0.99, 0.985, 0.99), (0.96, 0.95, 0.955)))]
    d = client.post(f"/sessions/{ids[2]}/debriefs", json={"points": [
        {"section": "traction", "text": "Wheelspin out of T2"}]}).json()
    check = client.get(f"/debriefs/{d['id']}/check").json()
    assert [r["group"] for r in check["covers"]["runs"]] == [0, 0, 1]
    assert [g["label"] for g in check["groups"]] == ["Setup 1", "Setup 2"]
    assert [g["runs"] for g in check["groups"]] == [["FP1 stint 1", "FP1 stint 2"], ["FP1 stint 3"]]
    assert check["laps"] == check["groups"][1]["laps"]  # the main verdicts are the last setup's
    assert len(check["points"][0]["by_group"]) == 2
