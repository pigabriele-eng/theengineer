"""Every channel the logger recorded, lap by lap, against lap time.

Only slow-moving channels are scanned: temperatures, pressures, fuel, electrics. Fast channels (speeds, rpm,
suspension, lambda) just follow the driving and would only say "faster laps are faster". Lap time is first
cleared of the run-to-run differences and of the trend through each run (tyres coming in, fuel burning off),
so what remains is what changed from lap to lap for other reasons. These are leads to check, not causes.
"""
from __future__ import annotations

import math
import re

import numpy as np

from app.analysis.laps import Lap
from app.importers.motec import LdFile

# timing, clocks, counters and GPS bookkeeping: they say when, not how
SKIP_NAMES = re.compile(r"lap|split|gain|time|mileage|hour|minute|sats|runtime|remaining|gps|supply|beacon", re.I)
CATEGORIES = (  # what a channel is about, from its name; "other" channels deserve the most scepticism
    ("tyres", re.compile(r"tyre|tire", re.I)),
    ("brakes", re.compile(r"brake", re.I)),
    ("fuel", re.compile(r"fuel", re.I)),
    ("powertrain", re.compile(r"oil|water|coolant|gearbox|diff|engine|clutch(?!.*ac)", re.I)),
    ("conditions", re.compile(r"ambient|air temp|track temp|baro|humid", re.I)),
)
SIGNIFICANT_P = 1e-4  # many channels are tested at once, so the bar is high
MIN_R = 0.35
MIN_LAPS = 12
WINDOW_BINS = 5


def _within(values: np.ndarray, groups: np.ndarray) -> np.ndarray:
    out = np.array(values, float)
    for g in np.unique(groups):
        sel = (groups == g) & ~np.isnan(out)
        if sel.any():
            out[groups == g] -= out[sel].mean()
    return out


def _residual(y: np.ndarray, x: np.ndarray) -> np.ndarray:
    a = np.c_[x, np.ones(len(x))]
    return y - a @ np.linalg.lstsq(a, y, rcond=None)[0]


def _corr(x: np.ndarray, y: np.ndarray) -> tuple[float, float, float] | None:
    if len(x) < MIN_LAPS or x.std() < 1e-12 or y.std() < 1e-12:
        return None
    r = float(np.corrcoef(x, y)[0, 1])
    z = math.atanh(max(min(r, 0.9999), -0.9999)) * math.sqrt(len(x) - 3)
    return r, math.erfc(abs(z) / math.sqrt(2)), float(np.polyfit(x, y, 1)[0])


def lap_medians(ld: LdFile, laps: list[Lap]) -> dict[str, tuple[str, np.ndarray, float]]:
    """Per channel: unit, median per lap, and how much it moves within a lap (mean standard deviation)."""
    out = {}
    for name, ch in ld.channels.items():
        if SKIP_NAMES.search(name) or ch.count < 10:
            continue
        t, v = ch.times(), ch.values().astype(float)
        meds, sds = [], []
        for l in laps:
            i0, i1 = np.searchsorted(t, [l.start, l.end])
            seg = v[i0:i1]
            meds.append(float(np.median(seg)) if len(seg) > 2 else np.nan)
            sds.append(float(seg.std()) if len(seg) > 2 else np.nan)
        out[name] = (ch.unit, np.array(meds), float(np.nanmean(sds)) if not np.isnan(sds).all() else np.nan)
    return out


def channel_scan(items: list[tuple[str, LdFile, list[Lap]]]) -> list[dict]:
    """Slow channels that move with lap time, strongest first, each with the range where laps were quickest."""
    runs = np.array([run for run, _, laps in items for _ in laps])
    times = np.array([l.time for _, _, laps in items for l in laps])
    order = np.array([i for _, _, laps in items for i in range(len(laps))], float)
    if len(times) < MIN_LAPS:
        return []
    stats: dict[str, list] = {}
    for k, (_, ld, laps) in enumerate(items):
        for name, (unit, med, sd) in lap_medians(ld, laps).items():
            stats.setdefault(name, [unit, [None] * len(items), []])
            stats[name][1][k] = med
            stats[name][2].append(sd)
    lengths = [len(laps) for _, _, laps in items]
    trend = _within(order, runs)
    y = _residual(_within(times, runs), trend)
    found: list[dict] = []
    seen: list[np.ndarray] = []
    for name, (unit, per_run, sds) in stats.items():
        x = np.concatenate([m if m is not None else np.full(n, np.nan) for m, n in zip(per_run, lengths, strict=True)])
        if np.isnan(x).mean() > 0.2:
            continue
        ok = ~np.isnan(x)
        xw = _within(x, runs)
        spread = float(np.nanstd(xw))
        if spread < 1e-9 or not np.nanmean(sds) < spread:  # moves more inside a lap than from lap to lap
            continue
        xr = _residual(xw[ok], trend[ok])
        c = _corr(xr, y[ok])
        if c is None or c[1] > SIGNIFICANT_P or abs(c[0]) < MIN_R:
            continue
        if any(abs(np.corrcoef(x[ok], s[ok])[0, 1]) > 0.999 for s in seen if (~np.isnan(s[ok])).all()):
            continue  # the same sensor logged twice under another name
        seen.append(x)
        category = next((k for k, rx in CATEGORIES if rx.search(name)), "other")
        found.append({"channel": name, "unit": unit, "category": category, "r": round(c[0], 3), "p": c[1],
                      "seconds_per_unit": round(c[2], 4), "window": _window(x[ok], y[ok])})
    found.sort(key=lambda f: f["p"])
    return found


def _window(x: np.ndarray, y: np.ndarray) -> dict | None:
    """The band of values where laps were quickest against the rest (lap time already cleared of trends)."""
    edges = np.unique(np.percentile(x, np.linspace(0, 100, WINDOW_BINS + 1)))
    if len(edges) < 3:
        return None
    bins = np.clip(np.searchsorted(edges, x, side="right") - 1, 0, len(edges) - 2)
    means = [float(y[bins == b].mean()) if np.any(bins == b) else np.inf for b in range(len(edges) - 1)]
    best = int(np.argmin(means))
    inside = bins == best
    if inside.all():
        return None
    return {"from": round(float(edges[best]), 3), "to": round(float(edges[best + 1]), 3),
            "quicker_by_s": round(float(y[~inside].mean() - y[inside].mean()), 3), "laps": int(inside.sum())}
