import numpy as np
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
    r = client.post(f"/sessions/{s['id']}/files", files={"file": ("run.xrk", b"a,b")})
    assert r.status_code == 415
    r = client.post(f"/sessions/{s['id']}/files", files={"file": ("run.csv", b"a,b")})
    assert r.status_code == 422  # a CSV, but not a logger export


def test_gps_lap_timing_learned_from_an_earlier_log(client):
    from tests.synthetic import simulate, write_ld

    channels, lap_times = simulate()
    first = client.post("/sessions", json={"name": "Day 1"}).json()
    r = client.post(f"/sessions/{first['id']}/files", files={"file": ("a.ld", write_ld(channels))}).json()
    assert r["files"][0]["meta"]["lap_source"] == "marker"
    assert client.get("/tracks").json()[0]["name"] == "Test Track"  # from the log header

    no_marker = {k: v for k, v in channels.items() if k not in ("S/F Marker", "Lap Time")}
    second = client.post("/sessions", json={"name": "Day 2"}).json()
    r = client.post(f"/sessions/{second['id']}/files", files={"file": ("b.ld", write_ld(no_marker))}).json()
    assert r["files"][0]["meta"]["lap_source"] == "gps"
    assert abs(r["best_lap_s"] - min(lap_times)) < 0.05


def test_ldx_upload_attaches_beacons_to_its_log(client):
    from tests.synthetic import simulate, write_ld

    channels, lap_times = simulate()
    s = client.post("/sessions", json={}).json()
    client.post(f"/sessions/{s['id']}/files", files={"file": ("run1.ld", write_ld(channels))})
    starts = [sum(lap_times[:i]) for i in range(1, 6)]
    marks = "".join(f'<Marker ClassName="BCN" Name="b" Time="{t * 1e6}"/>' for t in starts)
    ldx = f"<LDXFile><Layers><Layer><MarkerBlock><MarkerGroup>{marks}</MarkerGroup></MarkerBlock></Layer></Layers>"
    ldx += "</LDXFile>"
    r = client.post(f"/sessions/{s['id']}/files", files={"file": ("run1.ldx", ldx.encode())})
    assert r.status_code == 201, r.text
    detail = r.json()
    assert detail["files"][0]["meta"]["lap_source"] == "beacons"
    assert len(detail["laps"]) == 4


def test_earlier_counter_timed_logs_are_retimed_once_the_line_is_known(client):
    from tests.synthetic import simulate, write_ld

    channels, lap_times = simulate()
    no_marker = {k: v for k, v in channels.items() if k not in ("S/F Marker", "Lap Time")}
    no_marker["Lap Number"] = (1, "", np.floor(np.interp(np.arange(len(channels["GPS Latitude"][2]) // 20 + 1),
                                                        np.cumsum([0, *lap_times]), np.arange(len(lap_times) + 1))))
    a = client.post("/sessions", json={"name": "Early"}).json()
    r = client.post(f"/sessions/{a['id']}/files", files={"file": ("early.ld", write_ld(no_marker))}).json()
    assert r["files"][0]["meta"]["lap_source"] == "counter"

    b = client.post("/sessions", json={"name": "Later"}).json()
    client.post(f"/sessions/{b['id']}/files", files={"file": ("later.ld", write_ld(channels))})
    early = client.get(f"/sessions/{a['id']}").json()
    assert early["files"][0]["meta"]["lap_source"] == "gps"
    assert abs(early["best_lap_s"] - min(lap_times)) < 0.05
