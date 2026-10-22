"""Onboard videos on a run's clock (app/videos.py, routers/desktop.py): a GoPro's own GPS speed matched to the log,
a VBOX Video's shared clock, and the start-line frame."""
import struct
import time

import numpy as np

from app import videos
from tests.synthetic import simulate
from tests.test_vbox import write_vbo


def _box(kind: bytes, payload: bytes) -> bytes:
    return struct.pack(">I4s", 8 + len(payload), kind) + payload


def _full(kind: bytes, payload: bytes) -> bytes:
    return _box(kind, b"\x00\x00\x00\x00" + payload)


def _klv(key: str, typ: str, ssize: int, repeat: int, data: bytes) -> bytes:
    pad = (-len(data)) % 4
    return key.encode() + typ.encode() + bytes([ssize]) + struct.pack(">H", repeat) + data + b"\x00" * pad


def gopro_mp4(speeds_ms: np.ndarray, hz: float = 18.0, per_payload: int = 18) -> bytes:
    """A video file holding only a GoPro GPMF track: one payload a second, each with GPS5 rows (lat, lon, alt,
    2D speed, 3D speed) scaled as a GoPro writes them."""
    scal = [10_000_000, 10_000_000, 1000, 1000, 100]
    payloads = []
    for k in range(0, len(speeds_ms), per_payload):
        rows = speeds_ms[k:k + per_payload]
        gps = b"".join(struct.pack(">5i", 493276000, 85659000, 100_000, int(v * 1000), int(v * 100)) for v in rows)
        strm = _klv("STNM", "c", 1, 7, b"GPS (L)") + _klv("SCAL", "l", 4, 5, struct.pack(">5i", *scal)) \
            + _klv("GPS5", "l", 20, len(rows), gps)
        payloads.append(_nest("DEVC", _nest("STRM", strm)))
    scale = 1000
    durs = [round(len(speeds_ms[k:k + per_payload]) / hz * scale) for k in range(0, len(speeds_ms), per_payload)]
    ftyp = _box(b"ftyp", b"mp41\x00\x00\x00\x00mp41")
    mdat_payload = b"".join(payloads)
    mdat_start = len(ftyp) + 8
    offsets, pos = [], mdat_start
    for p in payloads:
        offsets.append(pos)
        pos += len(p)
    total = sum(durs)
    mvhd = _full(b"mvhd", struct.pack(">IIII", 0, 0, scale, total) + b"\x00" * 80)
    mdhd = _full(b"mdhd", struct.pack(">IIII", 0, 0, scale, total) + b"\x00\x00\x00\x00")
    hdlr = _full(b"hdlr", b"\x00\x00\x00\x00meta" + b"\x00" * 12 + b"GoPro MET\x00")
    stsd = _full(b"stsd", struct.pack(">I", 1) + _box(b"gpmd", b"\x00" * 8))
    stts = _full(b"stts", struct.pack(">I", len(durs)) + b"".join(struct.pack(">II", 1, d) for d in durs))
    stsz = _full(b"stsz", struct.pack(">II", 0, len(payloads)) + b"".join(struct.pack(">I", len(p)) for p in payloads))
    stco = _full(b"stco", struct.pack(">I", len(offsets)) + b"".join(struct.pack(">I", o) for o in offsets))
    stsc = _full(b"stsc", struct.pack(">I", 1) + struct.pack(">III", 1, 1, 1))
    stbl = _box(b"stbl", stsd + stts + stsz + stsc + stco)
    trak = _box(b"trak", _box(b"mdia", mdhd + hdlr + _box(b"minf", stbl)))
    udta = _box(b"udta", _box(b"FIRM", b"H23.01.01.10.00"))
    moov = _box(b"moov", mvhd + trak + udta)
    return ftyp + _box(b"mdat", mdat_payload) + moov


def _nest(key: str, inner: bytes) -> bytes:
    return key.encode() + b"\x00" + bytes([1]) + struct.pack(">H", len(inner)) + inner


def _log_speed():
    ch, _ = simulate((0.9, 1.0, 0.97, 0.99, 0.98), hz=100)
    v = ch["vCar"][2]
    return np.arange(len(v)) / 100, v


def test_reads_gopro_gps(tmp_path):
    t, v = _log_speed()
    cam_t = np.arange(0, 120, 1 / 18)
    p = tmp_path / "GX010042.MP4"
    p.write_bytes(gopro_mp4(np.interp(cam_t + 30, t, v) / 3.6))
    mp4 = videos.Mp4(p)
    assert mp4.camera == "H23.01.01.10.00"
    assert abs(mp4.duration_s - 120) < 0.2
    got = videos.gps_speed(mp4)
    assert got is not None
    vt, vv = got
    assert len(vt) == len(cam_t)
    assert np.allclose(vv, np.interp(cam_t + 30, t, v), atol=0.01)


def test_matches_camera_speed_to_log():
    t, v = _log_speed()
    rng = np.random.default_rng(3)
    cam_t = np.arange(0, 150, 1 / 18)
    start = 41.37  # the log's time at the video's first frame
    cam_v = np.interp(cam_t + start, t, v) + rng.normal(0, 1.5, len(cam_t))
    got = videos.match_speed(cam_t, cam_v, t, v)
    assert got is not None
    assert abs(got[0] - start) < 0.05
    assert got[1] > videos.GOOD_MATCH
    # a camera that started before the logger
    got = videos.match_speed(cam_t, np.interp(cam_t - 8.5, t, v), t, v)
    assert abs(got[0] - -8.5) < 0.05


def test_vbox_video_and_start_line(client, settle, tmp_path):
    folder = tmp_path / "Coaching day"
    folder.mkdir()
    raw, _ = write_vbo()
    (folder / "VBOX0001.vbo").write_bytes(raw)
    (folder / "VBOX0001_0001.mp4").write_bytes(b"not really a video")
    started = client.post("/desktop/import", json={"paths": [str(folder)]}).json()
    assert started["logs"] == 1 and started["videos"] == 1
    for _ in range(200):
        job = client.get(f"/desktop/import/{started['job']}").json()
        if job["status"] in ("done", "failed"):
            break
        time.sleep(0.05)
    assert job["status"] == "done", job
    linked = job["videos"]["linked"]
    assert len(linked) == 1 and job["videos"]["unmatched"] == []
    v = linked[0]
    assert v["method"] == "vbox"
    assert abs(v["start"] - -3.2) < 0.06  # the log's first sample was 3.2 s into the video
    # nothing twice: the same folder again imports nothing
    again = client.post("/desktop/import", json={"paths": [str(folder)]}).json()
    assert again["job"] is None
    run = client.get(f"/desktop/runs/{v['session_id']}/laps").json()
    assert run["videos"][0]["id"] == v["id"]
    lap = run["laps"][1]
    moved = client.put(f"/desktop/videos/{v['id']}/start-line", json={"video_s": 100.0, "lap": lap["number"]}).json()
    assert moved["method"] == "start-line"
    assert abs(moved["start"] - (lap["start"] - 100.0)) < 1e-3
    lib = client.get("/desktop/library").json()
    assert any(r["videos"] == 1 for t in lib["tracks"] for e in t["events"] for r in e["runs"]) or \
        any(r["videos"] == 1 for r in lib["loose"])
    # the file plays from where it is, in parts
    part = client.get(f"/desktop/videos/{v['id']}/file", headers={"Range": "bytes=0-3"})
    assert part.status_code == 206 and part.content == b"not "
    assert client.delete(f"/desktop/videos/{v['id']}").status_code == 204
    settle()
