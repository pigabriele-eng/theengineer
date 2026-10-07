"""Predict qualifying times and finishing positions from past official results.

Everything here is a pure function over a list of *session dicts* in the shape the
result-list parser produces (one dict per Qualifying 1/2 or Race 1/2 classification,
with ``year``, ``order``, ``venue``, ``code``, ``weather`` and ``rows``). Nothing
touches the database or the network, and only numpy is used.

The model, in the order the numbers are built (all of it from information that
existed *before* the round being predicted):

1. **Pole time.** Every earlier dry qualifying pole is explained as
   ``log(pole) = venue base + season pace`` (a weighted least-squares fit, recent
   seasons weigh more). The prediction is the venue's base time times this
   season's pace. This season's pace comes from this season's earlier rounds
   compared with earlier visits to those circuits; before the first round of a
   season, last season's pace is used. Only circuits raced in two or more seasons
   inform season pace (a one-off circuit says nothing about it), a small ridge keeps
   each season's pace near the previous one's, and the pace change applied is clamped
   to +-``PACE_CLAMP_PCT``. A circuit whose times jumped by more than
   ``LAYOUT_JUMP_PCT`` between visits beyond the season pace (Barcelona before and
   after 2023) is treated as a new track from the jump on. A circuit with no
   earlier dry visit gets no time prediction (positions are still predicted).
2. **Our gap to pole (%)** = our current form + our circuit offset.
   *Form* is the median of our gap in this season's earlier dry qualifyings,
   shrunk toward last season's median when there are only a few rounds; Q1 and
   Q2 (different drivers) each lean a little toward their own sessions this season.
   *Circuit offset* is how our gap at this circuit compared with our own season
   median in earlier visits (car + BoP + track character, all in one number);
   when our team never raced there, other cars of our brand and class stand in.
   A single gap above ``GAP_CAP_PCT`` is capped (a lap that went wrong).
3. **Our qualifying time** = predicted pole x (1 + gap). When a logged best lap
   from practice at this circuit is given, it is first turned into a qualifying
   estimate (minus ``PRACTICE_TO_QUALI_PCT``) and blended in with weight
   ``LOGGED_WEIGHT``; the gap and the position follow the blended time.
4. **Qualifying position**: the predicted gap is laid on the gap-to-pole spread of
   the field in this season's earlier dry qualifyings plus earlier visits to the
   circuit: position = 1 + (share of the field that was quicker than that gap)
   x (expected entry). The same is done within our class.
5. **Race position** = 70 % (predicted grid + our usual gain) + 30 % our recent
   average finish (``RACE_FORM_WEIGHT``). The usual gain is the recency-weighted
   median of (finish - grid) of our team's earlier races, shrunk toward the
   field-wide median for that grid slot. Q1 sets the Race 1 grid, Q2 the Race 2
   grid. Retirements are left out, so the race number is "if we finish".

The weights were picked by backtesting 2023-2026 (see ``backtest``); most of them
change the errors very little, the circuit offset and the race-form blend help most.

**Wet sessions.** A session flagged ``Wet`` at its start or its end is left out
of every lap-time and gap model, because a wet lap says nothing about dry pace. When a sheet gives no conditions
(ADAC GT4 Germany's tables), a session more than ``WET_PCT`` slower than the weekend's best lap counts as wet.
Wet sessions still count for race finishing positions. Predictions assume a dry
session.

**Ranges.** Every number comes with a likely range: the size of the model's own
misses when it predicted the last ``RANGE_ROUNDS`` rounds before this one (an
inner backtest with the same no-lookahead rule, 80th percentile of the absolute
error). With too little history to backtest, fixed fallbacks are used.
"""

from __future__ import annotations

import math
import re
from collections.abc import Iterable, Sequence
from itertools import pairwise
from statistics import median
from typing import Any

import numpy as np

QUALI_CODES = ("Q1", "Q2")
RACE_CODES = ("R1", "R2")
GRID_FOR = {"R1": "Q1", "R2": "Q2"}

SEASON_DECAY = 0.6  # weight of a season n years back = DECAY**n (pole fit, circuit offsets, race gains)
CODE_FORM_PRIOR = 4.0  # Q1 / Q2 own form is shrunk toward the overall form as if from 4 sessions
FORM_PRIOR_ROUNDS = 2.0  # last season's form counts like this many dry qualifyings of the current one
OFFSET_PRIOR = 1.0  # circuit offset is shrunk toward 0 as if 1 visit had shown no offset
BRAND_OFFSET_WEIGHT = 0.5  # how much a brand-only circuit offset is trusted relative to our own
GAP_CAP_PCT = 4.0  # a qualifying gap beyond this is a lap that went wrong; it is capped, not believed
GAIN_PRIOR_RACES = 4.0  # our race gain is shrunk toward the field's gain as if from 4 races
RACE_FORM_WEIGHT = 0.3  # race finish = this share of our recent race finishes + the rest from grid + usual gain
PRACTICE_TO_QUALI_PCT = 0.3  # assumed: a practice best lap is ~0.3 % slower than the same car in qualifying
LOGGED_WEIGHT = 0.5  # weight of the logged-lap estimate against the results model
LAYOUT_JUMP_PCT = 2.5  # a circuit that got this much quicker/slower beyond season pace is treated as changed
PACE_RIDGE = 0.01  # small pull of each season's pace toward the previous season's (1 = one fresh pole)
PACE_CLAMP_PCT = 5.0  # season pace change since the last visit is kept within +-5 %
WET_PCT = 4.0  # without a weather line, a session this much slower than the weekend's best lap was wet
RANGE_ROUNDS = 12  # inner backtest depth used for the likely ranges
RANGE_QUANTILE = 0.8
FALLBACK_ERR = {"pole_pct": 0.6, "gap_pct": 0.5, "time_s": 0.8, "q_pos": 6.0, "q_class_pos": 4.0, "r_pos": 6.0}


# --------------------------------------------------------------------------- helpers


def _norm(text: str | None) -> str:
    return " ".join((text or "").lower().split())


def _team_match(row_team: str | None, team: str | None) -> bool:
    a, b = _norm(row_team), _norm(team)
    return bool(a and b) and (a == b or a in b or b in a)


def _surname(name: str | None) -> str:
    """'Gabriele Piana', 'G.Piana' and 'PIANA Gabriele' all -> 'piana' (the last word, else the word in capitals)."""
    text = (name or "").strip()
    caps = [w for w in text.split() if len(w) > 1 and w.isupper()]
    word = caps[0] if caps else (re.split(r"[\s.]+", text)[-1] if text else "")
    return _norm(word)


def is_wet(session: dict) -> bool:
    """True when the session was declared wet at its start or its end."""
    w = session.get("weather") or {}
    return "wet" in (_norm(w.get("conditions_start")), _norm(w.get("conditions_end")))


def mark_wet(sessions: list[dict]) -> list[dict]:
    """Flag as wet the sessions whose sheet gave no conditions but whose best lap was more than ``WET_PCT`` slower
    than the quickest lap of the same weekend (a series whose site gives no weather: a dry qualifying is within
    about 2.5 % of the weekend's best, a wet one 7-10 % off it)."""
    best: dict[tuple, float] = {}
    for s in sessions:
        p = _pole(s)
        key = (s["year"], s.get("round_id") or s.get("order"))
        if p and (key not in best or p < best[key]):
            best[key] = p
    for s in sessions:
        w = s.get("weather") or {}
        p, b = _pole(s), best.get((s["year"], s.get("round_id") or s.get("order")))
        if not (w.get("conditions_start") or w.get("conditions_end")) and p and b and _gap_pct(p, b) > WET_PCT:
            s["weather"] = {**w, "conditions_start": "Wet", "conditions_end": "Wet", "inferred": True}
    return sessions


def _round_key(s: dict) -> tuple[int, int]:
    return int(s["year"]), int(s.get("order") or 0)


def _timed(session: dict) -> list[dict]:
    """Rows with a usable best lap, in a classified or non-classified-but-running state."""
    return [
        r for r in session.get("rows") or []
        if r.get("best_lap_s") and r.get("status") not in ("dns", "dsq")
    ]


def _pole(session: dict) -> float | None:
    laps = [r["best_lap_s"] for r in _timed(session)]
    return min(laps) if laps else None


def _gap_pct(lap: float, pole: float) -> float:
    return (lap / pole - 1.0) * 100.0


def _venue_label(venue: str) -> str:
    special = {"paul-ricard": "Paul Ricard", "nurburgring": "Nürburgring", "spa": "Spa-Francorchamps"}
    return special.get(venue, venue.replace("-", " ").title())


def _wmedian(values: Sequence[float], weights: Sequence[float]) -> float:
    order = np.argsort(values)
    v = np.asarray(values, float)[order]
    w = np.asarray(weights, float)[order]
    c = np.cumsum(w)
    return float(v[np.searchsorted(c, c[-1] / 2.0)])


def _quantile_abs(errors: Iterable[float], q: float = RANGE_QUANTILE) -> float | None:
    e = [abs(x) for x in errors if x is not None and not math.isnan(x)]
    if len(e) < 4:
        return None
    return float(np.quantile(e, q))


def _r(x: float | None, nd: int = 3) -> float | None:
    return None if x is None else round(float(x), nd)


def fmt_lap(seconds: float | None) -> str:
    if seconds is None:
        return "n/a"
    m, s = divmod(seconds, 60.0)
    return f"{int(m)}:{s:06.3f}"


# --------------------------------------------------------------------------- who is "us"


class _Us:
    """Finds our rows: car number + team in the target year, team (same number first) before,
    brand + class when the team is unknown or absent."""

    def __init__(self, year: int, car_number: str | None, team: str | None, brand: str | None,
                 car_class: str | None, prior: list[dict], driver: str | None = None):
        self.year = year
        self.car_number = str(car_number) if car_number is not None else None
        self.team = team
        self.brand = brand
        self.car_class = car_class
        self.driver = _surname(driver) if driver else None
        # Our drivers this season, to find us in seasons the car ran for another team or under another number.
        self.crew: set[str] = set()
        if self.car_number and not self.driver:
            for s in sorted(prior, key=_round_key, reverse=True):
                if int(s["year"]) != year:
                    continue
                rows = self.rows(s, allow_fallback=False)
                if rows:
                    self.crew = {_surname(d) for d in rows[0].get("drivers") or []} - {""}
                    break
        # Fill brand / class from our latest row this season (or the latest season the team raced).
        if not (self.brand and self.car_class):
            for s in sorted(prior, key=_round_key, reverse=True):
                rows = self.rows(s, allow_fallback=False)
                if rows:
                    self.brand = self.brand or rows[0].get("brand")
                    self.car_class = self.car_class or rows[0].get("car_class")
                    break

    def rows(self, s: dict, allow_fallback: bool = True) -> list[dict]:
        """Our rows in a session. ``allow_fallback=False`` returns only our own car / team."""
        rows = s.get("rows") or []
        same_year = int(s["year"]) == self.year
        if self.driver:  # a driver given: wherever that driver raced, else (a year without them) the brand
            mine = [r for r in rows if self.driver in {_surname(d) for d in r.get("drivers") or []}]
            if mine or not allow_fallback or same_year:
                return mine
            return self._brand_rows(rows)
        if same_year and self.car_number:
            # This season the car number + team is who we are.
            mine = [r for r in rows if str(r.get("car_number")) == self.car_number
                    and (self.team is None or _team_match(r.get("team"), self.team))]
            if mine or self.team:
                return mine  # our car did not run this session: nobody else stands in for it
        if self.team and not (same_year and self.car_number):
            # Earlier seasons: the team, our car number first, else the team's other car(s).
            mine = [r for r in rows if _team_match(r.get("team"), self.team)]
            same = [r for r in mine if self.car_number and str(r.get("car_number")) == self.car_number]
            if same:
                return same
            crew = self._crew_rows(rows)
            if crew or mine:
                return crew or mine
        elif not same_year:
            crew = self._crew_rows(rows)
            if crew:
                return crew
        if not allow_fallback:
            return []
        return self._brand_rows(rows)

    def _crew_rows(self, rows: list[dict]) -> list[dict]:
        """The cars that had the most of this season's drivers (a driver who changed team or number)."""
        if not self.crew:
            return []
        n = {id(r): len(self.crew & {_surname(d) for d in r.get("drivers") or []}) for r in rows}
        top = max(n.values(), default=0)
        return [r for r in rows if top and n[id(r)] == top]

    def _brand_rows(self, rows: list[dict]) -> list[dict]:
        if self.brand:
            return [r for r in rows if _norm(r.get("brand")) == _norm(self.brand)
                    and (not self.car_class or r.get("car_class") == self.car_class)]
        return []

    def is_proxy(self, s: dict) -> bool:
        """True when ``rows`` falls back to brand + class for this session."""
        return bool(self.rows(s)) and not self.rows(s, allow_fallback=False)


def _our_gap(s: dict, us: _Us) -> float | None:
    """Our gap to pole (%) in a dry qualifying session, capped; median over our rows."""
    pole = _pole(s)
    if pole is None:
        return None
    laps = [r["best_lap_s"] for r in us.rows(s) if r.get("best_lap_s") and r.get("status") not in ("dns", "dsq")]
    if not laps:
        return None
    return min(median(_gap_pct(x, pole) for x in laps), GAP_CAP_PCT)


# --------------------------------------------------------------------------- the model core


def _split(sessions: Sequence[dict], venue: str, year: int, before_order: int | None) -> tuple[list[dict], int]:
    """Only what existed before the round: earlier seasons + this season's rounds with order < cutoff."""
    if before_order is None:
        this = [s for s in sessions if int(s["year"]) == year and s.get("venue") == venue]
        if this:
            before_order = min(int(s.get("order") or 0) for s in this)
        else:
            orders = [int(s.get("order") or 0) for s in sessions if int(s["year"]) == year]
            before_order = (max(orders) + 1) if orders else 1
    prior = [s for s in sessions
             if int(s["year"]) < year or (int(s["year"]) == year and int(s.get("order") or 0) < before_order)]
    return prior, before_order


def _fe_fit(obs: list[tuple[str, int, float]], year: int) -> tuple[dict[str, float], dict[int, float], set[int]]:
    """Weighted least squares log(pole) = venue + season.

    Returns (venue terms, season terms, seasons whose pace was actually measured).
    Only circuits raced in two or more seasons say anything about season pace, so only they
    enter the fit; a circuit seen in one season gets its venue term afterwards from that
    season's pace. A small ridge penalty pulls each season's pace toward the previous
    season's, so a season linked to the rest by little data cannot run away. A season with
    no usable data takes the pace of the latest season before it.
    """
    seasons_of: dict[str, set[int]] = {}
    for v, y, _ in obs:
        seasons_of.setdefault(v, set()).add(y)
    fit = [o for o in obs if len(seasons_of[o[0]]) >= 2]
    years = sorted({y for _, y, _ in fit})
    vt: dict[str, float] = {}
    st: dict[int, float] = {}
    if fit:
        venues = sorted({v for v, _, _ in fit})
        vi = {v: i for i, v in enumerate(venues)}
        yi = {y: len(venues) + i for i, y in enumerate(years[1:])}  # first season is the reference
        n_par = len(venues) + len(years) - 1
        rows, rhs, wts = [], [], []
        for v, y, lp in fit:
            x = np.zeros(n_par)
            x[vi[v]] = 1.0
            if y in yi:
                x[yi[y]] = 1.0
            rows.append(x)
            rhs.append(lp)
            wts.append(SEASON_DECAY ** max(year - y, 0))
        for a, b in pairwise(years):  # ridge: season b's pace minus season a's pace -> 0
            x = np.zeros(n_par)
            x[yi[b]] = 1.0
            if a in yi:
                x[yi[a]] = -1.0
            rows.append(x)
            rhs.append(0.0)
            wts.append(PACE_RIDGE)
        X, yv, sw = np.array(rows), np.array(rhs), np.sqrt(np.array(wts))
        coef, *_ = np.linalg.lstsq(X * sw[:, None], yv * sw, rcond=None)
        vt = {v: float(coef[i]) for v, i in vi.items()}
        st = {y: (float(coef[yi[y]]) if y in yi else 0.0) for y in years}
    measured = set(st)
    for y in sorted({y for _, y, _ in obs}):
        if y not in st:
            earlier = [s for s in st if s < y]
            st[y] = st[max(earlier)] if earlier else (st[min(st)] if st else 0.0)
    for v in seasons_of:
        if v not in vt:
            vt[v] = float(np.mean([lp - st[y] for vv, y, lp in obs if vv == v]))
    return vt, st, measured


def _pole_model(prior: list[dict], venue: str, year: int) -> dict:
    """Pole = (venue's last dry visit) x (season pace now / season pace then).

    Season pace comes from a fit of every earlier dry pole as venue + season. A circuit whose
    times jump by more than ``LAYOUT_JUMP_PCT`` between visits, beyond what the season pace
    explains, is treated as changed (new layout, resurfacing): the older visits are kept apart.
    """
    obs = []
    for s in prior:
        if s.get("code") in QUALI_CODES and not is_wet(s):
            p = _pole(s)
            if p:
                obs.append((s["venue"], int(s["year"]), math.log(p)))
    out: dict[str, Any] = {"pole_s": None, "base_s": None, "pace_pct": None, "visits": [], "n_obs": len(obs),
                           "set_aside": []}
    if not obs or venue not in {v for v, _, _ in obs}:
        return out
    set_aside: list[tuple[str, int]] = []
    for _ in range(4):
        vt, st, _ = _fe_fit(obs, year)
        resid: dict[str, dict[int, list[float]]] = {}
        for v, y, lp in obs:
            resid.setdefault(v, {}).setdefault(y, []).append(lp - vt[v] - st[y])
        split = None
        for v, by in resid.items():
            ys = sorted(by)
            for y1, y2 in pairwise(ys):
                if abs(np.mean(by[y2]) - np.mean(by[y1])) > math.log1p(LAYOUT_JUMP_PCT / 100):
                    split = (v, y2)
            if split:
                break
        if not split:
            break
        v, y2 = split
        obs = [(f"{vv}<{y2}" if vv == v and y < y2 else vv, y, lp) for vv, y, lp in obs]
        set_aside.append(split)
    vt, st, measured = _fe_fit(obs, year)
    years = sorted(st)
    pace_year = year if year in st else years[-1]
    visits = sorted({y for v, y, _ in obs if v == venue})
    last = visits[-1]
    last_lp = float(np.mean([lp for v, y, lp in obs if v == venue and y == last]))
    # Venue term from all its visits (recent ones weigh more). Backtested against "last visit
    # x pace change", which did no better (0.75 % vs 0.73 % mean pole error 2023-2026).
    # The pace change since the last visit is clamped to +-PACE_CLAMP_PCT: series pace never
    # moves more than that in a few seasons, a bigger number is a fitting artefact.
    lim = math.log1p(PACE_CLAMP_PCT / 100.0)
    pace = min(max(st[pace_year] - st[last], -lim), lim)
    log_pole = vt[venue] + st[last] + pace
    out.update(
        pole_s=float(math.exp(log_pole)),
        base_s=float(math.exp(last_lp)),
        pace_pct=(math.exp(pace) - 1.0) * 100.0,
        visits=visits,
        pace_from_this_season=year in measured,
        set_aside=[f"{_venue_label(v)} before {y}" for v, y in set_aside],
    )
    return out


def _season_gaps(prior: list[dict], us: _Us) -> dict[int, list[tuple[dict, float]]]:
    by_year: dict[int, list[tuple[dict, float]]] = {}
    for s in prior:
        if s.get("code") in QUALI_CODES and not is_wet(s):
            g = _our_gap(s, us)
            if g is not None:
                by_year.setdefault(int(s["year"]), []).append((s, g))
    return by_year


def _gap_model(prior: list[dict], venue: str, year: int, us: _Us) -> dict:
    by_year = _season_gaps(prior, us)
    cur = [g for _, g in by_year.get(year, [])]
    earlier = [y for y in by_year if y < year]
    last_year = max(earlier) if earlier else None
    prev = median([g for _, g in by_year[last_year]]) if last_year is not None else None
    if cur and prev is not None:
        form = (len(cur) * median(cur) + FORM_PRIOR_ROUNDS * prev) / (len(cur) + FORM_PRIOR_ROUNDS)
    elif cur:
        form = median(cur)
    else:
        form = prev
    # Our circuit offset: our gap at this venue vs our median of that season.
    diffs, wts, proxy_flags = [], [], []
    for y, items in by_year.items():
        here = [g for s, g in items if s["venue"] == venue]
        if here and len(items) >= 3:
            diffs.append(median(here) - median(g for _, g in items))
            wts.append(SEASON_DECAY ** (year - y))
            proxy_flags.append(any(us.is_proxy(s) for s, _ in items if s["venue"] == venue))
    src = "team"
    if diffs and all(proxy_flags):
        src = "brand"
    if diffs:
        trust = BRAND_OFFSET_WEIGHT if src == "brand" else 1.0
        offset = trust * sum(d * w for d, w in zip(diffs, wts, strict=True)) / (sum(wts) + OFFSET_PRIOR)
    else:
        offset, src = 0.0, "none"
    # Q1 and Q2 are driven by different drivers: this season's same-session gaps pull the form their way.
    code_gap: dict[str, float | None] = {}
    code_n: dict[str, int] = {}
    for code in QUALI_CODES:
        mine = [g for s, g in by_year.get(year, []) if s.get("code") == code]
        code_n[code] = len(mine)
        if form is None:
            code_gap[code] = None
        elif mine:
            f = (len(mine) * median(mine) + CODE_FORM_PRIOR * form) / (len(mine) + CODE_FORM_PRIOR)
            code_gap[code] = f + offset
        else:
            code_gap[code] = form + offset
    return {
        "form_pct": form,
        "form_rounds_this_season": len(cur),
        "form_last_season_pct": prev,
        "venue_offset_pct": offset,
        "venue_offset_source": src,
        "venue_visits_used": len(diffs),
        "gap_pct": None if form is None else form + offset,
        "code_gap_pct": code_gap,
        "code_rounds_this_season": code_n,
    }


def _field_refs(prior: list[dict], venue: str, year: int) -> list[dict]:
    """Dry qualifyings whose field spread stands in for the coming one."""
    dry_q = [s for s in prior if s.get("code") in QUALI_CODES and not is_wet(s) and _pole(s)]
    this = [s for s in dry_q if int(s["year"]) == year]
    if not this:
        years = sorted({int(s["year"]) for s in dry_q})
        this = [s for s in dry_q if years and int(s["year"]) == years[-1]]
    at_venue = [s for s in dry_q if s["venue"] == venue]
    if at_venue:
        last = max(int(s["year"]) for s in at_venue)
        at_venue = [s for s in at_venue if int(s["year"]) == last]
    return this + [s for s in at_venue if s not in this]


def _expected_entry(prior: list[dict], year: int, car_class: str | None) -> tuple[int, int]:
    """Field size (all, our class) of the latest qualifying before this round."""
    qs = sorted((s for s in prior if s.get("code") in QUALI_CODES), key=_round_key)
    this = [s for s in qs if int(s["year"]) == year] or qs
    if not this:
        return 0, 0
    last = this[-1]
    rows = [r for r in last.get("rows") or [] if r.get("status") != "dns"]
    return len(rows), sum(1 for r in rows if car_class and r.get("car_class") == car_class)


def _position_from_gap(gap: float, refs: list[dict], entry: int, car_class: str | None,
                       us: _Us) -> tuple[float | None, float | None]:
    """1 + (share of the field quicker than ``gap``) x (expected entry), overall and in class."""
    fr_all, fr_cls = [], []
    for s in refs:
        pole = _pole(s)
        mine = {id(r) for r in us.rows(s, allow_fallback=False)}
        others = [r for r in _timed(s) if id(r) not in mine]
        if not others or pole is None:
            continue
        gaps = np.array([_gap_pct(r["best_lap_s"], pole) for r in others])
        fr_all.append(float(np.mean(gaps < gap)))
        cls = np.array([_gap_pct(r["best_lap_s"], pole) for r in others if r.get("car_class") == car_class])
        if car_class and cls.size:
            fr_cls.append(float(np.mean(cls < gap)))
    n_all, n_cls = entry
    pos = 1 + float(np.mean(fr_all)) * max(n_all - 1, 0) if fr_all and n_all else None
    pos_c = 1 + float(np.mean(fr_cls)) * max(n_cls - 1, 0) if fr_cls and n_cls else None
    return pos, pos_c


def _race_gain(prior: list[dict], year: int, us: _Us, grid: float) -> dict:
    """Usual places gained from grid to finish: ours (recency-weighted median), shrunk toward the field's."""
    by_round: dict[tuple[int, int, str], dict] = {}
    for s in prior:
        by_round[(int(s["year"]), int(s.get("order") or 0), s.get("code"))] = s
    ours, wts, field = [], [], []
    for (y, o, code), race in by_round.items():
        if code not in RACE_CODES:
            continue
        q = by_round.get((y, o, GRID_FOR[code]))
        if q is None:
            continue
        qpos = {str(r.get("car_number")): r.get("position") for r in q.get("rows") or []}
        mine = {id(r) for r in us.rows(race, allow_fallback=False)}
        for r in race.get("rows") or []:
            g = qpos.get(str(r.get("car_number")))
            if not g or r.get("position") is None:
                continue
            d = r["position"] - g
            if id(r) in mine:
                ours.append(d)
                wts.append(SEASON_DECAY ** (year - y))
            elif abs(g - grid) <= 4 and y >= year - 2:
                field.append(d)
    field_gain = float(median(field)) if field else 0.0
    if ours:
        n_eff = sum(wts) ** 2 / sum(w * w for w in wts)
        own = _wmedian(ours, wts)
        gain = (n_eff * own + GAIN_PRIOR_RACES * field_gain) / (n_eff + GAIN_PRIOR_RACES)
    else:
        own, gain = None, field_gain
    return {"gain": gain, "own_median_gain": own, "field_gain": field_gain, "races_used": len(ours)}


def _race_form(prior: list[dict], year: int, us: _Us) -> float | None:
    """Our average race finish (races we finished): this season, shrunk toward last season."""
    by_year: dict[int, list[int]] = {}
    for s in prior:
        if s.get("code") in RACE_CODES:
            for r in us.rows(s, allow_fallback=False):
                if r.get("position"):
                    by_year.setdefault(int(s["year"]), []).append(r["position"])
    cur = by_year.get(year, [])
    earlier = [y for y in by_year if y < year]
    prev = float(np.mean(by_year[max(earlier)])) if earlier else None
    if cur and prev is not None:
        return (sum(cur) + FORM_PRIOR_ROUNDS * prev) / (len(cur) + FORM_PRIOR_ROUNDS)
    return float(np.mean(cur)) if cur else prev


def _core(sessions: Sequence[dict], venue: str, year: int, car_number: str | None, team: str | None,
          brand: str | None, car_class: str | None, before_order: int | None,
          logged_best_s: float | None, driver: str | None = None) -> dict:
    prior, cutoff = _split(sessions, venue, year, before_order)
    us = _Us(year, car_number, team, brand, car_class, prior, driver)
    pole = _pole_model(prior, venue, year)
    gapm = _gap_model(prior, venue, year, us)
    entry = _expected_entry(prior, year, us.car_class)
    refs = _field_refs(prior, venue, year)

    logged = None
    if logged_best_s:
        logged = {"logged_best_s": logged_best_s,
                  "as_quali_s": logged_best_s * (1 - PRACTICE_TO_QUALI_PCT / 100.0), "weight": LOGGED_WEIGHT}
    q: dict[str, dict] = {}
    for code in QUALI_CODES:
        gap = gapm["code_gap_pct"][code]
        our_time = None
        if pole["pole_s"] is not None and gap is not None:
            our_time = pole["pole_s"] * (1 + gap / 100.0)
        if logged:
            est = logged["as_quali_s"]
            if our_time is not None:
                our_time = LOGGED_WEIGHT * est + (1 - LOGGED_WEIGHT) * our_time
                gap = _gap_pct(our_time, pole["pole_s"])
            elif pole["pole_s"] is not None:
                our_time, gap = est, _gap_pct(est, pole["pole_s"])
            else:
                our_time = est  # no pole model: the logged lap is our only time; the gap stays the model's
        pos = cls = None
        if gap is not None:
            pos, cls = _position_from_gap(gap, refs, entry, us.car_class, us)
        q[code] = {"gap_pct": gap, "our_time": our_time, "pos": pos, "class_pos": cls}
    race: dict[str, dict | None] = {}
    for code in RACE_CODES:
        grid = q[GRID_FOR[code]]["pos"]
        if grid is None:
            race[code] = None
            continue
        rg = _race_gain(prior, year, us, grid)
        from_grid = grid + rg["gain"]
        form = _race_form(prior, year, us)
        pos = from_grid if form is None else (1 - RACE_FORM_WEIGHT) * from_grid + RACE_FORM_WEIGHT * form
        race[code] = {"position": min(max(1.0, pos), max(entry[0], 1)), "grid": grid, "from_grid": from_grid,
                      "race_form": form, **rg}
    return {
        "prior": prior, "cutoff": cutoff, "us": us, "pole": pole, "gap": gapm, "entry": entry, "refs": refs,
        "q": q, "race": race, "logged": logged,
    }


# --------------------------------------------------------------------------- actuals and errors


def _actual(sessions: Sequence[dict], venue: str, year: int, us: _Us) -> dict[str, dict]:
    out: dict[str, dict] = {}
    for s in sessions:
        if s.get("venue") != venue or int(s["year"]) != year:
            continue
        code = s.get("code")
        mine = us.rows(s, allow_fallback=False)
        r = mine[0] if mine else None
        entry = sum(1 for x in s.get("rows") or [] if x.get("status") != "dns")
        a: dict[str, Any] = {"wet": is_wet(s), "entry": entry}
        if code in QUALI_CODES:
            a["pole_s"] = _pole(s)
            a["our_time_s"] = r.get("best_lap_s") if r and r.get("status") not in ("dns", "dsq") else None
            a["position"] = r.get("position") if r else None
            if r and r.get("position") is not None:
                cls = [x for x in s.get("rows") or [] if x.get("car_class") == r.get("car_class")
                       and x.get("position") is not None]
                a["class_position"] = 1 + sum(1 for x in cls if x["position"] < r["position"])
            else:
                a["class_position"] = None
        elif code in RACE_CODES:
            a["position"] = r.get("position") if r else None
            a["status"] = r.get("status") if r else None
        out[code] = a
    return out


def _round_errors(core: dict, actual: dict[str, dict]) -> dict[str, list[float]]:
    """Signed errors (prediction - actual) of one round, as used for ranges and the backtest."""
    e: dict[str, list[float]] = {k: [] for k in ("pole_pct", "pole_s", "gap_pct", "time_s", "q_pos", "q_class_pos",
                                                  "r_pos")}
    for code in QUALI_CODES:
        a = actual.get(code)
        if not a:
            continue
        p = core["pole"]["pole_s"]
        q = core["q"][code]
        if not a["wet"]:
            if p is not None and a.get("pole_s"):
                e["pole_s"].append(p - a["pole_s"])
                e["pole_pct"].append(_gap_pct(p, a["pole_s"]))
            if q["our_time"] is not None and a.get("our_time_s"):
                e["time_s"].append(q["our_time"] - a["our_time_s"])
            if q["gap_pct"] is not None and a.get("our_time_s") and a.get("pole_s"):
                e["gap_pct"].append(q["gap_pct"] - min(_gap_pct(a["our_time_s"], a["pole_s"]), GAP_CAP_PCT))
        if q["pos"] is not None and a.get("position"):
            e["q_pos"].append(q["pos"] - a["position"])
        if q["class_pos"] is not None and a.get("class_position"):
            e["q_class_pos"].append(q["class_pos"] - a["class_position"])
    for code in RACE_CODES:
        a = actual.get(code)
        rp = core["race"].get(code)
        if a and rp and a.get("position"):
            e["r_pos"].append(rp["position"] - a["position"])
    return e


def _rounds(sessions: Sequence[dict]) -> list[tuple[int, int, str]]:
    return sorted({(int(s["year"]), int(s.get("order") or 0), s["venue"]) for s in sessions})


def _range_errors(prior: list[dict], kw: dict) -> dict[str, float]:
    """80th-percentile absolute misses of the model over the last RANGE_ROUNDS rounds before this one."""
    errs: dict[str, list[float]] = {}
    for y, o, v in _rounds(prior)[-RANGE_ROUNDS:]:
        core = _core(prior, v, y, before_order=o, logged_best_s=None, **kw)
        act = _actual(prior, v, y, core["us"])
        for k, vals in _round_errors(core, act).items():
            errs.setdefault(k, []).extend(vals)
    out = {}
    for k, fb in FALLBACK_ERR.items():
        q = _quantile_abs(errs.get(k, []))
        out[k] = fb if q is None else q
    return out


# --------------------------------------------------------------------------- public API


def predict_round(sessions: Sequence[dict], venue: str, year: int, *, car_number: str | None = None,
                  team: str | None = None, brand: str | None = None, car_class: str | None = None,
                  before_order: int | None = None, logged_best_s: float | None = None,
                  with_ranges: bool = True, driver: str | None = None) -> dict:
    """Predict qualifying (Q1, Q2) and race (R1, R2) results of ``year``'s round at ``venue``.

    Only sessions of earlier seasons and of this season's rounds with ``order < before_order``
    are used. ``before_order`` defaults to the round's own order when the round is in
    ``sessions`` (so a finished round can be "re-predicted" honestly), otherwise to one past
    the last round of ``year`` that is in the data.
    """
    kw = {"car_number": car_number, "team": team, "brand": brand, "car_class": car_class, "driver": driver}
    core = _core(sessions, venue, year, before_order=before_order, logged_best_s=logged_best_s, **kw)
    err = _range_errors(core["prior"], kw) if with_ranges else dict(FALLBACK_ERR)
    us: _Us = core["us"]
    pole, gapm = core["pole"], core["gap"]
    n_all, n_cls = core["entry"]
    label = _venue_label(venue)

    def clamp(x: float, hi: int) -> int:
        return int(min(max(1, round(x)), max(hi, 1)))

    out_sessions: dict[str, dict] = {}
    for code in QUALI_CODES:
        p = pole["pole_s"]
        cq = core["q"][code]
        t, g, q, qc = cq["our_time"], cq["gap_pct"], cq["pos"], cq["class_pos"]
        # Position range: the gap range laid on the field spread, never narrower than half the typical miss.
        pos_lo = pos_hi = q
        if g is not None:
            lo, _ = _position_from_gap(g - err["gap_pct"], core["refs"], core["entry"], us.car_class, us)
            hi, _ = _position_from_gap(g + err["gap_pct"], core["refs"], core["entry"], us.car_class, us)
            pos_lo = lo if lo is not None else q
            pos_hi = hi if hi is not None else q
        out_sessions[code] = {
            "pole_s": _r(p),
            "pole_range_s": None if p is None else [_r(p * (1 - err["pole_pct"] / 100)),
                                                    _r(p * (1 + err["pole_pct"] / 100))],
            "our_time_s": _r(t),
            "our_time_range_s": None if t is None else [_r(t - err["time_s"]), _r(t + err["time_s"])],
            "our_gap_pct": _r(g),
            "position": None if q is None else clamp(q, n_all),
            "position_range": None if q is None else [
                clamp(min(pos_lo, q - err["q_pos"] / 2), n_all),
                clamp(max(pos_hi, q + err["q_pos"] / 2), n_all)],
            "class_position": None if qc is None else clamp(qc, n_cls),
            "class_position_range": None if qc is None else [clamp(qc - err["q_class_pos"], n_cls),
                                                             clamp(qc + err["q_class_pos"], n_cls)],
            "field_size": n_all or None,
            "class_size": n_cls or None,
        }
    for code in RACE_CODES:
        rp = core["race"].get(code)
        out_sessions[code] = {
            "grid_from": GRID_FOR[code],
            "position": None if rp is None else clamp(rp["position"], n_all),
            "position_range": None if rp is None else [clamp(rp["position"] - err["r_pos"], n_all),
                                                       clamp(rp["position"] + err["r_pos"], n_all)],
            "usual_gain": None if rp is None else _r(-rp["gain"], 1),
        }

    explain = _explain(core, label, year, out_sessions)
    this_rounds = sorted({(int(s.get("order") or 0), s["venue"]) for s in core["prior"] if int(s["year"]) == year})
    return {
        "venue": venue,
        "venue_name": label,
        "year": year,
        "before_order": core["cutoff"],
        "car_number": car_number,
        "team": team,
        "brand": us.brand,
        "car_class": us.car_class,
        "sessions": out_sessions,
        "components": {
            "pole_base_s": _r(pole["base_s"]),
            "previous_dry_visits": pole["visits"],
            "season_pace_pct": _r(pole["pace_pct"]),
            "form_gap_pct": _r(gapm["form_pct"]),
            "form_rounds_this_season": gapm["form_rounds_this_season"],
            "form_last_season_pct": _r(gapm["form_last_season_pct"]),
            "venue_offset_pct": _r(gapm["venue_offset_pct"]),
            "venue_offset_source": gapm["venue_offset_source"],
            "model_gap_pct": _r(gapm["gap_pct"]),
            "logged_best": None if core["logged"] is None else {k: _r(v) for k, v in core["logged"].items()},
            "typical_miss": {k: _r(v) for k, v in err.items()},
        },
        "data_used": {
            "sessions": len(core["prior"]),
            "seasons": sorted({int(s["year"]) for s in core["prior"]}),
            "rounds_this_season": [_venue_label(v) for _, v in this_rounds],
        },
        "explain": explain,
        "notes": [
            "Predictions assume a dry session; wet sessions are left out of every lap-time model.",
            "Race positions are 'if we finish': retirements are not predicted.",
            f"Practice laps are assumed {PRACTICE_TO_QUALI_PCT}% slower than qualifying (not fitted: no practice "
            "results in the data).",
        ],
    }


def _explain(core: dict, label: str, year: int, out: dict) -> list[str]:
    pole, gapm = core["pole"], core["gap"]
    lines = []
    if pole["pole_s"] is None:
        lines.append(f"No dry qualifying at {label} in the results before this round, so there is no pole time "
                     "or lap time to predict; positions come from our current form only.")
    else:
        visits = ", ".join(str(v) for v in pole["visits"])
        pace = pole["pace_pct"] or 0.0
        last = pole["visits"][-1]
        rel = "the same pace as" if abs(pace) < 0.05 else (
            f"{abs(pace):.1f}% {'slower' if pace > 0 else 'quicker'} than")
        who = "this season's earlier rounds have been" if pole.get("pace_from_this_season") else (
            "no dry qualifying yet this season at a circuit raced before, so last season's pace is used:")
        lines.append(f"Pole at {label}: about {fmt_lap(pole['pole_s'])}. Built from dry qualifying in {visits} "
                     f"({fmt_lap(pole['base_s'])} in {last}); {who} {rel} {last} at the same circuits.")
        for note in pole.get("set_aside") or []:
            if note.startswith(label):
                lines.append(f"Times at {note} look like a different track (layout or surface), so they are left out.")
    if gapm["form_pct"] is not None:
        if gapm["form_rounds_this_season"]:
            lines.append(f"Our form: {gapm['form_pct']:.2f}% off pole, from {gapm['form_rounds_this_season']} dry "
                         f"qualifying session(s) this season blended with last season.")
        else:
            lines.append(f"Our form: {gapm['form_pct']:.2f}% off pole, taken from last season (no dry qualifying "
                         "this season yet).")
        off = gapm["venue_offset_pct"]
        if gapm["venue_offset_source"] == "none":
            lines.append(f"We have no earlier dry qualifying at {label} to tell if it suits us; no circuit "
                         "adjustment.")
        else:
            who = "our team" if gapm["venue_offset_source"] == "team" else "other cars of our brand and class"
            word = "closer to" if off < 0 else "further from"
            lines.append(f"At {label}, {who} usually ran {abs(off):.2f}% {word} pole than the season "
                         f"average (car, balance of performance and track character together).")
    if core["logged"]:
        lg = core["logged"]
        lines.append(f"Our logged best lap here ({fmt_lap(lg['logged_best_s'])}) counts as "
                     f"{fmt_lap(lg['as_quali_s'])} in qualifying (assumed {PRACTICE_TO_QUALI_PCT}% quicker); it gets "
                     f"{lg['weight']:.0%} of the say in our lap time, the results model the rest.")
    for code in QUALI_CODES:
        q = out[code]
        if q["position"] is None:
            continue
        t = f" with a {fmt_lap(q['our_time_s'])}" if q["our_time_s"] else ""
        lo, hi = q["position_range"]
        cls = f", P{q['class_position']} in {core['us'].car_class}" if q["class_position"] else ""
        why = ""
        if gapm["code_rounds_this_season"][code] and gapm["gap_pct"] is not None:
            diff = (gapm["code_gap_pct"][code] or 0.0) - gapm["gap_pct"]
            if abs(diff) >= 0.05:
                why = f" ({code} has gone {'better' if diff < 0 else 'worse'} than our average this season)"
        lines.append(f"Qualifying {code[1]}: expect around P{q['position']} overall{t} "
                     f"(likely P{lo}-P{hi}){cls}{why}.")
    for code in RACE_CODES:
        r = out[code]
        if r["position"] is not None:
            gain = r["usual_gain"] or 0.0
            how = f"we usually gain {gain:.0f} places" if gain >= 0.5 else (
                f"we usually lose {-gain:.0f} places" if gain <= -0.5 else "we usually hold our grid spot")
            lo, hi = r["position_range"]
            form = core["race"][code]["race_form"]
            recent = f", and our recent finishes average P{form:.0f}" if form is not None else ""
            lines.append(f"Race {code[1]}: from the {GRID_FOR[code]} grid {how}{recent}; expect about "
                         f"P{r['position']} (likely P{lo}-P{hi}) if we finish.")
    lines.append("All of this assumes a dry track.")
    return lines


def backtest(sessions: Sequence[dict], *, car_number: str = "12", team: str = "Borusan Otomotiv Motorsport",
             years: Iterable[int] = (2023, 2024, 2025, 2026), with_ranges: bool = False,
             driver: str | None = None) -> dict:
    """Predict every round of ``years`` from strictly earlier rounds and compare with what happened.

    The naive baseline is: pole and our lap time = the same session at our last dry visit to the
    circuit; qualifying and race positions = our average so far this season (last season's before
    the first round). Errors are absolute; race errors only count races we finished.
    """
    years = tuple(years)
    rounds = [r for r in _rounds(sessions) if r[0] in years]
    per_round = []
    pool: dict[str, list[float]] = {}
    for y, o, v in rounds:
        pred = predict_round(sessions, v, y, car_number=car_number, team=team, before_order=o,
                             with_ranges=with_ranges, driver=driver)
        core = _core(sessions, v, y, car_number, team, None, None, o, None, driver)
        act = _actual(sessions, v, y, core["us"])
        errs = _round_errors(core, act)
        base = _naive(core["prior"], v, y, core["us"])
        berr = _naive_errors(base, act)
        row = {
            "year": y, "order": o, "venue": v, "venue_name": _venue_label(v),
            "predicted": {c: {k: pred["sessions"][c].get(k) for k in ("pole_s", "our_time_s", "position",
                                                                     "class_position")} for c in QUALI_CODES}
            | {c: {"position": pred["sessions"][c]["position"]} for c in RACE_CODES},
            "actual": {c: {k: (_r(x) if isinstance(x, float) else x) for k, x in a.items()} for c, a in act.items()},
            "baseline": base,
            "abs_error": {k: _r(float(np.mean(np.abs(v_)))) if v_ else None for k, v_ in errs.items()},
            "baseline_abs_error": {k: _r(float(np.mean(np.abs(v_)))) if v_ else None for k, v_ in berr.items()},
        }
        row["summary"] = _round_summary(row)
        per_round.append(row)
        for k, vals in errs.items():
            pool.setdefault(f"{y}:{k}", []).extend(abs(x) for x in vals)
            pool.setdefault(f"all:{k}", []).extend(abs(x) for x in vals)
        for k, vals in berr.items():
            pool.setdefault(f"{y}:base_{k}", []).extend(abs(x) for x in vals)
            pool.setdefault(f"all:base_{k}", []).extend(abs(x) for x in vals)

    def table(prefix: str) -> dict:
        t = {}
        for k in ("pole_s", "pole_pct", "time_s", "gap_pct", "q_pos", "q_class_pos", "r_pos"):
            m = pool.get(f"{prefix}:{k}", [])
            b = pool.get(f"{prefix}:base_{k}", [])
            t[k] = {"model_mae": _r(float(np.mean(m))) if m else None, "n": len(m),
                    "baseline_mae": _r(float(np.mean(b))) if b else None, "baseline_n": len(b)}
        return t

    overall = {"all": table("all")} | {str(y): table(str(y)) for y in years}
    return {
        "car_number": car_number,
        "team": team,
        "driver": driver,
        "years": list(years),
        "rounds": per_round,
        "overall": overall,
        "metrics": {
            "pole_s": "pole time error, seconds (dry qualifyings)",
            "pole_pct": "pole time error, % of the lap",
            "time_s": "our qualifying lap error, seconds (dry qualifyings)",
            "gap_pct": "our gap-to-pole error, percentage points (dry qualifyings)",
            "q_pos": "our qualifying position error, places (all qualifyings)",
            "q_class_pos": "our qualifying class position error, places",
            "r_pos": "our race finishing position error, places (races we finished)",
        },
        "summary": _overall_summary(overall["all"]),
    }


def _naive(prior: list[dict], venue: str, year: int, us: _Us) -> dict:
    """Same session at our last dry visit for times; our season average so far for positions."""
    base: dict[str, Any] = {}
    visits = [s for s in prior if s["venue"] == venue and s.get("code") in QUALI_CODES and not is_wet(s)]
    if visits:
        last = max(int(s["year"]) for s in visits)
        lv = [s for s in visits if int(s["year"]) == last]
        for code in QUALI_CODES:
            s = next((x for x in lv if x["code"] == code), lv[0])
            mine = [r["best_lap_s"] for r in us.rows(s) if r.get("best_lap_s")]
            base[code] = {"pole_s": _pole(s), "our_time_s": min(mine) if mine else None}
    years = sorted({int(s["year"]) for s in prior})
    for y in ([year] if year in years else []) + years[::-1][:1]:
        qp = [r["position"] for s in prior if int(s["year"]) == y and s.get("code") in QUALI_CODES
              for r in us.rows(s, allow_fallback=False) if r.get("position")]
        rp = [r["position"] for s in prior if int(s["year"]) == y and s.get("code") in RACE_CODES
              for r in us.rows(s, allow_fallback=False) if r.get("position")]
        if qp or rp:
            base["q_pos"] = float(np.mean(qp)) if qp else None
            base["r_pos"] = float(np.mean(rp)) if rp else None
            break
    return base


def _naive_errors(base: dict, act: dict[str, dict]) -> dict[str, list[float]]:
    e: dict[str, list[float]] = {k: [] for k in ("pole_pct", "pole_s", "time_s", "q_pos", "r_pos")}
    for code in QUALI_CODES:
        a = act.get(code)
        if not a:
            continue
        b = base.get(code) or {}
        if not a["wet"]:
            if b.get("pole_s") and a.get("pole_s"):
                e["pole_s"].append(b["pole_s"] - a["pole_s"])
                e["pole_pct"].append(_gap_pct(b["pole_s"], a["pole_s"]))
            if b.get("our_time_s") and a.get("our_time_s"):
                e["time_s"].append(b["our_time_s"] - a["our_time_s"])
        if base.get("q_pos") and a.get("position"):
            e["q_pos"].append(base["q_pos"] - a["position"])
    for code in RACE_CODES:
        a = act.get(code)
        if a and base.get("r_pos") and a.get("position"):
            e["r_pos"].append(base["r_pos"] - a["position"])
    return e


def _round_summary(row: dict) -> str:
    name, y = row["venue_name"], row["year"]
    parts = []
    for code in QUALI_CODES:
        p, a = row["predicted"].get(code, {}), row["actual"].get(code)
        if not a:
            continue
        wet = " (wet)" if a.get("wet") else ""
        bits = []
        if p.get("pole_s") and a.get("pole_s"):
            bits.append(f"pole {fmt_lap(p['pole_s'])} vs {fmt_lap(a['pole_s'])}")
        if p.get("our_time_s") and a.get("our_time_s"):
            bits.append(f"us {fmt_lap(p['our_time_s'])} vs {fmt_lap(a['our_time_s'])}")
        if p.get("position") and a.get("position"):
            bits.append(f"P{p['position']} vs P{a['position']}")
        if bits:
            parts.append(f"{code}{wet}: " + ", ".join(bits))
    for code in RACE_CODES:
        p, a = row["predicted"].get(code, {}), row["actual"].get(code)
        if a and p.get("position"):
            got = f"P{a['position']}" if a.get("position") else (a.get("status") or "no result").upper()
            parts.append(f"{code}: P{p['position']} vs {got}")
    return f"{name} {y} - predicted vs actual. " + "; ".join(parts) + "."


def _overall_summary(t: dict) -> list[str]:
    out = []

    def line(key: str, what: str, unit: str, nd: int) -> None:
        m, b = t[key]["model_mae"], t[key]["baseline_mae"]
        if m is None:
            return
        txt = f"{what}: typically off by {m:.{nd}f}{unit}"
        if b is not None:
            verdict = "better than" if m < b else ("no better than" if m >= b else "")
            txt += f" ({verdict} the simple guess, off by {b:.{nd}f}{unit})"
        out.append(txt + ".")

    line("pole_s", "Pole time", " s", 2)
    line("time_s", "Our qualifying lap", " s", 2)
    line("q_pos", "Our qualifying position", " places", 1)
    line("r_pos", "Our race finish (when we finish)", " places", 1)
    return out
