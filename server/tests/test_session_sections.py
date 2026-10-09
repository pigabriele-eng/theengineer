"""Every lap of the latest session against its fastest lap, section by section (app/session_sections.py)."""
from datetime import datetime, timedelta

import numpy as np
import pytest
from sqlalchemy import select

from app import db as app_db, models, page_cache
from app import session_sections as ss
from tests import synthetic
from tests.synthetic import simulate, write_ld

CORNERS = [{"code": "T1", "apex_m": 300}, {"code": "T2", "apex_m": 700}]


def _late_apex(d, pace):
    """The synthetic lap, but carrying far more speed through T1 and far less through T2."""
    v = 150.0 - 60.0 * np.exp(-((d - 300) / 45.0) ** 2) - 110.0 * np.exp(-((d - 700) / 45.0) ** 2)
    return v * pace


def _upload(client, session_id, paces, monkeypatch=None, speed=None):
    if speed is not None:
        with monkeypatch.context() as m:  # (never undo(): the client fixture's settings are in the same monkeypatch)
            m.setattr(synthetic, "speed_at", speed)
            channels, _ = simulate(paces=paces)
    else:
        channels, _ = simulate(paces=paces)
    r = client.post(f"/sessions/{session_id}/files", files={"file": ("run.ld", write_ld(channels))})
    assert r.status_code == 201, r.text


def _run(client, event, name, driver=None):
    body = {"event_id": event["id"], "name": name, "kind": "race"}
    if driver:
        body["driver_id"] = driver["id"]
    return client.post("/sessions", json=body).json()["id"]


def test_chunks_each_start_with_the_fastest_lap():
    laps = [(1, n) for n in range(1, 8)] + [(2, n) for n in range(1, 6)]
    plan = ss.chunks(laps, (1, 4), size=5)
    assert all(c[0] == (1, 4) and 2 <= len(c) <= 6 for c in plan)
    assert [x for c in plan for x in c[1:]] == [x for x in laps if x != (1, 4)]  # each other lap once, in order
    assert len(plan) == 3
    assert ss.chunks([(1, 1)], (1, 1)) == []
    assert ss.CHUNK + 1 == ss.MAX_LAPS  # every chunk fits one lap comparison


def test_latest_upload_wins_and_one_import_counts_as_one_upload(client):
    track = client.post("/tracks", json={"name": "Test ring", "corners": CORNERS}).json()
    event = client.post("/events", json={"name": "Round 5", "track_id": track["id"]}).json()
    q = _run(client, event, "Q1")
    r1, r2 = _run(client, event, "R1 stint 1"), _run(client, event, "R1 stint 2")
    fp = _run(client, event, "FP1 stint 1")
    for sid in (q, r1, r2):
        _upload(client, sid, (1.0, 0.99))
    with app_db.SessionLocal() as db:
        sessions = ss._sessions(db, event["id"])
        part, _ = ss.latest_part(db, sessions)
        assert part.code == "R1"  # FP1 has no log yet: no timed run
        when = ss.upload_times(db, sessions)
        assert when[r2] >= when[r1] >= when[q]
    _upload(client, fp, (1.0, 0.99))  # FP1's log uploaded last: its session is the latest uploaded
    with app_db.SessionLocal() as db:
        part, _ = ss.latest_part(db, ss._sessions(db, event["id"]))
        assert part.code == "FP1"
        # Q1 and R1 came in one later import: of the runs uploaded together, the one driven last
        start = datetime(2030, 1, 1)
        db.add(models.ImportJob(filename="weekend.zip", status=models.ImportStatus.done, created_at=start,
                                finished_at=start + timedelta(seconds=30), session_ids=[q, r1, r2]))
        db.commit()
        sessions = ss._sessions(db, event["id"])
        when = ss.upload_times(db, sessions)
        assert when[q] == when[r1] == when[r2] == start
        part, _ = ss.latest_part(db, sessions)
        assert part.code == "R1"
        # a log stored while that import ran counts as part of it
        f = next(s for s in sessions if s.id == fp).files[0]
        f.uploaded_at = start + timedelta(seconds=12)
        db.commit()
        assert ss.upload_times(db, ss._sessions(db, event["id"]))[fp] == start


def test_latest_session_sections(client, monkeypatch):
    track = client.post("/tracks", json={"name": "Test ring", "corners": CORNERS}).json()
    event = client.post("/events", json={"name": "Round 5", "track_id": track["id"]}).json()
    empty = client.post("/events", json={"name": "Round 6", "track_id": track["id"]}).json()
    anna, bo = (client.post("/drivers", json={"name": n}).json() for n in ("Anna Berg", "Bo Lind"))
    q = _run(client, event, "Q1", anna)
    _upload(client, q, (1.0,))
    s1, s2 = _run(client, event, "R1 stint 1", anna), _run(client, event, "R1 stint 2", bo)
    _upload(client, s1, (1.0, 0.99, 0.8, 0.98, 0.985))  # lap 3 off the pace
    _upload(client, s2, (0.975, 0.97, 0.972), monkeypatch, _late_apex)

    assert client.get("/events/999/latest-session/sections").status_code == 404
    assert client.get(f"/events/{empty['id']}/latest-session/sections").json()["status"] == "empty"

    monkeypatch.setattr(ss, "CHUNK", 2)  # several comparisons, each with the fastest lap
    first = client.get(f"/events/{event['id']}/latest-session/sections").json()
    assert first["status"] == "working" and first["session"] == {"code": "R1", "title": "R1"}
    # the laps are listed at once, by stint in the order they ran, the lap off the pace too
    assert [(r["id"], r["driver"], [l["number"] for l in r["laps"]]) for r in first["runs"]] == [
        (s1, "Anna Berg", [1, 2, 3, 4, 5]), (s2, "Bo Lind", [1, 2, 3])]
    assert all(l["sections"] is None for r in first["runs"] for l in r["laps"])
    assert [(l["clean"], l["kind"]) for l in first["runs"][0]["laps"]][2] == (False, "slow")
    assert first["left_out"] == 0
    assert first["fastest"]["session_id"] == s1 and first["fastest"]["lap"] == 1
    assert ss.wait_idle(120)
    res = client.get(f"/events/{event['id']}/latest-session/sections").json()
    assert res["status"] == "ready" and res["progress"] is None and res["note"] is None
    assert res["numbering"] == "official" and [s["code"] for s in res["sections"]] == ["T1", "T2"]
    times = {(r["id"], l["number"]): l["sections"] for r in res["runs"] for l in r["laps"]}
    assert all(t is not None and len(t) == 2 for t in times.values())
    fast = times[(s1, 1)]
    assert sum(fast) == pytest.approx(res["fastest"]["time"], abs=0.05)
    # the late-apex stint: slower laps, but quicker than the fastest lap through T1 (and slower through T2)
    for n in (1, 2, 3):
        lap = times[(s2, n)]
        assert lap[0] - fast[0] <= -0.02 and lap[1] > fast[1]
    # the same laps of the stint the fastest lap is in: slower everywhere, by their pace, the lap off it most
    assert all(times[(s1, n)][k] >= fast[k] for n in (2, 3, 4, 5) for k in (0, 1))
    assert all(times[(s1, 3)][k] > times[(s1, 2)][k] for k in (0, 1))
    # the section times are the lap comparison's own
    cmp = client.post("/compare/laps", json={"laps": [{"session_id": s1, "lap": 1}, {"session_id": s2, "lap": 2}]})
    assert [s["times"] for s in cmp.json()["sections"]] == [[fast[0], times[(s2, 2)][0]], [fast[1], times[(s2, 2)][1]]]

    # kept: answered again at once, the same
    assert client.get(f"/events/{event['id']}/latest-session/sections").json() == res
    # a driver changed: worked out again
    assert client.patch(f"/garage/runs/{s2}", json={"driver_id": anna["id"]}).status_code == 200
    again = client.get(f"/events/{event['id']}/latest-session/sections").json()
    assert again["status"] == "working" and again["runs"][1]["driver"] == "Anna Berg"
    assert ss.wait_idle(120)
    assert client.get(f"/events/{event['id']}/latest-session/sections").json()["status"] == "ready"


def test_one_clean_lap_and_warm_up(client, monkeypatch):
    track = client.post("/tracks", json={"name": "Test ring", "corners": CORNERS}).json()
    event = client.post("/events", json={"name": "Round 7", "track_id": track["id"]}).json()
    q = _run(client, event, "Q1")
    _upload(client, q, (1.0,))
    monkeypatch.setattr(ss, "RECENT_DAYS", 100000)  # the synthetic logs are dated long ago
    ss.warm([q])  # as the prebuild does after an upload: worked out and kept
    with app_db.SessionLocal() as db:
        row = db.scalar(select(page_cache.PageCache).where(page_cache.PageCache.scope == ss._scope(event["id"])))
        assert row is not None
    res = client.get(f"/events/{event['id']}/latest-session/sections").json()
    assert res["status"] == "ready" and res["note"].startswith("One clean lap")
    assert res["runs"][0]["laps"][0]["sections"] is None and res["sections"] is None


def test_another_session_and_stints_mixed_in(client, monkeypatch):
    track = client.post("/tracks", json={"name": "Test ring", "corners": CORNERS}).json()
    event = client.post("/events", json={"name": "Round 8", "track_id": track["id"]}).json()
    anna, bo = (client.post("/drivers", json={"name": n}).json() for n in ("Anna Berg", "Bo Lind"))
    q = _run(client, event, "Q1", anna)
    _upload(client, q, (1.0, 0.99))
    s1, s2 = _run(client, event, "R1 stint 1", anna), _run(client, event, "R1 stint 2", bo)
    _upload(client, s1, (1.0, 0.99, 0.985))
    _upload(client, s2, (0.975, 0.97), monkeypatch, _late_apex)
    _run(client, event, "FP1 stint 1")  # no log: not a session to pick
    url = f"/events/{event['id']}/latest-session/sections"

    first = client.get(url).json()
    assert first["latest"] == "R1" and first["added"] == []
    # the sessions to pick from, in the order they ran, each with its stints, laps and drivers
    assert [(c["code"], c["drivers"], [r["id"] for r in c["runs"]]) for c in first["sessions"]] == [
        ("Q1", ["Anna Berg"], [q]), ("R1", ["Anna Berg", "Bo Lind"], [s1, s2])]
    assert first["sessions"][1]["laps"] == sum(r["laps"] for r in first["sessions"][1]["runs"]) > 0
    assert all(r["session"] == "R1" for r in first["runs"])
    assert ss.wait_idle(120)
    latest = client.get(url).json()
    assert latest["status"] == "ready" and latest["sessions"] == first["sessions"]
    assert client.get(url, params={"part": "R1"}).json() == latest  # the latest, picked: the same answer

    # another session
    qa = client.get(url, params={"part": "Q1"}).json()
    assert qa["session"]["code"] == "Q1" and [r["id"] for r in qa["runs"]] == [q] and qa["latest"] == "R1"
    # ... with a stint of another session mixed in after its own, named with its session
    mix = client.get(url, params={"part": "Q1", "add": f"{s2},{q}"}).json()
    assert mix["added"] == [s2]  # Q1's own run isn't added again
    assert [(r["id"], r["session"]) for r in mix["runs"]] == [(q, "Q1"), (s2, "R1")]
    every = [(r["id"], l["number"], l["time"]) for r in mix["runs"] for l in r["laps"]]
    quickest = min(every, key=lambda x: x[2])  # the quickest of all these laps, whichever session
    assert (mix["fastest"]["session_id"], mix["fastest"]["lap"]) == quickest[:2]
    assert ss.wait_idle(120)
    ready = client.get(url, params={"part": "Q1", "add": str(s2)}).json()
    assert ready["status"] == "ready" and [s["code"] for s in ready["sections"]] == ["T1", "T2"]
    assert all(l["sections"] is not None for r in ready["runs"] for l in r["laps"])
    # the latest session's answer is kept apart from the picked ones
    assert client.get(url).json() == latest

    assert client.get(url, params={"part": "FP9"}).status_code == 404
    assert client.get(url, params={"add": "3,x"}).status_code == 422


def _quali(d, pace):
    """A qualifying run's laps: as the synthetic lap, but the in-lap (pace 0.51) pushes through T1 quicker than any
    other lap, then backs off for the pit lane."""
    if pace == 0.51:
        return np.where(d < 500, synthetic._SPEED_AT(d, 1.012), synthetic._SPEED_AT(d, 0.7))
    return synthetic._SPEED_AT(d, pace)  # (speed_at is this function while the run is driven)


def test_lap_kinds():
    lap = lambda n, clean: models.Lap(number=n, clean=clean)  # noqa: E731
    # Gabriele's qualifying run: an out-lap, a slow build lap, the pushes, a push that turns into the in-lap
    q = [lap(1, False), lap(2, False), lap(3, True), lap(4, True), lap(5, False)]
    assert ss.lap_kinds(q) == {1: "out", 2: "build", 3: None, 4: None, 5: "in"}
    # a slow lap among the clean ones, and a cool-down lap before the in-lap
    r = [lap(1, True), lap(2, False), lap(3, True), lap(4, False), lap(5, False)]
    assert ss.lap_kinds(r) == {1: None, 2: "slow", 3: None, 4: "slow", 5: "in"}
    assert ss.lap_kinds([lap(1, False), lap(2, False)]) == {1: "out", 2: "build"}
    assert ss.lap_kinds([]) == {}
    # set by hand: as set (a build lap set by hand is clean, as the pick makes it)
    picked = [lap(1, False), lap(2, True), lap(3, True), lap(4, False), lap(5, True)]
    assert ss.lap_kinds(picked, {2: "build", 4: "push", 5: "in"}) == {1: "out", 2: "build", 3: None, 4: None,
                                                                       5: "in"}


def test_the_clean_laps_first_then_each_runs_others():
    answer = {"fastest": {"session_id": 1, "lap": 3}, "runs": [
        {"id": 1, "laps": [{"number": n, "clean": n in (3, 4)} for n in (1, 2, 3, 4, 5)]},
        {"id": 2, "laps": [{"number": n, "clean": n == 2} for n in (1, 2, 3)]}]}
    assert ss.plan_chunks(answer) == [[(1, 3), (1, 4), (2, 2)], [(1, 3), (1, 1), (1, 2), (1, 5)],
                                      [(1, 3), (2, 1), (2, 3)]]
    # by section code: one a comparison doesn't have goes without
    res = {"sections": [{"code": "T1", "times": [9.1, 9.3]}, {"code": "T3", "times": [5.0, 5.2]}]}
    assert ss.by_code(["T1", "T2", "T3"], res, 1) == [9.3, None, 5.2]


def test_every_lap_driven_out_and_in_laps_too(client, monkeypatch):
    track = client.post("/tracks", json={"name": "Test ring", "corners": CORNERS}).json()
    event = client.post("/events", json={"name": "Round 8", "track_id": track["id"]}).json()
    q = _run(client, event, "Q1")
    _upload(client, q, (0.85, 0.94, 1.0, 0.995, 0.51), monkeypatch, _quali)
    url = f"/events/{event['id']}/latest-session/sections"
    first = client.get(url).json()
    laps = first["runs"][0]["laps"]
    assert [(l["number"], l["clean"], l["kind"]) for l in laps] == [
        (1, False, "out"), (2, False, "build"), (3, True, None), (4, True, None), (5, False, "in")]
    assert first["fastest"]["lap"] == 3 and first["left_out"] == 0
    assert ss.wait_idle(120)
    res = client.get(url).json()
    assert res["status"] == "ready" and res["note"] is None
    times = {l["number"]: l["sections"] for l in res["runs"][0]["laps"]}
    assert all(t is not None and None not in t and len(t) == 2 for t in times.values())
    # the in-lap: quicker than the fastest lap through T1, before it backs off for the pit lane
    assert times[5][0] < times[3][0] and times[5][1] > times[3][1]
    assert all(times[n][k] > times[3][k] for n in (1, 2) for k in (0, 1))

    # a lap set by hand is what it was set to, here and on every page (the in-lap called a push lap: clean)
    r = client.put(f"/sessions/{q}/laps/5/type", json={"type": "push"})
    assert r.status_code == 200, r.text
    picked = client.get(url).json()
    assert [(l["number"], l["clean"], l["kind"]) for l in picked["runs"][0]["laps"]][4] == (5, True, None)
    assert ss.wait_idle(120)
    client.put(f"/sessions/{q}/laps/5/type", json={"type": None})

    # a lap quicker than the fastest that isn't clean is only part of a lap: left out
    with app_db.SessionLocal() as db:
        part = db.scalar(select(models.Lap).where(models.Lap.session_id == q, models.Lap.number == 2))
        part.time_s = 20.0
        db.commit()
    again = client.get(url).json()
    assert [l["number"] for l in again["runs"][0]["laps"]] == [1, 3, 4, 5] and again["left_out"] == 1
    assert ss.wait_idle(120)


def test_a_lap_the_comparison_cant_place_goes_alone(client, monkeypatch):
    track = client.post("/tracks", json={"name": "Test ring", "corners": CORNERS}).json()
    event = client.post("/events", json={"name": "Round 9", "track_id": track["id"]}).json()
    run = _run(client, event, "FP1")
    _upload(client, run, (1.0, 0.99, 0.985, 0.98))
    real = ss.compare_picks

    def picky(picks, *a, **k):
        if any(p.number == 3 for p in picks):
            raise ValueError("can't place lap 3")
        return real(picks, *a, **k)

    monkeypatch.setattr(ss, "compare_picks", picky)
    client.get(f"/events/{event['id']}/latest-session/sections")
    assert ss.wait_idle(120)
    res = client.get(f"/events/{event['id']}/latest-session/sections").json()
    times = {l["number"]: l["sections"] for l in res["runs"][0]["laps"]}
    assert times[3] is None and all(times[n] is not None for n in (1, 2, 4))
    assert res["note"].startswith("Some laps couldn't be placed")
