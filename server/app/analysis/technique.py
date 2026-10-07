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

from app.analysis.channels import EXIT, POWER
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
INPUT_ROLES = {"throttle": 0, "brake": 1, "steer": 1, "gear": 0}  # the driver's inputs sent with the trace: decimals
# perfect driving's own phases (model_phases): braking, at the grip limit (part throttle), full throttle; no coasting
MODEL_PHASES = ("braking", "grip limit", "full throttle")

PHASE_WORDS = ("braking", "entry", "mid-corner", "exit", "full throttle")


# ---------- perfect driving from any point ----------

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
        n, F, B = self.n, self.F, self.B
        fw = max(v0 + float(self.ahead[i0]), 1.0)
        out = [min(fw, B[i0])]
        i = i0
        while i < n:
            fw = self.step_up(i, fw)
            i += 1
            if abs(fw - F[i]) < 1e-7:
                break
            out.append(min(fw, B[i]))
        return Restart(self, i0, np.array(out))


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
                     shifts: ShiftModel | None = None) -> list[dict]:
    """The mistakes that are wrong whatever the target: a lift on the way out of a corner, the throttle on and off
    through it, the throttle stepped on so early or so hard that the car forces a lift or a steering correction,
    braking in a straight line, with no cornering to share the grip with, below the deceleration the car shows at
    that place, and upshifts early or late (shifts). Each with what it alone costs (lift_cost and gain_cost, never
    past the speed the car's best cornering allows; brake_cost; else the span against the realistic target), per
    corner, most costly first; under MIN_OBVIOUS_S left out."""
    thr = tr.get("throttle")
    if thr is None:
        return []
    v, t, ay = tr["speed"], tr["t"], np.asarray(tr["ay"], float)
    most = np.asarray(env.vc, float)  # m/s: the speed the car's best cornering allows at each metre
    n = len(v) - 1
    st = tr.get("steer")
    out = []

    def item(kind: str, c: Corner, a: int, b: int, at: int, title: str, what: str, do: str,
             cost: float | None = None) -> dict:
        b = max(b, a + 1)
        if cost is None:  # what the span costs against the realistic target
            cost = span_cost(env_r, tr, a, b)
        return {"key": f"{c.code}:{kind}", "kind": kind, "code": c.code,
                "phase": {"soft_straight_braking": "braking", "early_shift": "full throttle",
                          "late_shift": "full throttle", "on_off_throttle": "mid-corner"}.get(kind, "exit"),
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
                if len(dips) == 1 and not cornering:
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
    obvious = obvious_mistakes(tr, corners, env, env_r, shifts)
    trace_time = float(tr["t"][-1])
    named_at = {x["start_m"] for x in items}
    named = sum(p.cost for p in pieces if p.start in named_at)
    pit = sum(p.cost for p in pieces if p.role == "pit")
    rest = [p for p in pieces if p.start not in named_at and p.role != "pit"]
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
        # small losses no single mistake explains, less the places the lap beat the realistic target
        "budget": {
            "mistakes": round(named, 3),
            "at_limit": round(at_limit, 3),
            "optimism": round(optimism, 3),
            "pit_lane": round(pit, 3),
            "other": round(lap_time - sim.time - named - at_limit - optimism - pit, 3),
            "other_losses": round(sum(c for c in other if c > 0), 3),
            "other_gains": round(sum(c for c in other if c < 0), 3),
        },
        "mistakes": items,
        # the mistakes that are wrong whatever the target (exit lifts, power stepped on and forcing a lift or a
        # correction, soft straight-line braking): shown first, each with what it costs; they may overlap the above
        "obvious": obvious,
    }
    if detail:
        step = TRACE_STEP_M
        out["trace"] = {"step_m": step,
                        "driven": np.round(tr["speed"][::step], 1).tolist(),
                        "perfect": np.round(sim.speed[::step], 1).tolist(),
                        "realistic": np.round(realistic.speed[::step], 1).tolist(),
                        "inputs": lap_inputs(tr, step), "model_phases": model_phases(env, sim, step)}
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
