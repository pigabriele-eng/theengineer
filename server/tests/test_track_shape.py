"""The road's shape from the car's own logs: a banked corner, a crest and a compression are found where they are, the
elevation follows GPS altitude, and whatever the logger didn't record is left unknown rather than guessed."""
import json

import numpy as np
import pytest

from app.analysis.channels import math_channels
from app.analysis.insights import RunInput, prepare
from app.analysis.laps import load_session
from app.analysis.track_shape import LOG_ROLES, SHAPE_STEP_M, TRACE_ROLES, track_shape
from app.importers.motec import read_ld
from tests.synthetic import TRACK_M, simulate, write_ld

G = 9.81
N = 2000  # a 2 km loop
CORNERS = ((300, 1, 0.0), (700, -1, 15.0), (1100, -1, 0.0), (1500, 1, 0.0))  # apex m, side (+ left), bank deg
CORNER_G = 1.5  # at each apex on the quickest lap
GYRO_SCALE = 0.93  # the gyro and speed read the turn 7 % low against the accelerometer: the car's own, learned
PACES = (0.96, 0.97, 0.975, 0.98, 0.985, 0.99, 1.0)
CREST_M, CREST_H = 1800, 3.0
DIP_H = 2.0  # a dip on the timing line


def _bump(d, at, width, power=2):
    pd = (d - at + N / 2) % N - N / 2  # round the loop
    return np.exp(-np.abs(pd / width) ** power)


def _speed(d, pace):
    return pace * (200.0 - sum(90.0 * _bump(d, at, 70) for at, _, _ in CORNERS))


def _height(d):
    return CREST_H * _bump(d, CREST_M, 90) - DIP_H * _bump(d, 0, 70)


def _curve(d):
    """h'' (1/m), exactly."""
    out = np.zeros_like(d)
    for h, at, w in ((CREST_H, CREST_M, 90), (-DIP_H, 0, 70)):
        pd = (d - at + N / 2) % N - N / 2
        out += h * _bump(d, at, w) * (4 * pd ** 2 / w ** 4 - 2 / w ** 2)
    return out


def _bank(d):
    return sum(np.radians(b) * _bump(d, at, 60, 4) for at, _, b in CORNERS)


def _lap(pace: float, rng: np.random.Generator) -> dict[str, np.ndarray]:
    d = np.arange(N + 1, dtype=float)
    v = _speed(d, pace) / 3.6
    v1 = _speed(d, 1.0) / 3.6
    side = sum(s * _bump(d, at, 50, 4) for at, s, _ in CORNERS)  # signed share of the corner
    c = np.abs(side) * CORNER_G * (v / v1) ** 2  # the turn, g (the same line at every pace)
    s = np.sign(side)
    b = _bank(d)
    slope = np.gradient(_height(d))
    noise = lambda: rng.normal(0, 0.02, len(d))  # noqa: E731
    ax = np.gradient(v * v / 2) / G + slope
    # sideslip grows with the turn and comes back: while it changes the gyro reads less (or more) than the path
    beta = 0.03 * c
    slip = v * np.gradient(beta) * v / G
    az_road = np.cos(b) + c * np.sin(b) + v * v * _curve(d) / G
    return {
        "distance": d, "t": np.concatenate([[0.0], np.cumsum(2 / (v[:-1] + v[1:]))]), "speed": v * 3.6,
        "ax": ax + noise(),
        "ay": s * (1.03 * c * np.cos(b) - np.sin(b)) + noise(),  # 3 % more from body roll
        "turn_g": s * GYRO_SCALE * (c * np.cos(b) - slip) + noise(),
        "az": az_road + 0.1 * ax + noise(),  # the dash's accelerometer tilted: it reads some of the braking
        "altitude": _height(d) + 12.0 + rng.normal(0, 1.5) + rng.normal(0, 0.3, len(d)),
        "throttle": np.where(ax >= 0, 100.0, 0.0), "phase": np.zeros_like(d),
    }


@pytest.fixture(scope="module")
def laps() -> list[dict[str, np.ndarray]]:
    rng = np.random.default_rng(1)
    return [_lap(p, rng) for p in PACES]


def _without(laps, *roles):
    return [{k: v for k, v in tr.items() if k not in roles} for tr in laps]


def _features(shape, kind):
    return [f for f in shape.features if f["kind"] == kind]


def _covers(f, m):
    a, b = f["start_m"], f["end_m"]
    return a <= m <= b if a <= b else (m >= a or m <= b)


def _expected_load(m: int) -> float:
    """The road's load at metre m at the median pace."""
    d = np.array([float(m)])
    v = _speed(d, float(np.median(PACES)))[0] / 3.6
    return float(1 + v * v * _curve(d)[0] / G)


def test_a_banked_corner_a_crest_and_a_compression_are_found(laps):
    shape = track_shape(laps)
    assert shape is not None and shape.step_m == SHAPE_STEP_M
    places = len(range(0, N, SHAPE_STEP_M))
    assert len(shape.elevation_m) == len(shape.bank_deg) == len(shape.load_g) == places
    banked = _features(shape, "banked")
    assert len(banked) == 1 and _covers(banked[0], 700)
    assert banked[0]["value"] == pytest.approx(15.0, abs=2.0)
    # the flat corners read flat, at their apexes the bank is told
    for at in (300, 1100, 1500):
        assert abs(shape.bank_deg[at // SHAPE_STEP_M]) < 2.0
    assert np.isnan(shape.bank_deg[1000 // SHAPE_STEP_M])  # a straight: no corner to bank toward
    # the banked corner's load: what its bank adds to the cornering
    c = CORNER_G * (np.median(PACES)) ** 2
    assert shape.load_g[700 // SHAPE_STEP_M] == pytest.approx(np.cos(np.radians(15)) + c * np.sin(np.radians(15)),
                                                               abs=0.06)
    crest = _features(shape, "crest")
    assert len(crest) == 1 and _covers(crest[0], CREST_M)
    assert crest[0]["value"] == pytest.approx(_expected_load(CREST_M), abs=0.05)
    dip = _features(shape, "compression")
    assert len(dip) == 1 and _covers(dip[0], 0) and dip[0]["start_m"] > dip[0]["end_m"]  # through the timing line
    assert dip[0]["value"] == pytest.approx(_expected_load(0), abs=0.05)
    # elevation from GPS altitude: lowest in the dip, highest on the crest, the right height between them
    assert np.nanmin(shape.elevation_m) == 0
    assert np.nanmax(shape.elevation_m) == pytest.approx(CREST_H + DIP_H, abs=0.4)
    assert abs(int(np.argmax(shape.elevation_m)) * SHAPE_STEP_M - CREST_M) <= 20
    lowest = int(np.argmin(shape.elevation_m)) * SHAPE_STEP_M
    assert min(lowest, N - lowest) <= 20
    out = json.loads(json.dumps(shape.to_dict()))
    assert out["bank_deg"][1000 // SHAPE_STEP_M] is None and out["features"][0]["kind"]


def test_without_a_gyro_the_bank_is_unknown(laps):
    shape = track_shape(_without(laps, "turn_g"))
    assert shape is not None and np.isnan(shape.bank_deg).all() and not _features(shape, "banked")
    # its load is still measured: the banked corner's extra load reads as a compression
    assert any(_covers(f, 700) for f in _features(shape, "compression"))
    assert any(_covers(f, CREST_M) for f in _features(shape, "crest"))


def test_without_a_vertical_accelerometer_the_load_comes_from_the_bank_and_the_elevation(laps):
    shape = track_shape(_without(laps, "az"))
    assert shape is not None
    assert len(_features(shape, "banked")) == 1
    crest = _features(shape, "crest")
    assert len(crest) == 1 and _covers(crest[0], CREST_M)
    assert crest[0]["value"] == pytest.approx(_expected_load(CREST_M), abs=0.1)
    c = CORNER_G * (np.median(PACES)) ** 2
    assert shape.load_g[700 // SHAPE_STEP_M] == pytest.approx(np.cos(np.radians(15)) + c * np.sin(np.radians(15)),
                                                               abs=0.1)


def test_gps_altitude_that_does_not_repeat_is_not_used(laps):
    rng = np.random.default_rng(2)
    wandering = [{**tr, "altitude": tr["altitude"] + np.cumsum(rng.normal(0, 0.3, len(tr["altitude"])))}
                 for tr in laps]
    shape = track_shape(wandering)
    assert shape is not None and np.isnan(shape.elevation_m).all()
    assert all(e is None for e in shape.to_dict()["elevation_m"])
    assert len(_features(shape, "banked")) == 1


def test_nothing_to_tell_it_by(laps):
    assert track_shape([]) is None
    assert track_shape(_without(laps, "turn_g", "az", "altitude")) is None
    assert track_shape([{k: v[:150] for k, v in tr.items()} for tr in laps]) is None


# ---------- from a log, whatever its units ----------

def _channels(factor: float, unit: str) -> dict:
    """The synthetic test log with a vertical accelerometer (a dip at 700 m) and GPS altitude, its accelerometers
    multiplied by factor and labelled unit."""
    channels, _ = simulate()
    hz, _, v = channels["vCar"]
    dist = np.cumsum(v / 3.6 / hz) % TRACK_M
    vert = 1.0 + 0.3 * np.exp(-((dist - 700) / 25) ** 2)
    channels["G Force Vert"] = (hz, unit, vert * factor)
    for name in ("gLat", "gLong"):
        f, _, x = channels[name]
        channels[name] = (f, unit, x * factor)
    channels["GPS Altitude"] = (20, "m", 30 + 2 * np.sin(2 * np.pi * dist[:: hz // 20] / TRACK_M))
    return channels


def _log(factor: float, unit: str):
    data = load_session(read_ld(write_ld(_channels(factor, unit))))
    prep = prepare([RunInput("run", data)])
    return track_shape([x.trace for x in prep.laps])


def test_a_log_in_m_s2_reads_as_one_in_g():
    want = _log(1.0, "G")
    assert want is not None
    assert np.nanmedian(want.load_g) == pytest.approx(1.0, abs=0.02)
    assert want.load_g[700 // SHAPE_STEP_M] == pytest.approx(1.3, abs=0.06)
    assert np.nanmax(want.elevation_m) == pytest.approx(4.0, abs=0.5)
    for factor, unit in ((G, "G"), (1.0, "m/s/s")):  # m/s² under a g label; g under an m/s² label
        got = _log(factor, unit)
        assert got is not None
        assert np.allclose(got.load_g, want.load_g, atol=0.03)
        assert np.allclose(got.elevation_m, want.elevation_m, atol=0.01)


def test_a_log_read_for_its_shape_needs_only_its_roles():
    """What the shape reads of a lap comes out the same from LOG_ROLES as from every channel of the log, so a log
    read for its shape reads no other (the throttle, brake and steering here)."""
    ld = read_ld(write_ld(_channels(1.0, "G")))
    every, few = load_session(ld), load_session(ld, roles=LOG_ROLES)
    math_channels(every)
    math_channels(few)
    assert {"throttle", "brake", "steer"} <= set(every.sources) - set(few.sources)
    for role in TRACE_ROLES:
        assert np.array_equal(few.channels[role], every.channels[role]), role
