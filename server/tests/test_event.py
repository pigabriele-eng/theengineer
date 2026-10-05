"""Several runs compared on one reference lap."""
from app.analysis.event import Run, summarize
from app.analysis.laps import load_session
from app.importers.motec import read_ld
from tests.synthetic import simulate, write_ld


def test_runs_are_compared_on_the_fastest_lap_of_all_runs():
    fast = read_ld(write_ld(simulate(paces=(0.95, 1.0, 0.98))[0]))
    slow = read_ld(write_ld(simulate(paces=(0.93, 0.96, 0.95))[0]))
    report = summarize([Run("Day 1", load_session(slow), slow), Run("Day 2", load_session(fast), fast)])

    assert report["reference"]["run"] == "Day 2"
    assert [c["code"] for c in report["corners"]] == ["C1", "C2"]  # found in the speed trace, not official numbers
    day1, day2 = report["runs"]
    assert day1["best_time"] > day2["best_time"]
    # the slower run loses time to the reference in every corner section
    assert all(d > 0 for d in day1["best_vs_reference"].values())
    assert report["ideal_lap"] <= report["reference"]["time"] + 0.05
    assert day2["theoretical_best"] <= day2["best_time"] + 0.05
