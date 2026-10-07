import gc
import json
import os
import shutil
import tempfile
import time
from functools import cache
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

# CI runs the suite in a few parallel jobs, each one part of the test files (pytest --shard 2/4 runs the second of
# four parts). The parts are made of whole files, so a file's module fixtures are built in one job only, and of about
# equal time by the seconds each file took (tests/durations.json; a file not in it counts as an average one).
# `pytest -n auto --store-durations` writes that table again after tests were added or got slower.
DURATIONS = Path(__file__).with_name("durations.json")


def pytest_addoption(parser):
    parser.addoption("--shard", metavar="I/N", help="run only part I of N (1 to N) of the test files")
    parser.addoption("--store-durations", action="store_true", help="write each file's seconds to tests/durations.json")


def _test_file(nodeid: str) -> str:
    return nodeid.split("::", 1)[0]


def split_files(files: list[str], seconds: dict[str, float], parts: int) -> list[list[str]]:
    """The files in `parts` parts of about equal time: the longest file first, each into the part with least time."""
    known = [seconds[f] for f in files if f in seconds]
    average = sum(known) / len(known) if known else 1.0
    load, split = [0.0] * parts, [[] for _ in range(parts)]
    for f in sorted(files, key=lambda f: (-seconds.get(f, average), f)):
        i = load.index(min(load))
        load[i] += seconds.get(f, average)
        split[i].append(f)
    return split


@pytest.hookimpl(trylast=True)
def pytest_collection_modifyitems(config, items):
    shard = config.getoption("shard")
    if not shard:
        return
    index, parts = (int(n) for n in shard.split("/"))
    if not 1 <= index <= parts:
        raise pytest.UsageError(f"--shard {shard}: the part goes from 1 to {parts}")
    seconds = json.loads(DURATIONS.read_text()) if DURATIONS.exists() else {}
    mine = set(split_files(sorted({_test_file(i.nodeid) for i in items}), seconds, parts)[index - 1])
    config.hook.pytest_deselected(items=[i for i in items if _test_file(i.nodeid) not in mine])
    items[:] = [i for i in items if _test_file(i.nodeid) in mine]


_file_seconds: dict[str, float] = {}


def pytest_runtest_logreport(report):
    _file_seconds[_test_file(report.nodeid)] = _file_seconds.get(_test_file(report.nodeid), 0.0) + report.duration


def pytest_sessionfinish(session):
    # with pytest-xdist the workers' reports all reach the main process, which writes the table
    if session.config.getoption("store_durations") and not hasattr(session.config, "workerinput"):
        DURATIONS.write_text(json.dumps({f: round(s, 1) for f, s in sorted(_file_seconds.items())}, indent=1) + "\n")


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
    monkeypatch.setenv("PREBUILD", "off")  # only its own tests turn it on (tests/test_prebuild.py)
    monkeypatch.setenv("RUN_DUPES", "off")  # the same sample log is uploaded many times; tests/test_run_dupes.py on
    monkeypatch.setenv("UPLOAD_DUPES", "off")  # likewise; tests/test_upload_dupes.py on
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
    import app.page_cache
    importlib.reload(app.page_cache)  # its table on the fresh database's metadata
    import app.garage
    importlib.reload(app.garage)
    importlib.reload(app.timing)
    importlib.reload(app.routers.catalog)
    importlib.reload(app.routers.sessions)
    importlib.reload(app.routers.reports)
    import app.lappacks
    importlib.reload(app.lappacks)
    import app.import_rates
    importlib.reload(app.import_rates)  # its table on the fresh database's metadata
    import app.upload_dupes
    importlib.reload(app.upload_dupes)  # its table on the fresh database's metadata
    importlib.reload(app.routers.imports)
    importlib.reload(app.routers.debriefs)
    importlib.reload(app.routers.drivers)
    importlib.reload(app.routers.insights)
    importlib.reload(app.routers.comparisons)
    importlib.reload(app.routers.lapcompare)
    importlib.reload(app.routers.tyres)
    importlib.reload(app.routers.vehicle)
    importlib.reload(app.routers.trackmap)
    import app.routers.trackshape
    importlib.reload(app.routers.trackshape)
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
    import app.driver_prints
    import app.routers.driver_style
    for m in (app.driver_prints, app.routers.driver_style):
        importlib.reload(m)
    import app.prep.models
    import app.prep.track_grip
    import app.prep.weather
    import app.routers.prep
    import app.routers.track_grip
    for m in (app.prep.models, app.prep.weather, app.prep.plan, app.prep.gather, app.routers.track_grip,
              app.prep.track_grip, app.routers.prep):
        importlib.reload(m)
    importlib.reload(app.main)
    if TEST_DATABASE_URL:
        app.db.Base.metadata.drop_all(app.db.engine)
    # The app runs gc.collect() after every log it reads (heavy.release_memory and the like), and each one went
    # through the whole app and its libraries (about 250,000 objects): close to half the tests' CPU time. What is
    # alive now is set aside where the collector doesn't look, and handed back to it when the test ends.
    gc.collect()
    gc.freeze()
    with TestClient(app.main.app) as c:
        yield c
        # imports and reports run in background threads: let them finish here, not in the next test's database
        deadline = time.monotonic() + 120
        while app.routers.imports._jobs.unfinished_tasks and time.monotonic() < deadline:
            time.sleep(0.05)
        import app.prebuild
        app.prebuild.wait_idle()  # first: it asks for everything else
        app.routers.prep.wait_idle()  # then: it asks for reports and technique checks
        app.routers.technique.wait_idle()  # then: it asks for reports
        app.lappacks.wait_idle()  # then: it may ask for reports
        app.routers.reports.wait_idle()
        app.driver_prints.wait_idle()
    app.db.engine.dispose()
    gc.unfreeze()
