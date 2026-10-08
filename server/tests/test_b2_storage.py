"""Backblaze B2 through its S3-compatible API (mocked): Gabriele chose it on 2026-10-08 so every weekend fits."""
import gzip
import hashlib
import shutil
from xml.sax.saxutils import escape

import httpx
import pytest

from app import storage
from app.storage import S3Storage, TwoStorages, sign_v4
from tests.test_deploy import FakeSupabaseStorage

ENDPOINT = "https://s3.eu-central-003.backblazeb2.com"


def test_requests_are_signed_as_aws_documents():
    """AWS's Signature Version 4 test suite, case get-vanilla."""
    url = httpx.URL("https://example.amazonaws.com/")
    headers = {"host": "example.amazonaws.com", "x-amz-date": "20150830T123600Z"}
    auth = sign_v4("GET", url, headers, hashlib.sha256(b"").hexdigest(), "AKIDEXAMPLE",
                   "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY", "us-east-1", "20150830T123600Z", service="service")
    assert auth == ("AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, "
                    "SignedHeaders=host;x-amz-date, "
                    "Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31")


class FakeB2:
    """Just enough of an S3 bucket; checks every request carries a signature over its body."""

    def __init__(self, bucket: str = "theengineer-logs", page: int = 1000):
        self.bucket, self.page = bucket, page
        self.objects: dict[str, bytes] = {}
        self.requests: list[tuple[str, str]] = []

    def handler(self, request: httpx.Request) -> httpx.Response:
        auth = request.headers["authorization"]
        assert auth.startswith("AWS4-HMAC-SHA256 Credential=key-id/") and "/eu-central-003/s3/aws4_request" in auth
        assert request.headers["x-amz-content-sha256"] == hashlib.sha256(request.content).hexdigest()
        path = request.url.path.removeprefix("/")
        bucket, _, name = path.partition("/")
        self.requests.append((request.method, name or "?" + str(request.url.params)))
        if bucket != self.bucket:
            return httpx.Response(404)
        if not name and request.method == "HEAD":
            return httpx.Response(200)
        if not name and request.method == "GET":
            names = sorted(self.objects)
            start = int(request.url.params.get("continuation-token") or 0)
            part, more = names[start:start + self.page], start + self.page < len(names)
            xml = "".join(f"<Contents><Key>{escape(n)}</Key><Size>{len(self.objects[n])}</Size></Contents>"
                          for n in part)
            token = f"<NextContinuationToken>{start + self.page}</NextContinuationToken>" if more else ""
            return httpx.Response(200, content=(
                '<?xml version="1.0" encoding="UTF-8"?><ListBucketResult '
                f'xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><IsTruncated>{str(more).lower()}</IsTruncated>'
                f"{xml}{token}</ListBucketResult>"))
        if request.method == "PUT":
            self.objects[name] = request.content
            return httpx.Response(200)
        if request.method == "DELETE":
            self.objects.pop(name, None)
            return httpx.Response(204)
        if name in self.objects:
            return httpx.Response(200, content=self.objects[name])
        return httpx.Response(404, content=b"<Error><Code>NoSuchKey</Code></Error>")

    def storage(self, cache_dir, bucket: str | None = None) -> S3Storage:
        return S3Storage(ENDPOINT, bucket or self.bucket, "key-id", "secret", cache_dir,
                         client=httpx.Client(transport=httpx.MockTransport(self.handler)))


def test_b2_keeps_logs_compressed_and_reads_them_back(tmp_path):
    fake = FakeB2()
    s = fake.storage(tmp_path / "cache")
    s.setup()
    log = b"\x40\x00\x00\x00" + bytes(range(256)) * 400
    key = s.save(log, ".LD")
    assert key.endswith(".ld") and gzip.decompress(fake.objects[f"{key}.gz"]) == log
    shutil.rmtree(tmp_path / "cache")  # a new deploy: the disk is empty again
    assert s.local_path(key).read_bytes() == log
    assert ("GET", f"{key}.gz") in fake.requests
    (tmp_path / "run.ld").write_bytes(log)
    from_disk = s.save_file(tmp_path / "run.ld", ".ld")
    audio = s.save(b"fake audio", ".m4a")
    assert fake.objects[audio] == b"fake audio"
    with pytest.raises(FileNotFoundError):
        s.local_path("0123456789abcdef.ld")
    assert s.sizes([key, audio, "missing.ld"]) == {key: len(fake.objects[f"{key}.gz"]), audio: 10}
    assert s.used() == sum(len(b) for b in fake.objects.values())
    s.delete(from_disk)
    assert f"{from_disk}.gz" not in fake.objects and not (tmp_path / "cache" / from_disk).exists()
    s.delete(from_disk)  # already gone: nothing to do


def test_b2_listings_follow_the_pages(tmp_path):
    fake = FakeB2(page=2)
    s = fake.storage(tmp_path / "cache")
    keys = [s.save(bytes([i]) * 100, ".npz") for i in range(5)]
    assert s.sizes(keys) == dict.fromkeys(keys, 100)
    s.delete(keys[0])
    assert s.used() == 400


def test_b2_has_ten_times_the_room(tmp_path, monkeypatch):
    monkeypatch.delenv("STORAGE_LIMIT_MB", raising=False)
    s = FakeB2().storage(tmp_path)
    monkeypatch.setattr(storage, "backend", lambda: s)
    assert storage.usage() == {"used_mb": 0, "limit_mb": 9500}
    monkeypatch.setenv("STORAGE_LIMIT_MB", "1")
    with pytest.raises(storage.StorageFull):
        s.save(b"x", ".ld")  # less than the reserve kept for the reports


def test_a_missing_bucket_or_wrong_key_is_named(tmp_path):
    with pytest.raises(storage.StorageError, match="no bucket 'other'"):
        FakeB2().storage(tmp_path, bucket="other").setup()
    s = S3Storage(ENDPOINT, "b", "k", "s", tmp_path,
                  client=httpx.Client(transport=httpx.MockTransport(lambda r: httpx.Response(403))))
    with pytest.raises(storage.StorageError, match="S3_KEY_ID"):
        s.setup()
    with pytest.raises(storage.StorageError, match="Backblaze B2 couldn't store the file \\(403\\)"):
        s.save(b"x", ".m4a")


def test_new_files_go_to_b2_and_older_ones_stay_readable_in_supabase(tmp_path):
    old_fake, new_fake = FakeSupabaseStorage(), FakeB2()
    old = old_fake.storage(tmp_path / "cache")
    before = old.save(b"\x40 an older log", ".ld")
    both = TwoStorages(new_fake.storage(tmp_path / "cache"), old)
    both.setup()
    after = both.save(b"\x40 a new log", ".ld")
    assert f"{after}.gz" in new_fake.objects and f"logs/{after}.gz" not in old_fake.objects
    shutil.rmtree(tmp_path / "cache")
    assert both.local_path(before).read_bytes() == b"\x40 an older log"  # not in B2: read from Supabase
    assert both.local_path(after).read_bytes() == b"\x40 a new log"
    assert set(both.sizes([before, after, "missing.ld"])) == {before, after}
    assert both.used() == len(new_fake.objects[f"{after}.gz"])  # B2's room is what counts now
    both.delete(before)
    both.delete(after)
    assert old_fake.objects == {} and new_fake.objects == {}


def test_a_b2_that_cant_be_reached_leaves_the_app_on_supabase(tmp_path):
    old_fake = FakeSupabaseStorage()
    both = TwoStorages(FakeB2().storage(tmp_path, bucket="typo"), old_fake.storage(tmp_path))
    both.setup()
    key = both.save(b"\x40 log", ".ld")
    assert f"logs/{key}.gz" in old_fake.objects
    assert both.local_path(key).exists()


def test_the_settings_choose_the_storage(tmp_path, monkeypatch):
    storage._backend.cache_clear()
    monkeypatch.setenv("STORAGE_DIR", str(tmp_path))
    for name in ("SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "S3_ENDPOINT", "S3_BUCKET", "S3_KEY_ID", "S3_SECRET_KEY"):
        monkeypatch.delenv(name, raising=False)
    try:
        assert isinstance(storage.backend(), storage.LocalStorage)
        for name, value in (("S3_ENDPOINT", "s3.eu-central-003.backblazeb2.com"), ("S3_BUCKET", "logs-b2"),
                            ("S3_KEY_ID", "id"), ("S3_SECRET_KEY", " secret\n")):
            monkeypatch.setenv(name, value)
        b2 = storage.backend()
        assert isinstance(b2, S3Storage) and b2.endpoint == ENDPOINT and b2.region == "eu-central-003"
        assert b2.secret == "secret"  # a pasted line break doesn't break the signature
        monkeypatch.setenv("SUPABASE_URL", "https://project.supabase.co")
        monkeypatch.setenv("SUPABASE_SERVICE_ROLE_KEY", "sb_secret_x")
        both = storage.backend()
        assert isinstance(both, TwoStorages) and isinstance(both.old, storage.SupabaseStorage)
    finally:
        storage._backend.cache_clear()


def test_older_files_are_copied_to_b2_and_kept_in_supabase(tmp_path, monkeypatch):
    """Gabriele, 2026-10-08: "can we transfer everything on backblaze?" """
    old_fake, new_fake = FakeSupabaseStorage(), FakeB2()
    old = old_fake.storage(tmp_path / "cache")
    keys = [old.save(bytes([i]) * 5000, ".ld") for i in range(3)] + [old.save(b"audio", ".m4a")]
    both = TwoStorages(new_fake.storage(tmp_path / "cache"), old)
    both.setup()
    already = both.save(b"\x40 new", ".ld")
    assert both.copy_over() == {"copied": 4, "left": 0}
    for key in keys:
        name = old._object(key)
        assert new_fake.objects[name] == old_fake.objects[f"logs/{name}"]  # as stored: still compressed
    assert len(old_fake.objects) == 4  # Supabase keeps its copies
    assert both.used() == sum(len(b) for b in new_fake.objects.values())
    shutil.rmtree(tmp_path / "cache")
    old_fake.objects.clear()
    assert both.local_path(keys[0]).read_bytes() == bytes([0]) * 5000  # read from B2 now
    assert both.local_path(already).read_bytes() == b"\x40 new"
    assert both.copy_over() == {"copied": 0, "left": 0}  # nothing left to copy on the next start
    assert both.moving is None


def test_copying_stops_before_b2_is_full_and_skips_what_fails(tmp_path, monkeypatch):
    old_fake, new_fake = FakeSupabaseStorage(), FakeB2()
    old = old_fake.storage(tmp_path / "cache")
    keys = sorted(old.save(bytes(range(256)) * (40 + i), ".m4a") for i in range(3))  # 10-11 KB each, listed in order
    both = TwoStorages(new_fake.storage(tmp_path / "cache"), old)
    real = old_fake.handler

    def broken_first(request):
        if request.method == "GET" and request.url.path.endswith(keys[0]):
            return httpx.Response(500, text="boom")
        return real(request)

    old.client = httpx.Client(transport=httpx.MockTransport(broken_first), headers=old.client.headers)
    monkeypatch.setenv("STORAGE_LIMIT_MB", str((20_500 + storage.LOG_RESERVE_BYTES) / 1024**2))
    assert both.copy_over() == {"copied": 1, "left": 2}  # one failed, then the next would pass the limit
    assert list(new_fake.objects) == [keys[1]]


def test_the_storage_line_says_files_are_being_moved(tmp_path, monkeypatch):
    both = TwoStorages(FakeB2().storage(tmp_path), FakeSupabaseStorage().storage(tmp_path))
    monkeypatch.setattr(storage, "backend", lambda: both)
    both.moving = {"done": 3, "total": 40}
    assert storage.usage()["moving"] == {"done": 3, "total": 40}
    both.moving = None
    assert "moving" not in storage.usage()
