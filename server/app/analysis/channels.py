"""Math channels: what the car and driver were doing, derived from whatever the logger recorded.

Everything here works from speed alone at minimum (plus GPS for cornering); accelerometers, a yaw-rate gyro,
steering and wheel speeds make the channels more precise and unlock balance and slip.
"""
from __future__ import annotations

import numpy as np

from app.analysis.laps import MASTER_HZ, SessionData, _local_m

G = 9.81
SMOOTH_S = 0.2  # strips kerb spikes and vibration, keeps the shape of a corner

# Phases of a lap, by what the driver is doing
BRAKE, TRAIL, MID, EXIT, POWER = range(5)
PHASES = ("braking", "trail", "mid", "exit", "power")
TURNING_G = 0.5  # lateral g above which the car is cornering
THROTTLE_ON = 20.0  # % pedal
COAST_THROTTLE = 5.0


def smooth(y: np.ndarray, seconds: float = SMOOTH_S, hz: int = MASTER_HZ) -> np.ndarray:
    n = max(1, round(seconds * hz)) | 1
    if n == 1 or len(y) < n:
        return y.astype(float)
    k = np.ones(n) / n
    return np.convolve(np.pad(y.astype(float), n // 2, mode="edge"), k, "valid")


def _gps_heading_rate(c: dict[str, np.ndarray]) -> np.ndarray | None:
    """Turning rate (rad/s) from the GPS track, for loggers without a gyro or accelerometers."""
    if "lat" not in c or "lon" not in c:
        return None
    x, y = _local_m(c["lat"], c["lon"], float(np.median(c["lat"])), float(np.median(c["lon"])))
    x, y = smooth(x, 0.3), smooth(y, 0.3)
    heading = np.unwrap(np.arctan2(np.gradient(x), np.gradient(y)))
    moving = np.hypot(np.gradient(x), np.gradient(y)) * MASTER_HZ > 3
    rate = np.where(moving, np.gradient(heading) * MASTER_HZ, 0.0)
    return smooth(rate, 0.5)


def _brake_threshold(brake: np.ndarray) -> float:
    """Pressure (or torque) that counts as braking: 4 % of a firm stop, whatever unit the logger uses."""
    return 0.04 * float(np.percentile(brake, 99.5))


def _g_scale(logged: np.ndarray, expected: np.ndarray, where: np.ndarray) -> float | None:
    """What turns an accelerometer channel into g: 1 when it reads as g, 1/G when it reads G times what the car's
    motion says (m/s² under a g label), G when it reads 1/G of it (g under an m/s² label, divided once already);
    None when it can't be told.

    expected is the same acceleration in g from another source (the change in speed, or the turning rate times
    speed), compared where it is clear and only when the two move together. A source a little off (a gyro reading
    10 % low) still reads as g."""
    if np.count_nonzero(where) < 2 * MASTER_HZ:
        return None
    x, y = smooth(logged, 0.3)[where], expected[where]
    with np.errstate(all="ignore"):
        r = np.corrcoef(x, y)[0, 1]
    if not np.isfinite(r) or abs(r) < 0.6:  # not the same motion: nothing to tell the unit by
        return None
    ratio = float(np.median(np.abs(x))) / max(float(np.median(np.abs(y))), 1e-6)
    if 0.5 < ratio < 2:
        return 1.0
    if G / 2 < ratio < 2 * G:
        return 1 / G
    if 1 / (2 * G) < ratio < 2 / G:
        return G
    return None


def _wheel_scale(wheels: np.ndarray, v: np.ndarray, cruising: np.ndarray) -> float | None:
    """Factor turning a wheel-speed channel (rad/s, rpm or km/h) into km/h, from steady cruising."""
    ok = cruising & (wheels > 1)
    if np.count_nonzero(ok) < MASTER_HZ:
        return None
    return float(np.median(v[ok] / wheels[ok]))


def math_channels(data: SessionData) -> dict[str, np.ndarray]:
    """Derived channels on the session's 100 Hz clock. Adds them to data.channels and returns them."""
    c = data.channels
    v = c["speed"]
    vm = np.maximum(v / 3.6, 1.0)
    dv = np.gradient(smooth(v, 0.3)) / 3.6 * MASTER_HZ / G  # longitudinal g from speed
    out: dict[str, np.ndarray] = {}

    # loggers label units loosely, and an accelerometer in m/s² read as g has the car pulling 15 g: each axis is
    # checked against the car's motion (the change in speed; the turning rate times speed) and put in g
    ax = c.get("g_long")
    long_scale = None
    if ax is None:
        ax = dv
    else:
        if np.corrcoef(ax, dv)[0, 1] < 0:  # logged with braking positive
            ax = -ax
        long_scale = _g_scale(ax, dv, (v > 40) & (np.abs(dv) > 0.2))
        ax = ax * (long_scale or 1.0)
    yaw = np.radians(c["yaw"]) if "yaw" in c else None
    if "g_lat" in c:
        rate = yaw if yaw is not None else _gps_heading_rate(c)
        lat_scale = None
        if rate is not None:
            turn_g = rate * vm / G
            lat_scale = _g_scale(c["g_lat"], turn_g, (v > 40) & (np.abs(turn_g) > 0.3))
        if lat_scale is None:  # nothing to tell it by: one accelerometer, both axes in the same unit
            lat_scale = long_scale
        ay = c["g_lat"] * (lat_scale or 1.0)
    elif yaw is not None:
        ay = yaw * vm / G
    else:
        rate = _gps_heading_rate(c)
        ay = rate * vm / G if rate is not None else np.zeros_like(v)
    ax, ay = smooth(ax), smooth(ay)
    out["ax"], out["ay"] = ax, ay
    out["g_combined"] = np.hypot(ax, ay)
    out["g_direction"] = np.degrees(np.arctan2(ax, np.abs(ay)))  # -90 braking, 0 cornering, +90 accelerating

    # path curvature (1/m), positive in the same direction as positive lateral g. Lateral g gives the path
    # itself; yaw rate also carries the car rotating on its tyres (sideslip), so it only stands in for it.
    turn = None
    if yaw is not None:
        turn = -yaw if np.corrcoef(yaw, ay)[0, 1] < 0 else yaw
    curv = ay * G / vm**2 if "g_lat" in c or turn is None else smooth(turn / vm, 0.3)
    out["curvature"] = np.where(v > 20, curv, 0.0)

    throttle = c.get("throttle")
    braking = (c["brake"] > _brake_threshold(c["brake"])) if "brake" in c else (ax < -0.25)
    if throttle is not None:
        braking &= ~((throttle > 50) & (ax > -0.1))  # left-foot pressure under power is not braking
    turning = np.abs(ay) >= TURNING_G
    on_throttle = throttle >= THROTTLE_ON if throttle is not None else ax > 0.05
    phase = np.full(len(v), POWER)
    phase[on_throttle & turning] = EXIT
    phase[~on_throttle] = MID
    phase[braking & turning] = TRAIL
    phase[braking & ~turning] = BRAKE
    out["phase"] = phase.astype(float)
    out["braking"] = braking.astype(float)
    if throttle is not None:
        out["coasting"] = ((throttle < COAST_THROTTLE) & ~braking & (v > 40)).astype(float)
        out["overlap"] = (braking & (throttle > 15)).astype(float)

    # balance: steering used beyond what the path's curvature needs (positive = understeer)
    if "steer" in c and (yaw is not None or "g_lat" in c):
        _balance(c["steer"], out["curvature"], ay, v, out)
    # sideslip rate: the rear stepping out shows as yaw rate beyond what lateral g explains
    if turn is not None and "g_lat" in c:
        out["slide_rate"] = np.degrees(smooth(np.sign(ay) * (turn - ay * G / vm), 0.3))

    cruising = (np.abs(ax) < 0.05) & (np.abs(ay) < 0.1) & (v > 60)
    if all(f"wheel_{w}" in c for w in ("fl", "fr", "rl", "rr")):
        front = (c["wheel_fl"] + c["wheel_fr"]) / 2
        rear = (c["wheel_rl"] + c["wheel_rr"]) / 2
        kf, kr = _wheel_scale(front, v, cruising), _wheel_scale(rear, v, cruising)
        if kf and kr:
            out["rear_slip"] = smooth(np.where(v > 20, (rear * kr) / np.maximum(front * kf, 1) - 1, 0) * 100)
            out["front_lock"] = smooth(np.where(v > 20, front * kf / np.maximum(v, 1) - 1, 0) * 100)
    if "tc" in c:
        out["tc_on"] = (c["tc"] > 0).astype(float)
    if "abs" in c:
        out["abs_on"] = (c["abs"] >= (2 if c["abs"].max() >= 2 else 1)).astype(float)

    c.update(out)
    return out


def _balance(steer: np.ndarray, curv: np.ndarray, ay: np.ndarray, v: np.ndarray, out: dict) -> None:
    """Understeer as steering beyond the geometry of the path, in the steering channel's own units.

    The geometric steering per unit of curvature (wheelbase times steering ratio) is calibrated on gentle
    cornering, so no wheelbase or steering ratio is needed.
    """
    straight = (np.abs(ay) < 0.05) & (v > 60)
    st = steer - (float(np.median(steer[straight])) if np.count_nonzero(straight) > MASTER_HZ else 0.0)
    gentle = (np.abs(ay) > 0.2) & (np.abs(ay) < 0.5) & (v > 40) & (v < 140) & (np.abs(curv) > 1e-3)
    if np.count_nonzero(gentle) < MASTER_HZ:
        return
    k = float(np.median(st[gentle] / curv[gentle]))
    if k < 0:  # steering logged with the opposite sign to the turn
        st, k = -st, -k
    cornering = (np.abs(ay) > 0.3) & (v > 30)
    out["understeer"] = np.where(cornering, smooth(np.sign(curv) * (st - k * curv), 0.3), 0.0)
    out["steer_per_curvature"] = np.full(len(v), k)
