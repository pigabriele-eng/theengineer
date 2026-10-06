# ruff: noqa: E501  (result sheets are kept as wide as the page lays them out)
"""Official series results: reading a result sheet, the sync (with a stand-in for the series' site) and what the
results say about one of our events."""
from typing import ClassVar

import pytest

from app.results.resultlist import brand_of, parse_pages, seconds
from app.results.venues import venue_key
from tests.test_events import _session

QUALI = """\
                                       GT WorldChEU pwrd by AWS Sprint Cup Round 8
                                       GT4 European Series
                                       Qualifying 1

                                                                        Result List
Test Track, Length: 4259m
                                                                       Final Classification

                                                                  19 September 2026 11:15:00

  Stewards / Race Management                                           Weather Start/Finish                 Track Information
  STEWARD                          A.Person                           AIR                 18.3°C            GREEN FLAG                               11:15:00
  RACE DIRECTOR                    B.Person                           TRACK               20.5°C            CHEQUERED FLAG                           11:44:05
                                                                      CONDITIONS          Dry               TURN COUNT                                     14
                                                                      AIR                 18.9°C
                                                                      TRACK               19.4°C
                                                                      CONDITIONS          Wet
          Nr. Drivers                                     Team                                            Lap Best Time        Gap     Diff Kph     Day Time
        Cl.  Car                                          Entrant
    1      8 A.Alpha/B.Beta                               Team One                                          4    1:42.147                   150.1      11:36:52
     Silver Audi R8 LMS GT4                               Team One
    2    911C.Gamma/D.Delta                               Team Two                                          5    1:42.441     0.294   0.294 149.6      11:34:45
     Silver BMW M4 GT4 G82 EVO                            Team Two
    3     70 E.Eps(Silver)/F.Phi                          Team Three                                        2    1:43.371     1.224   0.930 129.5      11:30:00
     PAM   Aston Martin Vantage AMR  GT4 EVO              Team Three
   Not classified
          24 G.Gee/H.Aitch                                Team Four
     Am    Porsche 718 Cayman GT4 RS CS                   Team Four
"""

RACE = """\
                                       GT4 European Series
                                       Race 1
Test Track, Length: 4259m
                                                                       19 September 2026 17:25:00
        Nr. Drivers                                    Team                                          Laps     Total Time     Gap    Kph    Lap    Time      Kph
     Cl. Car                                           Entrant
   1    911 C.Gamma/D.Delt a                           Team Two                                        33    1:01:29.805           138.2     4 1:43.819    147.6
     Silver BMW M4 GT4 G82 EVO                         Team Two
   2      8 A.Alpha/B.Beta                             Team One                                        33    1:01:34.896    5.091 138.0      5 1:43.906    147.5
     Silver Audi R8 LMS GT4                            Team One
   3     70 E.Eps/F.Phi                                Team Three                                      31    1:01:37.226    2LAPS 138.2      4 1:44.751    147.7
     PAM   Aston Martin Vantage AMR GT4 EVO            Team Three
"""


def test_a_result_sheet_is_read():
    q = parse_pages([QUALI])
    assert (q.title, q.kind, q.number, q.track, q.length_m) == ("Qualifying 1", "qualifying", 1, "Test Track", 4259)
    assert q.date == "2026-09-19T11:15:00"
    assert q.weather["track_c_start"] == 20.5 and q.weather["conditions_end"] == "Wet"
    assert [r.car_number for r in q.rows] == ["8", "911", "70", "24"]
    first, ours, third, out = q.rows
    assert (first.position, first.best_lap_s, first.gap_s, first.car_class, first.brand) == (
        1, 102.147, None, "Silver", "Audi")
    assert ours.drivers == ["C.Gamma", "D.Delta"] and (ours.gap_s, ours.diff_s) == (0.294, 0.294)
    assert third.drivers == ["E.Eps", "F.Phi"] and third.car_class == "Pro-Am"
    assert third.car_model == "Aston Martin Vantage AMR GT4 EVO"
    assert (out.position, out.status, out.best_lap_s, out.car_class) == (None, "nc", None, "Am")

    r = parse_pages([RACE])
    assert r.kind == "race" and [x.position for x in r.rows] == [1, 2, 3]
    win, second, lapped = r.rows
    assert win.drivers == ["C.Gamma", "D.Delta"]  # a name's last letter split off by the page's text
    assert (win.laps, win.total_time_s, win.best_lap_no, win.best_lap_s) == (33, 3689.805, 4, 103.819)
    assert second.gap_s == 5.091 and lapped.gap_laps == 2


def test_names_and_times():
    assert seconds("1:01:29.805") == 3689.805 and seconds("5.091") == 5.091 and seconds("2LAPS") is None
    assert brand_of("Mercedes-AMG GT4") == "Mercedes-AMG" and brand_of("Ford Mustang GT4 2024") == "Ford"
    assert venue_key("Circuit Paul Ricard") == "paul-ricard" and venue_key("N&uuml;rburgring") == "nurburgring"
    assert venue_key("Hockenheim GP") == "hockenheim" and venue_key("Circuit Zandvoort") == "zandvoort"


class FakeSite:
    """The series' site: one season, one round at the test track, two result sheets."""
    NAME = "Fake series"
    calls: ClassVar[list[str]] = []

    @staticmethod
    def seasons(client):
        return {2026: "10"}

    @staticmethod
    def rounds(client, season_id):
        return [("75", "Test Track")]

    @staticmethod
    def round_sessions(client, season_id, round_id):
        from app.results.gt4europe import SessionLink
        return [SessionLink("Q1", "Qualifying 1", "https://x/q1.pdf"), SessionLink("R1", "Race 1", "https://x/r1.pdf")]

    @staticmethod
    def fetch(client, url):
        FakeSite.calls.append(url)
        return (QUALI if "q1" in url else RACE).encode()


@pytest.fixture()
def fake_site(client, monkeypatch):
    from app.results import resultlist, sync
    monkeypatch.setitem(sync.ADAPTERS, "gt4-europe", FakeSite)
    monkeypatch.setattr(sync, "parse_pdf", lambda data: resultlist.parse_pages([data.decode()]))
    monkeypatch.setattr(sync, "PAUSE_S", 0)
    FakeSite.calls = []
    return sync


def test_sync_loads_a_season_once(client, fake_site):
    fake_site.sync(years=[2026])
    assert len(FakeSite.calls) == 2
    fake_site.sync(years=[2026])  # nothing new on the site: nothing downloaded again
    assert len(FakeSite.calls) == 2
    status = client.get("/results/status").json()
    assert status["loaded"] == [{"series": "gt4-europe", "year": 2026, "sessions": 2}]
    rounds = client.get("/results/rounds", params={"year": 2026}).json()
    assert rounds[0]["venue"] == "test-track" and [s["code"] for s in rounds[0]["sessions"]] == ["Q1", "R1"]
    q1 = next(s for s in rounds[0]["sessions"] if s["code"] == "Q1")
    sheet = client.get(f"/results/sessions/{q1['id']}").json()
    assert len(sheet["rows"]) == 4 and sheet["brands"][0]["brand"] == "Audi"


def test_an_event_gets_its_official_results(client, fake_site):
    fake_site.sync(years=[2026])
    client.post("/tracks", json={"name": "Test Track"})
    ev = client.post("/events/folders", json={"name": "Round 5"}).json()
    sid = _session(client, ev["id"], "Q", (0.97, 0.98), "19/09/2026", "11:30:00")
    body = client.get(f"/results/events/{ev['id']}").json()
    assert body["round"]["name"] == "Test Track" and body["year"] == 2026
    # nothing logged matches an official lap: no car yet, until it's set by hand
    assert body["car_number"] is None
    body = client.put(f"/results/events/{ev['id']}/link", json={"car_number": "#911"}).json()
    assert body["car_number"] == "911" and body["car_number_from"] == "set"
    q1, r1 = body["sessions"]
    assert q1["code"] == "Q1" and q1["our_sessions"] == [{"id": sid, "name": "Q"}]
    us = q1["us"]
    assert (us["position"], us["class_position"], us["class_cars"]) == (2, 2, 2)
    assert (us["to_fastest_s"], us["gap_to_leader_s"], us["gap_to_ahead_s"]) == (0.294, 0.294, 0.294)
    assert q1["logged_rank"] >= 1 and q1["logged_best_s"] is not None
    assert r1["us"]["position"] == 1 and r1["us"]["gap_to_ahead_s"] is None
    assert client.get(f"/results/runs/{sid}").json()["official"]["code"] == "Q1"

    hist = client.get("/results/history", params={"venue": "Test Track", "car_number": "911", "year": 2026}).json()
    assert hist["team"] == "Team Two" and hist["years"][0]["sessions"][0]["us"]["position"] == 2
    assert hist["circuits"][0]["venue"] == "test-track"
    assert {b["brand"] for b in hist["brands"][0]["brands"]} == {"Audi", "BMW", "Aston Martin", "Porsche"}


def test_our_car_is_found_from_logged_laps(client):
    from app.results import models as rm
    from app.results import summary
    rnd = rm.ResultRound(series="s", year=2026, round_id="1", name="X", order=1)
    s = rm.ResultSession(code="Q1", title="Qualifying 1", kind="qualifying", source_url="u")
    s.rows = [rm.ResultRow(position=1, status="classified", car_number="8", best_lap_s=102.147),
              rm.ResultRow(position=6, status="classified", car_number="12", best_lap_s=102.441)]
    rnd.sessions = [s]
    assert summary.infer_car(rnd, [102.440, 104.48]) == ("12", 1)
    assert summary.infer_car(rnd, [110.0]) == (None, 0)
    assert summary.match_session(rnd, "12", ["Q"], "test", 102.44) is s
