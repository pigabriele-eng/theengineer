"""Technique check: one lap's driving mistakes against perfect driving, each with the time it costs.

Perfect driving is the theoretical lap (lapsim.py): the lap's own line taken at the limits the car has shown at every
place of the track (local_limits.py), with the model's own error at every metre taken out as the report's targets
have it (lapsim.Calibration, measured on the fastest lap). The lap is cut where the driver's actions change (the
lift, the brake point, the release, the slowest point, the throttle pick-up, full throttle, any lift on a straight)
and every piece is costed the same way: the driver's lap up to its start and perfect driving from there, against the
driver's lap up to its end and perfect driving from there. That difference is the time the piece costs, including
what it carries down the road (a slow exit costs time all the way down the next straight). The pieces add up to the
whole gap to the perfect lap.

Perfect driving takes the best the car has shown at every place, which no single lap puts together. So every piece
is also costed against the realistic target (the same lap at the grip a quick lap usually shows at each place, as in
the report): that is the time a driver can find. The difference, the perfect lap's optimism, is shown on its own.

Each piece that costs time is then named from what the driver did there against what perfect driving does (brake
point, deceleration, coasting, minimum speed, throttle pick-up and full throttle, lifts, traction control,
wheelspin, lock-ups, steering corrections). Where the pedals were already at the limit (flat out, braking with the
ABS working, driving out with the traction control working) the loss is the car's, not a mistake: the event's
quicker laps use more ABS and traction control, not less. Pieces with no clear cause, or too small to name, are the
part no single mistake explains; a lap that ends in the pit lane has that part on its own.

Corners are named only by their official numbers (or C1, C2... where the track has none).
"""
from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field

import numpy as np

from app.analysis.channels import EXIT, POWER, G
from app.analysis.lapsim import TOP_SPEED_MARGIN, Calibration, LapModel, SimLap
from app.analysis.laps import Section
from app.analysis.local_limits import PlaceLimits, on_own_line
from app.analysis.shifts import ShiftModel

MIN_COST_S = 0.02  # a piece that costs less than this (against the realistic target) is not named
CORNER_WINDOW_M = 100  # a corner's slowest point is looked for this far either side of the section's
BRAKE_EARLY_M = 5  # braking this much before perfect driving would counts as early
FULL_THROTTLE = 95.0  # % pedal
LIFT_THROTTLE = 90.0  # below this on a straight is a lift
MIN_LIFT_M = 8
LOCK_PCT = 15  # front wheels this much slower than the car under braking, with no ABS working: locking
ABS_AT_LIMIT = 0.5  # the ABS working this share of the braking: the brakes at the tyres' limit
TC_AT_LIMIT_S = 0.2  # traction control working this long on the way out: the drive at the tyres' limit
TC_AFTER_FULL_M = 60  # traction control working this soon after full throttle still belongs to the exit
PICKUP = 20.0  # % pedal: the throttle is back on
PIT_SPEED_SHARE = 0.6  # over the line slower than this share of perfect driving's speed: the lap ends in the pits
TRACE_STEP_M = 5
# the driver's inputs sent with the trace: decimals
INPUT_ROLES = {"throttle": 0, "brake": 1, "steer": 1, "gear": 0, "rpm": 0}
# perfect driving's own phases (model_phases): braking, at the grip limit (part throttle), full throttle; no coasting
MODEL_PHASES = ("braking", "grip limit", "full throttle")

PHASE_WORDS = ("braking", "entry", "mid-corner", "exit", "full throttle")


# ---------- perfect driving from any point ----------

REJOIN_TOL = 1e-7  # m/s: perfect driving from a point closer than this to the perfect lap has rejoined it


class Envelope(LapModel):
    """Perfect driving along one lap's line (the theoretical lap's own model, lapsim.LapModel), able to drive the rest
    of the lap perfectly from any metre at any speed.

    curvature and speeds are per metre of the line, 0..n (the timing line at both ends). calibration: the model's
    own error at every metre (lapsim.Calibration), added to every time and speed perfect driving is quoted at; the
    model itself (P, F, B, vc) stays as it drives."""

    def __init__(self, curvature: np.ndarray, lim: PlaceLimits, calibration: Calibration | None = None):
        super().__init__(np.asarray(curvature, float)[:-1], lim)
        n1 = self.n + 1
        self.cal = calibration if calibration is not None and len(calibration.t) == n1 else None
        self.dt = self.cal.dt if self.cal is not None else np.zeros(n1)  # s to each metre
        self.dv = self.cal.dv if self.cal is not None else np.zeros(n1)  # km/h at each metre
        # m/s: how much faster the model drives each metre than the fastest lap really did at its own limits
        self.ahead = (self.cal.own.speed - self.cal.speed) / 3.6 if self.cal is not None else np.zeros(n1)

    def sim(self) -> SimLap:
        raw = super().sim()
        return self.cal.lap(raw) if self.cal is not None else raw

    def restart(self, i0: int, v0: float) -> Restart:
        """Perfect driving from metre i0 at v0 (m/s, the driver's speed) until it rejoins the perfect lap. The model
        starts where it would be had it driven as the driver did: v0 plus what it drives that metre faster than the
        fastest lap really did at its own limits, so that the fastest lap checked against its own limits costs
        nothing anywhere."""
        fw = max(v0 + float(self.ahead[i0]), 1.0)
        run = self.run_up(i0, fw, self.n, self.F, REJOIN_TOL)
        out = np.array([min(x, b) for x, b in zip([fw, *run], self.B[i0:], strict=False)])
        return Restart(self, i0, out)


@dataclass
class Restart:
    env: Envelope
    i0: int
    speed: np.ndarray  # m/s from i0; the perfect lap's after that

    def at(self, a: int, b: int) -> np.ndarray:
        """Speeds over metres a..b (inclusive), a >= i0."""
        j = self.i0 + len(self.speed)
        if b < j:
            return self.speed[a - self.i0:b - self.i0 + 1]
        if a >= j:
            return self.env.P[a:b + 1]
        return np.concatenate([self.speed[a - self.i0:], self.env.P[j:b + 1]])

    def kmh(self, a: int, b: int) -> np.ndarray:
        """Speeds over metres a..b (inclusive) as quoted: km/h, calibrated."""
        return self.at(a, b) * 3.6 + self.env.dv[a:b + 1]

    def time(self, a: int, b: int) -> float:
        """Seconds from metre a to metre b, calibrated."""
        if b <= a:
            return 0.0
        cal = float(self.env.dt[b] - self.env.dt[a])
        j = self.i0 + len(self.speed)
        if a >= j:
            return float(self.env.cum[b] - self.env.cum[a]) + cal
        e = min(b, j)
        v = self.at(a, e)
        t = float(np.sum(2 / (v[:-1] + v[1:])))
        return t + (float(self.env.cum[b] - self.env.cum[e]) if b > e else 0.0) + cal

    def to_end(self) -> float:
        return self.time(self.i0, self.env.n)

    def brake_point(self, before: int) -> int | None:
        """The first metre where perfect driving from here is braking (held under the braking envelope)."""
        if before - self.i0 <= 1:
            return None
        v = self.at(self.i0, before)
        B = np.asarray(self.env.B[self.i0:before + 1])
        slowing = np.r_[False, np.diff(v) < -1e-6] & (v >= B - 1e-6)
        i = np.flatnonzero(slowing)
        return self.i0 + int(i[0]) - 1 if len(i) else None


# ---------- what the driver did ----------

@dataclass
class Corner:
    code: str
    section: Section
    m: int  # slowest point
    lift: int | None = None  # first metre off full throttle before the corner
    brake: int | None = None  # brake point
    release: int | None = None  # off the brake
    pickup: int | None = None  # throttle back on
    full: int | None = None  # full throttle again
    exit_end: int | None = None  # where the exit ends: full throttle, or later while traction control still works


def _first(mask: np.ndarray, offset: int = 0) -> int | None:
    i = np.flatnonzero(mask)
    return offset + int(i[0]) if len(i) else None


def _tc_end(tc_on: np.ndarray, start: int, stop: int, gap: int = 10) -> int:
    """Where traction control that works within TC_AFTER_FULL_M of start stops working (gaps under gap metres
    bridged); start when it doesn't."""
    idx = np.flatnonzero(tc_on[start:stop] > 0.5)
    if not len(idx) or idx[0] > TC_AFTER_FULL_M:
        return start
    end = int(idx[0])
    for i in idx:
        if i - end > gap:
            break
        end = int(i)
    return start + end + 1


def _last_off_run(full: np.ndarray, offset: int, bridge: int = 5) -> int | None:
    """Where the last stretch off full throttle starts (blips back to full shorter than bridge metres bridged): the
    lift for the corner, even when the driver is back at full throttle a metre before the slowest point."""
    edges = np.flatnonzero(np.diff(np.r_[0, (~full).astype(int), 0]))
    runs = list(zip(edges[::2].tolist(), edges[1::2].tolist(), strict=True))
    if not runs:
        return None
    start, end = runs[-1]
    for x, y in reversed(runs[:-1]):
        if start - y >= bridge:
            break
        start = x
    if start == 0 or end - start < 3:  # off full throttle since the corner before: no lift for this one
        return None
    return offset + start


def corner_events(tr: dict[str, np.ndarray], sections: list[Section]) -> list[Corner]:
    """For every corner of the lap (a section with a slowest point), where the driver lifted, braked, came off the
    brake, was slowest, picked up the throttle and was at full throttle again."""
    v = tr["speed"]
    n = len(v) - 1
    braking = tr["braking"] > 0.5
    thr = tr.get("throttle")
    full = thr > FULL_THROTTLE if thr is not None else np.rint(tr["phase"]).astype(int) == POWER
    on = (thr > PICKUP) if thr is not None else np.rint(tr["phase"]).astype(int) >= EXIT
    corners = [s for s in sections if s.apex is not None]
    out: list[Corner] = []
    prev = 0
    for ci, s in enumerate(corners):
        lo, hi = max(s.start, s.apex - CORNER_WINDOW_M), min(s.end, s.apex + CORNER_WINDOW_M)
        m = lo + int(np.argmin(v[lo:hi + 1]))
        c = Corner(s.code, s, m)
        a0 = min(prev, m)
        c.lift = _last_off_run(full[a0:m], a0)
        c.brake = _first(braking[(c.lift or a0):m], c.lift or a0)
        if c.brake is not None:
            br = tr["brake"] if "brake" in tr else braking.astype(float)
            pk = c.brake + int(np.argmax(br[c.brake:m + 1]))
            c.release = _first(~braking[pk:n + 1], pk)
        nxt = corners[ci + 1].apex if ci + 1 < len(corners) else n
        start = max(c.release or c.lift or m, m - 40)
        c.pickup = _first(on[start:nxt] & ~braking[start:nxt], start)
        if c.pickup is not None:
            c.full = _first(full[c.pickup:nxt], c.pickup)
        if c.full is not None:
            c.exit_end = c.full
            if "tc_on" in tr:  # traction control still cutting the power after full throttle: still the exit
                c.exit_end = _tc_end(tr["tc_on"], c.full, nxt)
        out.append(c)
        prev = c.full if c.full is not None else m + 1
    return out


def straight_lifts(tr: dict[str, np.ndarray], corners: list[Corner]) -> list[tuple[int, int]]:
    """Lifts off full throttle between one corner's full throttle and the next corner's lift: [from, to) metres."""
    thr = tr.get("throttle")
    if thr is None:
        return []
    n = len(thr) - 1
    out = []
    for i, c in enumerate(corners):
        a = c.exit_end
        if a is None:
            continue
        nxt = corners[i + 1] if i + 1 < len(corners) else None
        b = (nxt.lift or nxt.brake or nxt.m) if nxt else n
        low = (thr[a:b] < LIFT_THROTTLE).astype(int)
        edges = np.flatnonzero(np.diff(np.r_[0, low, 0]))
        for x, y in zip(edges[::2], edges[1::2], strict=True):
            if y - x >= MIN_LIFT_M:
                back = _first(thr[a + y:b] > FULL_THROTTLE, a + y)
                out.append((a + int(x), int(back) if back is not None else a + int(y)))
    return out


# ---------- the pieces of the lap and what each costs ----------

@dataclass
class Piece:
    start: int
    end: int
    role: str  # straight, lift, brake_early, braking, mid, pickup, build, lift_straight, coast_corner
    corner: Corner | None = None
    cost: float = 0.0  # against the realistic target
    cost_perfect: float = 0.0
    within: float = 0.0  # the part lost inside the piece (realistic)
    carried: float = 0.0  # the part carried beyond it
    restart: Restart | None = None  # perfect driving from the start of the piece
    restart_r: Restart | None = None
    limit: bool = False  # nothing more for the pedals to give: full throttle, or braking with the ABS working


def _points(corners: list[Corner], lifts: list[tuple[int, int]], env: Envelope, v: np.ndarray, n: int,
            pit_from: int | None = None) -> list[tuple[int, str, Corner | None]]:
    pts: list[tuple[int, str, Corner | None]] = [(0, "straight", None)]
    for c in corners:
        if c.lift is not None and c.lift < c.m - 2 and (c.brake is None or c.brake - c.lift >= 3):
            pts.append((c.lift, "lift" if c.brake is not None else "coast_corner", c))
        if c.brake is not None:
            q = env.restart(c.brake, v[c.brake] / 3.6)
            bq = q.brake_point(c.m)
            if bq is not None and bq - c.brake >= BRAKE_EARLY_M and (c.release is None or bq < c.release):
                pts.append((c.brake, "brake_early", c))
                pts.append((bq, "braking", c))
            else:
                pts.append((c.brake, "braking", c))
            if c.release is not None and c.release < c.m:
                pts.append((c.release, "mid", c))
        build = max(c.m, c.release or 0)
        if c.pickup is not None and c.pickup > c.m + 2:
            pts.append((c.m, "pickup", c))
            build = c.pickup
        if c.exit_end is None or c.exit_end > build + 2:
            pts.append((build, "build", c))
        if c.exit_end is not None:
            pts.append((max(c.exit_end, build), "straight", c))
    for a, b in lifts:
        pts.append((a, "lift_straight", None))
        pts.append((b, "straight", None))
    if pit_from is not None:  # the lap ends in the pit lane: one piece from the lift for it to the line
        pts = [p for p in pts if p[0] < pit_from] + [(pit_from, "pit", None)]
    pts.sort(key=lambda p: p[0])  # stable: at one metre the later step of a corner wins (an empty step did not happen)
    out: list[tuple[int, str, Corner | None]] = []
    for p in pts:
        if not 0 <= p[0] < n:
            continue
        if out and p[0] == out[-1][0]:
            out[-1] = p
        elif not out or p[0] > out[-1][0]:
            out.append(p)
    return out


def cost_pieces(tr: dict[str, np.ndarray], corners: list[Corner], lifts: list[tuple[int, int]],
                env: Envelope, env_r: Envelope, pit_from: int | None = None) -> tuple[list[Piece], float, float]:
    """Every piece of the lap with its cost against perfect driving and against the realistic target. Also the
    driver's lap up to the start and perfect driving from there, against each target's lap: what the speed over
    the line (from the lap before) is worth."""
    v, t = tr["speed"], tr["t"]
    n = len(v) - 1
    pts = _points(corners, lifts, env, v, n, pit_from)
    pieces = [Piece(a, b, role, c) for (a, role, c), (b, _, _) in zip(pts, [*pts[1:], (n, "", None)], strict=True)]
    totals = []
    for e in (env, env_r):
        r = [e.restart(p.start, v[p.start] / 3.6) for p in pieces]
        total = [float(t[p.start]) + q.to_end() for p, q in zip(pieces, r, strict=True)] + [float(t[n])]
        for i, p in enumerate(pieces):
            cost = total[i + 1] - total[i]
            if e is env:
                p.cost_perfect, p.restart = cost, r[i]
            else:
                p.cost, p.restart_r = cost, r[i]
                p.within = float(t[p.end] - t[p.start]) - r[i].time(p.start, p.end)
                p.carried = cost - p.within
        totals.append(total[0])
    return pieces, totals[0], totals[1]


# ---------- naming the mistakes ----------

def _dt(tr: dict[str, np.ndarray]) -> np.ndarray:
    t = tr["t"]
    return np.diff(t, append=t[-1] + (t[-1] - t[-2]))


def _reversals(x: np.ndarray, step: float) -> int:
    """How often x changes direction by more than step: a smooth turn in and out is one."""
    if len(x) < 3 or step <= 0:
        return 0
    count, ext, up = 0, float(x[0]), None
    for val in x[1:]:
        if up is None:
            if abs(val - ext) >= step:
                up, ext = val > ext, float(val)
        elif (val > ext) == up:
            ext = float(val)
        elif abs(val - ext) >= step:
            count += 1
            up, ext = not up, float(val)
    return count


@dataclass
class Mistake:
    key: str  # what kind of mistake
    phase: str  # one of PHASE_WORDS
    title: str
    what: str  # what the driver did against what perfect driving does, with the numbers
    do: str  # what to do instead
    at: int  # the metre it is shown at
    value: float | None = None  # its size in the habit's unit, to average across laps
    unit: str = ""
    notes: list[str] = field(default_factory=list)


def _corner_limit(env: Envelope, m: int) -> float:
    lo, hi = max(m - 10, 0), min(m + 10, env.n)
    return float((env.vc[lo:hi + 1] * 3.6 + env.dv[lo:hi + 1]).min())


def _braking(tr: dict[str, np.ndarray], a: int, b: int, env: Envelope, units: dict[str, str]) -> dict:
    """The driver's braking from a to b against what the car has shown it can do at each moment (the hardest braking
    at that place while cornering as hard as the driver was): the peak, and the deceleration given away while the
    pressure built and after the peak. Also the peak pressure, how long it took to build, ABS and front lock.
    Decelerations are the accelerometer's less the slope of the road, as the car's limits are."""
    out: dict = {}
    if b - a < 3:
        return out
    dec = -(np.asarray(tr["ax"][a:b], float) - env.grade[a:b])
    ay, dt = np.abs(tr["ay"][a:b]), _dt(tr)[a:b]
    avail = np.array([env.brake_limit(a + j, float(y)) for j, y in enumerate(ay)])
    pk = int(np.argmax(dec))
    out.update(peak=float(dec[pk]), peak_avail=float(avail[pk]), peak_at=a + pk,
               mean=float((dec * dt).sum() / dt.sum()), mean_avail=float((avail * dt).sum() / dt.sum()))
    after = slice(pk, None)
    if dt[after].sum() > 0:
        out["after"] = float((dec[after] * dt[after]).sum() / dt[after].sum())
        out["after_avail"] = float((avail[after] * dt[after]).sum() / dt[after].sum())
    short = np.clip(avail - dec, 0, None) * dt
    out["ramp_loss"], out["ease_loss"] = float(short[:pk].sum()), float(short[pk:].sum())
    if "brake" in tr:
        br = tr["brake"][a:b]
        out["pressure"] = float(br.max())
        out["pressure_unit"] = units.get("brake", "")
        reach = _first(br >= 0.9 * br.max())
        out["build_s"] = float(dt[:reach].sum()) if reach is not None else None
    if "abs_on" in tr:
        out["abs_share"] = float((dt * (tr["abs_on"][a:b] > 0.5)).sum() / dt.sum())
    if "front_lock" in tr:
        out["front_lock"] = float(-np.percentile(tr["front_lock"][a:b], 5))
    return out


def _pressure(nb: dict) -> str:
    return f", peak pressure {nb['pressure']:.0f} {nb['pressure_unit']}".rstrip() if "pressure" in nb else ""


def name_piece(p: Piece, tr: dict[str, np.ndarray], env: Envelope, env_r: Envelope, units: dict[str, str],
               section_of: Callable[[int], str]) -> Mistake | None:
    """What the driver did wrong in this piece, in plain words, or None when nothing stands out."""
    v = tr["speed"]
    dt = _dt(tr)
    a, b = p.start, p.end
    c = p.corner
    code = c.code if c else section_of((a + b) // 2)
    q = p.restart  # perfect driving from the start of the piece
    thr = tr.get("throttle")

    if p.role == "brake_early":
        d = b - a
        nb = _braking(tr, a, c.release or c.m, env_r, units)
        soft = "peak" in nb and nb["peak"] < 0.9 * nb["peak_avail"]
        what = (f"You braked at {a} m at {v[a]:.0f} km/h. From that speed perfect driving stays on the throttle to "
                f"{b} m, then brakes at the car's limit.")
        if soft:
            what += f" Your braking peaked at {nb['peak']:.2f} g; the car can stop at {nb['peak_avail']:.2f} g there."
        do = f"Brake {d} m later, at about {b} m" + (", and harder from the first moment." if soft else ".")
        return Mistake("brake_early", "braking", f"Braked {d} m early", what, do, a, float(d), "m")

    if p.role == "lift":
        d = b - a
        coast = float((dt[a:b] * (tr["coasting"][a:b] > 0.5)).sum()) if "coasting" in tr else None
        what = (f"You came off full throttle at {a} m and only braked at {b} m"
                + (f": {coast:.2f} s with neither pedal" if coast else "") +
                ". Perfect driving stays flat until it brakes.")
        return Mistake("lift_before_brake", "braking", f"Lifted {d} m before braking", what,
                       "Go straight from full throttle to the brake.", a, float(d), "m")

    if p.role == "braking":
        nb = _braking(tr, a, b, env_r, units)
        end_v = v[b]
        perfect_v = float(q.kmh(b, b)[0])
        real_v = float(p.restart_r.kmh(b, b)[0])
        over = real_v - end_v
        limit_r = _corner_limit(env_r, c.m)
        limit_p = _corner_limit(env, c.m)
        if p.carried >= 0.5 * p.cost and over >= 2.0 and c.release is not None:
            what = (f"You came off the brake at {b} m at {end_v:.0f} km/h; perfect driving still carries "
                    f"{perfect_v:.0f} km/h there ({real_v:.0f} km/h at the realistic target). Your slowest point was "
                    f"{v[c.m]:.0f} km/h; the grip allows {limit_p:.0f} km/h ({limit_r:.0f} km/h at the realistic "
                    "target).")
            return Mistake("over_slowed", "entry", "Slowed the car too much on the brakes", what,
                           f"Brake less into {code}: let the brake go at about {real_v:.0f} km/h and carry the "
                           "speed to the slowest point.", b, over, "km/h")
        if not nb:
            return None
        if nb.get("abs_share", 0) >= ABS_AT_LIMIT:
            p.limit = True  # the ABS working: the brakes at the tyres' limit, nothing more for the foot to give
            return None
        if nb.get("front_lock", 0) >= LOCK_PCT:
            what = (f"Braking from {a} to {b} m the front wheels ran up to {nb['front_lock']:.0f}% slower than the "
                    f"car{_pressure(nb)}. Locked wheels stop the car less well; perfect driving brakes at the limit "
                    "with the wheels turning.")
            return Mistake("lockup", "braking", "Locked the front wheels", what,
                           "Ease the pressure off as the speed falls, so the fronts keep turning.", a,
                           nb["front_lock"], "%")
        if nb["peak"] < 0.9 * nb["peak_avail"]:
            what = (f"Your braking peaked at {nb['peak']:.2f} g at {nb['peak_at']} m{_pressure(nb)}; the car can stop "
                    f"at {nb['peak_avail']:.2f} g there, and perfect driving uses all of it.")
            return Mistake("soft_braking", "braking", "Braked below the car's limit", what,
                           "Brake harder at the start, then ease off as you turn in.", a,
                           nb["peak_avail"] - nb["peak"], "g")
        if nb["ramp_loss"] > nb["ease_loss"] and (nb.get("build_s") or 0) >= 0.25:
            what = (f"The brake pressure took {nb['build_s']:.2f} s to build{_pressure(nb)}; perfect driving is at "
                    "full deceleration at once.")
            return Mistake("slow_brake_build", "braking", "Slow onto the brake", what,
                           "Hit the brake firmly from the first moment.", a, nb["build_s"], "s")
        if "after" in nb and nb["after"] < 0.9 * nb["after_avail"]:
            what = (f"After the peak ({nb['peak']:.2f} g at {nb['peak_at']} m) the car slowed at {nb['after']:.2f} g "
                    f"on average to {b} m, where it could slow at {nb['after_avail']:.2f} g. Perfect driving keeps "
                    "braking at the limit, easing off only as the turn takes the grip.")
            return Mistake("early_ease", "entry", "Eased off the brake too soon", what,
                           "Hold the pressure longer; ease off only as you turn in.", nb["peak_at"],
                           nb["after_avail"] - nb["after"], "g")
        return None

    if p.role in ("mid", "coast_corner"):
        coast = float((dt[a:b] * (tr["coasting"][a:b] > 0.5)).sum()) if "coasting" in tr else 0.0
        vm = float(v[c.m])
        limit_r, limit_p = _corner_limit(env_r, c.m), _corner_limit(env, c.m)
        if p.role == "coast_corner":
            low = float(thr[a:c.m + 1].min()) if thr is not None else None
            what = (f"You lifted from {a} m" + (f" down to {low:.0f}% throttle" if low is not None else "") +
                    f"; slowest {vm:.0f} km/h at {c.m} m, where the grip allows {limit_p:.0f} km/h "
                    f"({limit_r:.0f} km/h at the realistic target).")
            return Mistake("lift_corner", "mid-corner", f"Lifted more than needed through {code}", what,
                           f"Lift less: carry about {limit_r:.0f} km/h through {code}.", a, limit_r - vm, "km/h")
        if coast >= 0.12:
            what = (f"From {a} m, off the brake, to the slowest point at {c.m} m you coasted {coast:.2f} s with "
                    f"neither pedal; slowest {vm:.0f} km/h, where the grip allows {limit_p:.0f} km/h "
                    f"({limit_r:.0f} km/h at the realistic target). Perfect driving keeps the car at its limit: "
                    "braking into the turn, then straight to the throttle.")
            return Mistake("coasting", "mid-corner", f"Coasted {coast:.1f} s into the corner", what,
                           "Trail the brake further into the turn and go from brake to throttle with no gap.",
                           a, coast, "s")
        if limit_r - vm >= 1.5:
            what = (f"Slowest {vm:.0f} km/h at {c.m} m; the grip allows {limit_p:.0f} km/h there "
                    f"({limit_r:.0f} km/h at the realistic target).")
            return Mistake("min_speed", "mid-corner", "Too slow at the slowest point", what,
                           f"Carry about {limit_r:.0f} km/h through the slowest point of {code}.", c.m,
                           limit_r - vm, "km/h")
        return _steering(tr, a, b, "mid-corner", code)

    if p.role == "pickup":
        d = b - a
        what = (f"The throttle came back on at {b} m, {d} m after the slowest point ({a} m, {v[a]:.0f} km/h). "
                "Perfect driving is accelerating from the slowest point.")
        coast = float((dt[a:b] * (tr["coasting"][a:b] > 0.5)).sum()) if "coasting" in tr else 0.0
        if coast >= 0.1:
            what += f" {coast:.2f} s of it with neither pedal."
        return Mistake("late_throttle", "exit", f"Throttle {d} m late", what,
                       f"Pick up the throttle at the slowest point, at about {a} m.", b, float(d), "m")

    if p.role == "build":
        if c is None:
            return None
        qm = p.restart_r if p.restart_r.i0 == c.m else env_r.restart(c.m, v[c.m] / 3.6)
        span = qm.at(c.m, min(c.m + 600, env.n))
        fq = next((c.m + j for j, x in enumerate(span) if env_r.power_limited(float(x), c.m + j)), None)
        tc = float((dt[a:b] * (tr["tc_on"][a:b] > 0.5)).sum()) if "tc_on" in tr else 0.0
        slip = float(np.percentile(tr["rear_slip"][a:b], 90)) if "rear_slip" in tr and b - a >= 5 else 0.0
        lifts = 0
        if thr is not None and b > a + 2:
            seg = thr[a:b]
            dip = (np.maximum.accumulate(seg) - seg) > 15
            lifts = int(np.count_nonzero(np.diff(dip.astype(int)) == 1))
        full_at = c.full
        where = (f"Full throttle at {full_at} m, {full_at - c.m} m after the slowest point ({c.m} m)"
                 if full_at is not None else "No full throttle before the next corner")
        could = f"; the car could take full throttle from {fq} m" if fq is not None else ""
        base = f"{where}{could}."
        traction = (f" Traction control worked {tc:.2f} s" + (f", rear wheels slipping up to {slip:.0f}%" if slip >= 5
                                                              else "") + ".") if tc >= 0.1 else ""
        if lifts >= 1:
            what = f"{base} You lifted {lifts} time{'s' if lifts > 1 else ''} on the way to full throttle.{traction}"
            return Mistake("exit_lift", "exit", "Lifted on the way out", what,
                           "One smooth push to full throttle, no lifting back.", a, float(lifts), "")
        if tc >= TC_AT_LIMIT_S:
            p.limit = True  # traction control trimming the drive: the car at its traction limit, not the foot
            return None
        if full_at is not None and fq is not None and full_at - fq >= 10:
            what = f"{base} Perfect driving builds the throttle at the limit of grip all the way.{traction}"
            return Mistake("slow_throttle", "exit", f"Full throttle {full_at - fq} m late", what,
                           f"Build the throttle faster: full throttle by about {fq} m.", a,
                           float(full_at - fq), "m")
        st = _steering(tr, a, b, "exit", code)
        if st is None and full_at is not None and (fq is None or full_at <= fq + 10):
            p.limit = True  # full throttle as early as perfect driving: the rest is the car
        return st

    if p.role == "lift_straight":
        low = float(thr[a:b].min()) if thr is not None else None
        braked = bool((tr["braking"][a:b] > 0.5).any())
        qs = p.restart_r.at(a, b)
        flat = np.mean([env_r.power_limited(float(x), i) for i, x in zip(range(a, b), qs[:-1], strict=True)]) >= 0.8
        what = (f"{'You touched the brake' if braked else 'You lifted'} from {a} to {b} m"
                + (f", down to {low:.0f}% throttle" if low is not None and not braked else "")
                + f", and were at {v[b]:.0f} km/h at {b} m. ")
        quoted = p.restart_r.kmh(a, b)
        q_end = float(quoted[-1])
        if flat:
            what += f"Perfect driving is flat out here, at {q_end:.0f} km/h by {b} m."
            do = f"Stay flat through {code}."
        elif qs.min() < qs[0] - 0.3:
            what += f"Perfect driving slows only to {float(quoted.min()):.0f} km/h here."
            do = f"Lift less in {code}: carry {float(quoted.min()):.0f} km/h."
        else:
            what += f"Perfect driving keeps accelerating here at the limit of grip, to {q_end:.0f} km/h by {b} m."
            do = f"Keep accelerating through {code}: squeeze the throttle rather than lift."
        return Mistake("lift", "full throttle", f"{'Braked' if braked else 'Lifted'} in {code}", what, do,
                       a, float(b - a), "m")
    return None


def _flat(tr: dict[str, np.ndarray], p: Piece) -> bool:
    """Full throttle (or the traction control trimming it) nearly all the way through the piece."""
    if "throttle" not in tr or p.end <= p.start:
        return False
    return float(np.mean(tr["throttle"][p.start:p.end] > FULL_THROTTLE)) >= 0.9


def _steering(tr: dict[str, np.ndarray], a: int, b: int, phase: str, code: str) -> Mistake | None:
    if "steer" not in tr or b - a < 10:
        return None
    st = tr["steer"][a:b]
    turn = float(np.abs(st).max())
    n = _reversals(st, 0.08 * turn) if turn > 0 else 0
    if n < 2:
        return None
    what = f"You corrected the steering {n} times between {a} and {b} m; perfect driving is one smooth input."
    return Mistake("steering", phase, "Steering corrections", what,
                   "Turn in once and hold the steering; let the throttle place the car.", a, float(n), "")


# ---------- the obvious mistakes ----------

EXIT_LIFT_PTS = 20.0  # % pedal: the throttle falls this far below the most it reached on the way out: a lift
EXIT_LIFT_HOLD_S = 0.15  # ...and stays 10 points or more below it this long (a jolt of the foot on a kerb is not)
EXIT_REACH_M = 150  # the exit runs this far past full throttle, at most (and never into the next corner's lift)
MIN_LIFT_FROM = 40.0  # % pedal: a lift is from at least this much throttle
EXIT_PAST_APEX_M = 10  # a lift from full throttle this far past the slowest point is on the way out, cornering or not
STEP_RATE = 300.0  # %/s over STEP_WINDOW_S: the throttle stepped on rather than squeezed
STEP_WINDOW_S = 0.2
STEP_FORCES_S = 1.5  # a lift or steering correction this soon after a step was forced by it
STRAIGHT_AY = 0.3  # g: braking with less cornering than this is braking in a straight line
SOFT_SHARE = 0.88  # straight-line deceleration (its 80th percentile) under this share of what the car shows there
MIN_STRAIGHT_BRAKE_S = 0.3
MIN_SCRUB_KMH = 20.0  # braking that takes off less than this is a dab, not a stop
ABS_ANY = 0.2  # the ABS working this share of the straight-line braking: the brakes are at the limit already
LIFT_BEFORE_S = 0.3  # a lift is costed against the acceleration the car had this long before it
MAX_LIFT_LOSS = 15 / 3.6  # m/s: a lift costs at most this much speed (a pre-lift jolt is no acceleration to keep)
APEX_DIP_KMH = 5.0  # in a run of corners, a dip this deep is another corner
LAST_CORNER_M = 30  # ...and the way out starts no sooner than this before the last one's official position
NEXT_TURN_M = 30  # a lift is for the next corner when the car turns the other way over this far after it (by
NEXT_TURN_G = 0.5  # this much, in g) or loads up the same way (by NEXT_TURN_RISE, to twice NEXT_TURN_G)
NEXT_TURN_RISE = 0.3
EXIT_AY_SHARE = 0.8  # a lift with the car still cornering this hard (of the most it did from the slowest point) is
# on and off the throttle through the corner, not a lift on the way out
SHIFT_MARGIN_RPM = 150  # an upshift this far off the ideal revs is early or late
LIMITER_RPM = 80  # revs within this of the limiter: on it
LIMITER_HELD_M = 10  # metres on the limiter before an upshift: late, wherever the ideal revs are
STALL_SMOOTH_S = 0.15  # the acceleration out of a corner, averaged over this long
STALL_BEFORE_S = 0.3  # ...against what it was this long before
STALL_MIN_ACC = 1.0  # m/s²: the speed was climbing at least this fast
STALL_SHARE = 0.25  # the acceleration falling below this share of it: the speed stalls (or drops)
STALL_BACK = 0.5  # ...until it is back above this share
STALL_MIN_S = 0.2  # for this long or longer
STALL_SHIFT_S = 0.4  # a stall no longer than this around a gear change is the gear change
DRIVING_MS2 = 0.5  # m/s²: accelerating at least this before a lift, the car was driving out of the corner
DIP_MAX_M = 200  # a lift the throttle never comes back from is counted this far at most
MIN_OBVIOUS_S = 0.01  # an obvious mistake that costs less than this is the car at its limit (or noise)


def span_cost(e: Envelope, tr: dict[str, np.ndarray], a: int, b: int) -> float:
    """What the driver's lap from metre a to metre b costs against e's driving: the driver's lap up to a and e's
    from there, against the driver's lap up to b and e's from there (as cost_pieces costs every piece)."""
    v, t = tr["speed"], tr["t"]
    ra, rb = e.restart(a, v[a] / 3.6), e.restart(b, v[b] / 3.6)
    return float(t[b] + rb.to_end() - t[a] - ra.to_end())


def lift_cost(tr: dict[str, np.ndarray], j: int, end: int, stop: int, most: np.ndarray | None = None) -> float:
    """What a lift from metre j to end costs: the car keeps the acceleration it had just before the lift (LIFT_BEFORE_S)
    through it instead, or where it was not accelerating then (balanced in a corner), the acceleration it had just
    after, once back on the throttle; and what it would have had
    more at the end is carried on until stop, the next corner's lift or brake point (_carried). Never above most (m/s
    at each metre: the speed the car's best cornering allows there), nor below the lap's own."""
    v, t = np.asarray(tr["speed"], float) / 3.6, np.asarray(tr["t"], float)
    most = np.full_like(v, np.inf) if most is None else np.maximum(np.asarray(most, float), v)
    j0 = max(int(np.searchsorted(t, t[j] - LIFT_BEFORE_S)), 0)
    k1 = min(int(np.searchsorted(t, t[end] + LIFT_BEFORE_S)), len(v) - 1)
    before = float(v[j] - v[j0]) / max(float(t[j] - t[j0]), 1e-3) if j > j0 else 0.0
    after = float(v[k1] - v[end]) / max(float(t[k1] - t[end]), 1e-3) if k1 > end else 0.0
    acc = max(before if before >= DRIVING_MS2 else after, 0.0)
    x = np.arange(end - j + 1, dtype=float)
    held = np.minimum(np.sqrt(v[j] ** 2 + 2 * acc * x), np.minimum(v[j:end + 1] + MAX_LIFT_LOSS, most[j:end + 1]))
    held = np.maximum(held, v[j:end + 1])
    return float(np.sum(1 / v[j:end] - 1 / held[:-1])) + _carried(v, end, float(held[-1]), stop, most)


def _carried(v: np.ndarray, end: int, start: float, stop: int, most: np.ndarray) -> float:
    """What the lap loses from metre end to stop (m/s at each metre in v) for not being at start there: the car at
    start drives on with the acceleration the lap itself had at each speed on the way (its gears, its drag), so the
    speed it has more shrinks as the lap's own acceleration falls with speed. Never above most."""
    if start <= v[end] or stop <= end:
        return 0.0
    seg = v[end:stop + 1]
    acc = (seg[1:] ** 2 - seg[:-1] ** 2) / 2  # m/s² at each metre (per metre of road)
    order = np.argsort(seg[:-1])
    at_v, acc_v = seg[:-1][order], acc[order]
    held, lost = start, 0.0
    for k in range(len(seg) - 1):
        held = min(max(held, seg[k]), most[end + k])
        lost += 1 / seg[k] - 1 / held
        held = np.sqrt(max(held ** 2 + 2 * float(np.interp(held, at_v, acc_v)), 0.0))
    return float(lost)


def gain_cost(tr: dict[str, np.ndarray], j: int, end: int, extra: np.ndarray, stop: int,
              most: np.ndarray | None = None) -> float:
    """What the lap lost from metre j to end for want of extra acceleration (m/s² at each metre of it): the car
    driven with it from j, then what it would have had more at end carried down the straight (as lift_cost)."""
    v = np.asarray(tr["speed"], float) / 3.6
    most = np.full_like(v, np.inf) if most is None else np.maximum(np.asarray(most, float), v)
    held = v[j:end + 1].copy()
    for k in range(1, len(held)):
        up = held[k - 1] ** 2 + v[j + k] ** 2 - v[j + k - 1] ** 2 + 2 * max(float(extra[k - 1]), 0.0)
        held[k] = min(max(np.sqrt(max(up, 0.0)), v[j + k]), most[j + k])
    return float(np.sum(1 / v[j:end] - 1 / held[:-1])) + _carried(v, end, float(held[-1]), stop, most)


def shift_mistakes(tr: dict[str, np.ndarray], model: ShiftModel, a: int, stop: int) -> list[dict]:
    """The upshifts from metre a to stop (the way out of a corner, to the next one's lift or brake point) made early
    (before the revs where the next gear drives harder, by SHIFT_MARGIN_RPM or more) or late (past them, or held on
    the rev limiter), each with the stretch it cost drive over and the acceleration missing there."""
    need = ("gear", "rpm", "throttle")
    if any(k not in tr for k in need) or stop - a < 5:
        return []
    g = np.rint(np.asarray(tr["gear"], float)).astype(int)
    rpm, v, thr = (np.asarray(tr[k], float) for k in ("rpm", "speed", "throttle"))
    nm = np.asarray(tr["engine_torque"], float) if "engine_torque" in tr else None
    out = []
    for k in a + np.flatnonzero(np.diff(g[a:stop]) > 0):
        k = int(k)
        gear, into = int(g[k]), int(g[k + 1])
        if gear not in model.ideal or model.next_gear(gear) != into or thr[max(k - 10, a):k + 1].mean() < 95:
            continue
        ideal = model.ideal[gear]
        at = float(rpm[max(k - 10, a):k + 1].max())
        v_ideal = ideal / model.ratio[gear]
        on_limit = int(np.sum(rpm[max(k - 60, a):k + 1] >= model.limit - LIMITER_RPM))
        if at < ideal - SHIFT_MARGIN_RPM:
            e = k + 1
            while e < stop and v[e] < v_ideal and thr[e] >= 90 and g[e] == into:
                e += 1
            extra = model.per_force * np.clip(model.force(gear, v[k:e]) - model.force(into, v[k:e]), 0, None)
            out.append({"kind": "early_shift", "j": k, "end": e, "extra": extra, "rpm": at, "ideal": ideal,
                        "kmh": float(v[k]), "ideal_kmh": float(v_ideal)})
        elif at > ideal + SHIFT_MARGIN_RPM or on_limit >= LIMITER_HELD_M:
            j = k
            while j > a and g[j - 1] == gear and v[j - 1] >= v_ideal and thr[j - 1] >= 90:
                j -= 1
            if k - j < 3:
                continue
            had = (np.clip(nm[j:k], 0, None) * model.ratio[gear] if nm is not None
                   else model.force(gear, v[j:k]))
            extra = model.per_force * np.clip(model.force(into, v[j:k]) - had, 0, None)
            out.append({"kind": "late_shift", "j": j, "end": k, "extra": extra, "rpm": at, "ideal": ideal,
                        "kmh": float(v[k]), "ideal_kmh": float(v_ideal), "limiter_m": on_limit})
    return out


IDEAL_SHIFT_SLOWS_M = 5  # the lap slows for the next corner where its speed is lower this many metres on
IDEAL_SHIFT_DECEL_M = 40  # its braking there, read over this many metres
IDEAL_SHIFT_SMOOTH_M = 15  # m, the lap's own acceleration on the way averaged over this (one metre's is noise)


def with_ideal_shifts(tr: dict[str, np.ndarray], model: ShiftModel | None,
                      sections: list[Section]) -> np.ndarray | None:
    """The lap's speed (km/h, every metre) had every upshift on the way out of a corner been made at the ideal revs
    (shift_mistakes): the drive the wrong gear lost added back where it was lost, and the speed it gained carried on
    with the lap's own acceleration at each speed (its gears, its drag) until the lap slows for the next corner,
    which the car then brakes for as hard as the lap did there, so the speed runs back into the lap's own. None where
    the logs can't tell the shift points or every upshift was right. Never slower than the lap anywhere."""
    if model is None or any(k not in tr for k in ("gear", "rpm", "throttle")):
        return None
    driven = np.asarray(tr["speed"], float)
    n = len(driven) - 1
    ms = driven / 3.6
    fixed = driven.copy()
    apexes = sorted({int(s.apex) for s in sections if s.apex is not None and 0 <= s.apex < n})
    for a, b in zip(apexes, [*apexes[1:], n], strict=True):
        for sh in shift_mistakes(tr, model, a, b):
            j, e, extra = sh["j"], min(sh["end"], n), sh["extra"]
            held = fixed[j] / 3.6
            for k in range(j + 1, e + 1):
                up = held * held + ms[k] ** 2 - ms[k - 1] ** 2 + 2 * max(float(extra[k - 1 - j]), 0.0)
                held = max(up, 0.0) ** 0.5
                fixed[k] = max(fixed[k], held * 3.6)
            # where the lap slows for the next corner
            stop = next((k for k in range(e, n - IDEAL_SHIFT_SLOWS_M)
                         if driven[k + IDEAL_SHIFT_SLOWS_M] < driven[k] - 0.5), n)
            seg = ms[e:stop + 1]
            if len(seg) >= IDEAL_SHIFT_SMOOTH_M:
                acc = np.convolve((seg[1:] ** 2 - seg[:-1] ** 2) / 2, np.ones(IDEAL_SHIFT_SMOOTH_M)
                                  / IDEAL_SHIFT_SMOOTH_M, "same")
                order = np.argsort(seg[:-1])
                at_v, acc_v = seg[:-1][order], acc[order]
                v, i = max(held, ms[e]), e
                while i < stop:
                    # the lap's own step there, less what the car pulls less at the higher speed: the speed it
                    # has more only shrinks
                    less = float(np.interp(ms[i], at_v, acc_v) - np.interp(v, at_v, acc_v))
                    up = (max(v * v + ms[i + 1] ** 2 - ms[i] ** 2 - 2 * max(less, 0.0), 0.0)) ** 0.5
                    v, i = min(up, ms[i + 1] + v - ms[i]), i + 1
                    if v <= ms[i]:
                        break
                    fixed[i] = max(fixed[i], v * 3.6)
            # braking for it as hard as the lap did, back into the lap's own speed where it slows
            after = ms[stop:min(stop + IDEAL_SHIFT_DECEL_M, n) + 1]
            dec = float(np.max((after[:-1] ** 2 - after[1:] ** 2) / 2)) if len(after) > 1 else 0.0
            for k in range(stop, j, -1):
                cap = (ms[stop] ** 2 + 2 * max(dec, 0.0) * (stop - k)) ** 0.5 * 3.6
                if cap >= fixed[k]:
                    break
                fixed[k] = max(cap, driven[k])
    return fixed if np.any(fixed > driven + 1e-6) else None


def ideal_shift_saving(tr: dict[str, np.ndarray], fixed: np.ndarray | None) -> np.ndarray:
    """Seconds saved up to each metre of the lap driven at fixed's speed (with_ideal_shifts) instead of its own."""
    v = np.maximum(np.asarray(tr["speed"], float), 1.0) / 3.6
    if fixed is None:
        return np.zeros(len(v))
    f = np.maximum(np.asarray(fixed, float), 1.0) / 3.6
    return np.concatenate([[0.0], np.cumsum(2 / (v[:-1] + v[1:]) - 2 / (f[:-1] + f[1:]))])


def brake_cost(va: float, vb: float, got: float, can: float) -> float:
    """What braking from va to vb (m/s) at got instead of can (g) costs: braking at can starts later, and the car
    holds va to there."""
    if got <= 0 or can <= got:
        return 0.0
    g = 9.81
    longer = (va ** 2 - vb ** 2) / 2 / g * (1 / got - 1 / can)
    return float((va - vb) / g * (1 / got - 1 / can) - longer / va)


def _last_apex(v: np.ndarray, a: int, b: int) -> int:
    """The last slowest point from a to b: after a, every dip of APEX_DIP_KMH or more is a corner of its own."""
    apex, peak, dip = a, float(v[a]), None
    for k in range(a + 1, max(b, a + 1)):
        if dip is None:
            if v[k] > peak:
                peak = float(v[k])
            elif peak - v[k] >= APEX_DIP_KMH:
                dip = k
        elif v[k] < v[dip]:
            dip = k
        elif v[k] - v[dip] >= APEX_DIP_KMH:
            apex, peak, dip = dip, float(v[k]), None
    return apex if dip is None else dip


def _dips(seg: np.ndarray, ts: np.ndarray, top: np.ndarray, ay: np.ndarray, a: int, side: float,
          apex: int) -> list[tuple[int, int, float, float]]:
    """Every lift from metre a on (seg: the throttle from there): the throttle EXIT_LIFT_PTS or more below the most
    it had reached, for EXIT_LIFT_HOLD_S or longer, and not for the next corner. Each as (start metre, metre the
    throttle is back, the throttle before, the lowest)."""
    out, i0 = [], 0
    for j in np.flatnonzero((top - seg >= EXIT_LIFT_PTS) & (top >= MIN_LIFT_FROM)):
        j = int(j)
        if j < i0 or _held_below(seg, ts, top, j) < EXIT_LIFT_HOLD_S or _into_next(ay, a + j, side):
            continue
        back = _first(seg[j:] >= top[j] - 5, j)
        end = back if back is not None else min(j + DIP_MAX_M, len(seg) - 1)
        low_k = j + int(np.argmin(seg[j:end + 1]))
        out.append((a + j, a + end, float(top[j]), float(seg[low_k])))
        i0 = end + 1
    return out


BRAKE_TRAIL_AY = 1.0  # g: the braking is judged up to the turn-in, where the cornering takes over the grip
BRAKE_UNUSED_S = 0.03  # what braking at the limit up to there finds over the best braking there: a mistake
BRAKE_EASED = 0.8  # the pedal below this share of its peak in the braking: eased off
BRAKE_REACHED = 0.9  # the braking is judged from where it first reaches this share of the grip


BRAKE_FLOOR_PCT = 10  # the best braking at a corner: this percentile of what every lap's gives away there


def relative_braking(raw: list[dict[str, dict]], obvious: list[list[dict]]) -> None:
    """Every lap's braking left unused at each corner (obvious_mistakes' braking) against the best braking there
    across the laps (BRAKE_FLOOR_PCT; a lap with none gives nothing away): where a lap gives away BRAKE_UNUSED_S more
    than that, an obvious mistake, costing the difference, added to its obvious mistakes (in place, most costly
    first)."""
    codes = {code for r in raw for code in r}
    for code in codes:
        floor = float(np.percentile([r[code]["cost_s"] if code in r else 0.0 for r in raw], BRAKE_FLOOR_PCT))
        for r, obv in zip(raw, obvious, strict=True):
            x = r.get(code)
            if x is None or x["cost_s"] - floor < BRAKE_UNUSED_S:
                continue
            obv.append({**x, "cost_s": round(x["cost_s"] - floor, 3),
                        "what": x["what"] + f" The best braking here on the other laps gives away {floor:.2f} s."})
            obv.sort(key=lambda m: -m["cost_s"])


def _braking_unused(tr: dict[str, np.ndarray], env: Envelope, a: int, b: int) -> tuple[float, int, float,
                                                                                         float | None] | None:
    """What the braking gives away from where it first reaches the limit (BRAKE_REACHED; a is the brake point) up
    to the turn-in (BRAKE_TRAIL_AY of cornering, or b, the release), against the deceleration the car has shown at
    each metre of it while cornering as it was (env.brake_limit): the same end speed from a later brake point.
    (time, end metre, the share of the grip used, the least pedal pressure as a share of its peak where it was eased
    off, or None) or None."""
    ay = np.abs(np.asarray(tr["ay"], float))
    e = next((i for i in range(a, b) if ay[i] >= BRAKE_TRAIL_AY), b)
    if e - a < 10:
        return None
    v = np.asarray(tr["speed"], float) / 3.6
    lim = np.array([env.brake_limit(i, ay[i]) for i in range(a, e + 1)])
    dec = -(np.asarray(tr["ax"][a:e + 1], float) - env.grade[a:e + 1])
    # from where the pedal first reaches the limit: how fast it gets there is the brake point's own matter
    hit = np.flatnonzero(dec >= BRAKE_REACHED * lim)
    if not len(hit) or e - (a + int(hit[0])) < 10:
        return None
    a, lim, dec = a + int(hit[0]), lim[hit[0]:], dec[hit[0]:]
    bw = v[a:e + 1].copy()
    for k in range(e - a - 1, -1, -1):
        bw[k] = max(v[a + k], (bw[k + 1] ** 2 + 2 * lim[k + 1] * G) ** 0.5)
    f = np.maximum(v[a:e + 1], np.minimum(bw, v[a]))  # never quicker than the speed it braked from
    took = float(np.sum(2 / (v[a:e] + v[a + 1:e + 1])))
    could = float(np.sum(2 / (f[:-1] + f[1:])))
    on = dec > 0.2
    share = float(dec[on].sum() / max(lim[on].sum(), 1e-9)) if on.any() else 0.0
    eased = None
    if "brake" in tr:
        p = np.asarray(tr["brake"][a:e + 1], float)
        pk = int(np.argmax(p))
        if p[pk] > 0 and pk < len(p) - 1 and float(p[pk:].min()) < BRAKE_EASED * p[pk]:
            eased = float(p[pk:].min() / p[pk] * 100)
    return took - could, e, share, eased


SLIDE_LOCK_DEG = 1.5  # steering this far the other way to the corner, on the throttle: opposite lock
SLIDE_THROTTLE = 80.0  # % throttle
SLIDE_AY = 0.5  # g of cornering still: the car is still turning, not straightening up
SLIDE_MIN_M = 4  # metres of opposite lock
SLIDE_LEAD_M = 20  # the rear steps out (and the drive goes) this far before the opposite lock goes on
SLIDE_BEFORE_M = 20  # the acceleration before the slide, over this far
SLIDE_SMOOTH_M = 9  # the acceleration is read over this many metres
SLIDE_AFTER_M = 25  # the drive the slide takes, counted this far past the opposite lock


def _acc(tr: dict[str, np.ndarray]) -> np.ndarray:
    """m/s² at every metre, read over SLIDE_SMOOTH_M."""
    v = np.asarray(tr["speed"], float) / 3.6
    t = np.asarray(tr["t"], float)
    if len(t) <= SLIDE_SMOOTH_M or not np.all(np.diff(t) > 0):
        return np.zeros(len(v))
    a = np.gradient(v, t)
    w = SLIDE_SMOOTH_M
    return np.convolve(np.pad(a, w, mode="edge"), np.ones(w) / w, mode="same")[w:-w]


def _steer_sign(tr: dict[str, np.ndarray]) -> float:
    """+1 where the log's steering turns the way its lateral g does (steering right for a right-hand corner), -1
    where the other way; 0 without a steering channel."""
    if "steer" not in tr:
        return 0.0
    st, ay = np.asarray(tr["steer"], float), np.asarray(tr["ay"], float)
    m = np.isfinite(st) & (np.abs(ay) > 0.8)
    return float(np.sign(np.sum(st[m] * ay[m]))) if m.sum() >= 20 else 0.0


def _power_slide(tr: dict[str, np.ndarray], a: int, b: int, side: float,
                 steer_sign: float) -> tuple[int, int, float] | None:
    """The first stretch from metre a to b where the driver holds opposite lock (SLIDE_LOCK_DEG or more against the
    corner) on the throttle while the car is still cornering (SLIDE_AY) for SLIDE_MIN_M or longer: the rear stepping
    out under power. (start metre, end metre, the most opposite lock in degrees) or None."""
    if side == 0 or b - a < SLIDE_MIN_M:
        return None
    st = np.asarray(tr["steer"][a:b], float) * steer_sign * side  # positive: into the corner
    thr = np.asarray(tr["throttle"][a:b], float)
    ay = np.asarray(tr["ay"][a:b], float) * side
    hit = (st <= -SLIDE_LOCK_DEG) & (thr >= SLIDE_THROTTLE) & (ay >= SLIDE_AY)
    k = 0
    while k < len(hit):
        if hit[k]:
            e = k
            while e + 1 < len(hit) and (hit[e + 1] or (st[e + 1] < 0 and thr[e + 1] >= SLIDE_THROTTLE)):
                e += 1
            if e - k + 1 >= SLIDE_MIN_M:
                return a + k, a + e, float(-st[k:e + 1].min())
            k = e + 1
        else:
            k += 1
    return None


def _stalls(tr: dict[str, np.ndarray], a: int, b: int, ay: np.ndarray,
            side: float) -> list[tuple[int, int, np.ndarray, float]]:
    """Where the speed, climbing out of a corner (from metre a to b, the next corner's lift or brake point), stops
    climbing or drops and then climbs again: the acceleration (smoothed over STALL_SMOOTH_S) below STALL_SHARE of
    what it was just before, for STALL_MIN_S or longer, with no braking and not for the next corner. A gear change
    alone is not a stall. Each as (start metre, end metre, the acceleration missing at each metre in m/s², the
    acceleration before in g)."""
    v, t = np.asarray(tr["speed"], float) / 3.6, np.asarray(tr["t"], float)
    if b - a < 20:
        return []
    acc = np.gradient(v[a:b + 1], t[a:b + 1])
    k = max(1, round(STALL_SMOOTH_S * float(np.median(v[a:b + 1]))))
    acc = np.convolve(acc, np.ones(k) / k, mode="same")
    braking = np.asarray(tr["braking"][a:b + 1], float) > 0.5 if "braking" in tr else np.zeros(b - a + 1, bool)
    gear = np.rint(np.asarray(tr["gear"][a:b + 1], float)) if "gear" in tr else None
    out, i = [], 0
    while i < len(acc):
        i0 = max(int(np.searchsorted(t[a:b + 1], t[a + i] - STALL_BEFORE_S)), 0)
        was = float(np.median(acc[i0:i])) if i - i0 >= 3 else 0.0
        if was < STALL_MIN_ACC or acc[i] >= STALL_SHARE * was or braking[i]:
            i += 1
            continue
        e = i
        while e < len(acc) - 1 and acc[e] < STALL_BACK * was and not braking[e]:
            e += 1
        back = e < len(acc) - 1 and not braking[e]
        long = t[a + e] - t[a + i] >= STALL_MIN_S
        shift = gear is not None and np.any(np.diff(gear[i:e + 1]) != 0) and t[a + e] - t[a + i] < STALL_SHIFT_S
        if back and long and not shift and not _into_next(ay, a + i, side):
            out.append((a + i, a + e, np.clip(was - acc[i:e + 1], 0, None), was / 9.81))
        i = e + 1
    return out


def _into_next(ay: np.ndarray, j: int, side: float) -> bool:
    """A lift at j is for the next corner, not off the exit of this one: the car turns the other way after it, or
    loads up into a new turn the same way (NEXT_TURN_M either side of it)."""
    after = float(np.mean(ay[j:j + NEXT_TURN_M])) if j < len(ay) else 0.0
    before = float(np.mean(ay[max(j - NEXT_TURN_M, 0):j])) if j > 0 else after
    if np.sign(after) != side and abs(after) >= NEXT_TURN_G:
        return True
    return abs(after) - abs(before) >= NEXT_TURN_RISE and abs(after) >= 2 * NEXT_TURN_G


def _held_below(seg: np.ndarray, ts: np.ndarray, top: np.ndarray, j: int) -> float:
    """How long from j the throttle stays 10 points or more below the most it had reached."""
    k = j
    while k < len(seg) and seg[k] <= top[k] - 10:
        k += 1
    return float(ts[min(k, len(ts) - 1)] - ts[j])


def _step_at(seg: np.ndarray, ts: np.ndarray) -> tuple[int, float] | None:
    """The first place the throttle rises faster than STEP_RATE: (index, %/s)."""
    for j in range(len(seg)):
        k = int(np.searchsorted(ts, ts[j] + STEP_WINDOW_S))
        if k >= len(seg):
            break
        rate = (seg[k] - seg[j]) / max(float(ts[k] - ts[j]), 1e-3)
        if rate >= STEP_RATE and seg[k] >= MIN_LIFT_FROM:
            return j, float(rate)
    return None


def _correction(st: np.ndarray, ts: np.ndarray, j: int, until_s: float) -> int | None:
    """A steering correction from j within until_s: the wheel unwinding, then wound back on (or the other way), by a
    fifth of the lock or more."""
    k = int(np.searchsorted(ts, ts[j] + until_s))
    x = np.abs(st[j:k + 1])
    if len(x) < 5 or x.max() <= 0:
        return None
    low = np.minimum.accumulate(x)
    back = np.flatnonzero(x - low >= 0.2 * x.max())
    return j + int(back[0]) if len(back) else None


def obvious_mistakes(tr: dict[str, np.ndarray], corners: list[Corner], env: Envelope, env_r: Envelope,
                     shifts: ShiftModel | None = None, braking: dict[str, dict] | None = None) -> list[dict]:
    """The mistakes that are wrong whatever the target: a lift on the way out of a corner, the throttle on and off
    through it, the throttle stepped on so early or so hard that the car forces a lift or a steering correction,
    braking in a straight line, with no cornering to share the grip with, below the deceleration the car shows at
    that place, and upshifts early or late (shifts). Each with what it alone costs (lift_cost and gain_cost, never
    past the speed the car's best cornering allows; brake_cost; else the span against the realistic target), per
    corner, most costly first; under MIN_OBVIOUS_S left out. Given braking (a dict), the braking up to each turn-in
    below the grip a quick lap usually shows there goes in it by corner, as it is only a mistake against the best
    braking there on the other laps (relative_braking)."""
    thr = tr.get("throttle")
    if thr is None:
        return []
    v, t, ay = tr["speed"], tr["t"], np.asarray(tr["ay"], float)
    most = np.asarray(env.vc, float)  # m/s: the speed the car's best cornering allows at each metre
    n = len(v) - 1
    st = tr.get("steer")
    steer_sign = _steer_sign(tr)
    out = []

    def item(kind: str, c: Corner, a: int, b: int, at: int, title: str, what: str, do: str,
             cost: float | None = None) -> dict:
        b = max(b, a + 1)
        if cost is None:  # what the span costs against the realistic target
            cost = span_cost(env_r, tr, a, b)
        return {"key": f"{c.code}:{kind}", "kind": kind, "code": c.code,
                "phase": {"soft_straight_braking": "braking", "braking_unused": "braking",
                          "early_shift": "full throttle", "late_shift": "full throttle",
                          "on_off_throttle": "mid-corner"}.get(kind, "exit"),
                "start_m": a, "end_m": b, "at_m": at,
                "cost_s": round(max(cost, 0.0), 3), "title": title, "what": what, "do": do}

    for i, c in enumerate(corners):
        nxt = corners[i + 1] if i + 1 < len(corners) else None
        stop = (nxt.lift or nxt.brake or nxt.m) if nxt else n
        # ---- the way out: from the slowest point (or the pick-up after it) past full throttle
        last = max([m for m in getattr(c.section, "at", []) if m < stop] or [c.m])
        a = max(_last_apex(v, max(c.m, last - LAST_CORNER_M), min(stop, c.section.end))
                if len(c.section.corners) > 1 else c.m, c.pickup or c.m)  # in a run of corners, from the last
        if c.pickup is not None and a < stop - 5:
            b = min(stop, (c.full if c.full is not None else stop) + EXIT_REACH_M, n)
            seg, ts = thr[a:b], t[a:b]
            top = np.maximum.accumulate(seg)
            side = np.sign(np.mean(ay[max(c.m - 5, 0):c.m + 6]))
            dips = _dips(seg, ts, top, ay, a, side, c.m)
            lifted = [(x, e) for x, e, _, _ in dips]
            lift = dips[0][0] - a if dips else None
            step = _step_at(thr[c.pickup:b], t[c.pickup:b])
            step_at = c.pickup + step[0] if step else None
            forced_lift = (lift is not None and step_at is not None
                           and t[a + lift] - t[step_at] <= STEP_FORCES_S and a + lift > step_at)
            corr = (_correction(st, t, step_at, STEP_FORCES_S) if st is not None and step_at is not None
                    and lift is None else None)
            if dips and forced_lift:
                j, end, high, low = dips.pop(0)
                early = step_at < c.m
                what = (f"On the way out of {c.code} you went to the throttle at {step[1]:.0f}%/s at {step_at} m"
                        + (f", {c.m - step_at} m before the slowest point" if early else "") +
                        f", and the car would not take it: you had to lift from {high:.0f}% to {low:.0f}% at {j} m, "
                        f"at {v[j]:.0f} km/h.")
                out.append(item("power_step", c, step_at, end, step_at,
                                "Too early on the power, then lifted" if early else
                                "Stepped on the power, then lifted", what,
                                "Squeeze the throttle on from the slowest point, as fast as the car takes it, so "
                                "you never have to come back off it.", lift_cost(tr, j, end, stop, most)))
            lift_item = None
            if dips:
                j, end = dips[0][0], dips[-1][1]
                cost = sum(lift_cost(tr, x, e, stop, most) for x, e, _, _ in dips)
                most_g = float(np.max(np.abs(ay[c.m:j + 1])))
                cornering = max(abs(ay[x]) for x, _, _, _ in dips) > EXIT_AY_SHARE * most_g
                # off full throttle past the slowest point is a lift on the way out, however hard the car is still
                # cornering (a long fast corner's exit is still cornering)
                from_full = dips[0][2] >= FULL_THROTTLE and j >= c.m + EXIT_PAST_APEX_M
                if len(dips) == 1 and (not cornering or from_full):
                    _, _, high, low = dips[0]
                    after = f" {j - c.m} m after the slowest point ({c.m} m)" if j > c.m else ""
                    what = (f"On the way out of {c.code} you were at {high:.0f}% throttle, then lifted to {low:.0f}% "
                            f"at {j} m{after}, at {v[j]:.0f} km/h. Every metre off the throttle on the way out is "
                            "speed lost all the way down the next straight.")
                    out.append(item("exit_lift", c, j, end, j, f"Lifted on the exit of {c.code}", what,
                                    "Once the throttle is on, keep it on: open it only as fast as the car takes it, "
                                    "and keep adding until full throttle.", cost))
                    lift_item = out[-1]
                else:
                    lows = ", ".join(f"{lo:.0f}% at {x} m" for x, _, _, lo in dips)
                    times = "once" if len(dips) == 1 else ("twice" if len(dips) == 2 else f"{len(dips)} times")
                    what = (f"Through {c.code}, with the car still cornering, you came off the throttle {times} "
                            f"(down to {lows}) at {v[j]:.0f}-{v[end]:.0f} km/h. Each lift takes drive away "
                            "and unsettles the car, and the speed it costs is carried all the way down the next "
                            "straight.")
                    out.append(item("on_off_throttle", c, j, end, j, f"Throttle on and off through {c.code}", what,
                                    "Find the throttle the car holds through the corner and keep adding to it "
                                    "smoothly: balance the car with the steering, not by lifting.", cost))
                    lift_item = out[-1]
            elif corr is not None:
                what = (f"You went to the throttle at {step[1]:.0f}%/s at {step_at} m"
                        + (f", {c.m - step_at} m before the slowest point" if step_at < c.m else "") +
                        f", and had to correct the steering at {corr} m: the rear stepped out under the power.")
                out.append(item("power_step", c, step_at, corr + 10, step_at,
                                "Stepped on the power, then corrected", what,
                                "Squeeze the throttle on rather than stepping on it, so the rear stays with you."))
            # ---- the speed stops climbing (or drops) on the way out, whatever the pedal shows
            for j, e, extra, was in _stalls(tr, a, b, ay, side):
                if any(x <= e and j <= y for x, y in lifted):  # the lift above says it: it costs the stall at least
                    if lift_item is not None:
                        stall = round(max(gain_cost(tr, j, e, extra, stop, most), 0.0), 3)
                        lift_item["cost_s"] = max(lift_item["cost_s"], stall)
                        lift_item["end_m"] = max(lift_item["end_m"], e)
                        if "speed stopped" not in lift_item["what"]:
                            drop = float(v[j] - v[j:e + 1].min())
                            lift_item["what"] += (f" With it the speed stopped climbing from {j} m to {e} m"
                                                  + (f", dropping {drop:.0f} km/h." if drop >= 1 else "."))
                            if lift_item["kind"] == "exit_lift":
                                lift_item["title"] = f"Lifted on the exit of {c.code}, the speed stalled"
                    continue
                drop = float(v[j] - v[j:e + 1].min())
                how = f"dropped {drop:.0f} km/h" if drop >= 1 else "stopped climbing"
                least = float(thr[j:e + 1].min())
                if least < FULL_THROTTLE:
                    why = f" with the throttle down to {least:.0f}%"
                elif st is not None and np.abs(st[j:e + 1]).max() >= 1.15 * abs(st[j]) + 0.5:
                    why = " at full throttle while the steering was wound on: the tyres scrubbed it off"
                else:
                    why = " at full throttle: the car slid or ran wide"
                what = (f"On the way out of {c.code} the speed was climbing ({was:.2f} g) and then {how} from {j} m "
                        f"to {e} m, at {v[j]:.0f} km/h,{why}, before any braking for the next corner. Speed that "
                        "stops building on the way out is lost all the way down the next straight.")
                out.append(item("exit_stall", c, j, e, j, f"Speed stalled on the exit of {c.code}", what,
                                "Keep the car accelerating from the slowest point to the next brake point: open the "
                                "steering and add throttle steadily; no lift, no scrub.",
                                gain_cost(tr, j, e, extra, stop, most)))
            # ---- the rear stepping out under power: opposite lock on the throttle while still cornering
            slide = _power_slide(tr, a, b, side, steer_sign) if steer_sign else None
            if slide is not None:
                lock_at, e, lock = slide
                j = max(lock_at - SLIDE_LEAD_M, a)
                acc = _acc(tr)
                was = float(np.mean(acc[max(j - SLIDE_BEFORE_M, a):j])) if j > a else float(acc[j])
                upto = min(e + SLIDE_AFTER_M, stop, n)
                extra = np.clip(was - acc[j:upto], 0.0, None)
                cost = gain_cost(tr, j, upto, extra, stop, most)
                over = [x for x in out if x["code"] == c.code and x["kind"] in ("exit_stall", "power_step")
                        and x["start_m"] <= upto and j <= x["end_m"]]
                for x in over:  # the slide is why: one mistake, named for its cause
                    out.remove(x)
                    cost = max(cost, x["cost_s"])
                rs = (f", the rear slipping up to {float(np.max(tr['rear_slip'][j:e + 1])):.0f}%"
                      if "rear_slip" in tr and np.max(tr["rear_slip"][j:e + 1]) > 0 else "")
                tc = " with the traction control cutting in" if "tc_on" in tr and np.any(tr["tc_on"][j:e + 1] > 0.5) \
                    else ""
                what = (f"On the way out of {c.code} at full throttle the rear stepped out at {v[j]:.0f} km/h: from "
                        f"{lock_at} m you had to hold {lock:.0f}° of opposite lock while the car was still cornering "
                        f"at {abs(float(ay[lock_at])):.1f} g{rs}{tc}. The drive the slide took is speed lost all "
                        "the way down the next straight.")
                out.append(item("power_oversteer", c, j, upto, j, f"Oversteer on the power out of {c.code}", what,
                                "Open the steering before adding the last of the throttle, and squeeze it on as the "
                                "lock comes off, so the rear tyres are never asked for more than they have.", cost))
        # ---- the upshifts on the way out, early or late against the revs where the next gear drives harder
        if shifts is not None and c.pickup is not None:
            def gear_of(m: int) -> int:
                return int(np.rint(tr["gear"][m]))

            for sh in shift_mistakes(tr, shifts, c.pickup, min(stop, n)):
                j, e = sh["j"], sh["end"]
                cost = gain_cost(tr, j, e, sh["extra"], min(stop, n), most)
                if sh["kind"] == "early_shift":
                    upto = (f"all the way to the rev limiter ({shifts.limit:,.0f} rpm)" if shifts.to_limit(gear_of(j))
                            else f"up to {sh['ideal']:,.0f} rpm ({sh['ideal_kmh']:.0f} km/h)")
                    what = (f"On the way out of {c.code} you shifted up at {sh['rpm']:,.0f} rpm ({sh['kmh']:.0f} "
                            "km/h). The engine's torque and the gear ratios say this gear pulls harder than the next "
                            f"one {upto}, so the car drove with less force until {e} m.")
                    out.append(item("early_shift", c, j, e, j, f"Shifted up early out of {c.code}", what,
                                    f"Hold the gear to {sh['ideal']:,.0f} rpm before shifting up.", cost))
                else:
                    held = (f", {sh['limiter_m']} m of it on the rev limiter" if sh["limiter_m"] >= LIMITER_HELD_M
                            else "")
                    what = (f"On the way out of {c.code} you held the gear past {sh['ideal']:,.0f} rpm from {j} m, "
                            f"where the next gear already drives harder, and shifted up at {sh['kmh']:.0f} km/h"
                            f"{held}.")
                    out.append(item("late_shift", c, j, e, j, f"Shifted up late out of {c.code}", what,
                                    f"Shift up at {sh['ideal']:,.0f} rpm"
                                    + (", just before the limiter." if shifts.to_limit(gear_of(j)) else "."), cost))
        # ---- braking in a straight line below the car's deceleration there
        if c.brake is not None:
            a, b = c.brake, c.release or c.m
            if b - a >= 10 and v[a] - v[b] >= MIN_SCRUB_KMH:
                dec = -(np.asarray(tr["ax"][a:b], float) - env.grade[a:b])
                straight = np.abs(tr["ay"][a:b]) < STRAIGHT_AY
                dt = _dt(tr)[a:b]
                abs_share = float((dt * (tr["abs_on"][a:b] > 0.5)).sum() / dt.sum()) if "abs_on" in tr else 0.0
                if straight.sum() >= 5 and float(dt[straight].sum()) >= MIN_STRAIGHT_BRAKE_S and abs_share < ABS_ANY:
                    idx = np.flatnonzero(straight)
                    can = float(max(env.brake_limit(a + int(j), 0.0) for j in idx))
                    got = float(np.percentile(dec[idx], 80))
                    end = a + int(idx[-1]) + 1
                    if got < SOFT_SHARE * can and v[a] - v[end] >= MIN_SCRUB_KMH / 2:
                        what = (f"Braking for {c.code} in a straight line from {a} m ({v[a]:.0f} km/h), with no "
                                f"cornering to share the grip with, the car slowed at {got:.2f} g; it has shown "
                                f"{can:.2f} g there. All the grip is free for braking until you turn in.")
                        out.append(item("soft_straight_braking", c, a, end, a,
                                        f"Braked below the car's limit in a straight line into {c.code}", what,
                                        "Brake harder at once, to the limit, while the car is straight; then brake "
                                        "later to match.", brake_cost(v[a] / 3.6, v[end] / 3.6, got, can)))
            # ---- the whole braking, into the turn-in too, below the grip the car shows there (ABS or not)
            if braking is not None and not any(x["code"] == c.code and x["kind"] == "soft_straight_braking"
                                               for x in out):
                unused = _braking_unused(tr, env_r, a, b)
                if unused is not None and unused[0] > 0:
                    cost, e, share, eased = unused
                    ease = (f"; you eased off the pedal to {eased:.0f}% of its peak while the car could still take "
                            "more" if eased is not None else "")
                    what = (f"Braking for {c.code} from {a} m ({v[a]:.0f} km/h) to {e} m, the car slowed at "
                            f"{share:.0%} of the grip it has shown at each metre of it, cornering as it was{ease}. "
                            "Braking at the limit all the way to the turn-in, you could brake later.")
                    # kept aside: what it costs is judged against the best braking there (relative_braking)
                    braking[c.code] = item("braking_unused", c, a, e, a, f"Braking grip left unused into {c.code}",
                                           what, "Hold the pressure at the limit until the turn-in, and release it "
                                           "only as the steering goes on; then move the brake point later.", cost)
    out = [x for x in out if x["cost_s"] >= MIN_OBVIOUS_S]
    out.sort(key=lambda x: -x["cost_s"])
    return out


# ---------- one lap ----------

def pit_entry(tr: dict[str, np.ndarray], env_r: Envelope) -> int | None:
    """Where a lap that ends in the pit lane (over the line far slower than perfect driving, on the pit limiter)
    lifts for it: the metre the driver last had the throttle in, or the speed up, before slowing for the pit lane.
    None for a flying lap."""
    v = tr["speed"]
    n = len(v) - 1
    q = env_r.P * 3.6 + env_r.dv
    slow = v < PIT_SPEED_SHARE * q
    if not slow[n]:
        return None
    k = n
    while k > 0 and slow[k - 1]:
        k -= 1
    if "throttle" in tr:
        on = np.flatnonzero(tr["throttle"][:k] >= LIFT_THROTTLE)
    else:
        on = np.flatnonzero(v[:k] >= 0.9 * q[:k])
    return int(on[-1]) + 1 if len(on) else 0


def lap_inputs(tr: dict[str, np.ndarray], step: int) -> dict[str, list[float] | None]:
    """The driver's inputs (throttle %, brake pressure, steering, gear, as the log's channels for those roles have
    them) at the speed trace's points, every step metres; None for a channel the log doesn't have."""
    return {r: np.round(np.asarray(tr[r][::step], float), d).tolist() if r in tr else None
            for r, d in INPUT_ROLES.items()}


def model_phases(env: Envelope, sim: SimLap, step: int) -> list[int]:
    """Perfect driving's own phase every step metres, as its model drives (an index into MODEL_PHASES): braking for
    the corner ahead; at the grip limit (cornering as hard as the car has shown there, or driving out as hard as the
    tyres allow: part throttle); or full throttle (the engine, not the grip, limits the drive, or at top speed). The
    model has no pedal positions and never coasts."""
    v_top = env.lim.top_speed * TOP_SPEED_MARGIN / 3.6
    out = []
    for i in range(0, env.n + 1, step):
        by = int(sim.limited_by[i])  # lapsim.LIMITED_BY: corner, accel, brake
        if by == 2:
            out.append(0)
        elif by == 1:
            out.append(2 if env.power_limited(float(env.P[i]), i) else 1)
        else:
            out.append(2 if env.vc[i] >= v_top - 1e-6 else 1)
    return out


MODEL_SMOOTH_M = 15  # perfect driving's acceleration is read over this many metres
MODEL_FULL = 0.92  # within this share of full drive, perfect driving is at full throttle
MODEL_BRAKING_G = 0.15  # slowing this much harder than the drag alone, perfect driving is on the brakes
MODEL_BRAKE_G = 0.3  # the driver's brake pressure per g is fitted where they brake at least this hard
MODEL_BRAKE_MIN = 0.1  # ...with at least this share of their hardest pressure on the pedal
MODEL_BRAKE_SAMPLES = 30
DOWNSHIFT_MARGIN_RPM = 300  # perfect driving shifts down once the lower gear is this far short of its upshift


def _resistance(env: Envelope, v: np.ndarray) -> np.ndarray:
    """g of drag at v (m/s): the power curve's air drag, what slows the car with no pedal pressed."""
    return max(-float(env.lim.power[2]), 0.0) * v * v


def _accel(kmh: np.ndarray, t: np.ndarray | None = None) -> np.ndarray:
    """Acceleration (g) along a speed trace every metre, read over MODEL_SMOOTH_M."""
    v = np.asarray(kmh, float) / 3.6
    a = np.gradient(v, t) / G if t is not None else np.gradient(v * v / 2) / G
    k = np.ones(MODEL_SMOOTH_M) / MODEL_SMOOTH_M
    return np.convolve(np.pad(a, MODEL_SMOOTH_M, mode="edge"), k, mode="same")[MODEL_SMOOTH_M:-MODEL_SMOOTH_M]


def _brake_per_g(tr: dict[str, np.ndarray], env: Envelope) -> float | None:
    """The driver's brake pressure per g of braking beyond the drag, fitted on this lap's own braking: so perfect
    driving's braking reads in the log's own pressure units. None without a brake channel or braking to fit."""
    if "brake" not in tr:
        return None
    p = np.asarray(tr["brake"], float)
    decel = -_accel(tr["speed"]) - _resistance(env, np.asarray(tr["speed"], float) / 3.6)
    m = np.isfinite(p) & np.isfinite(decel) & (decel >= MODEL_BRAKE_G)
    if m.sum() < MODEL_BRAKE_SAMPLES:
        return None
    m &= p >= MODEL_BRAKE_MIN * float(np.max(p[m]))
    k = float(np.dot(p[m], decel[m]) / np.dot(decel[m], decel[m])) if m.sum() >= MODEL_BRAKE_SAMPLES else 0.0
    return k if k > 0 else None


def _ideal_gears(shifts: ShiftModel, kmh: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """The gear (as logged) perfect driving is in at each point, and its revs: up at the ideal shift point (the top
    gear runs to the rev limiter), down once the lower gear is DOWNSHIFT_MARGIN_RPM short of its own."""
    gears = sorted(shifts.ratio, key=lambda g: -shifts.ratio[g])  # lowest first
    top = len(gears) - 1
    up = [shifts.ideal.get(g, shifts.limit) if j < top else np.inf for j, g in enumerate(gears)]

    def lowest(v: float) -> int:
        return next((j for j, g in enumerate(gears) if shifts.ratio[g] * v < up[j]), top)

    j = lowest(float(kmh[0]))
    out = np.empty(len(kmh), int)
    for k, v in enumerate(np.asarray(kmh, float)):
        while j < top and shifts.ratio[gears[j]] * v >= up[j]:
            j += 1
        while j > 0 and shifts.ratio[gears[j - 1]] * v < up[j - 1] - DOWNSHIFT_MARGIN_RPM:
            j -= 1
        out[k] = gears[j]
    ratio = np.array([shifts.ratio[int(g)] for g in out])
    return out, np.minimum(ratio * kmh, shifts.limit)


def model_inputs(tr: dict[str, np.ndarray], env: Envelope, sim: SimLap, step: int,
                 shifts: ShiftModel | None = None) -> dict[str, list[float] | None]:
    """Perfect driving's inputs at the speed trace's points, every step metres, to lay over the driver's: what its
    speed (sim, as the chart draws it) asks of the car. Full throttle wherever its model is (model_phases) or the
    speed needs nearly all the car's drive there (MODEL_FULL); part throttle as the share of full drive the speed
    needs; brake pressure where it slows clearly harder than the drag (MODEL_BRAKING_G), as the driver's own pressure
    per g on this lap would give it (None without a brake channel); and the gear and revs of the ideal shift points
    at its speed (None without a shift model). The model has no pedals: these are what its speed needs."""
    kmh = np.asarray(sim.speed, float)
    v = kmh / 3.6
    a = _accel(kmh)
    r = _resistance(env, v)
    per_g = _brake_per_g(tr, env)
    idx = np.arange(0, len(kmh), step)
    phases = model_phases(env, sim, step)
    throttle, brake = [], []
    for k, i in enumerate(idx):
        drive = float(a[i] + r[i])
        full = env.power_at(int(min(i, env.n - 1)), float(v[i])) + float(r[i])
        share = drive / max(full, 1e-6)
        flat = phases[k] == 2 or share >= MODEL_FULL
        braking = not flat and drive < -MODEL_BRAKING_G
        throttle.append(100.0 if flat else 0.0 if braking else round(float(np.clip(100 * share, 0, 100))))
        brake.append(round(per_g * -drive, 1) if braking and per_g is not None else 0.0)
    out: dict[str, list[float] | None] = {"throttle": throttle, "brake": brake if per_g is not None else None,
                                          "gear": None, "rpm": None}
    if shifts is not None:
        gear, rpm = _ideal_gears(shifts, kmh)
        out["gear"], out["rpm"] = gear[idx].tolist(), np.round(rpm[idx]).tolist()
    return out


FIXED_KINDS = ("exit_lift", "exit_stall", "on_off_throttle", "power_step", "soft_straight_braking", "braking_unused",
               "power_oversteer", "early_shift", "late_shift")
SHIFT_KINDS = ("early_shift", "late_shift")


def without_mistakes(tr: dict[str, np.ndarray], env_r: Envelope, sections: list[Section],
                     obvious: list[dict], shifts: ShiftModel | None = None) -> np.ndarray:
    """The lap's speed (km/h, every metre) with its obvious mistakes taken out, the rest as driven: from where each
    mistake starts the car drives on as hard as the lap itself showed it can at each speed on the way (and a quick
    lap's grip allows, env_r), until it has to
    brake for the next corner as hard as the car has shown there, or meets the lap's own speed again. So an exit
    lifted on, stalled or stepped on runs on smoothly, and soft straight-line braking starts later and brakes
    harder. An upshift made early or late (given the shift model) is made at the ideal revs instead: the drive
    the wrong gear lost is added back over the stretch it cost (as gain_cost), and the speed gained carried on.
    Never slower than the lap anywhere."""
    driven = np.asarray(tr["speed"], float)
    n = len(driven) - 1
    fixed = driven.copy()
    todo = sorted((o for o in obvious if o["kind"] in FIXED_KINDS and (shifts is not None or
                                                                       o["kind"] not in SHIFT_KINDS)),
                  key=lambda o: o["start_m"])
    if not todo:
        return fixed
    # braking for every corner as hard as the car has shown: back from each apex at the lap's own speed there, and
    # from the end of every soft straight-line braking at the speed it reached
    seed = np.full(n + 1, np.inf)
    for sec in sections:
        if sec.apex is not None and 0 <= sec.apex <= n:
            seed[sec.apex] = driven[sec.apex]
    for o in todo:
        if o["kind"] in ("soft_straight_braking", "braking_unused"):
            e = min(int(o["end_m"]), n)
            seed[e] = min(seed[e], driven[e])
    bw = np.empty(n + 1)
    bw[n] = min(seed[n], driven[n]) / 3.6
    for i in range(n - 1, -1, -1):
        v = bw[i + 1]
        bw[i] = min(seed[i] / 3.6, (v * v + 2 * env_r.brake_at(i + 1, v) * G) ** 0.5)
    apexes = sorted(sec.apex for sec in sections if sec.apex is not None)
    ms = driven / 3.6
    for o in todo:
        i = max(int(o["start_m"]), 0)
        end = min(int(o["end_m"]), n)
        # the lap's own acceleration at each speed on the way to the next corner (its gears, its drag): the most it
        # showed at that speed or faster, so a lift's own slowing doesn't count
        stop = next((x for x in apexes if x > end), n)
        seg = ms[i:stop + 1]
        if len(seg) < 3:
            continue
        acc = (seg[1:] ** 2 - seg[:-1] ** 2) / 2
        order = np.argsort(seg[:-1])
        at_v = seg[:-1][order]
        most = np.maximum.accumulate(acc[order][::-1])[::-1]
        v = fixed[i] / 3.6
        if o["kind"] in SHIFT_KINDS:  # the drive the wrong gear lost, added back where it was lost
            sh = next((x for x in shift_mistakes(tr, shifts, i, min(end + 2, n)) if x["kind"] == o["kind"]), None)
            if sh is None:
                continue
            j, e, extra = sh["j"], min(sh["end"], n), sh["extra"]
            held = v = fixed[j] / 3.6
            for k in range(j + 1, e + 1):
                up = held * held + ms[k] ** 2 - ms[k - 1] ** 2 + 2 * max(float(extra[k - 1 - j]), 0.0)
                held = min(max(up, 0.0) ** 0.5, bw[k])
                fixed[k] = max(fixed[k], held * 3.6)
            i, end, v = e, e, max(held, ms[e])
        while i < n:
            own = (v * v + 2 * max(float(np.interp(v, at_v, most)), 0.0)) ** 0.5
            v = min(own, env_r.step_up(i, v), bw[i + 1])
            i += 1
            if v * 3.6 <= driven[i] and i >= end:
                break
            fixed[i] = max(fixed[i], v * 3.6)
    return fixed


def fixed_inputs(tr: dict[str, np.ndarray], env_r: Envelope, realistic: SimLap, sections: list[Section],
                 obvious: list[dict], step: int, shifts: ShiftModel | None) -> dict:
    """This lap with its obvious mistakes taken out (without_mistakes), every step metres: its speed, and the
    driver's own inputs except where a mistake was taken out, where they are what the new speed asks of the car
    (model_inputs) and the ideal gear and revs."""
    fixed = without_mistakes(tr, env_r, sections, obvious, shifts)
    changed = (fixed - np.asarray(tr["speed"], float))[::step] > 0.05
    model = model_inputs(tr, env_r, SimLap(fixed, realistic.t, realistic.time, realistic.limited_by), step, shifts)
    own = lap_inputs(tr, step)
    out: dict = {"speed": np.round(fixed[::step], 1).tolist()}
    for r in ("throttle", "brake", "gear", "rpm"):
        mine, theirs = own.get(r), model.get(r)
        out[r] = None if mine is None else [t if c and theirs is not None else m
                                            for m, t, c in zip(mine, theirs or mine, changed, strict=True)]
    return out


BLEND_M = 30  # metres over which the best-technique lap blends from one corner's source into the next
BEST_MIN_GAIN_S = 0.005  # a pass quicker than this lap's by less is no better


@dataclass
class Pass:
    """One lap's check, as the best-technique lap reads it: who drove it, its time through every section, the
    obvious mistakes in it and its trace (check_lap's detail)."""
    run: str
    number: int
    time: float
    driver: str | None
    times: list[float]  # s through each section
    obvious: list[dict]
    trace: dict
    braking: dict[str, dict] = field(default_factory=dict)  # obvious_mistakes' braking: by corner


def section_times(tr: dict[str, np.ndarray], sections: list[Section]) -> list[float]:
    """s through each section of a lap's trace on the line."""
    t = np.asarray(tr["t"], float)
    return [float(t[min(s.end, len(t) - 1)] - t[s.start]) for s in sections]


def _through(kmh: list[float], s: Section, step: int) -> float:
    """s through a section at a speed trace's points every step metres."""
    v = np.maximum(np.asarray(kmh[s.start // step:s.end // step + 1], float), 1.0) / 3.6
    return float(np.sum(2 * step / (v[:-1] + v[1:])))


def best_technique(view: Pass, passes: list[Pass], sections: list[Section],
                   shifts: ShiftModel | None = None) -> dict:
    """The lap to lay over this one: through every section the driver's own quickest clean pass of the event (no
    obvious mistake in it but its upshifts) where it beats this lap's, else this lap's own pass with its obvious
    mistakes taken out (built; fixed_inputs), or as driven where it had none (own). Every pass shifts up at the ideal
    revs (without_mistakes), so a real pass's early or late upshifts are put right and the time that finds counted.
    Blended over BLEND_M at every join, so the speed runs on smoothly; the gear and revs are the ideal shift points'
    at its speed (given the shift model). Each section says where it comes from (a real pass, its run and lap, and
    what was put right in it; built; or own) and what it finds over this lap there; its time is this lap's less all
    of that."""
    tr = view.trace
    step = int(tr["step_m"])
    n = len(tr["driven"])
    roles = ("throttle", "brake", "gear", "rpm")
    mine = [p for p in passes if view.driver is None or p.driver in (None, view.driver)]
    chosen, sources = [], []
    for k, s in enumerate(sections):
        def put_right(p: Pass, s: Section = s) -> list[str]:
            return sorted({o["kind"] for o in p.obvious if s.start <= o["at_m"] < s.end})

        def fixed_time(p: Pass, k: int = k, s: Section = s) -> float:
            """The pass's real time through the section less what taking its mistakes out finds there."""
            ptr = p.trace
            return p.times[k] - max(_through(ptr["driven"], s, step) - _through(ptr["model"]["fixed"]["speed"], s,
                                                                                step), 0.0)

        best, best_t = view, fixed_time(view)
        for p in mine:
            if p is view or any(x not in SHIFT_KINDS for x in put_right(p)):
                continue
            if p.times[k] >= view.times[k] - BEST_MIN_GAIN_S:  # no quicker than this lap's as driven
                continue
            t = fixed_time(p)
            if t < best_t - BEST_MIN_GAIN_S:
                best, best_t = p, t
        gain = max(view.times[k] - best_t, 0.0)
        src = best.trace["model"]["fixed"]
        chosen.append(src)
        if best is view:  # built where a mistake was taken out; else this lap's own pass is already its best
            sources.append({"code": s.code, "start_m": s.start, "end_m": s.end,
                            "kind": "built" if gain >= BEST_MIN_GAIN_S else "own", "gain_s": round(gain, 3),
                            "put_right": put_right(view) if gain >= BEST_MIN_GAIN_S else []})
        else:
            sources.append({"code": s.code, "start_m": s.start, "end_m": s.end, "kind": "pass", "run": best.run,
                            "number": best.number, "gain_s": round(gain, 3), "put_right": put_right(best)})
    m = np.arange(n) * step
    # each point's weight on every section's source: 1 inside it, falling over BLEND_M across each join
    weights = np.zeros((len(sections), n))
    for k, s in enumerate(sections):
        lo = np.clip((m - (s.start - BLEND_M / 2)) / BLEND_M, 0, 1) if k else np.ones(n)
        hi = np.clip(((s.end + BLEND_M / 2) - m) / BLEND_M, 0, 1) if k < len(sections) - 1 else np.ones(n)
        weights[k] = np.minimum(lo, hi)
    weights /= np.maximum(weights.sum(axis=0), 1e-9)
    out: dict = {"sources": sources}
    for r in ("speed", *roles):
        cols = [c[r] for c in chosen]
        if any(c is None or len(c) != n for c in cols):
            out[r] = None
            continue
        vals = np.array([np.asarray(c, float) for c in cols])
        if r == "gear":  # a gear is not blended: the source weighing most
            g = vals[np.argmax(weights, axis=0), np.arange(n)]
            out[r] = g.tolist()
        else:
            out[r] = np.round(np.nansum(vals * weights, axis=0), 1).tolist()
    if shifts is not None and out["speed"] is not None:  # the ideal shift points at its speed
        gear, rpm = _ideal_gears(shifts, np.asarray(out["speed"], float))
        out["gear"], out["rpm"] = gear.tolist(), np.round(rpm).tolist()
    out["time"] = round(view.time - sum(x["gain_s"] for x in sources), 3)  # less what every section finds
    return out


EXIT_KINDS = ("exit_lift", "exit_stall", "on_off_throttle", "power_step", "power_oversteer")


def _with_exit_lifts(obvious: list[dict], items: list[dict], tr: dict[str, np.ndarray]) -> list[dict]:
    """The obvious mistakes, with every lift on the way out that the comparison with the realistic target names
    (the throttle coming back off before full throttle, with the target already flat) and the obvious check missed:
    a lift from part throttle, or one that starts at the slowest point, is still a lift on the way out."""
    v = tr["speed"]
    out = list(obvious)
    for x in items:
        if x["kind"] != "exit_lift" or x["cost_s"] < MIN_OBVIOUS_S:
            continue
        a, b = int(x["start_m"]), int(x["end_m"])
        if any(o["code"] == x["code"] and o["kind"] in EXIT_KINDS and o["start_m"] <= b and a <= o["end_m"]
               for o in out):
            continue
        what = (f"On the way out of {x['code']} you came off the throttle before reaching full throttle, and the "
                f"speed only went from {v[a]:.0f} to {v[b]:.0f} km/h from {a} m to {b} m. " + x["what"])
        out.append({"key": f"{x['code']}:exit_lift", "kind": "exit_lift", "code": x["code"], "phase": "exit",
                    "start_m": a, "end_m": b, "at_m": x["at_m"], "cost_s": x["cost_s"],
                    "title": f"Lifted on the exit of {x['code']}", "what": what, "do": x["do"]})
    return sorted(out, key=lambda o: -o["cost_s"])


def check_lap(tr: dict[str, np.ndarray], perfect: PlaceLimits, held: PlaceLimits, sections: list[Section], *,
              lap_time: float, units: dict[str, str] | None = None, detail: bool = True,
              calibrations: tuple[Calibration | None, Calibration | None] = (None, None),
              shifts: ShiftModel | None = None) -> dict:
    """The lap's mistakes against perfect driving, most costly first, and how the gap to the perfect lap splits:
    named mistakes, losses with the pedals at the limit, the perfect lap's optimism, the pit lane and what no single
    mistake explains.

    tr: the lap's trace on the line (every metre, timing line at both ends). perfect and held: the limits the car has
    shown at every place, at their best and as a quick lap usually shows them (the report's theoretical lap and
    realistic target); calibrations: the model's own error at every metre at each, as the report's targets have it
    (Prepared.calibration and held_calibration). Both are driven on the lap's own line at limits never below what
    the lap itself showed there (local_limits.on_own_line)."""
    units = units or {}
    env, env_r = (Envelope(tr["curvature"], on_own_line(lim, tr), cal)
                  for lim, cal in zip((perfect, held), calibrations, strict=True))
    sim, realistic = env.sim(), env_r.sim()
    corners = corner_events(tr, sections)
    lifts = straight_lifts(tr, corners)
    pit_from = pit_entry(tr, env_r)
    pieces, _, start_r = cost_pieces(tr, corners, lifts, env, env_r, pit_from)

    def section_of(m: int) -> str:
        return next((s.code for s in sections if s.start <= m < s.end), sections[-1].code)

    items = []
    for p in pieces:
        if p.cost < MIN_COST_S or p.role == "pit":
            continue
        mk = name_piece(p, tr, env, env_r, units, section_of)
        if mk is None:
            continue
        code = p.corner.code if p.corner else section_of((p.start + p.end) // 2)
        items.append({"key": f"{code}:{mk.key}", "kind": mk.key, "code": code, "phase": mk.phase,
                      "start_m": p.start, "end_m": p.end, "at_m": mk.at, "cost_s": round(p.cost, 3),
                      "cost_perfect_s": round(p.cost_perfect, 3), "carried_s": round(p.carried, 3),
                      "title": mk.title, "what": mk.what, "do": mk.do,
                      "value": None if mk.value is None else round(float(mk.value), 3), "unit": mk.unit})
    items.sort(key=lambda x: -x["cost_s"])
    braking: dict[str, dict] = {}
    obvious = obvious_mistakes(tr, corners, env, env_r, shifts, braking)
    obvious = _with_exit_lifts(obvious, items, tr)
    trace_time = float(tr["t"][-1])
    named_at = {x["start_m"] for x in items}
    named = sum(p.cost for p in pieces if p.start in named_at)
    # the obvious mistakes count too, each at its own cost, where no named mistake already covers them: on the
    # fastest lap the targets are built on, its own mistakes are in the targets, so only they show what it lost
    def beyond(o: dict) -> float:  # what an obvious mistake costs beyond the named ones over it
        return o["cost_s"] - sum(x["cost_s"] for x in items if x["code"] == o["code"] and x["start_m"] <= o["end_m"]
                                 and o["start_m"] <= x["end_m"])

    unnamed = [(o, beyond(o)) for o in obvious]
    unnamed = [(o, c) for o, c in unnamed if c > 0]
    named += sum(c for _, c in unnamed)
    pit = sum(p.cost for p in pieces if p.role == "pit")
    rest = [p for p in pieces if p.start not in named_at and p.role != "pit"]
    # the pieces an obvious mistake explains are that mistake: what the mistake costs beyond them, perfect driving
    # already carries (it is built on the quickest laps, this one's mistakes and all)
    covered = [any(o["start_m"] <= p.end and p.start <= o["end_m"] for o, _ in unnamed) for p in rest]
    in_targets = -max(sum(c for _, c in unnamed) - sum(p.cost for p, c in zip(rest, covered, strict=True) if c), 0.0)
    rest = [p for p, c in zip(rest, covered, strict=True) if not c]
    # a loss where the pedals were at the limit; where such a piece beat the realistic target it is a gain like others
    limited = [p.cost > 0 and (p.limit or (p.role == "straight" and _flat(tr, p))) for p in rest]
    at_limit = sum(p.cost for p, x in zip(rest, limited, strict=True) if x)
    optimism = realistic.time - sim.time
    # the speed over the line comes from the lap before, and the lap's own timing is a hair off its trace
    carried_in = (start_r - realistic.time) + (lap_time - trace_time)
    other = [p.cost for p, x in zip(rest, limited, strict=True) if not x] + [carried_in]
    out = {
        "lap_time": round(lap_time, 3),
        "perfect": round(sim.time, 3),
        "realistic": round(realistic.time, 3),
        "gap": round(lap_time - sim.time, 3),
        "pit_from_m": pit_from,  # the lap ends in the pit lane from here
        # the gap to the perfect lap, split: the named mistakes; at the limit (flat out, or braking with the ABS or
        # driving out with the traction control working, yet the car below its best); the perfect lap's optimism
        # (the best of every place against a quick lap's usual); the pit lane, when the lap ends in it; and the rest:
        # small losses no single mistake explains, less the places the lap beat the realistic target. The mistakes
        # are the named ones and every obvious one at its own cost; in_targets (zero or less) is the part of them
        # perfect driving already carries from this lap, so the parts still add up to the gap
        "budget": {
            "mistakes": round(named, 3),
            "in_targets": round(in_targets, 3),
            "at_limit": round(at_limit, 3),
            "optimism": round(optimism, 3),
            "pit_lane": round(pit, 3),
            "other": round(lap_time - sim.time - named - in_targets - at_limit - optimism - pit, 3),
            "other_losses": round(sum(c for c in other if c > 0), 3),
            "other_gains": round(sum(c for c in other if c < 0), 3),
        },
        "mistakes": items,
        # the mistakes that are wrong whatever the target (exit lifts, power stepped on and forcing a lift or a
        # correction, soft straight-line braking): shown first, each with what it costs; they may overlap the above
        "obvious": obvious,
        # the braking up to each turn-in below a quick lap's usual grip, by corner: a mistake only against the best
        # braking there on the other laps (relative_braking)
        "braking": braking,
    }
    if detail:
        step = TRACE_STEP_M
        out["trace"] = {"step_m": step,
                        "driven": np.round(tr["speed"][::step], 1).tolist(),
                        "perfect": np.round(sim.speed[::step], 1).tolist(),
                        "realistic": np.round(realistic.speed[::step], 1).tolist(),
                        "inputs": lap_inputs(tr, step), "model_phases": model_phases(env, sim, step),
                        # perfect driving's and the realistic target's inputs, to lay over the driver's
                        "model": {"perfect": model_inputs(tr, env, sim, step, shifts),
                                  "realistic": model_inputs(tr, env_r, realistic, step, shifts),
                                  "fixed": fixed_inputs(tr, env_r, realistic, sections, obvious, step, shifts)}}
        out["pieces"] = [{"start_m": p.start, "end_m": p.end, "role": p.role,
                          "code": p.corner.code if p.corner else section_of((p.start + p.end) // 2),
                          "cost_s": round(p.cost, 3), "cost_perfect_s": round(p.cost_perfect, 3)} for p in pieces]
    return out


# ---------- the mistakes that repeat ----------

HABITS = {
    "brake_early": "Braking early",
    "lift_before_brake": "Lifting before the brake",
    "over_slowed": "Slowing the car too much on the brakes",
    "lockup": "Locking the front wheels",
    "soft_braking": "Braking below the car's limit",
    "slow_brake_build": "Slow onto the brake",
    "early_ease": "Easing off the brake too soon",
    "lift_corner": "Lifting more than needed",
    "coasting": "Coasting into the corner",
    "min_speed": "Too slow at the slowest point",
    "late_throttle": "Late on the throttle",
    "exit_lift": "Lifting on the way out",
    "slow_throttle": "Slow to full throttle",
    "lift": "Lifting off full throttle",
    "steering": "Steering corrections",
}


def habits(laps: list[list[dict]], min_laps: int = 2) -> list[dict]:
    """The mistakes that repeat across laps (each a list of check_lap mistakes): per corner and kind, in how many of
    the laps, what it costs a lap on average over every lap checked and when it happens, and its usual size. Most
    costly per lap first."""
    n = len(laps)
    by: dict[str, dict] = {}
    for items in laps:
        seen: set[str] = set()
        for m in items:
            h = by.setdefault(m["key"], {"key": m["key"], "kind": m["kind"], "code": m["code"], "phases": {},
                                         "laps": 0, "cost": 0.0, "cost_perfect": 0.0, "values": [],
                                         "unit": m["unit"]})
            h["cost"] += m["cost_s"]
            h["cost_perfect"] += m["cost_perfect_s"]
            h["phases"][m["phase"]] = h["phases"].get(m["phase"], 0) + 1
            if m["key"] not in seen:
                seen.add(m["key"])
                h["laps"] += 1
                if m.get("value") is not None:
                    h["values"].append(m["value"])
    out = []
    for h in by.values():
        if h["laps"] < min(min_laps, n):
            continue
        out.append({"key": h["key"], "kind": h["kind"], "code": h["code"],
                    "phase": max(h["phases"], key=h["phases"].get), "title": HABITS.get(h["kind"], h["kind"]),
                    "laps": h["laps"], "of": n, "share": round(h["laps"] / n, 3),
                    "cost_per_lap_s": round(h["cost"] / n, 3), "cost_when_s": round(h["cost"] / h["laps"], 3),
                    "cost_perfect_per_lap_s": round(h["cost_perfect"] / n, 3),
                    "value": round(float(np.median(h["values"])), 2) if h["values"] else None, "unit": h["unit"]})
    out.sort(key=lambda x: -x["cost_per_lap_s"])
    return out


# ---------- what each obvious mistake really costs, measured on the laps ----------

MEASURE_MIN_LAPS = 3  # laps with a mistake, and laps without, before its cost is measured rather than modelled
MEASURE_SIGMAS = 2.0  # a measured loss counts once it is this many standard errors clear of none


def mistake_stats(laps: list[tuple[str | None, list[float], list[dict]]], sections: list[Section]) -> list[dict]:
    """What each obvious mistake (by section and kind) really cost on these laps, driver by driver: the time from
    the section's start to the next section's end (so a slow exit's loss down the straight counts), the median of the
    laps with the mistake there against the median of the laps with no obvious mistake over that stretch. laps: each
    clean lap's driver, time through each section (section_times) and obvious mistakes. A loss measured, not
    modelled: kept per driver so pooling events (pool_stats) compares like with like."""
    n = len(sections)
    if n == 0:
        return []

    def window(times: list[float], k: int) -> float:
        return times[k] + (times[k + 1] if k + 1 < n else 0.0)

    def section_of(m: float) -> int | None:
        return next((k for k, s in enumerate(sections) if s.start <= m < s.end), None)

    marks = [[(section_of(o["at_m"]), o) for o in obv] for _, _, obv in laps]
    out = []
    for driver in {d for d, _, _ in laps}:
        mine = [i for i, (d, _, _) in enumerate(laps) if d == driver]
        found: dict[tuple[int, str], list[int]] = {}
        model: dict[tuple[int, str], list[float]] = {}
        for i in mine:
            for k, o in marks[i]:
                if k is None:
                    continue
                if i not in found.setdefault((k, o["kind"]), []):
                    found[(k, o["kind"])].append(i)
                model.setdefault((k, o["kind"]), []).append(float(o.get("cost_s", 0.0)))
        for (k, kind), with_ in found.items():
            over = {k, k + 1}
            clean = [i for i in mine if not any(s in over for s, _ in marks[i])]
            if len(clean) < MEASURE_MIN_LAPS:  # too few laps clean over the stretch: those without this mistake
                clean = [i for i in mine if i not in with_]
            if not clean:
                continue
            w1 = np.array([window(laps[i][1], k) for i in with_])
            w0 = np.array([window(laps[i][1], k) for i in clean])
            had, free = float(np.median(w1)), float(np.median(w0))
            # the noise on that difference: a median's standard error, about 1.25 x the mean's
            se = 1.25 * float(np.sqrt((w1.var(ddof=1) / len(w1) if len(w1) > 1 else 0.0)
                                      + (w0.var(ddof=1) / len(w0) if len(w0) > 1 else 0.0)))
            out.append({"code": sections[k].code, "kind": kind, "driver": driver, "laps_with": len(with_),
                        "laps_without": len(clean), "diff_s": round(had - free, 4), "se_s": round(se, 4),
                        "model_s": round(float(np.mean(model[(k, kind)])), 4)})
    return out


def pool_stats(stats: list[list[dict]]) -> dict[str, dict]:
    """Every event's (or session's) mistake_stats pooled, by "code:kind": the measured cost (each driver's and each
    event's difference, weighted by the laps behind it: the fewer of with and without), the laps and events it rests
    on, and the model's own estimate beside it. measured is True once MEASURE_MIN_LAPS laps with and without it
    back it; clear once the loss stands clear of the noise (MEASURE_SIGMAS of pm_s, its standard error). cost_s is the
    measured loss where clear, the model's otherwise: a mistake the laps can't measure yet is still a mistake."""
    acc: dict[str, dict] = {}
    for events, group in enumerate(stats):
        for x in group:
            a = acc.setdefault(f"{x['code']}:{x['kind']}", {"code": x["code"], "kind": x["kind"], "w": 0.0, "sum": 0.0,
                                                            "laps_with": 0, "laps_without": 0, "model": [],
                                                            "events": set()})
            w = float(min(x["laps_with"], x["laps_without"]))
            a["w"] += w
            a["sum"] += w * x["diff_s"]
            a["se2"] = a.get("se2", 0.0) + (w * x.get("se_s", 0.0)) ** 2
            a["laps_with"] += x["laps_with"]
            a["laps_without"] += x["laps_without"]
            a["model"].append(x["model_s"])
            a["events"].add(events)
    out = {}
    for key, a in acc.items():
        measured = a["laps_with"] >= MEASURE_MIN_LAPS and a["laps_without"] >= MEASURE_MIN_LAPS and a["w"] > 0
        model_s = float(np.mean(a["model"]))
        diff = a["sum"] / a["w"] if a["w"] > 0 else 0.0
        pm = float(np.sqrt(a.get("se2", 0.0))) / a["w"] if a["w"] > 0 else 0.0
        # measured, yet no loss clear of the noise (MEASURE_SIGMAS of it): not measurable yet, the flag stands
        clear = measured and diff > MEASURE_SIGMAS * pm
        out[key] = {"key": key, "code": a["code"], "kind": a["kind"], "measured": measured, "clear": clear,
                    "measured_s": round(diff, 3) if measured else None, "pm_s": round(pm, 3) if measured else None,
                    "cost_s": round(diff, 3) if clear else round(model_s, 3),
                    "model_s": round(model_s, 3), "laps_with": a["laps_with"], "laps_without": a["laps_without"],
                    "events": len(a["events"])}
    return out
