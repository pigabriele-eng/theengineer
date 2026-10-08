"""Two drivers corner by corner (the report's Drivers section, routers/report_drivers.py): each one's passes through
each official corner group, ranked as the report ranks them (analysis/advice.py _against_neighbours: each pass's
section time against the same section on the two laps either side of it in its own run, so tyre age, fuel and the
track as it was cancel out) and split into the top 10% (at least three passes), as many in the middle and the bottom
10%; for each group the point by point median of speed, brake and throttle through the corner on a coarse grid, with
the technique numbers that go with it: braking point, peak brake, brakes off, minimum speed and where and in what
gear, throttle on, full throttle, exit speed. Positions are metres from the corner's apex (minus: before it), the
same apex for both drivers: the reference lap's slowest point, or a corner taken flat's official position.

Each lap is reduced as it is read (summarise, handed to compare._read): its section metrics (compare._section) and
three short traces per section, so a weekend of laps fits in a few megabytes. Pure numbers, so the tests run it on
made-up traces.
"""
from __future__ import annotations

import warnings
from dataclasses import dataclass

import numpy as np

from app.analysis.advice import CORNER_WINDOW_M, MIN_QUICK, QUICK_SHARE, _against_neighbours
from app.analysis.channels import PHASES
from app.analysis.compare import EXIT_M, _dt, _section, _steer_offset

SIDES = ("a", "b")
GROUPS = ("top", "median", "bottom")  # "Top 10%", "Median", "Bottom 10%" on the page
STEP_M = 5  # the traces' grid
CHANNELS = ("speed", "brake", "throttle")
BEFORE_M = 40  # a corner's traces start this far before the earliest braking point shown...
FLAT_BEFORE_M = 150  # ...or this far before the apex where nobody brakes
AFTER_M = 40  # and end this far after the latest full throttle (at least EXIT_M after the apex, where exit speed is)
KEEP = ("time", "min_speed", "min_speed_at", "exit_speed", "brake_point", "peak_brake", "trail_share", "throttle_on",
        "full_throttle", *(f"time_{p}" for p in PHASES))
POSITIONS = ("brake_point", "brake_off", "min_speed_at", "throttle_on", "full_throttle")  # sent from the apex


@dataclass
class Pass:
    """One clean lap, reduced: its numbers per section and its short traces per section."""
    side: str
    session_id: int
    number: int
    time: float
    sections: list[dict]
    traces: list[np.ndarray]  # per section: (3, points) float32, CHANNELS every STEP_M from the section's start


def summarise(tr: dict[str, np.ndarray], src, lap, index: int, sections: list) -> Pass:
    """compare._read's reduction of one lap's trace on the distance grid (1 m)."""
    dt = _dt(tr["t"])
    steer0 = _steer_offset(tr) if "steer" in tr else 0.0
    out, traces = [], []
    n = len(tr["speed"])
    nan = np.full(n, np.nan)
    for s in sections:
        m = _section(tr, dt, s, steer0)
        row = {k: m.get(k) for k in KEEP}
        if s.apex is None and s.at:  # a corner taken flat: its speed is the lowest near its official position
            lo, hi = max(s.start, s.at[0] - CORNER_WINDOW_M), min(s.end, s.at[0] + CORNER_WINDOW_M)
            if hi > lo:
                j = lo + int(np.argmin(tr["speed"][lo:hi + 1]))
                row["min_speed"], row["min_speed_at"] = float(tr["speed"][j]), j
        bp = m.get("brake_point")
        row["brake_off"] = None
        if bp is not None:  # where the braking that starts there ends: the release, trail braking included
            off = np.flatnonzero(tr["braking"][bp:s.end] <= 0.5)
            row["brake_off"] = bp + int(off[0]) if len(off) else None
        row["gear"] = float(tr["gear"][row["min_speed_at"]]) if "gear" in tr else None
        out.append(row)
        at = np.minimum(np.arange(s.start, s.end + 1, STEP_M), n - 1)
        traces.append(np.stack([tr.get(ch, nan)[at] for ch in CHANNELS]).astype(np.float32))
    return Pass(src.side, int(src.meta["session_id"]), lap.number, float(lap.time), out, traces)


def groups(times: np.ndarray, runs: list[str], index: np.ndarray) -> dict[str, np.ndarray]:
    """The passes of each group, by index: ranked by how much each beat the laps around it in its run, the top tenth
    (at least three, as advice._quick takes them), as many from the middle of the ranking and the bottom tenth."""
    order = np.argsort(_against_neighbours(times, runs, index), kind="stable")
    k = min(len(times), max(MIN_QUICK, round(len(times) * QUICK_SHARE)))
    mid = max(0, (len(order) - k) // 2)
    return {"top": order[:k], "median": order[mid:mid + k], "bottom": order[len(order) - k:]}


def _median(vals: list, min_share: float = 0.5) -> float | None:
    """The median of the values known, when at least this share of the passes has one (a corner most take flat has
    no braking point)."""
    got = [float(v) for v in vals if v is not None]
    return float(np.median(got)) if got and len(got) >= min_share * len(vals) else None


def _numbers(rows: list[dict], anchor: int) -> dict:
    out: dict = {"passes": len(rows)}
    for k in (*POSITIONS, "peak_brake", "trail_share", "min_speed", "exit_speed", "time", "gear"):
        v = _median([r.get(k) for r in rows])
        if v is not None and k in POSITIONS:
            v -= anchor
        out[k] = None if v is None else round(v, 3 if k == "time" else 2 if k == "trail_share" else 1)
    if out["gear"] is not None:
        out["gear"] = round(out["gear"])
    return out


def _trace(arrays: list[np.ndarray], i0: int, i1: int) -> dict:
    with warnings.catch_warnings():  # a channel the log hasn't is all NaN: sent as nulls
        warnings.simplefilter("ignore", RuntimeWarning)
        med = np.nanmedian(np.stack([a[:, i0:i1] for a in arrays]), axis=0)
    out = {}
    for c, ch in enumerate(CHANNELS):
        digits = 1 if ch == "speed" else 0
        out[ch] = [None if np.isnan(v) else (round(float(v), 1) if digits else round(float(v))) for v in med[c]]
    return out


def corner_view(passes: list[Pass], sections: list, step: int = STEP_M) -> list[dict]:
    """Per section: both sides' groups (numbers and traces on one window, from the apex), and the section time gap,
    a minus b."""
    by = {g: [p for p in passes if p.side == g] for g in SIDES}
    out = []
    for k, s in enumerate(sections):
        if not by["a"] or not by["b"]:
            break
        if s.apex is not None:  # the slowest point of the reference lap
            anchor = int(s.apex)
        elif s.at:  # a corner taken flat: its official position
            anchor = int(s.at[0])
        else:
            anchor = int(np.median([p.sections[k]["min_speed_at"] for p in passes]))
        sides: dict = {}
        for g in SIDES:
            rows = [p.sections[k] for p in by[g]]
            times = np.array([r["time"] for r in rows])
            found = groups(times, [str(p.session_id) for p in by[g]], np.array([p.number for p in by[g]]))
            sides[g] = {name: (idx, _numbers([rows[i] for i in idx], anchor)) for name, idx in found.items()}
        bps = [n["brake_point"] for g in SIDES for _, n in sides[g].values() if n["brake_point"] is not None]
        fulls = [n["full_throttle"] for g in SIDES for _, n in sides[g].values() if n["full_throttle"] is not None]
        start = anchor + min(bps) - BEFORE_M if bps else anchor - FLAT_BEFORE_M
        end = anchor + max([EXIT_M, *(f + AFTER_M for f in fulls)])
        i0 = max(0, int((start - s.start) // step))
        i1 = min(len(by["a"][0].traces[k][0]), int((min(end, s.end) - s.start) // step) + 1)
        i1 = max(i1, i0 + 2)
        grp: dict = {}
        for name in GROUPS:
            grp[name] = {}
            for g in SIDES:
                idx, numbers = sides[g][name]
                grp[name][g] = {**numbers, **_trace([by[g][i].traces[k] for i in idx], i0, i1)}
        t = {g: np.array([p.sections[k]["time"] for p in by[g]]) for g in SIDES}
        med = {g: float(np.median(t[g])) for g in SIDES}
        delta = med["a"] - med["b"]
        faster = "a" if delta < 0 else "b"
        other = "b" if faster == "a" else "a"
        by_phase = {}
        for p in PHASES:
            v = {g: _median([x.sections[k][f"time_{p}"] for x in by[g]]) for g in SIDES}
            by_phase[p] = None if None in v.values() else round(v["a"] - v["b"], 3)
        same_way = [(p, v) for p, v in by_phase.items() if v is not None and v * delta > 0]
        out.append({
            "code": s.code, "corners": s.corners, "apex_m": anchor, "flat": s.apex is None,
            "from_m": s.start + i0 * step - anchor, "step_m": step,
            "median": {g: round(med[g], 3) for g in SIDES}, "delta_s": round(delta, 3), "faster": faster,
            # how many of the quicker driver's passes beat the other's typical pass here
            "beats": int(np.count_nonzero(t[faster] < med[other])), "of": len(t[faster]),
            "by_phase": by_phase, "main_phase": max(same_way, key=lambda pv: abs(pv[1]))[0] if same_way else None,
            "groups": grp,
        })
    return out
