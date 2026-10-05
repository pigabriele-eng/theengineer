"""Lap time opportunities, driving trends, setup weaknesses and driver scores from any set of laps.

No reference lap is needed. The car's own laps give its limits (limits.py); the fastest lap's line driven at
those limits everywhere gives the theoretical lap (lapsim.py). Every lap is then measured against that, corner
by corner and phase by phase, and the laps are compared with each other to find what the quick ones do.
"""
from __future__ import annotations

import math
from itertools import pairwise
from dataclasses import dataclass, field

import numpy as np

from app.analysis.align import TrackLine, aligned_trace, track_line
from app.analysis.channels import BRAKE, EXIT, MID, PHASES, POWER, TRAIL, math_channels
from app.analysis.laps import SessionData, detect_corners, lap_length
from app.analysis.lapsim import LIMITED_BY, SimLap, theoretical_lap
from app.analysis.limits import CarLimits, car_limits
from app.analysis.scan import channel_scan
from app.importers.motec import LdFile

GROUP_WITHIN_M = 150  # official corners this close to a corner's slowest point share its section
STRAIGHT_MIN_M = 250  # full throttle for at least this long makes a straight with a speed trap
MEDALS = (("gold", 98.0), ("silver", 97.0), ("bronze", 95.0))  # % of the theoretical lap
MIN_LAPS_FOR_TRENDS = 8
LIMIT_LAPS_WITHIN = 0.02  # the car's limits come from laps this close to the quickest
MIN_LIMIT_LAPS = 3
SIGNIFICANT_P = 0.01


@dataclass
class RunInput:
    name: str
    data: SessionData
    driver: str | None = None
    meta: dict = field(default_factory=dict)
    ld: LdFile | None = None  # the raw log, to scan every channel it recorded


@dataclass
class Section:
    code: str
    start: int
    end: int
    apex: int | None  # slowest point, or None for a section without a real corner

    def to_dict(self) -> dict:
        return {"code": self.code, "start_m": self.start, "end_m": self.end, "apex_m": self.apex}


@dataclass
class LapRecord:
    run: str
    number: int
    time: float
    driver: str | None
    trace: dict[str, np.ndarray]
    index_in_run: int  # 0 for the run's first clean lap: a stand-in for tyre age and fuel burn
    own_sim: SimLap | None = None

    @property
    def key(self) -> str:
        return f"{self.run}#{self.number}"


@dataclass
class Prepared:
    line: TrackLine | None
    length: int
    reference: LapRecord
    laps: list[LapRecord]
    limits: CarLimits
    sim: SimLap  # the reference line at the car's limits
    sections: list[Section]
    numbering: str  # "official" when the track's corner numbers were used, else "detected"


# ---------- preparation ----------

def prepare(runs: list[RunInput], corners: list[tuple[str, float]] | None = None) -> Prepared | None:
    """Traces on one line for every clean lap, the car's limits and the theoretical lap."""
    for r in runs:
        if "phase" not in r.data.channels:
            math_channels(r.data)
    clean = [(r, l) for r in runs for l in r.data.laps if l.clean]
    if not clean:
        return None
    ref_run, ref_lap = min(clean, key=lambda rl: rl[1].time)
    line = track_line(ref_run.data, ref_lap)
    length = line.length if line is not None else round(lap_length(ref_run.data, ref_lap))
    laps = []
    for r in runs:
        for i, l in enumerate(x for x in r.data.laps if x.clean):
            tr = aligned_trace(r.data, l, line, length)
            laps.append(LapRecord(r.name, l.number, l.time, r.driver, tr, i))
    reference = next(x for x in laps if x.run == ref_run.name and x.number == ref_lap.number)
    limits = car_limits([x.trace for x in _limit_laps(laps)])
    sim = _closed_sim(reference.trace["curvature"], limits)
    for x in laps:
        x.own_sim = _closed_sim(x.trace["curvature"], limits)
    sections, numbering = make_sections(reference.trace, corners)
    return Prepared(line, len(reference.trace["distance"]), reference, laps, limits, sim, sections, numbering)


def _limit_laps(laps: list[LapRecord]) -> list[LapRecord]:
    """The laps that show what the car can do: a slower driver, a wet run or worn tyres must not lower it.

    Adding slower laps never changes the limits; adding quicker ones raises them, as it should.
    """
    quick = sorted(laps, key=lambda x: x.time)
    cut = quick[0].time * (1 + LIMIT_LAPS_WITHIN)
    return [x for i, x in enumerate(quick) if x.time <= cut or i < MIN_LIMIT_LAPS]


def _closed_sim(curvature: np.ndarray, limits: CarLimits) -> SimLap:
    """Traces include the timing line at both ends; simulate the loop once and repeat the line point."""
    sim = theoretical_lap(curvature[:-1], limits)
    return SimLap(np.append(sim.speed, sim.speed[0]), np.append(sim.t, sim.time), sim.time,
                  np.append(sim.limited_by, sim.limited_by[0]))


def _label(codes: list[str]) -> str:
    if len(codes) == 1:
        return codes[0]
    if len(codes) == 2:
        return f"{codes[0]}/{codes[1]}"
    return f"{codes[0]}-{codes[-1]}"


def make_sections(ref: dict[str, np.ndarray], corners: list[tuple[str, float]] | None = None
                  ) -> tuple[list[Section], str]:
    """Split the lap at the fast points between corners.

    With the track's official corners, each section carries the official numbers inside it, grouped like
    "T8/T9" or "T2-T4"; a flat-out kink far from any slow point gets its own section. Without them, the
    slowest points are numbered C1, C2... so they are never mistaken for official numbers.
    """
    found = detect_corners(ref)
    n = len(ref["speed"])
    if not found:
        return [Section("Lap", 0, n - 1, None)], "detected"
    if not corners:
        secs = [Section(f"C{i + 1}", c.start, c.end, c.apex) for i, c in enumerate(found)]
        return secs, "detected"
    official = sorted(((code, int(apex)) for code, apex in corners if apex is not None and 0 <= apex < n),
                      key=lambda c: c[1])
    secs: list[Section] = []
    for c in found:
        inside = [(code, a) for code, a in official if c.start <= a < c.end or (c is found[-1] and a >= c.start)]
        near = [x for x in inside if abs(x[1] - c.apex) <= GROUP_WITHIN_M]
        far = [x for x in inside if abs(x[1] - c.apex) > GROUP_WITHIN_M]
        if not near and secs and not far:  # a slow point the track map has no number for: part of the last one
            secs[-1].end = c.end
            continue
        start = c.start
        before = [x for x in far if x[1] < c.apex]
        after = [x for x in far if x[1] > c.apex]
        if before:
            split = (before[-1][1] + (near[0][1] if near else c.apex)) // 2
            secs.append(Section(_label([x[0] for x in before]), start, split, None))
            start = split
        end = c.end
        if after:
            split = ((near[-1][1] if near else c.apex) + after[0][1]) // 2
            end = split
        secs.append(Section(_label([x[0] for x in near]) if near else f"C{len(secs) + 1}", start, end, c.apex))
        if after:
            secs.append(Section(_label([x[0] for x in after]), split, c.end, None))
    secs[0].start, secs[-1].end = 0, n - 1
    for a, b in pairwise(secs):
        b.start = a.end
    return secs, "official"


# ---------- per lap, per section ----------

def _dt(tr: dict[str, np.ndarray]) -> np.ndarray:
    t = tr["t"]
    return np.diff(t, append=t[-1] + (t[-1] - t[-2]))


def _first(mask: np.ndarray) -> int | None:
    i = np.flatnonzero(mask)
    return int(i[0]) if len(i) else None


def _wmean(v: np.ndarray, w: np.ndarray) -> float | None:
    s = float(w.sum())
    return float((v * w).sum() / s) if s > 0 else None


def section_metrics(x: LapRecord, s: Section, lim: CarLimits, sim: SimLap) -> dict:
    tr = x.trace
    a, b = s.start, s.end
    sl = slice(a, b)
    v = tr["speed"][sl]
    dt = _dt(tr)[sl]
    phase = np.rint(tr["phase"][sl]).astype(int)
    use = lim.use(v, tr["ax"][sl], tr["ay"][sl])
    apex = (s.apex if s.apex is not None else a + int(np.argmin(v))) - a
    m: dict = {
        "time": float(tr["t"][b] - tr["t"][a]),
        "sim_time": float(sim.t[b] - sim.t[a]),
        "entry_speed": float(v[0]), "min_speed": float(v.min()), "exit_speed": float(v[-1]),
        "max_speed": float(v.max()),
    }
    braking = tr["braking"][sl] > 0.5
    bp = _first(braking[: max(apex, 1)])
    m["brake_point"] = a + bp if bp is not None else None
    if "brake" in tr:
        m["peak_brake"] = float(tr["brake"][sl].max())
    for p, name in ((BRAKE, "braking"), (TRAIL, "trail"), (MID, "mid"), (EXIT, "exit")):
        w = dt * (phase == p)
        m[f"time_{name}"] = float(w.sum())
        m[f"grip_{name}"] = _wmean(use, w)
    braking_m = np.count_nonzero((phase == BRAKE) | (phase == TRAIL))
    m["trail_share"] = np.count_nonzero(phase == TRAIL) / braking_m if braking_m >= 10 else None
    grip_phases = phase < POWER
    m["grip_use"] = _wmean(use, dt * grip_phases)
    if "throttle" in tr:
        thr = tr["throttle"][sl]
        on = _first((thr > 20) & ~braking & (np.arange(len(v)) >= apex - 40))
        full = _first((thr > 95) & (np.arange(len(v)) >= (on if on is not None else apex)))
        m["throttle_on"] = a + on if on is not None else None
        m["full_throttle"] = a + full if full is not None else None
        m["coasting"] = float((dt * (tr["coasting"][sl] > 0.5)).sum())
        m["overlap"] = float((dt * (tr["overlap"][sl] > 0.5)).sum())
    for ch, name in (("tc_on", "tc"), ("abs_on", "abs")):
        if ch in tr:
            m[name] = float((dt * (tr[ch][sl] > 0.5)).sum())
    if "understeer" in tr:
        us = tr["understeer"][sl]
        for p, name in ((TRAIL, "entry"), (MID, "mid"), (EXIT, "exit")):
            sel = (phase == p) & (np.abs(tr["ay"][sl]) > 0.5)
            m[f"understeer_{name}"] = float(np.median(us[sel])) if np.count_nonzero(sel) >= 5 else None
    if "rear_slip" in tr:
        sel = phase == EXIT
        m["rear_slip_exit"] = float(np.percentile(tr["rear_slip"][sl][sel], 90)) if sel.sum() >= 5 else None
    on_brakes = (phase == BRAKE) | (phase == TRAIL)
    if "front_lock" in tr:
        m["front_lock"] = float(-np.percentile(tr["front_lock"][sl][on_brakes], 5)) if on_brakes.sum() >= 5 else None
    if "slide_rate" in tr:
        m["rear_rotation_braking"] = float(np.percentile(tr["slide_rate"][sl][on_brakes], 95)) \
            if on_brakes.sum() >= 5 else None
    if "steer" in tr:
        st = tr["steer"][sl]
        turn = np.abs(st).max()
        m["steering_activity"] = float(np.abs(np.diff(st)).sum() / turn) if turn > 0 else None
    return m


def _phase_losses(x: LapRecord, sim: SimLap, a: int, b: int) -> dict[str, float]:
    """Time the lap gives away to the theoretical lap, split by what the driver was doing at the time."""
    dt = _dt(x.trace)[a:b]
    st = np.diff(sim.t, append=sim.time)[a:b]
    phase = np.rint(x.trace["phase"][a:b]).astype(int)
    return {PHASES[p]: round(float((dt - st)[phase == p].sum()), 3) for p in range(len(PHASES))}


# ---------- statistics ----------

def corr(x: np.ndarray, y: np.ndarray) -> dict | None:
    x, y = np.asarray(x, float), np.asarray(y, float)
    ok = ~(np.isnan(x) | np.isnan(y))
    x, y = x[ok], y[ok]
    n = len(x)
    if n < MIN_LAPS_FOR_TRENDS or x.std() < 1e-9 or y.std() < 1e-9:
        return None
    r = float(np.corrcoef(x, y)[0, 1])
    z = math.atanh(max(min(r, 0.9999), -0.9999)) * math.sqrt(n - 3)
    slope = float(np.polyfit(x, y, 1)[0])
    return {"r": round(r, 3), "n": n, "p": float(math.erfc(abs(z) / math.sqrt(2))), "slope": slope}


def _within(values: np.ndarray, groups: list[str]) -> np.ndarray:
    """Values minus their run's mean: what changes from lap to lap, not from run to run."""
    out = np.array(values, float)
    g = np.array(groups)
    for k in set(groups):
        sel = (g == k) & ~np.isnan(out)
        if sel.sum():
            out[g == k] -= out[sel].mean()
    return out


# Lap features that describe technique (compared lap to lap within a run) and the car's state (run to run)
LAP_STATE = ("tyre_p_fl", "tyre_p_fr", "tyre_p_rl", "tyre_p_rr", "tyre_t_fl", "tyre_t_fr", "tyre_t_rl", "tyre_t_rr")
TECHNIQUE = {  # metric -> (label, unit, better when higher)
    "brake_point": ("Braking point", "m", True),
    "peak_brake": ("Peak brake pressure", "", True),
    "min_speed": ("Minimum speed", "km/h", True),
    "exit_speed": ("Exit speed", "km/h", True),
    "throttle_on": ("Throttle pick-up", "m", False),
    "full_throttle": ("Full throttle", "m", False),
    "coasting": ("Coasting", "s", False),
    "overlap": ("Brake and throttle together", "s", False),
    "trail_share": ("Braking done while turning", "", True),
    "grip_braking": ("Grip used braking", "", True),
    "grip_trail": ("Grip used turning in", "", True),
    "grip_mid": ("Grip used mid-corner", "", True),
    "grip_exit": ("Grip used on exit", "", True),
    "tc": ("Traction control working", "s", False),
    "abs": ("ABS working", "s", False),
    "understeer_entry": ("Understeer on entry", "°", False),
    "understeer_mid": ("Understeer mid-corner", "°", False),
    "understeer_exit": ("Understeer on exit", "°", False),
    "rear_slip_exit": ("Rear wheelspin on exit", "%", False),
    "steering_activity": ("Steering corrections", "", False),
}


def _trend_rows(laps: list[LapRecord], per_lap: list[dict], target: str = "time") -> list[dict]:
    """Which technique metrics go with a quicker time, lap to lap within the same run.

    The gain is what moving from a typical lap to the quick laps' value (the best 10 % of the lap-to-lap
    variation) was worth, never more than the gap between the median and the best time.
    """
    runs = [x.run for x in laps]
    times = np.array([m[target] for m in per_lap])
    y = _within(times, runs)
    cap = float(np.median(times) - times.min())
    out = []
    for key, (label, unit, _) in TECHNIQUE.items():
        vals = np.array([m.get(key) if m.get(key) is not None else np.nan for m in per_lap], float)
        if np.isnan(vals).mean() > 0.3:
            continue
        dev = _within(vals, runs)
        c = corr(dev, y)
        if c is None or c["p"] > SIGNIFICANT_P or abs(c["r"]) < 0.3:
            continue
        step = float(np.nanpercentile(dev, 10 if c["slope"] > 0 else 90))
        gain = min(-c["slope"] * step, cap)
        if gain < 0.01:
            continue
        mid = float(np.nanmedian(vals))
        quick = float(np.clip(mid + step, np.nanmin(vals), np.nanmax(vals)))
        out.append({"metric": key, "label": label, "unit": unit, "r": c["r"], "n": c["n"], "p": round(c["p"], 4),
                    "seconds_per_unit": round(c["slope"], 4), "median": round(mid, 3),
                    "quick_laps_value": round(quick, 3), "gain_s": round(gain, 3)})
    out.sort(key=lambda r: -r["gain_s"])
    return out


def _lap_state(x: LapRecord) -> dict[str, float]:
    return {k: float(np.median(x.trace[k])) for k in LAP_STATE if k in x.trace}


def lap_correlations(prep: Prepared, per_lap_sections: dict[str, list[dict]], with_state: bool = True) -> list[dict]:
    """Lap-level driving measures (and tyre state, unless the full channel scan covers it) against lap time."""
    laps = prep.laps
    times = np.array([x.time for x in laps])
    runs = [x.run for x in laps]
    feats: dict[str, tuple[str, str, np.ndarray]] = {}
    states = [_lap_state(x) for x in laps]
    for k in LAP_STATE if with_state else ():
        if all(k in s for s in states):
            wheel = k[-2:].upper()
            kind = "Tyre pressure" if k.startswith("tyre_p") else "Tyre temperature"
            feats[k] = (f"{kind} {wheel}", "bar" if "_p_" in k else "°C", np.array([s[k] for s in states]))
    feats["lap_in_run"] = ("Laps into the run", "laps", np.array([x.index_in_run for x in laps], float))
    for key in ("grip_use", "coasting", "tc", "abs", "overlap"):
        if all(key in m and m[key] is not None for ms in per_lap_sections.values() for m in ms):
            vals = np.array([sum(ms[i][key] for ms in per_lap_sections.values()) for i in range(len(laps))])
            if key == "grip_use":
                vals = vals / len(per_lap_sections)
            label, unit, _ = TECHNIQUE.get(key, ("Grip used (average)", "", True))
            feats[key] = (label, unit, vals)
    out = []
    for key, (label, unit, vals) in feats.items():
        overall = corr(vals, times)
        within = corr(_within(vals, runs), _within(times, runs))
        best = min((c for c in (overall, within) if c is not None), key=lambda c: c["p"], default=None)
        if best is None or best["p"] > SIGNIFICANT_P or abs(best["r"]) < 0.3:
            continue
        out.append({"metric": key, "label": label, "unit": unit, "r": best["r"], "n": best["n"],
                    "p": round(best["p"], 4), "seconds_per_unit": round(best["slope"], 4),
                    "compared": "lap to lap within runs" if best is within else "across all laps",
                    "range": [round(float(np.percentile(vals, 10)), 3), round(float(np.percentile(vals, 90)), 3)]})
    out.sort(key=lambda r: r["p"])
    return out


# ---------- top speeds ----------

def straights(prep: Prepared) -> list[dict]:
    """Full-throttle stretches of the reference lap, each with a speed trap at its fastest point.

    A straight that crosses the timing line is one straight: it starts near the end of the lap (start_m is
    then larger than end_m).
    """
    tr = prep.reference.trace
    n = prep.length
    flat = tr["throttle"] > 95 if "throttle" in tr else (tr["ax"] > 0) & (tr["braking"] < 0.5)
    flat = np.convolve(flat.astype(float), np.ones(31), "same") > 0  # bridge brief lifts and gear changes
    edges = np.flatnonzero(np.diff(np.r_[0, flat.astype(int), 0]))
    segs = [[int(a), int(b)] for a, b in zip(edges[::2], edges[1::2], strict=True)]
    if len(segs) > 1 and segs[0][0] == 0 and segs[-1][1] >= n - 1:
        segs[0][0] = segs.pop()[0] - n  # wraps through the timing line
    out = []
    for a, b in segs:
        a, b = a + 15, b - 15
        if b - a < STRAIGHT_MIN_M:
            continue
        span = np.arange(a, b) % n
        trap = int(span[int(np.argmax(tr["speed"][span]))])
        end = b % n
        into = next((s.code for s in prep.sections if s.apex is not None and s.apex > end),
                    next((s.code for s in prep.sections if s.apex is not None), prep.sections[0].code))
        out.append({"name": f"Straight into {into}", "start_m": a % n, "end_m": end, "trap_m": trap})
    return out


def top_speeds(prep: Prepared, groups: dict[str, list[LapRecord]] | None = None) -> list[dict]:
    """Speed at each trap per lap, how much of it the exit of the corner before explains, and the rest."""
    groups = groups or {"all": prep.laps}
    n = prep.length
    out = []
    for st in straights(prep):
        a, trap = st["start_m"], st["trap_m"]
        window = np.arange(trap - 30, trap + 31) % n
        entry = {}
        for name, laps in groups.items():
            trap_v = np.array([x.trace["speed"][window].max() for x in laps])
            exit_v = np.array([x.trace["speed"][a] for x in laps])  # where the throttle goes flat
            entry[name] = {"best": round(float(trap_v.max()), 1), "median": round(float(np.median(trap_v)), 1),
                           "exit_median": round(float(np.median(exit_v)), 1), "laps": len(laps),
                           "_trap": trap_v, "_exit": exit_v}
        all_trap = np.concatenate([e["_trap"] for e in entry.values()])
        all_exit = np.concatenate([e["_exit"] for e in entry.values()])
        c = corr(all_exit, all_trap)
        k = c["slope"] if c and c["p"] < 0.05 else 0.0
        for e in entry.values():
            # trap speed with the exit speed difference taken out: car, tow and conditions
            e["exit_adjusted_median"] = round(float(np.median(e["_trap"] - k * (e["_exit"] - all_exit.mean()))), 1)
            del e["_trap"], e["_exit"]
        out.append({**st, "per_exit_kmh": round(k, 2), "exit_r": c["r"] if c else None, "groups": entry})
    return out


# ---------- setup ----------

def setup_diagnostics(prep: Prepared) -> dict:
    tr = {k: np.concatenate([x.trace[k] for x in prep.laps]) for k in prep.reference.trace if k != "distance"}
    dt = np.concatenate([_dt(x.trace) for x in prep.laps])
    phase = np.rint(tr["phase"]).astype(int)
    v, ay = tr["speed"], np.abs(tr["ay"])
    out: dict = {"lateral_grip_by_speed": [
        {"speed_kmh": round(float(s), 0), "g": round(float(g), 2)}
        for s, g in zip(prep.limits.speeds, prep.limits.max_lateral(prep.limits.speeds), strict=True)]}
    if "understeer" in tr:
        us = tr["understeer"]
        corner = (ay > 0.5) & (phase != BRAKE) & (phase != POWER)
        k = float(np.polyfit(ay[corner], us[corner], 1)[0]) if corner.sum() > 100 else 0.0
        rel = us - k * ay  # balance against the car's own average at the same lateral g
        bands = (("slow", 0, 110), ("medium", 110, 160), ("fast", 160, 400))
        table = []
        for name, lo, hi in bands:
            row = {"speed": name, "range_kmh": [lo, hi]}
            for p, pname in ((TRAIL, "entry"), (MID, "mid"), (EXIT, "exit")):
                sel = corner & (phase == p) & (v >= lo) & (v < hi)
                row[pname] = round(float(np.median(rel[sel])), 2) if sel.sum() >= 200 else None
            table.append(row)
        spread = float(np.percentile(np.abs(rel[corner] - np.median(rel[corner])), 75)) if corner.any() else 0.0
        out["balance"] = {"understeer_per_g": round(k, 2), "table": table, "typical_spread": round(spread, 2),
                          "notes": _balance_notes(table, spread)}
    if "tc_on" in tr:
        out["traction_control_s_per_lap"] = round(float((dt * (tr["tc_on"] > 0.5)).sum()) / len(prep.laps), 2)
    if "abs_on" in tr:
        braking = tr["braking"] > 0.5
        out["abs_share_of_braking"] = round(float((dt * braking * (tr["abs_on"] > 0.5)).sum()
                                                  / max((dt * braking).sum(), 1e-9)), 3)
    if "slide_rate" in tr:
        trail = phase == TRAIL
        out["rear_rotation_under_braking"] = round(float(np.percentile(tr["slide_rate"][trail], 95)), 1) \
            if trail.sum() > 100 else None
    tyres = {}
    for kind, unit in (("p", "bar"), ("t", "°C")):
        vals = {w: float(np.median(tr[f"tyre_{kind}_{w}"])) for w in ("fl", "fr", "rl", "rr")
                if f"tyre_{kind}_{w}" in tr}
        if len(vals) == 4:
            tyres["pressure" if kind == "p" else "temperature"] = {
                "unit": unit, **{w: round(x, 2 if kind == "p" else 1) for w, x in vals.items()},
                "front_minus_rear": round((vals["fl"] + vals["fr"] - vals["rl"] - vals["rr"]) / 2, 2),
                "left_minus_right": round((vals["fl"] + vals["rl"] - vals["fr"] - vals["rr"]) / 2, 2)}
    if tyres:
        out["tyres"] = tyres
    return out


def _balance_notes(table: list[dict], spread: float) -> list[str]:
    """Plain-language reading of the balance table: only differences well beyond the usual scatter."""
    notes = []
    step = max(spread, 0.1)
    for row in table:
        e, m, x = row.get("entry"), row.get("mid"), row.get("exit")
        if e is not None and m is not None and e - m > step:
            notes.append(f"More understeer on entry than mid-corner in {row['speed']} corners")
        if e is not None and m is not None and m - e > step:
            notes.append(f"The car is looser on entry than mid-corner in {row['speed']} corners")
        if x is not None and m is not None and m - x > step:
            notes.append(f"The rear steps out on the throttle in {row['speed']} corners (less steering needed)")
        if x is not None and m is not None and x - m > step:
            notes.append(f"Exit understeer on the throttle in {row['speed']} corners")
    slow, fast = table[0].get("mid"), table[-1].get("mid")
    if slow is not None and fast is not None and abs(fast - slow) > step:
        notes.append("More understeer in fast corners than slow ones (aero or springs balance)" if fast > slow
                     else "Looser in fast corners than slow ones (aero or springs balance)")
    return notes


# ---------- scores ----------

def lap_scores(x: LapRecord, prep: Prepared) -> dict:
    """How much of the theoretical lap this lap extracted, overall and in each phase of driving."""
    dt = _dt(x.trace)
    st = np.diff(prep.sim.t, append=prep.sim.time)
    phase = np.rint(x.trace["phase"]).astype(int)
    extraction = 100 * prep.sim.time / x.time
    parts = {}
    for p, name in ((BRAKE, "braking"), (TRAIL, "turn_in"), (MID, "mid_corner"), (EXIT, "traction")):
        sel = phase == p
        parts[name] = round(float(100 * st[sel].sum() / dt[sel].sum()), 1) if dt[sel].sum() > 0.5 else None
    medal = next((m for m, th in MEDALS if extraction >= th), None)
    nxt = next(((m, th) for m, th in reversed(MEDALS) if extraction < th), None)
    return {
        "extraction": round(extraction, 2), "medal": medal, "scores": parts,
        "own_line_extraction": round(100 * x.own_sim.time / x.time, 2) if x.own_sim else None,
        "next_medal": {"medal": nxt[0], "seconds_to_find": round(x.time - prep.sim.time / (nxt[1] / 100), 2)}
        if nxt else None,
    }


def consistency(times: list[float]) -> float | None:
    """100 when every clean lap matches the best; 10 points off for each 1 % the median lap is slower."""
    if len(times) < 3:
        return None
    best, med = min(times), float(np.median(times))
    return round(float(np.clip(100 - 1000 * (med / best - 1), 0, 100)), 1)


# ---------- the whole picture ----------

def _r(v, nd=3):
    return None if v is None else round(v, nd)


def analyze_runs(runs: list[RunInput], corners: list[tuple[str, float]] | None = None) -> dict:
    prep = prepare(runs, corners)
    if prep is None:
        return {"laps": [], "sections": []}
    laps, sim = prep.laps, prep.sim
    per_lap = {s.code: [section_metrics(x, s, prep.limits, sim) for x in laps] for s in prep.sections}
    ref_i = laps.index(prep.reference)

    sections_out = []
    for s in prep.sections:
        ms = per_lap[s.code]
        times = np.array([m["time"] for m in ms])
        best_i = int(np.argmin(times))
        ref_m = ms[ref_i]
        sections_out.append({
            **s.to_dict(),
            "theoretical": round(ref_m["sim_time"], 3),
            "best": {"lap": laps[best_i].key, "time": round(float(times[best_i]), 3)},
            "median": round(float(np.median(times)), 3),
            "reference": {k: _r(v) if isinstance(v, float) else v for k, v in ref_m.items()},
            "reference_loss_by_phase": _phase_losses(prep.reference, sim, s.start, s.end),
            # where the time is: the reference lap against the theoretical lap and the best lap in this section
            "to_theoretical": round(ref_m["time"] - ref_m["sim_time"], 3),
            "to_best": round(ref_m["time"] - float(times[best_i]), 3),
            "spread": round(float(np.percentile(times, 75) - np.percentile(times, 25)), 3),
            "trends": _trend_rows(laps, ms)[:4],
        })
    opportunities = sorted(
        ({"code": s["code"], "to_theoretical": s["to_theoretical"], "to_best": s["to_best"],
          "main_phase": max(s["reference_loss_by_phase"].items(), key=lambda kv: kv[1])[0],
          "trend": s["trends"][0] if s["trends"] else None} for s in sections_out),
        key=lambda o: -o["to_theoretical"])

    by_run: dict[str, list[LapRecord]] = {}
    for x in laps:
        by_run.setdefault(x.run, []).append(x)
    lap_rows = []
    for x in laps:
        sc = lap_scores(x, prep)
        lap_rows.append({"run": x.run, "lap": x.number, "driver": x.driver, "time": x.time,
                         "top_speed": round(float(x.trace["speed"].max()), 1),
                         "theoretical_own_line": round(x.own_sim.time, 3) if x.own_sim else None, **sc})
    run_rows = []
    for name, xs in by_run.items():
        best = min(xs, key=lambda x: x.time)
        run_rows.append({"run": name, "driver": xs[0].driver, "clean_laps": len(xs), "best": best.time,
                         "best_lap": best.number, "consistency": consistency([x.time for x in xs]),
                         "extraction": round(100 * sim.time / best.time, 2)})

    ideal = sum(float(min(m["time"] for m in per_lap[s.code])) for s in prep.sections)
    scan_items = [(r.name, r.ld, [l for l in r.data.laps if l.clean]) for r in runs if r.ld is not None]
    sp = sim.speed
    return {
        "reference": {"run": prep.reference.run, "lap": prep.reference.number, "time": prep.reference.time},
        "length_m": prep.length,
        "numbering": prep.numbering,
        "theoretical_lap": round(sim.time, 3),
        "ideal_lap": round(ideal, 3),
        "limits": prep.limits.to_dict(),
        "sections": sections_out,
        "opportunities": opportunities,
        "laps": lap_rows,
        "runs": run_rows,
        "correlations": lap_correlations(prep, per_lap, with_state=not scan_items),
        "channel_scan": channel_scan(scan_items) if scan_items else [],
        "top_speeds": top_speeds(prep, {k: v for k, v in by_run.items()}),
        "setup": setup_diagnostics(prep),
        "trace": {  # the reference lap and the theoretical lap, every 5 m, for charts and the track map
            "step_m": 5,
            "reference_speed": np.round(prep.reference.trace["speed"][::5], 1).tolist(),
            "theoretical_speed": np.round(sp[::5], 1).tolist(),
            "limited_by": [LIMITED_BY[i] for i in sim.limited_by[::5]],
            "line": prep.line.to_dict(5) if prep.line is not None else None,
        },
    }
