"""Logs the desktop app imported from the computer's own folders (routers/desktop.py): where each one is, so a log
keeps the folder it came from (LoggerFile.meta "source_path") and the videos next to it can join its run."""
import threading
from pathlib import Path

_lock = threading.Lock()
_paths: set[str] = set()


def add(paths: list[Path]) -> None:
    with _lock:
        _paths.update(str(p.resolve()) for p in paths)


def is_local(path: Path) -> bool:
    with _lock:
        return str(Path(path).resolve()) in _paths
