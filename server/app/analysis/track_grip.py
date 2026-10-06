"""The track's grip level, session by session, apart from the tyres' own state.

1. Grip at the limit, lap by lap. Every quick lap of the event is put on one track line (the compact traces of
   analysis/compact.py). The car's grip limit and the road's shape come from the quickest laps as the report learns
   them (insights.grip_limits, track_shape.py): g per unit of the road's vertical load, so banked corners, crests and
   compressions neither lend nor take grip. The limit places are where the quickest laps mostly ride at that limit
   (median grip use at least LIMIT_USE while braking or cornering, away from banked corners, crests and compressions).
   A lap's grip is its g per unit of load there against the quickest laps' median at the same place, the median over
   those places: +2 % means it pulled 2 % more g than they did at the same metres of the same corners.
2. The tyres' share. The pooled tyre model of the car (vehicle/tyre_data.py, the Tools > Tyre fit model) groups its
   laps by hot pressure and by TPMS temperature and says how much grip each group had, with a range. Each group's
   number is pulled toward the groups' average by how unsure it is (grip_curve): when the groups differ by no more
   than their own ranges, the line is flat and the tyres count as the same on every lap. A lap's expected tyre grip is
   read off those lines at its own pressures and temperatures: per axle the mean of the two (they rise together, so
   they are one reading of the tyre's state, not two), then the mean of the two axles.
3. The track. A lap's track grip is its grip at the limit less the tyres' expected share. A session (the logs of one
   official session, Q or R1, together) has the median of its quick laps (within QUICK_WITHIN of its best, so
   warm-up, traffic and cool-down laps don't pull it down), with the median's 90 % range from their spread. Levels are
   given against the first session with enough quick laps for a range.

What it can't tell apart: anything else that changes grip between runs (a setup change, fuel load, worn tyres, a
driver who doesn't take the car to the limit, racing in traffic) reads as the track. The sessions' drivers, when
known, are shown with them, and race laps are read against each other, not against qualifying.
"""
from __future__ import annotations

import itertools
import math
import warnings
from dataclasses import dataclass, field

import numpy as np

from app.analysis.channels import POWER
from app.analysis.insights import LapRecord, grip_limits, road_shape

QUICK_WITHIN = 0.02  # a session's quick laps: within this share of its best
LIMIT_USE = 0.9  # a limit place: the quickest laps' median grip use here is at least this ...
LIMIT_SHARE = 0.7  # ... and at least this share of them brake or corner here
MIN_SPEED_KMH = 50.0
GRIP_SIDE_DEG = 30.0  # directions up to this (braking, cornering, a little traction) are grip-limited
MIN_PLACES = 50  # metres of limit places a lap must cover to be measured
MIN_LIMIT_M = 150  # metres of limit places on the track before anything is measured
TRACE_ROLES = ("speed", "ax", "ay", "phase", "turn_g", "az", "altitude")  # what a lap keeps on the line
MIN_GROUPS = 3  # groups of laps with a range the tyre model needs against a condition before it is used
MIN_RANGE_LAPS = 3  # quick laps a session needs for a range (and to be the base, or to be compared)
FLAT_PCT = 1.0  # a change smaller than this (%) is "held"
WET_DROP_PCT = 8.0  # a session this far below the others: a wet or damp track, most likely
DIP_PCT = 2.0  # a session this far below the sessions either side of it is worth a word
MOST = 2 / 3  # "most of it": this share of the change
Z90 = 1.645


@dataclass
class LapIn:
    """One lap of a session, with the tyres' state on it (from the tyre data summary)."""
    key: str  # the lap's LapRecord.key: its grip at the limit is looked up by it
    number: int
    time: float
    event_lap: int | None = None  # laps the car had driven at the event by the end of this one
    front_c: float | None = None  # TPMS temperature and hot pressure, per axle
    front_bar: float | None = None
    rear_c: float | None = None
    rear_bar: float | None = None
    wet: bool = False  # the logger's wiper switch on


@dataclass
class SessionIn:
    """An official session (one or more logs: Q, R1, D1S2), its laps and conditions."""
    key: str
    name: str
    session_ids: list[int] = field(default_factory=list)
    start: str | None = None  # ISO date and time of its first log: the sessions are taken in this order
    kind: str = "other"  # qualifying, race or other
    drivers: list[str] = field(default_factory=list)
    ambient_c: float | None = None
    track_c: float | None = None
    laps: list[LapIn] = field(default_factory=list)


# ---------- 1. grip at the limit, lap by lap ----------

@dataclass
class Measured:
    grip: dict[str, float]  # LapRecord.key -> grip against the quickest laps at the limit places (fraction)
    limit_m: int  # metres of the lap counted as limit places
    length_m: int
    road_load: bool  # the road's vertical load (banking, crests, compressions) was known and taken out


def lap_grip(laps: list[LapRecord]) -> Measured | None:
    """Every lap's grip at the limit places against the quickest laps' (module docstring, step 1). The laps are on
    one line (traces of equal length, with speed, ax, ay and phase; turn_g, az and altitude for the road's shape).
    None when there are no limit places to compare at."""
    if not laps:
        return None
    shape = road_shape(laps)
    lim = grip_limits(laps, shape)
    n = len(laps[0].trace["speed"])
    load = np.ones(n) if lim.load is None else np.asarray(lim.load, float)
    shaped = shape.shaped_on(n) if shape is not None else np.zeros(n, bool)
    times = np.array([x.time for x in laps])
    quick = np.flatnonzero(times <= times.min() * (1 + QUICK_WITHIN))
    if len(quick) < 3:
        quick = np.argsort(times)[:3]
    use_q, grip_q, cg_q = [], [], []
    for i in quick:
        tr = laps[i].trace
        g, cg = _grip_metres(tr, load, shaped)
        use_q.append(np.where(g, lim.use(tr["speed"], tr["ax"], tr["ay"], at=slice(None)), np.nan))
        grip_q.append(g)
        cg_q.append(np.where(g, cg, np.nan))
    with warnings.catch_warnings():  # metres no quick lap brakes or corners at: all nan, left out below
        warnings.simplefilter("ignore", RuntimeWarning)
        med_use = np.nanmedian(np.array(use_q), axis=0)
        ref = np.nanmedian(np.array(cg_q), axis=0)
    del use_q, cg_q
    limit = ((np.nan_to_num(med_use) >= LIMIT_USE) & (np.mean(np.array(grip_q), axis=0) >= LIMIT_SHARE)
             & np.isfinite(ref) & (np.nan_to_num(ref) > 0.3))
    if np.count_nonzero(limit) < MIN_LIMIT_M:
        return None
    out = {}
    for x in laps:
        g, cg = _grip_metres(x.trace, load, shaped)
        sel = limit & g
        if np.count_nonzero(sel) >= MIN_PLACES:
            out[x.key] = float(np.median(cg[sel] / ref[sel])) - 1
    return Measured(out, int(np.count_nonzero(limit)), n - 1, bool(np.any(load != 1)))


def _grip_metres(tr: dict[str, np.ndarray], load: np.ndarray, shaped: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Where the lap is braking or cornering (grip-limited directions, at speed, off banked corners, crests and
    compressions), and its combined g per unit of the road's load at every metre."""
    ax, ay = np.asarray(tr["ax"], float), np.asarray(tr["ay"], float)
    direction = np.degrees(np.arctan2(ax, np.abs(ay)))
    g = ((np.rint(tr["phase"]) < POWER) & (np.asarray(tr["speed"]) > MIN_SPEED_KMH) & ~shaped
         & (direction <= GRIP_SIDE_DEG))
    return g, np.hypot(ax, ay) / load


# ---------- 2. the tyres' share, from the pooled tyre model ----------

def _usable(bins: list[dict]) -> list[dict]:
    return [b for b in bins if b.get("grip") is not None and b.get("low") is not None and b.get("high") is not None
            and b["high"] > b["low"]]


def grip_curve(cond: dict | None) -> tuple[np.ndarray, np.ndarray] | None:
    """The tyre model's grip against one condition on one axle: its groups' grip at their middles, each pulled toward
    the groups' average by how unsure it is. Of the spread between the groups, the part beyond their own ranges' is
    real (between = spread - own); a group keeps between / (between + its own variance) of its difference from the
    average, so a group with a wide range counts for little and scatter alone gives a flat line. As fractions,
    centred on the average; None when fewer than MIN_GROUPS groups have a range or their spread is all scatter."""
    bins = _usable((cond or {}).get("bins") or [])
    if len(bins) < MIN_GROUPS:
        return None
    g = np.array([b["grip"] for b in bins], float)
    var = (np.array([b["high"] - b["low"] for b in bins], float) / (2 * Z90)) ** 2  # the 5-95 % range
    w = 1 / var
    mean = float(np.sum(w * g) / np.sum(w))
    between = float(np.sum((g - mean) ** 2) / (len(g) - 1) - np.mean(var))
    if between <= 0:
        return None
    x = np.array([(b["from"] + b["to"]) / 2 for b in bins], float)
    o = np.argsort(x)
    return x[o], ((g - mean) * between / (between + var))[o]


def tyre_terms(conditions: dict | None) -> dict[str, dict[str, tuple[np.ndarray, np.ndarray]]]:
    """Per axle, the tyre model's grip lines (grip_curve) against hot pressure ("bar") and TPMS temperature ("c")
    that show more than scatter."""
    out: dict[str, dict] = {}
    for axle in ("front", "rear"):
        for name, key in (("pressure", "bar"), ("temperature", "c")):
            curve = grip_curve(((conditions or {}).get(name) or {}).get(axle))
            if curve is not None:
                out.setdefault(axle, {})[key] = curve
    return out


def tyre_effect(terms: dict[str, dict], lap: LapIn) -> float:
    """The car's grip the tyre model expects from the tyres' state on this lap, against its average lap (a fraction):
    per axle the mean of its pressure and temperature lines at the lap's values (pressure and temperature rise
    together, so they are one reading of the tyre's state, not two), then the mean of the two axles (an axle whose
    lines are flat counts 0)."""
    axles = []
    for axle in ("front", "rear"):
        vals = [float(np.interp(x, *curve)) for key, curve in terms.get(axle, {}).items()
                if (x := getattr(lap, f"{axle}_{key}")) is not None and math.isfinite(x)]
        axles.append(float(np.mean(vals)) if vals else 0.0)
    return float(np.mean(axles))


# ---------- 3. the track, session by session ----------

def _r(x: float | None, nd: int = 2) -> float | None:
    return None if x is None or not math.isfinite(x) else round(float(x), nd)


def _median(vals: list) -> float | None:
    vals = [v for v in vals if v is not None and math.isfinite(v)]
    return float(np.median(vals)) if vals else None


def _level(values: list[float]) -> tuple[float | None, float | None]:
    """The median of the laps' values and its standard error (None from fewer than MIN_RANGE_LAPS laps)."""
    if not values:
        return None, None
    v = np.array(values, float)
    if len(v) < MIN_RANGE_LAPS:
        return float(np.median(v)), None
    return float(np.median(v)), 1.2533 * float(np.std(v, ddof=1)) / math.sqrt(len(v))


def _pct(x: float | None) -> float | None:
    return None if x is None or not math.isfinite(x) else round(100 * float(x), 1)


def evolution(sessions: list[SessionIn], measured: dict[str, float], conditions: dict | None,
              model: dict | None = None) -> dict:
    """The track's grip session by session in time order (step 3), with the plain-words read.

    measured: LapRecord.key -> grip at the limit (lap_grip's, a fraction). conditions: the tyre model's "conditions"
    (None without a model). model: what the model rests on, to say so ({"sessions", "laps", "tyre"})."""
    terms = tyre_terms(conditions)
    ordered = sorted(sessions, key=lambda s: (s.start or "", s.key))
    rows, laps_out = [], []
    for s in ordered:
        mine = [(lap, measured[lap.key]) for lap in s.laps if lap.key in measured]
        if not mine:
            continue
        best = min(lap.time for lap, _ in mine)
        quick = [(lap, g) for lap, g in mine if lap.time <= best * (1 + QUICK_WITHIN)]
        track, meas, tyres = [], [], []
        for lap, g in quick:
            t = tyre_effect(terms, lap)
            track.append(g - t)
            meas.append(g)
            tyres.append(t)
            laps_out.append({"session": s.key, "lap": lap.number, "event_lap": lap.event_lap,
                             "time": _r(lap.time, 3), "measured": g, "tyres": t, "track": g - t})
        level, se = _level(track)
        rows.append({
            "key": s.key, "name": s.name, "session_ids": s.session_ids, "start": s.start, "kind": s.kind,
            "drivers": s.drivers, "ambient_c": _r(s.ambient_c, 1), "track_c": _r(s.track_c, 1),
            "wet": sum(1 for lap, _ in quick if lap.wet) * 2 > len(quick),
            "laps": len(quick), "best": _r(best, 3),
            "_track": level, "_se": se, "_measured": _median(meas), "_tyres": _median(tyres),
            "state": {k: _r(_median([getattr(lap, k) for lap, _ in quick]), 3 if k.endswith("bar") else 1)
                      for k in ("front_c", "front_bar", "rear_c", "rear_bar")},
        })
    if not rows:
        return {"available": False, "sessions": [], "laps": [], "read": [], "headline": None,
                "notes": ["No lap could be measured at the limit places, so the track's grip can't be told."]}
    base = next((r for r in rows if r["_se"] is not None), rows[0])
    for r in rows:
        r["base"] = r is base
        r["track"] = _pct(r["_track"] - base["_track"])
        r["measured"] = _pct(r["_measured"] - base["_measured"])
        r["tyres"] = _pct(r["_tyres"] - base["_tyres"])
        spread = None
        if r["_se"] is not None:
            spread = Z90 * (r["_se"] if r is base else math.hypot(r["_se"], base["_se"] or 0.0))
        r["pm"] = _pct(spread)
        r["range"] = [_pct(r["_track"] - base["_track"] - spread), _pct(r["_track"] - base["_track"] + spread)] \
            if spread is not None else None
    for lap in laps_out:
        for k in ("measured", "tyres", "track"):
            lap[k] = _pct(lap[k] - base[f"_{k}"])
    read, headline = _read(rows, base, laps_out, terms, model)
    for r in rows:
        for k in [k for k in r if k.startswith("_")]:
            del r[k]
    return {"available": True, "base": base["name"], "sessions": rows, "laps": laps_out, "read": read,
            "headline": headline,
            "tyre_model": {"used": bool(terms), "curves": _curves_out(terms), **(model or {})}}


def _curves_out(terms: dict) -> dict:
    """The tyre model's lines used, per axle and condition: the groups' middles and grip (%)."""
    names = {"bar": "pressure", "c": "temperature"}
    return {axle: {names[key]: {"at": [round(float(v), 3) for v in x],
                                "grip_pct": [round(100 * float(v), 2) for v in y]}
                   for key, (x, y) in curves.items()} for axle, curves in terms.items()}


def _num(x: float) -> str:
    """A percentage in words: whole numbers from 2 %, one decimal below."""
    x = abs(x)
    return f"{x:.0f}" if x >= 2 else f"{x:.1f}"


def _signed(x: float) -> str:
    return ("+" if x > 0 else "\u2212" if x < 0 else "") + _num(x)


def _ranged(rows: list[dict]) -> list[dict]:
    return [r for r in rows if r["pm"] is not None]


def _read(rows: list[dict], base: dict, laps: list[dict], terms: dict, model: dict | None
          ) -> tuple[list[str], dict | None]:
    """The plain-words read: how grip moved from the first session to qualifying (or through a test), where most of
    it came, overnight, the races, sessions that stand out, the tyres' share and how sure it is."""
    out: list[str] = []
    after = rows[rows.index(base) + 1:]
    if not after:
        out.append(f"Only {base['name']} could be measured with enough quick laps, so there is no change to read yet.")
        out.append(_tyre_words(rows, terms, model))
        return out, None
    quali = [r for r in after if r["kind"] == "qualifying"]
    races = [r for r in rows if r["kind"] == "race"]
    if quali:
        to = quali[-1]
    elif races and base["kind"] == "qualifying":
        to = None  # qualifying first, then the races: they are read against each other below
    else:
        to = (_ranged(after) or after)[-1]
    headline = None
    if to is not None:
        headline = _headline(rows, base, laps, to, out)
    out += _overnight(rows)
    q = quali[-1] if quali else (base if base["kind"] == "qualifying" else None)
    if q is not None and races:
        parts = ", ".join(f"{r['name']} {_signed(r['track'] - q['track'])} %" for r in races)
        out.append(f"Against {q['name']} the races ran {parts}. Race laps carry more fuel, older tyres and traffic, so "
                   "most of that is the car and the racing, not the track.")
    if len(races) >= 2:
        a, b = races[0], races[-1]
        d = b["track"] - a["track"]
        pm = math.hypot(a["pm"], b["pm"]) if a["pm"] is not None and b["pm"] is not None else None
        sure = pm is not None and abs(d) > pm and abs(d) >= FLAT_PCT
        within = f" ± {_num(pm)} %" if pm else ""
        text = f"{'rose' if d > 0 else 'fell'} about {_num(d)} %{within}" if sure \
            else f"held ({_signed(d)} %{within})"
        ranged = _ranged(rows)
        told = a in ranged and b in ranged and ranged.index(b) - ranged.index(a) == 1 and \
            (a["start"] or "")[:10] != (b["start"] or "")[:10]  # already read as the night between them
        if not told:
            out.append(f"From {a['name']} to {b['name']} grip {text}.")
        if headline is None:
            headline = {"from": a["name"], "to": b["name"], "change_pct": round(d, 1),
                        "pm": _r(pm, 1) if pm else None, "sure": sure}
    out += _standouts(rows)
    out.append(_tyre_words(rows, terms, model))
    pms = [r["pm"] for r in _ranged(rows) if r is not base]
    if pms:
        out.append(f"How sure: a session's level is the median of its quick laps, good to about ± "
                   f"{_num(float(np.median(pms)))} % against {base['name']} (90 % range); a session of fewer than "
                   f"{MIN_RANGE_LAPS} quick laps gets none.")
    return out, headline


def _headline(rows: list[dict], base: dict, laps: list[dict], to: dict, out: list[str]) -> dict:
    """The change from the base session to `to` in words (appended to out), with where most of it came."""
    change, pm = to["track"], to["pm"]
    sure = pm is not None and abs(change) > pm and abs(change) >= FLAT_PCT
    within = f" (± {_num(pm)} %)" if pm is not None else ""
    headline = {"from": base["name"], "to": to["name"], "change_pct": change, "pm": pm, "sure": sure}
    if not sure:
        out.append(f"Grip held from {base['name']} to {to['name']}: {_signed(change)} %{within}, within what "
                   "lap-to-lap scatter can hide.")
        return headline
    text = f"Grip {'rose' if change > 0 else 'fell'} about {_num(change)} %{within} from {base['name']} to {to['name']}"
    when = _when(rows, base, laps, change, to)
    if when:
        headline["by_lap"] = when["event_lap"]
        text += f"; {when['text']}"
    out.append(text + ".")
    after = _ranged(rows[rows.index(base) + 1:rows.index(to) + 1])
    if change > 0 and len(after) >= 2:
        peak = max(after, key=lambda r: r["track"])
        later = after[after.index(peak) + 1:]
        if later:
            lo, hi = min(r["track"] for r in later), max(r["track"] for r in later)
            if peak["track"] - lo < 2 * FLAT_PCT:
                out.append(f"From {peak['name']} on it held within {_num(peak['track'] - lo)} %.")
            else:
                span = f"{_signed(lo)} to {_signed(hi)} %" if hi - lo >= 0.5 else f"{_signed(lo)} %"
                out.append(f"It peaked in {peak['name']} ({_signed(peak['track'])} %); the sessions after it ran "
                           f"{span}.")
    return headline


def _when(rows: list[dict], base: dict, laps: list[dict], change: float, to: dict) -> dict | None:
    """Where most of the change came: the first quick lap past MOST of the change from which the median of it and
    the next two is past it too, in laps the car had driven at the event, and whether that came across a break
    between sessions."""
    order = [r["key"] for r in rows]
    start, stop = order.index(base["key"]), order.index(to["key"])
    seq = [x for x in laps if start <= order.index(x["session"]) <= stop and x["event_lap"] is not None]
    seq.sort(key=lambda x: (order.index(x["session"]), x["event_lap"]))
    goal = MOST * change
    for i in range(len(seq) - 2):
        past = float(np.median([x["track"] for x in seq[i:i + 3]]))
        if not all((v >= goal) if change > 0 else (v <= goal) for v in (past, seq[i]["track"])):
            continue
        x = seq[i]
        name = rows[order.index(x["session"])]["name"]
        if i > 0 and seq[i - 1]["session"] != x["session"]:
            prev = rows[order.index(seq[i - 1]["session"])]["name"]
            return {"event_lap": x["event_lap"],
                    "text": f"most of it between {prev} and {name}, by the car's {_ordinal(x['event_lap'])} lap of "
                            "the event"}
        return {"event_lap": x["event_lap"],
                "text": f"most of it in the first {x['event_lap']} laps of the event (by lap {x['lap']} of {name})"}
    return None


def _ordinal(n: int) -> str:
    suffix = "th" if 10 <= n % 100 <= 20 else {1: "st", 2: "nd", 3: "rd"}.get(n % 10, "th")
    return f"{n}{suffix}"


def _overnight(rows: list[dict]) -> list[str]:
    """Each night between two days of running: did the grip hold, or did the track go green again?"""
    out = []
    ranged = _ranged(rows)
    for a, b in itertools.pairwise(ranged):
        if not a["start"] or not b["start"] or a["start"][:10] == b["start"][:10]:
            continue
        if (a["kind"] == "race") != (b["kind"] == "race"):
            continue  # a race against another kind of session tells the racing, not the night
        d = b["track"] - a["track"]
        pm = math.hypot(a["pm"], b["pm"])
        both = f"{a['name']} {_signed(a['track'])} %, then {b['name']} {_signed(b['track'])} %"
        if abs(d) <= max(pm, FLAT_PCT):
            out.append(f"Overnight the grip held: {both}.")
        elif d < 0:
            out.append(f"Overnight it lost about {_num(d)} % ({both}): rain or the night took rubber off, so expect "
                       "it to come in again.")
        else:
            out.append(f"Overnight it gained about {_num(d)} % ({both}).")
    return out


def _standouts(rows: list[dict]) -> list[str]:
    """Sessions well below the rest: wet (the wiper on, or far down), or a dip against the sessions either side,
    with what the tyres' state on them says. Races are read against each other, not here."""
    out = []
    ranged = [r for r in _ranged(rows) if r["kind"] != "race"]
    typical = float(np.median([r["track"] for r in ranged])) if ranged else 0.0
    for r in rows:
        if r["wet"]:
            out.append(f"{r['name']}: the wiper was on, so read its grip ({_signed(r['track'])} %) as a wet or damp "
                       "track.")
            continue
        if r not in ranged:
            continue
        if typical - r["track"] >= WET_DROP_PCT:
            out.append(f"{r['name']} was {_num(typical - r['track'])} % below the other sessions: most likely a wet or "
                       "damp track.")
            continue
        i = ranged.index(r)
        near = [ranged[j] for j in (i - 1, i + 1) if 0 <= j < len(ranged)]
        if len(near) < 2:
            continue
        dip = min(x["track"] for x in near) - r["track"]
        if dip >= DIP_PCT and dip > r["pm"]:
            out.append(f"{r['name']} was about {_num(dip)} % below the sessions either side of it"
                       f"{_odd_state(r, ranged)}.")
    return out


def _odd_state(r: dict, rows: list[dict]) -> str:
    """What stands out in a session's tyre state against the other sessions' (below their range), in words."""
    for key, what, unit, nd, step in (("front_c", "front tyres ran cooler", "°C", 0, 5.0),
                                      ("rear_c", "rear tyres ran cooler", "°C", 0, 5.0),
                                      ("front_bar", "front hot pressures were lower", "bar", 2, 0.05),
                                      ("rear_bar", "rear hot pressures were lower", "bar", 2, 0.05)):
        mine = r["state"].get(key)
        rest = [x["state"].get(key) for x in rows if x is not r and x["state"].get(key) is not None]
        if mine is None or len(rest) < 2 or mine >= min(rest) - step:
            continue
        return (f"; its {what} than in any other session ({mine:.{nd}f} {unit} against {min(rest):.{nd}f}-"
                f"{max(rest):.{nd}f}), as they do when the car is driven or set up differently: more likely the car "
                "than the track")
    return ": a setup change, fuel, the driver or the track; nothing in the tyres' state stands out"


def _tyre_words(rows: list[dict], terms: dict, model: dict | None) -> str:
    if model is None:
        return ("No tyre model for this car yet (its logs are still being summarised), so the tyres' state is not "
                "taken out: the levels are the grip at the limit as measured.")
    basis = f" ({model['sessions']} sessions, {model.get('laps', 0)} laps of this car)" if model.get("sessions") \
        else ""
    if not terms:
        return (f"The tyre model{basis} can't tell grip changing with hot pressure or TPMS temperature from scatter, "
                "so none of the change is put down to the tyres.")
    names = {"bar": "hot pressures", "c": "TPMS temperatures"}
    which = " and ".join(sorted({names[k] for curves in terms.values() for k in curves}))
    shares = [r for r in rows if r["tyres"] is not None]
    low, high = min(shares, key=lambda r: r["tyres"]), max(shares, key=lambda r: r["tyres"])
    if high["tyres"] - low["tyres"] < 0.5:
        return (f"The tyre model{basis} shows grip changing a little with {which}, but the sessions' quick laps ran "
                "at much the same, so the tyres' state moves these levels by under 0.5 %.")
    base = next(r for r in rows if r["base"])
    return (f"From the tyres' {which}, the tyre model{basis} expects {low['name']} {_signed(low['tyres'])} % and "
            f"{high['name']} {_signed(high['tyres'])} % against {base['name']}; that share is taken out of the track "
            "levels.")


METHOD = [
    "Grip at the limit: every quick lap on one track line, its g per unit of the road's vertical load (banked corners, "
    "crests and compressions taken out) at the places the quickest laps ride at the car's grip limit, against their "
    "median there.",
    "The tyres' share: the pooled tyre model of the car (Tools > Tyre fit) groups its laps by hot pressure and TPMS "
    "temperature; each group's grip, pulled toward the average by how unsure it is, gives the grip a lap's tyres are "
    "expected to give. When the groups differ no more than their ranges, the tyres count as the same on every lap.",
    "The track: grip at the limit less the tyres' share. A session's level is the median of its quick laps (within "
    f"{QUICK_WITHIN * 100:.0f} % of its best), against the first session with {MIN_RANGE_LAPS} or more; the range is "
    "the median's 90 % range.",
    "A setup change, fuel, worn tyres or a driver who doesn't take the car to the limit also change the grip measured, "
    "and read as the track.",
]
