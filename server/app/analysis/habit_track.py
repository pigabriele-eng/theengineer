"""Habit tracker: each driver's recurring technique mistakes over every event, getting better or worse, and drivers
side by side.

The mistakes are the technique check's (analysis/technique.py, worked out per event by routers/technique.py): every
clean lap's obvious mistakes (never the pieces of its gap to the perfect lap), each at a corner (its official
number) with the time it cost. A habit is a kind of mistake (lifting on the way out, braking early...). How often a
driver makes it is the share of the corners they drove where it was flagged (a lap through a track of 12 corners
drives 12), so tracks with more or fewer corners compare. What it costs is the time it cost a lap, on average.

A habit is getting better or worse by its share of corners at the driver's earlier events against their recent ones
(the first half of their events against the rest, by date); a change smaller than a quarter of it, than two corners
in a hundred, or than the luck of a few corners (TREND_Z standard errors) is about the same. Only events where the
driver did MIN_EVENT_LAPS clean laps or more count. With two events that is one track against another.

Corners are typed by the speed at their slowest point on the event's fastest lap: slow, medium and fast corners, and
flat-out kinks (sections with no real slowest point). Nearly every corner of a lap shows some small mistake, so a
corner counts for its type only when its mistakes together cost COSTLY_S or more.

The way two drivers differ every time they share the car comes from their style fingerprints
(analysis/driver_style.py), which are relative to the other laps of the same event.
"""
from __future__ import annotations

from collections import Counter, defaultdict
from dataclasses import dataclass, field

import numpy as np

from app.analysis import driver_style as ds
from app.analysis.technique import HABITS

MIN_EVENT_LAPS = 5  # fewer clean laps at an event and it doesn't count towards a trend
TREND_SHARE = 0.25  # a change of at least this share of the habit's rate is a trend
TREND_MIN = 0.02  # ... and of at least two corners in a hundred
TREND_Z = 2.0  # ... and this many standard errors: more than the luck of a few corners
TREND_CORNERS = 30  # fewer corners driven before or since and there is too little to say
COSTLY_S = 0.1  # s: a corner whose mistakes cost this much on a lap counts in the corner types
CORNER_SHOWN = 3  # corners where a habit shows most
CORNER_MIN_RATE = 0.2  # of the driver's laps at that event: less is not where it shows
HABIT_MIN_HITS = 2  # a habit flagged fewer times than this for every driver is left out
HABITS_KEPT = 30
STYLE_AGREE = 0.75  # of the shared events: a style difference that holds this often
STYLE_KEPT = 8

GROUPS = {"braking": "Braking", "corner": "Mid-corner", "throttle": "Throttle and exits", "shifting": "Shifting"}
KIND_GROUP = {
    "brake_early": "braking", "lift_before_brake": "braking", "over_slowed": "braking", "lockup": "braking",
    "soft_braking": "braking", "slow_brake_build": "braking", "early_ease": "braking",
    "soft_straight_braking": "braking",
    "lift_corner": "corner", "coasting": "corner", "min_speed": "corner", "steering": "corner",
    "late_throttle": "throttle", "exit_lift": "throttle", "slow_throttle": "throttle", "lift": "throttle",
    "power_step": "throttle", "on_off_throttle": "throttle", "exit_stall": "throttle",
    "early_shift": "shifting", "late_shift": "shifting",
}
PHASE_GROUP = {"braking": "braking", "entry": "braking", "mid-corner": "corner", "exit": "throttle",
               "full throttle": "throttle"}  # a kind the check adds later goes by its phase
LABELS = {
    **HABITS,
    "soft_straight_braking": "Braking below the limit in a straight line",
    "power_step": "Stepping on the power, then lifting or correcting",
    "on_off_throttle": "Throttle on and off through the corner",
    "exit_stall": "Speed stalling on the way out",
    "early_shift": "Shifting up early",
    "late_shift": "Shifting up late",
}
DO = {
    "brake_early": "Brake later, at the limit from the first moment.",
    "lift_before_brake": "Go straight from full throttle to the brake.",
    "over_slowed": "Let the brake go earlier and carry the speed to the slowest point.",
    "lockup": "Ease the pressure off as the speed falls, so the fronts keep turning.",
    "soft_braking": "Brake harder at the start, then ease off as you turn in.",
    "slow_brake_build": "Hit the brake firmly from the first moment.",
    "early_ease": "Hold the pressure longer; ease off only as you turn in.",
    "soft_straight_braking": "Brake to the limit while the car is straight, then brake later to match.",
    "lift_corner": "Lift less: carry more speed through the corner.",
    "coasting": "Trail the brake further in and go from brake to throttle with no gap.",
    "min_speed": "Carry more speed through the slowest point.",
    "steering": "Turn in once and hold the steering; let the throttle place the car.",
    "late_throttle": "Pick up the throttle at the slowest point.",
    "exit_lift": "Once the throttle is on, keep it on and keep adding to full throttle.",
    "slow_throttle": "Build the throttle faster, at the limit of grip.",
    "lift": "Stay flat where the car is flat out.",
    "power_step": "Squeeze the throttle on from the slowest point, as fast as the car takes it.",
    "on_off_throttle": "Find the throttle the car holds through the corner and keep adding to it smoothly.",
    "exit_stall": "Keep the car accelerating to the next brake point: open the steering, add throttle steadily.",
    "early_shift": "Hold the gear to the shift point before shifting up.",
    "late_shift": "Shift up at the shift point, before the limiter.",
}
# the corners by the speed at their slowest point (km/h) on the event's fastest lap
TYPES = (("slow", "Slow corners", "slowest point under 100 km/h"),
         ("medium", "Medium corners", "slowest point 100 to 150 km/h"),
         ("fast", "Fast corners", "slowest point over 150 km/h"),
         ("flat", "Flat-out kinks", "taken without a real slowest point"))
SLOW_KMH, FAST_KMH = 100.0, 150.0
STYLE_GROUP = {
    "brake_on": "braking", "brake_peak": "braking", "brake_build": "braking", "brake_off": "braking",
    "trail": "braking", "brake_fullness": "braking", "lap_brake_apply_rate": "braking",
    "lap_brake_release_rate": "braking", "lap_braking": "braking",
    "coast": "throttle", "throttle_on": "throttle", "throttle_ramp": "throttle", "lift": "throttle",
    "lap_full_throttle": "throttle", "lap_coasting": "throttle", "lap_overlap": "throttle",
    "lap_part_throttle": "throttle", "lap_throttle_open_rate": "throttle", "lap_throttle_close_rate": "throttle",
    "lap_throttle_corrections": "throttle",
    "vmin": "corner", "vmin_at": "corner", "steer_lock": "corner", "steer_busy": "corner",
    "lap_steer_rate": "corner", "lap_steer_corrections": "corner",
    "gear": "shifting",
}


def group_of(kind: str, phase: str | None = None) -> str:
    return KIND_GROUP.get(kind) or PHASE_GROUP.get(phase or "", "corner")


# ---------- corner types ----------

def corner_type(slowest_kmh: float | None) -> str:
    if slowest_kmh is None:
        return "flat"
    if slowest_kmh < SLOW_KMH:
        return "slow"
    return "medium" if slowest_kmh <= FAST_KMH else "fast"


def section_types(sections: list[dict], speed: list[float] | None, step_m: int) -> dict[str, str]:
    """Each section's corner type (by its code) from a lap's speed every step_m metres; {} without the speeds."""
    if not speed or step_m <= 0:
        return {}
    v = np.asarray(speed, float)
    out = {}
    for s in sections:
        if s.get("apex_m") is None:
            out[s["code"]] = "flat"
            continue
        a, b = int(s["start_m"]) // step_m, int(s["end_m"]) // step_m + 1
        seg = v[max(a, 0):min(b, len(v))]
        out[s["code"]] = corner_type(float(np.nanmin(seg)) if len(seg) else None)
    return out


# ---------- one event ----------

@dataclass
class Tally:
    """One driver's mistakes at one event: corner passes where each was flagged, and the time they cost."""
    laps: int = 0
    passes: int = 0  # corners driven: laps x the track's sections
    type_passes: Counter = field(default_factory=Counter)  # type -> corners of that type driven
    hits: Counter = field(default_factory=Counter)  # kind -> corner passes where it was flagged
    cost: defaultdict = field(default_factory=lambda: defaultdict(float))  # kind -> seconds
    group_hits: Counter = field(default_factory=Counter)  # group -> corner passes with any mistake of the group
    group_cost: defaultdict = field(default_factory=lambda: defaultdict(float))
    type_hits: Counter = field(default_factory=Counter)  # type -> corner passes of that type costing COSTLY_S
    type_cost: defaultdict = field(default_factory=lambda: defaultdict(float))
    kind_type_hits: Counter = field(default_factory=Counter)  # (kind, type)
    kind_code_hits: Counter = field(default_factory=Counter)  # (kind, code)
    phases: dict = field(default_factory=dict)  # kind -> its phase, for a kind GROUPS doesn't list


def tally_event(result: dict, driver_of: dict[int, int], types: dict[str, str]) -> dict[int, Tally]:
    """Every driver's Tally at an event, from its technique check (result) and who drove each run now (driver_of:
    session id -> driver id; runs nobody is named for are left out). Only the obvious mistakes count, each at the
    time it really cost: never the pieces of the gap to the perfect lap. The same kind at the same corner of a lap
    counts once, at the larger cost; the mistakes of one group (or anything at all, for the corner types) at the same
    corner of a lap count once too, so overlapping findings never add up."""
    codes = [s["code"] for s in result.get("sections") or []]
    if not codes:
        return {}
    n_type = Counter(types[c] for c in codes if c in types)
    out: dict[int, Tally] = {}
    for lap in result.get("laps") or []:
        d = driver_of.get(int(lap["session_id"]))
        if d is None:
            continue
        t = out.setdefault(d, Tally())
        t.laps += 1
        t.passes += len(codes)
        t.type_passes.update(n_type)
        found: dict[tuple[str, str], tuple[float, str | None]] = {}
        for m in lap.get("obvious") or []:
            k = (m["kind"], m["code"])
            cost = float(m.get("cost_s") or 0.0)
            if k not in found or cost > found[k][0]:
                found[k] = (cost, m.get("phase"))
        by_group: dict[tuple[str, str], float] = {}
        for (kind, code), (cost, phase) in found.items():
            t.hits[kind] += 1
            t.cost[kind] += cost
            t.kind_code_hits[(kind, code)] += 1
            t.phases.setdefault(kind, phase)
            if code in types:
                t.kind_type_hits[(kind, types[code])] += 1
            g = (group_of(kind, phase), code)
            by_group[g] = max(by_group.get(g, 0.0), cost)
        by_code: dict[str, float] = {}  # what the corner's mistakes cost: each group's costliest, added up
        for (g, code), cost in by_group.items():
            t.group_hits[g] += 1
            t.group_cost[g] += cost
            by_code[code] = by_code.get(code, 0.0) + cost
        for code, cost in by_code.items():
            if code in types:
                t.type_cost[types[code]] += cost
                if cost >= COSTLY_S:
                    t.type_hits[types[code]] += 1
    return out


# ---------- over every event ----------

@dataclass
class Event:
    id: int
    label: str  # the track, with the year when the driver went there more than once
    tallies: dict[int, Tally]


def pct(x: float) -> str:
    if 0 < x < 0.005:
        return "under 1%"
    return f"{round(100 * x)}%"


def _names(labels: list[str], latest: bool) -> str:
    if len(labels) == 1:
        return labels[0]
    if len(labels) == 2:
        return f"{labels[0]} and {labels[1]}"
    return f"the {len(labels)} {'latest' if latest else 'earlier'} events"


def trend(points: list[tuple[int, int, str]]) -> dict | None:
    """Better, worse or about the same: the rate at the driver's earlier events against their recent ones. points:
    (hits, corners driven, event label) per event, oldest first, events with too few laps left out by the caller."""
    if len(points) < 2:
        return None
    half = len(points) // 2
    early, recent = points[:half], points[half:]
    ha, na = sum(p[0] for p in early), sum(p[1] for p in early)
    hb, nb = sum(p[0] for p in recent), sum(p[1] for p in recent)
    if min(na, nb) < TREND_CORNERS:
        return None
    a, b = ha / na, hb / nb
    pooled = (ha + hb) / (na + nb)
    se = float(np.sqrt(pooled * (1 - pooled) * (1 / na + 1 / nb)))
    real = abs(b - a) >= max(TREND_MIN, TREND_SHARE * max(a, b)) and abs(b - a) >= TREND_Z * se
    then, now = _names([p[2] for p in early], False), _names([p[2] for p in recent], True)
    if real and b < a:
        return {"dir": "better", "words": f"Better: from {pct(a)} of corners at {then} to {pct(b)} at {now}."}
    if real:
        return {"dir": "worse", "words": f"Worse: from {pct(a)} of corners at {then} to {pct(b)} at {now}."}
    return {"dir": "steady", "words": f"About the same: {pct(a)} of corners at {then}, {pct(b)} at {now}."}


def stat(rows: list[tuple[Event, int, int, float, int]]) -> dict:
    """A habit's numbers over every event: rows are (event, hits, passes, cost, laps), oldest first, for the events
    the driver drove."""
    rows = [r for r in rows if r[4] > 0 and r[2] > 0]
    hits, passes = sum(r[1] for r in rows), sum(r[2] for r in rows)
    cost, laps = sum(r[3] for r in rows), sum(r[4] for r in rows)
    pts = [(r[1], r[2], r[0].label) for r in rows if r[4] >= MIN_EVENT_LAPS]
    return {"rate": round(hits / passes, 4) if passes else 0.0,
            "cost_per_lap_s": round(cost / laps, 3) if laps else 0.0,
            "laps": laps, "events": len(rows), "trend": trend(pts),
            "by_event": [{"event_id": r[0].id, "rate": round(r[1] / r[2], 4), "cost_per_lap_s": round(r[3] / r[4], 3),
                          "laps": r[4]} for r in rows]}


def _drivers_of(events: list[Event]) -> list[int]:
    laps: Counter = Counter()
    for e in events:
        for d, t in e.tallies.items():
            laps[d] += t.laps
    return [d for d, n in laps.most_common() if n > 0]


def tracker(events: list[Event], names: dict[int, str], codes: dict[int, str], tracks: dict[int, str | None],
            styles: dict[int, dict[int, dict[str, float]]] | None = None) -> dict:
    """The habit tracker's answer from every event's tallies (oldest first). names and codes: driver id -> name and
    three-letter code; tracks: event id -> track name; styles: event id -> driver id -> fingerprint by kind (the
    mean over the driver's laps there)."""
    drivers = _drivers_of(events)

    def rows(d: int, part) -> list[tuple[Event, int, int, float, int]]:
        out = []
        for e in events:
            t = e.tallies.get(d)
            if t is not None and t.laps:
                hits, passes, cost = part(t)
                out.append((e, hits, passes, cost, t.laps))
        return out

    groups = [{"key": g, "label": label,
               "drivers": {str(d): stat(rows(d, lambda t, g=g: (t.group_hits[g], t.passes, t.group_cost[g])))
                           for d in drivers}} for g, label in GROUPS.items()]
    corner_types = []
    for ty, label, note in TYPES:
        if not any(t.type_passes[ty] for e in events for t in e.tallies.values()):
            continue
        corner_types.append({"key": ty, "label": label, "note": note, "drivers": {
            str(d): stat(rows(d, lambda t, ty=ty: (t.type_hits[ty], t.type_passes[ty], t.type_cost[ty])))
            for d in drivers if any(e.tallies.get(d) and e.tallies[d].type_passes[ty] for e in events)}})
    kinds = {k for e in events for t in e.tallies.values() for k, n in t.hits.items() if n}
    habits = []
    for kind in kinds:
        if max((sum(e.tallies[d].hits[kind] for e in events if d in e.tallies) for d in drivers), default=0) \
                < HABIT_MIN_HITS:
            continue
        per = {}
        for d in drivers:
            st = stat(rows(d, lambda t, kind=kind: (t.hits[kind], t.passes, t.cost[kind])))
            spots = sorted(((t.kind_code_hits[(kind, c)] / t.laps, c, e.id) for e in events
                            if (t := e.tallies.get(d)) is not None and t.laps >= MIN_EVENT_LAPS
                            for (k, c) in t.kind_code_hits if k == kind), reverse=True)
            st["corners"] = [{"code": c, "event_id": eid, "track": tracks.get(eid), "rate": round(r, 3)}
                             for r, c, eid in spots if r >= CORNER_MIN_RATE][:CORNER_SHOWN]
            ty_hits, ty_passes = Counter(), Counter()
            for e in events:
                t = e.tallies.get(d)
                if t is None:
                    continue
                ty_passes.update(t.type_passes)
                for (k, ty), n in t.kind_type_hits.items():
                    if k == kind:
                        ty_hits[ty] += n
            st["types"] = {ty: round(ty_hits[ty] / n, 4) for ty, n in ty_passes.items() if n}
            per[str(d)] = st
        phase = next((t.phases[kind] for e in events for t in e.tallies.values() if kind in t.phases), None)
        habits.append({"kind": kind, "label": LABELS.get(kind, kind.replace("_", " ").capitalize()),
                       "group": group_of(kind, phase), "do": DO.get(kind, ""), "drivers": per})
    habits.sort(key=lambda h: (-max((s["cost_per_lap_s"] for s in h["drivers"].values()), default=0.0), h["kind"]))
    return {
        "drivers": [{"id": d, "name": names.get(d, f"Driver {d}"), "code": codes.get(d, ""),
                     "laps": sum(e.tallies[d].laps for e in events if d in e.tallies),
                     "events": sum(1 for e in events if d in e.tallies and e.tallies[d].laps)} for d in drivers],
        "groups": groups,
        "corner_types": corner_types,
        "corner_types_note": f"A corner counts when its mistakes cost {COSTLY_S:.1f} s or more on that lap.",
        "habits": habits[:HABITS_KEPT],
        "pairs": style_pairs(styles or {}, drivers),
    }


# ---------- styles side by side ----------

def style_pairs(styles: dict[int, dict[int, dict[str, float]]], drivers: list[int]) -> list[dict]:
    """For every two drivers who shared the car at some event: the ways they differ there, from their fingerprints
    (relative to the event's laps), kept when the difference goes the same way at STYLE_AGREE of their shared events
    and is a trait (driver_style.TRAIT_AT) on average. Driver a is the lower id."""
    out = []
    ids = sorted(set(drivers))
    for i, a in enumerate(ids):
        for b in ids[i + 1:]:
            shared = [ev for ev in styles.values() if a in ev and b in ev]
            if not shared:
                continue
            traits = []
            for kind, k in ds.KINDS.items():
                if k.outcome:
                    continue
                diffs = [ev[a][kind] - ev[b][kind] for ev in shared if kind in ev[a] and kind in ev[b]]
                if not diffs:
                    continue
                mean = float(np.mean(diffs))
                agree = sum(1 for x in diffs if np.sign(x) == np.sign(mean) and x != 0)
                if abs(mean) < ds.TRAIT_AT or agree < STYLE_AGREE * len(diffs):
                    continue
                traits.append({"kind": kind, "group": STYLE_GROUP.get(kind, "corner"), "label": k.label,
                               "explain": k.explain, "words": k.more if mean > 0 else k.less,
                               "words_b": k.less if mean > 0 else k.more, "agree": agree, "of": len(diffs),
                               "size": round(abs(mean), 2)})
            traits.sort(key=lambda x: (-x["agree"], -x["size"]))
            out.append({"a": a, "b": b, "events": len(shared), "traits": traits[:STYLE_KEPT]})
    return out
