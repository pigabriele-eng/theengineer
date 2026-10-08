"""Our runs named after the official session each ran in, from the log's time of day laid on the timetable."""
from datetime import datetime, timedelta

from app import models
from app.results import models as rm
from app.results import run_names
from tests.test_events import _session
from tests.test_results import fake_site  # noqa: F401  (the series' site stand-in)


def _round(*sessions):
    rnd = rm.ResultRound(series="gt4-europe", year=2026, round_id="1", name="Test Track", venue="test-track")
    rnd.sessions = [rm.ResultSession(code=c, title=c, kind="race", source_url="u", starts_at=t) for c, t in sessions]
    return rnd


def test_the_timetable_and_a_logger_clock_an_hour_out():
    table = run_names.timetable(_round(("FP1", "2026-09-18T10:00:00"), ("FP2", "2026-09-18T14:00:00"),
                                       ("Q1", "2026-09-19T11:15:00"), ("Q2", "2026-09-19T11:40:00")))
    assert [(c, t1 - t0) for c, t0, t1 in table] == [
        ("FP1", timedelta(minutes=60)), ("FP2", timedelta(minutes=60)), ("Q1", timedelta(minutes=25)),
        ("Q2", timedelta(minutes=30))]
    t = datetime(2026, 9, 18, 11, 5)  # the logger runs an hour ahead
    runs = [(1, (t, t + timedelta(minutes=20))), (2, (t + timedelta(minutes=30), t + timedelta(minutes=50))),
            (3, (t + timedelta(hours=4), t + timedelta(hours=4, minutes=40)))]
    h, verdicts = run_names.place(runs, table)
    assert h == -1 and {k: v[0] for k, v in verdicts.items()} == {1: "FP1", 2: "FP1", 3: "FP2"}
    # half in Q1, half in Q2: asked, not guessed
    q = datetime(2026, 9, 19, 11, 25)
    assert run_names._verdict(run_names._shares((q, q + timedelta(minutes=30)), table, timedelta())) == \
        (None, ["Q2", "Q1"])
    assert run_names.label("R2") == "R2" and run_names.label("T3") == "PT3" and run_names.label("FP1") == "FP1"


def test_runs_are_named_and_a_name_typed_by_hand_stays(client, fake_site):  # noqa: F811
    fake_site.sync(years=[2026])  # Q1 at 11:15 and R1 at 17:25 on 19 September 2026
    client.post("/tracks", json={"name": "Test Track"})
    ev = client.post("/events/folders", json={"name": "Round 5"}).json()
    q = _session(client, ev["id"], "03_Q", (0.97, 0.98), "19/09/2026", "11:16:00")
    # the names the upload gave: the logger's own session name, a numbered folder
    r1 = _session(client, ev["id"], "Session 1", (0.99, 1.0), "19/09/2026", "17:27:00")
    r2 = _session(client, ev["id"], "04_R1", (0.99, 1.0), "19/09/2026", "17:50:00")
    client.patch(f"/sessions/{r2}", json={"name": "My stint"})
    body = client.get(f"/results/events/{ev['id']}/run-names").json()
    assert {n["session_id"]: n["name"] for n in body["named"]} == {q: "Q1", r1: "R1 stint 1"}
    names = {s["id"]: (s["name"], s["kind"]) for d in client.get(f"/events/{ev['id']}").json()["days"]
             for s in d["sessions"]}
    assert names[q] == ("Q1", "qualifying") and names[r1] == ("R1 stint 1", "race") and names[r2][0] == "My stint"
    # a tap answers a question: this run was in none of them
    assert client.post(f"/results/run-names/{r1}", json={"code": None}).status_code == 200
    assert client.post(f"/results/run-names/{r1}", json={"code": "X9"}).status_code == 422



def _run(name, session, folder=None):
    meta = {"event_session": session, **({"folder": folder} if folder else {})}
    return models.RunSession(name=name, files=[models.LoggerFile(filename="20260716-2658000.ld", meta=meta)])


def test_what_the_folders_and_the_logger_say():
    # Misano 2026: paid tests in numbered folders inside a test folder, or numbered in its name (Monza)
    assert run_names.hint(_run("02 (2)", "PTS", "01_Data/01_PTS/02"), None) == ("test", "T2")
    assert run_names.hint(_run("01", "PT_24002"), None) == ("test", "T1")  # uploaded before folders were kept
    assert run_names.hint(_run("01_PTS1", "PTS1"), None) == ("test", "T1")
    assert run_names.hint(_run("02_FP (3)", "FP", "01_Data/02_FP"), None) == ("practice", None)
    assert run_names.hint(_run("05_R1", "R1"), None) == ("race", "R1")
    # a name given here before says nothing: "FP2 run 1" was a wrong guess, the logger's "FP" stands
    mark = rm.RunNameMark(auto_name="FP2 run 1")
    assert run_names.hint(_run("FP2 run 1", "FP"), mark) == ("practice", None)
    assert [run_names.run_name("T2", 1), run_names.run_name("FP1", 2), run_names.run_name("Q1", 1),
            run_names.run_name("Q1", 2), run_names.run_name("R2", 1), run_names.run_name("R1", 1)] == \
        ["PT2 stint 1", "FP1 stint 2", "Q1", "Q1", "R2 stint 1", "R1 stint 1"]  # no stints in Q; a DNF's race too


def test_logs_saved_after_the_session_go_to_the_last_one_of_their_kind():
    table = run_names.timetable(_round(("T1", "2026-07-16T09:00:00"), ("FP1", "2026-07-17T09:37:00"),
                                       ("FP2", "2026-07-17T16:25:00"), ("Q1", "2026-07-18T11:18:00"),
                                       ("Q2", "2026-07-18T11:42:00"), ("R1", "2026-07-18T18:05:00"),
                                       ("R2", "2026-07-19T11:50:00")))
    at = datetime.fromisoformat
    assert run_names._by_time(at("2026-07-17T11:21:05"), "practice", table) == ["FP1"]  # not FP2, later that day
    assert run_names._by_time(at("2026-07-18T14:27:51"), "qualifying", table) == ["Q2", "Q1"]  # the best lap tells
    assert run_names._by_time(at("2026-07-19T13:31:07"), "race", table) == ["R2"]  # R1 was the day before
    assert run_names._by_time(at("2026-07-17T19:55:00"), "practice", table) == ["FP2"]  # FP1 ended hours before
    assert run_names._hint("04_PQ") == ("practice", "PQ")  # Spa 2026: no PQ in the timetable, so FP2 by time
    # the offset that puts R1's log in R2 is not taken: its folder says R1
    t = at("2026-07-19T10:23:44")
    h, _ = run_names.place([(1, (t, t + timedelta(minutes=7)))], table, {1: ("R1",)})
    assert h == 0


def test_quali_runs_too_close_to_call_are_told_by_who_started_race_1():
    # Monza 2026: our Q1 and Q2 best laps 0.007 s apart; Rackl started Race 1, Piana took over after the stop
    rackl, piana = 1, 2
    q_a, q_b = (models.RunSession(id=i, driver_id=d) for i, d in ((10, piana), (11, rackl)))
    r1_first, r1_second = models.RunSession(id=20, driver_id=rackl), models.RunSession(id=21, driver_id=piana)
    t = datetime(2026, 5, 30, 19, 26)
    order = {10: (t, 0), 11: (t, 0), 20: (t, 60), 21: (t, 1800)}
    got = run_names._by_driver([q_a, q_b, r1_first, r1_second], {20: "R1", 21: "R1"},
                               {10: ["Q2", "Q1"], 11: ["Q2", "Q1"]}, order)
    assert got == {10: "Q2", 11: "Q1"}
    # no driver known: still asked
    assert run_names._by_driver([models.RunSession(id=10)], {}, {10: ["Q1", "Q2"]}, {10: (t, 0)}) == {}


def test_two_runs_in_one_qualifying_are_its_two_drivers():
    # Gabriele, 2026-10-08: "there are no stints in Q, so a second run is the second driver"
    table = run_names.timetable(_round(("Q1", "2026-09-19T11:15:00"), ("Q2", "2026-09-19T11:40:00"),
                                       ("R1", "2026-09-19T17:25:00"), ("Q3", "2026-09-20T09:00:00")))
    t = datetime(2026, 9, 19, 12, 5)
    a, b = models.RunSession(id=1), models.RunSession(id=2)
    order = {1: (t, 0), 2: (t, 400), 3: (t.replace(hour=17), 0), 4: (t, 900)}
    # one log of both, or one download after both: the run that ran first is Q1, the next driver's run Q2
    assert run_names._quali_per_driver([a, b], {1: "Q1", 2: "Q1"}, order, table, set()) == {2: "Q2"}
    assert run_names._quali_per_driver([a, b], {1: "Q2", 2: "Q2"}, order, table, set()) == {1: "Q1"}
    # the drivers known: the one who started Race 1 qualified first
    piana, rackl = 1, 2
    a.driver_id, b.driver_id = piana, rackl
    r1 = models.RunSession(id=3, driver_id=rackl)
    codes = {1: "Q1", 2: "Q1", 3: "R1"}
    assert run_names._quali_per_driver([a, b, r1], codes, order, table, set()) == {1: "Q2"}  # Rackl stays in Q1
    b.driver_id = None  # the other run's driver not known yet: Piana didn't start Race 1, so not Q1
    assert run_names._quali_per_driver([a, b, r1], codes, order, table, set()) == {1: "Q2"}
    # one driver's two logs stay together
    b.driver_id = piana
    assert run_names._quali_per_driver([a, b, r1], codes, order, table, set()) == {}
    # a session tapped by hand stays; the other driver takes the free one
    b.driver_id = None
    assert run_names._quali_per_driver([a, b], {1: "Q1", 2: "Q1"}, order, table, {2}) == {1: "Q2"}
    # nowhere free that day (Q2 holds a run, Q3 is the next day): each keeps Q1, told apart by its driver
    c = models.RunSession(id=4)
    assert run_names._quali_per_driver([a, b, c], {1: "Q1", 2: "Q1", 4: "Q2"}, order, table, set()) == {}


def test_a_race_has_a_stint_per_driver():
    # Gabriele, 2026-10-08: "R1 has two stints"
    piana, rackl = 1, 2
    runs = [models.RunSession(id=i, driver_id=d) for i, d in ((1, piana), (2, piana), (3, rackl))]
    assert run_names._stints("R1", runs) == [1, 1, 2]  # one stint's log saved twice
    assert run_names._stints("FP1", runs) == [1, 2, 3]  # practice: every run out of the pits is a stint
    assert run_names._stints("R1", [models.RunSession(id=1), models.RunSession(id=2)]) == [1, 2]
