"""Shift points from the logs: the gear ratios and torque curve read from full throttle, the revs where the next gear
drives harder, and early and late upshifts against them."""
import numpy as np
import pytest

from app.analysis.shifts import BEFORE_LIMIT_RPM, ShiftModel
from app.analysis.technique import gain_cost, shift_mistakes

RATIO = {5: 100.0, 6: 70.0, 7: 52.0, 8: 30.0}  # revs per km/h, the logger's own gear numbers
LIMIT = 7000.0
PER_FORCE, DRAG = 4e-5, 1e-5


def torque(rpm):
    rpm = np.asarray(rpm, float)
    return np.where(rpm < 5000, 400 + 0.05 * (rpm - 3000), 500 - 0.12 * (rpm - 5000))


def straight(shift_at: dict[int, float], length: int = 800, v0: float = 40.0) -> dict[str, np.ndarray]:
    """Full throttle from v0 km/h on a straight, every metre, shifting up out of each gear at shift_at's revs."""
    v, gear, t = [v0], [5], [0.0]
    for _ in range(length):
        g = gear[-1]
        rpm = RATIO[g] * v[-1]
        nxt = g + 1 if g + 1 in RATIO else None
        if nxt is not None and rpm >= shift_at.get(g, LIMIT):
            g = nxt
            rpm = RATIO[g] * v[-1]
        force = torque(min(rpm, LIMIT)) * RATIO[g] if rpm < LIMIT else 0.0
        acc = PER_FORCE * force - DRAG * v[-1] ** 2
        ms = v[-1] / 3.6
        ms2 = np.sqrt(max(ms ** 2 + 2 * acc, 1.0))
        t.append(t[-1] + 2 / (ms + ms2))
        v.append(ms2 * 3.6)
        gear.append(g)
    v, gear = np.array(v), np.array(gear)
    rpm = np.array([RATIO[g] for g in gear]) * v
    return {"speed": v, "t": np.array(t), "gear": gear, "rpm": rpm,
            "engine_torque": np.where(rpm < LIMIT, torque(rpm), 0.0), "throttle": np.full(len(v), 100.0),
            "ay": np.zeros(len(v))}


@pytest.fixture(scope="module")
def model() -> ShiftModel:
    laps = [straight({5: r, 6: r, 7: r}) for r in (5800, 6300, 6800, LIMIT + 1)]
    m = ShiftModel.of(laps)
    assert m is not None
    return m


def test_the_ratios_torque_and_limiter_come_from_the_logs(model):
    assert set(model.ratio) == set(RATIO)
    for g, k in RATIO.items():
        assert model.ratio[g] == pytest.approx(k, rel=1e-3)
    assert model.limit == pytest.approx(LIMIT, abs=100)
    assert model.torque(5500) == pytest.approx(float(torque(5500)), rel=0.03)
    assert model.per_force == pytest.approx(PER_FORCE, rel=0.1)


def test_the_ideal_shift_is_where_the_next_gear_drives_harder(model):
    rpm = np.arange(5000, LIMIT, 1.0)
    v = rpm / RATIO[5]
    cross = rpm[np.argmax(torque(v * RATIO[6]) * RATIO[6] >= torque(rpm) * RATIO[5])]
    assert model.ideal[5] == pytest.approx(min(cross, model.limit - BEFORE_LIMIT_RPM), abs=60)


def test_an_early_and_a_late_upshift_are_found_and_costed(model):
    early = straight({5: model.ideal[5] - 800, 6: model.ideal[6]})
    found = shift_mistakes(early, model, 0, len(early["speed"]) - 1)
    assert [x["kind"] for x in found] == ["early_shift"]
    x = found[0]
    lost = gain_cost(early, x["j"], x["end"], x["extra"], len(early["speed"]) - 1)
    # what it really lost against the same straight shifted at the ideal revs
    right = straight({5: model.ideal[5], 6: model.ideal[6]})
    at = len(early["speed"]) - 1
    assert 0.7 * (early["t"][at] - right["t"][at]) <= lost <= 1.5 * (early["t"][at] - right["t"][at])
    assert lost > 0.01

    late = straight({5: np.inf, 6: model.ideal[6]})  # held on the limiter...
    late["gear"][np.argmax(late["rpm"] >= LIMIT - 20) + 60:] = 6  # ...for 60 m, then shifted
    late["rpm"] = np.array([RATIO[g] for g in late["gear"]]) * late["speed"]
    found = shift_mistakes(late, model, 0, len(late["speed"]) - 1)
    assert [x["kind"] for x in found] == ["late_shift"] and found[0]["limiter_m"] >= 10


def test_no_shift_points_without_revs_or_torque():
    lap = straight({5: 6500, 6: 6500})
    del lap["engine_torque"]
    assert ShiftModel.of([lap]) is None


def test_an_early_upshift_taken_out_of_the_lap_shifts_at_the_ideal_revs(model):
    from app.analysis.laps import Section
    from app.analysis.local_limits import PlaceLimits
    from app.analysis.technique import Envelope, without_mistakes
    early = straight({5: model.ideal[5] - 800, 6: model.ideal[6]})
    right = straight({5: model.ideal[5], 6: model.ideal[6]})
    n = len(early["speed"]) - 1
    x = shift_mistakes(early, model, 0, n)[0]
    lim = PlaceLimits.uniform(n, lateral=2.0, brake=2.0, accel=2.0, power=(100.0, 1.0, 0.0), top_speed=400.0)
    env = Envelope(np.zeros(n + 1), lim)
    item = {"kind": "early_shift", "start_m": x["j"], "end_m": x["end"], "at_m": x["j"]}
    fixed = without_mistakes(early, env, [Section("T1", 0, n, None)], [item], model)
    v = early["speed"]
    assert np.all(fixed >= v - 1e-9) and np.all(fixed[:x["j"] + 1] == v[:x["j"] + 1])
    # it gains about what shifting at the ideal revs gains, never more than that straight's own speed
    assert np.all(fixed <= right["speed"] + 0.5)
    ms = fixed / 3.6
    took = float(np.sum(2 / (ms[:-1] + ms[1:])))
    assert 0.5 * (early["t"][n] - right["t"][n]) <= early["t"][n] - took <= 1.5 * (early["t"][n] - right["t"][n])
    # without the shift model nothing is put right
    assert without_mistakes(early, env, [Section("T1", 0, n, None)], [item]).tolist() == v.tolist()
