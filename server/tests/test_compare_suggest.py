"""Laps to compare first (app/compare_suggest.py): which pairs, like with like on tyres, and their corners."""
from app import compare_suggest as cs
from app.compare_suggest import Run, session_type, suggest
from tests.synthetic import simulate, write_ld


def _run(id_, name, session, kind, driver_id, laps, driver=None):
    return Run(id_, name, session, kind, "new" if kind == "qualifying" else "used", driver_id,
               driver or (None if driver_id is None else f"Driver {driver_id}"), laps)


def _pairs(out):
    return [(p["kind"], p["tyres"], [(x["session_id"], x["lap"]) for x in p["laps"]]) for p in out]


def test_session_type():
    assert session_type("test", "03_Q", "03_Q (2)", "Q") == "qualifying"
    assert session_type("test", "04_R1") == "race"
    assert session_type("test", "Race 1 stint 2") == "race"
    assert session_type("test", "PTS 1") == "practice"
    assert session_type("test", "FP2 stint 1") == "practice"
    assert session_type("test", "01_D1S1", "D1S1") == "test"
    assert session_type("test", "Quick run") == "test"  # a name that only starts with Q
    assert session_type("race", "Q1") == "race"  # the kind set on the run wins


def test_pairs_in_order_of_use_like_with_like():
    runs = [
        _run(1, "FP1 stint 1", "FP1", "practice", 1, [(1, 101.0), (2, 100.6), (3, 100.9)]),
        _run(2, "FP1 stint 2", "FP1", "practice", 2, [(1, 101.2), (2, 101.0)]),
        _run(3, "Q1", "Q1", "qualifying", 1, [(1, 99.0), (2, 99.4)]),
        _run(4, "Q1", "Q1", "qualifying", 2, [(1, 99.5)]),
        _run(5, "R1 stint 1", "R1", "race", 1, [(1, 100.8), (2, 100.4), (3, 100.9), (4, 101.1), (5, 101.0)]),
        _run(6, "R1 stint 2", "R1", "race", 2, [(1, 100.7), (2, 101.3), (3, 101.0), (4, 101.2)]),
    ]
    out, notes = suggest(runs)
    assert notes == []
    assert _pairs(out) == [
        ("teammates", "new", [(3, 1), (4, 1)]),  # the qualifying laps, the quicker driver first
        ("teammates", "used", [(5, 2), (6, 1)]),  # each driver's best used-tyre lap, wherever it is
        ("progress", "used", [(5, 2), (1, 2)]),  # driver 1: R1 against FP1, both used (Q1 was on new tyres)
        ("progress", "used", [(6, 1), (2, 2)]),  # driver 2: R1 against FP1
        ("consistency", "used", [(5, 2), (5, 3)]),  # driver 1's best used lap against the lap nearest the median
    ]
    for p in out:
        assert {x["tyres"] for x in p["laps"]} == {p["tyres"]}  # never a used-tyre lap against a new-tyre one
        times = [x["time"] for x in p["laps"]]
        assert p["laps"][p["slower"]]["time"] == max(times) and p["gap_s"] == round(max(times) - min(times), 3)
    assert out[4]["laps"][1]["role"] == "typical" and out[4]["median_s"] == 100.9 and out[4]["stint_laps"] == 5
    assert out[0]["laps"][0]["driver"] == "Driver 1" and out[0]["laps"][0]["kind"] == "qualifying"
    assert len(suggest(runs, limit=3)[0]) == 3


def test_one_driver_no_driver_and_nothing_yet():
    one = [_run(1, "D1S1", "D1S1", "test", 7, [(1, 108.0), (2, 107.6)]),
           _run(2, "D1S2", "D1S2", "test", 7, [(1, 107.4), (2, 107.9), (3, 107.7), (4, 108.1)])]
    out, notes = suggest(one)
    assert all(p["kind"] != "teammates" for p in out)  # one driver: no teammates' pair
    # the typical lap: of the two laps as near the median (107.8), the earlier
    assert _pairs(out) == [("progress", "used", [(2, 1), (1, 2)]), ("consistency", "used", [(2, 1), (2, 2)])]
    assert notes == []

    nobody = [Run(r.id, r.name, r.session, r.kind, r.tyres, None, None, r.laps) for r in one]
    out, notes = suggest(nobody)
    assert len(out) == 2 and "set who drove each run" in notes[0]

    # a stint too short for a typical lap, and a typical lap as quick as the best: no consistency pair
    short = [_run(1, "Q", "Q", "qualifying", 1, [(1, 99.0)]),
             _run(2, "R1", "R1", "race", 1, [(1, 100.0), (2, 100.02), (3, 100.03), (4, 100.01)])]
    out, notes = suggest(short)
    assert out == [] and notes[0].startswith("Nothing to compare like with like yet")

    out, notes = suggest([_run(1, "FP1", "FP1", "practice", 1, [])])
    assert out == [] and notes[0].startswith("No clean laps")


def test_corners_of_a_comparison():
    res = {"opportunities": [{"sections": []}, {"sections": [
        {"code": "T10", "loss_s": 0.41, "phase": "entry"}, {"code": "T11-T12", "loss_s": 0.286, "phase": "entry"},
        {"code": "T6-T7", "loss_s": 0.184, "phase": "exit"}, {"code": "T1", "loss_s": 0.17, "phase": "braking"}]}]}
    assert [c["code"] for c in cs.corners_of(res, 1)] == ["T10", "T11-T12", "T6-T7"]
    tiny = {"opportunities": [{"sections": [{"code": "T2", "loss_s": 0.012, "phase": "mid-corner"}]}]}
    assert cs.corners_of(tiny, 0) == [{"code": "T2", "loss_s": 0.012, "phase": "mid-corner"}]


def _upload(client, session, paces):
    r = client.post(f"/sessions/{session['id']}/files", files={"file": ("run.ld", write_ld(simulate(paces=paces)[0]))})
    assert r.status_code == 201, r.text


def test_suggestions_endpoint(client):
    track = client.post("/tracks", json={"name": "Test ring", "corners": [
        {"code": "T1", "apex_m": 300}, {"code": "T2", "apex_m": 700}]}).json()
    event = client.post("/events", json={"name": "Round 3", "track_id": track["id"]}).json()
    empty = client.post("/events", json={"name": "Next round", "track_id": track["id"]}).json()
    anna, bo = (client.post("/drivers", json={"name": n}).json() for n in ("Anna Berg", "Bo Lind"))
    runs = {}
    for name, kind, driver, paces in (("Q1", "qualifying", anna, (1.0, 0.99)), ("Q1", "qualifying", bo, (0.99,)),
                                      ("R1 stint 1", "race", anna, (0.97, 0.96, 0.965, 0.955)),
                                      ("R1 stint 2", "race", bo, (0.965, 0.955, 0.96, 0.95))):
        s = client.post("/sessions", json={"event_id": event["id"], "name": name, "kind": kind,
                                           "driver_id": driver["id"]}).json()
        _upload(client, s, paces)
        runs[(name, driver["id"])] = s["id"]

    assert client.get("/events/999/compare/suggestions").status_code == 404
    nothing = client.get(f"/events/{empty['id']}/compare/suggestions").json()
    assert nothing["status"] == "ready" and nothing["suggestions"] == [] and nothing["notes"]

    first = client.get(f"/events/{event['id']}/compare/suggestions").json()
    assert first["status"] in ("working", "ready")
    assert cs.wait_idle(120)
    res = client.get(f"/events/{event['id']}/compare/suggestions").json()
    assert res["status"] == "ready" and res["progress"] is None
    q_anna, q_bo = runs[("Q1", anna["id"])], runs[("Q1", bo["id"])]
    r_anna, r_bo = runs[("R1 stint 1", anna["id"])], runs[("R1 stint 2", bo["id"])]
    pairs = _pairs(res["suggestions"])
    assert pairs[:2] == [("teammates", "new", [(q_anna, 1), (q_bo, 1)]),
                         ("teammates", "used", [(r_anna, 1), (r_bo, 1)])]
    # no progress pair: each driver has one session on each tyre state; then each one's best race lap against the
    # stint's typical lap (paces 0.97, 0.96, 0.965, 0.955: the median is between laps 2 and 3)
    assert [(k, t, laps[0]) for k, t, laps in pairs[2:]] == [("consistency", "used", (r_anna, 1)),
                                                              ("consistency", "used", (r_bo, 1))]
    assert pairs[2][2][1] in ((r_anna, 2), (r_anna, 3)) and pairs[3][2][1] in ((r_bo, 2), (r_bo, 3))
    for p in res["suggestions"]:
        assert p["corners"] and {c["code"] for c in p["corners"]} <= {"T1", "T2"}
        assert all(c["loss_s"] > 0 for c in p["corners"]) and p["numbering"] == "official"
    # the event's sessions with every lap of their runs, to pick by hand
    assert [s["code"] for s in res["sessions"]] == ["Q1", "R1"]
    assert [len(r["laps"]) for r in res["sessions"][0]["runs"]] == [2, 1]
    assert res["sessions"][0]["runs"][0]["tyres"] == "new" and res["sessions"][1]["runs"][0]["tyres"] == "used"

    # kept: answered again without working anything out, and the comparison it suggests opens at once
    assert client.get(f"/events/{event['id']}/compare/suggestions").json() == res
    laps = [{"session_id": x["session_id"], "lap": x["lap"]} for x in res["suggestions"][0]["laps"]]
    r = client.post("/compare/laps", json={"laps": laps})
    assert r.status_code == 200 and r.json()["laps"][1]["driver"] == "Bo Lind"

    # a driver changed on a run: worked out again
    assert client.patch(f"/garage/runs/{r_bo}", json={"driver_id": anna["id"]}).status_code == 200
    again = client.get(f"/events/{event['id']}/compare/suggestions").json()
    assert cs.wait_idle(120)
    again = client.get(f"/events/{event['id']}/compare/suggestions").json()
    assert all(p["kind"] != "teammates" or p["tyres"] == "new" for p in again["suggestions"])
