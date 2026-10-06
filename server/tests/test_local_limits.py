"""The perfect lap's limits, place by place: a banked corner keeps its own grip, nothing is asked below what the
fastest lap showed, and accelerometers logged in m/s² read as g."""
import numpy as np
import pytest

from app.analysis.channels import math_channels
from app.analysis.insights import RunInput, analyze_runs
from app.analysis.lapsim import LapModel, theoretical_lap
from app.analysis.laps import load_session
from app.analysis.local_limits import PlaceLimits, place_limits, smoothed_curvature
from app.importers.motec import read_ld
from tests.synthetic import simulate, speed_at, write_ld

G = 9.81
N = 1000  # a 1 km loop: a flat corner at 300 m, a banked one at 700 m
FLAT_G, BANKED_G = 1.4, 1.9  # lateral g the accelerometer shows at each apex on the quickest lap
PACES = (0.96, 0.97, 0.975, 0.98, 0.985, 0.99, 1.0)


def _weight(d: np.ndarray, at: float) -> np.ndarray:
    return np.exp(-((d - at) / 30.0) ** 2)


def _lap(pace: float) -> dict[str, np.ndarray]:
    """One lap on the line, every metre: the same line at every pace, so the cornering g grows with pace squared."""
    d = np.arange(N + 1, dtype=float)
    v = speed_at(d, pace)
    ms = v / 3.6
    k = (FLAT_G * _weight(d, 300) + BANKED_G * _weight(d, 700)) * G / (speed_at(d, 1.0) / 3.6) ** 2
    ax = np.gradient(ms ** 2 / 2) / G
    t = np.concatenate([[0.0], np.cumsum(2 / (ms[:-1] + ms[1:]))])
    return {"distance": d, "t": t, "speed": v, "ax": ax, "ay": ms ** 2 * k / G, "curvature": k,
            "throttle": np.where(ax >= 0, 100.0, 0.0), "phase": np.zeros_like(v)}


@pytest.fixture(scope="module")
def laps() -> list[dict[str, np.ndarray]]:
    return [_lap(p) for p in PACES]


def _slowest(v: np.ndarray, at: int) -> float:
    return float(v[at - 60:at + 61].min())


def test_a_banked_corner_keeps_its_grip_and_lends_it_to_no_other(laps):
    best = laps[-1]
    perfect, held = place_limits(laps, best)
    # each corner's own cornering: the banked one shows far more, and the flat one is not given it
    assert perfect.lateral[perfect.place_of(np.array([300]))[0]] == pytest.approx(FLAT_G, abs=0.03)
    assert perfect.lateral[perfect.place_of(np.array([700]))[0]] == pytest.approx(BANKED_G, abs=0.03)
    sim = theoretical_lap(best["curvature"], perfect)
    # the banked corner's grip in the flat one would carry sqrt(1.9 / 1.4), 16 %, more speed through it; perfect
    # driving carries no more than the line's smoothing gives (about 1 %)
    assert _slowest(sim.speed, 300) <= 1.02 * _slowest(best["speed"], 300)
    assert _slowest(sim.speed, 700) >= 0.99 * _slowest(best["speed"], 700)
    # laps that are the same lap at different paces: perfect driving is the quickest of them, to within a hair
    t_best = float(best["t"][-1])
    assert 0.99 * t_best <= sim.time <= 1.002 * t_best
    real = theoretical_lap(best["curvature"], held)
    assert sim.time <= real.time <= 1.002 * t_best


def test_never_less_than_the_fastest_lap_showed(laps):
    # the slower laps alone would set lower limits: the fastest lap's own values are the floor
    perfect, held = place_limits(laps[:3], laps[-1])
    best = laps[-1]
    t_best = float(best["t"][-1])
    alone, _ = place_limits(laps[:3])
    assert theoretical_lap(best["curvature"], alone).time > 1.01 * t_best
    for lim in (perfect, held):
        at = np.arange(N)
        place = lim.place_of(at)
        # its cornering as perfect driving reads it on its line (the curvature smoothed)
        ay = (best["speed"][:N] / 3.6) ** 2 * smoothed_curvature(best["curvature"][:N]) / G
        assert np.all(lim.lateral[place] >= ay - 1e-6)
        decel = -(best["ax"][:N] - lim.grade)  # as the limits read the accelerometer: less the road's slope
        braking = decel > 0.1
        assert np.all(lim.brake[place[braking], 0] >= decel[braking] - 1e-6)
        # within the steps the braking and drive are kept at (a twentieth of the place's cornering)
        assert theoretical_lap(best["curvature"], lim).time <= 1.01 * t_best


def test_the_report_simulation_and_perfect_driving_from_any_point_agree(laps):
    perfect, _ = place_limits(laps, laps[-1])
    k = laps[-1]["curvature"]
    model = LapModel(k[:-1], perfect)
    sim = theoretical_lap(k, perfect)
    assert np.allclose(model.P * 3.6, sim.speed) and model.cum[-1] == pytest.approx(sim.time)
    # under braking, perfect driving never brakes harder than the car showed at the place, at the cornering it asks
    F = np.array(model.F)
    braking = np.flatnonzero((model.P[:-1] < F[:-1] - 1e-6) & (model.P[1:] < F[1:] - 1e-6))
    assert len(braking) > 50
    for i in braking:
        v0, v1 = model.P[i], model.P[i + 1]
        assert (v0 ** 2 - v1 ** 2) / (2 * G) <= model.brake_at(i + 1, v1) + 1e-6


def test_uniform_limits_are_a_friction_circle():
    lim = PlaceLimits.uniform(N, lateral=1.5, brake=1.4, accel=0.9, power=(40 / 3.6, 0.0, 0.0), top_speed=200.0)
    model = LapModel(np.zeros(N), lim)
    assert model.brake_limit(10, 0.0) == pytest.approx(1.4)
    assert model.brake_limit(10, 0.9) == pytest.approx(1.4 * 0.8, abs=0.02)  # sqrt(1 - 0.6^2)
    assert model.brake_limit(10, 1.5) == pytest.approx(0.0, abs=1e-9)
    assert np.allclose(model.P * 3.6, 200 * 1.02)  # a straight line: flat out at the top speed all the way


def test_every_laps_own_line_theoretical_lap_follows_its_line(monkeypatch):
    """The insights' theoretical lap on each lap's own line (insights.prepare) drives a lap that moves across the
    road on the run into T1, where the quick laps go straight, at the cornering that lap showed there itself: not
    held to the quick laps' next to none, which made it seconds slower than the lap."""
    import app.analysis.insights as insights

    channels, times = simulate((0.99, 1.0, 0.995, 0.99, 0.96))
    hz = channels["vCar"][0]
    a, b = round(sum(times[:5]) * hz), round(sum(times[:6]) * hz)  # the 0.96 lap: 4 % off, not a limit lap
    v = channels["vCar"][2][a:b]
    d = np.cumsum(v) / 3.6 / hz
    swerve = 0.6 * (np.exp(-((d - 188) / 8) ** 2) - np.exp(-((d - 212) / 8) ** 2))  # g: out and back
    channels["gLat"][2][a:b] += swerve
    channels["nYaw"][2][a:b] += np.degrees(swerve * G / np.maximum(v / 3.6, 1.0))
    log = write_ld(channels)

    def own_line(lap: int) -> tuple[float, float]:
        res = analyze_runs([RunInput("run", load_session(read_ld(log)))])
        row = next(r for r in res["laps"] if r["lap"] == lap)
        return row["theoretical_own_line"], row["time"]

    with monkeypatch.context() as mp:
        mp.setattr(insights, "on_own_line", lambda lim, tr: lim)  # how it was
        before, time = own_line(5)
    after, _ = own_line(5)
    assert before > time + 1.0
    assert after < time - 0.3


# ---------- accelerometers in m/s² ----------

def _log(unit: str, factor: float, gyro: bool = True):
    channels, times = simulate()
    for name in ("gLat", "gLong"):
        hz, _, v = channels[name]
        channels[name] = (hz, unit, v * factor)
    if not gyro:
        del channels["nYaw"]
    return read_ld(write_ld(channels)), times


@pytest.mark.parametrize("unit,factor,gyro", [
    ("G", G, True),  # m/s² under a g label
    ("G", G, False),  # the same with no gyro to check the lateral axis against
    ("m/s/s", 1.0, True),  # g under an m/s² label, divided by 9.81 when read
])
def test_accelerometers_logged_in_the_wrong_unit_read_as_g(unit, factor, gyro):
    ld, _ = _log(unit, factor, gyro)
    d = load_session(ld)
    math_channels(d)
    right = load_session(_log("G", 1.0)[0])
    math_channels(right)
    for axis in ("ax", "ay"):
        for q in (0.5, 99.5):
            assert np.percentile(d.channels[axis], q) == pytest.approx(np.percentile(right.channels[axis], q), abs=0.02)
    want = analyze_runs([RunInput("run", right)])
    got = analyze_runs([RunInput("run", d)])
    assert got["theoretical_lap"] == pytest.approx(want["theoretical_lap"], abs=0.02)
    assert np.allclose(got["limits"]["envelope_g"], want["limits"]["envelope_g"], atol=0.05)
