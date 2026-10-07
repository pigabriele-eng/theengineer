"""Deleting an event with its runs and logs (app/event_delete.py): two tests imported, one deleted with everything in
it; no row of any table still refers to its runs, logs or the event, its stored files are gone, and the other test is
untouched. Without runs=delete only the folder goes."""
import json
import time

import httpx
import pytest
from sqlalchemy import JSON, select

from tests.test_deploy import FakeSupabaseStorage
from tests.test_imports import log_bytes, make_zip, upload

ROOTS = ("events", "run_sessions", "logger_files")


def _wait_report(client, event_id, timeout=120):
    t0 = time.monotonic()
    while time.monotonic() - t0 < timeout:
        body = client.get(f"/reports/events/{event_id}").json()
        if body["status"] not in ("queued", "running"):
            assert body["status"] == "ready", body
            return body
        time.sleep(0.2)
    raise AssertionError("report still working")


def _import(client, name: str) -> dict:
    job = upload(client, (f"{name}.zip", make_zip({f"{name}/01_D1S1/a.ld": log_bytes(),
                                                  f"{name}/02_D1S2/b.ld": log_bytes()})))
    assert job["status"] == "done" and len(job["session_ids"]) == 2, job
    (ev,) = [f for f in client.get("/events/folders").json() if f["name"] == name]
    _wait_report(client, ev["id"])
    return {"event": ev["id"], "sessions": job["session_ids"], "job": job["id"]}


def _ids(db, test: dict) -> dict[str, set[int]]:
    from app import models

    files = set(db.scalars(select(models.LoggerFile.id).where(models.LoggerFile.session_id.in_(test["sessions"]))))
    return {"events": {test["event"]}, "run_sessions": set(test["sessions"]), "logger_files": files}


def _named(value, gone: dict[str, set[int]], key: str = "") -> bool:
    """Whether a JSON value names one of the ids: under a key ending in event_id, session_id or file_id, in a
    session_ids list, or as a key of a "sessions" mapping."""
    words = {"event_id": "events", "session_id": "run_sessions", "file_id": "logger_files"}
    if key == "session_ids" and isinstance(value, list):
        return any(v in gone["run_sessions"] for v in value if isinstance(v, int))
    if isinstance(value, dict):
        if key == "sessions" and any(k.isdigit() and int(k) in gone["run_sessions"] for k in value):
            return True
        for k, v in value.items():
            table = next((t for w, t in words.items() if k.endswith(w)), None)
            if table and isinstance(v, int) and not isinstance(v, bool) and v in gone[table]:
                return True
            if _named(v, gone, k):
                return True
    if isinstance(value, list):
        return any(_named(v, gone, key) for v in value)
    return False


def references(db, gone: dict[str, set[int]]) -> list[str]:
    """Every column of every table that still refers to the ids: by a foreign key, by a column named like one
    (..._id), by a cache scope ("event:3", "session:12|...") or inside a JSON value."""
    from app import db as app_db

    found = []
    for t in app_db.Base.metadata.sorted_tables:
        for c in t.columns:
            if c.primary_key:
                continue
            targets = {fk.column.table.name for fk in c.foreign_keys}
            if not targets:
                targets = {t_ for w, t_ in (("event_id", "events"), ("session_id", "run_sessions"),
                                            ("file_id", "logger_files")) if c.name.endswith(w)}
            for table in targets & gone.keys():
                if db.scalars(select(c).where(c.in_(gone[table]))).first() is not None:
                    found.append(f"{t.name}.{c.name}")
            if isinstance(c.type, JSON):
                for value in db.scalars(select(c)):
                    if _named(value, gone, c.name):
                        found.append(f"{t.name}.{c.name} (JSON)")
                        break
        if "scope" in t.c:
            for scope in db.scalars(select(t.c.scope)):
                for part in scope.split("|"):
                    kind, _, v = part.partition(":")
                    table = {"event": "events", "session": "run_sessions"}.get(kind)
                    if table and v.isdigit() and int(v) in gone[table]:
                        found.append(f"{t.name}.scope {scope}")
    return found


def _stored(tmp_path) -> dict[str, int]:
    folder = tmp_path / "storage"
    return {p.name: p.stat().st_size for p in folder.iterdir() if p.is_file()} if folder.exists() else {}


def _fill(db, a: dict, b: dict, gone_a: dict) -> dict:
    """Something in every kind of table for test a, and some rows of test b pointing at a's runs or event."""
    from app import models, seasons, storage
    from app.laptags import LapTag
    from app.prep.models import PrepCache
    from app.results.models import EventResultLink
    from app.routers.track_grip import TrackGripCache
    from app.setup.models import SessionSetup, SetupRunSummary

    a1, a2 = a["sessions"]
    b1, _ = b["sessions"]
    fa = min(gone_a["logger_files"])
    fb = db.scalar(select(models.LoggerFile.id).where(models.LoggerFile.session_id == b1))
    db.add_all([LapTag(session_id=a1, file_id=fa, lap=2, tag="sc"),
                LapTag(session_id=b1, file_id=fb, lap=2, tag="fcy")])
    debrief = models.Debrief(session_id=a1, transcript="Understeer in T1", audio_path=storage.save(b"voice", ".m4a"))
    db.add(debrief)
    db.flush()
    db.add(models.DebriefPoint(debrief_id=debrief.id, section="balance", text="Understeer", corner_code="T1"))
    db.add_all([SessionSetup(session_id=a1, template="generic", values={"arb_front": 3}),
                SessionSetup(session_id=b1, template="generic", values={"arb_front": 4}, copied_from_session_id=a1),
                SetupRunSummary(session_id=a2, signature="x", data={"best": 90.1})])
    db.add_all([models.EventDates(event_id=a["event"]), seasons.EventInfo(event_id=a["event"], drivers=[]),
                EventResultLink(event_id=a["event"], series="gt4-europe", year=2026)])
    plan = models.EventPlan(event_id=a["event"], venue="Test Track")
    db.add(plan)
    db.flush()
    season = seasons.Season(name="GT4 2026", year=2026, entry={})
    db.add(season)
    db.flush()
    db.add(seasons.SeasonRound(season_id=season.id, name="Round 1", event_id=a["event"], plan_id=plan.id,
                               made_event=True))
    from datetime import date
    db.add(models.CalendarEntry(uid="cal-1", title="Test", start=date(2026, 7, 3), end=date(2026, 7, 3),
                                event_id=a["event"], made_event=True, included=True))
    db.add(models.TechniqueCache(scope=f"event:{a['event']}", signature="s", status="done",
                                 details=storage.save(b"technique", ".npz"), result={"laps": []}))
    db.add(models.TechniqueCache(scope=f"session:{a2}", signature="s", status="done", result={"laps": []}))
    db.add_all([PrepCache(scope=f"event:{a['event']}|car:logger:1", signature="s", result={"past": []}),
                # a prep report of b drawing on a as a past event: worked out again
                PrepCache(scope=f"event:{b['event']}|car:logger:1", signature="s",
                          result={"past": [{"event_id": a["event"], "best": {"session_id": a1}}]}),
                TrackGripCache(scope=f"event:{a['event']}|car:logger:1", signature="s", result={"laps": []}),
                TrackGripCache(scope=f"event:{b['event']}|car:logger:1", signature="s", result={"laps": []})])
    # one upload that made runs in both: it keeps b's run
    both = models.ImportJob(filename="both.zip", status="done", session_ids=[a2, b1])
    db.add(both)
    db.flush()
    db.add(models.ImportEvent(job_id=a["job"], event_id=a["event"], archive="a.zip"))
    db.commit()
    return {"both": both.id, "season": season.id}


def test_an_event_goes_with_its_runs_logs_and_all_kept_for_them(client, tmp_path):
    from app import db as app_db, models, seasons
    from app.laptags import LapTag
    from app.prep.models import PrepCache
    from app.setup.models import SessionSetup

    a, b = _import(client, "Monza test"), _import(client, "Spa test")
    with app_db.SessionLocal() as db:
        gone, kept = _ids(db, a), _ids(db, b)
        extra = _fill(db, a, b, gone)
        keys_a = [k for k in db.scalars(select(models.LoggerFile.path).where(
            models.LoggerFile.id.in_(gone["logger_files"])))]
        keys_a += [k for k in db.scalars(select(models.SessionTraces.path).where(
            models.SessionTraces.session_id.in_(gone["run_sessions"]))) if k]
        keys_a += [db.scalar(select(models.Debrief.audio_path))]
        keys_a += [db.scalar(select(models.TechniqueCache.details).where(models.TechniqueCache.details.is_not(None)))]
        laps_a = len(db.scalars(select(models.Lap.id).where(models.Lap.session_id.in_(gone["run_sessions"]))).all())
        # the check below sees them all before
        assert {"run_sessions.event_id", "laps.file_id", "lap_tags.file_id", "debriefs.session_id",
                "session_traces.session_id", "session_setups.copied_from_session_id", "event_info.event_id",
                "event_plans.event_id", "season_rounds.event_id", "calendar_entries.event_id",
                "event_result_links.event_id", "import_events.event_id", "import_jobs.session_ids (JSON)",
                "prep_cache.result (JSON)", f"report_cache.scope event:{a['event']}",
                f"technique_cache.scope session:{a['sessions'][1]}"} <= set(references(db, gone))
    assert len(keys_a) == 2 + 2 + 2  # two logs, their compact lap traces, a recording and a technique check
    before = _stored(tmp_path)
    assert set(keys_a) <= set(before)
    folder_b = client.get(f"/events/{b['event']}").json()

    size = client.get(f"/events/{a['event']}/size").json()
    assert size == {"event_id": a["event"], "name": "Monza test", "runs": 2, "laps": laps_a, "logs": 2,
                    "files": 6, "bytes": sum(before[k] for k in keys_a)}
    assert client.get("/events/999/size").status_code == 404

    r = client.delete(f"/events/{a['event']}", params={"runs": "delete"})
    assert r.status_code == 200, r.text
    out = r.json()
    assert {k: out[k] for k in ("deleted", "runs", "laps", "logs", "files", "bytes")} == {
        "deleted": a["event"], "runs": 2, "laps": laps_a, "logs": 2, "files": 6, "bytes": size["bytes"]}
    assert out["rows"]["run_sessions"] == 2 and out["rows"]["laps"] == laps_a and out["rows"]["debrief_points"] == 1
    assert out["cleared"] == {"season_rounds.event_id": 1, "calendar_entries.event_id": 1,
                              "session_setups.copied_from_session_id": 1}

    with app_db.SessionLocal() as db:
        assert references(db, gone) == []
        # what pointed at a but belongs to something that stays: kept, unlinked
        rnd = db.scalar(select(seasons.SeasonRound))
        assert (rnd.season_id, rnd.event_id, rnd.plan_id, rnd.made_event) == (extra["season"], None, None, False)
        entry = db.scalar(select(models.CalendarEntry))
        assert (entry.event_id, entry.included, entry.made_event) == (None, False, False)  # out of later syncs
        assert db.get(models.ImportJob, a["job"]) is None
        assert db.get(models.ImportJob, extra["both"]).session_ids == [b["sessions"][0]]
        assert db.get(models.ImportJob, b["job"]).session_ids == b["sessions"]
        setup_b = db.scalar(select(SessionSetup))
        assert (setup_b.session_id, setup_b.values, setup_b.copied_from_session_id) == (b["sessions"][0],
                                                                                        {"arb_front": 4}, None)
        prep_b = db.scalar(select(PrepCache))
        assert prep_b.scope.startswith(f"event:{b['event']}|") and prep_b.result is None  # worked out again
        assert [t.session_id for t in db.scalars(select(LapTag))] == [b["sessions"][0]]
        # b is all there
        assert references(db, kept) != []
        assert len(db.scalars(select(models.SessionTraces).where(
            models.SessionTraces.session_id.in_(kept["run_sessions"]))).all()) == 2
    after = _stored(tmp_path)
    assert set(after) == set(before) - set(keys_a)  # a's files gone, every other one kept
    assert client.get(f"/events/{a['event']}").status_code == 404
    assert client.get(f"/sessions/{a['sessions'][0]}").status_code == 404
    assert client.get(f"/events/{b['event']}").json() == folder_b
    assert _wait_report(client, b["event"])["status"] == "ready"
    assert [f["id"] for f in client.get("/events/folders").json()] == [b["event"]]

    # without runs=delete only the folder goes: b's runs and their logs stay, in no event
    r = client.delete(f"/events/{b['event']}")
    assert r.status_code == 200 and sorted(r.json()["sessions_kept"]) == sorted(b["sessions"])
    loose = client.get("/events/none").json()
    assert sorted(s["id"] for d in loose["days"] for s in d["sessions"]) == sorted(b["sessions"])
    assert set(_stored(tmp_path)) == set(after)
    assert client.delete(f"/events/{b['event']}", params={"runs": "delete"}).status_code == 404
    assert client.delete("/events/1", params={"runs": "all"}).status_code == 422


def test_no_full_delete_while_an_upload_is_importing(client):
    from app import db as app_db, models

    ev = client.post("/events/folders", json={"name": "Weekend"}).json()
    with app_db.SessionLocal() as db:
        db.add(models.ImportJob(filename="x.zip", status=models.ImportStatus.running))
        db.commit()
    r = client.delete(f"/events/{ev['id']}", params={"runs": "delete"})
    assert r.status_code == 409 and "still being imported" in r.json()["detail"]
    assert client.get(f"/events/{ev['id']}").status_code == 200


def test_a_planned_event_without_runs_goes_with_its_plan(client):
    r = client.post("/planned-events", json={"name": "Zandvoort", "venue": "Circuit Zandvoort",
                                             "start": "2026-09-19", "end": "2026-09-20"})
    ev = r.json()
    assert client.get(f"/events/{ev['id']}/size").json() == {"event_id": ev["id"], "name": "Zandvoort", "runs": 0,
                                                             "laps": 0, "logs": 0, "files": 0, "bytes": 0}
    out = client.delete(f"/events/{ev['id']}", params={"runs": "delete"}).json()
    assert out["rows"] == {"events": 1, "event_dates": 1, "event_plans": 1}
    assert client.get("/calendar").json()["plans"] == []


def test_what_running_jobs_left_behind_is_swept_up(client, tmp_path):
    from app import db as app_db, event_delete, models, storage
    from app.laptags import LapTag

    a, b = _import(client, "Monza test"), _import(client, "Spa test")
    with app_db.SessionLocal() as db:
        gone, kept = _ids(db, a), _ids(db, b)
    assert client.delete(f"/events/{a['event']}", params={"runs": "delete"}).status_code == 200
    sid = max(gone["run_sessions"])
    with app_db.SessionLocal() as db:
        # a report job that had read a run before it went writes its lap traces afterwards
        key = storage.save(b"traces", ".npz")
        db.add(models.SessionTraces(session_id=sid, signature="x", path=key, laps=3))
        db.add(LapTag(session_id=sid, file_id=min(gone["logger_files"]), lap=1, tag="sc"))
        db.commit()
    # ids in use are left alone (b's, named here too; or a deleted id SQLite gave to a new row)
    assert event_delete.sweep({k: gone[k] | kept[k] for k in gone}) == {"session_traces": 1, "lap_tags": 1}
    assert key not in _stored(tmp_path)
    with app_db.SessionLocal() as db:
        assert references(db, gone) == []
        assert len(db.scalars(select(models.SessionTraces).where(
            models.SessionTraces.session_id.in_(kept["run_sessions"]))).all()) == 2
    assert _wait_report(client, b["event"])["status"] == "ready"
    assert event_delete.sweep(gone) == {}
    event_delete.wait_idle()


class ListingSupabase(FakeSupabaseStorage):
    def handler(self, request: httpx.Request) -> httpx.Response:
        if request.method == "POST" and request.url.path == "/storage/v1/object/list/logs":
            body = json.loads(request.content)
            self.requests.append(("LIST", str(body["offset"])))
            # names within the bucket, as Supabase lists them (the fake keeps them as "logs/<name>")
            names = sorted(self.objects)[body["offset"]:body["offset"] + body["limit"]]
            return httpx.Response(200, json=[{"name": n.removeprefix("logs/"), "id": n,
                                              "metadata": {"size": len(self.objects[n])}} for n in names])
        return super().handler(request)


def test_stored_sizes_come_from_the_bucket_listing(tmp_path, monkeypatch):
    from app import storage

    monkeypatch.setattr(storage, "LIST_PAGE", 2)
    fake = ListingSupabase()
    s = fake.storage(tmp_path / "cache")
    keys = [s.save(b"\x40" * 5000, ".ld"), s.save(b"audio", ".m4a"), s.save(b"x" * 10, ".npz")]
    sizes = s.sizes([*keys, "missing.ld"])
    assert set(sizes) == set(keys)
    assert sizes[keys[0]] == len(fake.objects[f"logs/{keys[0]}.gz"]) < 5000  # as stored: compressed
    assert sizes[keys[1]] == 5
    assert [r for r in fake.requests if r[0] == "LIST"] == [("LIST", "0"), ("LIST", "2")]

    local = storage.LocalStorage(tmp_path / "storage")
    key = local.save(b"abc", ".ld")
    assert local.sizes([key, "missing.ld"]) == {key: 3}


@pytest.mark.parametrize("scope, named", [("event:3", True), ("event:3|car:logger:7", True), ("event:30", False),
                                          ("session:12", True), ("session:4", False), ("driver:3", False)])
def test_cache_scopes_naming_what_goes(scope, named):
    from app import event_delete

    assert event_delete.scope_named(scope, {"events": {3}, "run_sessions": {12}}) is named
