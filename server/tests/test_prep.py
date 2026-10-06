"""The prep report: past events at the venue with the same car, turned into a briefing, and the venue's weather."""
import re
import time
from datetime import date
from types import SimpleNamespace

import pytest

from app.prep import brief, weather
from app.prep.plan import QUALI, RACE, lap_times, venue_key
from tests.synthetic import simulate, write_ld

CORNER_NAME = re.compile(r"Nordkurve|Sachs|Spitzkehre|Mercedes|Ameisen|Tarzan|Hugenholtz|Scheivlak")


# ---------- the briefing, from gathered events ----------

def _habit(key, unit, phase, typical, quick, theoretical=None, used=False):
    return {"key": key, "label": key, "unit": unit, "phase": phase, "typical": typical, "quick": quick,
            "theoretical": theoretical, "link": "strong", "used": used, "worth_s": 0.1}


def _section(code, gain, best, typical, where, advice, habits, flat=False):
    return {"code": code, "corners": [code], "flat": flat, "start_m": 0, "end_m": 100, "apex_m": None if flat else 50,
            "times": {"best": best, "typical": typical, "theoretical": best - 0.1, "best_lap": "Run 2#4",
                      "fastest_lap": best + 0.05, "quick": best + 0.02, "realistic": best},
            "gain_s": gain, "where": where, "main_phase": max(where, key=where.get), "headline": advice[0] if advice
            else None, "advice": advice, "habits": habits, "loss_line": ""}


def _event(id_, year, best, t1_typical, driver="Anna", with_tyres=True, remarks=()):
    t1 = _section("T1", 0.26, 13.0, t1_typical, {"braking": 0.0, "entry": 0.02, "mid-corner": 0.01, "exit": 0.15,
                                                 "full throttle": 0.08},
                  ["Come off the brake 6 m sooner, at 230 m"],
                  [_habit("brake_point", "m", "braking", 161.5, 161.0, 172),
                   _habit("release_at", "m", "entry", 236, 230), _habit("speed_at_release", "km/h", "entry", 157, 166),
                   _habit("min_speed", "km/h", "mid-corner", 148.8, 155.8, 159.5, used=True),
                   _habit("throttle_on", "m", "exit", 265, 265), _habit("full_throttle", "m", "exit", 278, 279.5),
                   _habit("exit_speed", "km/h", "full throttle", 205, 208, 209.9)])
    t1.update(start_m=120, end_m=300, apex_m=245)
    t2 = _section("T2-T5", 0.29, 25.4, 25.8, {"braking": 0.01, "entry": 0.0, "mid-corner": 0.01, "exit": 0.12,
                                               "full throttle": 0.14},
                  ["Leave T4 faster: 200.0 km/h at 1317 m against 197.4"],
                  [_habit("after_T4", "km/h", "exit", 197.4, 200.0, 199.8, used=True),
                   _habit("corner_speed_T4", "km/h", "mid", 115, 116),
                   _habit("min_speed", "km/h", "mid-corner", 74, 76), _habit("throttle_on", "m", "exit", 850, 845)])
    t2.update(start_m=650, end_m=1400, apex_m=830)
    t2["habits"][0]["label"] = "Speed after T4, at 1317 m"
    t6 = _section("T6", 0.01, 13.1, 13.2, {"braking": 0.01, "entry": 0.0, "mid-corner": 0.0, "exit": 0.0,
                                            "full throttle": 0.0}, [], [])
    report = {"numbering": "official", "laps_analysed": 40,
              "headline": {"ideal": best - 1.0, "realistic": best - 0.4, "theoretical": best - 1.7,
                           "typical": best + 1.5, "fastest": {"time": best}},
              "gains": [{"code": "T2-T5"}, {"code": "T1"}, {"code": "T6"}], "sections": [t1, t2, t6],
              "runs": [{"run": "Run 2", "driver": driver}],
              "corners": [{"code": "T1", "at_m": 245}, {"code": "T2", "at_m": 830}, {"code": "T4", "at_m": 1200}]}
    tyreprep = {
        "has_tpms": True, "advice": [{"key": "plan", "title": "Recommendation",
                                      "text": "Warm up like Run 1 (2 warm-up laps, 88 s of brake dragging): push from "
                                              "80 °C front and 60 °C rear; the best lap came 4 to 6 laps after "
                                              "leaving the pits."}],
        "push": {"front_c": 80, "rear_c": 60}, "ready": {"min": 6.0, "max": 9.6, "peak_from_exit": [4, 6]},
        "fastest": {"best": {"label": "Run 1", "warm_laps": 2, "drag_s": 88, "straight_hard_stops": 0, "weaves": 19,
                             "ready_min": 6.0, "peak_flying": 3, "peak_time": best + 0.2}},
        "cold": {"tyres": [{"tyre": "FL", "cold_bar": 1.13, "target_hot_bar": 1.82, "runs": 7},
                           {"tyre": "RR", "cold_bar": 1.21, "target_hot_bar": 1.79, "runs": 9}]},
        "windows": {"tyres": {}},
        "sims": [{"label": "Run 1", "kind": "quali", "peak_time": best + 0.2, "peak_flying": 3}],
        "long_runs": [{"label": "Run 3", "times": [best + 0.9, best + 1.0, best + 1.1]}],
    } if with_tyres else None
    sessions = [{"id": id_ * 10 + 1, "name": "Run 1", "kind": "other", "driver": driver, "clean_laps": 10,
                 "best": best + 0.3, "times": [best + 0.3], "ambient_c": 15.0, "track_c": None, "tyre": "DHG"},
                {"id": id_ * 10 + 2, "name": "Run 2", "kind": "other", "driver": driver, "clean_laps": 12,
                 "best": best, "times": [best], "ambient_c": 19.0, "track_c": 31.0, "tyre": "DHG"}]
    runs = [{"session_id": id_ * 10 + 2, "name": "Run 2", "has_setup": True, "template": "bmw-m4-gt4-evo",
             "values": {"arb_front": 3}, "laps": {"best_s": best, "top3_s": best + 0.2},
             "changes": [{"text": "Front anti-roll bar 2 → 3"}], "compared_with": {"name": "Run 1"},
             "deltas": {"best_s": -0.3}, "summary": {"balance": {"entry": 0.9, "mid": 0.1, "exit": -1.6},
                                                     "tc_s_per_lap": 1.2}}]
    return {"id": id_, "name": f"Hockenheim {year}", "start": f"{year}-05-05", "end": f"{year}-05-06", "year": year,
            "other_cars": False, "sessions": sessions, "report": report, "report_note": None,
            "technique": {driver: {"laps": 22, "habits": [
                {"key": "T1:late_throttle", "code": "T1", "phase": "exit", "title": "Late on the throttle", "laps": 9,
                 "of": 22, "cost_per_lap_s": 0.08}]}},
            "technique_note": None, "tyreprep": tyreprep, "tyreprep_note": None, "runs": runs,
            "remarks": list(remarks)}


REMARK = {"session_id": 22, "session": "Run 2", "driver": "Anna", "text": "Understeer mid-corner in T6",
          "corner": "T6", "kind": "understeer", "symptom": "understeer_mid", "label": "understeer mid-corner at T6",
          "verdict": "agree", "data": "T6 mid-corner: +0.9° against the car's normal, clear understeer."}


def test_a_two_year_briefing_puts_the_target_first_and_compares_the_years():
    events = [_event(1, "2025", 107.44, 13.37, remarks=[REMARK]),
              _event(2, "2026", 107.23, 13.20, remarks=[{**REMARK, "session_id": 22}])]
    setup = {"baseline": {"session": "Run 2", "year": "2026", "best_s": 107.23}, "suggestions": [
        {"title": "Soften the front anti-roll bar", "changes": [{"text": "Front anti-roll bar 3 → 2"}],
         "reason": "understeer mid-corner at T6 (driver; data)"}], "recurring": []}
    out = brief.build({"id": 9, "name": "Hockenheim 2027"}, {"key": "logger:1", "label": "logger 1"}, events,
                      None, setup)
    perf = out["performance"]
    assert [r["year"] for r in perf] == ["2025", "2026"]
    assert perf[1]["change"]["best"] == pytest.approx(-0.21)
    assert perf[1]["quali"]["basis"] == "quali run" and perf[1]["race_pace"]["basis"] == "long runs"
    assert perf[0]["conditions"]["ambient_c"] == [15.0, 19.0] and perf[0]["conditions"]["track_c"] == [31.0, 31.0]
    assert out["trend"].startswith("2026 against 2025: best lap 0.21 s quicker")

    keys = [b["key"] for b in out["briefing"]]
    assert keys[:5] == ["target", "corners", "quali", "pressures", "setup"]
    target = out["briefing"][0]["text"]
    assert target.startswith("Aim for 1:46.83") and "1:47.23 (2026, Run 2, Anna)" in target
    assert "Most time to find in T2-T5 (0.29 s a lap, also in 2025)" in out["briefing"][1]["text"]
    assert out["briefing"][2]["text"].startswith("What worked in 2026: warm up like Run 1") \
        and out["briefing"][2]["text"].endswith("2025 needed the same push temperatures.")
    assert "Set FL 1.13, RR 1.21 bar cold" in out["briefing"][3]["text"]
    assert "soften the front anti-roll bar (Front anti-roll bar 3 → 2)" in out["briefing"][4]["text"]

    rows = out["corners"]["rows"]
    assert [r["code"] for r in rows] == ["T2-T5", "T1", "T6"] and out["corners"]["comparable"]
    t1 = next(r for r in rows if r["code"] == "T1")
    assert t1["change"]["typical"] == pytest.approx(-0.17)
    assert t1["ideal"] == ("Brake at 161 m (perfect driving brakes at 172 m), off the brake at 230 m at 166 km/h, "
                           "156 km/h at the slowest point (the car can do 160 km/h), throttle back on at 265 m, full "
                           "throttle at 280 m, 208 km/h at the end of the section (the car can do 210 km/h).")
    assert t1["why"].startswith("A typical pass gives away 0.26 s here: 0.15 s on exit") and "counts twice" in t1["why"]
    t2 = next(r for r in rows if r["code"] == "T2-T5")  # along the track: the slowest point, then T4, then after it
    assert t2["ideal"] == ("76 km/h at the slowest point, throttle back on at 845 m, 116 km/h at T4, 200 km/h after "
                           "T4.")
    assert t1["drivers"][0]["driver"] == "Anna"
    assert "won time in T1 (0.17 s)" in out["corners"]["changes"]

    assert out["technique"][0]["habits"][0]["text"] == \
        "T1: late on the throttle on 18 of 44 laps, 0.08 s a lap (2025, 2026)"
    said = out["setups"]["said"][0]
    assert said["runs"] == 2 and said["text"].startswith("Understeer mid-corner at T6: said after 2 runs (2025, 2026)")
    assert out["setups"]["runs"][0]["balance"] == "clear understeer on entry, strong oversteer on exit"
    same = brief.build({"id": 9}, {"key": "x", "label": "x"}, [events[0], {**events[0], "id": 3, "year": "2026"}],
                       None, None)
    assert same["trend"].startswith("2026 against 2025: best lap the same (1:47.44 against 1:47.44)")
    text = str(out)
    assert not CORNER_NAME.search(text)


def test_one_past_event_is_enough_and_detected_corners_are_not_lined_up():
    ev = _event(1, "2025", 107.44, 13.37, with_tyres=False)
    ev["report"]["numbering"] = "detected"
    out = brief.build({"id": 2}, {"key": "x", "label": "x"}, [ev], None, None)
    assert len(out["performance"]) == 1 and out["performance"][0]["change"] is None and out["trend"] is None
    assert out["quali"] is None and out["pressures"] is None
    assert not out["corners"]["comparable"] and "no official corner numbers" in out["corners"]["note"]
    assert [b["key"] for b in out["briefing"]][:2] == ["target", "corners"]


def test_the_race_and_quali_come_from_the_sessions_when_they_are_marked():
    ev = _event(1, "2026", 102.44, 13.0)
    ev["sessions"][0].update(kind="qualifying", best=102.44, times=[102.44])
    ev["sessions"][1].update(kind="race", best=104.48, times=[104.48, 104.9, 105.1])
    row = brief.performance([ev])[0]
    assert row["quali"] == {"time": 102.44, "session": "Run 1", "driver": "Anna", "basis": "qualifying"}
    assert row["race_pace"] == {"time": 104.9, "laps": 3, "basis": "race"}


def test_session_kinds_and_venues_from_names():
    assert QUALI.match("Q") and QUALI.match("Q2") and QUALI.match("Qualifying 1") and not QUALI.match("D1S1")
    assert RACE.match("R1") and RACE.match("Race 2") and not RACE.match("Run 3")
    assert QUALI.match("03_Q (2)") and RACE.match("04_R1") and not QUALI.match("06_D2S1") and not RACE.match("1 Run")
    assert venue_key("Hockenheimring") == venue_key("hockenheim") == venue_key("Hockenheim GP")
    assert venue_key("Zandvoort") == venue_key("Circuit Zandvoort") and venue_key("") is None
    assert venue_key("Test ring") == "test ring"


# ---------- the weather ----------

ARCHIVE = {"latitude": 49.33, "longitude": 8.57, "timezone": "Europe/Berlin",
           "daily_units": {"temperature_2m_max": "°C"},
           "daily": {"time": ["2025-05-05", "2025-05-06"], "temperature_2m_max": [18.2, 21.0],
                     "temperature_2m_min": [7.1, 9.4], "precipitation_sum": [0.0, 3.2],
                     "wind_speed_10m_max": [14.0, 33.5], "weather_code": [2, 61]}}
FORECAST = {"latitude": 49.33, "longitude": 8.57,
            "daily": {"time": ["2026-10-10", "2026-10-11"], "temperature_2m_max": [27.0, 28.4],
                      "temperature_2m_min": [15.0, 16.2], "precipitation_sum": [0.0, 0.0],
                      "precipitation_probability_max": [10, 20], "wind_speed_10m_max": [9.0, 12.0],
                      "weather_code": [0, 1]}}


@pytest.fixture()
def fixtures(monkeypatch):
    calls = []

    def fake(url, params):
        calls.append((url, params))
        if url == weather.ARCHIVE_URL:
            return ARCHIVE
        return FORECAST
    monkeypatch.setattr(weather, "_get_json", fake)
    return calls


def test_a_pit_log_stub_is_not_a_lap():
    def session(id_, *times):
        log = SimpleNamespace(id=id_ * 10, meta={"duration_s": 600})
        return SimpleNamespace(id=id_, files=[log], laps=[SimpleNamespace(file_id=log.id, clean=True, time_s=t)
                                                            for t in times])
    assert lap_times([session(1, 104.9, 104.48), session(2, 3.0), session(3, 105.1)]) == \
        {1: [104.48, 104.9], 2: [], 3: [105.1]}


def test_weather_days_and_words():
    days = weather.days_from(ARCHIVE)
    assert days[1] == {"date": "2025-05-06", "t_max": 21.0, "t_min": 9.4, "rain_mm": 3.2, "rain_chance": None,
                       "wind_kmh": 33.5, "sky": "rain"}
    s = weather.summary(days)
    assert s["text"] == "21 °C at the warmest, 7 °C at night, wet on 1 of 2 days (3 mm), wind up to 34 km/h"


def test_weather_for_past_events_and_the_forecast(client, fixtures):
    from app.db import SessionLocal
    with SessionLocal() as db:
        place = {"lat": 49.3276, "lon": 8.5659}
        out = weather.venue_weather(db, place, [{"id": 1, "start": "2025-05-05", "end": "2025-05-06", "year": "2025"}],
                                    {"start": "2026-10-10", "end": "2026-10-11"}, today=date(2026, 10, 6))
        assert out["past"][0]["summary"]["t_max"] == 21.0
        assert out["forecast"]["kind"] == "forecast" and out["forecast"]["summary"]["text"].startswith("28 °C")
        assert out["compare"].startswith("The forecast is about 8 °C warmer than 2025")
        assert "set the cold pressures lower" in out["compare"]
        url, params = fixtures[-1]
        assert url == weather.FORECAST_URL and params["start_date"] == "2026-10-10"
        assert "precipitation_probability_max" in params["daily"]
        n = len(fixtures)
        weather.venue_weather(db, place, [{"id": 1, "start": "2025-05-05", "end": "2025-05-06", "year": "2025"}],
                              {"start": "2026-10-10", "end": "2026-10-11"}, today=date(2026, 10, 6))
        assert len(fixtures) == n  # kept: asked again it doesn't fetch again

        far = weather.venue_weather(db, place, [], {"start": "2027-05-03", "end": "2027-05-04"},
                                    today=date(2026, 10, 6))
        assert far["forecast"] is None and "appears here from 2027-04-18" in far["note"]
        assert weather.venue_weather(db, None, [], {"start": None})["note"].startswith("This track has no GPS")


def test_weather_service_unreachable(client, monkeypatch):
    import httpx

    from app.db import SessionLocal

    def down(url, params):
        raise httpx.ConnectError("blocked")
    monkeypatch.setattr(weather, "_get_json", down)
    with SessionLocal() as db:
        out = weather.venue_weather(db, {"lat": 1.0, "lon": 2.0}, [{"id": 1, "start": "2025-05-05", "end": None}],
                                    {"start": "2026-10-10", "end": None}, today=date(2026, 10, 6))
    assert out["past"] == [] and out["forecast"] is None and "couldn't be reached" in out["note"]


# ---------- the API, on synthetic logs ----------

def _wait(client, url, timeout=180):
    t0 = time.monotonic()
    while time.monotonic() - t0 < timeout:
        r = client.get(url)
        assert r.status_code == 200, r.text
        body = r.json()
        if body["status"] not in ("queued", "running"):
            return body
        time.sleep(0.3)
    raise AssertionError(f"{url} still working after {timeout} s")


def test_prep_report_over_two_past_events(client, fixtures):
    track = client.post("/tracks", json={"name": "Test ring", "corners": [
        {"code": "T1", "apex_m": 300, "sector": None}, {"code": "T2", "apex_m": 700, "sector": None}]}).json()
    anna = client.post("/drivers", json={"name": "Anna"}).json()
    events = []
    for year, paces in (("2025", (0.95, 0.97, 0.96)), ("2026", (0.97, 0.99, 0.985))):
        ev = client.post("/events", json={"name": f"Test ring {year}", "track_id": track["id"]}).json()
        for n in range(2):
            s = client.post("/sessions", json={"event_id": ev["id"], "name": f"Run {n + 1}",
                                               "driver_id": anna["id"]}).json()
            log = write_ld(simulate(paces=paces)[0])
            r = client.post(f"/sessions/{s['id']}/files", files={"file": ("run.ld", log)})
            assert r.status_code == 201, r.text
        assert client.patch(f"/events/{ev['id']}", json={"start": f"{year}-05-05", "end": f"{year}-05-06"}) \
            .status_code == 200
        events.append(ev)
    upcoming = client.post("/events", json={"name": "Test ring 2027", "track_id": track["id"]}).json()
    client.patch(f"/events/{upcoming['id']}", json={"start": "2027-05-03", "end": "2027-05-04"})
    elsewhere = client.post("/events", json={"name": "Somewhere else"}).json()

    listed = client.get("/prep/events").json()["events"]
    assert listed[str(upcoming["id"])] == {"events": 2, "same_car_events": 2, "years": ["2025", "2026"],
                                           "upcoming": True}
    assert listed[str(events[1]["id"])]["years"] == ["2025"] and str(events[0]["id"]) not in listed
    assert str(elsewhere["id"]) not in listed

    none = client.get(f"/prep/events/{elsewhere['id']}").json()
    assert none["status"] == "none" and none["report"] is None and "no track" in none["reason"]
    first = client.get(f"/prep/events/{events[0]['id']}").json()
    assert first["status"] == "none" and "No past event at Test ring" in first["reason"]

    body = _wait(client, f"/prep/events/{upcoming['id']}")
    assert body["status"] == "ready", body.get("error")
    assert body["car"]["key"].startswith("logger:") and [e["name"] for e in body["past_events"]] == \
        ["Test ring 2025", "Test ring 2026"]
    rep = body["report"]
    assert [r["year"] for r in rep["performance"]] == ["2025", "2026"]
    assert rep["performance"][1]["change"]["best"] < 0  # the quicker paces of 2026
    assert rep["performance"][0]["drivers"][0]["name"] == "Anna"
    assert rep["briefing"][0]["key"] == "target"
    assert rep["corners"]["comparable"] and {r["code"] for r in rep["corners"]["rows"]} <= {"T1", "T2"}
    grip = rep["track_grip"]  # the test ring is too short at the grip limit to compare laps on: each event says so
    assert [e["year"] for e in grip["events"]] == ["2025", "2026"] and grip["guidance"] == []
    assert all("grip limit" in n for n in grip["notes"])

    again = client.get(f"/prep/events/{upcoming['id']}").json()
    assert again["status"] == "ready" and again["report"] == rep  # kept

    anyone = _wait(client, f"/prep/events/{upcoming['id']}?car=any")
    assert anyone["status"] == "ready" and anyone["car"]["key"] == "any"

    w = client.get(f"/prep/events/{upcoming['id']}/weather").json()
    assert w["place"] is not None and len(w["past"]) == 2  # the archive, from the fixtures

    r = client.post(f"/prep/events/{upcoming['id']}/refresh")
    assert r.status_code == 200 and r.json()["status"] in ("queued", "running", "ready")
    assert _wait(client, f"/prep/events/{upcoming['id']}")["status"] == "ready"
    assert client.get("/prep/events/9999").status_code == 404

    # the official results: our car found from the logged laps, each past event's sessions' official weather, and
    # the prediction told our logged best lap here
    from tests.test_prep_official import add_round
    for row, other in zip(rep["performance"], (0.9, 0.95), strict=True):
        year = int(row["year"])
        add_round("test-ring", "Test ring", year, 1, f"{year}-05-05", our_gap=1.0, our_finish=3,
                  pole=row["best"]["time"] / 1.01, race_pace=1.0)  # our best laps match in Q1 and R1
        add_round("other-ring", "Other ring", year, 2, f"{year}-06-07", our_gap=0.3, our_finish=2,
                  pole=row["best"]["time"] * other)
    off = client.get(f"/prep/events/{upcoming['id']}/results").json()
    assert (off["car_number"], off["car_number_from"]) == ("12", "found from the logged laps of Test ring 2026")
    assert off["weather"][str(events[0]["id"])][0] == {"code": "Q1", "dry": True, "air_c": 18.0, "track_c": 24.5,
                                                        "conditions": "Dry", "conditions_end": "Dry"}
    assert off["prediction"]["logged_best"]["time_s"] == pytest.approx(rep["performance"][1]["best"]["time"])
    assert off["lines"][0].startswith("2026: Q1 P4")
    # once the garage knows the car (its logger fitted to it), its number is ours
    serial = int(body["car"]["key"].split(":")[1])
    assert client.post("/garage/cars", json={"number": "21", "model": "Test GT4", "loggers": [serial]}) \
        .status_code == 201
    off = client.get(f"/prep/events/{upcoming['id']}/results").json()
    assert (off["car_number"], off["car_number_from"]) == ("21", "from the garage")

    # a planned event (made by hand or from the calendar) has only its venue as written: it finds the track by it
    planned = client.post("/planned-events", json={"name": "Round 3", "venue": "Test ring, Somewhere 12",
                                                   "start": "2027-06-01", "end": "2027-06-02"}).json()
    listed = client.get("/prep/events").json()["events"]
    assert listed[planned["key"]] == {"events": 2, "same_car_events": 2, "years": ["2025", "2026"], "upcoming": True}
