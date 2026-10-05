"""The reference lap drawn as a track map: its path, speed, start/finish line, corners and sections.

Everything is placed on the same reference lap, distance grid and corner numbering as the corner analysis
(laps.analyze) and the insights sections, so a section on the map is the section in the numbers.
"""
from __future__ import annotations

import numpy as np

from app.analysis.align import track_line
from app.analysis.laps import (CornerSpec, SessionData, corner_metrics, corner_sections, lap_length, lap_trace,
                               make_sections)

STEP_M = 5  # one path point every 5 m: smooth at any phone or report size, about 900 points at Hockenheim
SMOOTH_M = 11  # moving average over the GPS path, metres: takes out GPS jitter, keeps the tightest corner's shape
DIRECTION_M = 15  # the direction of travel at the line, from the path this far either side of it
MAP_ROLES = ("speed", "lat", "lon")  # all a map needs from the log


class NoLapError(ValueError):
    """No lap to draw the track from."""


class NoGpsError(ValueError):
    """The log has no GPS position."""


def _smooth_loop(v: np.ndarray, w: int) -> np.ndarray:
    k = np.ones(w) / w
    return np.convolve(np.pad(v, w, mode="wrap"), k, "same")[w:-w]


def _closed_path(x: np.ndarray, y: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """The lap's GPS path with its small end-to-start gap spread over the lap, so it closes, then smoothed."""
    n = len(x)
    if n > 2 * SMOOTH_M:
        # where the path would carry on one metre past its last point, which should be its first point
        gx, gy = x[-1] + (x[-1] - x[-2]) - x[0], y[-1] + (y[-1] - y[-2]) - y[0]
        f = np.arange(n) / n
        x, y = x - gx * f, y - gy * f
        x, y = _smooth_loop(x, SMOOTH_M), _smooth_loop(y, SMOOTH_M)
    return x, y


def track_map(data: SessionData, corners: list[CornerSpec] | None = None, ref_number: int | None = None) -> dict:
    """The reference lap (the best clean lap unless another is asked for) as a map in local metres: x east and
    y north of the lap's mean position, one point every STEP_M from the start/finish line, with speed.

    Raises NoLapError when there is no lap to draw, NoGpsError when the log has no GPS position.
    """
    clean = [l for l in data.laps if l.clean]
    ref = next((l for l in data.laps if l.number == ref_number), None) if ref_number is not None else None
    if ref is None and ref_number is not None:
        raise NoLapError(f"No lap {ref_number} in this log")
    ref = ref or (min(clean, key=lambda l: l.time) if clean else None)
    if ref is None:
        raise NoLapError("No clean lap to draw the track from")
    length = round(lap_length(data, ref))
    line = track_line(data, ref, length)
    if line is None or length < 4 * STEP_M:
        raise NoGpsError("This log has no GPS position, so the track can't be drawn")
    trace = lap_trace(data, ref, length)  # the analysis' own reference trace, one point per metre
    x, y = _closed_path(line.x, line.y)
    sections, numbering = make_sections(trace, corners)
    labelled, _ = corner_sections(trace, corners)
    apex_of = {c.code: c.apex for c in labelled}
    # the reference lap's time and slowest speed in each corner, as the corner analysis gives them
    metrics = {c.code: corner_metrics(trace, c) for c in labelled}

    def at(m: float) -> dict:
        i = int(np.clip(round(m), 0, length - 1))
        return {"x": round(float(x[i]), 1), "y": round(float(y[i]), 1)}

    # direction of travel through the line, from just before it to just after it
    dx = float(x[DIRECTION_M] - x[-DIRECTION_M])
    dy = float(y[DIRECTION_M] - y[-DIRECTION_M])
    norm = float(np.hypot(dx, dy)) or 1.0
    # shoelace area: negative when the lap runs clockwise seen from above (x east, y north)
    area = 0.5 * float(np.sum(x * np.roll(y, -1) - np.roll(x, -1) * y))

    idx = np.arange(0, length, STEP_M)
    official = sorted((c for c in corners or [] if c[1] is not None and 0 <= c[1] < length), key=lambda c: c[1])
    return {
        "reference_lap": ref.number,
        "lap_time": ref.time,
        "length_m": length,
        "step_m": STEP_M,
        "numbering": numbering,
        "clockwise": area < 0,
        # the path from the line round to just before it; the map closes it back to the first point
        "x": np.round(x[idx], 1).tolist(),
        "y": np.round(y[idx], 1).tolist(),
        "speed": np.round(trace["speed"][idx], 1).tolist(),
        "start": {**at(0), "dx": round(dx / norm, 4), "dy": round(dy / norm, 4),
                  "heading": round(float(np.degrees(np.arctan2(dx, dy))) % 360, 1)},
        "sections": [{"code": s.code, "start_m": s.start, "end_m": s.end, "apex_m": apex_of.get(s.code),
                      "corners": s.corners, "apex": at(apex_of[s.code]) if s.code in apex_of else None,
                      "time": metrics[s.code]["time"] if s.code in metrics else None,
                      "min_speed": metrics[s.code]["min_speed"] if s.code in metrics else None}
                     for s in sections],
        # every official corner on its own, where the track's numbers are known
        "corners": [{"code": c[0], "apex_m": round(float(c[1])), **at(c[1])} for c in official]
        if numbering == "official" else [],
    }
