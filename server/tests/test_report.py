"""The report: compact session traces, the advice worked out from them, and the cached report behind the API."""
import re
import time
from dataclasses import replace

import numpy as np
import pytest

from app.analysis import compact
from app.analysis.advice import build_report, lap_text
from app.analysis.insights import RunInput, analyze_runs
from app.analysis.laps import load_session
from app.analysis.scan import scan_medians
from app.importers.motec import read_ld
from app.routers.reports import _plain
from tests.synthetic import simulate, write_ld

# Laid out like Hockenheim: a flat T1, the T2-T5 sector around the first slow point and two official corners close
# together at the second.
SECTORED = [("T1", 100, None), ("T2", 280, "T2-T5"), ("T3", 300, "T2-T5"), ("T4", 320, "T2-T5"),
            ("T5", 520, "T2-T5"), ("T6", 690, None), ("T7", 740, None)]
RUNS = {"Run 1": (0.95, 0.97, 0.96, 0.975, 0.965), "Run 2": (0.98, 1.0, 0.985, 0.99, 0.97)}


def _log(paces):
    return read_ld(write_ld(simulate(paces=paces)[0]))


@pytest.fixture(scope="module")
def runs():
    out = []
    for name, paces in RUNS.items():
        ld = _log(paces)
        out.append((name, ld, load_session(ld)))
    return out


@pytest.fixture(scope="module")
def reduced(runs):
    return [compact.reduce_session(data, name, ld=ld) for name, ld, data in runs]


def test_a_session_reduces_to_compact_traces_that_survive_storage(runs, reduced):
    _, _, data = runs[0]
    cs = reduced[0]
    clean = [l for l in data.laps if l.clean]
    assert cs.n_laps == len(clean) == 5
    assert list(cs.times) == [l.time for l in clean] and list(cs.index_in_run) == [0, 1, 2, 3, 4]
    assert cs.traces["speed"].dtype == np.float32 and cs.traces["phase"].dtype == np.int8
    assert cs.traces["speed"].shape == (5, cs.length + 2 * compact.PAD_M + 1)
    # each lap is timed from the line: its time at the far end of the lap is its lap time
    at_end = cs.traces["t"][:, compact.PAD_M + cs.length]
    assert np.allclose(at_end, cs.times, atol=0.05)

    back = compact.from_file(compact.to_bytes(cs))
    assert (back.name, back.length, list(back.numbers)) == (cs.name, cs.length, list(cs.numbers))
    for role, arr in cs.traces.items():
        assert np.array_equal(back.traces[role], arr), role
    assert back.line is not None and abs(back.line.length - cs.line.length) < 1
    assert set(back.channels) == set(cs.channels)
    assert cs.nbytes() < 2_000_000  # a few laps of a 1 km track: small


def test_laps_of_another_session_land_on_the_reference_line(reduced):
    a, b = reduced
    # the same circle logged twice: a's laps on b's line stay where they were, to the metre
    pos = compact.positions_on(a, b.line, b.length)
    assert np.max(np.abs(pos - np.arange(b.length + 1) * a.length / b.length)) < 3
    laps = compact.laps_on(a, b.line, b.length)
    assert len(laps) == a.n_laps and len(laps[0]["distance"]) == b.length + 1
    assert all(abs(tr["t"][-1] - t) < 0.1 for tr, t in zip(laps, a.times, strict=True))


def test_report_from_compact_traces_matches_the_engine(runs, reduced):
    prep, extras = compact.prepare_compact([(1, reduced[0]), (2, reduced[1])], SECTORED)
    rep = build_report(prep, extras, SECTORED)
    full = analyze_runs([RunInput(name, data) for name, _, data in runs], SECTORED)

    h = rep["headline"]
    assert h["fastest"]["run"] == "Run 2" and h["fastest"]["session_id"] == 2
    assert abs(h["fastest"]["time"] - min(min(s.times) for s in reduced)) < 1e-6
    assert h["theoretical"] <= h["ideal"] <= h["fastest"]["time"] <= h["typical"]
    # the realistic target lies between the theoretical lap and the fastest lap (here, whose laps are the same lap
    # at different paces, the fastest lap is a quick lap's usual everywhere)
    assert h["theoretical"] <= h["realistic"] <= 1.002 * h["fastest"]["time"]
    assert abs(h["ideal"] - full["ideal_lap"]) < 0.05
    assert abs(h["theoretical"] - full["theoretical_lap"]) < 0.05
    assert 0 < h["score"]["extraction"] <= 100 and h["score"]["medal"]

    assert [s["code"] for s in rep["sections"]] == ["T1", "T2-T5", "T6/T7"]
    assert 1 <= len(rep["gains"]) <= 3
    assert all(g["seconds"] > 0 and g["code"] in {"T1", "T2-T5", "T6/T7"} for g in rep["gains"])
    assert [g["seconds"] for g in rep["gains"]] == sorted((g["seconds"] for g in rep["gains"]), reverse=True)
    for s in rep["sections"]:
        # the best pass may come from another lap's line: perfect driving on the fastest lap's line is about as quick
        assert s["times"]["theoretical"] <= 1.005 * s["times"]["best"]
        assert s["times"]["best"] <= s["times"]["typical"] + 1e-6
        assert set(s["where"]) <= {"braking", "entry", "mid-corner", "exit", "full throttle"}
        assert s["ladder"]["driving"] >= 0
    assert rep["trends"]["runs"][1]["best"] == h["fastest"]["time"]
    tr = rep["trace"]
    assert len(tr["typical"]) == len(tr["quick"]) == len(tr["theoretical"]) == rep["length_m"] // tr["step_m"] + 1
    assert rep["laps_analysed"] == 10 and rep["runs_analysed"] == 2


def test_the_traces_can_be_let_go_as_their_laps_are_placed(reduced):
    """consume: each session's compact traces go once its laps are on the line, and the report is the same."""
    want = build_report(*compact.prepare_compact([(1, reduced[0]), (2, reduced[1])], SECTORED), SECTORED)
    copies = [replace(cs, traces=dict(cs.traces)) for cs in reduced]
    got = build_report(*compact.prepare_compact([(1, copies[0]), (2, copies[1])], SECTORED, consume=True), SECTORED)
    assert [cs.traces for cs in copies] == [{}, {}] and all(cs.traces for cs in reduced)
    assert _plain(got) == _plain(want)


def test_report_names_corners_by_number_only(reduced):
    prep, extras = compact.prepare_compact([(1, reduced[0]), (2, reduced[1])], SECTORED)
    rep = build_report(prep, extras, SECTORED)
    words = " ".join(_strings(rep))
    corners = set(re.findall(r"\bT\d+(?:[-/]T?\d+)?\b", words))
    assert corners and corners <= {"T1", "T2", "T3", "T4", "T5", "T6", "T7", "T2-T5", "T6/T7"}


def _strings(x):
    if isinstance(x, str):
        yield x
    elif isinstance(x, dict):
        for v in x.values():
            yield from _strings(v)
    elif isinstance(x, list):
        for v in x:
            yield from _strings(v)


def test_a_lap_time_relation_in_plain_words():
    from app.analysis.advice import _relation
    vals = np.array([80, 82, 84, 86, 88, 90, 81, 83, 85, 87, 89, 91], float)
    runs = ["a"] * 6 + ["b"] * 6
    rel = _relation("the front left tyre temperature", "°C", vals, runs, -0.02, -0.7, 12, 1e-4, True, "lap", 0)
    within = vals - np.repeat([85.0, 86.0], 6)  # sized over the spread within a run, not across runs
    span = np.percentile(within, 90) - np.percentile(within, 10)
    assert rel["sure"] == "sure" and rel["seconds"] == pytest.approx(0.02 * span, abs=1e-3)
    assert rel["text"] == f"Within a run, laps where the front left tyre temperature was {span:.0f} °C higher were " \
                          f"{0.02 * span:.2f} s quicker."
    assert _relation("x", "", vals, runs, -0.001, -0.7, 12, 1e-4, True, "lap", 0) is None  # too small to matter


def test_logger_channel_names_in_words():
    from app.analysis.advice import channel_words
    assert channel_words("TGearbox") == "the gearbox temperature"
    assert channel_words("POilEngine") == "the oil engine pressure"
    assert channel_words("FuelLevel") == "the fuel level"
    assert channel_words("BrakeTempFL") == "the brake temp FL"
    assert channel_words("Fuel_Used") == "the fuel used"


def test_a_relation_carried_by_the_warm_up_laps_is_flagged():
    from app.analysis.advice import _only_warm_up
    rng = np.random.default_rng(5)
    runs = [r for r in "abc" for _ in range(8)]
    index = np.array([i for _ in "abc" for i in range(8)])
    warm = np.where(index < 2, 60.0 + 10 * index, 80.0) + rng.normal(0, 0.5, 24)  # tyres warm over two laps
    slow_start = np.where(index < 2, 2.0 - index, 0.0) + rng.normal(0, 0.05, 24)  # and the first laps are slow
    assert _only_warm_up(warm, 100 + slow_start, runs, index, -0.8)
    hot = 80 + rng.normal(0, 3, 24)  # hotter is quicker on every lap
    assert not _only_warm_up(hot, 100 - 0.05 * hot + rng.normal(0, 0.02, 24), runs, index, -0.8)


def test_what_goes_with_lap_time_is_ranked_and_leaves_out_the_obvious(reduced):
    prep, extras = compact.prepare_compact([(1, reduced[0]), (2, reduced[1])], SECTORED)
    rels = build_report(prep, extras, SECTORED)["lap_time_relations"]
    for group in (False, True):  # what holds once the car is warm first, each part strongest first
        rs = [abs(r["r"]) for r in rels if r["warm_up"] is group]
        assert rs == sorted(rs, reverse=True)
    assert [r["warm_up"] for r in rels] == sorted(r["warm_up"] for r in rels)
    assert all(r["seconds"] >= 0.05 and r["sure"] in ("very sure", "sure", "fairly sure") for r in rels)
    assert not any("grip" in r["label"] for r in rels)


def test_channel_scan_from_kept_lap_medians():
    rng = np.random.default_rng(3)
    items = []
    for run in range(3):
        temps = 80 + rng.normal(0, 3, 8)
        times = list(100 - 0.05 * (temps - 80) + rng.normal(0, 0.02, 8))
        items.append((f"run {run}", times, {"TOil": ("C", temps, 0.5), "nEngine": ("rpm", rng.normal(5000, 5, 8),
                                                                                       900.0)}))
    found = scan_medians(items)
    assert [f["channel"] for f in found] == ["TOil"]  # rpm moves a lot within every lap and not with lap time
    assert found[0]["r"] < -0.8


def test_lap_text():
    assert lap_text(107.44) == "1:47.44" and lap_text(59.5) == "59.50"


# ---------- the API ----------

def _wait(client, url, timeout=120):
    t0 = time.monotonic()
    while time.monotonic() - t0 < timeout:
        r = client.get(url)
        assert r.status_code == 200, r.text
        body = r.json()
        if body["status"] not in ("queued", "running"):
            return body
        assert body["progress"]["total"] >= 1
        time.sleep(0.2)
    raise AssertionError(f"{url} still working after {timeout} s")


def test_event_and_session_reports(client):
    track = client.post("/tracks", json={"name": "Test ring", "corners": [
        {"code": code, "apex_m": m, "sector": sector} for code, m, sector in SECTORED]}).json()
    event = client.post("/events", json={"name": "Test day", "track_id": track["id"]}).json()
    anna = client.post("/drivers", json={"name": "Anna"}).json()
    ids = []
    for (name, paces), driver in zip(RUNS.items(), (anna["id"], None), strict=True):
        s = client.post("/sessions", json={"event_id": event["id"], "name": name, "driver_id": driver}).json()
        r = client.post(f"/sessions/{s['id']}/files", files={"file": ("run.ld", write_ld(simulate(paces=paces)[0]))})
        assert r.status_code == 201, r.text
        ids.append(s["id"])

    first = client.get(f"/reports/events/{event['id']}").json()
    assert first["status"] in ("queued", "running", "ready") and first["title"] == "Test day"
    body = _wait(client, f"/reports/events/{event['id']}")
    assert body["status"] == "ready" and not body["stale"], body.get("error")
    rep = body["report"]
    assert [s["code"] for s in rep["sections"]] == ["T1", "T2-T5", "T6/T7"]
    assert rep["runs_analysed"] == 2 and rep["trends"]["runs"][0]["driver"] == "Anna"
    assert [c["code"] for c in rep["corners"]] == [c[0] for c in SECTORED]
    assert [s["included"] for s in body["sessions"]] == [True, True]
    assert body["track"] == "Test ring"

    # kept: asked again it answers at once from the cache
    again = client.get(f"/reports/events/{event['id']}").json()
    assert again["status"] == "ready" and again["report"] == rep

    # asked in the moment between the job saving the report and letting go of it: ready, never "done"
    from app.routers import reports
    scope = f"event:{event['id']}"
    assert reports.claim(reports._lock, reports._pending, scope)
    try:
        assert client.get(f"/reports/events/{event['id']}").json()["status"] == "ready"
    finally:
        with reports._lock:
            reports._pending.discard(scope)

    one = _wait(client, f"/reports/sessions/{ids[1]}")
    assert one["status"] == "ready" and one["report"]["runs_analysed"] == 1

    # another session joins the event: the report is worked out again, the last one shown meanwhile as stale
    s = client.post("/sessions", json={"event_id": event["id"], "name": "Run 3"}).json()
    client.post(f"/sessions/{s['id']}/files", files={"file": ("run.ld", write_ld(simulate(paces=(0.9, 0.92))[0]))})
    changed = client.get(f"/reports/events/{event['id']}").json()
    if changed["status"] != "ready":
        assert changed["stale"] and changed["report"] == rep
    body = _wait(client, f"/reports/events/{event['id']}")
    assert body["status"] == "ready" and body["report"]["runs_analysed"] == 3

    r = client.post(f"/reports/events/{event['id']}/refresh")
    assert r.status_code == 200 and r.json()["status"] in ("queued", "running", "ready")
    assert _wait(client, f"/reports/events/{event['id']}")["status"] == "ready"


def test_report_without_laps_and_unknown_ids(client):
    event = client.post("/events", json={"name": "Empty day"}).json()
    client.post("/sessions", json={"event_id": event["id"], "name": "No log"})
    body = client.get(f"/reports/events/{event['id']}").json()
    assert body["status"] == "empty" and body["report"] is None
    assert body["sessions"][0]["note"] == "No logger file" and not body["sessions"][0]["included"]
    assert client.get("/reports/events/9999").status_code == 404
    assert client.get("/reports/sessions/9999").status_code == 404


def test_report_json_is_plain():
    from app.routers.reports import _plain
    out = _plain({"a": np.float32(1.5), "b": [np.nan, np.int64(3), np.inf], "c": (np.bool_(True), "x")})
    assert out == {"a": 1.5, "b": [None, 3, None], "c": [True, "x"]}
    assert type(out["b"][1]) is int


def test_a_long_event_keeps_its_quickest_laps(reduced, monkeypatch):
    from app.routers import reports
    monkeypatch.setattr(reports, "MAX_LAPS", 6)
    kept, left_out = reports._quickest([(1, reduced[0]), (2, reduced[1])])
    times = sorted(np.concatenate([cs.times for cs in reduced]))
    n = sum(cs.n_laps for _, cs in kept)
    assert left_out == 10 - n and n == sum(t <= times[5] for t in times)  # the quickest six, and any tied with them
    assert max(t for _, cs in kept for t in cs.times) == times[5]
    for _, cs in kept:
        assert cs.traces["speed"].shape[0] == cs.n_laps == len(cs.index_in_run)
        assert all(len(med) == cs.n_laps for _, med, _ in cs.channels.values())


def test_a_log_that_trips_the_reduction_leaves_only_its_session_out(client, monkeypatch):
    from app.analysis import compact as compact_module
    event = client.post("/events", json={"name": "Test day"}).json()
    ids = []
    for name, paces in RUNS.items():
        s = client.post("/sessions", json={"event_id": event["id"], "name": name}).json()
        client.post(f"/sessions/{s['id']}/files", files={"file": ("run.ld", write_ld(simulate(paces=paces)[0]))})
        ids.append(s["id"])
    real = compact_module.reduce_log

    def flaky(ld, name, *a, **k):
        if name == "Run 1":
            raise RuntimeError("unexpected layout")
        return real(ld, name, *a, **k)
    monkeypatch.setattr(compact_module, "reduce_log", flaky)
    body = _wait(client, f"/reports/events/{event['id']}")
    assert body["status"] == "ready" and body["report"]["runs_analysed"] == 1
    note = {s["name"]: s for s in body["sessions"]}["Run 1"]
    assert not note["included"] and "unexpected layout" in note["note"]
