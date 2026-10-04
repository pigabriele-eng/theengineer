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
