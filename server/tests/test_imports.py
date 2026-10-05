"""Importing many files at once: zips of whole tests, loose logs, folders at any depth and zips inside zips."""
import io
import time
import zipfile
from functools import cache

import pytest

from app.importers import archive


@cache
def log_bytes() -> bytes:
    from tests.synthetic import simulate, write_ld

    return write_ld(simulate()[0])


@cache
def lap_times() -> tuple[float, ...]:
    from tests.synthetic import simulate

    return tuple(simulate()[1])


def ldx_bytes() -> bytes:
    starts = [sum(lap_times()[:i]) for i in range(1, 6)]
    marks = "".join(f'<Marker ClassName="BCN" Name="b" Time="{t * 1e6}"/>' for t in starts)
    return (f"<LDXFile><Layers><Layer><MarkerBlock><MarkerGroup>{marks}</MarkerGroup></MarkerBlock></Layer>"
            "</Layers></LDXFile>").encode()


def make_zip(entries: dict[str, bytes]) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        for name, data in entries.items():
            # a ZipInfo keeps the name exactly as given, '..' and leading '/' included
            z.writestr(zipfile.ZipInfo(name, (2026, 7, 3, 12, 0, 0)), data, compress_type=zipfile.ZIP_DEFLATED)
    return buf.getvalue()


def upload(client, *files: tuple[str, bytes]) -> dict:
    r = client.post("/imports", files=[("files", f) for f in files])
    assert r.status_code == 202, r.text
    assert r.json()["status"] in ("queued", "running", "done")
    deadline = time.monotonic() + 120
    while True:
        job = client.get(f"/imports/{r.json()['id']}").json()
        if job["status"] in ("done", "failed"):
            return job
        assert time.monotonic() < deadline, job
        time.sleep(0.05)


def sessions_by_name(client, job) -> dict[str, dict]:
    out = {}
    for sid in job["session_ids"]:
        s = client.get(f"/sessions/{sid}").json()
        out[s["name"]] = s
    return out


def test_a_zip_of_a_test_gives_a_session_per_run(client):
    z = make_zip({
        "Hockenheim test/01_D1S1/20250505-1.ld": log_bytes(),
        "Hockenheim test/02_D1S2/20250505-2.ld": log_bytes(),
        "Hockenheim test/02_D1S2/schd0372.bmo": b"\x00" * 100,
    })
    job = upload(client, ("Hockenheim test.zip", z))
    assert job["status"] == "done", job
    assert (job["total"], job["done"]) == (2, 2)
    assert job["errors"] == [] and job["message"] is None
    assert job["skipped"] == [{"file": "Hockenheim test.zip/Hockenheim test/02_D1S2/schd0372.bmo",
                               "reason": "not a logger file"}]
    runs = sessions_by_name(client, job)
    assert set(runs) == {"01_D1S1", "02_D1S2"}
    for s in runs.values():
        assert s["kind"] == "test" and len(s["laps"]) == 4 and s["best_lap_s"] is not None
        assert s["files"][0]["filename"].endswith(".ld")

    (event,) = client.get("/events").json()  # the runs from one zip are one event, for multi-session analysis
    assert event["name"] == "Hockenheim test" and event["date"] == "2026-07-03"
    assert event["track_id"] == client.get("/tracks").json()[0]["id"]  # "Test Track", from the log headers
    assert {s["event_id"] for s in runs.values()} == {event["id"]}
    r = client.post("/insights", json={"session_ids": job["session_ids"]})
    assert r.status_code == 200, r.text


@cache
def unmarked_log_bytes() -> bytes:
    from tests.synthetic import simulate, write_ld

    return write_ld({k: v for k, v in simulate()[0].items() if k not in ("S/F Marker", "Lap Time")})


def test_an_ldx_in_the_zip_gives_its_log_beacon_lap_times(client):
    job = upload(client, ("day.zip", make_zip({"run/x.ld": unmarked_log_bytes(), "run/x.ldx": ldx_bytes()})))
    (s,) = sessions_by_name(client, job).values()
    assert s["name"] == "run"
    assert s["files"][0]["meta"]["lap_source"] == "beacons"
    assert len(s["files"][0]["meta"]["beacons"]) == 5
    assert len(s["laps"]) == 4
    assert job["skipped"] == []


def test_a_corrupt_log_is_reported_and_the_others_still_import(client):
    z = make_zip({"01_good/a.ld": log_bytes(), "02_bad/b.ld": b"\x40\x00\x00\x00" + b"\xff" * 5000,
                  "03_bad_too/c.csv": b"a,b"})
    job = upload(client, ("test.zip", z))
    assert job["status"] == "done" and (job["total"], job["done"]) == (3, 3)
    assert list(sessions_by_name(client, job)) == ["01_good"]
    assert [e["file"] for e in job["errors"]] == ["test.zip/02_bad/b.ld", "test.zip/03_bad_too/c.csv"]
    assert all(e["error"] for e in job["errors"])
    assert len(client.get("/sessions").json()) == 1  # no empty sessions left behind


def test_unsafe_names_in_a_zip_are_ignored(client, tmp_path):
    z = make_zip({"../evil.ld": log_bytes(), "/etc/evil.ld": log_bytes(), "C:/evil.ld": log_bytes(),
                  "runs/../../evil.ld": log_bytes(), "ok/run.ld": log_bytes(), "__MACOSX/ok/._run.ld": b"x",
                  "ok/.DS_Store": b"x"})
    job = upload(client, ("t.zip", z))
    assert list(sessions_by_name(client, job)) == ["ok"]
    reasons = {s["file"].removeprefix("t.zip/"): s["reason"] for s in job["skipped"]}
    assert {k for k, r in reasons.items() if r.startswith("unsafe")} == {
        "../evil.ld", "/etc/evil.ld", "C:/evil.ld", "runs/../../evil.ld"}
    assert reasons["__MACOSX/ok/._run.ld"] == reasons["ok/.DS_Store"] == "hidden or system file"
    assert not list(tmp_path.parent.glob("evil.ld")) and not (tmp_path / "evil.ld").exists()


def test_loose_logs_and_a_zip_in_one_upload(client):
    z = make_zip({"Test/Day1/Run1/20250505-7.ld": log_bytes(),  # two folders deep
                  "Test/Day1/Run2/b.ld": log_bytes()})
    job = upload(client, ("a.ld", log_bytes()), ("b.ld", log_bytes()), ("Test.zip", z),
                 ("20250505-7.ldx", ldx_bytes()), ("notes.pdf", b"%PDF"))
    assert job["status"] == "done" and job["total"] == 4 and job["errors"] == []
    runs = sessions_by_name(client, job)
    # loose logs carry no folder: named from the header's session name
    assert set(runs) == {"Session 1", "Session 1 (2)", "Run1", "Run2"}
    assert len(runs["Run1"]["files"][0]["meta"]["beacons"]) == 5  # the loose .ldx found its log in the zip
    assert job["skipped"] == [{"file": "notes.pdf", "reason": "not a logger file"}]
    (event,) = client.get("/events").json()
    assert event["name"] == "Test"
    assert runs["Run1"]["event_id"] == event["id"] and runs["Session 1"]["event_id"] is None


def test_a_zip_inside_a_zip_is_opened(client):
    inner = make_zip({"x.ld": log_bytes(), "deeper.zip": make_zip({"y.ld": log_bytes()})})
    z = make_zip({"season/03_D1S3.zip": inner, "season/01_D1S1/a.ld": log_bytes()})
    job = upload(client, ("season.zip", z))
    assert job["status"] == "done" and job["errors"] == []
    assert set(sessions_by_name(client, job)) == {"03_D1S3", "01_D1S1"}
    assert job["skipped"] == [{"file": "season.zip/season/03_D1S3.zip/deeper.zip",
                               "reason": "a zip inside a zip inside a zip isn't opened"}]
    assert len(client.get("/events").json()) == 1


def test_logs_in_one_folder_get_numbered_names(client):
    job = upload(client, ("t.zip", make_zip({"T01/06_D2S1/a.ld": log_bytes(), "T01/06_D2S1/b.ld": log_bytes(),
                                              "T01/06_D2S1/c.ld": log_bytes(), "T01/07_D2S2/d.ld": log_bytes()})))
    assert sorted(sessions_by_name(client, job)) == ["06_D2S1", "06_D2S1 (2)", "06_D2S1 (3)", "07_D2S2"]

    # logs side by side in the folder that holds the whole zip go by their headers, not that folder
    job = upload(client, ("t2.zip", make_zip({"T02/a.ld": log_bytes(), "T02/b.ld": log_bytes()})))
    assert sorted(sessions_by_name(client, job)) == ["Session 1", "Session 1 (2)"]


def test_the_size_and_entry_caps_stop_the_walk(client, monkeypatch):
    size = len(log_bytes())
    monkeypatch.setattr(archive, "MAX_TOTAL_BYTES", size * 2 + 10)
    job = upload(client, ("t.zip", make_zip({f"run{i}/x.ld": log_bytes() for i in range(4)})))
    assert job["status"] == "done" and job["total"] == 2 and len(job["session_ids"]) == 2
    assert "more than" in job["message"] and "run2/x.ld" in job["message"]

    monkeypatch.setattr(archive, "MAX_TOTAL_BYTES", 3 * 1024**3)
    monkeypatch.setattr(archive, "MAX_ENTRIES", 3)
    job = upload(client, ("big.zip", make_zip({f"f{i}.bmo": b"x" for i in range(5)})))
    assert job["total"] == 0 and "5 entries" in job["message"]


def test_not_a_zip_and_nothing_to_import(client):
    job = upload(client, ("broken.zip", b"PK not really"), ("run.ld", log_bytes()))
    assert job["errors"] == [{"file": "broken.zip", "error": "Not a zip file, or a damaged one"}]
    assert len(job["session_ids"]) == 1
    r = client.post("/imports", files=[("files", ("photo.jpg", b"jpeg"))])
    assert r.status_code == 415
    assert client.get("/imports/999").status_code == 404


def test_imports_left_running_by_a_restart_are_marked_failed(client):
    import app.db
    import app.models
    from app.routers.imports import INTERRUPTED, fail_interrupted

    with app.db.SessionLocal() as db:
        job = app.models.ImportJob(filename="x.zip", status="running", session_ids=[], errors=[], skipped=[])
        db.add(job)
        db.commit()
        job_id = job.id
    fail_interrupted()
    job = client.get(f"/imports/{job_id}").json()
    assert job["status"] == "failed" and job["message"] == INTERRUPTED and job["finished_at"]


def test_ldx_pairs_prefer_the_log_next_to_them():
    def item(label: str, where: str) -> archive.Item:
        return archive.Item(label, label.rsplit("/", 1)[-1], 1, where=where)

    logs = [item("a/run.ld", "a"), item("b/run.ld", "b"), item("c/other.ld", "c")]
    ldx = [item("b/run.ldx", "b"), item("a/RUN.ldx", "a"), item("d/stray.ldx", "d")]
    pairs, left = archive.pair_ldx(logs, ldx)
    assert pairs[0].label == "a/RUN.ldx" and pairs[1].label == "b/run.ldx" and 2 not in pairs
    assert [x.label for x in left] == ["d/stray.ldx"]


@pytest.mark.parametrize("name,ok", [("a/b.ld", True), ("a\\b.ld", True), ("../a.ld", False), ("/a.ld", False),
                                     ("a/../../b.ld", False), ("D:\\a.ld", False), ("./a/./b.ld", True)])
def test_entry_names(name, ok):
    assert (archive._parts(name) is not None) == ok
