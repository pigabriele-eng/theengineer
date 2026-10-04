def test_session_upload_analysis_and_debrief(client):
    from tests.synthetic import simulate, write_ld

    track = client.post("/tracks", json={"name": "Norisring", "corners": [{"code": "T1", "name": "Grundig"}]}).json()
    car = client.post("/cars", json={"name": "BMW M2 Cup", "team": "Test"}).json()
    driver = client.post("/drivers", json={"name": "Gabriele"}).json()
    event = client.post("/events", json={"name": "M2 Cup Norisring", "series": "M2 Cup",
                                         "track_id": track["id"], "date": "2026-07-03"}).json()
    s = client.post("/sessions", json={"event_id": event["id"], "kind": "practice", "car_id": car["id"],
                                       "driver_id": driver["id"]}).json()

    channels, _ = simulate()
    r = client.post(f"/sessions/{s['id']}/files", files={"file": ("run.ld", write_ld(channels))})
    assert r.status_code == 201, r.text
    detail = r.json()
    assert len(detail["laps"]) == 4
    assert detail["files"][0]["meta"]["mapped_channels"]["speed"] == "vCar"
    assert detail["best_lap_s"] == min(l["time_s"] for l in detail["laps"])

    analysis = client.get(f"/sessions/{s['id']}/analysis").json()
    assert len(analysis["corners"]) == 2

    debrief = client.post(f"/sessions/{s['id']}/debriefs", json={
        "mode": "individual",
        "points": [{"section": "balance", "text": "Entry understeer in T1", "corner_id": track["corners"][0]["id"],
                    "phase": "entry", "speaker_driver_id": driver["id"]}],
    })
    assert debrief.status_code == 201
    assert client.get(f"/sessions/{s['id']}/debriefs").json()[0]["points"][0]["phase"] == "entry"


def test_rejects_unsupported_files(client):
    s = client.post("/sessions", json={}).json()
    r = client.post(f"/sessions/{s['id']}/files", files={"file": ("run.csv", b"a,b")})
    assert r.status_code == 415
