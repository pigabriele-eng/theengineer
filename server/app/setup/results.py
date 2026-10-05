"""What a run gave: lap times, and the car's balance from the balance report's analysis, to set against its setup.

The balance is the report's (app.analysis.balance, built in the same way as GET /report/balance?session=): the
understeer angle, road wheel degrees beyond what the path needs with the yaw gyro corrected, and the car's own
normal amount of it per g of cornering. A run keeps its understeer per g (comparable between runs of the same car),
the balance against that normal in each phase of the corner (entry on the brakes, mid-corner, exit on the throttle;
+ the front pushes, - the rear slides) overall, per corner speed and per corner, the corners' speeds, the time
traction control and ABS work, and the report's setup advice (app.analysis.setup_advice), so the run history and
the setup suggestions never read the log again.

Reading a log is the expensive part, so a summary is kept in its own table and computed for one session at a time,
under the server's heavy-work lock (app/heavy.py).
"""
from __future__ import annotations

import ctypes
import gc
from datetime import datetime

import numpy as np
from sqlalchemy import select
from sqlalchemy.orm import Session

from app import heavy, models
from app.analysis.balance import PHASE_NAMES, SPEED_BANDS, Collected, analyse, car_geometry, collect, prepared
from app.analysis.insights import Prepared, _dt, cornering
from app.analysis.setup_advice import CAR_SHARE_MIN, report, where_car_loses
from app.routers.balance import preset_for
from app.routers.sessions import load_main_file, official_corners
from app.setup.models import SetupRunSummary
from app.vehicle.presets import preset_detail

VERSION = "2"  # change it when the summary changes, and every cached one is computed again
MIN_SAMPLES = 200  # metres of a phase while cornering, across the clean laps, before its balance counts


def speed_band(kmh: float | None) -> str | None:
    """slow under 110 km/h, medium to 160, fast above: the balance report's corner speed bands."""
    if kmh is None:
        return None
    return next((name for name, lo, hi in SPEED_BANDS if lo <= kmh < hi), "fast")


def lap_times(laps: list[models.Lap]) -> dict:
    """Lap time numbers straight from the database: best, the mean of the three quickest and how many clean."""
    clean = sorted(l.time_s for l in laps if l.clean)
    return {"clean_laps": len(clean), "best_s": clean[0] if clean else None,
            "top3_s": round(float(np.mean(clean[:3])), 3) if len(clean) >= 3 else None}


def from_laps(prep: Prepared, per_g: float | None) -> dict:
    """What the report doesn't give for a whole run: the balance against the car's normal in each phase over all
    corner speeds (the report's speed table without the split), and the seconds of ABS per clean lap."""
    out: dict = {"entry": None, "mid": None, "exit": None, "abs_s_per_lap": None}
    laps = [x for x in prep.laps if "understeer" in x.trace]
    if per_g is not None and laps:
        tr = {k: np.concatenate([x.trace[k] for x in laps]).astype(float)
              for k in ("understeer", "ay", "phase", "speed")}
        corner = cornering(tr) & (tr["speed"] > 40)
        rel = tr["understeer"] - per_g * np.abs(tr["ay"])
        phase = np.rint(tr["phase"]).astype(int)
        for p, name in PHASE_NAMES:
            sel = corner & (phase == p)
            out[name] = round(float(np.median(rel[sel])), 2) if np.count_nonzero(sel) >= MIN_SAMPLES else None
    with_abs = [x for x in prep.laps if "abs_on" in x.trace]
    if with_abs:
        total = sum(float((_dt(x.trace) * (x.trace["abs_on"] > 0.5)).sum()) for x in with_abs)
        out["abs_s_per_lap"] = round(total / len(with_abs), 2)
    return out


def summarize(a: dict, rep: dict, extra: dict | None = None) -> dict:
    """A run's summary from the balance analysis (analyse()), its report section (setup_advice.report) and
    from_laps()."""
    extra = extra or {}
    g, diag = a.get("gradient"), a.get("diagnostics") or {}
    balance = None
    if g:
        balance = {**{p: extra.get(p) for _, p in PHASE_NAMES}, "gradient_per_g": g["per_g"], "spread": g["spread"],
                   "by_speed": [{k: r[k] for k in ("speed", "entry", "mid", "exit")} for r in g["table"]],
                   "by_g": g["by_g"]}
    sections = []
    for s in a["sections"]:
        bal = s.get("balance") or {}
        sections.append({
            "code": s["code"], "apex_m": s["apex_m"], "min_speed_kmh": s["min_speed_kmh"],
            "speed": speed_band(s["min_speed_kmh"]),
            **{p: (bal.get(p) or {}).get("value") for _, p in PHASE_NAMES},
            "car_s": s["car"], "where": where_car_loses(s) if s["car"] >= CAR_SHARE_MIN else None,
            "tc_s": (s.get("tc_s") or {}).get("typical"),
            "rear_slip_exit": (s.get("rear_slip_exit") or {}).get("typical")})
    return {
        "balance": balance,
        "sections": sections,
        "corners": [{"code": s["code"], "apex_m": s["apex_m"], "apex_kmh": s["min_speed_kmh"], "speed": s["speed"]}
                    for s in sections if s["apex_m"] is not None],
        "numbering": a.get("numbering"),
        "tc_s_per_lap": diag.get("traction_control_s_per_lap"),
        "abs_s_per_lap": extra.get("abs_s_per_lap"),
        "tyres": diag.get("tyres"),
        "lap_split": rep["car_limits"]["lap"],
        "advice": {k: rep[k] for k in ("headline", "recommendations", "notes", "checks")},
        "steering": rep["method"]["steering_ratio"],
    }


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


def _build(db: Session, s: models.RunSession) -> dict:
    """The balance report's analysis of this one session (as app.routers.balance builds it), summarised."""
    preset = preset_for([s.car] if s.car else [])
    geo = car_geometry(preset_detail(preset) if preset else None)
    col = Collected()
    _, run, track = load_main_file(db, s)
    collect(s.name or f"Session {s.id}", run, geo, col, driver=s.driver.name if s.driver else None,
            meta={"session_id": s.id})
    del run  # collect() has kept only each clean lap's few channels
    gc.collect()
    corners = official_corners(track)
    prep = prepared(col, corners)
    if prep is None:
        return {"balance": None, "corners": [], "note": "No clean laps in this session"}
    a = analyse(prep, corners)
    rep = report(a, geo.to_dict(), col.sessions, preset)
    g = a.get("gradient")
    return summarize(a, rep, from_laps(prep, g["per_g"] if g else None))


def run_summary(db: Session, s: models.RunSession) -> dict:
    """The session's summary: from the cache, or read from its main log (one log at a time across requests)."""
    hit = cached(db, s)
    if hit is not None:
        return hit
    with heavy.lock:  # one log-reading job at a time across the server
        hit = cached(db, s)  # another request may have just computed it
        if hit is not None:
            return hit
        if _main_file(s) is None or not any(l.clean for l in s.laps):
            data = {"balance": None, "corners": [], "note": "No clean laps in this session"}
        else:
            try:
                data = _build(db, s)
            finally:
                _release_memory()
        row = db.scalar(select(SetupRunSummary).where(SetupRunSummary.session_id == s.id))
        if row is None:
            row = SetupRunSummary(session_id=s.id)
            db.add(row)
        row.signature, row.data, row.computed_at = signature(s), data, datetime.now().astimezone()
        db.commit()
        return data
