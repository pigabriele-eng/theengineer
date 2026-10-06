"""Grip compared per unit of the road's load: a banked corner, where the car pulls far more g on the same tyres, sets
neither the car's grip envelope nor the cornering lent to places taken flat out, and its grip use reads like any
other corner's; the balance and the tyre fit read it the same way."""
from dataclasses import dataclass
from types import SimpleNamespace

import numpy as np
import pytest

from app.analysis.channels import BRAKE, MID, POWER
from app.analysis.grip import Report
from app.analysis.insights import LapRecord, lateral, targets
from app.analysis.limits import CarLimits, car_limits
from app.analysis.local_limits import PERFECT, place_limits
from app.analysis.track_shape import LEVEL_G, TrackShape, on_line, track_shape
from app.vehicle.tyre_fit import level_road, yaw_rate_scale

G = 9.81
N = 2000  # a 2 km loop
MU = 1.5  # the tyres' grip per unit of load, at the limit through every corner on the quickest lap
BANK_DEG = 15.0
CORNERS = ((300, 1, 0.0), (700, -1, BANK_DEG), (1100, -1, 0.0), (1500, 1, 0.0))  # apex m, side, bank
PACES = (0.97, 0.975, 0.98, 0.985, 0.99, 0.995, 1.0)
GYRO_SCALE = 0.93


def _bump(d, at, width, power=2):
    pd = (d - at + N / 2) % N - N / 2
    return np.exp(-np.abs(pd / width) ** power)


def _lap(pace: float, rng: np.random.Generator) -> dict[str, np.ndarray]:
    d = np.arange(N + 1, dtype=float)
    v = pace * (200.0 - sum(90.0 * _bump(d, at, 70) for at, _, _ in CORNERS)) / 3.6
    share = sum(s * _bump(d, at, 70, 4) for at, s, _ in CORNERS)
    side = np.sign(share)
    b = sum(np.radians(bank) * _bump(d, at, 80, 4) for at, _, bank in CORNERS)
    mu = MU * pace ** 2 * np.abs(share)  # the share of the tyres' grip in use
    c = (mu * np.cos(b) + np.sin(b)) / (np.cos(b) - mu * np.sin(b))  # the turn that asks that of them
    az = np.cos(b) + c * np.sin(b)
    ax = np.gradient(v * v / 2) / G
    noise = lambda: rng.normal(0, 0.01, len(d))  # noqa: E731
    ay = side * (c * np.cos(b) - np.sin(b))  # = side * mu * az: on the bank the car pulls more g
    phase = np.where(np.abs(ay) > 0.3, MID, np.where(ax < 0, BRAKE, POWER))
    return {"distance": d, "t": np.concatenate([[0.0], np.cumsum(2 / (v[:-1] + v[1:]))]), "speed": v * 3.6,
            "ax": ax + noise(), "ay": ay + noise(), "turn_g": side * GYRO_SCALE * c * np.cos(b) + noise(),
            "az": az + noise(), "throttle": np.where(ax >= 0, 100.0, 0.0), "phase": phase.astype(float),
            "curvature": side * c * G / (v * v)}


@pytest.fixture(scope="module")
def laps() -> list[dict[str, np.ndarray]]:
    rng = np.random.default_rng(3)
    return [_lap(p, rng) for p in PACES]


@pytest.fixture(scope="module")
def shape(laps) -> TrackShape:
    out = track_shape(laps)
    assert out is not None
    assert [f["kind"] for f in out.features] == ["banked"]
    return out


def test_the_shape_on_the_line(shape):
    load, shaped = on_line(shape, N + 1)
    assert len(load) == len(shaped) == N + 1
    assert load[700] > 1.5 and load[1000] == 1.0  # a straight: level, within the accelerometer's own error
    assert shaped[700] and not shaped[300] and not shaped[1000]
    assert shaped[0] == shaped[N]
    assert on_line(None, N + 1) == (None, None)
    near = TrackShape(5, np.zeros(4), np.zeros(4), np.array([1.0, 1.0 + LEVEL_G / 2, 1.0 + 3 * LEVEL_G, 0.6]),
                      [{"kind": "crest", "start_m": 18, "end_m": 2, "value": 0.6}])  # through the timing line
    load = near.load_on(21)
    assert load[5] == 1.0 and load[10] == pytest.approx(1 + 2 * LEVEL_G) and load[15] == pytest.approx(0.6 + LEVEL_G)
    assert near.shaped_on(21).tolist() == [True] * 3 + [False] * 15 + [True] * 3


def test_the_banked_corner_sets_no_grip_for_the_rest_of_the_lap(laps, shape):
    level = car_limits(laps)
    assert level.max_lateral(level.speeds).max() > 2.2  # the bank's g, lent to every corner
    lim = car_limits(laps, *on_line(shape, N + 1))
    assert lim.max_lateral(lim.speeds).max() == pytest.approx(MU, abs=0.08)  # the tyres' own, on a level road
    quick = laps[PACES.index(1.0)]

    def apex_use(limits, at):
        sl = slice(at - 5, at + 6)
        return float(np.mean(limits.use(quick["speed"][sl], quick["ax"][sl], quick["ay"][sl], at=sl)))

    # every corner at the limit reads at the limit, the banked one too
    for at, _, _ in CORNERS:
        assert apex_use(lim, at) == pytest.approx(1.0, abs=0.08)
    assert apex_use(level, 300) < 0.75  # against the bank's g the flat corners looked well short of it


def test_places_taken_flat_out_borrow_the_level_corners_grip(laps, shape):
    load, shaped = on_line(shape, N + 1)
    before, = place_limits(laps, percentiles=(PERFECT,))
    after, = place_limits(laps, percentiles=(PERFECT,), load=load, shaped=shaped)
    flat = after.corner != after.lateral
    assert flat.any()
    lent = after.corner[flat] / load[np.flatnonzero(flat) * after.step]
    assert np.max(lent) == pytest.approx(MU, abs=0.1)  # the level corners' grip, at the place's own load
    assert np.max(before.corner[before.corner != before.lateral]) > 2.0  # the banked corner's


@dataclass
class _Lap:
    time: float
    trace: dict[str, np.ndarray]


def test_targets_carry_the_shape(laps):
    records = [_Lap(float(tr["t"][-1]), tr) for tr in laps]
    quick = min(records, key=lambda x: x.time)
    t = targets(records, quick.trace, quick.time)
    assert t.shape is not None and [f["kind"] for f in t.shape.features] == ["banked"]
    assert t.limits.load is not None and t.limits.max_lateral(t.limits.speeds).max() == pytest.approx(MU, abs=0.08)


def test_the_balance_reads_cornering_per_unit_of_load(laps, shape):
    lim = car_limits(laps, *on_line(shape, N + 1))
    tr = laps[0]
    per_load = lateral(tr, lim)
    assert per_load[700] == pytest.approx(abs(tr["ay"][700]) / lim.load[700])
    assert per_load[300] == pytest.approx(abs(tr["ay"][300]))  # a level corner: its own g
    assert lateral(tr, lim, slice(690, 710)) == pytest.approx(per_load[690:710])
    plain = CarLimits(lim.speeds, lim.envelope, lim.line_speeds, lim.accel, lim.brake, lim.top_speed)
    assert lateral(tr, plain)[700] == pytest.approx(abs(tr["ay"][700]))  # no shape: the g itself


def test_the_gg_diagram_reads_against_the_level_road_edge(laps):
    """The grip report's g-g points are per unit of the road's load, as its edge is: the banked corner's sit on the
    edge like the level corners', not outside it, and are flagged."""
    study = SimpleNamespace(laps=[LapRecord("R", i + 1, float(tr["t"][-1]), None, tr, i) for i, tr in enumerate(laps)],
                            corners=None)
    rep = Report(study)
    gg = rep._gg(rep.ref)
    m, ay, load, shaped = (np.asarray(gg[k]) for k in ("m", "ay", "load", "shaped"))
    assert len(m) == len(ay) == len(load) == len(shaped)
    bank, flat = (m > 680) & (m < 720), (m > 280) & (m < 320)
    assert shaped[bank].all() and not shaped[flat].any()
    assert load[bank].min() > 1.2 and np.all(load[flat] == 1.0)
    raw = np.abs(rep.ref.trace["ay"][m[bank]])
    assert raw.max() > 1.25 * MU  # the g the bank lets the car pull
    assert np.abs(ay[bank]).max() == pytest.approx(np.abs(ay[flat]).max(), rel=0.08)  # per unit of load, the same
    edge = rep.limits.max_lateral(np.asarray(gg["speed"], float))
    assert np.max(np.abs(ay[bank]) / edge[bank]) < 1.1


def test_the_tyre_fit_reads_level_road_only():
    rng = np.random.default_rng(5)
    n = 6000
    v_kmh = np.full(n, 120.0)
    r = np.full(n, 0.3)  # rad/s
    turn = v_kmh / 3.6 * r / G  # g the turn takes
    banked = np.arange(n) >= 2000  # most of this log is banked
    b = np.radians(15.0)
    ay = np.where(banked, turn * np.cos(b) - np.sin(b), turn) * 1.05  # the gyro reads 5 % low
    az = np.where(banked, np.cos(b) + turn * np.sin(b), 1.0) + rng.normal(0, 0.01, n)
    level = level_road({"az": az})
    assert level is not None and not level[banked].any() and level[:1900].all()
    assert level_road({}) is None
    zeros = np.zeros(n)
    assert yaw_rate_scale(v_kmh, ay, zeros, r, zeros, level) == pytest.approx(1.05, abs=0.01)
    assert yaw_rate_scale(v_kmh, ay, zeros, r, zeros) < 0.9  # the bank's, without the vertical accelerometer
