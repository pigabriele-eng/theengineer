from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.db import Base, engine
from app.routers import catalog, debriefs, insights, sessions, tyres, vehicle


@asynccontextmanager
async def lifespan(_: FastAPI):
    Base.metadata.create_all(engine)
    yield


app = FastAPI(title="The Engineer", lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])
app.include_router(catalog.router)
app.include_router(sessions.router)
app.include_router(debriefs.router)
app.include_router(insights.router)
app.include_router(tyres.router)
app.include_router(vehicle.router)


@app.get("/health")
def health():
    return {"status": "ok"}
