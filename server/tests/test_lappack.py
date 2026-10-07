"""Lap packs: the comparisons traced from a session's pack and compact traces give the log's answer."""
import io
import time

import numpy as np
import pytest
from sqlalchemy import select

from app.analysis import compact, lappack
from app.analysis.align import TrackLine, aligned_trace, project, track_line
from app.analysis.channels import math_channels
from app.analysis.compare import RunSource, compare_groups
from app.analysis.insights import RunInput
from app.analysis.lapcompare import KEEP, Pick, compare_picks
from app.analysis.laps import load_session
from app.importers.motec import read_ld
from tests.synthetic import simulate, write_ld

CORNERS = [("T1", 300, None), ("T2", 700, None)]


def _data(paces):
    channels, _ = simulate(paces=paces)
    hz, unit, v = channels["vCar"]
    channels["vCar"] = (hz, unit, np.round(v, 1))  # as a MoTeC log keeps it: in steps of 0.1 km/h
    data = load_session(read_ld(write_ld(channels)))
    math_channels(data)
    return data


def _packed(data) -> lappack.PackedRun:
    """The run as the server keeps it: its pack and its compact traces, each through storage and back."""
    pack = lappack.from_bytes(lappack.to_bytes(lappack.build(data)))
    own = lappack.own_traces(io.BytesIO(compact.to_bytes(compact.reduce_session(data, "run"))),
                             lappack.FROM_COMPACT, compact.FORMAT)
    assert lappack.matches(pack, own)
    return lappack.PackedRun(pack, own)


@pytest.fixture(scope="module")
def runs():
    return {"quick": _data((1.0, 0.99)), "slow": _data((0.97, 0.98, 0.96))}


class _Flat(TrackLine):
    def xy(self, lat, lon):  # positions given in metres
        return np.asarray(lat, float), np.asarray(lon, float)


def test_positions_are_placed_as_by_searching_the_whole_line():
    # a figure of eight (the line crosses itself), with a stretch where two points sit on top of each other
    s = np.linspace(0, 2 * np.pi, 3000, endpoint=False)
    x, y = 600 * np.sin(s), 300 * np.sin(2 * s)
    x[1000], y[1000] = x[1001], y[1001]
    line = _Flat(0.0, 0.0, x, y)
    rng = np.random.default_rng(3)
    k = rng.integers(0, len(x), 2000)
    px = np.r_[x[k] + rng.normal(0, 8, len(k)), x[1001], (x[5] + x[6]) / 2, 0.0, 5000.0, np.nan, x[7:30]]
    py = np.r_[y[k] + rng.normal(0, 8, len(k)), y[1001], (y[5] + y[6]) / 2, 0.0, -20.0, 1.0, y[7:30] + 400]
    lx, ly = x.astype(np.float32), y.astype(np.float32)
    d2 = (px[:, None].astype(np.float32) - lx) ** 2 + (py[:, None].astype(np.float32) - ly) ** 2
    dist, off = project(line, px, py)
    np.testing.assert_array_equal(dist, d2.argmin(1))  # the first of equally near points
    np.testing.assert_array_equal(off, np.sqrt(d2.min(1)))
    assert dist[len(k)] == 1000


def test_a_pack_keeps_the_laps_samples(runs):
    data = runs["slow"]
    pack = lappack.build(data)
    back = lappack.from_bytes(lappack.to_bytes(pack))
    assert list(back.laps) == [l.number for l in data.laps if l.clean] == [1, 2, 3]  # not the out- and in-laps
    assert back.length == pack.length and back.line == pack.line
    for n in back.laps:
        a, b = pack.lap(n), back.lap(n)
        assert (a.start, a.lap) == (b.start, b.lap)
        assert set(a.channels) == set(b.channels) >= {"speed", "lat", "lon", "throttle", "phase", "braking"}
        for role in a.channels:  # as logged: in the steps the log has them in
            np.testing.assert_allclose(b.channels[role], a.channels[role], atol=1e-4, rtol=1e-6, err_msg=role)
        assert np.abs(a.own - b.own).max() <= 0.0005  # metres
    assert back.meta["code"]["speed"][0] == 0.1  # whole steps of 0.1 km/h
    assert len(lappack.to_bytes(pack)) < 60_000  # three laps of a 1 km track

    with pytest.raises(lappack.NotCovered):
        back.lap(0)  # the out-lap


def test_a_packed_lap_is_traced_as_from_the_log(runs):
    data, run = runs["slow"], _packed(runs["slow"])
    lap = next(l for l in data.laps if l.number == 2)
    line = track_line(data, next(l for l in data.laps if l.number == 1))
    old = aligned_trace(data, lap, line, line.length)
    new = run.trace(2, line, line.length, KEEP)
    assert set(new) == {k for k in KEEP if k in old}
    np.testing.assert_allclose(new["t"], old["t"], atol=1e-6)  # its time to every metre
    np.testing.assert_allclose(new["speed"], old["speed"], atol=1e-3)
    for role in ("throttle", "phase", "braking", "coasting", "overlap"):  # its own samples
        np.testing.assert_allclose(new[role], old[role], atol=0.01, err_msg=role)
    for role in ("brake", "steer", "ax", "ay"):  # from its compact trace: read from a 1 m grid
        scale = np.abs(old[role]).max()
        assert np.abs(new[role] - old[role]).mean() < 0.01 * scale, role
    # the pack's own line, as the log's
    w = run.window(1)
    assert track_line(w, w.laps[0]).length == line.length
    np.testing.assert_allclose(track_line(w, w.laps[0]).x, line.x, atol=1e-3)
    with pytest.raises(lappack.NotCovered):
        run.trace(4, line, line.length, KEEP)  # the in-lap isn't in the pack


def _same_comparison(old: dict, new: dict) -> None:
    assert new["length_m"] == old["length_m"] and new["numbering"] == old["numbering"]
    assert [(s["code"], s["start_m"], s["end_m"], s["best"]) for s in new["sections"]] == \
        [(s["code"], s["start_m"], s["end_m"], s["best"]) for s in old["sections"]]
    for a, b in zip(old["sections"], new["sections"], strict=True):
        np.testing.assert_allclose(b["times"], a["times"], atol=0.0011)
    assert new["ideal"]["time"] == pytest.approx(old["ideal"]["time"], abs=0.0011)
    assert [(x["lap"], x["time"], x["clean"], x["sections_best"]) for x in new["laps"]] == \
        [(x["lap"], x["time"], x["clean"], x["sections_best"]) for x in old["laps"]]
    for a, b in zip(old["opportunities"], new["opportunities"], strict=True):
        assert b["to_ideal"] == pytest.approx(a["to_ideal"], abs=0.0011)
        assert [(s["code"], s["versus"], s["phase"]) for s in b["sections"]] == \
            [(s["code"], s["versus"], s["phase"]) for s in a["sections"]]
        for x, y in zip(a["sections"], b["sections"], strict=True):
            assert y["loss_s"] == pytest.approx(x["loss_s"], abs=0.0011)
            assert y["phase_loss_s"] == pytest.approx(x["phase_loss_s"], abs=0.0011)
    for a, b in zip(old["traces"]["laps"], new["traces"]["laps"], strict=True):
        np.testing.assert_allclose(b["t"], a["t"], atol=0.0011)
        np.testing.assert_allclose(b["speed"], a["speed"], atol=0.11)
        np.testing.assert_allclose(b["throttle"], a["throttle"], atol=0.6)
    assert new["channels"] == old["channels"] and new["aligned_by"] == old["aligned_by"]


def test_compared_laps_from_packs_are_the_logs(runs):
    packed = {name: _packed(data) for name, data in runs.items()}
    times = {name: {l.number: l.time for l in data.laps} for name, data in runs.items()}
    picks = [Pick("slow", 3, times["slow"][3]), Pick("quick", 1, times["quick"][1]), Pick("slow", 1, times["slow"][1]),
             Pick("quick", 2, times["quick"][2])]
    old = compare_picks(picks, runs.__getitem__, CORNERS)

    def no_log(run):
        raise AssertionError(f"read the log of {run}")

    new = compare_picks(picks, no_log, CORNERS, packed=packed.get)
    _same_comparison(old, new)

    # a lap the pack doesn't hold is read from the log, under the guard; the other run isn't read
    packed["quick"] = _packed(runs["quick"])
    del packed["quick"].pack.laps[1]
    read, held = [], []

    class Guard:
        def __enter__(self):
            held.append(True)

        def __exit__(self, *exc):
            held.pop()

    def load(run):
        assert held
        read.append(run)
        return runs[run]

    picks = [Pick("quick", 1, times["quick"][1]), Pick("slow", 2, times["slow"][2])]
    mixed = compare_picks(picks, load, CORNERS, guard=Guard(), packed=packed.get)
    assert read == ["quick"]
    _same_comparison(compare_picks(picks, runs.__getitem__, CORNERS), mixed)


def test_compared_drivers_from_packs_are_the_logs(runs):
    def sources(packed):
        out = []
        for name, side in (("quick", "a"), ("slow", "b")):
            data = runs[name]
            run = RunInput(name, data)
            best = min(l.time for l in data.laps if l.clean)
            out.append(RunSource(name, side, lambda r=run: RunInput(r.name, r.data), best,
                                 packed=(lambda p=packed[name]: p) if packed else None))
        return out

    old = compare_groups(sources(None), corners=CORNERS)
    # each run's channels are let go once read: read them again for the second comparison
    for name, paces in (("quick", (1.0, 0.99)), ("slow", (0.97, 0.98, 0.96))):
        runs[name] = _data(paces)
    packed = {name: _packed(data) for name, data in runs.items()}

    def no_log():
        raise AssertionError("read a log")

    new = compare_groups([RunSource(s.name, s.side, no_log, s.best, packed=s.packed) for s in sources(packed)],
                         corners=CORNERS)
    assert [s["code"] for s in new["sections"]] == [s["code"] for s in old["sections"]]
    for a, b in zip(old["sections"], new["sections"], strict=True):
        for g in "ab":
            np.testing.assert_allclose(b["times"][g], a["times"][g], atol=0.0011)
        assert b["delta_s"] == pytest.approx(a["delta_s"], abs=0.0011)
        assert b["main_phase"] == a["main_phase"]
    assert new["median_gap_s"] == pytest.approx(old["median_gap_s"], abs=0.0011)
    assert new["typical_gap_s"] == pytest.approx(old["typical_gap_s"], abs=0.0011)
    assert new["laps"] == old["laps"] and new["reference"] == old["reference"]
    assert new["theoretical_lap"] == pytest.approx(old["theoretical_lap"], abs=0.02)


def _upload(client, session_id: int, paces) -> None:
    channels, _ = simulate(paces=paces)
    hz, unit, v = channels["vCar"]
    channels["vCar"] = (hz, unit, np.round(v, 1))
    r = client.post(f"/sessions/{session_id}/files", files={"file": ("run.ld", write_ld(channels))})
    assert r.status_code == 201, r.text


def _job(client, body: dict) -> dict:
    job = client.post("/compare/drivers/jobs", json=body)
    assert job.status_code == 202, job.text
    for _ in range(600):
        job = client.get(f"/compare/drivers/jobs/{job.json()['id']}")
        if job.json()["status"] in ("done", "failed"):
            break
        time.sleep(0.05)
    assert job.json()["status"] == "done", job.json()["error"]
    return job.json()["result"]


def test_comparisons_read_no_log_once_their_sessions_are_packed(client, monkeypatch):
    import app.heavy
    import app.lappacks
    import app.routers.insights
    import app.routers.lapcompare
    import app.routers.reports
    from app import db as app_db
    from app import models

    track = client.post("/tracks", json={"name": "Test ring", "corners": [
        {"code": "T1", "apex_m": 300}, {"code": "T2", "apex_m": 700}]}).json()
    event = client.post("/events", json={"name": "Test day", "track_id": track["id"]}).json()
    ids = {}
    for name, paces in (("Ben", (0.97, 0.98)), ("Anna", (1.0, 0.99))):
        ids[name] = client.post("/sessions", json={"event_id": event["id"], "name": f"Run {name}"}).json()["id"]
        _upload(client, ids[name], paces)
        client.post("/drivers/assign", json={"driver_name": name, "session_ids": [ids[name]]})
    picks = {"laps": [{"session_id": ids["Ben"], "lap": 2}, {"session_id": ids["Anna"], "lap": 1},
                      {"session_id": ids["Anna"], "lap": 2}]}
    sides = {"a": {"label": "Ben", "session_ids": [ids["Ben"]]}, "b": {"label": "Anna", "session_ids": [ids["Anna"]]}}

    # the first time, from the logs: each session's pack is made in the background, with its compact traces
    first = client.post("/compare/laps", json=picks)
    assert first.status_code == 200, first.text
    drivers = _job(client, sides)
    assert app.lappacks.wait_idle() and app.routers.reports.wait_idle()
    with app_db.SessionLocal() as db:
        rows = {r.session_id: r for r in db.scalars(select(models.LapPackFile))}
    assert set(rows) == set(ids.values()) and all(r.path and r.laps == 2 and r.error is None for r in rows.values())

    # then without reading a log or waiting for the lock
    def no_log(*args, **kwargs):
        raise AssertionError("read a log")

    locked = []

    class Locked:
        def __enter__(self):
            locked.append(True)
            raise AssertionError("took heavy.lock")

        def __exit__(self, *exc):
            return False

    with monkeypatch.context() as m:
        for module in (app.routers.lapcompare, app.routers.insights, app.lappacks):
            m.setattr(module, "read_file", no_log)
        m.setattr(app.heavy, "lock", Locked())
        app.routers.lapcompare._answers.clear()
        again = client.post("/compare/laps", json=picks)
        assert again.status_code == 200, again.text
        _same_comparison(first.json(), again.json())
        assert again.json()["laps"] == first.json()["laps"]  # each lap's session, driver, time and best sections
        assert client.post("/compare/laps", json=picks).json() == again.json()  # kept: answered at once

        packed = _job(client, sides)
        assert [s["code"] for s in packed["sections"]] == [s["code"] for s in drivers["sections"]]
        for a, b in zip(drivers["sections"], packed["sections"], strict=True):
            for g in "ab":
                np.testing.assert_allclose(b["times"][g], a["times"][g], atol=0.0011)
        assert packed["laps"] == drivers["laps"] and packed["median_gap_s"] == pytest.approx(drivers["median_gap_s"],
                                                                                              abs=0.0011)
        # packs already made are skipped without reading or locking anything
        app.lappacks.warm_sessions(list(ids.values()))
        with app_db.SessionLocal() as db:
            assert {r.session_id: r.path for r in db.scalars(select(models.LapPackFile))} == \
                {sid: r.path for sid, r in rows.items()}
        assert not locked
