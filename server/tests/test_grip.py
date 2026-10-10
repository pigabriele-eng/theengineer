"""Grip use and traction control on synthetic runs: quicker laps use more grip, and TC that grows with the rear
tyre temperature on one corner exit."""
import json

import numpy as np
import pytest

from app.analysis.grip import (ROLES, TRY_OVERRIDE, GripStudy, _override_headline, _override_vs_tc, _runs_of,
                               _vs_words, partial, tc_words)
from app.analysis.laps import load_session
from app.importers.motec import read_ld
from tests.synthetic import simulate, write_ld

PACES = [0.97, 0.985, 1.0, 0.975, 0.99, 0.965, 0.995, 0.98, 0.97, 0.99]  # every lap clean, no two alike
TC_FROM_M = 720.0  # TC cuts in on the exit of the second corner (apex at 700 m) ...
TC_GROWTH_M = 6.0  # ... for 6 m more on every lap, as the rear tyres warm up


def with_tc(channels: dict, lap_times: list[float], base_m: float = 0.0) -> dict:
    """Add a TC flag on the second corner's exit (base_m long on the first flying lap), wheel speeds and rear tyre
    temperatures rising lap by lap."""
    v = channels["vCar"][2]
    hz = 100
    t = np.arange(len(v)) / hz
    starts = np.r_[0.0, np.cumsum(lap_times)]
    lap = np.clip(np.searchsorted(starts, t, side="right") - 1, 0, len(lap_times) - 1)
    dist = np.cumsum(v / 3.6 / hz)
    within = dist - np.interp(starts[lap], t, dist)
    flying = (lap >= 1) & (lap <= len(lap_times) - 2)
    reach = TC_FROM_M + base_m + TC_GROWTH_M * (lap - 1)
    tc = (flying & (within >= TC_FROM_M) & (within < reach)).astype(float)
    wheel = v / 3.6 / 0.33
    out = dict(channels)
    out["BInterventionCauseTC"] = (hz, "", tc)
    for w in ("FL", "FR"):
        out[f"nWheel{w}"] = (hz, "rad/s", wheel)
    for w in ("RL", "RR"):
        out[f"nWheel{w}"] = (hz, "rad/s", wheel * (1 + 0.08 * tc))
    temp = 55.0 + 1.5 * lap  # °C, one step per lap
    for w in ("RL", "RR"):
        out[f"TTyre{w}"] = (10, "C", temp[::10])
    return out


@pytest.fixture(scope="module")
def run():
    channels, lap_times = simulate(PACES)
    return with_tc(channels, lap_times)


@pytest.fixture(scope="module")
def report(run):
    ld = read_ld(write_ld(run))
    study = GripStudy()
    data = load_session(ld)
    study.add("Run 1", data, ld)
    assert "tyre_p_fl" not in data.channels and "phase" in data.channels  # what the report doesn't need is gone
    return study.report()


def test_reading_only_the_roles_it_uses_changes_nothing(run):
    """The router reads only ROLES from a log and lets the log go before the laps are placed: the same report as
    from every channel of the log."""
    v = run["vCar"][2]
    slow = len(v) // 10
    log = write_ld({**run, "nEngine": (100, "rpm", 2000 + 30 * v), "NGearPos": (10, "", np.full(slow, 4.0)),
                    "NAbs": (100, "", (v < 120).astype(float)), "pBrakeR": (50, "bar", np.zeros(len(v) // 2)),
                    "pTyreFL": (10, "bar", np.full(slow, 1.9)), "TTyreFL": (10, "C", np.full(slow, 70.0))})
    ld = read_ld(log)
    every = GripStudy()
    every.add("Run 1", load_session(ld), ld)
    data = load_session(ld, roles=ROLES)
    unread = set(load_session(ld).channels) - set(data.channels)
    assert {"gear", "abs", "brake_rear", "tyre_p_fl", "tyre_t_fl"} <= unread
    few = GripStudy()
    few.read_log(data, ld)
    del ld
    few.add_laps("Run 1", data)
    assert few.report() == every.report()


def test_report_is_plain_json(report):
    json.dumps(report, allow_nan=False)
    assert report["available"] and report["clean_laps"] == len(PACES)
    assert report["numbering"] == "detected"
    assert [s["code"] for s in report["sections"]] == ["C1", "C2"]


def test_quicker_laps_use_more_grip(report):
    g = report["grip"]
    assert g["vs_time"]["r"] < -0.9 and g["vs_time"]["n"] == len(PACES)
    assert g["s_per_pct"] < 0  # more grip use, quicker lap
    laps = sorted(report["laps"], key=lambda r: r["time"])
    assert laps[0]["grip_use"] == max(r["grip_use"] for r in laps)
    assert report["fastest"]["time"] == laps[0]["time"]
    assert report["headlines"][0]["key"] == "grip_vs_time"
    for s in report["sections"]:
        assert s["r"] < -0.5 and s["note"]
        assert set(s["phases"]) == {"braking", "trail", "mid", "exit"}


def test_grip_limit_and_gg(report):
    lim = report["limits"]
    assert len(lim["directions_deg"]) == 19 and len(lim["envelope_g"]) == len(lim["speeds_kmh"])
    assert len(lim["bands_kmh"]) == len(lim["speeds_kmh"]) and lim["bands_kmh"][-1][1] is None
    gg = report["gg"]["fastest"]
    assert len(gg["ax"]) == len(gg["ay"]) == len(gg["speed"]) > 50
    assert max(abs(a) for a in gg["ay"]) == pytest.approx(1.4, abs=0.15)  # the corners' lateral g
    assert report["map"] is not None and len(report["map"]["x"]) == len(report["map"]["grip_use"])


def test_traction_control_zone_and_tyre_temperature(report):
    tc = report["tc"]
    assert tc["available"] and tc["channel"] == "BInterventionCauseTC"
    zone = next(z for z in tc["zones"] if z["start_m"] < 760 < z["end_m"])
    assert zone["where"] == "C2 exit"
    assert abs(zone["start_m"] - TC_FROM_M) < 25
    assert zone["slip_pct"] > 4  # the rear wheels spin up while TC works
    w = tc["vs_rear_temp_within"]
    assert w["r"] > 0.9 and w["slope"] > 0
    assert any(h["key"] == "tc_temp" for h in report["headlines"])
    # the synthetic log has no engine torque or TC switch: said so, not failed
    assert report["channels"]["engine_torque"] is None and tc["switch"] is None
    assert any("MEngine" in n for n in tc["notes"])


def _tc_report(paces):
    channels, lap_times = simulate(paces)
    ld = read_ld(write_ld(with_tc(channels, lap_times, base_m=30.0)))
    study = GripStudy()
    study.add("Run 1", load_session(ld), ld)
    return study.report()


def test_traction_control_from_one_lap():
    """Gabriele, 2026-10-09: TC from one lap. One lap finds the zone and what TC does there; what it costs takes 4."""
    r = _tc_report([0.97])
    assert r["clean_laps"] == 1
    zone = next(z for z in r["tc"]["zones"] if z["start_m"] < 730 < z["end_m"])
    assert zone["verdict"] == "unknown" and zone["passes"] == 1 and zone["passes_tc"] == 1
    assert zone["note"].startswith(f"TC cuts in here on 1 of 1 lap for {zone['tc_s']:.2f} s, with ")
    assert "takes 4 laps through here" in zone["note"] and zone["advice"] == ""
    assert r["tc"]["lost_per_lap_s"] is None  # not "0.00 s": too few laps to say
    four = _tc_report([0.97, 0.985, 1.0, 0.975])
    zone = next(z for z in four["tc"]["zones"] if z["start_m"] < 730 < z["end_m"])
    assert zone["passes"] == 4 and zone["verdict"] != "unknown" and zone["speed_per_tc_s"] is not None
    assert four["tc"]["lost_per_lap_s"] is not None and four["tc"]["vs_rear_temp"] is not None


def _bmw(channels: dict, lap_times: list[float], status, override_button: bool = True, kerb: bool = False) -> dict:
    """The BMW M4 GT4's TC status (NTCStatus, 10 Hz: 10 + the dash level, 0 while TC is off) from status(lap, metres
    into the lap), with the TC flag cleared where TC is off, the EVO's override button (BSTW TC) and a kerb strike
    just before the TC zone (G Force Vert)."""
    hz = 100
    v = channels["vCar"][2]
    t = np.arange(len(v)) / hz
    starts = np.r_[0.0, np.cumsum(lap_times)]
    lap = np.clip(np.searchsorted(starts, t, side="right") - 1, 0, len(lap_times) - 1)
    dist = np.cumsum(v / 3.6 / hz)
    within = dist - np.interp(starts[lap], t, dist)
    st = np.array(status(lap, within), float)
    out = dict(channels)
    f, unit, tc = out["BInterventionCauseTC"]
    out["BInterventionCauseTC"] = (f, unit, np.where(st == 0, 0.0, tc))
    st10 = st[::10]
    out["NTCStatus"] = (10, "", st10)
    if override_button:  # pressed where TC goes off
        out["BSTW TC"] = (10, "", np.r_[0.0, (st10[1:] == 0) & (st10[:-1] != 0)].astype(float))
    if kerb:
        out["G Force Vert"] = (hz, "G", np.where((lap >= 1) & (within >= TC_FROM_M - 10) & (within < TC_FROM_M + 2),
                                                 1.8, 1.0))
    return out


def test_tc_level_is_the_dash_number_and_override_passes_are_left_out():
    """Gabriele, 2026-10-09: on the M4 GT4 (EVO and not) a higher TC number cuts in earlier and more; the EVO's TC
    override switches TC off for about 10 s. The level comes from NTCStatus, not the thumb wheel, and a pass with TC
    off isn't read as one with little TC."""
    channels, lap_times = simulate(PACES)
    channels = with_tc(channels, lap_times)
    channels["NSTWThumbSlip"] = (10, "", np.full(len(channels["vCar"][2]) // 10, 7.0))  # the wheel: not the level
    off_lap = 4

    def status(lap, m):
        level = np.where(lap <= 5, 13, 14)  # dash 3, then 4
        return np.where((lap == off_lap) & (m >= TC_FROM_M - 80) & (m < TC_FROM_M + 200), 0, level)

    ld = read_ld(write_ld(_bmw(channels, lap_times, status)))
    study = GripStudy()
    study.add("Run 1", load_session(ld), ld)
    r = study.report()
    tc = r["tc"]
    assert tc["switch"]["channel"] == "NTCStatus" and tc["switch"]["positions"] == [3, 4]
    assert r["channels"]["tc_switch"] == "NTCStatus"
    zone = next(z for z in tc["zones"] if z["start_m"] < 760 < z["end_m"])
    assert zone["passes_tc_off"] == 1 and zone["passes"] == len(PACES) - 1
    vs = zone["override_vs_tc"]  # the lap with the override on through here, against the laps with TC
    assert vs["passes_override"] == 1 and vs["passes_tc"] == len(PACES) - 1 and not vs["clear"]
    assert f"1 lap with the override on through here against {len(PACES) - 1} with TC: " in zone["note"]
    assert "not clear yet: it takes two laps of each." in zone["note"]
    assert zone["advice"] == "Not clear yet whether the override pays here: more laps of each tell."
    row = next(x for x in r["laps"] if x["lap"] == off_lap)
    assert row["tc_off_s"] > 2 and row["tc_s"] is not None
    assert all(x["tc_off_s"] == 0 for x in r["laps"] if x["lap"] != off_lap)
    assert any("TC was off for part of 1 of" in n and "the TC override" in n for n in tc["notes"])
    assert not zone["override"]  # no kerb triggers it, and the override was used here


def test_where_to_try_tc_override():
    """Gabriele, 2026-10-09: "suggest areas where tc was never overridden but tc is triggered by curb riding", on the
    EVO only."""
    channels, lap_times = simulate([0.97])
    channels = with_tc(channels, lap_times, base_m=30.0)
    evo = _bmw(channels, lap_times, lambda lap, m: np.full(len(lap), 12), kerb=True)
    for logs, expected in ((evo, True), ({k: v for k, v in evo.items() if k != "BSTW TC"}, False)):
        r = _study(logs)
        zone = next(z for z in r["tc"]["zones"] if z["start_m"] < 730 < z["end_m"])
        assert zone["kerb_g"] >= 0.5 and zone["verdict"] == "unknown" and zone["override_vs_tc"] is None
        assert zone["override"] is expected  # the earlier car has no override button
        assert (zone["advice"] == TRY_OVERRIDE) is expected
        heads = [h for h in r["headlines"] if h["key"] == "tc_override"]
        assert bool(heads) is expected
    assert heads == [] and expected is False
    (head,) = [h for h in _study(evo)["headlines"] if h["key"] == "tc_override"]
    assert head["value"] == zone["where"] and head["action"] == f"Try it just before the kerb at {zone['where']}."


def _study(logs: dict) -> dict:
    ld = read_ld(write_ld(logs))
    study = GripStudy()
    study.add("Run 1", load_session(ld), ld)
    return study.report()


def test_override_against_tc_at_the_same_entry_speed():
    """Gabriele, 2026-10-09: "use the laps where tc was sometimes overridden to calculate laptime difference on
    average. This should help inform if override is worth it"."""
    tc = [{"v_in": 100 + i, "t_run": 5.0 - 0.02 * i + 0.01 * (i % 2)} for i in range(6)]
    off = [{"v_in": 100.5 + i, "t_run": 4.9 - 0.02 * (i + 0.5) + 0.01 * (i % 2)} for i in range(5)]
    vs = _override_vs_tc(tc, off)
    assert vs["passes_override"] == 5 and vs["passes_tc"] == 6 and vs["clear"]
    assert vs["diff_s"] == pytest.approx(-0.1, abs=0.01) and vs["within_s"] < 0.05
    note, advice = _vs_words(vs)
    assert note.startswith("5 laps with the override on through here against 6 with TC: 0.10 s quicker with the "
                           "override to the next braking point, at the same entry speed.")
    assert advice == "Press TC override here every lap: it was about 0.10 s quicker to the next braking point."
    slower = _override_vs_tc(off, tc)
    assert slower["clear"] and slower["diff_s"] > 0
    assert _vs_words(slower)[1].startswith("Keep TC on here: the override was about 0.10 s slower")
    one = _override_vs_tc(tc, off[:1])
    assert not one["clear"] and one["within_s"] is None
    assert _override_vs_tc(tc, []) is None and _override_vs_tc([], off) is None
    head = _override_headline([{"where": "T7 exit", "override": False, "override_vs_tc": vs},
                               {"where": "T3", "override": True, "override_vs_tc": None},
                               {"where": "T9", "override": False, "override_vs_tc": slower}])
    assert head["value"] == "≈ 0.10 s a lap"
    assert head["action"] == "Press it every lap at T7 exit. Keep TC on at T9. Try it just before the kerb at T3."


def test_logs_without_tc_say_so():
    channels, _ = simulate(PACES)
    ld = read_ld(write_ld(channels))
    study = GripStudy()
    study.add("No TC", load_session(ld), ld)
    r = study.report()
    assert r["available"] and not r["tc"]["available"]
    assert "no traction control channel" in r["tc"]["notes"][0]
    assert all(h["key"] not in ("tc_cost", "tc_temp") for h in r["headlines"])


def test_runs_are_read_one_at_a_time_onto_one_line(run):
    study = GripStudy()
    quick, slow = simulate([0.99, 1.0, 0.995])[0], simulate([0.97, 0.975, 0.98])[0]
    for name, channels in (("Slow", slow), ("Quick", quick)):
        ld = read_ld(write_ld(channels))
        study.add(name, load_session(ld), ld)
    r = study.report()
    assert r["clean_laps"] == 6 and r["fastest"]["run"] == "Quick"
    assert {x["run"] for x in r["laps"]} == {"Slow", "Quick"}
    assert r["length_m"] == pytest.approx(1000, abs=15)


def test_no_clean_laps():
    channels, _ = simulate([0.6])  # out-lap, one slow lap, in-lap: nothing quick
    study = GripStudy()
    ld = read_ld(write_ld(channels))
    data = load_session(ld)
    for lap in data.laps:
        lap.clean = False
    study.add("Garage", data, ld)
    r = study.report()
    assert not r["available"] and "No clean laps" in r["notes"][0]


def test_helpers():
    assert _runs_of(np.array([0, 1, 1, 0, 1, 1, 1, 0, 0, 0, 0, 1], bool), 3, 2) == [(1, 7)]
    rng = np.random.default_rng(1)
    z = rng.normal(size=60)
    x = rng.normal(size=60)
    y = 2.0 * x + 3.0 * z + rng.normal(scale=0.1, size=60)
    p = partial(y, x, z)
    assert p["coef"] == pytest.approx(2.0, abs=0.1) and p["r"] > 0.9
    assert partial(y[:5], x[:5], z[:5]) is None
    zone = {"verdict": "cost", "quick_share": 0.9, "tc_s": 1.1, "slip_pct": 13.0, "speed_per_tc_s": -0.8,
            "time_per_tc_s": 0.16, "time_cost_s": 0.18, "kerb_g": 0.1, "steer_tc": 69.0, "steer_no_tc": 65.0,
            "steer_unit": "°", "pedal_s_tc": 0.66, "pedal_s_no_tc": 0.75}
    note, advice = tc_words(zone)
    assert "0.18 s each time" in note
    assert advice.startswith("Unwind about 4° more steering") and "0.75 s" in advice
    note, advice = tc_words({**zone, "kerb_g": 0.8})
    assert "kerb" in note and "kerb" in advice


def test_grip_endpoint(client, run):
    import app.routers.report_grip as rg

    ev = client.post("/events", json={"name": "Test day"}).json()
    ids = []
    for name in ("Run 1", "Run 2"):
        s = client.post("/sessions", json={"name": name, "event_id": ev["id"]}).json()
        up = client.post(f"/sessions/{s['id']}/files", files={"file": ("run.ld", write_ld(run))})
        assert up.status_code == 201
        ids.append(s["id"])
    r = client.get(f"/report/grip?session={ids[0]}")
    assert r.status_code == 200, r.text
    one = r.json()
    assert one["available"] and one["clean_laps"] == len(PACES) and one["tc"]["available"]
    r = client.get(f"/report/grip?event={ev['id']}")
    assert r.status_code == 200, r.text
    both = r.json()
    assert both["clean_laps"] == 2 * len(PACES)
    assert {x["run"] for x in both["laps"]} == {"Run 1", "Run 2"}
    assert ("event", ev["id"]) in rg._cache
    assert client.get(f"/report/grip?event={ev['id']}").json() == both  # from the cache
    assert client.get("/report/grip").status_code == 422
    assert client.get(f"/report/grip?session={ids[0]}&event={ev['id']}").status_code == 422
    assert client.get("/report/grip?session=999").status_code == 404
    assert client.get("/report/grip?event=999").status_code == 404


def test_a_report_of_the_earlier_version_shows_while_the_new_one_is_made(client, monkeypatch):
    """A new version of the report (TC level and override, 2026-10-09) doesn't read every log on the restart after it:
    the start-up pass leaves the reports kept by the version before, and one opened shows its earlier answer, marked
    updating, while the prebuild works out the new one."""
    import zlib

    from sqlalchemy import select

    import app.routers.report_grip as rg
    from app import db as app_db
    from app import models, page_cache, prebuild, run_labels
    from app.page_cache import PageCache

    channels, lap_times = simulate([0.97, 0.98, 0.975])
    s = client.post("/sessions", json={"name": "Old"}).json()
    assert client.post(f"/sessions/{s['id']}/files",
                       files={"file": ("run.ld", write_ld(with_tc(channels, lap_times)))}).status_code == 201
    scope = f"session:{s['id']}|grip"
    assert client.get(f"/report/grip?session={s['id']}").status_code == 200
    with app_db.SessionLocal() as db:  # kept as version 1 kept it: with its part for fewer than 8 clean laps
        run = db.get(models.RunSession, s["id"])
        label = run_labels.labels_for(db, [run])[run.id]
        old = page_cache.digest(["grip", page_cache.VERSIONS["grip"] - 1, page_cache.sessions_part(db, [run]),
                                 page_cache.track_part(run.event.track if run.event else None),
                                 *run_labels.renamed([label]), "tc from one lap"])
        row = db.scalar(select(PageCache).where(PageCache.scope == scope))
        row.signature, row.body = old, zlib.compress(json.dumps({"available": False, "notes": ["v1"]}).encode())
        db.commit()
    rg._cache.clear()
    reads, queued = [], []
    real_read = rg._read
    monkeypatch.setattr(rg, "_read", lambda db, s: reads.append(s.id) or real_read(db, s))
    monkeypatch.setattr(prebuild, "enabled", lambda: True)
    monkeypatch.setattr(prebuild, "refresh", queued.extend)

    prebuild.RUN["grip"]("session", s["id"])  # the start-up pass: left as it is
    shown = client.get(f"/report/grip?session={s['id']}").json()
    assert shown == {"available": False, "notes": ["v1"], "updating": True} and not reads
    assert queued == [("grip now", ("session", s["id"]))]
    prebuild.RUN["grip now"]("session", s["id"])  # what the page asked for: the new one
    assert reads == [s["id"]]
    new = client.get(f"/report/grip?session={s['id']}").json()
    assert new["available"] and "updating" not in new and new["tc"]["available"]
    assert reads == [s["id"]] and queued == [("grip now", ("session", s["id"]))]


def test_unreadable_log_is_left_out(client, run, monkeypatch):
    import app.routers.report_grip as rg

    ev = client.post("/events", json={"name": "Second day"}).json()
    for name in ("Good", "Broken"):
        s = client.post("/sessions", json={"name": name, "event_id": ev["id"]}).json()
        assert client.post(f"/sessions/{s['id']}/files", files={"file": ("run.ld", write_ld(run))}).status_code == 201
    real = rg._read

    def flaky(db, s):
        if s.name == "Broken":
            raise ValueError("bad log")
        return real(db, s)

    monkeypatch.setattr(rg, "_read", flaky)
    r = client.get(f"/report/grip?event={ev['id']}")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["clean_laps"] == len(PACES) and {x["run"] for x in body["laps"]} == {"Good"}
    assert any("Could not read the log of Broken" in n for n in body["notes"])
