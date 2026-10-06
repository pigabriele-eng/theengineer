"""Naming the events an upload made, and putting a zip's sessions into the race weekend they belong to, so a weekend
uploaded as several zips ends up in one event."""
from functools import cache

import pytest

from app.routers.event_naming import suggest
from tests.synthetic import simulate, write_ld
from tests.test_imports import make_zip, upload


@cache
def log(event: str = "GT4_ES_R05", venue: str = "Zandvoort", day: str = "19/09/2026") -> bytes:
    """A synthetic log with the header's event name, venue (at most 10 characters) and day given."""
    data = write_ld(simulate(paces=(0.97, 0.98))[0], event=event)
    return (data.replace(b"Test Track", venue.encode().ljust(10, b"\x00"), 1)
            .replace(b"03/07/2026", day.encode(), 1))


def weekend_zip(folder: str, **header) -> tuple[str, bytes]:
    return f"{folder}.zip", make_zip({f"{folder}/a.ld": log(**header), f"{folder}/b.ld": log(**header)})


def made(client, job) -> list[dict]:
    r = client.get(f"/imports/{job['id']}/events")
    assert r.status_code == 200, r.text
    return r.json()["events"]


def test_a_new_event_gets_a_name_from_its_logs_and_the_next_zip_joins_it(client):
    job = upload(client, weekend_zip("03_Q"))
    (quali,) = made(client, job)
    assert quali["name"] == "03_Q" and quali["zip"] == "03_Q"  # named after the zip until it is named
    assert quali["suggested_name"] == "GT4_ES_R05 Zandvoort"
    assert (quali["venue"], quali["log_event"]) == ("Zandvoort", "GT4_ES_R05")
    assert (quali["start"], quali["end"], quali["sessions"]) == ("2026-09-19", "2026-09-19", 2)
    assert quali["matches"] == []
    r = client.patch(f"/events/{quali['id']}", json={"name": quali["suggested_name"]})
    assert r.status_code == 200 and r.json()["name"] == "GT4_ES_R05 Zandvoort"

    job2 = upload(client, weekend_zip("04_R1"))
    (race1,) = made(client, job2)
    assert race1["name"] == "04_R1"
    (match,) = race1["matches"]
    assert (match["id"], match["name"], match["why"]) == (quali["id"], "GT4_ES_R05 Zandvoort", "event")

    r = client.post(f"/events/{race1['id']}/merge", json={"into": quali["id"]})
    assert r.status_code == 200, r.text
    assert sorted(r.json()["moved"]) == sorted(job2["session_ids"])
    assert r.json()["into"]["sessions"] == 4
    assert made(client, job2) == []  # its event is gone: nothing left to name
    folders = client.get("/events/folders").json()
    assert [f["name"] for f in folders] == ["GT4_ES_R05 Zandvoort"]
    assert client.get(f"/events/{race1['id']}").status_code == 404


def test_the_same_venue_on_the_next_day_is_the_same_weekend(client):
    first = made(client, upload(client, weekend_zip("04_R1")))[0]
    # no event name in the header: named after the zip, matched by venue and back-to-back days
    (sunday,) = made(client, upload(client, weekend_zip("05_R2", event="", day="20/09/2026")))
    assert sunday["suggested_name"] == "05_R2"
    assert [(m["id"], m["why"]) for m in sunday["matches"]] == [(first["id"], "dates")]
    # another venue, or the same venue a week later, isn't
    (elsewhere,) = made(client, upload(client, weekend_zip("R1_SPA", event="", venue="Spa")))
    assert elsewhere["matches"] == [] and elsewhere["suggested_name"] == "R1_SPA"
    (later,) = made(client, upload(client, weekend_zip("R1_LATER", event="GT4_ES_R06", day="27/09/2026")))
    assert later["matches"] == []


def test_one_upload_of_several_zips_offers_each_the_others(client):
    job = upload(client, weekend_zip("03_Q"), weekend_zip("04_R1"))
    q, r1 = made(client, job)
    assert (q["zip"], r1["zip"]) == ("03_Q", "04_R1")
    assert [m["id"] for m in q["matches"]] == [r1["id"]] and [m["id"] for m in r1["matches"]] == [q["id"]]
    client.post(f"/events/{r1['id']}/merge", json={"into": q["id"]})
    (left,) = made(client, job)
    assert left["id"] == q["id"] and left["matches"] == [] and left["sessions"] == 4


def test_uploads_into_a_picked_event_or_loose_logs_make_nothing_to_name(client):
    ev = client.post("/events/folders", json={"name": "Zandvoort weekend"}).json()
    r = client.post("/imports", files=[("files", weekend_zip("03_Q"))], data={"event_id": str(ev["id"])})
    assert r.status_code == 202
    loose = upload(client, ("loose.ld", log()))  # one import at a time: the picked one is done by now
    into = client.get(f"/imports/{r.json()['id']}").json()
    assert into["status"] == "done" and len(into["session_ids"]) == 2
    assert made(client, into) == [] and made(client, loose) == []
    assert client.get("/imports/999/events").status_code == 404


def test_merging_widens_dates_set_by_hand_and_checks_its_target(client):
    ev = client.post("/events/folders", json={"name": "Zandvoort", "start": "2026-09-18",
                                              "end": "2026-09-19"}).json()
    (sunday,) = made(client, upload(client, weekend_zip("05_R2", day="20/09/2026")))
    assert [(m["id"], m["why"]) for m in sunday["matches"]] == []  # an empty event has no venue yet
    assert client.post(f"/events/{sunday['id']}/merge", json={"into": sunday["id"]}).status_code == 422
    assert client.post(f"/events/{sunday['id']}/merge", json={"into": 9999}).status_code == 404
    r = client.post(f"/events/{sunday['id']}/merge", json={"into": ev["id"]})
    assert r.status_code == 200, r.text
    into = r.json()["into"]
    assert (into["start"], into["end"], into["dates_by_hand"]) == ("2026-09-18", "2026-09-20", True)
    assert into["track"] == "Zandvoort"  # the track of the logs it gained


@pytest.mark.parametrize(("event", "venue", "name"), [
    ("GT4_ES_R05", "Zandvoort", "GT4_ES_R05 Zandvoort"),
    ("2025 GT4GER T02 HOC", "Hockenheimring", "2025 GT4GER T02 HOC Hockenheimring"),
    ("GT4 Zandvoort R5", "Zandvoort", "GT4 Zandvoort R5"),  # the venue once
    ("GT4_ES_R05", None, "GT4_ES_R05"),
    (None, "Zandvoort", "03_Q"),  # no event name: the zip's
])
def test_suggested_names(event, venue, name):
    assert suggest(event, venue, "03_Q") == name
