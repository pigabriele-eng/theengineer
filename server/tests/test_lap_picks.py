"""A lap's type set by hand (Gabriele, 2026-10-09: "add the ability to manually change the nature of the lap in case
the app gets it wrong"): his pick wins over the app's reading, survives the log being timed again, and the pages
follow it."""
from app.analysis.laps import Lap, apply_picks
from app.analysis.stint import lap_kinds
from app.routers.technique import mark_build_laps
from tests.test_timing import marked


def laps(*clean: bool) -> list[Lap]:
    return [Lap(i + 1, 100.0 * i, 100.0 * (i + 1), 100.0, c) for i, c in enumerate(clean)]


def test_a_pick_wins_and_finds_its_lap_by_when_it_started():
    xs = laps(False, True, True, False)
    apply_picks(xs, {"1.5": "push", "201.0": "in", "350.0": "out", "300.0": "nonsense"})
    assert [(x.pick, x.clean) for x in xs] == [("push", True), (None, True), ("in", False), (None, False)]


def test_the_stint_reads_picked_laps_as_set():
    # the app's own: slow laps at the start are out-laps, at the end in-laps
    assert lap_kinds(laps(False, False, True, True, False), []) == ["out", "out", "flying", "flying", "in"]
    xs = laps(False, False, True, True, False)
    apply_picks(xs, {"100": "build", "200": "in"})
    # the build lap stays a slow lap (not an out-lap) and the out-lap before it stays out
    assert lap_kinds(xs, []) == ["out", "slow", "in", "flying", "in"]


def test_a_picked_push_lap_is_never_a_build_lap_and_a_picked_build_lap_always_is():
    rows = [{"session_id": 1, "number": n, "time": t} for n, t in [(2, 120.0), (3, 115.0), (4, 115.5), (5, 125.0)]]
    mark_build_laps(rows, {1: "qualifying"}, {1: {2: "push", 4: "build"}})
    assert [(x["build"], x["pick"]) for x in rows] == [(False, "push"), (False, None), (True, "build"), (True, None)]


def test_a_lap_set_by_hand_keeps_its_type_when_the_log_is_timed_again(client, settle):
    import app.db
    import app.models
    from app import timing

    sid = client.post("/sessions", json={"name": "Q1"}).json()["id"]
    before = client.post(f"/sessions/{sid}/files", files={"file": ("q.ld", marked())}).json()["laps"]
    timing.wait_idle()
    out = next(l for l in before if not l["clean"])
    push = next(l for l in before if l["clean"])
    assert client.put(f"/sessions/{sid}/laps/{out['number']}/type", json={"type": "warm"}).status_code == 422
    assert client.put(f"/sessions/{sid}/laps/999/type", json={"type": "push"}).status_code == 404

    r = client.put(f"/sessions/{sid}/laps/{out['number']}/type", json={"type": "push"})
    assert r.status_code == 200
    r = client.put(f"/sessions/{sid}/laps/{push['number']}/type", json={"type": "in"}).json()
    by = {l["number"]: l for l in r["laps"]}
    assert (by[out["number"]]["pick"], by[out["number"]]["clean"]) == ("push", True)
    assert (by[push["number"]]["pick"], by[push["number"]]["clean"]) == ("in", False)
    assert all(l["pick"] is None for n, l in by.items() if n not in (out["number"], push["number"]))

    settle()
    with app.db.SessionLocal() as db:  # timed again, as when older lap timing is found on startup
        for f in db.query(app.models.LoggerFile):
            f.meta = {k: v for k, v in f.meta.items() if k != "timing_version"}
        db.commit()
    timing.check_all_tracks()
    timing.wait_idle()
    again = {l["number"]: l for l in client.get(f"/sessions/{sid}").json()["laps"]}
    assert (again[out["number"]]["pick"], again[out["number"]]["clean"]) == ("push", True)
    assert (again[push["number"]]["pick"], again[push["number"]]["clean"]) == ("in", False)

    # given back to the app: its own reading again
    r = client.put(f"/sessions/{sid}/laps/{out['number']}/type", json={"type": None}).json()
    by = {l["number"]: l for l in r["laps"]}
    assert (by[out["number"]]["pick"], by[out["number"]]["clean"]) == (None, False)
    assert by[push["number"]]["pick"] == "in"
    stints = client.get(f"/sessions/{sid}/stint").json()
    kinds = {l["lap"]: l["kind"] for s in stints["stints"] for l in s["laps"]}
    assert kinds[push["number"]] == "in"
    settle()
