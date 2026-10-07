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
    assert run_names.label("R2") == "Race 2" and run_names.label("T3") == "PT3" and run_names.label("FP1") == "FP1"


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
    assert {n["session_id"]: n["name"] for n in body["named"]} == {q: "Q1", r1: "Race 1 stint 1"}
    names = {s["id"]: (s["name"], s["kind"]) for d in client.get(f"/events/{ev['id']}").json()["days"]
             for s in d["sessions"]}
    assert names[q] == ("Q1", "qualifying") and names[r1] == ("Race 1 stint 1", "race") and names[r2][0] == "My stint"
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
    assert [run_names.run_name("T2", 1, 1), run_names.run_name("FP1", 2, 4), run_names.run_name("Q1", 1, 1),
            run_names.run_name("R2", 1, 2)] == ["PT2 stint 1", "FP1 stint 2", "Q1", "Race 2 stint 1"]


def test_logs_saved_after_the_session_go_to_the_last_one_of_their_kind():
    table = run_names.timetable(_round(("T1", "2026-07-16T09:00:00"), ("FP1", "2026-07-17T09:37:00"),
                                       ("FP2", "2026-07-17T16:25:00"), ("Q1", "2026-07-18T11:18:00"),
                                       ("Q2", "2026-07-18T11:42:00"), ("R1", "2026-07-18T18:05:00"),
                                       ("R2", "2026-07-19T11:50:00")))
    at = datetime.fromisoformat
    assert run_names._by_time(at("2026-07-17T11:21:05"), "practice", table) == ["FP1"]  # not FP2, later that day
    assert run_names._by_time(at("2026-07-18T14:27:51"), "qualifying", table) == ["Q2", "Q1"]  # the best lap tells
    assert run_names._by_time(at("2026-07-19T13:31:07"), "race", table) == ["R2"]  # R1 was the day before
    # the offset that puts R1's log in R2 is not taken: its folder says R1
    t = at("2026-07-19T10:23:44")
    h, _ = run_names.place([(1, (t, t + timedelta(minutes=7)))], table, {1: ("R1",)})
    assert h == 0
