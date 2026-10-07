"""The pages' answers kept in the database (app/page_cache.py), the prebuild that works them out in the background
after an upload (app/prebuild.py), and background work giving the heavy-work lock to requests first (app/heavy.py)."""
import json
import os
import sys
import threading
import time
import zlib

import numpy as np
import pytest
from sqlalchemy import select
from tests.synthetic import simulate, write_ld
from tests.test_imports import log_bytes, make_zip, upload

PAGES = ("analysis", "map", "shape", "insights")


@pytest.fixture(autouse=True)
def _no_quiet_wait(monkeypatch):
    """The tests' own requests don't hold the prebuild up (test_a_piece_starts_after_a_quiet_moment checks that)."""
    from app import prebuild

    monkeypatch.setattr(prebuild, "QUIET_S", {prebuild.UPLOAD: 0.0, prebuild.START: 0.0})
    monkeypatch.setattr(prebuild, "MAX_WAIT_S", {prebuild.UPLOAD: 0.0, prebuild.START: 0.0})


def _session(client, name="Run 1", paces=(0.95, 0.97, 0.96, 0.975)) -> tuple[int, int]:
    event = client.post("/events", json={"name": "Test day"}).json()
    s = client.post("/sessions", json={"event_id": event["id"], "name": name}).json()
    r = client.post(f"/sessions/{s['id']}/files", files={"file": ("run.ld", write_ld(simulate(paces=paces)[0]))})
    assert r.status_code == 201, r.text
    return s["id"], r.json()["files"][0]["id"]


def _scopes() -> set[str]:
    from app import db as app_db
    from app.page_cache import PageCache

    with app_db.SessionLocal() as db:
        return set(db.scalars(select(PageCache.scope)))


def _get_all(client, sid: int, fid: int) -> dict[str, dict]:
    out = {p: client.get(f"/sessions/{sid}/{p}") for p in PAGES}
    out["stint"] = client.get(f"/stint?files={fid}")
    out["grip"] = client.get(f"/report/grip?session={sid}")
    out["balance"] = client.get(f"/report/balance?session={sid}")
    for p, r in out.items():
        assert r.status_code == 200, (p, r.text)
    return {p: r.json() for p, r in out.items()}


def test_a_kept_page_answers_without_reading_the_log_or_waiting_for_the_lock(client, monkeypatch):
    from app import heavy
    from app.routers import balance, insights, report_grip, sessions, stint, trackmap, trackshape

    sid, fid = _session(client)
    first = _get_all(client, sid, fid)
    assert {f"session:{sid}|{p}" for p in (*PAGES, "grip", "balance")} | {f"session:{sid}|stint|file:{fid}"} \
        <= _scopes()

    def no_log(*a, **k):
        raise AssertionError("the log was read again")
    for module in (sessions, insights, stint, trackmap, trackshape, report_grip):
        monkeypatch.setattr(module, "read_file", no_log)
    monkeypatch.setattr(balance, "load_main_file", no_log)
    for module in (stint, trackmap, trackshape, report_grip, balance):  # as after a restart
        module._cache.clear()
    with heavy.lock:  # another job is reading a log: a kept answer doesn't wait for it
        assert _get_all(client, sid, fid) == first
        assert client.get(f"/sessions/{sid}/stint").json() == first["stint"]


def test_a_kept_page_goes_out_as_the_json_it_is_kept_as(client, monkeypatch):
    from fastapi import routing

    from app.routers import balance, report_grip, stint, trackmap, trackshape

    sid, fid = _session(client)
    ev = client.get(f"/sessions/{sid}").json()["event_id"]
    analysis = client.get(f"/sessions/{sid}/analysis").json()
    lap = next(l["number"] for l in analysis["laps"] if l["clean"] and l["number"] != analysis["reference_lap"])
    paths = [*(f"/sessions/{sid}/{p}" for p in PAGES), f"/stint?files={fid}", f"/sessions/{sid}/stint",
             f"/report/grip?session={sid}", f"/report/balance?session={sid}", f"/report/grip?event={ev}",
             f"/report/balance?event={ev}", f"/events/{ev}/map", f"/events/{ev}/shape",
             f"/sessions/{sid}/compare?lap={lap}&reference_lap={analysis['reference_lap']}"]
    encoded = []
    real = routing.jsonable_encoder
    monkeypatch.setattr(routing, "jsonable_encoder", lambda x, *a, **k: encoded.append(x) or real(x, *a, **k))
    first = {p: client.get(p) for p in paths}  # worked out: sent as the text just kept
    for _ in range(2):  # from memory, then (as after a restart) from the database
        for p in paths:
            r = client.get(p)
            assert r.status_code == 200 and r.headers["content-type"] == "application/json", (p, r.text)
            assert r.content == first[p].content, p
        for module in (stint, trackmap, trackshape, report_grip, balance):
            module._cache.clear()
    assert encoded == []  # FastAPI never read them back into Python to write them out again
    assert first[f"/events/{ev}/map"].json() == {**first[f"/sessions/{sid}/map"].json(), "event_fastest": True}


def test_a_kept_page_is_worked_out_again_when_its_log_or_laps_change(client, monkeypatch):
    from app import db as app_db, heavy, models
    from app.routers import sessions

    sid, fid = _session(client)
    calls = []
    real = sessions.analyze
    monkeypatch.setattr(sessions, "analyze", lambda *a, **k: calls.append(1) or real(*a, **k))
    first = client.get(f"/sessions/{sid}/analysis").json()
    assert client.get(f"/sessions/{sid}/analysis").json() == first and len(calls) == 1

    with app_db.SessionLocal() as db:  # its laps as stored change (timed again)
        lap = db.scalar(select(models.Lap).where(models.Lap.session_id == sid, models.Lap.clean)
                        .order_by(models.Lap.number.desc()))
        lap.time_s += 0.5
        db.commit()
    assert client.get(f"/sessions/{sid}/analysis").json()["file_id"] == fid and len(calls) == 2
    client.get(f"/sessions/{sid}/analysis")
    assert len(calls) == 2  # kept again

    # a longer log: the page reads that one now
    r = client.post(f"/sessions/{sid}/files", files={"file": ("long.ld", write_ld(simulate(
        paces=(0.95, 0.97, 0.96, 0.975, 0.98, 0.99))[0]))})
    assert r.status_code == 201, r.text
    third = client.get(f"/sessions/{sid}/analysis").json()
    assert len(calls) == 3 and third["file_id"] != fid and len(third["laps"]) > len(first["laps"])

    # a tagged lap: the stint view changes, from the log's reduction kept in memory (no wait for the lock)
    view = client.get(f"/stint?files={fid}").json()
    assert client.put("/lap-tags", json={"file_id": fid, "lap": 3, "tag": "sc"}).status_code == 200
    with heavy.lock:
        tagged = client.get(f"/stint?files={fid}").json()
    assert tagged != view


def test_the_session_pages_lap_comparisons_are_kept_lap_by_lap(client, monkeypatch):
    from app import db as app_db, heavy, models
    from app.routers import sessions

    sid, fid = _session(client, paces=(0.95, 0.97, 0.96, 0.975, 0.98))
    analysis = client.get(f"/sessions/{sid}/analysis").json()
    ref = analysis["reference_lap"]
    laps = [l for l in client.get(f"/sessions/{sid}").json()["laps"] if l["file_id"] == analysis["file_id"]]
    clean = [l for l in laps if l["clean"] and l["number"] != ref]
    lap = sorted(clean, key=lambda l: l["time_s"])[0]["number"]  # the pair the page opens on (LapCompare.tsx)
    other = next(l["number"] for l in clean if l["number"] != lap)
    with app_db.SessionLocal() as db:
        assert sessions.default_compare(db.get(models.RunSession, sid)) == (lap, ref)  # the prebuild's pair

    worked = []
    real = sessions.compare_laps
    monkeypatch.setattr(sessions, "compare_laps", lambda *a, **k: worked.append(a[1:3]) or real(*a, **k))
    path = f"/sessions/{sid}/compare"
    first = {n: client.get(path, params={"lap": n, "reference_lap": ref}).json() for n in (lap, other)}
    assert first[lap]["lap"] == lap and first[lap]["reference_lap"] == ref and first[lap]["file_id"] == fid
    # other views are worked out each time and not kept: another reference, step or log, or a lap the log doesn't have
    assert client.get(path, params={"lap": lap, "reference_lap": other}).json()["reference_lap"] == other
    assert client.get(path, params={"lap": lap, "reference_lap": ref, "step": 10}).json()["step_m"] == 10
    assert client.get(path, params={"lap": lap, "file_id": fid + 1}).status_code == 404
    assert client.get(path, params={"lap": 99, "reference_lap": ref}).status_code == 404
    assert {s for s in _scopes() if "|compare" in s} == {f"session:{sid}|compare|{n}|{ref}" for n in (lap, other)}
    assert len(worked) == 5

    def no_log(*a, **k):
        raise AssertionError("the log was read again")
    monkeypatch.setattr(sessions, "read_file", no_log)
    with heavy.lock:  # another job is reading a log: a kept comparison doesn't wait for it
        for n in (lap, other):
            assert client.get(path, params={"lap": n, "reference_lap": ref}).json() == first[n]
    assert len(worked) == 5


def test_an_event_deleted_takes_its_kept_pages_with_it(client):
    from app import db as app_db
    from tests.test_event_delete import _ids, _import, references

    a, b = _import(client, "Monza test"), _import(client, "Spa test")
    for test in (a, b):
        for sid in test["sessions"]:
            assert client.get(f"/sessions/{sid}/analysis").status_code == 200
            assert client.get(f"/sessions/{sid}/map").status_code == 200
        assert client.get(f"/events/{test['event']}/shape").status_code == 200
    kept_b = {s for s in _scopes() if s.startswith(f"event:{b['event']}|")
              or any(s.startswith(f"session:{sid}|") for sid in b["sessions"])}
    assert len(kept_b) == 5
    with app_db.SessionLocal() as db:
        gone = _ids(db, a)
        assert {f"page_cache.scope session:{a['sessions'][0]}|analysis",
                f"page_cache.scope event:{a['event']}|shape"} <= set(references(db, gone))

    r = client.delete(f"/events/{a['event']}", params={"runs": "delete"})
    assert r.status_code == 200, r.text
    assert r.json()["rows"]["page_cache"] == 5
    with app_db.SessionLocal() as db:
        assert references(db, gone) == []
    assert kept_b <= _scopes()
    assert not any(s.startswith(f"event:{a['event']}|") for s in _scopes())


def _wait_tyre_data_and_prebuild(timeout=180):
    from app import db as app_db, prebuild
    from app.vehicle import tyre_store

    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        with app_db.SessionLocal() as db:
            todo = tyre_store._todo(db)
        if not todo and tyre_store._state["current"] is None and prebuild.wait_idle(1) and not tyre_store._done:
            return
        time.sleep(0.2)
    raise AssertionError("the prebuild didn't finish")


def test_an_import_is_prebuilt_and_every_page_then_opens_at_once(client, monkeypatch):
    from app import heavy, models, prebuild
    from app import db as app_db
    from app.routers import reports, sessions

    monkeypatch.setenv("PREBUILD", "on")
    job = upload(client, ("Test day.zip", make_zip({"Test day/01_D1S1/a.ld": log_bytes(),
                                                    "Test day/02_D1S2/b.ld": log_bytes()})))
    assert job["status"] == "done", job
    _wait_tyre_data_and_prebuild()
    (ev,) = [e["id"] for e in client.get("/events").json()]
    sids = job["session_ids"]
    for sid in sids:
        assert {f"session:{sid}|{p}" for p in ("analysis", "map", "shape", "tyreprep")} <= _scopes()
        assert f"session:{sid}|insights" not in _scopes()  # no page asks for them
    assert f"event:{ev}|shape" in _scopes()
    assert not reports._jobs.unfinished_tasks  # nothing left to the report queue: the prebuild did it

    with app_db.SessionLocal() as db:
        fids = {s.id: s.files[0].id for s in db.scalars(select(models.RunSession))}
        pairs = {s.id: sessions.default_compare(s) for s in db.scalars(select(models.RunSession))}
    for sid, (lap, ref) in pairs.items():  # the lap comparison the session page opens on
        assert f"session:{sid}|compare|{lap}|{ref}" in _scopes()
    with heavy.lock:  # every page answers from what was kept, without waiting for the heavy-work lock
        for sid, (lap, ref) in pairs.items():
            assert client.get(f"/sessions/{sid}/compare", params={"lap": lap, "reference_lap": ref}).status_code == 200
        for path in (f"/reports/events/{ev}", f"/technique/events/{ev}", f"/track-grip/events/{ev}",
                     *(f"/reports/sessions/{sid}" for sid in sids), *(f"/technique/sessions/{sid}" for sid in sids)):
            body = client.get(path).json()
            assert body["status"] == "ready", (path, body)
        for sid in sids:
            for path in (f"/sessions/{sid}/analysis", f"/stint?files={fids[sid]}", f"/sessions/{sid}/map",
                         f"/sessions/{sid}/shape", f"/report/tyre-prep?session={sid}", f"/report/grip?session={sid}",
                         f"/report/balance?session={sid}"):
                assert client.get(path).status_code == 200, path
        quick_laps = ",".join(str(fids[sid]) for sid in reversed(sids))  # the report's quick laps: every main log
        for path in (f"/events/{ev}/map", f"/events/{ev}/shape", f"/report/tyre-prep?event={ev}",
                     f"/report/grip?event={ev}", f"/report/balance?event={ev}", f"/stint?files={quick_laps}"):
            assert client.get(path).status_code == 200, path
    status = client.get("/prebuild").json()
    assert status["enabled"] and status["queued"] == 0 and status["current"] is None and status["worked"] > 0
    with app_db.SessionLocal() as db:  # and the lap packs the lap and driver comparisons read instead of the logs
        assert {r.session_id for r in db.scalars(select(models.LapPackFile)) if r.path} == set(sids)

    # a log added to a run: its pages and its event's are made again, the other run's are still up to date
    analysed = []
    real = sessions.analyze
    monkeypatch.setattr(sessions, "analyze", lambda *a, **k: analysed.append(1) or real(*a, **k))
    old_laps = len(client.get(f"/sessions/{sids[0]}/analysis").json()["laps"])
    r = client.post(f"/sessions/{sids[0]}/files", files={"file": ("long.ld", write_ld(simulate(
        paces=(0.95, 0.97, 0.96, 0.975, 0.98, 0.99))[0]))})
    assert r.status_code == 201, r.text
    _wait_tyre_data_and_prebuild()
    assert len(analysed) == 1  # only the run with the new log
    with heavy.lock:
        assert client.get(f"/reports/events/{ev}").json()["status"] == "ready"
        assert len(client.get(f"/sessions/{sids[0]}/analysis").json()["laps"]) > old_laps
        assert client.get(f"/sessions/{sids[1]}/analysis").status_code == 200
    assert len(analysed) == 1

    # on start-up: what is missing or out of date is made again, at the lowest priority
    with app_db.SessionLocal() as db:
        db.execute(models.ReportCache.__table__.delete())
        db.commit()
        pieces = prebuild.everything(db)
    assert pieces[0] == ("traces", (min(sids),)) and ("report", ("event", ev)) in pieces
    monkeypatch.setattr(prebuild, "START_DELAY_S", 0)
    prebuild.start()
    deadline = time.monotonic() + 60
    while True:  # (asking the API would queue the report itself)
        with app_db.SessionLocal() as db:
            if db.scalar(select(models.ReportCache.result_signature).where(
                    models.ReportCache.scope == f"event:{ev}")):
                break
        assert time.monotonic() < deadline
        time.sleep(0.2)
    _wait_tyre_data_and_prebuild()
    assert not reports._jobs.unfinished_tasks
    with heavy.lock:
        assert client.get(f"/reports/events/{ev}").json()["status"] == "ready"


def test_pieces_for_an_upload_go_before_the_start_up_pass_and_duplicates_are_dropped(monkeypatch):
    from app import prebuild

    ran, gate = [], threading.Event()

    def piece(name):
        if name == "first":
            gate.wait(10)
        ran.append(name)
    monkeypatch.setitem(prebuild.RUN, "test", piece)
    prebuild._put(prebuild.START, [("test", ("first",))])
    time.sleep(0.2)  # the worker is in the first piece now
    prebuild._put(prebuild.START, [("test", ("start a",)), ("test", ("start b",))])
    prebuild._put(prebuild.UPLOAD, [("test", ("upload a",)), ("test", ("upload b",)), ("test", ("upload a",))])
    prebuild._put(prebuild.START, [("test", ("start a",))])
    gate.set()
    assert prebuild.wait_idle(10)
    assert ran == ["first", "upload a", "upload b", "start a", "start b"]


def test_background_work_takes_the_lock_only_after_requests_waiting_for_it(monkeypatch):
    from app import heavy, prebuild

    order = []

    def request():
        with heavy.lock:
            order.append("request")

    def background_piece(name):
        with heavy.lock:
            order.append(name)
    monkeypatch.setitem(prebuild.RUN, "test", background_piece)

    with heavy.lock:  # a job is reading a log
        prebuild._put(prebuild.UPLOAD, [("test", ("piece 1",)), ("test", ("piece 2",))])
        time.sleep(0.3)  # the prebuild waits for the lock, uncounted
        assert heavy.lock.waiting == 0
        t = threading.Thread(target=request)
        t.start()  # a page is opened meanwhile
        while heavy.lock.waiting == 0:
            time.sleep(0.01)
    t.join(5)
    assert prebuild.wait_idle(10)
    assert order == ["request", "piece 1", "piece 2"]

    # between two pieces of background work, a request that comes in goes first
    order.clear()
    hold = threading.Event()

    def slow_piece(name):
        with heavy.lock:
            order.append(name)
            if name == "piece 1":
                hold.wait(5)
    monkeypatch.setitem(prebuild.RUN, "test", slow_piece)
    prebuild._put(prebuild.UPLOAD, [("test", ("piece 1",)), ("test", ("piece 2",))])
    while order != ["piece 1"]:
        time.sleep(0.01)
    t = threading.Thread(target=request)
    t.start()
    while heavy.lock.waiting == 0:
        time.sleep(0.01)
    hold.set()
    t.join(5)
    assert prebuild.wait_idle(10)
    assert order == ["piece 1", "request", "piece 2"]


def test_a_piece_starts_after_a_quiet_moment_at_the_lowest_cpu_priority(monkeypatch):
    from app import prebuild
    from app.vehicle import tyre_store

    ran = []
    monkeypatch.setitem(prebuild.RUN, "test", lambda name: ran.append(
        (name, os.getpriority(os.PRIO_PROCESS, threading.get_native_id()) if sys.platform.startswith("linux")
         else None)))
    monkeypatch.setattr(prebuild, "QUIET_S", {prebuild.UPLOAD: 0.3, prebuild.START: 0.6})
    monkeypatch.setattr(prebuild, "MAX_WAIT_S", {prebuild.UPLOAD: 60.0, prebuild.START: 60.0})
    monkeypatch.setitem(tyre_store._traffic, "in_flight", 1)  # a page is being answered
    prebuild._put(prebuild.UPLOAD, [("test", ("upload",))])
    prebuild._put(prebuild.START, [("test", ("start",))])
    time.sleep(0.5)
    assert ran == []  # not while a request is being served
    tyre_store._traffic["in_flight"] = 0
    t0 = tyre_store._traffic["last"] = time.monotonic()  # ... and answered now
    assert prebuild.wait_idle(10)
    took = time.monotonic() - t0
    assert [name for name, _ in ran] == ["upload", "start"] and took >= 0.6
    if sys.platform.startswith("linux"):
        assert {nice for _, nice in ran} == {prebuild.NICE}


def test_health_checks_are_not_traffic(client, monkeypatch):
    from app.vehicle import tyre_store

    monkeypatch.setitem(tyre_store._traffic, "last", time.monotonic() - 100)
    assert client.get("/health").status_code == 200
    assert client.get("/prebuild").status_code == 200
    assert tyre_store.idle_s() > 99  # Render's health checks don't hold the background work up
    client.get("/events")
    assert tyre_store.idle_s() < 5


def test_a_page_that_keeps_polling_holds_a_piece_up_only_so_long(monkeypatch):
    from app import prebuild
    from app.vehicle import tyre_store

    ran = []
    monkeypatch.setitem(prebuild.RUN, "test", lambda name: ran.append((name, time.monotonic())))
    monkeypatch.setattr(prebuild, "QUIET_S", {prebuild.UPLOAD: 3.0, prebuild.START: 20.0})
    monkeypatch.setattr(prebuild, "MAX_WAIT_S", {prebuild.UPLOAD: 0.5, prebuild.START: 1.0})
    stop = threading.Event()

    def polling_page():  # a request every 0.1 s, so a quiet moment never comes
        while not stop.is_set():
            tyre_store._traffic["last"] = time.monotonic()
            time.sleep(0.1)
    poller = threading.Thread(target=polling_page)
    poller.start()
    try:
        t0 = time.monotonic()
        prebuild._put(prebuild.UPLOAD, [("test", ("upload",))])
        prebuild._put(prebuild.START, [("test", ("start",))])
        assert prebuild.wait_idle(10)  # both ran, each after its longest wait
    finally:
        stop.set()
        poller.join()
    assert [name for name, _ in ran] == ["upload", "start"]
    assert 0.5 <= ran[0][1] - t0 < 3 and ran[1][1] - ran[0][1] >= 1.0


def test_a_kept_answer_has_no_nan():
    from app import page_cache

    x = {"a": float("nan"), "b": np.array([1.0, np.inf]), "c": [np.float64("nan"), (2, -np.inf)], "d": "NaN"}
    back = json.loads(zlib.decompress(page_cache._pack(x)))
    assert back == {"a": None, "b": [1.0, None], "c": [None, [2, None]], "d": "NaN"}
    assert page_cache.plain(x) == back
    json.dumps(back, allow_nan=False)  # as the API answers
