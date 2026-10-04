"""Line up what was said about a corner with what the logger recorded there."""
from __future__ import annotations

from app import models

MAX_APEX_GAP_M = 150


def corner_data(points: list[models.DebriefPoint], track_corners: list[models.Corner], analysis: dict) -> dict:
    """For each corner mentioned in the debrief, the logged corner it refers to and its metrics.

    Track corners with a known apex distance are matched to the nearest detected corner; otherwise the
    codes have to agree (detected corners are numbered T1, T2, ... in lap order).
    """
    detected = analysis.get("corners", [])
    ref = analysis.get("reference_lap")
    by_code = {c.code.lower(): c for c in track_corners}
    out: dict[str, dict] = {}
    for code in dict.fromkeys(p.corner_code for p in points if p.corner_code):
        known = by_code.get(code.lower())
        if known and known.apex_m is not None and detected:
            near = min(detected, key=lambda c: abs(c["apex_m"] - known.apex_m))
            hit = near if abs(near["apex_m"] - known.apex_m) <= MAX_APEX_GAP_M else None
        else:
            hit = next((c for c in detected if c["code"].lower() == code.lower()), None)
        if hit is None:
            continue
        laps = hit["laps"]
        out[code] = {
            "detected_code": hit["code"], "apex_m": hit["apex_m"],
            "reference_lap": ref, "reference": laps.get(ref),
            "best_lap": hit["best_lap"], "best": laps.get(hit["best_lap"]),
            "spread_s": round(max(m["time"] for m in laps.values()) - min(m["time"] for m in laps.values()), 3),
        }
    return out
