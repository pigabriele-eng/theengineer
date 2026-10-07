from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from sqlalchemy.exc import DataError, IntegrityError

from app import calendar_sync, driver_prints, empty_runs, event_delete, prebuild, run_delete, storage, timing
from app.auth import check_settings, require_user, require_user_or_query_token
from app.db import create_tables
from app.routers import catalog, debriefs, imports, insights, sessions, trackmap, tyres, vehicle
from app.routers import balance as report_balance
from app.routers import comparisons, drivers, lapcompare, report_grip, reports, setups, tyre_model, tyreprep
from app.routers import event_naming, events, garage, planned, technique
from app.routers import prep as prep_report
from app.routers import stint as stint_tool
from app.routers import track_grip, trackshape
from app.routers import driver_style
from app.vehicle import tyre_store
from app import results

results.bind_models()  # before the results modules below use its tables
from app.results import sync as results_sync  # noqa: E402
from app.routers import results as series_results  # noqa: E402
from app import catalog as vehicle_lists, seasons  # noqa: E402

seasons.bind_models()  # their tables on the current database's metadata (the tests load a fresh one each time)
from app import season_match  # noqa: E402

season_match.bind_models()


@asynccontextmanager
async def lifespan(_: FastAPI):
    check_settings()
    create_tables()
    imports.fail_interrupted()
    storage.backend().setup()
    timing.check_all_tracks()  # in the background: logs timed from an older start/finish line are re-timed
    empty_runs.start()  # in the background: imported runs with no laps (pit-lane logs) are removed
    tyre_store.start()  # summarises logs for the tyre model in the background, older ones first
    calendar_sync.start()  # reads the racing calendar now and then, for planned events
    results_sync.start_background()  # official series results: missing seasons, and current events kept fresh
    season_match.start()  # in the background: events with data and no season join theirs, or a question is kept
    prebuild.start()  # in the background, last: the pages of every event worked out where missing or out of date
    driver_prints.start()  # a little later: driver fingerprints of events that have none yet
    yield
    tyre_store.stop()
    calendar_sync.stop()


app = FastAPI(title="The Engineer", lifespan=lifespan)
# Any origin: the app signs in with a bearer token, not cookies.
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])
app.middleware("http")(tyre_store.track_requests)  # the tyre data job waits for a quiet moment
signed_in = [Depends(require_user)]
for r in (catalog.router, sessions.router, imports.router, debriefs.router, insights.router, tyres.router,
          vehicle.router):
    app.include_router(r, dependencies=signed_in)
app.include_router(trackmap.router, dependencies=signed_in)
app.include_router(trackshape.router, dependencies=signed_in)
app.include_router(report_grip.router, dependencies=signed_in)
app.include_router(report_balance.router, dependencies=signed_in)
app.include_router(setups.router, dependencies=signed_in)
app.include_router(tyreprep.router, dependencies=signed_in)
for r in (drivers.router, comparisons.router):
    app.include_router(r, dependencies=signed_in)
app.include_router(lapcompare.router, dependencies=signed_in)
app.include_router(reports.router, dependencies=signed_in)
app.include_router(tyre_model.router, dependencies=signed_in)
app.include_router(technique.router, dependencies=signed_in)
app.include_router(events.router, dependencies=signed_in)
app.include_router(planned.router, dependencies=signed_in)
app.include_router(event_naming.router, dependencies=signed_in)
app.include_router(stint_tool.router, dependencies=signed_in)
app.include_router(driver_style.router, dependencies=signed_in)
app.include_router(prep_report.router, dependencies=signed_in)
app.include_router(series_results.router, dependencies=signed_in)
app.include_router(garage.router, dependencies=signed_in)
app.include_router(vehicle_lists.router, dependencies=signed_in)
app.include_router(seasons.router, dependencies=signed_in)
app.include_router(season_match.router, dependencies=signed_in)
app.include_router(track_grip.router, dependencies=signed_in)
app.include_router(event_delete.router, dependencies=signed_in)
app.include_router(run_delete.router, dependencies=signed_in)
app.include_router(prebuild.router, dependencies=signed_in)
app.include_router(debriefs.media_router, dependencies=[Depends(require_user_or_query_token)])


# Postgres checks what SQLite lets through: links to records that don't exist and text longer than its column.
@app.exception_handler(IntegrityError)
def _conflict(_: Request, e: IntegrityError):
    return JSONResponse({"detail": "That refers to a record that doesn't exist, or duplicates one that does"}, 409)


@app.exception_handler(DataError)
def _bad_value(_: Request, e: DataError):
    return JSONResponse({"detail": f"A value doesn't fit: {str(e.orig).splitlines()[0]}"}, 422)


@app.exception_handler(storage.StorageError)
def _storage_failed(_: Request, e: storage.StorageError):
    return JSONResponse({"detail": f"File storage failed: {e}"}, 502)


@app.get("/health")
def health():
    return {"status": "ok"}
