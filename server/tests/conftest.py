import os
import shutil
import tempfile
import time
from functools import cache

import pytest
from fastapi.testclient import TestClient

# Set TEST_DATABASE_URL to a throwaway Postgres database to run the API tests against Postgres instead of SQLite
# (its tables are dropped before every test).
TEST_DATABASE_URL = os.environ.get("TEST_DATABASE_URL")

# The tests run in parallel with pytest-xdist (pytest -n auto): each worker is a process of its own, with its own
# reloaded modules, and every test gets its own SQLite database and storage folder under its tmp_path (a folder per
# worker). On Postgres each worker works in a schema of its own in the throwaway database.
_worker_dir: str | None = None


def pytest_configure(config):
    """Anything that reaches the database or storage outside the client fixture lands in this worker's own folder,
    never in ./theengineer.db or ./storage, nor in a database DATABASE_URL points at."""
    global _worker_dir
    worker = getattr(config, "workerinput", {}).get("workerid", "main")
    _worker_dir = tempfile.mkdtemp(prefix=f"theengineer-tests-{worker}-")
    os.environ["DATABASE_URL"] = f"sqlite:///{_worker_dir}/test.db"
    os.environ["STORAGE_DIR"] = os.path.join(_worker_dir, "storage")


def pytest_unconfigure(config):
    if _worker_dir:
        shutil.rmtree(_worker_dir, ignore_errors=True)


@cache
def _test_database_url() -> str:
    worker = os.environ.get("PYTEST_XDIST_WORKER")
    if not worker:
        return TEST_DATABASE_URL
    from sqlalchemy import create_engine, text

    from app.db import database_url

    engine = create_engine(database_url(TEST_DATABASE_URL))
    with engine.begin() as conn:
        conn.execute(text(f'CREATE SCHEMA IF NOT EXISTS "{worker}"'))
    engine.dispose()
    return f"{TEST_DATABASE_URL}{'&' if '?' in TEST_DATABASE_URL else '?'}options=-csearch_path%3D{worker}"


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("DATABASE_URL", _test_database_url() if TEST_DATABASE_URL else f"sqlite:///{tmp_path}/test.db")
    monkeypatch.setenv("STORAGE_DIR", str(tmp_path / "storage"))
    for key in ("DEEPGRAM_API_KEY", "ANTHROPIC_API_KEY", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY",
                "ALLOWED_EMAILS"):
        monkeypatch.delenv(key, raising=False)  # sign-in off, files on the local disk
    import importlib

    import app.db
    import app.main
    import app.routers.balance
    import app.routers.comparisons
    import app.routers.debriefs
    import app.routers.drivers
    import app.routers.imports
    import app.routers.insights
    import app.routers.lapcompare
    import app.routers.reports
    import app.routers.sessions
    import app.routers.setups
    import app.routers.trackmap
    import app.routers.tyres
    import app.routers.vehicle
    import app.timing
    importlib.reload(app.db)
    importlib.reload(app.models)
    importlib.reload(app.timing)
    importlib.reload(app.routers.catalog)
    importlib.reload(app.routers.sessions)
    importlib.reload(app.routers.reports)
    importlib.reload(app.routers.imports)
    importlib.reload(app.routers.debriefs)
    importlib.reload(app.routers.drivers)
    importlib.reload(app.routers.insights)
    importlib.reload(app.routers.comparisons)
    importlib.reload(app.routers.lapcompare)
    importlib.reload(app.routers.tyres)
    importlib.reload(app.routers.vehicle)
    importlib.reload(app.routers.trackmap)
    importlib.reload(app.routers.balance)
    import app.routers.technique
    importlib.reload(app.routers.technique)
    import app.routers.events
    importlib.reload(app.routers.events)
    import app.setup.data
    import app.setup.models
    import app.setup.results
    import app.setup.sheet
    import app.setup.suggest
    for m in (app.setup.models, app.setup.results, app.setup.sheet, app.setup.suggest, app.setup.data,
              app.routers.setups):
        importlib.reload(m)
    import app.laptags
    import app.routers.stint
    for m in (app.laptags, app.routers.stint):
        importlib.reload(m)
    importlib.reload(app.main)
    if TEST_DATABASE_URL:
        app.db.Base.metadata.drop_all(app.db.engine)
    with TestClient(app.main.app) as c:
        yield c
        # imports and reports run in background threads: let them finish here, not in the next test's database
        deadline = time.monotonic() + 120
        while app.routers.imports._jobs.unfinished_tasks and time.monotonic() < deadline:
            time.sleep(0.05)
        app.routers.technique.wait_idle()  # first: it asks for reports
        app.routers.reports.wait_idle()
    app.db.engine.dispose()
