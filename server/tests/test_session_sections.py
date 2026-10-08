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
    # the laps are listed at once, by stint in the order they ran, clean laps only
    assert [(r["id"], r["driver"], [l["number"] for l in r["laps"]]) for r in first["runs"]] == [
        (s1, "Anna Berg", [1, 2, 4, 5]), (s2, "Bo Lind", [1, 2, 3])]
    assert all(l["sections"] is None for r in first["runs"] for l in r["laps"])
    assert first["left_out"] == 1  # the lap off the pace
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
    # the same laps of the stint the fastest lap is in: slower everywhere, by their pace
    assert all(times[(s1, n)][k] >= fast[k] for n in (2, 4, 5) for k in (0, 1))
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
