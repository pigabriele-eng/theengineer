"""An event's mode, race weekend or coaching day (app/event_modes.py): set and read, listed with the folders, and
gone with the event."""
from sqlalchemy import select


def _folder(client, name: str) -> int:
    r = client.post("/events/folders", json={"name": name})
    assert r.status_code == 201, r.text
    return r.json()["id"]


def _rows(client) -> dict[int, str]:
    from app import db as app_db
    from app.event_modes import EventMode

    with app_db.SessionLocal() as db:
        return dict(db.execute(select(EventMode.event_id, EventMode.mode)).all())


def test_mode_is_a_weekend_until_set(client):
    a, b = _folder(client, "Hockenheim test"), _folder(client, "Client day")
    assert client.get(f"/events/{a}/mode").json() == {"mode": "weekend"}
    assert client.put(f"/events/{b}/mode", json={"mode": "coaching"}).json() == {"mode": "coaching"}
    assert client.get(f"/events/{b}/mode").json() == {"mode": "coaching"}
    assert client.put(f"/events/{b}/mode", json={"mode": "weekend"}).json() == {"mode": "weekend"}
    assert client.put(f"/events/{b}/mode", json={"mode": "coaching"}).status_code == 200
    assert _rows(client) == {b: "coaching"}  # one row per event, changed in place
    assert client.put(f"/events/{b}/mode", json={"mode": "holiday"}).status_code == 422
    assert client.get("/events/9999/mode").status_code == 404
    assert client.put("/events/9999/mode", json={"mode": "coaching"}).status_code == 404

    s = client.post("/sessions", json={"name": "Loose run"})  # a run in no event: the folder "none"
    assert s.status_code == 201, s.text
    folders = {f["key"]: f for f in client.get("/events/folders").json()}
    assert folders[str(a)]["mode"] == "weekend" and folders[str(b)]["mode"] == "coaching"
    assert folders["none"]["mode"] is None


def test_the_mode_goes_with_the_event(client):
    keep, full = _folder(client, "Folder only"), _folder(client, "With its runs")
    for event_id in (keep, full):
        client.put(f"/events/{event_id}/mode", json={"mode": "coaching"})
    assert client.delete(f"/events/{keep}").status_code == 200
    assert _rows(client) == {full: "coaching"}
    r = client.delete(f"/events/{full}", params={"runs": "delete"})
    assert r.status_code == 200, r.text
    assert r.json()["rows"].get("event_modes") == 1
    assert _rows(client) == {}
    new = _folder(client, "Next")  # SQLite may give it a deleted event's id: it starts as a weekend
    assert client.get(f"/events/{new}/mode").json() == {"mode": "weekend"}

    planned = client.post("/planned-events", json={"name": "Client day", "venue": "Circuit Zandvoort",
                                                   "start": "2026-11-02", "end": "2026-11-02"}).json()["id"]
    client.put(f"/events/{planned}/mode", json={"mode": "coaching"})
    assert client.delete(f"/planned-events/{planned}").status_code in (200, 204)
    assert _rows(client) == {}
