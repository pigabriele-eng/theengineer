"""A run's tyres, guessed from its laps until the driver says, and a lap's time without its mistakes."""
from app.analysis.technique import mistakes_total
from app.run_tyres import FRESH, NEW, USED, WORN, RunLaps, guess


def test_qualifying_is_new_a_race_fresh_and_practice_guessed_from_the_laps_in_the_order_they_ran():
    """Gabriele's rules: qualifying always a new set; races always Fresh (the qualifying set), never New; in practice
    a new set shows as a much quicker lap at the start of a run; the runs after it on that set step down as its laps
    add up. Spa's paid test and practice, as they ran."""
    runs = [RunLaps(1, "test", "PT1 stint 1", [151.4, 151.2, 151.6, 151.5, 151.3, 151.6], laps=10),  # age unknown
            RunLaps(2, "test", "PT1 stint 2", [150.2, 150.6, 150.9, 151.0], laps=6),  # a lap 0.7% quicker: new set
            RunLaps(3, "test", "PT1 stint 3", [151.64, 151.7, 151.9], laps=6),  # 6 laps on it
            RunLaps(4, "test", "PT2 stint 1", [151.2, 151.5, 151.3, 151.8, 152.0], laps=7),  # 12: used
            RunLaps(5, "test", "PT2 stint 2", [150.6, 151.0], [5, 6], laps=8),  # quick, but late in the run: 19
            RunLaps(6, "practice", "FP1 stint 1", [151.2, 151.4], laps=4),  # 27: very used
            RunLaps(7, "practice", "FP1 stint 2", [149.56, 150.1], laps=4),  # as quick as qualifying: new set
            RunLaps(8, "practice", "FP1 stint 3", [149.52, 150.0], laps=4),  # as quick, on a set still fresh: same set
            RunLaps(9, "test", "03_Q", [149.40, 149.9]),  # imported from a folder, its order in front
            RunLaps(10, "race", "R1", [151.6, 151.9, 152.3]),
            RunLaps(11, "test", "04_R2", [151.5, 151.6])]
    g = guess(runs)
    assert [g[i]["tyres"] for i in range(1, 12)] == \
        [USED, NEW, FRESH, USED, USED, WORN, NEW, FRESH, NEW, FRESH, FRESH]
    assert not g[1]["sure"] and "isn't known" in g[1]["why"]
    assert not g[2]["sure"] and "clearly quicker" in g[2]["why"] and g[2]["set_laps"] == 0
    assert g[4]["set_laps"] == 12 and g[5]["set_laps"] == 19 and g[6]["set_laps"] == 27
    assert "as quick as qualifying" in g[7]["why"]
    assert g[9] == {"tyres": NEW, "label": "New", "pair": NEW, "sure": True, "why": "qualifying: always a new set",
                    "set_laps": None}
    assert g[10]["sure"] and g[10]["label"] == "Fresh" and g[10]["pair"] == USED and g[11]["tyres"] == FRESH
    assert g[6]["label"] == "Very used" and g[6]["pair"] == USED


def _o(code, start, end, cost):
    return {"code": code, "start_m": start, "end_m": end, "cost_s": cost}


def test_overlapping_mistakes_in_a_corner_count_once():
    lift_and_stall = [_o("T10", 100, 160, 0.12), _o("T10", 140, 200, 0.08)]
    assert mistakes_total(lift_and_stall) == 0.12  # the stall is the lift's loss
    apart = [_o("T10", 100, 160, 0.12), _o("T10", 300, 340, 0.05), _o("T11", 150, 170, 0.03)]
    assert mistakes_total(apart) == 0.2
    assert mistakes_total([]) == 0.0


def test_with_no_qualifying_and_nothing_quicker_every_run_is_guessed_used():
    g = guess([RunLaps(1, "test", "Run 1", [101.0, 101.2]), RunLaps(2, "test", "Run 2", [100.9, 101.3])])
    assert {v["tyres"] for v in g.values()} == {USED} and not any(v["sure"] for v in g.values())


def test_the_warm_up_before_a_new_set_hard_stops_on_the_straights_of_the_out_lap():
    """Gabriele: a new set shows as a much faster lap after a warm-up with a lot of braking in a straight line where
    the car is normally flat out."""
    import numpy as np

    from app.warm_up import stops

    hz = 100
    speed = np.full(60 * hz, 180.0)
    brake = np.zeros(60 * hz)
    steer = np.zeros(60 * hz)
    for at in (5, 15):  # two hard stops on a straight
        brake[at * hz:at * hz + 50] = 80.0
    brake[30 * hz:30 * hz + 150] = 90.0  # a corner's braking: the wheel turns as it lets go
    steer[31 * hz:34 * hz] = 120.0
    assert stops(brake, speed, steer, hard=100.0, wheel=120.0) == 2
    assert stops(brake, np.full(60 * hz, 60.0), steer, hard=100.0, wheel=120.0) == 0  # in the pit lane: too slow

    # Monza's FP2: the second stint's out lap has the warm-up, then a lap quicker than any on the set before
    runs = [RunLaps(1, "practice", "FP1 stint 1", [116.3, 116.5, 116.4], laps=12),
            RunLaps(2, "practice", "FP2 stint 1", [117.7, 117.3, 116.8], laps=6, warm_up=2),  # warm-up, not quick
            RunLaps(3, "practice", "FP2 stint 2", [117.5, 116.2, 116.3, 115.8], laps=8, warm_up=2),
            RunLaps(4, "practice", "FP2 stint 3", [118.0, 116.1], laps=5, warm_up=0),
            RunLaps(5, "qualifying", "Q", [115.2])]
    g = guess(runs)
    assert [g[i]["tyres"] for i in range(1, 6)] == [USED, USED, NEW, FRESH, NEW]
    assert "warm-up" in g[3]["why"] and "2 hard stops" in g[3]["why"]
