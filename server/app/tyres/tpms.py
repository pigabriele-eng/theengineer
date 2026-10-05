"""Cold and hot tyre pressures measured by the TPMS in a log: the evidence for the pressure model.

The sensors sleep while the car stands and wake once the wheels turn, so where a corner's TPMS first reports
after the car starts rolling is the pressure set in the garage, at the tyre's temperature then (a cold start).
A tyre set fitted at a stop wakes up cold again and starts a new run. The hot pressure is where the pressure
settles in the first stint long enough to stabilise. A stop on the way (an out-lap check) is crossed only when
no air was let out; once a stop lets air out, the run ends there.
"""
from __future__ import annotations

from dataclasses import asdict, dataclass

import numpy as np

from app.importers.motec import Channel, LdFile
from app.tyres.gaslaw import hot_from_cold
from app.tyres.presets import ATMOSPHERIC_BAR

CORNERS = ("FL", "FR", "RL", "RR")
PRESSURE_CHANNELS = {c: (f"pTyre{c}", f"Tyre Pres {c}", f"Tyre Pressure {c}") for c in CORNERS}
TEMP_CHANNELS = {c: (f"TTyre{c}", f"Tyre Temp {c}", f"Tyre Air Temp {c}") for c in CORNERS}
SPEED_CHANNELS = ("vCar", "Ground Speed", "Corr Speed", "GPS Speed", "Speed")
AMBIENT_CHANNELS = ("TAmbient", "Air Temp", "Ambient Temp")
ATMOSPHERE_CHANNELS = ("pAmbient", "Baro Pressure", "Barometric Pressure")

NO_REPORT_BAR = 0.05  # the dash logs 0 bar for a sensor that is not reporting
NO_REPORT_C = -40  # ... and -50 °C
ROLLING_KMH = 5
RACING_KMH = 60  # hot pressures and the ambient temperature only from samples at racing speed
REPORT_GAP_S = 30  # a sensor silent this long has gone to sleep (a stop, or a wheel change)
SETTLE_S = 3  # the first seconds after a sensor wakes read nonsense, e.g. -33 °C
COLD_WINDOW_S = 10  # cold pressure and temperature: the median over this long once settled
LATE_REPORT_S = 60  # a sensor that first reports after this much running at speed missed the cold pressure
NEW_SET_DROP_C = 20  # a sensor waking this much colder than it went to sleep is on a new tyre set
SAME_SET_S = 300  # cold starts of different corners this close together are one tyre set
STOP_S = 20  # standing still this long ends a stint
BLEED_BAR = 0.06  # pressure this much lower after a stop than before it: air was let out
STINT_EDGE_S = 10  # pressure just before a stop and just after it: the median over this many seconds
MIN_HOT_RUNNING_S = 720  # running at speed in one stint before the pressure counts as settled (within ~0.03 bar)
HOT_WINDOW_S = 120  # hot pressure: the median over the last 2 minutes of running at speed in that stint
STABLE_BAR = 0.04  # the hot window may be at most this much above the 2 minutes before it


@dataclass
class CornerRun:
    corner: str
    start_s: float  # when the sensor first reported
    cold_bar: float
    cold_c: float | None
    hot_bar: float | None = None
    hot_c: float | None = None
    rise_bar: float | None = None
    running_s: float = 0.0  # seconds at racing speed from the cold start to the end of the hot window
    gas_law_hot_bar: float | None = None  # what the gas law expects from the cold reading and the hot temperature
    used: bool = False
    note: str | None = None  # why it can't be used, if it can't

    def to_dict(self) -> dict:
        return {k: round(v, 3) if isinstance(v, float) else v for k, v in asdict(self).items()}


def _per_second(ch: Channel, n: int, invalid_below: float | None = None, reduce=np.nanmedian) -> np.ndarray:
    """One value per second (nan where the channel holds no valid sample)."""
    v = ch.values().astype(float)
    if invalid_below is not None:
        v[v <= invalid_below] = np.nan
    f = max(int(ch.freq), 1)
    m = min(n, len(v) // f)
    out = np.full(n, np.nan)
    if m:
        block = v[: m * f].reshape(m, f)
        has = ~np.all(np.isnan(block), axis=1)
        out[:m][has] = reduce(block[has], axis=1)
    return out


def _median(x: np.ndarray) -> float | None:
    x = x[~np.isnan(x)]
    return float(np.median(x)) if len(x) else None


def _blocks(reporting: np.ndarray) -> list[tuple[int, int]]:
    """Stretches of seconds where the sensor reports, joined across gaps shorter than REPORT_GAP_S."""
    idx = np.flatnonzero(reporting)
    if not len(idx):
        return []
    out, start, last = [], idx[0], idx[0]
    for i in idx[1:]:
        if i - last > REPORT_GAP_S:
            out.append((int(start), int(last) + 1))
            start = i
        last = i
    out.append((int(start), int(last) + 1))
    return out


def _stops(v: np.ndarray) -> list[tuple[int, int]]:
    """Seconds where the car stood still for at least STOP_S."""
    still = np.concatenate([[False], v < ROLLING_KMH, [False]])
    edges = np.flatnonzero(np.diff(still.astype(int)))
    return [(int(a), int(b)) for a, b in zip(edges[::2], edges[1::2], strict=True) if b - a >= STOP_S]


def logger_conditions(ld: LdFile) -> dict:
    """Ambient temperature (at racing speed: the sensor heat-soaks in the pits) and air pressure from the logger."""
    out: dict = {}
    speed = ld.channel(*SPEED_CHANNELS)
    amb = ld.channel(*AMBIENT_CHANNELS)
    if speed is not None and amb is not None:
        n = int(speed.duration)
        v = _per_second(speed, n, reduce=np.nanmean)
        t = _per_second(amb, n, invalid_below=NO_REPORT_C)
        value = _median(t[v > RACING_KMH])
        if value is not None:
            out["ambient_c"] = round(value, 1)
    baro = ld.channel(*ATMOSPHERE_CHANNELS)
    if baro is not None:
        vals = baro.values()
        vals = vals[vals > 0]
        if len(vals):
            p = float(np.median(vals))
            p = p / 1000 if p > 500 else p / 100 if p > 50 else p  # mbar or kPa to bar
            if 0.7 < p < 1.1:
                out["atmospheric_bar"] = round(p, 3)
    return out


def measure_runs(ld: LdFile) -> list[dict]:
    """Every cold start in the log, as runs: {"set": n, "start_s", "corners": {corner: CornerRun dict}}.

    Set 0 is the tyres the car left on; set 1 the next set fitted at a stop, and so on.
    """
    speed = ld.channel(*SPEED_CHANNELS)
    if speed is None:
        return []
    n = int(speed.duration)
    v = _per_second(speed, n, reduce=np.nanmean)
    atmospheric = logger_conditions(ld).get("atmospheric_bar", ATMOSPHERIC_BAR)
    found: list[CornerRun] = []
    for corner in CORNERS:
        pch, tch = ld.channel(*PRESSURE_CHANNELS[corner]), ld.channel(*TEMP_CHANNELS[corner])
        if pch is None:
            continue
        p = _per_second(pch, n, invalid_below=NO_REPORT_BAR)
        if np.all(np.isnan(p)):
            continue
        if np.nanmedian(p) > 50:  # some systems log kPa
            p = p / 100
        temp = _per_second(tch, n, invalid_below=NO_REPORT_C) if tch is not None else np.full(n, np.nan)
        found += corner_runs(corner, v, p, temp, atmospheric)
    # the four sensors of one set wake within a few minutes of each other
    sets: list[dict[str, CornerRun]] = []
    for r in sorted(found, key=lambda r: r.start_s):
        if not sets or r.corner in sets[-1] or r.start_s - min(x.start_s for x in sets[-1].values()) > SAME_SET_S:
            sets.append({})
        sets[-1][r.corner] = r
    return [{"set": i, "start_s": round(min(r.start_s for r in runs.values()), 1),
             "corners": {c: runs[c].to_dict() for c in CORNERS if c in runs}}
            for i, runs in enumerate(sets)]


def corner_runs(corner: str, v: np.ndarray, p: np.ndarray, temp: np.ndarray,
                atmospheric: float = ATMOSPHERIC_BAR) -> list[CornerRun]:
    """Cold starts of one corner and the hot pressure each reached; one value per second in v, p and temp."""
    blocks = _blocks(~np.isnan(p))
    stops = _stops(v)
    starts = []
    for k, (a, _) in enumerate(blocks):
        if k == 0:
            # a sensor already reporting when the log starts holds the last run's values, not a cold start
            if a > 0 and np.any(v[: a + 1] > ROLLING_KMH):
                starts.append(k)
            continue
        before, after = _median(temp[max(blocks[k - 1][1] - STINT_EDGE_S, 0): blocks[k - 1][1]]), \
            _median(temp[a + SETTLE_S: a + SETTLE_S + COLD_WINDOW_S])
        if before is not None and after is not None and before - after >= NEW_SET_DROP_C:
            starts.append(k)
    runs = []
    for j, k in enumerate(starts):
        end = blocks[starts[j + 1]][0] if j + 1 < len(starts) else len(p)
        runs.append(_measure(corner, blocks[k][0], end, v, p, temp, stops, atmospheric))
    return runs


def _measure(corner: str, a: int, end: int, v: np.ndarray, p: np.ndarray, temp: np.ndarray,
             stops: list[tuple[int, int]], atmospheric: float) -> CornerRun:
    win = slice(a + SETTLE_S, a + SETTLE_S + COLD_WINDOW_S)
    cold_bar, cold_c = _median(p[win]), _median(temp[win])
    run = CornerRun(corner, float(a), round(cold_bar if cold_bar is not None else float(p[a]), 3), cold_c)
    last_stand = max([b for _, b in stops if b <= a] or [0])
    racing = v > RACING_KMH
    early = int(np.count_nonzero(racing[last_stand:a]))
    if early > LATE_REPORT_S:
        run.note = f"The sensor first reported after {early} s at speed, so it missed the cold pressure."
        return run

    # the first stint long enough to stabilise, crossing earlier stops where no air was let out
    seg_start = a
    for s0, s1 in [*[s for s in stops if a < s[0] < end], (end, end)]:
        running = np.flatnonzero(racing[seg_start:s0] & ~np.isnan(p[seg_start:s0])) + seg_start
        if len(running) >= MIN_HOT_RUNNING_S:
            return _hot(run, running, a, p, temp, racing, atmospheric)
        if s0 >= end:
            break
        before = _median(p[max(s0 - STINT_EDGE_S, seg_start):s0])
        after_idx = np.flatnonzero(~np.isnan(p[s1:end]) & (v[s1:end] > ROLLING_KMH))[:STINT_EDGE_S] + s1
        after = _median(p[after_idx]) if len(after_idx) else None
        if before is not None and after is not None and before - after > BLEED_BAR:
            run.note = (f"Air was let out at the stop after {round(len(running) / 60)} min at speed, before the "
                        "pressure had settled.")
            return run
        seg_start = s1
    run.note = "The tyres never ran long enough at speed in one stint for the pressure to settle (12 minutes)."
    return run


def _hot(run: CornerRun, running: np.ndarray, a: int, p: np.ndarray, temp: np.ndarray, racing: np.ndarray,
         atmospheric: float) -> CornerRun:
    window, previous = running[-HOT_WINDOW_S:], running[-2 * HOT_WINDOW_S:-HOT_WINDOW_S]
    first, second = _median(p[previous]), _median(p[window])
    run.hot_bar = round(float(np.nanmedian(p[window])), 3)
    run.hot_c = _median(temp[window])
    run.rise_bar = round(run.hot_bar - run.cold_bar, 3)
    run.running_s = float(np.count_nonzero(racing[a: window[-1] + 1]))
    if run.cold_c is not None and run.hot_c is not None:
        run.gas_law_hot_bar = round(hot_from_cold(run.cold_bar, run.cold_c, run.hot_c, atmospheric), 3)
    if first is not None and second is not None and second - first > STABLE_BAR:
        run.note = "The pressure was still rising at the end of the stint."
    else:
        run.used = True
    return run
