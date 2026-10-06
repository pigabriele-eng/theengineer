"""Events as folders: dates and sessions by day, moving sessions between events (and what that does to the event's
report), uploads into a picked event, and sessions side by side from the report's compact lap traces."""
import time
from functools import cache

import numpy as np
import pytest

from app.analysis import compact
from app.analysis.laps import load_session
from app.analysis.side_by_side import best_index, reference_of, summarise
from app.importers.motec import read_ld
from tests.synthetic import simulate, write_ld
from tests.test_imports import make_zip, upload

CORNERS = [("T1", 300, None), ("T2", 700, None)]  # the synthetic track's two corners, as official numbers


@cache
def log(paces: tuple[float, ...], day: str = "03/07/2026", at: str = "12:00:00") -> bytes:
    """A synthetic log recorded on the day and at the time given (dd/mm/yyyy, HH:MM:SS: same width as the header's)."""
    data = write_ld(simulate(paces=paces)[0])
    return data.replace(b"03/07/2026", day.encode(), 1).replace(b"12:00:00", at.encode(), 1)


def _track(client):
    return client.post("/tracks", json={"name": "Test Track", "corners": [
        {"code": c, "apex_m": m, "sector": s} for c, m, s in CORNERS]}).json()


def _session(client, event_id, name, paces, day="03/07/2026", at="12:00:00"):
    s = client.post("/sessions", json={"event_id": event_id, "name": name}).json()
    r = client.post(f"/sessions/{s['id']}/files", files={"file": ("run.ld", log(paces, day, at))})
    assert r.status_code == 201, r.text
    return s["id"]


def _wait(client, url, timeout=120):
    t0 = time.monotonic()
    while time.monotonic() - t0 < timeout:
        body = client.get(url).json()
        if body["status"] not in ("queued", "running", "working"):
            return body
        time.sleep(0.2)
    raise AssertionError(f"{url} still working after {timeout} s")


def test_an_event_folder_holds_its_sessions_by_day(client):
    _track(client)
    ev = client.post("/events/folders", json={"name": "Race weekend"}).json()
    assert ev["sessions"] == 0 and ev["days"] == [] and ev["start"] is None
    sunday = _session(client, ev["id"], "Race", (0.97, 0.98), "05/07/2026", "14:00:00")
    fp1 = _session(client, ev["id"], "FP1", (0.95, 0.96, 0.97), "03/07/2026", "10:30:00")
    fp2 = _session(client, ev["id"], "FP2", (0.99, 1.0), "03/07/2026", "15:00:00")
    client.post("/sessions", json={"event_id": ev["id"], "name": "Notes only"})

    body = client.get(f"/events/{ev['id']}").json()
    assert [d["date"] for d in body["days"]] == ["2026-07-03", "2026-07-05", None]
    assert [s["id"] for s in body["days"][0]["sessions"]] == [fp1, fp2]  # through the day
    assert [s["name"] for s in body["days"][2]["sessions"]] == ["Notes only"]
    first = body["days"][0]["sessions"][0]
    assert first["time"] == "10:30" and first["laps"] == first["clean_laps"] == 3
    assert first["best_lap_s"] == pytest.approx(min(simulate(paces=(0.95, 0.96, 0.97))[1][1:4]), abs=0.02)
    # dates from the logs, the best lap of the event, the track from the logs
    assert (body["start"], body["end"], body["dates_by_hand"]) == ("2026-07-03", "2026-07-05", False)
    assert body["best_session_id"] == fp2 and body["sessions"] == 4 and body["track"] == "Test Track"

    (listed,) = client.get("/events/folders").json()
    assert listed["id"] == ev["id"] and listed["start"] == "2026-07-03" and listed["best_session_id"] == fp2
    assert sunday in [s["id"] for d in body["days"] for s in d["sessions"]]


def test_events_are_renamed_redated_and_deleted_keeping_their_sessions(client):
    ev = client.post("/events/folders", json={"name": "Test", "start": "2026-07-03", "end": "2026-07-05"}).json()
    assert (ev["start"], ev["end"], ev["dates_by_hand"]) == ("2026-07-03", "2026-07-05", True)
    sid = _session(client, ev["id"], "Run 1", (0.97, 0.98), "04/07/2026")
    r = client.patch(f"/events/{ev['id']}", json={"name": "  Hockenheim test  ", "end": "2026-07-06"})
    assert r.status_code == 200 and r.json()["name"] == "Hockenheim test" and r.json()["end"] == "2026-07-06"
    assert client.patch(f"/events/{ev['id']}", json={"start": "2026-07-09"}).status_code == 422  # after the end
    assert client.patch(f"/events/{ev['id']}", json={"name": "   "}).status_code == 422
    back = client.patch(f"/events/{ev['id']}", json={"start": None, "end": None}).json()  # from the logs again
    assert (back["start"], back["end"], back["dates_by_hand"]) == ("2026-07-04", "2026-07-04", False)
    assert client.get("/events").json()[0]["date"] == "2026-07-04"

    other = client.post("/events/folders", json={"name": "Elsewhere"}).json()
    r = client.delete(f"/events/{ev['id']}")
    assert r.status_code == 200 and r.json()["sessions_kept"] == [sid]
    assert client.get(f"/events/{ev['id']}").status_code == 404
    folders = client.get("/events/folders").json()
    assert folders[0]["key"] == "none" and folders[0]["sessions"] == 1  # the loose sessions come first
    assert [f["id"] for f in folders[1:]] == [other["id"]]
    loose = client.get("/events/none").json()
    assert [s["id"] for d in loose["days"] for s in d["sessions"]] == [sid]
    assert client.get(f"/sessions/{sid}").json()["event_id"] is None


def test_a_session_gets_a_label_and_a_kind(client):
    ev = client.post("/events/folders", json={"name": "Weekend"}).json()
    s = client.post("/sessions", json={"event_id": ev["id"], "name": "01_D1S1"}).json()
    r = client.patch(f"/sessions/{s['id']}", json={"name": "FP1", "kind": "practice"})
    assert r.status_code == 200 and (r.json()["name"], r.json()["kind"]) == ("FP1", "practice")
    assert client.patch(f"/sessions/{s['id']}", json={"name": " "}).status_code == 422
    assert client.patch(f"/sessions/{s['id']}", json={"kind": "sprint"}).status_code == 422
    assert client.patch(f"/sessions/{s['id']}", json={"event_id": 999}).status_code == 404
    assert client.get(f"/sessions/{s['id']}").json()["name"] == "FP1"  # a refused move changes nothing
    assert client.patch("/sessions/999", json={"name": "x"}).status_code == 404


def test_moving_a_session_takes_it_out_of_its_old_events_report(client):
    _track(client)
    a = client.post("/events/folders", json={"name": "Day one"}).json()
    b = client.post("/events/folders", json={"name": "Day two"}).json()
    keep = _session(client, a["id"], "Run 1", (0.95, 0.96, 0.97))
    moved = _session(client, a["id"], "Run 2", (0.98, 0.99, 1.0))
    before = _wait(client, f"/reports/events/{a['id']}")
    assert before["status"] == "ready" and before["report"]["runs_analysed"] == 2

    r = client.post(f"/events/{b['id']}/sessions", json={"session_ids": [moved]})
    assert r.status_code == 200 and [s["id"] for d in r.json()["days"] for s in d["sessions"]] == [moved]
    assert r.json()["track"] == "Test Track"  # the event took the track its logs were driven at
    # the old event's report lists only the session it still holds at once, and is worked out again without the other
    now = client.get(f"/reports/events/{a['id']}").json()
    assert [s["id"] for s in now["sessions"]] == [keep]
    after = _wait(client, f"/reports/events/{a['id']}")
    assert after["status"] == "ready" and not after["stale"]
    assert after["report"]["runs_analysed"] == 1 and after["report"]["trends"]["runs"][0]["session_id"] == keep
    other = _wait(client, f"/reports/events/{b['id']}")
    assert other["status"] == "ready" and other["report"]["trends"]["runs"][0]["session_id"] == moved

    # moved back and out again, several at once and one by one
    client.post(f"/events/{a['id']}/sessions", json={"session_ids": [moved, keep]})
    assert client.get(f"/events/{b['id']}").json()["sessions"] == 0
    r = client.patch(f"/sessions/{moved}", json={"event_id": None})
    assert r.status_code == 200 and r.json()["event_id"] is None
    assert client.post("/events/none/sessions", json={"session_ids": [keep, 999]}).status_code == 404
    assert client.post("/events/abc/sessions", json={"session_ids": [keep]}).status_code == 404


def test_sessions_side_by_side_from_the_report_traces(client):
    _track(client)
    ev = client.post("/events/folders", json={"name": "Weekend"}).json()
    fri = _session(client, ev["id"], "FP1", (0.95, 0.96, 0.97), "03/07/2026", "10:00:00")
    sun = _session(client, ev["id"], "Race", (0.99, 1.0, 0.98), "05/07/2026", "14:00:00")
    url = f"/events/{ev['id']}/compare?sessions={fri},{sun}"
    first = client.get(url).json()
    if first["status"] == "working":  # the traces aren't made yet: lap times now, sections when the report has read
        assert first["sections"] == [] and first["sessions"][0]["best_lap_s"] is not None
    body = _wait(client, url)
    assert body["status"] == "ready" and body["numbering"] == "official"
    assert [s["id"] for s in body["sessions"]] == [fri, sun] and body["track"] == "Test Track"
    assert [s["code"] for s in body["sections"]] == ["T1", "T2"]
    fp1, race = body["sessions"]
    assert race["best_lap_s"] < fp1["best_lap_s"]
    for s in body["sessions"]:
        assert s["state"] == "ready" and s["top_speed_kmh"] > 100
        assert s["ideal_s"] <= s["best_lap_s"] + 0.05
    assert all(sec["best"] == 1 for sec in body["sections"])  # the race is quicker everywhere
    assert body["reference"]["session_id"] == sun

    # the same sections and best times as the event's report
    report = _wait(client, f"/reports/events/{ev['id']}")["report"]
    for sec, rep in zip(body["sections"], report["sections"], strict=True):
        assert (sec["code"], sec["start_m"], sec["end_m"]) == (rep["code"], rep["start_m"], rep["end_m"])
        assert min(sec["times"]) == pytest.approx(rep["times"]["best"], abs=0.002)

    assert client.get(f"/events/{ev['id']}/compare?sessions={fri}").status_code == 422
    assert client.get(f"/events/{ev['id']}/compare?sessions=a,b").status_code == 422
    loose = client.post("/sessions", json={"name": "Elsewhere"}).json()
    assert client.get(f"/events/{ev['id']}/compare?sessions={fri},{loose['id']}").status_code == 404


def test_side_by_side_sections_match_the_report_engine():
    runs = [compact.reduce_session(load_session(read_ld(log(p))), n) for n, p in
            (("a", (0.95, 0.96, 0.97)), ("b", (0.99, 1.0, 0.98)))]
    ref = reference_of(2, runs[1], CORNERS)
    prep, _ = compact.prepare_compact([(1, runs[0]), (2, runs[1])], CORNERS)
    assert [(s.code, s.start, s.end) for s in ref.sections] == [(s.code, s.start, s.end) for s in prep.sections]
    a, b = summarise(1, runs[0], ref), summarise(2, runs[1], ref)
    # each lap's sections add up to its lap time; the best sections to no more than the best lap
    assert sum(b.sections) <= float(runs[1].times.min()) + 0.05
    assert all(x > y for x, y in zip(a.sections, b.sections, strict=True))
    assert a.top_speed == pytest.approx(float(np.max(runs[0].traces["speed"])), abs=0.5)
    assert best_index([None, 3.0, 2.0]) == 2 and best_index([None]) is None


def test_an_upload_goes_into_the_event_picked(client):
    ev = client.post("/events/folders", json={"name": "Hockenheim", "start": "2026-07-01", "end": "2026-07-02"}).json()
    client.post("/sessions", json={"event_id": ev["id"], "name": "01_D1S1"})
    z = make_zip({"Test day/01_D1S1/a.ld": log((0.97, 0.98)), "Test day/02_D1S2/b.ld": log((0.97, 0.99))})
    r = client.post("/imports", files=[("files", ("Test day.zip", z))], data={"event_id": str(ev["id"])})
    assert r.status_code == 202, r.text
    while (job := client.get(f"/imports/{r.json()['id']}").json())["status"] not in ("done", "failed"):
        time.sleep(0.05)
    assert job["status"] == "done" and len(job["session_ids"]) == 2
    assert [e["name"] for e in client.get("/events").json()] == ["Hockenheim"]  # no event named after the zip
    body = client.get(f"/events/{ev['id']}").json()
    names = sorted(s["name"] for d in body["days"] for s in d["sessions"])
    assert names == ["01_D1S1", "01_D1S1 (2)", "02_D1S2"]  # unique within the event
    assert (body["start"], body["end"]) == ("2026-07-01", "2026-07-02")  # set by hand, kept
    assert body["track"] == "Test Track"

    assert client.post("/imports", files=[("files", ("x.zip", z))], data={"event_id": "999"}).status_code == 404
    job = upload(client, ("Other day.zip", z))  # nothing picked: a new event named after the zip, as before
    assert sorted(e["name"] for e in client.get("/events").json()) == ["Hockenheim", "Other day"]
    assert job["status"] == "done"
