"""The theoretical lap and the realistic target calibrated on the fastest lap: the lap simulation's own error cancels,
so a place gains only what another lap really showed there beyond the fastest lap."""
import numpy as np
import pytest

from app.analysis.insights import targets
from app.analysis.laps import Section
from app.analysis.technique import check_lap
from tests.synthetic import CORNERS_M, curvature_at, speed_at

G = 9.81
N = 1000  # the 1 km loop of tests.synthetic: corners at 300 and 700 m, straights at 0/1000 and 500 m
SECTIONS = [Section("T1", 0, 500, 300, ["T1"]), Section("T2", 500, N, 700, ["T2"])]


class Lap:
    def __init__(self, pace: np.ndarray):
        """A lap on the line, every metre, at pace (a share of the quickest speed) at each metre: the same line on
        every lap, so the cornering g grows with pace squared."""
        d = np.arange(N + 1, dtype=float)
        v = speed_at(d, 1.0) * pace
        ms = v / 3.6
        k = curvature_at(d)
        ax = np.gradient(ms ** 2 / 2) / G
        t = np.concatenate([[0.0], np.cumsum(2 / (ms[:-1] + ms[1:]))])
        braking = ax < -0.15
        thr = np.where(ax >= 0, 100.0, 0.0)
        self.trace = {"distance": d, "t": t, "speed": v, "ax": ax, "ay": ms ** 2 * k / G, "curvature": k,
                      "throttle": thr, "brake": np.where(braking, -ax * 60, 0.0), "braking": braking.astype(float),
                      "coasting": (~braking & (thr < 5)).astype(float), "phase": np.zeros_like(v)}
        self.time = float(t[-1])


def _step(d: np.ndarray, a: float, b: float, width: float = 25.0) -> np.ndarray:
    """1 between metres a and b, 0 outside, smoothly over width metres either side."""
    return 0.5 * (np.tanh((d - a) / width * 2) - np.tanh((d - b) / width * 2))


def _section(t: np.ndarray, s: Section) -> float:
    return float(t[s.end] - t[s.start])


@pytest.fixture(scope="module")
def fastest() -> Lap:
    return Lap(np.ones(N + 1))


def test_fed_only_one_laps_limits_the_targets_are_that_lap(fastest):
    t = targets([fastest], fastest.trace, fastest.time, SECTIONS)
    # the simulation alone at that lap's own limits is not that lap: that is the model's own error
    assert abs(t.calibration.own.time - fastest.time) > 0.05
    for target in (t.sim, t.realistic):
        assert target.time == pytest.approx(fastest.time, abs=1e-9)
        assert np.allclose(target.t, fastest.trace["t"], atol=1e-9)
        assert np.allclose(target.speed, fastest.trace["speed"], atol=1e-9)
    # the technique check of that lap against itself: nothing to find
    out = check_lap(fastest.trace, t.perfect, t.held, SECTIONS, lap_time=fastest.time,
                    calibrations=(t.calibration, t.held_calibration))
    assert out["perfect"] == pytest.approx(fastest.time, abs=1e-3)
    assert out["realistic"] == pytest.approx(fastest.time, abs=1e-3)
    assert out["gap"] == pytest.approx(0, abs=1e-3) and out["mistakes"] == []
    assert all(abs(p["cost_s"]) < 2e-3 and abs(p["cost_perfect_s"]) < 2e-3 for p in out["pieces"])


def test_a_lap_quicker_in_one_section_moves_only_that_section(fastest):
    d = np.arange(N + 1, dtype=float)
    # 3 % quicker through T1, 3 % slower through T2: slower over the lap
    other = Lap(0.97 + 0.06 * _step(d, 40, 460))
    assert other.time > fastest.time
    assert _section(other.trace["t"], SECTIONS[0]) < _section(fastest.trace["t"], SECTIONS[0])
    t = targets([fastest, other], fastest.trace, fastest.time, SECTIONS)
    ref = fastest.trace["t"]
    for target in (t.sim, t.realistic):  # never slower than the fastest lap, metre by metre
        assert np.all(np.diff(target.t) <= np.diff(ref) + 1e-12)
        assert np.all(target.speed >= fastest.trace["speed"] - 1e-9)
    gain = {s.code: _section(ref, s) - _section(t.sim.t, s) for s in SECTIONS}
    # T1 gains at least what the other lap really did there, and T2 next to nothing: only the speed T1's quicker exit
    # still carries down the straight into it
    assert _section(t.sim.t, SECTIONS[0]) <= _section(other.trace["t"], SECTIONS[0]) + 1e-9
    assert gain["T1"] > 0.1
    assert 0 <= gain["T2"] < 0.05 * gain["T1"]
    # T2 from its braking on is the fastest lap's own
    brake = int(CORNERS_M[1]) - 50
    assert np.allclose(np.diff(t.sim.t)[brake:], np.diff(ref)[brake:], atol=1e-9)
    assert t.sim.time == pytest.approx(fastest.time - gain["T1"] - gain["T2"], abs=1e-9)
    # the realistic target (the median of two laps) gains less than the theoretical lap, and only in T1 too
    real = {s.code: _section(ref, s) - _section(t.realistic.t, s) for s in SECTIONS}
    assert 0 < real["T1"] <= gain["T1"] and 0 <= real["T2"] < 0.05 * gain["T1"]
