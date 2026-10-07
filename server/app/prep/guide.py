"""The lap guide of a coming weekend: the gear map and the corner-by-corner passes of the race weekend's Before view.

From the past events at the venue with the same car (app/prep/plan.py), worked out from the report's compact lap
traces (analysis/compact.py): no log is opened, and one session's traces are in memory at a time.

- The gear map is the best lap here (the quickest clean lap of all the past events): its path every MAP_STEP_M from
  the start/finish line, the gear held at each point, where the braking starts (with the gear on the way in and the
  gear the braking ends in), and the official corners with the lowest gear through each.
- The corners are the report's sections on that lap (the official numbers, grouped as the analysis groups them: "T1",
  "T2-T5", "T8/T9"). Every clean lap here is placed on the best lap's line and timed through each section; each
  section keeps two passes with their speed, throttle, brake and gear every TRACE_STEP_M: the best pass there (the
  quickest of all the laps, which can be on another lap than the best lap) and a typical pass (the lap whose time
  through the section is the median one).
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from app.analysis import compact
from app.analysis.laps import CornerSpec, make_sections
from app.analysis.side_by_side import Reference
from app.analysis.trackmap import DIRECTION_M, _closed_path

GUIDE_VERSION = 1  # raise when the answer changes, so every kept one is worked out again
MAP_STEP_M = 10  # one map point every 10 m: about 460 at Hockenheim
TRACE_STEP_M = 3  # the passes' traces, one point every 3 m
BRAKE_ON = 0.12  # share of the lap's hardest braking that counts as braking, where the log has no braking flag
MIN_BRAKE_M = 20  # a shorter dab of the brake (a lift and a touch in a fast corner) isn't a braking zone
JOIN_BRAKE_M = 25  # two stretches of braking closer than this are one zone
APEX_M = 15  # the gear through a corner: the lowest within this far of its apex
EXIT_M = 30  # the gear a braking zone ends in: the lowest up to this far after it
FIRST_KMH = (8.0, 60.0)  # first gear: the gear the car is driven in at these speeds (pulling away, the pit lane)...
FIRST_S = 1.5  # ...for this long at least
RATIO_STEP = 1.12  # a gear below has at least this many more revs per km/h than the gear above it
PASS_ROLES = ("speed", "throttle", "brake")
ROUND = {"speed": 1, "throttle": 0, "brake": 1}


@dataclass
class Source:
    """A session the guide reads, with what its answer names it by."""
    session_id: int
    session: str
    driver: str | None
    event_id: int
    event: str
    year: str | None


def _role(cs: compact.CompactSession, role: str) -> np.ndarray | None:
    arr = cs.traces.get(role)
    if arr is None or not arr.size:
        return None
    if arr.dtype != np.int8 and not np.isfinite(arr).any():
        return None
    return arr


def _gears(g: np.ndarray, step: int) -> list[int | None]:
    """The gear held over each step of the lap: the most common forward gear there (shifts and neutral read 0), else
    the one before."""
    out: list[int | None] = []
    last = None
    for a in range(0, len(g), step):
        part = g[a:a + step]
        part = part[part > 0]
        if part.size:
            vals, counts = np.unique(part, return_counts=True)
            last = int(vals[np.argmax(counts)])
        out.append(last)
    return out


def _lowest(g: np.ndarray | None, a: float, b: float) -> int | None:
    if g is None:
        return None
    part = g[max(0, int(a)):max(0, int(b)) + 1]
    part = part[part > 0]
    return int(part.min()) if part.size else None


def _braking(cs: compact.CompactSession, i: int, length: int) -> np.ndarray | None:
    """Where the lap brakes, metre by metre: the analysis' own braking flag, else the brake channel over BRAKE_ON of
    its hardest."""
    p = cs.pad
    flag = _role(cs, "braking")
    if flag is not None:
        return flag[i, p:p + length + 1] > 0
    brake = _role(cs, "brake")
    if brake is None:
        return None
    b = np.abs(brake[i, p:p + length + 1].astype(float))
    top = float(np.nanmax(b)) if np.isfinite(b).any() else 0.0
    return b > BRAKE_ON * top if top > 0 else None


def _zones(on: np.ndarray) -> list[tuple[int, int]]:
    """The braking zones as (first metre, last metre), short gaps joined and short dabs left out."""
    edges = np.flatnonzero(np.diff(np.concatenate([[0], on.astype(np.int8), [0]])))
    runs = [[int(a), int(b) - 1] for a, b in zip(edges[::2], edges[1::2], strict=True)]
    joined: list[list[int]] = []
    for r in runs:
        if joined and r[0] - joined[-1][1] <= JOIN_BRAKE_M:
            joined[-1][1] = r[1]
        else:
            joined.append(r)
    return [(a, b) for a, b in joined if b - a + 1 >= MIN_BRAKE_M]


def lowest_gear(cs: compact.CompactSession, lap: int) -> int | None:
    """The lowest forward gear the lap is held in (as logged) for a stretch of the map, not a passing value."""
    g = _role(cs, "gear")
    if g is None:
        return None
    held = [x for x in _gears(g[lap, cs.pad:cs.pad + cs.length + 1].astype(int), MAP_STEP_M) if x is not None]
    return min(held) if held else None


def first_gear(gear: tuple[np.ndarray, np.ndarray], speed: tuple[np.ndarray, np.ndarray],
               rpm: tuple[np.ndarray, np.ndarray] | None, lowest: int) -> int:
    """The value the log gives first gear: some dashes number the gears with an offset (the BMW M4 GT4's NGearPos
    logs neutral as 3 and first gear as 5). From the lowest gear the best lap uses, each value below it that the car is
    driven in (FIRST_KMH, for FIRST_S or more) with more revs per km/h than the gear above it (RATIO_STEP) is the
    gear below, down to the gear the car pulls away in: first gear. Each argument is (times, values)."""
    t, raw = gear
    g = np.rint(raw).astype(int)
    v = np.interp(t, speed[0], speed[1])
    r = np.interp(t, rpm[0], rpm[1]) if rpm is not None else None
    dt = float(np.median(np.diff(t))) if len(t) > 1 else 0.0

    def ratio(x: int) -> float | None:
        m = (g == x) & (v > FIRST_KMH[0])
        return float(np.median(r[m] / v[m])) if r is not None and m.any() else None

    first = lowest
    while True:
        below = first - 1
        driven = (g == below) & (v >= FIRST_KMH[0]) & (v <= FIRST_KMH[1])
        if np.count_nonzero(driven) * dt < FIRST_S:
            return first
        k_below, k_first = ratio(below), ratio(first)
        if k_below is not None and k_first is not None and k_below < RATIO_STEP * k_first:
            return first  # no shorter a gear than the one above it: not a gear below (reverse, a shift's value)
        first = below


def reference(source: Source, cs: compact.CompactSession, lap: int, corners: list[CornerSpec] | None) -> Reference:
    """The lap given (index into the session's clean laps) as the reference: its line and the report's sections."""
    speed = cs.traces["speed"][lap, cs.pad:cs.pad + cs.length + 1].astype(float)
    sections, numbering = make_sections({"speed": speed}, corners)
    return Reference(source.session_id, int(cs.numbers[lap]), float(cs.times[lap]), cs.line, cs.length, sections,
                     numbering)


def gear_map(cs: compact.CompactSession, lap: int, ref: Reference, corners: list[CornerSpec] | None,
             shift: int = 0) -> dict | None:
    """The best lap drawn with its gears (the logged value less shift; 0 and below: no gear): None when its log has
    no GPS position (no path to draw)."""
    line = cs.line
    length = cs.length
    if line is None or length < 4 * MAP_STEP_M:
        return None
    x, y = _closed_path(np.asarray(line.x, float), np.asarray(line.y, float))
    gear_tr = _role(cs, "gear")
    g = gear_tr[lap, cs.pad:cs.pad + length + 1].astype(int) - shift if gear_tr is not None else None
    idx = np.arange(0, length, MAP_STEP_M)

    def at(m: float) -> dict:
        k = int(np.clip(round(m), 0, length - 1))
        return {"x": round(float(x[k]), 1), "y": round(float(y[k]), 1)}

    def heading(m: float) -> dict:
        a, b = round(m) - 4, round(m) + 4
        dx, dy = float(x[b % length] - x[a % length]), float(y[b % length] - y[a % length])
        norm = float(np.hypot(dx, dy)) or 1.0
        return {"dx": round(dx / norm, 3), "dy": round(dy / norm, 3)}

    dx = float(x[DIRECTION_M] - x[-DIRECTION_M])
    dy = float(y[DIRECTION_M] - y[-DIRECTION_M])
    norm = float(np.hypot(dx, dy)) or 1.0
    area = 0.5 * float(np.sum(x * np.roll(y, -1) - np.roll(x, -1) * y))
    on = _braking(cs, lap, length)
    braking = []
    for a, b in _zones(on) if on is not None else []:
        braking.append({"start_m": a, "end_m": b, **at(a), **heading(a),
                        "gear_in": _lowest(g, a - 5, a) if g is not None else None,
                        "gear_out": _lowest(g, a, b + EXIT_M)})
    official = sorted((c for c in corners or [] if c[1] is not None and 0 <= c[1] < length), key=lambda c: c[1])
    return {
        "length_m": length,
        "step_m": MAP_STEP_M,
        "clockwise": area < 0,
        "x": np.round(x[idx], 1).tolist(),
        "y": np.round(y[idx], 1).tolist(),
        "gear": _gears(g, MAP_STEP_M) if g is not None else None,
        "start": {**at(0), "dx": round(dx / norm, 4), "dy": round(dy / norm, 4)},
        "braking": braking,
        "corners": [{"code": c[0], "at_m": round(float(c[1])), **at(c[1]),
                     "gear": _lowest(g, c[1] - APEX_M, c[1] + APEX_M)} for c in official]
        if ref.numbering == "official" else [],
        "sections": [{"code": s.code, "start_m": s.start, "end_m": s.end, "apex_m": s.apex,
                      "apex": at(s.apex) if s.apex is not None else None,
                      "gear": _lowest(g, s.apex - APEX_M, s.apex + APEX_M) if s.apex is not None else None}
                     for s in ref.sections],
    }


class Guide:
    """Built one session at a time: the reference session first (the one with the best lap here), then the others."""

    def __init__(self, source: Source, cs: compact.CompactSession, lap: int, corners: list[CornerSpec] | None,
                 first: int | None = None):
        """first: the value the log gives first gear (first_gear), None when unknown: gears as logged."""
        self.corners = corners
        self.first = first
        self.shift = first - 1 if first is not None else 0
        self.ref = reference(source, cs, lap, corners)
        self.map = gear_map(cs, lap, self.ref, corners, self.shift)
        self.best = {"session_id": source.session_id, "session": source.session, "driver": source.driver,
                     "event_id": source.event_id, "event": source.event, "year": source.year,
                     "lap": int(cs.numbers[lap]), "time": round(float(cs.times[lap]), 3)}
        self.grid = np.arange(0, self.ref.length + 1, TRACE_STEP_M)
        self.sources: list[Source] = []
        self.laps: list[tuple[int, int, float]] = []  # (source index, lap number, lap time)
        self.times: list[np.ndarray] = []  # each lap's time through each section
        self.traces: list[dict[str, np.ndarray | None]] = []  # each lap's PASS_ROLES and gear on the grid
        self.units: dict[str, str] = {}
        self.add(source, cs)

    def add(self, source: Source, cs: compact.CompactSession, floor: float = 0.0) -> None:
        """Every clean lap of the session on the reference line (but laps quicker than floor: a pit log's stub)."""
        if not cs.n_laps:
            return
        k = len(self.sources)
        self.sources.append(source)
        for role in (*PASS_ROLES, "gear"):
            if role in cs.units and role not in self.units:
                self.units[role] = cs.units[role]
        j = compact.positions_on(cs, self.ref.line, self.ref.length) + cs.pad
        n = cs.traces["t"].shape[1]
        base = np.arange(n, dtype=float)
        jg = j[self.grid]
        near = np.clip(np.rint(jg).astype(int), 0, n - 1)
        starts = np.array([s.start for s in self.ref.sections])
        ends = np.array([s.end for s in self.ref.sections])
        roles = {r: _role(cs, r) for r in (*PASS_ROLES, "gear")}
        for i in range(cs.n_laps):
            if float(cs.times[i]) < floor:
                continue
            t = np.interp(j, base, cs.traces["t"][i])
            times = t[ends] - t[starts]
            times[~np.isfinite(times) | (times <= 0)] = np.inf
            self.laps.append((k, int(cs.numbers[i]), float(cs.times[i])))
            self.times.append(times)
            tr: dict[str, np.ndarray | None] = {}
            for r in PASS_ROLES:
                arr = roles[r]
                tr[r] = np.interp(jg, base, arr[i]).astype(np.float32) if arr is not None else None
            g = roles["gear"]
            tr["gear"] = g[i][near].astype(int) - self.shift if g is not None else None
            self.traces.append(tr)

    def _pass(self, lap: int, k: int, a: int, b: int) -> dict:
        src = self.sources[self.laps[lap][0]]
        tr = self.traces[lap]
        out = {"session_id": src.session_id, "session": src.session, "driver": src.driver, "event_id": src.event_id,
               "year": src.year, "lap": self.laps[lap][1], "lap_time": round(self.laps[lap][2], 3),
               "time": round(float(self.times[lap][k]), 3)}
        for r in PASS_ROLES:
            v = tr[r]
            out[r] = None if v is None else [None if not np.isfinite(x) else round(float(x), ROUND[r])
                                             for x in v[a:b + 1]]
        g = tr["gear"]
        out["gear"] = None if g is None else [int(x) if x > 0 else None for x in g[a:b + 1]]
        return out

    def result(self) -> dict:
        corners = []
        times = np.array(self.times) if self.times else np.zeros((0, len(self.ref.sections)))
        official = sorted((c for c in self.corners or [] if c[1] is not None), key=lambda c: c[1])
        for k, s in enumerate(self.ref.sections):
            col = times[:, k] if len(times) else np.zeros(0)
            ok = np.flatnonzero(np.isfinite(col))
            row = {"code": s.code, "corners": s.corners, "start_m": s.start, "end_m": s.end, "apex_m": s.apex,
                   "marks": [{"code": c[0], "at_m": round(float(c[1]))} for c in official if s.start <= c[1] <= s.end]
                   if self.ref.numbering == "official" else [],
                   "passes": int(ok.size), "best": None, "typical": None, "gain_s": None}
            if ok.size:
                order = ok[np.argsort(col[ok], kind="stable")]
                best, typical = int(order[0]), int(order[(len(order) - 1) // 2])
                a = int(np.searchsorted(self.grid, s.start))
                b = int(np.searchsorted(self.grid, s.end, side="right")) - 1
                row.update({"x0_m": int(self.grid[a]), "best": self._pass(best, k, a, b),
                            "typical": self._pass(typical, k, a, b),
                            "gain_s": round(float(col[typical] - col[best]), 3)})
            corners.append(row)
        return {"numbering": self.ref.numbering, "length_m": self.ref.length, "step_m": TRACE_STEP_M,
                "units": {r: self.units.get(r) for r in PASS_ROLES}, "best_lap": self.best,
                # gears numbered from first gear, or as the log numbers them when first gear couldn't be found
                "gears": {"first_logged_as": self.first, "as_logged": self.first is None},
                "laps": len(self.laps), "map": self.map, "corners": corners}
