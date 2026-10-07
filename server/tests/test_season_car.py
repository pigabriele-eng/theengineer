"""Our car in a season is remembered and put on its events by itself: on the event (from the season, unless it sets
one) and on its runs without a car, when an event joins, a season's car is set or changed, at an import and at startup.
It is found from the season's entry, its events' runs, or a round's entry list by our drivers; a car set by hand stays,
and a car is never told by its number alone across seasons."""
from datetime import date

from tests.test_season_match import M4, _entry, _logged, _pending, _runs, _scan

HOFOR = "Hofor Racing"


def _calendar(year: int, entries: list[tuple[str, list[str], str, str]]) -> None:
    """The series' published calendar of the year: Zandvoort (with this entry list) and Barcelona."""
    from app.db import SessionLocal
    from app.results import models as rm

    with SessionLocal() as db:
        zv = rm.ResultCalendarRound(series="gt4-europe", year=year, round_id="75", name="Zandvoort",
                                    venue="zandvoort", order=5, start=date(year, 9, 18), end=date(year, 9, 20))
        zv.entries = [rm.ResultEntry(car_number=n, drivers=d, team=t, car_model=m) for n, d, t, m in entries]
        db.add_all([zv, rm.ResultCalendarRound(series="gt4-europe", year=year, round_id="76", name="Barcelona",
                                               venue="barcelona", order=6, start=date(year, 10, 9),
                                               end=date(year, 10, 11))])
        db.commit()


def _rounds(year: int) -> list[dict]:
    return [{"name": "Zandvoort", "venue": "Zandvoort", "start": f"{year}-09-18", "end": f"{year}-09-20",
             "round_id": "75", "order": 5},
            {"name": "Barcelona", "venue": "Barcelona", "start": f"{year}-10-09", "end": f"{year}-10-11",
             "round_id": "76", "order": 6}]


def _season(client, year: int = 2026, series: str | None = "gt4-europe", number: str | None = None,
            entry: dict | None = None) -> dict:
    r = client.post("/seasons", json={"name": f"GT4 European Series {year}", "series": series, "year": year,
                                      "car_number": number, "entry": entry or {}, "rounds": _rounds(year)})
    assert r.status_code == 201, r.text
    return r.json()


def _info(client, ev: int) -> dict:
    return client.get(f"/events/{ev}/info").json()


def _import(runs: list[int]) -> None:
    from app import season_match
    from app.db import SessionLocal

    with SessionLocal() as db:
        season_match.after_import(db, runs)


def test_the_entry_list_gives_the_season_its_car_and_every_event_gets_it(client):
    _calendar(2026, [("12", ["Gabriele ROSSI", "Max VERDI"], HOFOR, "BMW M4 GT4 EVO"),
                     ("8", ["A ALPHA"], "Team One", "Audi R8 LMS GT4")])
    max_ = client.post("/garage/drivers", json={"name": "Max Verdi"}).json()
    ev, runs = _logged("zandvoort-2026-09", "Zandvoort", ["2026-09-19", "2026-09-20"], driver="VERDI Max")
    # our season, no car or number in it: the round's entry list has Max on one car
    season = _season(client, entry={"drivers": [max_["id"]]})
    season = client.get(f"/seasons/{season['id']}").json()
    car = next(c for c in client.get("/garage").json()["cars"] if c["number"] == "12")
    assert (car["team"], car["model"]) == (HOFOR, "BMW M4 GT4 EVO")  # made from the list
    assert season["car_number"] == "12" and season["entry"]["car_id"] == car["id"]  # remembered
    assert all(r["car_id"] == car["id"] for r in _runs(client, runs).values())
    info = _info(client, ev)
    assert info["resolved"]["car"]["number"] == "12" and info["from"]["car"] == "season"
    assert info["resolved"]["team"]["name"] == HOFOR and info["own"]["car_id"] is None  # nothing set on the event
    (linked,) = _pending(client, event_id=ev)["linked"]
    assert "Car #12 BMW M4 GT4 EVO, Hofor Racing, set on 2 runs." in linked["summary"]

    # the season's next event, uploaded later (another dash): it joins, and its runs get the car too
    ev2, runs2 = _logged("barcelona-2026-10", "Barcelona", ["2026-10-10"], serial=31337)
    _import(runs2)
    assert _info(client, ev2)["season"]["id"] == season["id"]
    assert all(r["car_id"] == car["id"] for r in _runs(client, runs2).values())


def test_a_car_set_by_hand_on_a_run_or_the_event_stays(client):
    entry = _entry(client)
    other = client.post("/garage/cars", json={"number": "7", "model": M4}).json()["car"]
    third = client.post("/garage/cars", json={"number": "3", "model": M4}).json()["car"]
    _, runs = _logged("zandvoort-2026-09", "Zandvoort", ["2026-09-19"], serial=None, runs=3)
    client.patch(f"/garage/runs/{runs[0]}", json={"car_id": other["id"]})
    _season(client, series=None, number="12", entry=entry)
    got = _runs(client, runs)
    assert [got[r]["car_id"] for r in runs] == [other["id"], entry["car_id"], entry["car_id"]]

    # an event whose car is set by hand: its runs get that car, not the season's
    ev2, runs2 = _logged("zandvoort-extra", "Zandvoort", ["2026-09-20"], serial=None)
    client.put(f"/events/{ev2}/info", json={"car_id": third["id"]})
    _import(runs2)
    info = _info(client, ev2)
    assert info["season"] is not None and info["resolved"]["car"]["id"] == third["id"]
    assert info["from"]["car"] == "event"
    assert all(r["car_id"] == third["id"] for r in _runs(client, runs2).values())


def test_setting_or_changing_the_season_s_car_fills_the_events_without_one(client):
    ev, runs = _logged("zandvoort-2026-09", "Zandvoort", ["2026-09-19"], serial=None)
    season = _season(client, series=None)
    assert _info(client, ev)["season"]["id"] == season["id"]
    assert all(r["car_id"] is None for r in _runs(client, runs).values())  # the season knows no car yet
    car = client.post("/garage/cars", json={"number": "12", "model": M4, "team_name": HOFOR}).json()["car"]
    r = client.put(f"/seasons/{season['id']}", json={"entry": {"car_id": car["id"]}})
    assert r.status_code == 200, r.text
    assert all(r["car_id"] == car["id"] for r in _runs(client, runs).values())
    assert _info(client, ev)["resolved"]["car"]["id"] == car["id"]

    # changed: the event shows the new car; runs that have one keep it, a run without one gets the new one
    other = client.post("/garage/cars", json={"number": "9", "model": M4}).json()["car"]
    client.patch(f"/garage/runs/{runs[1]}", json={"car_id": None})
    r = client.put(f"/seasons/{season['id']}", json={"entry": {"car_id": other["id"]}})
    assert r.status_code == 200, r.text
    got = _runs(client, runs)
    assert [got[r]["car_id"] for r in runs] == [car["id"], other["id"]]
    assert _info(client, ev)["resolved"]["car"]["id"] == other["id"]


def test_a_car_the_season_got_meanwhile_is_put_on_its_events_at_startup(client):
    from app import seasons
    from app.db import SessionLocal

    _, runs = _logged("zandvoort-2026-09", "Zandvoort", ["2026-09-19"], serial=None)
    season = _season(client, series=None)
    car = client.post("/garage/cars", json={"number": "12", "model": M4}).json()["car"]
    with SessionLocal() as db:  # not through the app (an older server linked the event)
        db.get(seasons.Season, season["id"]).entry = {"car_id": car["id"], "drivers": []}
        db.commit()
    assert all(r["car_id"] is None for r in _runs(client, runs).values())
    _scan()  # what the server does once when it starts
    assert all(r["car_id"] == car["id"] for r in _runs(client, runs).values())


def test_the_runs_of_an_event_give_the_season_its_car(client):
    car = client.post("/garage/cars", json={"number": "12", "model": M4}).json()["car"]
    _, runs = _logged("zandvoort-2026-09", "Zandvoort", ["2026-09-19"], serial=None)
    for r in runs:
        client.patch(f"/garage/runs/{r}", json={"car_id": car["id"]})
    season = _season(client, series=None)
    assert client.get(f"/seasons/{season['id']}").json()["entry"]["car_id"] == car["id"]
    _, runs2 = _logged("barcelona-2026-10", "Barcelona", ["2026-10-10"], serial=None)
    _import(runs2)
    assert all(r["car_id"] == car["id"] for r in _runs(client, runs2).values())


def test_another_year_s_season_doesn_t_leak_its_car_or_number(client):
    entry = _entry(client, drivers=("Gabriele Rossi",))  # car #12 of Hofor Racing
    ev25, runs25 = _logged("zandvoort-2025-09", "Zandvoort", ["2025-09-19"], serial=None)
    _season(client, year=2025, number="12", entry=entry)
    assert all(r["car_id"] == entry["car_id"] for r in _runs(client, runs25).values())

    # 2026, by hand, with only a number: last year's #12 isn't taken for it by its number
    ev, runs = _logged("zandvoort-2026-09", "Zandvoort", ["2026-09-19"], serial=None)
    season = _season(client, series=None, number="12")
    assert client.get(f"/seasons/{season['id']}").json()["entry"]["car_id"] is None
    assert all(r["car_id"] is None for r in _runs(client, runs).values())
    assert _info(client, ev)["resolved"]["car"] is None
    assert _info(client, ev25)["resolved"]["car"]["number"] == "12"


def test_our_car_next_year_is_found_by_its_drivers_team_and_model_with_that_year_s_number(client):
    entry = _entry(client, drivers=("Gabriele Rossi",))  # car #12 of Hofor Racing, an M4
    ev25, _ = _logged("zandvoort-2025-09", "Zandvoort", ["2025-09-19"], serial=None)
    _season(client, year=2025, number="12", entry=entry)

    # 2026: the entry list has Gabriele on #21, the same team and model; another team's #12 isn't ours
    _calendar(2026, [("21", ["Gabriele ROSSI", "Nico BIANCHI"], HOFOR, "BMW M4 GT4 EVO"),
                     ("12", ["A ALPHA"], "Team One", "BMW M4 GT4 EVO")])
    ev, runs = _logged("zandvoort-2026-09", "Zandvoort", ["2026-09-19"], serial=None)
    season = _season(client)
    season = client.get(f"/seasons/{season['id']}").json()
    assert (season["car_number"], season["entry"]["car_id"]) == ("21", entry["car_id"])
    assert all(r["car_id"] == entry["car_id"] for r in _runs(client, runs).values())
    assert _info(client, ev)["resolved"]["car"]["number"] == "21"
    assert _info(client, ev25)["resolved"]["car"]["number"] == "12"
    (linked,) = _pending(client, event_id=ev)["linked"]
    assert "Car #21 " in linked["summary"]


def test_a_car_is_told_by_drivers_team_and_model_never_by_its_number_alone(client):
    from app import season_car
    from app.db import SessionLocal

    entry = _entry(client, drivers=("Gabriele Rossi",))
    _logged("zandvoort-2025-09", "Zandvoort", ["2025-09-19"], serial=None)
    _season(client, year=2025, number="12", entry=entry)  # Gabriele drove it there
    audi = client.post("/garage/cars", json={"number": "30", "model": "Audi R8 LMS GT4"}).json()["car"]
    with SessionLocal() as db:
        like = season_car.car_like
        assert like(db, "12", [], None, None, 2026) is None  # last year's car: not by its number
        assert like(db, "12", [], None, None, 2025) == entry["car_id"]  # its own year's
        assert like(db, "12", [], HOFOR, M4, 2026) == entry["car_id"]  # number and team
        assert like(db, "21", ["ROSSI Gabriele"], HOFOR, "BMW M4 GT4 EVO", 2026) == entry["car_id"]
        assert like(db, "21", ["Gabriele Rossi"], "FK Performance", None, 2026) is None  # another team's
        assert like(db, "21", ["Gabriele Rossi"], None, None, 2026) is None  # a driver alone isn't enough
        assert like(db, "30", [], None, "Audi R8 LMS GT4", 2026) == audi["id"]  # in no season
        assert like(db, "30", [], None, M4, 2026) is None  # another model
