import threading
import time

from app.heavy import lock, one_at_a_time


def test_log_reading_work_runs_one_at_a_time():
    running, most = 0, 0
    count = threading.Lock()

    @one_at_a_time
    def read_a_log():
        nonlocal running, most
        with count:
            running += 1
            most = max(most, running)
        time.sleep(0.02)
        with count:
            running -= 1

    threads = [threading.Thread(target=read_a_log) for _ in range(4)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert most == 1


def test_work_that_holds_the_lock_can_call_more_of_it():
    @one_at_a_time
    def inner():
        return "done"

    with lock:
        assert inner() == "done"


def test_memory_is_handed_back_once_the_outermost_holder_lets_go(monkeypatch):
    import app.heavy as heavy

    calls = []
    monkeypatch.setattr(heavy, "release_memory", lambda: calls.append(1))
    with lock:
        with lock:
            pass
        assert calls == []  # still inside the outer job
    assert calls == [1]


def test_a_lock_another_thread_holds_is_not_taken_without_waiting():
    took = []
    with lock:
        t = threading.Thread(target=lambda: took.append(lock.acquire(blocking=False)))
        t.start()
        t.join()
    assert took == [False]
