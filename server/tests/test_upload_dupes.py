"""A weekend uploaded again: the logs already in the app are left out before they are read, the new ones join the
event the others are in (app/upload_dupes.py)."""
from functools import cache

from tests.test_imports import make_zip, upload


@cache
def log(paces=(0.9, 1.0, 0.97, 0.99)) -> bytes:
    from tests.synthetic import simulate, write_ld

    return write_ld(simulate(paces)[0])


def test_a_weekend_uploaded_again_adds_only_the_missing_runs(client, monkeypatch):
    monkeypatch.setenv("UPLOAD_DUPES", "on")
    first = upload(client, ("Spa.zip", make_zip({"Spa/01_FP1/a.ld": log()})))
    assert first["status"] == "done" and len(first["session_ids"]) == 1
    (event,) = client.get("/events").json()

    again = upload(client, ("Spa.zip", make_zip({"Spa/01_FP1/a.ld": log(),
                                                 "Spa/02_FP2/b.ld": log((0.95, 1.0, 0.98))})))
    assert again["status"] == "done", again
    assert again["already_uploaded"] == 1 and (again["total"], again["done"]) == (2, 2)
    assert again["skipped"] == [{"file": "Spa.zip/Spa/01_FP1/a.ld", "already": True, "reason": "Already uploaded",
                                 "session_id": first["session_ids"][0]}]
    (new,) = again["session_ids"]
    assert len(client.get("/events").json()) == 1  # no second event of the zip's name
    assert client.get(f"/sessions/{new}").json()["event_id"] == event["id"]


def test_logs_stored_before_their_bytes_were_kept_are_known_by_their_header(client, monkeypatch):
    from app import upload_dupes
    from app.db import SessionLocal

    monkeypatch.setenv("UPLOAD_DUPES", "on")
    first = upload(client, ("Monza.zip", make_zip({"Monza/a.ld": log()})))
    with SessionLocal() as db:
        db.query(upload_dupes.LogPrint).delete()
        db.commit()
    again = upload(client, ("Monza.zip", make_zip({"Monza/a.ld": log()})))
    assert again["already_uploaded"] == 1 and again["session_ids"] == []
    assert again["skipped"][0]["session_id"] == first["session_ids"][0]


def test_the_same_log_twice_in_one_upload_is_imported_once(client, monkeypatch):
    monkeypatch.setenv("UPLOAD_DUPES", "on")
    job = upload(client, ("T.zip", make_zip({"T/1/a.ld": log(), "T/2/a copy.ld": log()})))
    assert len(job["session_ids"]) == 1 and job["already_uploaded"] == 1
    assert job["skipped"][0]["reason"] == "Twice in this upload"


def test_a_different_log_is_imported(client, monkeypatch):
    monkeypatch.setenv("UPLOAD_DUPES", "on")
    upload(client, ("A.zip", make_zip({"A/a.ld": log()})))
    job = upload(client, ("B.zip", make_zip({"B/b.ld": log((0.95, 1.0, 0.98))})))
    assert len(job["session_ids"]) == 1 and job["already_uploaded"] == 0


def test_header_key_reads_what_the_import_stores():
    from app import upload_dupes
    from app.importers.motec import read_ld

    raw = log()
    ld = read_ld(raw)
    assert upload_dupes.header_key(raw[:upload_dupes.HEAD_BYTES]) == (ld.device_serial, ld.date, ld.time,
                                                                       round(ld.duration, 1))
    assert upload_dupes.header_key(b"not a log") is None
