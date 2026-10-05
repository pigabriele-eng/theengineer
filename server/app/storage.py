"""Where uploaded logger files and debrief recordings live: the local disk, or Supabase Storage.

The database keeps each file's storage key (LoggerFile.path, Debrief.audio_path). Code that reads a file asks
for a local path with `local_path(key)`: on the local disk that is the file itself; with Supabase it is a copy
downloaded on first use into a cache folder and reused after that.

Supabase is used when SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are set (bucket STORAGE_BUCKET, default
"logs", created private on startup if it's missing); otherwise files go under STORAGE_DIR (default ./storage).
Logs are stored gzip-compressed in Supabase (a 90 MB MoTeC log is about 11 MB), which keeps them under the
free plan's 50 MB per-file limit; the cached copy is the plain file.
"""
from __future__ import annotations

import gzip
import logging
import os
import uuid
import zlib
from functools import cache
from pathlib import Path
from typing import Protocol

import httpx

COMPRESSED_SUFFIXES = (".ld", ".ldx", ".csv", ".txt")  # logs compress well; audio is compressed already
COMPRESS_LEVEL = 4  # close to the smallest size for a fraction of the time of level 9
CACHE_LIMIT_BYTES = 2 * 1024**3  # downloaded copies kept on the server's disk


class StorageError(OSError):
    pass


class Storage(Protocol):
    def setup(self) -> None:
        """Make sure files can be stored (called on startup)."""

    def save(self, data: bytes, suffix: str) -> str:
        """Store new file contents and return their key."""

    def local_path(self, key: str) -> Path:
        """A local file with the contents stored under the key. FileNotFoundError when there is none."""


def _new_key(suffix: str) -> str:
    return f"{uuid.uuid4().hex}{suffix.lower()}"


class LocalStorage:
    def __init__(self, root: Path):
        self.root = root

    def setup(self) -> None:
        self.root.mkdir(parents=True, exist_ok=True)

    def save(self, data: bytes, suffix: str) -> str:
        key = _new_key(suffix)
        self.setup()
        (self.root / key).write_bytes(data)
        return key

    def local_path(self, key: str) -> Path:
        # older rows hold the file's full path (absolute, or relative to where the server runs)
        for p in (self.root / key, Path(key)):
            if p.is_file():
                return p
        raise FileNotFoundError(f"Stored file {key} not found")


class SupabaseStorage:
    """Supabase Storage through its REST API, with a local cache of the files read."""

    def __init__(self, url: str, service_key: str, bucket: str, cache_dir: Path, client: httpx.Client | None = None):
        self.api = f"{url.rstrip('/')}/storage/v1"
        self.bucket = bucket
        self.cache_dir = cache_dir
        # new secret keys (sb_secret_...) go on the apikey header only; the legacy service_role JWT on both
        headers = {"apikey": service_key}
        if not service_key.startswith("sb_"):
            headers["Authorization"] = f"Bearer {service_key}"
        self.client = client or httpx.Client(timeout=httpx.Timeout(30, read=300))
        self.client.headers.update(headers)

    @staticmethod
    def _object(key: str) -> str:
        return f"{key}.gz" if key.lower().endswith(COMPRESSED_SUFFIXES) else key

    def _url(self, key: str) -> str:
        return f"{self.api}/object/{self.bucket}/{self._object(key)}"

    @staticmethod
    def _fail(what: str, r: httpx.Response) -> StorageError:
        return StorageError(f"Supabase Storage couldn't {what} ({r.status_code}): {r.text[:300]}")

    def setup(self) -> None:
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        if self.client.get(f"{self.api}/bucket/{self.bucket}").status_code == 200:
            return
        r = self.client.post(f"{self.api}/bucket", json={"id": self.bucket, "name": self.bucket, "public": False})
        if r.status_code >= 400 and "already exists" not in r.text.lower():
            raise self._fail(f"create the bucket '{self.bucket}'", r)

    def save(self, data: bytes, suffix: str) -> str:
        key = _new_key(suffix)
        body = gzip.compress(data, COMPRESS_LEVEL) if key.endswith(COMPRESSED_SUFFIXES) else data
        r = self.client.post(self._url(key), content=body, headers={"Content-Type": "application/octet-stream"})
        if r.status_code == 413:
            raise StorageError(f"The file is {len(body) / 1e6:.0f} MB, more than the storage takes per file "
                               "(50 MB on Supabase's free plan)")
        if r.status_code >= 400:
            raise self._fail("store the file", r)
        self._write_cache(key, [data])
        return key

    def local_path(self, key: str) -> Path:
        p = self.cache_dir / key
        try:
            os.utime(p)  # recently used: trimmed last
            return p
        except FileNotFoundError:
            pass
        with self.client.stream("GET", self._url(key)) as r:
            if r.status_code >= 400:
                r.read()
                # older Storage versions answer 400 with a "not found" body for a missing object
                if r.status_code == 404 or "not found" in r.text.lower():
                    raise FileNotFoundError(f"Stored file {key} not found")
                raise self._fail("read the file", r)
            if self._object(key) != key:
                d = zlib.decompressobj(wbits=31)
                return self._write_cache(key, (d.decompress(chunk) for chunk in r.iter_bytes()), d)
            return self._write_cache(key, r.iter_bytes())

    def _write_cache(self, key: str, chunks, decompressor=None) -> Path:
        """Write to a temporary name and rename, so a reader never sees half a file."""
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        p = self.cache_dir / key
        tmp = p.with_name(f".{p.name}.{uuid.uuid4().hex}")
        try:
            with tmp.open("wb") as f:
                for chunk in chunks:
                    f.write(chunk)
                if decompressor is not None:
                    f.write(decompressor.flush())
            tmp.replace(p)
        finally:
            tmp.unlink(missing_ok=True)
        self._trim_cache(keep=p)
        return p

    def _trim_cache(self, keep: Path) -> None:
        """Delete the least recently used copies once the cache is over its limit. Files being read stay
        readable: they are unlinked, never truncated."""
        entries = []
        for p in self.cache_dir.iterdir():
            if p == keep or p.name.startswith("."):  # dot files are downloads in progress
                continue
            try:
                st = p.stat()
            except FileNotFoundError:  # just trimmed by another request
                continue
            entries.append((st.st_mtime, st.st_size, p))
        total = keep.stat().st_size + sum(size for _, size, _ in entries)
        for _, size, p in sorted(entries):
            if total <= CACHE_LIMIT_BYTES:
                break
            p.unlink(missing_ok=True)
            total -= size


@cache
def _backend(storage_dir: str, url: str | None, key: str | None, bucket: str) -> Storage:
    if url and key:
        return SupabaseStorage(url, key, bucket, Path(storage_dir) / "cache")
    if url:
        logging.getLogger(__name__).warning("SUPABASE_SERVICE_ROLE_KEY isn't set: files are stored on the local disk "
                                            "in %s, which a hosted server may lose on restart", storage_dir)
    return LocalStorage(Path(storage_dir))


def backend() -> Storage:
    return _backend(os.environ.get("STORAGE_DIR", "./storage"), os.environ.get("SUPABASE_URL"),
                    os.environ.get("SUPABASE_SERVICE_ROLE_KEY"), os.environ.get("STORAGE_BUCKET") or "logs")


def save(data: bytes, suffix: str) -> str:
    return backend().save(data, suffix)


def local_path(key: str) -> Path:
    return backend().local_path(key)
