"""One memory-heavy job at a time.

Reading a log and analysing it takes 100 to 300 MB while it runs, and the server has 512 MB on Render's free plan,
so two at once can run it out of memory. Every request or background job that reads logs takes this lock first;
the others wait their turn. It is re-entrant, so a job that already holds it can call code that takes it again.

Queueing alone isn't enough: each request runs on its own worker thread, and glibc keeps the memory a thread frees
in that thread's arena, so the leftovers of a few requests add up past 512 MB. When the outermost holder lets go,
the lock hands that memory back to the system before the next job starts.

Within a job the same happens on a smaller scale: glibc keeps the big arrays a log was worked through with (made and
dropped by the hundred) for the next ones, and the pieces it keeps add up to tens of MB more than the job holds at
any moment. A job calls trim() where it has just dropped a log's channels, so its peak is what it holds.

Background work that nobody is waiting for (the prebuild, app/prebuild.py) runs inside background(): it takes the lock
only when no request or other job is waiting for it, and gives it straight back when one came in at that moment, so a
page Gabriele opens waits at most for the one piece of background work that is already running.
"""
import ctypes
import functools
import gc
import threading
import time
from collections.abc import Iterator
from contextlib import contextmanager

POLL_S = 0.05  # how often background work looks again whether the lock is free and nobody else wants it


def trim() -> None:
    """Give the memory already freed back to the system: a few milliseconds, so it can follow every log."""
    try:
        ctypes.CDLL("libc.so.6").malloc_trim(0)
    except (OSError, AttributeError):  # not glibc
        pass


def release_memory() -> None:
    """Free what the last job left behind and give it back to the system."""
    gc.collect()
    trim()


_background = threading.local()


@contextmanager
def background() -> Iterator[None]:
    """This thread's work is background work: inside this, the lock is taken only after everyone else waiting for it
    (requests and the other jobs)."""
    before = getattr(_background, "on", False)
    _background.on = True
    try:
        yield
    finally:
        _background.on = before


def in_background() -> bool:
    return getattr(_background, "on", False)


class _HeavyLock:
    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._held = threading.local()
        self._count = threading.Lock()
        self._waiting = 0  # threads waiting for the lock now, background work left out

    @property
    def waiting(self) -> int:
        """How many requests or jobs (not background work) are waiting for the lock now."""
        return self._waiting

    def acquire(self, blocking: bool = True, timeout: float = -1) -> bool:
        depth = getattr(self._held, "depth", 0)
        if depth:  # this thread holds it already
            got = self._lock.acquire(blocking, timeout)
        elif in_background():
            got = self._acquire_last(blocking, timeout)
        else:
            with self._count:
                self._waiting += 1
            try:
                got = self._lock.acquire(blocking, timeout)
            finally:
                with self._count:
                    self._waiting -= 1
        if not got:
            return False
        self._held.depth = depth + 1
        return True

    def _acquire_last(self, blocking: bool, timeout: float) -> bool:
        """For background work: the lock once it is free and nobody else is waiting for it."""
        deadline = None if timeout < 0 else time.monotonic() + timeout
        while True:
            if not self._waiting and self._lock.acquire(blocking, POLL_S if blocking else -1):
                if not self._waiting:
                    return True
                self._lock.release()  # someone came in just now: they go first
            if not blocking or (deadline is not None and time.monotonic() >= deadline):
                return False
            if self._waiting:
                time.sleep(POLL_S)

    def wait_for_others(self) -> None:
        """For background work between two pieces of it: wait while requests or jobs are waiting for the lock."""
        while self._waiting:
            time.sleep(POLL_S)

    def release(self) -> None:
        self._held.depth -= 1
        try:
            if self._held.depth == 0:
                release_memory()
        finally:
            self._lock.release()

    def __enter__(self) -> "_HeavyLock":
        self.acquire()
        return self

    def __exit__(self, *exc) -> None:
        self.release()


lock = _HeavyLock()


def one_at_a_time(fn):
    """For an endpoint that reads logs: it waits until no other log-reading work is running."""
    @functools.wraps(fn)
    def wrapper(*args, **kwargs):
        with lock:
            return fn(*args, **kwargs)
    return wrapper
