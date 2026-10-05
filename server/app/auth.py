"""Sign-in: every request carries the user's Supabase access token (Authorization: Bearer ...), checked with
Supabase Auth.

Off when SUPABASE_URL is not set (local development and the tests). ALLOWED_EMAILS, a comma-separated list,
lets only those accounts in. Tokens Supabase accepted are remembered for a minute, so analysis calls don't each
wait for Supabase.
"""
from __future__ import annotations

import hashlib
import os
import threading
import time

import httpx
from fastapi import Header, HTTPException, Query

TOKEN_TTL_S = 60.0
_MAX_CACHED = 1000
_cache: dict[str, tuple[float, dict]] = {}  # sha256 of the token -> (expires at, Supabase user)
_lock = threading.Lock()


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
        _cache[key] = (now + TOKEN_TTL_S, user)
    return user


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
