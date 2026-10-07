"""Errors nobody handled still answer in plain words, with the headers the app needs to read them.

An exception a page's request didn't handle used to reach the server's outermost layer, which answers 500 without
the cross-origin (CORS) headers: the browser then hides the answer and the app only sees "Failed to fetch", as if
the server were unreachable. This layer sits inside the CORS one, so the answer keeps its headers: the app gets
{"detail": ...} it can show, 503 when the server is only busy (no database connection free in time: worth asking
again in a moment) and 500 otherwise; the error then goes on to the server, which logs it with its traceback.
"""
from __future__ import annotations

from sqlalchemy.exc import TimeoutError as PoolTimeout
from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Message, Receive, Scope, Send

BUSY = "The server is busy working out other figures; asking again in a moment."
RETRY_AFTER_S = 5


def answer_for(e: Exception) -> tuple[int, str, dict[str, str]]:
    if isinstance(e, PoolTimeout):
        return 503, BUSY, {"Retry-After": str(RETRY_AFTER_S)}
    return 500, f"The server ran into a problem working this out ({type(e).__name__}); it has been logged.", {}


class PlainErrors:
    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        started = False

        async def sending(message: Message) -> None:
            nonlocal started
            if message["type"] == "http.response.start":
                started = True
            await send(message)

        try:
            await self.app(scope, receive, sending)
        except Exception as e:
            if not started:  # else part of the answer is out already: nothing else can be said
                status, detail, headers = answer_for(e)
                await JSONResponse({"detail": detail}, status, headers=headers)(scope, receive, send)
            raise  # on to the server, which logs it with its traceback (the answer is sent: nothing more goes out)
