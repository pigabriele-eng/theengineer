"""Two drivers (or two groups of runs) on one car and track, over all their clean laps: where each gains or loses
and how consistently, which technique explains it, and each driver's habits that repeat lap after lap.

Built for many runs at once. Each run is loaded, its clean laps are placed on one GPS line and reduced to
per-lap section metrics plus a few small per-metre arrays (about 0.1 MB a lap), and the run is freed before the
next is read, so memory grows with the number of laps, not with the size of the logs. The run with the quickest
lap is read first: that lap gives the line every lap is placed on and the corner sections. The car's limits
(for grip use) come from all the quick laps once every run has been read.
"""
from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field, replace

import numpy as np

from app import heavy
from app.analysis.align import aligned_trace, track_line
from app.analysis.channels import BRAKE, EXIT, MID, PHASES, POWER, TRAIL, TURNING_G, math_channels
from app.analysis.insights import RunInput, _first, _wmean, _within, consistency, corr, targets, top_speeds
from app.analysis.laps import CornerSpec, Lap, SessionData, lap_length, make_sections
from app.analysis.limits import CarLimits

SIDES = ("a", "b")
SIGNIFICANT_P = 0.05  # a technique difference is worth something when it goes with section time at this level
MIN_EFFECT_S = 0.01
HABIT_MIN_COST_S = 0.02  # each time it happens
EXIT_M = 150  # exit speed is taken this far past the slowest point (or at the section end, if sooner)
MIN_SIDE_LAPS = 3  # laps a side needs in a section before its median is compared
QUICK_SHARE = 0.25  # the quickest quarter of all laps in a section show what works there
HABIT_MIN_LAPS = 3
HABIT_MIN_SHARE = 0.25  # a habit happens on at least this share of a driver's laps
STEP_M = 5  # resolution of the traces sent for charts

# Logger roles the comparison needs; tyre, engine and suspension channels are dropped before the laps are aligned
ROLES = ("speed", "throttle", "brake", "steer", "lat", "lon", "g_lat", "g_long", "yaw", "tc", "abs",
         "wheel_fl", "wheel_fr", "wheel_rl", "wheel_rr")

# metric -> (label, unit, better when higher); None when either is a matter of style rather than time
TECHNIQUE: dict[str, tuple[str, str, bool | None]] = {
    "brake_point": ("Braking point", "m", True),
    "peak_brake": ("Peak brake pressure", "", True),
    "trail_share": ("Braking done while turning", "%", True),
    "lift_to_brake": ("Lift before braking", "s", False),
    "coast_turn_in": ("Coasting before turn-in", "s", False),
    "min_speed": ("Minimum speed", "km/h", True),
    "coast_mid": ("Coasting mid-corner", "s", False),
    "min_throttle": ("Least throttle (no braking)", "%", True),
    "throttle_on": ("Throttle pick-up", "m", False),
    "throttle_rate": ("Throttle application rate", "%/s", True),
    "full_throttle": ("Full throttle", "m", False),
    "exit_speed": ("Exit speed", "km/h", True),
    "end_speed": ("Speed at the end of the section", "km/h", True),
    "steer_peak": ("Steering angle", "°", None),
    "steering_activity": ("Steering corrections", "", False),
    "grip_use": ("Grip used", "%", True),
    "grip_braking": ("Grip used braking", "%", True),
    "grip_trail": ("Grip used turning in", "%", True),
    "grip_mid": ("Grip used mid-corner", "%", True),
    "grip_exit": ("Grip used on exit", "%", True),
    "tc": ("Traction control working", "s", False),
    "abs": ("ABS working", "s", False),
    "overlap": ("Brake and throttle together", "s", False),
    "understeer_entry": ("Understeer on entry", "°", None),
    "understeer_mid": ("Understeer mid-corner", "°", None),
    "understeer_exit": ("Understeer on exit", "°", None),
    "rear_slip_exit": ("Rear wheelspin on exit", "%", False),
}
SHARES = {"trail_share", "grip_use", "grip_braking", "grip_trail", "grip_mid", "grip_exit"}  # 0..1, sent as %
POSITIONS = {"brake_point", "throttle_on", "full_throttle"}  # metres on the lap, sent as metres from the apex
# speeds are what the technique produces, not technique: they show where the time goes, the inputs show how
OUTCOMES = {"min_speed", "exit_speed", "end_speed"}
CLEAR_SHARE = 0.6  # a section difference is clear when the quicker side beats the other's median this often


@dataclass
class RunSource:
    """One run to compare, loaded only when its turn comes."""
    name: str
    side: str  # "a" or "b"
    load: Callable[[], RunInput]
    best: float | None = None  # its quickest clean lap if known, so the quickest run is read first
    meta: dict = field(default_factory=dict)


@dataclass
class LapSummary:
    """What is kept of one clean lap once its run is freed."""
    side: str
    run: str
    number: int
    time: float
    index_in_run: int
    sections: list[dict]  # metrics per section, in lap order
    dt: np.ndarray  # seconds spent on each metre (float32)
    speed: np.ndarray
    ax: np.ndarray
    ay: np.ndarray
    phase: np.ndarray  # int8, see channels.PHASES
    throttle: np.ndarray | None
    style: dict = field(default_factory=dict)  # lap-wide totals

    @property
    def trace(self) -> dict[str, np.ndarray]:  # what top_speeds and the car's limits read
        out = {"speed": self.speed, "ax": self.ax, "ay": self.ay, "phase": self.phase}
        if self.throttle is not None:
            out["throttle"] = self.throttle
        return out


@dataclass
class _Reference:
    """The quickest lap of the first run read: the line, the length and the sections every lap is measured on."""
    run: str
    number: int
    line: object
    align_length: int  # the lap length laps are aligned to when there is no GPS line
    trace: dict[str, np.ndarray]
    sections: list
    numbering: str

    @property
    def length(self) -> int:  # points on the distance grid, timing line to timing line, both ends included
        return len(self.trace["distance"])

    @property  # for insights.straights, which reads prep.reference.trace
    def reference(self):
        return self


# ---------- one lap ----------

def _dt(t: np.ndarray) -> np.ndarray:
    return np.diff(t, append=t[-1] + (t[-1] - t[-2]))


def _steer_offset(tr: dict[str, np.ndarray]) -> float:
    straight = (np.abs(tr["ay"]) < 0.05) & (tr["speed"] > 60)
    return float(np.median(tr["steer"][straight])) if np.count_nonzero(straight) > 50 else 0.0


def _section(tr: dict[str, np.ndarray], dt: np.ndarray, s, steer0: float) -> dict:
    """Section time and the technique that went into it, from one lap on the distance grid (1 m)."""
    a, b = s.start, s.end
    sl = slice(a, b)
    v = tr["speed"][sl]
    n = len(v)
    d = dt[sl]
    t = tr["t"][sl]
    idx = np.arange(n)
    phase = np.rint(tr["phase"][sl]).astype(int)
    apex = (s.apex if s.apex is not None else a + int(np.argmin(v))) - a
    m: dict = {
        "time": float(tr["t"][b] - tr["t"][a]),
        "entry_speed": float(v[0]), "min_speed": float(v.min()), "end_speed": float(v[-1]),
        "min_speed_at": a + int(np.argmin(v)),
        "exit_speed": float(v[max(0, min(apex + EXIT_M, n - 1))]),
    }
    for p in range(len(PHASES)):
        m[f"time_{PHASES[p]}"] = float(d[phase == p].sum())
    braking = tr["braking"][sl] > 0.5
    turning = np.abs(tr["ay"][sl]) >= TURNING_G
    bp = _first(braking[: max(apex, 1)])
    m["brake_point"] = a + bp if bp is not None else None
    m["peak_brake"] = float(tr["brake"][sl].max()) if "brake" in tr and bp is not None else None
    on_brakes = (phase == BRAKE) | (phase == TRAIL)
    m["trail_share"] = np.count_nonzero(phase == TRAIL) / np.count_nonzero(on_brakes) \
        if np.count_nonzero(on_brakes) >= 10 else None
    on = None
    if "throttle" in tr:
        thr = tr["throttle"][sl]
        # a pick-up needs a lift first: in a corner taken flat there is none to measure
        lifted = np.maximum.accumulate(thr <= 20)
        on = _first((thr > 20) & ~braking & (idx >= apex - 40) & lifted)
        full = _first((thr > 95) & (idx >= on)) if on is not None else None
        m["throttle_on"] = a + on if on is not None else None
        m["full_throttle"] = a + full if full is not None else None
        m["min_throttle"] = float(thr.min()) if bp is None else None  # how far a corner without braking is lifted
        m["throttle_rate"] = None
        if on is not None:
            k = full if full is not None else on + int(np.argmax(thr[on:]))
            if thr[k] >= 50:  # % per second from pick-up to full (or to the most it got in this section)
                m["throttle_rate"] = float((thr[k] - 20) / max(t[k] - t[on], 0.03))
        m["lift_to_brake"] = None
        if bp is not None:
            was_on = np.flatnonzero(thr[:bp] >= 50)
            if len(was_on):  # last moment on the throttle before the brakes came on
                m["lift_to_brake"] = float(t[bp] - t[min(was_on[-1] + 1, bp)])
        coasting = tr["coasting"][sl] > 0.5
        m["coasting"] = float(d[coasting].sum())
        if bp is not None:
            entry = (idx >= bp) & (idx < max(apex, bp))
            m["coast_turn_in"] = float(d[entry & coasting & ~turning].sum())
            mid = (idx >= bp) & (idx < (on if on is not None else n))
            m["coast_mid"] = float(d[mid & coasting & turning].sum())
        else:
            m["coast_turn_in"] = m["coast_mid"] = None
        m["overlap"] = float(d[tr["overlap"][sl] > 0.5].sum())
    for ch, name in (("tc_on", "tc"), ("abs_on", "abs")):
        if ch in tr:
            m[name] = float(d[tr[ch][sl] > 0.5].sum())
    if "understeer" in tr:
        us = tr["understeer"][sl]
        for p, name in ((TRAIL, "entry"), (MID, "mid"), (EXIT, "exit")):
            sel = (phase == p) & (np.abs(tr["ay"][sl]) > 0.5)
            m[f"understeer_{name}"] = float(np.median(us[sel])) if np.count_nonzero(sel) >= 5 else None
    if "rear_slip" in tr:
        sel = phase == EXIT
        m["rear_slip_exit"] = float(np.percentile(tr["rear_slip"][sl][sel], 90)) if sel.sum() >= 5 else None
    if "steer" in tr:
        st = tr["steer"][sl] - steer0
        turn = float(np.abs(st).max())
        m["steer_peak"] = turn if np.abs(tr["ay"][sl]).max() >= TURNING_G else None
        m["steering_activity"] = float(np.abs(np.diff(st)).sum() / turn) if turn > 1e-6 else None
    return m


def _summarise(tr: dict[str, np.ndarray], src: RunSource, lap: Lap, index: int, sections: list) -> LapSummary:
    dt = _dt(tr["t"])
    steer0 = _steer_offset(tr) if "steer" in tr else 0.0
    secs = [_section(tr, dt, s, steer0) for s in sections]
    style = {}
    for key, label in (("coasting", "coasting_s"), ("overlap", "brake_throttle_overlap_s"), ("tc_on", "tc_s"),
                       ("abs_on", "abs_s")):
        if key in tr:
            style[label] = float(dt[tr[key] > 0.5].sum())
    if "brake" in tr:
        style["peak_brake"] = float(np.percentile(tr["brake"], 99.5))
    rates = [m["throttle_rate"] for m in secs if m.get("throttle_rate") is not None]
    if rates:
        style["throttle_rate_pct_s"] = float(np.median(rates))
    f32 = np.float32
    return LapSummary(src.side, src.name, lap.number, lap.time, index, secs, dt.astype(f32), tr["speed"].astype(f32),
                      tr["ax"].astype(f32), tr["ay"].astype(f32), np.rint(tr["phase"]).astype(np.int8),
                      tr["throttle"].astype(f32) if "throttle" in tr else None, style)


def _grip(x: LapSummary, sections: list, limits: CarLimits) -> None:
    """Share of the car's grip in use, per section and phase: only known once every run's quick laps are in."""
    use = limits.use(x.speed.astype(float), x.ax.astype(float), x.ay.astype(float))
    dt = x.dt.astype(float)
    for s, m in zip(sections, x.sections, strict=True):
        sl = slice(s.start, s.end)
        u, d, ph = use[sl], dt[sl], x.phase[sl]
        for p, name in ((BRAKE, "braking"), (TRAIL, "trail"), (MID, "mid"), (EXIT, "exit")):
            m[f"grip_{name}"] = _wmean(u, d * (ph == p)) if (d * (ph == p)).sum() > 0.1 else None
        m["grip_use"] = _wmean(u, d * (ph < POWER))
    phase = x.phase
    for p in range(4):
        sel = phase == p
        x.style[f"grip_{PHASES[p]}"] = _wmean(use[sel], dt[sel])
        x.style[f"time_{PHASES[p]}_s"] = float(dt[sel].sum())
    x.style[f"time_{PHASES[POWER]}_s"] = float(dt[phase == POWER].sum())


# ---------- reading the runs ----------

def _slim(data: SessionData) -> SessionData:
    return replace(data, channels={k: v for k, v in data.channels.items() if k in ROLES})


def _reference(data: SessionData, src: RunSource, lap: Lap, corners: list[CornerSpec] | None) -> _Reference:
    line = track_line(data, lap)
    length = line.length if line is not None else round(lap_length(data, lap))
    full = aligned_trace(data, lap, line, length)
    sections, numbering = make_sections(full, corners)
    keep = ("distance", "t", "speed", "throttle", "ax", "braking", "curvature", "phase")
    return _Reference(src.name, lap.number, line, length, {k: full[k] for k in keep if k in full}, sections, numbering)


def _read(sources: list[RunSource], corners: list[CornerSpec] | None,
          progress: Callable[[int, str], None] | None) -> tuple[_Reference | None, list[LapSummary], list[dict]]:
    """Every source, one at a time, reduced to its laps' summaries."""
    ref: _Reference | None = None
    laps: list[LapSummary] = []
    runs: list[dict] = []
    for done, src in enumerate(sorted(sources, key=lambda s: (s.best is None, s.best or 0.0))):
        if progress:
            progress(done, src.meta.get("session", src.name))
        with heavy.lock:  # one log in memory at a time, across this job, imports and requests
            run = src.load()
            clean = [l for l in run.data.laps if l.clean]
            data = _slim(run.data) if clean else None
            run.data.channels, run.ld = {}, None
            del run
            if data is not None:
                math_channels(data)
                if ref is None:
                    ref = _reference(data, src, min(clean, key=lambda l: l.time), corners)
                for i, lap in enumerate(clean):
                    tr = aligned_trace(data, lap, ref.line, ref.align_length)
                    laps.append(_summarise(tr, src, lap, i, ref.sections))
                    del tr
                del data
            heavy.release_memory()  # also when the lock is held further out, as by POST /compare/drivers
        times = [l.time for l in clean]
        runs.append({"run": src.name, "side": src.side, **src.meta, "laps": len(times),
                     "best": min(times) if times else None,
                     "median": round(float(np.median(times)), 3) if times else None})
    return ref, laps, runs


# ---------- comparing ----------

def _vals(laps: list[LapSummary], k: int, key: str) -> np.ndarray:
    return np.array([np.nan if (v := x.sections[k].get(key)) is None else v for x in laps], float)


def _median(v: np.ndarray) -> float | None:
    v = v[~np.isnan(v)]
    return float(np.median(v)) if len(v) >= MIN_SIDE_LAPS else None


def _shown(key: str, v: float | None) -> float | None:
    if v is None:
        return None
    return round(100 * v, 1) if key in SHARES else round(v, 3)


def _technique(laps: list[LapSummary], k: int, sides: np.ndarray, times: np.ndarray, runs_of: list[str],
               delta: float, anchor: int) -> list[dict]:
    """Each technique measure for both sides, and what the difference is worth when it goes with section time.
    Positions on the lap are given in metres from anchor (the corner's slowest point), negative before it."""
    y = _within(times, runs_of)
    rows = []
    for key, (label, unit, better_high) in TECHNIQUE.items():
        vals = _vals(laps, k, key)
        med = {g: _median(vals[sides == g]) for g in SIDES}
        if med["a"] is None or med["b"] is None:
            continue
        c = corr(_within(vals, runs_of), y)
        worth = None
        if c is not None and c["p"] <= SIGNIFICANT_P:
            w = c["slope"] * (med["a"] - med["b"])  # seconds a's typical value costs (+) or gains (-) against b's
            # each measure is judged on its own and they overlap: none is worth more than the whole difference
            w = float(np.sign(w) * min(abs(w), abs(delta)))
            worth = round(w, 3) if abs(w) >= MIN_EFFECT_S else None
        shift = anchor if key in POSITIONS else 0
        rows.append({"metric": key, "label": label, "unit": unit, "better": better_high,
                     "a": _shown(key, med["a"] - shift), "b": _shown(key, med["b"] - shift),
                     "diff": _shown(key, med["a"] - med["b"]), "worth_s": worth,
                     "r": c["r"] if c is not None else None,
                     "explains": worth is not None and worth * delta > 0})
    # what explains the difference first, the driver's inputs before the speeds they produce
    rows.sort(key=lambda r: (not r["explains"], r["metric"] in OUTCOMES, -abs(r["worth_s"] or 0)))
    return rows


@dataclass
class _Habit:
    kind: str
    label: str
    unit: str
    advice: str


HABITS = {h.kind: h for h in (
    _Habit("early_lift", "Lifting off well before braking", "s",
           "Stay flat until the braking point: the lift costs speed and the brakes do the work anyway."),
    _Habit("lift_fast", "Lifting where the quick laps stay on the throttle", "%",
           "The quick laps keep more throttle through here: commit, or lift less and earlier."),
    _Habit("early_brake", "Braking earlier than the quick laps", "m",
           "The quick laps brake later here; move the marker a few metres at a time."),
    _Habit("scattered_brakes", "Brake point changes from lap to lap", "m",
           "Pick one marker and brake at it every lap; vary the pressure, not the point."),
    _Habit("no_trail", "Off the brakes before turning in", "%",
           "Carry some brake pressure into the turn-in and release it as the steering goes in."),
    _Habit("coast_turn_in", "Coasting before turn-in", "s",
           "Go straight from the brake to turning in: release the brake as you start to turn."),
    _Habit("coast_mid", "Coasting mid-corner, waiting for the throttle", "s",
           "Pick up the throttle as soon as the car is rotated, even a little, to settle it."),
    _Habit("late_throttle", "Late on the throttle", "m",
           "The quick laps are back on the throttle earlier here."),
    _Habit("slow_throttle", "Slow throttle application", "%/s",
           "Once the car is straightening, open the throttle more decisively."),
    _Habit("tc_exit", "Traction control working on exit", "s",
           "Open the throttle more progressively or a little later, or straighten the car first."),
    _Habit("overlap", "Brake and throttle together", "s",
           "Brake and throttle overlap longer than on the quick laps."),
    _Habit("steering_corrections", "Steering corrections", "",
           "More steering corrections than on the quick laps: a calmer, single steering input."),
)}


def _habit_flags(laps: list[LapSummary], k: int, quick: np.ndarray, sides: np.ndarray) -> dict[str, tuple]:
    """For each habit, which laps show it in this section (nan where it can't be judged) and how far off they are."""
    def v(key):
        return _vals(laps, k, key)

    def qmed(x):
        q = x[quick & ~np.isnan(x)]
        return float(np.median(q)) if len(q) >= 3 else None

    out = {}
    lift, coast_in, coast_mid = v("lift_to_brake"), v("coast_turn_in"), v("coast_mid")
    for kind, x, floor, margin in (("early_lift", lift, 0.25, 0.15), ("coast_turn_in", coast_in, 0.15, 0.1),
                                   ("coast_mid", coast_mid, 0.2, 0.15), ("tc_exit", v("tc"), 0.3, 0.2),
                                   ("overlap", v("overlap"), 0.2, 0.15)):
        q = qmed(x)
        if q is None:
            continue
        limit = max(floor, q + margin)
        out[kind] = (np.where(np.isnan(x), np.nan, x > limit), x, q)
    bp = v("brake_point")
    q = qmed(bp)
    if q is not None:
        out["early_brake"] = (np.where(np.isnan(bp), np.nan, bp < q - 10), q - bp, None)  # metres early
        own = np.full(len(bp), np.nan)
        for g in SIDES:  # metres from the driver's own usual brake point
            sel = (sides == g) & ~np.isnan(bp)
            if sel.sum() >= HABIT_MIN_LAPS:
                own[sel] = np.abs(bp[sel] - np.median(bp[sel]))
        out["scattered_brakes"] = (np.where(np.isnan(own), np.nan, own > 10), own, None)
    trail = v("trail_share")
    q = qmed(trail)
    if q is not None and q >= 0.3:
        out["no_trail"] = (np.where(np.isnan(trail), np.nan, trail < q - 0.25), trail * 100, q * 100)
    least = v("min_throttle")
    q = qmed(least)
    if q is not None and q >= 50:
        out["lift_fast"] = (np.where(np.isnan(least), np.nan, least < q - 25), least, q)
    on = v("throttle_on")
    q = qmed(on)
    if q is not None:
        out["late_throttle"] = (np.where(np.isnan(on), np.nan, on > q + 10), on - q, None)  # metres late
    rate = v("throttle_rate")
    q = qmed(rate)
    if q is not None:
        out["slow_throttle"] = (np.where(np.isnan(rate), np.nan, rate < 0.6 * q), rate, q)
    act = v("steering_activity")
    q = qmed(act)
    if q is not None:
        out["steering_corrections"] = (np.where(np.isnan(act), np.nan, act > max(1.5 * q, q + 0.5)), act, q)
    return out


def _habit_cost(times: np.ndarray, flag: np.ndarray, mine: np.ndarray) -> tuple[float | None, str | None]:
    """Median section time with the habit minus without: on the driver's own laps when both kinds are common
    enough, else on all laps of both drivers."""
    for sel, basis in ((mine, "own laps"), (np.ones(len(times), bool), "all laps")):
        ok = sel & ~np.isnan(flag)
        yes, no = times[ok & (flag == 1)], times[ok & (flag == 0)]
        if len(yes) >= HABIT_MIN_LAPS and len(no) >= HABIT_MIN_LAPS:
            return float(np.median(yes) - np.median(no)), basis
    return None, None


def _habits(per_section: list[tuple], sides: np.ndarray) -> dict[str, list[dict]]:
    """Patterns a driver repeats over many laps that cost time, grouped by habit, worst first."""
    out: dict[str, dict[str, dict]] = {g: {} for g in SIDES}
    for code, times, flags in per_section:
        for kind, (flag, value, quick) in flags.items():
            for g in SIDES:
                mine = sides == g
                judged = mine & ~np.isnan(flag)
                hits = judged & (flag == 1)
                n, count = int(judged.sum()), int(hits.sum())
                if count < HABIT_MIN_LAPS or count < HABIT_MIN_SHARE * n:
                    continue
                cost, basis = _habit_cost(times, flag, mine)
                if cost is None or cost < HABIT_MIN_COST_S:
                    continue  # repeated, but not costing time
                h = HABITS[kind]
                row = out[g].setdefault(kind, {"kind": kind, "label": h.label, "unit": h.unit, "advice": h.advice,
                                               "per_lap_s": 0.0, "sections": []})
                share = count / n
                row["sections"].append({
                    "code": code, "laps": count, "of": n, "share": round(share, 3), "cost_s": round(cost, 3),
                    "basis": basis, "per_lap_s": round(cost * share, 3),
                    "value": round(float(np.nanmedian(value[hits])), 2),
                    "quick": None if quick is None else round(float(quick), 2)})
                row["per_lap_s"] += cost * share
    result = {}
    for g in SIDES:
        rows = sorted(out[g].values(), key=lambda r: -r["per_lap_s"])
        for r in rows:
            r["per_lap_s"] = round(r["per_lap_s"], 3)
            r["sections"].sort(key=lambda s: -s["per_lap_s"])
        result[g] = rows
    return result


def _style(laps: list[LapSummary]) -> dict:
    keys = {k for x in laps for k in x.style}
    out = {}
    for k in sorted(keys):
        vals = [x.style[k] for x in laps if x.style.get(k) is not None]
        if vals:
            v = float(np.median(vals))
            out[k] = round(100 * v, 1) if k.startswith("grip_") else round(v, 2)
    return out


def compare_groups(sources: list[RunSource], labels: dict[str, str] | None = None,
                   corners: list[CornerSpec] | None = None,
                   progress: Callable[[int, str], None] | None = None) -> dict:
    """Side "a" against side "b" over every clean lap of their runs. Deltas are a minus b: + means a is slower.
    progress(runs read so far, the session being read) is called before each run is read."""
    labels = labels or {"a": "A", "b": "B"}
    ref, laps, runs = _read(sources, corners, progress)
    by = {g: [x for x in laps if x.side == g] for g in SIDES}
    if ref is None or not by["a"] or not by["b"]:
        missing = [labels[g] for g in SIDES if not by[g]]
        return {"error": f"No clean laps for {' and '.join(missing) or 'either side'}", "sections": []}
    sections = ref.sections
    # the reference lap as the theoretical lap needs it: its line, and its own speed, g and time (no lap is slower)
    ref_lap = next((x for x in laps if x.run == ref.run and x.number == ref.number), min(laps, key=lambda x: x.time))
    ref_t = np.concatenate([[0.0], np.cumsum(np.asarray(ref_lap.dt, float)[:-1])])
    t = targets(laps, {**ref_lap.trace, "curvature": ref.trace["curvature"], "t": ref_t}, ref_lap.time, sections)
    limits = t.limits
    for x in laps:
        _grip(x, sections, limits)
    sim = t.sim

    sides = np.array([x.side for x in laps])
    runs_of = [x.run for x in laps]
    dt = {g: np.stack([x.dt for x in by[g]]).astype(float) for g in SIDES}
    prof = {g: np.median(dt[g], axis=0) for g in SIDES}  # a typical lap for each side, robust to one messy lap
    phases = np.stack([x.phase for x in laps])
    phase_at = np.array([np.bincount(col, minlength=len(PHASES)).argmax() for col in phases.T])
    del phases
    times_all = {g: np.array([x.time for x in by[g]]) for g in SIDES}

    out_sections, habit_input = [], []
    for k, s in enumerate(sections):
        times = _vals(laps, k, "time")
        t = {g: times[sides == g] for g in SIDES}
        med = {g: float(np.median(t[g])) for g in SIDES}
        delta = med["a"] - med["b"]
        beats = {"a": float(np.mean(t["a"] < med["b"])), "b": float(np.mean(t["b"] < med["a"]))}
        faster = "a" if delta < 0 else "b"
        gap = prof["a"][s.start:s.end] - prof["b"][s.start:s.end]
        by_phase = {PHASES[p]: round(float(gap[phase_at[s.start:s.end] == p].sum()), 3) for p in range(len(PHASES))}
        same_way = [kv for kv in by_phase.items() if kv[1] * delta > 0]
        main_phase = max(same_way or by_phase.items(), key=lambda kv: abs(kv[1]))[0]
        anchor = s.apex if s.apex is not None else int(np.median(_vals(laps, k, "min_speed_at")))
        technique = _technique(laps, k, sides, times, runs_of, delta, anchor)
        quick_cut = np.percentile(times, 100 * QUICK_SHARE)
        habit_input.append((s.code, times, _habit_flags(laps, k, times <= quick_cut, sides)))
        out_sections.append({
            **s.to_dict(), "corners": s.corners,
            "median": {g: round(med[g], 3) for g in SIDES},
            "best": {g: round(float(t[g].min()), 3) for g in SIDES},
            "spread": {g: round(float(np.percentile(t[g], 75) - np.percentile(t[g], 25)), 3) for g in SIDES},
            "delta_s": round(delta, 3), "faster": faster,
            # how often the quicker driver's laps beat the other driver's median lap here, and the reverse
            "beats": {g: round(beats[g], 3) for g in SIDES}, "consistency": round(beats[faster], 3),
            "clear": bool(beats[faster] >= CLEAR_SHARE and abs(delta) >= MIN_EFFECT_S), "anchor_m": anchor,
            "gap_by_phase": by_phase, "main_phase": main_phase,
            "theoretical": round(float(sim.t[s.end] - sim.t[s.start]), 3),
            "technique": technique,
            "why": next((r for r in technique if r["explains"]), None),
            "times": {g: np.round(t[g], 3).tolist() for g in SIDES},
        })

    summary = {}
    for g in SIDES:
        tt = times_all[g]
        summary[g] = {
            "label": labels[g], "laps": len(tt), "runs": len({x.run for x in by[g]}),
            "best": round(float(tt.min()), 3), "median": round(float(np.median(tt)), 3),
            "consistency": consistency(list(tt)),
            "median_extraction": round(float(np.median(100 * sim.time / tt)), 2),
            "style": _style(by[g]),
        }
    where = sorted(({"code": s["code"], "delta_s": s["delta_s"], "faster": s["faster"], "clear": s["clear"],
                     "consistency": s["consistency"], "main_phase": s["main_phase"], "why": s["why"]}
                    for s in out_sections), key=lambda r: -abs(r["delta_s"]))
    speed = {g: np.median(np.stack([x.speed for x in by[g]]), axis=0) for g in SIDES}
    step = STEP_M
    return {
        "labels": labels, "length_m": ref.length, "numbering": ref.numbering,
        "reference": {"run": ref.run, "lap": ref.number},
        "theoretical_lap": round(sim.time, 3),
        "median_gap_s": round(summary["a"]["median"] - summary["b"]["median"], 3),
        "typical_gap_s": round(float(prof["a"].sum() - prof["b"].sum()), 3),
        "summary": summary, "sections": out_sections, "where_time_goes": where,
        "habits": _habits(habit_input, sides),
        "laps": [{"side": x.side, "run": x.run, "lap": x.number, "time": x.time} for x in laps],
        "runs": runs,
        "top_speeds": top_speeds(ref, by),
        "delta_trace": {"step_m": step, "gap_s": np.round(np.cumsum(prof["a"] - prof["b"])[::step], 3).tolist()},
        "speed_trace": {"step_m": step, **{g: np.round(speed[g][::step], 1).tolist() for g in SIDES}},
    }


def sources_from_runs(runs: list[RunInput], group_of: dict[str, str]) -> list[RunSource]:
    """Runs already in memory as sources (tests, scripts): each is still freed once it has been read."""
    def keep(r: RunInput) -> Callable[[], RunInput]:
        return lambda: r
    return [RunSource(r.name, group_of[r.name], keep(r), min((l.time for l in r.data.laps if l.clean), default=None))
            for r in runs if r.name in group_of]
