"""Runs with no laps: a pit-lane log isn't kept, a lapped log with no lap beacon is kept and flagged, and the
runs already on the server are cleared once without touching what the user entered. Synthetic logs only."""
import json
from functools import cache

import httpx
import numpy as np

from app.analysis import emptyrun
from app.analysis.laps import load_session
from app.importers.motec import read_ld
from tests.synthetic import ORIGIN, simulate, write_ld
from tests.test_deploy import FakeSupabaseStorage
from tests.test_imports import make_zip, upload


def pit_channels(seconds: float = 52.0, top: float = 12.0) -> dict:
    """The dash recording in the pit lane: rolled to the box and stopped, GPS still, no line crossed."""
    t = np.arange(0, seconds, 0.01)
    v = top * np.clip(np.sin(np.pi * t / seconds), 0, None)
    t20 = np.arange(0, seconds, 0.05)
    lat = ORIGIN[0] + 0.0008 + 0.00002 * np.sin(t20 / 7)
    lon = ORIGIN[1] - 0.0002 + 0.00002 * np.cos(t20 / 5)
    return {"GPS Latitude": (20, "deg", lat), "GPS Longitude": (20, "deg", lon), "vCar": (100, "km/h", v),
            "S/F Marker": (10, "", np.zeros(int(seconds * 10))), "Lap Time": (1, "s", np.zeros(int(seconds)))}


@cache
def pit_log() -> bytes:
    return write_ld(pit_channels())


@cache
def lapped_log() -> bytes:
    return write_ld(simulate()[0])


@cache
def unmarked_log() -> bytes:
    """Six laps of the GPS circle (out-lap, four laps, in-lap) with no start/finish marker or lap time."""
    return write_ld({k: v for k, v in simulate()[0].items() if k not in ("S/F Marker", "Lap Time")})


@cache
def counter_log() -> bytes:
    """Laps timed only by the dash's 1 Hz lap counter: it teaches the track no start/finish line."""
    channels, times = simulate()
    t1 = np.arange(len(channels["Lap Time"][2]), dtype=float)
    number = np.searchsorted(np.cumsum(times)[:-1], t1, side="right").astype(float)
    return write_ld({**{k: v for k, v in channels.items() if k != "S/F Marker"}, "Lap Number": (1, "", number)})


def stored_files(tmp_path, suffix: str = "") -> list[str]:
    return sorted(p.name for p in (tmp_path / "storage").glob(f"*{suffix}") if p.is_file())


def judge(raw: bytes, tmp_path, length: float | None = None) -> emptyrun.Verdict:
    p = tmp_path / f"log{len(list(tmp_path.glob('log*')))}.ld"
    p.write_bytes(raw)
    ld = read_ld(p)
    data = load_session(ld)
    assert data.laps == []
    return emptyrun.judge(ld, data, None, None, length)


# ---------- the verdict, from the data ----------

def test_the_verdict_reads_the_log(tmp_path):
    assert judge(pit_log(), tmp_path).reason == "no laps: 52 s in the pit lane"
    standing = write_ld(pit_channels(23.0, 0.0))
    assert judge(standing, tmp_path).reason == "no laps: 23 s standing still"

    # an out-lap and an in-lap: the marker saw the car cross the line once, the GPS track closes only once
    out_in = judge(write_ld(simulate(paces=())[0]), tmp_path)
    assert not out_in.keep and out_in.reason.startswith("no laps: out-lap and in-lap only (2.0 km")

    # laps with nothing to time them: the GPS passes the same points six times, a lap apart
    untimed = judge(unmarked_log(), tmp_path)
    assert untimed.keep and untimed.gps and 4 <= untimed.laps <= 5  # its out- and in-lap are whole circles
    assert untimed.note()["title"] == "Laps not timed: the lap beacon is missing"
    assert untimed.reason.startswith("The car did about") and "line isn't known yet" in untimed.reason
    assert ".ldx" in untimed.fix and "timed from its GPS by itself" in untimed.fix

    # a marker pulse with the car standing is the dash starting up, not a crossing; one at speed is a crossing
    channels, times = simulate(stops={0: 5.0})
    channels = {k: v for k, v in channels.items() if k != "Lap Time"}
    for at, keep in ((times[0] - 2.5, True), (times[0] + 20.0, False)):
        marker = np.zeros_like(channels["S/F Marker"][2])
        marker[round(at * 10)] = 1.0
        assert judge(write_ld({**channels, "S/F Marker": (10, "", marker)}), tmp_path).keep is keep

    # no GPS either: the distance at racing speed against the track's length; without a length only a long run
    blind = write_ld({k: v for k, v in simulate()[0].items()
                      if k not in ("S/F Marker", "Lap Time", "GPS Latitude", "GPS Longitude")})
    by_length = judge(blind, tmp_path, length=1000.0)
    assert by_length.keep and not by_length.gps and by_length.laps >= 1 and "no GPS" in by_length.reason
    assert "by itself" not in by_length.fix
    assert not judge(blind, tmp_path).keep


# ---------- at import and upload ----------

def test_a_pit_lane_log_is_left_out_of_an_import(client, tmp_path):
    z = make_zip({"T01/01_D1S1/run.ld": lapped_log(), "T01/02_D1S2/pit.ld": pit_log(),
                  "T01/02_D1S2/run.ld": lapped_log()})
    job = upload(client, ("T01.zip", z))
    assert job["status"] == "done" and (job["total"], job["done"]) == (3, 3) and job["errors"] == []
    assert job["skipped"] == [{"file": "T01.zip/T01/02_D1S2/pit.ld", "reason": "no laps: 52 s in the pit lane"}]
    assert job["untimed"] == []
    names = sorted(client.get(f"/sessions/{i}").json()["name"] for i in job["session_ids"])
    assert names == ["01_D1S1", "02_D1S2"]  # the run in the pit log's folder takes the folder's name
    assert len(client.get("/sessions").json()) == 2
    assert len(stored_files(tmp_path, ".ld")) == 2  # the pit log was never stored


def test_the_upload_refuses_a_pit_lane_log_and_keeps_the_session(client, tmp_path):
    s = client.post("/sessions", json={"name": "My run", "kind": "practice"}).json()
    r = client.post(f"/sessions/{s['id']}/files", files={"file": ("pit.ld", pit_log())})
    assert r.status_code == 422
    assert r.json()["detail"] == "pit.ld wasn't added (no laps: 52 s in the pit lane)."
    kept = client.get(f"/sessions/{s['id']}").json()
    assert kept["name"] == "My run" and kept["files"] == [] and stored_files(tmp_path, ".ld") == []
    r = client.post(f"/sessions/{s['id']}/files", files={"file": ("run.ld", lapped_log())})
    assert r.status_code == 201 and len(r.json()["laps"]) == 4


def test_a_lapped_log_without_beacon_or_marker_is_kept_flagged_and_timed_later(client):
    import app.timing

    job = upload(client, ("day1.zip", make_zip({"day1/01_untimed/run.ld": unmarked_log()})))
    (sid,) = job["session_ids"]
    assert job["skipped"] == []
    (note,) = job["untimed"]
    assert note["session_id"] == sid and note["name"] == "01_untimed" and note["file"] == "run.ld"
    assert "lap beacon is missing" in note["title"] and note["laps"] >= 4 and ".ldx" in note["fix"]
    s = client.get(f"/sessions/{sid}").json()
    assert s["laps"] == [] and s["files"][0]["meta"]["untimed"]["reason"] == note["reason"]

    # a log with the dash's marker teaches the track its line; the kept log is then timed from its GPS
    upload(client, ("day2.zip", make_zip({"day2/01_marked/run.ld": lapped_log()})))
    app.timing.wait_idle()
    s = client.get(f"/sessions/{sid}").json()
    assert len(s["laps"]) >= 4 and s["files"][0]["meta"]["lap_source"] == "gps"
    assert "untimed" not in s["files"][0]["meta"]
    assert client.get(f"/imports/{job['id']}").json()["untimed"] == []


def test_an_ldx_with_beacons_times_a_kept_log(client):
    from tests.test_imports import ldx_bytes

    s = client.post("/sessions", json={}).json()
    r = client.post(f"/sessions/{s['id']}/files", files={"file": ("run.ld", unmarked_log())})
    assert r.status_code == 201 and r.json()["laps"] == [] and "untimed" in r.json()["files"][0]["meta"]
    r = client.post(f"/sessions/{s['id']}/files", files={"file": ("run.ldx", ldx_bytes())})
    assert len(r.json()["laps"]) == 4 and "untimed" not in r.json()["files"][0]["meta"]


# ---------- the runs already on the server ----------

def _old_import(client, monkeypatch, entries: dict[str, bytes]) -> dict[str, int]:
    """Sessions as an import made them before empty runs were left out: kept, with no laps and no mark."""
    import app.db
    import app.models
    import app.routers.reports
    import app.routers.sessions
    import app.timing

    import app.routers.imports

    with monkeypatch.context() as m:
        m.setattr(app.routers.sessions, "judge", lambda *a: emptyrun.Verdict(True, "kept"))
        job = upload(client, ("T01.zip", make_zip(entries)))
    app.routers.imports._jobs.join()  # the import asks for its reports just after it shows done
    app.timing.wait_idle()
    app.routers.reports.wait_idle()
    with app.db.SessionLocal() as db:
        for f in db.query(app.models.LoggerFile).all():
            f.meta = {k: v for k, v in f.meta.items() if k != "untimed"}
        db.commit()
    return {client.get(f"/sessions/{i}").json()["name"]: i for i in job["session_ids"]}


def test_the_startup_check_removes_empty_runs_but_never_what_the_user_entered(client, monkeypatch, tmp_path):
    import app.db
    import app.empty_runs
    import app.models
    import app.routers.sessions
    import app.routers.trackmap
    from app import storage
    from app.setup.models import SetupRunSummary

    app.empty_runs.wait_idle()  # the check the server ran on startup, on the empty database
    ids = _old_import(client, monkeypatch, {
        "T01/a_debrief/pit.ld": pit_log(), "T01/b_setup/pit.ld": pit_log(), "T01/c_driver/pit.ld": pit_log(),
        "T01/d_empty/pit.ld": pit_log(), "T01/e_cached/pit.ld": pit_log(), "T01/f_untimed/run.ld": unmarked_log(),
        "T01/g_lapped/run.ld": counter_log()})
    assert client.get(f"/sessions/{ids['g_lapped']}").json()["laps"]
    by_hand = client.post("/sessions", json={"name": "Typed in"}).json()["id"]
    with monkeypatch.context() as m:
        m.setattr(app.routers.sessions, "judge", lambda *a: emptyrun.Verdict(True, "kept"))
        assert client.post(f"/sessions/{by_hand}/files", files={"file": ("pit.ld", pit_log())}).status_code == 201

    assert client.post(f"/sessions/{ids['a_debrief']}/debriefs", json={"transcript": "Understeer in T6"}
                       ).status_code == 201
    assert client.put(f"/sessions/{ids['b_setup']}/setup", json={"notes": "soft rear bar"}).status_code == 200
    assert client.put(f"/sessions/{ids['c_driver']}/driver", json={"driver_name": "Gabriele"}).status_code == 200

    # everything a removed session leaves in the caches
    e = ids["e_cached"]
    event_id = client.get(f"/sessions/{e}").json()["event_id"]
    traces, details = storage.save(b"traces", ".npz"), storage.save(b"details", ".npz")
    with app.db.SessionLocal() as db:
        (f,) = db.get(app.models.RunSession, e).files
        for model, result in ((app.models.ReportCache, {"runs": [{"run": "e_cached", "session_id": e}]}),
                              (app.models.TechniqueCache, {"habits": {"sessions": {str(ids["g_lapped"]): []}}})):
            row = db.query(model).filter_by(scope=f"event:{event_id}").one_or_none() or model(scope=f"event:{event_id}")
            row.signature = row.result_signature = "y"
            row.status, row.result = "done", result
            db.add(row)
        db.add_all([
            app.models.SessionTraces(session_id=e, signature="x", path=traces),
            app.models.ReportCache(scope=f"session:{e}", signature="x", status="done", result={"x": 1}),
            app.models.TechniqueCache(scope=f"session:{e}", signature="x", status="done", details=details),
            app.models.TyreData(file_id=f.id, session_id=e, version="v", status="none", car_key="k", car_label="k",
                                preset="bmw-m4-gt4-evo", tyre="Pirelli P Zero DHG"),
            SetupRunSummary(session_id=e, signature="s", data={}),
        ])
        db.commit()
        file_id = f.id
    app.routers.trackmap._cache[(file_id, "path")] = {"map": 1}
    before = set(stored_files(tmp_path))

    result = app.empty_runs.cleanup()
    assert result == {"removed": [ids["d_empty"], e], "kept": [ids["f_untimed"]]}
    left = {s["id"] for s in client.get("/sessions").json()}
    assert left == {ids["a_debrief"], ids["b_setup"], ids["c_driver"], ids["f_untimed"], ids["g_lapped"], by_hand}
    untimed = client.get(f"/sessions/{ids['f_untimed']}").json()["files"][0]["meta"]["untimed"]
    assert "lap beacon is missing" in untimed["title"] and "no start/finish marker" in untimed["reason"]

    gone = before - set(stored_files(tmp_path))
    assert len(gone) == 4 and traces in gone and details in gone  # two logs, the traces and the lap checks
    with app.db.SessionLocal() as db:
        assert db.query(app.models.LoggerFile).filter_by(session_id=e).count() == 0
        assert db.query(app.models.Lap).filter_by(session_id=e).count() == 0
        assert db.query(app.models.SessionTraces).filter_by(session_id=e).count() == 0
        assert db.query(app.models.TyreData).filter_by(session_id=e).count() == 0
        assert db.query(SetupRunSummary).filter_by(session_id=e).count() == 0
        assert db.query(app.models.ReportCache).filter_by(scope=f"session:{e}").count() == 0
        assert db.query(app.models.TechniqueCache).filter_by(scope=f"session:{e}").count() == 0
        event_report = db.query(app.models.ReportCache).filter_by(scope=f"event:{event_id}").one()
        assert event_report.result is None and event_report.result_signature is None  # worked out again
        event_check = db.query(app.models.TechniqueCache).filter_by(scope=f"event:{event_id}").one()
        assert event_check.result is not None  # it never had the removed session in it
    assert (file_id, "path") not in app.routers.trackmap._cache
    names = {s["name"] for s in client.get(f"/reports/events/{event_id}").json()["sessions"]}
    assert names == {"a_debrief", "b_setup", "c_driver", "f_untimed", "g_lapped"}

    assert app.empty_runs.cleanup() == {"removed": [], "kept": []}  # once: nothing is read again


def test_a_run_whose_log_is_gone_from_storage_is_left_alone(client, monkeypatch, tmp_path):
    import app.empty_runs

    app.empty_runs.wait_idle()
    ids = _old_import(client, monkeypatch, {"T01/a/pit.ld": pit_log()})
    for p in (tmp_path / "storage").glob("*.ld"):
        p.unlink()
    assert app.empty_runs.cleanup() == {"removed": [], "kept": []}
    assert client.get(f"/sessions/{ids['a']}").status_code == 200


# ---------- deleting stored files ----------

class DeletingSupabase(FakeSupabaseStorage):
    def handler(self, request: httpx.Request) -> httpx.Response:
        if request.method == "DELETE":
            name = request.url.path.removeprefix("/storage/v1/object/")
            self.requests.append(("DELETE", name))
            if self.objects.pop(name, None) is None:
                return httpx.Response(400, json={"statusCode": "404", "error": "not_found",
                                                 "message": "Object not found"})
            return httpx.Response(200, content=json.dumps({"message": "Successfully deleted"}))
        return super().handler(request)


def test_stored_files_are_deleted(tmp_path):
    from app import storage

    fake = DeletingSupabase()
    s = fake.storage(tmp_path / "cache")
    key = s.save(b"\x40\x00\x00\x00 a log", ".ld")
    assert s.local_path(key).exists()
    s.delete(key)
    assert fake.objects == {} and not (tmp_path / "cache" / key).exists()
    s.delete(key)  # already gone: nothing to do

    local = storage.LocalStorage(tmp_path / "storage")
    key = local.save(b"x", ".ld")
    outside = tmp_path / "outside.ld"
    outside.write_bytes(b"keep")
    local.delete(key)
    local.delete(str(outside))  # never outside the storage folder
    assert not (tmp_path / "storage" / key).exists() and outside.exists()


def test_what_the_app_filled_in_itself_keeps_no_empty_run(client, monkeypatch):
    """A car from the logger's serial or the season, a driver from the driving style, a kind from the timetable:
    none was put there by a person, so an empty run that has them still goes; a name typed for it keeps it."""
    import app.db
    import app.empty_runs
    import app.models
    from app.driver_prints import StyleTag
    from app.results.models import RunNameMark

    app.empty_runs.wait_idle()
    ids = _old_import(client, monkeypatch, {"T01/a_car/pit.ld": pit_log(), "T01/b_named/pit.ld": pit_log()})
    with app.db.SessionLocal() as db:
        car = app.models.Car(name="BMW M4 GT4 #12")
        driver = app.models.Driver(name="Gabriele Piana")
        db.add_all([car, driver])
        db.flush()
        a = db.get(app.models.RunSession, ids["a_car"])
        a.car_id, a.driver_id, a.kind = car.id, driver.id, app.models.SessionKind.practice
        db.add_all([StyleTag(session_id=a.id, event_id=a.event_id, driver_id=driver.id, source="fingerprint"),
                    RunNameMark(session_id=a.id, code="FP1", auto_name="FP1 stint 1"),
                    RunNameMark(session_id=ids["b_named"], by_hand=True)])
        db.commit()
    assert app.empty_runs.cleanup() == {"removed": [ids["a_car"]], "kept": []}
    assert client.get(f"/sessions/{ids['b_named']}").status_code == 200


def test_a_run_with_no_lap_to_use_goes_after_the_upload_and_at_startup(client, tmp_path):
    # Gabriele, 2026-10-08: "R1 has two stints, please automatically delete no laps runs"
    import app.db
    import app.empty_runs
    import app.models
    import app.routers.imports

    app.empty_runs.wait_idle()  # the check the server ran on startup, on the empty database
    in_lap = write_ld(simulate((1.0,), stops={1: 40.0})[0])  # one lap, through the pits: not clean
    job = upload(client, ("R1.zip", make_zip({
        "R1/01_R1/run.ld": lapped_log(), "R1/02_R1/run.ld": in_lap,
        "R1/03_R1/run.ld": write_ld(simulate((0.95, 1.0, 0.97))[0]),
        "R1/04_R1/run.ld": write_ld(simulate((0.9, 0.95, 1.0, 0.98))[0])})))
    app.routers.imports._jobs.join()  # what an import does once it shows done: duplicates, runs with no lap to use
    job = client.get(f"/imports/{job['id']}").json()
    assert job["status"] == "done" and len(job["session_ids"]) == 3
    assert job["skipped"] == [{"file": "02_R1/run.ld", "reason": "No lap to use: only an out-lap and an in-lap"}]
    assert sorted(client.get(f"/sessions/{i}").json()["name"] for i in job["session_ids"]) == \
        ["01_R1", "03_R1", "04_R1"]
    assert len(stored_files(tmp_path, ".ld")) == 3

    # runs already on the server left with a lap or two, none clean: they go, unless a person put something on them
    a, b, c = job["session_ids"]
    with app.db.SessionLocal() as db:
        for sid in (a, b, c):
            laps = db.query(app.models.Lap).filter_by(session_id=sid).order_by(app.models.Lap.number).all()
            for lap in laps[2:]:
                db.delete(lap)
            for lap in laps[:2]:
                lap.clean = False
        db.commit()
    assert client.post(f"/sessions/{a}/debriefs", json={"transcript": "Box this lap"}).status_code == 201
    assert client.put(f"/sessions/{b}/driver", json={"driver_name": "Gabriele"}).status_code == 200
    assert app.empty_runs.cleanup() == {"removed": [c], "kept": []}
    assert {s["id"] for s in client.get("/sessions").json()} == {a, b}
    assert len(stored_files(tmp_path, ".ld")) == 2



def test_the_lap_to_grid_goes_and_a_practice_run_stays(client):
    # Gabriele, 2026-10-08: "You can delete the "lap to grid" which is normally the first run from pits to grid"
    import app.empty_runs
    import app.routers.imports

    app.empty_runs.wait_idle()
    job = upload(client, ("Round.zip", make_zip({
        "Round/01_FP1/a.ld": write_ld(simulate((0.85,))[0]), "Round/01_FP1/b.ld": write_ld(simulate((0.92, 0.99))[0]),
        "Round/04_R1/a.ld": write_ld(simulate((0.8,))[0]),  # from the pits to the grid: one slow lap
        "Round/04_R1/b.ld": lapped_log(), "Round/04_R1/c.ld": write_ld(simulate((0.95, 1.0, 0.97))[0])})))
    app.routers.imports._jobs.join()
    job = client.get(f"/imports/{job['id']}").json()
    assert job["skipped"] == [{"file": "04_R1/a.ld",
                               "reason": "The lap to grid: from the pits to the grid before the race"}]
    names = sorted(client.get(f"/sessions/{i}").json()["name"] for i in job["session_ids"])
    assert len(names) == 4 and sum(n.startswith("01_FP1") for n in names) == 2
    assert app.empty_runs.cleanup() == {"removed": [], "kept": []}  # the race's first run now is its first stint
