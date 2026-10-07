"""A run's tyres, guessed from its laps until the driver says, and a lap's time without its mistakes."""
from app.analysis.technique import mistakes_total
from app.run_tyres import NEW, USED, RunLaps, guess


def test_qualifying_is_new_a_race_used_and_a_test_run_guessed_from_its_laps():
    runs = [RunLaps(1, "qualifying", "Q1", [149.40, 149.9]),
            RunLaps(2, "race", "R1 stint 1", [151.2, 151.0, 151.4, 151.8]),
            RunLaps(3, "test", "PT2 stint 1", [149.52, 149.8]),  # short and as quick as qualifying
            RunLaps(4, "test", "PT2 stint 2", [150.9, 151.0, 151.1, 151.3, 151.2]),  # a long run
            RunLaps(5, "test", "FP1 stint 1", [150.8]),  # short, but not as quick
            RunLaps(6, "test", "Q2", [149.6])]  # named as qualifying, left as a test
    g = guess(runs)
    assert g[1] == {"tyres": NEW, "sure": True, "why": "qualifying: new tyres, low fuel"}
    assert g[2] == {"tyres": USED, "sure": True, "why": "race: the qualifying set"}
    assert g[3]["tyres"] == NEW and not g[3]["sure"] and "short run" in g[3]["why"]
    assert g[4]["tyres"] == USED and not g[4]["sure"]
    assert g[5]["tyres"] == USED and not g[5]["sure"]
    assert g[6]["tyres"] == NEW and g[6]["sure"]


def _o(code, start, end, cost):
    return {"code": code, "start_m": start, "end_m": end, "cost_s": cost}


def test_overlapping_mistakes_in_a_corner_count_once():
    lift_and_stall = [_o("T10", 100, 160, 0.12), _o("T10", 140, 200, 0.08)]
    assert mistakes_total(lift_and_stall) == 0.12  # the stall is the lift's loss
    apart = [_o("T10", 100, 160, 0.12), _o("T10", 300, 340, 0.05), _o("T11", 150, 170, 0.03)]
    assert mistakes_total(apart) == 0.2
    assert mistakes_total([]) == 0.0
