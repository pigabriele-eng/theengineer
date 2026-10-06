"""The accumulating tyre model: every log reduced once to a small summary, and one model fitted from all of a car's.

Summary (summarise), made once per log when it is uploaded or imported, and in the background for older logs:
the quasi-steady cornering samples of the tyre fit (tyre_fit.session_samples), lap by lap and per axle, binned by
grip level (mu in bands of BAND_MU): how many samples, their mean mu, and the median and spread of their slip
angle. Each lap also keeps the axle's TPMS temperature and pressure (medians at racing speed) and its laps on the
tyre, counted from the cold start the TPMS shows when it shows one. A summary is a few tens of kilobytes, so the
model pools every session of a car without opening a log.

Model (fit_model), from the summaries of one car and tyre:
1. Sessions are lined up. The body-slip estimate carries an offset that differs from log to log (up to about a
   degree on the Hockenheim logs, and about the same on both axles, so it is the estimate's, not the tyres'), so
   each session's slip angles are shifted by their median difference to the pool at low load (mu ALIGN_MU), where
   the tyres are far from their limit. The shifts average out to zero across the sessions.
2. The curve per axle is fitted through the pooled slip angle in each band of mu, as the single-log fit does
   (tyre_fit.fit_curve). The pooled slip angle of a band is the sample-weighted mean of the laps' medians. Its
   spread comes from refitting on sessions drawn at random with replacement (laps when there are fewer than 5).
3. Grip against a condition (TPMS temperature, hot pressure, laps on the tyre): the laps are grouped by the
   condition, and in each band of mu at or above GRIP_MU (hard cornering) the slip angle a group needed is set
   against the pool's; the curve's slope there turns the slip saved into grip, averaged over the group's samples:
   +3 % means 3 % more grip at the same slip angle than the average lap. Its range comes from redrawing the
   sessions and, within them, the laps. A range of the condition with the most grip (_window) is trusted as far
   as the model, fitted again with each of its sessions left out in turn, still shows it (_left_out). The redraws
   use a fixed seed, so the same summaries always give the same answer.
"""
from __future__ import annotations

import itertools
import math
from dataclasses import dataclass, field

import numpy as np

from app.analysis.laps import MASTER_HZ, SessionData
from app.vehicle.model import Vehicle
from app.vehicle.tyre_fit import (
    BIN_MU,
    BOUNDS,
    DEFAULT_SHAPE,
    MIN_BIN,
    MIN_CORNERS,
    MIN_SAMPLES,
    NotEnoughData,
    Samples,
    _fit_points,
    _note,
    magic_formula,
    session_samples,
)

VERSION = 2  # bump when the summary's method changes: older summaries are then made again in the background
BAND_MU = BIN_MU
RACING_KMH = 60.0  # TPMS medians only from samples at racing speed
SET_START_SLACK_S = 5.0  # a lap starting this soon before a set's cold start is still on that set
SLIP_BOUND_DEG = float(np.degrees(BOUNDS[1][1]))  # the most slip at the peak the fit allows
AXLE_WHEELS = {"front": ("fl", "fr"), "rear": ("rl", "rr")}

ALIGN_MU = (0.3, 0.9)
GRIP_MU = 0.8
MIN_GRIP_BAND = 20  # samples in a band before it counts towards a group's grip
MIN_GROUP_LAPS = 4
MIN_GROUP_SAMPLES = 200  # samples at or above GRIP_MU
MIN_GROUP_BANDS = 3
BOOT_CURVE = 30
BOOT_GRIP = 400
MIN_SESSIONS_REDRAW = 3  # spreads redraw whole sessions once there are this many
SPREAD_PCT = (5, 95)  # a group's grip range: the middle 90 % of its redraws
MIN_GAIN = 0.02  # a group must also have this much less grip than the best to count as clearly worse
HOLD_HIGH = 0.9  # a window stays "high" only when this share of the refits leaving one session out show it
HOLD_MEDIUM = 2 / 3  # ... and "medium" when this share do; below it, "low"
LAPS_PER_BIN = 15  # laps are grouped by a condition into groups of about this many laps ...
MAX_BINS = 8  # ... and at most this many groups
CONDITIONS = {
    "temperature": {
        "label": "TPMS temperature", "noun": "TPMS temperature", "unit": "°C", "key": "temp_c", "step": 1.0,
        "note": "The TPMS sensor reads the air inside the tyre, which lags the tread and runs cooler than it. "
                "Temperature, pressure and laps on the tyre rise together through a run."},
    "pressure": {
        "label": "Hot pressure", "noun": "pressure", "unit": "bar", "key": "bar", "step": 0.01,
        "note": "Pressure rises with temperature through a run, and between sessions with the cold pressure set, so "
                "read it with the temperature: a group of laps at one pressure also shares their temperature."},
    "tyre_laps": {
        "label": "Laps on the tyre", "noun": "laps on the tyre", "unit": "laps", "key": "tyre_lap",
        "edges": [1, 2, 3, 4, 6, 9, 13, 21, 1000],
        "note": "Counted from the cold start the TPMS shows in the log; earlier use of the set is not in the log. "
                "Fuel burning off and the track rubbering in move with it."},
}


# ---------- one log -> summary ----------

def _r(x: float | None, nd: int) -> float | None:
    return None if x is None or not np.isfinite(x) else round(float(x), nd)


def _bands(alpha: np.ndarray, mu: np.ndarray) -> dict:
    """Samples binned by mu: band index, count, mean mu, median slip angle and its interquartile range (deg)."""
    keep = mu > 0
    alpha, mu = np.degrees(alpha[keep]), mu[keep]
    idx = np.floor(mu / BAND_MU).astype(int)
    out: dict[str, list] = {"b": [], "n": [], "mu": [], "a": [], "q": []}
    for b in np.unique(idx):
        sel = idx == b
        q1, q2, q3 = np.percentile(alpha[sel], [25, 50, 75])
        out["b"].append(int(b))
        out["n"].append(int(np.count_nonzero(sel)))
        out["mu"].append(round(float(mu[sel].mean()), 4))
        out["a"].append(round(float(q2), 3))
        out["q"].append(round(float(q3 - q1), 3))
    return out


def _axle_state(c: dict[str, np.ndarray], sl: slice, fast: np.ndarray, axle: str) -> tuple[float | None, ...]:
    """Median TPMS temperature and pressure (bar) of the axle's two tyres over the lap, at racing speed."""
    out = []
    for kind in ("t", "p"):
        vals = [float(np.median(c[k][sl][fast])) for w in AXLE_WHEELS[axle]
                if (k := f"tyre_{kind}_{w}") in c and np.any(fast)]
        value = float(np.mean(vals)) if vals else None
        if kind == "p" and value is not None and value > 50:  # some systems log kPa
            value /= 100
        out.append(value)
    return tuple(out)


def summarise(data: SessionData, car: Vehicle, set_starts: list[float] | None = None) -> dict:
    """One log's tyre data, lap by lap and per axle (see the module docstring). NotEnoughData if it has no steady
    cornering. set_starts: when each tyre set went out cold (tpms.measure_runs), for the laps on the tyre."""
    s = session_samples(data, car, out=Samples())
    idx = s.index[0]
    t = idx / MASTER_HZ
    c = data.channels
    v = c["speed"]
    end = len(v) / MASTER_HZ
    crossings = [l.start for l in data.laps] + ([data.laps[-1].end] if data.laps else [])
    edges = [0.0, *crossings, end + 1]
    lap_at = {round(l.start, 3): l for l in data.laps}
    starts = sorted(set_starts or [])
    laps = []
    for a, b in itertools.pairwise(edges):
        sel = (t >= a) & (t < b)
        if not np.any(sel):
            continue
        lap = lap_at.get(round(a, 3))
        tyre_lap = None
        on = [x for x in starts if x <= a + SET_START_SLACK_S]
        if on:
            tyre_lap = 1 + sum(1 for x in crossings if on[-1] + SET_START_SLACK_S < x <= a + 1e-6)
        span = slice(int(a * MASTER_HZ), min(int(b * MASTER_HZ), len(v)))
        fast = v[span] > RACING_KMH
        row = {"lap": lap.number if lap else None, "start_s": round(a, 2), "time_s": lap.time if lap else None,
               "clean": bool(lap.clean) if lap else False, "tyre_lap": tyre_lap,
               "samples": int(np.count_nonzero(sel)), "corners": len(np.unique(s.corner[0][sel]))}
        for axle, al, mu in (("front", s.alpha_f[0], s.mu_f[0]), ("rear", s.alpha_r[0], s.mu_r[0])):
            temp, bar = _axle_state(c, span, fast, axle)
            row[axle] = {"temp_c": _r(temp, 1), "bar": _r(bar, 3), **_bands(al[sel], mu[sel])}
        laps.append(row)
    info = s.sessions[0]
    return {
        "version": VERSION,
        "samples": info["samples"], "corners": info["corners"], "corners_dropped": info["corners_dropped"],
        "yaw_rate_scale": info["yaw_rate_scale"], "steering": info["steering"],
        "speed_kmh": [round(float(x)) for x in np.percentile(s.speed_kmh[0], [5, 95])],
        "lap_source": data.lap_source,
        "loads": {"mass_kg": car.mass_kg, "front_weight_fraction": car.front_weight_fraction,
                  "cog_height_mm": car.cog_height_mm, "wheelbase_mm": car.wheelbase_mm,
                  "downforce_n": car.downforce_n, "aero_balance_front": car.aero_balance_front,
                  "aero_ref_speed_kmh": car.aero_ref_speed_kmh},
        "laps": laps,
    }


# ---------- many summaries -> model ----------

@dataclass
class Entry:
    """One summarised log in the pool, with what the model reports about it."""
    summary: dict
    session_id: int
    name: str
    track: str | None = None
    date: str | None = None  # ISO date of the log
    ambient_c: float | None = None
    tyre: str | None = None


@dataclass
class Rows:
    """Every (lap, axle, band) of the pool as flat arrays, for one axle."""
    seg: np.ndarray  # which lap (index into Pool.laps)
    ent: np.ndarray  # which session (index into Pool.entries)
    band: np.ndarray
    n: np.ndarray
    mu: np.ndarray
    alpha: np.ndarray  # median slip angle, deg, after the session's shift
    iqr: np.ndarray


@dataclass
class Pool:
    entries: list[Entry]
    laps: list[dict] = field(default_factory=list)  # each lap's row, with "entry" (index into entries)
    rows: dict[str, Rows] = field(default_factory=dict)
    shifts: dict[str, np.ndarray] = field(default_factory=dict)  # per entry, deg


def _pool(entries: list[Entry]) -> Pool:
    p = Pool(entries)
    cols: dict[str, dict[str, list]] = {ax: {k: [] for k in ("seg", "ent", "band", "n", "mu", "alpha", "iqr")}
                                         for ax in AXLE_WHEELS}
    for e, entry in enumerate(entries):
        for lap in entry.summary["laps"]:
            k = len(p.laps)
            p.laps.append({**lap, "entry": e})
            for ax in AXLE_WHEELS:
                d = lap[ax]
                cols[ax]["seg"] += [k] * len(d["b"])
                cols[ax]["ent"] += [e] * len(d["b"])
                for key, src in (("band", "b"), ("n", "n"), ("mu", "mu"), ("alpha", "a"), ("iqr", "q")):
                    cols[ax][key] += d[src]
    for ax, cc in cols.items():
        p.rows[ax] = Rows(*(np.array(cc[k], int) for k in ("seg", "ent", "band")),
                          *(np.array(cc[k], float) for k in ("n", "mu", "alpha", "iqr")))
    _align(p)
    return p


def _band_points(r: Rows, weight: np.ndarray | None = None) -> tuple[np.ndarray, ...]:
    """Per band of mu: pooled slip angle (deg), mean mu and sample count. weight multiplies each row's count."""
    w = r.n if weight is None else r.n * weight
    if not len(w) or not np.any(w > 0):
        return (np.empty(0),) * 4
    nb = int(r.band.max()) + 1
    cnt = np.bincount(r.band, w, nb)
    ok = cnt > 0
    alpha = np.bincount(r.band, w * r.alpha, nb)[ok] / cnt[ok]
    mu = np.bincount(r.band, w * r.mu, nb)[ok] / cnt[ok]
    return np.flatnonzero(ok), alpha, mu, cnt[ok]


def _weighted_median(x: np.ndarray, w: np.ndarray) -> float:
    o = np.argsort(x)
    cw = np.cumsum(w[o])
    return float(x[o][np.searchsorted(cw, cw[-1] / 2)])


def _align(p: Pool) -> None:
    """Shift each session's slip angles onto the pool at low load (module docstring, step 1)."""
    for ax, r in p.rows.items():
        shifts = np.zeros(len(p.entries))
        if len(p.entries) >= 2 and len(r.n):
            raw = r.alpha.copy()
            ent = r.ent
            for _ in range(2):
                bands, pooled, _, _ = _band_points(r)
                ref = np.full(int(r.band.max()) + 1, np.nan)
                ref[bands] = pooled
                low = (r.band * BAND_MU >= ALIGN_MU[0]) & ((r.band + 1) * BAND_MU <= ALIGN_MU[1] + 1e-9)
                weights = np.array([r.n[low & (ent == e)].sum() for e in range(len(p.entries))])
                have = weights >= MIN_BIN
                for e in np.flatnonzero(have):
                    sel = low & (ent == e)
                    shifts[e] += _weighted_median(r.alpha[sel] - ref[r.band[sel]], r.n[sel])
                if have.any():
                    shifts[have] -= np.average(shifts[have], weights=weights[have])
                r.alpha = raw - shifts[ent]
        p.shifts[ax] = shifts


def _curve_fit(a_deg: np.ndarray, m: np.ndarray, p0: np.ndarray | None = None) -> tuple[np.ndarray, np.ndarray]:
    return _fit_points(np.radians(a_deg), m, p0)


def _mu_points(r: Rows, weight: np.ndarray | None = None) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """The points the curve is fitted through: bands with at least MIN_BIN samples."""
    _, a, m, n = _band_points(r, weight)
    keep = n >= MIN_BIN
    return a[keep], m[keep], n[keep]


def _redraw(rng: np.random.Generator, ids: np.ndarray, size: int) -> np.ndarray:
    """ids drawn with replacement, as many as there are: how often each was drawn, per replicate (size x max id)."""
    draws = rng.integers(0, len(ids), (size, len(ids)))
    out = np.zeros((size, int(ids.max()) + 1))
    for i in range(size):
        out[i] = np.bincount(ids[draws[i]], minlength=out.shape[1])
    return out


def _units(r: Rows, min_sessions: int) -> tuple[np.ndarray, np.ndarray]:
    """What to redraw for a spread: whole sessions when there are enough of them (laps of one session share its
    conditions and its sensors' errors), else laps. Returns each row's unit and the units present."""
    ents = np.unique(r.ent)
    if len(ents) >= min_sessions:
        return r.ent, ents
    return r.seg, np.unique(r.seg)


def _quantiles(r: Rows, qs: list[float]) -> list[float]:
    """Slip angle quantiles of all samples, each row's samples spread evenly over its interquartile range."""
    lo, hi = r.alpha - r.iqr, r.alpha + r.iqr  # the middle half spans the IQR, so about 2 IQR for nearly all
    x = np.concatenate([np.linspace(a, b, 5) for a, b in zip(lo, hi, strict=True)]) if len(lo) else np.empty(0)
    w = np.repeat(r.n / 5, 5)
    o = np.argsort(x)
    cw = np.cumsum(w[o])
    return [float(x[o][np.searchsorted(cw, q * cw[-1])]) for q in qs]


def _axle_fit(r: Rows, rng: np.random.Generator) -> dict:
    a, m, _n = _mu_points(r)
    if len(a) < 5:
        raise NotEnoughData("The cornering covers too narrow a range of load to fit a curve; use laps at pace")
    p, free = _curve_fit(a, m)
    spread = {}
    unit, units = _units(r, 5)
    if len(units) >= 5:
        boot = []
        for w in _redraw(rng, units, BOOT_CURVE):
            ba, bm, _ = _mu_points(r, w[unit])
            if len(ba) >= 5:
                boot.append(_curve_fit(ba, bm, p.copy())[0])
        if len(boot) >= 10:
            lo, hi = np.percentile(np.array(boot), [10, 90], axis=0)
            spread = {"peak_mu_range": [round(float(lo[0]), 3), round(float(hi[0]), 3)],
                      "slip_at_peak_range_deg": [round(float(np.degrees(lo[1])), 2),
                                                 round(float(np.degrees(hi[1])), 2)]}
    res = m - magic_formula(np.radians(a), *p)
    total = float(np.var(m))
    d, ap, c, sh = p
    stiffness = d * c * np.tan(np.pi / (2 * c)) / ap
    # scatter of the slip angle in each band: the laps' own spread and the spread between their medians
    bands, pooled, _, cnt = _band_points(r)
    nb = int(r.band.max()) + 1
    centre = np.zeros(nb)
    centre[bands] = pooled
    var = r.n * ((r.iqr / 1.349) ** 2 + (r.alpha - centre[r.band]) ** 2)
    sd_band = np.sqrt(np.bincount(r.band, var, nb)[bands] / cnt)
    return {
        "peak_mu": round(float(d), 3),
        "slip_at_peak_deg": round(float(np.degrees(ap)), 2),
        "shape": round(float(c), 3),
        "shape_fitted": bool(free[2]),
        "slip_offset_deg": round(float(np.degrees(sh)), 2),
        "peak_reached": bool(m.max() >= 0.95 * d),
        "cornering_stiffness_mu_per_deg": round(float(np.radians(stiffness)), 4),
        **spread,
        "samples": int(r.n.sum()),
        "load_bins": len(a),
        "rmse_mu": round(float(np.sqrt(np.mean(res**2))), 4),
        "r2": round(1 - float(np.mean(res**2)) / total, 3) if total > 0 else None,
        "slip_scatter_deg": round(float(np.median(sd_band[cnt >= MIN_BIN])), 2) if np.any(cnt >= MIN_BIN) else None,
        "slip_range_deg": [round(x, 2) for x in _quantiles(r, [0.01, 0.99])],
        "mu_observed_max": round(float(m.max()), 3),
        "slip_at_mu_max_deg": round(float(a[int(np.argmax(m))]), 2),
        "note": _note(float(m.max()), d, ap),
        "params": p,
    }


# ----- grip against conditions -----

@dataclass
class Reference:
    """The pool's slip angle in each band of mu, and what one degree less slip there is worth in grip."""
    alpha: np.ndarray  # deg, nan where the pool has too few samples or the band is below GRIP_MU
    per_deg: np.ndarray  # relative grip per degree of slip saved: the curve's slope over its mu


def _reference(r: Rows, p: np.ndarray) -> Reference:
    nb = int(r.band.max()) + 1
    bands, a, m, n = _band_points(r)
    alpha = np.full(nb, np.nan)
    per_deg = np.zeros(nb)
    ok = (n >= MIN_BIN) & (bands * BAND_MU >= GRIP_MU - 1e-9)
    h = np.radians(0.05)
    x = np.radians(a[ok])
    slope = (magic_formula(x + h, *p) - magic_formula(x - h, *p)) / (2 * np.degrees(h))
    alpha[bands[ok]] = a[ok]
    per_deg[bands[ok]] = slope / m[ok]
    return Reference(alpha, per_deg)


def _group_points(r: Rows, nb: int, weight: np.ndarray | None = None) -> tuple[np.ndarray, np.ndarray]:
    """The group's slip angle in each band of mu, and its samples there (0 where too few to count). With a 2-D
    weight (replicates x rows), every replicate's come back as rows."""
    w2 = np.atleast_2d(r.n if weight is None else r.n * weight)
    cnt = np.stack([np.bincount(r.band, x, nb) for x in w2])
    num = np.stack([np.bincount(r.band, x * r.alpha, nb) for x in w2])
    with np.errstate(invalid="ignore", divide="ignore"):
        a = np.nan_to_num(num / cnt)
    n = np.where(cnt >= MIN_GRIP_BAND, cnt, 0.0)
    return (a[0], n[0]) if weight is None or np.ndim(weight) == 1 else (a, n)


def _grip(a: np.ndarray, n: np.ndarray, ref: Reference) -> np.ndarray:
    """Grip against the pool at the same slip angle: in each band the slip the group needed against the pool's,
    turned into grip by the curve's slope there, averaged over the group's samples (last axis)."""
    use = np.where(np.isfinite(ref.alpha), n, 0.0)
    gain = -ref.per_deg * (a - np.nan_to_num(ref.alpha))
    with np.errstate(invalid="ignore", divide="ignore"):
        return np.sum(use * gain, axis=-1) / np.sum(use, axis=-1)


def _subset(r: Rows, segs: np.ndarray) -> Rows:
    sel = np.isin(r.seg, segs)
    return Rows(r.seg[sel], r.ent[sel], r.band[sel], r.n[sel], r.mu[sel], r.alpha[sel], r.iqr[sel])


def _group_grip(r: Rows, ref: Reference, rng: np.random.Generator) -> dict | None:
    """A group's grip against the average, and its spread when its sessions are redrawn (none from fewer than
    MIN_SESSIONS_REDRAW sessions: the laps of one session can't show how much another would differ)."""
    nb = len(ref.alpha)
    a, n = _group_points(r, nb)
    counted = np.where(np.isfinite(ref.alpha), n, 0.0)
    if np.count_nonzero(counted) < MIN_GROUP_BANDS or counted.sum() < MIN_GROUP_SAMPLES:
        return None
    out = {"grip": round(float(_grip(a, n, ref)), 4), "low": None, "high": None, "samples": int(counted.sum())}
    ents = np.unique(r.ent)
    if len(ents) >= MIN_SESSIONS_REDRAW:
        ba, bn = _group_points(r, nb, _redraw_nested(rng, r, BOOT_GRIP))
        gs = _grip(ba, bn, ref)
        enough = np.count_nonzero(np.where(np.isfinite(ref.alpha), bn, 0.0), axis=-1) >= MIN_GROUP_BANDS
        gs = gs[np.isfinite(gs) & enough]
        if len(gs) >= BOOT_GRIP // 2:
            lo, hi = np.percentile(gs, SPREAD_PCT)
            out.update(low=_r(lo, 4), high=_r(hi, 4))
    return out


def _redraw_nested(rng: np.random.Generator, r: Rows, size: int) -> np.ndarray:
    """Sessions drawn with replacement, then laps within each drawn session: the weight of every row, per
    replicate (size x rows). Both the sessions and the laps (which corners passed the steady-cornering test, each
    with its own body-slip error) vary from one group to the next."""
    ents = np.unique(r.ent)
    per_session = _redraw(rng, ents, size)  # size x max entry
    lap_w = np.zeros((size, int(r.seg.max()) + 1))
    for e in ents:
        laps = np.unique(r.seg[r.ent == e])
        trials = (per_session[:, e] * len(laps)).astype(int)
        lap_w[:, laps] = rng.multinomial(trials, np.full(len(laps), 1 / len(laps)))
    return lap_w[:, r.seg]


def _bins(values: np.ndarray, spec: dict) -> list[tuple[float, float]]:
    ok = values[np.isfinite(values)]
    if not len(ok):
        return []
    if "edges" in spec:
        e = spec["edges"]
        return [(float(a), float(b)) for a, b in itertools.pairwise(e) if np.any((ok >= a) & (ok < b))]
    # about the same number of laps in each group, edges on round values
    step = spec["step"]
    k = int(np.clip(len(ok) // LAPS_PER_BIN, 2, MAX_BINS))
    inner = np.round(np.quantile(ok, np.linspace(0, 1, k + 1)[1:-1]) / step)
    edges = np.unique([math.floor(ok.min() / step + 1e-9), *inner, math.floor(ok.max() / step + 1e-9) + 1])
    return [(round(float(a) * step, 3), round(float(b) * step, 3)) for a, b in itertools.pairwise(edges)]


def _usable(bins: list[dict]) -> list[dict]:
    """The groups that take part in a window: those with a range (from at least MIN_SESSIONS_REDRAW sessions)."""
    return [b for b in bins if b["low"] is not None]


def _confidence(base: str, held: int, of: int) -> str:
    """A window's confidence once it has been refitted with each of its sessions left out: it keeps "high" only when
    nearly every refit still shows it (HOLD_HIGH), is at most "medium" when most do (HOLD_MEDIUM), else "low"."""
    if base == "none":
        return "none"
    share = held / of if of else 0.0
    if share >= HOLD_HIGH - 1e-9:
        return base
    if share >= HOLD_MEDIUM - 1e-9:
        return "medium"
    return "low"


def _window(bins: list[dict], spec: dict, axle: str, held: tuple[int, int] | None = None) -> dict | None:
    """The groups around the best one that are not clearly worse than it, and how sure that is.

    Clearly worse: the group's whole range lies below the best one's range, and its grip is at least MIN_GAIN
    below the best. Confidence is "high" when two groups or more are clearly worse and the window rests on at
    least 5 sessions and 30 laps, "medium" when one is, and "none" when none is, or when a group beyond a clearly
    worse one is not worse itself (grip going up and down is scatter, not a window): then grip did not clearly
    change with the condition. held: in how many of how many refits with one session left out the window is still
    there (_left_out); the confidence then follows _confidence and the text says so."""
    usable = _usable(bins)
    if len(usable) < 2:
        return None
    best = max(usable, key=lambda b: b["grip"])
    floor = best["low"]

    def clearly_worse(b: dict) -> bool:
        return b["high"] < floor and best["grip"] - b["grip"] >= MIN_GAIN - 1e-9

    lo_i = hi_i = next(i for i, b in enumerate(usable) if b is best)
    while lo_i > 0 and not clearly_worse(usable[lo_i - 1]):
        lo_i -= 1
    while hi_i < len(usable) - 1 and not clearly_worse(usable[hi_i + 1]):
        hi_i += 1
    inside = usable[lo_i:hi_i + 1]
    worse = [b for b in usable if clearly_worse(b)]
    stray = [b for i, b in enumerate(usable) if not lo_i <= i <= hi_i and not clearly_worse(b)]
    apart = [b for b in usable if b["high"] < floor]
    sessions = len(set().union(*(set(b["session_ids"]) for b in inside)))
    laps = sum(b["laps"] for b in inside)
    if stray or not worse:
        confidence = "none"
    elif len(worse) >= 2 and sessions >= 5 and laps >= 30:
        confidence = "high"
    else:
        confidence = "medium"
    edge = "low" if lo_i == 0 and hi_i < len(usable) - 1 else "high" if hi_i == len(usable) - 1 and lo_i > 0 \
        else None
    out = {"from": inside[0]["from"], "to": inside[-1]["to"], "open": edge, "grip": best["grip"],
           "confidence": confidence, "sessions": sessions, "laps": laps}
    if confidence == "none":
        spread = max(b["grip"] for b in usable) - min(b["grip"] for b in usable)
        why = ("up and down with no one range best" if stray and worse
               else f"under {MIN_GAIN * 100:.0f} %, too little to act on" if apart else "inside their scatter")
        over = _where(spec, usable[0]["from"], usable[-1]["to"], bare=True)
        out["text"] = (f"{axle.capitalize()}: no clear change with {spec['noun']} over {over}: the groups differ by "
                       f"up to {spread * 100:.0f} %, {why} ({sum(b['laps'] for b in usable)} laps).")
        return out
    # the window's grip against the clearly worse groups', each averaged over its samples (the best group alone
    # would overstate it: it is the highest of several noisy groups)
    out["gain"] = round(_mean_grip(inside) - _mean_grip(worse), 4)
    below = [b for b in worse if b["to"] <= inside[0]["from"]]
    above = [b for b in worse if b["from"] >= inside[-1]["to"]]
    sides = " and ".join(_where(spec, g[0]["from"], g[-1]["to"], lead=True) for g in (below, above) if g)
    where = _where(spec, inside[0]["from"], inside[-1]["to"], edge, lead=True)
    basis, check = f"{laps} laps from {sessions} sessions", ""
    if held is not None:
        out["held"], out["of"] = held
        confidence = out["confidence"] = _confidence(confidence, *held)
        check = ("; still there with any one session left out" if held[0] == held[1]
                 else f"; still there in {held[0]} of {held[1]} fits that leave one session out")
    if confidence == "low":
        out["text"] = (f"{axle.capitalize()}: maybe more grip {where}, about {out['gain'] * 100:.0f} % more than "
                       f"{sides}, but only {held[0]} of {held[1]} fits that leave one session out still show it, so "
                       f"it rests on a few runs ({basis}; low confidence).")
    else:
        out["text"] = (f"{axle.capitalize()}: most grip {where}, about {out['gain'] * 100:.0f} % more than {sides} "
                       f"({basis}{check}; {confidence} confidence).")
    return out


def _mean_grip(groups: list[dict]) -> float:
    return sum(b["grip"] * b["samples"] for b in groups) / sum(b["samples"] for b in groups)


def _num(spec: dict, x: float) -> str:
    return f"{x:.2f}" if spec["unit"] == "bar" else f"{x:.0f}"


def _where(spec: dict, a: float, b: float, edge: str | None = None, bare: bool = False, lead: bool = False) -> str:
    """A range of the condition in words; edge "low" or "high" when it runs to the edge of what was seen (the best
    may lie beyond it). bare: without naming the temperature or the tyre, when the sentence already does. lead:
    with the preposition in front ("at 1.80 bar hot", "in the first 4 laps on the tyre")."""
    if spec["unit"] == "laps":
        first, last = int(a), int(b) - 1
        tyre = "" if bare else " on the tyre"
        if edge == "low":
            text = "in " * lead + ("the first lap" if last == 1 else f"the first {last} laps") + tyre
        elif edge == "high" or last >= 999:
            text = f"{'from ' * lead}lap {first}{tyre} {'onwards' if lead else 'and later'}"
        else:
            text = "in " * lead + (f"lap {first}" if last == first else f"laps {first}-{last}") + tyre
        return text
    unit = spec["unit"]
    suffix = " hot" if unit == "bar" else "" if bare else " TPMS temperature"
    if edge == "low":
        text = f"{_num(spec, b)} {unit}{suffix} or {'less' if unit == 'bar' else 'cooler'}"
    elif edge == "high":
        text = f"{_num(spec, a)} {unit}{suffix} or {'more' if unit == 'bar' else 'hotter'}"
    else:
        text = f"{_num(spec, a)}-{_num(spec, b)} {unit}{suffix}"
    return "at " * lead + text


def _groups(p: Pool, ax: str, ref: Reference, spec: dict, rng: np.random.Generator) -> list[dict]:
    """The laps grouped by one condition, each group's grip against the pool and its range."""
    r = p.rows[ax]
    vals = np.array([np.nan if (x := (lap[ax][spec["key"]] if spec["key"] != "tyre_lap" else lap["tyre_lap"]))
                     is None else float(x) for lap in p.laps])
    bins = []
    for lo, hi in _bins(vals, spec):
        segs = np.flatnonzero((vals >= lo - 1e-9) & (vals < hi - 1e-9))
        sub = _subset(r, segs)
        laps_used = np.unique(sub.seg)
        row = {"from": lo, "to": hi, "laps": len(laps_used),
               "session_ids": sorted({p.entries[p.laps[s]["entry"]].session_id for s in laps_used}),
               "grip": None, "low": None, "high": None, "samples": 0}
        if len(laps_used) >= MIN_GROUP_LAPS:
            g = _group_grip(sub, ref, rng)
            if g:
                row.update(g)
        bins.append(row)
    while bins and bins[0]["grip"] is None:
        bins.pop(0)
    while bins and bins[-1]["grip"] is None:
        bins.pop()
    for b in bins:
        b["sessions"] = len(b["session_ids"])
    return bins


def _conditions(p: Pool, fits: dict[str, dict], rng: np.random.Generator, seed: int) -> dict:
    refs = {ax: _reference(r, fits[ax]["params"]) for ax, r in p.rows.items()}
    out, found = {}, []
    for name, spec in CONDITIONS.items():
        cond = {"label": spec["label"], "unit": spec["unit"], "note": spec["note"]}
        for ax in p.rows:
            bins = _groups(p, ax, refs[ax], spec, rng)
            w = _window(bins, spec, ax)
            cond[ax] = {"bins": bins, "window": w}
            if w is not None and w["confidence"] != "none":
                found.append((name, ax))
        out[name] = cond
    held = _left_out(p, fits, out, found, seed)
    for name, ax in found:
        c = out[name][ax]
        c["window"] = _window(c["bins"], CONDITIONS[name], ax, held[(name, ax)])
    for cond in out.values():
        for ax in p.rows:
            for b in cond[ax]["bins"]:
                del b["session_ids"]
    return out


def _left_out(p: Pool, fits: dict[str, dict], out: dict, found: list[tuple[str, str]],
              seed: int) -> dict[tuple[str, str], tuple[int, int]]:
    """Each window found, fitted again from the start with each of its sessions left out in turn (lined up, curve,
    groups, ranges): in how many of those refits it is still there, its best group inside the same range. A finding
    one or two sessions carry fails this, even when the ranges of the full fit look clear. Every refit has its own
    fixed seed, so the same data always give the same answer."""
    sessions = {key: sorted(set().union(*(b["session_ids"] for b in _usable(out[key[0]][key[1]]["bins"]))))
                for key in found}
    held = dict.fromkeys(found, 0)
    for i, sid in enumerate(sorted(set().union(*sessions.values()))):
        rest = [e for e in p.entries if e.session_id != sid]
        if not rest:
            continue
        q = _pool(rest)
        refs: dict[str, Reference | None] = {}
        for name, ax in found:
            if sid not in sessions[(name, ax)]:
                continue
            if ax not in refs:
                a, m, _ = _mu_points(q.rows[ax])
                refs[ax] = _reference(q.rows[ax], _curve_fit(a, m, fits[ax]["params"].copy())[0]) \
                    if len(a) >= 5 else None
            if refs[ax] is None:
                continue
            rng = np.random.default_rng([seed, i, list(CONDITIONS).index(name), list(AXLE_WHEELS).index(ax)])
            bins = _groups(q, ax, refs[ax], CONDITIONS[name], rng)
            w = _window(bins, CONDITIONS[name], ax)
            if w is None or w["confidence"] == "none":
                continue
            best = max(_usable(bins), key=lambda b: b["grip"])
            full = out[name][ax]["window"]
            if full["from"] - 1e-9 <= (best["from"] + best["to"]) / 2 <= full["to"] + 1e-9:
                held[(name, ax)] += 1
    return {key: (held[key], len(sessions[key])) for key in found}


# ----- the whole model -----

def _peak_text(axle: str, f: dict) -> str:
    rng = f.get("peak_mu_range")
    if f["peak_reached"]:
        spread = f" ({rng[0]:.2f}-{rng[1]:.2f})" if rng else ""
        srange = f.get("slip_at_peak_range_deg")
        sspread = "" if not srange else f" ({srange[0]:.1f}° or more)" if srange[1] >= SLIP_BOUND_DEG - 0.05 \
            else f" ({srange[0]:.1f}-{srange[1]:.1f}°)"
        return (f"{axle.capitalize()}: grip peaks at mu {f['peak_mu']:.2f}{spread} at {f['slip_at_peak_deg']:.1f}° "
                f"of slip{sspread}; past that it falls away.")
    return (f"{axle.capitalize()}: the peak is not in the data yet: at the most grip seen, mu "
            f"{f['mu_observed_max']:.2f}, it ran {f['slip_at_mu_max_deg']:.1f}° of slip and grip was still rising.")


def _dates(entries: list[Entry]) -> list[str]:
    ds = sorted(e.date for e in entries if e.date)
    return [ds[0], ds[-1]] if ds else []


def fit_model(entries: list[Entry], seed: int = 0) -> dict:
    """The tyre model of the pooled summaries: curve per axle, grip against conditions, advice and its basis. The
    redraws use the fixed seed, so the same summaries always give the same model."""
    entries = [e for e in entries if e.summary.get("laps")]
    if not entries:
        raise NotEnoughData("No summarised session with steady cornering for this car and tyre yet.")
    p = _pool(entries)
    samples = int(sum(e.summary["samples"] for e in entries))
    corners = int(sum(e.summary["corners"] for e in entries))
    if samples < MIN_SAMPLES or corners < MIN_CORNERS:
        raise NotEnoughData(
            f"Not enough quasi-steady cornering to fit a tyre curve: found {samples} samples in {corners} corners, "
            f"need at least {MIN_SAMPLES} samples ({MIN_SAMPLES / MASTER_HZ:.0f} s) in {MIN_CORNERS} corners.")
    rng = np.random.default_rng(seed)
    fits = {ax: _axle_fit(r, rng) for ax, r in p.rows.items()}
    binned = {}
    for ax, r in p.rows.items():
        a, m, n = _mu_points(r)
        binned[ax] = {"alpha_deg": np.round(a, 3).tolist(), "mu": np.round(m, 4).tolist(),
                      "count": n.astype(int).tolist()}
    top = max(max(f["slip_range_deg"][1], min(f["slip_at_peak_deg"] * 1.3, 2 * f["slip_range_deg"][1]))
              for f in fits.values())
    grid = np.linspace(0, top, 61)
    curves = {"alpha_deg": np.round(grid, 3).tolist()}
    for ax, f in fits.items():
        curves[ax] = np.round(magic_formula(np.radians(grid), *f["params"]), 4).tolist()
    conditions = _conditions(p, fits, rng, seed)
    for f in fits.values():
        del f["params"]

    laps_used = [lap for lap in p.laps if lap["samples"] > 0]
    ambients = [e.ambient_c for e in entries if e.ambient_c is not None]
    speeds = np.array([e.summary["speed_kmh"] for e in entries], float)
    basis = {
        "sessions": len(entries), "laps": len(laps_used), "samples": samples, "corners": corners,
        "tracks": sorted({e.track for e in entries if e.track}), "dates": _dates(entries),
        "ambient_c": [min(ambients), max(ambients)] if ambients else None,
        "speed_range_kmh": [int(speeds[:, 0].min()), int(speeds[:, 1].max())],
        "with_tpms": sum(1 for lap in laps_used if lap["front"]["temp_c"] is not None),
        "with_tyre_laps": sum(1 for lap in laps_used if lap["tyre_lap"] is not None),
    }
    for ax, f in fits.items():
        f["advice"] = _peak_text(ax, f)
    advice = [f["advice"] for f in fits.values()]
    for name in ("temperature", "pressure", "tyre_laps"):
        for ax in AXLE_WHEELS:
            w = conditions[name][ax]["window"]
            if w is not None:
                advice.append(w["text"])
    sessions = []
    for e, entry in enumerate(entries):
        s = entry.summary
        sessions.append({
            "session_id": entry.session_id, "name": entry.name, "track": entry.track, "date": entry.date,
            "tyre": entry.tyre, "ambient_c": entry.ambient_c,
            "laps": sum(1 for lap in s["laps"] if lap["samples"] > 0), "samples": s["samples"],
            "slip_shift_deg": {ax: round(float(p.shifts[ax][e]), 2) for ax in AXLE_WHEELS},
            "yaw_rate_scale": s["yaw_rate_scale"], "steering": s["steering"],
        })
    loads = entries[0].summary["loads"]
    return {
        "basis": basis,
        "advice": advice,
        "axles": fits,
        "curves": curves,
        "binned": binned,
        "conditions": conditions,
        "sessions": sessions,
        "loads": loads,
        "assumptions": [
            "Every log is summarised once: its steady-cornering samples, lap by lap, binned by grip level.",
            "Axle curves: each mu includes both tyres, their load transfer, camber and compliance.",
            f"Car values as in the preset ({loads['mass_kg']:.0f} kg, {loads['front_weight_fraction'] * 100:.0f} % "
            "front); the single-log fit takes your own.",
            "Each session's slip angles are shifted to line up with the others at low load (mu 0.3-0.9): the "
            "body-slip estimate carries an offset that differs from log to log.",
            f"Grip against a condition: in each band of mu from {GRIP_MU:.1f} up, the slip angle the group's laps "
            "needed against all laps', turned into grip by the curve's slope. The range is the middle 90 % when "
            "the sessions, and the laps within them, are redrawn; a group from fewer than "
            f"{MIN_SESSIONS_REDRAW} sessions gets none.",
            "A range has the most grip only when the groups beside it are clearly worse: their whole range below "
            f"the best group's and at least {MIN_GAIN * 100:.0f} % less grip. The model is then fitted again with "
            "each of its sessions left out in turn. Confidence is high with two such groups, 5 sessions and 30 laps, "
            f"when at least {HOLD_HIGH * 100:.0f} % of those refits still show the range; medium when "
            f"{HOLD_MEDIUM * 100:.0f} % do; low when fewer do, as it then rests on a few runs.",
            "The redraws use a fixed seed: the same sessions always give the same answer.",
            "TPMS temperature is the sensor inside the tyre, not the tread surface.",
            "Laps on the tyre count from the cold start the TPMS shows in the log; earlier use of the set is not "
            "in the log.",
            f"The shape is held at {DEFAULT_SHAPE} for an axle whose data stop short of 95 % of its peak.",
        ],
    }
