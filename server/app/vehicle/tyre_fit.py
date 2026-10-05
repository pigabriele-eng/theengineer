"""Fit a simplified lateral tyre curve per axle from logged sessions.

What it measures is the axle's effective curve: normalised lateral force mu = F_y / F_z of the axle against its
slip angle, with the two tyres, their load transfer, camber and compliance all folded in. That is the curve the
car's balance runs on, not a single tyre on a test rig.

Method (steady-state bicycle model, Milliken & Milliken, Race Car Vehicle Dynamics, ch. 5):
1. Samples: quasi-steady cornering only. Speed at least MIN_SPEED_KMH, lateral g at least MIN_LAT_G,
   longitudinal g within +-MAX_LONG_G (no heavy braking, no full traction), small yaw acceleration and a
   steady lateral g, and inside a corner that starts and ends on a straight (needed for body slip, step 3).
2. Sensor check: the yaw-rate gyro is scaled so that speed x yaw rate equals lateral acceleration on
   quasi-steady samples, which is exact while body slip is not changing. Gyros on CAN often carry a scale
   error (the Hockenheim logs read about 9 % low against both the accelerometer and the GPS course).
3. Body slip beta is not measured, so it is estimated: d(beta)/dt = a_y / V - r is integrated from the straight
   before each corner to the straight after it, where beta is about zero, with a linear correction so it closes
   at zero at both ends (that removes sensor offsets). A corner that misses zero by more than MAX_CLOSE_DEG
   before that correction is dropped: its sensors disagree too much to trust its slip angles. Beta also carries
   the sensors' timing: a 20 ms lag between the accelerometer and the gyro moves it by about 0.5 deg in a fast
   corner. What is left is a scatter of about a degree, reported as slip_scatter_deg.
4. Slip angles: alpha_f = delta - beta - a r / V and alpha_r = -beta + b r / V, with delta the road wheel angle
   (steering wheel angle / steering ratio) and a, b the centre of gravity's distances to the axles.
5. Axle lateral forces from the lateral and yaw balance: F_yf = (m a_y b + I_z dr/dt) / L,
   F_yr = (m a_y a - I_z dr/dt) / L, with I_z = m a b (dynamic index 1, a usual estimate).
6. Axle vertical loads: static share of m g, plus downforce scaled with (V / V_ref)^2 and split by the aero
   balance (when given), plus or minus the longitudinal transfer m a_x h / L.
7. Curve: mu(alpha) = D sin(C atan(B (alpha + S_H))) with B = tan(pi / 2C) / alpha_peak, the Magic Formula with
   E = 0 (Pacejka, Tire and Vehicle Dynamics, ch. 4). D is the peak mu, alpha_peak the slip angle at the peak,
   C the shape (how much grip falls away past the peak) and S_H the Magic Formula's horizontal shift, which here
   takes up a constant offset in the estimated slip angle (body-slip bias, toe and compliance steer: about
   0.5-0.7 deg on the Hockenheim logs). Fitted by least squares through the median slip angle
   in each band of mu (see load_bins): a coarse grid, then Gauss-Newton with Levenberg-Marquardt damping. C is
   held at 1.3 unless the data reach within 5 % of the peak; the axle that saturates first is usually the only
   one that does, since in steady cornering both axles work at about the same mu.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from itertools import pairwise

import numpy as np

from app.analysis.channels import math_channels, smooth
from app.analysis.laps import MASTER_HZ, SessionData
from app.vehicle.model import G, Vehicle

MIN_SPEED_KMH = 60.0
MIN_LAT_G = 0.3
MAX_LONG_G = 0.3
MAX_YAW_ACCEL = 0.25  # rad/s^2
MAX_LAT_JERK = 1.0  # g/s
STRAIGHT_G = 0.1  # a straight: lateral g below this ...
STRAIGHT_S = 0.5  # ... for at least this long
MAX_CORNER_S = 20.0  # longer spans between straights drift too far to trust beta
MAX_CLOSE_DEG = 2.0  # a corner whose integrated beta misses zero on the next straight by more is dropped
BIN_MU = 0.05  # width of the load bins the curve is fitted through
MIN_BIN = 30
MIN_SAMPLES = 500
MIN_CORNERS = 5
DEFAULT_SHAPE = 1.3  # a usual lateral shape factor, used when the data never reach the peak
# D, alpha_peak, C, slip offset S_H
BOUNDS = np.array([[0.3, np.radians(1.0), 1.05, np.radians(-3.0)], [3.0, np.radians(15.0), 2.0, np.radians(3.0)]])


class NotEnoughData(ValueError):
    pass


@dataclass
class Samples:
    alpha_f: list[np.ndarray] = field(default_factory=list)
    alpha_r: list[np.ndarray] = field(default_factory=list)
    mu_f: list[np.ndarray] = field(default_factory=list)
    mu_r: list[np.ndarray] = field(default_factory=list)
    speed_kmh: list[np.ndarray] = field(default_factory=list)
    corner: list[np.ndarray] = field(default_factory=list)  # which corner each sample came from
    index: list[np.ndarray] = field(default_factory=list)  # each sample's position on the session's 100 Hz clock
    corners: int = 0
    next_id: int = 0
    sessions: list[dict] = field(default_factory=list)


def magic_formula(alpha: np.ndarray, d: float, alpha_peak: float, c: float, shift: float = 0.0) -> np.ndarray:
    """mu at slip angle alpha (rad): peak d at alpha_peak (rad) past the shift, shape c > 1."""
    return d * np.sin(c * np.arctan(np.tan(np.pi / (2 * c)) / alpha_peak * (alpha + shift)))


def _runs(mask: np.ndarray) -> list[tuple[int, int]]:
    """[start, end) of each run of True."""
    edges = np.flatnonzero(np.diff(np.concatenate([[0], mask.astype(np.int8), [0]])))
    return list(zip(edges[::2].tolist(), edges[1::2].tolist(), strict=True))


def _logged_ratio(wheel: np.ndarray | None, road: np.ndarray | None) -> float | None:
    """Steering wheel / road wheel when the logger records both (the 'steer' role is then a road-wheel angle)."""
    if wheel is None or road is None:
        return None
    turned = np.abs(road) > 1.0
    if np.count_nonzero(turned) < MASTER_HZ:
        return None
    ratio = float(np.median(np.abs(wheel[turned] / road[turned])))
    return ratio if 5 < ratio < 30 else None


def _road_wheel_angle(c: dict[str, np.ndarray], kappa: np.ndarray, ay_g: np.ndarray, v_kmh: np.ndarray,
                      fit_mask: np.ndarray, wheelbase_m: float, ratio: float | None,
                      ratio_source: str) -> tuple[np.ndarray, dict]:
    """Road wheel angle (rad, positive into the turn) and where the steering ratio came from.

    Without a ratio, a logger that records both the steering wheel and a road-wheel angle has done the job
    already. Otherwise the ratio is inferred from the data: in steady cornering the steering wheel angle is
    ratio * (L * curvature + K * a_y) (RCVD ch. 5), so a regression on curvature and lateral g separates the
    geometry from the understeer gradient K. The engine's balance calibration (channels._balance) takes the
    plain median of steer / curvature in gentle corners, which folds K * V^2 into the ratio: on the Hockenheim
    logs that reads about 28 % high, fine for a balance trend but not for slip angles.
    """
    straight = (np.abs(ay_g) < 0.05) & (v_kmh > 60)

    def centred(x: np.ndarray) -> np.ndarray:
        x = smooth(x)
        return x - (float(np.median(x[straight])) if np.count_nonzero(straight) > MASTER_HZ else 0.0)

    wheel, road = c.get("steer_wheel"), c.get("steer")
    if wheel is None and road is None:
        raise NotEnoughData("This log has no steering angle channel; the front slip angle needs one")
    src = centred(wheel if wheel is not None else road)
    if ratio is not None:
        info = {"ratio": ratio, "source": ratio_source}
    elif (logged := _logged_ratio(wheel, road)) is not None:
        src, ratio = centred(road), 1.0
        info = {"ratio": round(logged, 2), "source": "logger",
                "note": "The log records a road-wheel angle next to the steering wheel; it is used directly"}
    else:
        sel = fit_mask & (np.abs(ay_g) < 1.0)
        if np.count_nonzero(sel) < 2 * MASTER_HZ:
            raise NotEnoughData("Not enough steady cornering to infer the steering ratio; enter it")
        coef = np.linalg.lstsq(np.c_[kappa[sel], ay_g[sel]], np.radians(src[sel]), rcond=None)[0]
        ratio = abs(float(coef[0])) / wheelbase_m
        if not 0.5 < ratio < 40:
            raise NotEnoughData(f"The steering ratio inferred from the data ({ratio:.1f}) is not plausible; enter it")
        info = {"ratio": round(ratio, 2), "source": "data",
                "note": "Inferred from steering against curvature and lateral g in steady corners"}
    delta = np.radians(src) / ratio
    turning = np.abs(ay_g) > MIN_LAT_G
    if np.count_nonzero(turning) and np.corrcoef(delta[turning], kappa[turning])[0, 1] < 0:
        delta = -delta  # steering logged with the opposite sign to the turn
    return delta, info


def yaw_rate_scale(v_kmh: np.ndarray, ay_g: np.ndarray, ax_g: np.ndarray, r: np.ndarray,
                   r_dot: np.ndarray) -> float:
    """The factor that corrects the yaw gyro (step 2 above): speed x yaw rate against lateral g in steady corners.

    r is the yaw rate in rad/s, smoothed and signed like lateral g; r_dot its rate of change. Raises NotEnoughData
    without steady cornering, or when the two disagree by more than a scale error (a unit problem instead).
    """
    v = np.maximum(v_kmh / 3.6, 1.0)
    steady = ((v_kmh >= MIN_SPEED_KMH) & (np.abs(ay_g) >= 0.5) & (np.abs(ax_g) <= MAX_LONG_G)
              & (np.abs(r_dot) <= MAX_YAW_ACCEL) & (np.abs(r) > 0.05))
    if np.count_nonzero(steady) < MASTER_HZ:
        raise NotEnoughData("No steady cornering in this log")
    scale = float(np.median(ay_g[steady] * G / (v[steady] * r[steady])))
    if not 0.7 < scale < 1.4:
        raise NotEnoughData(f"Speed x yaw rate and lateral g disagree by a factor {scale:.2f}; check channel units")
    return scale


def session_samples(data: SessionData, car: Vehicle, steering_ratio: float | None = None,
                    ratio_source: str = "entered", out: Samples | None = None) -> Samples:
    """Quasi-steady cornering samples of one session, as (slip angle, mu) per axle. See the module docstring."""
    out = out or Samples()
    c = data.channels
    for role, what in (("g_lat", "lateral g"), ("yaw", "yaw rate")):
        if role not in c:
            raise NotEnoughData(f"This log has no {what} channel; the tyre fit needs lateral g, yaw rate and steering")
    if "ay" not in c:
        math_channels(data)
    hz = MASTER_HZ
    v_kmh = c["speed"]
    v = np.maximum(v_kmh / 3.6, 1.0)
    ay_g, ax_g = c["ay"], c["ax"]  # smoothed; ax positive accelerating
    ay = ay_g * G
    r = np.radians(smooth(c["yaw"]))
    if np.count_nonzero((v_kmh >= MIN_SPEED_KMH) & (np.abs(ay_g) >= 0.5)) < MASTER_HZ:
        raise NotEnoughData("No steady cornering in this log")
    if np.corrcoef(r, ay)[0, 1] < 0:
        r = -r
    r_dot_raw = smooth(np.gradient(r) * hz)
    scale = yaw_rate_scale(v_kmh, ay_g, ax_g, r, r_dot_raw)
    r = r * scale
    r_dot = r_dot_raw * scale
    kappa = r / v
    jerk = np.gradient(ay_g) * hz

    L = car.wheelbase_mm / 1000
    wf = car.front_weight_fraction
    a, b = L * (1 - wf), L * wf
    m, h = car.mass_kg, car.cog_height_mm / 1000
    quasi = ((v_kmh >= MIN_SPEED_KMH) & (np.abs(ay_g) >= MIN_LAT_G) & (np.abs(ax_g) <= MAX_LONG_G)
             & (np.abs(r_dot) <= MAX_YAW_ACCEL) & (np.abs(jerk) <= MAX_LAT_JERK))
    delta, steering = _road_wheel_angle(c, kappa, ay_g, v_kmh, quasi, L, steering_ratio, ratio_source)

    # body slip, corner by corner between sustained straights
    beta = np.full(len(v), np.nan)
    straights = [s for s in _runs(np.abs(ay_g) < STRAIGHT_G) if s[1] - s[0] >= STRAIGHT_S * hz]
    dropped = 0
    for (_, i0), (i1, _) in pairwise(straights):
        if i1 - i0 > MAX_CORNER_S * hz or i1 - i0 < hz or v_kmh[i0:i1 + 1].min() < 30:
            continue
        rate = ay[i0:i1 + 1] / v[i0:i1 + 1] - r[i0:i1 + 1]
        bt = np.concatenate([[0.0], np.cumsum((rate[1:] + rate[:-1]) / 2) / hz])
        if abs(bt[-1]) > np.radians(MAX_CLOSE_DEG):
            dropped += 1
            continue
        beta[i0:i1 + 1] = bt - bt[-1] * np.linspace(0, 1, len(bt))

    ok = quasi & np.isfinite(beta)
    alpha_f = delta - beta - a * r / v
    alpha_r = -beta + b * r / v
    iz = m * a * b
    fyf = (m * ay * b + iz * r_dot) / L
    fyr = (m * ay * a - iz * r_dot) / L
    aero = car.downforce_n * (v_kmh / car.aero_ref_speed_kmh) ** 2
    dfz = m * G * ax_g * h / L
    fzf = m * G * wf + aero * car.aero_balance_front - dfz
    fzr = m * G * (1 - wf) + aero * (1 - car.aero_balance_front) + dfz
    side = np.sign(ay)

    # number the corners (spans between straights), unique across sessions
    span = np.cumsum(np.concatenate([[0], np.diff(np.isfinite(beta).astype(np.int8)) == 1])) + out.next_id
    used = np.unique(span[ok])
    out.next_id = int(span[-1]) + 1
    out.alpha_f.append((side * alpha_f)[ok])
    out.alpha_r.append((side * alpha_r)[ok])
    out.mu_f.append((side * fyf / fzf)[ok])
    out.mu_r.append((side * fyr / fzr)[ok])
    out.speed_kmh.append(v_kmh[ok])
    out.corner.append(span[ok])
    out.index.append(np.flatnonzero(ok))
    out.corners += len(used)
    out.sessions.append({"samples": int(np.count_nonzero(ok)), "corners": len(used), "corners_dropped": dropped,
                         "yaw_rate_scale": round(scale, 4), "steering": steering})
    return out


def _sse(p: np.ndarray, alpha: np.ndarray, mu: np.ndarray) -> float:
    return float(np.sum((magic_formula(alpha, *p) - mu) ** 2))


def _refine(p: np.ndarray, alpha: np.ndarray, mu: np.ndarray, free: np.ndarray) -> np.ndarray:
    """Gauss-Newton with Levenberg-Marquardt damping on the free parameters, kept inside BOUNDS."""
    lam, cost = 1e-3, _sse(p, alpha, mu)
    for _ in range(200):
        res = magic_formula(alpha, *p) - mu
        jac = np.zeros((len(alpha), int(free.sum())))
        for j, k in enumerate(np.flatnonzero(free)):
            step = 1e-6 * max(abs(p[k]), 1e-3)
            hi, lo = p.copy(), p.copy()
            hi[k] += step
            lo[k] -= step
            jac[:, j] = (magic_formula(alpha, *hi) - magic_formula(alpha, *lo)) / (2 * step)
        jtj, jtr = jac.T @ jac, jac.T @ res
        improved = False
        while lam < 1e10:
            step = np.linalg.solve(jtj + lam * np.diag(np.diag(jtj) + 1e-12), -jtr)
            trial = p.copy()
            trial[free] = np.clip(p[free] + step, BOUNDS[0][free], BOUNDS[1][free])
            new = _sse(trial, alpha, mu)
            if new < cost:
                done = cost - new < 1e-10 * max(cost, 1e-12)
                p, cost, lam, improved = trial, new, lam / 3, True
                break
            lam *= 4
        if not improved or done:
            break
    return p


def load_bins(alpha: np.ndarray, mu: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    """Median slip angle and mu in each band of mu, with the band's sample count and slip scatter (rad).

    The slip angle carries the body-slip estimate's error (about a degree), mu is measured far more precisely,
    so the curve is fitted through the median slip at each load level rather than through the raw samples:
    fitting mu against noisy slip angles would flatten the curve.
    """
    keep = mu > 0
    alpha, mu = alpha[keep], mu[keep]
    idx = np.floor(mu / BIN_MU).astype(int)
    rows = []
    for i in np.unique(idx):
        a = alpha[idx == i]
        if len(a) >= MIN_BIN:
            q1, q3 = np.percentile(a, [25, 75])
            rows.append((np.median(a), np.median(mu[idx == i]), len(a), (q3 - q1) / 1.349))
    if not rows:
        return (np.empty(0),) * 4
    return tuple(np.array(c, dtype=float) for c in zip(*rows, strict=True))


def _fit_points(a: np.ndarray, m: np.ndarray, p: np.ndarray | None = None) -> tuple[np.ndarray, np.ndarray]:
    """Least-squares Magic Formula through (slip, mu) points: grid start unless one is given, shape held first,
    freed only when the points reach within 5 % of the peak."""
    if p is None:
        ds = m.max() * np.linspace(0.95, 1.6, 27)
        aps = np.radians(np.arange(1.0, 15.01, 0.25))
        grid = np.stack(np.meshgrid(ds, aps, [DEFAULT_SHAPE], [0.0], indexing="ij"), -1).reshape(-1, 4)
        p = grid[int(np.argmin([_sse(g, a, m) for g in grid]))].astype(float)
    free = np.array([True, True, False, True])
    p = _refine(p, a, m, free)
    if m.max() >= 0.95 * p[0]:
        free = np.array([True, True, True, True])
        p = _refine(p, a, m, free)
    return p, free


def fit_curve(alpha: np.ndarray, mu: np.ndarray, groups: np.ndarray | None = None) -> dict:
    """Peak mu, slip angle at the peak and shape of mu(alpha), with fit quality. alpha in rad.

    With `groups` (the corner each sample came from), the spread of peak mu and slip at peak is estimated by
    refitting on corners drawn at random with replacement: samples within a corner are not independent.
    """
    a, m, _, scatter = load_bins(alpha, mu)
    if len(a) < 5:
        raise NotEnoughData("The cornering covers too narrow a range of load to fit a curve; use laps at pace")
    p, free = _fit_points(a, m)
    spread = {}
    if groups is not None and len(ids := np.unique(groups)) >= 8:
        rng = np.random.default_rng(0)
        members = [np.flatnonzero(groups == g) for g in ids]
        boot = []
        for _ in range(30):
            idx = np.concatenate([members[i] for i in rng.integers(0, len(ids), len(ids))])
            ba, bm, _, _ = load_bins(alpha[idx], mu[idx])
            if len(ba) >= 5:
                boot.append(_fit_points(ba, bm, p.copy())[0])
        if len(boot) >= 10:
            lo, hi = np.percentile(np.array(boot), [10, 90], axis=0)
            spread = {"peak_mu_range": [round(float(lo[0]), 3), round(float(hi[0]), 3)],
                      "slip_at_peak_range_deg": [round(float(np.degrees(lo[1])), 2),
                                                 round(float(np.degrees(hi[1])), 2)]}
    res = m - magic_formula(a, *p)
    var = float(np.var(m))
    d, ap, c, sh = p
    stiffness = d * c * np.tan(np.pi / (2 * c)) / ap  # d mu / d alpha at zero slip, per rad
    return {
        "peak_mu": round(float(d), 3),
        "slip_at_peak_deg": round(float(np.degrees(ap)), 2),
        "shape": round(float(c), 3),
        "shape_fitted": bool(free[2]),
        "slip_offset_deg": round(float(np.degrees(sh)), 2),
        "peak_reached": bool(m.max() >= 0.95 * d),
        "cornering_stiffness_mu_per_deg": round(float(np.radians(stiffness)), 4),
        **spread,
        "samples": len(alpha),
        "load_bins": len(a),
        "rmse_mu": round(float(np.sqrt(np.mean(res**2))), 4),
        "r2": round(1 - float(np.mean(res**2)) / var, 3) if var > 0 else None,
        "slip_scatter_deg": round(float(np.degrees(np.median(scatter))), 2),
        "slip_range_deg": [round(float(np.degrees(x)), 2) for x in np.percentile(alpha, [1, 99])],
        "mu_observed_max": round(float(m.max()), 3),
        "slip_at_mu_max_deg": round(float(np.degrees(a[int(np.argmax(m))])), 2),
        "note": _note(m.max(), d, ap),
    }


def _note(top: float, d: float, alpha_peak: float) -> str | None:
    if top >= 0.95 * d:
        return None
    if alpha_peak >= BOUNDS[1][1] * 0.999:
        return (f"The data stop at mu {top:.2f} with grip still rising: they do not show where it peaks, so the "
                "peak values sit on the fit's limit and mean only 'higher than the data'. In steady cornering both "
                "axles work at about the same mu, so only the axle that limits the car can show its peak.")
    return (f"The data stop at mu {top:.2f}, {top / d:.0%} of the fitted peak: the peak and the slip at the peak "
            "are extrapolated. In steady cornering both axles work at about the same mu, so only the axle that "
            "limits the car can show its peak.")


def fit_tyres(sessions: list[SessionData], car: Vehicle, steering_ratio: float | None = None,
              ratio_source: str = "entered") -> dict:
    """Fitted curve per axle from one or more sessions, or NotEnoughData with what was missing."""
    s, skipped = Samples(), []
    for i, data in enumerate(sessions):
        try:
            session_samples(data, car, steering_ratio, ratio_source, s)
        except NotEnoughData as e:
            if len(sessions) == 1:
                raise
            skipped.append({"index": i, "reason": str(e)})
    n = sum(len(x) for x in s.alpha_f)
    if n < MIN_SAMPLES or s.corners < MIN_CORNERS:
        raise NotEnoughData(
            f"Not enough quasi-steady cornering to fit a tyre curve: found {n} samples in {s.corners} corners, "
            f"need at least {MIN_SAMPLES} samples ({MIN_SAMPLES / MASTER_HZ:.0f} s) in {MIN_CORNERS} corners. "
            "Use a longer run, or several, with laps at pace.")
    axles, binned = {}, {}
    groups = np.concatenate(s.corner)
    for axle, al, mu in (("front", s.alpha_f, s.mu_f), ("rear", s.alpha_r, s.mu_r)):
        alpha, m = np.concatenate(al), np.concatenate(mu)
        axles[axle] = fit_curve(alpha, m, groups)
        ba, bm, bc, _ = load_bins(alpha, m)
        binned[axle] = {"alpha_deg": np.round(np.degrees(ba), 3).tolist(), "mu": np.round(bm, 4).tolist(),
                        "count": bc.astype(int).tolist()}
    # both fitted curves on one slip grid for a chart: past the data, and past the peak when it is in reach
    top = max(max(f["slip_range_deg"][1], min(f["slip_at_peak_deg"] * 1.3, 2 * f["slip_range_deg"][1]))
              for f in axles.values())
    grid = np.linspace(0, top, 61)
    curves = {"alpha_deg": np.round(grid, 3).tolist()}
    for axle, f in axles.items():
        mf = magic_formula(np.radians(grid), f["peak_mu"], np.radians(f["slip_at_peak_deg"]), f["shape"],
                           np.radians(f["slip_offset_deg"]))
        curves[axle] = np.round(mf, 4).tolist()
    return {
        "samples": n,
        "corners": s.corners,
        "sessions": s.sessions,
        "skipped": skipped,
        "speed_range_kmh": [round(float(x)) for x in np.percentile(np.concatenate(s.speed_kmh), [5, 95])],
        "axles": axles,
        "curves": curves,
        "binned": binned,
        "loads": {"mass_kg": car.mass_kg, "front_weight_fraction": car.front_weight_fraction,
                  "cog_height_mm": car.cog_height_mm, "wheelbase_mm": car.wheelbase_mm,
                  "downforce_n": car.downforce_n, "aero_balance_front": car.aero_balance_front,
                  "aero_ref_speed_kmh": car.aero_ref_speed_kmh},
        "selection": {"min_speed_kmh": MIN_SPEED_KMH, "min_lateral_g": MIN_LAT_G, "max_longitudinal_g": MAX_LONG_G,
                      "max_yaw_accel_rad_s2": MAX_YAW_ACCEL, "max_lateral_jerk_g_s": MAX_LAT_JERK,
                      "max_corner_s": MAX_CORNER_S},
        "assumptions": [
            "Axle curves: each mu includes both tyres, their load transfer, camber and compliance.",
            "Body slip is estimated by integrating lateral g / speed minus yaw rate from straight to straight.",
            "The yaw gyro is scaled so speed x yaw rate matches lateral g in steady corners.",
            "Axle loads: static, plus downforce at speed if given, plus longitudinal transfer; no fuel burn.",
            "Corners whose slip estimate misses zero on the next straight by more than 2 deg are left out.",
            "A constant slip-angle offset is fitted with the curve (the Magic Formula's horizontal shift).",
            "The shape is held at 1.3 for an axle whose data stop short of 95 % of its peak.",
        ],
    }
