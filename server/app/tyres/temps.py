"""Tyre temperature analysis: camber and pressure advice from the temperatures across each tyre's tread.

Readings are inside (towards the car's centre), middle and outside, in °C, from a pyrometer after a run or
averaged from IR sensors in a log. The rules, one per question:
- camber: the inside edge should run hotter than the outside by the target spread. Much more than that is more
  negative camber than the tyre needs; much less, or the outside hotter, is too little.
- pressure: the middle should sit at the average of the two edges. A hotter middle means the tyre is over-inflated
  and running on its centre; a cooler middle means it is under-inflated and running on its edges.
- balance: each tyre's average, front axle against rear and left side against right.
Where a reading or a suggestion goes past a limit in the older public Pirelli GT4 booklets (presets.OLDER_BOOKLET),
a reference note says so, labelled as not the DHG P_Book.
"""
from __future__ import annotations

import re

import numpy as np

from app.importers.motec import LdFile
from app.tyres.presets import OLDER_BOOKLET, TARGET_SPREAD_C, TARGET_SPREAD_SOURCE
from app.tyres.tpms import CORNERS, NO_REPORT_C, RACING_KMH, SPEED_CHANNELS

CAMBER_TOLERANCE_C = 3.0  # spread within the target ± this: camber looks right
PRESSURE_TOLERANCE_C = 3.0  # middle within the edges' average ± this: pressure looks right
CAMBER_STEP_DEG = 0.25  # a cautious first change; measure again before the next one
PRESSURE_STEP_BAR = 0.05
AXLE_BALANCE_C = 8.0  # front and rear averages further apart than this: one axle is doing more of the work
SIDE_BALANCE_C = 5.0  # left and right averages further apart than this
READING_RANGE_C = (-10.0, 200.0)  # outside this a reading is a typo
POSITIONS = ("inside", "middle", "outside")


def _deg(x: float) -> str:
    return f"{x:.0f} °C" if abs(x - round(x)) < 0.05 else f"{x:.1f} °C"


def _reference(text: str, source: str = OLDER_BOOKLET["source"]) -> dict:
    return {"text": f"{text} Reference: {OLDER_BOOKLET['label']}.", "source": source}


def camber_advice(r: dict, target_spread: float, axle: str = "front") -> dict:
    spread = r["inside"] - r["outside"]
    off = spread - target_spread
    out: dict = {"spread_c": round(spread, 1), "target_spread_c": target_spread, "change_deg": 0.0, "references": []}
    if spread < 0:
        out["verdict"] = "more negative camber"
        out["text"] = (f"The outside edge is {_deg(-spread)} hotter than the inside: the tyre is rolling onto its "
                       f"shoulder, so it needs more negative camber (try {CAMBER_STEP_DEG}° to start).")
        out["change_deg"] = -CAMBER_STEP_DEG
    elif off > CAMBER_TOLERANCE_C:
        out["verdict"] = "less negative camber"
        out["text"] = (f"The inside is {_deg(spread)} hotter than the outside, {_deg(off)} more than the "
                       f"{_deg(target_spread)} target: more negative camber than the tyre needs, so take out about "
                       f"{CAMBER_STEP_DEG}°.")
        out["change_deg"] = CAMBER_STEP_DEG
    elif off < -CAMBER_TOLERANCE_C:
        out["verdict"] = "more negative camber"
        out["text"] = (f"The inside is only {_deg(spread)} hotter than the outside, {_deg(-off)} under the "
                       f"{_deg(target_spread)} target: the outside edge is working too hard, so add about "
                       f"{CAMBER_STEP_DEG}° of negative camber.")
        out["change_deg"] = -CAMBER_STEP_DEG
    else:
        out["verdict"] = "ok"
        out["text"] = (f"The inside is {_deg(spread)} hotter than the outside, within {_deg(CAMBER_TOLERANCE_C)} of "
                       f"the {_deg(target_spread)} target: camber looks right.")
    if r.get("camber_deg") is not None and out["change_deg"]:
        out["suggested_camber_deg"] = round(r["camber_deg"] + out["change_deg"], 2)
        out["text"] += f" From {r['camber_deg']:.2f}° to {out['suggested_camber_deg']:.2f}°."
    limit = OLDER_BOOKLET["max_inside_outside_c"]
    if spread > limit:
        out["references"].append(_reference(f"The inside runs more than {_deg(limit)} hotter than the outside, the "
                                             "most the booklet allows."))
    camber, most = out.get("suggested_camber_deg", r.get("camber_deg")), OLDER_BOOKLET["max_camber_deg"][axle]
    if camber is not None and camber < most:
        out["references"].append(_reference(f"{camber:.2f}° is more negative than the {most:.1f}° maximum static "
                                            f"camber for the {axle}."))
    return out


def pressure_advice(r: dict, hot_min_bar: float | None = None) -> dict:
    edges = (r["inside"] + r["outside"]) / 2
    off = r["middle"] - edges
    out = {"middle_vs_edges_c": round(off, 1), "change_bar": 0.0}
    if off > PRESSURE_TOLERANCE_C:
        out["verdict"] = "lower"
        out["text"] = (f"The middle is {_deg(off)} hotter than the average of the edges: the tyre is over-inflated "
                       f"and running on its centre, so lower the pressure by about {PRESSURE_STEP_BAR:.2f} bar.")
        out["change_bar"] = -PRESSURE_STEP_BAR
    elif off < -PRESSURE_TOLERANCE_C:
        out["verdict"] = "raise"
        out["text"] = (f"The middle is {_deg(-off)} cooler than the average of the edges: the tyre is under-inflated "
                       f"and running on its edges, so raise the pressure by about {PRESSURE_STEP_BAR:.2f} bar.")
        out["change_bar"] = PRESSURE_STEP_BAR
    else:
        out["verdict"] = "ok"
        out["text"] = (f"The middle is within {_deg(PRESSURE_TOLERANCE_C)} of the average of the edges: the pressure "
                       "looks right.")
    p = r.get("pressure_bar")
    if p is not None:
        new = round(p + out["change_bar"], 2)
        if out["change_bar"]:
            out["suggested_pressure_bar"] = new
            out["text"] += f" From {p:.2f} to {new:.2f} bar hot."
        if hot_min_bar is not None and new < hot_min_bar:
            out["below_minimum"] = True
            out["text"] += f" That is below the P-Book hot minimum of {hot_min_bar:.2f} bar: stay at or above it."
    return out


def _mean(tyres: dict[str, dict], corners: tuple[str, ...]) -> float | None:
    vals = [tyres[c]["average_c"] for c in corners if c in tyres]
    return float(np.mean(vals)) if len(vals) == len(corners) else None


def balance(tyres: dict[str, dict]) -> list[dict]:
    """Front against rear and left against right, from each tyre's average."""
    out = []
    front, rear = _mean(tyres, ("FL", "FR")), _mean(tyres, ("RL", "RR"))
    if front is not None and rear is not None:
        d = front - rear
        if d > AXLE_BALANCE_C:
            text = (f"The fronts average {_deg(d)} more than the rears: the front tyres are doing more of the work, "
                    "which usually goes with understeer.")
        elif d < -AXLE_BALANCE_C:
            text = (f"The rears average {_deg(-d)} more than the fronts: the rear tyres are doing more of the work, "
                    "which usually goes with oversteer or wheelspin.")
        else:
            text = f"Front and rear are within {_deg(AXLE_BALANCE_C)} of each other: the axles share the work evenly."
        refs = []
        if abs(d) > OLDER_BOOKLET["max_front_rear_c"]:
            refs.append(_reference(f"Front and rear are more than {_deg(OLDER_BOOKLET['max_front_rear_c'])} apart, "
                                   "the most the booklet allows.", OLDER_BOOKLET["front_rear_source"]))
        out.append({"kind": "axle", "front_c": round(front, 1), "rear_c": round(rear, 1),
                    "difference_c": round(d, 1), "text": text, "references": refs})
    left, right = _mean(tyres, ("FL", "RL")), _mean(tyres, ("FR", "RR"))
    if left is not None and right is not None:
        d = left - right
        if abs(d) > SIDE_BALANCE_C:
            hot, other, turn = ("left", "right", "right") if d > 0 else ("right", "left", "left")
            text = (f"The {hot} tyres average {_deg(abs(d))} more than the {other}: the track has more or faster "
                    f"{turn}-hand corners, which load the {hot} side, or the car is set up unevenly.")
        else:
            text = f"Left and right are within {_deg(SIDE_BALANCE_C)} of each other."
        out.append({"kind": "side", "left_c": round(left, 1), "right_c": round(right, 1),
                    "difference_c": round(d, 1), "text": text, "references": []})
    return out


def analyze_temps(readings: dict[str, dict], target_spread: dict[str, float] | None = None,
                  hot_min_bar: dict[str, float] | None = None) -> dict:
    """Advice per tyre and the car's balance.

    readings: {corner: {"inside", "middle", "outside", optional "pressure_bar", "camber_deg"}}
    target_spread: {"front": °C, "rear": °C}, defaulting to presets.TARGET_SPREAD_C
    hot_min_bar: {"front": bar, "rear": bar}, the P-Book hot minimums where entered
    """
    spread = {"front": TARGET_SPREAD_C, "rear": TARGET_SPREAD_C, **(target_spread or {})}
    tyres = {}
    for corner in CORNERS:
        r = readings.get(corner)
        if not r:
            continue
        for pos in POSITIONS:
            if not READING_RANGE_C[0] <= r[pos] <= READING_RANGE_C[1]:
                raise ValueError(f"{corner} {pos} reads {r[pos]} °C; check the reading")
        axle = "front" if corner[0] == "F" else "rear"
        tyres[corner] = {
            "corner": corner, **{p: r[p] for p in POSITIONS},
            "average_c": round((r["inside"] + r["middle"] + r["outside"]) / 3, 1),
            "camber": camber_advice(r, spread[axle], axle),
            "pressure": pressure_advice(r, (hot_min_bar or {}).get(axle)),
        }
    if not tyres:
        raise ValueError("Enter the inside, middle and outside temperature of at least one tyre")
    return {"tyres": [tyres[c] for c in CORNERS if c in tyres], "balance": balance(tyres),
            "target_spread_c": spread, "target_spread_source": TARGET_SPREAD_SOURCE if target_spread is None
            else "entered"}


# ---------- IR tyre temperature sensors in a log ----------

_TOKENS = re.compile(r"[A-Z]+(?=[A-Z][a-z])|[A-Z]?[a-z]+|[A-Z]+|\d+")
_TYRE_WORDS = {"tyre", "tire", "ir", "surf", "surface", "tread", "pyro"}
_CORNER_WORDS = {"fl": "FL", "fr": "FR", "rl": "RL", "rr": "RR", "lf": "FL", "rf": "FR", "lr": "RL"}
_POSITION_WORDS = {"inner": "inside", "inside": "inside", "in": "inside", "centre": "middle", "center": "middle",
                   "middle": "middle", "mid": "middle", "outer": "outside", "outside": "outside", "out": "outside"}


def ir_channels(ld: LdFile, numbered_from: str = "inside") -> dict[str, dict[str, list[str]]]:
    """IR tyre surface channels per corner, as {corner: {position: [channel names]}}.

    Named channels (e.g. "Tyre Temp FL Inner", "TTyreFLCentre") are used as named. Numbered channels across the
    tread (e.g. "IR FL 1" to "IR FL 8") are split into thirds; channel 1 is the inside edge unless numbered_from is
    "outside". The TPMS channels (TTyreFL...) measure the air inside the tyre and have no position, so they never
    match.
    """
    named: dict[str, dict[str, list[str]]] = {}
    numbered: dict[str, list[tuple[int, str]]] = {}
    for name, ch in ld.channels.items():
        if not ch.readable:
            continue
        tokens = [t.lower() for t in _TOKENS.findall(name)]
        if not _TYRE_WORDS & set(tokens):
            continue
        at = next((i for i, t in enumerate(tokens) if t in _CORNER_WORDS), None)
        if at is None:
            continue
        corner, after = _CORNER_WORDS[tokens[at]], tokens[at + 1:]
        pos = next((_POSITION_WORDS[t] for t in after if t in _POSITION_WORDS), None)
        if pos is not None:
            named.setdefault(corner, {}).setdefault(pos, []).append(name)
        elif after and after[-1].isdigit():
            numbered.setdefault(corner, []).append((int(after[-1]), name))
    out = {c: m for c, m in named.items() if all(p in m for p in POSITIONS)}
    for corner, chans in numbered.items():
        if corner in out or len(chans) < 3:
            continue
        names = [n for _, n in sorted(chans)]
        if numbered_from == "outside":
            names.reverse()
        thirds = np.array_split(np.arange(len(names)), 3)
        out[corner] = {p: [names[i] for i in idx] for p, idx in zip(POSITIONS, thirds, strict=True)}
    return out


def ir_readings(ld: LdFile, numbered_from: str = "inside") -> tuple[dict[str, dict], dict]:
    """Each corner's inside, middle and outside temperature: the mean of its channels while at racing speed."""
    found = ir_channels(ld, numbered_from)
    speed = ld.channel(*SPEED_CHANNELS)
    readings = {}
    for corner, positions in found.items():
        r = {}
        for pos, names in positions.items():
            vals = []
            for name in names:
                ch = ld.channels[name]
                v, t = ch.values(), ch.times()
                ok = v > NO_REPORT_C
                if speed is not None:
                    ok &= np.interp(t, speed.times(), speed.values()) > RACING_KMH
                vals.append(v[ok])
            allv = np.concatenate(vals) if vals else np.array([])
            if not len(allv):
                break
            r[pos] = round(float(np.mean(allv)), 1)
        if len(r) == len(POSITIONS):
            readings[corner] = r
    return readings, found
