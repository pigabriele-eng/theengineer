"""Technique check: a lap's mistakes against perfect driving, what each costs, and the ones that repeat."""
import time

import numpy as np
import pytest

from app.analysis.insights import _closed_sim
from app.analysis.laps import Section
from app.analysis.limits import DIRECTIONS, CarLimits
from app.analysis.technique import Envelope, check_lap, habits
from tests.synthetic import curvature_at, simulate, write_ld

G = 9.81
N = 1000  # a 1 km loop with two corners, at 300 and 700 m
SECTIONS = [Section("T1", 0, 500, 300, ["T1"]), Section("T2", 500, N, 700, ["T2"])]
CORNERS = [("T1", 300.0, None), ("T2", 700.0, None)]


@pytest.fixture(scope="module")
def lim() -> CarLimits:
    speeds = np.array([50.0, 100.0, 150.0, 200.0])
    line = np.arange(0, 260, 10.0)
    return CarLimits(speeds=speeds, envelope=np.full((len(speeds), len(DIRECTIONS)), 1.5), line_speeds=line,
                     accel=np.minimum(0.9, 40 / np.maximum(line, 1)), brake=np.full(len(line), 1.4), top_speed=210.0)


@pytest.fixture(scope="module")
def k() -> np.ndarray:
    return curvature_at(np.arange(N + 1, dtype=float))


@pytest.fixture(scope="module")
def env(k, lim) -> Envelope:
    return Envelope(k, lim)


def lap(v_kmh: np.ndarray, k: np.ndarray, throttle: np.ndarray | None = None) -> dict[str, np.ndarray]:
    """A lap's trace on the line from its speed at every metre: time, g, pedals and the states the check reads."""
    v = np.asarray(v_kmh, float)
    ms = v / 3.6
    t = np.concatenate([[0.0], np.cumsum(2 / (ms[:-1] + ms[1:]))])
    ax = np.gradient(ms, t) / G
    braking = ax < -0.15
    thr = np.where(braking, 0.0, np.where(ax > -0.02, 100.0, 0.0)) if throttle is None else throttle
    f32 = {"speed": v, "ax": ax, "ay": ms ** 2 * k / G, "curvature": k, "throttle": thr,
           "brake": np.where(braking, -ax * 60, 0.0), "steer": k * 2000, "front_lock": np.zeros_like(v),
           "rear_slip": np.zeros_like(v)}
    out = {name: np.asarray(x, np.float32) for name, x in f32.items()}
    states = {"braking": braking, "coasting": ~braking & (thr < 5), "tc_on": np.zeros_like(v),
              "abs_on": np.zeros_like(v), "phase": np.zeros_like(v)}
    out.update({name: np.asarray(x, np.int8) for name, x in states.items()})
    out["t"], out["distance"] = t, np.arange(len(v), dtype=float)
    return out


def check(tr: dict, lim: CarLimits) -> dict:
    return check_lap(tr, lim, SECTIONS, lap_time=float(tr["t"][-1]))


def test_perfect_driving_from_any_point_is_the_theoretical_lap(env, k, lim):
    sim = _closed_sim(k, lim)
    assert env.cum[-1] == pytest.approx(sim.time, abs=1e-6)
    assert np.allclose(env.P * 3.6, sim.speed, atol=1e-6)
    # started anywhere at perfect driving's own speed it drives the perfect lap on
    for i0 in (0, 150, 640, 950):
        r = env.restart(i0, float(env.P[i0]))
        assert r.to_end() == pytest.approx(env.cum[-1] - env.cum[i0], abs=1e-6)
    # slower than that, it loses time and catches up with the perfect lap before the next corner
    r = env.restart(400, float(env.P[400]) * 0.8)
    assert r.to_end() > env.cum[-1] - env.cum[400]
    assert r.i0 + len(r.speed) < 700


def test_a_perfect_lap_has_no_mistakes(env, k, lim):
    out = check(lap(env.P * 3.6, k), lim)
    assert out["mistakes"] == []
    assert out["gap"] == pytest.approx(0, abs=0.01)
    assert out["perfect"] < out["realistic"]
    b = out["budget"]
    assert b["optimism"] == pytest.approx(out["realistic"] - out["perfect"], abs=1e-3)
    # at the car's full grip the lap beats the 95 % target: gains, not mistakes
    assert b["other_gains"] < 0 and b["mistakes"] == 0


def _costs_add_up(out: dict) -> None:
    b = out["budget"]
    assert b["mistakes"] + b["at_limit"] + b["optimism"] + b["pit_lane"] + b["other"] == pytest.approx(out["gap"],
                                                                                                         abs=2e-3)
    # what no mistake explains is the sum of the small losses and gains: every piece of the lap is counted once
    assert b["other_losses"] + b["other_gains"] == pytest.approx(b["other"], abs=2e-3)
    assert b["mistakes"] == pytest.approx(sum(m["cost_s"] for m in out["mistakes"]), abs=2e-3)


def test_early_soft_braking_is_named_and_costed(env, k, lim):
    v = env.P * 3.6
    m = 600 + int(np.argmin(v[600:800]))
    vm = v[m] / 3.6
    soft = np.sqrt(vm ** 2 + 2 * 0.7 * G * np.clip(m - np.arange(N + 1), 0, None)) * 3.6  # 0.7 g, not 1.4
    v = np.where((np.arange(N + 1) > 450) & (np.arange(N + 1) <= m), np.minimum(v, soft), v)
    out = check(lap(v, k), lim)
    _costs_add_up(out)
    kinds = {x["kind"] for x in out["mistakes"] if x["code"] == "T2"}
    assert kinds & {"brake_early", "soft_braking"}, out["mistakes"]
    early = next(x for x in out["mistakes"] if x["kind"] == "brake_early")
    assert early["phase"] == "braking" and early["value"] >= 10 and early["unit"] == "m"
    assert " m early" in early["title"] and "km/h" in early["what"] and early["do"].startswith("Brake")
    # against perfect driving, the named mistakes are the whole gap: the rest of the lap is perfect
    assert sum(x["cost_perfect_s"] for x in out["mistakes"]) == pytest.approx(out["gap"], abs=0.02)
    assert out["mistakes"] == sorted(out["mistakes"], key=lambda x: -x["cost_s"])


def test_a_lift_on_the_straight_and_a_late_throttle(env, k, lim):
    v = env.P * 3.6
    thr = None
    # a lift from 420 to 470 m, then perfect driving again from wherever that leaves the car
    a, b = 420, 470
    v = v.copy()
    ms = np.sqrt(np.maximum((v[a] / 3.6) ** 2 - 2 * 0.08 * G * np.arange(b - a + 1), 1))
    v[a:b + 1] = ms * 3.6
    v[b:] = env.restart(b, float(ms[-1])).at(b, N) * 3.6
    thr = np.where(np.gradient(v) >= -1e-3, 100.0, 0.0)
    thr[a:b] = 0
    out = check(lap(v, k, thr), lim)
    _costs_add_up(out)
    lift = next(x for x in out["mistakes"] if x["kind"] == "lift")
    assert lift["code"] == "T1" and lift["phase"] == "full throttle" and lift["start_m"] == a
    assert lift["title"] == "Lifted in T1" and lift["cost_perfect_s"] == pytest.approx(out["gap"], abs=0.01)

    # on the throttle 40 m after the slowest point of T1, the speed held till then
    v = env.P * 3.6
    m = 200 + int(np.argmin(v[200:400]))
    v = v.copy()
    v[m:m + 41] = v[m]
    v[m + 40:] = env.restart(m + 40, float(v[m] / 3.6)).at(m + 40, N) * 3.6
    tr = lap(v, k)
    tr["throttle"][m:m + 40] = 10
    out = check(tr, lim)
    _costs_add_up(out)
    late = next(x for x in out["mistakes"] if x["kind"] == "late_throttle")
    assert late["code"] == "T1" and late["phase"] == "exit" and late["value"] == pytest.approx(40, abs=2)


def test_a_lap_that_ends_in_the_pit_lane(env, k, lim):
    v = env.P * 3.6
    v = v.copy()
    stop = np.sqrt((50 / 3.6) ** 2 + 2 * 1.2 * G * np.clip(940 - np.arange(N + 1), 0, None)) * 3.6
    v[850:] = np.minimum(v[850:], np.maximum(stop[850:], 50))
    out = check(lap(v, k), lim)
    _costs_add_up(out)
    assert out["pit_from_m"] is not None and 850 <= out["pit_from_m"] <= 940
    assert out["budget"]["pit_lane"] > 1
    assert all(x["end_m"] <= out["pit_from_m"] for x in out["mistakes"])


def test_mistakes_that_repeat():
    def m(key, cost, value=None):
        code, kind = key.split(":")
        return {"key": key, "kind": kind, "code": code, "phase": "braking", "cost_s": cost, "cost_perfect_s": cost,
                "value": value, "unit": "m"}

    laps = [[m("T1:brake_early", 0.10, 20), m("T2:coasting", 0.05)],
            [m("T1:brake_early", 0.20, 30)],
            [m("T2:coasting", 0.03), m("T2:coasting", 0.01)],
            []]
    out = habits(laps)
    assert [h["key"] for h in out] == ["T1:brake_early", "T2:coasting"]
    early, coast = out
    assert (early["laps"], early["of"], early["share"]) == (2, 4, 0.5)
    assert early["cost_per_lap_s"] == pytest.approx(0.075) and early["cost_when_s"] == pytest.approx(0.15)
    assert early["value"] == 25 and early["title"] == "Braking early"
    assert coast["laps"] == 2 and coast["cost_per_lap_s"] == pytest.approx(0.0225, abs=1e-3)
    # once is not a habit
    assert habits([[m("T1:lockup", 0.3)], []]) == []


# ---------- the API ----------

def _wait(client, url, timeout=180):
    t0 = time.monotonic()
    while time.monotonic() - t0 < timeout:
        r = client.get(url)
        assert r.status_code == 200, r.text
        body = r.json()
        if body["status"] not in ("queued", "running"):
            return body
        assert body["progress"] is not None
        time.sleep(0.2)
    raise AssertionError(f"{url} still working after {timeout} s")


def test_technique_check_api(client):
    track = client.post("/tracks", json={"name": "Test ring", "corners": [
        {"code": code, "apex_m": at, "sector": sector} for code, at, sector in CORNERS]}).json()
    event = client.post("/events", json={"name": "Test day", "track_id": track["id"]}).json()
    ids = []
    for name, paces in (("Run 1", (0.95, 0.97, 0.96)), ("Run 2", (0.98, 1.0, 0.985))):
        s = client.post("/sessions", json={"event_id": event["id"], "name": name}).json()
        r = client.post(f"/sessions/{s['id']}/files", files={"file": ("run.ld", write_ld(simulate(paces=paces)[0]))})
        assert r.status_code == 201, r.text
        ids.append(s["id"])

    body = _wait(client, f"/technique/sessions/{ids[1]}")
    assert body["status"] == "ready", body.get("error")
    assert body["scope"] == "event" and body["map"] == {"event": event["id"]} and body["grip"] == 0.95
    assert [x["number"] for x in body["laps"]] == [1, 2, 3]  # its clean laps: not the out-lap (0) or in-lap
    best = min(body["laps"], key=lambda x: x["time"])
    lap_ = body["lap"]
    assert lap_["number"] == best["number"] == body["best_lap"]
    assert lap_["perfect"] <= lap_["realistic"] and lap_["gap"] == pytest.approx(lap_["time"] - lap_["perfect"],
                                                                                 abs=1e-3)
    assert sum(lap_["budget"][k] for k in ("mistakes", "at_limit", "optimism", "pit_lane", "other")) == \
        pytest.approx(lap_["gap"], abs=2e-3)
    tr = lap_["trace"]
    assert len(tr["driven"]) == len(tr["perfect"]) == len(tr["realistic"]) == body["length_m"] // tr["step_m"] + 1
    for x in lap_["mistakes"]:
        assert x["code"] in {"T1", "T2"} and x["phase"] in {"braking", "entry", "mid-corner", "exit", "full throttle"}
        assert x["what"] and x["do"] and x["cost_s"] >= 0.02
    assert [s["code"] for s in body["sections"]] == ["T1", "T2"]
    assert body["habits"]["session_laps"] == 3 and body["habits"]["event_laps"] == 6
    for h in body["habits"]["session"] + body["habits"]["event"]:
        assert h["laps"] >= 2 and h["cost_per_lap_s"] > 0

    other = client.get(f"/technique/sessions/{ids[1]}", params={"lap": 3}).json()
    assert other["lap"]["number"] == 3
    out_lap = client.get(f"/technique/sessions/{ids[1]}", params={"lap": 0}).json()
    assert out_lap["lap"] is None and "clean" in out_lap["lap_note"]

    ev = client.get(f"/technique/events/{event['id']}").json()
    assert ev["status"] == "ready" and ev["laps_checked"] == 6
    assert ev["best"] == {"session_id": ids[1], "number": best["number"], "time": best["time"]}
    assert [s["laps"] for s in ev["sessions"]] == [3, 3]

    # a session of no event is checked on its own
    import app.db
    import app.models

    alone = client.post("/sessions", json={"name": "Alone"}).json()
    client.post(f"/sessions/{alone['id']}/files", files={"file": ("run.ld", write_ld(simulate(paces=(0.99,))[0]))})
    with app.db.SessionLocal() as db:  # the upload put it in the event its log names: take it out
        db.get(app.models.RunSession, alone["id"]).event_id = None
        db.commit()
    body = _wait(client, f"/technique/sessions/{alone['id']}")
    assert body["status"] == "ready" and body["scope"] == "session" and body["map"] == {"session": alone["id"]}
    assert body["habits"]["event"] is None and body["lap"]["number"] == 1

    r = client.post(f"/technique/events/{event['id']}/refresh")
    assert r.status_code == 200 and r.json()["status"] in ("queued", "running", "ready")
    assert _wait(client, f"/technique/events/{event['id']}")["status"] == "ready"
    assert client.get("/technique/sessions/9999").status_code == 404
    assert client.get("/technique/events/9999").status_code == 404
