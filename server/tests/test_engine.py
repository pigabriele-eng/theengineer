from itertools import pairwise

import numpy as np
import pytest

from app.analysis.align import aligned_trace, track_line
from app.analysis.channels import BRAKE, POWER, math_channels
from app.analysis.compare import compare_groups, sources_from_runs
from app.analysis.insights import RunInput, analyze_runs, make_sections
from app.analysis.laps import analyze, compare_laps, detect_corners, lap_trace, load_session
from app.analysis.scan import channel_scan
from app.debrief.check import read_claim
from app.importers.motec import read_ld
from tests.synthetic import TRACK_M, simulate, write_ld


@pytest.fixture(scope="module")
def data():
    channels, lap_times = simulate()
    return load_session(read_ld(write_ld(channels))), lap_times


def test_math_channels_from_accelerometers(data):
    d, _ = data
    math_channels(d)
    c = d.channels
    assert 1.2 < np.abs(c["ay"]).max() < 1.6  # the synthetic corners pull 1.4 g at the quickest lap's apex
    assert c["ax"].min() < -0.5 and c["ax"].max() > 0.2
    phases = set(np.unique(c["phase"]).astype(int))
    assert BRAKE in phases and POWER in phases
    apex = np.argmin(np.abs(d.distance - (TRACK_M * 2 + 300)))  # T1 on the quickest lap
    assert c["curvature"][apex] > 0.02


def test_cornering_from_gps_when_there_are_no_accelerometers():
    channels, _ = simulate()
    for name in ("gLat", "gLong", "nYaw"):
        del channels[name]
    d = load_session(read_ld(write_ld(channels)))
    math_channels(d)
    # the GPS track is a 1 km circle: lateral g is v^2 / r on the straights
    v = d.channels["speed"] / 3.6
    fast = (v > 40) & (d.t > 40)
    expected = v[fast] ** 2 / (TRACK_M / (2 * np.pi)) / 9.81
    assert np.median(np.abs(d.channels["ay"][fast]) / expected) == pytest.approx(1.0, abs=0.1)


def test_laps_are_timed_line_to_line_by_position(data):
    d, lap_times = data
    ref = next(l for l in d.laps if l.number == 2)
    line = track_line(d, ref)
    for lap in d.laps:
        tr = aligned_trace(d, lap, line)
        # the 10 Hz start/finish marker is up to 0.1 s off; the position-based crossing is not
        assert tr["t"][-1] == pytest.approx(lap_times[lap.number], abs=0.05)
        assert len(tr["t"]) == line.length + 1  # both ends of the lap, on the line
        assert np.all(np.diff(tr["t"]) > 0)


def test_insights_without_a_reference_lap(data):
    d, lap_times = data
    res = analyze_runs([RunInput("run", d)])
    best = min(lap_times[1:5])
    # the laps are one lap at different paces: no place shows more than the fastest lap, so the theoretical lap is it
    assert res["theoretical_lap"] == pytest.approx(best, abs=0.01)
    assert res["ideal_lap"] <= best + 0.01
    assert res["numbering"] == "detected"
    assert [s["code"] for s in res["sections"]] == ["C1", "C2"]
    assert all(s["to_theoretical"] >= 0 for s in res["sections"])
    laps = {l["lap"]: l for l in res["laps"]}
    assert laps[2]["extraction"] > laps[3]["extraction"]  # the quicker lap extracted more
    assert 90 < laps[3]["extraction"] < 100
    assert laps[2]["medal"] in ("gold", "silver", "bronze")
    assert set(laps[2]["scores"]) == {"braking", "turn_in", "mid_corner", "traction"}
    assert res["top_speeds"] and res["top_speeds"][0]["groups"]["run"]["best"] > 140
    assert res["setup"]["lateral_grip_by_speed"]
    assert len(res["trace"]["theoretical_speed"]) == len(res["trace"]["reference_speed"])


def test_official_corner_numbers_name_the_sections(data):
    d, _ = data
    res = analyze_runs([RunInput("run", d)], [("T1", 300), ("T2", 690)])
    assert res["numbering"] == "official"
    assert [s["code"] for s in res["sections"]] == ["T1", "T2"]


def test_grouped_and_flat_corners():
    # slowest points at 300 and 700; T2/T3 sit together, T4 is a flat kink far from either
    d = np.arange(1000)
    ref = {"speed": 150 - 100 * np.exp(-((d - 300) / 45.0) ** 2) - 80 * np.exp(-((d - 700) / 45.0) ** 2)}
    secs, numbering = make_sections(ref, [("T1", 300), ("T2", 690), ("T3", 740), ("T4", 950)])
    assert numbering == "official"
    assert [s.code for s in secs] == ["T1", "T2/T3", "T4"]
    assert secs[0].start == 0 and secs[-1].end == 999


def test_a_flat_bottomed_corner_is_one_corner():
    # a hairpin held at its slowest speed for a few metres: every point of the flat bottom is a minimum
    d = np.arange(1000)
    v = 150 - 100 * np.exp(-((d - 300) / 45.0) ** 2) - 80 * np.exp(-((d - 700) / 45.0) ** 2)
    flat = np.abs(d - 700) < 20
    v[flat] = v[flat].max()
    found = detect_corners({"speed": v})
    assert len(found) == 2 and found[0].apex == 300 and 680 < found[1].apex < 720
    # the second corner starts on the straight before it, so its braking zone is inside it
    assert found[1].start < 600 < found[1].apex < found[1].end


def test_a_corner_just_before_the_line_is_found():
    d = np.arange(4000)
    v = 200 - 120 * np.exp(-((d - 1500) / 45.0) ** 2) - 120 * np.exp(-((d - 3970) / 45.0) ** 2)
    v -= 120 * np.exp(-((d + 30) / 45.0) ** 2)  # the hairpin's braking zone wraps round past the line
    found = detect_corners({"speed": v})
    assert [c.code for c in found] == ["C1", "C2"]
    assert found[0].apex == 1500 and abs(found[1].apex - 3970) <= 2
    # a flat-bottomed slowest point straddling the line counts once
    v = np.roll(v, 30)
    v[-20:], v[:20] = v[0], v[0]
    assert [c.code for c in detect_corners({"speed": v})] == ["C1", "C2"]


def test_two_drivers_compared():
    fast = load_session(read_ld(write_ld(simulate(paces=(1.0, 0.99, 0.995))[0])))
    slow = load_session(read_ld(write_ld(simulate(paces=(0.96, 0.95, 0.955))[0])))
    runs = [RunInput("A run", slow), RunInput("B run", fast)]
    res = compare_groups(sources_from_runs(runs, {"A run": "a", "B run": "b"}), {"a": "Anna", "b": "Ben"})
    assert res["typical_gap_s"] > 0.5  # Anna is slower
    assert {g["faster"] for g in res["where_time_goes"]} == {"b"}
    assert [res["summary"][g]["label"] for g in ("a", "b")] == ["Anna", "Ben"]
    assert res["summary"]["b"]["median_extraction"] > res["summary"]["a"]["median_extraction"]
    assert set(res["top_speeds"][0]["groups"]) == {"a", "b"}
    assert all(r.data.channels == {} for r in runs)  # each run's channels are dropped once its laps are reduced


class _Channel:
    def __init__(self, t, v, unit=""):
        self._t, self._v, self.unit, self.count = t, v, unit, len(v)

    def times(self):
        return self._t

    def values(self):
        return self._v


class _Log:
    def __init__(self, channels):
        self.channels = channels


def test_channel_scan_finds_slow_channels_that_move_with_lap_time():
    from app.analysis.laps import Lap
    rng = np.random.default_rng(1)
    items = []
    for run in range(3):
        laps, t0 = [], 0.0
        temps, rpm = [], []
        for i in range(8):
            temp = 80 + rng.normal(0, 3)
            time = 100 - 0.05 * (temp - 80) + rng.normal(0, 0.02)
            laps.append(Lap(i + 1, t0, t0 + time, round(time, 3), True))
            temps.append(np.full(int(time * 10), temp))
            rpm.append(5000 + 2000 * np.sin(np.arange(int(time * 10))))
            t0 += time
        t = np.concatenate([np.arange(len(x)) / 10 + l.start for x, l in zip(temps, laps, strict=True)])
        log = _Log({"TTyreFL": _Channel(t, np.concatenate(temps), "C"),
                    "nEngine": _Channel(t, np.concatenate(rpm), "rpm"),
                    "Lap Time": _Channel(t, np.repeat([l.time for l in laps], [len(x) for x in temps]), "s")})
        items.append((f"run {run}", log, laps))
    found = channel_scan(items)
    assert [f["channel"] for f in found] == ["TTyreFL"]  # rpm moves within every lap; lap time is skipped
    assert found[0]["r"] < -0.8 and found[0]["category"] == "tyres"
    assert found[0]["window"]["from"] > 80  # quickest when hotter


@pytest.mark.parametrize("text,kind,negated,phase", [
    ("Understeer on entry to the hairpin", "understeer", False, "entry"),
    ("The car is loose on exit", "oversteer", False, "exit"),
    ("Sottosterzo a centro curva", "understeer", False, "mid"),
    ("Heck kommt beim Ausgang", "oversteer", False, "exit"),
    ("No understeer at T8 any more", "understeer", True, None),
    ("Locking the front into T1", "lock_up", False, None),
    ("Unstable under braking for T6", "braking_stability", False, "braking"),
    ("Lots of wheelspin out of T6", "traction", False, None),
    ("Tyres drop off after five laps", "tyre_drop", False, None),
])
def test_debrief_claims_are_read(text, kind, negated, phase):
    c = read_claim(text)
    assert (c.kind, c.negated, c.phase) == (kind, negated, phase)


def test_engine_endpoints(client):
    track = client.post("/tracks", json={"name": "Test ring", "corners": [
        {"code": "T1", "apex_m": 300}, {"code": "T2", "apex_m": 690}]}).json()
    event = client.post("/events", json={"name": "Test day", "track_id": track["id"]}).json()
    anna = client.post("/drivers", json={"name": "Anna"}).json()
    ids = []
    for paces, driver in (((0.96, 0.95, 0.955), anna["id"]), ((1.0, 0.99, 0.995), None)):
        s = client.post("/sessions", json={"event_id": event["id"], "driver_id": driver}).json()
        r = client.post(f"/sessions/{s['id']}/files", files={"file": ("run.ld", write_ld(simulate(paces=paces)[0]))})
        assert r.status_code == 201, r.text
        ids.append(s["id"])

    one = client.get(f"/sessions/{ids[0]}/insights").json()
    assert one["numbering"] == "official" and [s["code"] for s in one["sections"]] == ["T1", "T2"]
    assert one["laps"][0]["driver"] == "Anna"
    both = client.post("/insights", json={"session_ids": ids}).json()
    assert len(both["runs"]) == 2 and both["theoretical_lap"] <= min(r["best"] for r in both["runs"])

    cmp = client.post("/compare/drivers", json={"a": {"label": "Anna", "session_ids": [ids[0]]},
                                                "b": {"label": "Ben", "session_ids": [ids[1]]}})
    assert cmp.status_code == 200, cmp.text
    assert cmp.json()["typical_gap_s"] > 0
    picked = client.post("/compare/drivers", json={
        "a": {"label": "Early", "laps": [{"session_id": ids[1], "laps": [1]}]},
        "b": {"label": "Late", "laps": [{"session_id": ids[1], "laps": [2, 3]}]}}).json()
    assert picked["summary"]["a"]["laps"] == 1 and picked["summary"]["b"]["laps"] == 2

    d = client.post(f"/sessions/{ids[0]}/debriefs", json={"points": [
        {"section": "balance", "text": "Understeer mid-corner", "corner_code": "T1"},
        {"section": "issues", "text": "Radio was quiet"},
        {"section": "traction", "text": "Wheelspin out of T2"},  # typed: the corner is in the words
    ]}).json()
    check = client.get(f"/debriefs/{d['id']}/check").json()
    assert [p["claim"] for p in check["points"]] == ["understeer", None, "traction"]
    # the synthetic laps have too little cornering for the car's balance gradient: the point says so
    assert check["points"][0]["section"] == "T1" and check["points"][0]["line"].startswith("The balance can't be")
    assert check["balance"] is None
    assert check["points"][1]["verdict"] == "cannot check" and check["points"][1]["agreement"] == "unclear"
    assert check["points"][2]["section"] == "T2"
    assert sum(check["agreement"].values()) == 3


def test_corners_in_one_sector_are_one_section():
    # T2-T4 slow complex at 300, T5 a flat kink at 520; the track times T2 to T5 as one sector
    d = np.arange(1000)
    ref = {"speed": 150 - 100 * np.exp(-((d - 300) / 45.0) ** 2) - 80 * np.exp(-((d - 700) / 45.0) ** 2)}
    corners = [("T1", 100, None), ("T2", 280, "T2-T5"), ("T3", 300, "T2-T5"), ("T4", 320, "T2-T5"),
               ("T5", 520, "T2-T5"), ("T6", 700, None)]
    apart, _ = make_sections(ref, [c[:2] for c in corners])
    assert [s.code for s in apart] == ["T1", "T2-T4", "T5", "T6"]
    secs, numbering = make_sections(ref, corners)
    assert numbering == "official"
    assert [s.code for s in secs] == ["T1", "T2-T5", "T6"]
    joined = secs[1]
    assert (joined.start, joined.end) == (apart[1].start, apart[2].end) and joined.apex == 300
    assert secs[0].end == joined.start and joined.end == secs[2].start


def test_known_track_gets_its_corners(client):
    t = client.post("/tracks", json={"name": "Hockenheimring"}).json()
    sectors = {c["code"]: c["sector"] for c in t["corners"]}
    assert len(t["corners"]) == 17 and sectors["T2"] == sectors["T5"] == "T2-T5" and sectors["T6"] is None
    t = client.put(f"/tracks/{t['id']}/corners", json=[{"code": "T1", "apex_m": 280}]).json()
    assert [c["code"] for c in t["corners"]] == ["T1"]


# The synthetic lap laid out like Hockenheim: a flat T1, the T2-T5 sector around the first slow point (T5 a flat
# kink well after it), and two official corners close together at the second slow point.
SECTORED = [("T1", 100, None), ("T2", 280, "T2-T5"), ("T3", 300, "T2-T5"), ("T4", 320, "T2-T5"),
            ("T5", 520, "T2-T5"), ("T6", 690, None), ("T7", 740, None)]


def test_session_corners_use_the_official_numbers(data):
    d, lap_times = data
    res = analyze(d, corners=SECTORED)
    assert res["numbering"] == "official"
    codes = [c["code"] for c in res["corners"]]
    ref = next(l for l in d.laps if l.number == res["reference_lap"])
    assert codes == [s.code for s in make_sections(lap_trace(d, ref, res["length_m"]), SECTORED)[0]]
    assert codes == ["T1", "T2-T5", "T6/T7"]
    t1, sector, pair = res["corners"]
    assert t1["apex_m"] == 100  # a flat kink sits at its official position
    assert abs(sector["apex_m"] - 300) < 20 and abs(pair["apex_m"] - 700) < 20
    assert sector["start_m"] < 280 and sector["end_m"] > 520  # T5 is timed inside the T2-T5 section
    assert res["corners"][0]["start_m"] == 0 and res["corners"][-1]["end_m"] == res["length_m"] - 1
    assert all(a["end_m"] == b["start_m"] for a, b in pairwise(res["corners"]))
    assert res["theoretical_best"] <= min(lap_times[1:5]) + 0.05

    cmp = compare_laps(d, lap_number=3, ref_number=res["reference_lap"], corners=SECTORED)
    assert cmp["numbering"] == "official"
    assert cmp["corners"] == [{k: c[k] for k in ("code", "apex_m", "start_m", "end_m")} for c in res["corners"]]


def test_session_corners_without_official_numbers_are_not_t_numbers(data):
    d, _ = data
    res = analyze(d)
    assert res["numbering"] == "detected"
    assert [c["code"] for c in res["corners"]] == ["C1", "C2"]
    cmp = compare_laps(d, lap_number=3)
    assert cmp["numbering"] == "detected" and [c["code"] for c in cmp["corners"]] == ["C1", "C2"]


def test_session_page_endpoints_number_corners_from_the_track(client):
    track = client.post("/tracks", json={"name": "Test ring", "corners": [
        {"code": code, "apex_m": m, "sector": sector} for code, m, sector in SECTORED]}).json()
    event = client.post("/events", json={"name": "Test day", "track_id": track["id"]}).json()
    on_track = client.post("/sessions", json={"event_id": event["id"]}).json()
    unknown = client.post("/sessions", json={}).json()  # no event, and the log names no venue
    for s in (on_track, unknown):
        r = client.post(f"/sessions/{s['id']}/files", files={"file": ("run.ld", write_ld(simulate()[0]))})
        assert r.status_code == 201, r.text

    analysis = client.get(f"/sessions/{on_track['id']}/analysis").json()
    assert analysis["numbering"] == "official"
    assert [c["code"] for c in analysis["corners"]] == ["T1", "T2-T5", "T6/T7"]
    cmp = client.get(f"/sessions/{on_track['id']}/compare", params={"lap": 3}).json()
    assert cmp["numbering"] == "official"
    assert [(c["code"], c["apex_m"]) for c in cmp["corners"]] == [(c["code"], c["apex_m"]) for c in analysis["corners"]]
    insights = client.get(f"/sessions/{on_track['id']}/insights").json()
    assert [s["code"] for s in insights["sections"]] == ["T1", "T2-T5", "T6/T7"]  # the same numbers everywhere

    analysis = client.get(f"/sessions/{unknown['id']}/analysis").json()
    assert analysis["numbering"] == "detected" and [c["code"] for c in analysis["corners"]] == ["C1", "C2"]
    cmp = client.get(f"/sessions/{unknown['id']}/compare", params={"lap": 3}).json()
    assert cmp["numbering"] == "detected" and [c["code"] for c in cmp["corners"]] == ["C1", "C2"]
