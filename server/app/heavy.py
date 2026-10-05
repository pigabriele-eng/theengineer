"""One memory-heavy job at a time.

Reading a log and analysing it takes 100 to 300 MB while it runs, and the server has 512 MB on Render's free plan,
so two at once can run it out of memory. Every request or background job that reads logs takes this lock first;
the others wait their turn. It is re-entrant, so a job that already holds it can call code that takes it again.
"""
import functools
import threading

lock = threading.RLock()


def one_at_a_time(fn):
    """For an endpoint that reads logs: it waits until no other log-reading work is running."""
    @functools.wraps(fn)
    def wrapper(*args, **kwargs):
        with lock:
            return fn(*args, **kwargs)
    return wrapper
