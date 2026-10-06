"""What the car has shown it can do at each place of the track: the limits the perfect lap drives at.

A perfect lap is only as believable as its limits. One grip envelope for the whole track lends the grip of one
corner to every other: a banked or cambered corner, a crest, a dip, a bumpy braking zone or a kerb the car can use
all change what the accelerometers show at the limit there, and no car uses its whole friction circle (full braking
and full cornering at once) everywhere, as an envelope assumes. So the limits are kept place by place, every
PLACE_STEP_M metres along the line, from what the quick laps did within PLACE_WINDOW_M of the place:

- the most cornering (lateral g) a lap held there;
- for every share of that, the hardest braking and the hardest acceleration a lap pulled there while cornering at
  least that hard: the car's own combined grip at that place, never a shape borrowed from elsewhere;
- full throttle as the car's power curve against speed (a = P/v + r - c v^2: power, rolling drag and air drag) plus
  what each place adds or takes (a gear change, the slope of the road), so arriving faster gives less acceleration;
- the top speed.

Across the laps each limit is a percentile: PERFECT takes a high one (the place's best, not one lap's spike, and the
upper quartile of the drive at full throttle, gear changes included); REALISTIC the median (what a quick lap usually
shows there). The fastest lap's own limits (own=True: the same limits from that lap alone, plus its own values at the
place itself as its line reads them) are a floor: neither asks the car for less than the fastest lap showed there, so
perfect driving at either is nowhere slower than at the fastest lap's own (lapsim.Calibration). Where most laps were
flat out the grip was not the limit, so the corner speed there may use the cornering the car shows in its other
corners, per unit of the road's vertical load (track_shape.py): learned on the corners away from banked corners,
crests and compressions, and lent at the load of the place it is lent to.

Accelerations are the accelerometer's less the slope of the road at the place (the slope shows as a steady offset
between the accelerometer and the change in speed), so braking and drive are the car's, not gravity's. Cornering
stays in the accelerometer's units, as the line's curvature does (lapsim.py): a banked corner that shows more
lateral g keeps it, and lends it to no other corner.
"""
from __future__ import annotations

from array import array
from collections.abc import Callable
from dataclasses import dataclass, field

import numpy as np

from app.analysis.channels import POWER, G

PLACE_STEP_M = 5
PLACE_WINDOW_M = 20  # a place's limits come from this far either side of it
REFERENCE_WINDOW_M = 3  # the fastest lap's own values count only this close to the place
LEVELS = np.linspace(0.0, 1.0, 21)  # shares of a place's cornering limit the braking and drive are kept at
GRADE_WINDOW_M = 50  # the slope of the road: the accelerometer's steady offset over this far either side
KINETIC_SMOOTH_M = 5
DRIVE_WINDOW_M = 10  # what a place adds to the power curve: each lap's mean over this far either side
FULL_THROTTLE = 95.0  # % pedal
FLAT_SHARE = 0.5  # a place most laps take flat out is limited by power, not grip
POWER_BINS_KMH = np.arange(60.0, 330.0, 10.0)
POWER_BIN_SAMPLES = 30
STRAIGHT_G = 0.3  # the power curve is fitted on full throttle with less cornering than this
TOP_SPEED_PERCENTILE = 99.9
CORNER_PERCENTILE = 95  # the car's cornering, for places taken flat out: this percentile of its corners' limits
CHUNK = 64  # places worked at a time, so many laps fit in little memory
CURVE_SMOOTH_M = 9  # a line's curvature is smoothed over this many metres for the lap simulation


@dataclass(frozen=True)
class Percentiles:
    grip: float  # across laps, for cornering, braking and acceleration at each place
    drive: float  # for what a place adds to the power curve at full throttle


PERFECT = Percentiles(90, 75)
REALISTIC = Percentiles(50, 50)


@dataclass
class PlaceLimits:
    step: int  # metres between places; place j is centred on metre j * step
    lateral: np.ndarray  # g per place: the cornering shown there
    corner: np.ndarray  # g per place: what the corner speed may use (the car's cornering where taken flat out)
    brake: np.ndarray  # g (positive), [place, level]: braking shown while cornering at >= LEVELS x lateral
    accel: np.ndarray  # g, [place, level]: acceleration shown while cornering at >= LEVELS x lateral
    power: tuple[float, float, float]  # full throttle against speed v (m/s): c0 / v + c1 + c2 v^2, in g
    drive: np.ndarray  # g per metre of the line: what the place adds to the power curve at full throttle
    grade: np.ndarray  # g per metre: the slope of the road as the accelerometer reads it
    top_speed: float  # km/h
    floor: PlaceLimits | None = field(default=None, repr=False, compare=False)  # braking and acceleration never below
    _tables: dict = field(default_factory=dict, repr=False, compare=False)

    @property
    def length(self) -> int:  # metres of the line the limits were learned on
        return len(self.drive)

    def metre_index(self, n: int) -> np.ndarray:
        """For a line of n metres (another lap of the same track), the metre of this line each one maps to."""
        if n == self.length:
            return np.arange(n)
        return np.minimum((np.arange(n) * self.length) // max(n, 1), self.length - 1)

    def place_of(self, metres: np.ndarray) -> np.ndarray:
        return np.rint(np.asarray(metres) / self.step).astype(int) % len(self.lateral)

    def full_throttle(self, v: float | np.ndarray) -> float | np.ndarray:
        """The power curve: acceleration at full throttle at v (m/s) on a straight, before the place's own part."""
        c0, c1, c2 = self.power
        s = np.maximum(v, 30 / 3.6)
        return c0 / s + c1 + c2 * s * s

    def tables(self, ay_step: float, ay_max: float) -> tuple[array, array, int]:
        """Acceleration and braking (g) for every place against cornering g in steps of ay_step, flat (place by
        place, cols values each) for the lap simulation's quick lookups, and cols. Never below the floor's at the
        same cornering, so that perfect driving at these limits is nowhere slower than at the floor."""
        key = (ay_step, ay_max)
        if key not in self._tables:
            out = []
            grid = self._grid(ay_step, ay_max)
            for t in grid:
                flat = array("d")
                flat.frombytes(np.ascontiguousarray(t, dtype=np.float64).tobytes())
                out.append(flat)
            self._tables[key] = (out[0], out[1], grid[0].shape[1])
        return self._tables[key]

    def _grid(self, ay_step: float, ay_max: float, keep: bool = False) -> list[np.ndarray]:
        """Acceleration and braking (g), [place, cornering g in steps of ay_step], never below the floor's. keep:
        kept for the next call, for limits that are the floor of many (one lap's own line after another)."""
        key = ("grid", ay_step, ay_max)
        if key in self._tables:
            return self._tables[key]
        ayg = np.arange(0, ay_max + ay_step / 2, ay_step)
        lat = np.maximum(self.lateral, 1e-3)
        out = [np.array([np.interp(ayg, LEVELS * lv, row) for lv, row in zip(lat, table, strict=True)])
               for table in (self.accel, self.brake)]
        if self.floor is not None:
            out = [np.maximum(t, f) for t, f in zip(out, self.floor._grid(ay_step, ay_max, keep=True), strict=True)]
        if keep:
            self._tables[key] = out
        return out

    def to_dict(self) -> dict:
        return {"step_m": self.step, "lateral_g": np.round(self.lateral, 2).tolist(),
                "corner_g": np.round(self.corner, 2).tolist(),
                "brake_g": np.round(self.brake[:, 0], 2).tolist(), "accel_g": np.round(self.accel[:, 0], 2).tolist(),
                "power": [round(float(c), 4) for c in self.power], "top_speed_kmh": round(self.top_speed, 1)}

    @classmethod
    def uniform(cls, n: int, lateral: float, brake: float, accel: float, power: tuple[float, float, float],
                top_speed: float, step: int = PLACE_STEP_M) -> PlaceLimits:
        """The same limits everywhere on a line of n metres, braking and acceleration falling off with cornering
        round a friction circle: for tests and examples."""
        places = int(np.ceil(n / step))
        circle = np.sqrt(np.clip(1 - LEVELS**2, 0, 1))
        return cls(step, np.full(places, lateral), np.full(places, lateral), np.tile(brake * circle, (places, 1)),
                   np.tile(accel * circle, (places, 1)), power, np.zeros(n), np.zeros(n), top_speed)


def smoothed_curvature(curvature: np.ndarray) -> np.ndarray:
    """|curvature| (1/m) over CURVE_SMOOTH_M round the closed line: the path a car can follow at speed."""
    w = CURVE_SMOOTH_M | 1
    k = np.convolve(np.pad(np.abs(np.asarray(curvature, float)), w // 2, mode="wrap"), np.ones(w) / w, "valid")
    return np.maximum(k, 1e-5)


def _kinetic(v_kmh: np.ndarray) -> np.ndarray:
    """Acceleration (g) from the change in speed along the line, per metre: what moves the car, slope included."""
    v = v_kmh.astype(float) / 3.6
    w = 2 * KINETIC_SMOOTH_M + 1
    e = np.convolve(np.pad(0.5 * v * v, KINETIC_SMOOTH_M, mode="edge"), np.ones(w) / w, "valid")
    return np.gradient(e) / G


def _moving(x: np.ndarray, half: int) -> np.ndarray:
    """Moving sum over +-half metres, round the closed lap, for every row."""
    w = 2 * half + 1
    c = np.cumsum(np.pad(x, ((0, 0), (half + 1, half)), mode="wrap"), axis=1)
    return c[:, w:] - c[:, :-w]


def _power_fit(v: np.ndarray, a: np.ndarray) -> tuple[float, float, float] | None:
    """a = c0 / v + c1 + c2 v^2 through the median acceleration in each 10 km/h of full throttle on the straight."""
    meds, speeds = [], []
    for b in POWER_BINS_KMH:
        m = np.abs(v - b) < 5
        if np.count_nonzero(m) > POWER_BIN_SAMPLES:
            meds.append(float(np.median(a[m])))
            speeds.append(b / 3.6)
    if len(speeds) < 3:
        return None
    s, y = np.array(speeds), np.array(meds)
    x = np.c_[1 / s, np.ones(len(s)), s**2]
    best: tuple[float, np.ndarray] | None = None
    for cols in ((0, 1, 2), (1, 2), (0, 1), (1,)):  # power never negative, drag never pushing: the best fit that obeys
        coef = np.zeros(3)
        coef[list(cols)] = np.linalg.lstsq(x[:, cols], y, rcond=None)[0]
        if coef[0] < 0 or coef[2] > 0:
            continue
        err = float(np.sum((x @ coef - y) ** 2))
        if best is None or err < best[0]:
            best = (err, coef)
    assert best is not None
    return float(best[1][0]), float(best[1][1]), float(best[1][2])


NO_POWER_CURVE = (0.0, 10.0, 0.0)  # no straights to learn the power curve from: grip alone limits the drive
_SPAN = np.arange(-PLACE_WINDOW_M, PLACE_WINDOW_M + 1)
_NEAR = np.arange(-REFERENCE_WINDOW_M, REFERENCE_WINDOW_M + 1)


def _full_of(tr: dict[str, np.ndarray], n: int) -> np.ndarray:
    if "throttle" in tr:
        return np.asarray(tr["throttle"][:n]) > FULL_THROTTLE
    return np.rint(np.asarray(tr["phase"][:n], float)).astype(int) == POWER


def _over_curve(power: tuple[float, float, float]) -> Callable[[np.ndarray, np.ndarray], np.ndarray]:
    """Acceleration a beyond the power curve at speed v (km/h); none without a power curve."""
    def over(v: np.ndarray, a: np.ndarray) -> np.ndarray:
        if power == NO_POWER_CURVE:
            return np.zeros_like(a)
        s = np.maximum(v, 30.0) / 3.6
        return a - (power[0] / s + power[1] + power[2] * s * s)
    return over


@dataclass
class _Own:
    """What one lap shows at every metre of its line (n metres), read as place_limits reads the laps: its cornering,
    and at the place itself its cornering as perfect driving on its line reads it (the line's curvature smoothed,
    lapsim.py); its braking and drive with the slope of the road taken off; its drive beyond the power curve (its
    mean near each metre where it was flat out, else none: the power curve alone); its top speed."""
    n: int
    lat: np.ndarray
    line: np.ndarray
    lon: np.ndarray
    drive: np.ndarray
    top: float

    @classmethod
    def of(cls, tr: dict[str, np.ndarray], n: int, grade: np.ndarray,
           over_curve: Callable[[np.ndarray, np.ndarray], np.ndarray]) -> _Own:
        speed = np.asarray(tr["speed"][:n], float)
        v = speed / 3.6
        line = (v * v * smoothed_curvature(np.asarray(tr["curvature"], float)[:n]) / G).astype(np.float32)
        lat = np.abs(np.asarray(tr["ay"][:n], float)).astype(np.float32)
        lon = (np.asarray(tr["ax"][:n], float) - grade).astype(np.float32)
        full = _full_of(tr, n)
        count = _moving(full[None, :].astype(float), DRIVE_WINDOW_M)[0]
        total = _moving(np.where(full, over_curve(speed, lon), 0.0)[None, :], DRIVE_WINDOW_M)[0]
        drive = np.where(count >= 0.5 * (2 * DRIVE_WINDOW_M + 1), total / np.maximum(count, 1), 0.0)
        top = float(np.percentile(np.asarray(tr["speed"], float), TOP_SPEED_PERCENTILE))
        return cls(n, lat, line, lon, drive, top)

    def near(self, centres: np.ndarray, laps_window: bool = True) -> tuple[np.ndarray, np.ndarray]:
        """Its cornering, and its braking and drive, near each of these places (places x samples): within
        PLACE_WINDOW_M as the laps' are read (unless laps_window is False), and within REFERENCE_WINDOW_M as its line
        reads it."""
        ridx = (centres[:, None] + _NEAR[None, :]) % self.n
        if not laps_window:
            return self.line[ridx], self.lon[ridx]
        idx = (centres[:, None] + _SPAN[None, :]) % self.n
        return (np.concatenate([self.lat[idx], self.line[ridx]], axis=1),
                np.concatenate([self.lon[idx], self.lon[ridx]], axis=1))


def _shown_at(lat: np.ndarray, lon: np.ndarray, thr: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Per place (rows of samples), the hardest braking and acceleration (g, never below zero) among the samples
    cornering at least thr."""
    m = lat >= thr[:, None]
    return (np.maximum(np.where(m, -lon, -np.inf).max(axis=1), 0),
            np.maximum(np.where(m, lon, -np.inf).max(axis=1), 0))


def place_limits(traces: list[dict[str, np.ndarray]], reference: dict[str, np.ndarray] | None = None,
                 percentiles: tuple[Percentiles, ...] = (PERFECT, REALISTIC), own: bool = False, *,
                 load: np.ndarray | None = None, shaped: np.ndarray | None = None) -> list[PlaceLimits]:
    """The limits at every place, one set per percentiles, from the quick laps' traces (on the line's distance grid,
    timing line at both ends, with math channels). reference: the fastest lap, whose own limits are the floor of
    every set. own: also its own limits, last: what that lap alone shows at every place, read as the laps' are, and
    at the place itself its cornering as perfect driving on its line reads it (the line's curvature smoothed,
    lapsim.py), so that at no more than its speed, perfect driving has at least its grip at every metre.
    load: the road's vertical load (g) at every metre (track_shape.py), shaped: the metres of its banked corners,
    crests and compressions; both for the cornering lent to places taken flat out."""
    if own and reference is None:
        raise ValueError("own limits need the reference lap")
    n = len(traces[0]["speed"]) - 1
    nl = len(traces)
    f32 = np.float32

    def rows(key: str) -> np.ndarray:
        return np.array([np.asarray(tr[key][:n], float) for tr in traces])

    speed = rows("speed")
    ax = rows("ax")
    kin = np.array([_kinetic(np.asarray(tr["speed"], float))[:n] for tr in traces])
    grade = np.median(_moving(ax - kin, GRADE_WINDOW_M) / (2 * GRADE_WINDOW_M + 1), axis=0)
    lon = (ax - grade).astype(f32)  # the car's own braking and drive
    del kin, ax
    lat = np.abs(rows("ay")).astype(f32)
    full = np.array([_full_of(tr, n) for tr in traces])

    # full throttle: the power curve, and each place's own part as a percentile of the laps' means there
    straight = full & (lat < STRAIGHT_G)
    fit = _power_fit(speed[straight], lon[straight])
    power = fit if fit is not None else NO_POWER_CURVE
    over_curve = _over_curve(power)

    # each lap's mean over DRIVE_WINDOW_M either side of every metre, where it was flat out for at least half of it
    left = np.where(full, over_curve(speed, lon), 0.0)
    count = _moving(full.astype(float), DRIVE_WINDOW_M)
    lap_means = np.where(count >= 0.5 * (2 * DRIVE_WINDOW_M + 1),
                         _moving(left, DRIVE_WINDOW_M) / np.maximum(count, 1), np.nan)
    del left, count
    shown = np.sum(~np.isnan(lap_means), axis=0) >= max(1.0, 0.2 * nl)
    top = float(np.percentile(speed, TOP_SPEED_PERCENTILE))
    del speed

    if reference is not None:
        ref = _Own.of(reference, n, grade, over_curve)
        top = max(top, ref.top)

    sets: list[Percentiles | None] = [*percentiles, *([None] if reference is not None else [])]  # None: its own
    centres = np.arange(0, n, PLACE_STEP_M)
    places = len(centres)
    out_lat = np.zeros((len(sets), places))
    out_brk = np.zeros((len(sets), places, len(LEVELS)))
    out_acc = np.zeros((len(sets), places, len(LEVELS)))
    flat = np.zeros(places, bool)
    for c0_ in range(0, places, CHUNK):
        cs = centres[c0_:c0_ + CHUNK]
        sl = slice(c0_, c0_ + len(cs))
        idx = (cs[:, None] + _SPAN[None, :]) % n  # places x window
        lw, aw = lat[:, idx], lon[:, idx]  # laps x places x window
        flat[sl] = np.mean(full[:, idx].all(axis=2), axis=0) >= FLAT_SHARE
        peak = lw.max(axis=2)
        if reference is not None:
            ol, oa = ref.near(cs)
            own_lv = ol.max(axis=1)
        for p, pc in enumerate(sets):
            if pc is None:
                lv = own_lv
            else:
                lv = np.percentile(peak, pc.grip, axis=0)
                if reference is not None:
                    lv = np.maximum(lv, own_lv)
            out_lat[p, sl] = lv
            for j, share in enumerate(LEVELS):
                thr = (share * lv - 1e-6).astype(f32)
                b = a = np.zeros(len(cs))
                if pc is not None:
                    m = lw >= thr[None, :, None]
                    brk = np.maximum(np.where(m, -aw, -np.inf).max(axis=2), 0)
                    acc = np.maximum(np.where(m, aw, -np.inf).max(axis=2), 0)
                    b, a = np.percentile(brk, pc.grip, axis=0), np.percentile(acc, pc.grip, axis=0)
                    del m
                if reference is not None:  # never less than the fastest lap's own at the same cornering
                    ob, oa_ = _shown_at(ol, oa, thr)
                    b, a = np.maximum(b, ob), np.maximum(a, oa_)
                out_brk[p, sl, j], out_acc[p, sl, j] = b, a
        del lw, aw

    # the car's cornering for the places taken flat out is compared per unit of the road's load: learned on the
    # corners whose grip is the car's own (no banked corner, crest or compression within the place's window), and
    # lent at each place's own load
    lift = np.ones(places) if load is None else np.asarray(load, float)[centres]
    learn = ~flat
    if shaped is not None:
        apart = _moving(np.asarray(shaped[:n], float)[None, :], PLACE_WINDOW_M)[0][centres] > 0
        if (learn & ~apart).any():
            learn &= ~apart
    out = []
    for p, pc in enumerate(sets):
        lv = out_lat[p]
        per_load = lv / lift
        car = float(np.percentile(per_load[learn] if learn.any() else per_load, CORNER_PERCENTILE))
        if pc is None:
            drive = ref.drive
        else:
            drive = np.zeros(n)  # where no lap was at full throttle, the power curve alone
            if shown.any():
                drive[shown] = np.nanpercentile(lap_means[:, shown], pc.drive, axis=0)
            if reference is not None:
                drive = np.maximum(drive, ref.drive)
        out.append(PlaceLimits(
            step=PLACE_STEP_M, lateral=lv, corner=np.where(flat, np.maximum(lv, car * lift), lv),
            brake=np.minimum.accumulate(out_brk[p], axis=1), accel=np.minimum.accumulate(out_acc[p], axis=1),
            power=power, drive=drive, grade=grade, top_speed=ref.top if pc is None else top))
    if reference is not None:  # the fastest lap's own, as perfect driving reads them, are every set's floor
        for lim in out[:-1]:
            lim.floor = out[-1]
        if not own:
            out.pop()
    return out


def on_own_line(lim: PlaceLimits, trace: dict[str, np.ndarray]) -> PlaceLimits:
    """The limits perfect driving takes on one lap's own line (a lap simulated on its own, as the technique check
    and a lap's own-line theoretical lap do): lim, and where this lap's line asks for more cornering than lim's laps
    ever showed at a place, what this lap itself showed there.

    lim comes from the quick laps, on their lines. Where this lap's line turns and theirs did not (a move across the
    road on a straight to pass or to take a tow, a different line through a flat kink), the little cornering they
    showed there is no grip limit: held to it, perfect driving brakes hard for the swerve and, in a braking zone
    where no lap accelerated, stays slow to the next corner, seconds slower than the lap itself. At such a place the
    lap's own cornering as its line reads it at its speed, and its braking and drive while cornering that hard, are
    a floor, as the fastest lap's own are lim's; everywhere else lim is unchanged, so the fastest lap gets lim back.

    trace: the lap on lim's distance grid (the timing line at both ends), with math channels. The limits returned
    have the lap's own cornering, braking and acceleration at those places (none elsewhere) as their own, lim as
    their floor, and lim's corner speed raised to the lap's cornering there."""
    n = lim.length
    if len(trace["speed"]) != n + 1:  # another grid: stretched onto lim's
        m = len(trace["speed"]) - 1
        at = np.linspace(0.0, m, n + 1)
        trace = {k: np.interp(at, np.arange(m + 1), np.asarray(trace[k], float))
                 for k in ("speed", "ay", "ax", "curvature", "throttle", "phase") if k in trace}
    own = _Own.of(trace, n, lim.grade, _over_curve(lim.power))
    # at each place, its cornering as its own line reads it at its speed, and its braking and drive (few samples)
    ol, oa = own.near(np.arange(0, n, lim.step), laps_window=False)
    lv = ol.max(axis=1).astype(float)
    beyond = lv > lim.lateral  # more than lim's laps showed there
    # at every share of its cornering at once (places x samples x levels), as place_limits reads them level by level
    m = (ol[:, :, None] >= (LEVELS[None, :] * lv[:, None] - 1e-6).astype(np.float32)[:, None, :]) \
        & beyond[:, None, None]
    brk = np.maximum(np.where(m, -oa[:, :, None], -np.inf).max(axis=1), 0)
    acc = np.maximum(np.where(m, oa[:, :, None], -np.inf).max(axis=1), 0)
    del m
    return PlaceLimits(step=lim.step, lateral=lv, corner=np.where(beyond, np.maximum(lim.corner, lv), lim.corner),
                       brake=np.minimum.accumulate(brk, axis=1), accel=np.minimum.accumulate(acc, axis=1),
                       power=lim.power, drive=lim.drive, grade=lim.grade, top_speed=lim.top_speed, floor=lim)
