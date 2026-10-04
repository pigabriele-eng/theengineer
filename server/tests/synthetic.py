"""Build small but realistic MoTeC .ld files for tests: a 1 km track with two corners."""
import numpy as np

from app.importers.motec import CHANNEL, EVENT, HEADER, LD_MARKER

TRACK_M = 1000.0
CORNERS_M = (300.0, 700.0)
ORIGIN = (49.3276, 8.5659)  # the track is a circle with start/finish at its southern point


def speed_at(d: np.ndarray, pace: float) -> np.ndarray:
    v = 150.0 - 100.0 * np.exp(-((d - CORNERS_M[0]) / 45.0) ** 2) - 80.0 * np.exp(-((d - CORNERS_M[1]) / 45.0) ** 2)
    return v * pace


def simulate(
    paces=(0.9, 1.0, 0.97, 0.99), hz: int = 100
) -> tuple[dict[str, tuple[int, str, np.ndarray]], list[float]]:
    """An out-lap at 0.6 pace, then one lap per pace, then a slow in-lap.

    Returns (name -> (freq, unit, data), lap times).
    """
    laps = [0.6, *paces, 0.6]
    dt = 1.0 / hz
    v_out, lap_idx, lap_times, dist = [], [], [], []
    for i, pace in enumerate(laps):
        d, elapsed = 0.0, 0.0
        while d < TRACK_M:
            v = float(speed_at(np.array([d]), pace)[0])
            v_out.append(v)
            lap_idx.append(i)
            dist.append(d)
            d += v / 3.6 * dt
            elapsed += dt
        lap_times.append(elapsed)
    v = np.array(v_out)
    n = len(v)
    accel = np.gradient(v) * hz
    throttle = np.where(accel >= 0, 100.0, 0.0)
    brake = np.where(accel < -5, -accel * 120.0, 0.0)
    steer = np.clip(150 - v, 0, None) * 2
    lap_idx = np.array(lap_idx)
    crossings = np.flatnonzero(np.diff(lap_idx)) + 1
    # 10 Hz start/finish marker, high for 0.5 s after each crossing
    t10 = np.arange(0, n / hz, 0.1)
    sf = np.zeros_like(t10)
    for c in crossings:
        sf[(t10 >= c / hz) & (t10 < c / hz + 0.5)] = 1.0
    # 1 Hz lap time channel holding the last completed lap time
    t1 = np.arange(0, n / hz, 1.0)
    lt = np.zeros_like(t1)
    # each crossing completes the lap before it; the in-lap after the last crossing never completes
    for c, time in zip(crossings, lap_times, strict=False):
        lt[t1 >= c / hz] = time
    # 20 Hz GPS on a circle, driven anticlockwise from the southern point
    r = TRACK_M / (2 * np.pi)
    ang = 2 * np.pi * np.array(dist)[:: hz // 20] / TRACK_M
    x, y = r * np.sin(ang), r - r * np.cos(ang)
    lat = ORIGIN[0] + np.degrees(y / 6_371_000.0)
    lon = ORIGIN[1] + np.degrees(x / (6_371_000.0 * np.cos(np.radians(ORIGIN[0]))))
    return {
        "GPS Latitude": (20, "deg", lat),
        "GPS Longitude": (20, "deg", lon),
        "vCar": (hz, "km/h", v),
        "rThrottlePedal": (50, "%", throttle[:: hz // 50]),
        "Brake Torque": (50, "Nm", -brake[:: hz // 50]),
        "aSteer": (50, "deg", steer[:: hz // 50]),
        "S/F Marker": (10, "", sf),
        "Lap Time": (1, "s", lt),
    }, lap_times


def write_ld(channels: dict[str, tuple[int, str, np.ndarray]], event: str = "TEST EVENT") -> bytes:
    names = list(channels)
    header_size = HEADER.size
    event_ptr = header_size
    meta_ptr = event_ptr + EVENT.size
    data_ptr = meta_ptr + CHANNEL.size * len(names)
    metas, blobs, offset = [], [], data_ptr
    for i, name in enumerate(names):
        freq, unit, values = channels[name]
        blob = np.asarray(values, dtype=np.float32).tobytes()
        prev = meta_ptr + CHANNEL.size * (i - 1) if i else 0
        nxt = meta_ptr + CHANNEL.size * (i + 1) if i < len(names) - 1 else 0
        metas.append(CHANNEL.pack(prev, nxt, offset, len(values), 0, 0x07, 4, freq, 0, 1, 1, 0,
                                  name.encode(), name[:8].encode(), unit.encode()))
        blobs.append(blob)
        offset += len(blob)
    header = HEADER.pack(LD_MARKER, meta_ptr, data_ptr, event_ptr, 0, 0, 0, 12345, b"C125", 650, 0, len(names),
                         b"03/07/2026", b"12:00:00", b"Test Driver", b"Test Car", b"Test Track", 0, b"")
    ev = EVENT.pack(event.encode(), b"Session 1", b"", 0)
    return header + ev + b"".join(metas) + b"".join(blobs)
