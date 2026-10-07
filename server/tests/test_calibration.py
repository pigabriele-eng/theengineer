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


# ---------- a lap on a line of its own ----------

def _swerving(pace: float, at: float = 200.0, g: float = 0.6) -> Lap:
    """A lap at this pace that moves across the road around metre `at`, out and back at up to g of cornering, on
    the run into T1 where the quick laps go straight and are already off the throttle: a race lap pulling out to
    pass."""
    lap = Lap(np.full(N + 1, pace))
    d = np.arange(N + 1, dtype=float)
    ms = lap.trace["speed"] / 3.6
    swerve = g * G / ms ** 2 * (np.exp(-((d - at + 12) / 8) ** 2) - np.exp(-((d - at - 12) / 8) ** 2))
    lap.trace["curvature"] = lap.trace["curvature"] + swerve
    lap.trace["ay"] = ms ** 2 * lap.trace["curvature"] / G
    return lap


def test_perfect_driving_on_a_lap_that_moves_across_the_road(fastest, monkeypatch):
    """Five Hockenheim laps and a Zandvoort race lap moved across the road on a straight. Perfect driving on their own
    line was held to the cornering the quick laps showed there (next to none), so it braked for the swerve and, in a
    braking zone where no lap accelerated, crawled to the corner: a perfect lap of 118 s against laps of 107 to 113 s.
    Where a lap's line asks for more cornering than the quick laps showed, its own is the floor."""
    import app.analysis.technique as technique
    from app.analysis.insights import _closed_sim
    from app.analysis.local_limits import on_own_line

    quick = [fastest, *(Lap(np.full(N + 1, p)) for p in (0.995, 0.99, 0.985))]
    racing = _swerving(0.95)  # 5 % off the pace: not one of the laps the limits come from
    t = targets([*quick, racing], fastest.trace, fastest.time, SECTIONS)

    def check() -> dict:
        return check_lap(racing.trace, t.perfect, t.held, SECTIONS, lap_time=racing.time,
                         calibrations=(t.calibration, t.held_calibration))

    with monkeypatch.context() as mp:  # how it was: the quick laps' limits alone
        mp.setattr(technique, "on_own_line", lambda lim, tr: lim)
        before = check()
    assert before["perfect"] > racing.time + 1.0 and before["gap"] < 0
    out = check()
    assert out["perfect"] <= out["realistic"] < racing.time - 0.5
    # the swerve is taken no faster than the lap took it (nothing showed the car could), the rest at the limits:
    # a little off the theoretical lap, not twice the lap time
    assert t.sim.time < out["perfect"] < t.sim.time + 1.0, t.sim.time
    # the limits change only where the lap's line asked for more than the quick laps showed: around the swerve
    own = on_own_line(t.perfect, racing.trace)
    places = np.flatnonzero(own.corner != t.perfect.corner) * own.step
    assert len(places) and places.min() >= 160 and places.max() <= 240
    # the fastest lap on its own line: the very limits it was checked against before
    mine = on_own_line(t.perfect, fastest.trace)
    assert np.array_equal(mine.corner, t.perfect.corner)
    assert _closed_sim(fastest.trace["curvature"], mine).time == _closed_sim(fastest.trace["curvature"],
                                                                              t.perfect).time


def test_the_theoretical_lap_is_never_quicker_than_the_best_pass_through_a_section(fastest):
    d = np.arange(N + 1, dtype=float)
    other = Lap(0.97 + 0.06 * _step(d, 40, 460))
    t = targets([fastest, other], fastest.trace, fastest.time, SECTIONS)
    for s in SECTIONS:
        best = min(_section(x.trace["t"], s) for x in (fastest, other))
        assert _section(t.sim.t, s) == pytest.approx(best, abs=1e-6)
        assert _section(t.realistic.t, s) >= best - 1e-9


def test_a_lap_off_the_fastest_laps_line_lends_the_targets_nothing(fastest):
    alone = targets([fastest], fastest.trace, fastest.time, SECTIONS)
    off = Lap(np.full(N + 1, 1.4))  # a speed channel in other units: "quicker" everywhere
    t = targets([fastest, off], fastest.trace, fastest.time, SECTIONS)
    assert t.sim.time == pytest.approx(alone.sim.time, abs=1e-9)
    assert t.realistic.time == pytest.approx(alone.realistic.time, abs=1e-9)


def test_a_lift_on_the_way_out_of_a_corner_is_an_obvious_mistake(fastest):
    d = np.arange(N + 1, dtype=float)
    lifted = Lap(1 - 0.06 * _step(d, 360, 420, 10))
    lifted.trace["throttle"] = np.where((d >= 350) & (d <= 400), 20.0, lifted.trace["throttle"])
    t = targets([fastest, lifted], fastest.trace, fastest.time, SECTIONS)
    out = check_lap(lifted.trace, t.perfect, t.held, SECTIONS, lap_time=lifted.time,
                    calibrations=(t.calibration, t.held_calibration))
    lifts = [m for m in out["obvious"] if m["kind"] == "exit_lift"]
    assert [m["code"] for m in lifts] == ["T1"] and 350 <= lifts[0]["at_m"] <= 360
    assert 0.01 <= lifts[0]["cost_s"] <= lifted.time - fastest.time + 0.01
    clean = check_lap(fastest.trace, t.perfect, t.held, SECTIONS, lap_time=fastest.time,
                      calibrations=(t.calibration, t.held_calibration))
    assert clean["obvious"] == []


def test_braking_below_the_limit_costs_the_later_brake_point():
    from app.analysis.technique import brake_cost
    assert brake_cost(60.0, 25.0, 1.3, 1.3) == 0.0
    soft = brake_cost(60.0, 25.0, 1.0, 1.3)
    # braking 35 m/s at 1.0 g instead of 1.3 g: 0.83 s longer, of which the later brake point wins back most
    assert 0.05 < soft < 0.83
