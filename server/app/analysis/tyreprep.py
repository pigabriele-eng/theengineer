"""Tyre and qualifying preparation: how the tyres came in, where the fast laps happened, what to set cold.

reduce_session turns one log into a small summary, so an event is read one session at a time:
- the log at 10 Hz: speed, front brake pressure, throttle, steering, GPS and the TPMS pressure and temperature of
  each tyre;
- a map of the session's fastest lap (GPS every 2 m) with where it brakes and where it runs straight, so warm-up
  work can be placed: braking where the fast lap doesn't brake, steering swings (weaving) where it runs straight;
- runs: the running between stops of LONG_STOP_S or more (the pit box or the garage). For every run with flying
  laps: the warm-up from leaving to the first flying lap (time, distance, brake dragging against the throttle,
  braking and hard stops on the straights, weaving), the tyres when leaving, at the line of every flying lap and
  over each lap, the axle temperatures second by second, and what the stop after it did to the pressures;
- every clean lap's time and median TPMS readings, for the tyre windows;
- stints as stint.py splits them (stops of 5 s), with stint.py's trends and notes for the long ones.

aggregate finds the quali-style runs (a warm-up on cold tyres or with the brakes worked, then flying laps getting
quicker to a best close to the session's best within the first MAX_PEAK_LAP flying laps), learns the TPMS
temperatures at the line that every near-best lap started from and how long the tyres took to get there from cold,
compares the warm-up procedures, and gives each tyre's pressure and temperature window on the fastest laps, the
cold pressures that land in it (the pressure calculator's own logic, tyres/pressure.py) and the long-run fade.
"""
from __future__ import annotations

import re
import warnings
from collections import defaultdict
from statistics import median

import numpy as np
from numpy.lib.stride_tricks import sliding_window_view

from app.analysis.laps import DEFAULT_CHANNEL_MAP, NO_SIGNAL_BELOW, WHEELS, Lap
from app.analysis.stint import FITTED, STOP_KMH, STOP_S, lap_kinds, outliers, split_stints, stint_notes, trend
from app.importers.motec import LdFile
from app.tyres.pressure import pressure_plan

HZ = 10
TYRE_ROLES = tuple(f"tyre_{k}_{w.lower()}" for k in ("p", "t") for w in WHEELS)
ROLES = ("speed", "brake", "throttle", "steer", "steer_wheel", "lat", "lon", *TYRE_ROLES)

# the log
TPMS_ASLEEP_S = 5.0  # a TPMS reading further than this from the nearest real sample: the sensor is asleep
TPMS_BAD_C = -30.0  # a waking sensor logs about -33 °C for a while; real tyres are never this cold
TPMS_GLITCH_S = 1.0  # ... and its first temperature after that is often a glitch that changes within this
BRAKE_BAR = {"bar": 1.0, "psi": 0.0689476, "kpa": 0.01, "mpa": 10.0}

# the fastest lap's map
MAP_STEP_M = 2.0
ON_TRACK_M = 25.0  # further than this from the fast lap's line: the pit lane
BRAKE_ZONE_M = 40.0  # braking within this of where the fast lap brakes is normal braking for a corner
STRAIGHT_M = 50.0  # straight: the fast lap's steering stays under STRAIGHT_LOCK this far either side
STRAIGHT_LOCK = 0.1  # share of the cornering lock (99th percentile of the steering on clean laps)
WEAVE_LOCK = 0.1  # a steering reversal of this share of the cornering lock is one swing
PLACE_CHUNK = 500

# runs and the warm-up
STILL_KMH = 3.0
LONG_STOP_S = 15.0  # standing this long ends a run (pit box, garage)
MOVING_KMH = 10.0
MIN_RUN_S = 30.0
AT_SPEED_KMH = 60.0  # warm-up work counts above this speed (not the pit lane)
DRAG_BAR, DRAG_THROTTLE = 3.0, 15.0  # dragging the brakes: pressure on while the throttle is open
BRAKING_BAR = 15.0
HARD_STOP_BAR = 40.0
EVENT_GAP_S = 1.0  # brake applications closer than this are one stop
LEAVE_S = (30.0, 40.0)  # the tyres when leaving: the TPMS needs some rolling before it reports
LINE_S = 3.0  # readings at the line: the median over this long either side of it
WARM_END_S = 5.0
PRE_WARMED_ABOVE_AMBIENT_C = 25.0  # fronts this much above the ambient when leaving: still warm from earlier
PRE_WARMED_C = 40.0  # ... or above this when the log has no ambient temperature
BRAKE_WARM_S = 15.0  # this much brake dragging before the first flying lap is a deliberate brake warm-up
MIN_GAIN_LAPS = 0.2  # a warm-up's gain per lap needs at least this much of a lap between the two readings
READY_FROM_S = 60.0
BLEED_AFTER_S = (22.0, 30.0)  # pressures after a stop, once the sensors report again
BLEED_BEFORE_S = 5.0
BLEED_BAR = 0.06  # pressures this much lower after a stop than before it: air was let out
COOLED_BAR = 0.25  # this much lower: the tyres were changed or left to cool

# quali-style runs
NEAR_SESSION_BEST_S = 0.5  # the build's best lap is at most this far off the session's best ...
MAX_PEAK_LAP = 6  # ... on one of the first this many flying laps
QUALI_LAPS_AFTER = 3  # a quali sim pits within this many laps of its best; more, and it became a long run
# a session named like qualifying ("Q", "Q2", "03_Q", "Quali") or marked as one
QUALI_NAME = re.compile(r"(?:^|[^a-z0-9])(q[1-3]?|qp|quali|qualy|qualif[a-z]*)(?:$|[^a-z0-9])", re.IGNORECASE)
PUSH_GAP_S = 0.3  # near-best: within this much of the day's best lap
PEAK_HOLD_S = 0.4  # the peak holds while laps stay this close to it

# tyre windows and long runs
WINDOW_GAP_S = 0.5
MIN_WINDOW_LAPS = 5
WINDOW_PCT = (10, 50, 90)
LONG_RUN_LAPS = 6  # flying laps in the trend before a stint counts as a long run
WIDE_BAR = 0.1  # near-best laps spread over this much hot pressure: within it, pressure didn't hold the lap back


# ---------------------------------------------------------------- the log at 10 Hz

def log_channels(ld: LdFile, channel_map: dict[str, tuple[str, ...]] | None = None) -> dict[str, np.ndarray] | None:
    """The roles this analysis uses on a 10 Hz clock; TPMS readings are nan where the sensor isn't reporting.

    "brake_levels" holds the drag, braking and hard-stop thresholds in the brake channel's own units."""
    cmap = {**DEFAULT_CHANNEL_MAP, **(channel_map or {})}
    speed = ld.channel(*cmap["speed"])
    if speed is None:
        return None
    t = np.arange(0, speed.duration, 1 / HZ)
    out: dict[str, np.ndarray] = {"t": t}
    for role in ROLES:
        ch = ld.channel(*cmap[role])
        if ch is None:
            continue
        ct, cv = ch.times(), ch.values().astype(float)
        if role.startswith("tyre_"):
            v = _tpms(role, ct, cv, t)
            if v is not None:
                out[role] = v
            continue
        if role in ("lat", "lon"):
            ok = np.abs(cv) > NO_SIGNAL_BELOW[role]  # no GPS fix logs as zeros
            if np.count_nonzero(ok) < 2:
                continue
            ct, cv = ct[ok], cv[ok]
        v = np.interp(t, ct, cv)
        if role == "brake":
            v = np.abs(v)  # some cars log brake torque as a negative number
            scale = BRAKE_BAR.get(ch.unit.strip().lower())
            levels = np.array([DRAG_BAR, BRAKING_BAR, HARD_STOP_BAR])
            if scale is not None:
                levels = levels / scale
            else:  # brake torque or an unknown unit: the same shares of a hard stop at 120 bar
                levels = levels / 120 * float(np.percentile(v, 99.5))
            out["brake_levels"] = levels
        out[role] = v
    return out


def _tpms(role: str, ct: np.ndarray, cv: np.ndarray, t: np.ndarray) -> np.ndarray | None:
    ok = cv > NO_SIGNAL_BELOW[role]
    if role.startswith("tyre_p") and np.count_nonzero(ok) and np.median(cv[ok]) > 50:  # some systems log kPa
        cv = cv / 100
    if role.startswith("tyre_t"):
        ok &= cv > TPMS_BAD_C
    if np.count_nonzero(ok) < 2:
        return None
    ct, cv = ct[ok], cv[ok]
    if role.startswith("tyre_t"):
        ct, cv = _drop_wake_glitch(ct, cv)
        if len(ct) < 2:
            return None
    v = np.interp(t, ct, cv)
    i = np.clip(np.searchsorted(ct, t), 1, len(ct) - 1)
    gap = np.minimum(np.abs(t - ct[i - 1]), np.abs(ct[i] - t))
    v[gap > TPMS_ASLEEP_S] = np.nan
    return v


def _drop_wake_glitch(ct: np.ndarray, cv: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Drop a waking sensor's first temperature when it changes within TPMS_GLITCH_S: in the logs it is a
    sample or two of nonsense (6 °C on a 17 °C tyre, 51 °C on a 109 °C one) before the real readings."""
    drop = np.zeros(len(ct), bool)
    for i in np.flatnonzero(np.concatenate([[True], np.diff(ct) > TPMS_ASLEEP_S])):
        k = int(np.searchsorted(ct, ct[i] + TPMS_GLITCH_S, side="right"))
        changed = np.flatnonzero(cv[i:k] != cv[i])
        if len(changed):
            drop[i:i + changed[0]] = True
    return ct[~drop], cv[~drop]


def _idx(s: float, n: int) -> int:
    return int(np.clip(round(s * HZ), 0, n))


def _median(x: np.ndarray) -> float | None:
    x = x[np.isfinite(x)]
    return float(np.median(x)) if len(x) else None


def _r(x: float | None, nd: int) -> float | None:
    return None if x is None else round(x, nd)


def _tyres(ch: dict[str, np.ndarray], a: float, b: float) -> dict[str, dict[str, float | None]]:
    """Median TPMS pressure (bar) and temperature (°C) of each tyre between two times."""
    n = len(ch["t"])
    sl = slice(_idx(a, n), max(_idx(b, n), _idx(a, n) + 1))
    out: dict[str, dict[str, float | None]] = {"p": {}, "t": {}}
    for kind, nd in (("p", 3), ("t", 1)):
        for w in WHEELS:
            v = ch.get(f"tyre_{kind}_{w.lower()}")
            out[kind][w] = _r(_median(v[sl]), nd) if v is not None else None
    return out


def _axle(values: dict[str, float | None], axle: str) -> float | None:
    """The axle's average from the sensors that report (one of a pair often wakes late)."""
    v = [values.get(w) for w in (("FL", "FR") if axle == "front" else ("RL", "RR")) if values.get(w) is not None]
    return float(np.mean(v)) if v else None


def _all4(values: dict[str, float | None]) -> float | None:
    v = [values.get(w) for w in WHEELS]
    return float(np.mean(v)) if all(x is not None for x in v) else None


def _stops(v: np.ndarray, min_s: float, kmh: float) -> list[tuple[float, float]]:
    still = np.concatenate([[False], v < kmh, [False]]).astype(int)
    e = np.flatnonzero(np.diff(still))
    return [(a / HZ, b / HZ) for a, b in zip(e[::2], e[1::2], strict=True) if b - a >= min_s * HZ]


def _events(mask: np.ndarray) -> int:
    """Separate applications in a mask: stretches more than EVENT_GAP_S apart."""
    idx = np.flatnonzero(mask)
    return int(1 + np.count_nonzero(np.diff(idx) > EVENT_GAP_S * HZ)) if len(idx) else 0


def _pivots(x: np.ndarray, swing: float) -> list[int]:
    """Where the signal turns back by at least `swing` (a zigzag): the peaks and troughs of the swings."""
    out: list[int] = []
    if not len(x) or swing <= 0:
        return out
    hi = lo = float(x[0])
    hi_i = lo_i = 0
    way = 0
    for i, v in enumerate(x.tolist()):
        if v > hi:
            hi, hi_i = v, i
        if v < lo:
            lo, lo_i = v, i
        if way >= 0 and hi - v >= swing:
            out.append(hi_i)
            way, lo, lo_i = -1, v, i
        elif way <= 0 and v - lo >= swing:
            out.append(lo_i)
            way, hi, hi_i = 1, v, i
    return out


# ---------------------------------------------------------------- the fastest lap's map

def _local(lat: np.ndarray, lon: np.ndarray, lat0: float, lon0: float) -> tuple[np.ndarray, np.ndarray]:
    r = 6_371_000.0
    return np.radians(lon - lon0) * r * np.cos(np.radians(lat0)), np.radians(lat - lat0) * r


def _around(mask: np.ndarray, k: int) -> np.ndarray:
    """How many of the k points either side (and the point) are set, the lap wrapping round at the line."""
    k = min(k, len(mask) - 1)
    padded = np.concatenate([mask[len(mask) - k:], mask, mask[:k]]).astype(int)
    return np.convolve(padded, np.ones(2 * k + 1, int), "valid")


def _track_map(ch: dict[str, np.ndarray], laps: list[Lap]) -> dict | None:
    """The session's fastest lap every MAP_STEP_M: its line, where it brakes and where it runs straight."""
    clean = [l for l in laps if l.clean]
    if not clean or "lat" not in ch or "lon" not in ch:
        return None
    n = len(ch["t"])
    ref = min(clean, key=lambda l: l.time)
    i0, i1 = _idx(ref.start, n), _idx(ref.end, n)
    if i1 - i0 < 10 * HZ:
        return None
    dist = np.concatenate([[0.0], np.cumsum(ch["speed"][i0:i1 - 1]) / 3.6 / HZ])
    grid = np.arange(0, dist[-1], MAP_STEP_M)
    lat0, lon0 = float(np.median(ch["lat"][i0:i1])), float(np.median(ch["lon"][i0:i1]))
    x, y = _local(ch["lat"][i0:i1], ch["lon"][i0:i1], lat0, lon0)
    m: dict = {"lat0": lat0, "lon0": lon0, "x": np.interp(grid, dist, x), "y": np.interp(grid, dist, y)}
    if "brake" in ch:
        braking = np.interp(grid, dist, ch["brake"][i0:i1]) > ch["brake_levels"][0]
        m["brake_zone"] = _around(braking, round(BRAKE_ZONE_M / MAP_STEP_M)) > 0
    steer = ch.get("steer_wheel", ch.get("steer"))
    if steer is not None:
        on_laps = np.concatenate([steer[_idx(l.start, n):_idx(l.end, n)] for l in clean])
        lock = float(np.percentile(np.abs(on_laps), 99)) if len(on_laps) else 0.0
        if lock > 0:
            calm = np.abs(np.interp(grid, dist, steer[i0:i1])) < STRAIGHT_LOCK * lock
            k = round(STRAIGHT_M / MAP_STEP_M)
            m["straight"] = _around(calm, k) == 2 * k + 1
            m["lock"] = lock
    return m


def _place(m: dict, lat: np.ndarray, lon: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Each sample's nearest point on the fast lap's map, and how far from it (m)."""
    x, y = _local(lat, lon, m["lat0"], m["lon0"])
    idx, off = np.empty(len(x), int), np.empty(len(x))
    for j in range(0, len(x), PLACE_CHUNK):
        d2 = (x[j:j + PLACE_CHUNK, None] - m["x"][None]) ** 2 + (y[j:j + PLACE_CHUNK, None] - m["y"][None]) ** 2
        idx[j:j + PLACE_CHUNK] = d2.argmin(1)
        off[j:j + PLACE_CHUNK] = np.sqrt(d2.min(1))
    return idx, off


def _work(ch: dict[str, np.ndarray], a: float, b: float, m: dict | None) -> dict:
    """What the driver did to warm the tyres and brakes between two times (above AT_SPEED_KMH)."""
    n = len(ch["t"])
    sl = slice(_idx(a, n), _idx(b, n))
    v = ch["speed"][sl]
    fast = v > AT_SPEED_KMH
    out: dict = {"seconds": round(b - a, 1), "km": round(float(np.sum(v)) / 3.6 / HZ / 1000, 2),
                 "drag_s": None, "brake_s": None, "hard_stops": None,
                 "straight_brake_s": None, "straight_hard_stops": None, "weave_swings": None}
    br = ch.get("brake")
    if br is not None:
        drag, braking, hard = ch["brake_levels"]
        br = br[sl]
        if "throttle" in ch:
            out["drag_s"] = round(np.count_nonzero(fast & (br > drag) & (ch["throttle"][sl] > DRAG_THROTTLE)) / HZ, 1)
        out["brake_s"] = round(np.count_nonzero(fast & (br > braking)) / HZ, 1)
        out["hard_stops"] = _events(fast & (br > hard))
    if m is None or not len(v):
        return out
    # only the samples that matter are placed on the map: braking at speed and the steering swings
    braking_at_speed = fast & (br > braking) if br is not None and "brake_zone" in m else np.zeros(len(v), bool)
    swings = []
    if "straight" in m:
        steer = ch.get("steer_wheel", ch.get("steer"))[sl]
        swings = [p for p in _pivots(steer, WEAVE_LOCK * m["lock"]) if fast[p]]
    at = np.flatnonzero(braking_at_speed | np.isin(np.arange(len(v)), swings))
    idx, off = np.zeros(len(v), int), np.full(len(v), np.inf)
    if len(at):
        idx[at], off[at] = _place(m, ch["lat"][sl][at], ch["lon"][sl][at])
    on = fast & (off < ON_TRACK_M)
    if br is not None and "brake_zone" in m:
        odd = on & ~m["brake_zone"][idx]
        out["straight_brake_s"] = round(np.count_nonzero(odd & (br > braking)) / HZ, 1)
        out["straight_hard_stops"] = _events(odd & (br > hard))
    if "straight" in m:
        out["weave_swings"] = len([p for p in swings if on[p] and m["straight"][idx[p]]])
    return out


def _add(a: dict | None, b: dict) -> dict:
    if a is None:
        return b
    return {k: (None if a[k] is None and b[k] is None else (a[k] or 0) + (b[k] or 0)) for k in b}


def _axle_series(ch: dict[str, np.ndarray], a: float, b: float) -> dict | None:
    """Front and rear axle TPMS temperature once a second from a to b: the median of the LINE_S either side."""
    n = len(ch["t"])
    out: dict = {"start_s": round(a, 1)}
    half = round(LINE_S * HZ)
    i0, i1 = _idx(a, n), _idx(b, n)
    if i1 - i0 < HZ:
        return None
    for axle, pair in (("front", ("fl", "fr")), ("rear", ("rl", "rr"))):
        cols = [ch[f"tyre_t_{w}"] for w in pair if f"tyre_t_{w}" in ch]
        if not cols:
            return None
        lo, hi = max(i0 - half, 0), min(i1 + half, n)
        with warnings.catch_warnings():  # all-nan stretches (a sensor asleep) are expected: they give nan
            warnings.simplefilter("ignore", RuntimeWarning)
            avg = np.nanmean(np.vstack([c[lo:hi] for c in cols]), axis=0)
            win = sliding_window_view(np.pad(avg, (half, half), constant_values=np.nan), 2 * half + 1)
            med = np.nanmedian(win[np.arange(i0, i1, HZ) - lo], axis=1)
        out[axle] = [round(float(x), 1) if np.isfinite(x) else None for x in med]
    return out


# ---------------------------------------------------------------- one session

def reduce_session(ch: dict[str, np.ndarray], laps: list[Lap], ambient_c: float | None = None) -> dict:
    """The small per-session summary that aggregate works from (see the module docstring).

    ambient_c: the day's air temperature, which tells cold tyres from tyres still warm from earlier running."""
    v = ch["speed"]
    n = len(v)
    clean = [l for l in laps if l.clean]
    lap_m = float(np.median([np.sum(v[_idx(l.start, n):_idx(l.end, n)]) / 3.6 / HZ for l in clean])) if clean \
        else None
    m = _track_map(ch, laps)
    baseline = None
    if m is not None and "straight" in m:  # steering swings on the straights of a normal flying lap
        baseline = float(np.median([_work(ch, l.start, l.end, m)["weave_swings"] for l in clean[:10]]))
    return {
        "best": min((l.time for l in clean), default=None), "lap_m": round(lap_m) if lap_m else None,
        "ambient_c": ambient_c, "has_tpms": any(r in ch for r in TYRE_ROLES),
        "has_map": m is not None, "weave_per_lap": baseline,
        "runs": _runs(ch, laps, lap_m, ambient_c, m, baseline),
        "clean_laps": [{"n": l.number, "time": l.time, **_tyres(ch, l.start, l.end)} for l in clean],
        "stints": _stints(ch, laps),
    }


def _runs(ch: dict[str, np.ndarray], laps: list[Lap], lap_m: float | None, ambient_c: float | None,
          m: dict | None, weave_per_lap: float | None) -> list[dict]:
    v = ch["speed"]
    moving = np.flatnonzero(v > MOVING_KMH)
    if not len(moving):
        return []
    still = np.flatnonzero(v[: moving[0]] < STILL_KMH)
    t_first = (still[-1] + 1) / HZ if len(still) else 0.0  # rolling out of the garage starts the first run
    t_last = moving[-1] / HZ
    long = _stops(v, LONG_STOP_S, STILL_KMH)
    inner = [(a, b) for a, b in long if t_first < a and b < t_last]  # stops with driving on both sides
    starts = [t_first] + [b for a, b in inner]
    ends = [a for a, b in inner] + [t_last]
    warm_above = PRE_WARMED_C if ambient_c is None else ambient_c + PRE_WARMED_ABOVE_AMBIENT_C
    runs, install, number = [], None, 0
    for s0, s1 in zip(starts, ends, strict=True):
        if s1 - s0 < MIN_RUN_S:
            continue
        number += 1
        inside = [l for l in laps if l.start >= s0 - 1 and l.end <= s1 + 1]
        flying = [l for l in inside if l.clean]
        if not flying:  # an installation run or an out-and-in: its work counts towards the next run
            install = _add(install, _work(ch, s0, s1, m))
            continue
        f0 = flying[0].start
        warm = _work(ch, s0, f0, m)
        warm["laps"] = round(warm["km"] * 1000 / lap_m) if lap_m else None
        warm["weaves"] = None
        if warm["weave_swings"] is not None and weave_per_lap is not None and lap_m:
            warm["weaves"] = max(0, round(warm["weave_swings"] - weave_per_lap * warm["km"] * 1000 / lap_m))
        leave = _tyres(ch, s0 + LEAVE_S[0], s0 + LEAVE_S[1])
        leave_km = float(np.sum(v[_idx(s0, len(v)):_idx(s0 + sum(LEAVE_S) / 2, len(v))])) / 3.6 / HZ / 1000
        front_leave = _axle(leave["t"], "front")
        stop = next(((a, b) for a, b in long if abs(a - s1) < 2), None)
        bleed = None
        if stop is not None:
            before = _tyres(ch, stop[0] - BLEED_BEFORE_S, stop[0])["p"]
            after = _tyres(ch, stop[1] + BLEED_AFTER_S[0], stop[1] + BLEED_AFTER_S[1])["p"]
            bleed = {w: round(after[w] - before[w], 3) if after[w] is not None and before[w] is not None else None
                     for w in WHEELS}
        runs.append({
            "number": number, "start_s": round(s0, 1), "end_s": round(s1, 1), "install": install, "warm": warm,
            "leave": leave, "leave_km": round(leave_km, 2), "warm_end": _tyres(ch, f0 - WARM_END_S, f0),
            "pre_warmed": None if front_leave is None else bool(front_leave > warm_above),
            "laps": [{"n": l.number, "time": l.time, "clean": l.clean} for l in inside],
            "flying": [{"n": l.number, "time": l.time, "start_s": round(l.start, 2), "end_s": round(l.end, 2),
                        "line": _tyres(ch, l.start - LINE_S, l.start + LINE_S), "lap": _tyres(ch, l.start, l.end)}
                       for l in flying],
            "axle_c": _axle_series(ch, s0, flying[-1].end),
            "stop_after_s": round(stop[1] - stop[0], 1) if stop else None, "bleed": bleed,
        })
        install = None
    return runs


def _stints(ch: dict[str, np.ndarray], laps: list[Lap]) -> list[dict]:
    """Long stints lap by lap, split and fitted as stint.py does it: the lap-time and tyre trends and notes."""
    stops = _stops(ch["speed"], STOP_S, STOP_KMH)
    out = []
    for number, stint in enumerate(split_stints(laps, stops), start=1):
        rows = []
        for i, (lap, kind) in enumerate(zip(stint, lap_kinds(stint, stops), strict=True)):
            ty = _tyres(ch, lap.start, lap.end)
            rows.append({"lap": lap.number, "tyre_lap": i + 1, "kind": kind, "time": lap.time,
                         "in_fit": False, "outlier": False, "off_trend_s": None,
                         "pressure": _r(_all4(ty["p"]), 3), "temperature": _r(_all4(ty["t"]), 1),
                         "front_c": _r(_axle(ty["t"], "front"), 1), "rear_c": _r(_axle(ty["t"], "rear"), 1)})
        flying = [r for r in rows if r["kind"] == "flying"]
        if len(flying) < LONG_RUN_LAPS:
            continue
        x = np.array([r["tyre_lap"] for r in flying], float)
        times = np.array([r["time"] for r in flying])
        bad = outliers(x, times)
        line = np.polyfit(x[~bad], times[~bad], 1) if np.count_nonzero(~bad) >= 2 else [0.0, np.median(times)]
        for r, b, xi, t in zip(flying, bad, x, times, strict=True):
            r["outlier"] = bool(b)
            r["off_trend_s"] = round(float(t - np.polyval(line, xi)), 2)
        used = [r for r in flying if not r["outlier"]]
        if len(used) < LONG_RUN_LAPS:
            continue
        for r in used:
            r["in_fit"] = True
        xu = np.array([r["tyre_lap"] for r in used], float)
        fits = {}
        for key, field in (("time", "time"), ("tyre_pressure", "pressure"), ("tyre_temperature", "temperature")):
            t = trend(xu, np.array([np.nan if r[field] is None else r[field] for r in used], float))
            if t is not None:
                fits[key] = {"label": FITTED[key][0], "unit": FITTED[key][1], **t}
        best = min(used, key=lambda r: r["time"])
        out.append({"number": number, "first_lap": stint[0].number, "last_lap": stint[-1].number,
                    "flying": len(flying), "best": best["time"],
                    "median": round(float(np.median([r["time"] for r in used])), 3),
                    "best_lap": best["lap"], "best_flying": used.index(best) + 1, "fits": fits,
                    "laps": rows, "notes": stint_notes(fits, rows, "")})
    return out


# ---------------------------------------------------------------- the report

def aggregate(sessions: list[dict], pressure_runs: list[dict] | None = None,
              minimums: list[dict] | None = None) -> dict:
    """The tyre and qualifying preparation report over reduced sessions.

    sessions: reduce_session outputs, each with "session_id", "name" and "day" added (the log's date: near-best
    laps are judged against that day's best). pressure_runs: tpms.measure_runs of the same logs, with the keys
    the pressure calculator reads (see routers/tyres.logged_runs); minimums: the series' P-Book rows.
    """
    timed = [s for s in sessions if s.get("best") is not None]
    day_best: dict[str, float] = {}
    for s in timed:
        day_best[s["day"]] = min(day_best.get(s["day"], 1e9), s["best"])
    sims = _quali_runs(timed, day_best)
    points = [p for sim in sims for p in sim["points"]]
    push = _push(points)
    if push:
        for sim in sims:
            _ready(sim, push)
    windows = _windows(timed)
    out = {
        "sessions": [{"session_id": s["session_id"], "name": s["name"], "day": s["day"], "best": s.get("best")}
                     for s in sessions],
        "day_best": day_best, "has_tpms": any(s["has_tpms"] for s in sessions),
        "has_map": any(s.get("has_map") for s in timed),
        "push": push, "peak_hold_s": PEAK_HOLD_S, "ready": _ready_summary(sims), "fastest": _fastest(sims),
        "brake_work": _brake_work(sims),
        "build": _build(sims), "pressure": _pressure_effect(points),
        "sims": [{k: v for k, v in sim.items() if k != "axle_c"} for sim in sims],
        "windows": windows, "cold": _cold(windows, pressure_runs or [], minimums or []),
        "long_runs": _long_runs(timed, sims, push),
    }
    out["advice"] = _advice(out)
    out["method"] = METHOD
    return out


def is_quali_session(s: dict) -> bool:
    """A session marked as qualifying, or named like one."""
    return s.get("kind") == "qualifying" or bool(QUALI_NAME.search(s.get("name") or ""))


def _quali_runs(sessions: list[dict], day_best: dict[str, float]) -> list[dict]:
    out = []
    for s in sessions:
        several = len(s["runs"]) > 1 or bool(s["runs"] and s["runs"][0]["number"] > 1)
        quali_session = is_quali_session(s)
        for run in s["runs"]:
            fly = run["flying"]
            times = [f["time"] for f in fly]
            bi = int(np.argmin(times[:MAX_PEAK_LAP]))  # the build's peak; a long run may go quicker later
            peak = fly[bi]
            building = bi >= 1 and float(np.polyfit(np.arange(bi + 1), times[: bi + 1], 1)[0]) < 0
            # a real qualifying run often peaks on its first flying lap, after the out-lap's warm-up, and pits soon
            # after; a long run's flat or fading laps don't (it has more laps, or its first isn't the quickest)
            first_best = bi == 0 and len(fly) <= QUALI_LAPS_AFTER + 1 and all(t > times[0] for t in times[1:])
            near = peak["time"] - s["best"] <= NEAR_SESSION_BEST_S
            warm, install = run["warm"], run["install"] or {}
            drag = (warm["drag_s"] or 0) + (install.get("drag_s") or 0)
            cold_start = run["pre_warmed"] is False
            # in a qualifying session the warm-up may be in an earlier log (the logger restarted in the pits)
            prepared = cold_start or drag >= BRAKE_WARM_S or quali_session
            if not ((building or first_best) and near and prepared):
                continue
            label = s["name"] + (f" run {run['number']}" if several else "")
            after = fly[bi + 1:]
            held = [f for f in after if f["time"] - peak["time"] <= PEAK_HOLD_S]
            last = held[-1] if held else peak
            laps_out = warm["laps"]
            # the TPMS reports once rolling: the gain per lap is over the laps from that first reading to the line
            measured = (warm["km"] - run["leave_km"]) * 1000 / s["lap_m"] if s["lap_m"] else 0.0
            per_lap = {}
            for kind, unit in (("t", "c"), ("p", "bar")):
                for axle in ("front", "rear"):
                    a, b = _axle(run["leave"][kind], axle), _axle(run["warm_end"][kind], axle)
                    gain = None if a is None or b is None or measured < MIN_GAIN_LAPS else (b - a) / measured
                    per_lap[f"{axle}_{unit}"] = _r(gain, 1 if unit == "c" else 3)
            out.append({
                "label": label, "session_id": s["session_id"], "session": s["name"], "run": run["number"],
                "day": s["day"], "kind": "quali" if len(run["laps"]) - run["laps"].index(
                    next(l for l in run["laps"] if l["n"] == peak["n"])) - 1 <= QUALI_LAPS_AFTER else "quali_start",
                "pre_warmed": bool(run["pre_warmed"]), "cold_start": cold_start,
                "warm_min": round(warm["seconds"] / 60, 1), "warm_laps": laps_out, "warm_km": warm["km"],
                "drag_s": warm["drag_s"], "brake_s": warm["brake_s"], "hard_stops": warm["hard_stops"],
                "straight_brake_s": warm["straight_brake_s"], "straight_hard_stops": warm["straight_hard_stops"],
                "weaves": warm["weaves"], "install": run["install"],
                "warm_gain_per_lap": per_lap, "leave": run["leave"],
                "first_front": _r(_axle(fly[0]["line"]["t"], "front"), 0),
                "first_rear": _r(_axle(fly[0]["line"]["t"], "rear"), 0),
                "peak_lap": peak["n"], "peak_flying": bi + 1,
                "peak_from_exit": laps_out + bi + 1 if laps_out is not None else None,
                "peak_min": round((peak["start_s"] - run["start_s"]) / 60, 1), "peak_time": peak["time"],
                "gap_day": round(peak["time"] - day_best[s["day"]], 2),
                "peak_front": _r(_axle(peak["line"]["t"], "front"), 0),
                "peak_rear": _r(_axle(peak["line"]["t"], "rear"), 0),
                "peak_pf": _r(_axle(peak["lap"]["p"], "front"), 2), "peak_pr": _r(_axle(peak["lap"]["p"], "rear"), 2),
                "peak_tyres": peak["lap"],
                "hold": {"laps": 1 + len(held), "after": len(after), "last_lap": last["n"],
                         "minutes": round((last["end_s"] - peak["start_s"]) / 60, 1)},
                "laps": run["laps"], "bleed": run["bleed"], "bleed_kind": _bleed_kind(run["bleed"]),
                "axle_c": run["axle_c"],
                "points": [{"sim": label, "session_id": s["session_id"], "lap": f["n"], "flying": i + 1,
                            "time": f["time"], "gap": round(f["time"] - day_best[s["day"]], 2),
                            "front": _r(_axle(f["line"]["t"], "front"), 0),
                            "rear": _r(_axle(f["line"]["t"], "rear"), 0),
                            "pf": _r(_axle(f["line"]["p"], "front"), 2), "pr": _r(_axle(f["line"]["p"], "rear"), 2),
                            "peak": i == bi}
                           for i, f in enumerate(fly)],
                "ready_min": None, "first_ready_lap": None, "peak_after_ready": None,
            })
    return out


def _bleed_kind(bleed: dict | None) -> str | None:
    vals = [v for v in (bleed or {}).values() if v is not None]
    if len(vals) < 2:
        return None
    drops = [-v for v in vals]
    if min(drops) >= COOLED_BAR:
        return "changed"  # new tyres, or tyres left to cool
    if max(drops) >= BLEED_BAR:
        return "bled"
    return "none"


def _push(points: list[dict]) -> dict | None:
    """The coolest TPMS temperatures at the line that a near-best lap started from."""
    near = [p for p in points if p["gap"] <= PUSH_GAP_S and p["front"] is not None and p["rear"] is not None]
    if not near:
        return None
    pf = [p["pf"] for p in near if p["pf"] is not None]
    pr = [p["pr"] for p in near if p["pr"] is not None]
    return {"front_c": int(min(p["front"] for p in near)), "rear_c": int(min(p["rear"] for p in near)),
            "laps": len(near), "gap_s": PUSH_GAP_S,
            "pf": [min(pf), max(pf)] if pf else None, "pr": [min(pr), max(pr)] if pr else None}


def _ready(sim: dict, push: dict) -> None:
    """When both axles first reached the push temperatures, and which flying lap first started there."""
    series = sim["axle_c"]
    if series:
        for i, (f, r) in enumerate(zip(series["front"], series["rear"], strict=True)):
            if i >= READY_FROM_S and f is not None and r is not None and f >= push["front_c"] \
                    and r >= push["rear_c"]:
                sim["ready_min"] = round(i / 60, 1)
                break
    pts = sim["points"]
    first = next((k for k, p in enumerate(pts) if p["front"] is not None and p["rear"] is not None
                  and p["front"] >= push["front_c"] and p["rear"] >= push["rear_c"]), None)
    if first is not None:
        sim["first_ready_lap"] = pts[first]["lap"]
        sim["peak_after_ready"] = sim["peak_flying"] - 1 - first


def _ready_summary(sims: list[dict]) -> dict | None:
    cold = [s for s in sims if s["cold_start"] and s["ready_min"] is not None]
    if not cold:
        return None
    mins = [s["ready_min"] for s in cold]
    judged = [s for s in sims if s["peak_after_ready"] is not None]
    exits = [s["peak_from_exit"] for s in cold if s["peak_from_exit"] is not None]
    return {"min": min(mins), "max": max(mins), "median": round(median(mins), 1), "runs": len(cold),
            "peak_on_ready": len([s for s in judged if s["peak_after_ready"] in (0, 1)]), "of": len(judged),
            "peak_from_exit": [min(exits), max(exits)] if exits else None}


PROCEDURE = ("label", "warm_laps", "warm_min", "drag_s", "straight_brake_s", "straight_hard_stops", "weaves",
             "ready_min", "peak_lap", "peak_flying", "peak_min", "peak_time")


def _fastest(sims: list[dict]) -> dict | None:
    """The warm-up that got the tyres from cold to the push temperatures soonest."""
    cold = [s for s in sims if s["cold_start"] and s["ready_min"] is not None]
    if not cold:
        return None
    best = min(cold, key=lambda s: (s["ready_min"], s["peak_min"]))
    return {"best": {k: best[k] for k in PROCEDURE}, "runs": len(cold)}


def _brake_work(sims: list[dict]) -> dict | None:
    """The cold-start run with the most brake dragging in its warm-up against the one with the least."""
    cold = [s for s in sims if s["cold_start"] and s["ready_min"] is not None and s["drag_s"] is not None]
    if len(cold) < 2:
        return None
    most = max(cold, key=lambda s: s["drag_s"])
    least = min(cold, key=lambda s: s["drag_s"])
    if most is least:
        return None
    return {"most": {k: most[k] for k in PROCEDURE}, "least": {k: least[k] for k in PROCEDURE},
            "saved_min": round(least["ready_min"] - most["ready_min"], 1), "runs": len(cold)}


def _build(sims: list[dict]) -> dict | None:
    """Typical TPMS gain of a warm-up lap and of each flying lap from a cold start, per axle (°C and bar)."""
    cold = [s for s in sims if s["cold_start"]]
    if not cold:
        return None
    warm = {}
    for key in ("front_c", "rear_c", "front_bar", "rear_bar"):
        vals = [s["warm_gain_per_lap"][key] for s in cold if s["warm_gain_per_lap"][key] is not None]
        warm[key] = _r(median(vals), 0 if key.endswith("_c") else 2) if vals else None
    flying = []
    for k in range(MAX_PEAK_LAP - 1):
        pairs = [(s["points"][k], s["points"][k + 1]) for s in cold if len(s["points"]) > k + 1]
        if len(pairs) < 2:
            break
        row: dict = {"lap": k + 1, "runs": len(pairs)}
        for key, nd in (("front", 0), ("rear", 0), ("pf", 2), ("pr", 2)):
            gains = [b[key] - a[key] for a, b in pairs if a[key] is not None and b[key] is not None]
            row[key] = _r(median(gains), nd) if gains else None
        flying.append(row)
    return {"warm_lap": warm, "flying": flying, "runs": len(cold)}


def _pressure_effect(points: list[dict]) -> dict | None:
    """The hot pressures the near-best laps started at: if they span a range, pressure in it didn't hold the lap."""
    near = [p for p in points if p["gap"] <= PUSH_GAP_S and p["pf"] is not None]
    if len(near) < 2:
        return None
    low, high = min(near, key=lambda p: p["pf"]), max(near, key=lambda p: p["pf"])
    pick = ("sim", "session_id", "lap", "time", "gap", "pf", "pr")
    return {"laps": len(near), "pf": [low["pf"], high["pf"]], "span_bar": round(high["pf"] - low["pf"], 2),
            "wide": high["pf"] - low["pf"] >= WIDE_BAR, "lowest": {k: low[k] for k in pick},
            "highest": {k: high[k] for k in pick}}


def _windows(sessions: list[dict]) -> dict | None:
    laps = [{"session_id": s["session_id"], "session": s["name"], **l} for s in sessions for l in s["clean_laps"]]
    if not laps:
        return None
    laps.sort(key=lambda l: l["time"])
    best = laps[0]["time"]
    fast = [l for l in laps if l["time"] - best <= WINDOW_GAP_S]
    if len(fast) < MIN_WINDOW_LAPS:
        fast = laps[:MIN_WINDOW_LAPS]
    tyres: dict[str, dict] = {}
    for w in WHEELS:
        row = {}
        for kind, nd in (("p", 2), ("t", 0)):
            vals = [l[kind][w] for l in fast if l[kind][w] is not None]
            if len(vals) >= 3:
                lo, mid, hi = np.percentile(vals, WINDOW_PCT)
                row[kind] = [round(float(lo), nd), round(float(mid), nd), round(float(hi), nd)]
        if row:
            tyres[w] = row
    if not tyres:
        return None
    return {"laps": len(fast), "of": len(laps), "within_s": round(fast[-1]["time"] - best, 2), "best": best,
            "tyres": tyres}


def _cold(windows: dict | None, runs: list[dict], minimums: list[dict]) -> dict | None:
    """Cold pressures that land each tyre in the middle of its window: the pressure calculator's answer."""
    if not windows:
        return None
    targets = {w: row["p"][1] for w, row in windows["tyres"].items() if "p" in row}
    if not targets:
        return None
    plan = pressure_plan(targets, runs, minimums)
    used = {(r.get("file_id"), r.get("set")) for r in runs if any(c.get("used") for c in r["corners"].values())}
    seen = defaultdict(list)
    for r in runs:
        for w, c in r["corners"].items():
            seen[w].append(c["cold_bar"])
    return {"targets": targets, "runs_used": len(used),
            "set_before": {w: [round(min(v), 2), round(max(v), 2)] for w, v in seen.items() if v},
            "tyres": [{"tyre": c["corner"], "target_hot_bar": c["target_hot_bar"],
                       "cold_bar": c["data"].get("cold_bar"), "rise_bar": c["data"].get("rise_bar"),
                       "runs": c["data"].get("runs"), "typical_error_bar": c["data"].get("typical_error_bar"),
                       "text": c["data"]["text"], "flags": c["flags"]} for c in plan["corners"]]}


def _long_runs(sessions: list[dict], sims: list[dict], push: dict | None) -> list[dict]:
    """Stints of LONG_RUN_LAPS or more flying laps that weren't quali sims, with the fade once the tyres were in:
    over the laps run at or above the push temperatures (lap medians), else from the stint's best lap on."""
    quali_laps = {(s["session_id"], l["n"]) for s in sims if s["kind"] == "quali" for l in s["laps"]}
    out = []
    for s in sessions:
        for st in s["stints"]:
            used = [r for r in st["laps"] if r["in_fit"]]
            if {(s["session_id"], r["lap"]) for r in used} <= quali_laps:
                continue
            if push:
                warm = [r for r in used if r["front_c"] is not None and r["rear_c"] is not None
                        and r["front_c"] >= push["front_c"] and r["rear_c"] >= push["rear_c"]]
                basis = "warm"
            else:
                best = min(used, key=lambda r: r["time"])
                warm = [r for r in used if r["tyre_lap"] >= best["tyre_lap"]]
                basis = "after_best"
            fade = trend(np.array([r["tyre_lap"] for r in warm], float), np.array([r["time"] for r in warm]))
            out.append({"session_id": s["session_id"], "session": s["name"],
                        "label": f"{s['name']}, laps {st['first_lap']}-{st['last_lap']}",
                        **{k: st[k] for k in ("number", "first_lap", "last_lap", "flying", "best", "median",
                                              "best_lap", "best_flying", "fits", "notes")},
                        "fade": fade, "fade_basis": basis, "fade_laps": len(warm),
                        "front_c": [used[0]["front_c"], used[-1]["front_c"]],
                        "rear_c": [used[0]["rear_c"], used[-1]["rear_c"]],
                        "pressure": [used[0]["pressure"], used[-1]["pressure"]],
                        "laps": [{k: r[k] for k in ("lap", "kind", "time", "in_fit", "outlier", "front_c",
                                                    "rear_c", "pressure")} for r in st["laps"]]})
    return out


# ---------------------------------------------------------------- advice, in plain words

def _lap(s: float) -> str:
    m = int(s // 60)
    return f"{m}:{s - 60 * m:06.3f}" if m else f"{s:.3f}"


def _nth(n: int) -> str:
    return f"{n}{'th' if 10 <= n % 100 <= 20 else {1: 'st', 2: 'nd', 3: 'rd'}.get(n % 10, 'th')}"


def _span(lo: float, hi: float, nd: int = 0) -> str:
    a, b = f"{lo:.{nd}f}", f"{hi:.{nd}f}"
    return a if a == b else f"{a} to {b}"


def _plural(n: int | None, word: str) -> str:
    return f"{n} {word}{'' if n == 1 else 's'}"


def _procedure(p: dict) -> str:
    """A warm-up in a few words: '2 warm-up laps, 88 s of brake dragging, 5 hard stops on the straights'."""
    parts = [_plural(p["warm_laps"], "warm-up lap")] if p["warm_laps"] is not None else []
    if p["drag_s"] is not None:
        parts.append(f"{p['drag_s']:.0f} s of brake dragging")
    if p["straight_hard_stops"]:
        parts.append(f"{_plural(p['straight_hard_stops'], 'hard stop')} on the straights")
    if p["weaves"]:
        parts.append(f"{p['weaves']} weaving swings")
    return ", ".join(parts)


def _advice(r: dict) -> list[dict]:
    """The answers, most useful first: each {"key", "title", "text"}."""
    if not r["has_tpms"]:
        return [{"key": "no_tpms", "title": "No tyre sensors",
                 "text": "These logs have no TPMS channels (pTyre and TTyre for each tyre), so the tyre "
                         "preparation can't be read from them."}]
    out = []
    push, ready, fastest, brakes = r["push"], r["ready"], r["fastest"], r["brake_work"]
    sims = r["sims"]
    if push and fastest and ready:
        f = fastest["best"]
        lo, hi = ready["peak_from_exit"] or (None, None)
        text = (f"Warm up like {f['label']} ({_procedure(f)}): from cold it had the tyres up to temperature "
                f"{f['ready_min']:.1f} min after leaving, the quickest of {_plural(fastest['runs'], 'cold start')}. "
                f"Then push from the first lap that starts with the fronts at {push['front_c']} °C and the rears at "
                f"{push['rear_c']} °C on the TPMS")
        text += f"; the best lap came {_span(lo, hi)} laps after leaving the pits." if lo is not None else "."
        out.append({"key": "plan", "title": "Recommendation", "text": text})
    elif push:
        out.append({"key": "plan", "title": "Recommendation",
                    "text": f"Push from the first lap that starts with the fronts at {push['front_c']} °C and the "
                            f"rears at {push['rear_c']} °C on the TPMS."})
    if not sims:
        out.append({"key": "no_sims", "title": "No quali-style run found",
                    "text": "No run started on cold tyres or with a brake warm-up and then built its lap times to a "
                            f"best within {NEAR_SESSION_BEST_S:.1f} s of the session's best in its first "
                            f"{MAX_PEAK_LAP} flying laps, or set its best on the first flying lap and pitted soon "
                            "after. Run a quali simulation, or name the qualifying session Q (or mark it as "
                            "qualifying), to get the warm-up advice."})
    if push:
        out.append({"key": "push", "title": "When to push",
                    "text": f"All {_plural(push['laps'], 'lap')} within {push['gap_s']:.1f} s of the day's best "
                            f"started with the fronts at {push['front_c']} °C or more and the rears at "
                            f"{push['rear_c']} °C or more (TPMS axle averages at the line)."})
    if ready:
        text = (f"From cold the tyres got there {_span(ready['min'], ready['max'], 1)} minutes after leaving the pits "
                f"(median {ready['median']:.1f}, {_plural(ready['runs'], 'cold start')}).")
        if ready["of"]:
            text += (f" In {ready['peak_on_ready']} of {ready['of']} quali-style runs the best lap was the first lap "
                     "that started up to temperature, or the one after it.")
        held = max((s for s in sims if s["kind"] == "quali_start"), key=lambda s: s["hold"]["laps"], default=None)
        if held and held["hold"]["laps"] >= 3:
            text += (f" Once in, the pace held: {held['label']} stayed within {PEAK_HOLD_S:.1f} s of its build's best "
                     f"for {held['hold']['laps']} of {held['hold']['after'] + 1} laps, so there is no single-lap "
                     "peak to miss.")
        out.append({"key": "ready", "title": "Peak lap", "text": text})
    build = r["build"]
    if build:
        wl = build["warm_lap"]
        parts = []
        if wl.get("front_c") is not None:
            parts.append(f"A warm-up lap adds about {wl['front_c']:.0f} °C to the fronts"
                         + (f" and {wl['rear_c']:.0f} °C to the rears" if wl.get("rear_c") is not None else "")
                         + (f" ({wl['front_bar']:+.2f} bar at the front)" if wl.get("front_bar") is not None else "")
                         + ".")
        steps = [f"{x['front']:+.0f}" for x in build["flying"] if x["front"] is not None]
        if steps:
            parts.append("Then each flying lap from cold adds " + ", ".join(steps) + " °C to the fronts, lap by lap. "
                         "Read the TPMS at the line rather than counting laps.")
        if parts:
            out.append({"key": "build", "title": "Build laps", "text": " ".join(parts)})
    if brakes:
        m, l = brakes["most"], brakes["least"]
        saved = brakes["saved_min"]
        verdict = (f"More brake work got the tyres ready about {saved:.1f} min sooner" if saved > 0 else
                   "More brake work in the warm-up did not get the tyres ready sooner")
        out.append({"key": "brakes", "title": "Brake warming",
                    "text": f"{verdict}: {m['label']} ({_procedure(m)}) was ready at {m['ready_min']:.1f} min, "
                            f"{l['label']} ({_procedure(l)}) at {l['ready_min']:.1f} min. "
                            f"From {_plural(brakes['runs'], 'cold start')}, so treat it as a trend to test."})
    pres = r["pressure"]
    if pres:
        lo, hi = pres["lowest"], pres["highest"]
        text = (f"The near-best laps started at {pres['pf'][0]:.2f} to {pres['pf'][1]:.2f} bar on the fronts, hot: "
                f"{lo['sim']} lap {lo['lap']} at {lo['pf']:.2f} bar was {lo['gap']:.2f} s off the day's best, "
                f"{hi['sim']} lap {hi['lap']} at {hi['pf']:.2f} bar {hi['gap']:.2f} s off.")
        if pres["wide"]:
            text += " Within this range the hot pressure made no difference to the pace: set it for the race."
        out.append({"key": "pressure", "title": "Hot pressure", "text": text})
    w, cold = r["windows"], r["cold"]
    if w:
        fl = w["tyres"].get("FL", {})
        text = (f"On the {w['laps']} fastest laps (within {w['within_s']:.2f} s of the best) each tyre ran in the "
                "window below.")
        if "p" in fl and "t" in fl:
            text += f" The front-left sat at {fl['p'][1]:.2f} bar and {fl['t'][1]:.0f} °C in the middle of it."
        out.append({"key": "window", "title": "Where the fast laps happened", "text": text})
    if cold and any(c["cold_bar"] is not None for c in cold["tyres"]):
        sets = ", ".join(f"{c['tyre']} {c['cold_bar']:.2f}" for c in cold["tyres"] if c["cold_bar"] is not None)
        out.append({"key": "cold", "title": "What to set cold",
                    "text": f"To land in the middle of the window, set {sets} bar cold: the pressure calculator's "
                            f"answer from the cold-to-hot rise of {_plural(cold['runs_used'], 'logged run')}. Open "
                            "the calculator to account for today's temperatures."})
    elif cold:
        out.append({"key": "cold", "title": "What to set cold",
                    "text": "No run in these logs ran long enough on one set for the pressures to settle (12 minutes "
                            "at speed), so the cold-to-hot rise can't be learned yet. Enter the window's middle as "
                            "the hot target in the pressure calculator."})
    lr = r["long_runs"]
    if lr:
        fades = [x["fade"] for x in lr if x["fade"]]
        clear = [f for f in fades if f["clear"] and f["per_lap"] > 0]
        longest = max(lr, key=lambda x: x["flying"])
        text = f"{_plural(len(lr), 'long run')}, the longest {longest['flying']} flying laps ({longest['label']})."
        if clear:
            text += (f" Once the tyres were up to temperature the lap time rose a median "
                     f"{median([f['per_lap'] for f in clear]):.2f} s a lap in {len(clear)} of {len(fades)}.")
        elif fades:
            text += (f" Once the tyres were up to temperature the lap times held: no clear fade in "
                     f"{_plural(len(fades), 'run')} long enough to tell.")
        text += " Fuel burning off hides some of the tyre fade."
        out.append({"key": "fade", "title": "Long runs", "text": text})
    return out


METHOD = [
    "Runs are split at every stop of 15 s or more. A quali-style run starts on cold tyres (fronts less than 25 °C "
    "above the air temperature when leaving) or with at least 15 s of brake dragging, then its flying laps get "
    "quicker to a best within 0.5 s of the session's best on one of its first 6 flying laps, or its first flying "
    "lap is its best and it pits within 3 laps. In a session marked as qualifying or named like one (Q, Q1, "
    "Quali) the cold-tyre or brake-dragging start isn't needed: the warm-up may be in an earlier log. A quali sim "
    "pits within 3 laps of its best; a quali-style start carries on as a long run.",
    "Tyre temperatures and pressures are the TPMS: the air inside the tyre, not the tread. At the line means the "
    "median over 3 s either side of it; axle values are the average of the two tyres.",
    "Push temperatures are the coolest that any lap within 0.3 s of the day's best started from. Ready is the first "
    "moment, at least a minute after leaving, that both axles reached them. The peak holds while laps stay within "
    "0.4 s of the build's best.",
    "Warm-up work above 60 km/h. Brake dragging: front brakes over 3 bar with the throttle over 15 %. Hard stops "
    "on the straights: separate applications over 40 bar where the session's fastest lap doesn't brake. Weaving: "
    "steering swings of a tenth of the cornering lock where the fastest lap runs straight, above the number a "
    "normal flying lap has there.",
    "Tyre windows: the 10th to 90th percentile of the lap medians on the laps within 0.5 s of the best (at least "
    "the 5 fastest). Cold pressures come from the pressure calculator, learned from every logged run that settled.",
    "Long runs: stints of 6 or more flying laps, split and fitted as in the stint analysis; the fade is the trend "
    "over the laps run with the tyres at or above the push temperatures.",
]
