import pytest

from app.setup.suggest import Observation, driver_observations, suggest
from app.setup.templates import BMW_M4_GT4_EVO, GENERIC, InvalidSetup, clean_values, diff, warnings

BMW = BMW_M4_GT4_EVO

BASE = {"wing": 3, "arb_front": 3, "arb_rear": 2, "spring_front": 2, "spring_rear": 2,
        "bump_fl": 8, "bump_fr": 8, "bump_rl": 10, "bump_rr": 10, "rebound_fl": 8, "rebound_fr": 8,
        "rebound_rl": 8, "rebound_rr": 8, "ride_height_front": 156, "ride_height_rear": 162,
        "camber_fl": -3.4, "camber_fr": -3.4, "camber_rl": -2.8, "camber_rr": -2.8, "toe_rl": 1.0, "toe_rr": 1.0,
        "brake_balance": 56.5, "tc": 4, "abs": 5, "pressure_cold_fl": 1.45, "fuel": 60, "ballast": 30}


# ---------- templates ----------

def test_bmw_template_has_the_documented_adjustments():
    rows = BMW.rows
    assert (rows["arb"].layout, rows["arb"].min, rows["arb"].max) == ("axle", 1, 5)  # 5-position bars, both axles
    assert (rows["wing"].min, rows["wing"].max) == (1, 6)  # 6 wing settings
    assert [label for _, label in rows["spring"].options] == ["Soft", "Medium", "Stiff"]  # three H&R rates
    assert rows["bump"].layout == rows["rebound"].layout == "corner"  # KW 2-way, per corner
    assert rows["tc"].max == 10
    fields = BMW.fields()
    for key in ("ride_height_front", "ride_height_rear", "camber_rl", "toe_fr", "pressure_cold_rr", "fuel",
                "ballast", "abs", "brake_balance", "spring_rate_rear"):
        assert key in fields
    # every row says what a higher number means, so suggestions can step it the right way on any car
    assert all(r.up for t in (BMW, GENERIC) for r in t.rows.values())


def test_clean_values_keeps_numbers_and_refuses_what_the_car_cannot_take():
    out = clean_values(BMW, {"arb_front": 3.0, "camber_fl": -3.2, "fuel": None, "wing": ""})
    assert out == {"arb_front": 3, "camber_fl": -3.2}
    assert isinstance(out["arb_front"], int)
    with pytest.raises(InvalidSetup, match="not on the"):
        clean_values(BMW, {"diff_preload": 40})
    with pytest.raises(InvalidSetup, match="whole position"):
        clean_values(BMW, {"arb_rear": 2.5})
    with pytest.raises(InvalidSetup, match="one of"):
        clean_values(BMW, {"spring_front": 4})
    with pytest.raises(InvalidSetup, match="number"):
        clean_values(BMW, {"tc": True})


def test_warnings_flag_bop_ride_heights_camber_limits_and_positions():
    w = warnings(BMW, {"ride_height_front": 154.0, "ride_height_rear": 160.0, "camber_fl": -3.6,
                       "camber_rl": -3.1, "camber_rr": -3.0, "arb_front": 6, "pressure_cold_fl": 1.3, "fuel": 125})
    keys = {x["key"] for x in w}
    assert keys == {"ride_height_front", "camber_fl", "camber_rl", "arb_front", "pressure_cold_fl", "fuel"}
    assert any("155.0" in x["text"] for x in w)  # the BoP minimum is named


def test_diff_lists_changes_in_sheet_order():
    after = {**BASE, "arb_rear": 3, "spring_front": 3, "camber_fl": -3.2}
    d = diff(BMW, BASE, after)
    assert [c["key"] for c in d] == ["arb_rear", "spring_front", "camber_fl"]
    assert d[0]["text"] == "Anti-roll bar rear 2 → 3"
    assert d[1]["text"] == "Spring front Medium → Stiff"
    assert d[2]["delta"] == pytest.approx(0.2)
    assert diff(BMW, BASE, {**BASE, "tc": None})[0]["text"] == "TC 4 → not set"


# ---------- suggestions ----------

def _ranked(observations, values=BASE, template=BMW):
    return suggest(template, values, observations)["suggestions"]


def test_mid_corner_understeer_in_slow_corners_softens_the_front_bar_first():
    obs = [Observation("understeer", "mid", "T6", "slow"), Observation("understeer", "mid", "T8/T9", "slow")]
    out = _ranked(obs)
    assert out[0]["lever"] == "arb_front_softer"
    assert out[0]["changes"][0]["text"] == "Anti-roll bar front 3 → 2"
    assert "T6" in out[0]["reason"] and "T8/T9" in out[0]["reason"]
    assert all(s["lever"] != "wing_less" for s in out[:2])  # aero hardly works in slow corners


def test_fast_corner_understeer_brings_the_aero_forward():
    out = _ranked([Observation("understeer", "mid", "T7", "fast", weight=1.5)])
    levers = [s["lever"] for s in out]
    assert levers.index("wing_less") < levers.index("spring_front_softer")
    assert "rake_more" in levers


def test_a_bar_at_its_softest_position_is_not_suggested_softer():
    out = _ranked([Observation("understeer", "mid", "T6", "slow")], {**BASE, "arb_front": 1})
    assert "arb_front_softer" not in [s["lever"] for s in out]
    assert out[0]["lever"] == "arb_rear_stiffer"


def test_conflicting_feedback_is_weighed_and_named_as_a_risk():
    obs = [Observation("understeer", "mid", "T6", "slow"), Observation("traction", "exit", "T2-T5", "slow"),
           Observation("traction", "exit", "T8/T9", "slow")]
    out = {s["lever"]: s for s in _ranked(obs)}
    assert "arb_rear_stiffer" not in out or "traction" in out["arb_rear_stiffer"]["watch"]
    assert out["arb_front_softer"]["score"] > 0


def test_rake_change_never_goes_below_the_bop_ride_height():
    values = {**BASE, "ride_height_rear": 160.0}
    out = {s["lever"]: s for s in _ranked([Observation("oversteer", "mid", "T7", "fast")], values)}
    rake = out["rake_less"]["changes"][0]
    assert rake["key"] == "ride_height_front" and rake["to"] == 158.0  # raise the front instead


def test_dampers_step_the_right_way_for_the_click_convention():
    out = {s["lever"]: s for s in _ranked([Observation("understeer", "entry", "T1", "medium")])}
    bump = out["bump_front_softer"]["changes"]
    assert [(c["key"], c["from"], c["to"]) for c in bump] == [("bump_fl", 8, 10.0), ("bump_fr", 8, 10.0)]  # more open


def test_braking_instability_moves_the_balance_forward_and_lock_ups_rearward():
    out = _ranked([Observation("braking_stability", "braking", "T6")])
    assert out[0]["lever"] == "brake_balance_front"
    assert out[0]["changes"][0]["text"] == "Brake balance 56.5 → 57 % front"
    out = _ranked([Observation("lock_up", "braking", "T6")])
    assert out[0]["lever"] == "brake_balance_rear"


def test_without_a_sheet_changes_are_relative_steps():
    out = _ranked([Observation("understeer", "mid", "T6", "slow")], {})
    assert out[0]["changes"][0]["text"] == "Anti-roll bar front: one position softer"


def test_generic_template_uses_spring_rates():
    out = suggest(GENERIC, {"spring_rate_rear": 200.0}, [Observation("traction", "exit", "T2", "slow")] * 2)[
        "suggestions"]
    springs = next(s for s in out if s["lever"] == "spring_rear_softer")
    assert springs["changes"][0]["to"] == pytest.approx(180.0)


def test_driver_and_data_together_rank_higher():
    driver = Observation("understeer", "mid", "T6", "slow")
    data = Observation("understeer", "mid", "T6", "slow", source="data", time_s=0.08, text="T6 mid understeer")
    alone = _ranked([driver])[0]["score"]
    both = _ranked([driver, data])[0]
    assert both["score"] > 2 * alone
    assert both["sources"] == ["driver", "data"] and both["agreement"] == "both"
    assert "0.08 s" in both["reason"]


class _Point:
    def __init__(self, i, text, corner=None, phase=None, section="balance"):
        self.id, self.debrief_id, self.text, self.corner_code, self.section = i, 1, text, corner, section
        self.phase = type("P", (), {"value": phase})() if phase else None


def test_driver_observations_from_debrief_points():
    corners = [{"code": "T2-T5", "speed": "slow"}, {"code": "T7", "speed": "fast"}]
    points = [
        _Point(1, "Big understeer in the middle of the corner", "T3", "mid"),
        _Point(2, "No oversteer at all on exit", "T7"),
        _Point(3, "Lots of wheelspin coming out", "T4", section="priorities"),
        _Point(4, "The car pushes in the fast corners"),
        _Point(5, "Tyres were fine"),
        _Point(6, "It bottoms out over the kerbs", "T7"),
        _Point(7, "Sottosterzo in uscita", "T7"),
    ]
    obs, skipped = driver_observations(points, corners)
    by_id = {o.ref["debrief_point_id"]: o for o in obs}
    assert (by_id[1].kind, by_id[1].phase, by_id[1].speed) == ("understeer", "mid", "slow")  # T3 is in T2-T5
    assert (by_id[3].kind, by_id[3].phase, by_id[3].weight) == ("traction", "exit", 1.5)  # a driver priority
    assert (by_id[4].kind, by_id[4].speed) == ("understeer", "fast")
    assert by_id[6].kind == "ride"
    assert (by_id[7].kind, by_id[7].phase) == ("understeer", "exit")
    assert {s["id"] for s in skipped} == {2, 5}  # a negated claim, and nothing about balance


def test_repeats_are_capped():
    points = [_Point(i, "Understeer mid-corner", "T6", "mid") for i in range(5)]
    obs, _ = driver_observations(points, [])
    assert sum(o.weight for o in obs) == pytest.approx(1.5)


# ---------- the data side: the balance report ----------

def _summary():
    """A run summary built from an analyse()-shaped result (the balance report's own test fixture): the rear won't
    take power out of T6 and T8/T9, and the slow corners push mid-corner."""
    from app.analysis.balance import car_geometry
    from app.analysis.setup_advice import report
    from app.setup.results import summarize
    from tests.test_balance import _analysis, _row

    a = _analysis([_row("T6", 70, mid=2.0, exit_=-1.2, car=0.13, tc=0.8, slip=11),
                   _row("T8/T9", 75, mid=1.5, exit_=0.1, car=0.05, tc=0.6),
                   _row("T15-T17", 108, mid=0.7, exit_=-0.4, car=0.29, tc=1.3)],
                  [("slow", 0.2, 1.5, -0.3), ("medium", 0.1, 0.4, 0.0), ("fast", 0.0, 0.3, 0.2)], tc_per_lap=5.9)
    for i, sec in enumerate(a["sections"]):
        sec["apex_m"] = 500 * (i + 1)
    rep = report(a, car_geometry(None).to_dict(), [], "bmw-m4-gt4-evo")
    return summarize(a, rep, {"entry": 0.1, "mid": 1.1, "exit": -0.6, "abs_s_per_lap": 4.2})


def test_run_summary_comes_from_the_balance_report():
    s = _summary()
    b = s["balance"]
    assert (b["entry"], b["mid"], b["exit"], b["gradient_per_g"]) == (0.1, 1.1, -0.6, 1.0)
    assert [r["speed"] for r in b["by_speed"]] == ["slow", "medium", "fast"]
    assert [(c["code"], c["speed"]) for c in s["corners"]] == [("T6", "slow"), ("T8/T9", "slow"),
                                                               ("T15-T17", "slow")]  # 108 km/h is under 110
    t6 = s["sections"][0]
    assert (t6["mid"], t6["exit"], t6["tc_s"], t6["rear_slip_exit"]) == (2.0, -1.2, 0.8, 11)
    assert (s["tc_s_per_lap"], s["abs_s_per_lap"]) == (5.9, 4.2)
    assert s["advice"]["headline"].startswith("One weakness runs through the data")
    assert [r["key"] for r in s["advice"]["recommendations"]][:2] == ["rear_bar_softer", "rear_bump_softer"]


def test_the_data_measures_and_checks_each_remark():
    from app.setup import data

    s = _summary()
    seen = {(o.corner, o.kind, o.phase) for o in data.measured(s)}
    assert {("T6", "understeer", "mid"), ("T6", "oversteer", "exit"), ("T8/T9", "understeer", "mid")} <= seen
    assert ("T6", "traction", "exit") in seen  # 0.8 s of TC a pass and 11 % rear slip
    assert ("T15-T17", "understeer", "mid") not in seen  # 0.7 degrees is slight

    def verdict(*args):
        return data.check(Observation(*args), s)["verdict"]

    assert verdict("understeer", "mid", "T6") == "agree"
    assert verdict("oversteer", "mid", "T6") == "disagree"
    assert verdict("understeer", "mid", "T16") == "slight"  # T16 is in T15-T17
    assert verdict("understeer", "exit", "T8") == "normal"  # T8/T9 on exit: +0.1
    assert verdict("understeer", "mid", None, "slow") == "agree"  # the slow corners' row
    assert verdict("understeer", "entry", "T6") == "unmeasured"
    assert verdict("understeer", "mid", "T11") == "unmeasured"  # no such section
    assert verdict("traction", "exit", "T6") == "agree"
    assert verdict("traction", "exit", None) == "agree"  # 5.9 s of TC a lap
    assert data.check(Observation("lock_up", "braking", "T6"), s) is None  # not measured by the balance
    assert "+2.0°" in data.check(Observation("oversteer", "mid", "T6"), s)["text"]


def test_one_list_from_the_balance_report_and_the_debrief():
    from app.setup import data

    s = _summary()
    advice = s["advice"]["recommendations"]
    alone = suggest(BMW, BASE, [], advice=advice)["suggestions"]
    assert [x["lever"] for x in alone][:3] == ["arb_rear_softer", "bump_rear_softer", "wing_more"]  # its order
    assert all(x["agreement"] == "data" and x["sources"] == ["data"] for x in alone)
    assert alone[0]["report"]["rank"] == 1 and alone[0]["reason"] == ""

    driver = Observation("oversteer", "exit", "T6", "slow", text="The rear steps out on the throttle")
    driver.check = data.check(driver, s)
    out = suggest(BMW, BASE, [driver], advice=advice, measured=data.measured(s))["suggestions"]
    top = out[0]
    assert top["lever"] == "arb_rear_softer" and top["agreement"] == "both"
    assert top["sources"] == ["driver", "data"]
    assert top["changes"][0]["text"] == "Anti-roll bar rear 2 → 1"
    assert top["confirmed"][0].startswith("T6 on exit")
    assert top["score"] > alone[0]["score"] + 2.0  # the driver's remark, and both sides agreeing


def test_driver_and_data_disagreeing_is_shown():
    from app.setup import data

    s = _summary()
    loose = Observation("oversteer", "mid", "T6", "slow", text="Loose mid-corner in T6")
    loose.check = data.check(loose, s)  # the data reads +2.0: understeer
    out = {x["lever"]: x for x in suggest(BMW, BASE, [loose], measured=data.measured(s))["suggestions"]}
    stiffer = out["arb_front_stiffer"]
    assert stiffer["agreement"] == "disagree"
    assert stiffer["disagree"][0] == ("The driver said oversteer mid-corner at T6, but the data reads +2.0° against "
                                      "the car's normal, strong understeer (T6 mid-corner).")

    advice = [{"key": "rear_bar_softer", "title": "Rear anti-roll bar one step softer", "why": "Traction",
               "expect": "Less TC", "watch": None}]
    pushes = Observation("understeer", "exit", "T6", "slow")
    out = {x["lever"]: x for x in suggest(BMW, BASE, [pushes], advice=advice)["suggestions"]}
    assert out["arb_rear_stiffer"]["disagree"] == ["The balance report moves the roll stiffness the other way: Rear "
                                                   "anti-roll bar one step softer."]
    assert out["arb_front_softer"]["agreement"] == "disagree"  # a softer front bar undoes a softer rear bar
    assert out["arb_rear_softer"]["agreement"] == "disagree"
    assert out["arb_rear_softer"]["disagree"] == ["The driver's feedback points the other way: understeer on exit at "
                                                  "T6 (driver)."]

    at_softest = suggest(BMW, {**BASE, "arb_rear": 1}, [], advice=advice)
    assert at_softest["suggestions"] == []
    assert "can't take it" in at_softest["notes"][0]


# ---------- the API ----------

def _upload(client, sid):
    from tests.synthetic import simulate, write_ld
    channels, _ = simulate()
    r = client.post(f"/sessions/{sid}/files", files={"file": ("run.ld", write_ld(channels))})
    assert r.status_code == 201, r.text


def test_sheet_copy_previous_and_changes(client):
    event = client.post("/events", json={"name": "Test day"}).json()
    a, b = (client.post("/sessions", json={"name": n, "event_id": event["id"]}).json() for n in ("Run 1", "Run 2"))
    assert client.get("/setup/templates").json()[0]["key"] == "bmw-m4-gt4-evo"
    assert client.get("/setup/templates/bmw-m4-gt4-evo").json()["groups"][0]["name"] == "Aero"

    empty = client.get(f"/sessions/{a['id']}/setup").json()
    assert (empty["exists"], empty["template"], empty["previous"]) == (False, "bmw-m4-gt4-evo", None)
    assert client.post(f"/sessions/{a['id']}/setup/copy-previous").status_code == 409

    r = client.put(f"/sessions/{a['id']}/setup", json={"values": BASE, "notes": "Baseline"})
    assert r.status_code == 200, r.text
    assert r.json()["values"]["arb_front"] == 3
    assert client.put(f"/sessions/{a['id']}/setup", json={"values": {"arb_front": 2.5}}).status_code == 422

    copied = client.post(f"/sessions/{b['id']}/setup/copy-previous").json()
    assert copied["values"] == client.get(f"/sessions/{a['id']}/setup").json()["values"]
    assert copied["copied_from_session_id"] == a["id"] and copied["changes"] == []
    r = client.put(f"/sessions/{b['id']}/setup", json={"values": {**copied["values"], "arb_rear": 3,
                                                                  "ride_height_front": 150}}).json()
    assert [c["text"] for c in r["changes"]] == ["Anti-roll bar rear 2 → 3", "Ride height front 156 → 150 mm"]
    assert r["warnings"][0]["key"] == "ride_height_front"
    assert client.get(f"/sessions/{a['id']}/setup").json()["notes"] == "Baseline"  # notes kept when not sent
    assert [x["session_id"] for x in client.get("/setups").json()] == [b["id"], a["id"]]


def test_history_vehicle_and_suggestions(client):
    event = client.post("/events", json={"name": "Test day"}).json()
    a, b = (client.post("/sessions", json={"name": n, "event_id": event["id"]}).json() for n in ("Run 1", "Run 2"))
    _upload(client, a["id"])
    _upload(client, b["id"])
    client.put(f"/sessions/{a['id']}/setup", json={"values": BASE})
    client.put(f"/sessions/{b['id']}/setup", json={"values": {**BASE, "arb_front": 2}})

    h = client.get(f"/sessions/{b['id']}/setup/history").json()
    assert [r["name"] for r in h["runs"]] == ["Run 1", "Run 2"]
    assert all(r["needs_summary"] for r in h["runs"])
    for r in h["runs"]:
        res = client.get(f"/sessions/{r['session_id']}/setup/results").json()
        assert res["laps"]["clean_laps"] >= 1 and len(res["summary"]["corners"]) == 2
    h = client.get(f"/sessions/{b['id']}/setup/history").json()
    second = h["runs"][1]
    assert not second["needs_summary"]
    assert second["compared_with"]["name"] == "Run 1"
    assert [c["text"] for c in second["changes"]] == ["Anti-roll bar front 3 → 2"]
    assert second["deltas"]["best_s"] == pytest.approx(0.0, abs=1e-6)  # the same synthetic log

    v = client.get(f"/sessions/{b['id']}/setup/vehicle").json()
    assert v["vehicle"]["arb_front_setting"] == 2 and v["vehicle"]["arb_rear_setting"] == 2
    assert v["vehicle"]["mass_kg"] == pytest.approx(1480 + 30 + 85 + 60 * 0.75)
    assert v["vehicle"]["cog_height_mm"] == pytest.approx(460 + (156 + 162) / 2 - 157.5)
    assert any("H&R" in n for n in v["notes"])  # spring options without rates
    assert client.post("/vehicle/model", json=v["vehicle"]).status_code == 200
    plain = client.post("/sessions", json={"name": "No sheet"}).json()
    assert client.get(f"/sessions/{plain['id']}/setup/vehicle").status_code == 404

    client.post(f"/sessions/{b['id']}/debriefs", json={"points": [
        {"section": "balance", "text": "Understeer mid-corner", "corner_code": "C1", "phase": "mid"},
        {"section": "tyres", "text": "Tyres were fine"}]})
    s = client.get(f"/sessions/{b['id']}/setup/suggestions").json()
    assert s["observations"][0]["speed"] == "slow"  # C1 is a slow corner in the run summary
    assert s["suggestions"][0]["changes"][0]["text"] == "Anti-roll bar front 2 → 1"
    assert "Vehicle model" in s["suggestions"][0]["model"]
    assert len(s["skipped_points"]) == 1
    assert s["observations"][0]["check"]["verdict"] == "unmeasured"  # the synthetic log has no yaw rate
    assert s["data"]["headline"].startswith("This log has no usable steering or yaw rate channel")

    extra = {"observations": [{"kind": "oversteer", "phase": "exit", "corner": "C2", "weight": 3,
                               "text": "C2 exit oversteer", "time_s": 0.3}]}
    s = client.post(f"/sessions/{b['id']}/setup/suggestions", json=extra).json()
    assert s["observations"][-1]["speed"] == "slow" and s["observations"][-1]["source"] == "data"
    assert s["suggestions"][0]["lever"] == "arb_rear_softer"


def test_registered_data_sources_feed_the_suggestions(client):
    import app.setup.suggest as sg

    def balance_report(db, s):
        return [sg.Observation("understeer", "mid", "T6", "slow", source="data", time_s=0.1, text="T6 mid")]

    def broken(db, s):
        raise RuntimeError("no log")

    s = client.post("/sessions", json={"name": "Run"}).json()
    sg.register_data_source(balance_report)
    sg.register_data_source(broken)
    try:
        out = client.get(f"/sessions/{s['id']}/setup/suggestions").json()
    finally:
        sg._data_sources.clear()
    assert out["suggestions"][0]["lever"] == "arb_front_softer"
    assert out["suggestions"][0]["sources"] == ["data"]
    assert any("no log" in n for n in out["notes"])


def test_suggestions_use_the_runs_balance_report(client, monkeypatch):
    import app.setup.results as results

    summary = _summary()
    monkeypatch.setattr(results, "run_summary", lambda db, s: summary)
    sid = client.post("/sessions", json={"name": "Run"}).json()["id"]
    _upload(client, sid)
    client.put(f"/sessions/{sid}/setup", json={"values": BASE})
    client.post(f"/sessions/{sid}/debriefs", json={"points": [
        {"section": "balance", "text": "The rear steps out on the throttle", "corner_code": "T6", "phase": "exit"}]})
    out = client.get(f"/sessions/{sid}/setup/suggestions").json()
    assert out["data"]["headline"].startswith("One weakness runs through the data")
    assert out["observations"][0]["check"]["verdict"] == "agree"
    assert out["observations"][0]["speed"] == "slow"  # T6 from the report's corners
    assert {m["corner"] for m in out["measured"]} >= {"T6", "T8/T9"}
    top = out["suggestions"][0]
    assert (top["lever"], top["agreement"], top["report"]["rank"]) == ("arb_rear_softer", "both", 1)
    assert "Vehicle model" in top["model"]
