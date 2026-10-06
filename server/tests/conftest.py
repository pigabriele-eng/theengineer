import os
import time

import pytest
from fastapi.testclient import TestClient

# Set TEST_DATABASE_URL to a throwaway Postgres database to run the API tests against Postgres instead of SQLite
# (its tables are dropped before every test).
TEST_DATABASE_URL = os.environ.get("TEST_DATABASE_URL")


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("DATABASE_URL", TEST_DATABASE_URL or f"sqlite:///{tmp_path}/test.db")
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
    import app.garage
    importlib.reload(app.garage)
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
    import app.routers.event_naming
    importlib.reload(app.routers.event_naming)
    import app.routers.garage
    importlib.reload(app.routers.garage)
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
