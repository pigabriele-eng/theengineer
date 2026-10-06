"""The prep report in words: what the past events at a venue learned, turned into a briefing for the coming weekend.

Pure functions over what gather.py collected (each past event's report, technique habits, tyre prep, setups and
remarks), so it can be tested without logs. Most important first: the briefing (what to aim for, where the time is,
quali prep, pressures, the setup to open with, each driver's focus), then the performance year by year, corner by
corner with the ideal way through each corner, quali prep per event, setups and how the car behaved on them, each
driver's recurring technique points, and the opening recommendation with its evidence.

Corners are named only by their numbers (official where the track has them). Laps and sections are compared across
years only by those numbers, and only when every event used the track's official ones.
"""
from __future__ import annotations

import re
import statistics
from collections import defaultdict

from app.analysis.advice import lap_text
from app.analysis.setup_advice import describe

TOP = 3  # corners named in the briefing
HABITS_PER_DRIVER = 4
LOSS_WORTH_S = 0.02  # a phase losing less than this is not worth a word
SIGNIFICANT_CHANGE_S = 0.05  # a section this much quicker or slower than the year before is worth a word
SECTION_KEYS = ("code", "corners", "flat", "start_m", "end_m", "apex_m", "times", "gain_s", "where", "main_phase",
                "headline", "advice", "loss_line")
HABIT_KEYS = ("key", "label", "unit", "phase", "typical", "quick", "theoretical", "link", "used", "worth_s")
WHY = {  # what the time in each part of a corner comes from, in plain words
    "braking": "Time under braking comes from braking later and harder: the quick passes stop the car in less "
               "distance, so they stay at full speed longer on the way in.",
    "entry": "On entry the time is in the release: letting the brake go progressively while turning keeps the "
             "front loaded so the car turns, and it carries more speed to the apex.",
    "mid-corner": "Mid-corner the time is in the minimum speed: the car has more grip there than a typical pass "
                  "uses, so brake a little less rather than later.",
    "exit": "The exit counts twice: every km/h more out of the corner is carried all the way down the next "
            "straight, so getting back on the throttle earlier and more smoothly is worth more than braking later.",
    "full throttle": "The straight after the corner is quicker only through a better exit from it: the quick passes "
                     "are faster down it because they left the corner faster.",
}
BALANCE_WORDS = {"entry": "on entry", "mid": "mid-corner", "exit": "on exit"}


def _r(v: float | None, nd: int = 3) -> float | None:
    return None if v is None else round(float(v), nd)


def _median(vals: list[float]) -> float | None:
    return round(float(statistics.median(vals)), 3) if vals else None


def _s(v: float) -> str:
    return f"{abs(v):.2f} s"


def _quicker(delta: float) -> str:
    """'0.21 s quicker' for a negative time change, '0.21 s slower' for a positive one, 'the same' within 5 ms."""
    if abs(delta) < 0.005:
        return "the same"
    return f"{_s(delta)} {'quicker' if delta < 0 else 'slower'}"


def _span(lo: float, hi: float, unit: str, nd: int = 0) -> str:
    a, b = f"{lo:.{nd}f}", f"{hi:.{nd}f}"
    return f"{a} {unit}" if a == b else f"{a} to {b} {unit}"


def _plural(n: int, word: str) -> str:
    return f"{n} {word}{'' if n == 1 else 's'}"


def trim_report(rep: dict | None) -> dict | None:
    """An event report cut down to what the prep report reads."""
    if not rep:
        return None
    sections = []
    for s in rep.get("sections", []):
        sec = {k: s.get(k) for k in SECTION_KEYS}
        sec["habits"] = [{k: h.get(k) for k in HABIT_KEYS} for h in s.get("habits", [])]
        sections.append(sec)
    return {"numbering": rep.get("numbering"), "laps_analysed": rep.get("laps_analysed"),
            "headline": rep.get("headline"), "gains": rep.get("gains", []), "sections": sections,
            "runs": (rep.get("trends") or {}).get("runs", []), "where_total": rep.get("where_total"),
            "corners": rep.get("corners") or []}


# ---------- year by year ----------

def performance(events: list[dict]) -> list[dict]:
    """One row per past event, oldest first: what lap times were reached and in what conditions, and the change
    from the event before."""
    rows, prev = [], None
    for ev in events:
        sess = ev["sessions"]
        timed = [s for s in sess if s["best"] is not None]
        if not timed:
            continue
        best = min(timed, key=lambda s: s["best"])
        head = (ev.get("report") or {}).get("headline") or {}
        quali = None
        q = [s for s in timed if s["kind"] == "qualifying"]
        if q:
            b = min(q, key=lambda s: s["best"])
            quali = {"time": b["best"], "session": b["name"], "driver": b["driver"], "basis": "qualifying"}
        else:
            sims = [x for x in ((ev.get("tyreprep") or {}).get("sims") or []) if x.get("kind") == "quali"]
            if sims:
                b = min(sims, key=lambda x: x["peak_time"])
                quali = {"time": b["peak_time"], "session": b["label"], "driver": None, "basis": "quali run",
                         "lap": b["peak_flying"]}
        race = None
        r = [s for s in timed if s["kind"] == "race"]
        if r:
            times = [t for s in r for t in s["times"]]
            race = {"time": _median(times), "laps": len(times), "basis": "race"}
        else:
            times = [t for x in ((ev.get("tyreprep") or {}).get("long_runs") or []) for t in x["times"]]
            if times:
                race = {"time": _median(times), "laps": len(times), "basis": "long runs"}
        drivers: dict[str, dict] = {}
        for s in timed:
            if s["driver"]:
                d = drivers.setdefault(s["driver"], {"name": s["driver"], "best": s["best"], "laps": 0})
                d["best"] = min(d["best"], s["best"])
                d["laps"] += s["clean_laps"]
        ambient = [s["ambient_c"] for s in sess if s["ambient_c"] is not None]
        track = [s["track_c"] for s in sess if s["track_c"] is not None]
        row = {
            "event_id": ev["id"], "name": ev["name"], "year": ev["year"], "start": ev["start"], "end": ev["end"],
            "sessions": len(sess), "clean_laps": sum(s["clean_laps"] for s in sess), "other_cars": ev["other_cars"],
            "best": {"time": best["best"], "session": best["name"], "session_id": best["id"], "driver": best["driver"]},
            "ideal": head.get("ideal"), "realistic": head.get("realistic"), "theoretical": head.get("theoretical"),
            "typical": head.get("typical"), "quali": quali, "race_pace": race,
            "drivers": sorted(drivers.values(), key=lambda d: d["best"]),
            "conditions": {"ambient_c": [min(ambient), max(ambient)] if ambient else None,
                           "track_c": [min(track), max(track)] if track else None,
                           "tyres": sorted({s["tyre"] for s in sess if s["tyre"]})},
            "change": None,
        }
        if prev is not None:
            row["change"] = {k: _r(a - b) for k, a, b in (
                ("best", row["best"]["time"], prev["best"]["time"]),
                ("ideal", row["ideal"], prev["ideal"]),
                ("race_pace", (row["race_pace"] or {}).get("time"), (prev["race_pace"] or {}).get("time")),
                ("quali", (row["quali"] or {}).get("time"), (prev["quali"] or {}).get("time")))
                if a is not None and b is not None}
        rows.append(row)
        prev = row
    return rows


def trend_text(rows: list[dict]) -> str | None:
    """The change from the year before the last to the last, in words."""
    if len(rows) < 2:
        return None
    a, b = rows[-2], rows[-1]
    ch = b["change"] or {}
    parts = [f"best lap {_quicker(ch['best'])} ({lap_text(b['best']['time'])} against {lap_text(a['best']['time'])})"]
    if ch.get("ideal") is not None:
        parts.append(f"ideal lap {_quicker(ch['ideal'])}")
    if ch.get("race_pace") is not None:
        parts.append(f"race pace {_quicker(ch['race_pace'])}")
    if ch.get("quali") is not None:
        parts.append(f"quali {_quicker(ch['quali'])}")
    return f"{b['year']} against {a['year']}: " + ", ".join(parts) + "."


# ---------- corner by corner ----------

def _fmt_value(h: dict, v: float) -> str:
    unit = h["unit"]
    if unit == "m":
        return f"{v:.0f} m"
    if unit == "km/h":
        return f"{v:.0f} km/h"
    if unit == "%":
        return f"{v:.0f} %"
    if unit == "s":
        return f"{v:.1f} s"
    return f"{v:.0f} {unit}".strip()


def ideal_pass(sec: dict, corner_at: dict[str, float] | None = None) -> str | None:
    """The quickest passes through a section in one sentence, in the order things happen along the track, with the
    theoretical lap's value where it shows the car can do clearly more. corner_at: where each corner number sits
    (metres from the line), so the speeds at a long section's corners fall in their place."""
    hs = {h["key"]: h for h in sec.get("habits") or [] if h.get("quick") is not None}
    corner_at = corner_at or {}
    start = sec.get("start_m") or 0.0
    end = sec.get("end_m") if sec.get("end_m") is not None else start
    steps: list[tuple[float, str]] = []  # (metres, words): sorted by where it happens

    def theo(h: dict, more: float) -> str:
        t = h.get("theoretical")
        if t is None or abs(t - h["quick"]) < more:
            return ""
        return f" (the car can do {_fmt_value(h, t)})"

    if sec.get("flat"):
        if "entry_speed" in hs:
            steps.append((start, f"arrive at {_fmt_value(hs['entry_speed'], hs['entry_speed']['quick'])}"))
    else:
        brake = start
        if "brake_point" in hs:
            h = hs["brake_point"]
            brake = h["quick"]
            t = h.get("theoretical")
            later = f" (perfect driving brakes at {t:.0f} m)" if t is not None and t - h["quick"] >= 3 else ""
            steps.append((brake, f"brake at {h['quick']:.0f} m{later}"))
        if "peak_brake" in hs and hs["peak_brake"]["unit"]:
            steps.append((brake + 0.1, f"up to {_fmt_value(hs['peak_brake'], hs['peak_brake']['quick'])}"))
        release = brake + 0.2
        if "release_at" in hs:
            release = hs["release_at"]["quick"]
            at = f" at {hs['speed_at_release']['quick']:.0f} km/h" if "speed_at_release" in hs else ""
            steps.append((release, f"off the brake at {release:.0f} m{at}"))
        if "min_speed" in hs:  # the slowest point comes between letting the brake go and the throttle going down
            apex = hs["throttle_on"]["quick"] - 0.1 if "throttle_on" in hs else release + 0.1
            steps.append((apex, f"{hs['min_speed']['quick']:.0f} km/h at the slowest point"
                                f"{theo(hs['min_speed'], 1.0)}"))
        for key, h in hs.items():
            if key.startswith("corner_speed_"):
                code = key[len("corner_speed_"):]
                steps.append((corner_at.get(code, end - 0.2), f"{h['quick']:.0f} km/h at {code}"))
            elif key.startswith("after_"):
                m = re.search(r"at (\d+) m", h.get("label") or "")
                code = key[len("after_"):]
                pos = float(m.group(1)) if m else corner_at.get(code, end - 0.2) + 0.1
                steps.append((pos, f"{h['quick']:.0f} km/h after {code}"))
    if "throttle_on" in hs and not sec.get("flat"):
        steps.append((hs["throttle_on"]["quick"], f"throttle back on at {hs['throttle_on']['quick']:.0f} m"))
    if "full_throttle" in hs:
        steps.append((hs["full_throttle"]["quick"], f"full throttle at {hs['full_throttle']['quick']:.0f} m"))
    if "exit_speed" in hs:
        steps.append((end + 1, f"{hs['exit_speed']['quick']:.0f} km/h at the end of the section"
                               f"{theo(hs['exit_speed'], 1.0)}"))
    if not steps:
        return None
    text = ", ".join(words for _, words in sorted(steps, key=lambda s: s[0]))
    return text[0].upper() + text[1:] + "."


def why_text(sec: dict) -> str | None:
    """Where a typical pass loses time to the quick ones, and what that part of a corner is about."""
    where = {k: v for k, v in (sec.get("where") or {}).items() if v >= LOSS_WORTH_S}
    if not where or (sec.get("gain_s") or 0) < LOSS_WORTH_S:
        return None
    parts = sorted(where.items(), key=lambda kv: -kv[1])
    lost = " and ".join(f"{v:.2f} s {'on' if k != 'braking' else 'under'} {k if k != 'braking' else 'braking'}"
                        for k, v in parts[:2])
    out = f"A typical pass gives away {sec['gain_s']:.2f} s here: {lost}."
    main = parts[0][0]
    if main in WHY:
        out += " " + WHY[main]
    return out


def corners(events: list[dict], technique_rows: list[dict]) -> dict:
    """Section by section: the time at each event, the ideal way through it and why, and the drivers' recurring
    mistakes there. Lined up across years only when every event used the track's official corner numbers."""
    reps = [(ev, ev["report"]) for ev in events if ev.get("report") and ev["report"].get("sections")]
    if not reps:
        return {"rows": [], "comparable": False, "note": "No report could be worked out for these events.",
                "from": None, "changes": None}
    comparable = all(r.get("numbering") == "official" for _, r in reps)
    latest_ev, latest = reps[-1]
    use = reps if comparable else [(latest_ev, latest)]
    by_code: dict[str, dict] = {}
    order: list[str] = []
    for ev, rep in use:
        top = {g["code"] for g in rep.get("gains", [])[:TOP]}
        for sec in rep["sections"]:
            code = sec["code"]
            if code not in by_code:
                by_code[code] = {"code": code, "per_event": {}, "top_in": [], "source": None}
                order.append(code)
            row = by_code[code]
            t = sec.get("times") or {}
            row["per_event"][str(ev["id"])] = {"year": ev["year"], "best": t.get("best"), "typical": t.get("typical"),
                                               "theoretical": t.get("theoretical"), "gain": sec.get("gain_s"),
                                               "main_phase": sec.get("main_phase")}
            if code in top:
                row["top_in"].append(ev["year"])
            row["source"] = (ev, rep, sec)  # the latest event that has this section
    habits_at: dict[str, list[dict]] = defaultdict(list)
    for d in technique_rows:
        for h in d["habits"]:
            habits_at[h["code"]].append({"driver": d["name"], "text": h["text"]})
    rows = []
    for code in order:
        row = by_code[code]
        ev, rep, sec = row.pop("source")
        runs = {r["run"]: r for r in rep.get("runs", [])}
        corner_at = {c["code"]: c["at_m"] for c in rep.get("corners") or [] if c.get("at_m") is not None}
        best_lap = ((sec.get("times") or {}).get("best_lap") or "").split("#")[0]
        best_by = runs.get(best_lap, {})
        change = None
        per = [row["per_event"].get(str(e["id"])) for e, _ in use]
        per = [p for p in per if p]
        if comparable and len(per) >= 2 and per[-1]["typical"] is not None and per[-2]["typical"] is not None:
            change = {"typical": _r(per[-1]["typical"] - per[-2]["typical"]),
                      "best": _r((per[-1]["best"] or 0) - (per[-2]["best"] or 0)), "from": per[-2]["year"],
                      "to": per[-1]["year"]}
        rows.append({
            "code": code, "corners": sec.get("corners") or [], "flat": bool(sec.get("flat")),
            "gain_s": sec.get("gain_s"), "main_phase": sec.get("main_phase"), "year": ev["year"],
            "best": (sec.get("times") or {}).get("best"), "theoretical": (sec.get("times") or {}).get("theoretical"),
            "best_by": {"session": best_lap or None, "driver": best_by.get("driver")},
            "per_event": row["per_event"], "top_in": row["top_in"], "change": change,
            "ideal": ideal_pass(sec, corner_at), "why": why_text(sec), "advice": sec.get("advice") or [],
            "drivers": habits_at.get(code, [])[:3],
        })
    rows.sort(key=lambda r: -(r["gain_s"] or 0))
    changes = None
    if comparable and len(use) >= 2:
        moved = [r for r in rows if r["change"] and abs(r["change"]["typical"]) >= SIGNIFICANT_CHANGE_S]
        won = sorted((r for r in moved if r["change"]["typical"] < 0), key=lambda r: r["change"]["typical"])
        lost = sorted((r for r in moved if r["change"]["typical"] > 0), key=lambda r: -r["change"]["typical"])
        a, b = use[-2][0]["year"], use[-1][0]["year"]
        parts = []
        if won:
            parts.append("won time in " + ", ".join(f"{r['code']} ({_s(r['change']['typical'])})" for r in won[:3]))
        if lost:
            parts.append("lost time in " + ", ".join(f"{r['code']} ({_s(r['change']['typical'])})" for r in lost[:3]))
        changes = (f"A typical pass in {b} against {a}: " + "; ".join(parts) + ".") if parts else \
            f"No section changed by more than {SIGNIFICANT_CHANGE_S:.2f} s a pass from {a} to {b}."
    note = None
    if not comparable and len(reps) > 1:
        note = ("This track's corners carry numbers found in the speed trace (C1, C2...), not official ones, so they "
                f"can't be lined up across years: the corners below are from {latest_ev['year']}.")
    elif not comparable:
        note = "This track has no official corner numbers yet: C1, C2... are its slow corners in lap order."
    return {"rows": rows, "comparable": comparable, "note": note, "from": latest_ev["year"], "changes": changes}


# ---------- quali prep ----------

def quali(events: list[dict], perf: list[dict]) -> dict | None:
    """The quali prep that worked: the latest event's tyre prep advice, and how each event's compared."""
    with_prep = [ev for ev in events if ev.get("tyreprep") and ev["tyreprep"].get("has_tpms")]
    if not with_prep:
        return None
    quali_lap = {r["event_id"]: r["quali"] for r in perf}
    per_event = []
    for ev in with_prep:
        tp = ev["tyreprep"]
        push, ready, fastest = tp.get("push") or {}, tp.get("ready") or {}, (tp.get("fastest") or {}).get("best")
        cold = tp.get("cold") or {}
        per_event.append({
            "event_id": ev["id"], "year": ev["year"], "quali": quali_lap.get(ev["id"]),
            "push": {"front_c": push.get("front_c"), "rear_c": push.get("rear_c")} if push else None,
            "ready_min": [ready["min"], ready["max"]] if ready else None,
            "peak_from_exit": ready.get("peak_from_exit") if ready else None,
            "warm_up": {k: fastest.get(k) for k in ("label", "warm_laps", "drag_s", "straight_hard_stops", "weaves",
                                                    "ready_min", "peak_flying", "peak_time")} if fastest else None,
            "cold": {t["tyre"]: t["cold_bar"] for t in cold.get("tyres", []) if t.get("cold_bar") is not None}
            or None,
            "sims": len(tp.get("sims") or []),
        })
    latest = with_prep[-1]
    return {"from": latest["year"], "event_id": latest["id"], "advice": latest["tyreprep"].get("advice") or [],
            "per_event": per_event}


def quali_text(q: dict | None) -> str | None:
    if not q:
        return None
    plan = next((a for a in q["advice"] if a["key"] == "plan"), None)
    if plan is None:
        return None
    text = f"What worked in {q['from']}: {plan['text'][:1].lower()}{plan['text'][1:]}"
    mine = next((e["push"] for e in q["per_event"] if e["event_id"] == q["event_id"]), None)
    others = [e for e in q["per_event"] if e["event_id"] != q["event_id"] and e["push"]]
    if others:
        o = others[-1]
        if o["push"] == mine:
            text += f" {o['year']} needed the same push temperatures."
        else:
            text += (f" In {o['year']} the push temperatures were {o['push']['front_c']} °C front and "
                     f"{o['push']['rear_c']} °C rear.")
    return text


# ---------- tyre pressures ----------

def pressures(events: list[dict], perf: list[dict], tyre_model: dict | None) -> dict | None:
    """The cold pressures that landed the tyres in the middle of the fast laps' window at the latest event that
    learned them, with the air temperature they were learned in and what the pooled tyre model adds."""
    ev = next((e for e in reversed(events) if ((e.get("tyreprep") or {}).get("cold") or {}).get("tyres")), None)
    if ev is None and not tyre_model:
        return None
    out: dict = {"tyre_model": tyre_model}
    if ev is not None:
        cold = ev["tyreprep"]["cold"]
        row = next((r for r in perf if r["event_id"] == ev["id"]), None)
        out.update({"event_id": ev["id"], "year": ev["year"],
                    "tyres": [{"tyre": t["tyre"], "cold_bar": t["cold_bar"], "target_hot_bar": t["target_hot_bar"],
                               "runs": t.get("runs")} for t in cold["tyres"]],
                    "ambient_c": (row or {}).get("conditions", {}).get("ambient_c"),
                    "window": (ev["tyreprep"].get("windows") or {}).get("tyres")})
    return out


def pressures_text(p: dict | None) -> str | None:
    if not p or not p.get("tyres"):
        return None
    cold = [t for t in p["tyres"] if t["cold_bar"] is not None]
    if not cold:
        return None
    sets = ", ".join(f"{t['tyre']} {t['cold_bar']:.2f}" for t in cold)
    hot = ", ".join(f"{t['tyre']} {t['target_hot_bar']:.2f}" for t in cold)
    air = p.get("ambient_c")
    when = f" at {_span(air[0], air[1], '°C', 0)} air" if air else ""
    text = (f"Set {sets} bar cold: in {p['year']}{when} that landed the tyres in the middle of the fast laps' window "
            f"({hot} bar hot). Correct it for the weekend's temperatures in the pressure calculator.")
    lines = (p.get("tyre_model") or {}).get("lines") or []
    press = [l for l in lines if "bar" in l]
    if press:
        text += " The tyre model: " + press[0]
    return text


# ---------- setups, balance and remarks ----------

def balance_words(bal: dict | None) -> str | None:
    """'slight understeer on entry, clear oversteer on exit' (normal phases left out); 'neutral' when all are."""
    if not bal:
        return None
    parts = []
    for phase in ("entry", "mid", "exit"):
        d = describe(bal.get(phase))
        if d is None:
            continue
        if d["kind"] != "normal":
            parts.append(f"{d['strength']} {d['kind']} {BALANCE_WORDS[phase]}")
    if not parts:
        return "balanced (close to the car's normal)" if any(bal.get(p) is not None for p in BALANCE_WORDS) else None
    return ", ".join(parts)


def setup_runs(events: list[dict]) -> dict:
    """Every past run with its setup changes, how the car behaved (balance from the data) and what the drivers
    said with the data's check."""
    rows, remarks = [], []
    for ev in events:
        by_session = defaultdict(list)
        for r in ev.get("remarks") or []:
            by_session[r["session_id"]].append(r)
            remarks.append({**r, "year": ev["year"], "event_id": ev["id"]})
        drivers = {s["id"]: s["driver"] for s in ev["sessions"]}
        for r in ev.get("runs") or []:
            summary = r.get("summary") or {}
            bal = summary.get("balance")
            rows.append({
                "event_id": ev["id"], "year": ev["year"], "session_id": r["session_id"], "name": r["name"],
                "driver": drivers.get(r["session_id"]), "best": r["laps"]["best_s"], "top3": r["laps"]["top3_s"],
                "setup": r["has_setup"], "changes": [c["text"] for c in r.get("changes") or []],
                "compared_with": (r.get("compared_with") or {}).get("name"),
                "delta_best": (r.get("deltas") or {}).get("best_s"),
                "balance": balance_words(bal), "balance_values": {p: (bal or {}).get(p) for p in ("entry", "mid",
                                                                                                    "exit")},
                "tc_s_per_lap": summary.get("tc_s_per_lap"),
                "remarks": [{"text": m["text"], "verdict": m["verdict"], "data": m["data"]}
                            for m in by_session.get(r["session_id"], [])],
            })
    groups: dict[tuple, dict] = {}
    for m in remarks:
        g = groups.setdefault((m["symptom"], m["corner"]), {"label": m["label"], "runs": 0, "years": set(),
                                                            "drivers": set(), "verdicts": defaultdict(int)})
        g["runs"] += 1
        g["years"].add(m["year"])
        if m["driver"]:
            g["drivers"].add(m["driver"])
        if m["verdict"]:
            g["verdicts"][m["verdict"]] += 1
    said = []
    for g in sorted(groups.values(), key=lambda g: (-len(g["years"]), -g["runs"])):
        verdicts = ", ".join(f"{VERDICT.get(k, k)} in {n}" for k, n in g["verdicts"].items())
        said.append({"label": g["label"], "runs": g["runs"], "years": sorted(g["years"]),
                     "drivers": sorted(g["drivers"]),
                     "text": f"{g['label'][0].upper()}{g['label'][1:]}: said after {_plural(g['runs'], 'run')} "
                             f"({', '.join(sorted(g['years']))})" + (f"; the data {verdicts}" if verdicts else "")
                             + "."})
    with_sheet = sum(1 for r in rows if r["setup"])
    note = None
    if rows and not with_sheet:
        note = ("No setup sheet was saved for these runs, so the runs below show how the car behaved but not on "
                "which setup. Fill in each session's setup sheet and the next prep report can say which setup worked.")
    return {"runs": rows, "said": said, "with_sheet": with_sheet, "note": note}


VERDICT = {"agree": "agreed", "slight": "leaned the same way", "normal": "read normal", "disagree": "said the opposite",
           "unmeasured": "couldn't measure it"}


# ---------- technique per driver ----------

def technique(events: list[dict]) -> list[dict]:
    """Each driver's mistakes that repeat across the events (from the technique check of their own laps), costliest
    a lap first. Untagged laps are one group."""
    drivers: dict[str, dict] = {}
    for ev in events:
        for name, d in (ev.get("technique") or {}).items():
            row = drivers.setdefault(name, {"name": name or None, "laps": 0, "years": [], "items": {}})
            row["laps"] += d["laps"]
            row["years"].append(ev["year"])
            for h in d["habits"]:
                it = row["items"].setdefault(h["key"], {"key": h["key"], "code": h["code"], "phase": h["phase"],
                                                        "title": h["title"], "laps": 0, "cost": 0.0, "years": []})
                it["laps"] += h["laps"]
                it["cost"] += h["cost_per_lap_s"] * h["of"]
                it["years"].append(ev["year"])
    out = []
    for row in drivers.values():
        n = max(row["laps"], 1)
        items = []
        for it in row["items"].values():
            per_lap = it["cost"] / n
            if per_lap < 0.005:
                continue
            years = sorted(set(it["years"]))
            items.append({"code": it["code"], "phase": it["phase"], "title": it["title"], "laps": it["laps"], "of": n,
                          "cost_per_lap_s": round(per_lap, 3), "years": years,
                          "text": f"{it['code']}: {it['title'].lower()} on {it['laps']} of {n} laps, "
                                  f"{per_lap:.2f} s a lap" + (f" ({', '.join(years)})" if len(row['years']) > 1
                                                              else "")})
        items.sort(key=lambda x: -x["cost_per_lap_s"])
        out.append({"name": row["name"], "laps": row["laps"], "years": sorted(set(row["years"])),
                    "habits": items[:HABITS_PER_DRIVER]})
    out.sort(key=lambda d: (d["name"] is None, -d["laps"]))
    return out


# ---------- the briefing ----------

def briefing(perf: list[dict], corner: dict, q: dict | None, press: dict | None, setup: dict | None,
             tech: list[dict], runs: dict) -> list[dict]:
    """The few things to know before the weekend, most important first: each {"key", "title", "text"}."""
    out = []
    if perf:
        last = perf[-1]
        best = min(perf, key=lambda r: r["best"]["time"])
        who = ", ".join(x for x in (best["best"]["session"], best["best"]["driver"]) if x)
        target = last["realistic"] if last["realistic"] is not None else last["best"]["time"]
        target = min(target, best["best"]["time"])
        text = (f"Aim for {lap_text(target)}: the best lap here is {lap_text(best['best']['time'])} ({best['year']}, "
                f"{who})")
        if last["ideal"] is not None:
            text += f", the best sections of {last['year']} add up to {lap_text(last['ideal'])}"
        if last["theoretical"] is not None:
            text += f" and the car's theoretical lap is {lap_text(last['theoretical'])}"
        text += "."
        if last["race_pace"]:
            text += (f" Race pace in {last['year']}: {lap_text(last['race_pace']['time'])} "
                     f"({'race' if last['race_pace']['basis'] == 'race' else 'long runs'}).")
        trend = trend_text(perf)
        if trend:
            text += " " + trend
        out.append({"key": "target", "title": "Lap time to aim for", "text": text})
    rows = [r for r in corner["rows"] if (r["gain_s"] or 0) >= LOSS_WORTH_S][:TOP]
    if rows:
        names = ", ".join(f"{r['code']} ({r['gain_s']:.2f} s a lap"
                          + (f", also in {', '.join(y for y in r['top_in'] if y != r['year'])}"
                             if len([y for y in r["top_in"] if y != r["year"]]) else "") + ")" for r in rows)
        first = rows[0]
        lead = first["advice"][0] if first["advice"] else first["ideal"]
        text = f"Most time to find in {names}."
        if lead:
            text += f" In {first['code']}: {lead[0].lower() + lead[1:]}" + ("" if lead.endswith(".") else ".")
        out.append({"key": "corners", "title": "Where the time is", "text": text})
    qt = quali_text(q)
    if qt:
        out.append({"key": "quali", "title": "Quali prep", "text": qt})
    pt = pressures_text(press)
    if pt:
        out.append({"key": "pressures", "title": "Tyre pressures", "text": pt})
    st = setup_text(setup)
    if st:
        out.append({"key": "setup", "title": "Setup to start with", "text": st})
    focus = []
    for d in tech:
        if d["habits"]:
            h = d["habits"][0]
            focus.append(f"{d['name'] or 'Untagged laps'}: {h['text']}")
    if focus:
        text = "; ".join(focus) + "."
        if all(d["name"] is None for d in tech):
            text += " Tag the sessions with their driver to split this by driver."
        out.append({"key": "drivers", "title": "Driver focus", "text": text})
    said = [s for s in runs["said"] if len(s["years"]) > 1 or s["runs"] > 1][:2]
    if said:
        out.append({"key": "said", "title": "What the drivers kept saying",
                    "text": " ".join(s["text"] for s in said)})
    return out


def _first_reason(reason: str) -> str:
    """The first of a suggestion's reasons, its corners cut to three: 'oversteer on exit at T13, T6 (driver; data)'.
    The reasons are joined by '; ' outside brackets, and '(driver; data)' has one inside."""
    first = reason.split("); ", 1)[0]
    if "(" in first and not first.endswith(")"):
        first += ")"
    m = re.match(r"(.*? at )([^()]+?)( \(.*\))?$", first)
    if m:
        codes = m.group(2).split(", ")
        if len(codes) > 3:
            first = m.group(1) + ", ".join(codes[:3]) + " and others" + (m.group(3) or "")
    return first


def setup_text(setup: dict | None) -> str | None:
    if not setup:
        return None
    base, sug = setup.get("baseline"), setup.get("suggestions") or []
    parts = []
    if base:
        parts.append(f"Start from the setup of {base['session']} ({base['year']}, best {lap_text(base['best_s'])}), "
                     "the quickest run with a setup sheet.")
    else:
        parts.append("No setup sheet was saved at this track yet, so changes are steps from the car's usual setup.")
    rec = setup.get("recurring") or []
    if rec:
        parts.append("The car showed " + "; ".join(r["text"] for r in rec[:2]) + ".")
    if sug:
        s = sug[0]
        changes = ", ".join(c["text"] for c in s.get("changes") or [])
        why = f" for {_first_reason(s['reason'])}" if s.get("reason") else ""
        parts.append(f"First change to try: {s['title'].lower()}" + (f" ({changes})" if changes else "") + why + ".")
    return " ".join(parts) if (base or sug or rec) else None


def build(target: dict, car: dict, events: list[dict], tyre_model: dict | None, setup: dict | None) -> dict:
    """The whole prep report from the gathered events (oldest first)."""
    perf = performance(events)
    tech = technique(events)
    corner = corners(events, tech)
    q = quali(events, perf)
    press = pressures(events, perf, tyre_model)
    runs = setup_runs(events)
    notes = []
    for ev in events:
        for key, what in (("report_note", "report"), ("technique_note", "technique check"),
                          ("tyreprep_note", "tyre prep")):
            if ev.get(key):
                notes.append(f"{ev['name']} ({ev['year']}): its {what} is left out: {ev[key]}")
        if ev["other_cars"]:
            notes.append(f"{ev['name']} ({ev['year']}) also holds other cars' runs: its ideal, theoretical and "
                         "corner times include their laps.")
    return {
        "target": target, "car": car,
        "briefing": briefing(perf, corner, q, press, setup, tech, runs),
        "performance": perf, "trend": trend_text(perf),
        "corners": corner, "quali": q, "pressures": press, "setups": runs, "technique": tech,
        "recommendation": setup,
        "notes": notes,
        "method": METHOD,
    }


METHOD = [
    "Past events: every event at this track that started before this one, with clean laps. The same car: the car a "
    "session is linked to; a session without one counts for the car whose logger recorded it (the dash serial).",
    "Lap times: best is the quickest clean lap; ideal, realistic and theoretical laps come from each event's report; "
    "race pace is the median clean lap of the race sessions (else of the long runs); quali is the best qualifying "
    "lap (else the peak of the best quali-style run).",
    "Corners: each event's report sections, by the track's official corner numbers. The ideal pass is what the "
    "quickest tenth of the passes did, with the theoretical lap's value where the car can clearly do more.",
    "Quali prep and pressures: the tyre prep report of each event (TPMS warm-up, push temperatures, peak lap, the "
    "cold pressures that land in the fast laps' window).",
    "Setups and balance: each run's setup sheet and the balance from its log, against what the drivers said in "
    "their debriefs. The opening setup is the quickest past run with a sheet, with the setup tool's ranked changes "
    "for what both the drivers and the data kept showing.",
    "Driver technique: the technique check's mistakes that repeat on each driver's laps, costed against the "
    "realistic target.",
]
