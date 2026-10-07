"""What the official results say about us: per session (position, gaps, our best lap against the fastest and the
class best, where our logged best would have placed), per event, and across years and circuits for the prep report.

"Us" is a car number in one season. Numbers change hands between seasons (and a driver changes team), so earlier
seasons find us by our driver (``our_driver``: the one of the car's crew who drove our own logged runs, else who raced
the most seasons); without one, by the team that ran that number.
"""
from __future__ import annotations

import re
import statistics
from collections import Counter, defaultdict

from sqlalchemy import func, select
from sqlalchemy.orm import Session, selectinload

from app.results import models as rm
from app.results import predict
from app.results.venues import plain

MATCH_S = 0.10  # a logged best lap within this of an official best lap is the same lap
MIN_MATCHES = 2  # sessions whose best lap must match before a car is taken as ours


def _num(n: str | None) -> str | None:
    return n.strip().lstrip("#").lstrip("0") or "0" if n else None


def _best(rows: list[rm.ResultRow]) -> rm.ResultRow | None:
    timed = [r for r in rows if r.best_lap_s]
    return min(timed, key=lambda r: r.best_lap_s) if timed else None


def _pct(a: float | None, b: float | None) -> float | None:
    return round((a - b) / b * 100, 3) if a and b else None


def row_dict(r: rm.ResultRow) -> dict:
    return {"position": r.position, "status": r.status, "car_number": r.car_number, "drivers": r.drivers,
            "team": r.team, "car_class": r.car_class, "car_model": r.car_model, "brand": r.brand, "laps": r.laps,
            "best_lap_s": r.best_lap_s, "total_time_s": r.total_time_s, "gap_s": r.gap_s, "gap_laps": r.gap_laps,
            "diff_s": r.diff_s}


def session_dict(s: rm.ResultSession, rows: bool = False) -> dict:
    out = {"id": s.id, "code": s.code, "title": s.title, "kind": s.kind, "starts_at": s.starts_at,
           "weather": s.weather or {}, "fastest": s.fastest, "source_url": s.source_url,
           "cars": len(s.rows), "fetched_at": s.fetched_at.isoformat() if s.fetched_at else None}
    if rows:
        out["rows"] = [row_dict(r) for r in s.rows]
    return out


def find_car(s: rm.ResultSession, car_number: str | None) -> rm.ResultRow | None:
    n = _num(car_number)
    return next((r for r in s.rows if _num(r.car_number) == n), None) if n else None


def ahead_gap(s: rm.ResultSession, car: rm.ResultRow) -> float | None:
    """Gap to the car one place ahead: the sheet's own for a qualifying, from total times in a race."""
    if car.position is None or car.position == 1:
        return None
    if s.kind == "qualifying":
        return car.diff_s
    ahead = next((r for r in s.rows if r.position == car.position - 1), None)
    if ahead and ahead.total_time_s and car.total_time_s and ahead.laps == car.laps:
        return round(car.total_time_s - ahead.total_time_s, 3)
    return None


def car_summary(s: rm.ResultSession, car: rm.ResultRow | None, logged_best_s: float | None = None) -> dict:
    """Our result in one official session."""
    fastest = _best(s.rows)
    out: dict = {**session_dict(s), "fastest_s": fastest.best_lap_s if fastest else None,
                 "fastest_car": f"#{fastest.car_number} {fastest.brand or ''}".strip() if fastest else None}
    if logged_best_s:
        better = sum(1 for r in s.rows if r.best_lap_s and r.best_lap_s < logged_best_s)
        out["logged_best_s"] = logged_best_s
        out["logged_rank"] = better + 1  # where our logged best lap would sit among the session's best laps
    if car is None:
        out["us"] = None
        return out
    same_class = [r for r in s.rows if r.car_class == car.car_class]
    class_best = _best(same_class)
    brand_best = _best([r for r in s.rows if r.brand == car.brand and r is not car])
    class_pos = (sorted(r.position for r in same_class if r.position is not None).index(car.position) + 1
                 if car.position is not None else None)
    rank = (1 + sum(1 for r in s.rows if r.best_lap_s and car.best_lap_s and r.best_lap_s < car.best_lap_s)
            if car.best_lap_s else None)
    out["us"] = {
        **row_dict(car), "class_position": class_pos, "class_cars": len(same_class),
        "gap_to_leader_s": car.gap_s if car.position != 1 else 0.0, "gap_to_leader_laps": car.gap_laps,
        "gap_to_ahead_s": ahead_gap(s, car),
        "best_lap_rank": rank,
        "to_fastest_s": round(car.best_lap_s - fastest.best_lap_s, 3) if car.best_lap_s and fastest else None,
        "to_fastest_pct": _pct(car.best_lap_s, fastest.best_lap_s if fastest else None),
        "class_best_s": class_best.best_lap_s if class_best else None,
        "to_class_best_s": round(car.best_lap_s - class_best.best_lap_s, 3)
        if car.best_lap_s and class_best else None,
        "brand_best_s": brand_best.best_lap_s if brand_best else None,
        "brand_best_car": f"#{brand_best.car_number}" if brand_best else None,
    }
    return out


def brand_table(s: rm.ResultSession) -> list[dict]:
    """Each make's best lap and best position in one session, quickest make first."""
    fastest = _best(s.rows)
    by: dict[str, list[rm.ResultRow]] = defaultdict(list)
    for r in s.rows:
        by[r.brand or "?"].append(r)
    out = []
    for brand, rows in by.items():
        b = _best(rows)
        laps = sorted(r.best_lap_s for r in rows if r.best_lap_s)
        placed = [r.position for r in rows if r.position is not None]
        out.append({"brand": brand, "cars": len(rows), "best_s": b.best_lap_s if b else None,
                    "best_car": f"#{b.car_number}" if b else None,
                    "to_fastest_pct": _pct(b.best_lap_s if b else None, fastest.best_lap_s if fastest else None),
                    "median_s": round(statistics.median(laps), 3) if laps else None,
                    "best_position": min(placed) if placed else None})
    return sorted(out, key=lambda x: (x["best_s"] is None, x["best_s"] or 0))


# --- matching our logged sessions to the official ones -----------------------------------------------------------

def infer_car(rnd: rm.ResultRound, logged_bests: list[float]) -> tuple[str | None, int]:
    """The car whose official best laps match our logged best laps most often: (number, matches)."""
    score: dict[str, tuple[int, float]] = {}
    for s in rnd.sessions:
        for r in s.rows:
            if not r.best_lap_s:
                continue
            d = min((abs(r.best_lap_s - b) for b in logged_bests), default=99)
            if d <= MATCH_S:
                n, tot = score.get(r.car_number, (0, 0.0))
                score[r.car_number] = (n + 1, tot + d)
    if not score:
        return None, 0
    number, (n, _) = min(score.items(), key=lambda kv: (-kv[1][0], kv[1][1]))
    return number, n


def is_classification(code: str) -> bool:
    """A qualifying or race result (Q1, R2): what the history, the circuits and the predictions read. Practice
    (FP1, PQ) and official test sessions (T1) are shown with the round only."""
    return code[:1] in ("Q", "R") and code[1:].isdigit()


def _hint(text: str | None) -> tuple[str | None, str | None]:
    """'Q', 'Qualifying 2', 'R1', 'Race', 'FP2', 'Practice', 'Test 1' -> (kind, code or None)."""
    t = plain(text or "")
    m = re.search(r"\b(fp|free practice|practice|test\w*|q|quali\w*|r|race)\s*(\d)?\b", t)
    if not m:
        return None, None
    word = m.group(1)
    kind, prefix = (("practice", "FP") if word in ("fp", "free practice", "practice") else
                    ("test", "T") if word.startswith("test") else
                    ("qualifying", "Q") if word.startswith("q") else ("race", "R"))
    return kind, (prefix + m.group(2)) if m.group(2) else None


def match_session(rnd: rm.ResultRound, car_number: str | None, names: list[str | None], kind: str | None,
                  logged_best_s: float | None) -> rm.ResultSession | None:
    """The official session one of our logged sessions was: by its names (ours, then the log's: Q, R1...) and
    kind, then by our car's official best lap nearest the logged best."""
    hk, code = next((h for h in map(_hint, names) if h[0]), (None, None))
    if code:
        exact = next((s for s in rnd.sessions if s.code == code), None)
        if exact:
            return exact
    want = hk or (kind if kind in ("qualifying", "race", "practice", "test") else None)
    cands = [s for s in rnd.sessions if want is None or s.kind == want]
    if not cands:
        return None
    if len(cands) == 1 and want:
        return cands[0]
    if logged_best_s:
        def diff(s: rm.ResultSession) -> float:
            car = find_car(s, car_number)
            if car is not None and car.best_lap_s:
                return abs(car.best_lap_s - logged_best_s)
            return min((abs(r.best_lap_s - logged_best_s) for r in s.rows if r.best_lap_s), default=99) + 1
        best = min(cands, key=diff)
        return best if diff(best) <= (1.0 if want else MATCH_S) else None
    return None


# --- across years and circuits (the prep report) -----------------------------------------------------------------

def _rounds(db: Session, series: str) -> list[rm.ResultRound]:
    q = (select(rm.ResultRound).where(rm.ResultRound.series == series)
         .options(selectinload(rm.ResultRound.sessions).selectinload(rm.ResultSession.rows)))
    return list(db.scalars(q).all())


def team_of(rounds: list[rm.ResultRound], car_number: str, year: int | None) -> tuple[str | None, int | None]:
    """The team that ran this number: in that year, else in the latest year it appears."""
    seen: dict[int, str] = {}
    for rnd in rounds:
        for s in rnd.sessions:
            car = find_car(s, car_number)
            if car and car.team:
                seen.setdefault(rnd.year, car.team)
    if not seen:
        return None, None
    y = year if year in seen else max(seen)
    return seen[y], y


def our_row(s: rm.ResultSession, team: str | None, car_number: str | None, same_number: bool) -> rm.ResultRow | None:
    if same_number:
        car = find_car(s, car_number)
        if car is not None and (team is None or car.team == team):
            return car
    if team is None:
        return None
    mine = [r for r in s.rows if r.team == team]
    placed = [r for r in mine if r.position is not None]
    return min(placed, key=lambda r: r.position) if placed else (mine[0] if mine else None)


def our_driver(db: Session, series: str, car_number: str | None, year: int | None) -> str | None:
    """The driver who follows our car across seasons, as a surname ('piana'): of the drivers of this car number in
    ``year`` (its results, else its entry list), the one who drove the most of our own runs (the garage's drivers),
    else the one who raced the most seasons of the series. None when the number is unknown that year."""
    from app import models  # the app's runs and drivers

    n = _num(car_number)
    if not n or year is None:
        return None
    rounds = _rounds(db, series)
    crew: Counter[str] = Counter()
    for rnd in rounds:
        if rnd.year == year:
            for sess in rnd.sessions:
                for r in sess.rows:
                    if _num(r.car_number) == n:
                        crew.update(predict._surname(d) for d in r.drivers or [])
    if not crew:
        entries = db.scalars(select(rm.ResultEntry).join(rm.ResultCalendarRound)
                             .where(rm.ResultCalendarRound.series == series, rm.ResultCalendarRound.year == year)).all()
        for e in entries:
            if _num(e.car_number) == n:
                crew.update(predict._surname(d) for d in e.drivers or [])
    crew.pop("", None)
    if not crew:
        return None
    seasons: dict[str, set[int]] = defaultdict(set)
    for rnd in rounds:
        for sess in rnd.sessions:
            for r in sess.rows:
                for d in r.drivers or []:
                    if (sn := predict._surname(d)) in crew:
                        seasons[sn].add(rnd.year)
    runs = Counter({predict._surname(name): k for name, k in db.execute(
        select(models.Driver.name, func.count(models.RunSession.id))
        .join(models.RunSession, models.RunSession.driver_id == models.Driver.id).group_by(models.Driver.name))})
    return max(crew, key=lambda sn: (runs.get(sn, 0), len(seasons[sn]), crew[sn]))


def _driver_row(s: rm.ResultSession, driver: str) -> rm.ResultRow | None:
    mine = [r for r in s.rows if driver in {predict._surname(d) for d in r.drivers or []}]
    return mine[0] if mine else None


def _dry(s: rm.ResultSession) -> bool:
    """Dry at the start: the best laps of a session that turns wet later were set before it did."""
    return "wet" not in ((s.weather or {}).get("conditions_start") or "").lower()


def history(db: Session, venue: str | None = None, series: str = "gt4-europe", car_number: str | None = None,
            year: int | None = None, team: str | None = None, driver: str | None = None) -> dict:
    """Past results at a circuit by year, our strong and weak circuits across all years, and makes compared.

    venue: a venues.venue_key ("zandvoort"); car_number + year find our team; team overrides it. Other seasons find
    our car by our driver (a surname; found from the car number when not given), else by the team.
    """
    rounds = _rounds(db, series)
    if driver is None and car_number and year is not None:
        driver = our_driver(db, series, car_number, year)
    found_year = None
    if team is None and car_number:
        team, found_year = team_of(rounds, car_number, year)
    out: dict = {"series": series, "venue": venue, "team": team, "car_number": car_number, "driver": driver,
                 "team_from_year": found_year, "years": [], "circuits": [], "brands": []}
    if not rounds:
        out["note"] = "No official results loaded yet"
        return out
    # every round: our quali gap to pole (dry only) and finishing places
    per: list[dict] = []
    for rnd in sorted(rounds, key=lambda r: (r.year, r.order)):
        same = found_year is None or rnd.year == found_year
        sessions = []
        for s in sorted((x for x in rnd.sessions if is_classification(x.code)), key=lambda x: x.code):
            if driver and (year is None or rnd.year != year):  # another season: wherever our driver raced
                car = _driver_row(s, driver)
            else:
                car = our_row(s, team, car_number, same_number=True) if team or car_number else None
                if car is None and not same:
                    car = our_row(s, team, None, same_number=False)
            fastest = _best(s.rows)
            sessions.append({"code": s.code, "title": s.title, "starts_at": s.starts_at, "dry": _dry(s),
                             "weather": s.weather or {}, "cars": len(s.rows),
                             "fastest_s": fastest.best_lap_s if fastest else None,
                             "us": car_summary(s, car)["us"] if car else None,
                             "brands": brand_table(s)})
        per.append({"year": rnd.year, "round": rnd.order, "name": rnd.name, "venue": rnd.venue,
                    "sessions": sessions})
    for p in per:
        if venue and p["venue"] == venue:
            out["years"].append(p)
    out["years"].sort(key=lambda p: p["year"], reverse=True)
    out["brands"] = [{"year": p["year"], "code": s["code"], "dry": s["dry"], "brands": s["brands"]}
                     for p in out["years"] for s in p["sessions"]]
    for p in out["years"]:
        for s in p["sessions"]:
            s.pop("brands")
    out["circuits"] = circuit_trend(per)
    return out


def circuit_trend(per: list[dict]) -> list[dict]:
    """Each circuit's quali gap to pole against our average that season (negative: quicker than our norm there,
    a strong circuit), and the average race finish, over every year raced there."""
    season_gap: dict[int, list[float]] = defaultdict(list)
    for p in per:
        for s in p["sessions"]:
            if s["code"].startswith("Q") and s["dry"] and s["us"] and s["us"]["to_fastest_pct"] is not None:
                season_gap[p["year"]].append(s["us"]["to_fastest_pct"])
    norm = {y: statistics.median(v) for y, v in season_gap.items() if v}
    by: dict[str, dict] = {}
    for p in per:
        if not p["sessions"]:
            continue  # a round still to come
        c = by.setdefault(p["venue"] or p["name"], {"venue": p["venue"], "name": p["name"], "years": {},
                                                    "offsets": [], "finishes": [], "quali": []})
        y = c["years"].setdefault(p["year"], {"quali_pos": [], "race_pos": [], "gap_pct": []})
        for s in p["sessions"]:
            us = s["us"]
            if not us:
                continue
            if s["code"].startswith("Q"):
                if us["position"]:
                    y["quali_pos"].append(us["position"])
                    c["quali"].append(us["position"])
                if s["dry"] and us["to_fastest_pct"] is not None:
                    y["gap_pct"].append(us["to_fastest_pct"])
                    if p["year"] in norm:
                        c["offsets"].append(us["to_fastest_pct"] - norm[p["year"]])
            elif us["position"]:
                y["race_pos"].append(us["position"])
                c["finishes"].append(us["position"])
    out = []
    for c in by.values():
        off = statistics.mean(c["offsets"]) if c["offsets"] else None
        verdict = None if off is None else "strong" if off <= -0.1 else "weak" if off >= 0.1 else "average"
        out.append({"venue": c["venue"], "name": c["name"], "visits": len(c["years"]),
                    "quali_offset_pct": round(off, 3) if off is not None else None, "verdict": verdict,
                    "avg_quali_pos": round(statistics.mean(c["quali"]), 1) if c["quali"] else None,
                    "avg_race_pos": round(statistics.mean(c["finishes"]), 1) if c["finishes"] else None,
                    "by_year": {str(y): {"best_quali": min(v["quali_pos"]) if v["quali_pos"] else None,
                                         "best_race": min(v["race_pos"]) if v["race_pos"] else None,
                                         "gap_pct": round(statistics.mean(v["gap_pct"]), 3) if v["gap_pct"]
                                         else None} for y, v in sorted(c["years"].items())}})
    return sorted(out, key=lambda c: (c["quali_offset_pct"] is None, c["quali_offset_pct"] or 0))


def model_sessions(db: Session, series: str = "gt4-europe") -> list[dict]:
    """Every loaded classification in the shape the predictions read (results/predict.py)."""
    out = []
    for rnd in _rounds(db, series):
        for s in rnd.sessions:
            if not is_classification(s.code):
                continue
            out.append({"year": rnd.year, "round_id": rnd.round_id, "round_name": rnd.name, "venue": rnd.venue,
                        "order": rnd.order, "code": s.code, "title": s.title, "kind": s.kind,
                        "number": int(s.code[1:]) if s.code[1:].isdigit() else None, "date": s.starts_at,
                        "track": s.track, "length_m": s.length_m, "weather": s.weather or {},
                        "fastest": s.fastest, "rows": [row_dict(r) for r in s.rows]})
    return predict.mark_wet(out)
