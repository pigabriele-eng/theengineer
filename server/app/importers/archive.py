"""Find the logger files in an upload of several files at once: loose logs and zips, with logs in folders at any
depth and zips inside a zip (one level deep).

Nothing is unpacked up front. The walk reads each zip's directory, and a log is copied out (to a temporary name,
never the name in the zip) only when it is imported, so one log at a time is on the disk. Entry names with an
absolute path or '..' are skipped. One upload is capped at MAX_TOTAL_BYTES of files once unpacked and
MAX_ENTRIES zip entries; the walk stops at either, and what was found before that is still imported.
"""
from __future__ import annotations

import itertools
import re
import shutil
import zipfile
import zlib
from collections.abc import Callable
from contextlib import ExitStack
from dataclasses import dataclass, field
from functools import partial
from pathlib import Path, PurePosixPath
from typing import IO

LOGS = (".ld", ".csv", ".txt")  # .csv and .txt: logger exports
LDX = ".ldx"  # beacons for the .ld log of the same name
ZIP = ".zip"
ACCEPTED = (*LOGS, LDX, ZIP)
MAX_TOTAL_BYTES = 3 * 1024**3
MAX_UPLOAD_BYTES = 3 * 1024**3  # as sent, zips still compressed
MAX_ENTRIES = 10_000
MAX_DIRECTORY_BYTES = 16 * 1024**2  # a zip's own list of entries, read into memory to open it
CHUNK_BYTES = 1024**2

_counter = itertools.count()


def suffix(name: str) -> str:
    return PurePosixPath(name).suffix.lower()


@dataclass
class Item:
    """A log or .ldx somewhere in the upload."""
    label: str  # where it is in the upload, as shown to the user: "test.zip/01_D1S1/run.ld"
    name: str  # the file's own name: "run.ld"
    size: int
    where: str  # the zip and folder holding it, so an .ldx goes with the log next to it first
    folder: str | None = None  # the folder the session is named after
    archive: int | None = None  # the uploaded zip it came from (an index into Contents.archives)
    path: Path | None = None  # a file uploaded on its own is on the disk already
    _open: Callable[[], IO[bytes]] | None = field(default=None, repr=False)

    @property
    def ext(self) -> str:
        return suffix(self.name)

    @property
    def stem(self) -> str:
        return PurePosixPath(self.name).stem

    def extract(self, folder: Path) -> Path:
        """The file on the local disk: copied out of its zip in chunks, under a name of our own (the caller
        deletes the copy), or the uploaded file itself."""
        if self.path is not None:
            return self.path
        dest = folder / f"entry-{next(_counter)}{self.ext}"
        try:
            with self._open() as src, dest.open("wb") as out:
                shutil.copyfileobj(src, out, CHUNK_BYTES)
        except BaseException:
            dest.unlink(missing_ok=True)
            raise
        return dest


@dataclass
class Contents:
    logs: list[Item] = field(default_factory=list)
    ldx: list[Item] = field(default_factory=list)
    archives: list[str] = field(default_factory=list)  # the uploaded zips' names without .zip
    skipped: list[dict] = field(default_factory=list)  # {"file", "reason"}
    errors: list[dict] = field(default_factory=list)  # {"file", "error"}
    stopped: str | None = None  # why the walk stopped early


def _parts(name: str) -> list[str] | None:
    """The entry's path as folder names and its file name; None when it is absolute or goes up with '..'."""
    name = name.replace("\\", "/")
    if name.startswith("/") or re.match(r"[A-Za-z]:", name):
        return None
    parts = [p for p in name.split("/") if p not in ("", ".")]
    if ".." in parts:
        return None
    return parts


def _junk(parts: list[str]) -> bool:
    """Mac resource forks (__MACOSX/, ._name), .DS_Store and other hidden files."""
    return any(p == "__MACOSX" or p.startswith(".") for p in parts)


def _directory(path: Path) -> tuple[int, int] | None:
    """(entries, bytes) of a zip's directory from its end record, read before the directory itself is."""
    try:
        with path.open("rb") as f:
            end = zipfile._EndRecData(f)  # the standard library's own reader of the end record
    except OSError:
        return None
    return (end[zipfile._ECD_ENTRIES_TOTAL], end[zipfile._ECD_SIZE]) if end else None


class Upload:
    """The files of one upload: walk() lists the logs in them. Zips stay open until the end of the with block."""

    def __init__(self, files: list[tuple[str, Path]], tmp: Path):
        self.files = files  # (name as uploaded, file on the disk)
        self.tmp = tmp  # where zips inside zips are unpacked
        self.contents = Contents()
        self._bytes = 0
        self._entries = 0
        self._stack = ExitStack()

    def __enter__(self) -> Upload:
        return self

    def __exit__(self, *exc) -> None:
        self._stack.close()

    def walk(self) -> Contents:
        c = self.contents
        for name, path in self.files:
            if c.stopped:
                break
            ext = suffix(name)
            if ext == ZIP:
                c.archives.append(PurePosixPath(name).stem)
                self._zip(name, path, len(c.archives) - 1, nested=False)
            elif ext in (*LOGS, LDX):
                size = path.stat().st_size
                if self._fits(size, name):
                    self._add(Item(name, name, size, where="", path=path))
            else:
                self._skip(name, "not a logger file")
        return c

    def _skip(self, label: str, reason: str) -> None:
        self.contents.skipped.append({"file": label, "reason": reason})

    def _add(self, item: Item) -> None:
        (self.contents.ldx if item.ext == LDX else self.contents.logs).append(item)

    def _fits(self, size: int, label: str) -> bool:
        self._bytes += size
        if self._bytes > MAX_TOTAL_BYTES:
            self.contents.stopped = (f"The upload holds more than {MAX_TOTAL_BYTES / 1024**3:.3g} GB of files once "
                                     f"unpacked, so the import stopped at {label}. Upload the rest separately.")
            return False
        return True

    def _zip(self, label: str, path: Path, archive: int, nested: bool) -> None:
        c = self.contents
        directory = _directory(path)
        if directory and directory[0] + self._entries > MAX_ENTRIES:
            c.stopped = (f"{label} has {directory[0]:,} entries, more than the {MAX_ENTRIES:,} one upload can hold, "
                         "so the import stopped there. Zip fewer files at a time.")
            return
        if directory and directory[1] > MAX_DIRECTORY_BYTES:
            c.errors.append({"file": label, "error": "The zip's list of files is too large to open"})
            return
        try:
            zf = self._stack.enter_context(zipfile.ZipFile(path))
        except (zipfile.BadZipFile, OSError):
            c.errors.append({"file": label, "error": "Not a zip file, or a damaged one"})
            return
        infos = zf.infolist()
        self._entries += len(infos)
        if self._entries > MAX_ENTRIES:  # the end record didn't say
            c.stopped = (f"The upload holds more than {MAX_ENTRIES:,} files in zips, so the import stopped at "
                         f"{label}. Zip fewer files at a time.")
            return

        files = []
        for info in sorted(infos, key=lambda i: i.filename):
            if info.is_dir():
                continue
            shown = f"{label}/{info.filename}"
            parts = _parts(info.filename)
            if parts is None:
                self._skip(shown, "unsafe path (absolute or with '..')")
            elif _junk(parts):
                self._skip(shown, "hidden or system file")
            else:
                files.append((info, parts, shown))
        # The top of the zip is the folder holding everything, if there is one (zipping a folder makes one). A log
        # alone there is named after it (or the zip); several logs there are named from their headers instead.
        top = PurePosixPath(label).stem
        if len({p[0] for _, p, _ in files}) == 1 and all(len(p) > 1 for _, p, _ in files):
            top = files[0][1][0]
            files = [(i, p[1:], s) for i, p, s in files]
        logs_at_top = sum(len(p) == 1 and suffix(p[0]) in LOGS for _, p, _ in files)

        for info, parts, shown in files:
            ext = suffix(parts[-1])
            if ext in (*LOGS, LDX):
                if not self._fits(info.file_size, shown):
                    return
                folder = parts[-2] if len(parts) > 1 else (top if logs_at_top == 1 else None)
                self._add(Item(shown, parts[-1], info.file_size, where=f"{label}/{'/'.join(parts[:-1])}",
                               folder=folder, archive=archive, _open=partial(zf.open, info)))
            elif ext == ZIP and nested:
                self._skip(shown, "a zip inside a zip inside a zip isn't opened")
            elif ext == ZIP:
                if not self._fits(info.file_size, shown):
                    return
                inner = Item(shown, parts[-1], info.file_size, where="", _open=partial(zf.open, info))
                try:
                    inner_path = inner.extract(self.tmp)
                except Exception as e:
                    c.errors.append({"file": shown, "error": unpack_error(e)})
                    continue
                self._zip(shown, inner_path, archive, nested=True)
                if c.stopped:
                    return
            else:
                self._skip(shown, "not a logger file")


def pair_ldx(logs: list[Item], ldx: list[Item]) -> tuple[dict[int, Item], list[Item]]:
    """Each .ld log's .ldx (by the log's index): the one of the same name next to it, else one of the same name
    anywhere in the upload. Also the .ldx files left over."""
    left = list(ldx)
    pairs: dict[int, Item] = {}
    for same_place in (True, False):
        for i, log in enumerate(logs):
            if log.ext != ".ld" or i in pairs:
                continue
            match = next((x for x in left if x.stem.lower() == log.stem.lower()
                          and (x.where == log.where or not same_place)), None)
            if match is not None:
                pairs[i] = match
                left.remove(match)
    return pairs, left


def unpack_error(e: Exception) -> str:
    """A plain description of why a file couldn't be copied out of its zip."""
    if isinstance(e, NotImplementedError):  # e.g. Deflate64, which Windows uses for big files
        return "It's compressed in a way this server can't unpack; zip it again with a standard zip tool"
    if isinstance(e, RuntimeError) and "encrypted" in str(e):
        return "The zip is password protected"
    if isinstance(e, (zipfile.BadZipFile, EOFError, zlib.error)):
        return f"It's damaged inside the zip ({e})"
    return f"Couldn't unpack it: {e}"
