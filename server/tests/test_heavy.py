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
