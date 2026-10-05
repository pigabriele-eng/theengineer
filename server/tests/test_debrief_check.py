"""Debrief points against the data: claims read from the words, balance by section and phase, verdicts and what
they mean. Synthetic laps only."""
import numpy as np
import pytest

from app.analysis.channels import EXIT, MID, POWER, TRAIL
from app.analysis.insights import LapRecord, Prepared, Section
from app.debrief.car_balance import CORNER, section_balance
from app.debrief.check import (
    MINUS,
    SUGGEST,
    _tyres,
    _verdict,
    check_point,
    corner_in_text,
    read_claim,
)

SECTION_M = 100
CODES = ["T1", "T2", "T3", "T4", "T5", "T6"]
N_LAPS = 10
MIN_SPEED = 100 + np.arange(N_LAPS)  # lap i carries a little more speed through T1 than lap i - 1


def _lap(i: int, rng: np.random.Generator) -> dict[str, np.ndarray]:
    """One lap over six 100 m sections: 30 m braking into the turn, 30 m mid-corner, 30 m exit, 10 m flat out.

    The car's normal understeer is 1.0 degree per g, and: T3 entry pushes (+0.6) on all laps but one, T5 exit is
    loose (-0.8) on every lap, T4 mid-corner pushes a little (+0.2: within normal, as the report reads it) and T1
    mid-corner pushes more on the laps with more speed at the apex.
    """
    n = SECTION_M * len(CODES) + 1
    phase = np.full(n, float(POWER))
    ay = np.zeros(n)
    us = np.zeros(n)
    for s, code in enumerate(CODES):
        a = s * SECTION_M
        for j, (p, g) in enumerate(((TRAIL, 0.9), (MID, 1.3), (EXIT, 1.0))):
            sl = slice(a + 30 * j, a + 30 * (j + 1))
            phase[sl], ay[sl] = p, g
            extra = {("T3", TRAIL): 0.6 if i != 3 else -0.2, ("T5", EXIT): -0.8, ("T4", MID): 0.2,
                     ("T1", MID): 0.08 * (MIN_SPEED[i] - MIN_SPEED.mean())}.get((code, p), 0.0)
            us[sl] = 1.0 * ay[sl] + extra + rng.normal(0, 0.03, 30)
    return {"phase": phase, "ay": ay, "understeer": us, "speed": np.where(ay > 1.1, 90.0, 150.0)}


@pytest.fixture(scope="module")
def prep() -> Prepared:
    rng = np.random.default_rng(3)
    laps = [LapRecord("run", i + 1, 100.0 + 0.1 * rng.normal(), None, _lap(i, rng), i) for i in range(N_LAPS)]
    sections = [Section(c, s * SECTION_M, (s + 1) * SECTION_M, s * SECTION_M + 45) for s, c in enumerate(CODES)]
    return Prepared(None, SECTION_M * len(CODES) + 1, laps[0], laps, None, None, sections, "official")


@pytest.fixture(scope="module")
def per(prep) -> dict[str, list[dict]]:
    return {s.code: [{"time": 10.0, "min_speed": float(MIN_SPEED[i]) if s.code == "T1" else 100.0}
                     for i in range(N_LAPS)] for s in prep.sections}


def check(prep, per, text, corner=None, phase=None):
    return check_point(text, corner, phase, prep, per, {}, section_balance(prep))


def test_balance_by_section_and_phase(prep):
    bal = section_balance(prep)
    assert bal.unit == "°" and bal.per_g == pytest.approx(1.0, abs=0.05)  # through zero, as the report fits it
    assert np.nanmedian(bal.laps["T3"]["entry"]) == pytest.approx(0.6, abs=0.1)
    assert np.sum(bal.laps["T3"]["entry"] > 0.3) == N_LAPS - 1
    assert np.nanmedian(bal.laps["T5"]["exit"]) == pytest.approx(-0.8, abs=0.1)
    assert abs(np.nanmedian(bal.laps["T2"]["mid"])) < 0.1
    assert np.isfinite(bal.laps["T4"][CORNER]).all()
    # slow cornering (the 90 km/h mid-corner samples) is all mid-corner; the 150 km/h ones are entry and exit
    assert np.isfinite(bal.bands["slow"]["mid"]).all() and np.isnan(bal.bands["slow"]["entry"]).all()


def test_no_balance_without_the_channel(prep):
    bare = Prepared(None, prep.length, prep.reference, [LapRecord(x.run, x.number, x.time, None,
                    {k: v for k, v in x.trace.items() if k != "understeer"}, x.index_in_run) for x in prep.laps],
                    None, None, prep.sections, "official")
    assert section_balance(bare) is None


def test_balance_point_that_matches_is_the_car_when_on_almost_every_lap(prep, per):
    r = check(prep, per, "Big understeer at turn-in", "T3", "entry")
    assert (r["verdict"], r["agreement"], r["cause"]) == ("confirmed", "agrees", "car")
    assert r["laps_with_it"] == N_LAPS - 1 and r["laps"] == N_LAPS
    assert r["line"].startswith("Said understeer at T3 entry; data: balance at T3 entry +0.6° from the car's "
                                "normal (slight understeer), more understeer than normal on 9 of 10 laps")
    assert r["line"].endswith("so it matches.")
    assert r["suggestion"] == SUGGEST[("understeer", "entry")]


def test_balance_reads_as_the_report_does(prep, per):
    # +0.2 is within the car's normal in the report (slight starts at 0.3): partly, never confirmed
    r = check(prep, per, "A bit of understeer mid-corner", "T4", "mid")
    assert r["verdict"] == "partly" and "a touch towards understeer (+0.2°, within the car's normal)" in r["evidence"]
    r = check(prep, per, "Sovrasterzo in uscita dalla T5")
    assert f"{MINUS}0.8° from the car's normal (clear oversteer)" in r["evidence"]


def test_trait_felt_in_another_phase(prep, per):
    r = check(prep, per, "Understeer in the middle of T3", "T3", "mid")
    assert r["verdict"] == "not seen" and r["cause"] == "car"
    assert r["meaning"].startswith("The data shows understeer here on entry instead (+0.6°")
    assert r["suggestion"] == SUGGEST[("understeer", "entry")]


def test_oversteer_where_the_front_pushes_is_technique(prep, per):
    r = check(prep, per, "The rear steps out when I turn in", "T3", "entry")
    assert (r["verdict"], r["agreement"], r["cause"]) == ("contradicted", "disagrees", "technique")
    assert "front pushes" in r["meaning"]
    assert r["suggestion"] == SUGGEST[("understeer", "entry")]  # fix the push, not the rear


def test_understeer_where_the_car_is_average(prep, per):
    r = check(prep, per, "Understeer in the middle of the corner", "T2", "mid")
    assert (r["verdict"], r["agreement"], r["cause"]) == ("not seen", "disagrees", "car")
    assert "whole-car balance" in r["meaning"]


def test_trait_that_comes_with_the_driving(prep, per):
    r = check(prep, per, "Sottosterzo in percorrenza alla T1")
    assert r["phase"] == "mid" and r["section"] == "T1"
    assert r["cause"] == "technique" and "carry more speed to the apex" in r["meaning"]


def test_negated_and_whole_corner_points(prep, per):
    assert check(prep, per, "Sovrasterzo in uscita dalla T5")["verdict"] == "confirmed"
    r = check(prep, per, "No understeer at T2 any more")
    assert (r["verdict"], r["phase"]) == ("confirmed", None)
    assert check(prep, per, "No understeer at T4 any more")["verdict"] == "partly"  # +0.2 mid-corner
    r = check(prep, per, "No understeer at T3 any more")
    assert r["verdict"] == "contradicted"
    r = check(prep, per, "Understeer at T3")  # no phase said: the phase that shows it
    assert r["verdict"] == "confirmed" and "at T3 entry" in r["evidence"]


def test_points_without_a_corner(prep, per):
    r = check(prep, per, "General understeer, the car is pushing everywhere")
    assert (r["verdict"], r["agreement"]) == ("cannot check", "unclear")
    r = check(prep, per, "Understeer in slow corners")
    assert r["speed_band"] == "slow" and r["verdict"] != "cannot check"
    assert check(prep, per, "Understeer at T9", "T9")["verdict"] == "cannot check"
    assert check(prep, per, "Radio was quiet")["claim"] is None


@pytest.mark.parametrize("z,share,negated,verdict", [
    (1.0, 0.9, False, "confirmed"),
    (1.0, 0.55, False, "partly"),
    (0.5, 0.6, False, "partly"),
    (0.1, 0.5, False, "not seen"),
    (2.0, 0.3, False, "not seen"),  # one huge lap does not make a trait
    (-1.0, 0.2, False, "contradicted"),
    (-1.0, 0.2, True, "confirmed"),
    (0.1, 0.4, True, "confirmed"),
    (0.2, 0.8, True, "confirmed"),  # consistently a hair more is still no understeer to speak of
    (0.5, 0.6, True, "partly"),
    (1.0, 0.9, True, "contradicted"),
])
def test_verdicts(z, share, negated, verdict):
    assert _verdict(z, share, negated) == verdict


@pytest.mark.parametrize("text,kind,negated,phase", [
    ("In staccata alla T6 la macchina è instabile in frenata", "braking_stability", False, "braking"),
    ("Le gomme calano dopo cinque giri", "tyre_drop", False, None),
    ("Il retrotreno scappa in uscita", "oversteer", False, "exit"),
    ("Opposite lock on the throttle out of T6", "oversteer", False, "exit"),
    ("No traction out of T6", "traction", False, None),
    ("Poca trazione in uscita", "traction", False, "exit"),
    ("Traction out of T13 is good now", "traction", True, None),
    ("No wheelspin any more", "traction", True, None),
    ("I was pushing on the out-lap", None, False, None),
    ("Needs a lot of steering lock", None, False, None),
    ("The front pushes wide at the apex", "understeer", False, "mid"),
])
def test_claims_in_english_and_italian(text, kind, negated, phase):
    c = read_claim(text)
    assert (c.kind, c.negated, c.phase) == (kind, negated, phase)


@pytest.mark.parametrize("text,code", [
    ("Understeer at turn 13 on entry", "T13"), ("Sovrasterzo in ingresso curva 6", "T6"),
    ("Locking into T 8", "T8"), ("Wheelspin out of t2", "T2"), ("Tyres gone after 5 laps", None),
])
def test_corner_said_in_the_text(text, code):
    assert corner_in_text(text) == code


def _stint(times: list[float]) -> Prepared:
    laps = [LapRecord("run", i + 1, t, None, {}, i) for i, t in enumerate(times)]
    return Prepared(None, 0, laps[0], laps, None, None, [], "official")


def test_tyre_claims_on_lap_times():
    warm = _stint([101.5, 100.8, 100.0, 100.1, 99.9, 100.0, 100.1, 100.0])
    assert _tyres(read_claim("Cold tyres, slow to come in"), warm)["verdict"] == "confirmed"
    steady = _stint([100.0, 100.1, 99.9, 100.0, 100.1, 99.9, 100.0, 100.1])
    assert _tyres(read_claim("Cold tyres, slow to come in"), steady)["verdict"] == "contradicted"
    fading = _stint([100.0 + 0.15 * i for i in range(12)])
    r = _tyres(read_claim("Tyres drop off after five laps"), fading)
    assert r["verdict"] == "confirmed" and "+0.15 s per lap" in r["line"]
    assert _tyres(read_claim("Tyres drop off after five laps"), steady)["verdict"] == "cannot check"  # 6 late laps
    flat = _stint([100.0, 100.1, 99.9, 100.0, 100.1, 99.9, 100.0, 100.1, 99.9, 100.0, 100.1])
    assert _tyres(read_claim("Tyres drop off after five laps"), flat)["verdict"] == "not seen"
