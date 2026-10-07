"""?brief=true on a technique check: only how far it is (status, progress), without the check, for a page that asks
again until it is ready (the app's technique page)."""
from tests.synthetic import simulate, write_ld
from tests.test_technique import CORNERS, _wait

HEAD = {"scope", "id", "title", "track", "status", "progress", "error", "stale"}


def test_a_brief_answer_is_the_status_without_the_check(client):
    track = client.post("/tracks", json={"name": "Test ring", "corners": [
        {"code": code, "apex_m": at, "sector": sector} for code, at, sector in CORNERS]}).json()
    event = client.post("/events", json={"name": "Test day", "track_id": track["id"]}).json()
    s = client.post("/sessions", json={"event_id": event["id"], "name": "Run 1"}).json()
    r = client.post(f"/sessions/{s['id']}/files", files={"file": ("run.ld", write_ld(simulate(paces=(0.95, 0.97))[0]))})
    assert r.status_code == 201, r.text

    first = client.get(f"/technique/sessions/{s['id']}?brief=true").json()
    assert set(first) == HEAD and first["status"] in ("queued", "running", "ready")

    done = _wait(client, f"/technique/sessions/{s['id']}?brief=true")
    assert set(done) == HEAD and done["status"] == "ready" and done["progress"] is None
    full = client.get(f"/technique/sessions/{s['id']}").json()
    assert {k: full[k] for k in HEAD} == done and full["lap"] is not None

    ev = _wait(client, f"/technique/events/{event['id']}?brief=true")
    assert set(ev) == HEAD and ev["status"] == "ready"
    assert client.get(f"/technique/events/{event['id']}").json()["sessions"]
    assert client.get("/technique/sessions/9999?brief=true").status_code == 404
