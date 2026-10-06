"""The prep report's official results: our places at the track each year with the official weather, strong or weak
track, the makes compared, and the prediction for the coming round with how far predictions missed before."""
from app.prep import official

US, TEAM = "12", "Our Team"
# (car, team, make, gap to the fastest in %) in every qualifying
FIELD = [("8", "Team One", "Audi", 0.0), ("33", "Team Three", "BMW", 0.2), ("44", "Team Four", "Porsche", 0.6),
         ("55", "Team Five", "Ford", 1.4)]


def add_round(venue, name, year, order, day, our_gap, our_finish, pole=100.0, wet=False, race_pace=1.03):
    """One official round: Q1 and R1, our car among four others."""
    from app.db import SessionLocal  # the test's own database
    from app.results import models as rm

    cars = sorted([(US, TEAM, "BMW", our_gap), *FIELD], key=lambda c: c[3])
    cond = "Wet" if wet else "Dry"
    with SessionLocal() as db:
        rnd = rm.ResultRound(series="gt4-europe", year=year, round_id=f"{venue}{year}", name=name, venue=venue,
                             order=order)
        q = rm.ResultSession(code="Q1", title="Qualifying 1", kind="qualifying", starts_at=f"{day}T11:15:00",
                             source_url="https://example.invalid/q1.pdf",
                             weather={"air_c_start": 18.0, "track_c_start": 24.5, "conditions_start": cond,
                                      "conditions_end": cond})
        q.rows = [rm.ResultRow(position=i + 1, status="classified", car_number=n, team=t, brand=b, car_class="Silver",
                               car_model=f"{b} GT4", best_lap_s=round(pole * (1 + g / 100), 3), drivers=["A.Driver"])
                  for i, (n, t, b, g) in enumerate(cars)]
        others = [c for c in cars if c[0] != US]
        order_r = others[:our_finish - 1] + [c for c in cars if c[0] == US] + others[our_finish - 1:]
        r = rm.ResultSession(code="R1", title="Race 1", kind="race", starts_at=f"{day}T17:00:00",
                             source_url="https://example.invalid/r1.pdf",
                             weather={"air_c_start": 20.0, "track_c_start": 28.0, "conditions_start": "Dry"})
        r.rows = [rm.ResultRow(position=i + 1, status="classified", car_number=n, team=t, brand=b, car_class="Silver",
                               car_model=f"{b} GT4", laps=30, best_lap_s=round(pole * (race_pace + g / 100), 3),
                               total_time_s=3600 + i * 3.0, drivers=["A.Driver"])
                  for i, (n, t, b, g) in enumerate(order_r)]
        rnd.sessions = [q, r]
        db.add(rnd)
        db.commit()


def two_seasons():
    for year in (2025, 2026):
        add_round("test-ring", "Test ring", year, 1, f"{year}-05-04", our_gap=1.0, our_finish=3)
        add_round("other-ring", "Other ring", year, 2, f"{year}-06-07", our_gap=0.3, our_finish=2, pole=90.0)


def test_how_far_to_trust_the_prediction():
    bt = {"years": [2023, 2024, 2025, 2026], "overall": {"all": {
        "pole_s": {"model_mae": 0.85, "baseline_mae": 0.99}, "time_s": {"model_mae": 0.92, "baseline_mae": 1.27},
        "r_pos": {"model_mae": 5.5, "baseline_mae": 7.1}, "q_pos": {"model_mae": 9.0, "baseline_mae": 8.6}}}}
    assert official.trust_line(bt) == (
        "How far to trust it: predicting each round of 2023-2026 from what was known before it, the model beat a "
        "simple guess on pole (0.85 s against 0.99 s), our quali lap (0.92 s against 1.27 s) and race finish (5.5 "
        "against 7.1 places), but our quali position was still about 9 places off on average.")
    assert official.trust_line({"overall": {"all": {}}}) is None
    # logged laps name our car only at the meeting itself, not at a test day there the same year
    assert official._same_meeting([{"starts_at": "2026-05-05T11:15:00"}], "2026-05-04", "2026-05-06")
    assert not official._same_meeting([{"starts_at": "2026-09-19T11:15:00"}], "2026-05-04", "2026-05-06")
    # the report looks back: the event's own meeting and later ones are left out
    h = {"years": [{"year": y, "sessions": [{"starts_at": f"{y}-05-04T11:15:00"}]} for y in (2026, 2025)],
         "brands": [{"year": 2026}, {"year": 2025}]}
    assert [y["year"] for y in official.before(h, "2026-05-03", 2026)["years"]] == [2025]
    assert official.before(h, None, 2026)["brands"] == [{"year": 2025}]
    pred = {"sessions": {"Q1": {"position": 6, "position_range": [4, 9], "our_time_s": 101.0},
                         "Q2": {"position": None}, "R1": {"position": 5, "position_range": [3, 8]}}}
    assert official.prediction_line(pred) == \
        "Q1 around P6 (likely P4-P9) with a 1:41.00; R1 about P5 (P3-P8), in the dry and if we finish."


def test_official_results_at_the_track(client):
    track = client.post("/tracks", json={"name": "Test ring"}).json()
    ev = client.post("/events", json={"name": "Test ring 2027", "track_id": track["id"]}).json()
    client.patch(f"/events/{ev['id']}", json={"start": "2027-05-03", "end": "2027-05-04"})
    url = f"/prep/events/{ev['id']}/results"

    body = client.get(url).json()
    assert body["venue"] == "test-ring" and not body["loaded"] and "No official results loaded" in body["note"]

    two_seasons()
    body = client.get(url).json()
    assert body["loaded"] and body["car_number"] is None and "Which car number is ours" in body["note"]
    assert [y["year"] for y in body["years"]] == [2026, 2025] and body["prediction"] is None

    client.put(f"/results/events/{ev['id']}/link", json={"car_number": "#12"})
    body = client.get(url).json()
    assert (body["car_number"], body["car_number_from"], body["team"], body["brand"]) == \
        ("12", "set for this event", TEAM, "BMW")
    q1 = body["years"][0]["sessions"][0]
    assert (q1["code"], q1["place"], q1["to_fastest_pct"], q1["weather"]["track_c"]) == ("Q1", "P4", 1.0, 24.5)
    assert body["lines"][0] == "2026: Q1 P4 (1.00 % off the fastest), R1 P3."
    verdict = body["track_verdict"]
    assert verdict["verdict"] == "weak" and verdict["strongest"] == ["Other ring"]
    assert verdict["text"].startswith("Test ring is a weak track for us: in dry qualifying we were 0.35 % further")
    makes = body["makes"]
    assert [r["brand"] for r in makes["rows"]][:2] == ["Audi", "BMW"] and makes["rows"][1]["ours"]
    assert makes["text"].startswith("In 2026 Q1 the quickest BMW was #33")

    pred = body["prediction"]
    assert pred["sessions"]["Q1"]["position"] is not None and pred["line"].startswith("Q1 around P")
    assert pred["explain"] and body["trust"]["years"] == [2026]
    assert "beat a simple guess on quali position (0.5 against 0.8 places)" in body["trust"]["text"]
    assert body["note"] is None
