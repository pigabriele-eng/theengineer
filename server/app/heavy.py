"""One memory-heavy job at a time.

Reading a log and analysing it takes 100 to 300 MB while it runs, and the server has 512 MB on Render's free plan,
so two at once can run it out of memory. Every request or background job that reads logs takes this lock first;
the others wait their turn. It is re-entrant, so a job that already holds it can call code that takes it again.

Queueing alone isn't enough: each request runs on its own worker thread, and glibc keeps the memory a thread frees
in that thread's arena, so the leftovers of a few requests add up past 512 MB. When the outermost holder lets go,
the lock hands that memory back to the system before the next job starts.
"""
import ctypes
import functools
import gc
import threading


def release_memory() -> None:
    """Free what the last job left behind and give it back to the system."""
    gc.collect()
    try:
        ctypes.CDLL("libc.so.6").malloc_trim(0)
    except (OSError, AttributeError):  # not glibc
        pass


class _HeavyLock:
    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._held = threading.local()

    def acquire(self, blocking: bool = True, timeout: float = -1) -> bool:
        if not self._lock.acquire(blocking, timeout):
            return False
        self._held.depth = getattr(self._held, "depth", 0) + 1
        return True

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
