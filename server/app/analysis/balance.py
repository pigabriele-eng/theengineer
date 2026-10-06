"""Car balance and setup direction: where the car, not the driver, limits the lap, and what to change.

Balance is the understeer angle: the road wheel angle beyond what the path's curvature needs on geometry alone,
    understeer angle = steering wheel angle / steering ratio - wheelbase x yaw rate / speed,
signed by the direction of the turn (positive: the front pushes; negative: the rear slides). The yaw gyro is
first scaled to agree with the accelerometer in steady corners, as the tyre fit does (on the Hockenheim logs it
reads about 9 % low). Every car has some understeer that grows with cornering load: the car's own gradient
(degrees per g, fitted on all its cornering) is taken off, so what is left says where the balance moves away
from the car's normal. On the Hockenheim test that gradient was about 1 degree per g. Cornering load is lateral g
per unit of the road's vertical load (track_shape.py), so a banked corner or a dip, where the car pulls more g on the
same tyres, is measured against the same normal as a level corner.

Where the car limits the lap: in each section, the reference lap against the quickest pass of the same section
is driving (the car has shown it can do better); the quickest pass against the realistic target (the grip a quick
lap usually shows at each place, used without a mistake: lapsim.py) is the car's share where the pass is slower;
the rest, down to the theoretical lap (the best the car has shown at each place), is the theoretical lap asking for
the best of every place at once.

Multi-session work loads one session at a time and keeps only each clean lap's few channels on the distance
grid (a few hundred kB per lap), so an event fits in the memory of a small server.
"""
from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
from numpy.lib.stride_tricks import sliding_window_view

from app.analysis.align import TrackLine, aligned_trace, track_line
from app.analysis.channels import EXIT, G, MID, PHASES, TRAIL, math_channels, smooth
from app.analysis.insights import (
    LapRecord,
    Prepared,
    _balance_notes,
    cornering,
    lateral,
    setup_diagnostics,
    targets,
    understeer_fit,
)
from app.analysis.lapsim import SimLap
from app.analysis.laps import MASTER_HZ, CornerSpec, SessionData, lap_length, make_sections
from app.analysis.limits import CarLimits
from app.analysis.local_limits import PlaceLimits, smoothed_curvature
from app.vehicle.tyre_fit import NotEnoughData, _logged_ratio, level_road, yaw_rate_scale

# Fallbacks from the Hockenheim test (BMW M4 GT4): the ratio between the logger's two steering channels, and the
# published wheelbase. Used when the car data has no value.
HOCKENHEIM_STEERING_RATIO = 15.6
HOCKENHEIM_WHEELBASE_MM = 2857.0

HELD_WINDOW_M = 40  # grip "held" is the least lateral g over this many metres
CORNERING_G = 0.5  # balance is read where the car corners at least this hard
MIN_SAMPLES = 5  # per lap and phase
SPEED_BANDS = (("slow", 0, 110), ("medium", 110, 160), ("fast", 160, 400))  # km/h, as setup_diagnostics
PHASE_NAMES = ((TRAIL, "entry"), (MID, "mid"), (EXIT, "exit"))  # braking while turning, neither pedal, throttle
# Per section and pass, typical and quick: traction control and ABS time (s), peak brake pressure, rear wheel slip
# on the exit (90th percentile, %) and minimum speed (km/h)
AIDS = ("tc_s", "abs_s", "peak_brake", "rear_slip_exit", "min_speed")

# Channels kept per lap on the distance grid; everything else is dropped as soon as the lap is traced
KEEP = ("t", "speed", "ax", "ay", "phase", "braking", "brake", "throttle", "coasting", "overlap", "tc_on", "abs_on",
        "rear_slip", "curvature", "understeer", "tyre_p_fl", "tyre_p_fr", "tyre_p_rl", "tyre_p_rr",
        "tyre_t_fl", "tyre_t_fr", "tyre_t_rl", "tyre_t_rr", "turn_g", "az", "altitude")


@dataclass
class Geometry:
    """Steering ratio and wheelbase, with where each came from and whether it is published or an estimate."""
    wheelbase_mm: float
    wheelbase_source: str
    wheelbase_confidence: str  # published, measured or estimate
    steering_ratio: float | None  # None: the logger's road-wheel angle is used when there is one
    ratio_source: str
    ratio_confidence: str

    def to_dict(self) -> dict:
        return {"wheelbase_mm": self.wheelbase_mm, "wheelbase_source": self.wheelbase_source,
                "wheelbase_confidence": self.wheelbase_confidence, "steering_ratio": self.steering_ratio,
                "steering_ratio_source": self.ratio_source, "steering_ratio_confidence": self.ratio_confidence}


def car_geometry(preset: dict | None) -> Geometry:
    """Wheelbase and steering ratio from the car preset (see app.vehicle.presets.preset_detail), else Hockenheim's."""
    wb = (preset or {}).get("values", {}).get("wheelbase_mm") or {}
    if wb.get("value"):
        wheelbase = (float(wb["value"]), f"{preset['name']} car data", wb.get("confidence") or "estimate")
    else:
        wheelbase = (HOCKENHEIM_WHEELBASE_MM, "BMW M4 GT4 value (no car data)", "estimate")
    sr = (preset or {}).get("steering_ratio") or {}
    if sr.get("value"):
        ratio = (float(sr["value"]), f"{preset['name']} car data", sr.get("confidence") or "estimate")
    else:
        ratio = (None, "not in the car data", "unknown")
    return Geometry(*wheelbase, *ratio)


# ---------- the balance channel ----------

def _centred(x: np.ndarray, straight: np.ndarray) -> np.ndarray:
    x = smooth(x)
    return x - (float(np.median(x[straight])) if np.count_nonzero(straight) > MASTER_HZ else 0.0)


def road_wheel_angle(c: dict[str, np.ndarray], kappa: np.ndarray, ay_g: np.ndarray, v_kmh: np.ndarray,
                     geo: Geometry) -> tuple[np.ndarray, dict]:
    """Road wheel angle (deg, positive into the turn) and the steering ratio behind it, with its source.

    1. The car data's steering ratio, on the steering wheel angle.
    2. A logger that records a road-wheel angle next to the steering wheel (the BMW does): that angle, with the
       ratio between the two channels reported.
    3. The steering wheel angle over the Hockenheim ratio (an estimate). A single steering channel is taken as a
       steering wheel angle when it is many times the road wheel angle the path needs.
    """
    straight = (np.abs(ay_g) < 0.05) & (v_kmh > 60)
    wheel, road = c.get("steer_wheel"), c.get("steer")
    if wheel is None and road is None:
        raise NotEnoughData("This log has no steering angle channel")
    if wheel is None:  # one channel: road wheel or steering wheel?
        gentle = (np.abs(ay_g) > 0.3) & (v_kmh > 40) & (np.abs(kappa) > 2e-3)
        need = np.degrees(geo.wheelbase_mm / 1000 * np.abs(kappa[gentle]))
        if np.count_nonzero(gentle) > MASTER_HZ and np.median(np.abs(road[gentle]) / need) > 5:
            wheel, road = road, None
    if geo.steering_ratio and wheel is not None:
        delta, info = _centred(wheel, straight) / geo.steering_ratio, {
            "ratio": geo.steering_ratio, "source": geo.ratio_source, "confidence": geo.ratio_confidence}
    elif road is not None:
        logged = _logged_ratio(wheel, road)
        delta = _centred(road, straight)
        info = {"ratio": round(logged, 1) if logged else None, "confidence": "measured",
                "source": "the logger's road-wheel angle" + (" (steering wheel / road wheel measured in this log)"
                                                             if logged else "")}
    else:
        delta = _centred(wheel, straight) / HOCKENHEIM_STEERING_RATIO
        info = {"ratio": HOCKENHEIM_STEERING_RATIO, "confidence": "estimate",
                "source": "the BMW M4 GT4 value measured at Hockenheim (no ratio in the car data)"}
    turning = np.abs(ay_g) > 0.3
    if np.count_nonzero(turning) and np.corrcoef(delta[turning], kappa[turning])[0, 1] < 0:
        delta = -delta  # steering logged with the opposite sign to the turn
    return delta, info


def balance_channel(data: SessionData, geo: Geometry) -> dict:
    """Adds data.channels["understeer"]: the understeer angle in degrees (see the module docstring).

    Needs math_channels first. Returns how it was made (yaw scale, steering ratio), or raises NotEnoughData.
    """
    c = data.channels
    if "yaw" not in c or ("steer" not in c and "steer_wheel" not in c):
        raise NotEnoughData("The balance needs a yaw rate and a steering channel")
    v_kmh, ay_g, ax_g = c["speed"], c["ay"], c["ax"]
    v = np.maximum(v_kmh / 3.6, 5.0)
    r = np.radians(smooth(c["yaw"]))
    if np.corrcoef(r, ay_g)[0, 1] < 0:
        r = -r
    scale = yaw_rate_scale(v_kmh, ay_g, ax_g, r, smooth(np.gradient(r) * MASTER_HZ), level_road(c))
    kappa = r * scale / v
    delta, steering = road_wheel_angle(c, kappa, ay_g, v_kmh, geo)
    ua = np.sign(ay_g) * (delta - np.degrees(geo.wheelbase_mm / 1000 * kappa))
    c["understeer"] = np.where((np.abs(ay_g) > 0.3) & (v_kmh > 30), smooth(ua, 0.3), 0.0)
    return {"yaw_scale": round(scale, 3), "steering": steering}


# ---------- one session at a time ----------

@dataclass
class Collected:
    """What is kept of each session: its clean laps on the reference line, and how its balance was read."""
    laps: list[LapRecord] = field(default_factory=list)
    sessions: list[dict] = field(default_factory=list)
    line: TrackLine | None = None
    length: int | None = None


def collect(name: str, data: SessionData, geo: Geometry, out: Collected, *, driver: str | None = None,
            meta: dict | None = None) -> None:
    """Trace the session's clean laps onto the reference line (the first session's quickest lap sets it), keep
    the few channels the analysis needs, and drop the session's full-rate channels."""
    entry = {"name": name, **(meta or {}), "laps": 0}
    out.sessions.append(entry)
    clean = [l for l in data.laps if l.clean]
    if not clean:
        entry["note"] = "No clean lap"
        data.channels = {}
        return
    c = data.channels
    for role in ("gear", "rpm", "brake_rear"):  # not used here: free them before the math channels are made
        c.pop(role, None)
    for role in c:  # half the memory; GPS keeps full precision (float32 rounds a position to about half a metre)
        if role not in ("lat", "lon"):
            c[role] = c[role].astype(np.float32)
    math_channels(data)
    needed = {*KEEP, "lat", "lon", "yaw", "steer", "steer_wheel"}
    for role in [r for r in c if r not in needed or r == "understeer"]:  # the engine's understeer is replaced
        del c[role]
    try:
        entry.update(balance_channel(data, geo))
    except NotEnoughData as e:
        entry["note"] = f"No balance: {e}"
    for role in ("yaw", "steer", "steer_wheel"):
        c.pop(role, None)
    if out.length is None:
        ref = min(clean, key=lambda l: l.time)
        out.line = track_line(data, ref)
        out.length = out.line.length if out.line is not None else round(lap_length(data, ref))
    for i, l in enumerate(clean):
        tr = aligned_trace(data, l, out.line, out.length)
        out.laps.append(LapRecord(name, l.number, l.time, driver,
                                  {k: tr[k].astype(np.float32) for k in KEEP if k in tr}, i))
    entry["laps"] = len(clean)
    data.channels = {}


def prepared(col: Collected, corners: list[CornerSpec] | None) -> Prepared | None:
    """The engine's Prepared from collected laps: limits, the theoretical lap, the realistic target and the
    sections."""
    laps = col.laps
    if not laps:
        return None
    reference = min(laps, key=lambda x: x.time)
    sections, numbering = make_sections(reference.trace, corners)
    t = targets(laps, reference.trace, reference.time, sections)
    return t.prepared(col.line, reference, laps, sections, numbering)


# ---------- the analysis ----------

def _f(x: np.ndarray) -> np.ndarray:
    return np.asarray(x, dtype=float)


def gradient(prep: Prepared) -> dict | None:
    """The car's own understeer gradient (deg per g) over all its cornering, through zero at zero g.

    Understeer grows faster than linearly as the tyres near their limit, so a straight line with an offset
    (understeer_fit) reads steeper with a negative offset; the gradient through zero is the "normal amount" the
    balance is measured against. understeer_fit's slope is kept to show how much the understeer steepens. The g is
    lateral g per unit of the road's load (insights.lateral).
    """
    laps = [x for x in prep.laps if "understeer" in x.trace]
    if len(laps) < max(1, len(prep.laps) // 2):
        return None
    tr = {k: _f(np.concatenate([x.trace[k] for x in laps])) for k in ("understeer", "phase", "speed")}
    tr["ay"] = np.concatenate([lateral(x.trace, prep.limits) for x in laps])
    corner = cornering(tr) & (tr["speed"] > 40)
    if np.count_nonzero(corner) < 10 * MASTER_HZ:
        return None
    ay, us = np.abs(tr["ay"][corner]), tr["understeer"][corner]
    k = float(np.sum(ay * us) / np.sum(ay * ay))
    slope, offset = understeer_fit(tr)
    rel = us - k * ay
    v = tr["speed"][corner]
    phase = np.rint(tr["phase"][corner]).astype(int)
    table = []
    for name, lo, hi in SPEED_BANDS:
        row = {"speed": name, "range_kmh": [lo, hi]}
        for p, pname in PHASE_NAMES:
            sel = (phase == p) & (v >= lo) & (v < hi)
            row[pname] = round(float(np.median(rel[sel])), 2) if sel.sum() >= 200 else None
        table.append(row)
    spread = float(np.percentile(np.abs(rel - np.median(rel)), 75))
    by_g = []
    for lo, hi in ((0.5, 0.8), (0.8, 1.1), (1.1, 1.4), (1.4, 2.5)):
        sel = (ay >= lo) & (ay < hi)
        if sel.sum() >= 200:
            by_g.append({"g": [lo, hi], "understeer_deg": round(float(np.median(us[sel])), 2)})
    return {"per_g": round(k, 2), "fit_slope": round(slope, 2), "fit_offset": round(offset, 2), "by_g": by_g,
            "table": table, "spread": round(spread, 2), "notes": _balance_notes(table, spread)}


def throttle_lifts(throttle: np.ndarray) -> int:
    """Lifts of more than 20 points once the throttle has come up past 20 %."""
    n, peak, on = 0, 0.0, False
    for v in throttle:
        on = on or v > 20
        if on:
            peak = max(peak, float(v))
            if peak - v > 20:
                n, peak = n + 1, float(v)
    return n


def _typ(values: list[float], quick: list[float], nd: int = 2) -> dict | None:
    if not values:
        return None
    return {"typical": round(float(np.median(values)), nd),
            "quick": round(float(np.median(quick)), nd) if quick else None}


def _section_rows(prep: Prepared, held_sim: SimLap, k: float | None) -> list[dict]:
    ref = prep.reference.trace
    n_laps = len(prep.laps)
    need = max(1, min(3, n_laps), n_laps // 4)  # laps a balance value needs
    ts = [_f(x.trace["t"]) for x in prep.laps]
    rows = []
    for s in prep.sections:
        a, b = s.start, s.end
        sl = slice(a, b)
        times = np.array([t[b] - t[a] for t in ts])
        order = np.argsort(times)
        quick = set(order[:max(3, n_laps // 10)].tolist())
        bi = int(order[0])
        best = prep.laps[bi]
        theo, held = float(prep.sim.t[b] - prep.sim.t[a]), float(held_sim.t[b] - held_sim.t[a])
        lost = np.diff(ts[bi][a:b + 1]) - np.diff(held_sim.t[a:b + 1])
        ph = np.rint(_f(best.trace["phase"][sl])).astype(int)
        car_by_phase = {PHASES[p]: round(float(lost[ph == p].sum()), 3) for p in range(len(PHASES))}
        bal: dict[str, tuple[list, list]] = {p: ([], []) for _, p in PHASE_NAMES}
        aids: dict[str, tuple[list, list]] = {k: ([], []) for k in AIDS}
        held_share = []
        for i, x in enumerate(prep.laps):
            tr = x.trace
            ay = lateral(tr, prep.limits, sl)
            phase = np.rint(_f(tr["phase"][sl]))
            dt = np.diff(ts[i][a:b + 1])
            found: dict[str, float] = {}
            if k is not None and "understeer" in tr:
                us = _f(tr["understeer"][sl])
                for p, pname in PHASE_NAMES:
                    sel = (phase == p) & (ay > CORNERING_G)
                    if np.count_nonzero(sel) >= MIN_SAMPLES:
                        found[pname] = float(np.median(us[sel] - k * ay[sel]))
            if "tc_on" in tr:
                found["tc_s"] = float((dt * (tr["tc_on"][sl] > 0.5)).sum())
            if "abs_on" in tr:
                found["abs_s"] = float((dt * (tr["abs_on"][sl] > 0.5)).sum())
            if "brake" in tr:
                found["peak_brake"] = float(tr["brake"][sl].max())
            found["min_speed"] = float(tr["speed"][sl].min())
            if "rear_slip" in tr and np.count_nonzero(phase == EXIT) >= MIN_SAMPLES:
                found["rear_slip_exit"] = float(np.percentile(_f(tr["rear_slip"][sl])[phase == EXIT], 90))
            for key, value in found.items():
                store = bal.get(key) or aids[key]
                store[0].append(value)
                if i in quick:
                    store[1].append(value)
            if b - a > HELD_WINDOW_M:
                h = sliding_window_view(ay, HELD_WINDOW_M).min(1)
                vm = sliding_window_view(_f(tr["speed"][sl]), HELD_WINDOW_M).mean(1)
                held_share.append(h / np.maximum(prep.limits.max_lateral(vm), 0.1))
        hs = np.concatenate(held_share) if held_share else np.zeros(0)
        ref_time = float(ref["t"][b] - ref["t"][a])
        rows.append({
            "code": s.code, "corners": s.corners, "start_m": a, "end_m": b, "apex_m": s.apex,
            "min_speed_kmh": round(float(ref["speed"][sl].min()), 1),
            "reference": round(ref_time, 3), "best": round(float(times[bi]), 3), "best_lap": best.key,
            "typical": round(float(np.median(times)), 3), "theoretical": round(theo, 3), "held": round(held, 3),
            "driving": round(ref_time - float(times[bi]), 3), "car": round(float(times[bi]) - held, 3),
            "optimism": round(held - theo, 3), "car_by_phase": car_by_phase,
            "balance": {p: {"value": round(float(np.median(v)), 2),
                            "quick": round(float(np.median(qv)), 2) if len(qv) >= 3 else None, "laps": len(v)}
                        for p, (v, qv) in bal.items() if len(v) >= need},
            **{key: _typ(v, qv, 2 if key.endswith("_s") else 1) for key, (v, qv) in aids.items()},
            # the most lateral g held over HELD_WINDOW_M, as a share of the car's peak (both per unit of the road's
            # load); only for real corners
            "held_grip": {"p98": round(float(np.percentile(hs, 98)), 2), "max": round(float(hs.max()), 2)}
            if len(hs) and np.percentile(hs, 99) > 0.6 else None,
        })
    return rows


def _sim_ay(sim_speed: np.ndarray, curvature: np.ndarray, limits: PlaceLimits) -> np.ndarray:
    """A simulated lap's cornering g: speed squared times the (smoothed) curvature, capped at each place's limit."""
    k = smoothed_curvature(curvature)
    cap = limits.corner[limits.place_of(np.arange(len(k)))]
    return np.minimum((sim_speed / 3.6) ** 2 * k / G, cap)


def _lap_through(x: LapRecord, a: int, b: int, k: float | None, limits: CarLimits) -> dict:
    tr = x.trace
    sl = slice(a, b + 1)
    out = {"lap": x.key, "time": round(float(tr["t"][b] - tr["t"][a]), 3),
           "min_speed_kmh": round(float(tr["speed"][sl].min()), 1), "exit_speed_kmh": round(float(tr["speed"][b]), 1)}
    if "throttle" in tr:
        out["throttle_lifts"] = throttle_lifts(_f(tr["throttle"][sl]))
    if "tc_on" in tr:
        out["tc_s"] = round(float((np.diff(_f(tr["t"][sl])) * (tr["tc_on"][a:b] > 0.5)).sum()), 2)
    if "rear_slip" in tr:
        out["rear_slip_p98"] = round(float(np.percentile(_f(tr["rear_slip"][sl]), 98)), 1)
    ay = lateral(tr, limits, sl)
    turning = ay > CORNERING_G
    if k is not None and "understeer" in tr and np.count_nonzero(turning) >= MIN_SAMPLES:
        # the furthest the balance goes towards oversteer: the rear stepping out
        out["balance_low"] = round(float(np.percentile((_f(tr["understeer"][sl]) - k * ay)[turning], 5)), 2)
    return out


def focus_section(prep: Prepared, rows: list[dict], held_sim: SimLap, corners: list[CornerSpec] | None,
                  k: float | None) -> dict | None:
    """The section the fastest lap leaves most to the theoretical lap in, explained: its fastest lap, its quickest
    pass and the realistic theoretical lap through it, with traces for a chart."""
    corner_rows = [r for r in rows if r["apex_m"] is not None]
    if not corner_rows:
        return None
    row = max(corner_rows, key=lambda r: r["reference"] - r["theoretical"])
    a, b = row["start_m"], row["end_m"]
    best = next(x for x in prep.laps if x.key == row["best_lap"])
    curv = _f(prep.reference.trace["curvature"])
    held_ay = _sim_ay(held_sim.speed, curv, prep.held)
    theo_ay = _sim_ay(prep.sim.speed, curv, prep.perfect)
    idx = np.arange(a, b + 1, max(1, round((b - a) / 150)))

    def rnd(v: np.ndarray, nd: int = 1) -> list[float]:
        return np.round(_f(v), nd).tolist()

    return {
        "code": row["code"], "start_m": a, "end_m": b,
        "total": round(row["reference"] - row["theoretical"], 3),
        "driving": row["driving"], "car": row["car"], "optimism": row["optimism"],
        "reference": _lap_through(prep.reference, a, b, k, prep.limits),
        "best": _lap_through(best, a, b, k, prep.limits),
        "theoretical_peak_g": round(float(theo_ay[a:b + 1].max()), 2),
        "held_time": row["held"], "held_grip": row["held_grip"],
        "trace": {
            "distance_m": idx.tolist(),
            "reference_speed": rnd(prep.reference.trace["speed"][idx]), "best_speed": rnd(best.trace["speed"][idx]),
            "held_speed": rnd(held_sim.speed[idx]),
            "reference_g": rnd(np.abs(prep.reference.trace["ay"][idx]), 2),
            "best_g": rnd(np.abs(best.trace["ay"][idx]), 2), "held_g": rnd(held_ay[idx], 2),
            "corners": [{"code": c[0], "at_m": int(c[1])} for c in corners or [] if c[1] is not None
                        and a <= c[1] <= b],
        },
    }


def analyse(prep: Prepared, corners: list[CornerSpec] | None = None) -> dict:
    """Everything the balance and setup section needs, before the advice is worded."""
    diag = setup_diagnostics(prep)
    diag.pop("balance", None)  # measured against a gradient with an offset; see gradient()
    diag.pop("lateral_grip_by_speed", None)
    grad = gradient(prep)
    held_sim = prep.realistic  # the realistic target
    k = grad["per_g"] if grad else None
    rows = _section_rows(prep, held_sim, k)
    return {
        "reference": {"run": prep.reference.run, "lap": prep.reference.number, "time": prep.reference.time},
        "laps": len(prep.laps),
        "length_m": prep.length,
        "numbering": prep.numbering,
        "theoretical_lap": round(prep.sim.time, 3),
        "held_lap": round(held_sim.time, 3),
        "ideal_lap": round(sum(r["best"] for r in rows), 3),
        "peak_lateral_g": round(float(prep.limits.max_lateral(prep.limits.speeds).max()), 2),
        "gradient": grad,
        "diagnostics": diag,
        "sections": rows,
        "focus": focus_section(prep, rows, held_sim, corners, k),
    }
