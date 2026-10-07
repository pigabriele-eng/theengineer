"""The same run uploaded twice in one event is kept once (app/run_dupes.py): what was set by hand on either stays."""
import time

from sqlalchemy import select

from tests.test_events import _session


def test_a_run_uploaded_twice_is_kept_once(client, monkeypatch):
    from app import db as app_db
    from app import models, run_dupes

    monkeypatch.setenv("RUN_DUPES", "on")
    client.post("/tracks", json={"name": "Test Track"})
    ev = client.post("/events/folders", json={"name": "Round 5"}).json()
    first = _session(client, ev["id"], "03_Q", (0.97, 0.98), "19/09/2026", "11:16:00")
    copy = _session(client, ev["id"], "03_Q (2)", (0.97, 0.98), "19/09/2026", "11:16:00")
    later = _session(client, ev["id"], "03_Q (3)", (0.97, 0.98), "19/09/2026", "11:40:00")  # another time: kept
    other = _session(client, ev["id"], "03_Q (4)", (0.97, 0.99), "19/09/2026", "11:16:00")  # other laps: kept
    client.patch(f"/sessions/{copy}", json={"name": "Quali Gabriele"})
    with app_db.SessionLocal() as db:
        db.add(models.Debrief(session_id=first, transcript="Understeer in T1"))
        db.commit()
        assert run_dupes.merge_event(db, ev["id"]) == [first]  # the copy has the name typed by hand: it stays
        assert run_dupes.merge_event(db, ev["id"]) == []
        assert db.scalar(select(models.Debrief.session_id)) == copy
    left = {s["id"]: s["name"] for d in client.get(f"/events/{ev['id']}").json()["days"] for s in d["sessions"]}
    assert left == {copy: "Quali Gabriele", later: "03_Q (3)", other: "03_Q (4)"}


def test_an_upload_with_the_same_log_twice_keeps_one_run(client, monkeypatch):
    from tests.test_empty_runs import lapped_log, make_zip, upload

    monkeypatch.setenv("RUN_DUPES", "on")
    job = upload(client, ("T01.zip", make_zip({"T01/01_D1S1/run.ld": lapped_log(),
                                                 "T01/01_D1S1 copy/run.ld": lapped_log()})))
    for _ in range(100):  # the copy goes once the import is done
        if len(job["session_ids"]) == 1:
            break
        time.sleep(0.1)
        job = client.get(f"/imports/{job['id']}").json()
    assert job["status"] == "done" and len(job["session_ids"]) == 1
    assert client.get(f"/sessions/{job['session_ids'][0]}").status_code == 200  # the older of the two
