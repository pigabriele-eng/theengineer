"""The events list says each event's season (championship), so the home page can group events by year and
championship: a round's event is in its season, an event can be put in a season by hand, the rest are in none."""


def _event(client, name: str, start: str | None = None, end: str | None = None) -> int:
    r = client.post("/events/folders", json={"name": name, "start": start, "end": end})
    assert r.status_code == 201, r.text
    return r.json()["id"]


def _seasons(client) -> dict:
    return {f["key"]: f["season"] for f in client.get("/events/folders").json()}


def test_each_event_in_the_list_says_its_season(client):
    test = _event(client, "Hockenheim test", "2025-05-05", "2025-05-06")
    there = _event(client, "Zandvoort weekend", "2026-09-18", "2026-09-20")
    client.post("/sessions", json={"name": "Q", "event_id": there})
    client.post("/sessions", json={"name": "loose", "event_id": None})
    assert _seasons(client) == {"none": None, str(test): None, str(there): None}  # no seasons yet

    rounds = [{"name": "Paul Ricard", "venue": "Circuit Paul Ricard", "start": "2026-04-10", "end": "2026-04-12"},
              {"name": "Zandvoort", "venue": "zandvoort", "start": "2026-09-18", "end": "2026-09-20"}]
    gt4 = client.post("/seasons", json={"name": "GT4 European Series 2026", "series": "gt4-europe", "year": 2026,
                                        "rounds": rounds}).json()
    made = next(r["event_id"] for r in gt4["rounds"] if r["name"] == "Paul Ricard")
    got = _seasons(client)
    assert got[str(there)] == {"id": gt4["id"], "name": "GT4 European Series 2026", "year": 2026, "round": 2}
    assert got[str(made)] == {"id": gt4["id"], "name": "GT4 European Series 2026", "year": 2026, "round": 1}
    assert got[str(test)] is None and got["none"] is None

    # put in a season by hand (its event info): that season, without a round
    adac = client.post("/seasons", json={"name": "ADAC GT4 Germany 2025", "year": 2025}).json()
    assert client.put(f"/events/{test}/info", json={"season_id": adac["id"]}).status_code == 200
    assert _seasons(client)[str(test)] == {"id": adac["id"], "name": "ADAC GT4 Germany 2025", "year": 2025,
                                           "round": None}
    # the season named by hand wins over the round's season
    client.put(f"/events/{there}/info", json={"season_id": adac["id"]})
    assert _seasons(client)[str(there)]["id"] == adac["id"] and _seasons(client)[str(there)]["round"] is None

    # a season deleted: its events are in none (or back in the round's season)
    client.delete(f"/seasons/{adac['id']}")
    got = _seasons(client)
    assert got[str(test)] is None and got[str(there)]["id"] == gt4["id"] and got[str(there)]["round"] == 2
