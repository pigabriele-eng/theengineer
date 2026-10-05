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
    import app.routers.debriefs
    import app.routers.imports
    import app.routers.insights
    import app.routers.reports
    import app.routers.sessions
    import app.routers.trackmap
    import app.routers.tyres
    import app.routers.vehicle
    importlib.reload(app.db)
    importlib.reload(app.models)
    importlib.reload(app.routers.catalog)
    importlib.reload(app.routers.sessions)
    importlib.reload(app.routers.reports)
    importlib.reload(app.routers.imports)
    importlib.reload(app.routers.debriefs)
    importlib.reload(app.routers.insights)
    importlib.reload(app.routers.tyres)
    importlib.reload(app.routers.vehicle)
    importlib.reload(app.routers.trackmap)
    importlib.reload(app.main)
    if TEST_DATABASE_URL:
        app.db.Base.metadata.drop_all(app.db.engine)
    with TestClient(app.main.app) as c:
        yield c
        # imports and reports run in background threads: let them finish here, not in the next test's database
        deadline = time.monotonic() + 120
        while app.routers.imports._jobs.unfinished_tasks and time.monotonic() < deadline:
            time.sleep(0.05)
        app.routers.reports.wait_idle()
    app.db.engine.dispose()
