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
from app.analysis.lapsim import Calibration, LapModel, SimLap
from app.analysis.laps import Section
from app.analysis.local_limits import PlaceLimits

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


def check_lap(tr: dict[str, np.ndarray], perfect: PlaceLimits, held: PlaceLimits, sections: list[Section], *,
              lap_time: float, units: dict[str, str] | None = None, detail: bool = True,
              calibrations: tuple[Calibration | None, Calibration | None] = (None, None)) -> dict:
    """The lap's mistakes against perfect driving, most costly first, and how the gap to the perfect lap splits:
    named mistakes, losses with the pedals at the limit, the perfect lap's optimism, the pit lane and what no single
    mistake explains.

    tr: the lap's trace on the line (every metre, timing line at both ends). perfect and held: the limits the car has
    shown at every place, at their best and as a quick lap usually shows them (the report's theoretical lap and
    realistic target); calibrations: the model's own error at every metre at each, as the report's targets have it
    (Prepared.calibration and held_calibration)."""
    units = units or {}
    env, env_r = (Envelope(tr["curvature"], lim, cal) for lim, cal in zip((perfect, held), calibrations, strict=True))
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
    }
    if detail:
        step = TRACE_STEP_M
        out["trace"] = {"step_m": step,
                        "driven": np.round(tr["speed"][::step], 1).tolist(),
                        "perfect": np.round(sim.speed[::step], 1).tolist(),
                        "realistic": np.round(realistic.speed[::step], 1).tolist()}
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
