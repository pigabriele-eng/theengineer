"""Any laps from any runs at one track, side by side: where the time is, what the driver did differently there,
and the traces to see it.

The laps are placed on one GPS line (align.py) taken from the quickest of them, so laps from different runs and
drivers meet metre for metre. Runs are read one at a time and only the picked laps' traces are kept, so laps
from six hour-long logs fit in a small server.
"""
from __future__ import annotations

import gc
from collections.abc import Callable
from contextlib import AbstractContextManager, nullcontext
from dataclasses import dataclass, field
from itertools import pairwise

import numpy as np

from app.analysis.align import aligned_trace, track_line
from app.analysis.channels import BRAKE, EXIT, MID, PHASES, POWER, TRAIL, math_channels
from app.analysis.insights import LapRecord, _dt, section_metrics
from app.analysis.lappack import NotCovered, PackedRun
from app.analysis.laps import CornerSpec, Lap, Section, SessionData, corner_sections, lap_length, make_sections
from app.analysis.lapsim import SimLap
from app.analysis.limits import car_limits
from app.analysis.track_shape import on_line, track_shape

MIN_LAPS, MAX_LAPS = 2, 6
MIN_LOSS_S = 0.01  # a section time this close to the quickest is not an opportunity
TOP_OPPORTUNITIES = 5
WHERE_M = 100  # the stretch of a section where most of the time goes, for the charts
# what section_metrics, the charts and the road's shape (grip per unit of its load) need; every other channel is
# dropped as soon as a lap is traced
KEEP = ("distance", "t", "speed", "throttle", "brake", "steer", "gear", "phase", "braking", "ax", "ay", "coasting",
        "overlap", "turn_g", "az", "altitude")
CHART_ROLES = {"speed": 1, "throttle": 0, "brake": 1, "steer": 1, "gear": 0}  # role -> decimals sent
PHASE_NAMES = {"braking": "braking", "trail": "entry", "mid": "mid-corner", "exit": "exit", "power": "full throttle"}

# Technique differences that explain time lost in each phase, the most telling first
EXPLAINS = {
    BRAKE: ("brake_point", "peak_brake", "grip_braking", "min_speed"),
    TRAIL: ("min_speed", "grip_trail", "brake_point", "coasting", "steering_activity"),
    MID: ("min_speed", "coasting", "grip_mid", "throttle_on", "steering_activity"),
    EXIT: ("throttle_on", "coasting", "min_speed", "grip_exit", "full_throttle", "steering_activity"),
    POWER: ("full_throttle", "throttle_on", "coasting", "min_speed", "grip_exit"),
}
GRIP_WORDS = {"grip_braking": "braking", "grip_trail": "turning in", "grip_mid": "mid-corner",
              "grip_exit": "on the exit"}
# metric -> (what it costs: positive when lap a is worse than the quicker lap b; the least worth saying; the words;
# the unit). Brake, throttle and full-throttle points are metres from the timing line.
COSTS: dict[str, tuple[Callable[[float, float], float], float, str, str]] = {
    "brake_point": (lambda a, b: b - a, 3, "brakes {:.0f} m earlier", "m"),
    "min_speed": (lambda a, b: b - a, 1, "minimum speed {:.0f} km/h lower", "km/h"),
    "throttle_on": (lambda a, b: a - b, 5, "picks up the throttle {:.0f} m later", "m"),
    "full_throttle": (lambda a, b: a - b, 5, "full throttle {:.0f} m later", "m"),
    "peak_brake": (lambda a, b: 100 * (b - a) / b if b > 0 else 0.0, 8, "brakes {:.0f} % less hard", "%"),
    "coasting": (lambda a, b: a - b, 0.1, "coasts {:.1f} s longer (off both pedals)", "s"),
    "steering_activity": (lambda a, b: a / b if b > 0 else 0.0, 1.3, "{:.1f} times the steering corrections", "x"),
    **{k: (lambda a, b: 100 * (b - a), 3, f"uses {{:.0f}} % less of the car's grip {w}", "%")
       for k, w in GRIP_WORDS.items()},
}
SCALE = {k: 100 for k in GRIP_WORDS}  # grip use is sent in %


@dataclass
class Pick:
    """One lap to compare. run names the log it is in (each run is read once, whatever number of its laps are
    picked); time is the lap time as stored, used to read the quickest lap's run first."""
    run: str
    number: int
    time: float
    meta: dict = field(default_factory=dict)  # passed through to the result (session, driver, ...)


@dataclass
class Traced:
    pick: Pick
    lap: Lap
    trace: dict[str, np.ndarray]


def compare_picks(picks: list[Pick], load: Callable[[str], SessionData], corners: list[CornerSpec] | None = None,
                  step: float = 5.0, guard: AbstractContextManager = nullcontext(),
                  packed: Callable[[str], PackedRun | None] | None = None) -> dict:
    """The picked laps on one line: section times, the ideal lap, where each lap loses time and why, and traces.

    load(run) reads one run; it is called once per run, the quickest lap's run first, and the run is let go
    before the next is read. guard is held from reading a run until it is let go (the server's one-log-at-a-time
    lock). packed(run), when given, is the run's lap pack and compact traces (lappack.py) if they hold every lap
    picked from it: those laps are then traced from them, without reading the log or taking the guard. corners are
    the track's official corners. Raises ValueError when a picked lap is not in its run.
    """
    if not MIN_LAPS <= len(picks) <= MAX_LAPS:
        raise ValueError(f"Pick {MIN_LAPS} to {MAX_LAPS} laps")
    order = list(dict.fromkeys(p.run for p in sorted(picks, key=lambda p: p.time)))
    traced: dict[int, Traced] = {}
    line = length = sources = None
    for run in order:
        mine = sorted(((i, p) for i, p in enumerate(picks) if p.run == run), key=lambda ip: ip[1].time)
        fast = packed(run) if packed is not None else None
        if fast is not None:
            try:
                got, line, length, sources = _from_pack(fast, mine, line, length, sources)
                traced.update(got)
                continue
            except NotCovered:  # not all there after all: from the log
                pass
        with guard:  # while this run's log is in memory
            data = load(run)
            math_channels(data)
            for i, p in mine:
                lap = next((l for l in data.laps if l.number == p.number), None)
                if lap is None:
                    raise ValueError(f"{p.meta.get('session', run)} has no lap {p.number}")
                if length is None:  # the quickest picked lap: its path is the line every lap is placed on
                    line = track_line(data, lap)
                    length = line.length if line is not None else round(lap_length(data, lap))
                    sources = data.sources
                tr = aligned_trace(data, lap, line, length)
                traced[i] = Traced(p, lap, {k: tr[k] for k in KEEP if k in tr})
            del data
            gc.collect()
    laps = [traced[i] for i in range(len(picks))]
    out = _summarise(laps, corners, step)
    out["aligned_by"] = "gps" if line is not None else "wheel speed"
    out["channels"] = {r: sources[r] for r in out["traces"]["roles"] if r in sources}
    return out


def _from_pack(run: PackedRun, mine: list[tuple[int, Pick]], line, length, sources):
    """compare_picks' tracing of one run's picked laps (the quickest first), from its lap pack: the same traces as
    from its log, but no log is read."""
    got = {}
    for i, p in mine:
        lap = run.pack.laps.get(p.number)
        if lap is None:
            raise NotCovered(f"lap {p.number} isn't in the pack")
        if length is None:  # the quickest picked lap: its path is the line every lap is placed on
            w = run.window(p.number)
            line = track_line(w, lap)
            length = line.length if line is not None else round(lap_length(w, lap))
            sources = run.own.sources
        got[i] = Traced(p, lap, run.trace(p.number, line, length, KEEP))
    return got, line, length, sources


def _summarise(laps: list[Traced], corners: list[CornerSpec] | None, step: float) -> dict:
    ref = min(laps, key=lambda x: x.lap.time)
    n = len(ref.trace["distance"])
    traces = [x.trace for x in laps]
    limits = car_limits(traces, *on_line(track_shape(traces), n))
    no_sim = SimLap(np.zeros(n), np.zeros(n), 0.0, np.zeros(n, int))  # section_metrics' theoretical time: unused
    sections, numbering = make_sections(ref.trace, corners)
    marks, _ = corner_sections(ref.trace, corners)
    at = {c[0]: c[1] for c in corners or [] if c[1] is not None}
    records = [LapRecord(x.pick.run, x.lap.number, x.lap.time, None, x.trace, 0) for x in laps]
    metrics = [[{**section_metrics(r, s, limits, no_sim), "corner_min": _corner_minimums(r.trace, s, at)}
                for s in sections] for r in records]
    times = np.array([[m["time"] for m in row] for row in metrics])  # [lap, section]
    best = times.argmin(axis=0)
    ideal = float(times.min(axis=0).sum())
    return {
        "length_m": n - 1,
        "numbering": numbering,
        "reference": laps.index(ref),
        "laps": [{**x.pick.meta, "run": x.pick.run, "lap": x.lap.number, "time": x.lap.time, "clean": x.lap.clean,
                  "sections_best": int(np.count_nonzero(best == i)),
                  "to_ideal": round(float(times[i].sum()) - ideal, 3)} for i, x in enumerate(laps)],
        "sections": [{**s.to_dict(), "corners": s.corners, "times": np.round(times[:, k], 3).tolist(),
                      "best": int(best[k])} for k, s in enumerate(sections)],
        "corners": [{"code": c.code, "apex_m": c.apex} for c in marks],  # one per section, as on the session page
        # every official corner on its own, to mark them in a section of several
        "track_corners": [{"code": code, "apex_m": round(m)} for code, m in sorted(at.items(), key=lambda kv: kv[1])
                          if 0 <= m < n],
        "ideal": {"time": round(ideal, 3), "from": [int(b) for b in best]},
        "opportunities": [_opportunities(i, laps, sections, metrics, times) for i in range(len(laps))],
        "traces": _traces(laps, sections, best, step),
    }


def _corner_minimums(tr: dict[str, np.ndarray], s: Section, at: dict[str, float]) -> dict[str, float] | None:
    """Slowest speed through each official corner of a section that holds several (T15-T17: T15, T16 and T17),
    each corner reaching halfway to its neighbours."""
    pos = sorted((at[c], c) for c in s.corners if c in at and s.start <= at[c] <= s.end)
    if len(pos) < 2:
        return None
    cuts = [s.start, *[round((a + b) / 2) for (a, _), (b, _) in pairwise(pos)], s.end]
    return {c: float(tr["speed"][cuts[k]:cuts[k + 1] + 1].min()) for k, (_, c) in enumerate(pos)}


def _phase_split(a: Traced, b: Traced, start: int, end: int) -> np.ndarray:
    """Time lap a loses to lap b on these metres, in each phase (indexed as PHASES).

    Each metre counts in the earlier phase of the two laps: where one still brakes and the other is already back
    on the throttle, the time went braking.
    """
    gap = (_dt(a.trace) - _dt(b.trace))[start:end]
    phase = np.minimum(np.rint(a.trace["phase"][start:end]), np.rint(b.trace["phase"][start:end])).astype(int)
    return np.array([gap[phase == p].sum() for p in range(len(PHASES))])


def _where(a: Traced, b: Traced, start: int, end: int) -> list[int]:
    """The WHERE_M metres of the section where lap a loses the most to lap b."""
    gap = np.r_[0.0, np.cumsum((_dt(a.trace) - _dt(b.trace))[start:end])]
    w = min(WHERE_M, end - start)
    i = int(np.argmax(gap[w:] - gap[:-w])) if w > 0 else 0
    return [start + i, start + i + w]


def _opportunities(i: int, laps: list[Traced], sections: list[Section], metrics: list[list[dict]],
                   times: np.ndarray) -> dict:
    """Where lap i loses time to the quickest of the other laps, section by section, biggest first."""
    rows = []
    others = [j for j in range(len(laps)) if j != i]
    for k, s in enumerate(sections):
        j = min(others, key=lambda j: times[j, k])
        loss = float(times[i, k] - times[j, k])
        if loss < MIN_LOSS_S:
            continue
        split = _phase_split(laps[i], laps[j], s.start, s.end)
        p = int(split.argmax())
        rows.append({
            "code": s.code, "loss_s": round(loss, 3), "versus": j,
            "phase": PHASE_NAMES[PHASES[p]], "phase_loss_s": round(float(split[p]), 3),
            "by_phase": {PHASE_NAMES[PHASES[q]]: round(float(v), 3) for q, v in enumerate(split)},
            "where_m": _where(laps[i], laps[j], s.start, s.end),
            "differences": differences(metrics[i][k], metrics[j][k], p),
        })
    rows.sort(key=lambda r: -r["loss_s"])
    return {"to_ideal": round(float(times[i].sum() - times.min(axis=0).sum()), 3),
            "sections": rows[:TOP_OPPORTUNITIES]}


def differences(a: dict, b: dict, phase: int, limit: int = 3) -> list[dict]:
    """What lap a did differently from the quicker lap b in one section, in plain words: only the differences
    that cost time, the ones that explain the phase where the time went first.

    a and b are section_metrics, with corner_min (the slowest speed through each official corner) in a section of
    several corners: there the minimum speed is told corner by corner.
    """
    out = []
    for key in EXPLAINS[phase]:
        va, vb = a.get(key), b.get(key)
        words = COSTS[key][2]
        if key == "min_speed" and a.get("corner_min") and b.get("corner_min"):
            # the corner where lap a is slowest against lap b
            code = max(a["corner_min"], key=lambda c: b["corner_min"][c] - a["corner_min"][c])
            va, vb = a["corner_min"][code], b["corner_min"][code]
            words = words.replace("minimum speed", f"minimum speed in {code}")
        if va is None or vb is None:
            continue
        cost, least, _, unit = COSTS[key]
        d = cost(va, vb)
        if d >= least:
            scale = SCALE.get(key, 1)
            out.append({"metric": key, "text": words.format(d), "value": round(d, 2), "unit": unit,
                        "lap": round(scale * va, 2), "versus": round(scale * vb, 2)})
    return out[:limit]


def _traces(laps: list[Traced], sections: list[Section], best: np.ndarray, step: float) -> dict:
    """Every lap, and the ideal lap stitched from the quickest lap in each section, every `step` metres."""
    n = len(laps[0].trace["distance"])
    idx = np.unique(np.r_[np.arange(0, n, max(1, round(step))), n - 1])
    roles = [r for r in CHART_ROLES if all(r in x.trace for x in laps)]

    def pack(tr: dict[str, np.ndarray]) -> dict:
        out = {"t": np.round(tr["t"][idx], 3).tolist()}
        for r in roles:
            out[r] = np.round(tr[r][idx], CHART_ROLES[r]).tolist()
        return out

    ideal = {k: np.empty(n) for k in ("t", *roles)}
    elapsed = 0.0
    for k, s in enumerate(sections):
        tr = laps[best[k]].trace
        sl = slice(s.start, s.end + 1)
        ideal["t"][sl] = elapsed + tr["t"][sl] - tr["t"][s.start]
        for r in roles:
            ideal[r][sl] = tr[r][sl]
        elapsed += float(tr["t"][s.end] - tr["t"][s.start])
    return {"step_m": round(step), "distance": idx.tolist(), "laps": [pack(x.trace) for x in laps],
            "ideal": pack(ideal), "roles": roles}


# ---------- theoretical laps ----------
# Gabriele, 2026-10-08: "add the theoretical lap time per run and a theoretical lap time for both compared stints
# together. call them "stint theoretical" and "combined theoretical" and give the possibility to add the traces of
# such laps to the graph". Only these two, on the comparisons; every report's best and typical laps stay real laps.

def theoreticals(picks: list[Pick], packed: Callable[[str], PackedRun | None], corners: list[CornerSpec] | None = None,
                 step: float = 5.0) -> dict:
    """Each picked stint's "stint theoretical" (its quickest time in each section, from all its clean laps) and the
    "combined theoretical" of the stints together (the quickest in each section of any of them), on the line and
    sections of the comparison of these picks (compare_picks), with traces stitched from the laps holding each
    section, every `step` metres, on the comparison's grid.

    Read from the lap packs only (packed(run): the run's clean laps, or None): a stint without one is "not ready".
    Each time is told as the stint's quickest real lap (as stored) less what the sections gain on it, so a theoretical
    is never slower than the real lap it comes from. NotCovered when the quickest picked lap has no pack.
    """
    if not MIN_LAPS <= len(picks) <= MAX_LAPS:
        raise ValueError(f"Pick {MIN_LAPS} to {MAX_LAPS} laps")
    runs: dict[str, PackedRun | None] = {}
    for p in sorted(picks, key=lambda p: p.time):
        if p.run not in runs:
            runs[p.run] = packed(p.run)
    first = min(picks, key=lambda p: p.time)
    pr = runs[first.run]
    if pr is None or first.number not in pr.pack.laps:
        raise NotCovered(f"lap {first.number} isn't in a lap pack")
    # the comparison's line (its quickest picked lap's path) and its sections (from the quickest picked lap's trace)
    w = pr.window(first.number)
    line = track_line(w, pr.pack.laps[first.number])
    length = line.length if line is not None else round(lap_length(w, pr.pack.laps[first.number]))
    covered = [p for p in picks if runs[p.run] is not None and p.number in runs[p.run].pack.laps]
    ref = min(covered, key=lambda p: runs[p.run].pack.laps[p.number].time)
    ref_tr = runs[ref.run].trace(ref.number, line, length, KEEP)
    sections, _ = make_sections(ref_tr, corners)
    starts = np.array([s.start for s in sections])
    ends = np.array([s.end for s in sections])

    stints, laps_of = [], {}  # laps_of: run -> (lap numbers, times [lap, section], stored lap times)
    for run in dict.fromkeys(p.run for p in picks):  # in the order picked
        meta = next(p.meta for p in picks if p.run == run)
        head = {"run": run, **{k: meta.get(k) for k in ("session_id", "session", "driver")}}
        pr = runs[run]
        numbers, rows, stored = [], [], []
        for lap in pr.clean_laps() if pr is not None else []:
            try:
                t = pr.trace(lap.number, line, length, ())["t"]
            except NotCovered:
                continue
            numbers.append(lap.number)
            rows.append(t[ends] - t[starts])
            stored.append(lap.time)
        if not numbers:
            stints.append({**head, "ready": False})
            continue
        times = np.array(rows)
        laps_of[run] = (numbers, times, np.array(stored))
        stints.append({**head, "ready": True, **_theoretical(times, np.array(stored),
                                                             [(run, n) for n in numbers])})
    combined = None
    if len(laps_of) >= 2:
        keys = [(run, n) for run, (numbers, _, _) in laps_of.items() for n in numbers]
        combined = _theoretical(np.vstack([t for _, t, _ in laps_of.values()]),
                                np.concatenate([s for _, _, s in laps_of.values()]), keys)

    # the traces: each section from the lap holding it
    holders = {tuple(f) for s in stints if s["ready"] for f in s["from"]} | \
        ({tuple(f) for f in combined["from"]} if combined else set())
    roles = tuple(CHART_ROLES)
    traces = {}
    for run, n in holders:
        traces[(run, n)] = runs[run].trace(n, line, length, roles)
    roles = tuple(r for r in CHART_ROLES if all(r in tr for tr in traces.values()))
    idx = np.unique(np.r_[np.arange(0, len(ref_tr["distance"]), max(1, round(step))), len(ref_tr["distance"]) - 1])

    def stitch(sources: list[list]) -> dict:
        n = len(ref_tr["distance"])
        out = {k: np.empty(n) for k in ("t", *roles)}
        elapsed = 0.0
        for k, s in enumerate(sections):
            tr = traces[tuple(sources[k])]
            sl = slice(s.start, s.end + 1)
            out["t"][sl] = elapsed + tr["t"][sl] - tr["t"][s.start]
            for r in roles:
                out[r][sl] = tr[r][sl]
            elapsed += float(tr["t"][s.end] - tr["t"][s.start])
        packed_out = {"t": np.round(out["t"][idx], 3).tolist()}
        for r in roles:
            packed_out[r] = np.round(out[r][idx], CHART_ROLES[r]).tolist()
        return packed_out

    return {
        "sections": [s.code for s in sections],
        "stints": stints,
        "combined": combined,
        "traces": {"step_m": round(step), "distance": idx.tolist(), "roles": list(roles),
                   "stints": [stitch(s["from"]) if s["ready"] else None for s in stints],
                   "combined": stitch(combined["from"]) if combined else None},
    }


def _theoretical(times: np.ndarray, stored: np.ndarray, keys: list[tuple[str, int]]) -> dict:
    """The quickest of these laps in each section (times: [lap, section]): its time, told as the quickest real lap
    (stored) less what the sections gain on it on the line, and the (run, lap) holding each section."""
    best = int(stored.argmin())
    hold = times.argmin(axis=0)
    gain = max(0.0, float(times[best].sum() - times.min(axis=0).sum()))
    return {"time": round(float(stored[best]) - gain, 3), "gap_s": round(gain, 3),
            "best_run": keys[best][0], "best_lap": keys[best][1], "best_time": round(float(stored[best]), 3),
            "laps": len(keys), "from": [list(keys[i]) for i in hold]}
