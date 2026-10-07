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


def _small_pool(tmp_path):
    """A database with one connection and no wait for it: a second reader fails at once while the first holds it."""
    from sqlalchemy import Column, Integer, MetaData, Table, create_engine, insert
    from sqlalchemy.orm import sessionmaker

    import app.connections  # noqa: F401  (app.db imports it: the hand-back is registered)

    engine = create_engine(f"sqlite:///{tmp_path}/pool.db", pool_size=1, max_overflow=0, pool_timeout=0.2)
    rows = Table("rows", MetaData(), Column("id", Integer, primary_key=True))
    rows.metadata.create_all(engine)
    with engine.begin() as conn:
        conn.execute(insert(rows).values(id=1))
    return engine, rows, sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)


def test_a_request_waiting_for_the_lock_hands_its_database_connection_back(tmp_path):
    from sqlalchemy import select

    engine, rows, Session = _small_pool(tmp_path)
    read, waiting, done = [], threading.Event(), threading.Event()

    def request():
        with Session() as db:
            read.append(db.scalar(select(rows.c.id)))  # holds the only connection from here
            waiting.set()
            with lock:  # another log is being read: it waits, without the connection
                read.append(db.scalar(select(rows.c.id)))  # and takes one again
        done.set()

    with lock:
        t = threading.Thread(target=request)
        t.start()
        assert waiting.wait(5)
        deadline = time.monotonic() + 5
        while lock.waiting == 0 and time.monotonic() < deadline:
            time.sleep(0.01)
        assert engine.pool.checkedout() == 0
        with Session() as other:  # a request answered from what is kept still gets a connection
            assert other.scalar(select(rows.c.id)) == 1
    assert done.wait(5)
    t.join()
    assert read == [1, 1]


def test_a_request_with_writes_not_committed_keeps_its_connection(tmp_path):
    from sqlalchemy import func, insert, select

    engine, rows, Session = _small_pool(tmp_path)
    holding, release = threading.Event(), threading.Event()

    def request():
        with Session() as db:
            db.execute(insert(rows).values(id=2))  # written, not committed: never committed early
            holding.set()
            with lock:
                release.wait(5)
            db.rollback()

    with lock:
        t = threading.Thread(target=request)
        t.start()
        assert holding.wait(5)
        deadline = time.monotonic() + 5
        while lock.waiting == 0 and time.monotonic() < deadline:
            time.sleep(0.01)
        assert engine.pool.checkedout() == 1
    release.set()
    t.join()
    with Session() as db:
        assert db.scalar(select(func.count()).select_from(rows)) == 1  # the write was rolled back, as asked
