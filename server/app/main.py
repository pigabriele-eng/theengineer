from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from sqlalchemy.exc import DataError, IntegrityError

from app import storage, timing
from app.auth import check_settings, require_user, require_user_or_query_token
from app.db import create_tables
from app.routers import catalog, debriefs, imports, insights, sessions, trackmap, tyres, vehicle
from app.routers import report_grip


@asynccontextmanager
async def lifespan(_: FastAPI):
    check_settings()
    create_tables()
    imports.fail_interrupted()
    storage.backend().setup()
    timing.check_all_tracks()  # in the background: logs timed from an older start/finish line are re-timed
    yield


app = FastAPI(title="The Engineer", lifespan=lifespan)
# Any origin: the app signs in with a bearer token, not cookies.
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])
signed_in = [Depends(require_user)]
for r in (catalog.router, sessions.router, imports.router, debriefs.router, insights.router, tyres.router,
          vehicle.router):
    app.include_router(r, dependencies=signed_in)
app.include_router(trackmap.router, dependencies=signed_in)
app.include_router(report_grip.router, dependencies=signed_in)
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
