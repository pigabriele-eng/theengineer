import copy

import pytest

from app.results.predict import backtest, is_wet, predict_round

TEAM = "Borusan Otomotiv Motorsport"
# Other cars: number -> gap to pole (%) in every qualifying. Ours sits at 1.0 %.
FIELD = {"1": 0.0, "2": 0.4, "3": 0.8, "4": 1.3, "5": 1.8, "6": 2.5}
BASE = {"alpha": 100.0, "bravo": 120.0, "charlie": 90.0}
PACE = {2023: 1.01, 2024: 1.0, 2025: 0.99, 2026: 0.98}


def _quali(year, order, venue, code, *, us_gap=1.0, wet=False, pole=None):
    pole = pole or BASE[venue] * PACE[year]
    cars = [("12", TEAM, us_gap)] + [(n, f"Team {n}", g) for n, g in FIELD.items()]
    cars.sort(key=lambda c: c[2])
    rows = [{
        "position": i + 1, "status": "classified", "car_number": n, "drivers": ["A.Driver"], "team": t,
        "entrant": t, "car_class": "Silver", "car_model": "BMW M4 GT4" if n == "12" else "Other GT4",
        "brand": "BMW" if n == "12" else "Other", "laps": None, "best_lap_s": round(pole * (1 + g / 100), 3),
        "best_lap_no": 3, "total_time_s": None, "gap_s": None, "gap_laps": None, "diff_s": None, "kph": None,
    } for i, (n, t, g) in enumerate(cars)]
    cond = "Wet" if wet else "Dry"
    return {"year": year, "round_id": f"{year}{order}", "round_name": venue.title(), "venue": venue, "order": order,
            "code": code, "title": code, "kind": "qualifying", "number": int(code[1]), "date": None, "track": None,
            "length_m": None, "weather": {"conditions_start": cond, "conditions_end": cond, "track_c_start": 30.0},
            "fastest": None, "rows": rows}


def _race(quali, code, *, our_finish):
    """Race: every other car keeps its grid order, we finish at ``our_finish``."""
    grid = [r["car_number"] for r in quali["rows"]]
    others = [n for n in grid if n != "12"]
    order = [*others[: our_finish - 1], "12", *others[our_finish - 1:]]
    rows = []
    for i, n in enumerate(order):
        src = next(r for r in quali["rows"] if r["car_number"] == n)
        rows.append({**src, "position": i + 1, "laps": 30, "best_lap_s": src["best_lap_s"] + 1.5})
    return {**quali, "code": code, "title": code, "kind": "race", "number": int(code[1]), "rows": rows}


def _round(year, order, venue, *, us_gap=1.0, our_finish=2, wet_q=False):
    q1 = _quali(year, order, venue, "Q1", us_gap=us_gap, wet=wet_q)
    q2 = _quali(year, order, venue, "Q2", us_gap=us_gap, wet=wet_q)
    return [q1, q2, _race(q1, "R1", our_finish=our_finish), _race(q2, "R2", our_finish=our_finish)]


def _season(year, venues, **kw):
    return [s for i, v in enumerate(venues, start=1) for s in _round(year, i, v, **kw)]


@pytest.fixture
def sessions():
    return (_season(2023, ["alpha", "bravo", "charlie"]) + _season(2024, ["alpha", "bravo", "charlie"])
            + _season(2025, ["bravo", "alpha", "charlie"]))


def test_pole_is_venue_base_times_season_pace(sessions):
    p = predict_round(sessions, "alpha", 2025, car_number="12", team=TEAM, with_ranges=False)
    assert p["before_order"] == 2
    assert p["sessions"]["Q1"]["pole_s"] == pytest.approx(99.0, abs=0.05)
    assert p["components"]["season_pace_pct"] == pytest.approx(-1.0, abs=0.05)
    assert p["components"]["previous_dry_visits"] == [2023, 2024]


def test_our_time_gap_and_position(sessions):
    p = predict_round(sessions, "alpha", 2025, car_number="12", team=TEAM, with_ranges=False)
    q = p["sessions"]["Q1"]
    assert q["our_gap_pct"] == pytest.approx(1.0, abs=0.01)
    assert q["our_time_s"] == pytest.approx(99.0 * 1.01, abs=0.05)
    assert q["position"] == 4  # cars at 0.0, 0.4, 0.8 % are quicker
    assert q["class_position"] == 4
    assert q["field_size"] == 7
    # We always finished P2 from P4: the race prediction moves us forward.
    assert p["sessions"]["R1"]["position"] < q["position"]
    assert p["explain"] and all(isinstance(line, str) for line in p["explain"])
    assert any("Alpha" in line for line in p["explain"])


def test_no_lookahead(sessions):
    before = predict_round(sessions, "alpha", 2025, car_number="12", team=TEAM)
    changed = copy.deepcopy(sessions)
    for s in changed:
        if s["year"] == 2025 and s["order"] >= 2:  # the round itself and everything after it
            for r in s["rows"]:
                r["best_lap_s"] = r["best_lap_s"] * 1.2 if r["best_lap_s"] else None
                r["position"] = 40 - (r["position"] or 0)
    changed += _season(2026, ["alpha"], us_gap=3.0)  # a later season too
    after = predict_round(changed, "alpha", 2025, car_number="12", team=TEAM)
    assert after["sessions"] == before["sessions"]
    assert after["components"] == before["components"]
    # Dropping the target round entirely (an upcoming round) gives the same answer with an explicit cutoff.
    upcoming = [s for s in sessions if not (s["year"] == 2025 and s["order"] >= 2)]
    ahead = predict_round(upcoming, "alpha", 2025, car_number="12", team=TEAM, before_order=2)
    assert ahead["sessions"] == before["sessions"]


def test_wet_sessions_are_left_out_of_times(sessions):
    base = predict_round(sessions, "alpha", 2025, car_number="12", team=TEAM, with_ranges=False)
    wet = _round(2024, 4, "alpha", us_gap=5.0, wet_q=True)
    for s in wet[:2]:
        for r in s["rows"]:
            r["best_lap_s"] *= 1.1
    assert is_wet(wet[0])
    p = predict_round(sessions + wet, "alpha", 2025, car_number="12", team=TEAM, with_ranges=False)
    assert p["sessions"]["Q1"]["pole_s"] == base["sessions"]["Q1"]["pole_s"]
    assert p["sessions"]["Q1"]["our_gap_pct"] == base["sessions"]["Q1"]["our_gap_pct"]


def test_logged_best_pulls_our_time(sessions):
    base = predict_round(sessions, "alpha", 2025, car_number="12", team=TEAM, with_ranges=False)
    fast = predict_round(sessions, "alpha", 2025, car_number="12", team=TEAM, with_ranges=False, logged_best_s=99.2)
    t0, t1 = base["sessions"]["Q1"]["our_time_s"], fast["sessions"]["Q1"]["our_time_s"]
    assert 99.2 * 0.997 < t1 < t0
    assert fast["sessions"]["Q1"]["position"] <= base["sessions"]["Q1"]["position"]
    assert fast["components"]["logged_best"]["logged_best_s"] == 99.2


def test_new_venue_has_no_times_but_positions(sessions):
    p = predict_round(sessions, "delta", 2025, car_number="12", team=TEAM, with_ranges=False)
    assert p["before_order"] == 4
    assert p["sessions"]["Q1"]["pole_s"] is None and p["sessions"]["Q1"]["our_time_s"] is None
    assert p["sessions"]["Q1"]["position"] == 4
    assert p["sessions"]["R2"]["position"] is not None
    assert "No dry qualifying at Delta" in p["explain"][0]


def test_earlier_years_found_by_team(sessions):
    # Last year we raced as #11: the team still identifies us; this year's #12 rows are ours.
    for s in sessions:
        if s["year"] < 2025:
            for r in s["rows"]:
                if r["car_number"] == "12":
                    r["car_number"] = "11"
    p = predict_round(sessions, "bravo", 2025, car_number="12", team=TEAM, with_ranges=False)
    assert p["components"]["form_last_season_pct"] == pytest.approx(1.0, abs=0.01)
    assert p["sessions"]["Q1"]["position"] == 4


def test_backtest_shape_and_matches_predictions(sessions):
    bt = backtest(sessions, years=(2024, 2025))
    assert [(r["year"], r["venue"]) for r in bt["rounds"]] == [
        (2024, "alpha"), (2024, "bravo"), (2024, "charlie"), (2025, "bravo"), (2025, "alpha"), (2025, "charlie")]
    alpha = bt["rounds"][4]
    p = predict_round(sessions, "alpha", 2025, car_number="12", team=TEAM, with_ranges=False)
    assert alpha["predicted"]["Q1"]["pole_s"] == p["sessions"]["Q1"]["pole_s"]
    assert alpha["actual"]["Q1"]["pole_s"] == pytest.approx(99.0)
    assert alpha["abs_error"]["pole_s"] == pytest.approx(0.0, abs=0.05)
    assert alpha["abs_error"]["q_pos"] == pytest.approx(0.0, abs=0.01)
    overall = bt["overall"]["all"]
    for key in ("pole_s", "pole_pct", "time_s", "q_pos", "r_pos"):
        assert {"model_mae", "baseline_mae", "n", "baseline_n"} <= set(overall[key])
    assert set(bt["overall"]) == {"all", "2024", "2025"}
    assert all(isinstance(r["summary"], str) for r in bt["rounds"])
    assert bt["summary"]


def test_season_linked_only_by_a_new_circuit_stays_sane():
    # Data starts in 2024; so far in 2025 the only dry qualifying was at a circuit never raced
    # before ("delta"), which says nothing about 2025 pace. The fit must not run away.
    BASE["delta"] = 110.0
    try:
        sessions = _season(2024, ["alpha", "bravo"]) + _round(2025, 1, "delta")
        p = predict_round(sessions, "alpha", 2025, car_number="12", team=TEAM, with_ranges=False)
    finally:
        del BASE["delta"]
    assert p["before_order"] == 2
    assert abs(p["components"]["season_pace_pct"]) <= 5.0
    assert p["sessions"]["Q1"]["pole_s"] == pytest.approx(100.0, abs=0.05)  # 2024 pace carried over
    assert p["sessions"]["Q1"]["our_time_s"] == pytest.approx(101.0, abs=0.1)
    assert any("last season's pace is used" in line for line in p["explain"])


def test_changed_track_is_set_aside(sessions):
    # Bravo was 5 % slower before 2025 (old layout): those visits must not drag the new pole.
    for s in sessions:
        if s["venue"] == "bravo" and s["year"] < 2025:
            for r in s["rows"]:
                r["best_lap_s"] = round(r["best_lap_s"] * 1.05, 3)
    sessions += _season(2026, ["alpha", "bravo"])
    p = predict_round(sessions, "bravo", 2026, car_number="12", team=TEAM, with_ranges=False)
    assert p["sessions"]["Q1"]["pole_s"] == pytest.approx(120.0 * 0.98, abs=0.1)
    assert any("different track" in line for line in p["explain"])


def test_predicted_vs_actual_rows(sessions):
    from app.results.predict import actual_round, compare
    p = predict_round(sessions, "alpha", 2025, car_number="12", team=TEAM)
    rows = {(r["code"], r["what"]): r for r in compare(p, actual_round(sessions, "alpha", 2025, car_number="12",
                                                                         team=TEAM))}
    assert {("Q1", "pole"), ("Q1", "our_lap"), ("Q1", "position"), ("R1", "position")} <= set(rows)
    pole = rows[("Q1", "pole")]
    assert pole["actual"] == pytest.approx(99.0) and pole["miss"] == pytest.approx(0.0, abs=0.05)
    assert pole["inside"] is True and rows[("R1", "position")]["status"] == "classified"
