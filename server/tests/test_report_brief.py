"""?brief=true on a report: only how far it is (status, progress), without the report, for a page that asks again
until it is ready (the app's run page)."""
from tests.test_events import _session, _track, _wait

HEAD = {"scope", "id", "title", "track", "status", "progress", "error", "stale"}


def test_a_brief_answer_is_the_status_without_the_report(client):
    _track(client)
    ev = client.post("/events/folders", json={"name": "Test day"}).json()
    sid = _session(client, ev["id"], "Run 1", (0.95, 0.96, 0.97))

    first = client.get(f"/reports/events/{ev['id']}?brief=true").json()
    assert set(first) == HEAD
    assert first["status"] in ("queued", "running", "ready")

    done = _wait(client, f"/reports/events/{ev['id']}?brief=true")
    assert set(done) == HEAD and done["status"] == "ready" and done["progress"] is None

    full = client.get(f"/reports/events/{ev['id']}").json()
    assert full["status"] == "ready" and full["report"] is not None and full["sessions"]
    assert {k: full[k] for k in HEAD} == done

    one = _wait(client, f"/reports/sessions/{sid}?brief=true")
    assert set(one) == HEAD and one["scope"] == "session" and one["id"] == sid
    assert client.get(f"/reports/sessions/{sid}").json()["report"] is not None
