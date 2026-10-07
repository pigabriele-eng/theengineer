"""Adding a series' season: our car's number, when it isn't known, is looked for on the round's entry list (or in its
results) by our drivers' names. One car: its number is used and not asked for. Several: they are one-tap answers. None,
or no list: the number is asked for as before. A number set by hand stays."""
from datetime import date

from tests.test_season_match import M4, _logged, _pending, _scan, _seed_calendar


def _seed_cars(cars: list[tuple[str, list[str], str, str]], results: bool = False) -> None:
    """Zandvoort's entry list (or, with results, its official results and no entry list) with these cars:
    (number, drivers, team, model)."""
    from app.db import SessionLocal
    from app.results import models as rm

    _seed_calendar(entries=False)
    with SessionLocal() as db:
        if results:
            rnd = rm.ResultRound(series="gt4-europe", year=2026, round_id="75", name="Zandvoort", venue="zandvoort",
                                 order=5)
            for code in ("Q1", "R1"):
                s = rm.ResultSession(code=code, title=code, kind="race", source_url="x")
                s.rows = [rm.ResultRow(position=i + 1, status="classified", car_number=n, drivers=d, team=t,
                                       car_model=m) for i, (n, d, t, m) in enumerate(cars)]
                rnd.sessions.append(s)
            db.add(rnd)
        else:
            cal = db.query(rm.ResultCalendarRound).filter_by(round_id="75").one()
            cal.entries = [rm.ResultEntry(car_number=n, drivers=d, team=t, car_model=m) for n, d, t, m in cars]
        db.commit()


ENTRIES = [("12", ["Gabriele ROSSI", "Max VERDI"], "Hofor Racing", "BMW M4 GT4 EVO"),
           ("21", ["Gabriele ROSSI", "Nico BIANCHI"], "FK Performance", "BMW M4 GT4 EVO"),
           ("8", ["A ALPHA"], "Team One", "Audi R8 LMS GT4")]


def _driver(client, name: str) -> int:
    return client.post("/garage/drivers", json={"name": name}).json()["id"]


def _event_with_driver(client, name: str | None) -> tuple[int, list[int]]:
    ev, runs = _logged("zandvoort-2026-09", "Zandvoort", ["2026-09-19", "2026-09-20"])
    if name:
        r = client.patch(f"/garage/runs/{runs[0]}", json={"driver_id": _driver(client, name)})
        assert r.status_code == 200, r.text
    return ev, runs


def _question(client) -> dict:
    _scan()
    (q,) = _pending(client)["questions"]
    assert q["kind"] == "official" and q["prompt"] == "Add to GT4 European Series 2026, round 5 Zandvoort?"
    return q


def test_our_driver_on_one_car_gives_its_number_and_it_isn_t_asked_for(client):
    _seed_cars(ENTRIES)
    client.post("/catalog/vehicles", json={"name": M4})
    ev, _ = _event_with_driver(client, "Max Verdi")  # on the runs: only on #12
    q = _question(client)
    assert q["needs"] == [] and "numbers" not in q["options"][0]
    assert "Your car there: #12 Hofor Racing, BMW M4 GT4 EVO (Gabriele ROSSI, Max VERDI)." in q["why"]
    r = client.post(f"/season-match/{q['id']}", json={"answer": q["options"][0]["key"]})
    assert r.status_code == 200, r.text
    (season,) = client.get("/seasons").json()
    assert season["car_number"] == "12" and next(x for x in season["rounds"] if x["round_id"] == "75")["event_id"] == ev
    car = next(c for c in client.get("/garage").json()["cars"] if c["number"] == "12")
    assert car["team"] == "Hofor Racing" and season["entry"]["car_id"] == car["id"]


def test_our_driver_in_the_results_when_there_is_no_entry_list(client):
    _seed_cars(ENTRIES, results=True)
    _event_with_driver(client, "Nico Bianchi")
    q = _question(client)
    assert q["needs"] == [] and "#21 FK Performance" in q["why"]
    assert client.post(f"/season-match/{q['id']}", json={"answer": q["options"][0]["key"]}).status_code == 200
    (season,) = client.get("/seasons").json()
    assert season["car_number"] == "21"
    assert next(c for c in client.get("/garage").json()["cars"] if c["number"] == "21")["team"] == "FK Performance"


def test_our_driver_on_two_cars_gives_two_one_tap_numbers_the_likeliest_first(client):
    _seed_cars(ENTRIES)
    # the event's runs are in a car of ours (numbered 21) that Gabriele Rossi drove at another event
    car = client.post("/garage/cars", json={"number": "21", "model": M4}).json()["car"]
    _, before = _logged("Spa test", "Spa", ["2026-06-01"], runs=1)
    rossi = _driver(client, "Gabriele Rossi")
    client.patch(f"/garage/runs/{before[0]}", json={"car_id": car["id"], "driver_id": rossi})
    _, runs = _event_with_driver(client, None)
    for run in runs:
        client.patch(f"/garage/runs/{run}", json={"car_id": car["id"]})
    q = _question(client)
    assert q["needs"] == ["car_number"]
    numbers = q["options"][0]["numbers"]
    assert [n["car_number"] for n in numbers] == ["21", "12"]  # the number our car has comes first
    assert numbers[1] == {"car_number": "12", "label": "#12 Hofor Racing",
                          "why": "BMW M4 GT4 EVO · Gabriele ROSSI, Max VERDI"}
    assert "Gabriele Rossi is on 2 cars of its entry list: which is yours?" in q["why"]
    r = client.post(f"/season-match/{q['id']}", json={"answer": q["options"][0]["key"], "car_number": "12"})
    assert r.status_code == 200, r.text
    assert client.get("/seasons").json()[0]["car_number"] == "12"


def test_a_driver_only_in_the_garage_is_a_guess_so_its_car_is_asked(client):
    _seed_cars(ENTRIES)
    _driver(client, "Max Verdi")  # in the garage, but nothing says it drove this car or in this series
    _event_with_driver(client, None)
    q = _question(client)
    assert q["needs"] == ["car_number"] and [n["car_number"] for n in q["options"][0]["numbers"]] == ["12"]


def test_no_driver_of_ours_on_the_list_or_no_list_asks_for_the_number(client):
    _seed_cars(ENTRIES)
    _event_with_driver(client, "Zed Nobody")
    q = _question(client)
    assert q["needs"] == ["car_number"] and "numbers" not in q["options"][0]


def test_no_entry_list_asks_for_the_number(client):
    _seed_calendar(entries=False)
    _event_with_driver(client, "Max Verdi")
    q = _question(client)
    assert q["needs"] == ["car_number"] and "numbers" not in q["options"][0]


def test_a_number_set_by_hand_stays(client):
    from app.db import SessionLocal
    from app.results import models as rm

    _seed_cars(ENTRIES)
    ev, _ = _event_with_driver(client, "Max Verdi")  # the list says #12
    with SessionLocal() as db:  # set by hand on the event's Results panel (an older link kept another series)
        db.add(rm.EventResultLink(event_id=ev, series="adac-gt4-germany", year=2026, car_number="7", by_hand=1,
                                  updated_at=date(2026, 9, 21)))
        db.commit()
    q = _question(client)
    assert q["needs"] == [] and "Your car there" not in q["why"]
    assert client.post(f"/season-match/{q['id']}", json={"answer": q["options"][0]["key"]}).status_code == 200
    assert client.get("/seasons").json()[0]["car_number"] == "7"


def test_last_year_s_number_is_not_this_year_s(client):
    """Numbers change from season to season: our 2025 season's #99 isn't taken for 2026; the entry list says #12."""
    r = client.post("/seasons", json={"name": "GT4 European Series 2025", "series": "gt4-europe", "year": 2025,
                                      "car_number": "99", "rounds": []})
    assert r.status_code in (200, 201), r.text
    _seed_cars(ENTRIES)
    _event_with_driver(client, "Max Verdi")
    q = _question(client)
    assert q["needs"] == [] and "Your car there: #12" in q["why"]
