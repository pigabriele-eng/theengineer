"""GET /events/{id}/debriefs: every debrief of an event's runs in one call, newest first, for the weekend page."""


def test_an_events_debriefs_come_in_one_call_newest_first(client):
    from app import models  # after the client fixture: the modules of this test's database
    from app.db import SessionLocal

    event = client.post("/events", json={"name": "Zandvoort weekend"}).json()
    other = client.post("/events", json={"name": "Another weekend"}).json()
    quali = client.post("/sessions", json={"event_id": event["id"], "name": "Q"}).json()
    race = client.post("/sessions", json={"event_id": event["id"], "name": "R1"}).json()
    elsewhere = client.post("/sessions", json={"event_id": other["id"], "name": "FP1"}).json()
    point = {"section": "balance", "text": "Entry understeer in T1"}
    first = client.post(f"/sessions/{quali['id']}/debriefs", json={"mode": "individual", "points": [point]}).json()
    second = client.post(f"/sessions/{race['id']}/debriefs",
                         json={"mode": "individual", "points": [point, point]}).json()
    client.post(f"/sessions/{elsewhere['id']}/debriefs", json={"mode": "individual", "points": [point]})
    with SessionLocal() as db:  # a recording saved, not transcribed yet
        db.add(models.Debrief(session_id=race["id"], audio_path="x.m4a", status=models.DebriefStatus.queued))
        db.commit()

    rows = client.get(f"/events/{event['id']}/debriefs").json()
    assert [r["session_id"] for r in rows] == [race["id"], race["id"], quali["id"]]
    assert rows[0]["state"] == "recorded" and rows[0]["has_audio"] and rows[0]["points"] == 0
    assert {r["id"]: (r["state"], r["points"]) for r in rows[1:]} == {second["id"]: ("ready", 2),
                                                                      first["id"]: ("ready", 1)}
    assert client.get("/events/9999/debriefs").status_code == 404


def test_a_debriefs_state():
    from app import models
    from app.routers.event_debriefs import state_of

    s = models.DebriefStatus
    assert state_of(s.ready, True, 0) == "ready"
    assert state_of(s.ready, False, 3) == "ready"
    assert state_of(s.ready, False, 0) == "recorded"
    assert state_of(s.queued, False, 0) == "recorded"
    assert state_of(s.processing, True, 0) == "recorded"
    assert state_of(s.failed, False, 0) == "failed"
