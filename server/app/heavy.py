"""One heavy background step at a time in this server process.

Reading a big log takes 200-300 MB at its peak, and the hosted server has 512 MB. The import of an upload and the
report's work both run in background threads; each holds this lock while it reads one log, so the two never read
logs at the same moment. Requests from the app are not held up by it.
"""
import ctypes
import gc
import threading

lock = threading.RLock()  # re-entrant: the report's work holds it while it reduces a session it needs


def release_memory() -> None:
    """Free the arrays of a log just read and hand the memory back to the system (glibc otherwise keeps it for the
    thread, and the server has 512 MB on Render)."""
    gc.collect()
    try:
        ctypes.CDLL("libc.so.6").malloc_trim(0)
    except (OSError, AttributeError):  # not glibc
        pass
