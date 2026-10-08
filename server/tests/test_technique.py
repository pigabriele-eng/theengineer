"""Technique check: a lap's mistakes against perfect driving, what each costs, and the ones that repeat."""
import time

import numpy as np
import pytest

from app.analysis.insights import _closed_sim
from app.analysis.laps import Section
from app.analysis.local_limits import PlaceLimits
from app.analysis.shifts import ShiftModel
from app.analysis.technique import Envelope, check_lap, habits, mistakes_total
from tests.synthetic import curvature_at, simulate, write_ld

G = 9.81
N = 1000  # a 1 km loop with two corners, at 300 and 700 m
SECTIONS = [Section("T1", 0, 500, 300, ["T1"]), Section("T2", 500, N, 700, ["T2"])]
CORNERS = [("T1", 300.0, None), ("T2", 700.0, None)]


def uniform(share: float = 1.0) -> PlaceLimits:
    """1.5 g of cornering, 1.4 g of braking and 0.9 g of drive everywhere (less while cornering), power falling off
    as 40 / km/h g."""
    return PlaceLimits.uniform(N, lateral=1.5 * share, brake=1.4 * share, accel=0.9 * share,
                               power=(40 / 3.6, 0.0, 0.0), top_speed=210.0)


HELD = uniform(0.95)  # what a quick lap usually shows: a little less everywhere


@pytest.fixture(scope="module")
def lim() -> PlaceLimits:
    return uniform()


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


def check(tr: dict, lim: PlaceLimits) -> dict:
    return check_lap(tr, lim, HELD, SECTIONS, lap_time=float(tr["t"][-1]))


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
    # at the best limits everywhere the lap beats the realistic target: gains, not mistakes
    assert b["other_gains"] < 0 and b["mistakes"] == 0


def test_the_trace_carries_the_drivers_inputs_and_perfect_drivings_phases(env, k, lim):
    v = env.P * 3.6
    v[200:320] = np.minimum(v[200:320], 0.9 * v[200:320].max())  # a little slow into T1, so it has a mistake
    tr = lap(v, k)
    tr["gear"] = np.asarray(np.clip(v // 40, 1, 6), np.int8)
    out = check(tr, lim)
    t = out["trace"]
    n = len(t["driven"])
    assert n == N // t["step_m"] + 1
    ins = t["inputs"]
    assert set(ins) == {"throttle", "brake", "steer", "gear", "rpm"}
    assert ins["rpm"] is None  # this log has no revs
    for role in ("throttle", "brake", "steer", "gear"):
        # every channel at the speed trace's own points: the same metres, so they line up with it point for point
        assert len(ins[role]) == n
        assert ins[role] == pytest.approx(np.asarray(tr[role][::t["step_m"]], float), abs=0.06)
    assert ins["throttle"][0] == 100 and max(ins["brake"]) > 0 and set(ins["gear"]) <= set(range(1, 7))
    # perfect driving's own phases: braking into both corners, full throttle on the straights, never coasting
    ph = np.array(t["model_phases"])
    assert len(ph) == n and set(ph.tolist()) <= {0, 1, 2}
    m = np.arange(n) * t["step_m"]
    for apex in (300, 700):
        assert np.any(ph[(m > apex - 150) & (m < apex)] == 0)
        assert ph[m == apex][0] != 0
    assert np.all(ph[(m > 400) & (m < 450)] == 2)
    perfect = np.array(t["perfect"])
    assert np.all(np.diff(perfect)[ph[:-1] == 0] < 0)  # braking, perfect driving slows down

    # a log with no steering channel: the inputs say so; the check still works
    del tr["steer"]
    out2 = check(tr, lim)
    assert out2["trace"]["inputs"]["steer"] is None
    assert out2["trace"]["inputs"]["throttle"] == ins["throttle"]
    assert [x["key"] for x in out2["mistakes"]] == [x["key"] for x in out["mistakes"] if x["kind"] != "steering"]


def test_perfect_drivings_inputs_to_lay_over_the_drivers(env, k, lim):
    tr = lap(env.P * 3.6, k)  # the perfect lap itself, braking at 60 bar per g
    shifts = ShiftModel({5: 60.0, 6: 40.0, 7: 30.0}, np.array([3000.0, 7000.0]), np.array([400.0, 400.0]), 7000.0,
                        {5: 6800.0, 6: 6800.0}, 1.0, 0.0)
    out = check_lap(tr, lim, HELD, SECTIONS, lap_time=float(tr["t"][-1]), shifts=shifts)
    t = out["trace"]
    n, step = len(t["driven"]), t["step_m"]
    m = np.arange(n) * step
    model = t["model"]["perfect"]
    assert set(model) == {"throttle", "brake", "gear", "rpm"}
    assert all(len(model[r]) == n for r in model)
    thr, brk = np.array(model["throttle"]), np.array(model["brake"])
    ph = np.array(t["model_phases"])
    # full throttle wherever the model is, the pedal off while it brakes, never both
    assert np.all(thr[ph == 2] == 100)
    assert np.all((thr == 0) | (brk == 0))
    for apex in (300, 700):  # braking into both corners, at about the driver's own pressure for that deceleration
        into = (m > apex - 150) & (m < apex - 20)
        assert brk[into].max() > 0 and np.all(thr[into & (brk > 0)] == 0)
    hard = brk > 0
    assert np.median(brk[hard] / (60 * np.abs(tr["ax"][::step][hard]))) == pytest.approx(1, abs=0.15)
    assert np.all(brk[(m > 400) & (m < 450)] == 0)
    # the ideal shift points: up at 6,800 rpm, the gear rising with the speed, the revs never past the limiter
    gear, rpm = np.array(model["gear"]), np.array(model["rpm"])
    assert set(gear.tolist()) <= {5, 6, 7} and np.all(rpm <= 7000)
    v = np.array(t["perfect"])
    # (the speeds are rounded to 0.1 km/h)
    assert np.all(rpm == pytest.approx(np.array([shifts.ratio[g] for g in gear]) * v, abs=5))
    assert np.all(rpm[gear == 5] < 6800) and np.all(rpm[gear == 6] < 6800)
    # the realistic target's too; with no brake channel there is no brake pressure to give
    del tr["brake"]
    out2 = check_lap(tr, lim, HELD, SECTIONS, lap_time=float(tr["t"][-1]), shifts=shifts)
    assert out2["trace"]["model"]["perfect"]["brake"] is None
    assert len(out2["trace"]["model"]["realistic"]["throttle"]) == n


def _costs_add_up(out: dict) -> None:
    b = out["budget"]
    assert b["mistakes"] + b["in_targets"] + b["at_limit"] + b["optimism"] + b["pit_lane"] + b["other"] == \
        pytest.approx(out["gap"], abs=2e-3)
    # what no mistake explains is the sum of the small losses and gains: every piece of the lap is counted once
    assert b["other_losses"] + b["other_gains"] == pytest.approx(b["other"], abs=2e-3)
    # every mistake listed counts, the obvious ones too where no named one covers them
    beyond = [o["cost_s"] - sum(x["cost_s"] for x in out["mistakes"] if x["code"] == o["code"]
                                and x["start_m"] <= o["end_m"] and o["start_m"] <= x["end_m"]) for o in out["obvious"]]
    assert b["mistakes"] == pytest.approx(sum(m["cost_s"] for m in out["mistakes"]) + sum(c for c in beyond if c > 0),
                                          abs=2e-3)


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
    assert body["scope"] == "event" and body["map"] == {"event": event["id"]}
    assert [x["number"] for x in body["laps"]] == [1, 2, 3]  # its clean laps: not the out-lap (0) or in-lap
    best = min(body["laps"], key=lambda x: x["time"])
    lap_ = body["lap"]
    assert lap_["number"] == best["number"] == body["best_lap"]
    # no perfect lap reaches the page: the lap, its mistakes and what it would have been without them
    for gone in ("perfect", "realistic", "gap", "budget", "mistakes"):
        assert gone not in lap_
    assert lap_["mistakes_s"] == pytest.approx(mistakes_total(lap_["obvious"]), abs=1e-3)
    assert lap_["without_mistakes"] == pytest.approx(lap_["time"] - lap_["mistakes_s"], abs=1e-3)
    assert all(x["without_mistakes"] <= x["time"] for x in body["laps"])
    # the test day has no qualifying: its runs' tyres are guessed, to confirm
    assert body["tyres"]["sure"] is False and lap_["tyres"] == body["tyres"]["tyres"]
    tr = lap_["trace"]
    assert "perfect" not in tr and "realistic" not in tr and set(tr["model"]) <= {"best"}
    assert len(tr["driven"]) == body["length_m"] // tr["step_m"] + 1
    # the driver's inputs at the same points; the synthetic log has no gear channel
    ins = tr["inputs"]
    assert {r: v is not None for r, v in ins.items()} == {"throttle": True, "brake": True, "steer": True, "gear": False,
                                                       "rpm": False}
    assert all(len(ins[r]) == len(tr["driven"]) for r in ("throttle", "brake", "steer"))
    overlay = tr["model"]["best"]
    assert len(overlay["speed"]) == len(tr["driven"]) and len(overlay["sources"]) == len(body["sections"])
    assert overlay["time"] <= lap_["time"] + 1e-3
    assert body["inputs"]["throttle"] == {"channel": "rThrottlePedal", "unit": "%"}
    assert body["inputs"]["brake"]["channel"] == "Brake Torque" and body["inputs"]["gear"]["channel"] is None
    # the session's quickest lap is the event's fastest: nothing to lay over it
    assert lap_["fastest"]["this_lap"] and lap_["fastest"]["inputs"] is None
    assert isinstance(lap_["obvious"], list)  # the obvious mistakes reach the page with each lap
    for x in lap_["obvious"]:
        assert x["code"] in {"T1", "T2"} and x["what"] and x["do"] and x["cost_s"] >= 0.01
    assert [s["code"] for s in body["sections"]] == ["T1", "T2"]
    assert body["habits"]["session_laps"] == 3 and body["habits"]["event_laps"] == 6
    for h in body["habits"]["session"] + body["habits"]["event"]:
        assert h["laps"] >= 2 and h["cost_per_lap_s"] > 0

    other = client.get(f"/technique/sessions/{ids[1]}", params={"lap": 3}).json()
    assert other["lap"]["number"] == 3
    fastest = other["lap"]["fastest"]
    assert not fastest["this_lap"] and (fastest["session_id"], fastest["number"]) == (ids[1], best["number"])
    assert len(fastest["inputs"]["throttle"]) == len(other["lap"]["trace"]["driven"])
    assert fastest["inputs"]["throttle"] == tr["inputs"]["throttle"]  # the fastest lap's own, as checked
    out_lap = client.get(f"/technique/sessions/{ids[1]}", params={"lap": 0}).json()
    assert out_lap["lap"] is None and "clean" in out_lap["lap_note"]

    ev = client.get(f"/technique/events/{event['id']}").json()
    assert ev["status"] == "ready" and ev["laps_checked"] == 6
    assert ev["best"] == {"session_id": ids[1], "number": best["number"], "time": best["time"]}
    assert [s["laps"] for s in ev["sessions"]] == [3, 3]

    # the driver says Run 1 was on used tyres and Run 2 on new ones: their laps are no longer compared
    r = client.put(f"/technique/sessions/{ids[0]}/tyres", json={"tyres": "used"})
    assert r.status_code == 200 and r.json()["status"] == "queued"
    assert client.put(f"/technique/sessions/{ids[1]}/tyres", json={"tyres": "new"}).status_code == 200
    assert client.put(f"/technique/sessions/{ids[0]}/tyres", json={"tyres": "soft"}).status_code == 422
    first = _wait(client, f"/technique/sessions/{ids[0]}")
    assert {k: first["tyres"][k] for k in ("tyres", "label", "pair", "sure", "why", "laps")} == \
        {"tyres": "used", "label": "Used", "pair": "used", "sure": True, "why": "set by you", "laps": 3}
    assert {x["tyres"] for x in first["laps"]} == {"used"}
    ev = client.get(f"/technique/events/{event['id']}").json()
    assert [s["tyres"]["tyres"] for s in ev["sessions"]] == ["used", "new"]
    # every run's tyres for the event, to confirm or change with one tap; Very used is the same group as Used
    assert client.put(f"/technique/sessions/{ids[0]}/tyres", json={"tyres": "worn"}).status_code == 200
    listed = client.get(f"/technique/events/{event['id']}/tyres").json()
    assert [x["label"] for x in listed["levels"]] == ["New", "Fresh", "Used", "Very used"]
    assert [(r["id"], r["tyres"]["label"], r["tyres"]["sure"]) for r in listed["runs"]] == \
        [(ids[0], "Very used", True), (ids[1], "New", True)]
    for x in first["lap"]["trace"]["model"]["best"]["sources"]:  # Run 2's passes lend Run 1's laps nothing
        assert x["kind"] != "pass" or x["run"] != "Run 2"

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


def test_what_a_mistake_really_costs_is_measured_on_the_laps():
    from app.analysis.technique import mistake_stats, pool_stats
    secs = [Section("T1", 0, 300, 150, ["T1"]), Section("T2", 300, 600, 450, ["T2"]), Section("T3", 600, N, 800, [])]
    lift = {"kind": "exit_lift", "at_m": 200.0, "cost_s": 0.05}
    rng = np.random.default_rng(1)
    laps = []
    for i in range(12):  # four laps lift out of T1 and lose 0.2 s down to T2's end; the others don't
        times = [10.0 + rng.normal(0, 0.01), 8.0 + rng.normal(0, 0.01), 12.0]
        obv = []
        if i % 3 == 0:
            times[0] += 0.05
            times[1] += 0.15
            obv = [lift]
        laps.append(("PIA", times, obv))
    laps.append(("RAC", [9.0, 7.0, 11.0], [lift]))  # another driver's, quicker: not compared with these
    stats = mistake_stats(laps, secs)
    pia = next(x for x in stats if x["driver"] == "PIA")
    assert (pia["code"], pia["kind"], pia["laps_with"], pia["laps_without"]) == ("T1", "exit_lift", 4, 8)
    assert pia["diff_s"] == pytest.approx(0.2, abs=0.03) and pia["model_s"] == pytest.approx(0.05)
    pooled = pool_stats([stats])["T1:exit_lift"]
    assert pooled["measured"] and pooled["clear"] and pooled["cost_s"] == pytest.approx(0.2, abs=0.03)
    assert pooled["events"] == 1 and 0 < pooled["pm_s"] < 0.05
    # within the noise: measured, not clear, and the model's estimate stands (the flag is never hidden)
    noisy = [("PIA", [10.0 + rng.normal(0, 0.3), 8.0, 12.0], [lift] if i % 2 else []) for i in range(8)]
    vague = pool_stats([mistake_stats(noisy, secs)])["T1:exit_lift"]
    assert vague["measured"] and not vague["clear"] and vague["cost_s"] == pytest.approx(0.05)
    # too few laps with it: the model's estimate stands, and says so
    few = pool_stats([mistake_stats([*laps[:4], ("PIA", [10.0, 8.0, 12.0], [])], secs)])["T1:exit_lift"]
    assert not few["measured"] and few["cost_s"] == pytest.approx(0.05)
    # another event at the track adds to it
    both = pool_stats([stats, stats])["T1:exit_lift"]
    assert both["events"] == 2 and both["laps_with"] == 2 * pooled["laps_with"]


def test_opposite_lock_on_the_power_out_of_a_corner_is_a_slide():
    from app.analysis.technique import _power_slide, _steer_sign
    n = 200
    ay = np.full(n, 1.5)
    steer = np.full(n, 6.0)
    steer[100:115] = -4.0  # opposite lock, still cornering, full throttle
    tr = {"steer": steer, "ay": ay, "throttle": np.full(n, 100.0)}
    assert _steer_sign(tr) == 1.0
    j, e, lock = _power_slide(tr, 50, 180, 1.0, 1.0)
    assert (j, e, lock) == (100, 114, 4.0)
    # off the throttle, or the car already straight: not a slide on the power
    assert _power_slide({**tr, "throttle": np.full(n, 30.0)}, 50, 180, 1.0, 1.0) is None
    assert _power_slide({**tr, "ay": np.full(n, 0.2)}, 50, 180, 1.0, 1.0) is None
    # a left-hand corner on a log steering the other way round: the same slide
    left = {"steer": steer, "ay": -ay, "throttle": tr["throttle"]}
    assert _steer_sign(left) == -1.0 and _power_slide(left, 50, 180, -1.0, -1.0)[0] == 100


def test_braking_grip_left_unused_is_judged_against_the_best_braking_there():
    from app.analysis.technique import BRAKE_UNUSED_S, relative_braking

    def raw(cost):
        return {"T1": {"key": "T1:braking_unused", "kind": "braking_unused", "code": "T1", "cost_s": cost,
                       "what": "Braking for T1.", "at_m": 200, "start_m": 190, "end_m": 300}}

    costs = [0.01, 0.012, 0.015, 0.02, 0.03, 0.06]
    obvious = [[] for _ in costs]
    relative_braking([*(raw(c) for c in costs), {}], [*obvious, []])
    flagged = [i for i, o in enumerate(obvious) if o]
    assert flagged == [5]  # only the lap giving away clearly more than the best braking there
    m = obvious[5][0]
    assert m["cost_s"] >= BRAKE_UNUSED_S and m["cost_s"] < 0.06 and "best braking" in m["what"]


def test_a_check_kept_in_an_older_shape_is_worked_out_again_not_read(client):
    """A result kept before the lap's time without its mistakes (no "format") is no answer: never a 500."""
    import app.db
    import app.models
    from app.routers import technique

    track = client.post("/tracks", json={"name": "Test ring", "corners": [
        {"code": code, "apex_m": at, "sector": sector} for code, at, sector in CORNERS]}).json()
    event = client.post("/events", json={"name": "Test day", "track_id": track["id"]}).json()
    s = client.post("/sessions", json={"event_id": event["id"], "name": "Run 1"}).json()
    client.post(f"/sessions/{s['id']}/files", files={"file": ("run.ld", write_ld(simulate(paces=(0.95, 0.96))[0]))})
    assert _wait(client, f"/technique/sessions/{s['id']}")["status"] == "ready"
    with app.db.SessionLocal() as db:  # as kept before: laps with a gap to the perfect lap, no format
        row = technique._row(db, f"event:{event['id']}")
        old = {k: v for k, v in row.result.items() if k != "format"}
        old["laps"] = [{k: v for k, v in x.items() if k not in ("mistakes_s", "without_mistakes")} | {"gap": 1.0}
                       for x in old["laps"]]
        row.result = old
        db.commit()
    for url in (f"/technique/sessions/{s['id']}", f"/technique/events/{event['id']}"):
        r = client.get(url)
        assert r.status_code == 200, r.text
        assert r.json()["status"] in ("queued", "running")
    body = _wait(client, f"/technique/sessions/{s['id']}")
    assert body["status"] == "ready" and body["lap"]["without_mistakes"] <= body["lap"]["time"]
    assert client.get(f"/technique/events/{event['id']}").json()["sessions"][0]["best"]["without_mistakes"]
