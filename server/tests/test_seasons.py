"""Vehicles and tyres lists, seasons made ahead with their rounds as planned events, and what an event was run with
(event info: set on the event, else from its season, else from its runs and car)."""
M4 = "BMW M4 GT4 Evo (G82)"
P_BOOK = {"cold_min_bar": {"front": 1.3, "rear": 1.2}, "hot_min_bar": {"front": 1.8, "rear": 1.7},
          "hot_target_bar": {"front": 1.95, "rear": 1.85}, "source": "P-Book 2026 p.12"}


def _folders(client) -> dict[int, dict]:
    return {f["id"]: f for f in client.get("/events/folders").json() if f["id"] is not None}


def _event(client, name: str, start: str | None = None, end: str | None = None) -> int:
    r = client.post("/events/folders", json={"name": name, "start": start, "end": end})
    assert r.status_code == 201, r.text
    return r.json()["id"]


def _garage_car(client, number: str = "21", team: str | None = "Hofor Racing") -> dict:
    body = {"number": number, "model": M4}
    if team:
        body["team_name"] = team
    return client.post("/garage/cars", json=body).json()["car"]


def test_vehicles_and_tyres_lists(client):
    r = client.post("/catalog/vehicles", json={"name": M4, "maker": "BMW", "car_class": "GT4",
                                               "specs": {"mass_kg": 1450, "wheelbase_m": 2.86}})
    assert r.status_code == 201, r.text
    v = r.json()
    assert (v["name"], v["maker"], v["car_class"], v["specs"]["mass_kg"]) == (M4, "BMW", "GT4", 1450)
    assert client.post("/catalog/vehicles", json={"name": M4.lower()}).status_code == 409  # one of each
    assert client.post("/catalog/vehicles", json={"maker": "BMW"}).status_code == 422  # a name is needed
    other = client.post("/catalog/vehicles", json={"name": "Porsche 718 Cayman GT4 RS CS"}).json()
    r = client.put(f"/catalog/vehicles/{other['id']}", json={"car_class": "GT4", "notes": "  "})
    assert r.json()["car_class"] == "GT4" and r.json()["notes"] is None and r.json()["name"].startswith("Porsche")
    assert client.put(f"/catalog/vehicles/{other['id']}", json={"name": M4}).status_code == 409

    car = _garage_car(client)
    r = client.put(f"/catalog/cars/{car['id']}/vehicle", json={"vehicle_model_id": v["id"]})
    assert r.json() == {"car_id": car["id"], "vehicle_model_id": v["id"]}
    assert {x["name"]: x["car_ids"] for x in client.get("/catalog/vehicles").json()} == {
        M4: [car["id"]], "Porsche 718 Cayman GT4 RS CS": []}
    assert client.put("/catalog/cars/999/vehicle", json={"vehicle_model_id": v["id"]}).status_code == 404
    assert client.put(f"/catalog/cars/{car['id']}/vehicle", json={"vehicle_model_id": 999}).status_code == 404

    r = client.post("/catalog/tyres", json={"brand": "Pirelli", "compound": "P Zero DHG", "size": "30/68-18",
                                            "specs": P_BOOK})
    assert r.status_code == 201, r.text
    t = r.json()
    assert t["label"] == "Pirelli P Zero DHG" and t["specs"] == P_BOOK
    assert client.post("/catalog/tyres", json={"brand": "Pirelli"}).status_code == 422  # and a compound
    assert client.post("/catalog/tyres", json={"brand": "x", "compound": "y",
                                               "specs": {"cold_min_bar": {"front": -1}}}).status_code == 422
    wet = client.post("/catalog/tyres", json={"brand": "Pirelli", "compound": "P Zero WH"}).json()
    assert wet["specs"] == {} and wet["size"] is None
    r = client.put(f"/catalog/tyres/{wet['id']}", json={"specs": {"hot_target_bar": {"front": 1.9}}})
    assert r.json()["specs"] == {"hot_target_bar": {"front": 1.9}}
    assert [x["label"] for x in client.get("/catalog/tyres").json()] == ["Pirelli P Zero DHG", "Pirelli P Zero WH"]
    assert client.delete(f"/catalog/tyres/{wet['id']}").status_code == 204
    assert client.put(f"/catalog/tyres/{wet['id']}", json={"size": "x"}).status_code == 404

    assert client.delete(f"/catalog/vehicles/{v['id']}").status_code == 204  # the car stays, without a vehicle
    assert [x["name"] for x in client.get("/catalog/vehicles").json()] == ["Porsche 718 Cayman GT4 RS CS"]
    assert client.put(f"/catalog/cars/{car['id']}/vehicle", json={"vehicle_model_id": None}).status_code == 200


def test_event_info_inherits_from_its_season_and_lists_what_is_missing(client):
    from app import seasons
    from app.db import SessionLocal

    ev = _event(client, "Hockenheim test", "2026-05-06", "2026-05-07")
    info = client.get(f"/events/{ev}/info").json()
    assert info["missing"] == ["tyre brand", "compound", "car", "team", "drivers"]
    assert info["season"] is None and info["resolved"]["drivers"] == []
    assert client.get("/events/999/info").status_code == 404

    vehicle = client.post("/catalog/vehicles", json={"name": M4}).json()
    tyre = client.post("/catalog/tyres", json={"brand": "Pirelli", "compound": "P Zero DHG", "specs": P_BOOK}).json()
    car = _garage_car(client)
    client.put(f"/catalog/cars/{car['id']}/vehicle", json={"vehicle_model_id": vehicle["id"]})
    team_id = car["team_id"]
    a = client.post("/garage/drivers", json={"name": "Gabriele"}).json()
    b = client.post("/garage/drivers", json={"name": "Max"}).json()

    r = client.post("/seasons", json={"name": "GT4 European Series 2026", "series": "gt4-europe", "year": 2026,
                                      "car_number": "21",
                                      "entry": {"car_id": car["id"], "team_id": team_id, "tyre_kind_id": tyre["id"],
                                                "drivers": [a["id"], b["id"], a["id"]]}})
    assert r.status_code == 201, r.text
    season = r.json()
    assert season["entry"]["drivers"] == [a["id"], b["id"]] and season["rounds"] == []

    r = client.put(f"/events/{ev}/info", json={"season_id": season["id"]})
    info = r.json()
    assert info["missing"] == []
    res = info["resolved"]
    assert res["tyre_kind"]["label"] == "Pirelli P Zero DHG" and res["tyre_kind"]["specs"] == P_BOOK
    assert (res["car"]["id"], res["car"]["number"], res["team"]["name"]) == (car["id"], "21", "Hofor Racing")
    assert res["vehicle_model"]["name"] == M4  # the car's vehicle
    assert [d["name"] for d in res["drivers"]] == ["Gabriele", "Max"]
    assert info["from"] == {"tyre_kind": "season", "car": "season", "team": "season", "vehicle_model": "car",
                            "drivers": "season"}
    assert info["season"]["name"] == "GT4 European Series 2026" and info["own"]["tyre_kind_id"] is None

    # set on the event, it wins over the season; null goes back to the season
    wet = client.post("/catalog/tyres", json={"brand": "Pirelli", "compound": "P Zero WH"}).json()
    info = client.put(f"/events/{ev}/info", json={"tyre_kind_id": wet["id"], "drivers": [b["id"]]}).json()
    assert info["resolved"]["tyre_kind"]["compound"] == "P Zero WH" and info["from"]["tyre_kind"] == "event"
    assert [d["name"] for d in info["resolved"]["drivers"]] == ["Max"]
    assert info["own"]["drivers"] == [b["id"]] and info["own"]["season_id"] == season["id"]
    info = client.put(f"/events/{ev}/info", json={"tyre_kind_id": None, "drivers": []}).json()
    assert info["resolved"]["tyre_kind"]["compound"] == "P Zero DHG" and len(info["resolved"]["drivers"]) == 2

    assert client.put(f"/events/{ev}/info", json={"tyre_kind_id": 999}).status_code == 404
    assert client.put(f"/events/{ev}/info", json={"drivers": [999]}).status_code == 404
    assert client.put(f"/events/{ev}/info", json={"drivers": [1, 2, 3, 4, 5]}).status_code == 422
    assert client.put(f"/events/{ev}/info", json={"season_id": 999}).status_code == 404

    # a removed tyre reads as not set: back on the checklist
    client.delete(f"/catalog/tyres/{tyre['id']}")
    info = client.get(f"/events/{ev}/info").json()
    assert info["missing"] == ["tyre brand", "compound"] and info["resolved"]["tyre_kind"] is None

    # the helpers other code imports
    s = client.post("/sessions", json={"name": "FP1", "event_id": ev}).json()
    lone = client.post("/sessions", json={"name": "Shakedown"}).json()
    with SessionLocal() as db:
        assert seasons.tyre_kind_for_session(db, s["id"]) is None
        assert seasons.vehicle_for_session(db, s["id"]) == vehicle["id"]  # the event's car's vehicle
        assert seasons.vehicle_for_session(db, lone["id"]) is None and seasons.vehicle_for_session(db, 999) is None
        assert seasons.info_for_event(db, ev)["missing"] == ["tyre brand", "compound"]
    client.put(f"/events/{ev}/info", json={"tyre_kind_id": wet["id"]})
    porsche = client.post("/catalog/vehicles", json={"name": "Porsche 718 Cayman GT4 RS CS"}).json()
    other_car = _garage_car(client, "7", team=None)
    client.put(f"/catalog/cars/{other_car['id']}/vehicle", json={"vehicle_model_id": porsche["id"]})
    client.patch(f"/garage/runs/{lone['id']}", json={"car_id": other_car["id"]})
    with SessionLocal() as db:
        assert seasons.tyre_kind_for_session(db, s["id"]) == wet["id"]
        assert seasons.tyre_kind_for_session(db, lone["id"]) is None  # in no event
        assert seasons.vehicle_for_session(db, lone["id"]) == porsche["id"]  # its own car's vehicle

    # deleting the season leaves the event's own info, without the season
    assert client.delete(f"/seasons/{season['id']}").json() == {"deleted": season["id"], "events_removed": 0}
    info = client.get(f"/events/{ev}/info").json()
    assert info["season"] is None and info["own"]["tyre_kind_id"] == wet["id"]
    assert set(info["missing"]) == {"car", "team", "drivers"}


def test_without_a_season_the_car_and_drivers_come_from_the_runs(client):
    ev = _event(client, "Zandvoort", "2026-09-18", "2026-09-20")
    car = _garage_car(client, "21", team="Hofor Racing")
    a = client.post("/garage/drivers", json={"name": "Gabriele"}).json()
    for name in ("Q", "R1", "R2"):
        s = client.post("/sessions", json={"name": name, "event_id": ev}).json()
        client.patch(f"/garage/runs/{s['id']}", json={"car_id": car["id"], "driver_id": a["id"]})
    info = client.get(f"/events/{ev}/info").json()
    assert info["resolved"]["car"]["id"] == car["id"] and info["from"]["car"] == "runs"
    assert info["resolved"]["team"]["name"] == "Hofor Racing" and info["from"]["team"] == "car"
    assert [d["name"] for d in info["resolved"]["drivers"]] == ["Gabriele"] and info["from"]["drivers"] == "runs"
    assert info["missing"] == ["tyre brand", "compound"]


def test_a_season_s_rounds_become_planned_events(client):
    # logs already uploaded for one round: that event is linked, not made twice
    there = _event(client, "Zandvoort weekend", "2026-09-18", "2026-09-20")
    client.post("/planned-events", json={"name": "Circuit Zandvoort", "venue": "Circuit Zandvoort"})  # other days
    with_data = client.post("/sessions", json={"name": "Q", "event_id": there}).json()
    assert with_data["event_id"] == there
    rounds = [
        {"name": "Paul Ricard", "venue": "Circuit Paul Ricard", "start": "2026-04-10", "end": "2026-04-12",
         "round_id": "r1"},
        {"name": "Zandvoort", "venue": "zandvoort", "start": "2026-09-18", "end": "2026-09-20", "round_id": "r5"},
        {"name": "Barcelona", "venue": "Circuit de Barcelona-Catalunya", "start": "2026-10-09", "round_id": "r6"},
    ]
    r = client.post("/seasons", json={"name": "GT4 European Series 2026", "series": "gt4-europe", "year": 2026,
                                      "rounds": rounds})
    assert r.status_code == 201, r.text
    season = r.json()
    got = {x["name"]: x for x in season["rounds"]}
    assert [x["order"] for x in season["rounds"]] == [1, 2, 3]
    assert got["Zandvoort"]["event_id"] == there and not got["Zandvoort"]["made_event"]
    assert got["Zandvoort"]["has_data"] and got["Zandvoort"]["event_name"] == "Zandvoort weekend"
    folders = _folders(client)
    made = got["Barcelona"]["event_id"]
    assert got["Barcelona"]["made_event"] and got["Barcelona"]["plan_id"] is not None
    assert (folders[made]["start"], folders[made]["end"]) == ("2026-10-09", "2026-10-09")
    assert folders[made]["name"] == "Barcelona · GT4 European Series 2026"
    assert folders[made]["series"] == "GT4 European Series 2026"
    venues = {p["event_id"]: p["venue"] for p in client.get("/calendar").json()["plans"]}
    assert venues[made] == "Circuit de Barcelona-Catalunya" and venues[there] == "zandvoort"
    # the rounds' events know their season
    assert client.get(f"/events/{made}/info").json()["season"]["round"]["name"] == "Barcelona"
    assert client.get(f"/events/{there}/info").json()["season"]["id"] == season["id"]

    # a changed calendar: Barcelona moves, Paul Ricard is dropped, a round is added by hand
    paul = got["Paul Ricard"]["event_id"]
    rounds[2] = {**rounds[2], "start": "2026-10-16", "end": "2026-10-18"}
    r = client.put(f"/seasons/{season['id']}", json={"rounds": [rounds[1], rounds[2],
                                                                 {"name": "Monza", "start": "2026-11-01"}]})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["events_removed"] == 1 and [x["name"] for x in body["rounds"]] == ["Zandvoort", "Barcelona", "Monza"]
    folders = _folders(client)
    assert paul not in folders and there in folders
    assert (folders[made]["start"], folders[made]["end"]) == ("2026-10-16", "2026-10-18")  # the same event, moved
    assert body["rounds"][1]["event_id"] == made

    assert client.post("/seasons", json={"name": "x"}).status_code == 422  # a year is needed
    assert client.post("/seasons", json={"name": "x", "year": 2026, "rounds": [
        {"name": "y", "start": "2026-05-02", "end": "2026-05-01"}]}).status_code == 422
    assert client.post("/seasons", json={"name": "x", "year": 2026, "entry": {"car_id": 999}}).status_code == 404
    assert [s["name"] for s in client.get("/seasons").json()] == ["GT4 European Series 2026"]
    assert client.get(f"/seasons/{season['id']}").json()["rounds"][2]["name"] == "Monza"

    # deleting the season: the events it made without data go, the one with data stays
    r = client.delete(f"/seasons/{season['id']}")
    assert r.json() == {"deleted": season["id"], "events_removed": 2}
    folders = _folders(client)
    assert there in folders and made not in folders
    assert client.get(f"/seasons/{season['id']}").status_code == 404


def _seed_calendar(year: int) -> None:
    """A stand-in for the series' site: two rounds of its calendar, the first with its entry list published."""
    from datetime import date

    from app.db import SessionLocal
    from app.results import models as rm

    with SessionLocal() as db:
        first = rm.ResultCalendarRound(series="gt4-europe", year=year, round_id="75", name="Zandvoort",
                                       venue="zandvoort", order=5, start=date(year, 9, 18), end=date(year, 9, 20))
        first.entries = [
            rm.ResultEntry(car_number="12", drivers=["Gabriele ROSSI", "Max VERDI"], team="Hofor Racing",
                           car_model="BMW M4 GT4 EVO", brand="BMW", car_class="Silver"),
            rm.ResultEntry(car_number="8", drivers=["A ALPHA"], team="Team One", car_model="Audi R8 LMS GT4",
                           brand="Audi", car_class="Silver"),
        ]
        db.add_all([first, rm.ResultCalendarRound(series="gt4-europe", year=year, round_id="76", name="Portimao",
                                                  venue="portimao", order=6, start=date(year, 10, 15),
                                                  end=date(year, 10, 18))])
        db.commit()


def test_a_season_fills_itself_from_the_series_calendar_and_entry_list(client):
    """The path the Seasons screen takes: the series list, the season, its calendar's rounds as planned events, and
    our entry's blanks from our car's row on an entry list (a round without a list yet is fine)."""
    _seed_calendar(2026)
    series = client.get("/results/series").json()
    assert series[0]["key"] == "gt4-europe" and 2026 in series[0]["years"]
    vehicle = client.post("/catalog/vehicles", json={"name": M4}).json()
    team = client.post("/garage/teams", json={"name": "hofor racing"}).json()  # there already, other capitals
    gabriele = client.post("/garage/drivers", json={"name": "Gabriele"}).json()
    car = _garage_car(client, "12", team=None)
    season = client.post("/seasons", json={"name": "GT4 European Series 2026", "series": "gt4-europe",
                                           "year": 2026, "car_number": "12"}).json()

    cal = client.get("/results/calendar", params={"series": "gt4-europe", "year": 2026}).json()
    assert cal["status"] == "loaded"
    rounds = [{"name": r["name"], "venue": r["name"], "start": r["start"], "end": r["end"],
               "round_id": r["round_id"], "order": r["order"]} for r in cal["rounds"]]
    season = client.put(f"/seasons/{season['id']}", json={"rounds": rounds}).json()
    assert [(r["round_id"], r["order"], r["made_event"]) for r in season["rounds"]] == [("75", 5, True),
                                                                                        ("76", 6, True)]
    with_list = [r for r in cal["rounds"] if r["entries"]]
    assert [r["round_id"] for r in with_list] == ["75"]
    cars = client.get("/results/entries", params={"series": "gt4-europe", "year": 2026, "round_id": "75"}).json()
    ours = next(c for c in cars if c["car_number"] == season["car_number"])
    r = client.post(f"/seasons/{season['id']}/fill-entry", json=ours)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["filled"] == ["drivers", "team", "car", "vehicle"]
    names = {d["id"]: d["name"] for d in client.get("/garage").json()["drivers"]}
    assert [names[i] for i in body["entry"]["drivers"]] == ["Gabriele", "Max VERDI"]  # Gabriele was there already
    assert body["entry"]["drivers"][0] == gabriele["id"]
    assert (body["entry"]["team_id"], body["entry"]["car_id"], body["entry"]["vehicle_model_id"]) == (
        team["id"], car["id"], vehicle["id"])

    # what is set stays: a second fill changes nothing
    again = client.post(f"/seasons/{season['id']}/fill-entry",
                        json={"car_number": "12", "drivers": ["Someone Else"], "team": "Other"}).json()
    assert again["filled"] == [] and again["entry"] == body["entry"]

    # the planned round inherits it all
    info = client.get(f"/events/{season['rounds'][0]['event_id']}/info").json()
    assert info["missing"] == ["tyre brand", "compound"]
    assert info["resolved"]["car"]["number"] == "12" and info["season"]["round"]["name"] == "Zandvoort"


def test_after_an_upload_the_form_is_filled_from_the_previous_event_of_the_same_car(client):
    tyre = client.post("/catalog/tyres", json={"brand": "Pirelli", "compound": "P Zero DHG"}).json()
    car = _garage_car(client, "21")
    other = _garage_car(client, "7", team=None)
    driver = client.post("/garage/drivers", json={"name": "Gabriele"}).json()
    before = _event(client, "Hockenheim test", "2026-05-06", "2026-05-07")
    client.put(f"/events/{before}/info", json={"tyre_kind_id": tyre["id"], "car_id": car["id"],
                                                "drivers": [driver["id"]]})
    elsewhere = _event(client, "Other car's test", "2026-06-01", "2026-06-01")
    client.put(f"/events/{elsewhere}/info", json={"car_id": other["id"]})

    now = _event(client, "Zandvoort", "2026-09-18", "2026-09-20")
    runs = [client.post("/sessions", json={"name": n, "event_id": now}).json()["id"] for n in ("Q", "R1")]
    client.patch(f"/garage/runs/{runs[0]}", json={"car_id": car["id"]})
    loose = client.post("/sessions", json={"name": "loose"}).json()["id"]
    r = client.get("/event-info/for-runs", params={"ids": ",".join(map(str, [*runs, loose, 999]))})
    assert r.status_code == 200, r.text
    got = r.json()
    assert [i["event_id"] for i in got] == [now]  # each event once; runs in no event left out
    info = got[0]
    assert info["event_name"] == "Zandvoort" and "tyre brand" in info["missing"]
    prev = info["previous"]
    assert (prev["event_id"], prev["tyre_kind_id"], prev["drivers"]) == (before, tyre["id"], [driver["id"]])
    assert client.get("/event-info/for-runs", params={"ids": "x"}).status_code == 422
    assert client.get(f"/events/{before}/info").json()["previous"] is None  # nothing before it
