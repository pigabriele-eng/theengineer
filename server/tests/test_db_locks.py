import time

import pytest


def test_a_reader_never_holds_up_a_commit(client):
    """A request reading (a transaction open on its connection) while a background job commits: on SQLite, with
    write-ahead logging, the commit goes through at once, and the reader reads on (with the default journal both
    waited on each other until they gave up: "database is locked")."""
    from app import db as app_db, models

    if not app_db.DATABASE_URL.startswith("sqlite"):
        pytest.skip("Postgres never blocks a read on a write")
    raw = app_db.engine.raw_connection()
    try:
        cur = raw.cursor()
        cur.execute("BEGIN")
        cur.execute("SELECT count(*) FROM events").fetchall()  # the reader's snapshot, held open
        t0 = time.monotonic()
        with app_db.SessionLocal() as db:
            db.add(models.Event(name="Monza"))
            db.commit()
        assert time.monotonic() - t0 < 1
        assert cur.execute("SELECT count(*) FROM events").fetchone()[0] == 0  # still its own snapshot
        cur.execute("COMMIT")
        assert cur.execute("SELECT count(*) FROM events").fetchone()[0] == 1
    finally:
        raw.close()
