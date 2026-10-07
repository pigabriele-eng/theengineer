"""Deleting chosen runs (app/run_delete.py): only the runs asked for go, with their logs, laps, stored files and
kept pages; the event stays with its other runs, its info and its season links; another event is untouched; the
event's pages are worked out again for the runs it keeps; a run in no event goes the same way."""
from sqlalchemy import select

from tests.test_event_delete import _import, _stored, _wait_report, references


def _files(db, sessions) -> set[int]:
    from app import models

    return set(db.scalars(select(models.LoggerFile.id).where(models.LoggerFile.session_id.in_(sessions))))


def _keys(db, sessions) -> list[str]:
    """Storage keys of the runs' logs and compact lap traces."""
    from app import models

    keys = list(db.scalars(select(models.LoggerFile.path).where(models.LoggerFile.session_id.in_(sessions))))
    keys += [k for k in db.scalars(select(models.SessionTraces.path).where(
        models.SessionTraces.session_id.in_(sessions))) if k]
    return keys


def _scopes() -> set[str]:
    from app import db as app_db
    from app.page_cache import PageCache

    with app_db.SessionLocal() as db:
        return set(db.scalars(select(PageCache.scope)))


def _runs_of(client, key) -> list[int]:
    return sorted(s["id"] for d in client.get(f"/events/{key}").json()["days"] for s in d["sessions"])


def test_chosen_runs_go_and_the_event_keeps_the_others(client, tmp_path, monkeypatch):
    from app import db as app_db, models, prebuild, seasons, storage
    from app.page_cache import PageCache

    queued = []
    monkeypatch.setattr(prebuild, "after_upload", lambda db, ids: queued.append(list(ids)))
    a, b = _import(client, "Monza test"), _import(client, "Spa test")
    gone_id, kept_id = a["sessions"]
    for sid in a["sessions"]:
        assert client.get(f"/sessions/{sid}/analysis").status_code == 200
    assert client.get(f"/events/{a['event']}/shape").status_code == 200
    with app_db.SessionLocal() as db:
        gone = {"events": set(), "run_sessions": {gone_id}, "logger_files": _files(db, [gone_id])}
        keys = _keys(db, [gone_id])
        kept_keys = _keys(db, [kept_id, *b["sessions"]])
        last_keys = _keys(db, [kept_id, b["sessions"][1]])
        debrief = models.Debrief(session_id=gone_id, transcript="Understeer", audio_path=storage.save(b"voice", ".m4a"))
        db.add(debrief)
        db.add(models.TechniqueCache(scope=f"session:{gone_id}", signature="s", status="done",
                                     details=storage.save(b"technique", ".npz"), result={"laps": []}))
        db.add_all([models.EventDates(event_id=a["event"]), seasons.EventInfo(event_id=a["event"], drivers=[])])
        db.commit()
        keys += [debrief.audio_path, db.scalar(select(models.TechniqueCache.details).where(
            models.TechniqueCache.scope == f"session:{gone_id}"))]
        laps = len(db.scalars(select(models.Lap.id).where(models.Lap.session_id == gone_id)).all())
        report_sig = db.scalar(select(models.ReportCache.result_signature).where(
            models.ReportCache.scope == f"event:{a['event']}"))
        shape_sig = db.scalar(select(PageCache.signature).where(PageCache.scope == f"event:{a['event']}|shape"))
        assert f"report_cache.scope event:{a['event']}" not in references(db, gone)
        assert f"page_cache.scope session:{gone_id}|analysis" in references(db, gone)
    assert len(keys) == 4  # its log, its compact lap traces, a recording and a technique check
    before = _stored(tmp_path)
    assert set(keys) | set(kept_keys) <= set(before)
    folder_b = client.get(f"/events/{b['event']}").json()

    size = client.get("/runs/size", params={"ids": str(gone_id)}).json()
    assert size == {"session_ids": [gone_id], "name": "01_D1S1", "runs": 1, "laps": laps, "logs": 1, "files": 4,
                    "bytes": sum(before[k] for k in keys)}
    both = client.get("/runs/size", params={"ids": f"{gone_id},{b['sessions'][0]}"}).json()
    assert (both["runs"], both["logs"], both["files"]) == (2, 2, 6)

    r = client.delete("/runs", params={"ids": str(gone_id)})
    assert r.status_code == 200, r.text
    out = r.json()
    assert {k: out[k] for k in ("deleted", "events", "runs", "laps", "logs", "files", "bytes")} == {
        "deleted": [gone_id], "events": [a["event"]], "runs": 1, "laps": laps, "logs": 1, "files": 4,
        "bytes": size["bytes"]}
    assert out["rows"]["run_sessions"] == 1 and out["rows"]["debriefs"] == 1 and "events" not in out["rows"]
    assert queued == [[kept_id]]  # the event's pages, made again for the run it keeps

    with app_db.SessionLocal() as db:
        assert references(db, gone) == []
        assert db.get(models.Event, a["event"]) is not None
        assert db.scalar(select(seasons.EventInfo).where(seasons.EventInfo.event_id == a["event"])) is not None
        assert db.scalar(select(models.EventDates).where(models.EventDates.event_id == a["event"])) is not None
        assert db.get(models.ImportJob, a["job"]).session_ids == [kept_id]
        report = db.scalar(select(models.ReportCache).where(models.ReportCache.scope == f"event:{a['event']}"))
        assert report.result is None  # it named the run: worked out again
        assert db.scalar(select(models.SessionTraces).where(models.SessionTraces.session_id == kept_id)) is not None
    after = _stored(tmp_path)
    assert set(after) == set(before) - set(keys)  # its files gone, every other one kept
    assert not any(s.startswith(f"session:{gone_id}|") for s in _scopes())
    assert {f"session:{kept_id}|analysis", f"event:{a['event']}|shape"} <= _scopes()
    assert client.get(f"/sessions/{gone_id}").status_code == 404
    assert client.get(f"/sessions/{kept_id}/analysis").status_code == 200
    assert _runs_of(client, a["event"]) == [kept_id]
    assert client.get(f"/events/{b['event']}").json() == folder_b
    # the event's report, made again from the run it keeps
    report = _wait_report(client, a["event"])
    assert [s["id"] for s in report["sessions"]] == [kept_id] and report["report"] is not None
    with app_db.SessionLocal() as db:
        assert db.scalar(select(models.ReportCache.result_signature).where(
            models.ReportCache.scope == f"event:{a['event']}")) not in (None, report_sig)
    # its kept shape no longer matches: made again from the run it keeps
    assert client.get(f"/events/{a['event']}/shape").status_code == 200
    with app_db.SessionLocal() as db:
        assert db.scalar(select(PageCache.signature).where(PageCache.scope == f"event:{a['event']}|shape")) \
            not in (None, shape_sig)

    # a run in no event goes the same way; nothing to make again for an event
    assert client.post("/events/none/sessions", json={"session_ids": [b["sessions"][0]]}).status_code == 200
    queued.clear()
    out = client.delete("/runs", params={"ids": str(b["sessions"][0])}).json()
    assert (out["runs"], out["events"], queued) == (1, [], [])
    assert _runs_of(client, "none") == [] and _runs_of(client, b["event"]) == [b["sessions"][1]]
    assert set(last_keys) <= set(_stored(tmp_path))  # every log and trace of the runs kept is still there


def test_runs_asked_for_must_exist(client):
    a = _import(client, "Monza test")
    assert client.get("/runs/size", params={"ids": "999"}).status_code == 404
    assert client.delete("/runs", params={"ids": f"{a['sessions'][0]},999"}).status_code == 404
    for bad in ("", "x", "1,,y", "-3"):
        assert client.delete("/runs", params={"ids": bad}).status_code == 422, bad
    assert client.delete("/runs").status_code == 422
    assert _runs_of(client, a["event"]) == sorted(a["sessions"])  # nothing went
