"""The garage (teams, cars, drivers) and a run's driver and car, set by hand and filled in from its logger."""
from tests.synthetic import simulate, write_ld

M4 = "BMW M4 GT4 Evo (G82)"
SERIAL = 12345  # the synthetic logs' dash


def _run_with_log(client, name: str, **fields) -> dict:
    s = client.post("/sessions", json={"name": name, **fields}).json()
    channels, _ = simulate()
    r = client.post(f"/sessions/{s['id']}/files", files={"file": (f"{name}.ld", write_ld(channels))})
    assert r.status_code == 201, r.text
    return r.json()


def _garage(client) -> dict:
    r = client.get("/garage")
    assert r.status_code == 200, r.text
    return r.json()


def test_teams_cars_and_drivers(client):
    team = client.post("/garage/teams", json={"name": "Hofor Racing"}).json()
    assert client.post("/garage/teams", json={"name": "hofor racing"}).json()["id"] == team["id"]  # no duplicate

    r = client.post("/garage/cars", json={"number": "21", "model": M4, "team_id": team["id"]})
    assert r.status_code == 201, r.text
    car = r.json()["car"]
    assert car["name"] == f"{M4} #21"  # the cars table's name: other screens show it, presets are picked by it
    assert (car["number"], car["model"], car["team"]) == ("21", M4, "Hofor Racing")
    assert client.get("/cars").json()[0]["team"] == "Hofor Racing"
    assert client.post("/garage/cars", json={"team_id": team["id"]}).status_code == 422  # no number, no model

    a = client.post("/garage/drivers", json={"name": "Gabriele", "team_id": team["id"], "car_ids": [car["id"]]}).json()
    b = client.post("/garage/drivers", json={"name": "Max", "team_name": "Other Team"}).json()
    assert a["car_ids"] == [car["id"]] and a["team"] == "Hofor Racing"
    assert b["team"] == "Other Team" and b["car_ids"] == []
    r = client.patch(f"/garage/cars/{car['id']}", json={"number": "7", "driver_ids": [a["id"], b["id"]]})
    assert r.json()["car"]["name"] == f"{M4} #7" and r.json()["car"]["driver_ids"] == [a["id"], b["id"]]

    g = _garage(client)
    assert [t["name"] for t in g["teams"]] == ["Hofor Racing", "Other Team"]
    assert g["teams"][0]["car_ids"] == [car["id"]] and g["teams"][0]["driver_ids"] == [a["id"]]
    assert {d["name"]: d["car_ids"] for d in g["drivers"]} == {"Gabriele": [car["id"]], "Max": [car["id"]]}
    assert M4 in g["models"]

    client.patch(f"/garage/teams/{team['id']}", json={"name": "Hofor"})
    assert client.get("/cars").json()[0]["team"] == "Hofor"
    assert client.delete(f"/garage/teams/{team['id']}").status_code == 204
    g = _garage(client)
    assert g["cars"][0]["team_id"] is None and g["drivers"][0]["team_id"] is None  # they stay, without a team

    r = client.patch(f"/garage/drivers/{b['id']}", json={"name": "Max V", "car_ids": []})
    assert r.json()["name"] == "Max V" and r.json()["car_ids"] == []
    assert client.delete(f"/garage/drivers/{b['id']}").status_code == 204
    assert [d["name"] for d in _garage(client)["drivers"]] == ["Gabriele"]
    assert client.patch("/garage/drivers/999", json={"name": "x"}).status_code == 404
    assert client.patch(f"/garage/cars/{car['id']}", json={"driver_ids": [999]}).status_code == 404


def test_one_car_tag_fills_the_logger_and_new_logs_get_the_car(client):
    first = _run_with_log(client, "FP1")
    second = _run_with_log(client, "FP2")
    assert first["car_id"] is None
    g = _garage(client)
    assert g["loggers"] == [{"serial": SERIAL, "runs": 2, "last": "2026-07-03", "venue": "Test Track", "car_id": None}]

    car = client.post("/garage/cars", json={"number": "21", "model": M4}).json()["car"]
    r = client.patch(f"/garage/runs/{first['id']}", json={"car_id": car["id"]})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["car_id"] == car["id"] and body["logger"] == SERIAL
    assert body["filled"] == [second["id"]]  # the rest of the weekend from the same dash
    assert client.get(f"/sessions/{second['id']}").json()["car_id"] == car["id"]
    assert _garage(client)["cars"][0]["loggers"] == [SERIAL]

    third = _run_with_log(client, "Race")  # a new upload from that logger is the car's
    assert third["car_id"] == car["id"]

    # a run tagged with another car by hand keeps it, and the logger stays with the first car
    other = client.post("/garage/cars", json={"number": "22", "model": M4}).json()["car"]
    r = client.patch(f"/garage/runs/{third['id']}", json={"car_id": other["id"]}).json()
    assert r["filled"] == [] and r["logger"] is None
    assert client.get(f"/sessions/{first['id']}").json()["car_id"] == car["id"]

    # moving the logger to the other car by hand: runs without a car follow, runs with one stay
    client.patch(f"/garage/runs/{second['id']}", json={"car_id": None})
    r = client.patch(f"/garage/cars/{other['id']}", json={"loggers": [SERIAL]}).json()
    assert r["filled"] == [second["id"]]
    assert {c["id"]: c["loggers"] for c in _garage(client)["cars"]} == {car["id"]: [], other["id"]: [SERIAL]}

    r = client.patch(f"/garage/cars/{other['id']}", json={"loggers": []}).json()  # unlinked: its runs keep the car
    assert r["car"]["loggers"] == [] and client.get(f"/sessions/{second['id']}").json()["car_id"] == other["id"]
    assert client.patch(f"/garage/cars/{other['id']}", json={"loggers": [0]}).status_code == 422

    # removing a car keeps its runs, without a car
    assert client.delete(f"/garage/cars/{car['id']}").status_code == 204
    assert client.get(f"/sessions/{first['id']}").json()["car_id"] is None


def test_quick_driver_on_a_run(client):
    team = client.post("/garage/teams", json={"name": "Hofor"}).json()
    car = client.post("/garage/cars", json={"number": "21", "model": M4, "team_id": team["id"],
                                            "loggers": [SERIAL]}).json()["car"]
    run = _run_with_log(client, "Q")
    assert run["car_id"] == car["id"]

    r = client.patch(f"/garage/runs/{run['id']}", json={"driver_name": "Gabriele"})  # "New driver"
    assert r.status_code == 200, r.text
    assert r.json()["driver"] == "Gabriele"
    gab = next(d for d in _garage(client)["drivers"] if d["name"] == "Gabriele")
    assert gab["car_ids"] == [car["id"]] and gab["team_id"] == team["id"]  # offered first on the car's runs now

    # a run without a car gets the driver only: its car isn't guessed from the driver
    loose = client.post("/sessions", json={"name": "Hand"}).json()
    r = client.patch(f"/garage/runs/{loose['id']}", json={"driver_id": gab["id"]}).json()
    assert (r["driver_id"], r["car_id"], r["filled"]) == (gab["id"], None, [])
    r = client.patch(f"/garage/runs/{loose['id']}", json={"car_id": car["id"], "driver_id": None}).json()
    assert (r["driver_id"], r["car_id"], r["logger"]) == (None, car["id"], None)  # a run with no log: no logger

    # an existing name is the same driver, whatever its capitals; null clears
    r = client.patch(f"/garage/runs/{run['id']}", json={"driver_name": "gabriele"}).json()
    assert r["driver_id"] == gab["id"]
    assert client.patch(f"/garage/runs/{run['id']}", json={"driver_id": None}).json()["driver_id"] is None
    assert client.patch("/garage/runs/999", json={"driver_id": None}).status_code == 404
    assert client.patch(f"/garage/runs/{run['id']}", json={"car_id": 999}).status_code == 404

    # the event page's run rows carry the driver and car
    ev = client.post("/events/folders", json={"name": "Weekend"}).json()
    client.post(f"/events/{ev['id']}/sessions", json={"session_ids": [run["id"]]})
    client.patch(f"/garage/runs/{run['id']}", json={"driver_id": gab["id"]})
    row = client.get(f"/events/{ev['id']}").json()["days"][0]["sessions"][0]
    assert (row["driver_id"], row["car_id"], row["driver"]) == (gab["id"], car["id"], "Gabriele")
    groups = client.get("/compare/options").json()
    assert [(g["car"], [d["name"] for d in g["drivers"]]) for g in groups] == [(f"{M4} #21", ["Gabriele"])]


def test_driver_named_in_the_log_header(client):
    known = client.post("/drivers", json={"name": "Test Driver"}).json()  # the synthetic header's driver
    run = _run_with_log(client, "FP1")
    assert run["driver_id"] == known["id"]
    other = client.post("/drivers", json={"name": "Someone"}).json()
    kept = _run_with_log(client, "FP2", driver_id=other["id"])
    assert kept["driver_id"] == other["id"]  # a driver set before the upload stays
