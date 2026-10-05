import pytest
from fastapi.testclient import TestClient


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{tmp_path}/test.db")
    monkeypatch.setenv("STORAGE_DIR", str(tmp_path / "storage"))
    monkeypatch.delenv("DEEPGRAM_API_KEY", raising=False)
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    import importlib

    import app.db
    import app.main
    import app.routers.debriefs
    import app.routers.insights
    import app.routers.sessions
    import app.routers.tyres
    importlib.reload(app.db)
    importlib.reload(app.models)
    importlib.reload(app.routers.catalog)
    importlib.reload(app.routers.sessions)
    importlib.reload(app.routers.debriefs)
    importlib.reload(app.routers.insights)
    importlib.reload(app.routers.tyres)
    importlib.reload(app.main)
    with TestClient(app.main.app) as c:
        yield c
