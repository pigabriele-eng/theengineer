# ruff: noqa: E501  (the site's tables are kept as they come)
"""ADAC GT4 Germany: reading its site's page data (calendar, classification tables, entry lists), the sync against a
stand-in for the site, wet sessions spotted without a weather line, and finding our car across team changes."""
import ssl

import httpx
import pytest

from app.results import adac, predict, tls

# A season's calendar page: the site lists one weekend twice now and then (the copy has no sessions).
CALENDAR = {"pageContext": {"years": [2027, 2026, 2025]}, "data": {"allContentfulEvent": {"group": [{"nodes": [
    {"name": "Motorsport Arena Oschersleben", "startDate": "2025-04-25T08:00+02:00", "endDate": "2025-04-27T20:00+02:00", "sessions": [{}, {}, {}, {}]},
    {"name": "Hockenheimring Baden-Württemberg", "startDate": "2025-10-03T08:00+02:00", "endDate": "2025-10-05T20:00+02:00", "sessions": [{}, {}, {}, {}]},
    {"name": "Hockenheimring Baden-Württemberg", "startDate": "2025-10-03T13:00+02:00", "endDate": "2025-10-05T13:00+02:00", "sessions": []},
    {"name": "Red Bull Ring", "startDate": "2025-11-07T08:00+02:00", "endDate": "2025-11-09T20:00+02:00", "sessions": []},
]}]}}}

QUALI = ("Rank;#;Driver1;<<Driver2;TeamName;<<CarName;BestLapTime;GapTime\n"
         "1;55;Old Row;Broken;Team;Aston Martin Vantage GT4;1:3Rank;#;Driver1;Driver2;TeamName;CarName;BestLapTime;GapTime\n"
         "1;19;Hugo Alpha;Roman Beta;PROsport Racing;Aston Martin Vantage AMR GT4;1:28.820;\n"
         "2;51;Gabriele Piana;Ben Gamma;FK Performance Motorsport;BMW M4 GT4 Evo;1:29.020;0.200\n"
         "3;11;Enrico Delta;Jay Eps;SR Motorsport;Mercedes-AMG GT4;1:29.120;0.300\n"
         "NC;20;Luca Zeta;Dan Eta;razoon - more than racing;Porsche 718 Cayman GT4 RS CS;;\n"
         "DQ;8;Julien Theta;Luca Iota;BWT Mücke Motorsport;Mercedes-AMG GT4;;")
# Races come with the qualifying's heading now and then: the columns are read by their count.
RACE = ("Rank;#;Driver1;<<Driver2;TeamName;<<CarName;BestLapTime;GapTime\n"
        "1;11;Enrico Delta;Jay Eps;SR Motorsport;Mercedes-AMG GT4;1:02:48.979;;38;1:31.293\n"
        "2;51;Gabriele Piana;Ben Gamma;FK Performance Motorsport;BMW M4 GT4 Evo;1:02:54.305;5.326;38;1:31.334\n"
        "3;19;Hugo Alpha;Roman Beta;PROsport Racing;Aston Martin Vantage AMR GT4;1:02:30.100;-12.300;37;1:31.500\n"
        "NC;20;Luca Zeta;Dan Eta;razoon - more than racing;Porsche 718 Cayman GT4 RS CS;33:36.252;-19:17.300;15;1:48.609\n")
WET_QUALI = QUALI.replace("1:28.820", "1:38.820").replace("1:29.020", "1:39.020").replace("1:29.120", "1:39.120")
PDF = "https://res.cloudinary.com/adacmkv/image/upload/v1/ADAC_GT4_Germany_Qualifying_1_ResultList_1.0_x.pdf"


def _event(start: str, quali: str = QUALI) -> dict:
    sessions = [
        {"name": "1. Freies Training", "date": f"{start}T09:00+02:00", "csvData": {"csvData": QUALI}},
        {"name": "1. Zeittraining", "date": f"{start}T09:55+02:00", "csvData": {"csvData": quali},
         "downloadFile": [{"format": "pdf", "secure_url": PDF}]},
        {"name": "Rennen 1", "date": f"{start}T15:10+02:00", "csvData": {"csvData": RACE}},
        {"name": "2. Qualifying", "date": f"{start}T09:55+02:00", "csvData": {"csvData": quali}},
        {"name": "2. Rennen", "date": f"{start}T15:10+02:00", "csvData": {"csvData": RACE}},
    ]
    entries = ("#;TeamName;<<CarName;Driver1;<<Wohnort;Driver2;<<Wohnort\n"
               "51;FK Performance Motorsport;BMW M4 GT4 Evo;Gabriele Piana;Lugano (CHE);Ben Gamma;Malmö (SWE)\n"
               "#19;PROsport Racing;Aston Martin Vantage AMR GT4;Hugo Alpha;;Roman Beta;\n")
    return {"data": {"contentfulEvent": {"name": "x", "startDate": f"{start}T08:00+02:00", "sessions": sessions,
                                         "starterLists": [{"csvData": {"csvData": entries}}]}}}


PAGES = {
    "race-calendar": CALENDAR,
    "race-calendar/2025": CALENDAR,
    "race-calendar/2025/race-details/2025-4-25-motorsport-arena-oschersleben": _event("2025-04-25"),
    "race-calendar/2025/race-details/2025-10-3-hockenheimring-baden-wurttemberg": _event("2025-10-03", WET_QUALI),
    "race-calendar/2025/race-details/2025-11-7-red-bull-ring": {"data": {"contentfulEvent": {"startDate": "2025-11-07T08:00+02:00"}}},
}


def _site(calls: list[str]) -> httpx.Client:
    def handle(request: httpx.Request) -> httpx.Response:
        calls.append(str(request.url))
        prefix = "/page-data/adac-gt4-germany/"
        path = request.url.path
        if request.url.host == "www.adac-motorsport.de" and path.startswith(prefix):
            page = PAGES.get(path[len(prefix):].removesuffix("/page-data.json"))
            if page is not None:
                return httpx.Response(200, json={"result": page})
        return httpx.Response(404)  # the result PDFs too: the tables are enough

    return httpx.Client(transport=httpx.MockTransport(handle))


@pytest.fixture(autouse=True)
def _fresh():
    adac._events_cache.clear()


def test_the_calendar_is_read_one_event_a_weekend():
    evs = adac.parse_calendar(CALENDAR)
    assert [(e.round_id, e.slug, e.sessions) for e in evs] == [
        ("2025-04-25", "2025-4-25-motorsport-arena-oschersleben", 4),
        ("2025-10-03", "2025-10-3-hockenheimring-baden-wurttemberg", 4),
        ("2025-11-07", "2025-11-7-red-bull-ring", 0)]
    assert adac.slugify("Nürburgring") == "nurburgring"


def test_a_classification_table_is_read():
    links = adac.parse_sessions(_event("2025-04-25"))
    assert [(x.code, x.title) for x in links] == [("Q1", "1. Zeittraining"), ("Q2", "2. Qualifying"),
                                                   ("R1", "Rennen 1"), ("R2", "2. Rennen")]
    q1 = links[0]
    assert q1.pdf_url == PDF and q1.url.startswith(PDF + "#t")  # a corrected table gets a new address
    q = q1.result
    assert (q.title, q.kind, q.date) == ("Qualifying 1", "qualifying", "2025-04-25T09:55:00")
    assert [r.car_number for r in q.rows] == ["19", "51", "11", "20", "8"]  # the broken first copy is skipped
    first, ours = q.rows[:2]
    assert (first.position, first.best_lap_s, first.brand, first.drivers) == (1, 88.82, "Aston Martin", ["Hugo Alpha", "Roman Beta"])
    assert (ours.gap_s, ours.diff_s, ours.team) == (0.2, 0.2, "FK Performance Motorsport")
    assert [(r.status, r.position) for r in q.rows[3:]] == [("nc", None), ("dsq", None)]
    r = links[2].result
    win, second, lapped, out = r.rows
    assert (win.total_time_s, win.laps, win.best_lap_s, win.gap_s) == (3768.979, 38, 91.293, None)
    assert second.gap_s == 5.326
    assert (lapped.gap_laps, lapped.gap_s) == (1, None)
    assert (out.status, out.gap_s, out.laps) == ("nc", None, 15)


def test_an_entry_list_with_home_towns():
    rid, cars = adac.parse_entry_list(_event("2025-04-25"))
    assert rid == "2025-04-25"
    assert [(c.car_number, c.drivers, c.team, c.car_model) for c in cars] == [
        ("51", ["Gabriele Piana", "Ben Gamma"], "FK Performance Motorsport", "BMW M4 GT4 Evo"),
        ("19", ["Hugo Alpha", "Roman Beta"], "PROsport Racing", "Aston Martin Vantage AMR GT4")]


def test_the_sync_loads_adac_seasons(client, monkeypatch):
    from app.results import sync
    monkeypatch.setattr(sync, "PAUSE_S", 0)
    calls: list[str] = []
    with _site(calls) as site:
        sync.sync("adac-gt4-germany", years=[2025], client=site)
        assert sum("cloudinary" in c for c in calls) == 2  # each new sheet with a PDF tried once for its weather
        n = len(calls)
        adac._events_cache.clear()
        sync.sync("adac-gt4-germany", years=[2025], client=site)  # nothing new: no sheet fetched again
        assert sum("cloudinary" in c for c in calls[n:]) == 0
        sync.sync_calendar("adac-gt4-germany", 2025, client=site)
    status = client.get("/results/status").json()
    assert {"series": "adac-gt4-germany", "year": 2025, "sessions": 8} in status["loaded"]
    rounds = client.get("/results/rounds", params={"year": 2025, "series": "adac-gt4-germany"}).json()
    assert [(r["venue"], [s["code"] for s in r["sessions"]]) for r in rounds] == [
        ("oschersleben", ["Q1", "Q2", "R1", "R2"]), ("hockenheim", ["Q1", "Q2", "R1", "R2"])]
    cal = client.get("/results/calendar", params={"year": 2025, "series": "adac-gt4-germany"}).json()
    assert [(r["round_id"], r["venue"], r["entries"]) for r in cal["rounds"]] == [
        ("2025-04-25", "oschersleben", 2), ("2025-10-03", "hockenheim", 2), ("2025-11-07", "red-bull-ring", 0)]
    series = {s["key"]: s for s in client.get("/results/series").json()}
    assert series["adac-gt4-germany"]["name"] == "ADAC GT4 Germany" and series["adac-gt4-germany"]["years"][0] == 2023

    p = client.get("/results/predict", params={"venue": "Hockenheim", "year": 2026, "series": "adac-gt4-germany",
                                               "driver": "Piana"})
    assert p.status_code == 200 and p.json()["sessions"]["Q1"]["position"] is not None
    bt = client.get("/results/backtest", params={"series": "adac-gt4-germany", "driver": "Piana"}).json()
    assert bt["driver"] == "Piana" and bt["years"][0] == 2024


def test_an_event_of_an_adac_season_reads_adac_results(client):
    from app import db as app_db
    from app import models
    from app.results import sync
    ev = client.post("/events/folders", json={"name": "Hockenheim"}).json()
    assert client.get(f"/results/events/{ev['id']}").json()["series"] == "gt4-europe"
    with app_db.SessionLocal() as db:
        db.get(models.Event, ev["id"]).series = "ADAC GT4 Germany 2026"
        db.commit()
        assert sync.series_of_event(db, ev["id"]) == "adac-gt4-germany"
    assert client.get(f"/results/events/{ev['id']}").json()["series"] == "adac-gt4-germany"
    assert sync.series_key("GT4 European Series 2026") == "gt4-europe" and sync.series_key("NLS") is None


def _sessions(start_year: int = 2024) -> list[dict]:
    out = []
    for y, team, number in ((2024, "Old Team", "2"), (2025, "FK Performance Motorsport", "21")):
        for order, (venue, quali) in enumerate((("oschersleben", QUALI), ("hockenheim", WET_QUALI)), 1):
            for link in adac.parse_sessions(_event(f"{y}-0{order + 3}-01", quali)):
                rows = [dict(vars(r)) for r in link.result.rows]
                for r in rows:
                    if r["car_number"] == "51":
                        r["car_number"], r["team"] = number, team
                out.append({"year": y, "order": order, "round_id": f"{y}-{order}", "venue": venue,
                            "code": link.code, "weather": {}, "rows": rows})
    return [s for s in out if s["year"] >= start_year]


def test_wet_sessions_are_spotted_without_a_weather_line():
    sessions = predict.mark_wet(_sessions())
    wet = sorted({(s["venue"], s["code"]) for s in sessions if predict.is_wet(s)})
    assert wet == [("hockenheim", "Q1"), ("hockenheim", "Q2")]  # 10 s off the weekend's race laps
    assert next(s for s in sessions if s["venue"] == "hockenheim")["weather"]["inferred"] is True
    dry = {"year": 2025, "round_id": "z", "code": "Q1", "weather": {"conditions_start": "Dry"},
           "rows": [{"best_lap_s": 120.0, "status": "classified"}]}
    assert not predict.is_wet(predict.mark_wet([dry, {**dry, "code": "R1", "rows": [{"best_lap_s": 100.0}]}])[0])


def test_our_car_is_followed_across_teams():
    sessions = _sessions()
    us = predict._Us(2025, "21", "FK Performance Motorsport", None, None, sessions)
    old = next(s for s in sessions if s["year"] == 2024 and s["code"] == "Q1")
    assert us.crew == {"piana", "gamma"}
    assert [r["car_number"] for r in us.rows(old)] == ["2"]  # another team and number the year before
    by_driver = predict._Us(2025, None, None, None, None, sessions, driver="G.Piana")
    assert [r["car_number"] for r in by_driver.rows(old)] == ["2"]
    assert predict._surname("Gabriel GAMMA") == "gamma" and predict._surname("C.Gamma") == "gamma"


def test_the_missing_certificate_is_kept_with_the_code():
    ctx = tls.context(adac.CERTS)
    assert isinstance(ctx, ssl.SSLContext) and ctx.verify_mode == ssl.CERT_REQUIRED
    subjects = [dict(x[0] for x in c["subject"]).get("commonName") for c in ctx.get_ca_certs()]
    assert "GlobalSign GCC R46 OV TLS CA 2025" in subjects
