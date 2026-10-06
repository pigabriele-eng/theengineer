"""Line crossings closer together than a real lap can be are one pass of the line, whatever times the laps; and a
track's sectors are its sections. Synthetic logs only."""
import numpy as np

from app.analysis import emptyrun
from app.analysis.laps import TimingLine, lap_starts, load_session, make_sections, split_laps
from app.importers.motec import read_ld
from tests.synthetic import ORIGIN, simulate, write_ld
from tests.test_empty_runs import pit_channels


def pulses(n: int, *at_s: float) -> np.ndarray:
    """A 10 Hz S/F marker high for 0.3 s from each of these times."""
    marker = np.zeros(n)
    for t in at_s:
        marker[round(t * 10):round(t * 10) + 3] = 1.0
    return marker


def test_a_double_pulse_in_a_pit_log_is_no_lap():
    """Like the Zandvoort race 2 pit log: rolling down the pit lane past the line, the dash's marker pulses twice,
    3 s apart. That was a 3 s "lap", clean (it was its own session's best) and the best of the whole event."""
    channels = pit_channels(60.0, 12.0)
    n = len(channels["S/F Marker"][2])
    for gap in (3.0, 25.0):  # 25 s apart: longer than any double pulse, but the car drove a few metres between
        ld = read_ld(write_ld({**channels, "S/F Marker": (10, "", pulses(n, 30.0, 30.0 + gap))}))
        assert len(lap_starts(ld)[0]) == 0 and split_laps(ld) == ([], "")
        data = load_session(ld)
        assert data.laps == [] and data.lap_source == ""
        verdict = emptyrun.judge(ld, data, None, None, None)
        assert not verdict.keep and verdict.reason == "no laps: 60 s in the pit lane"  # an empty run: not kept


def test_a_double_pulse_at_the_line_leaves_the_lap_whole():
    channels, lap_times = simulate()
    crossings = np.cumsum(lap_times)[:-1]  # the end of the out-lap and of each lap
    n = len(channels["S/F Marker"][2])
    twice = pulses(n, *crossings, crossings[2] + 3.0)  # the dash's marker pulses again 3 s after one crossing
    ld = read_ld(write_ld({**channels, "S/F Marker": (10, "", twice)}))
    laps, source = split_laps(ld)
    assert source == "marker" and len(laps) == 4
    np.testing.assert_allclose([l.time for l in laps], lap_times[1:5], atol=0.11)
    assert [l.clean for l in laps] == [False, True, True, True]

    # every source: .ldx beacons and the dash's lap counter too
    unmarked = read_ld(write_ld({k: v for k, v in channels.items() if k not in ("S/F Marker", "Lap Time")}))
    laps, source = split_laps(unmarked, beacons=sorted([*crossings, crossings[1] + 2.0]))
    assert source == "beacons" and len(laps) == 4
    np.testing.assert_allclose([l.time for l in laps], lap_times[1:5], atol=0.02)
    t1 = np.arange(n // 10, dtype=float)
    counter = np.searchsorted(crossings, t1, side="right").astype(float)
    counter[round(crossings[3]) + 2] += 1  # a lap counted twice a moment apart: one step up and one back
    counted = read_ld(write_ld({**{k: v for k, v in channels.items() if k not in ("S/F Marker", "Lap Time")},
                                "Lap Number": (1, "", counter)}))
    laps, source = split_laps(counted)
    assert source == "counter" and len(laps) == 4
    np.testing.assert_allclose([l.time for l in laps], lap_times[1:5], atol=1.01)


def test_a_car_standing_at_the_line_does_no_lap_by_gps():
    """GPS positions wander across the line while the car stands next to it: a crossing every 30 s, no lap."""
    seconds = 125.0
    t20 = np.arange(0, seconds, 0.05)
    east = 3.0 * np.sin(2 * np.pi * t20 / 30.0)  # metres, across a line heading east
    lon = ORIGIN[1] + np.degrees(east / (6_371_000.0 * np.cos(np.radians(ORIGIN[0]))))
    ld = read_ld(write_ld({"GPS Latitude": (20, "deg", np.full_like(t20, ORIGIN[0])),
                           "GPS Longitude": (20, "deg", lon),
                           "vCar": (100, "km/h", np.zeros(int(seconds * 100)))}))
    line = TimingLine(ORIGIN[0], ORIGIN[1], 90.0, "marker")
    from app.analysis.laps import gps_crossings

    assert len(gps_crossings(ld, line)) == 5  # what the GPS alone sees
    assert split_laps(ld, line=line) == ([], "")


def _trace() -> dict[str, np.ndarray]:
    """A lap with two slow points, at 300 m and 800 m, and a long fast stretch between them."""
    d = np.arange(1100)
    return {"speed": 150 - 100 * np.exp(-((d - 300) / 45.0) ** 2) - 80 * np.exp(-((d - 800) / 45.0) ** 2)}


def test_a_tracks_sectors_are_its_sections():
    """Like Zandvoort: flat kinks after a slow point, the first corner of a two-corner sector (T6-T7 there) among
    them, the sector's second corner the next slow point."""
    ref = _trace()
    corners = [("T1", 300, None), ("T2", 460, None), ("T3", 495, "T3-T4"), ("T4", 800, "T3-T4"),
               ("T5", 1000, None)]
    plain, _ = make_sections(ref, [c[:2] for c in corners])
    assert [s.code for s in plain] == ["T1", "T2", "T3", "T4", "T5"]  # each flat kink a section of its own
    secs, numbering = make_sections(ref, corners)
    assert numbering == "official" and [s.code for s in secs] == ["T1", "T2", "T3-T4", "T5"]
    sector = secs[2]
    assert (sector.start, sector.end, sector.apex) == (plain[2].start, plain[3].end, 800)
    assert sector.start == (460 + 495) // 2 and sector.corners == ["T3", "T4"]

    # a sector's corner close to another corner's slow point is still timed with its sector
    corners = [("T1", 300, None), ("T2", 790, None), ("T3", 830, "T3-T4"), ("T4", 1000, "T3-T4")]
    assert [s.code for s in make_sections(ref, [c[:2] for c in corners])[0]] == ["T1", "T2/T3", "T4"]
    secs, _ = make_sections(ref, corners)
    assert [s.code for s in secs] == ["T1", "T2", "T3-T4"]
    assert secs[1].apex == 800 and secs[1].end == secs[2].start == (790 + 830) // 2 and secs[2].end == 1099
