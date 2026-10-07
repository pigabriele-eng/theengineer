"""Errors nobody handled answer in words the app can show, with the CORS headers the browser needs to read them."""
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.testclient import TestClient
from sqlalchemy.exc import TimeoutError as PoolTimeout

from app.plain_errors import PlainErrors


def _app() -> FastAPI:
    app = FastAPI()
    app.add_middleware(PlainErrors)  # as in app.main: before CORS, so inside it
    app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

    @app.get("/broken")
    def broken():
        raise KeyError("speed")

    @app.get("/busy")
    def busy():
        raise PoolTimeout("QueuePool limit of size 5 overflow 5 reached")

    return app


def test_an_unhandled_error_answers_with_cors_headers():
    client = TestClient(_app(), raise_server_exceptions=False)
    r = client.get("/broken", headers={"Origin": "https://app.example"})
    assert r.status_code == 500
    assert r.headers["access-control-allow-origin"] == "*"  # without it the browser only says "Failed to fetch"
    assert "KeyError" in r.json()["detail"]


def test_no_free_database_connection_is_busy_not_broken():
    client = TestClient(_app(), raise_server_exceptions=False)
    r = client.get("/busy", headers={"Origin": "https://app.example"})
    assert r.status_code == 503 and r.headers["retry-after"] == "5"
    assert r.headers["access-control-allow-origin"] == "*"
    assert "busy" in r.json()["detail"]


def test_the_server_has_the_layer_inside_cors(client):
    from app.main import app

    names = [m.cls.__name__ for m in app.user_middleware]
    assert names.index("PlainErrors") > names.index("CORSMiddleware")  # later in the list: closer to the routes
