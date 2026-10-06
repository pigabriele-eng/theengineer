"""Counting a lap the stint analysis leaves out: a slow lap, an outlier or an out-lap the user counts joins the
trends and every figure; a pit lap can't be counted; clearing the tag gives the old result back."""
import json

import numpy as np
import pytest

from app.analysis.channels import BRAKE, EXIT, MID, POWER, TRAIL
from app.analysis.insights import RunInput
from app.analysis.laps import Section, load_session
from app.analysis.stint import PIT_NOT_COUNTED, SECTION_KEYS, LapSummary, LogSummary, assemble, reduce_run
from app.importers.motec import read_ld
from tests.synthetic import simulate, write_ld

EXIT_FADE = 0.001  # s a metre on the exits, lap after lap: 0.1 s a lap


def _log(kinds: dict[int, str] | None = None, lost: dict[int, float] | None = None, n_laps: int = 8) -> LogSummary:
    """A log made by hand, one stint: the exit metres fade lap after lap. kinds: lap number -> its kind (flying
    otherwise); lost: lap number -> seconds lost on T2's exit alone (as traffic would)."""
    kinds, lost = kinds or {}, lost or {}
    phase = np.repeat(np.array([POWER, BRAKE, TRAIL, MID, EXIT, POWER], np.int8), 100)
    n = len(phase)
    sections = [Section("T1", 0, 300, 250, ["T1"]), Section("T2", 300, n, 450, ["T2"])]
    on_exit = phase == EXIT
    laps = []
    for i in range(n_laps):
        number = i + 1
        dt = np.full(n, 0.02, np.float32)
        dt[on_exit] += EXIT_FADE * i + lost.get(number, 0.0) / np.count_nonzero(on_exit)
        sec = {k: np.full(2, np.nan, np.float32) for k in SECTION_KEYS}
        sec["time"] = np.array([dt[:300].sum(), dt[300:].sum()], np.float32)
        kind = kinds.get(number, "flying")
        values = {"sens_kg": 0.0, "g_p90": 1.4, "trace_time": float(dt.sum())}
        laps.append(LapSummary(number, 100.0 * i, 100.0 * number, float(dt.sum()), kind == "flying", 1, number, kind,
                               values, sec, dt, phase, np.zeros(n, np.float32), None))
    return LogSummary("f", "Run", {}, "marker", n, sections, [], laps)


def _same(a: dict, b: dict) -> bool:
    return json.dumps(a, sort_keys=True, default=str) == json.dumps(b, sort_keys=True, default=str)


def test_a_slow_lap_counted_joins_the_fit():
    log = _log(kinds={5: "slow"}, lost={5: 0.4})
    before = assemble([log])["stints"][0]
    lap5 = before["laps"][4]
    assert lap5["kind"] == "slow" and not lap5["in_fit"] and not lap5["counted"]
    assert before["fitted_laps"] == 7 and before["fits"]["time"]["laps"] == 7
    assert "lap 5 (slow lap)" in before["words"]["left_out"]

    after = assemble([log], {("f", 5): "count"})["stints"][0]
    lap5 = after["laps"][4]
    assert lap5["counted"] and lap5["in_fit"] and lap5["kind"] == "slow" and lap5["tag"] is None
    assert after["fitted_laps"] == 8 and after["fits"]["time"]["laps"] == 8
    # in every figure: the lap time trend, the fade by phase (lap 5 lost its 0.4 s on T2's exit) and the words
    assert after["fits"]["time"]["per_lap"] != before["fits"]["time"]["per_lap"]
    assert after["fits"]["fade_exit"]["laps"] == 8
    assert after["median"] != before["median"]
    assert after["words"]["left_out"] == "Counted in by you: lap 5 (slow lap)."
    # the other laps keep their place
    assert [r["in_fit"] for r in after["laps"]] == [True] * 8


def test_an_outlier_counted_joins_the_fit_and_is_not_suggested_again():
    log = _log(lost={4: 2.0})
    before = assemble([log])["stints"][0]
    lap4 = before["laps"][3]
    assert lap4["outlier"] and not lap4["in_fit"]
    assert lap4["suggestion"]["tag"] == "traffic"  # 2 s lost in T2 alone
    assert before["fits"]["time"]["laps"] == 7

    after = assemble([log], {("f", 4): "count"})["stints"][0]
    lap4 = after["laps"][3]
    assert lap4["counted"] and lap4["in_fit"] and not lap4["outlier"]
    assert lap4["off_trend_s"] == pytest.approx(2.0, abs=0.05)
    assert lap4["suggestion"] is None  # the user's word stands
    assert after["fits"]["time"]["laps"] == 8 and after["fits"]["fade_exit"]["laps"] == 8
    assert after["fits"]["time"]["per_lap"] != before["fits"]["time"]["per_lap"]
    assert after["words"]["left_out"] == "Counted in by you: lap 4 (+2.0 s off the trend)."
    # tagged traffic instead, it is left out again
    traffic = assemble([log], {("f", 4): "traffic"})["stints"][0]["laps"][3]
    assert traffic["tag"] == "traffic" and not traffic["in_fit"] and not traffic["counted"]


def test_a_pit_lap_cant_be_counted():
    log = _log(kinds={8: "pit"})
    before = assemble([log])
    after = assemble([log], {("f", 8): "count"})
    pit = after["stints"][0]["laps"][7]
    assert pit["kind"] == "pit" and not pit["counted"] and not pit["in_fit"]
    assert _same(after, before)


def test_clearing_the_tag_restores_the_old_result():
    log = _log(kinds={1: "out", 6: "slow"}, lost={3: 2.0, 6: 0.5})
    before = assemble([log])
    counted = assemble([log], {("f", 1): "count", ("f", 3): "count", ("f", 6): "count"})
    assert counted["stints"][0]["fitted_laps"] == before["stints"][0]["fitted_laps"] + 3
    assert not _same(counted, before)
    assert _same(assemble([log], {}), before)


@pytest.fixture(scope="module")
def run_ld():
    """As test_stint's run: 8 laps (the fifth 3 % off), an in-lap with a 40 s stop, an out-lap and 6 laps."""
    def paces(n, slow=None):
        return [(0.97 if i == slow else 1.0) / (1 + 0.002 * i) for i in range(n)]
    channels, _ = simulate([*paces(8, 4), 0.6, 0.6, *paces(6)], stops={9: 40.0})
    return write_ld(channels)


def test_reduce_run_keeps_every_lap_but_the_pit_lap(run_ld):
    ld = read_ld(run_ld)
    log = reduce_run(RunInput("stints", load_session(ld), ld=ld))
    kinds = {l.kind for l in log.laps}
    assert {"flying", "out", "pit"} <= kinds
    for lap in log.laps:
        kept = (lap.dt, lap.phase, lap.sens, lap.corner)
        assert all(a is None for a in kept) if lap.kind == "pit" else all(a is not None for a in kept)


def test_counting_through_the_api_and_clearing_it(client, run_ld):
    s = client.post("/sessions", json={"name": "Long run"}).json()
    fid = client.post(f"/sessions/{s['id']}/files", files={"file": ("run.ld", run_ld)}).json()["files"][0]["id"]
    before = client.get(f"/stint?files={fid}").json()
    one, two = before["stints"]
    assert one["laps"][-1]["kind"] == "pit" and one["laps"][-1]["lap"] == 9
    assert two["laps"][0]["kind"] == "out" and two["laps"][0]["lap"] == 10 and not two["laps"][0]["in_fit"]
    assert [r["lap"] for r in one["laps"] if r["outlier"]] == [5]

    # a pit lap can't be counted: one line says why
    r = client.put("/lap-tags", json={"file_id": fid, "lap": 9, "tag": "count"})
    assert r.status_code == 422 and r.json()["detail"] == PIT_NOT_COUNTED
    assert client.get(f"/lap-tags?file_id={fid}").json() == []

    # the out-lap and the outlier counted: each joins its stint's fit
    for lap in (10, 5):
        assert client.put("/lap-tags", json={"file_id": fid, "lap": lap, "tag": "count"}).status_code == 200
    after = client.get(f"/stint?files={fid}").json()
    one_c, two_c = after["stints"]
    out_lap, lap5 = two_c["laps"][0], one_c["laps"][4]
    assert out_lap["counted"] and out_lap["in_fit"] and lap5["counted"] and lap5["in_fit"] and not lap5["outlier"]
    assert one_c["fitted_laps"] == one["fitted_laps"] + 1 and two_c["fitted_laps"] == two["fitted_laps"] + 1
    assert after["overall"]["fitted_laps"] == before["overall"]["fitted_laps"] + 2
    # a slow first lap in the trend: the stint now looks as if it got quicker
    assert two_c["fits"]["time"]["per_lap"] < two["fits"]["time"]["per_lap"]
    assert "Counted in by you: lap 10 (out-lap)." in two_c["words"]["left_out"]

    # the tags still work on a counted lap: traffic takes the count's place
    assert client.put("/lap-tags", json={"file_id": fid, "lap": 5, "tag": "traffic"}).status_code == 200
    lap5 = client.get(f"/stint?files={fid}").json()["stints"][0]["laps"][4]
    assert lap5["tag"] == "traffic" and not lap5["counted"] and not lap5["in_fit"]

    # clearing the tags gives the old result back
    for lap in (10, 5):
        assert client.delete(f"/lap-tags?file_id={fid}&lap={lap}").status_code == 204
    assert client.get(f"/stint?files={fid}").json() == before
