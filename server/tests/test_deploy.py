"""What changes when the server is deployed: the database URL, and files kept in Supabase Storage (mocked)."""
import gzip
import json
import shutil

import httpx
import pytest

from app import storage
from app.db import database_url
from app.storage import LocalStorage, SupabaseStorage

SECRET = "sb_secret_test"


def test_postgres_urls_use_psycopg():
    assert database_url("postgresql://postgres.ref:pw@aws-1-eu-central-1.pooler.supabase.com:5432/postgres") == \
        "postgresql+psycopg://postgres.ref:pw@aws-1-eu-central-1.pooler.supabase.com:5432/postgres"
    assert database_url("postgres://u:p@h/db") == "postgresql+psycopg://u:p@h/db"
    assert database_url("postgresql+psycopg://u:p@h/db") == "postgresql+psycopg://u:p@h/db"
    assert database_url("sqlite:///./theengineer.db") == "sqlite:///./theengineer.db"


class FakeSupabaseStorage:
    """Just enough of the Supabase Storage REST API."""

    def __init__(self, key: str = SECRET):
        self.key = key
        self.buckets: dict[str, dict] = {}
        self.objects: dict[str, bytes] = {}
        self.requests: list[tuple[str, str]] = []

    def handler(self, request: httpx.Request) -> httpx.Response:
        assert request.headers["apikey"] == self.key
        path = request.url.path.removeprefix("/storage/v1")
        self.requests.append((request.method, path))
        if path == "/bucket" and request.method == "POST":
            body = json.loads(request.content)
            self.buckets[body["id"]] = body
            return httpx.Response(200, json={"name": body["id"]})
        if path.startswith("/bucket/"):
            name = path.removeprefix("/bucket/")
            if name in self.buckets:
                return httpx.Response(200, json=self.buckets[name])
            return httpx.Response(400, json={"statusCode": "404", "error": "Bucket not found"})
        name = path.removeprefix("/object/")
        if request.method == "POST":
            self.objects[name] = request.content
            return httpx.Response(200, json={"Key": name})
        if name in self.objects:
            return httpx.Response(200, content=self.objects[name])
        return httpx.Response(400, json={"statusCode": "404", "error": "not_found", "message": "Object not found"})

    def storage(self, cache_dir) -> SupabaseStorage:
        return SupabaseStorage("https://project.supabase.co/", self.key, "logs", cache_dir,
                               client=httpx.Client(transport=httpx.MockTransport(self.handler)))


def test_supabase_storage_keeps_logs_compressed_and_reads_them_back(tmp_path):
    fake = FakeSupabaseStorage()
    s = fake.storage(tmp_path / "cache")
    s.setup()
    s.setup()
    assert fake.buckets == {"logs": {"id": "logs", "name": "logs", "public": False}}  # created once, private

    log = b"\x40\x00\x00\x00" + bytes(range(256)) * 400
    key = s.save(log, ".LD")
    assert key.endswith(".ld") and "/" not in key
    stored = fake.objects[f"logs/{key}.gz"]
    assert len(stored) < len(log) / 10 and gzip.decompress(stored) == log
    assert s.local_path(key).read_bytes() == log  # cached when saved: no download
    assert ("GET", f"/object/logs/{key}.gz") not in fake.requests

    shutil.rmtree(tmp_path / "cache")  # a new deploy: the disk is empty again
    assert s.local_path(key).read_bytes() == log
    assert ("GET", f"/object/logs/{key}.gz") in fake.requests

    audio = s.save(b"fake audio", ".m4a")
    assert fake.objects[f"logs/{audio}"] == b"fake audio"  # already compressed: stored as it is
    with pytest.raises(FileNotFoundError):
        s.local_path("0123456789abcdef.ld")


def test_supabase_keys_go_on_the_right_headers(tmp_path):
    new = FakeSupabaseStorage().storage(tmp_path)
    assert "authorization" not in new.client.headers  # a secret key isn't a JWT
    legacy = FakeSupabaseStorage(key="legacy.service-role.jwt").storage(tmp_path)
    assert legacy.client.headers["authorization"] == "Bearer legacy.service-role.jwt"


def test_storage_errors_are_reported(tmp_path):
    def refuse(request: httpx.Request) -> httpx.Response:
        return httpx.Response(403, json={"message": "signature verification failed"})

    s = SupabaseStorage("https://project.supabase.co", SECRET, "logs", tmp_path,
                        client=httpx.Client(transport=httpx.MockTransport(refuse)))
    with pytest.raises(storage.StorageError, match="403"):
        s.setup()
    with pytest.raises(storage.StorageError, match="signature"):
        s.save(b"x", ".ld")


def test_local_storage_still_reads_files_saved_by_full_path(tmp_path, monkeypatch):
    s = LocalStorage(tmp_path / "storage")
    key = s.save(b"new", ".csv")
    assert s.local_path(key).read_bytes() == b"new"
    old = tmp_path / "elsewhere" / "abc.ld"
    old.parent.mkdir()
    old.write_bytes(b"old")
    assert s.local_path(str(old)) == old
    monkeypatch.chdir(tmp_path)
    assert s.local_path("elsewhere/abc.ld").read_bytes() == b"old"  # relative to where the server ran
    with pytest.raises(FileNotFoundError):
        s.local_path("missing.ld")


def test_uploads_and_analysis_work_with_supabase_storage(client, tmp_path, monkeypatch):
    from tests.synthetic import simulate, write_ld

    fake = FakeSupabaseStorage()
    s = fake.storage(tmp_path / "cache")
    s.setup()
    monkeypatch.setattr(storage, "backend", lambda: s)

    session = client.post("/sessions", json={}).json()
    r = client.post(f"/sessions/{session['id']}/files", files={"file": ("run.ld", write_ld(simulate()[0]))})
    assert r.status_code == 201, r.text
    assert len(r.json()["laps"]) == 4
    (stored,) = [k for k in fake.objects if k.endswith(".ld.gz")]

    shutil.rmtree(tmp_path / "cache")
    analysis = client.get(f"/sessions/{session['id']}/analysis")
    assert analysis.status_code == 200 and len(analysis.json()["corners"]) == 2
    assert ("GET", f"/object/{stored}") in fake.requests

    d = client.post(f"/sessions/{session['id']}/debriefs/audio", files={"audio": ("d.webm", b"webm audio")}).json()
    shutil.rmtree(tmp_path / "cache")
    assert client.get(f"/debriefs/{d['id']}/audio").content == b"webm audio"


def test_storage_failures_reach_the_app_as_502(client, tmp_path, monkeypatch):
    s = SupabaseStorage("https://project.supabase.co", SECRET, "logs", tmp_path,
                        client=httpx.Client(transport=httpx.MockTransport(lambda r: httpx.Response(413))))
    monkeypatch.setattr(storage, "backend", lambda: s)
    session = client.post("/sessions", json={}).json()
    r = client.post(f"/sessions/{session['id']}/debriefs/audio", files={"audio": ("long.m4a", b"x" * 1000)})
    assert r.status_code == 502 and "50 MB" in r.json()["detail"]


def test_what_postgres_refuses_is_a_client_error(client):
    """Postgres enforces lengths and links that SQLite lets through; the app gets a 4xx, not a 500."""
    assert client.post("/drivers", json={"name": "x" * 121}).status_code == 422
    assert client.post("/tracks", json={"name": "Norisring"}).status_code == 201
    assert client.post("/tracks", json={"name": "Norisring"}).status_code == 409
