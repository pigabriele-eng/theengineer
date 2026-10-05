"""Sign-in with Supabase tokens, with Supabase Auth mocked."""
import httpx
import pytest

from app import auth

USERS = {"good-token": {"id": "u1", "email": "Driver@Example.com"},
         "other-token": {"id": "u2", "email": "someone@example.com"}}


@pytest.fixture()
def signed_in(client, monkeypatch):
    """The API with sign-in on; Supabase's GET /auth/v1/user answers from USERS."""
    calls = []

    def fake_get(url, headers=None, timeout=None):
        calls.append((url, headers))
        user = USERS.get(headers["Authorization"].removeprefix("Bearer "))
        return httpx.Response(200, json=user) if user else httpx.Response(401, json={"msg": "invalid JWT"})

    monkeypatch.setattr(auth.httpx, "get", fake_get)
    monkeypatch.setenv("SUPABASE_URL", "https://project.supabase.co")
    monkeypatch.setenv("SUPABASE_ANON_KEY", "anon-key")
    auth._cache.clear()
    yield client, calls
    auth._cache.clear()


def bearer(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


def test_every_request_needs_a_valid_token(signed_in):
    client, calls = signed_in
    assert client.get("/sessions").status_code == 401
    assert client.get("/sessions", headers=bearer("expired")).status_code == 401
    assert client.get("/sessions", headers={"Authorization": "good-token"}).status_code == 401  # not a bearer token
    assert client.post("/sessions", json={}).status_code == 401
    assert client.get("/sessions", headers=bearer("good-token")).status_code == 200
    assert client.get("/health").status_code == 200  # Render's health check signs in with nothing

    url, headers = calls[-1]
    assert url == "https://project.supabase.co/auth/v1/user"
    assert headers == {"Authorization": "Bearer good-token", "apikey": "anon-key"}


def test_valid_tokens_are_remembered_for_a_while(signed_in, monkeypatch):
    client, calls = signed_in
    for _ in range(3):
        assert client.get("/sessions", headers=bearer("good-token")).status_code == 200
    assert len(calls) == 1
    monkeypatch.setattr(auth, "TOKEN_TTL_S", 0.0)
    auth._cache.clear()
    for _ in range(2):
        client.get("/sessions", headers=bearer("good-token"))
    assert len(calls) == 3


def test_allowed_emails_keep_other_accounts_out(signed_in, monkeypatch):
    client, _ = signed_in
    monkeypatch.setenv("ALLOWED_EMAILS", " driver@example.com, coach@example.com ")
    assert client.get("/sessions", headers=bearer("good-token")).status_code == 200  # any case
    r = client.get("/sessions", headers=bearer("other-token"))
    assert r.status_code == 403


def test_recording_plays_with_the_token_in_its_url(signed_in):
    client, _ = signed_in
    auth_header = bearer("good-token")
    s = client.post("/sessions", json={}, headers=auth_header).json()
    d = client.post(f"/sessions/{s['id']}/debriefs/audio", files={"audio": ("debrief.m4a", b"fake audio")},
                    headers=auth_header).json()

    assert client.get(f"/debriefs/{d['id']}/audio").status_code == 401
    assert client.get(f"/debriefs/{d['id']}/audio?access_token=expired").status_code == 401
    r = client.get(f"/debriefs/{d['id']}/audio?access_token=good-token")
    assert r.status_code == 200 and r.content == b"fake audio"
    assert client.get(f"/debriefs/{d['id']}/audio", headers=auth_header).content == b"fake audio"
    # only the recording takes the token in the URL
    assert client.get(f"/debriefs/{d['id']}?access_token=good-token").status_code == 401
    assert client.get("/sessions?access_token=good-token").status_code == 401


def test_supabase_unreachable_is_not_a_sign_out(signed_in, monkeypatch):
    client, _ = signed_in

    def down(url, headers=None, timeout=None):
        raise httpx.ConnectError("no route to host")

    monkeypatch.setattr(auth.httpx, "get", down)
    assert client.get("/sessions", headers=bearer("good-token")).status_code == 503
    monkeypatch.setattr(auth.httpx, "get", lambda url, headers=None, timeout=None: httpx.Response(502))
    assert client.get("/sessions", headers=bearer("good-token")).status_code == 503


def test_browsers_may_send_the_token_from_another_origin(signed_in):
    client, _ = signed_in
    r = client.options("/sessions", headers={"Origin": "https://theengineer-web.onrender.com",
                                             "Access-Control-Request-Method": "GET",
                                             "Access-Control-Request-Headers": "authorization"})
    assert r.status_code == 200
    assert "authorization" in r.headers["access-control-allow-headers"].lower()
    r = client.get("/sessions", headers={"Origin": "https://theengineer-web.onrender.com"})
    assert r.status_code == 401 and r.headers["access-control-allow-origin"] == "*"  # the app can read the 401
