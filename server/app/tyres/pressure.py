"""Cold pressures from a target hot pressure: the gas law, and this car's own logged runs.

Gas law: the air set cold warms to the expected hot temperature in a closed tyre (absolute pressure, kelvin).
Data: every logged run gives the rise from the cold set pressure to the settled hot pressure, per corner (tpms.py).
The rise is fitted against the tyre temperature at setting and the track (or ambient) temperature once there are
enough runs to see their effect; the cold pressure is the target minus the rise expected today.
Both answers are checked against the P-Book minimums and the tyre maker's hot window, where they are known.
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from app.tyres.gaslaw import cold_from_hot
from app.tyres.presets import HOT_WINDOWS
from app.tyres.tpms import CORNERS

AXLE = {"FL": "front", "FR": "front", "RL": "rear", "RR": "rear"}
MIN_RUNS_COLD_TERM = 4  # runs needed before the fit uses the tyre temperature at setting
MIN_RUNS_ENV_TERM = 6  # ... and the track or ambient temperature
MIN_SPREAD_C = 4.0  # a temperature that varied less than this across the runs can't show its effect
EXTRAPOLATE_C = 5.0  # today's value this far outside the runs' range makes the data answer a guess
GAS_LAW_GAP_BAR = 0.03  # runs that beat the gas law by more than this get a sentence saying so
TERM_NAMES = {"cold": "tyre temperature at setting", "track": "track temperature", "ambient": "ambient temperature"}


@dataclass
class Observation:
    """One corner of one logged run."""
    cold_c: float | None
    rise_bar: float
    hot_c: float | None = None
    gas_law_gap_bar: float | None = None  # measured hot pressure minus the gas law's, from the TPMS temperatures
    ambient_c: float | None = None
    track_c: float | None = None

    def value(self, term: str) -> float | None:
        return {"cold": self.cold_c, "track": self.track_c, "ambient": self.ambient_c}[term]


@dataclass
class RiseFit:
    """rise = intercept + sum(slope * (value - runs' mean)) over the terms, in bar."""
    n: int
    terms: list[str]
    intercept: float  # the rise at the runs' mean conditions
    slopes: dict[str, float]  # bar per °C
    means: dict[str, float]
    ranges: dict[str, tuple[float, float]]
    sd_bar: float | None  # residual standard deviation: the typical error of one prediction

    def predict(self, today: dict[str, float]) -> float:
        return self.intercept + sum(self.slopes[t] * (today[t] - self.means[t]) for t in self.terms)

    def outside(self, today: dict[str, float]) -> list[str]:
        """Terms where today's value is well outside what the runs saw."""
        return [t for t in self.terms
                if not self.ranges[t][0] - EXTRAPOLATE_C <= today[t] <= self.ranges[t][1] + EXTRAPOLATE_C]


def _spread(obs: list[Observation], term: str) -> float:
    vals = [o.value(term) for o in obs]
    return max(vals) - min(vals) if vals else 0.0


def fit_rise(obs: list[Observation], today: dict[str, float]) -> RiseFit | None:
    """Least-squares fit of the rise. A term joins only with enough runs that vary in it and today's value known."""
    if not obs:
        return None
    rows, terms = list(obs), []
    if "cold" in today:
        sub = [o for o in rows if o.cold_c is not None]
        if len(sub) >= MIN_RUNS_COLD_TERM and _spread(sub, "cold") >= MIN_SPREAD_C:
            rows, terms = sub, ["cold"]
    for env in ("track", "ambient"):  # one of the two: track temperature when the runs have it
        sub = [o for o in rows if o.value(env) is not None]
        if env in today and len(sub) >= MIN_RUNS_ENV_TERM and _spread(sub, env) >= MIN_SPREAD_C:
            rows, terms = sub, [*terms, env]
            break
    y = np.array([o.rise_bar for o in rows])
    means = {t: float(np.mean([o.value(t) for o in rows])) for t in terms}
    x = np.column_stack([np.ones(len(rows))] + [[o.value(t) - means[t] for o in rows] for t in terms])
    coef, *_ = np.linalg.lstsq(x, y, rcond=None)
    resid = y - x @ coef
    dof = len(rows) - len(coef)
    return RiseFit(
        n=len(rows), terms=terms, intercept=float(coef[0]),
        slopes={t: float(c) for t, c in zip(terms, coef[1:], strict=True)}, means=means,
        ranges={t: (min(o.value(t) for o in rows), max(o.value(t) for o in rows)) for t in terms},
        sd_bar=float(np.sqrt(resid @ resid / dof)) if dof > 0 else None,
    )


def observations(runs: list[dict], corner: str) -> list[Observation]:
    """The usable cold-to-hot measurements of one corner across the runs (see the runs endpoint)."""
    out = []
    for r in runs:
        c = r["corners"].get(corner)
        if not c or not c["used"]:
            continue
        gap = c["hot_bar"] - c["gas_law_hot_bar"] if c.get("gas_law_hot_bar") is not None else None
        out.append(Observation(c["cold_c"], c["rise_bar"], c["hot_c"], gap, r.get("ambient_c"), r.get("track_c")))
    return out


def limits_for(corner: str, minimums: list[dict]) -> dict:
    """The highest cold and hot minimum entered for this corner's axle, with where it came from."""
    rows = [m for m in minimums if m.get("axle") == AXLE[corner]]
    out: dict = {}
    for kind in ("cold", "hot"):
        have = [m for m in rows if m.get(f"{kind}_min_bar") is not None]
        if have:
            top = max(have, key=lambda m: m[f"{kind}_min_bar"])
            out[kind] = {"bar": top[f"{kind}_min_bar"], "source": top.get("source"), "tyre": top.get("tyre")}
    window = next((w for w in HOT_WINDOWS if w.get("axle") == AXLE[corner]), None)
    if window:
        out["window"] = window
    return out


def _fmt(bar: float) -> str:
    return f"{bar:.2f} bar"


def _src(limit: dict) -> str:
    return f" ({limit['source']})" if limit.get("source") else ""


def pressure_plan(targets: dict[str, float], runs: list[dict], minimums: list[dict], *,
                  set_c: float | None = None, ambient_c: float | None = None, track_c: float | None = None,
                  hot_c: dict[str, float] | None = None, atmospheric_bar: float = 1.013) -> dict:
    """Cold pressure per corner to reach the target hot pressure, by the gas law and by the logged runs."""
    set_source = "entered"
    if set_c is None and ambient_c is not None:
        set_c, set_source = ambient_c, "ambient (no tyre temperature entered)"
    today = {k: v for k, v in (("cold", set_c), ("track", track_c), ("ambient", ambient_c)) if v is not None}
    corners = []
    for corner in CORNERS:
        if targets.get(corner) is None:
            continue
        target = targets[corner]
        obs = observations(runs, corner)
        limit = limits_for(corner, minimums)
        gas = _gas_law(target, set_c, (hot_c or {}).get(corner), obs, atmospheric_bar)
        data = _from_data(target, obs, today)
        corners.append({"corner": corner, "axle": AXLE[corner], "target_hot_bar": target, "gas_law": gas,
                        "data": data, "limits": limit, "flags": _flags(target, gas, data, limit)})
    return {"atmospheric_bar": atmospheric_bar, "set_c": set_c, "set_c_source": set_source if set_c is not None
            else None, "ambient_c": ambient_c, "track_c": track_c, "corners": corners}


def _gas_law(target: float, set_c: float | None, hot: float | None, obs: list[Observation],
             atmospheric_bar: float) -> dict:
    temps = [o.hot_c for o in obs if o.hot_c is not None]
    source = "entered"
    if hot is None and temps:
        hot, source = round(float(np.median(temps)), 1), f"typical TPMS hot temperature in your {len(temps)} runs"
    out: dict = {"cold_bar": None, "set_c": set_c, "hot_c": hot, "hot_c_source": source if hot is not None else None}
    if set_c is None or hot is None:
        missing = "the tyre temperature at setting (or the ambient temperature)" if set_c is None \
            else "the expected hot tyre temperature"
        out["text"] = f"Enter {missing} to use the gas law."
        return out
    cold = cold_from_hot(target, hot, set_c, atmospheric_bar)
    out["cold_bar"] = round(cold, 2)
    out["text"] = (f"Set {_fmt(cold)} at {set_c:.0f} °C: the gas law takes it to {_fmt(target)} at {hot:.0f} °C "
                   f"(absolute pressure with {atmospheric_bar:.3f} bar of atmosphere).")
    gaps = [o.gas_law_gap_bar for o in obs if o.gas_law_gap_bar is not None]
    if gaps:
        gap = float(np.median(gaps))
        out["runs_gap_bar"] = round(gap, 3)
        if abs(gap) >= GAS_LAW_GAP_BAR:
            word = "above" if gap > 0 else "below"
            why = " The sensor sits on the rim and reads cooler than the air inside, so the gas law with its " \
                  "temperature asks for too much cold pressure." if gap > 0 else ""
            out["runs_note"] = (f"In your {len(gaps)} runs this tyre ended {abs(gap):.2f} bar {word} what the gas law "
                                f"predicts from the TPMS temperatures.{why}")
    return out


def _from_data(target: float, obs: list[Observation], today: dict[str, float]) -> dict:
    fit = fit_rise(obs, today)
    if fit is None:
        return {"cold_bar": None, "runs": 0, "text": "No logged run of this tyre settled to a hot pressure yet: upload "
                "logs with TPMS channels (pTyre/TTyre) to learn this car's pressure rise."}
    rise = fit.predict(today)
    cold = target - rise
    out = {"cold_bar": round(cold, 2), "rise_bar": round(rise, 3), "runs": fit.n,
           "typical_error_bar": round(fit.sd_bar, 3) if fit.sd_bar is not None else None,
           "terms": [TERM_NAMES[t] for t in fit.terms],
           "slopes_bar_per_c": {TERM_NAMES[t]: round(s, 4) for t, s in fit.slopes.items()},
           "average_rise_bar": round(float(np.mean([o.rise_bar for o in obs])), 3)}
    runs_word = "run" if fit.n == 1 else "runs"
    text = f"Set {_fmt(cold)}. In your {fit.n} {runs_word} this tyre gained {_fmt(fit.intercept)} from cold to hot"
    if fit.terms:
        text += " on average; it gains " + " and ".join(
            f"{abs(s):.3f} bar {'more' if s > 0 else 'less'} for every °C of {TERM_NAMES[t]} above "
            f"{fit.means[t]:.0f} °C" for t, s in fit.slopes.items())
        text += f", so today's expected gain is {_fmt(rise)}"
    text += "." if fit.sd_bar is None else f" (typical error ±{fit.sd_bar:.2f} bar)."
    left_out = [TERM_NAMES[t] for t in ("cold", "track", "ambient") if t in today and t not in fit.terms]
    if left_out:
        text += f" Not enough varied runs yet to account for the {' or '.join(left_out)}."
    far = fit.outside(today)
    if far:
        out["extrapolating"] = True
        text += (f" Today's {' and '.join(TERM_NAMES[t] for t in far)} is outside what your runs saw: treat it as "
                 "a guess.")
    out["text"] = text
    return out


def _flags(target: float, gas: dict, data: dict, limit: dict) -> list[str]:
    flags = []
    hot_min, cold_min, window = limit.get("hot"), limit.get("cold"), limit.get("window")
    if hot_min and target < hot_min["bar"]:
        flags.append(f"The target {_fmt(target)} is below the P-Book hot minimum of {_fmt(hot_min['bar'])}"
                     f"{_src(hot_min)}.")
    if window and not window["low_bar"] <= target <= window["high_bar"]:
        flags.append(f"The target {_fmt(target)} is outside the hot window of {window['low_bar']:.2f}-"
                     f"{window['high_bar']:.2f} bar{_src(window)}.")
    if cold_min:
        for name, answer in (("gas law", gas), ("data", data)):
            if answer.get("cold_bar") is not None and answer["cold_bar"] < cold_min["bar"]:
                flags.append(f"The {name} answer {_fmt(answer['cold_bar'])} is below the P-Book cold minimum of "
                             f"{_fmt(cold_min['bar'])}{_src(cold_min)}: set at least the minimum.")
    return flags
