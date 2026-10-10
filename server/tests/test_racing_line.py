import numpy as np
import pytest

from app.analysis import racing_line as rl
from app.analysis.laps import DEFAULT_CHANNEL_MAP, load_session
from app.analysis.trackmap import track_map
from app.importers.motec import read_ld
from tests.synthetic import ORIGIN, TRACK_M, simulate, write_ld

R = TRACK_M / (2 * np.pi)  # the synthetic track: a circle driven anticlockwise from its southern point
EARTH = 6_371_000.0


def _hhmmss(sec: np.ndarray) -> np.ndarray:
    hh, rest = np.divmod(sec, 3600)
    mm, ss = np.divmod(rest, 60)
    return hh * 10000 + mm * 100 + ss


def circle_log(paces=(0.9, 1.0, 0.97, 0.99), shift=(0.0, 0.0), delay=0.1, wide: tuple[int, float] | None = None,
               gps_clock=True) -> bytes:
    """A log like the BMW's: GPS fixes 10 a second, each logged at 20 Hz, the GPS clock as hhmmss.s, reaching the
    logger `delay` s late, the whole picture moved by `shift` (m east, north); and lateral g and yaw rate of the
    circle the car drives. wide: (lap, metres) runs that lap out wider by that much around 450 m into it."""
    ch, _ = simulate(paces=paces)
    hz = ch["vCar"][0]
    v = ch["vCar"][2] / 3.6
    d = np.concatenate([[0.0], np.cumsum(v[:-1]) / hz])  # metres driven
    t = np.arange(len(v)) / hz
    ch["gLat"] = (hz, "G", v ** 2 / R / 9.81)
    ch["nYaw"] = (hz, "deg/s", np.degrees(v / R))
    ch["aSteer"] = (hz, "deg", np.degrees(2.857 / R) + 0.5 * v ** 2 / R / 9.81)  # turning left: + steering
    radius = np.full(len(v), R)
    if wide is not None:
        lap, metres = wide
        k = np.floor(d / TRACK_M) == lap
        radius = radius + metres * k * np.exp(-((d % TRACK_M - 450) / 60) ** 2)
    tf = np.arange(0, t[-1], 0.1)  # when each fix was taken
    df = np.interp(tf, t, d)
    rf = np.interp(tf, t, radius)
    ang = 2 * np.pi * df / TRACK_M
    x, y = rf * np.sin(ang) + shift[0], R - rf * np.cos(ang) + shift[1]
    t20 = np.arange(0, t[-1], 0.05)
    i = np.clip(np.floor((t20 - delay) / 0.1 + 1e-9).astype(int), 0, len(tf) - 1)  # the last fix that has arrived
    lat = ORIGIN[0] + np.degrees(y[i] / EARTH)
    lon = ORIGIN[1] + np.degrees(x[i] / (EARTH * np.cos(np.radians(ORIGIN[0]))))
    ch["GPS Latitude"] = (20, "deg", lat)
    ch["GPS Longitude"] = (20, "deg", lon)
    if gps_clock:
        ch["GPS Time"] = (20, "", _hhmmss(36_000 + tf[i]))
    return write_ld(ch)


def source(log: bytes, sid: int = 1, name: str = "Run") -> rl.Source:
    ld = read_ld(log)
    data = load_session(ld, roles=rl.LOG_ROLES)
    return rl.Source(sid, name, data, rl.gps_fixes(ld, DEFAULT_CHANNEL_MAP["lat"], DEFAULT_CHANNEL_MAP["lon"]))


def built(primary: rl.Source, picks):
    m = track_map(primary.data)
    return rl.build(primary, picks, m["sections"], m["corners"], m["clockwise"])


def test_each_fix_once_on_the_gps_clock_and_its_delay_found():
    src = source(circle_log(delay=0.12))
    fx = src.fixes
    assert fx.timed_by == "gps clock"
    assert np.allclose(np.diff(fx.t), 0.1, atol=1e-6)  # one per fix, 10 a second, not 20 logged
    ref = rl._quickest_clean(src.data)
    lag, scale = rl.find_lag(fx, src.data, ORIGIN[0], ORIGIN[1])
    # fx.t is when the log first shows each fix: the delay plus up to one 20 Hz sample, 0.15 s here
    assert abs(lag - 0.15) <= 0.02 and abs(scale - 1) < 0.01
    # without the GPS clock the fixes are still each kept once, timed when the log first shows them
    plain = source(circle_log(gps_clock=False)).fixes
    assert plain.timed_by == "log" and abs(len(plain.t) - len(fx.t)) < 5
    assert ref is not None


def test_laps_on_one_line_with_the_car_on_it():
    src = source(circle_log())
    out = built(src, [(src, 2), (src, 4)])
    n = out["length_m"] // out["step_m"] + 1
    assert out["reference_lap"] == 2 and [l["number"] for l in out["laps"]] == [2, 4]
    road = out["road"]
    assert len(road["x"]) == len(road["left"]) == n and road["z"] is None  # no altitude logged
    x, y = np.array(road["x"]), np.array(road["y"])
    assert np.abs(np.hypot(x - x.mean(), y - y.mean()) - R).max() < 1.0  # the circle
    for lap in out["laps"]:
        assert len(lap["lateral"]) == len(lap["t"]) == len(lap["load"]["fl"]) == n
        assert np.abs(lap["lateral"]).max() < 0.3  # the same line, the GPS's steps and delay taken out
        assert lap["t"][0] == pytest.approx(0, abs=0.05)
        # heading east at the line (anticlockwise from the southern point), turning left the whole way
        assert abs(lap["yaw_deg"][1] - 90) < 3 and abs(lap["slip_deg"][n // 2]) < 1
        assert np.median(lap["ay"]) > 0 and np.median(lap["steer"]) > 0
        # turning left the right-hand tyres carry more, the left-hand less
        assert np.median(lap["load"]["fr"]) > 100 > np.median(lap["load"]["fl"])
        assert [e["code"] for e in lap["events"]] == [s["code"] for s in out["sections"]]
    # the used road: the laps' spread and the car's half width either side
    assert 1.5 < np.median(np.array(road["left"]) - np.array(road["right"])) < 3.0
    acc = out["accuracy"]
    assert acc["within_session_m"] is not None and acc["within_session_m"] < 0.3
    assert acc["gps_delay_s"] == pytest.approx(0.1, abs=0.03) and "±" in acc["summary"]


def test_a_wider_line_is_kept_and_another_sessions_drift_taken_out():
    a = source(circle_log())
    b = source(circle_log(paces=(0.95, 0.98), shift=(3.0, -1.0), wide=(1, 1.5)), sid=2, name="Run 2")
    out = built(a, [(a, 2), (b, 1)])
    other = out["laps"][1]
    assert other["label"] == "Run 2 lap 1"
    assert other["shift_m"] == pytest.approx([-3.0, 1.0], abs=0.3)  # moved back onto this session's track
    lat = np.array(other["lateral"])
    m = np.arange(len(lat)) * out["step_m"]
    near = np.abs(m - 450) < 30
    assert -1.7 < lat[near].min() < -1.1  # 1.5 m wider: to the right of a left turn
    assert np.abs(lat[np.abs(m - 450) > 250]).max() < 0.4  # and nowhere else
    assert out["accuracy"]["across_sessions_m"] is not None


def test_racing_line_endpoint(client, settle):
    event = client.post("/events", json={"name": "Test day"}).json()
    s1 = client.post("/sessions", json={"event_id": event["id"], "name": "Run 1"}).json()
    s2 = client.post("/sessions", json={"event_id": event["id"], "name": "Run 2"}).json()
    lone = client.post("/sessions", json={"name": "Elsewhere"}).json()
    for s, log in ((s1, circle_log()), (s2, circle_log(paces=(0.95, 0.98), shift=(2.0, 0.0))),
                   (lone, circle_log())):
        assert client.post(f"/sessions/{s['id']}/files", files={"file": ("run.ld", log)}).status_code == 201
    settle()

    r = client.get(f"/sessions/{s1['id']}/racing-line")
    assert r.status_code == 200, r.text
    out = r.json()
    assert out["session_id"] == s1["id"] and out["session_name"] == "Run 1"
    assert [l["number"] for l in out["laps"]] == [2, 4]  # the session's two quickest clean laps
    r = client.get(f"/sessions/{s1['id']}/racing-line", params={"laps": "3", "others": f"{s2['id']}:1"})
    assert r.status_code == 200, r.text
    assert [l["key"] for l in r.json()["laps"]] == [f"{s1['id']}:3", f"{s2['id']}:1"]
    # sent compressed to a browser
    raw = client.get(f"/sessions/{s1['id']}/racing-line", headers={"Accept-Encoding": "gzip"})
    assert raw.status_code == 200
    assert client.get(f"/sessions/{s1['id']}/racing-line", params={"laps": "1,2,3", "others": f"{s2['id']}:1,"
                                                                   f"{s2['id']}:2"}).status_code == 400
    assert client.get(f"/sessions/{s1['id']}/racing-line", params={"others": f"{lone['id']}:2"}).status_code == 400
    assert client.get(f"/sessions/{s1['id']}/racing-line", params={"laps": "42"}).status_code == 404
    no_gps = client.post("/sessions", json={"event_id": event["id"], "name": "No GPS"}).json()
    channels = {k: v for k, v in simulate()[0].items() if not k.startswith("GPS")}
    assert client.post(f"/sessions/{no_gps['id']}/files", files={"file": ("run.ld", write_ld(channels))}
                       ).status_code == 201
    settle()
    assert client.get(f"/sessions/{no_gps['id']}/racing-line").status_code == 422
