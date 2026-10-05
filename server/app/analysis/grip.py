"""Grip use and traction control: how much of the car's grip the driver uses, where the rest is left, and what
traction control costs on the corner exits.

The car's grip limit is the engine's own (limits.py): the 98th percentile of combined g in each 10° direction and
speed band, from the laps within 2 % of the quickest. Grip use is combined g over that limit, averaged over the time
spent braking, turning in, mid-corner and on the exit; full-throttle straights are left out, because there the
engine is the limit. The quick laps (within 1 % of the best) are split into their quickest and slowest third to see
what the quick ones do differently, corner by corner and phase by phase.

Traction control is the logger's TC intervention flag with the throttle open. A zone is a stretch where TC works on
at least one quick lap in twelve. In each zone, passes with more TC are compared with passes with less at the same
entry speed: the speed 150 m later and the time to the next braking point say whether TC costs time there or only
trims wheelspin while the driver pushes.

Many runs (a test day, an event) are read one at a time: each run's clean laps are placed on one track line and cut
down to a dozen channels per metre (about 0.2 MB a lap) before the next run is read, so memory stays flat however
many runs there are.
"""
from __future__ import annotations

import math
from itertools import pairwise

import numpy as np

from app.analysis.align import TrackLine, aligned_trace, track_line
from app.analysis.channels import BRAKE, EXIT, MID, POWER, TRAIL, math_channels
from app.analysis.insights import LapRecord, _limit_laps, _within, corr
from app.analysis.laps import CornerSpec, Lap, SessionData, Section, lap_length, make_sections
from app.analysis.limits import CarLimits, car_limits
from app.importers.motec import LdFile

QUICK_WITHIN = 0.01  # quick laps: within 1 % of the best
MIN_QUICK = 8  # with fewer quick laps than this, the quickest clean laps make up the number
GRIP_PHASES = ((BRAKE, "braking"), (TRAIL, "trail"), (MID, "mid"), (EXIT, "exit"))
SPOT_R = -0.35  # metres where grip use and section time go together at least this strongly
SPOT_MIN_M, SPOT_GAP_M = 15, 10  # a spot is one phase of the corner, at least 15 m long
SPOT_MIN_USE = 0.6  # below this the engine, not the tyres, limits the car
SMOOTH_M = 21
FLAT_SHARE = 0.3  # a section with less of its time than this in the grip phases is taken flat

TC_THROTTLE = 30.0  # % pedal: TC working with the driver on the throttle
TC_ZONE_SHARE = 0.08  # TC on at least one quick lap in twelve
TC_ZONE_MIN_M, TC_ZONE_GAP_M = 15, 30
TC_BEFORE_M, TC_AFTER_M, TC_FAR_M = 40, 20, 150
TC_PASS_S = 0.05  # a pass with more TC than this counts as a pass with TC
SIGNIFICANT = 0.05
KERB_G = 0.5  # vertical g spike that marks a kerb strike
MAP_STEP_M, GG_STEP_M = 5, 5

# Channels read straight from the log, beyond the standard roles: (role, names, sampled not interpolated)
EXTRA = (
    ("engine_torque", ("MEngine", "Engine Torque", "TqEngine", "Torque"), False),
    ("g_vert", ("G Force Vert", "gVert", "Vertical Accel", "G Vert", "aVert"), False),
    ("tc_switch", ("NSTWThumbSlip", "TC Switch", "TC Map", "TC Setting", "TC Level"), True),
)
# What a lap keeps once it is on the track line
KEEP = ("speed", "ax", "ay", "throttle", "brake", "tc_on", "rear_slip", "steer_wheel", "steer", "rpm",
        "engine_torque", "g_vert", "tc_switch")
STATE = ("tyre_t_rl", "tyre_t_rr", "tc_switch")  # kept per lap as the lap's median
# The standard roles the math channels need; everything else is dropped before they are worked out
MATH_IN = ("speed", "g_long", "g_lat", "yaw", "steer", "throttle", "brake", "lat", "lon", "tc",
           "wheel_fl", "wheel_fr", "wheel_rl", "wheel_rr")


def _wmean(v: np.ndarray, w: np.ndarray) -> float | None:
    s = float(w.sum())
    return float((v * w).sum() / s) if s > 0 else None


def _dt(t: np.ndarray) -> np.ndarray:
    return np.diff(t, append=t[-1] + (t[-1] - t[-2]))


def _fit(x, y) -> dict | None:
    """corr() with the line's intercept, for drawing it."""
    x, y = np.asarray(x, float), np.asarray(y, float)
    c = corr(x, y)
    if c is None:
        return None
    ok = ~(np.isnan(x) | np.isnan(y))
    return {**c, "intercept": float(y[ok].mean() - c["slope"] * x[ok].mean())}


def partial(y, x, z) -> dict | None:
    """The effect of x on y with z held fixed: least squares on both, and the correlation of what is left of x
    and y once z is taken out."""
    y, x, z = (np.asarray(a, float) for a in (y, x, z))
    ok = ~(np.isnan(x) | np.isnan(y) | np.isnan(z))
    y, x, z = y[ok], x[ok], z[ok]
    if len(x) < 8 or x.std() < 1e-9 or z.std() < 1e-9:
        return None
    coef, *_ = np.linalg.lstsq(np.c_[x, z, np.ones(len(x))], y, rcond=None)
    rx = x - np.polyval(np.polyfit(z, x, 1), z)
    ry = y - np.polyval(np.polyfit(z, y, 1), z)
    c = corr(rx, ry)
    if c is None:
        return None
    return {"r": c["r"], "p": c["p"], "n": c["n"], "coef": float(coef[0])}


def _runs_of(mask: np.ndarray, min_len: int, gap: int) -> list[tuple[int, int]]:
    """Stretches where mask holds, joined across gaps shorter than gap and kept when at least min_len long."""
    edges = np.flatnonzero(np.diff(np.r_[0, mask.astype(int), 0]))
    segs: list[list[int]] = []
    for a, b in zip(edges[::2], edges[1::2], strict=True):
        if segs and a - segs[-1][1] < gap:
            segs[-1][1] = int(b)
        else:
            segs.append([int(a), int(b)])
    return [(a, b) for a, b in segs if b - a >= min_len]


def _box(y: np.ndarray, n: int) -> np.ndarray:
    return np.convolve(y, np.ones(n) / n, "same")


def _r(v, nd: int = 3):
    if v is None:
        return None
    v = float(v)
    return None if not math.isfinite(v) else round(v, nd)


def _pct(v):
    return None if v is None else _r(100 * v, 1)


def _clean(o):
    """JSON-safe: numpy numbers to Python, NaN and infinity to None."""
    if isinstance(o, dict):
        return {k: _clean(v) for k, v in o.items()}
    if isinstance(o, list | tuple):
        return [_clean(v) for v in o]
    if isinstance(o, np.integer):
        return int(o)
    if isinstance(o, float | np.floating):
        return None if not math.isfinite(float(o)) else float(o)
    if isinstance(o, np.bool_):
        return bool(o)
    return o


# ---------- reading runs one at a time ----------

class GripStudy:
    """Collects the clean laps of one run after another on one track line, then reports on all of them."""

    def __init__(self, corners: list[CornerSpec] | None = None):
        self.corners = corners
        self.line: TrackLine | None = None
        self.length: int | None = None
        self.laps: list[LapRecord] = []
        self.state: dict[str, dict[str, float]] = {}
        self.sources: dict[str, str] = {}
        self.units: dict[str, str] = {}
        self.runs: list[dict] = []

    def add(self, name: str, data: SessionData, ld: LdFile | None = None, driver: str | None = None) -> None:
        """Place the run's clean laps on the track line and keep what the report needs.

        This uses up the run's channels: the ones the report has no use for are dropped from data.channels as it
        goes, so a long log never holds every channel and the math channels at once.
        """
        clean = [l for l in data.laps if l.clean]
        self.runs.append({"name": name, "clean_laps": len(clean), "best": min((l.time for l in clean), default=None)})
        if not clean:
            return
        keep = {"phase", "lat", "lon", *KEEP, *STATE}
        channels = data.channels
        for role in [r for r in channels if r not in keep and r not in MATH_IN]:
            del channels[role]
        if ld is not None:
            for role, names, discrete in EXTRA:
                ch = ld.channel(*names)
                if ch is None or ch.count < 2:
                    continue
                ct, cv = ch.times(), ch.values().astype(float)
                if discrete:
                    channels[role] = cv[np.clip(np.searchsorted(ct, data.t, side="right") - 1, 0, len(cv) - 1)]
                else:
                    channels[role] = np.interp(data.t, ct, cv)
                self.sources.setdefault(role, ch.name)
                self.units.setdefault(role, ch.unit)
        if "phase" not in channels:
            math_channels(data)
        for role in [r for r in channels if r not in keep]:
            del channels[role]
        for role, src in data.sources.items():
            self.sources.setdefault(role, src)
            if ld is not None and role not in self.units:
                ch = ld.channel(src)
                self.units[role] = ch.unit if ch is not None else ""
        if self.length is None:
            ref = min(clean, key=lambda l: l.time)
            self.line = track_line(data, ref)
            self.length = self.line.length if self.line is not None else round(lap_length(data, ref))
        for i, lap in enumerate(clean):
            self._add_lap(name, driver, data, lap, i)

    def _add_lap(self, run: str, driver: str | None, data: SessionData, lap: Lap, index: int) -> None:
        tr = aligned_trace(data, lap, self.line, self.length)
        cut: dict[str, np.ndarray] = {"t": tr["t"], "phase": np.rint(tr["phase"]).astype(np.int8)}
        for k in KEEP:
            if k in tr:
                cut[k] = tr[k].astype(np.float32)
        moving = tr["speed"] > 60
        state = {k: float(np.median(tr[k][moving] if moving.any() else tr[k])) for k in STATE if k in tr}
        rec = LapRecord(run, lap.number, lap.time, driver, cut, index)
        self.laps.append(rec)
        self.state[rec.key] = state

    # ---------- the report ----------

    def report(self) -> dict:
        if not self.laps:
            return _clean({"available": False, "runs": self.runs,
                           "notes": ["No clean laps in these logs, so the car's grip limit can't be learned yet."]})
        return _clean(Report(self).build())


class Report:
    def __init__(self, study: GripStudy):
        self.s = study
        self.laps = study.laps
        self.ref = min(self.laps, key=lambda x: x.time)
        self.limits: CarLimits = car_limits([x.trace for x in _limit_laps(self.laps)])
        self.sections, self.numbering = make_sections(self.ref.trace, study.corners)
        self.n = len(self.ref.trace["speed"])
        self.use = {x.key: self.limits.use(x.trace["speed"], x.trace["ax"], x.trace["ay"]).astype(np.float32)
                    for x in self.laps}
        self.dt = {x.key: _dt(x.trace["t"]) for x in self.laps}
        best = self.ref.time
        ranked = sorted(self.laps, key=lambda x: x.time)
        quick = [x for x in ranked if x.time <= best * (1 + QUICK_WITHIN)]
        self.quick = quick if len(quick) >= MIN_QUICK else ranked[:MIN_QUICK]
        self.typical = self.quick[len(self.quick) // 2]
        self.notes: list[str] = []
        # where each section's corner is: its slowest point, or the official position of its slowest corner
        at = {c[0]: int(c[1]) for c in study.corners or [] if c[1] is not None}
        speed = self.ref.trace["speed"]
        self.apex: dict[str, int | None] = {}
        for s in self.sections:
            known = [min(at[c], self.n - 1) for c in s.corners if c in at]
            slowest = min(known, key=lambda a: speed[a]) if known else None
            self.apex[s.code] = s.apex if s.apex is not None else slowest

    def build(self) -> dict:
        laps = [self._lap_row(x) for x in self.laps]
        grip = self._lap_grip(laps)
        sections = [self._section(s) for s in self.sections]
        tc = TractionControl(self).build(laps)
        out = {
            "available": True,
            "runs": self.s.runs,
            "numbering": self.numbering,
            "length_m": self.n - 1,
            "clean_laps": len(self.laps),
            "quick_laps": len(self.quick),
            "quick_within_pct": QUICK_WITHIN * 100,
            "fastest": self._lap_id(self.ref),
            "typical": self._lap_id(self.typical),
            "limits": self._limits(),
            "grip": grip,
            "sections": sections,
            "laps": laps,
            "tc": tc,
            "gg": {"fastest": self._gg(self.ref), "typical": self._gg(self.typical)},
            "map": self._map(tc),
            "channels": self._channels(),
        }
        out["headlines"] = headlines(out)
        out["notes"] = self._channel_notes() + self.notes
        return out

    @staticmethod
    def _lap_id(x: LapRecord) -> dict:
        return {"run": x.run, "lap": x.number, "time": x.time}

    # ---------- laps ----------

    def _lap_row(self, x: LapRecord) -> dict:
        u, dt, ph = self.use[x.key], self.dt[x.key], x.trace["phase"]
        st = self.s.state[x.key]
        rear = [st[k] for k in ("tyre_t_rl", "tyre_t_rr") if k in st]
        row = {
            "run": x.run, "lap": x.number, "time": x.time, "quick": x in self.quick,
            "grip_use": _pct(_wmean(u, dt * (ph < POWER))),
            "phases": {name: _pct(_wmean(u, dt * (ph == p))) for p, name in GRIP_PHASES},
            "tc_s": _r((dt * self.tc_active(x)).sum(), 2) if "tc_on" in x.trace else None,
            "rear_tyre_c": _r(np.mean(rear), 1) if len(rear) == 2 else None,
            "tc_switch": round(st["tc_switch"]) if "tc_switch" in st else None,
        }
        return row

    def tc_active(self, x: LapRecord) -> np.ndarray:
        on = x.trace["tc_on"] > 0.5
        return on & (x.trace["throttle"] > TC_THROTTLE) if "throttle" in x.trace else on

    def _lap_grip(self, rows: list[dict]) -> dict:
        times = np.array([r["time"] for r in rows])
        use = np.array([np.nan if r["grip_use"] is None else r["grip_use"] for r in rows])
        runs = [r["run"] for r in rows]
        quick = np.array([r["quick"] for r in rows])
        overall = _fit(use, times)
        quick_fit = _fit(use[quick], times[quick])
        quick_runs = [r for r, q in zip(runs, quick, strict=True) if q]
        within = corr(_within(use[quick], quick_runs), _within(times[quick], quick_runs))
        thirds = {}
        n3 = max(1, len(self.quick) // 3)
        for name, group in (("fast", self.quick[:n3]), ("slow", self.quick[-n3:])):
            thirds[name] = {}
            for p, pname in GRIP_PHASES:
                us = [_wmean(self.use[x.key], self.dt[x.key] * (x.trace["phase"] == p)) for x in group]
                us = [u for u in us if u is not None]
                ts = [float((self.dt[x.key] * (x.trace["phase"] == p)).sum()) for x in group]
                thirds[name][pname] = {"grip_use": _pct(np.mean(us)) if us else None, "time_s": _r(np.mean(ts), 2)}
        per_pct = quick_fit["slope"] if quick_fit else (overall["slope"] if overall else None)
        return {
            "typical": _r(np.nanmedian(use[quick]), 1) if quick.any() else None,
            "best_lap": _r(use[int(np.argmin(times))], 1),
            "vs_time": _stat(overall), "vs_time_quick": _stat(quick_fit), "vs_time_within": _stat(within),
            # seconds a lap for each 1 % more grip use, over the quick laps (negative: more grip, quicker)
            "s_per_pct": _r(per_pct, 3),
            "phases": thirds,
        }

    # ---------- sections ----------

    def _section(self, s: Section) -> dict:
        a, b = s.start, s.end
        rows = [self._pass(x, a, b) for x in self.quick]
        t = np.array([r["time"] for r in rows])
        us = np.array([np.nan if r["grip_use"] is None else r["grip_use"] for r in rows])
        order = np.argsort(t)
        n3 = max(1, len(t) // 3)
        fast, slow = order[:n3], order[-n3:]
        c = _fit(us, t)
        u_med = float(np.nanmedian(us)) if not np.isnan(us).all() else None
        u_fast = float(np.nanmean(us[fast])) if not np.isnan(us[fast]).all() else None
        worth = max(0.0, -c["slope"] * (u_fast - u_med)) if c and u_fast is not None and u_med is not None else None
        phases = {}
        for _, name in GRIP_PHASES:
            pu = np.array([np.nan if r["phases"][name] is None else r["phases"][name] for r in rows])
            pt = np.array([r["phase_time"][name] for r in rows])
            pc = corr(pu, t)
            ok = ~np.isnan(pu)
            phases[name] = {
                "grip_use": _pct(np.median(pu[ok])) if ok.sum() else None,
                "fast": _pct(np.nanmean(pu[fast])) if (~np.isnan(pu[fast])).any() else None,
                "slow": _pct(np.nanmean(pu[slow])) if (~np.isnan(pu[slow])).any() else None,
                "time_s": _r(np.median(pt), 2), "r": pc["r"] if pc else None,
            }
        grip_time = sum(np.median([r["phase_time"][n] for r in rows]) for _, n in GRIP_PHASES)
        flat = grip_time < FLAT_SHARE * float(np.median(t))
        spots = self._spots(s, t, fast, slow)
        brake_peak = np.array([r["brake_peak"] for r in rows]) if rows[0]["brake_peak"] is not None else None
        out = {
            **s.to_dict(), "apex_m": self.apex[s.code], "corners": s.corners, "passes": len(rows),
            "time": _r(np.median(t)), "time_fast": _r(t[fast].mean()), "time_slow": _r(t[slow].mean()),
            "grip_use": _pct(u_med), "grip_use_fast": _pct(u_fast),
            "grip_use_slow": _pct(np.nanmean(us[slow])) if not np.isnan(us[slow]).all() else None,
            "r": c["r"] if c else None, "p": _r(c["p"], 4) if c else None,
            "s_per_pct": _r(c["slope"] / 100, 4) if c else None, "worth_s": _r(worth),
            "phases": phases, "flat_out": bool(flat), "spots": spots,
            "brake_peak_fast": _r(brake_peak[fast].mean(), 1) if brake_peak is not None else None,
            "brake_peak_slow": _r(brake_peak[slow].mean(), 1) if brake_peak is not None else None,
        }
        out["note"] = section_note(out, self.s.units.get("brake", ""))
        return out

    def _pass(self, x: LapRecord, a: int, b: int) -> dict:
        tr = x.trace
        sl = slice(a, b)
        u, dt, ph = self.use[x.key][sl], self.dt[x.key][sl], tr["phase"][sl]
        return {
            "time": float(tr["t"][b] - tr["t"][a]),
            "grip_use": _wmean(u, dt * (ph < POWER)),
            "phases": {name: _wmean(u, dt * (ph == p)) for p, name in GRIP_PHASES},
            "phase_time": {name: float((dt * (ph == p)).sum()) for p, name in GRIP_PHASES},
            "brake_peak": float(tr["brake"][sl].max()) if "brake" in tr else None,
        }

    def _spots(self, s: Section, t: np.ndarray, fast: np.ndarray, slow: np.ndarray) -> list[dict]:
        """Stretches of the section where the quick passes use clearly more grip than the slow ones."""
        a, b = s.start, s.end
        if len(t) < 8 or t.std() < 1e-9:
            return []
        U = np.array([_box(self.use[x.key].astype(float), SMOOTH_M)[a:b] for x in self.quick])
        PH = np.array([x.trace["phase"][a:b] for x in self.quick])
        zt = (t - t.mean()) / t.std()
        sd = U.std(0)
        r = np.where(sd > 1e-9, ((U - U.mean(0)) * zt[:, None]).mean(0) / np.where(sd > 1e-9, sd, 1), 0.0)
        mode = np.array([np.bincount(PH[:, i].astype(int), minlength=5).argmax() for i in range(b - a)])
        out = []
        found = [(sa, sb, p) for p, _ in GRIP_PHASES for sa, sb in _runs_of((r < SPOT_R) & (mode == p), SPOT_MIN_M,
                                                                            SPOT_GAP_M)]
        for sa, sb, phase in found:
            seg = slice(sa, sb)
            raw = np.array([self.use[x.key][a:b][seg].mean() for x in self.quick])
            if raw[fast].mean() < SPOT_MIN_USE:
                continue

            def m(key, rows, how=np.mean, seg=seg):
                vals = [how(x.trace[key][a:b][seg]) for x in (self.quick[i] for i in rows) if key in x.trace]
                return float(np.mean(vals)) if vals else None

            out.append({
                "start_m": a + sa, "end_m": a + sb, "r": _r(r[seg].min(), 2), "phase": dict(GRIP_PHASES)[phase],
                "grip_fast": _pct(raw[fast].mean()), "grip_slow": _pct(raw[slow].mean()),
                "speed_fast": _r(m("speed", fast), 1), "speed_slow": _r(m("speed", slow), 1),
                "ax_fast": _r(m("ax", fast), 2), "ax_slow": _r(m("ax", slow), 2),
                "ay_fast": _r(m("ay", fast, lambda v: np.abs(v).mean()), 2),
                "ay_slow": _r(m("ay", slow, lambda v: np.abs(v).mean()), 2),
                "brake_fast": _r(m("brake", fast, np.max), 1), "brake_slow": _r(m("brake", slow, np.max), 1),
                "throttle_fast": _r(m("throttle", fast), 0), "throttle_slow": _r(m("throttle", slow), 0),
            })
        out.sort(key=lambda sp: sp["r"])
        return out[:2]

    # ---------- charts ----------

    def _limits(self) -> dict:
        lim = self.limits.to_dict()
        c = self.limits.speeds
        edges = [40.0, *((c[:-1] + c[1:]) / 2).tolist(), None]
        lim["bands_kmh"] = [[_r(lo, 0), _r(hi, 0)] for lo, hi in pairwise(edges)]
        return lim

    def _gg(self, x: LapRecord) -> dict:
        tr = x.trace
        idx = np.arange(0, self.n, GG_STEP_M)
        idx = idx[tr["phase"][idx] < POWER]
        return {"m": idx.tolist(), "speed": np.round(tr["speed"][idx], 0).tolist(),
                "ax": np.round(tr["ax"][idx], 2).tolist(), "ay": np.round(tr["ay"][idx], 2).tolist(),
                "use": np.round(100 * self.use[x.key][idx], 0).tolist(), "phase": tr["phase"][idx].tolist(),
                **self._lap_id(x)}

    def _map(self, tc: dict) -> dict | None:
        line = self.s.line
        if line is None:
            return None
        d = line.to_dict(MAP_STEP_M)
        k = len(d["x"])
        U = np.array([self.use[x.key] for x in self.quick])
        grip = np.array([x.trace["phase"] < POWER for x in self.quick])
        mostly = grip.mean(0) >= 0.5  # metres the quick laps mostly spend braking or cornering
        med = np.full(self.n, np.nan)
        med[mostly] = np.nanmedian(np.where(grip, U, np.nan)[:, mostly], 0)
        typical = med[::MAP_STEP_M][:k]
        out = {**d, "grip_use": [_pct(v) if not np.isnan(v) else None for v in typical]}
        freq = tc.pop("_freq", None)
        out["tc"] = [_pct(v) for v in freq[::MAP_STEP_M][:k]] if freq is not None else None
        return out

    # ---------- what the logs have ----------

    def _channels(self) -> dict:
        has = lambda role: all(role in x.trace for x in self.laps)  # noqa: E731
        some = lambda role: any(role in x.trace for x in self.laps)  # noqa: E731
        return {
            "accelerometers": "g_lat" in self.s.sources and "g_long" in self.s.sources,
            "tc": self.s.sources.get("tc") if some("tc_on") else None, "tc_all_runs": has("tc_on"),
            "wheel_speeds": some("rear_slip"), "engine_torque": self.s.sources.get("engine_torque"),
            "tc_switch": self.s.sources.get("tc_switch"),
            "tyre_temps": any(len([k for k in ("tyre_t_rl", "tyre_t_rr") if k in st]) == 2
                              for st in self.s.state.values()),
            "throttle": has("throttle"), "brake": has("brake"),
            "steering": self.s.sources.get("steer_wheel") or self.s.sources.get("steer"),
            "brake_unit": self.s.units.get("brake", ""),
        }

    def _channel_notes(self) -> list[str]:
        ch = self._channels()
        out = []
        if not ch["accelerometers"]:
            out.append("No accelerometers in these logs: g comes from speed and the yaw rate or GPS, so grip use is "
                       "approximate.")
        if not ch["throttle"]:
            out.append("No throttle channel in some logs, so the corner phases come from the g-forces alone.")
        return out


def _stat(c: dict | None) -> dict | None:
    if c is None:
        return None
    out = {"r": _r(c["r"], 3), "n": c["n"], "p": _r(c["p"], 5), "slope": _r(c["slope"], 5)}
    if "intercept" in c:
        out["intercept"] = _r(c["intercept"], 5)
    return out


# ---------- traction control ----------

class TractionControl:
    def __init__(self, rep: Report):
        self.rep = rep
        self.laps = [x for x in rep.laps if "tc_on" in x.trace]
        self.quick = [x for x in rep.quick if "tc_on" in x.trace]

    def build(self, rows: list[dict]) -> dict:
        if not self.laps:
            return {"available": False, "zones": [], "notes": [
                "These logs have no traction control channel (BInterventionCauseTC or TC Active), so TC is left out."]}
        rep = self.rep
        n = rep.n
        notes = []
        if len(self.laps) < len(rep.laps):
            notes.append(f"{len(rep.laps) - len(self.laps)} of {len(rep.laps)} clean laps come from logs without the "
                         "TC channel and are left out of this part.")
        base = self.quick or self.laps
        freq = _box(np.mean([rep.tc_active(x) for x in base], 0).astype(float), 11)
        tq = self._torque_map()
        zones = [self._zone(a, b, freq, tq) for a, b in _runs_of(freq > TC_ZONE_SHARE, TC_ZONE_MIN_M, TC_ZONE_GAP_M)]
        zones = [z for z in zones if z is not None]
        lost = sum(z["time_cost_s"] * z["quick_share"] for z in zones if z["verdict"] == "cost")
        out = {"available": True, "channel": rep.s.sources.get("tc"), "zones": zones,
               "lost_per_lap_s": _r(lost), "_freq": freq[:n]}
        out.update(self._lap_links(rows, notes))
        if not any("rear_slip" in x.trace for x in self.laps):
            notes.append("No wheel speeds (nWheelXX) in these logs, so wheelspin can't be measured.")
        if tq is None:
            notes.append("No engine torque channel (MEngine), so how much torque TC took can't be measured.")
        out["notes"] = notes
        return out

    def _torque_map(self):
        """Engine torque at each pedal position and rpm without TC: what the engine would have given."""
        laps = [x for x in self.laps if all(k in x.trace for k in ("engine_torque", "rpm", "throttle"))]
        if not laps:
            return None
        ped = np.concatenate([x.trace["throttle"] for x in laps])
        rpm = np.concatenate([x.trace["rpm"] for x in laps])
        tq = np.concatenate([x.trace["engine_torque"] for x in laps])
        free = np.concatenate([(x.trace["tc_on"] < 0.5) & (x.trace["speed"] > 40) for x in laps])
        if free.sum() < 500:
            return None
        ped_b = np.array([0, 30, 50, 70, 85, 95, 101.0])
        lo, hi = np.percentile(rpm[free], [1, 99])
        rpm_b = np.arange(math.floor(lo / 250) * 250, math.ceil(hi / 250) * 250 + 251, 250.0)
        table = np.full((len(ped_b) - 1, len(rpm_b) - 1), np.nan)
        pi = np.digitize(ped[free], ped_b) - 1
        ri = np.digitize(rpm[free], rpm_b) - 1
        tf = tq[free]
        for i in range(table.shape[0]):
            for j in range(table.shape[1]):
                m = (pi == i) & (ri == j)
                if m.sum() > 30:
                    table[i, j] = np.percentile(tf[m], 75)
            ok = ~np.isnan(table[i])
            if ok.any():
                table[i] = np.interp(np.arange(table.shape[1]), np.flatnonzero(ok), table[i][ok])
        if np.isnan(table).all():
            return None

        def expected(p: np.ndarray, r: np.ndarray) -> np.ndarray:
            i = np.clip(np.digitize(p, ped_b) - 1, 0, table.shape[0] - 1)
            j = np.clip(np.digitize(r, rpm_b) - 1, 0, table.shape[1] - 1)
            return table[i, j]
        return expected

    def _zone(self, za: int, zb: int, freq: np.ndarray, tq) -> dict | None:
        rep = self.rep
        n = rep.n
        a0, b0 = max(za - TC_BEFORE_M, 0), min(zb + TC_AFTER_M, n - 1)
        quick = {x.key for x in self.quick}
        passes = [self._pass(x, a0, b0, tq) | {"quick": x.key in quick} for x in self.laps]
        tct = np.array([p["tc_s"] for p in passes])
        hit = tct > TC_PASS_S
        if not hit.any():
            return None
        vin = [p["v_in"] for p in passes]
        speed = partial([p["v_far"] for p in passes], tct, vin)
        zone_t = partial([p["t_zone"] for p in passes], tct, vin)
        run_t = partial([p["t_run"] for p in passes], tct, vin)
        mid = (za + zb) // 2
        sec = next((s for s in rep.sections if s.start <= mid < s.end), rep.sections[-1])
        apex = rep.apex[sec.code]
        where = sec.code + (" exit" if apex is not None and mid >= apex else "")
        with_tc = [p for p, h in zip(passes, hit, strict=True) if h]
        without = [p for p, h in zip(passes, hit, strict=True) if not h]

        def med(ps, key):
            vals = [p[key] for p in ps if p.get(key) is not None]
            return float(np.median(vals)) if vals else None

        tc_mean = float(tct[hit].mean())
        verdict = "unknown"
        if speed is not None:
            verdict = "none"
            if speed["p"] < SIGNIFICANT and speed["coef"] < 0:
                verdict = "cost" if run_t and run_t["p"] < SIGNIFICANT and run_t["coef"] > 0 else "minor"
            elif zone_t is not None and zone_t["p"] < SIGNIFICANT and zone_t["coef"] < 0:
                verdict = "pushing"
        qp = [p for p in passes if p["quick"]] or passes
        z = {
            "start_m": za, "end_m": zb, "section": sec.code, "where": where, "verdict": verdict,
            "quick_share": _r(np.mean([p["tc_s"] > TC_PASS_S for p in qp])),
            "clean_share": _r(hit.mean()), "passes": len(passes), "tc_s": _r(tc_mean, 2),
            "speed_in_kmh": _r(np.median(vin), 0), "speed_out_kmh": _r(med(passes, "v_out"), 0),
            "speed_per_tc_s": _r(speed["coef"], 2) if speed else None,
            "speed_r": speed["r"] if speed else None, "speed_p": _r(speed["p"], 4) if speed else None,
            "speed_loss_kmh": _r(speed["coef"] * tc_mean, 1) if speed else None,
            "time_per_tc_s": _r(run_t["coef"], 3) if run_t else None,
            "time_r": run_t["r"] if run_t else None, "time_p": _r(run_t["p"], 4) if run_t else None,
            "time_cost_s": _r(run_t["coef"] * tc_mean, 3) if verdict == "cost" else 0.0,
            "slip_pct": _r(med(with_tc, "slip"), 1),
            "kerb_g": _r(med(with_tc, "kerb"), 2),
            "torque_cut_nm": _r(med(with_tc, "cut_nm"), 0),
            "steer_tc": _r(med(with_tc, "steer_full"), 0), "steer_no_tc": _r(med(without, "steer_full"), 0),
            "pedal_s_tc": _pedal_s(med(with_tc, "rate_full")), "pedal_s_no_tc": _pedal_s(med(without, "rate_full")),
            "lat_g_tc": _r(med(with_tc, "ay_full"), 2), "lat_g_no_tc": _r(med(without, "ay_full"), 2),
            "points": _speed_points(passes) if verdict in ("cost", "minor") else [],
            "steer_unit": "°" if rep.s.units.get("steer_wheel" if "steer_wheel" in rep.s.sources else "steer",
                                                 "").lower().startswith("deg") else "",
        }
        z["note"], z["advice"] = tc_words(z)
        return z

    def _pass(self, x: LapRecord, a0: int, b0: int, tq) -> dict:
        tr = x.trace
        rep = self.rep
        n = rep.n
        sl = slice(a0, b0)
        dt = rep.dt[x.key][sl]
        act = rep.tc_active(x)[sl]
        braking = tr["phase"] <= TRAIL
        nxt = np.flatnonzero(braking[b0:] & (tr["speed"][b0:] > 40))
        nb = b0 + int(nxt[0]) if len(nxt) else n - 1
        p = {"tc_s": float(dt[act].sum()), "v_in": float(tr["speed"][a0]), "v_out": float(tr["speed"][b0]),
             "v_far": float(tr["speed"][min(b0 + TC_FAR_M, nb)]), "t_zone": float(tr["t"][b0] - tr["t"][a0]),
             "t_run": float(tr["t"][nb] - tr["t"][a0])}
        if "rear_slip" in tr:
            p["slip"] = float(tr["rear_slip"][sl].max())
        steer = tr.get("steer_wheel", tr.get("steer"))
        on = np.flatnonzero(act)
        if len(on):
            i0 = a0 + int(on[0])
            if "g_vert" in tr:
                p["kerb"] = float(np.abs(tr["g_vert"][max(i0 - 15, 0):i0 + 5] - 1).max())
            if tq is not None and "engine_torque" in tr:
                cut = np.clip(tq(tr["throttle"][sl], tr["rpm"][sl]) - tr["engine_torque"][sl], 0, None)
                p["cut_nm"] = float(cut[act].mean())
        if "throttle" in tr:
            full = np.flatnonzero(tr["throttle"][sl] > 90)
            if len(full) and full[0] > 0:
                i1 = a0 + int(full[0])
                j1 = int(np.searchsorted(tr["t"], tr["t"][i1] - 0.3))
                p["rate_full"] = float((tr["throttle"][i1] - tr["throttle"][j1]) / 0.3)
                p["ay_full"] = float(abs(tr["ay"][i1]))
                if steer is not None:
                    p["steer_full"] = float(abs(steer[i1]))
        return p

    def _lap_links(self, rows: list[dict], notes: list[str]) -> dict:
        """TC per lap against rear tyre temperature, lap time and the TC switch."""
        rows = [r for r in rows if r["tc_s"] is not None]
        runs = [r["run"] for r in rows]
        tc = np.array([r["tc_s"] for r in rows])
        times = np.array([r["time"] for r in rows])
        out: dict = {"per_lap_s": _r(np.median(tc), 2)}
        temp = np.array([np.nan if r["rear_tyre_c"] is None else r["rear_tyre_c"] for r in rows])
        if np.isnan(temp).all():
            notes.append("No rear tyre temperatures in these logs, so TC can't be set against them.")
            out["vs_rear_temp"] = None
        else:
            out["vs_rear_temp"] = _stat(_fit(temp, tc))
            out["vs_rear_temp_within"] = _stat(corr(_within(temp, runs), _within(tc, runs)))
        out["vs_time"] = _stat(_fit(tc, times))
        out["vs_time_within"] = _stat(corr(_within(tc, runs), _within(times, runs)))
        sw = np.array([np.nan if r["tc_switch"] is None else r["tc_switch"] for r in rows])
        if np.isnan(sw).all():
            out["switch"] = None
        else:
            seen = sorted({int(v) for v in sw[~np.isnan(sw)]})
            c = corr(sw, tc) if len(seen) > 1 else None
            out["switch"] = {"channel": self.rep.s.sources.get("tc_switch"), "positions": seen, "vs_tc": _stat(c)}
        return out


def _speed_points(passes: list[dict]) -> list[list]:
    """Each pass's TC time and its speed 150 m on against a pass with the same entry speed, for the chart."""
    vin = np.array([p["v_in"] for p in passes])
    vfar = np.array([p["v_far"] for p in passes])
    res = vfar - np.polyval(np.polyfit(vin, vfar, 1), vin) if np.ptp(vin) > 0 else vfar - vfar.mean()
    return [[_r(p["tc_s"], 2), _r(d, 2), p["quick"]] for p, d in zip(passes, res, strict=True)]


def _pedal_s(rate: float | None) -> float | None:
    """Seconds from closed to fully open at this pedal rate (%/s)."""
    return _r(100 / rate, 2) if rate is not None and rate > 20 else None


# ---------- plain words ----------

def _f(v, nd=0) -> str:
    return "-" if v is None else f"{v:.{nd}f}"


def section_note(s: dict, brake_unit: str = "") -> str:
    """What the quick passes do differently in this section, in a sentence or two."""
    if s["r"] is None:
        return "Too few quick laps to compare quick and slow passes here."
    brake_r = s["phases"]["braking"]["r"]
    harder_slower = (f" Braking harder here goes with a slower pass (r {brake_r:+.2f}): brake less and carry speed."
                     if brake_r is not None and brake_r >= 0.35 else "")
    if not s["spots"]:
        if s["flat_out"]:
            return "Flat out: the time here comes from the exit of the corner before, not from grip."
        return f"No grip pattern separates the quick passes from the slow ones here (r {s['r']:+.2f})." + harder_slower
    return _spot_words(s["spots"][0], f" {brake_unit}" if brake_unit else "", harder_slower)


def _spot_words(sp: dict, unit: str, harder_slower: str) -> str:
    where = f"{sp['start_m']} to {sp['end_m']} m"
    ph = sp["phase"]
    dv = (sp["speed_fast"] or 0) - (sp["speed_slow"] or 0)
    faster = f" and are {dv:.0f} km/h faster" if dv >= 1 else ""
    dax = (sp["ax_fast"] or 0) - (sp["ax_slow"] or 0)
    day = (sp["ay_fast"] or 0) - (sp["ay_slow"] or 0)
    lateral = (f"pull {_f(sp['ay_fast'], 2)} g sideways against {_f(sp['ay_slow'], 2)} g, at {_f(sp['speed_fast'])} "
               f"km/h against {_f(sp['speed_slow'])} ({where})")
    if ph == "braking":
        if (sp["brake_fast"] or 0) < (sp["brake_slow"] or 0) and dv > 0:
            return (f"Brake less and carry speed. The quicker passes brake to {_f(sp['brake_fast'])}{unit} against "
                    f"{_f(sp['brake_slow'])} and keep {dv:.0f} km/h more ({where})." + harder_slower)
        return (f"Brake harder at the start of the braking zone. The quicker passes reach {_f(sp['brake_fast'])}{unit} "
                f"against {_f(sp['brake_slow'])} and slow at {abs(sp['ax_fast'] or 0):.2f} g against "
                f"{abs(sp['ax_slow'] or 0):.2f} g ({where}).")
    if ph == "trail":
        return (f"Turn in while still braking. The quicker passes already pull {_f(sp['ay_fast'], 2)} g sideways "
                f"against {_f(sp['ay_slow'], 2)} g on the brakes ({where})." + harder_slower)
    if ph == "mid":
        return f"Carry more speed mid-corner. The quicker passes {lateral}." + harder_slower
    if (sp["throttle_fast"] or 0) - (sp["throttle_slow"] or 0) >= 5:
        text = (f"Back on the throttle earlier. The quicker passes are at {_f(sp['throttle_fast'])} % throttle "
                f"against {_f(sp['throttle_slow'])} %{faster} ({where}).")
    elif dax > day:
        text = (f"Drive out harder. The quicker passes accelerate at {_f(sp['ax_fast'], 2)} g against "
                f"{_f(sp['ax_slow'], 2)} g{faster} ({where}).")
    else:
        text = f"Hold more cornering on the exit. The quicker passes {lateral}."
    return text + harder_slower


def tc_words(z: dict) -> tuple[str, str]:
    """The zone's finding and what to do about it."""
    share = round(100 * (z["quick_share"] or 0))
    v = z["verdict"]
    if v == "unknown":
        return (f"TC cuts in on {share} % of quick laps; too few laps to tell what it costs.", "")
    if v == "pushing":
        return (f"TC cuts in on {share} % of quick laps. Passes with TC are as quick or quicker through here: it "
                "is trimming wheelspin while you push.", "No change needed.")
    if v == "none":
        return (f"TC cuts in on {share} % of quick laps, with no measurable effect on speed or time.",
                "No change needed.")
    slip = f", with {z['slip_pct']:.0f} % wheelspin when it starts" if z["slip_pct"] is not None else ""
    loss = f"Each second of TC leaves you {abs(z['speed_per_tc_s']):.1f} km/h down {TC_FAR_M} m later"
    if v == "minor":
        return (f"TC cuts in on {share} % of quick laps for {z['tc_s']:.1f} s{slip}. {loss}, but no lap-time cost "
                "shows before the next braking point.",
                "Let the car run out a little earlier so it is straighter when the throttle is fully open.")
    note = (f"TC cuts in on {share} % of quick laps for {z['tc_s']:.1f} s{slip}. {loss} and "
            f"{1000 * z['time_per_tc_s']:.0f} ms slower to the next braking point: about {z['time_cost_s']:.2f} s "
            "each time.")
    if z["kerb_g"] is not None and z["kerb_g"] >= KERB_G:
        return (note + f" It starts with a {z['kerb_g']:.2f} g vertical spike: the kerb sets it off.",
                "Keep the wheels off the kerb on this exit, or be straight and settled before the car crosses it.")
    advice = []
    st, sn, u = z["steer_tc"], z["steer_no_tc"], z["steer_unit"]
    if st is not None and sn is not None and st - sn >= 2:
        note += (f" Passes with TC go to full throttle with {st:.0f}{u} of steering still on, against {sn:.0f}{u} "
                 "without TC.")
        advice.append(f"unwind about {st - sn:.0f}{u} more steering before going to full throttle")
    pt, pn = z["pedal_s_tc"], z["pedal_s_no_tc"]
    if pt is not None and pn is not None and pn - pt >= 0.05:
        note += f" They also open the throttle quicker: {pt:.2f} s from closed to open, against {pn:.2f} s."
        advice.append(f"open the throttle a touch slower (about {pn:.2f} s from closed to fully open, not {pt:.2f} s)")
    if not advice:
        advice.append("be straighter and smoother on the throttle on this exit so TC has less to catch")
    text = " and ".join(advice)
    return note, text[0].upper() + text[1:] + "."


def headlines(r: dict) -> list[dict]:
    """The few numbers to read first, each with what to do about it."""
    out = []
    g = r["grip"]
    vt = g["vs_time"]
    if vt is not None:
        thirds = g["phases"]
        gains = sorted(((thirds["fast"][p]["grip_use"] or 0) - (thirds["slow"][p]["grip_use"] or 0), p)
                       for _, p in GRIP_PHASES)
        words = {"braking": "in a straight line on the brakes", "trail": "turning in while still braking",
                 "mid": "mid-corner", "exit": "on the exits"}
        top = [p for d, p in sorted(gains, reverse=True)[:2] if d > 0.5]
        detail = (f"Over {vt['n']} clean laps, the laps that use more of the car's grip are the quicker ones"
                  + (f": each 1 % more grip use is worth about {abs(g['s_per_pct']):.2f} s a lap on the quick laps."
                     if g["s_per_pct"] is not None and g["s_per_pct"] < 0 else "."))
        action = ("Use more of the grip " + " and ".join(words[p] for p in top) + ": that is where the quickest laps "
                  "use more than the slowest ("
                  + "; ".join(f"{thirds['fast'][p]['grip_use']:.0f} % against {thirds['slow'][p]['grip_use']:.0f} %"
                              for p in top) + ").") if top else "Grip use is even across the corner phases."
        out.append({"key": "grip_vs_time", "label": "Lap time follows grip use", "value": f"r {vt['r']:+.2f}",
                    "detail": detail, "action": action})
    worth = [s for s in r["sections"] if (s["worth_s"] or 0) >= 0.005]
    if worth:
        total = sum(s["worth_s"] for s in worth)
        top = sorted(worth, key=lambda s: -s["worth_s"])[:2]
        out.append({"key": "grip_left", "label": "Time left in grip use", "value": f"≈ {total:.2f} s",
                    "detail": "If a typical quick lap used the grip like the quickest third of laps in every corner. "
                              f"Most of it in {' and '.join(s['code'] for s in top)}.",
                    "action": f"{top[0]['code']}: {top[0]['note']}"})
    tc = r["tc"]
    if tc.get("available"):
        cost = sorted((z for z in tc["zones"] if z["verdict"] == "cost"), key=lambda z: -z["time_cost_s"])
        if cost:
            z = cost[0]
            out.append({"key": "tc_cost", "label": "Lost to traction control",
                        "value": f"≈ {tc['lost_per_lap_s']:.2f} s",
                        "detail": f"A lap, mostly at {z['where']}: TC cuts in there on "
                                  f"{round(100 * z['quick_share'])} % of quick laps and costs about "
                                  f"{z['time_cost_s']:.2f} s each time. Elsewhere TC is a sign of pushing, not a loss.",
                        "action": f"{z['where']}: {z['advice']}"})
        elif tc["zones"]:
            out.append({"key": "tc_cost", "label": "Lost to traction control", "value": "none measured",
                        "detail": "Where TC cuts in, passes with more TC are no slower than passes with less.",
                        "action": "No change needed."})
        w = tc.get("vs_rear_temp_within") or tc.get("vs_rear_temp")
        if w is not None and w["p"] is not None and w["p"] < SIGNIFICANT and w["slope"] > 0:
            out.append({"key": "tc_temp", "label": "TC and rear tyre temperature",
                        "value": f"+{w['slope']:.2f} s per °C",
                        "detail": f"Each °C hotter on the rear tyres brings {w['slope']:.2f} s more TC a lap "
                                  f"(r {w['r']:+.2f} over {w['n']} laps, lap to lap within a run).",
                        "action": "Keep the rears from overheating on long runs (pressures, how hard you drive off "
                                  "the slow corners): hotter rears spin up sooner."})
    return out
