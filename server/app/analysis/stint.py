"""Stints: each run on one set of tyres, lap by lap: how the car fades, and how the driver adapts to it.

A stint is the laps between two stops (the car standing in the pit box or the garage). The work is split in two
so the screen stays quick and a small server copes:

- reduce_run reads one log (the heavy part: the caller runs it under app.heavy.lock, one log at a time, and keeps
  the result) and keeps, per lap, a few numbers per corner and phase and three small arrays per lap (every lap but
  a pit lap, so a lap the user counts can join the trends);
- assemble works out the stints of any set of reduced logs with the user's lap tags, in a fraction of a second.

Per lap: the grip the car pulled in each phase, in g (the 90th percentile over the lap's metres in the phase):
straight-line braking deceleration, combined g while trail braking, lateral g mid-corner, combined g on the exit,
and traction (forward g at full throttle below 140 km/h). The balance per phase is read as the car balance report
reads it (analysis/balance.py): the understeer angle against the car's normal at the same lateral g, the normal
being the degrees per g fitted on every clean lap of the logs in view. The driver's inputs per corner: brake point,
peak brake pressure, braking done while turning, minimum speed and where it falls, steering mid-corner, throttle
pick-up and full throttle, traction control, the line at the apex (GPS) and upshift revs. Fuel used and what its
mass costs on the lap come from analysis/fuel.py.

Per stint: trends through the flying laps (laps tagged safety car, FCY or traffic, and clear outliers, stay out; an
out-lap, in-lap, slow lap or outlier the user counts comes in, a pit lap never does),
the lap time trend split into fuel burn and tyre fade, the tyre fade split by phase (the seconds a lap lost where
the car brakes, turns in, corners, exits and accelerates, as the stint goes on), and the balance shift per corner
from the stint's early laps to its late laps.
"""
from __future__ import annotations

import warnings
from dataclasses import dataclass, field

import numpy as np

from app.analysis.align import TrackLine, lap_position, track_line
from app.analysis.balance import CORNERING_G, Geometry, balance_channel, car_geometry, throttle_lifts
from app.analysis.channels import BRAKE, EXIT, MID, POWER, TRAIL, math_channels
from app.analysis.fuel import FUEL_DENSITY, FULL_THROTTLE, FuelUse, fuel_estimate, fuel_from_log, mass_cost
from app.analysis.insights import RunInput
from app.analysis.laps import MASTER_HZ, CornerSpec, Lap, SessionData, Section, lap_length, make_sections
from app.vehicle.tyre_fit import NotEnoughData

VERSION = "stint-3"  # bump when what reduce_run keeps changes, so cached reductions are made again
STOP_KMH = 5.0  # slower than this is standing still
STOP_S = 5.0  # standing still this long is a stop in the pits, and ends the stint
SUSTAINED_S = 1.0  # sustained lateral g is the best average over this long
OUTLIER_SIGMAS = 3.0
OUTLIER_MIN_S = 0.5  # a flying lap this far off its stint's trend is a clear outlier (traffic, a mistake)
TRAFFIC_S = 0.5  # a lap this much slower than its trend, lost in one or two corners, may have met traffic
MIN_FIT_LAPS = 4
MIN_PHASE_M = 10  # metres of a phase in one lap before its balance counts
MIN_SECTION_M = 5  # metres of a phase in one corner before its balance or grip counts there
MIN_GRIP_M = 20  # metres of a phase in a lap before its grip counts
TRACTION_KMH = 140  # full-throttle forward g below this speed is traction-limited
# a trend is clear when flat lies outside its 95 % confidence band: Student's t for these degrees of freedom
T95 = ((1, 12.71), (2, 4.30), (3, 3.18), (4, 2.78), (5, 2.57), (6, 2.45), (8, 2.31), (10, 2.23), (15, 2.13),
       (20, 2.09), (30, 2.04), (1000, 1.96))
BALANCE_PHASES = ((TRAIL, "entry"), (MID, "mid"), (EXIT, "exit"))
GRIP = (("braking", "Braking", "deceleration in a straight line"), ("trail", "Trail braking", "combined g"),
        ("mid", "Mid-corner", "lateral g"), ("exit", "Exit", "combined g"),
        ("power", "Traction", f"forward g at full throttle below {TRACTION_KMH} km/h"))
# the tyre fade split by what the car is doing on each metre: key, phase, label, the grip it uses
COMPONENTS = (("braking", BRAKE, "Straight-line braking", "braking"), ("trail", TRAIL, "Trail braking", "trail"),
              ("mid", MID, "Mid-corner", "mid"), ("exit", EXIT, "Traction on exit", "exit"),
              ("power", POWER, "Full-throttle acceleration", "power"))
EXCLUDING_TAGS = ("sc", "fcy", "traffic")  # "none": the user looked and the lap counts
COUNT_TAG = "count"  # the user counts a lap the analysis leaves out (not a pit lap): it joins the trends
PIT_NOT_COUNTED = "A pit lap can't be counted: the time standing in the pits swamps everything measured on it."
TAG_LABEL = {"sc": "Safety car", "fcy": "FCY", "traffic": "Traffic"}
# the driver's inputs, per corner: label, unit, how the change reads (word when it rises, word when it falls)
DRIVER = {
    "brake_point": ("Brake point", "m", ("later", "earlier")),
    "peak_brake": ("Peak brake pressure", "brake", ("harder", "softer")),
    "trail_share": ("Braking done while turning", "%", ("more", "less")),
    "min_speed": ("Minimum speed", "km/h", ("higher", "lower")),
    "apex_at": ("Slowest point", "m", ("later", "earlier")),
    "steer_mid": ("Steering mid-corner", "steer", ("more", "less")),
    "throttle_on": ("Throttle pick-up", "m", ("later", "earlier")),
    "full_throttle": ("Full throttle", "m", ("later", "earlier")),
    "offset_in": ("Line at the apex", "m", ("tighter", "wider")),
}
LAP_DRIVER = {"tc_s": ("Traction control", "s"), "abs_s": ("ABS", "s"), "coast_s": ("Coasting", "s"),
              "shift_rpm": ("Upshift revs", "rpm")}
# Roles reduce_run reads from the log; everything else stays on disk
ROLES = ("speed", "throttle", "brake", "steer", "steer_wheel", "gear", "rpm", "lat", "lon", "g_lat", "g_long", "yaw",
         "tc", "abs", *(f"tyre_{k}_{w}" for k in "pt" for w in ("fl", "fr", "rl", "rr")))
TYRES = tuple(f"tyre_{k}_{w}" for k in "pt" for w in ("fl", "fr", "rl", "rr"))
SECTION_KEYS = ("time", "brake_g", "trail_g", "mid_g", "exit_g", "brake_point", "peak_brake", "trail_share",
                "min_speed", "apex_at", "throttle_on", "full_throttle", "steer_mid", "tc_s", "lifts", "coast_s",
                "offset_in", "full_m")
APEX_WINDOW_M = 10  # the line at the apex: median offset over this many metres either side
# Labels of the per-lap values the tyre prep report fits through its long runs (tyreprep.py; stint_notes below)
FITTED = {
    "time": ("Lap time", "s"), "grip_use": ("Grip in use", "%"), "sustained_lat_g": ("Sustained lateral g", "g"),
    "balance_entry": ("Entry balance", ""), "balance_mid": ("Mid-corner balance", ""),
    "balance_exit": ("Exit balance", ""), "tc_s": ("Traction control", "s"), "abs_s": ("ABS", "s"),
    "tyre_pressure": ("Tyre pressure (average)", "bar"), "tyre_temperature": ("Tyre temperature (average)", "°C"),
}
WARMING_BAR = 0.1  # average tyre pressure still rising this much over the flying laps: the tyres are coming in


# ---------- splitting a log into stints ----------

def find_stops(data: SessionData) -> list[tuple[float, float]]:
    """When the car stood still for STOP_S or longer (start and end, seconds into the log)."""
    still = (data.channels["speed"] < STOP_KMH).astype(int)
    edges = np.flatnonzero(np.diff(np.r_[0, still, 0]))
    return [(a / MASTER_HZ, b / MASTER_HZ) for a, b in zip(edges[::2], edges[1::2], strict=True)
            if b - a >= STOP_S * MASTER_HZ]


def split_stints(laps: list[Lap], stops: list[tuple[float, float]]) -> list[list[Lap]]:
    """Laps grouped between stops; the lap with the stop in it closes its stint."""
    out: list[list[Lap]] = []
    for lap in laps:
        if not out or any(out[-1][-1].start <= a < lap.start for a, _ in stops):
            out.append([])
        out[-1].append(lap)
    return out


def lap_kinds(stint: list[Lap], stops: list[tuple[float, float]]) -> list[str]:
    """pit (the stop is in it), out, in, slow (not a clean lap) or flying.

    The laps that are not clean at the start of a stint are its out-laps (tyres and brakes coming in), those at
    its end its in-laps.
    """
    kinds = ["pit" if any(l.start <= a < l.end for a, _ in stops) else "flying" if l.clean else "slow"
             for l in stint]
    for i, k in enumerate(kinds):
        if k != "slow":
            break
        kinds[i] = "out"
    for i in reversed(range(len(kinds))):
        if kinds[i] not in ("slow", "pit"):
            break
        if kinds[i] == "slow":
            kinds[i] = "in"
    return kinds


# ---------- statistics ----------

def outliers(x: np.ndarray, y: np.ndarray) -> np.ndarray:
    """Laps far off the trend: residuals from a Theil-Sen line, which the outliers themselves can't pull."""
    if len(x) < 3:
        return np.zeros(len(x), bool)
    i, j = np.triu_indices(len(x), 1)
    dx = x[j] - x[i]
    slope = float(np.median((y[j] - y[i])[dx != 0] / dx[dx != 0])) if np.any(dx != 0) else 0.0
    res = y - slope * x
    res = res - np.median(res)
    sigma = 1.4826 * float(np.median(np.abs(res)))
    return np.abs(res) > max(OUTLIER_SIGMAS * sigma, OUTLIER_MIN_S)


def _t95(dof: int) -> float:
    return float(np.interp(dof, [d for d, _ in T95], [t for _, t in T95]))


def trend(x: np.ndarray, y: np.ndarray) -> dict | None:
    """Least-squares line through (laps into the stint, value): change per lap and its standard error."""
    ok = np.isfinite(y)
    x, y = x[ok], y[ok]
    n = len(x)
    if n < MIN_FIT_LAPS or np.ptp(x) == 0:
        return None
    slope, icept = np.polyfit(x, y, 1)
    res = y - (slope * x + icept)
    se = float(np.sqrt(res @ res / (n - 2) / np.sum((x - x.mean()) ** 2)))
    band = _t95(n - 2) * se
    return {"per_lap": round(float(slope), 4), "se": round(se, 4), "within": round(band, 4), "laps": n,
            "start": round(float(slope * x.min() + icept), 3), "change": round(float(slope * np.ptp(x)), 3),
            "level": round(float(y.mean()), 4), "clear": bool(abs(slope) > band and abs(slope) > 1e-9)}


def pooled_trend(groups: list[tuple[np.ndarray, np.ndarray]]) -> dict | None:
    """One slope through several stints at once, each stint keeping its own level (a stint on other tyres or
    another day starts where it starts): the change per lap within the stints."""
    xs, ys, spans, level = [], [], [], []
    for x, y in groups:
        x, y = np.asarray(x, float), np.asarray(y, float)
        ok = np.isfinite(y)
        x, y = x[ok], y[ok]
        if len(x) < 2 or np.ptp(x) == 0:
            continue
        level.extend(y.tolist())
        xs.append(x - x.mean())
        ys.append(y - y.mean())
        spans.append(float(np.ptp(x)))
    if not xs:
        return None
    x, y = np.concatenate(xs), np.concatenate(ys)
    n, dof = len(x), len(x) - len(xs) - 1
    if n < MIN_FIT_LAPS or dof < 1:
        return None
    sxx = float(x @ x)
    slope = float(x @ y) / sxx
    res = y - slope * x
    se = float(np.sqrt(res @ res / dof / sxx))
    band = _t95(dof) * se
    return {"per_lap": round(slope, 4), "se": round(se, 4), "within": round(band, 4), "laps": n,
            "stints": len(xs), "change": round(slope * float(np.mean(spans)), 3),
            "level": round(float(np.mean(level)), 4),
            "clear": bool(abs(slope) > band and abs(slope) > 1e-9)}


def _r(v, nd: int = 3):
    return None if v is None or not np.isfinite(v) else round(float(v), nd)


def stint_notes(fits: dict, rows: list[dict], steer_unit: str) -> list[str]:
    """A long run's fade in plain words, for the tyre prep report (tyreprep.py)."""
    notes = []
    t = fits.get("time")
    if t is None:
        notes.append(f"Too few flying laps for a trend (it takes {MIN_FIT_LAPS}).")
    elif not t["clear"]:
        notes.append(f"Lap times hold steady over {t['laps']} flying laps: no clear trend "
                     f"(within ±{t['within']:.2f} s a lap).")
    elif t["per_lap"] > 0:
        notes.append(f"Lap time rises {t['per_lap']:.2f} s a lap over {t['laps']} flying laps, "
                     f"{t['change']:.1f} s from the first to the last.")
    else:
        notes.append(f"Lap time falls {-t['per_lap']:.2f} s a lap over {t['laps']} flying laps: the car got "
                     "quicker as the stint went on.")
    g = fits.get("grip_use")
    if g is not None and g["clear"]:
        notes.append(f"Grip in use {'falls' if g['per_lap'] < 0 else 'rises'} {abs(g['per_lap']):.1f} points a lap "
                     f"(share of the grip the car showed on its best laps), {g['change']:+.1f} over the stint.")
    elif g is not None:
        notes.append("Grip in use holds steady through the stint.")
    for name in ("entry", "mid", "exit"):
        b = fits.get(f"balance_{name}")
        if b is not None and b["clear"]:
            way = "understeer" if b["per_lap"] > 0 else "oversteer"
            notes.append(f"{FITTED[f'balance_{name}'][0]} moves towards {way} through the stint "
                         f"({b['change']:+.2f} {steer_unit} of steering from the first to the last flying lap).")
    p = fits.get("tyre_pressure")
    if p is not None and p["change"] > WARMING_BAR:
        notes.append(f"The tyres were still coming in: average pressure rose {p['change']:.2f} bar over these laps, "
                     "so they show warm-up as much as wear.")
    tc = fits.get("tc_s")
    if tc is not None and tc["clear"] and tc["per_lap"] > 0:
        fading = t is not None and t["clear"] and t["per_lap"] > 0
        notes.append(f"Traction control works {tc['per_lap']:.1f} s a lap longer each lap"
                     + (": with the lap times rising, the rear tyres are fading." if fading else "."))
    left = []
    for r in rows:
        if r["in_fit"]:
            continue
        why = {"out": "out-lap", "in": "in-lap", "pit": "pit stop", "slow": "slow lap"}.get(r["kind"])
        if r["outlier"]:
            why = f"{r['off_trend_s']:+.1f} s off the trend"
        left.append(f"lap {r['lap']} ({why})")
    if left:
        notes.append("Left out of the trend: " + ", ".join(left) + ".")
    return notes


# ---------- one log, reduced ----------

@dataclass
class LapSummary:
    number: int
    start: float
    end: float
    time: float
    clean: bool
    stint: int
    tyre_lap: int  # laps into the stint, the first lap is 1
    kind: str
    values: dict[str, float] = field(default_factory=dict)  # whole-lap numbers (nan where there is none)
    sections: dict[str, np.ndarray] | None = None  # SECTION_KEYS -> one value per section
    # every lap but a pit lap: seconds per metre, the phase on each metre, seconds per metre per kg of mass, and
    # the balance samples (metre, understeer angle, |lateral g|, phase) where the car corners
    dt: np.ndarray | None = None
    phase: np.ndarray | None = None
    sens: np.ndarray | None = None
    corner: dict[str, np.ndarray] | None = None

    def nbytes(self) -> int:
        arrays = [self.dt, self.phase, self.sens, *(self.corner or {}).values(), *(self.sections or {}).values()]
        return sum(a.nbytes for a in arrays if a is not None)


@dataclass
class LogSummary:
    """What assemble needs from one log; a few hundred kB for an hour of running."""
    key: str  # the file's id, or the run's name
    name: str
    meta: dict
    lap_source: str
    length: int
    sections: list[Section]
    stops: list[tuple[float, float]]
    laps: list[LapSummary]
    k_sums: tuple[float, float] = (0.0, 0.0)  # sum |ay| x understeer and sum ay² over the clean laps' cornering
    balance: dict | None = None  # how the balance channel was made, or why there is none ("note")
    steer: dict = field(default_factory=dict)  # channel, unit (the channel steering mid-corner is read from)
    brake_unit: str = ""
    fuel: dict = field(default_factory=dict)  # source, channel, note
    mass: dict = field(default_factory=dict)  # kg, source
    notes: list[str] = field(default_factory=list)

    def nbytes(self) -> int:
        return sum(l.nbytes() for l in self.laps) + 1000 * len(self.laps)


def _unit(run: RunInput, role: str) -> str:
    name = run.data.sources.get(role)
    ch = run.ld.channel(name) if run.ld is not None and name and hasattr(run.ld, "channel") else None
    return (ch.unit or "") if ch is not None else ""


def _trace(data: SessionData, lap: Lap, line: TrackLine | None, length: int, roles: tuple[str, ...]
           ) -> dict[str, np.ndarray]:
    """One lap on a 1 m grid from the timing line to the timing line (as align.aligned_trace), only these roles."""
    idx, d = lap_position(data, lap, line, length)
    grid = np.arange(0, length + 0.5)
    tt = data.t[idx]
    out = {"t": np.interp(grid, d, tt) - float(np.interp(0.0, d, tt))}
    for role in roles:
        if role in data.channels:
            out[role] = np.interp(grid, d, data.channels[role][idx])
    return out


def _lateral_g(data: SessionData, i0: int, i1: int) -> tuple[float, float]:
    """Peak lateral g, and the best average over SUSTAINED_S, on the lap's own clock."""
    ay = np.abs(data.channels["ay"][i0:i1])
    w = round(SUSTAINED_S * MASTER_HZ)
    sustained = float(np.convolve(ay, np.ones(w) / w, "valid").max()) if len(ay) >= w else np.nan
    return (float(ay.max()) if len(ay) else np.nan), sustained


def _shift_rpm(data: SessionData, i0: int, i1: int) -> float:
    """Median revs at the upshifts made on full throttle in the lap."""
    c = data.channels
    if "gear" not in c or "rpm" not in c or "throttle" not in c:
        return np.nan
    gear, rpm, thr = c["gear"][i0:i1], c["rpm"][i0:i1], c["throttle"][i0:i1]
    up = np.flatnonzero(np.diff(gear) == 1)
    w = round(0.3 * MASTER_HZ)
    at = [float(rpm[max(j - w, 0):j + 1].max()) for j in up if j >= w and thr[j - w:j].min() > 80]
    return float(np.median(at)) if len(at) >= 2 else np.nan


def _p90(values: np.ndarray, sel: np.ndarray, least: int) -> float:
    v = values[sel]
    return float(np.percentile(v, 90)) if len(v) >= least else np.nan


def _first(mask: np.ndarray) -> int | None:
    i = np.flatnonzero(mask)
    return int(i[0]) if len(i) else None


class _Geometry:
    """The reference line's direction and which way each corner turns, for the line at the apex."""

    def __init__(self, line: TrackLine | None, sections: list[Section]):
        self.line = line
        if line is None:
            return
        tx, ty = np.gradient(line.x), np.gradient(line.y)
        norm = np.maximum(np.hypot(tx, ty), 1e-6)
        self.tx, self.ty = tx / norm, ty / norm
        n = len(line.x)
        self.turn = {}
        for s in sections:
            if s.apex is None:
                continue
            a, b = max(s.apex - 15, 0), min(s.apex + 15, n - 1)
            cross = self.tx[a] * self.ty[b] - self.ty[a] * self.tx[b]
            self.turn[s.code] = 1.0 if cross > 0 else -1.0  # 1: a left-hander

    def offset_left(self, tr: dict[str, np.ndarray]) -> np.ndarray | None:
        """Each metre's distance to the left of the reference line (m), from GPS."""
        if self.line is None or "lat" not in tr or "lon" not in tr:
            return None
        n = min(len(self.line.x), len(tr["lat"]))
        px, py = self.line.xy(tr["lat"][:n], tr["lon"][:n])
        return (px - self.line.x[:n]) * -self.ty[:n] + (py - self.line.y[:n]) * self.tx[:n]


def _section_values(tr: dict[str, np.ndarray], dt: np.ndarray, sections: list[Section], geo: _Geometry,
                    steer: str | None) -> dict[str, np.ndarray]:
    v, ax, ay = tr["speed"], tr["ax"], np.abs(tr["ay"])
    phase = np.rint(tr["phase"]).astype(int)
    braking = tr["braking"] > 0.5
    comb = np.hypot(ax, ay)
    thr = tr.get("throttle")
    off = geo.offset_left(tr)
    out = {k: np.full(len(sections), np.nan) for k in SECTION_KEYS}
    for j, s in enumerate(sections):
        a, b = s.start, s.end
        sl = slice(a, b)
        ph = phase[sl]
        out["time"][j] = tr["t"][b] - tr["t"][a]
        out["brake_g"][j] = _p90(-ax[sl], (ph == BRAKE) & (v[sl] > 50), MIN_SECTION_M)
        out["trail_g"][j] = _p90(comb[sl], ph == TRAIL, MIN_SECTION_M)
        out["mid_g"][j] = _p90(ay[sl], (ph == MID) & (ay[sl] > CORNERING_G), MIN_SECTION_M)
        out["exit_g"][j] = _p90(comb[sl], ph == EXIT, MIN_SECTION_M)
        n_brake = np.count_nonzero((ph == BRAKE) | (ph == TRAIL))
        if n_brake >= 10:
            out["trail_share"][j] = 100 * np.count_nonzero(ph == TRAIL) / n_brake
        if "tc_on" in tr:
            out["tc_s"][j] = float((dt[sl] * (tr["tc_on"][sl] > 0.5)).sum())
        if "coasting" in tr:
            out["coast_s"][j] = float((dt[sl] * (tr["coasting"][sl] > 0.5)).sum())
        if thr is not None:
            out["lifts"][j] = throttle_lifts(thr[sl])
            out["full_m"][j] = np.count_nonzero(thr[sl] > FULL_THROTTLE)
        if s.apex is None:
            continue
        low = a + int(np.argmin(v[sl]))
        out["min_speed"][j] = v[low]
        out["apex_at"][j] = low
        bp = _first(braking[a:max(s.apex, a + 1)])
        if bp is not None:
            out["brake_point"][j] = a + bp
            if "brake" in tr:
                out["peak_brake"][j] = tr["brake"][a:max(s.apex, a + 1)].max()
        if steer is not None and steer in tr:
            sel = (ph == MID) & (ay[sl] > CORNERING_G)
            if np.count_nonzero(sel) >= MIN_SECTION_M:
                out["steer_mid"][j] = float(np.median(np.abs(tr[steer][sl][sel])))
        if thr is not None:
            k = np.arange(a, b)
            on = _first((thr[sl] > 20) & ~braking[sl] & (k >= low - 40))
            if on is not None:
                out["throttle_on"][j] = a + on
                full = _first(thr[a + on:b] > FULL_THROTTLE)
                if full is not None:
                    out["full_throttle"][j] = a + on + full
        if off is not None and s.code in geo.turn:
            w0, w1 = max(s.apex - APEX_WINDOW_M, 0), min(s.apex + APEX_WINDOW_M + 1, len(off))
            if w1 > w0:
                out["offset_in"][j] = float(np.median(off[w0:w1])) * geo.turn[s.code]
    return {k: v.astype(np.float32) for k, v in out.items()}


def _lap_values(tr: dict[str, np.ndarray], dt: np.ndarray) -> dict[str, float]:
    v, ax, ay = tr["speed"], tr["ax"], np.abs(tr["ay"])
    phase = np.rint(tr["phase"]).astype(int)[:-1]
    v, ax, ay = v[:-1], ax[:-1], ay[:-1]  # one value per metre step, like dt
    comb = np.hypot(ax, ay)
    thr = tr["throttle"][:-1] if "throttle" in tr else None
    out = {
        "trace_time": float(tr["t"][-1] - tr["t"][0]),
        "grip_braking": _p90(-ax, (phase == BRAKE) & (v > 50), MIN_GRIP_M),
        "grip_trail": _p90(comb, phase == TRAIL, MIN_GRIP_M),
        "grip_mid": _p90(ay, (phase == MID) & (ay > CORNERING_G), MIN_GRIP_M),
        "grip_exit": _p90(comb, phase == EXIT, MIN_GRIP_M),
        "grip_power": _p90(ax, (phase == POWER) & (v < TRACTION_KMH) & (thr > FULL_THROTTLE), MIN_GRIP_M)
        if thr is not None else np.nan,
        "g_p90": float(np.percentile(comb, 90)),
        "top_speed": float(v.max()),
    }
    # how much of the lap sits at one held speed (an FCY limit): within 5 km/h of the lap's typical speed
    typical = float(np.median(v))
    out["plateau"] = float(dt[np.abs(v - typical) < 5].sum() / max(dt.sum(), 1e-6)) if typical < 130 else 0.0
    for role, key in (("tc_on", "tc_s"), ("abs_on", "abs_s"), ("coasting", "coast_s")):
        out[key] = float((dt * (tr[role][:-1] > 0.5)).sum()) if role in tr else np.nan
    for role in TYRES:
        out[role] = float(np.median(tr[role])) if role in tr else np.nan
    return out


def reduce_run(run: RunInput, corners: list[CornerSpec] | None = None, geo: Geometry | None = None,
               mass: tuple[float, str] | None = None, density: float = FUEL_DENSITY) -> LogSummary:
    """One log reduced for assemble. Reads the run's channels once; the caller drops the run afterwards.

    run.data should be loaded with roles=ROLES (other channels are dropped here first). corners: the track's
    official corner numbers. geo: the car's steering ratio and wheelbase for the balance (car_geometry). mass: the
    car's mass with driver and fuel, and where it came from.
    """
    data = run.data
    c = data.channels
    for role in [r for r in c if r not in ROLES]:
        del c[role]
    for role in c:  # half the memory; GPS keeps full precision
        if role not in ("lat", "lon"):
            c[role] = c[role].astype(np.float32)
    steer = "steer_wheel" if "steer_wheel" in c else "steer" if "steer" in c else None
    key = str(run.meta.get("file_id", run.name))
    mass_kg, mass_source = mass or (1635.0, "the BMW M4 GT4 estimate with driver and fuel (no car data)")
    log = LogSummary(key, run.name, dict(run.meta), data.lap_source, 0, [], [], [],
                     steer={"role": steer, "channel": data.sources.get(steer),
                            "unit": _unit(run, steer) if steer else ""},
                     brake_unit=_unit(run, "brake"), mass={"kg": round(mass_kg, 1), "source": mass_source})
    fuel: FuelUse | None = fuel_from_log(run.ld, density)
    math_channels(data)
    for role in ("understeer", "steer_per_curvature", "slide_rate", "g_direction", "g_combined", "overlap",
                 "curvature"):
        c.pop(role, None)
    try:
        log.balance = balance_channel(data, geo or car_geometry(None))
    except NotEnoughData as e:
        log.balance = {"note": str(e)}
    for role in ("yaw", "g_lat", "g_long", "steer" if steer != "steer" else ""):
        c.pop(role, None)
    if fuel is None:
        fuel = fuel_estimate(data.t, c.get("throttle"))
    if fuel is not None:
        log.fuel = {"source": fuel.source, "channel": fuel.channel, "note": fuel.note}
    log.stops = stops = find_stops(data)
    clean = [l for l in data.laps if l.clean]
    if not clean:
        log.notes.append("No clean laps in this log, so its stints can't be read.")
        return log
    ref = min(clean, key=lambda l: l.time)
    line = track_line(data, ref)
    log.length = length = line.length if line is not None else round(lap_length(data, ref))
    roles = ("speed", "ax", "ay", "phase", "braking", "brake", "throttle", "understeer", "tc_on", "abs_on",
             "coasting", "lat", "lon", *((steer,) if steer else ()), *TYRES)
    ref_tr = _trace(data, ref, line, length, roles)
    log.sections, numbering = make_sections(ref_tr, corners)
    log.meta["numbering"] = numbering
    del ref_tr
    geom = _Geometry(line, log.sections)
    has_balance = "understeer" in c
    k_num = k_den = 0.0
    for number, laps in enumerate(split_stints(data.laps, stops), start=1):
        for i, (lap, kind) in enumerate(zip(laps, lap_kinds(laps, stops), strict=True)):
            row = LapSummary(lap.number, lap.start, lap.end, lap.time, lap.clean, number, i + 1, kind)
            i0, i1 = round(lap.start * MASTER_HZ), min(round(lap.end * MASTER_HZ), len(data.t))
            peak, sustained = _lateral_g(data, i0, i1)
            row.values = {"peak_lat_g": peak, "sustained_lat_g": sustained, "shift_rpm": _shift_rpm(data, i0, i1),
                          "full_s": float(np.count_nonzero(c["throttle"][i0:i1] > FULL_THROTTLE) / MASTER_HZ)
                          if "throttle" in c else np.nan}
            if fuel is not None:
                row.values["fuel_start"], row.values["fuel_end"] = fuel.at(lap.start), fuel.at(lap.end)
            log.laps.append(row)
            if kind == "pit":  # the time standing still swamps everything measured along the lap
                for role in TYRES:
                    if role in c:
                        row.values[role] = float(np.median(c[role][i0:i1]))
                continue
            tr = _trace(data, lap, line, length, roles)
            dt = np.maximum(np.diff(tr["t"]), 0.0)
            row.values.update(_lap_values(tr, dt))
            row.sections = _section_values(tr, dt, log.sections, geom, steer)
            sens = mass_cost(tr["speed"], tr.get("throttle", np.zeros(length + 1)), tr["braking"], mass_kg)
            row.values["sens_kg"] = float(sens.sum())
            # kept for out-laps, in-laps and slow laps too: they stay out of the trends unless the user counts them
            row.dt, row.sens = dt.astype(np.float32), sens
            row.phase = np.rint(tr["phase"][:-1]).astype(np.int8)
            if has_balance and "understeer" in tr:
                ay, ph = np.abs(tr["ay"]), np.rint(tr["phase"]).astype(int)
                sel = (ay > CORNERING_G) & ((ph == TRAIL) | (ph == MID) | (ph == EXIT))
                row.corner = {"at": np.flatnonzero(sel).astype(np.int32), "us": tr["understeer"][sel].astype(
                    np.float32), "ay": ay[sel].astype(np.float32), "phase": ph[sel].astype(np.int8),
                    "fast": (tr["speed"][sel] > 40)}
                if lap.clean:  # the car's normal: degrees per g through zero, as balance.gradient fits it
                    f = row.corner["fast"]
                    a_, u_ = row.corner["ay"][f].astype(float), row.corner["us"][f].astype(float)
                    k_num += float(a_ @ u_)
                    k_den += float(a_ @ a_)
    log.k_sums = (k_num, k_den)
    return log


# ---------- any set of logs, with the user's tags ----------

def _nanmedian(a: np.ndarray) -> np.ndarray:
    """Median of each column, ignoring gaps (NaN where a column has no value)."""
    if a.ndim != 2 or a.shape[0] == 0:
        return np.full(a.shape[-1] if a.ndim == 2 else 0, np.nan)
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", RuntimeWarning)
        return np.nanmedian(a, axis=0)


def _balance(lap: LapSummary, k: float, n_sections: int, section_of: np.ndarray) -> tuple[dict, np.ndarray]:
    """The lap's balance per phase (whole lap) and per section and phase: median understeer angle against the car's
    normal at the same lateral g (+ more understeer, - more oversteer)."""
    whole = {name: np.nan for _, name in BALANCE_PHASES}
    per = np.full((n_sections, 3), np.nan)
    if lap.corner is None:
        return whole, per
    c = lap.corner
    rel = c["us"].astype(float) - k * c["ay"].astype(float)
    sec = section_of[np.minimum(c["at"], len(section_of) - 1)]
    for j, (p, name) in enumerate(BALANCE_PHASES):
        sel = c["phase"] == p
        if np.count_nonzero(sel) >= MIN_PHASE_M:
            whole[name] = float(np.median(rel[sel]))
        for s in np.unique(sec[sel]):
            ss = sel & (sec == s)
            if np.count_nonzero(ss) >= MIN_SECTION_M:
                per[s, j] = float(np.median(rel[ss]))
    return whole, per


def _groups(n: int) -> tuple[slice, slice] | None:
    """The early and late laps of a stint's n fitted laps: a third each, at least two."""
    if n < MIN_FIT_LAPS:
        return None
    g = max(2, n // 3)
    return slice(0, g), slice(n - g, n)


@dataclass
class _Stint:
    log: LogSummary
    number: int
    laps: list[LapSummary]
    rows: list[dict]
    fitted: list[int]  # indexes into laps
    x: np.ndarray  # tyre laps of the fitted laps
    series: dict[str, np.ndarray]  # per fitted lap
    components: dict[str, np.ndarray]  # key -> per fitted lap (s)
    comp_sections: dict[str, np.ndarray]  # key -> [fitted lap, section] (s)
    balance_sections: np.ndarray  # [fitted lap, section, phase]
    driver_sections: dict[str, np.ndarray]  # key -> [fitted lap, section]: change against the stint's typical
    out: dict


def _tag_of(tags: dict, log: LogSummary, lap: LapSummary) -> str | None:
    return tags.get((log.key, lap.number))


def _suggest(lap: LapSummary, row: dict, typical: dict, sec_typ: np.ndarray, codes: list[str]) -> dict | None:
    """Why a lap looks slow for a reason outside the car: a safety car or FCY (slow everywhere, little grip used)
    or traffic (slow in one or two corners, with a lift). Only ever a suggestion for the user to confirm."""
    if lap.kind not in ("flying", "slow") or lap.sections is None or not np.isfinite(typical.get("time", np.nan)):
        return None
    pace = typical["time"]
    st = lap.sections["time"].astype(float)
    ratio = st / sec_typ
    g = lap.values.get("g_p90", np.nan)
    if (lap.time > 1.12 * pace and np.nanmin(ratio) > 1.03 and np.isfinite(typical.get("g_p90", np.nan))
            and g < 0.75 * typical["g_p90"]):
        held = lap.values.get("plateau", 0.0) > 0.4
        return {"tag": "fcy" if held else "sc", "likely": True, "options": ["fcy", "sc"] if held else ["sc", "fcy"],
                "why": f"{lap.time - pace:+.1f} s, slow in every corner and only {100 * g / typical['g_p90']:.0f} % "
                       "of a normal lap's grip in use" + (", at one held speed" if held else "")}
    loss = st - sec_typ
    total = float(np.nansum(np.clip(loss, 0, None)))
    # slow against the stint's trend where there is one (early laps of a stint that is still coming in are slower
    # than its typical lap all round, and that is no reason to leave them out)
    slow_by = row["off_trend_s"] if row.get("off_trend_s") is not None else lap.time - pace
    if slow_by < TRAFFIC_S or total <= 0:
        return None
    order = np.argsort(-np.nan_to_num(loss, nan=-1e9))[:2]
    top = float(np.nansum(np.clip(loss[order], 0, None)))
    if top < 0.6 * total or top < TRAFFIC_S:
        return None
    sec = lap.sections
    lifted = [j for j in order if loss[j] > 0.1 and (
        sec["lifts"][j] > typical["lifts"][j] or sec["coast_s"][j] > typical["coast_s"][j] + 0.2
        or sec["full_m"][j] < typical["full_m"][j] - 30)]
    where = " and ".join(f"{codes[j]} ({loss[j]:+.1f} s)" for j in order if loss[j] > 0.1)
    if lifted:
        return {"tag": "traffic", "options": ["traffic"], "likely": True,
                "why": f"lost {top:.1f} s in {where}, lifting where the other laps stay on the throttle"}
    return {"tag": "traffic", "options": ["traffic"], "likely": False,
            "why": f"lost {top:.1f} s in {where} alone: traffic, or a mistake?"}


def _split_by_cause(dt: np.ndarray, phase: np.ndarray, ref_dt: np.ndarray, ref_brakes: np.ndarray,
                    section_of: np.ndarray, n_sections: int) -> np.ndarray:
    """A lap's time against the reference lap, metre by metre, charged to the phase and corner where it was lost:
    [phase, section] in seconds (the parts add up to the whole difference).

    Speed lost in a phase is carried on: an exit 3 km/h slower is still slower all the way down the straight that
    follows, and that time counts against the exit, not against the straight. A deficit is carried as a difference
    in v² (the same push gives the same v² gain per metre) until the reference lap brakes and the lap, braking
    later, has caught up its speed. Only time actually lost (or gained) on a metre is carried; what is left on the
    metre is the phase's own. Where the reference brakes and the lap is still on the power, the lap braking later or
    earlier counts as braking.
    """
    n = min(len(dt), len(ref_dt), len(phase))
    dt, ref_dt, phase, rb = dt[:n].astype(float), ref_dt[:n].astype(float), phase[:n], ref_brakes[:n]
    sec = section_of[:n]
    vr2 = 1.0 / np.maximum(ref_dt, 1e-3) ** 2
    dv2 = 1.0 / np.maximum(dt, 1e-3) ** 2 - vr2
    act = dt - ref_dt
    comp = np.where(rb & (phase == POWER), BRAKE, phase).astype(int)
    out = np.zeros((len(COMPONENTS), n_sections))
    carry = np.zeros((len(COMPONENTS), n_sections))
    # the speed carried over the line comes from the end of the lap (the last corner, the same one each lap)
    last = np.flatnonzero(comp != POWER)
    if n >= 3 and len(last):
        carry[comp[last[-1]], sec[last[-1]]] = float(dv2[:3].mean())
    cut = np.flatnonzero((comp[1:] != comp[:-1]) | (sec[1:] != sec[:-1]) | (rb[1:] != rb[:-1])) + 1
    ceiling = None
    for a, b in zip(np.r_[0, cut], np.r_[cut, n], strict=True):
        p, s, brakes = comp[a], sec[a], bool(rb[a])
        c = float(carry.sum())
        if brakes and ceiling is None:  # the speed the lap reaches the braking zone with
            ceiling = float(vr2[max(a - 1, 0)]) + c
        elif not brakes:
            ceiling = None
        lost = float(act[a:b].sum())
        d_end = float(dv2[max(b - 3, a):b].mean())
        kept, carried = 0.0, 0.0
        if abs(c) > 1e-3:
            if brakes:
                ideal = np.minimum(vr2[a:b], ceiling) if c < 0 else vr2[a:b]
                expected = min(float(vr2[b - 1]), ceiling) - float(vr2[b - 1]) if c < 0 else 0.0
            else:
                ideal = vr2[a:b] + c
                expected = c
            f = 1.0 / np.sqrt(np.maximum(ideal, 1.0)) - ref_dt[a:b]
            f = np.clip(f, 0.0, np.maximum(act[a:b], 0.0)) if c < 0 else np.clip(f, np.minimum(act[a:b], 0.0), 0.0)
            carried = float(f.sum())
            out += carry * (carried / c)
            kept = max(expected, min(d_end, 0.0)) if expected < 0 else min(expected, max(d_end, 0.0))
            carry *= kept / c
        out[p, s] += lost - carried
        carry[p, s] += d_end - kept
    return out


def _stint(log: LogSummary, number: int, laps: list[LapSummary], tags: dict, k: float | None) -> _Stint:
    S = len(log.sections)
    section_of = np.zeros(max(log.length, 1), int)
    for j, s in enumerate(log.sections):
        section_of[s.start:s.end + 1] = j
    codes = [s.code for s in log.sections]
    rows = []
    for lap in laps:
        tag = _tag_of(tags, log, lap)
        rows.append({"lap": lap.number, "tyre_lap": lap.tyre_lap, "kind": lap.kind,
                     "tag": tag if tag in EXCLUDING_TAGS else None, "checked": tag == "none",
                     "counted": tag == COUNT_TAG and lap.kind != "pit" and lap.dt is not None, "suggestion": None,
                     "in_fit": False, "outlier": False, "off_trend_s": None, "time": round(lap.time, 3),
                     "fuel_kg": None})
    # the outlier test runs over the flying laps as it always does (a lap the user counts doesn't move the others),
    # then the counted laps join the fit whatever the test says
    candidates = [i for i, (lap, row) in enumerate(zip(laps, rows, strict=True))
                  if lap.kind == "flying" and row["tag"] is None and lap.dt is not None]
    counted = [i for i, row in enumerate(rows) if row["counted"]]
    x = np.array([laps[i].tyre_lap for i in candidates], float)
    times = np.array([laps[i].time for i in candidates])
    bad = outliers(x, times)
    if len(candidates) >= 3:
        keep = ~bad
        line = np.polyfit(x[keep], times[keep], 1) if np.count_nonzero(keep) >= 2 else [0.0, np.median(times)]
        for i, b, xi, t in zip(candidates, bad, x, times, strict=True):
            rows[i]["outlier"] = bool(b) and not rows[i]["counted"]
            rows[i]["off_trend_s"] = round(float(t - np.polyval(line, xi)), 2)
        for i in counted:
            rows[i]["off_trend_s"] = round(float(laps[i].time - np.polyval(line, laps[i].tyre_lap)), 2)
    fitted = sorted({i for i, b in zip(candidates, bad, strict=True) if not b} | set(counted))
    for i in fitted:
        rows[i]["in_fit"] = True
    fl = [laps[i] for i in fitted]
    xf = np.array([l.tyre_lap for l in fl], float)

    # fuel: what was burnt since the stint's first lap, and what that mass costs
    first = laps[0].values
    has_fuel = "fuel_start" in first and log.fuel
    sens = float(np.median([l.values["sens_kg"] for l in fl])) if fl else np.nan
    burnt = {}
    for lap, row in zip(laps, rows, strict=True):
        if has_fuel:
            burnt[lap.number] = lap.values["fuel_start"] - first["fuel_start"]
            row["fuel_kg"] = _r(lap.values["fuel_end"] - lap.values["fuel_start"], 2)
        if has_fuel and np.isfinite(sens) and lap.kind != "pit":
            row["corrected_time"] = round(lap.time + burnt[lap.number] * sens, 3)
        else:
            row["corrected_time"] = None

    # per lap: grip, balance, aids, tyres
    balance_sections = np.full((len(laps), S, 3), np.nan)
    for li, (lap, row) in enumerate(zip(laps, rows, strict=True)):
        v = lap.values
        row["grip"] = None if lap.kind == "pit" else {g: _r(v.get(f"grip_{g}"), 3) for g, *_ in GRIP}
        if k is not None and lap.corner is not None:
            whole, per = _balance(lap, k, S, section_of)
            row["balance"] = {name: _r(val, 2) for name, val in whole.items()}
            balance_sections[li] = per
        else:
            row["balance"] = None
        for key in ("tc_s", "abs_s", "coast_s"):
            row[key] = None if lap.kind == "pit" else _r(v.get(key), 1)
        row["peak_lat_g"] = _r(v.get("peak_lat_g"), 2)
        row["sustained_lat_g"] = _r(v.get("sustained_lat_g"), 2)
        row["shift_rpm"] = _r(v.get("shift_rpm"), 0)
        tyres = {}
        for kind, name, nd in (("p", "pressure_bar", 2), ("t", "temperature_c", 1)):
            vals = {w: round(v[r], nd) for w in ("fl", "fr", "rl", "rr")
                    if np.isfinite(v.get(r := f"tyre_{kind}_{w}", np.nan))}
            if vals:
                tyres[name] = vals
        row["tyres"] = tyres or None

    # the driver's inputs per corner, against the stint's typical (median of the fitted laps)
    typical_sec = {key: _nanmedian(np.array([l.sections[key] for l in fl], float)) if fl else np.full(S, np.nan)
                   for key in SECTION_KEYS}
    driver_sections = {}
    for key in DRIVER:
        arr = np.array([l.sections[key] - typical_sec[key] for l in fl], float) if fl else np.zeros((0, S))
        driver_sections[key] = arr
    for lap, row in zip(laps, rows, strict=True):
        if lap.sections is None:
            row["driver"] = None
            continue
        d = {}
        for key in DRIVER:
            delta = lap.sections[key].astype(float) - typical_sec[key]
            ok = np.isfinite(delta)
            d[key] = _r(float(delta[ok].mean()), 2) if np.count_nonzero(ok) >= max(1, S // 4) else None
        row["driver"] = d

    # suggestions for laps that look slow for a reason outside the car
    typical = {"time": float(np.median([l.time for l in fl])) if fl else np.nan,
               "g_p90": float(np.median([l.values["g_p90"] for l in fl])) if fl else np.nan,
               "lifts": typical_sec["lifts"], "coast_s": typical_sec["coast_s"], "full_m": typical_sec["full_m"]}
    for lap, row in zip(laps, rows, strict=True):
        if row["tag"] is None and not row["checked"] and not row["counted"]:  # the user's word stands
            row["suggestion"] = _suggest(lap, row, typical, typical_sec["time"], codes)

    # per fitted lap series for the trends
    series: dict[str, np.ndarray] = {}
    frows = [rows[i] for i in fitted]
    series["time"] = np.array([r["time"] for r in frows], float)
    series["corrected_time"] = np.array([np.nan if r["corrected_time"] is None else r["corrected_time"]
                                         for r in frows], float)
    for g, *_ in GRIP:
        series[f"grip_{g}"] = np.array([l.values.get(f"grip_{g}", np.nan) for l in fl], float)
    for _, name in BALANCE_PHASES:
        series[f"balance_{name}"] = np.array([np.nan if r["balance"] is None or r["balance"][name] is None
                                              else r["balance"][name] for r in frows], float)
    for key in DRIVER:
        series[key] = np.array([np.nan if r["driver"][key] is None else r["driver"][key] for r in frows], float)
    for key in LAP_DRIVER:
        series[key] = np.array([l.values.get(key, np.nan) for l in fl], float)
    for kind, key in (("p", "tyre_pressure"), ("t", "tyre_temperature")):
        series[key] = np.array([np.mean([l.values.get(f"tyre_{kind}_{w}", np.nan) for w in ("fl", "fr", "rl", "rr")])
                                for l in fl], float)

    # the tyre fade by phase: each fitted lap's time on every metre against the stint's typical lap, with the fuel
    # it had burnt put back on, charged to the phase and corner where it was lost (_split_by_cause)
    components = {key: np.zeros(len(fl)) for key, *_ in COMPONENTS}
    comp_sections = {key: np.zeros((len(fl), S)) for key, *_ in COMPONENTS}
    if len(fl) >= 2:
        dts = np.array([l.dt for l in fl], np.float32)
        if has_fuel:
            sens_m = np.median(np.array([l.sens for l in fl], np.float32), axis=0)
            dts = dts + np.array([burnt[l.number] for l in fl], np.float32)[:, None] * sens_m
        ref = np.median(dts, axis=0)
        ref_brakes = np.mean([np.isin(l.phase, (BRAKE, TRAIL)) for l in fl], axis=0) > 0.5
        for i, l in enumerate(fl):
            split = _split_by_cause(dts[i], l.phase, ref, ref_brakes, section_of, S)
            for j, (key, *_) in enumerate(COMPONENTS):
                components[key][i] = float(split[j].sum())
                comp_sections[key][i] = split[j]
    st = _Stint(log, number, laps, rows, fitted, xf, series, components, comp_sections,
                balance_sections[fitted] if fitted else np.zeros((0, S, 3)), driver_sections, {})
    st.out = _stint_out(st, sens, has_fuel)
    return st


def _fits(st: _Stint) -> dict:
    out = {}
    for key, y in st.series.items():
        t = trend(st.x, y)
        if t is not None:
            out[key] = t
    for key, y in st.components.items():
        t = trend(st.x, y)
        if t is not None:
            out[f"fade_{key}"] = t
    return out


def _stint_out(st: _Stint, sens: float, has_fuel: bool) -> dict:
    log, laps, rows = st.log, st.laps, st.rows
    fits = _fits(st)
    fl = [laps[i] for i in st.fitted]
    times = [laps[i].time for i in st.fitted]
    kg = [r["fuel_kg"] for r in (st.rows[i] for i in st.fitted) if r.get("fuel_kg") is not None]
    fuel = None
    if has_fuel and np.isfinite(sens):
        per_lap = float(np.median(kg)) if kg else None
        fuel = {"source": log.fuel["source"], "note": log.fuel["note"], "kg_per_lap": _r(per_lap, 2),
                "s_per_10kg": round(10 * sens, 3), "mass_kg": log.mass["kg"], "mass_source": log.mass["source"],
                "fuel_s_per_lap": _r(-per_lap * sens, 3) if per_lap is not None else None}
    sections = _section_rows(st)
    return {
        "key": f"{log.key}:{st.number}", "file_key": log.key, "run": log.name, "session_id": log.meta.get("session_id"),
        "file_id": log.meta.get("file_id"), "number": st.number, "first_lap": laps[0].number,
        "last_lap": laps[-1].number, "start_s": round(laps[0].start, 1), "end_s": round(laps[-1].end, 1),
        "best": min(times) if times else None, "median": round(float(np.median(times)), 3) if times else None,
        "fitted_laps": len(fl), "fits": fits, "fuel": fuel, "laps": rows,
        "groups": _group_laps(st), "sections": sections,
    }


def _group_laps(st: _Stint) -> dict | None:
    g = _groups(len(st.fitted))
    if g is None:
        return None
    nums = [st.laps[i].number for i in st.fitted]
    return {"early": nums[g[0]], "late": nums[g[1]]}


def _section_rows(st: _Stint) -> list[dict]:
    """Per corner: the balance early and late in the stint, and the fade and the driver's changes there."""
    g = _groups(len(st.fitted))
    out = []
    for j, s in enumerate(st.log.sections):
        row: dict = {"code": s.code, "corner": s.apex is not None}
        if g is not None and st.balance_sections.size:
            for p, (_, name) in enumerate(BALANCE_PHASES):
                col = st.balance_sections[:, j, p]
                early, late = col[g[0]], col[g[1]]
                if np.count_nonzero(np.isfinite(early)) >= 2 and np.count_nonzero(np.isfinite(late)) >= 2:
                    e, la = float(np.nanmedian(early)), float(np.nanmedian(late))
                    row[name] = {"early": round(e, 2), "late": round(la, 2), "shift": round(la - e, 2)}
        fade = {}
        for key, *_ in COMPONENTS:
            t = trend(st.x, st.comp_sections[key][:, j]) if len(st.x) else None
            if t is not None:
                fade[key] = t["per_lap"]
        row["fade"] = fade
        drv = {}
        for key in DRIVER:
            t = trend(st.x, st.driver_sections[key][:, j]) if len(st.x) else None
            if t is not None:
                drv[key] = {"change": t["change"], "clear": t["clear"]}
        row["driver"] = drv
        out.append(row)
    return out


def _gradient(logs: list[LogSummary]) -> float | None:
    num = sum(l.k_sums[0] for l in logs)
    den = sum(l.k_sums[1] for l in logs)
    return num / den if den > 0 else None


def combine(stints: list[_Stint]) -> dict:
    """The same trends over every stint in view at once: each stint keeps its own level, the change per lap is
    shared."""
    fits = {}
    keys = set().union(*(s.series for s in stints)) if stints else set()
    for key in keys:
        t = pooled_trend([(s.x, s.series[key]) for s in stints if key in s.series])
        if t is not None:
            fits[key] = t
    for key, *_ in COMPONENTS:
        t = pooled_trend([(s.x, s.components[key]) for s in stints])
        if t is not None:
            fits[f"fade_{key}"] = t
    # per corner (by its code: logs at one track share them)
    by_code: dict[str, dict[str, list]] = {}
    corner: dict[str, bool] = {}
    for s in stints:
        g = _groups(len(s.fitted))
        for j, sec in enumerate(s.log.sections):
            corner[sec.code] = corner.get(sec.code, False) or sec.apex is not None
            d = by_code.setdefault(sec.code, {key: [] for key in (*[c[0] for c in COMPONENTS], *DRIVER, "early",
                                                                    "late")})
            for key, *_ in COMPONENTS:
                d[key].append((s.x, s.comp_sections[key][:, j]))
            for key in DRIVER:
                d[key].append((s.x, s.driver_sections[key][:, j]))
            if g is not None and s.balance_sections.size:  # the balance early and late in each stint
                d["early"].append(s.balance_sections[g[0], j])
                d["late"].append(s.balance_sections[g[1], j])
    sections = []
    for code, d in by_code.items():
        fade = {key: t["per_lap"] for key, *_ in COMPONENTS if (t := pooled_trend(d[key])) is not None}
        drv = {key: {"change": t["change"], "clear": t["clear"]} for key in DRIVER
               if (t := pooled_trend(d[key])) is not None}
        row = {"code": code, "corner": corner[code], "fade": fade, "driver": drv}
        if d["early"]:
            early, late = np.concatenate(d["early"]), np.concatenate(d["late"])
            for p, (_, name) in enumerate(BALANCE_PHASES):
                e, la = early[:, p], late[:, p]
                if np.count_nonzero(np.isfinite(e)) >= 2 and np.count_nonzero(np.isfinite(la)) >= 2:
                    e_, l_ = float(np.nanmedian(e)), float(np.nanmedian(la))
                    row[name] = {"early": round(e_, 2), "late": round(l_, 2), "shift": round(l_ - e_, 2)}
        sections.append(row)
    fuel = [s.out["fuel"] for s in stints if s.out["fuel"] and s.out["fuel"]["kg_per_lap"] is not None]
    fuel_out = None
    if fuel:
        w = [s.out["fitted_laps"] for s in stints if s.out["fuel"] and s.out["fuel"]["kg_per_lap"] is not None]
        kg = float(np.average([f["kg_per_lap"] for f in fuel], weights=w))
        s10 = float(np.average([f["s_per_10kg"] for f in fuel], weights=w))
        fuel_out = {**fuel[0], "kg_per_lap": round(kg, 2), "s_per_10kg": round(s10, 3),
                    "fuel_s_per_lap": round(-kg * s10 / 10, 3)}
    return {"fits": fits, "sections": sections, "fuel": fuel_out, "stints": len(stints),
            "fitted_laps": sum(len(s.fitted) for s in stints)}


def assemble(logs: list[LogSummary], tags: dict[tuple[str, int], str] | None = None) -> dict:
    """Every stint of these logs, lap by lap, with the user's tags: trends, fuel and tyres, the fade by phase, the
    balance shift per corner, and what it says in plain words."""
    from app.analysis.stint_words import overall_words, stint_words

    tags = tags or {}
    k = _gradient(logs)
    if k is not None and not np.isfinite(k):
        k = None
    stints: list[_Stint] = []
    for log in logs:
        by_stint: dict[int, list[LapSummary]] = {}
        for lap in log.laps:
            by_stint.setdefault(lap.stint, []).append(lap)
        for number, laps in by_stint.items():
            stints.append(_stint(log, number, laps, tags, k))
    steer = next((l.steer for l in logs if l.steer.get("channel")), {})
    units = {"steer": steer.get("unit") or "°", "steer_role": steer.get("role"),
             "brake": next((l.brake_unit for l in logs if l.brake_unit), "")}
    out_stints = []
    for s in stints:
        s.out["words"] = stint_words(s.out, units)
        out_stints.append(s.out)
    usable = [s for s in stints if len(s.fitted) >= 2]
    overall = combine(usable)
    overall["words"] = overall_words(overall, out_stints, units)
    notes = []
    if k is not None:
        notes.append(f"Balance: the understeer angle against the car's normal at the same cornering g "
                     f"({k:.2f}° per g, fitted on every clean lap in view), as in the report's balance section.")
    else:
        notes.append(next((l.balance["note"] for l in logs if l.balance and l.balance.get("note")),
                          "No balance: the logs need a steering angle and a yaw rate."))
    for log in logs:
        notes.extend(f"{log.name}: {n}" for n in log.notes)
    return {"logs": [_log_out(l) for l in logs], "understeer_per_g": _r(k, 2), "units": units,
            "steer_channel": steer.get("channel"), "overall": overall, "stints": out_stints, "notes": notes}


def _log_out(log: LogSummary) -> dict:
    return {"key": log.key, "name": log.name, "session_id": log.meta.get("session_id"),
            "file_id": log.meta.get("file_id"), "lap_source": log.lap_source, "laps": len(log.laps),
            "length_m": log.length, "numbering": log.meta.get("numbering"),
            "stops": [{"start_s": round(a, 1), "end_s": round(b, 1), "duration_s": round(b - a, 1)}
                      for a, b in log.stops],
            "fuel": log.fuel or None, "mass": log.mass, "balance": log.balance, "notes": log.notes}


def stint_analysis(run: RunInput, corners: list[CornerSpec] | None = None, geo: Geometry | None = None,
                   tags: dict | None = None) -> dict:
    """Every stint in one run (reduce_run then assemble)."""
    return assemble([reduce_run(run, corners, geo)], tags)
