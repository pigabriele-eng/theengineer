"""Uploads join their season by themselves when it is sure which round they are, and a question is kept when it isn't
(two rounds, the same track on other days, a track not recognised, a series' published calendar). A "no" isn't asked
again, and nothing set by hand is changed."""
from datetime import date
from functools import cache

from sqlalchemy import select

from tests.synthetic import simulate, write_ld
from tests.test_imports import make_zip, upload

M4 = "BMW M4 GT4 Evo (G82)"
ZANDVOORT = {"name": "Zandvoort", "venue": "Circuit Zandvoort", "start": "2026-09-18", "end": "2026-09-20",
             "round_id": "75", "order": 5}


@cache
def _log(day: str, driver: bytes = b"GABRIELE", venue: str = "Zandvoort") -> bytes:
    """A synthetic log recorded at the venue (at most 10 characters) on the day, its header naming the driver (at
    most 11 characters); its dash is logger 12345."""
    data = write_ld(simulate(paces=(0.97, 0.98))[0])
    return (data.replace(b"Test Track", venue.encode().ljust(10, b"\x00"), 1)
            .replace(b"03/07/2026", day.encode(), 1)
            .replace(b"Test Driver", driver.ljust(11, b"\x00")[:11], 1))


def _logged(name: str, venue: str | None, days: list[str], driver: str | None = None, serial: int | None = 26580,
            runs: int = 2) -> tuple[int, list[int]]:
    """An event with runs whose logs' headers say the venue, day (one per run, the last repeated), driver and
    logger: what an import leaves, without reading logs."""
    from app import models
    from app.db import SessionLocal

    with SessionLocal() as db:
        track = None
        if venue:
            track = db.scalar(select(models.Track).where(models.Track.name == venue)) or models.Track(name=venue)
        ev = models.Event(name=name, track=track, date=date.fromisoformat(days[0]))
        db.add(ev)
        db.flush()
        ids = []
        for i in range(runs):
            day = date.fromisoformat(days[min(i, len(days) - 1)])
            s = models.RunSession(event_id=ev.id, name=f"Run {i + 1}")
            db.add(s)
            db.flush()
            meta = {"venue": venue or "", "date": day.strftime("%d/%m/%Y"), "driver": driver or "",
                    "device_serial": serial}
            db.add(models.LoggerFile(session_id=s.id, logger="motec", filename=f"{i}.ld", path=f"x/{ev.id}/{i}.ld",
                                     meta=meta))
            ids.append(s.id)
        db.commit()
        return ev.id, ids


def _scan() -> dict:
    from app import season_match
    from app.db import SessionLocal

    with SessionLocal() as db:
        return season_match.scan(db)


def _entry(client, number: str = "12", drivers: tuple[str, ...] = ("Gabriele Rossi",)) -> dict:
    car = client.post("/garage/cars", json={"number": number, "model": M4, "team_name": "Hofor Racing"}).json()["car"]
    tyre = client.post("/catalog/tyres", json={"brand": "Pirelli", "compound": "P Zero DHG"}).json()
    ids = [client.post("/garage/drivers", json={"name": n}).json()["id"] for n in drivers]
    return {"car_id": car["id"], "team_id": car["team_id"], "tyre_kind_id": tyre["id"], "drivers": ids}


def _season(client, name: str = "GT4 European Series 2026", rounds: list[dict] | None = None,
            entry: dict | None = None, series: str | None = "gt4-europe") -> dict:
    r = client.post("/seasons", json={"name": name, "series": series, "year": 2026, "car_number": "12",
                                      "entry": entry or {}, "rounds": rounds if rounds is not None else [ZANDVOORT]})
    assert r.status_code == 201, r.text
    return r.json()


def _pending(client, **params) -> dict:
    r = client.get("/season-match/pending", params=params)
    assert r.status_code == 200, r.text
    return r.json()


def _runs(client, ids: list[int]) -> dict[int, dict]:
    return {i: client.get(f"/sessions/{i}").json() for i in ids}


def test_a_test_day_before_the_round_joins_it_and_the_runs_get_the_car_and_driver(client):
    entry = _entry(client)
    season = _season(client, entry=entry)
    planned = season["rounds"][0]["event_id"]
    assert season["rounds"][0]["made_event"]

    # Wednesday's test, two days before the round: not taken into the round's planned event by the upload (that
    # waits for the day before), so the zip makes its own event, which then joins the round
    job = upload(client, ("Wednesday test.zip", make_zip({"W/a.ld": _log("16/09/2026"),
                                                          "W/b.ld": _log("16/09/2026")})))
    assert job["status"] == "done" and len(job["session_ids"]) == 2, job
    ev = client.get(f"/sessions/{job['session_ids'][0]}").json()["event_id"]
    assert ev != planned
    rnd = client.get(f"/seasons/{season['id']}").json()["rounds"][0]
    assert (rnd["event_id"], rnd["made_event"], rnd["has_data"]) == (ev, False, True)
    assert client.get(f"/events/{planned}").status_code == 404  # the empty planned event went into it
    folder = client.get(f"/events/{ev}").json()
    assert (folder["start"], folder["end"]) == ("2026-09-16", "2026-09-20")  # the test day and the round's

    info = client.get(f"/events/{ev}/info").json()
    assert info["season"]["id"] == season["id"] and info["season"]["round"]["name"] == "Zandvoort"
    assert info["own"]["season_id"] == season["id"] and info["missing"] == []
    assert info["resolved"]["tyre_kind"]["label"] == "Pirelli P Zero DHG"
    assert info["resolved"]["team"]["name"] == "Hofor Racing"
    for run in _runs(client, job["session_ids"]).values():
        assert (run["car_id"], run["driver_id"]) == (entry["car_id"], entry["drivers"][0])  # "GABRIELE" in the log
    loggers = {x["serial"]: x["car_id"] for x in client.get("/garage").json()["loggers"]}
    assert loggers[12345] == entry["car_id"]  # later logs from this dash get the car by themselves

    seen = _pending(client, runs=",".join(map(str, job["session_ids"])))
    assert seen["questions"] == []
    (linked,) = seen["linked"]
    assert linked["status"] == "linked" and linked["undo"]
    assert "round 5 Zandvoort" in linked["summary"] and "2 days before the round" in linked["summary"]
    assert "Logger 12345" in linked["summary"]

    # the race weekend's logs go into the same event now, and their runs get the car and driver too
    job2 = upload(client, ("Race.zip", make_zip({"R/a.ld": _log("19/09/2026")})))
    (race,) = job2["session_ids"]
    run = client.get(f"/sessions/{race}").json()
    assert (run["event_id"], run["car_id"], run["driver_id"]) == (ev, entry["car_id"], entry["drivers"][0])

    # not this season after all: undone, and not done again
    r = client.post(f"/season-match/{linked['id']}", json={"answer": "no"})
    assert r.status_code == 200, r.text
    assert client.get(f"/events/{ev}/info").json()["season"] is None
    rnd = client.get(f"/seasons/{season['id']}").json()["rounds"][0]
    assert rnd["event_id"] not in (None, ev) and rnd["made_event"]  # the round has its planned event again
    assert all(r["car_id"] is None and r["driver_id"] is None for r in _runs(client, job["session_ids"]).values())
    assert 12345 not in {x["serial"] for x in client.get("/garage").json()["loggers"] if x["car_id"]}
    assert _scan() == {"linked": 0, "asked": 0}
    assert client.get(f"/events/{ev}/info").json()["season"] is None
    assert client.post(f"/season-match/{linked['id']}", json={"answer": "no"}).status_code == 409


def test_an_event_there_before_its_season_joins_it_with_the_venue_spelled_otherwise(client):
    # the logs say "Le Castellet", the round "Circuit Paul Ricard": the same circuit
    ev, runs = _logged("Paul Ricard test", "Le Castellet", ["2026-04-10", "2026-04-11"])
    entry = _entry(client)
    season = _season(client, entry=entry, rounds=[
        {"name": "Paul Ricard", "venue": "Circuit Paul Ricard", "start": "2026-04-10", "end": "2026-04-12",
         "round_id": "71", "order": 1},
        ZANDVOORT])
    rounds = {r["name"]: r for r in season["rounds"]}
    assert rounds["Paul Ricard"]["event_id"] == ev and not rounds["Paul Ricard"]["made_event"]
    assert rounds["Zandvoort"]["made_event"]  # no data there: a planned event
    names = {e["id"]: e["name"] for e in client.get("/events/folders").json() if e["id"]}
    assert "Paul Ricard · GT4 European Series 2026" not in names.values()  # its planned event went into ours
    assert all(r["car_id"] == entry["car_id"] for r in _runs(client, runs).values())
    assert client.get(f"/events/{ev}/info").json()["missing"] == []


def test_a_round_linked_when_the_season_is_made_gets_its_runs_filled(client):
    # overlapping days at the same venue: the season links it itself, and the runs are filled
    ev, runs = _logged("zandvoort-2026-09", "Zandvoort", ["2026-09-19", "2026-09-20"])
    entry = _entry(client, drivers=("Gabriele", "Max"))
    _season(client, entry=entry)
    got = _runs(client, runs)
    assert all(r["car_id"] == entry["car_id"] and r["driver_id"] is None for r in got.values())
    # two drivers and the logs name neither: asked, with one tap for all, or the Tag drivers screen
    (q,) = _pending(client, event_id=ev)["questions"]
    assert q["kind"] == "drivers" and q["runs"] == 2
    assert [o["label"] for o in q["options"]] == ["All Gabriele", "All Max"]
    r = client.post(f"/season-match/{q['id']}", json={"answer": q["options"][1]["key"]})
    assert r.status_code == 200 and r.json()["done"].startswith("2 runs")
    assert all(r["driver_id"] == entry["drivers"][1] for r in _runs(client, runs).values())
    assert _pending(client)["count"] == 0


def test_tagging_the_runs_answers_who_drove(client):
    _, runs = _logged("zandvoort-2026-09", "Zandvoort", ["2026-09-19"])
    entry = _entry(client, drivers=("Gabriele", "Max"))
    _season(client, entry=entry)
    assert _pending(client)["count"] == 1
    for i, run in enumerate(runs):
        client.patch(f"/garage/runs/{run}", json={"driver_id": entry["drivers"][i]})
    assert _pending(client)["count"] == 0


def test_two_rounds_that_fit_are_asked_about_and_the_answer_links(client):
    ev, _ = _logged("zandvoort-2026-09", "Zandvoort", ["2026-09-19"])
    _season(client, "GT4 European Series 2026")
    b = _season(client, "GT4 Benelux Cup 2026", series=None)
    # there before both: each season links it when made (the newest is the one its info shows)
    assert {s["rounds"][0]["event_id"] for s in client.get("/seasons").json()} == {ev}

    # an event the seasons were already there for: two rounds fit, so it is asked
    ev2, _ = _logged("Zandvoort extra", "Zandvoort", ["2026-09-20"])
    _scan()
    (q,) = _pending(client, event_id=ev2)["questions"]
    assert q["kind"] == "round" and q["prompt"].startswith("Which round is Zandvoort extra")
    assert [o["label"].split(",")[0] for o in q["options"]] == ["GT4 European Series 2026", "GT4 Benelux Cup 2026"]
    pick = q["options"][1]
    r = client.post(f"/season-match/{q['id']}", json={"answer": pick["key"]})
    assert r.status_code == 200, r.text
    assert "GT4 Benelux Cup 2026, round 5 Zandvoort" in r.json()["done"]
    info = client.get(f"/events/{ev2}/info").json()
    assert info["season"]["id"] == b["id"]
    assert client.post(f"/season-match/{q['id']}", json={"answer": "no"}).status_code == 409


def test_only_the_track_or_only_the_days_are_asked_about_and_a_no_is_kept(client):
    season = _season(client)
    # the same track five days after the round
    after, _ = _logged("Zandvoort test", "Zandvoort", ["2026-09-25"])
    # the round's days, at a track the logs name in a way that isn't recognised
    odd, _ = _logged("Track day", "ZNDV", ["2026-09-19"])
    # the round's days at another circuit we know: not ours
    other, _ = _logged("Hockenheim test", "Hockenheimring", ["2026-09-19"])
    # the same track months away: not asked
    far, _ = _logged("Zandvoort in May", "Zandvoort", ["2026-05-02"])
    _scan()
    asked = {q["event_id"]: q for q in _pending(client)["questions"]}
    assert set(asked) == {after, odd}
    assert asked[after]["prompt"].startswith("Is Zandvoort test (25 Sep 2026, Zandvoort) part of GT4 European")
    assert "Same track, 25 Sep 2026; the round is 18-20 Sep 2026" in asked[after]["why"]
    assert "isn't recognised" in asked[odd]["why"]

    r = client.post(f"/season-match/{asked[after]['id']}", json={"answer": "no"})
    assert r.status_code == 200 and r.json()["done"] == "Not asked again."
    _scan()
    client.put(f"/seasons/{season['id']}", json={"car_number": "12"})  # saved: everything is matched again
    assert {q["event_id"] for q in _pending(client)["questions"]} == {odd}
    for ev in (after, other, far):
        assert client.get(f"/events/{ev}/info").json()["season"] is None
    assert client.post("/season-match/999", json={"answer": "no"}).status_code == 404
    q = _pending(client)["questions"][0]
    assert client.post(f"/season-match/{q['id']}", json={"answer": "round:999"}).status_code == 422


def _seed_calendar(entries: bool = True) -> None:
    """The series' published calendar (as the results module keeps it): Zandvoort with its entry list, and Barcelona."""
    from app.db import SessionLocal
    from app.results import models as rm

    with SessionLocal() as db:
        zv = rm.ResultCalendarRound(series="gt4-europe", year=2026, round_id="75", name="Zandvoort",
                                    venue="zandvoort", order=5, start=date(2026, 9, 18), end=date(2026, 9, 20))
        if entries:
            zv.entries = [rm.ResultEntry(car_number="12", drivers=["Gabriele ROSSI", "Max VERDI"],
                                         team="Hofor Racing", car_model="BMW M4 GT4 EVO", brand="BMW"),
                          rm.ResultEntry(car_number="8", drivers=["A ALPHA"], team="Team One",
                                         car_model="Audi R8 LMS GT4", brand="Audi")]
        db.add_all([zv, rm.ResultCalendarRound(series="gt4-europe", year=2026, round_id="76", name="Barcelona",
                                               venue="barcelona", order=6, start=date(2026, 10, 9),
                                               end=date(2026, 10, 11))])
        db.commit()


def test_with_no_season_of_ours_the_series_calendar_is_offered(client):
    _seed_calendar()
    client.post("/catalog/vehicles", json={"name": M4})
    ev, runs = _logged("zandvoort-2026-09", "Zandvoort", ["2026-09-19", "2026-09-20"], driver="ROSSI Gabriele",
                       runs=3)
    from app.db import SessionLocal
    from app.models import LoggerFile

    with SessionLocal() as db:  # the third run's log names nobody
        f = db.scalar(select(LoggerFile).where(LoggerFile.session_id == runs[2]))
        f.meta = {**f.meta, "driver": ""}
        db.commit()
    assert _scan() == {"linked": 0, "asked": 1}
    (q,) = _pending(client)["questions"]
    assert q["kind"] == "official" and q["prompt"] == "Add to GT4 European Series 2026, round 5 Zandvoort?"
    assert q["needs"] == ["car_number"]  # our number in the series isn't known yet
    r = client.post(f"/season-match/{q['id']}", json={"answer": q["options"][0]["key"]})
    assert r.status_code == 422 and "car's number" in r.json()["detail"]

    r = client.post(f"/season-match/{q['id']}", json={"answer": q["options"][0]["key"], "car_number": "#12"})
    assert r.status_code == 200, r.text
    (season,) = client.get("/seasons").json()
    assert (season["name"], season["series"], season["car_number"]) == ("GT4 European Series 2026", "gt4-europe",
                                                                       "12")
    rounds = {x["round_id"]: x for x in season["rounds"]}
    assert rounds["75"]["event_id"] == ev and rounds["76"]["made_event"]  # the whole calendar
    names = {d["id"]: d["name"] for d in client.get("/garage").json()["drivers"]}
    assert [names[i] for i in season["entry"]["drivers"]] == ["Gabriele ROSSI", "Max VERDI"]
    car = client.get("/garage").json()["cars"][0]
    assert (car["number"], car["team"]) == ("12", "Hofor Racing")  # made from the entry list
    assert season["entry"]["car_id"] == car["id"] and season["entry"]["vehicle_model_id"] is not None
    got = _runs(client, runs)
    assert all(r["car_id"] == car["id"] for r in got.values())
    first = season["entry"]["drivers"][0]
    assert [got[i]["driver_id"] for i in runs] == [first, first, None]  # the driver its header names
    (who,) = r.json()["questions"]  # the third run: asked
    assert who["kind"] == "drivers" and who["runs"] == 1
    info = client.get(f"/events/{ev}/info").json()
    assert info["missing"] == ["tyre brand", "compound"]  # the entry list says nothing of tyres


def test_a_known_car_number_isn_t_asked_for(client):
    _seed_calendar(entries=False)
    ev, _ = _logged("zandvoort-2026-09", "Zandvoort", ["2026-09-19"])
    from app.db import SessionLocal
    from app.results import models as rm

    with SessionLocal() as db:  # the Results panel found our car by its laps
        db.add(rm.EventResultLink(event_id=ev, series="gt4-europe", year=2026, round_id="75", car_number="12"))
        db.commit()
    _scan()
    (q,) = _pending(client)["questions"]
    assert q["needs"] == []
    r = client.post(f"/season-match/{q['id']}", json={"answer": q["options"][0]["key"]})
    assert r.status_code == 200, r.text
    assert client.get("/seasons").json()[0]["car_number"] == "12"


def test_a_hockenheim_test_with_no_season_and_no_round_there_is_left_alone(client):
    _seed_calendar()
    _logged("02_ADACGT4_T01_HOC", "Hockenheimring", ["2025-05-05", "2025-05-06"], serial=26724)
    assert _scan() == {"linked": 0, "asked": 0}
    assert _pending(client)["count"] == 0


def test_what_was_set_by_hand_stays(client):
    entry = _entry(client)
    other_car = client.post("/garage/cars", json={"number": "7", "model": M4}).json()["car"]
    max_ = client.post("/garage/drivers", json={"name": "Max"}).json()
    wet = client.post("/catalog/tyres", json={"brand": "Pirelli", "compound": "P Zero WH"}).json()
    ev, runs = _logged("zandvoort-2026-09", "Zandvoort", ["2026-09-19"], serial=None)
    client.patch(f"/garage/runs/{runs[0]}", json={"car_id": other_car["id"], "driver_id": max_["id"]})
    client.put(f"/events/{ev}/info", json={"tyre_kind_id": wet["id"]})
    # another event the season would take, but set by hand to another season
    elsewhere = _season(client, "My own season", series=None, rounds=[])
    ev2, _ = _logged("Zandvoort extra", "Zandvoort", ["2026-09-20"])
    client.put(f"/events/{ev2}/info", json={"season_id": elsewhere["id"]})

    season = _season(client, entry=entry)
    got = _runs(client, runs)
    assert (got[runs[0]]["car_id"], got[runs[0]]["driver_id"]) == (other_car["id"], max_["id"])
    assert (got[runs[1]]["car_id"], got[runs[1]]["driver_id"]) == (entry["car_id"], entry["drivers"][0])
    info = client.get(f"/events/{ev}/info").json()
    assert info["season"]["id"] == season["id"]
    assert info["resolved"]["tyre_kind"]["compound"] == "P Zero WH" and info["from"]["tyre_kind"] == "event"
    assert client.get(f"/events/{ev2}/info").json()["season"]["id"] == elsewhere["id"]
    assert _pending(client)["count"] == 0

    # a driver taken off a run by hand stays off when the season is saved again with the same entry
    client.patch(f"/garage/runs/{runs[1]}", json={"driver_id": None})
    client.put(f"/seasons/{season['id']}", json={"name": "GT4 European Series 2026"})
    assert client.get(f"/sessions/{runs[1]}").json()["driver_id"] is None
    # ...and a new driver in the entry is what runs without one get
    nico = client.post("/garage/drivers", json={"name": "Nico"}).json()
    client.put(f"/seasons/{season['id']}", json={"entry": {**entry, "drivers": [nico["id"]]}})
    assert client.get(f"/sessions/{runs[1]}").json()["driver_id"] == nico["id"]
    assert client.get(f"/sessions/{runs[0]}").json()["driver_id"] == max_["id"]


def test_the_round_s_event_already_has_data_so_the_next_zip_joins_the_season_beside_it(client):
    entry = _entry(client)
    quali, _ = _logged("03_Q", "Zandvoort", ["2026-09-19"])
    season = _season(client, entry=entry)
    assert season["rounds"][0]["event_id"] == quali
    race, runs = _logged("05_R2", "Zandvoort", ["2026-09-20"], serial=None)
    from app import season_match
    from app.db import SessionLocal

    with SessionLocal() as db:
        season_match.after_import(db, runs)
    info = client.get(f"/events/{race}/info").json()
    assert info["season"]["id"] == season["id"] and info["season"]["round"] is None
    assert all(r["car_id"] == entry["car_id"] for r in _runs(client, runs).values())
    (linked,) = _pending(client, event_id=race)["linked"]
    assert "The round's event is 03_Q" in linked["summary"] and linked["undo"]


def test_header_drivers_are_matched_whatever_the_order_capitals_and_accents():
    from app.season_match import days_text, same_person, same_track

    assert same_track("Le Castellet", "Circuit Paul Ricard") and same_track("Hockenheimring", "Hockenheim GP")
    assert same_track("CM.com Circuit Zandvoort", "zandvoort") and not same_track("Spanish GP", "Spa")
    assert not same_track("Hockenheimring", "Zandvoort") and not same_track("", "Zandvoort")

    assert same_person("ROSSI Gabriele", "Gabriele Rossi")
    assert same_person("gabriélé rossi", "Gabriele Rossi")
    assert same_person("G. Rossi", "Gabriele Rossi") and same_person("Gabriele", "Gabriele Rossi")
    assert not same_person("Max Verdi", "Gabriele Rossi") and not same_person("G", "Gabriele Rossi")
    assert not same_person("", "Gabriele") and not same_person("M. Rossi", "Gabriele Rossi")
    assert days_text(date(2026, 9, 18), date(2026, 9, 20)) == "18-20 Sep 2026"
    assert days_text(date(2026, 9, 30), date(2026, 10, 2)) == "30 Sep - 2 Oct 2026"
    assert days_text(date(2026, 9, 19), None) == "19 Sep 2026" and days_text(None, None) == "no dates"
