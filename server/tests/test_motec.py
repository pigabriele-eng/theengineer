import numpy as np
import pytest

from app.analysis.laps import analyze, compare_laps, load_session
from app.importers.motec import LdFormatError, read_ld
from tests.synthetic import TRACK_M, simulate, write_ld


@pytest.fixture(scope="module")
def session():
    channels, lap_times = simulate()
    return read_ld(write_ld(channels)), channels, lap_times


def test_reads_header_and_channels(session):
    ld, channels, _ = session
    assert ld.event_name == "TEST EVENT"
    assert ld.device_serial == 12345
    assert ld.driver == "Test Driver"
    assert set(ld.channels) == set(channels)
    speed = ld.channel("vCar")
    assert speed.unit == "km/h" and speed.freq == 100
    np.testing.assert_allclose(speed.values(), channels["vCar"][2], rtol=1e-6)


def test_channel_lookup_falls_back_and_ignores_case(session):
    ld, _, _ = session
    assert ld.channel("Ground Speed", "VCAR").name == "vCar"
    assert ld.channel("Missing") is None


def test_rejects_non_ld_bytes():
    with pytest.raises(LdFormatError):
        read_ld(b"not a log file" * 200)


def test_splits_laps_and_uses_logged_lap_times(session):
    ld, _, lap_times = session
    data = load_session(ld)
    # out-lap, 4 timed laps, in-lap: only the 4 laps between start/finish crossings are complete
    assert [l.number for l in data.laps] == [1, 2, 3, 4]
    np.testing.assert_allclose([l.time for l in data.laps], lap_times[1:5], atol=0.11)
    assert [l.clean for l in data.laps] == [False, True, True, True]
    assert data.channels["brake"].min() >= 0  # negative brake torque is flipped


def test_analysis_finds_both_corners(session):
    ld, _, lap_times = session
    result = analyze(load_session(ld))
    assert result["reference_lap"] == 2  # pace 1.0 is the fastest
    assert abs(result["length_m"] - TRACK_M) < 15
    apexes = [c["apex_m"] for c in result["corners"]]
    assert len(apexes) == 2
    assert abs(apexes[0] - 300) < 20 and abs(apexes[1] - 700) < 20
    t1 = result["corners"][0]["laps"]
    assert t1[2]["min_speed"] > t1[3]["min_speed"]  # faster lap carries more speed
    assert t1[2]["brake_point"] is not None and t1[2]["brake_point"] < 300
    assert result["theoretical_best"] <= min(lap_times[1:5]) + 0.05


def test_compare_laps_delta_ends_at_lap_time_difference():
    channels, _ = simulate()
    data = load_session(read_ld(write_ld(channels)))
    by_number = {l.number: l for l in data.laps}
    c = compare_laps(data, lap_number=3, ref_number=2)
    assert c["reference_lap"] == 2 and len(c["distance"]) == len(c["delta"]) == len(c["compare"]["speed"])
    assert c["delta"][0] == 0
    assert abs(c["delta"][-1] - (by_number[3].time - by_number[2].time)) < 0.1


LDX = b"""<?xml version="1.0"?>
<LDXFile Version="1.6"><Layers><Layer><MarkerBlock><MarkerGroup Name="Beacons" Index="1">
<Marker Version="100" ClassName="BCN" Name="Auto GPS 2" Flags="77" Time="6.62360432425654292e+08"/>
<Marker Version="100" ClassName="BCN" Name="Auto GPS 1" Flags="77" Time="2.58129811370032370e+08"/>
</MarkerGroup></MarkerBlock></Layer></Layers></LDXFile>"""


def test_reads_ldx_beacons_in_seconds():
    from app.importers.motec import read_ldx_beacons

    assert [round(t, 3) for t in read_ldx_beacons(LDX)] == [258.13, 662.36]
    with pytest.raises(LdFormatError):
        read_ldx_beacons(b"not xml")


def test_gps_timing_matches_the_lap_marker():
    from app.analysis.laps import lap_starts, split_laps, timing_line_at

    channels, lap_times = simulate()
    marked = read_ld(write_ld(channels))
    starts, source = lap_starts(marked)
    assert source == "marker"
    line = timing_line_at(marked, list(starts))

    unmarked = read_ld(write_ld({k: v for k, v in channels.items() if k not in ("S/F Marker", "Lap Time")}))
    laps, source = split_laps(unmarked, line=line)
    assert source == "gps"
    flying = [l.time for l in laps][1:5]
    assert np.allclose(flying, lap_times[1:5], atol=0.05)
    assert [l.clean for l in laps][1:5] == [False, True, True, True]


def test_the_dash_marker_and_its_line_win_over_beacons():
    from app.analysis.laps import lap_starts, split_laps, timing_line_at

    channels, lap_times = simulate()
    marked = read_ld(write_ld(channels))
    unmarked = read_ld(write_ld({k: v for k, v in channels.items() if k not in ("S/F Marker", "Lap Time")}))
    crossings = np.cumsum([0, *lap_times])[1:-1]
    beacons = list(crossings + 0.75)  # like i2's "Auto GPS" beacons: past the dash's line
    marker_line = timing_line_at(marked, list(lap_starts(marked)[0]), "marker")
    beacon_line = timing_line_at(unmarked, beacons, "beacons")

    assert lap_starts(marked, beacons)[1] == "marker"
    starts, source = lap_starts(unmarked, beacons, marker_line)  # the line learned from the dash's marker
    assert source == "gps" and np.allclose(starts[1:6], crossings, atol=0.1)  # (the log starts on the line)
    assert lap_starts(unmarked, beacons, beacon_line)[1] == "beacons"
    starts, source = lap_starts(unmarked, beacons)
    assert source == "beacons" and np.allclose(starts, beacons)
    laps, source = split_laps(unmarked, beacons=beacons)
    assert source == "beacons" and len(laps) == 4
