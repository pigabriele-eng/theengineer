"""Planned events and the racing calendar: the iCal reader, venue matching, uploads landing in a planned event, and
the sync from a synthetic calendar served on this machine (no real calendar)."""
import logging
import threading
from datetime import date, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

from app import ics
from app.plans import same_venue, short_venue
from tests.test_events import log
from tests.test_imports import make_zip, upload

SECRET = "private-0123456789abcdef0123456789abcdef"
PATH = f"/calendar/ical/racing%40group.calendar.google.com/{SECRET}/basic.ics"


# ---------- reading iCal ----------

def test_all_day_timed_and_utc_entries_cover_the_days_the_calendar_shows():
    cal = ics.parse(
        "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nX-WR-CALNAME:Racing\r\nX-WR-TIMEZONE:Europe/Amsterdam\r\n"
        # all day, Friday to Sunday: DTEND is the Monday
        "BEGIN:VEVENT\r\nUID:a@x\r\nDTSTART;VALUE=DATE:20260918\r\nDTEND;VALUE=DATE:20260921\r\n"
        "SUMMARY:GT4 European Series \\, Zandvoort\r\nLOCATION:Circuit Zandvoort\\, Burgemeester van Alphenstraat \r\n"
        " 108\\, Zandvoort\\, Netherlands\r\n"
        "BEGIN:VALARM\r\nACTION:DISPLAY\r\nSUMMARY:not the title\r\nTRIGGER:-PT1H\r\nEND:VALARM\r\nEND:VEVENT\r\n"
        # timed in a zone: the wall clock's date; an end at midnight doesn't count its day
        "BEGIN:VEVENT\r\nUID:b@x\r\nDTSTART;TZID=Europe/Berlin:20261009T090000\r\n"
        "DTEND;TZID=Europe/Berlin:20261011T000000\r\nSUMMARY:Hockenheim test\r\nEND:VEVENT\r\n"
        # UTC late in the evening is the next day in Amsterdam
        "BEGIN:VEVENT\r\nUID:c@x\r\nDTSTART:20261016T230000Z\r\nDURATION:PT2H\r\nSUMMARY:Night\r\nEND:VEVENT\r\n"
        # all day with no end: one day; a duration of days
        "BEGIN:VEVENT\r\nUID:d@x\r\nDTSTART;VALUE=DATE:20261101\r\nSUMMARY:Briefing\r\nEND:VEVENT\r\n"
        "BEGIN:VEVENT\r\nUID:e@x\r\nDTSTART;VALUE=DATE:20261105\r\nDURATION:P3D\r\nSUMMARY:Three\r\nEND:VEVENT\r\n"
        "BEGIN:VEVENT\r\nUID:f@x\r\nDTSTART;VALUE=DATE:20261201\r\nRRULE:FREQ=WEEKLY\r\nSUMMARY:Gym\r\nEND:VEVENT\r\n"
        "BEGIN:VEVENT\r\nUID:g@x\r\nDTSTART;VALUE=DATE:20261202\r\nSTATUS:CANCELLED\r\nSUMMARY:Off\r\nEND:VEVENT\r\n"
        "BEGIN:VEVENT\r\nSUMMARY:no uid\r\nDTSTART;VALUE=DATE:20261202\r\nEND:VEVENT\r\n"
        "END:VCALENDAR\r\n")
    assert (cal.name, cal.timezone, cal.unreadable) == ("Racing", "Europe/Amsterdam", 1)
    by = {e.uid: e for e in cal.entries}
    a = by["a@x"]
    assert (a.start, a.end, a.all_day) == (date(2026, 9, 18), date(2026, 9, 20), True)
    assert a.title == "GT4 European Series , Zandvoort"  # escapes undone, not the alarm's summary
    assert a.location == "Circuit Zandvoort, Burgemeester van Alphenstraat 108, Zandvoort, Netherlands"  # unfolded
    assert (by["b@x"].start, by["b@x"].end, by["b@x"].all_day) == (date(2026, 10, 9), date(2026, 10, 10), False)
    assert (by["c@x"].start, by["c@x"].end) == (date(2026, 10, 17), date(2026, 10, 17))
    assert (by["d@x"].start, by["d@x"].end) == (date(2026, 11, 1), date(2026, 11, 1))
    assert (by["e@x"].start, by["e@x"].end) == (date(2026, 11, 5), date(2026, 11, 7))
    assert by["f@x"].repeats and by["g@x"].cancelled and not a.repeats and not a.cancelled


def test_a_fold_inside_a_character_and_odd_lines_are_read():
    data = (b"\xef\xbb\xbfBEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:x\nDTSTART:20261003\nSUMMARY:Spa N\xc3\r\n \xbcrburgring\n"
            b"X-ODD;P=\"a:b\":v\nnot a property\nEND:VEVENT\nEND:VCALENDAR\n")  # the fold splits the bytes of ü
    (e,) = ics.parse(data).entries
    assert e.title == "Spa Nürburgring" and e.start == e.end == date(2026, 10, 3)
    with pytest.raises(ValueError):
        ics.parse(b"<html>Sign in</html>")


def test_venues_are_matched_however_they_are_written():
    assert same_venue("Hockenheimring", "Hockenheimring Baden-Württemberg, Am Motodrom, 68766 Hockenheim, Germany")
    assert same_venue("Hockenheim", "Hockenheimring")
    assert same_venue("Zandvoort", "Circuit Zandvoort, Burgemeester van Alphenstraat 108, Zandvoort, Netherlands")
    assert not same_venue("TT Circuit Assen, Netherlands", "Circuit Zandvoort, Netherlands")
    assert not same_venue("Test Track", "Zandvoort")
    assert short_venue("Circuit Zandvoort, Burgemeester van Alphenstraat 108") == "Circuit Zandvoort"


# ---------- a calendar served on this machine ----------

class Feed:
    """A synthetic iCal feed whose entries the test changes: {uid: (title, location, first day, last day)}."""

    def __init__(self):
        self.entries: dict[str, tuple[str, str | None, date, date]] = {}
        self.status = 200
        self.hits = 0
        feed = self

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                feed.hits += 1
                body = feed.text().encode() if self.path == PATH and feed.status == 200 else b"Not found"
                self.send_response(feed.status if self.path == PATH else 404)
                self.send_header("Content-Type", "text/calendar; charset=utf-8")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *args):
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}{PATH}"

    def text(self) -> str:
        out = ["BEGIN:VCALENDAR", "VERSION:2.0", "X-WR-CALNAME:Racing", "X-WR-TIMEZONE:Europe/Berlin"]
        for uid, (title, where, first, last) in self.entries.items():
            out += ["BEGIN:VEVENT", f"UID:{uid}", f"DTSTART;VALUE=DATE:{first:%Y%m%d}",
                    f"DTEND;VALUE=DATE:{last + timedelta(days=1):%Y%m%d}", f"SUMMARY:{title}"]
            out += [f"LOCATION:{where}"] if where else []
            out += ["END:VEVENT"]
        return "\r\n".join([*out, "END:VCALENDAR", ""])


@pytest.fixture()
def feed():
    f = Feed()
    yield f
    f.server.shutdown()


def _folders(client) -> dict[str, dict]:
    return {f["name"]: f for f in client.get("/events/folders").json() if f["id"] is not None}


def _entry(client, title) -> dict:
    return next(e for e in client.get("/calendar").json()["entries"] if e["title"] == title)


def test_the_calendar_makes_planned_events_and_keeps_them_in_step(client, feed, caplog):
    today = date.today()
    soon, later = today + timedelta(days=10), today + timedelta(days=40)
    feed.entries = {"r1@google.com": ("GT4 Zandvoort", "Circuit Zandvoort, Netherlands", soon, soon + timedelta(2)),
                    "r2@google.com": ("Spa test", "Spa-Francorchamps", later, later),
                    "old@google.com": ("Ancient", None, today - timedelta(days=400), today - timedelta(days=399))}
    caplog.set_level(logging.DEBUG)

    r = client.put("/calendar", json={"url": feed.url})
    assert r.status_code == 200, r.text
    body = r.json()
    assert SECRET not in r.text and feed.url not in r.text  # the address never comes back...
    assert body["feed"]["host"] == "127.0.0.1" and body["feed"]["ends_with"] == "cdef"
    assert body["feed"]["name"] == "Racing" and body["feed"]["summary"] == {"added": 2}
    assert [e["title"] for e in body["entries"]] == ["GT4 Zandvoort", "Spa test"]  # too old: not brought in
    folders = _folders(client)
    z = folders["GT4 Zandvoort"]
    assert (z["start"], z["end"], z["sessions"]) == (soon.isoformat(), (soon + timedelta(2)).isoformat(), 0)
    plans = {p["event_id"]: p for p in body["plans"]}
    assert plans[z["id"]] == {"event_id": z["id"], "venue": "Circuit Zandvoort", "from_calendar": True}

    # moved, retitled, one deleted, one new: the same events follow
    feed.entries["r1@google.com"] = ("GT4 ES Zandvoort", "Circuit Zandvoort, Netherlands", soon + timedelta(1),
                                     soon + timedelta(3))
    del feed.entries["r2@google.com"]
    feed.entries["r3@google.com"] = ("Monza", "Autodromo Nazionale Monza", later, later + timedelta(1))
    body = client.post("/calendar/sync").json()
    assert body["feed"]["summary"] == {"added": 1, "updated": 1, "removed": 1} and body["feed"]["error"] is None
    folders = _folders(client)
    assert set(folders) == {"GT4 ES Zandvoort", "Monza"}
    assert folders["GT4 ES Zandvoort"]["id"] == z["id"] and folders["GT4 ES Zandvoort"]["end"] == (
        soon + timedelta(3)).isoformat()

    # renamed in the app: the calendar's new title doesn't overwrite it, its new days still do
    client.patch(f"/events/{z['id']}", json={"name": "Zandvoort round 5"})
    feed.entries["r1@google.com"] = ("GT4 Zandvoort (R5)", "Circuit Zandvoort, Netherlands", soon, soon)
    client.post("/calendar/sync")
    ev = client.get(f"/events/{z['id']}").json()
    assert (ev["name"], ev["start"], ev["end"]) == ("Zandvoort round 5", soon.isoformat(), soon.isoformat())

    # switched off: its planned event goes and stays out; switched on: back
    monza = _entry(client, "Monza")
    body = client.patch(f"/calendar/entries/{monza['id']}", json={"included": False}).json()
    assert "Monza" not in _folders(client) and _entry(client, "Monza")["included"] is False
    client.post("/calendar/sync")
    assert "Monza" not in _folders(client)
    body = client.patch(f"/calendar/entries/{monza['id']}", json={"included": True}).json()
    assert _folders(client)["Monza"]["start"] == later.isoformat()

    # removed from the app (the planned event's Remove, or Delete on its page): stays out of later syncs
    mid = _folders(client)["Monza"]["id"]
    assert client.delete(f"/planned-events/{mid}").json() == {"deleted": mid}
    client.post("/calendar/sync")
    assert "Monza" not in _folders(client) and _entry(client, "Monza")["included"] is False
    client.patch(f"/calendar/entries/{monza['id']}", json={"included": True})
    client.delete(f"/events/{_folders(client)['Monza']['id']}")
    body = client.post("/calendar/sync").json()
    assert "Monza" not in _folders(client) and body["feed"]["summary"]["switched_off"] == 1

    # an address that stopped working: told, nothing removed
    feed.status = 404
    body = client.post("/calendar/sync").json()
    assert "wasn't found" in body["feed"]["error"] and "Zandvoort round 5" in _folders(client)
    feed.status = 200

    assert SECRET not in caplog.text  # ...and is never logged
    body = client.delete("/calendar").json()
    assert body["feed"] is None and body["entries"] == [] and _folders(client) == {}


def test_new_entries_wait_when_they_are_not_added_by_themselves(client, feed):
    day = date.today() + timedelta(days=5)
    feed.entries = {"a@x": ("Portimão", "Autódromo Internacional do Algarve", day, day)}
    body = client.put("/calendar", json={"url": feed.url, "auto_add": False}).json()
    assert body["feed"]["auto_add"] is False and body["feed"]["summary"] == {"waiting": 1}
    (e,) = body["entries"]
    assert e["included"] is False and e["event_id"] is None and _folders(client) == {}
    body = client.patch(f"/calendar/entries/{e['id']}", json={"included": True}).json()
    assert body["entries"][0]["event_id"] == _folders(client)["Portimão"]["id"]


def test_wrong_addresses_are_refused_without_repeating_them(client, feed):
    for bad in ("", "racing@group.calendar.google.com", "ftp://example.com/x.ics",
                "https://calendar.google.com/calendar/u/0/r/settings/calendar/abc"):
        r = client.put("/calendar", json={"url": bad})
        assert r.status_code == 422 and (not bad or bad not in r.text)
    r = client.put("/calendar", json={"url": feed.url.replace(SECRET, "private-ffffffffffffffffffffffff")})
    assert r.status_code == 422 and "wasn't found" in r.json()["detail"] and "ffff" not in r.text
    assert client.get("/calendar").json()["feed"] is None
    assert client.post("/calendar/sync").status_code == 404


def test_an_upload_lands_in_the_planned_event_at_its_venue_and_days(client, feed):
    today = date.today()
    day = today.strftime("%d/%m/%Y")
    # planned by hand at the log's venue (Test Track), starting tomorrow: today is the day before (setup)
    planned = client.post("/planned-events", json={"name": "Test Track weekend", "venue": "Test Track",
                                                    "start": (today + timedelta(1)).isoformat(),
                                                    "end": (today + timedelta(2)).isoformat()}).json()
    other = client.post("/planned-events", json={"name": "Zandvoort", "venue": "Circuit Zandvoort",
                                                  "start": today.isoformat(), "end": today.isoformat()}).json()
    assert planned["sessions"] == 0 and planned["start"] == (today + timedelta(1)).isoformat()
    assert client.post("/planned-events", json={"name": "x", "start": "2026-10-09", "end": "2026-10-08"}
                       ).status_code == 422
    z = make_zip({"Weekend/FP1/a.ld": log((0.97, 0.98), day), "Weekend/FP2/b.ld": log((0.97, 0.99), day)})
    job = upload(client, ("Weekend.zip", z))
    assert job["status"] == "done" and len(job["session_ids"]) == 2
    folders = _folders(client)
    assert set(folders) == {"Test Track weekend", "Zandvoort"}  # no event named after the zip
    ev = client.get(f"/events/{planned['id']}").json()
    assert ev["sessions"] == 2 and ev["track"] == "Test Track"
    assert (ev["start"], ev["end"]) == ((today + timedelta(1)).isoformat(), (today + timedelta(2)).isoformat())
    assert client.delete(f"/planned-events/{planned['id']}").status_code == 409  # it has data now
    assert client.delete(f"/planned-events/{other['id']}").status_code == 200

    # the calendar links an entry to the event already there (same venue, same days) instead of making another,
    # and when the entry is deleted the event with data stays
    feed.entries = {"tt@x": ("Round 3", "Test Track, Somewhere", today, today + timedelta(2))}
    body = client.put("/calendar", json={"url": feed.url}).json()
    assert body["entries"][0]["event_id"] == planned["id"] and body["entries"][0]["has_data"] is True
    assert set(_folders(client)) == {"Test Track weekend"}  # its own name kept
    feed.entries = {}
    client.post("/calendar/sync")
    assert client.get(f"/events/{planned['id']}").json()["sessions"] == 2

    # a log from another day goes where it went before: a zip makes its own event
    job = upload(client, ("Later.zip", make_zip({"Later/a.ld": log((0.97, 0.98),
                                                                    (today + timedelta(9)).strftime("%d/%m/%Y"))})))
    assert set(_folders(client)) == {"Test Track weekend", "Later"}
