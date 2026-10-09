"""Who drove: each driver's style fingerprint, found from the laps alone.

Every clean lap gets a fingerprint of how it was driven at each corner: where the braking starts and how fast the
pressure builds, how hard it peaks, how long the brake is trailed into the corner and how much of the stop is spent
near the peak, the coasting before the throttle, where the throttle comes back and how fast it opens, the steering's
lock and how busy it is, the slowest point's speed and where it sits, and the gear there; plus a few whole-lap habits
(pedal rates, coasting, pedal overlap, steering corrections). Every feature is scaled over the event's laps, so it
says how a lap differs from the event's typical lap.

Lap averages alone barely tell drivers apart; the corner by corner shape does. On the Zandvoort 2026 weekend
(Piana and Rackl), the corners split all 66 laps right with no names given, and a model trained on two sessions
named every lap of the third.

The same features averaged over the corners (a "kind": the trail braking of the lap, the brake build-up of the lap)
no longer depend on the track's corners, so a driver's fingerprint from one event finds them at another: Piana's
from Zandvoort found his runs at Paul Ricard and Monza, in line with the series' rule that the first qualifier
starts race 1. These kinds are relative to the other drivers of the car at that event (two drivers sharing a car
show as opposite fingerprints), so they recognise a driver best against teammates seen before.

Three ways to a suggestion, best first:
- tagged: two or more drivers of the event already have tagged runs; each lap goes to the nearest of their corner
  by corner fingerprints.
- groups: the laps are split into style groups (k-means); each group is named after a tagged run in it, or after
  the known driver whose fingerprint from other events it matches. A split only counts when it is clear: a single
  driver's laps from two sessions also split a little (track, tyres and fuel change), less cleanly than two drivers
  do (silhouette 0.16-0.19 for one driver against 0.20-0.30 for two on the logs checked); a weaker split counts when
  its groups match two different known drivers.
- one style: every lap looks like one driver.

A car with two drivers (the season's, or the event's own list: pair) splits into two styles at most, and they are
those two: a style named after a tagged run makes the other the teammate, and otherwise the known fingerprints only
need to say which way round fits better (DECIDE_MARGIN), not to match closely ("every outing that is not PIA must be
RAC", Gabriele, 2026-10-07).

A run is cut into stints where its laps are not consecutive (a pit stop or a slow lap between): each stint goes to
the group most of its laps are in, stints of one group next to each other are joined. A run whose stints go to two
groups had a driver change at a stop.

Suggestions only: nothing is tagged until the user confirms it.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field

import numpy as np

from app.analysis.laps import Corner, detect_corners

VERSION = 1  # raise when the features change: every event's fingerprint is worked out again
BRAKE_ON = 0.08  # of the event's top brake pressure
THROTTLE_ON = 10.0  # % pedal
THROTTLE_FULL = 90.0
MIN_LAPS = 6  # fewer clean laps in an event and nothing is suggested
CLEAR_SPLIT = 0.25  # silhouette of a style split that is clearly two drivers
LIKELY_SPLIT = 0.20  # ... likely two drivers
KNOWN_SPLIT = 0.15  # ... two drivers when its groups match two different known drivers
MATCH_COS = 0.3  # a group's fingerprint this close (cosine) to a known driver's is that driver
DECIDE_MARGIN = 0.1  # of two drivers, one way round fits this much better (summed cosines): the styles are named
MIN_GROUP_LAPS = 3
MIN_GROUP_SHARE = 0.10
MIN_STINT_LAPS = 3  # a shorter stint is joined to its neighbour: too few laps to call a driver change on
N_COMPONENTS = 10
SEED = 7
TRAIT_AT = 0.3  # spreads of the event's laps: a kind this far from the event's typical lap is a trait


@dataclass(frozen=True)
class Kind:
    label: str
    explain: str
    more: str  # the words when a driver's value is higher than their teammates'
    less: str
    outcome: bool = False  # a result of a quicker lap rather than a way of driving: never suggested


KINDS: dict[str, Kind] = {
    "brake_on": Kind("Braking point", "Where the braking starts, measured back from the slowest point of the corner.",
                     "brakes later", "brakes earlier"),
    "brake_peak": Kind("Peak brake pressure", "The highest brake pressure of each stop.",
                       "brakes harder", "brakes with less pressure"),
    "brake_build": Kind("Brake build-up", "The distance from first touching the brake to its peak pressure.",
                        "builds the brake pressure more gradually", "builds the brake pressure faster"),
    "brake_off": Kind("Brake release point", "Where the brake is fully let off, against the slowest point.",
                      "keeps the brake on later into the corner", "is off the brake earlier"),
    "trail": Kind("Trail braking", "Brake pressure held while the wheel is turned, into the corner.",
                  "trails the brake deeper into the corner", "does more of the braking in a straight line"),
    "brake_fullness": Kind("Brake shape", "How much of the stop is spent near the peak pressure: a square stop "
                           "holds the peak, a triangular one peaks and bleeds off.",
                           "holds the peak pressure longer (square stops)", "peaks and bleeds off (triangular stops)"),
    "coast": Kind("Coasting", "The distance between letting off the brake and picking up the throttle.",
                  "coasts longer between brake and throttle", "goes from brake to throttle with less coasting"),
    "throttle_on": Kind("Throttle pick-up", "Where the throttle comes back, against the slowest point.",
                        "picks up the throttle later", "picks up the throttle earlier"),
    "throttle_ramp": Kind("Throttle opening", "The distance from picking up the throttle to full throttle.",
                          "opens the throttle more progressively", "opens the throttle more quickly"),
    "lift": Kind("Lift in fast corners", "The lowest throttle through corners taken without braking.",
                 "lifts less in the fast corners", "lifts more in the fast corners"),
    "vmin": Kind("Minimum speed", "The speed at the slowest point of each corner.",
                 "carries more minimum speed", "slows the car more for the corners"),
    "vmin_at": Kind("Slowest point", "Where the slowest point of the corner sits: later suits a V-shaped line "
                    "(slow, turn, go), earlier a U-shaped one (roll speed through the middle).",
                    "has the slowest point later (V-shaped corners)",
                    "has the slowest point earlier (U-shaped corners)"),
    "gear": Kind("Gear at the slowest point", "The gear used at the slowest point of each corner.",
                 "uses a higher gear in the corners", "uses a lower gear in the corners"),
    "steer_lock": Kind("Steering lock", "The most steering used in each corner.",
                       "uses more steering lock", "uses less steering lock"),
    "steer_busy": Kind("Steering corrections in corners", "How much the steering keeps changing direction "
                       "through each corner.", "makes more steering corrections", "steers more smoothly"),
    "lap_full_throttle": Kind("Full throttle", "The share of the lap at full throttle.",
                              "is at full throttle more", "is at full throttle less", outcome=True),
    "lap_braking": Kind("Time on the brakes", "The share of the lap on the brakes.",
                        "spends more of the lap braking", "spends less of the lap braking", outcome=True),
    "lap_coasting": Kind("Coasting over the lap", "The share of the lap on neither pedal.",
                         "coasts more over the lap", "coasts less over the lap"),
    "lap_overlap": Kind("Pedal overlap", "The share of the lap on both pedals at once.",
                        "overlaps brake and throttle more", "overlaps brake and throttle less"),
    "lap_part_throttle": Kind("Part throttle", "The share of the lap between 10 and 90 % throttle.",
                              "uses more part throttle", "uses less part throttle"),
    "lap_steer_rate": Kind("Steering speed", "How fast the wheel is turned (the quick end of it).",
                           "turns the wheel faster", "turns the wheel more slowly"),
    "lap_steer_corrections": Kind("Steering corrections", "Changes of steering direction per second over the lap.",
                                  "corrects the steering more often", "corrects the steering less often"),
    "lap_throttle_open_rate": Kind("Throttle application speed", "How fast the throttle is opened.",
                                   "opens the throttle faster", "opens the throttle more slowly"),
    "lap_throttle_close_rate": Kind("Throttle lift speed", "How fast the throttle is closed.",
                                    "snaps off the throttle faster", "eases off the throttle"),
    "lap_throttle_corrections": Kind("Throttle corrections", "Changes of throttle direction per second.",
                                     "modulates the throttle more", "modulates the throttle less"),
    "lap_brake_apply_rate": Kind("Brake application speed", "How fast the brake pressure goes on.",
                                 "hits the brake faster", "applies the brake more slowly"),
    "lap_brake_release_rate": Kind("Brake release speed", "How fast the brake pressure comes off.",
                                   "releases the brake faster", "releases the brake more slowly"),
}


@dataclass
class EventLap:
    session_id: int
    number: int
    time: float
    trace: dict[str, np.ndarray]  # on one line for the whole event, every metre: t, speed, throttle, brake, steer, gear


@dataclass
class EventPrint:
    """An event's fingerprints: per lap its corner by corner features (z) and their averages by kind (v)."""
    sessions: list[int]
    numbers: list[int]
    times: list[float]
    keys: list[str]
    z: np.ndarray  # [lap, feature], scaled over the event
    kinds: list[str]
    v: np.ndarray  # [lap, kind], scaled over the event

    def to_json(self) -> dict:
        return {"version": VERSION, "sessions": self.sessions, "numbers": self.numbers, "times": self.times,
                "keys": self.keys, "kinds": self.kinds, "z": np.round(self.z, 3).tolist(),
                "v": np.round(self.v, 3).tolist()}

    @staticmethod
    def from_json(d: dict) -> EventPrint | None:
        if d.get("version") != VERSION or not d.get("numbers"):
            return None
        return EventPrint(d["sessions"], d["numbers"], d["times"], d["keys"], np.array(d["z"], float), d["kinds"],
                          np.array(d["v"], float))


@dataclass
class Stint:
    laps: list[int]  # lap numbers
    group: int
    share: float  # of its laps that are in that group


@dataclass
class SessionGuess:
    session_id: int
    group: int  # of its longest stint
    share: float  # of its laps in that group
    laps: int
    stints: list[Stint] = field(default_factory=list)


@dataclass
class Group:
    driver_id: int | None  # the driver it is, when known
    source: str  # "tag" (a tagged run of this event), "fingerprint" (a known driver's), "" (unknown)
    laps: int
    match: float | None = None  # cosine to the known driver's fingerprint
    v: np.ndarray | None = None  # the group's mean fingerprint by kind
    hint: int | None = None  # a known driver it is only somewhat like (app/driver_prints.py: asked, named first)


@dataclass
class Guess:
    mode: str  # "tagged", "alike" (tagged, but too alike to tell apart), "groups", "one style", "too few laps"
    separation: float | None  # silhouette of the groups
    groups: list[Group]
    sessions: list[SessionGuess]
    labels: np.ndarray  # group of every lap, in the print's order


# ---------- features ----------

def _first(mask: np.ndarray) -> int | None:
    i = np.flatnonzero(mask)
    return int(i[0]) if len(i) else None


def _rates(y: np.ndarray, dt: float) -> tuple[float, float]:
    d = np.diff(y) / dt
    up, down = d[d > 0], -d[d < 0]
    return (float(np.percentile(up, 90)) if len(up) else 0.0, float(np.percentile(down, 90)) if len(down) else 0.0)


def _reversals(y: np.ndarray, dt: float, min_rate: float) -> float:
    d = np.diff(y) / dt
    s = np.sign(d[np.abs(d) > min_rate])
    return float(np.count_nonzero(np.diff(s)))


def lap_features(tr: dict[str, np.ndarray], corners: list[Corner], brake_top: float, steer_top: float) -> dict:
    """One lap's features: lap_<kind> for the whole lap, <corner>_<kind> for each corner."""
    v, thr = tr["speed"], tr["throttle"]
    br = tr["brake"] / brake_top
    st = tr["steer"] / steer_top
    t = tr["t"]
    gear = tr.get("gear")
    on = br > BRAKE_ON
    f: dict[str, float] = {}
    duration = max(float(t[-1] - t[0]), 1.0)
    f["lap_full_throttle"] = float(np.mean(thr > 95))
    f["lap_braking"] = float(np.mean(on))
    f["lap_coasting"] = float(np.mean(~on & (thr < THROTTLE_ON)))
    f["lap_overlap"] = float(np.mean(on & (thr > THROTTLE_ON)))
    f["lap_part_throttle"] = float(np.mean((thr > THROTTLE_ON) & (thr < THROTTLE_FULL)))
    dt = 0.02  # pedal and steering rates on a time grid
    tt = np.arange(t[0], t[-1], dt)
    if len(tt) > 10:
        s_t, th_t, b_t = np.interp(tt, t, st), np.interp(tt, t, thr), np.interp(tt, t, br)
        s_t = np.convolve(s_t, np.ones(3) / 3, "same")
        f["lap_steer_rate"] = float(np.percentile(np.abs(np.diff(s_t)) / dt, 90))
        f["lap_steer_corrections"] = _reversals(s_t, dt, 0.05) / duration
        f["lap_throttle_open_rate"], f["lap_throttle_close_rate"] = _rates(th_t, dt)
        f["lap_throttle_corrections"] = _reversals(th_t, dt, 50) / duration
        f["lap_brake_apply_rate"], f["lap_brake_release_rate"] = _rates(b_t, dt)
    for c in corners:
        k, a = c.code, c.apex
        lo, hi = max(c.start, a - 400), min(c.end, a + 300)
        if hi - lo < 20 or a <= lo:
            continue
        m = lo + int(np.argmin(v[lo:hi]))
        f[f"{k}_vmin"] = float(v[m])
        f[f"{k}_vmin_at"] = float(m - a)
        start = _first(on[lo:a + 30])
        if start is not None and np.count_nonzero(on[lo:a + 30]) > 5:
            b0 = lo + start
            peak = b0 + int(np.argmax(br[b0:a + 30]))
            off = _first(~on[peak:hi])
            b1 = peak + (off if off is not None else hi - peak)
            f[f"{k}_brake_on"] = float(b0 - a)
            f[f"{k}_brake_peak"] = float(br[peak])
            f[f"{k}_brake_build"] = float(peak - b0)
            f[f"{k}_brake_off"] = float(b1 - a)
            f[f"{k}_trail"] = float(np.sum(br[peak:b1] * np.abs(st[peak:b1])))
            f[f"{k}_brake_fullness"] = float(br[b0:max(b1, b0 + 1)].mean() / max(br[peak], 1e-3))
            back = _first(thr[b1:hi] > THROTTLE_ON)
            t_on = b1 + (back if back is not None else hi - b1)
            f[f"{k}_coast"] = float(t_on - b1)
        else:
            s0 = max(a - 100, lo)
            back = _first(thr[s0:hi] > THROTTLE_ON)
            t_on = s0 + (back if back is not None else hi - s0)
            f[f"{k}_lift"] = float(thr[lo:a].min())
        f[f"{k}_throttle_on"] = float(t_on - a)
        full = _first(thr[t_on:hi] > THROTTLE_FULL)
        f[f"{k}_throttle_ramp"] = float(full if full is not None else hi - t_on)
        f[f"{k}_steer_lock"] = float(np.abs(st[lo:hi]).max())
        f[f"{k}_steer_busy"] = float(np.abs(np.diff(st[lo:hi], 2)).sum())
        if gear is not None:
            f[f"{k}_gear"] = float(gear[m])
    return f


def kind_of(key: str) -> str:
    return key if key.startswith("lap_") else re.sub(r"^[^_]+_", "", key, count=1)


def _scaled(x: np.ndarray) -> np.ndarray:
    sd = x.std(0)
    return (x - x.mean(0)) / np.where(sd > 1e-9, sd, 1.0)


def event_print(laps: list[EventLap]) -> EventPrint | None:
    """Every lap's fingerprint, scaled over the event's laps."""
    need = ("t", "speed", "throttle", "brake", "steer")
    laps = [l for l in laps if all(r in l.trace for r in need)]
    if len(laps) < MIN_LAPS:
        return None
    ref = {"speed": np.median(np.stack([l.trace["speed"] for l in laps]), 0)}
    corners = detect_corners(ref, min_drop_kmh=20)
    brake = np.concatenate([l.trace["brake"] for l in laps])
    steer = np.abs(np.concatenate([l.trace["steer"] for l in laps]))
    brake_top = max(float(np.percentile(brake, 99.5)), 1e-6)
    steer_top = max(float(np.percentile(steer, 99.5)), 1e-6)
    rows = [lap_features(l.trace, corners, brake_top, steer_top) for l in laps]
    keys = sorted(set().union(*rows))
    x = np.array([[r.get(k, np.nan) for k in keys] for r in rows], float)
    # a corner braked on some laps and not on others: the laps without a value take the event's typical one
    med = np.array([np.nanmedian(c) if np.isfinite(c).any() else 0.0 for c in x.T])
    x = np.where(np.isfinite(x), x, med)
    keep = x.std(0) > 1e-9
    z, keys = _scaled(x[:, keep]), [k for k, ok in zip(keys, keep, strict=True) if ok]
    kinds = sorted({kind_of(k) for k in keys} & set(KINDS))
    v = _scaled(np.stack([z[:, [i for i, k in enumerate(keys) if kind_of(k) == n]].mean(1) for n in kinds], 1))
    return EventPrint([l.session_id for l in laps], [l.number for l in laps], [round(l.time, 3) for l in laps],
                      keys, z, kinds, v)


# ---------- grouping ----------

def _components(z: np.ndarray, n: int = N_COMPONENTS) -> np.ndarray:
    u, s, _ = np.linalg.svd(z - z.mean(0), full_matrices=False)
    n = min(n, len(s))
    return u[:, :n] * s[:n]


def _kmeans(p: np.ndarray, k: int, n_init: int = 20) -> np.ndarray:
    rng = np.random.default_rng(SEED)
    best, best_cost = np.zeros(len(p), int), np.inf
    for _ in range(n_init):
        centres = [p[rng.integers(len(p))]]
        for _ in range(1, k):  # k-means++ start
            d2 = np.min([((p - c) ** 2).sum(1) for c in centres], 0)
            centres.append(p[rng.choice(len(p), p=d2 / d2.sum())] if d2.sum() > 0 else p[rng.integers(len(p))])
        c = np.array(centres)
        lab = np.zeros(len(p), int)
        for _ in range(100):
            lab = ((p[:, None] - c[None]) ** 2).sum(2).argmin(1)
            new = np.array([p[lab == j].mean(0) if np.any(lab == j) else c[j] for j in range(k)])
            if np.allclose(new, c):
                break
            c = new
        cost = float(((p - c[lab]) ** 2).sum())
        if cost < best_cost:
            best, best_cost = lab, cost
    return best


def silhouette(p: np.ndarray, lab: np.ndarray) -> float:
    groups = np.unique(lab)
    if len(groups) < 2:
        return 0.0
    d = np.sqrt(((p[:, None] - p[None]) ** 2).sum(2))
    s = np.zeros(len(p))
    for i in range(len(p)):
        own = lab == lab[i]
        if own.sum() <= 1:
            continue
        a = d[i, own].sum() / (own.sum() - 1)
        b = min(d[i, lab == g].mean() for g in groups if g != lab[i])
        s[i] = (b - a) / max(a, b) if max(a, b) > 0 else 0.0
    return float(s.mean())


def style_groups(p: np.ndarray, min_split: float = KNOWN_SPLIT, max_groups: int = 3) -> tuple[np.ndarray, float] | None:
    """The laps' best split into 2 to max_groups style groups and how clearly they separate (silhouette), or None."""
    n = len(p)
    best: tuple[np.ndarray, float] | None = None
    for k in range(2, max_groups + 1):
        if n < k * MIN_GROUP_LAPS:
            continue
        lab = _kmeans(p, k)
        sizes = np.bincount(lab, minlength=k)
        if sizes.min() < max(MIN_GROUP_LAPS, MIN_GROUP_SHARE * n):
            continue
        s = silhouette(p, lab)
        if s >= min_split and (best is None or s > best[1] + 0.02):  # a third group must earn its place
            best = (lab, s)
    return best


def told_apart(p: np.ndarray, driver: np.ndarray, tagged: list[int]) -> bool:
    """Whether the tagged drivers' laps (``driver``: each lap's driver id, -1 untagged) separate by style as clearly
    as two drivers do when the style finds them by itself (silhouette LIKELY_SPLIT). Two drivers who drive alike
    (Gabriele, 2026-10-09: "The driving style between SYL and PIA is apparently too similar for the app to
    recognize") separate no better than one driver's runs on other tyres do, so their other runs can't be put to
    the nearer of them. With fewer than MIN_GROUP_LAPS laps of a driver there is too little to tell: as before."""
    mine = driver >= 0
    if any(np.count_nonzero(driver == d) < MIN_GROUP_LAPS for d in tagged):
        return True
    return silhouette(p[mine], driver[mine]) >= LIKELY_SPLIT


def _cos(a: np.ndarray, b: np.ndarray) -> float:
    na, nb = np.linalg.norm(a), np.linalg.norm(b)
    return float(a @ b / (na * nb)) if na > 0 and nb > 0 else 0.0


def match_known(vecs: list[np.ndarray], known: dict[int, np.ndarray], taken: set[int] = frozenset()
                ) -> list[tuple[int, float] | None]:
    """Each group's known driver (a different one for each group) by the closest fingerprint, or None."""
    pairs = sorted(((_cos(v, kv), g, d) for g, v in enumerate(vecs) for d, kv in known.items() if d not in taken),
                   reverse=True)
    out: list[tuple[int, float] | None] = [None] * len(vecs)
    used = set(taken)
    for c, g, d in pairs:
        if c < MATCH_COS or out[g] is not None or d in used:
            continue
        out[g], used = (d, c), used | {d}
    return out


def pair_names(vecs: list[np.ndarray], names: list, pair: tuple[int, int], known: dict[int, np.ndarray]) -> list:
    """The two styles of a two-driver car named: one named after a tagged run of one of them makes the other the
    teammate ("entry"); with none, the way round the known fingerprints fit better, when clearly better ("pair", with
    each style's cosine to its driver's fingerprint where known). names: (driver, source, match) or None per style."""
    a, b = pair

    def fit(g: int, d: int) -> float:
        return _cos(vecs[g], known[d]) if d in known else 0.0

    named = [g for g in range(2) if names[g] is not None]
    if named:
        d = names[named[0]][0]
        if len(named) == 1 and d in pair:
            other = b if d == a else a
            names[1 - named[0]] = (other, "entry", fit(1 - named[0], other) if other in known else None)
        return names

    one, two = fit(0, a) + fit(1, b), fit(0, b) + fit(1, a)
    if abs(one - two) < DECIDE_MARGIN:
        return names
    first, second = (a, b) if one > two else (b, a)
    return [(d, "pair", fit(g, d) if d in known else None) for g, d in ((0, first), (1, second))]


def _stints(numbers: list[int], lab: list[int]) -> list[Stint]:
    """A run's laps (in order) cut where they are not consecutive, each piece given its laps' most common group,
    neighbours of one group joined and pieces too short to call joined to the longer neighbour."""
    pieces: list[list[int]] = []
    for i, n in enumerate(numbers):
        if pieces and n == numbers[i - 1] + 1:
            pieces[-1].append(i)
        else:
            pieces.append([i])
    out: list[tuple[list[int], int]] = []

    def join_same() -> None:
        j = 0
        while j < len(out) - 1:
            if out[j][1] == out[j + 1][1]:
                out[j:j + 2] = [(out[j][0] + out[j + 1][0], out[j][1])]
            else:
                j += 1

    for idx in pieces:
        out.append((list(idx), int(np.bincount([lab[i] for i in idx]).argmax())))
    join_same()
    while len(out) > 1:
        short = min(range(len(out)), key=lambda j: len(out[j][0]))
        if len(out[short][0]) >= MIN_STINT_LAPS:
            break
        into = max((j for j in (short - 1, short + 1) if 0 <= j < len(out)), key=lambda j: len(out[j][0]))
        lo, hi = sorted((short, into))
        out[lo:hi + 1] = [(sorted(out[lo][0] + out[hi][0]), out[into][1])]
        join_same()
    return [Stint([numbers[i] for i in idx], g, float(np.mean([lab[i] == g for i in idx]))) for idx, g in out]


def guess(ep: EventPrint, tags: dict[int, int | None], known: dict[int, np.ndarray] | None = None,
          max_groups: int = 3, pair: tuple[int, int] | None = None) -> Guess:
    """Style groups, named where possible, and every session's stints. tags: session id -> its driver id (None when
    untagged). known: driver id -> fingerprint by kind from other events (in ep.kinds' order). max_groups: how many
    drivers the car could have had (two in a two-driver car: a third group would be one of them on other tyres).
    pair: the car's two drivers, when it had exactly two (pair_names)."""
    known = known or {}
    n = len(ep.numbers)
    if n < MIN_LAPS:
        return Guess("too few laps", None, [], [], np.zeros(n, int))
    p = _components(ep.z)
    sid = np.array(ep.sessions)
    driver = np.array([tags.get(int(s)) or -1 for s in sid])
    tagged = sorted({int(d) for d in driver if d >= 0})
    separation = None
    if len(tagged) >= 2:
        mode = "tagged" if told_apart(p, driver, tagged) else "alike"
        centres = np.array([p[driver == d].mean(0) for d in tagged])
        lab = ((p[:, None] - centres[None]) ** 2).sum(2).argmin(1)
        groups = [Group(d, "tag", 0) for d in tagged]
    else:
        found = style_groups(p, max_groups=max_groups)
        groups = []
        if found is not None:
            lab, separation = found
            k = int(lab.max()) + 1
            vecs = [ep.v[lab == g].mean(0) for g in range(k)]
            names: list[tuple[int, str, float | None] | None] = [None] * k
            if tagged:  # the tagged driver names the group most of their laps are in
                g = int(np.bincount(lab[driver == tagged[0]], minlength=k).argmax())
                names[g] = (tagged[0], "tag", None)
            if pair is not None and k == 2:
                names = pair_names(vecs, names, pair, known)
            else:
                rest = [g for g in range(k) if names[g] is None]
                for g, m in zip(rest, match_known([vecs[g] for g in rest], known, set(tagged)), strict=True):
                    if m is not None:
                        names[g] = (m[0], "fingerprint", m[1])
            named = {x[0] for x in names if x is not None and (x[1] == "tag" or (x[2] or 0) >= MATCH_COS)}
            if separation < LIKELY_SPLIT and len(named) < k:  # a weak split counts only when known drivers explain it
                found = None
            else:
                groups = [Group(x[0], x[1], 0, x[2]) if x else Group(None, "", 0) for x in names]
        if found is None:
            mode, lab, separation = "one style", np.zeros(n, int), None
            groups = [Group(tagged[0], "tag", 0) if tagged else Group(None, "", 0)]
        else:
            mode = "groups"
    for g, grp in enumerate(groups):
        grp.laps = int(np.count_nonzero(lab == g))
        grp.v = ep.v[lab == g].mean(0) if grp.laps else None
    sessions = []
    for s in dict.fromkeys(int(x) for x in sid):
        idx = sorted(np.flatnonzero(sid == s), key=lambda i: ep.numbers[i])
        own = [int(lab[i]) for i in idx]
        stints = _stints([ep.numbers[i] for i in idx], own)
        main = max(stints, key=lambda st: len(st.laps))
        sessions.append(SessionGuess(s, main.group, float(np.mean([g == main.group for g in own])), len(idx), stints))
    return Guess(mode, separation, groups, sessions, lab)


def confidence(g: Guess, grp: Group, share: float) -> str:
    """"sure" or "likely" for a suggestion from that group with that share of the run's laps in it."""
    if share < 0.8 or g.mode == "alike":
        return "likely"
    if g.mode == "tagged" or (grp.source == "fingerprint" and (grp.match or 0) >= 0.5):
        return "sure"
    return "sure" if g.mode == "groups" and (g.separation or 0) >= CLEAR_SPLIT else "likely"


# ---------- describing ----------

def traits(v: np.ndarray, kinds: list[str], top: int | None = None) -> list[dict]:
    """A fingerprint by kind in words: the kinds furthest from the typical lap first."""
    out = []
    for name, x in sorted(zip(kinds, v, strict=True), key=lambda p: -abs(p[1])):
        if name not in KINDS or abs(x) < TRAIT_AT:
            continue
        k = KINDS[name]
        out.append({"kind": name, "label": k.label, "explain": k.explain, "value": round(float(x), 2),
                    "words": k.more if x > 0 else k.less})
    return out[:top] if top else out


def lap_time_links(rows: list[tuple[np.ndarray, np.ndarray]], kinds: list[str], min_laps: int = 30) -> list[dict]:
    """Which kinds go with quicker laps: each run's laps against the run's own typical lap (so the track, tyres,
    fuel and driver of the run are taken out), pooled over the runs. rows: (lap times, fingerprints by kind) per
    run, runs of 4 laps or more. r < 0: more of it goes with quicker laps."""
    dt, dv = [], []
    for t, v in rows:
        if len(t) < 4 or np.std(t) <= 0:
            continue
        dt.append((t - t.mean()) / t.std())
        dv.append(v - v.mean(0))
    if not dt or sum(len(x) for x in dt) < min_laps:
        return []
    t, v = np.concatenate(dt), np.concatenate(dv)
    out = []
    for j, name in enumerate(kinds):
        if name not in KINDS or v[:, j].std() <= 0:
            continue
        r = float(np.corrcoef(v[:, j], t)[0, 1])
        if abs(r) < 0.2:
            continue
        k = KINDS[name]
        out.append({"kind": name, "label": k.label, "r": round(r, 2), "laps": len(t), "outcome": k.outcome,
                    "words": f"On quicker laps the driver {k.more if r < 0 else k.less}"})
    return sorted(out, key=lambda x: -abs(x["r"]))
