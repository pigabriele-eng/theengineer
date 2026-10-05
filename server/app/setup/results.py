"""What a run gave: lap times and the car's balance reduced to a few numbers, to set against its setup.

Balance is the steering used beyond what the path needs (the analysis's understeer channel, + understeer), taken
while cornering on the clean laps: the median in each phase of the corner (entry on the brakes, mid-corner, exit on
the throttle), the same per corner speed, and its gradient against lateral g. The steering geometry is calibrated
on each run's own gentle cornering, so it reads the balance at the limit against how the car turns at low g, and
two runs of the same car can be compared. The corners' apex speeds come along, so a remark about a corner can be
put in the right speed range.

Reading a log is the expensive part (one 90 MB log peaks at about 300 MB), so a summary is kept in its own table
and computed for one session at a time, behind a lock.
"""
from __future__ import annotations

import ctypes
import gc
import threading
from datetime import datetime

import numpy as np
from sqlalchemy import select
from sqlalchemy.orm import Session

from app import models
from app.analysis.channels import BRAKE, EXIT, MID, POWER, TRAIL, math_channels
from app.analysis.laps import MASTER_HZ, CornerSpec, SessionData, corner_sections, lap_length, lap_trace, load_session
from app.routers.sessions import _channel_map, _line, _track_for, official_corners, read_file
from app.setup.models import SetupRunSummary

VERSION = "1"  # change it when the summary changes, and every cached one is computed again
SPEED_BANDS = (("slow", 0.0, 110.0), ("medium", 110.0, 160.0), ("fast", 160.0, 1000.0))
PHASES = ((TRAIL, "entry"), (MID, "mid"), (EXIT, "exit"))
MIN_SAMPLES = 2 * MASTER_HZ  # two seconds of a phase across the run before its balance counts
CORNERING_G = 0.5

_lock = threading.Lock()


def speed_band(kmh: float | None) -> str | None:
    if kmh is None:
        return None
    return next(name for name, lo, hi in SPEED_BANDS if lo <= kmh < hi)


def lap_times(laps: list[models.Lap]) -> dict:
    """Lap time numbers straight from the database: best, the mean of the three quickest and how many clean."""
    clean = sorted(l.time_s for l in laps if l.clean)
    return {"clean_laps": len(clean), "best_s": clean[0] if clean else None,
            "top3_s": round(float(np.mean(clean[:3])), 3) if len(clean) >= 3 else None}


def _median(x: np.ndarray) -> float | None:
    return round(float(np.median(x)), 3) if len(x) >= MIN_SAMPLES else None


def summarize(data: SessionData, corners: list[CornerSpec] | None = None, steer_unit: str = "") -> dict:
    """Balance by phase and corner speed, its gradient, TC and ABS use, hot tyres and the corners' apex speeds."""
    clean = [l for l in data.laps if l.clean]
    out: dict = {"balance": None, "corners": [], "tc_s_per_lap": None, "abs_s_per_lap": None, "tyres": None,
                 "steer_channel": data.sources.get("steer"), "steer_unit": steer_unit}
    if not clean:
        return out
    if "phase" not in data.channels:
        math_channels(data)
    c = data.channels
    n = len(data.t)
    on_lap = np.zeros(n, bool)
    for l in clean:
        on_lap[round(l.start * MASTER_HZ):min(round(l.end * MASTER_HZ), n)] = True
    phase = np.rint(c["phase"]).astype(int)
    v, ay = c["speed"], np.abs(c["ay"])
    if "understeer" in c:
        us = c["understeer"]
        cornering = on_lap & (ay > CORNERING_G) & (phase != BRAKE) & (phase != POWER)
        by_phase = {name: _median(us[cornering & (phase == p)]) for p, name in PHASES}
        by_speed = []
        for band, lo, hi in SPEED_BANDS:
            sel = cornering & (v >= lo) & (v < hi)
            by_speed.append({"speed": band, **{name: _median(us[sel & (phase == p)]) for p, name in PHASES}})
        gradient = None
        if np.count_nonzero(cornering) > 100:
            gradient = round(float(np.polyfit(ay[cornering], us[cornering], 1)[0]), 3)
        out["balance"] = {**by_phase, "by_speed": by_speed, "gradient_per_g": gradient}
    laps = len(clean)
    if "tc_on" in c:
        out["tc_s_per_lap"] = round(float(np.count_nonzero(on_lap & (c["tc_on"] > 0.5))) / MASTER_HZ / laps, 2)
    if "abs_on" in c:
        out["abs_s_per_lap"] = round(float(np.count_nonzero(on_lap & (c["abs_on"] > 0.5))) / MASTER_HZ / laps, 2)
    tyres = {}
    for kind, name, nd in (("p", "pressure_bar", 2), ("t", "temperature_c", 1)):
        vals = {w: round(float(np.median(c[f"tyre_{kind}_{w}"][on_lap & (v > 60)])), nd)
                for w in ("fl", "fr", "rl", "rr") if f"tyre_{kind}_{w}" in c and np.any(on_lap & (v > 60))}
        if len(vals) == 4:
            tyres[name] = vals
    out["tyres"] = tyres or None
    ref = min(clean, key=lambda l: l.time)
    trace = lap_trace(data, ref, round(lap_length(data, ref)))
    found, numbering = corner_sections(trace, corners)
    out["numbering"] = numbering
    out["corners"] = [{"code": x.code, "apex_m": int(x.apex), "apex_kmh": round(float(trace["speed"][x.apex]), 1),
                       "speed": speed_band(float(trace["speed"][x.apex]))} for x in found]
    return out


def _main_file(s: models.RunSession) -> models.LoggerFile | None:
    return max(s.files, key=lambda f: f.meta.get("duration_s", 0)) if s.files else None


def signature(s: models.RunSession) -> str:
    f = _main_file(s)
    t = lap_times(s.laps)
    return f"{VERSION}:{f.id if f else 0}:{t['clean_laps']}:{t['best_s'] or 0:.3f}"


def cached(db: Session, s: models.RunSession) -> dict | None:
    row = db.scalar(select(SetupRunSummary).where(SetupRunSummary.session_id == s.id))
    return row.data if row is not None and row.signature == signature(s) else None


def _release_memory() -> None:
    gc.collect()
    try:
        ctypes.CDLL("libc.so.6").malloc_trim(0)
    except (OSError, AttributeError):  # not glibc
        pass


def run_summary(db: Session, s: models.RunSession) -> dict:
    """The session's summary: from the cache, or read from its main log (one log at a time across requests)."""
    hit = cached(db, s)
    if hit is not None:
        return hit
    with _lock:
        hit = cached(db, s)  # another request may have just computed it
        if hit is not None:
            return hit
        f = _main_file(s)
        if f is None or not any(l.clean for l in s.laps):
            data = {"balance": None, "corners": [], "note": "No clean laps in this session"}
        else:
            try:
                ld = read_file(f)
                track = _track_for(db, s, ld)
                run = load_session(ld, _channel_map(s), beacons=f.meta.get("beacons"), line=_line(track))
                steer = ld.channel(run.sources["steer"]) if "steer" in run.sources else None
                data = summarize(run, official_corners(track), steer.unit if steer else "")
                del run, ld
            finally:
                _release_memory()
        row = db.scalar(select(SetupRunSummary).where(SetupRunSummary.session_id == s.id))
        if row is None:
            row = SetupRunSummary(session_id=s.id)
            db.add(row)
        row.signature, row.data, row.computed_at = signature(s), data, datetime.now().astimezone()
        db.commit()
        return data
