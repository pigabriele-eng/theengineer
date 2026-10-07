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
    assert -1e-9 <= gain["T2"] < 0.05 * gain["T1"]  # capped at the best pass: exactly none, to rounding
    # T2 from its braking on is the fastest lap's own
    brake = int(CORNERS_M[1]) - 50
    assert np.allclose(np.diff(t.sim.t)[brake:], np.diff(ref)[brake:], atol=1e-9)
    assert t.sim.time == pytest.approx(fastest.time - gain["T1"] - gain["T2"], abs=1e-9)
    # the realistic target (the median of two laps) gains less than the theoretical lap, and only in T1 too
    real = {s.code: _section(ref, s) - _section(t.realistic.t, s) for s in SECTIONS}
    assert 0 < real["T1"] <= gain["T1"] and -1e-9 <= real["T2"] < 0.05 * gain["T1"]


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
    # this lap gets its speed back by 420 m, quicker than any car could, so it loses less than a real lift would:
    # the cost (the drive the lift took, carried on) is of its size, not under it
    assert 0.01 <= lifts[0]["cost_s"] <= 2 * (lifted.time - fastest.time)
    clean = check_lap(fastest.trace, t.perfect, t.held, SECTIONS, lap_time=fastest.time,
                      calibrations=(t.calibration, t.held_calibration))
    assert clean["obvious"] == []


def test_braking_below_the_limit_costs_the_later_brake_point():
    from app.analysis.technique import brake_cost
    assert brake_cost(60.0, 25.0, 1.3, 1.3) == 0.0
    soft = brake_cost(60.0, 25.0, 1.0, 1.3)
    # braking 35 m/s at 1.0 g instead of 1.3 g: 0.83 s longer, of which the later brake point wins back most
    assert 0.05 < soft < 0.83


def test_the_theoretical_speed_runs_on_smoothly_across_a_section_join(fastest):
    d = np.arange(N + 1, dtype=float)
    other = Lap(0.97 + 0.06 * _step(d, 40, 460))
    t = targets([fastest, other], fastest.trace, fastest.time, SECTIONS)
    jump = np.abs(np.diff(t.sim.speed))
    own = np.abs(np.diff(fastest.trace["speed"]))
    assert jump[495:505].max() <= own.max() + 0.5  # no step at the join (500 m) beyond the lap's own


def test_the_throttle_on_and_off_twice_is_two_lifts():
    from app.analysis.technique import _dips
    n = 200
    thr = np.full(n, 100.0)
    thr[50:60], thr[90:100] = 40.0, 30.0  # off and back on, twice
    ts = np.arange(n) * 0.025  # 40 m/s
    out = _dips(thr, ts, np.maximum.accumulate(thr), np.full(n, -1.5), 0, -1.0, 0)
    assert [(a, lo) for a, _, _, lo in out] == [(50, 40.0), (90, 30.0)]


def test_speed_that_stops_climbing_on_the_way_out_is_a_stall():
    from app.analysis.technique import _stalls
    # out of a corner at 2 m/s², flat for 10 m (0.4 s at about 25 m/s), then climbing again; no braking
    x = np.arange(200, dtype=float)
    v2 = np.where(x < 80, 20.0 ** 2 + 4 * x, np.where(x < 90, 20.0 ** 2 + 320, 20.0 ** 2 + 320 + 4 * (x - 90)))
    ms = np.sqrt(v2)
    t = np.concatenate([[0.0], np.cumsum(2 / (ms[:-1] + ms[1:]))])
    tr = {"speed": ms * 3.6, "t": t, "braking": np.zeros(200)}
    out = _stalls(tr, 0, 199, np.full(200, -0.3), -1.0)
    assert len(out) == 1 and 70 <= out[0][0] <= 85 and 85 <= out[0][1] <= 100
    tr["braking"][75:] = 1.0  # the same, braking for the next corner: not a stall
    assert _stalls(tr, 0, 199, np.full(200, -0.3), -1.0) == []


def test_the_best_technique_lap_takes_the_best_clean_pass_or_builds_one(fastest):
    from app.analysis.technique import Pass, best_technique, section_times
    d = np.arange(N + 1, dtype=float)
    lifted = Lap(1 - 0.06 * _step(d, 360, 420, 10))  # an exit lift out of T1
    lifted.trace["throttle"] = np.where((d >= 350) & (d <= 400), 20.0, lifted.trace["throttle"])
    slow_t2 = Lap(1 - 0.03 * _step(d, 600, 800, 20))  # clean but slower through T2
    laps = [fastest, lifted, slow_t2]
    t = targets(laps, fastest.trace, fastest.time, SECTIONS)
    passes = []
    for i, x in enumerate(laps):
        out = check_lap(x.trace, t.perfect, t.held, SECTIONS, lap_time=x.time,
                        calibrations=(t.calibration, t.held_calibration))
        passes.append(Pass("Q1", i + 1, x.time, "PIA", section_times(x.trace, SECTIONS), out["obvious"],
                           out["trace"]))
    # the lifted lap with its lift taken out: never slower, quicker out of T1, the same elsewhere
    tr = passes[1].trace
    fixed = np.array(tr["model"]["fixed"]["speed"])
    driven = np.array(tr["driven"])
    m = np.arange(len(driven)) * tr["step_m"]
    assert np.all(fixed >= driven - 0.05)
    assert fixed[(m > 370) & (m < 410)].min() > driven[(m > 370) & (m < 410)].max() - 1
    assert np.allclose(fixed[m > 500], driven[m > 500], atol=0.05)
    # slow_t2 laid over: T1 from the lap with no lift (the fastest), T2 its own pass with nothing to take out
    best = best_technique(passes[2], passes, SECTIONS)
    src = {x["code"]: x for x in best["sources"]}
    assert src["T2"]["kind"] == "pass" and src["T2"]["number"] == 1 and src["T2"]["gain_s"] > 0
    # the lifted lap: T1's lift is not a clean pass, and the fastest lap's T1 is quicker: that pass is taken
    best = best_technique(passes[1], passes, SECTIONS)
    src = {x["code"]: x for x in best["sources"]}
    assert src["T1"]["kind"] == "pass" and src["T1"]["number"] == 1
    # the fastest lap: nothing quicker anywhere, nothing to take out
    best = best_technique(passes[0], passes, SECTIONS)
    assert [x["kind"] for x in best["sources"]] == ["own", "own"]
    assert best["time"] == pytest.approx(fastest.time, abs=1e-3)
    # the join blended: the speed runs on as smoothly as the laps' own
    best = best_technique(passes[2], passes, SECTIONS)
    v = np.array(best["speed"])
    assert len(v) == len(driven) and np.abs(np.diff(v)).max() <= np.abs(np.diff(driven)).max() + 1
    assert best["time"] < slow_t2.time
    # another driver's passes are not this driver's best
    other = [Pass(p.run, p.number, p.time, "RAC" if p is not passes[2] else "PIA", p.times, p.obvious, p.trace)
             for p in passes]
    best = best_technique(other[2], other, SECTIONS)
    assert all(x["kind"] != "pass" for x in best["sources"])


def test_a_lift_taken_out_of_the_lap_runs_on_at_its_own_acceleration(fastest):
    from app.analysis.technique import Envelope, without_mistakes
    d = np.arange(N + 1, dtype=float)
    lifted = Lap(1 - 0.06 * _step(d, 360, 420, 10))
    t = targets([fastest, lifted], fastest.trace, fastest.time, SECTIONS)
    env_r = Envelope(lifted.trace["curvature"], t.held, t.held_calibration)
    lift = {"kind": "exit_lift", "start_m": 350, "end_m": 400, "at_m": 355}
    fixed = without_mistakes(lifted.trace, env_r, SECTIONS, [lift])
    v = lifted.trace["speed"]
    assert np.all(fixed >= v - 1e-9) and np.all(fixed[:350] == v[:350]) and np.all(fixed[600:] == v[600:])
    assert fixed[400] > v[400] and fixed[400] <= fastest.trace["speed"][400] * 1.01
    assert np.abs(np.diff(fixed)).max() <= np.abs(np.diff(v)).max() + 0.5
    assert without_mistakes(lifted.trace, env_r, SECTIONS, []).tolist() == v.tolist()
