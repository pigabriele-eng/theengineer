"""VBOX .vbo files: Racelogic's conventions undone, laps from the file's own start/finish line, and the video clock
kept (app/importers/vbox.py)."""
import numpy as np

from app.importers.csvlog import read_csv_log
from tests.synthetic import ORIGIN, simulate

START_UTC = 10 * 3600 + 42 * 60  # 10:42:00


def write_vbo(paces=(0.9, 1.0, 0.97), video=True, start=START_UTC) -> tuple[bytes, list[float]]:
    """A VBOX Video file of the synthetic 1 km circle at 20 Hz: latitude and longitude in minutes, longitude
    positive west, UTC as hhmmss.ss, and the video's file index and milliseconds (the video started 3.2 s before
    the log)."""
    ch, lap_times = simulate(paces, hz=100)
    lat, lon = ch["GPS Latitude"][2], ch["GPS Longitude"][2]
    v = ch["vCar"][2][::5][:len(lat)]
    g_lat = ch["gLat"][2][::5][:len(lat)]
    n = len(lat)
    t = start + np.arange(n) * 0.05

    def hms(s: float) -> str:
        h, rem = divmod(s, 3600)
        m, sec = divmod(rem, 60)
        return f"{int(h):02d}{int(m):02d}{sec:05.2f}"

    half = np.degrees(15 / 6_371_000.0)  # the line reaches 15 m either side of the start point
    line = (f"Start {-ORIGIN[1] * 60:+.5f} {(ORIGIN[0] - half) * 60:+.5f} {-ORIGIN[1] * 60:+.5f} "
            f"{(ORIGIN[0] + half) * 60:+.5f} ¬ Start / Finish")
    head = ["satellites", "time", "latitude", "longitude", "velocity kmh", "lat_acc", *(
        ["avifileindex", "avisynctime"] if video else [])]
    cols = ["sats", "time", "lat", "long", "velocity", "Lat_acc", *(["avifileindex", "avitime"] if video else [])]
    out = ["File created on 03/11/2026 at 10:42:01", "", "[header]", *head, "", "[comments]", "Coaching day test",
           "", "[laptiming]", line, ""]
    if video:
        out += ["[avi]", "VBOX", "mp4", ""]
    out += ["[column names]", " ".join(cols), "", "[data]"]
    for i in range(n):
        row = [f"{12:03d}", hms(t[i]), f"{lat[i] * 60:+.6f}", f"{-lon[i] * 60:+.6f}", f"{v[i]:.3f}", f"{g_lat[i]:+.3f}"]
        if video:
            row += ["0001", f"{(i * 0.05 + 3.2) * 1000:.0f}"]
        out.append(" ".join(row))
    return ("\r\n".join(out) + "\r\n").encode("latin-1"), lap_times


def test_reads_vbox(tmp_path):
    raw, lap_times = write_vbo()
    p = tmp_path / "VBOX0001.vbo"
    p.write_bytes(raw)
    log = read_csv_log(p)
    assert log.logger == "vbox"
    assert log.date == "03/11/2026"
    lat, lon = log.channel("GPS Latitude").values(), log.channel("GPS Longitude").values()
    assert abs(float(np.median(lat)) - ORIGIN[0]) < 0.01  # minutes undone
    assert abs(float(np.median(lon)) - ORIGIN[1]) < 0.01  # west undone: Hockenheim is east of Greenwich
    assert log.channel("GPS Speed").unit == "km/h"
    assert log.channel("Lateral Acc").unit == "g"
    # the out-lap, then one crossing per lap: the laps are timed from the file's own start/finish line
    laps = np.diff(log.beacons)
    assert len(laps) == 3
    assert np.allclose(laps, lap_times[1:4], atol=0.1)
    assert log.video == {"prefix": "VBOX", "ext": "mp4"}
    sync = log.channel("avisynctime").values()  # in seconds, as every time here
    assert abs(sync[0] - 3.2) < 0.01


def test_vbox_without_video(tmp_path):
    raw, _ = write_vbo(video=False)
    p = tmp_path / "plain.vbo"
    p.write_bytes(raw)
    log = read_csv_log(p)
    assert log.video is None
    assert log.channel("avisynctime") is None


def test_vbox_across_midnight(tmp_path):
    raw, lap_times = write_vbo(start=23 * 3600 + 59 * 60 + 30)
    p = tmp_path / "late.vbo"
    p.write_bytes(raw)
    log = read_csv_log(p)
    assert np.allclose(np.diff(log.beacons), lap_times[1:4], atol=0.1)
