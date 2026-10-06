"""The track's grip level session by session: grip at the limit lap by lap, the tyre model's share taken out, the
evolution read in words, the prep report's guidance from it, and the endpoint on synthetic logs."""
import time

import numpy as np
import pytest

from app.analysis import track_grip as tg
from app.analysis.insights import LapRecord
from app.prep import track_grip as prep_tg
from tests.synthetic import simulate, write_ld
from tests.test_grip_per_load import _lap


# ---------- 1. grip at the limit ----------

def _grippier(tr: dict[str, np.ndarray], k: float) -> dict[str, np.ndarray]:
    """The same lap on a track with k times the grip: the same line, k times the g, sqrt(k) times the speed."""
    out = dict(tr)
    for key in ("ax", "ay", "turn_g"):
        out[key] = tr[key] * k
    out["speed"] = tr["speed"] * np.sqrt(k)
    return out


def test_a_grippier_track_reads_as_more_grip_at_the_limit():
    rng = np.random.default_rng(5)
    laps = []
    for i in range(10):
        k = 1.0 if i < 5 else 1.03
        tr = _grippier(_lap(1.0, rng), k)
        laps.append(LapRecord("green" if i < 5 else "rubbered", i, 100.0 - (k - 1) * 50, None, tr, i))
    m = tg.lap_grip(laps)
    assert m is not None and m.limit_m >= tg.MIN_LIMIT_M and m.road_load
    green = np.median([m.grip[x.key] for x in laps[:5]])
    rubbered = np.median([m.grip[x.key] for x in laps[5:]])
    assert rubbered - green == pytest.approx(0.03, abs=0.006)


def test_no_limit_places_no_measure():
    rng = np.random.default_rng(1)
    slow = [LapRecord("a", i, 100.0, None, {**_lap(1.0, rng), "phase": np.full(2001, 4.0)}, i) for i in range(4)]
    assert tg.lap_grip(slow) is None  # all on the power: nowhere grip-limited to compare


# ---------- 2. the tyres' share ----------

def _bins(grips, half=0.01, start=1.7, step=0.05):
    return {"bins": [{"from": start + i * step, "to": start + (i + 1) * step, "grip": g, "low": g - half,
                      "high": g + half, "samples": 100} for i, g in enumerate(grips)]}


def test_scatter_in_the_tyre_model_is_a_flat_line():
    assert tg.grip_curve(_bins([1.50, 1.505, 1.498, 1.502], half=0.02)) is None  # all within their own ranges
    assert tg.grip_curve(_bins([1.5, 1.6])) is None  # too few groups to tell
    x, y = tg.grip_curve(_bins([1.40, 1.45, 1.50, 1.55], half=0.005))
    assert list(np.round(x, 3)) == [1.725, 1.775, 1.825, 1.875]
    assert np.all(np.diff(y) > 0) and y[-1] - y[0] == pytest.approx(0.15, abs=0.01)  # clear: barely pulled in


def test_an_unsure_group_is_pulled_toward_the_average():
    cond = {"bins": [{"from": 1.7, "to": 1.75, "grip": 1.45, "low": 1.449, "high": 1.451},
                     {"from": 1.75, "to": 1.8, "grip": 1.50, "low": 1.499, "high": 1.501},
                     {"from": 1.8, "to": 1.85, "grip": 1.55, "low": 1.549, "high": 1.551},
                     {"from": 1.85, "to": 1.9, "grip": 1.80, "low": 1.30, "high": 2.30}]}  # one lap, wide
    _, y = tg.grip_curve(cond)
    assert y[-1] < 0.1  # nowhere near +0.3


def test_the_tyres_share_is_the_mean_of_the_axles():
    terms = {"front": {"bar": (np.array([1.7, 1.9]), np.array([-0.02, 0.02])),
                       "c": (np.array([80.0, 100.0]), np.array([0.0, 0.04]))}}
    lap = tg.LapIn("a#1", 1, 100.0, front_bar=1.8, front_c=100.0, rear_bar=1.8)
    assert tg.tyre_effect(terms, lap) == pytest.approx((0.0 + 0.04) / 2 / 2)  # front mean 0.02, rear flat 0
    assert tg.tyre_effect({}, lap) == 0.0
    assert tg.tyre_effect(terms, tg.LapIn("a#2", 2, 100.0)) == 0.0  # no tyre data on the lap


# ---------- 3. the evolution, in words ----------

def _session(key, name, start, levels, kind="other", t0=0.0, first_lap=1, wet=False, front_c=95.0):
    laps = [tg.LapIn(f"{key}#{i}", i, 100.0 + t0 + 0.01 * i, first_lap + i, front_c=front_c, front_bar=1.85,
                     wet=wet) for i in range(len(levels))]
    return tg.SessionIn(key, name, [int(key[1:])], start, kind, ["Anna"], 18.0, None, laps), \
        {lap.key: v for lap, v in zip(laps, levels, strict=True)}


def _event(*specs):
    sessions, measured = [], {}
    for spec in specs:
        s, m = _session(*spec[:4], **spec[4] if len(spec) > 4 else {})
        sessions.append(s)
        measured.update(m)
    return sessions, measured


def test_grip_rising_to_qualifying_and_where_it_came():
    sessions, measured = _event(
        ("s1", "FP1", "2026-05-01T10:00", [-0.01, 0.0, 0.0, 0.01, 0.0, -0.005]),
        ("s2", "FP2", "2026-05-01T14:00", [0.035, 0.04, 0.045, 0.04, 0.038], {"first_lap": 20}),
        ("s3", "Q", "2026-05-02T10:00", [0.045, 0.05, 0.048, 0.052], {"kind": "qualifying", "first_lap": 40}),
        ("s4", "R1", "2026-05-02T15:00", [0.0, 0.005, -0.005, 0.002, 0.0, 0.004], {"kind": "race", "first_lap": 50}))
    out = tg.evolution(sessions, measured, None, None)
    assert out["available"] and out["base"] == "FP1"
    rows = {r["name"]: r for r in out["sessions"]}
    assert rows["FP1"]["track"] == 0 and rows["Q"]["track"] == pytest.approx(4.9, abs=0.2)
    assert rows["Q"]["range"][0] < rows["Q"]["track"] < rows["Q"]["range"][1]
    assert out["headline"] == {"from": "FP1", "to": "Q", "change_pct": rows["Q"]["track"], "pm": rows["Q"]["pm"],
                               "sure": True, "by_lap": 20}
    assert out["read"][0].startswith("Grip rose about 5 % (± ")
    assert "most of it between FP1 and FP2, by the car's 20th lap of the event" in out["read"][0]
    assert any("Overnight the grip held" in s for s in out["read"])
    assert any(s.startswith("Against Q the races ran R1 \u22125 %") for s in out["read"])
    assert any("No tyre model" in s for s in out["read"])


def test_a_flat_track_held_and_a_dip_with_cool_tyres_is_put_down_to_the_car():
    sessions, measured = _event(
        ("s1", "D1S1", "2025-05-05T10:00", [0.0, 0.002, -0.002, 0.001]),
        ("s2", "D1S2", "2025-05-05T12:00", [0.002, 0.0, 0.003, 0.001]),
        ("s3", "D1S3", "2025-05-05T14:00", [-0.03, -0.028, -0.032, -0.03], {"front_c": 80.0}),
        ("s4", "D1S4", "2025-05-05T16:00", [0.001, 0.0, 0.002, 0.003]))
    out = tg.evolution(sessions, measured, None, None)
    assert out["read"][0].startswith("Grip held from D1S1 to D1S4")
    assert out["headline"]["sure"] is False
    dip = next(s for s in out["read"] if s.startswith("D1S3 was about 3 % below"))
    assert "front tyres ran cooler than in any other session (80 °C against 95-95)" in dip


def test_the_wiper_marks_a_wet_session_and_too_few_laps_get_no_range():
    sessions, measured = _event(
        ("s1", "FP1", "2026-05-01T10:00", [0.0, 0.01, 0.0]),
        ("s2", "FP2", "2026-05-01T14:00", [-0.12, -0.11, -0.13], {"wet": True}),
        ("s3", "FP3", "2026-05-01T16:00", [0.02, 0.03]))
    out = tg.evolution(sessions, measured, None, None)
    rows = {r["name"]: r for r in out["sessions"]}
    assert rows["FP2"]["wet"] and rows["FP3"]["range"] is None and rows["FP3"]["pm"] is None
    assert any(s.startswith("FP2: the wiper was on") for s in out["read"])


def test_the_tyre_models_share_is_taken_out():
    conditions = {"pressure": {"front": _bins([1.40, 1.45, 1.50, 1.55], half=0.005)}}
    sessions, measured = _event(("s1", "FP1", "2026-05-01T10:00", [0.0, 0.0, 0.0]),
                                ("s2", "FP2", "2026-05-01T14:00", [0.0, 0.0, 0.0]))
    for lap in sessions[1].laps:
        lap.front_bar = 1.875  # the model's grippiest pressure group
    for lap in sessions[0].laps:
        lap.front_bar = 1.725
    out = tg.evolution(sessions, measured, conditions, {"sessions": 4, "laps": 80, "tyre": "Slick"})
    fp2 = out["sessions"][1]
    assert fp2["measured"] == 0 and fp2["tyres"] > 2 and fp2["track"] == pytest.approx(-fp2["tyres"], abs=0.11)
    assert out["tyre_model"]["used"] and "pressure" in out["tyre_model"]["curves"]["front"]
    assert any("the tyre model (4 sessions, 80 laps of this car) expects" in s for s in out["read"])


def test_nothing_measured():
    sessions, _ = _event(("s1", "FP1", "2026-05-01T10:00", [0.0]))
    out = tg.evolution(sessions, {}, None, None)
    assert not out["available"] and out["notes"]


# ---------- the prep report's guidance ----------

def _answer(sessions, measured):
    return {"status": "ready", "result": tg.evolution(sessions, measured, None, None)}


def test_prep_guidance_from_one_past_event_says_so():
    sessions, measured = _event(
        ("s1", "FP1", "2025-05-01T10:00", [-0.01, 0.0, 0.0, 0.01, 0.0, -0.005], {"front_c": 88.0}),
        ("s2", "FP2", "2025-05-01T14:00", [0.035, 0.04, 0.045, 0.04, 0.038], {"first_lap": 20}),
        ("s3", "Q", "2025-05-02T10:00", [0.045, 0.05, 0.048, 0.052], {"kind": "qualifying", "first_lap": 40}),
        ("s4", "R1", "2025-05-02T15:00", [0.0, 0.005, -0.005, 0.002], {"kind": "race", "first_lap": 50}))
    ev = prep_tg.event_summary(3, "Spring cup", "2025", _answer(sessions, measured))
    assert ev["available"] and ev["base"] == "FP1" and ev["peak"]["session"] == "Q" and ev["by_lap"] == 20
    assert ev["quali"]["pct"] == pytest.approx(4.9, abs=0.2)
    assert ev["races_vs_quali"][0]["pct"] == pytest.approx(-4.8, abs=0.3)
    assert ev["first_tyres"]["front_c"] == -7.0
    out = prep_tg.summarise([ev])
    g = out["guidance"]
    assert g[0].startswith("Expect the first runs about 5 % ± ") and "Spring cup 2025 FP1" in g[0]
    assert g[1].startswith("Most of it comes in the car's first 20 laps of the weekend")
    assert any(s.startswith("By qualifying the track was +5 %") for s in g)
    assert any(s.startswith("The races ran \u22125 % against qualifying") for s in g)
    tyres = next(s for s in g if s.startswith("Against the later sessions, in the first (FP1 2025)"))
    assert "the fronts ran 7 °C cooler (about 0.05 bar lower hot at the same cold pressures)" in tyres
    assert "say the cold pressures were set differently" in tyres and "a lap more to come in" in tyres
    assert out["sureness"].startswith("From one past event only (Spring cup 2025)")


def test_prep_guidance_when_qualifying_came_first():
    sessions, measured = _event(
        ("s1", "Q", "2026-09-19T13:00", [0.0, 0.002, -0.002], {"kind": "qualifying"}),
        ("s2", "R1", "2026-09-19T18:40", [-0.07, -0.068, -0.072, -0.07], {"kind": "race", "first_lap": 10}),
        ("s3", "R2", "2026-09-20T13:20", [-0.06, -0.062, -0.064, -0.063], {"kind": "race", "first_lap": 40}))
    ev = prep_tg.event_summary(5, "Autumn cup", "2026", _answer(sessions, measured))
    assert ev["peak"] is None and ev["quali"] is None and len(ev["races_vs_quali"]) == 2
    g = prep_tg.summarise([ev])["guidance"]
    assert g[0].startswith("Qualifying is the first session logged at Autumn cup 2026")
    assert g[1].startswith("The races ran \u22127 to \u22126 % against qualifying")


def test_prep_guidance_over_two_events_gives_the_range():
    events = []
    for year, rise in (("2024", 0.03), ("2025", 0.06)):
        sessions, measured = _event(
            ("s1", "FP1", f"{year}-05-01T10:00", [0.0, 0.001, -0.001]),
            ("s2", "FP2", f"{year}-05-01T14:00", [rise, rise + 0.001, rise - 0.001], {"first_lap": 15}))
        events.append(prep_tg.event_summary(int(year), "Spring cup", year, _answer(sessions, measured)))
    events.append(prep_tg.event_summary(9, "Spring cup", "2026", {"status": "empty", "reason": "No clean laps."}))
    out = prep_tg.summarise(events)
    assert out["guidance"][0].startswith("Expect the first runs about 4 % down on grip") or \
        out["guidance"][0].startswith("Expect the first runs about 5 % down on grip")
    assert "\u22126 to \u22123 %" in out["guidance"][0] and "over 2 events" in out["guidance"][0]
    assert out["sureness"].startswith("From 2 past events")
    assert out["notes"] == ["Spring cup (2026): its track grip is left out: No clean laps."]
    assert prep_tg.summarise([]) is None


# ---------- the endpoint, on synthetic logs ----------

def test_the_endpoint_waits_for_the_report_then_answers_and_keeps_it(client):
    track = client.post("/tracks", json={"name": "Test ring", "corners": []}).json()
    ev = client.post("/events", json={"name": "Test ring 2025", "track_id": track["id"]}).json()
    for n, paces in enumerate(((0.98, 0.99, 0.985, 0.99), (0.995, 1.0, 0.998, 1.0))):
        s = client.post("/sessions", json={"event_id": ev["id"], "name": f"Run {n + 1}"}).json()
        r = client.post(f"/sessions/{s['id']}/files", files={"file": ("run.ld", write_ld(simulate(paces=paces)[0]))})
        assert r.status_code == 201, r.text
    t0 = time.monotonic()
    while True:
        body = client.get(f"/track-grip/events/{ev['id']}").json()
        if body["status"] != "waiting" or time.monotonic() - t0 > 180:
            break
        time.sleep(0.3)
    assert body["status"] == "ready", body
    assert body["car"]["key"].startswith("logger:")
    res = body["result"]
    # the test track's two short corners are too little of the lap at the grip limit to compare laps on: said so
    assert res["method"] and not res["available"] and "never ride at the car's grip limit" in res["notes"][-1]
    from app.db import SessionLocal
    from app.routers import track_grip as router
    with SessionLocal() as db:
        assert db.query(router.TrackGripCache).count() == 1
    assert client.get(f"/track-grip/events/{ev['id']}").json() == body  # kept
    assert client.get("/track-grip/events/9999").status_code == 404
    empty = client.post("/events", json={"name": "Nothing yet"}).json()
    assert client.get(f"/track-grip/events/{empty['id']}").json()["status"] == "empty"
