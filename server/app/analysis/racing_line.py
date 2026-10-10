"""The racing line: where on the road each lap ran, how the car sat on it and where the load was, for the 3D lap.

GPS alone is not good enough for a line. On the BMW's dash it is a 10 Hz fix logged at 20 Hz (every fix sits in the
log once or twice, so a fix's log time is up to 0.05 s off), it reaches the logger about 0.1 s after the car was
there (4-6 m at racing speed), and from one session to the next the whole picture can sit a metre or two to one
side. So the line is built from all of it:

- Fixes. Each GPS fix is kept once and timed by the GPS's own clock (GPS Time, hhmmss.s), put on the logger's clock;
  the delay is then found as the shift that makes the speed between fixes match the wheel-speed channel.
- Shape. Between fixes the path comes from wheel speed and the turning rate the lateral accelerometer gives
  (lateral g / speed is how fast the direction of travel turns; the yaw gyro, else GPS alone, where there is no
  accelerometer), whose scale and drift are learned from the GPS course over the lap. GPS then holds the path in
  place: only its slow difference from the integrated path is kept, so the GPS's jitter and its steps vanish.
- One line. Every lap is placed on the reference lap's line (the session's quickest clean lap), metre for metre, as
  a distance along it and a distance left or right of it.
- Lined up on the track. A lap of another session is moved, as a whole, by the shift that best lays it on the
  reference lap; a lap of the same session is too (the GPS drifts a little over a session). A shift of the whole lap
  can't hide a different line: a wider line in one corner is a wider line, and corners turn every way.

How good it is is measured, not assumed: the session's clean laps are compared at each corner's slowest point,
where a driver repeats the line best, and their spread is what the page says the line is good to.

Attitude is estimated: the body slip angle from the difference between how fast the direction of travel turns and
how fast the car turns (the gyro), roll and pitch from the car's g with typical GT4 gradients, and tyre loads from
the car's g with its weight, weight split, centre of gravity height, track and wheelbase (BMW M4 GT4 estimates when
the car has no data), downforce left out.
"""
from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np

from app.analysis.channels import G
from app.analysis.laps import MASTER_HZ, Lap, SessionData, _local_m, lap_length

STEP_M = 2  # one place every 2 m: about 2 300 places at Hockenheim, enough for a car at any speed on a phone
PAD_S = 3.0  # seconds either side of a lap fused with it, so the path is settled at the timing line
LAG_RANGE_S = 0.4  # the GPS delay is looked for within this either side of nothing
LAG_STEP_S = 0.01
MOVING_MS = 15.0  # m/s: the speeds the delay and the turning scale are learned at
COURSE_SMOOTH_S = 1.0  # the GPS course only corrects the integrated turning slower than this
PATH_SMOOTH_S = 2.0  # the GPS position only corrects the integrated path slower than this
SLIP_LEAK_S = 2.0  # the slip angle forgets the gyro's drift over this long
MAX_SLIP_DEG = 15.0
NEAR_GUESS_M = 150  # a lap's place on the line is looked for within this of where its wheel speed puts it
MAX_LATERAL_M = 25  # further from the line than this is the pit lane or a GPS error, not the lap
SHIFT_HUBER_M = 1.0  # the line-up shift is learned from places within about this of the reference lap...
SHIFT_ROUNDS = 4  # ...in a few rounds, places that disagree weighing less each round
HALF_WIDTH_M = 1.0  # the car's half width, added to the used road either side
WIDTH_SMOOTH_M = 10
ALT_SPREAD_M = 2.5  # GPS altitude is used when the laps' profiles agree within this (rms)
ALT_SMOOTH_M = 30
APEX_WINDOW_M = 60  # a lap's slowest point in a corner: within this of the reference lap's
BRAKE_SEARCH_M = 350
BRAKE_GAP_M = 25  # an easing of the brake pedal shorter than this is the same braking
TURN_IN_SEARCH_M = 150  # turn-in is looked for between this before the apex and the steering's peak
EXIT_M = 150  # how far past the apex the track-out is looked for
TURN_IN_SHARE = 0.25  # turned in: steering a quarter of the way to its peak in the corner
MIN_LATERAL_M = 0.4  # a line difference smaller than this is never told
MAX_SHIFT_M = 40  # a braking, turn-in or throttle point this much apart is a different way of driving the corner
MAX_OTHER_LAPS = 15  # another session's clean laps its typical line is taken from
THROTTLE_OFF = 10.0  # %: the throttle counts as closed below this ...
THROTTLE_ON = 20.0  # ... and picked up again above this

# Car body estimates (BMW M4 GT4, /mnt reference car.json): kept together so the page can say they are estimates
MASS_KG = 1635.0
FRONT_WEIGHT = 0.52
COG_HEIGHT_M = 0.46
TRACK_M = 1.645
WHEELBASE_M = 2.857
FRONT_ROLL_SHARE = 0.55  # share of the lateral load transfer the front axle takes
ROLL_DEG_PER_G = 1.4
PITCH_DEG_PER_G = 0.8

# what the racing line reads from a log (and its GPS fixes, read from the file itself)
LOG_ROLES = ("speed", "throttle", "brake", "steer", "gear", "lat", "lon", "g_lat", "g_long", "yaw", "g_vert",
             "altitude")
GPS_TIME_NAMES = ("GPS Time", "GPS UTC Time")
GPS_HEADING_NAMES = ("GPS Heading", "GPS Course", "Heading")


class NoGpsError(ValueError):
    """The log has no GPS position to place the line by."""


@dataclass
class Fixes:
    """GPS fixes, each once, on the logger's clock (seconds), delay taken out."""
    t: np.ndarray
    lat: np.ndarray
    lon: np.ndarray
    heading: np.ndarray | None  # degrees clockwise from north, when the GPS gives its course
    lag_s: float = 0.0  # the delay found and taken out
    timed_by: str = ""  # "gps clock" or "log"


def _hhmmss(g: np.ndarray) -> np.ndarray:
    hh = np.floor(g / 10000)
    mm = np.floor((g - hh * 10000) / 100)
    return hh * 3600 + mm * 60 + (g - hh * 10000 - mm * 100)


def gps_fixes(ld, lat_names: tuple[str, ...], lon_names: tuple[str, ...]) -> Fixes | None:
    """The log's GPS fixes, each once, timed by the GPS clock where it has one (else when the log first shows it)."""
    la_ch, lo_ch = ld.channel(*lat_names), ld.channel(*lon_names)
    if la_ch is None or lo_ch is None:
        return None
    tt, la, lo = la_ch.times(), la_ch.values(), lo_ch.values()
    if len(lo) != len(la):
        lo = np.interp(tt, lo_ch.times(), lo)
    ok = (np.abs(la) > 0.1) & (np.abs(lo) > 0.1)
    time_ch = ld.channel(*GPS_TIME_NAMES)
    hd_ch = ld.channel(*GPS_HEADING_NAMES)
    gt = None
    if time_ch is not None and len(time_ch.values()) == len(la):
        gt = time_ch.values()
        new = np.r_[True, np.diff(gt) != 0]
    else:
        new = np.r_[True, (np.diff(la) != 0) | (np.diff(lo) != 0)]
    keep = new & ok
    if np.count_nonzero(keep) < 20:
        return None
    t = tt[keep]
    timed_by = "log"
    if gt is not None:
        for decode in (_hhmmss, lambda g: g):  # hhmmss.s first (the BMW's dash), else plain seconds
            gs = np.unwrap(decode(gt[keep]), period=86400)
            # the clock is logged as a 32-bit float, a few ms off at that size: put back on the fixes' own beat
            beat = round(float(np.median(np.diff(gs))), 2) if len(gs) > 1 else 0.0
            if beat >= 0.02:
                gs = np.round(gs / beat) * beat
            rest = t - gs
            off = float(np.median(rest))
            if np.percentile(np.abs(rest - off), 95) < 0.15:  # the GPS clock and the log's agree: time by the GPS's
                t, timed_by = gs + off, "gps clock"
                break
    heading = None
    if hd_ch is not None and len(hd_ch.values()) == len(la):
        heading = hd_ch.values()[keep]
    order = np.argsort(t, kind="stable")
    fx = Fixes(t[order], la[keep][order], lo[keep][order], heading[order] if heading is not None else None,
               timed_by=timed_by)
    return fx


def _smooth(v: np.ndarray, n: int) -> np.ndarray:
    """Centred moving average over n samples (odd), the ends held."""
    n = max(1, int(n)) | 1
    if n == 1 or len(v) < 2:
        return v.astype(float)
    return np.convolve(np.pad(v.astype(float), n // 2, mode="edge"), np.ones(n) / n, "valid")


def find_lag(fx: Fixes, data: SessionData, lat0: float, lon0: float) -> tuple[float, float]:
    """The GPS delay (s) and the wheel speed's scale against GPS: the speed between fixes against the wheel speed,
    over the whole log where the car moves."""
    x, y = _local_m(fx.lat, fx.lon, lat0, lon0)
    dt = np.diff(fx.t)
    tm = (fx.t[1:] + fx.t[:-1]) / 2
    vs = np.hypot(np.diff(x), np.diff(y)) / np.maximum(dt, 1e-3)
    v = data.channels["speed"] / 3.6
    vc0 = np.interp(tm, data.t, v)
    ok = (dt > 0.02) & (dt < 0.3) & (vc0 > MOVING_MS)
    if np.count_nonzero(ok) < 50:
        return 0.0, 1.0
    tm, vs = tm[ok], vs[ok]
    best = (np.inf, 0.0)
    for lag in np.arange(-LAG_RANGE_S, LAG_RANGE_S + LAG_STEP_S / 2, LAG_STEP_S):
        vc = np.interp(tm - lag, data.t, v)
        e = float(np.mean(np.minimum((vs - vc) ** 2, 25.0)))  # a GPS glitch counts as 5 m/s off at most
        if e < best[0]:
            best = (e, float(lag))
    lag = best[1]
    scale = float(np.median(vs / np.maximum(np.interp(tm - lag, data.t, v), 1.0)))
    return lag, scale if 0.95 < scale < 1.05 else 1.0


@dataclass
class Fused:
    """A stretch of the log as a fused path, on the 100 Hz clock from sample i0."""
    i0: int
    x: np.ndarray
    y: np.ndarray
    course: np.ndarray  # direction of travel, radians clockwise from north
    slip: np.ndarray  # body slip angle, radians, + = the car points left of where it travels
    gps_rms_m: float  # the fixes' distance from the fused path (rms): the GPS's own scatter


def _turn_sign(rate: np.ndarray, course_rate: np.ndarray) -> float:
    with np.errstate(all="ignore"):
        r = np.corrcoef(rate, course_rate)[0, 1]
    return -1.0 if np.isfinite(r) and r < 0 else 1.0


def fuse(data: SessionData, fx: Fixes, i0: int, i1: int, lat0: float, lon0: float, v_scale: float = 1.0
         ) -> Fused | None:
    """The path from sample i0 to i1: wheel speed and turning between fixes, GPS holding it in place."""
    c = data.channels
    t = data.t[i0:i1]
    m = (fx.t >= t[0] - 1) & (fx.t <= t[-1] + 1)
    if np.count_nonzero(m) < 20:
        return None
    ft = fx.t[m]
    gx, gy = _local_m(fx.lat[m], fx.lon[m], lat0, lon0)
    v = c["speed"][i0:i1] / 3.6 * v_scale
    moving = v > MOVING_MS
    # the GPS course at each fix: the GPS's own where it has one, else from the fixes either side
    gcourse = np.unwrap(np.arctan2(np.gradient(gx), np.gradient(gy)))
    if fx.heading is not None:
        h = np.radians(fx.heading[m])
        h = gcourse + np.angle(np.exp(1j * (h - gcourse)))  # the same turn count as the fixes' course
        gcourse = np.where(np.abs(h - gcourse) < np.radians(20), h, gcourse)
    gc = np.interp(t, ft, gcourse)
    gc_rate = np.gradient(_smooth(gc, 31)) * MASTER_HZ
    vv = np.maximum(v, 5.0)
    # how fast the direction of travel turns: lateral g over speed, else the gyro, else the GPS alone
    rate = None
    if "g_lat" in c:
        rate = c["g_lat"][i0:i1] * G / vv
    elif "yaw" in c:
        rate = np.radians(c["yaw"][i0:i1])
    if rate is not None and np.count_nonzero(moving) > 5 * MASTER_HZ:
        rate = rate * _turn_sign(rate[moving], gc_rate[moving])
        rate = np.where(v > 5.0, rate, gc_rate)
        integ = np.cumsum(rate) / MASTER_HZ
        # its scale and slow drift, from the GPS course
        a = np.c_[integ[moving], np.ones(np.count_nonzero(moving))]
        k = float(np.linalg.lstsq(a, gc[moving], rcond=None)[0][0])
        k = k if 0.7 < k < 1.4 else 1.0
        course = k * integ + _smooth(gc - k * integ, round(COURSE_SMOOTH_S * MASTER_HZ))
    else:
        course = _smooth(gc, 21)
        k = 1.0
    # the path, wheel speed along the course, held in place by GPS
    dx = np.cumsum(v * np.sin(course)) / MASTER_HZ
    dy = np.cumsum(v * np.cos(course)) / MASTER_HZ
    ex = np.interp(t, ft, gx - np.interp(ft, t, dx))
    ey = np.interp(t, ft, gy - np.interp(ft, t, dy))
    w = round(PATH_SMOOTH_S * MASTER_HZ)
    x, y = dx + _smooth(ex, w), dy + _smooth(ey, w)
    inside = (ft >= t[0]) & (ft <= t[-1])
    rx, ry = gx[inside] - np.interp(ft[inside], t, x), gy[inside] - np.interp(ft[inside], t, y)
    gps_rms = float(np.sqrt(np.mean(rx ** 2 + ry ** 2))) if np.any(inside) else float("nan")
    # slip: the direction of travel turning against the body turning (the gyro), its drift forgotten
    slip = np.zeros_like(course)
    if "yaw" in c and "g_lat" in c and np.count_nonzero(moving) > 5 * MASTER_HZ:
        yaw = np.radians(c["yaw"][i0:i1])
        course_rate = np.gradient(course) * MASTER_HZ
        yaw = yaw * _turn_sign(yaw[moving], course_rate[moving])
        yi = np.cumsum(yaw) / MASTER_HZ
        a = np.c_[yi[moving], np.ones(np.count_nonzero(moving))]
        ky = float(np.linalg.lstsq(a, course[moving], rcond=None)[0][0])
        ky = ky if 0.7 < ky < 1.4 else 1.0
        # the body turns clockwise at ky * yaw, the direction of travel at course_rate: the body points further
        # left of where it travels as the travel turns clockwise faster than the body
        d = course_rate - ky * yaw
        leak = np.exp(-1 / (SLIP_LEAK_S * MASTER_HZ))
        s = 0.0
        out = np.empty_like(d)
        for j, dj in enumerate(d / MASTER_HZ):  # a leaky sum: about 10 000 steps a lap
            s = s * leak + dj
            out[j] = s
        out = np.where(moving, out, 0.0)
        slip = np.clip(out - _smooth(out, round(4 * SLIP_LEAK_S * MASTER_HZ)), -np.radians(MAX_SLIP_DEG),
                       np.radians(MAX_SLIP_DEG))
    return Fused(i0, x, y, course, slip, gps_rms)


@dataclass
class Line:
    """The reference lap's fused path, one point per metre from the timing line."""
    x: np.ndarray
    y: np.ndarray
    nx: np.ndarray = field(init=False)  # unit normal to the left of the direction of travel
    ny: np.ndarray = field(init=False)

    def __post_init__(self):
        tx = np.gradient(np.r_[self.x[-3:], self.x, self.x[:3]])[3:-3]
        ty = np.gradient(np.r_[self.y[-3:], self.y, self.y[:3]])[3:-3]
        n = np.hypot(tx, ty)
        n[n == 0] = 1
        self.nx, self.ny = -ty / n, tx / n

    @property
    def length(self) -> int:
        return len(self.x)


def _lap_samples(data: SessionData, lap: Lap) -> tuple[int, int, int, int]:
    """The lap's samples with PAD_S either side: (window start, lap start, lap end, window end)."""
    s0 = round(lap.start * MASTER_HZ)
    s1 = min(round(lap.end * MASTER_HZ), len(data.t) - 1)
    pad = round(PAD_S * MASTER_HZ)
    return max(s0 - pad, 0), s0, s1, min(s1 + pad, len(data.t) - 1)


def reference_line(data: SessionData, fused: Fused, lap: Lap, length: int) -> Line:
    """The reference lap's path at each metre of its wheel-speed distance, stretched to the lap's length: the same
    metres the corner analysis and the track map count."""
    _, s0, s1, _ = _lap_samples(data, lap)
    d = data.distance[s0:s1 + 1] - data.distance[s0]
    d = d / d[-1] * length
    j = np.arange(length)
    idx = np.interp(j, d, np.arange(s0, s1 + 1)) - fused.i0
    k = np.arange(len(fused.x))
    # the lap as driven: where it ends a metre or so beside where it started is the line taken there, not an error
    return Line(np.interp(idx, k, fused.x), np.interp(idx, k, fused.y))


def place_on_line(line: Line, x: np.ndarray, y: np.ndarray, guess: np.ndarray) -> np.ndarray:
    """Each position's distance along the line (metres, continuous past the line's ends), looked for within
    NEAR_GUESS_M of guess: first every COARSE_M along the line, then to the metre."""
    L = line.length
    offs = np.arange(-NEAR_GUESS_M, NEAR_GUESS_M + 1, COARSE_M)
    base = np.round(guess).astype(int)
    j = np.mod(base[:, None] + offs[None, :], L)
    d2 = (x[:, None] - line.x[j]) ** 2 + (y[:, None] - line.y[j]) ** 2
    near = base + offs[d2.argmin(1)]
    return place_near(line, x, y, near)[0]


COARSE_M = 4
NEAR_M = 6  # place_near looks this far either side of where it is told the position is


def place_near(line: Line, x: np.ndarray, y: np.ndarray, near: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Each position's distance along the line, looked for within NEAR_M of near, and its distance to the left (+)
    or right (-) of it."""
    L = line.length
    base = np.round(near).astype(int)
    offs = np.arange(-NEAR_M, NEAR_M + 1)
    j = np.mod(base[:, None] + offs[None, :], L)
    d2 = (x[:, None] - line.x[j]) ** 2 + (y[:, None] - line.y[j]) ** 2
    k = d2.argmin(1)
    jn = base + offs[k]  # the nearest point, continuous past the ends
    best = jn.astype(float)
    a = np.mod(jn, L)
    for step in (-1, 1):
        b = np.mod(a + step, L)
        sx, sy = line.x[b] - line.x[a], line.y[b] - line.y[a]
        u = np.clip(((x - line.x[a]) * sx + (y - line.y[a]) * sy) / np.maximum(sx ** 2 + sy ** 2, 1e-9), 0, 1)
        best = np.where(u > 0, jn + step * u, best)
    sm = np.mod(best, L)
    jj = np.arange(L)
    rx, ry = np.interp(sm, jj, line.x, period=L), np.interp(sm, jj, line.y, period=L)
    nx, ny = np.interp(sm, jj, line.nx, period=L), np.interp(sm, jj, line.ny, period=L)
    return best, (x - rx) * nx + (y - ry) * ny


@dataclass
class LapLine:
    """A lap on the reference line, one place every step metres from the timing line to the timing line."""
    lap: Lap
    s: np.ndarray  # metres along the line
    trace: dict[str, np.ndarray]  # "t", "lateral", the channels, "slip", "course_dev"
    shift: tuple[float, float] = (0.0, 0.0)
    gps_rms_m: float = float("nan")


def lap_line(data: SessionData, fx: Fixes, lap: Lap, line: Line, lat0: float, lon0: float, v_scale: float,
             step: int = STEP_M) -> LapLine | None:
    w0, s0, s1, w1 = _lap_samples(data, lap)
    f = fuse(data, fx, w0, w1 + 1, lat0, lon0, v_scale)
    if f is None:
        return None
    L = line.length
    dw = (data.distance[w0:w1 + 1] - data.distance[s0]) / max(data.distance[s1] - data.distance[s0], 1.0) * L
    sub = slice(None, None, 10)
    s10 = place_on_line(line, f.x[sub], f.y[sub], dw[sub])
    s = np.interp(np.arange(len(f.x)), np.arange(len(f.x))[sub], s10)
    s, lat = place_near(line, f.x, f.y, s)
    s = np.maximum.accumulate(s)
    return _on_grid(data, f, lap, line, s, lat, step, w0)


def _on_grid(data: SessionData, f: Fused, lap: Lap, line: Line, s: np.ndarray, lat: np.ndarray, step: int,
             w0: int, shift: tuple[float, float] = (0.0, 0.0)) -> LapLine | None:
    L = line.length
    good = np.abs(lat) < MAX_LATERAL_M
    if s[0] > 0 or s[-1] < L or np.count_nonzero(good) < len(s) * 0.8:
        return None
    grid = np.arange(0, L + step / 2, step, dtype=float)
    # the samples where s keeps rising, for interpolation
    keep = np.r_[True, np.diff(s) > 1e-6]
    sk = s[keep]
    idx = np.arange(len(s))[keep]
    at = np.interp(grid, sk, idx)  # fractional sample index at each place
    k = np.arange(len(s))

    def on(v: np.ndarray) -> np.ndarray:
        return np.interp(at, k, v)

    tt = data.t[w0:w0 + len(s)]
    t0 = float(np.interp(0.0, sk, tt[keep]))
    tr = {"t": on(tt) - t0, "lateral": on(lat), "slip": on(f.slip), "course": on(f.course)}
    for role in ("speed", "throttle", "brake", "steer", "gear", "g_lat", "g_long", "yaw", "g_vert", "altitude"):
        if role in data.channels:
            v = data.channels[role][w0:w0 + len(s)]
            tr[role] = np.interp(at, k, v) if role != "gear" else v[np.clip(np.round(at).astype(int), 0, len(v) - 1)]
    return LapLine(lap, grid, tr, shift, f.gps_rms_m)


def line_up(ll: LapLine, line: Line, ref_lateral: np.ndarray | None = None) -> LapLine:
    """The lap moved as a whole by the shift that best lays it on the reference lap (robustly: places far off weigh
    less), its distances to the line worked out again after the move."""
    L = line.length
    sm = np.mod(ll.s, L)
    nx = np.interp(sm, np.arange(L), line.nx, period=L)
    ny = np.interp(sm, np.arange(L), line.ny, period=L)
    target = ref_lateral if ref_lateral is not None else np.zeros_like(sm)
    r = ll.trace["lateral"] - target
    shift = np.zeros(2)
    for _ in range(SHIFT_ROUNDS):
        res = r + nx * shift[0] + ny * shift[1]
        w = np.minimum(1.0, SHIFT_HUBER_M / np.maximum(np.abs(res), 1e-6))
        a = np.array([[np.sum(w * nx * nx), np.sum(w * nx * ny)], [np.sum(w * nx * ny), np.sum(w * ny * ny)]])
        b = -np.array([np.sum(w * nx * r), np.sum(w * ny * r)])
        shift = np.linalg.solve(a + np.eye(2) * 1e-6, b)
    tr = dict(ll.trace)
    tr["lateral"] = ll.trace["lateral"] + nx * shift[0] + ny * shift[1]
    return LapLine(ll.lap, ll.s, tr, (float(shift[0]), float(shift[1])), ll.gps_rms_m)


# ---------- what the page shows ----------

def wheel_loads(ax: np.ndarray, ay: np.ndarray, az: np.ndarray | None) -> dict[str, np.ndarray]:
    """Each tyre's load as % of its static load, from the car's g (+ax speeding up, +ay turning left)."""
    w = MASS_KG * G
    static = {"fl": w * FRONT_WEIGHT / 2, "fr": w * FRONT_WEIGHT / 2,
              "rl": w * (1 - FRONT_WEIGHT) / 2, "rr": w * (1 - FRONT_WEIGHT) / 2}
    vert = az if az is not None else np.ones_like(ax)
    long_t = MASS_KG * G * ax * COG_HEIGHT_M / WHEELBASE_M / 2  # per wheel, to the rear when speeding up
    lat_t = MASS_KG * G * ay * COG_HEIGHT_M / TRACK_M  # per axle pair, to the right wheels turning left
    out = {}
    for wh, st in static.items():
        front = wh[0] == "f"
        share = FRONT_ROLL_SHARE if front else 1 - FRONT_ROLL_SHARE
        f = st * vert + (-long_t if front else long_t) + (lat_t * share if wh[1] == "r" else -lat_t * share)
        out[wh] = np.clip(f / st * 100, 0, 400)
    return out


def _brake_scale(data: SessionData) -> float:
    b = data.channels.get("brake")
    return float(np.percentile(b, 99.5)) if b is not None and np.percentile(b, 99.5) > 0 else 1.0


def _steer_sign(data: SessionData) -> float:
    """+1 when the log's steering reads + to the left (turning the way + lateral g does), else -1."""
    c = data.channels
    if "steer" not in c or "g_lat" not in c:
        return 1.0
    moving = c["speed"] > 60
    if np.count_nonzero(moving) < MASTER_HZ:
        return 1.0
    return _turn_sign(c["steer"][moving], c["g_lat"][moving])


def used_width(laterals: list[np.ndarray], step: int) -> tuple[np.ndarray, np.ndarray]:
    """How far left (+) and right (-) of the reference line the laps' cars reached, their half width included."""
    lat = np.array(laterals)
    return (_smooth(lat.max(0), WIDTH_SMOOTH_M // step) + HALF_WIDTH_M,
            _smooth(lat.min(0), WIDTH_SMOOTH_M // step) - HALF_WIDTH_M)


@dataclass
class Place:
    """Where a corner is judged, the same metres for every lap: its apex (where the reference lap came nearest the
    inside of the road the laps used, near its slowest point), its track-out (nearest the outside after it) and
    which way it turns."""
    slowest: int
    apex: int
    exit: int
    turn: float  # +1 left, -1 right


def corner_places(ref: dict[str, np.ndarray], sections: list[dict], left: np.ndarray, right: np.ndarray,
                  step: int) -> dict[str, Place]:
    n = len(ref["speed"])
    out = {}
    for sec in sections:
        if sec.get("apex_m") is None:
            continue
        ai = min(round(sec["apex_m"] / step), n - 1)
        lo, hi = max(ai - int(APEX_WINDOW_M / step), 0), min(ai + int(APEX_WINDOW_M / step), n - 1)
        if hi <= lo:
            continue
        slowest = lo + int(np.argmin(ref["speed"][lo:hi + 1]))
        win = slice(max(slowest - 15, 0), min(slowest + 16, n))
        turn = float(np.sign(np.median(ref["g_lat"][win]))) if "g_lat" in ref else 1.0
        turn = turn or 1.0
        inside = left if turn > 0 else -right  # how far the inside edge is from the reference line
        outside = -right if turn > 0 else left
        a0, a1 = max(slowest - int(APEX_WINDOW_M / step), 0), min(slowest + int(30 / step), n - 1)
        apex = a0 + int(np.argmin(inside[a0:a1 + 1]))
        e1 = min(apex + int(EXIT_M / step), n - 1)
        exit_ = apex + int(np.argmin(outside[apex:e1 + 1])) if e1 > apex else apex
        out[sec["code"]] = Place(slowest, apex, exit_, turn)
    return out


def corner_events(tr: dict[str, np.ndarray], step: int, places: dict[str, Place], brake_on: float) -> list[dict]:
    """Where the lap braked, turned in, was slowest and picked up the throttle in each corner, and where it was on
    the road at the corner's apex and track-out."""
    n = len(tr["speed"])
    m = np.arange(n) * step
    out = []
    steer = _smooth(tr["steer"], 5) if "steer" in tr else None
    for code, pl in places.items():
        lo, hi = max(pl.slowest - int(APEX_WINDOW_M / step), 0), min(pl.slowest + int(APEX_WINDOW_M / step), n - 1)
        ap = lo + int(np.argmin(tr["speed"][lo:hi + 1]))
        turn = pl.turn
        ev = {"code": code, "apex_m": int(m[ap]), "min_speed": round(float(tr["speed"][ap]), 1),
              "apex_lateral": round(float(tr["lateral"][pl.apex]), 2), "brake_m": None, "turn_in_m": None,
              "throttle_m": None, "exit_lateral": round(float(tr["lateral"][pl.exit]), 2),
              "turn": "left" if turn > 0 else "right"}
        # braking: the start of the braking that runs into the corner
        if "brake" in tr:
            b0 = max(ap - int(BRAKE_SEARCH_M / step), 0)
            on = np.flatnonzero(tr["brake"][b0:ap + 1] >= brake_on) + b0
            if len(on) and (ap - on[-1]) * step < 120:
                # back from the last braking before the apex, over any short easing of the pedal
                k = len(on) - 1
                while k > 0 and (on[k] - on[k - 1]) * step <= BRAKE_GAP_M:
                    k -= 1
                ev["brake_m"] = int(m[on[k]])
        # turn-in: steering a quarter of the way to its peak toward the corner, the last time before the apex
        if steer is not None:
            s0 = max(ap - int(TURN_IN_SEARCH_M / step), 0)
            st = steer[s0:min(ap + int(20 / step), n - 1) + 1] * turn
            if len(st) and float(st.max()) > 0.5:
                pk = int(np.argmax(st))
                below = np.flatnonzero(st[:pk + 1] < TURN_IN_SHARE * st[pk])
                if len(below):
                    ev["turn_in_m"] = int(m[s0 + below[-1] + 1])
        # throttle: picked up again after the last closing around the apex
        if "throttle" in tr:
            t0, t1 = max(ap - int(80 / step), 0), min(ap + int(30 / step), n - 1)
            closed = np.flatnonzero(tr["throttle"][t0:t1 + 1] < THROTTLE_OFF)
            if len(closed):
                j = t0 + closed[-1]
                after = np.flatnonzero(tr["throttle"][j:min(j + int(150 / step), n)] > THROTTLE_ON)
                if len(after):
                    ev["throttle_m"] = int(m[j + after[0]])
        out.append(ev)
    return out


def _section_time(tr: dict[str, np.ndarray], step: int, sec: dict) -> float:
    n = len(tr["t"])
    a, b = min(int(sec["start_m"] / step), n - 1), min(int(sec["end_m"] / step), n - 1)
    return float(tr["t"][b] - tr["t"][a])


def differences(first: dict, other: dict, sections: list[dict], step: int, name: str,
                least_m: float = MIN_LATERAL_M) -> list[dict]:
    """What the other lap does differently from the first lap, corner by corner, in plain words."""
    out = []
    ev0 = {e["code"]: e for e in first["events"]}
    for e in other["events"]:
        a = ev0.get(e["code"])
        if a is None:
            continue
        sign = 1 if e["turn"] == "left" else -1  # + lateral toward the inside
        parts = []

        def later(key: str, verb: str, least: float, a: dict = a, e: dict = e, parts: list = parts):
            if a[key] is not None and e[key] is not None and least <= abs(e[key] - a[key]) <= MAX_SHIFT_M:
                d = e[key] - a[key]
                parts.append(f"{verb} {abs(d):.0f} m {'later' if d > 0 else 'earlier'}")

        later("brake_m", "brakes", 3)
        later("turn_in_m", "turns in", 3)
        da = (e["apex_lateral"] - a["apex_lateral"]) * sign
        if abs(da) >= least_m:
            parts.append(f"is {abs(da):.1f} m {'nearer the inside' if da > 0 else 'wider'} at the apex")
        if a["exit_lateral"] is not None and e["exit_lateral"] is not None:
            dx = (a["exit_lateral"] - e["exit_lateral"]) * sign  # + = further out on the exit
            if abs(dx) >= least_m:
                parts.append(f"uses {abs(dx):.1f} m {'more' if dx > 0 else 'less'} of the exit")
        later("throttle_m", "picks up the throttle", 5)
        dv = e["min_speed"] - a["min_speed"]
        if abs(dv) >= 1:
            parts.append(f"carries {abs(dv):.0f} km/h {'more' if dv > 0 else 'less'} at the slowest point")
        sec = next((s for s in sections if s["code"] == e["code"]), None)
        dt = (_section_time(other["_trace"], step, sec) - _section_time(first["_trace"], step, sec)) if sec else None
        if not parts:
            continue
        words = f"{name} " + ", ".join(parts[:-1]) + (" and " if len(parts) > 1 else "") + parts[-1]
        if dt is not None and abs(dt) >= 0.01:
            words += f": {abs(dt):.2f} s {'slower' if dt > 0 else 'quicker'} through {e['code']}"
        out.append({"code": e["code"], "lap": other["key"], "words": words + ".",
                    "time_delta": round(dt, 3) if dt is not None else None})
    return out


def _r(v: np.ndarray, nd: int) -> list:
    return np.round(np.asarray(v, float), nd).tolist()


def lap_dict(ll: LapLine, key: str, label: str, steer_sign: float, brake_scale: float, line: Line) -> dict:
    tr = ll.trace
    n = len(ll.s)
    ax = _smooth(tr.get("g_long", np.zeros(n)), 5)
    ay = _smooth(tr.get("g_lat", np.zeros(n)), 5)
    az = _smooth(tr["g_vert"], 5) if "g_vert" in tr and 0.7 < np.median(tr["g_vert"]) < 1.3 else None
    loads = wheel_loads(ax, ay, az)
    # the body's heading: the line's direction, turned by how the lap crosses it, less the slip
    L = line.length
    sm = np.mod(ll.s, L)
    # the tangent from the left normal: n = (-ty, tx), so t = (ny, -nx); heading clockwise from north = atan2(tx, ty)
    road_dir = np.arctan2(np.interp(sm, np.arange(L), line.ny, period=L),
                          -np.interp(sm, np.arange(L), line.nx, period=L))
    cross = np.arctan(np.gradient(tr["lateral"], ll.s))  # + = drifting left of the line: heading turned left
    travel = road_dir - cross
    body = travel - tr["slip"]  # slip + = pointing left = heading turned anticlockwise
    yaw_deg = np.degrees(body) % 360
    brake = np.clip(tr["brake"] / brake_scale * 100, 0, 100) if "brake" in tr else np.zeros(n)
    return {
        "key": key, "number": ll.lap.number, "time": round(ll.lap.time, 3), "label": label,
        "shift_m": [round(ll.shift[0], 2), round(ll.shift[1], 2)],
        "t": _r(tr["t"], 3), "lateral": _r(tr["lateral"], 2), "speed": _r(tr["speed"], 1),
        "throttle": _r(tr.get("throttle", np.zeros(n)), 0), "brake": _r(brake, 0),
        "steer": _r(tr.get("steer", np.zeros(n)) * steer_sign, 1), "gear": _r(tr.get("gear", np.zeros(n)), 0),
        "yaw_deg": _r(yaw_deg, 1), "slip_deg": _r(np.degrees(tr["slip"]), 1),
        "roll_deg": _r(ay * ROLL_DEG_PER_G, 2), "pitch_deg": _r(-ax * PITCH_DEG_PER_G, 2),
        "ax": _r(ax, 2), "ay": _r(ay, 2), "load": {k: _r(v, 0) for k, v in loads.items()},
    }


def road(line: Line, left: np.ndarray, right: np.ndarray, altitudes: list[np.ndarray], step: int) -> dict:
    """The reference line every step metres, its left normal, the width the laps used and the height."""
    L = line.length
    grid = np.arange(0, L + step / 2, step)
    sm = np.mod(grid, L)
    j = np.arange(L)
    at = {k: np.interp(sm, j, getattr(line, k), period=L) for k in ("x", "y", "nx", "ny")}
    z = None
    if len(altitudes) >= 2:
        alt = np.array([a - np.median(a) for a in altitudes])
        med = np.median(alt, 0)
        spread = float(np.sqrt(np.mean((alt - med) ** 2)))
        if spread < ALT_SPREAD_M:
            zz = _smooth(med, ALT_SMOOTH_M // step)
            zz = zz - (zz[-1] - zz[0]) * grid / L  # the profile closes at the line
            z = zz - zz.min()
    elif len(altitudes) == 1:
        zz = _smooth(altitudes[0], ALT_SMOOTH_M // step)
        z = zz - zz.min()
    return {"x": _r(at["x"], 2), "y": _r(at["y"], 2), "nx": _r(at["nx"], 4), "ny": _r(at["ny"], 4),
            "left": _r(left, 2), "right": _r(right, 2), "z": _r(z, 2) if z is not None else None}


def repeat_spread(lines: list[LapLine]) -> float | None:
    """How closely the laps repeat their line: at each place the spread of their distances from the line (one
    standard deviation), the median over the lap. The GPS's error and the driver's own variation together, so the
    line is at least this good."""
    if len(lines) < 3:
        return None
    return float(np.median(np.array([ll.trace["lateral"] for ll in lines]).std(0)))


def session_gap(mine: list[LapLine], theirs: list[LapLine]) -> float | None:
    """How far one session's typical line sits from another's (rms over the lap, each the median of its laps)."""
    if not mine or not theirs:
        return None
    d = np.median([ll.trace["lateral"] for ll in theirs], 0) - np.median([ll.trace["lateral"] for ll in mine], 0)
    return float(np.sqrt(np.mean(d ** 2)))


def length_of(data: SessionData, lap: Lap) -> int:
    return round(lap_length(data, lap))


@dataclass
class Source:
    """One session's log for the racing line."""
    session_id: int
    name: str
    data: SessionData
    fixes: Fixes
    driver: str | None = None
    lag_s: float = 0.0
    v_scale: float = 1.0
    brake_on: float = 1.0
    steer_sign: float = 1.0


def _quickest_clean(data: SessionData) -> Lap | None:
    clean = [l for l in data.laps if l.clean]
    return min(clean, key=lambda l: l.time) if clean else None


def default_laps(data: SessionData, count: int = 2) -> list[int]:
    """The session's quickest clean laps: the laps a line is compared between unless others are picked."""
    return [l.number for l in sorted((l for l in data.laps if l.clean), key=lambda l: l.time)[:count]]


def prepare(src: Source, lat0: float, lon0: float) -> None:
    lag, scale = find_lag(src.fixes, src.data, lat0, lon0)
    src.fixes.t = src.fixes.t - lag
    src.fixes.lag_s, src.lag_s, src.v_scale = lag, lag, scale
    src.brake_on = 0.04 * _brake_scale(src.data)
    src.steer_sign = _steer_sign(src.data)


def _accuracy_words(within: float | None, across: float | None, shifts: list[float], scatter: float | None) -> str:
    parts = []
    if within is not None:
        parts.append(f"This session's clean laps repeat their line to about ±{within:.1f} m, straights included, "
                     f"so a difference of {max(within, MIN_LATERAL_M):.1f} m or more between two laps is real; less "
                     "may be the GPS.")
    else:
        parts.append("This session has too few clean laps to measure how well the line repeats; treat differences "
                     "under about 0.6 m with care.")
    if scatter is not None:
        parts.append(f"The GPS itself jitters only about ±{scatter:.1f} m, and each lap is moved as a whole to take "
                     "out its slow drift.")
    if shifts:
        gap = f", after which its typical line sits {across:.1f} m (rms) from this session's" if across else ""
        parts.append(f"Laps from other sessions were moved by up to {max(shifts):.1f} m to line them up on this "
                     f"session's track (the GPS shifts from one session to the next){gap}.")
    parts.append("The line is the path of the GPS aerial on the roof, built from GPS (10 fixes a second), wheel "
                 "speed and lateral g; a line to a few centimetres needs an RTK GPS. Slip, roll, pitch and tyre loads "
                 "are estimates from the car's g, without downforce.")
    return " ".join(parts)


def build(primary: Source, picks: list[tuple[Source, int]], sections: list[dict], corners: list[dict],
          clockwise: bool, step: int = STEP_M) -> dict:
    """The racing line page's data: the road, every picked lap on it with its attitude and loads, the corner events
    and what differs, and how accurate it is. picks are (source, lap number); the first is what the others are
    compared against."""
    ref = _quickest_clean(primary.data)
    if ref is None:
        raise ValueError("No clean lap in this session to draw the line from")
    w0, _, _, w1 = _lap_samples(primary.data, ref)
    m = (primary.fixes.t >= ref.start) & (primary.fixes.t <= ref.end)
    if np.count_nonzero(m) < 20:
        raise NoGpsError("The quickest lap has no GPS position, so the line can't be drawn")
    lat0, lon0 = float(np.median(primary.fixes.lat[m])), float(np.median(primary.fixes.lon[m]))
    prepared: set[int] = set()
    for src in [primary, *(s for s, _ in picks)]:
        if id(src) not in prepared:
            prepare(src, lat0, lon0)
            prepared.add(id(src))
    length = length_of(primary.data, ref)
    f = fuse(primary.data, primary.fixes, w0, w1 + 1, lat0, lon0, primary.v_scale)
    if f is None:
        raise NoGpsError("The quickest lap has no GPS position, so the line can't be drawn")
    line = reference_line(primary.data, f, ref, length)

    cache: dict[tuple[int, int], LapLine | None] = {}

    def placed(src: Source, number: int) -> LapLine | None:
        key = (id(src), number)
        if key not in cache:
            lap = next((l for l in src.data.laps if l.number == number), None)
            ll = lap_line(src.data, src.fixes, lap, line, lat0, lon0, src.v_scale, step) if lap else None
            cache[key] = line_up(ll, line) if ll is not None else None
        return cache[key]

    cleans = [ll for l in primary.data.laps if l.clean and (ll := placed(primary, l.number)) is not None]
    if not cleans:
        raise NoGpsError("No clean lap could be placed on the line")
    ref_ll = placed(primary, ref.number) or cleans[0]
    within = repeat_spread(cleans)
    shown: list[tuple[Source, LapLine]] = []
    for src, number in picks:
        ll = placed(src, number)
        if ll is not None:
            shown.append((src, ll))
    others = [ll for src, ll in shown if src is not primary]
    shifts = [float(np.hypot(*ll.shift)) for ll in others]
    gaps = []
    for src in {id(s): s for s, _ in shown if s is not primary}.values():  # each other session's own clean laps
        theirs = [ll for l in src.data.laps[:MAX_OTHER_LAPS * 3] if l.clean and (ll := placed(src, l.number))]
        if (g := session_gap(cleans, theirs[:MAX_OTHER_LAPS])) is not None:
            gaps.append(g)
    across = max(gaps) if gaps else None
    rms = [ll.gps_rms_m for ll in cleans if np.isfinite(ll.gps_rms_m)]

    left, right = used_width([ll.trace["lateral"] for ll in cleans], step)
    places = corner_places(ref_ll.trace, sections, left, right, step)
    many_sessions = len({id(s) for s, _ in shown}) > 1
    laps = []
    for src, ll in shown:
        label = f"{src.name} lap {ll.lap.number}" if many_sessions else f"Lap {ll.lap.number}"
        d = lap_dict(ll, f"{src.session_id}:{ll.lap.number}", label, src.steer_sign, src.brake_on / 0.04, line)
        d.update({"session_id": src.session_id, "session_name": src.name, "driver": src.driver,
                  "events": corner_events(ll.trace, step, places, src.brake_on)})
        d["_trace"] = ll.trace
        laps.append(d)
    diffs = []
    for d in laps[1:]:
        diffs += differences(laps[0], d, sections, step, d["label"], max(within or 0.0, MIN_LATERAL_M))
    for d in laps:
        d.pop("_trace")
        for e in d["events"]:
            e.pop("turn", None)
    return {
        "reference_lap": ref.number, "length_m": length, "step_m": step, "clockwise": clockwise,
        "road": road(line, left, right,
                     [ll.trace["altitude"] for ll in cleans if "altitude" in ll.trace], step),
        "sections": [{k: s.get(k) for k in ("code", "start_m", "end_m", "apex_m")} for s in sections],
        "corners": [{"code": c["code"], "apex_m": c["apex_m"]} for c in corners],
        "accuracy": {"summary": _accuracy_words(within, across, shifts, float(np.median(rms)) if rms else None),
                     "within_session_m": round(within, 2) if within is not None else None,
                     "across_sessions_m": round(across, 2) if across is not None else None,
                     "gps_scatter_m": round(float(np.median(rms)), 2) if rms else None,
                     "gps_delay_s": round(primary.lag_s, 2), "clean_laps": len(cleans)},
        "laps": laps,
        "differences": diffs,
    }
