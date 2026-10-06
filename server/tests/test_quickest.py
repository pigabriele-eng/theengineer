"""A long event's grip and balance reports work from its quickest laps (analysis/quickest.py), on synthetic runs
with the cap set low."""
from types import SimpleNamespace

import numpy as np
import pytest

from app.analysis import quickest
from app.analysis.quickest import keep_quickest, lap_cap
from tests.synthetic import simulate, write_ld

RUN_A = (0.97, 1.0, 0.98, 0.96)  # pace: 1.0 is the quickest lap
RUN_B = (0.99, 0.95, 0.975, 0.985)


def test_cut_back_run_by_run_keeps_the_quickest_of_all():
    rng = np.random.default_rng(3)
    runs = [[SimpleNamespace(time=float(t)) for t in rng.normal(100, 2, n)] for n in (7, 12, 3, 9)]
    every = [x for run in runs for x in run]
    kept: list = []
    for run in runs:  # as the reports do: each run's laps added, then cut back
        kept = keep_quickest(kept + run, 10)
    assert kept == keep_quickest(every, 10) and len(kept) == 10
    assert max(x.time for x in kept) == sorted(x.time for x in every)[9]
    assert [every.index(x) for x in kept] == sorted(every.index(x) for x in kept)  # in their order
    few = every[:10]
    assert keep_quickest(few, 10) is few  # an event under the cap is not touched
    tied = [SimpleNamespace(time=t) for t in (1.0, 2.0, 2.0, 3.0)]
    assert [x.time for x in keep_quickest(tied, 2)] == [1.0, 2.0, 2.0]  # a lap as quick as the slowest kept stays
    assert lap_cap(10, 31) == {"used": 10, "of": 31} and lap_cap(31, 31) is None


def _event(client, name: str) -> int:
    import app.routers.balance as rb
    import app.routers.report_grip as rg

    rg._cache.clear()  # a report kept from another test of the same event id and laps, made with another cap
    rb._cache.clear()
    track =client.post("/tracks", json={"name": f"{name} track", "corners": [
        {"code": "T1", "apex_m": 300.0}, {"code": "T2", "apex_m": 700.0}]}).json()
    ev = client.post("/events", json={"name": name, "track_id": track["id"]}).json()
    for run, paces in (("Run A", RUN_A), ("Run B", RUN_B)):
        s = client.post("/sessions", json={"name": run, "event_id": ev["id"]}).json()
        up = client.post(f"/sessions/{s['id']}/files", files={"file": ("run.ld", write_ld(simulate(paces)[0]))})
        assert up.status_code == 201, up.text
    return ev["id"]


@pytest.mark.parametrize("cap", [5, 100])
def test_grip_report_of_a_long_event(client, monkeypatch, cap):
    monkeypatch.setattr(quickest, "MAX_LAPS", cap)
    ev = _event(client, "Long day")
    r = client.get(f"/report/grip?event={ev}")
    assert r.status_code == 200, r.text
    body = r.json()
    times = {(x["run"], x["lap"]): x["time"] for x in body["laps"]}
    if cap == 100:  # under the cap: every lap, and nothing said
        assert "quickest_laps" not in body and body["clean_laps"] == 8
        return
    assert body["quickest_laps"] == {"used": 5, "of": 8} and body["clean_laps"] == len(times) == 5
    assert [x["clean_laps"] for x in body["runs"]] == [4, 4]  # what each run has; the report uses the quickest
    quickest_paces = sorted(RUN_A + RUN_B, reverse=True)[:5]
    kept = sorted(p for run, paces in (("Run A", RUN_A), ("Run B", RUN_B)) for i, p in enumerate(paces)
                  if (run, i + 1) in times)
    assert kept == sorted(quickest_paces)
    assert body["fastest"] == {"run": "Run A", "lap": 2, "time": min(times.values())}


@pytest.mark.parametrize("cap", [4, 100])
def test_balance_report_of_a_long_event(client, monkeypatch, cap):
    monkeypatch.setattr(quickest, "MAX_LAPS", cap)
    ev = _event(client, "Long day")
    r = client.get(f"/report/balance?event={ev}")
    assert r.status_code == 200, r.text
    body = r.json()
    assert [s["laps"] for s in body["sessions"]] == [4, 4]  # each run's clean laps
    if cap == 100:
        assert "quickest_laps" not in body and body["laps"] == 8
        return
    assert body["quickest_laps"] == {"used": 4, "of": 8} and body["laps"] == 4
    assert body["reference"]["run"] == "Run A" and body["reference"]["lap"] == 2
