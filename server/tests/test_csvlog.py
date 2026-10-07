"""CSV exports from MoTeC i2, AiM Race Studio and Pi Toolbox, built in their documented layouts from the
synthetic run, read back and run through the engine."""
import numpy as np
import pytest

from app.analysis.insights import RunInput, analyze_runs
from app.analysis.laps import load_session
from app.importers.csvlog import CsvLog, ExportFormatError, read_csv_log, read_log
from tests.synthetic import simulate, write_ld

HZ = 50
# synthetic channel -> (MoTeC i2 export name, AiM name, Pi Toolbox name, unit)
NAMES = {
    "vCar": ("Ground Speed", "GPS Speed", "ecu_speed[kph]", "km/h"),
    "rThrottlePedal": ("Throttle Pos", "ECU THROTTLE", "ecu_aps[%]", "%"),
    "Brake Torque": ("Brake Pressure Front", "Front Brake Pres", "log_pbrake_f[bar]", "bar"),
    "aSteer": ("Steered Angle", "Steering Angle", "log_asteer[deg]", "deg"),
    "gLat": ("G Force Lat", "LateralAcc", "log_acc_y[G]", "g"),
    "gLong": ("G Force Long", "InlineAcc", "log_acc_x[G]", "g"),
    "nYaw": ("Gyro Yaw Velocity", "YawRate", "sclu_yaw_rate[deg/s]", "deg/s"),
    "GPS Latitude": ("GPS Latitude", "GPS Latitude", "log_gps_lat[deg]", "deg"),
    "GPS Longitude": ("GPS Longitude", "GPS Longitude", "log_gps_lon[deg]", "deg"),
}


@pytest.fixture(scope="module")
def run():
    channels, lap_times = simulate()
    channels["Brake Torque"] = (50, "bar", -channels["Brake Torque"][2] / 50)  # pressure, not torque
    duration = len(channels["vCar"][2]) / 100
    t = np.arange(0, duration, 1 / HZ)
    grid = {k: np.interp(t, np.arange(len(v)) / f, v) for k, (f, _, v) in channels.items() if k in NAMES}
    crossings = np.cumsum(lap_times)[:-1]  # after the out-lap and after each timed lap
    return channels, lap_times, t, grid, crossings


def _cells(values, decimal=".") -> list[str]:
    return [f"{v:.6f}".replace(".", decimal) for v in values]


def motec_csv(run) -> str:
    """MoTeC i2 "Export Data": quoted cells, a second column of header keys, beacons in one cell."""
    _, _, t, grid, crossings = run
    lines = [
        '"Format","MoTeC CSV File",,,"Workbook",""', '"Venue","Test Track",,,"Worksheet",""',
        '"Vehicle","BMW M4 GT4",,,"Vehicle Desc",""', '"Driver","Test Driver",,,"Engine ID",""', '"Device","ADL"',
        '"Comment","",,,"Session","FP1"', '"Log Date","05/05/2025",,,"Origin Time","0.000","s"',
        '"Log Time","10:00:00",,,"Start Time","0.000","s"',
        f'"Sample Rate","{HZ}.000","Hz",,"End Time","{t[-1]:.3f}","s"',
        f'"Duration","{t[-1]:.3f}","s",,"Start Distance","0","m"', '"Range","entire outing",,,"End Distance","0","m"',
        '"Beacon Markers","' + " ".join(f"{c:.3f}" for c in crossings) + ' "', "", "",
        ",".join(f'"{n}"' for n in ["Time", *(NAMES[k][0] for k in grid)]),
        ",".join(f'"{u}"' for u in ["s", *(NAMES[k][3] for k in grid)]), "", "",
    ]
    cols = [_cells(t), *(_cells(v) for v in grid.values())]
    lines += [",".join(f'"{c}"' for c in row) for row in zip(*cols, strict=True)]
    return "\r\n".join(lines) + "\r\n"


def aim_csv(run, delim=",", decimal=".") -> str:
    """AiM Race Studio 3: unquoted, beacons one per cell ending with the end of the export."""
    _, lap_times, t, grid, crossings = run
    duration = f"{t[-1] + 1 / HZ:.3f}"
    head = [["Format", "AiM CSV File"], ["Session", "Test Session"], ["Vehicle", "BMW M4 GT4"],
            ["Racer", "Test Driver"], ["Championship", "GT4"], ["Comment", ""], ["Date", '"Monday, May 5, 2025"'],
            ["Time", "10:00 AM"], ["Sample Rate", str(HZ)], ["Duration", duration], ["Segment", "Session"],
            ["Beacon Markers", *(f"{c:.3f}" for c in crossings), duration],
            ["Segment Times", *(f"0:{x:06.3f}" for x in lap_times)], []]
    lines = [delim.join(r) for r in head]
    lines += [delim.join(["Time", *(NAMES[k][1] for k in grid)]), delim.join(["s", *(NAMES[k][3] for k in grid)]), ""]
    cols = [_cells(t, decimal), *(_cells(v, decimal) for v in grid.values())]
    lines += [delim.join(row) for row in zip(*cols, strict=True)]
    return "\n".join(lines) + "\n"


def pi_ascii(run, wide=False, decimal=".") -> str:
    """Pi Toolbox ASCII export: one block per channel at its own rate, or every channel in one block."""
    channels, _, t, grid, crossings = run
    lines = ["PiToolboxVersionedASCIIDataSet", "Version\t2", "", "{OutingInformation}", "CarName\tBMW M4 GT4",
             "TrackName\tTest Track", "DriverName\tTest Driver", "FirstLapNumber\t0", ""]
    if wide:
        lines += ["{ChannelBlock}", "\t".join(["Time", *(NAMES[k][2] for k in grid)])]
        for i, row in enumerate(zip(*[_cells(t, decimal), *(_cells(v, decimal) for v in grid.values())], strict=True)):
            # GPS only every fifth row: the other rows leave those cells empty
            lines.append("\t".join(c if i % 5 == 0 or not k.startswith("GPS") else ""
                                   for k, c in zip(["Time", *grid], row, strict=True)))
        lines.append("")
    else:
        for k in grid:
            f, _, v = channels[k]
            lines += ["{ChannelBlock}", f"Time\t{NAMES[k][2]}"]
            lines += [f"{i / f:.3f}\t{x:.6f}" for i, x in enumerate(v)] + [""]
    lines += ["{ChannelBlock}", "Time\ttpms_press_fl[psi]", *(f"{s}\t26.0" for s in range(int(t[-1]))), ""]
    lines += ["{EventBlock}", "Time\tName\tCategory\tSource\tMessage"]
    lines += [f"{c:.3f}\tEnd of lap\tToolbox Added\tDRV\tEnd of lap" for c in crossings]
    return "\r\n".join(lines) + "\r\n"


def distance_table(run, step=2.0) -> str:
    """A table exported by distance, the lap distance starting again from zero at every line crossing."""
    channels, _, _, _, crossings = run
    v = channels["vCar"][2]
    t100 = np.arange(len(v)) / 100
    d = np.r_[0.0, np.cumsum(v[1:] / 3.6 / 100)]
    dg = np.arange(0, d[-1], step)
    tg = np.interp(dg, d, t100)
    at_line = np.interp(crossings, t100, d)
    lap_d = dg - np.r_[0.0, at_line][np.searchsorted(at_line, dg, side="right")]
    cols = {"Lap Distance [m]": lap_d}
    for k in ("vCar", "rThrottlePedal", "gLat", "gLong", "nYaw"):
        f, _, x = channels[k]
        cols[f"{NAMES[k][2].split('[')[0]} [{NAMES[k][3]}]"] = np.interp(tg, np.arange(len(x)) / f, x)
    lines = [",".join(cols)] + [",".join(_cells(row)) for row in zip(*cols.values(), strict=True)]
    return "\n".join(lines) + "\n"


def _check_laps(log: CsvLog, lap_times, tol=0.05):
    data = load_session(log, beacons=log.beacons or None)
    timed = lap_times[1:-1]
    assert [l.number for l in data.laps] == list(range(1, len(timed) + 1))
    np.testing.assert_allclose([l.time for l in data.laps], timed, atol=tol)
    assert [l.clean for l in data.laps] == [False, True, True, True]
    return data


def test_motec_i2_export(run):
    log = read_csv_log(motec_csv(run).encode())
    assert (log.logger, log.layout) == ("motec", "MoTeC i2 CSV export")
    assert (log.venue, log.driver, log.vehicle, log.event_session) == ("Test Track", "Test Driver", "BMW M4 GT4", "FP1")
    assert log.channel("Ground Speed").freq == HZ and log.channel("G Force Lat").unit == "g"
    assert len(log.beacons) == 5
    data = _check_laps(log, run[1])
    assert data.lap_source == "beacons"
    assert data.sources["speed"] == "Ground Speed" and data.sources["yaw"] == "Gyro Yaw Velocity"
    res = analyze_runs([RunInput("csv", data, ld=log)])  # the whole engine, on a CSV export
    assert [s["code"] for s in res["sections"]] == ["C1", "C2"]
    assert "balance" in res["setup"]


@pytest.mark.parametrize("delim,decimal", [(",", "."), (";", ",")])
def test_aim_race_studio_export(run, delim, decimal):
    log = read_csv_log(aim_csv(run, delim, decimal).encode())
    assert (log.logger, log.layout) == ("aim", "AiM Race Studio CSV export")
    assert (log.driver, log.event_name, log.event_session) == ("Test Driver", "GT4", "Test Session")
    assert len(log.beacons) == 5  # the end-of-export marker is not a line crossing
    data = _check_laps(log, run[1])
    assert {data.sources[r] for r in ("speed", "throttle", "brake", "g_lat", "g_long", "yaw")} == {
        "GPS Speed", "ECU THROTTLE", "Front Brake Pres", "LateralAcc", "InlineAcc", "YawRate"}


@pytest.mark.parametrize("wide,decimal", [(False, "."), (True, ",")])
def test_pi_toolbox_ascii_export(run, wide, decimal):
    log = read_csv_log(pi_ascii(run, wide, decimal).encode("cp1252"))
    assert log.logger == "cosworth" and log.layout.startswith("Pi Toolbox ASCII export")
    assert (log.venue, log.vehicle, log.driver) == ("Test Track", "BMW M4 GT4", "Test Driver")
    speed = log.channel("ecu_speed")
    assert speed.unit == "km/h" and speed.freq == (HZ if wide else 100)
    assert log.channel("log_gps_lat").freq == (HZ // 5 if wide else 20)  # empty cells are not samples
    assert log.channel("tpms_press_fl").unit == "bar"
    assert log.channel("tpms_press_fl").values()[0] == pytest.approx(26.0 * 0.0689476)
    data = _check_laps(log, run[1])
    assert data.sources["g_lat"] == "log_acc_y" and data.sources["tyre_p_fl"] == "tpms_press_fl"


def test_export_by_distance_gets_its_time_from_speed(run):
    log = read_csv_log(distance_table(run).encode())
    assert log.logger == "cosworth" and log.layout.endswith("(by distance)")
    assert len(log.beacons) == 5  # where the lap distance starts again
    _check_laps(log, run[1], tol=0.1)


def test_not_an_export():
    with pytest.raises(ExportFormatError):
        read_csv_log(b"just,one,row\n")
    with pytest.raises(ExportFormatError):
        read_csv_log(write_ld(simulate()[0]))  # a native log renamed .csv


@pytest.mark.parametrize("quoted", [False, True])
def test_long_export_is_read_in_little_memory(tmp_path, quoted):
    """The server has 512 MB: a long export is read straight into numbers, never held as cells of text (which take
    over ten times the file's size)."""
    import tracemalloc

    q = '"' if quoted else ""
    rows = np.round(np.random.default_rng(0).normal(100, 30, (20_000, 30)), 3)
    rows[:, 0] = np.arange(len(rows)) / HZ
    head = ['"Format","MoTeC CSV File"', '"Venue","Test Track"', ""] if quoted else []
    lines = [*head, ",".join(["Time", "Ground Speed", *(f"Chan {k}" for k in range(28))]), "s,km/h" + "," * 28,
             *(",".join(f"{q}{x:.3f}{q}" for x in r) for r in rows)]
    path = tmp_path / "long.csv"
    path.write_text("\r\n".join(lines) + "\r\n")
    del lines
    tracemalloc.start()
    try:
        log = read_csv_log(path)
        peak = tracemalloc.get_traced_memory()[1]
    finally:
        tracemalloc.stop()
    assert np.allclose(log.channel("Chan 27").values(), rows[:, 29])
    assert log.duration == pytest.approx(len(rows) / HZ)
    assert peak < 3 * path.stat().st_size


def test_stored_logs_open_by_type(tmp_path, run):
    (tmp_path / "a.csv").write_text(aim_csv(run))
    (tmp_path / "b.ld").write_bytes(write_ld(simulate()[0]))
    assert isinstance(read_log(tmp_path / "a.csv"), CsvLog)
    assert read_log(tmp_path / "b.ld").channel("vCar") is not None


def test_csv_upload(client, run):
    s = client.post("/sessions", json={"name": "AiM run"}).json()
    r = client.post(f"/sessions/{s['id']}/files", files={"file": ("run.csv", aim_csv(run).encode())})
    assert r.status_code == 201, r.text
    f = r.json()["files"][0]
    assert f["logger"] == "aim" and f["meta"]["format"] == "csv" and f["meta"]["lap_source"] == "beacons"
    assert abs(r.json()["best_lap_s"] - min(run[1][1:-1])) < 0.05
    pi = client.post(f"/sessions/{s['id']}/files", files={"file": ("run.txt", pi_ascii(run).encode())})
    assert pi.status_code == 201 and pi.json()["files"][1]["logger"] == "cosworth"
    assert client.get(f"/sessions/{s['id']}/analysis").status_code == 200  # stored CSVs open again
    temps = client.get(f"/sessions/{s['id']}/tyre-temps")  # the tyre tools read them too: no IR sensors here
    assert temps.status_code == 422 and "no IR tyre temperature channels" in temps.json()["detail"]
