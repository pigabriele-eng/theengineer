import numpy as np

from app.analysis.advice import _quick


def test_the_top_10_percent_beat_the_laps_around_them_not_the_freshest_tyres():
    """Gabriele: the plain quickest passes "might be caused by tire degradation, fuel level or track condition". A run
    that gets 0.05 s a lap slower as the tyres wear: its first laps are the quickest, but the pass that beats its
    neighbours is the one the driver got right."""
    times = 10.0 + 0.05 * np.arange(30)
    times[20] -= 0.3  # lap 21: 0.3 s better than the laps around it, still slower than the first laps
    runs = ["R1"] * 30
    index = np.arange(30)
    assert list(_quick(times)) == [0, 1, 2]  # by plain time: the first laps on the freshest tyres
    top = _quick(times, runs, index)
    assert top[0] == 20 and len(top) == 3


def test_each_run_is_judged_on_its_own_laps():
    """Two runs on different fuel loads: a pass is only judged against the laps around it in its own run."""
    a = 10.0 + np.zeros(10)
    b = 11.0 + np.zeros(10)  # a whole second slower: heavier fuel
    b[5] -= 0.2
    times = np.concatenate([a, b])
    runs = ["A"] * 10 + ["B"] * 10
    index = np.concatenate([np.arange(10), np.arange(10)])
    assert 15 == _quick(times, runs, index)[0]
