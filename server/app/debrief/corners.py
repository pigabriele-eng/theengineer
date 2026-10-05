"""Line up what was said about a corner with what the logger recorded there."""
from __future__ import annotations

from app import models
from app.debrief.check import _codes


def corner_data(points: list[models.DebriefPoint], analysis: dict) -> dict:
    """For each corner mentioned in the debrief, the logged corner it is part of and its metrics.

    The analysis labels its corners with the track's official numbers ("T6", "T8/T9", "T2-T5"), so a point
    about T3 gets the corner labelled T2-T5. Corners of a track without official numbers are labelled C1,
    C2... in lap order and are never matched to a corner number someone said.
    """
    logged = analysis.get("corners", [])
    ref = analysis.get("reference_lap")
    out: dict[str, dict] = {}
    for code in dict.fromkeys(p.corner_code for p in points if p.corner_code):
        hit = next((c for c in logged if code.strip().upper() in _codes(c["code"])), None)
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
