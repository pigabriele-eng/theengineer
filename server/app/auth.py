"""Sign-in: every request carries the user's Supabase access token (Authorization: Bearer ...), checked with
Supabase Auth.

Off when SUPABASE_URL is not set (local development and the tests). ALLOWED_EMAILS, a comma-separated list,
lets only those accounts in. Tokens Supabase accepted are remembered for a few minutes, so analysis calls don't each
wait for Supabase; a page's requests sent together with a token not yet remembered ask Supabase once between them.
"""
from __future__ import annotations

import base64
import hashlib
import json
import os
import threading
import time

import httpx
from fastapi import Header, HTTPException, Query

TOKEN_TTL_S = 300.0
_MAX_CACHED = 1000
_cache: dict[str, tuple[float, dict]] = {}  # sha256 of the token -> (expires at, Supabase user)
_lock = threading.Lock()
_asking: dict[str, threading.Lock] = {}  # sha256 of the token -> held while Supabase is asked about it


def _bearer(authorization: str | None) -> str | None:
    scheme, _, token = (authorization or "").partition(" ")
    if scheme.lower() != "bearer":
        return None
    return token.strip() or None


def _supabase_user(url: str, token: str) -> dict:
    key = hashlib.sha256(token.encode()).hexdigest()
    now = time.monotonic()
    hit = _cache.get(key)
    if hit is not None and hit[0] > now:
        return hit[1]
    with _lock:
        asking = _asking.setdefault(key, threading.Lock())
    with asking:  # the page's other requests wait for this one's answer rather than each asking Supabase
        hit = _cache.get(key)
        if hit is not None and hit[0] > time.monotonic():
            return hit[1]
        try:
            return _ask(url, token, key)
        finally:
            with _lock:
                _asking.pop(key, None)


def _ask(url: str, token: str, key: str) -> dict:
    now = time.monotonic()
    try:
        r = httpx.get(f"{url.rstrip('/')}/auth/v1/user", timeout=10,
                      headers={"Authorization": f"Bearer {token}", "apikey": os.environ.get("SUPABASE_ANON_KEY", "")})
    except httpx.HTTPError as e:
        raise HTTPException(503, "Couldn't reach the sign-in service; try again in a moment") from e
    if r.status_code >= 500:
        raise HTTPException(503, "The sign-in service isn't answering; try again in a moment")
    if r.status_code != 200:
        raise HTTPException(401, "Sign in again", headers={"WWW-Authenticate": "Bearer"})
    user = r.json()
    with _lock:
        if len(_cache) >= _MAX_CACHED:
            for k in [k for k, (expires, _) in _cache.items() if expires <= now] or list(_cache):
                del _cache[k]
        _cache[key] = (now + min(TOKEN_TTL_S, _left(token)), user)
    return user


def _left(token: str) -> float:
    """Seconds until the token runs out, from its own exp (already checked by Supabase); TOKEN_TTL_S if unreadable."""
    try:
        part = token.split(".")[1]
        exp = float(json.loads(base64.urlsafe_b64decode(part + "=" * (-len(part) % 4)))["exp"])
    except (IndexError, KeyError, TypeError, ValueError):
        return TOKEN_TTL_S
    return max(exp - time.time(), 0.0)


def _check(token: str | None) -> dict | None:
    url = os.environ.get("SUPABASE_URL")
    if not url:
        return None
    if not token:
        raise HTTPException(401, "Not signed in", headers={"WWW-Authenticate": "Bearer"})
    user = _supabase_user(url, token)
    allowed = {e.strip().lower() for e in os.environ.get("ALLOWED_EMAILS", "").split(",") if e.strip()}
    if allowed and (user.get("email") or "").lower() not in allowed:
        raise HTTPException(403, "This account doesn't have access to The Engineer")
    return user


def check_settings() -> None:
    """Fail at startup rather than turn every sign-in away."""
    if os.environ.get("SUPABASE_URL") and not os.environ.get("SUPABASE_ANON_KEY"):
        raise RuntimeError("SUPABASE_URL is set but SUPABASE_ANON_KEY isn't, so sign-in tokens can't be checked")


def require_user(authorization: str | None = Header(None)) -> dict | None:
    """The signed-in Supabase user (None when sign-in is off)."""
    return _check(_bearer(authorization))


def require_user_or_query_token(authorization: str | None = Header(None),
                                access_token: str | None = Query(None)) -> dict | None:
    """The same, also taking the token as ?access_token= for media the app plays by URL."""
    return _check(_bearer(authorization) or access_token)
