"""Everything uploaded, in one download (Gabriele, 2026-10-22: "create a link for me to download ALL data i uploaded
to The Engineer to date")."""
import io
import json
import shutil
import zipfile

import httpx

from app import storage
from app.storage import TwoStorages
from tests.test_b2_storage import FakeB2
from tests.test_deploy import FakeSupabaseStorage
from tests.test_imports import make_zip, upload
from tests.test_vbox import write_vbo


def test_stored_files_are_read_through_without_a_cached_copy(tmp_path):
    old_fake, new_fake = FakeSupabaseStorage(), FakeB2()
    old = old_fake.storage(tmp_path / "cache")
    kept = old.save(b"\x40 an older log" * 1000, ".ld")
    both = TwoStorages(new_fake.storage(tmp_path / "cache"), old)
    assert both.copy_over()["copied"] == 1
    only_b2 = both.save(b"\x40 a new log", ".ld")
    shutil.rmtree(tmp_path / "cache")
    with both.open_chunks(only_b2) as chunks:
        assert b"".join(chunks) == b"\x40 a new log"
    assert not (tmp_path / "cache").exists()

    def capped(request):
        if request.method == "GET" and request.url.path.endswith(".gz"):
            return httpx.Response(403, content=b"<Error><Code>download_cap_exceeded</Code></Error>")
        return new_fake.handler(request)

    both.new.client = httpx.Client(transport=httpx.MockTransport(capped))
    with both.open_chunks(kept) as chunks:  # Supabase's copy, while B2 refuses
        assert b"".join(chunks) == b"\x40 an older log" * 1000
    try:
        with both.open_chunks(only_b2):
            raise AssertionError("B2 refused it and Supabase hasn't it")
    except storage.StorageError as e:
        assert "download_cap_exceeded" in str(e)


def test_everything_comes_in_one_zip(client, settle):
    raw, _ = write_vbo()
    job = upload(client, ("Coaching day.zip", make_zip({"Coaching day/VBOX0001.vbo": raw,
                                                         "Coaching day/VBOX0002.vbo": raw})))
    assert job["status"] == "done", job
    sid = job["session_ids"][0]
    assert client.patch(f"/sessions/{sid}", json={"name": "Customer A"}).status_code == 200
    r = client.get("/export/everything.zip")
    assert r.status_code == 200 and r.headers["content-type"] == "application/zip"
    assert "The Engineer - everything" in r.headers["content-disposition"]
    z = zipfile.ZipFile(io.BytesIO(r.content))
    names = z.namelist()
    logs = [n for n in names if n.endswith(".vbo")]
    assert len(logs) == 2 and "The Engineer/README.txt" in names and "The Engineer/MISSING.txt" not in names
    assert all(z.read(n) == raw for n in logs)  # as uploaded
    manifest = json.loads(z.read("The Engineer/the-engineer.json"))
    (event,) = manifest["events"]
    mine = next(s for s in event["sessions"] if s["id"] == sid)
    assert mine["name"] == "Customer A" and mine["laps"]
    assert mine["files"][0]["file"] in logs and "/Customer A (" in mine["files"][0]["file"]

    listed = client.get("/export/events").json()
    assert listed["files"] == 2 and listed["events"][0]["runs"] == 2 and listed["events"][0]["mb"] >= 0

    # one event alone; a file storage can't give today is listed, the rest still comes
    storage.local_path(_key(sid)).unlink()
    r = client.get(f"/export/everything.zip?event_id={event['id']}")
    z = zipfile.ZipFile(io.BytesIO(r.content))
    assert len([n for n in z.namelist() if n.endswith(".vbo")]) == 1
    assert "Customer A" in z.read("The Engineer/MISSING.txt").decode()
    settle()


def _key(session_id: int) -> str:
    from app import db, models
    with db.SessionLocal() as s:
        return s.query(models.LoggerFile).filter_by(session_id=session_id).one().path
