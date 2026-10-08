"""Where uploaded logger files and debrief recordings live: the local disk, Supabase Storage or Backblaze B2.

The database keeps each file's storage key (LoggerFile.path, Debrief.audio_path). Code that reads a file asks
for a local path with `local_path(key)`: on the local disk that is the file itself; with Supabase it is a copy
downloaded on first use into a cache folder and reused after that.

Supabase is used when SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are set (bucket STORAGE_BUCKET, default
"logs", created private on startup if it's missing); otherwise files go under STORAGE_DIR (default ./storage).
Logs are stored gzip-compressed in Supabase (a 90 MB MoTeC log is about 11 MB), which keeps them under the
free plan's 50 MB per-file limit; the cached copy is the plain file.

The free plan also holds 1 GB in all (STORAGE_LIMIT_MB, default 1024): a log that would take the bucket past it, less
LOG_RESERVE_BYTES kept for the reports and lap packs worked out from the logs, isn't stored (StorageFull), so an upload
stops with a clear message rather than storage failing half way (Gabriele, 2026-10-08: a 727 MB zip).

Backblaze B2 (free: 10 GB) is used when S3_ENDPOINT, S3_BUCKET, S3_KEY_ID and S3_SECRET_KEY are set (Gabriele chose
it on 2026-10-08 so every weekend fits). With Supabase set too, new files go to B2 and files stored earlier stay in
Supabase and are read from there (TwoStorages); nothing is moved.
"""
from __future__ import annotations

import gzip
import hashlib
import hmac
import logging
import os
import threading
import shutil
import urllib.parse
import uuid
import zlib
from collections.abc import Iterator
from datetime import UTC, datetime
from functools import cache
from pathlib import Path
from typing import Protocol
from xml.etree import ElementTree

import httpx

COMPRESSED_SUFFIXES = (".ld", ".ldx", ".csv", ".txt")  # logs compress well; audio is compressed already
LOG_SUFFIXES = COMPRESSED_SUFFIXES  # uploaded logs (stopped first when storage is nearly full)
COMPRESS_LEVEL = 4  # close to the smallest size for a fraction of the time of level 9
CACHE_LIMIT_BYTES = 2 * 1024**3  # downloaded copies kept on the server's disk
CHUNK_BYTES = 1024**2
LIMIT_MB_DEFAULT = 1024  # Supabase's free plan
LOG_RESERVE_BYTES = 50 * 1024**2  # kept free of logs: the reports and lap packs made from them need room too
LIST_PAGE = 1000  # files per page of a Supabase bucket listing
LIST_LIMIT = 100_000  # files looked through at most when finding stored sizes


class StorageFull(OSError):
    """A log that doesn't fit in what is left of the storage."""


class StorageError(OSError):
    pass


class Storage(Protocol):
    def setup(self) -> None:
        """Make sure files can be stored (called on startup)."""

    def save(self, data: bytes, suffix: str) -> str:
        """Store new file contents and return their key."""

    def save_file(self, path: Path, suffix: str) -> str:
        """Store a copy of a local file, read in chunks rather than all at once, and return its key."""

    def local_path(self, key: str) -> Path:
        """A local file with the contents stored under the key. FileNotFoundError when there is none."""

    def delete(self, key: str) -> None:
        """Remove the file stored under the key; nothing happens when there is none."""

    def sizes(self, keys: list[str]) -> dict[str, int]:
        """The bytes each key takes in storage (logs compressed, on Supabase); a key with no file is left out."""


def _new_key(suffix: str) -> str:
    return f"{uuid.uuid4().hex}{suffix.lower()}"


def _chunks(path: Path) -> Iterator[bytes]:
    with path.open("rb") as f:
        while chunk := f.read(CHUNK_BYTES):
            yield chunk


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

    def save_file(self, path: Path, suffix: str) -> str:
        key = _new_key(suffix)
        self.setup()
        shutil.copyfile(path, self.root / key)
        return key

    def local_path(self, key: str) -> Path:
        # older rows hold the file's full path (absolute, or relative to where the server runs)
        for p in (self.root / key, Path(key)):
            if p.is_file():
                return p
        raise FileNotFoundError(f"Stored file {key} not found")

    def delete(self, key: str) -> None:
        """Only inside the storage folder, also for an older row's full path."""
        root = self.root.resolve()
        for p in (self.root / key, Path(key)):
            if p.is_file() and p.resolve().is_relative_to(root):
                p.unlink(missing_ok=True)
                return

    def sizes(self, keys: list[str]) -> dict[str, int]:
        out = {}
        for key in keys:
            try:
                out[key] = self.local_path(key).stat().st_size
            except OSError:  # FileNotFoundError included: no file
                pass
        return out


class RemoteStorage:
    """Files kept by a storage service, with a local cache of the files read. Logs are stored gzip-compressed (their
    object name ends in .gz); the cached copy is the plain file. A service class says how to store, read, delete and
    list one object."""

    service = "Storage"
    limit_mb_default: float = LIMIT_MB_DEFAULT

    def __init__(self, cache_dir: Path):
        self.cache_dir = cache_dir
        self._used: int | None = None  # bytes stored, once listed (used())
        self._used_lock = threading.Lock()

    # ---- what each service does ----

    def _put(self, name: str, body: bytes) -> None:
        raise NotImplementedError

    def _get(self, name: str):
        """A context manager giving the streamed response (status_code, read(), text, iter_bytes())."""
        raise NotImplementedError

    def _remove(self, name: str) -> None:
        raise NotImplementedError

    def _list(self) -> Iterator[tuple[str, int]]:
        """(object name, bytes) for every object, a page at a time."""
        raise NotImplementedError

    # ---- the same for every service ----

    @staticmethod
    def _object(key: str) -> str:
        return f"{key}.gz" if key.lower().endswith(COMPRESSED_SUFFIXES) else key

    def _fail(self, what: str, r: httpx.Response) -> StorageError:
        return StorageError(f"{self.service} couldn't {what} ({r.status_code}): {r.text[:300]}")

    def save(self, data: bytes, suffix: str) -> str:
        key = _new_key(suffix)
        self._upload(key, gzip.compress(data, COMPRESS_LEVEL) if key.endswith(COMPRESSED_SUFFIXES) else data)
        self._write_cache(key, [data])
        return key

    def save_file(self, path: Path, suffix: str) -> str:
        """Only the compressed copy is held in memory (about 11 MB for a 90 MB log)."""
        key = _new_key(suffix)
        if key.endswith(COMPRESSED_SUFFIXES):
            z = zlib.compressobj(COMPRESS_LEVEL, wbits=31)  # a gzip stream, as gzip.compress writes
            body = b"".join([*(z.compress(chunk) for chunk in _chunks(path)), z.flush()])
        else:
            body = path.read_bytes()
        self._upload(key, body)
        del body
        self._write_cache(key, _chunks(path))
        return key

    def limit(self) -> int | None:
        return limit_bytes(self.limit_mb_default)

    def used(self) -> int:
        """Bytes the bucket holds, from its listing once, then kept up to date as files are stored and deleted."""
        with self._used_lock:
            if self._used is None:
                self._used = sum(size for _, size in self._list())
            return self._used

    def _upload(self, key: str, body: bytes) -> None:
        limit = self.limit()
        if limit is not None and key.endswith(LOG_SUFFIXES):
            used = self.used()
            if used + len(body) > limit - LOG_RESERVE_BYTES:
                raise StorageFull(full_words(used, limit, len(body)))
        self._put(self._object(key), body)
        with self._used_lock:
            if self._used is not None:
                self._used += len(body)

    def local_path(self, key: str) -> Path:
        p = self.cache_dir / key
        try:
            os.utime(p)  # recently used: trimmed last
            return p
        except FileNotFoundError:
            pass
        with self._get(self._object(key)) as r:
            if r.status_code >= 400:
                r.read()
                # older Supabase Storage versions answer 400 with a "not found" body for a missing object
                if r.status_code == 404 or "not found" in r.text.lower():
                    raise FileNotFoundError(f"Stored file {key} not found")
                raise self._fail("read the file", r)
            if self._object(key) != key:
                d = zlib.decompressobj(wbits=31)
                return self._write_cache(key, (d.decompress(chunk) for chunk in r.iter_bytes()), d)
            return self._write_cache(key, r.iter_bytes())

    def delete(self, key: str) -> None:
        self._remove(self._object(key))
        with self._used_lock:
            self._used = None  # listed again when next needed
        (self.cache_dir / key).unlink(missing_ok=True)

    def sizes(self, keys: list[str]) -> dict[str, int]:
        """From the bucket's listing (keys are at its top level), stopping once every key is found."""
        wanted = {self._object(k): k for k in keys}
        out: dict[str, int] = {}
        if not wanted:
            return out
        for name, size in self._list():
            key = wanted.pop(name, None)
            if key is not None:
                out[key] = size
                if not wanted:
                    break
        return out

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


class SupabaseStorage(RemoteStorage):
    """Supabase Storage through its REST API (free plan: 1 GB in all, 50 MB per file)."""

    service = "Supabase Storage"

    def __init__(self, url: str, service_key: str, bucket: str, cache_dir: Path, client: httpx.Client | None = None):
        super().__init__(cache_dir)
        self.api = f"{url.rstrip('/')}/storage/v1"
        self.bucket = bucket
        # new secret keys (sb_secret_...) go on the apikey header only; the legacy service_role JWT on both
        headers = {"apikey": service_key}
        if not service_key.startswith("sb_"):
            headers["Authorization"] = f"Bearer {service_key}"
        self.client = client or httpx.Client(timeout=httpx.Timeout(30, read=300))
        self.client.headers.update(headers)

    def _url(self, name: str) -> str:
        return f"{self.api}/object/{self.bucket}/{name}"

    def setup(self) -> None:
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        if self.client.get(f"{self.api}/bucket/{self.bucket}").status_code == 200:
            return
        r = self.client.post(f"{self.api}/bucket", json={"id": self.bucket, "name": self.bucket, "public": False})
        if r.status_code >= 400 and "already exists" not in r.text.lower():
            raise self._fail(f"create the bucket '{self.bucket}'", r)

    def _put(self, name: str, body: bytes) -> None:
        r = self.client.post(self._url(name), content=body, headers={"Content-Type": "application/octet-stream"})
        if r.status_code == 413:
            raise StorageError(f"The file is {len(body) / 1e6:.0f} MB, more than the storage takes per file "
                               "(50 MB on Supabase's free plan)")
        if r.status_code >= 400:
            raise self._fail("store the file", r)

    def _get(self, name: str):
        return self.client.stream("GET", self._url(name))

    def _remove(self, name: str) -> None:
        r = self.client.delete(self._url(name))
        # older Storage versions answer 400 with a "not found" body for a missing object
        if r.status_code >= 400 and r.status_code != 404 and "not found" not in r.text.lower():
            raise self._fail("delete the file", r)

    def _list(self) -> Iterator[tuple[str, int]]:
        for offset in range(0, LIST_LIMIT, LIST_PAGE):
            r = self.client.post(f"{self.api}/object/list/{self.bucket}", json={
                "prefix": "", "limit": LIST_PAGE, "offset": offset, "sortBy": {"column": "name", "order": "asc"}})
            if r.status_code >= 400:
                raise self._fail("list the files", r)
            page = r.json()
            for o in page:
                if isinstance(size := (o.get("metadata") or {}).get("size"), int):
                    yield o.get("name"), size
            if len(page) < LIST_PAGE:
                return


def sign_v4(method: str, url: httpx.URL, headers: dict[str, str], payload_hash: str, key_id: str, secret: str,
            region: str, amz_date: str, service: str = "s3") -> str:
    """The Authorization header of an AWS Signature Version 4 request (what S3-compatible services such as Backblaze
    B2 check). `headers` are the headers signed, `host` and `x-amz-date` among them."""
    def quote(s: str, safe: str = "-_.~") -> str:
        return urllib.parse.quote(s, safe=safe)

    query = sorted((quote(k), quote(v)) for k, v in url.params.multi_items())
    signed = sorted((k.lower(), " ".join(str(v).split())) for k, v in headers.items())
    names = ";".join(k for k, _ in signed)
    canonical = "\n".join([method, quote(url.path or "/", "/-_.~"), "&".join(f"{k}={v}" for k, v in query),
                           "".join(f"{k}:{v}\n" for k, v in signed), names, payload_hash])
    scope = f"{amz_date[:8]}/{region}/{service}/aws4_request"
    to_sign = "\n".join(["AWS4-HMAC-SHA256", amz_date, scope, hashlib.sha256(canonical.encode()).hexdigest()])
    key = f"AWS4{secret}".encode()
    for part in (amz_date[:8], region, service, "aws4_request"):
        key = hmac.new(key, part.encode(), hashlib.sha256).digest()
    signature = hmac.new(key, to_sign.encode(), hashlib.sha256).hexdigest()
    return f"AWS4-HMAC-SHA256 Credential={key_id}/{scope}, SignedHeaders={names}, Signature={signature}"


S3_NS = "{http://s3.amazonaws.com/doc/2006-03-01/}"
EMPTY_SHA256 = hashlib.sha256(b"").hexdigest()


class S3Storage(RemoteStorage):
    """An S3-compatible bucket, here Backblaze B2 (free: 10 GB in all, no per-file limit that matters): S3_ENDPOINT
    (https://s3.<region>.backblazeb2.com), S3_BUCKET, S3_KEY_ID and S3_SECRET_KEY. The bucket is made, private, in
    Backblaze's website; the key needs only that bucket."""

    service = "Backblaze B2"
    limit_mb_default = 9500  # Backblaze's free 10 GB are decimal: 10^10 bytes is 9,537 MB as counted here

    def __init__(self, endpoint: str, bucket: str, key_id: str, secret: str, cache_dir: Path,
                 region: str | None = None, client: httpx.Client | None = None):
        super().__init__(cache_dir)
        self.endpoint = endpoint.rstrip("/")
        if "://" not in self.endpoint:
            self.endpoint = f"https://{self.endpoint}"
        self.bucket, self.key_id, self.secret = bucket, key_id, secret
        host = httpx.URL(self.endpoint).host
        # s3.eu-central-003.backblazeb2.com: the region is the second part
        self.region = region or (host.split(".")[1] if host.startswith("s3.") and host.count(".") >= 2 else "us-east-1")
        self.client = client or httpx.Client(timeout=httpx.Timeout(30, read=300))

    def _request(self, method: str, name: str = "", params: dict | None = None, body: bytes = b"",
                 stream: bool = False):
        url = httpx.URL(f"{self.endpoint}/{self.bucket}" + (f"/{name}" if name else ""), params=params)
        payload = hashlib.sha256(body).hexdigest() if body else EMPTY_SHA256
        headers = {"host": url.netloc.decode(), "x-amz-content-sha256": payload,
                   "x-amz-date": datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")}
        headers["Authorization"] = sign_v4(method, url, headers, payload, self.key_id, self.secret, self.region,
                                           headers["x-amz-date"])
        del headers["host"]  # httpx sends it
        if stream:
            return self.client.stream(method, url, headers=headers)
        return self.client.request(method, url, headers=headers, content=body or None)

    def setup(self) -> None:
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        r = self._request("HEAD")
        if r.status_code == 404:
            raise StorageError(f"Backblaze B2 has no bucket '{self.bucket}': make it in Backblaze's website (private)")
        if r.status_code >= 400:
            raise StorageError(f"Backblaze B2 refused the bucket '{self.bucket}' ({r.status_code}): check S3_KEY_ID "
                               "and S3_SECRET_KEY, and that the key may use this bucket")

    def _put(self, name: str, body: bytes) -> None:
        r = self._request("PUT", name, body=body)
        if r.status_code >= 400:
            raise self._fail("store the file", r)

    def _get(self, name: str):
        return self._request("GET", name, stream=True)

    def _remove(self, name: str) -> None:
        r = self._request("DELETE", name)
        if r.status_code >= 400 and r.status_code != 404:
            raise self._fail("delete the file", r)

    def _list(self) -> Iterator[tuple[str, int]]:
        token = None
        for _ in range(0, LIST_LIMIT, LIST_PAGE):
            params = {"list-type": "2", "max-keys": str(LIST_PAGE)}
            if token:
                params["continuation-token"] = token
            r = self._request("GET", params=params)
            if r.status_code >= 400:
                raise self._fail("list the files", r)
            root = ElementTree.fromstring(r.content)
            for o in root.iter(f"{S3_NS}Contents"):
                yield o.findtext(f"{S3_NS}Key"), int(o.findtext(f"{S3_NS}Size") or 0)
            token = root.findtext(f"{S3_NS}NextContinuationToken")
            if root.findtext(f"{S3_NS}IsTruncated") != "true" or not token:
                return


class TwoStorages:
    """New files go to `new` (Backblaze B2); files stored before the move stay in `old` (Supabase) and are read and
    deleted there. Nothing is copied across. If `new` can't be reached on startup (a wrong key, a missing bucket),
    the server keeps using `old` alone and logs why, so the app keeps working."""

    def __init__(self, new: RemoteStorage, old: RemoteStorage):
        self.new: RemoteStorage | None = new
        self.old = old

    @property
    def current(self) -> RemoteStorage:
        return self.new or self.old

    def setup(self) -> None:
        self.old.setup()
        try:
            self.new.setup()
        except (StorageError, httpx.HTTPError) as e:
            logging.getLogger(__name__).error("New files stay in %s: %s", self.old.service, e)
            self.new = None

    def save(self, data: bytes, suffix: str) -> str:
        return self.current.save(data, suffix)

    def save_file(self, path: Path, suffix: str) -> str:
        return self.current.save_file(path, suffix)

    def local_path(self, key: str) -> Path:
        if self.new is not None:
            try:
                return self.new.local_path(key)
            except FileNotFoundError:
                pass
        return self.old.local_path(key)

    def delete(self, key: str) -> None:
        if self.new is not None:
            self.new.delete(key)
        self.old.delete(key)

    def sizes(self, keys: list[str]) -> dict[str, int]:
        out = self.new.sizes(keys) if self.new is not None else {}
        return out | self.old.sizes([k for k in keys if k not in out])

    def used(self) -> int:
        return self.current.used()

    def limit(self) -> int | None:
        return self.current.limit()


@cache
def _backend(storage_dir: str, url: str | None, key: str | None, bucket: str,
             s3: tuple[str, ...] | None = None) -> Storage:
    cache_dir = Path(storage_dir) / "cache"
    supabase = SupabaseStorage(url, key, bucket, cache_dir) if url and key else None
    if s3:
        b2 = S3Storage(*s3, cache_dir=cache_dir)
        return TwoStorages(b2, supabase) if supabase else b2
    if supabase:
        return supabase
    if url:
        logging.getLogger(__name__).warning("SUPABASE_SERVICE_ROLE_KEY isn't set: files are stored on the local disk "
                                            "in %s, which a hosted server may lose on restart", storage_dir)
    return LocalStorage(Path(storage_dir))


def backend() -> Storage:
    env = os.environ.get
    s3 = (env("S3_ENDPOINT"), env("S3_BUCKET"), env("S3_KEY_ID"), env("S3_SECRET_KEY"))
    return _backend(env("STORAGE_DIR", "./storage"), env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"),
                    env("STORAGE_BUCKET") or "logs", tuple(v.strip() for v in s3) if all(s3) else None)


def save(data: bytes, suffix: str) -> str:
    return backend().save(data, suffix)


def save_file(path: Path, suffix: str) -> str:
    return backend().save_file(path, suffix)


def local_path(key: str) -> Path:
    return backend().local_path(key)


def delete(key: str) -> None:
    backend().delete(key)


def sizes(keys: list[str]) -> dict[str, int]:
    return backend().sizes(keys)


def limit_bytes(default_mb: float = LIMIT_MB_DEFAULT) -> int | None:
    """The most the storage service holds (STORAGE_LIMIT_MB, default its free plan's; 0 for no limit)."""
    mb = float(os.environ.get("STORAGE_LIMIT_MB") or default_mb)
    return int(mb * 1024**2) if mb > 0 else None


def full_words(used: int, limit: int, size: int) -> str:
    return (f"Storage is nearly full ({used / 1024**2:.0f} of {limit / 1024**2:.0f} MB used): this log needs "
            f"{size / 1024**2:.0f} MB more, so it wasn't kept. Delete an old event or move to a bigger storage plan "
            "to add more")


def usage() -> dict:
    """What the storage holds and can hold, in MB (None when unknown or unlimited)."""
    b = backend()
    if not isinstance(b, (RemoteStorage, TwoStorages)):  # the local disk: no limit kept
        return {"used_mb": None, "limit_mb": None}
    limit, used = b.limit(), b.used()
    return {"used_mb": round(used / 1024**2), "limit_mb": round(limit / 1024**2) if limit is not None else None}
