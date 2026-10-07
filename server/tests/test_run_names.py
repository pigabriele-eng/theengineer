"""Our runs named after the official session each ran in, from the log's time of day laid on the timetable."""
from datetime import datetime, timedelta

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
    assert run_names.label("R2") == "Race 2" and run_names.label("T3") == "Test 3" and run_names.label("FP1") == "FP1"


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
    assert {n["session_id"]: n["name"] for n in body["named"]} == {q: "Q1", r1: "Race 1 run 1"}
    names = {s["id"]: (s["name"], s["kind"]) for d in client.get(f"/events/{ev['id']}").json()["days"]
             for s in d["sessions"]}
    assert names[q] == ("Q1", "qualifying") and names[r1] == ("Race 1 run 1", "race") and names[r2][0] == "My stint"
    # a tap answers a question: this run was in none of them
    assert client.post(f"/results/run-names/{r1}", json={"code": None}).status_code == 200
    assert client.post(f"/results/run-names/{r1}", json={"code": "X9"}).status_code == 422

