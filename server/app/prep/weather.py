"""The weather at the venue: what it was at each past event and the forecast for the coming one, from Open-Meteo
(free, no key): the historical weather archive (archive-api.open-meteo.com/v1/archive) and the forecast
(api.open-meteo.com/v1/forecast), daily values at the track's position (its start/finish line).

Answers are kept in the database (table prep_weather): the past for good once every day has values, a forecast for
FORECAST_KEEP_S. When the service can't be reached the answer says so and the rest of the prep report stands.
"""
from __future__ import annotations

import logging
import statistics
import time
from datetime import UTC, date, datetime, timedelta

import httpx
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.prep.models import WeatherCache

log = logging.getLogger(__name__)

ARCHIVE_URL = "https://archive-api.open-meteo.com/v1/archive"
FORECAST_URL = "https://api.open-meteo.com/v1/forecast"
DAILY = ("temperature_2m_max", "temperature_2m_min", "precipitation_sum", "wind_speed_10m_max", "weather_code")
FORECAST_DAILY = (*DAILY, "precipitation_probability_max")
FORECAST_DAYS = 16  # how far ahead the forecast reaches
FORECAST_KEEP_S = 3 * 3600
TIMEOUT_S = 8.0
TOTAL_S = 20.0  # all the fetches of one answer together
WET_MM = 1.0  # a day with this much rain or more is wet
# WMO weather codes as Open-Meteo gives them, in words
CODES = ((0, "clear"), (3, "cloudy"), (48, "fog"), (57, "drizzle"), (67, "rain"), (77, "snow"), (82, "showers"),
         (86, "snow showers"), (99, "thunderstorms"))


class WeatherUnavailable(Exception):
    pass


def _get_json(url: str, params: dict) -> dict:
    """One request to the weather service (replaced in tests)."""
    r = httpx.get(url, params=params, timeout=TIMEOUT_S)
    r.raise_for_status()
    return r.json()


def sky(code: float | None) -> str | None:
    if code is None:
        return None
    return next((words for top, words in CODES if code <= top), None)


def days_from(payload: dict) -> list[dict]:
    """Open-Meteo's daily arrays as one row per day."""
    d = payload.get("daily") or {}
    out = []
    for i, day in enumerate(d.get("time") or []):
        def val(key: str, i: int = i):
            arr = d.get(key)
            v = arr[i] if arr is not None and i < len(arr) else None
            return round(float(v), 1) if v is not None else None
        out.append({"date": day, "t_max": val("temperature_2m_max"), "t_min": val("temperature_2m_min"),
                    "rain_mm": val("precipitation_sum"), "rain_chance": val("precipitation_probability_max"),
                    "wind_kmh": val("wind_speed_10m_max"), "sky": sky(val("weather_code"))})
    return out


def summary(days: list[dict]) -> dict | None:
    """A few numbers over the days: the warmest and coolest, rain and wind."""
    known = [d for d in days if d["t_max"] is not None]
    if not known:
        return None
    rain = [d["rain_mm"] for d in known if d["rain_mm"] is not None]
    chance = [d["rain_chance"] for d in known if d["rain_chance"] is not None]
    wet = [d for d in known if (d["rain_mm"] or 0) >= WET_MM]
    out = {"t_max": max(d["t_max"] for d in known), "t_min": min(d["t_min"] for d in known if d["t_min"] is not None)
           if any(d["t_min"] is not None for d in known) else None,
           "t_max_mean": round(statistics.mean(d["t_max"] for d in known), 1),
           "rain_mm": round(sum(rain), 1) if rain else None, "wet_days": len(wet), "days": len(known),
           "rain_chance": max(chance) if chance else None,
           "wind_kmh": max((d["wind_kmh"] for d in known if d["wind_kmh"] is not None), default=None)}
    out["text"] = words(out)
    return out


def words(s: dict) -> str:
    text = f"{s['t_max']:.0f} °C at the warmest"
    if s["t_min"] is not None:
        text += f", {s['t_min']:.0f} °C at night"
    if s["wet_days"]:
        text += f", wet on {s['wet_days']} of {s['days']} days ({s['rain_mm']:.0f} mm)"
    elif s["rain_chance"] is not None and s["rain_chance"] >= 30:
        text += f", dry so far but up to {s['rain_chance']:.0f} % chance of rain"
    else:
        text += ", dry"
    if s["wind_kmh"] is not None and s["wind_kmh"] >= 30:
        text += f", wind up to {s['wind_kmh']:.0f} km/h"
    return text


def _cached(db: Session, key: str, keep_s: float | None) -> dict | None:
    row = db.scalar(select(WeatherCache).where(WeatherCache.key == key))
    if row is None or row.data is None:
        return None
    if keep_s is not None:
        fetched = row.fetched_at if row.fetched_at.tzinfo else row.fetched_at.replace(tzinfo=UTC)
        if (datetime.now(UTC) - fetched).total_seconds() > keep_s:
            return None
    return row.data


def _keep(db: Session, key: str, data: dict) -> None:
    row = db.scalar(select(WeatherCache).where(WeatherCache.key == key))
    if row is None:
        row = WeatherCache(key=key)
        db.add(row)
    row.data, row.fetched_at = data, datetime.now(UTC)
    try:
        db.commit()
    except IntegrityError:  # another request kept it a moment ago
        db.rollback()


def _fetch(db: Session, kind: str, lat: float, lon: float, start: date, end: date, deadline: float) -> list[dict]:
    key = f"{kind}|{lat:.2f}|{lon:.2f}|{start.isoformat()}|{end.isoformat()}"
    hit = _cached(db, key, FORECAST_KEEP_S if kind == "forecast" else None)
    if hit is not None:
        return hit["days"]
    if time.monotonic() > deadline:
        raise WeatherUnavailable("The weather service is slow to answer; try again in a moment.")
    params = {"latitude": round(lat, 4), "longitude": round(lon, 4), "start_date": start.isoformat(),
              "end_date": end.isoformat(), "timezone": "auto",
              "daily": ",".join(FORECAST_DAILY if kind == "forecast" else DAILY)}
    try:
        payload = _get_json(FORECAST_URL if kind == "forecast" else ARCHIVE_URL, params)
    except (httpx.HTTPError, ValueError) as e:
        log.warning("Weather %s for %s failed: %s", kind, key, e)
        raise WeatherUnavailable("The weather service couldn't be reached.") from e
    days = days_from(payload)
    complete = days and all(d["t_max"] is not None for d in days)
    if kind == "forecast" or complete:  # the archive fills in a few days late: keep it only once it has every day
        _keep(db, key, {"days": days})
    return days


def _dates(start: str | None, end: str | None) -> tuple[date, date] | None:
    if not start:
        return None
    a = date.fromisoformat(start)
    b = date.fromisoformat(end) if end else a
    return (a, b) if b >= a else (a, a)


def venue_weather(db: Session, place: dict | None, past: list[dict], target: dict, today: date | None = None) -> dict:
    """The weather at each past event (past: [{"id", "start", "end", "year"}]) and the forecast for the target
    event ({"start", "end"}). place: {"lat", "lon"} of the track, or None."""
    today = today or date.today()
    out: dict = {"place": place, "past": [], "forecast": None, "note": None, "compare": None}
    if not place:
        out["note"] = "This track has no GPS position yet (its logs teach it the start/finish line), so no weather."
        return out
    deadline = time.monotonic() + TOTAL_S
    lat, lon = place["lat"], place["lon"]
    problems = []
    for ev in past:
        span = _dates(ev.get("start"), ev.get("end"))
        if span is None:
            continue
        try:
            days = _fetch(db, "archive", lat, lon, span[0], min(span[1], today), deadline)
            out["past"].append({"event_id": ev["id"], "year": ev.get("year"), "days": days, "summary": summary(days)})
        except WeatherUnavailable as e:
            problems.append(str(e))
    span = _dates(target.get("start"), target.get("end"))
    if span is None:
        out["note"] = "Give the event its dates to see the forecast for the weekend."
    elif span[1] < today:
        try:  # the event is over: the weather it had
            days = _fetch(db, "archive", lat, lon, span[0], span[1], deadline)
            out["forecast"] = {"kind": "actual", "days": days, "summary": summary(days)}
        except WeatherUnavailable as e:
            problems.append(str(e))
    elif span[0] > today + timedelta(days=FORECAST_DAYS - 1):
        out["note"] = (f"The forecast reaches {FORECAST_DAYS} days ahead: it appears here from "
                       f"{(span[0] - timedelta(days=FORECAST_DAYS - 1)).isoformat()}.")
    else:
        a, b = max(span[0], today), min(span[1], today + timedelta(days=FORECAST_DAYS - 1))
        try:
            days = _fetch(db, "forecast", lat, lon, a, b, deadline)
            out["forecast"] = {"kind": "forecast", "days": days, "summary": summary(days)}
        except WeatherUnavailable as e:
            problems.append(str(e))
    if problems:
        out["note"] = " ".join(x for x in (out["note"], problems[0]) if x)
    out["compare"] = compare(out)
    return out


def compare(w: dict) -> str | None:
    """The coming weekend against the past events, in words: warmer or cooler, and what that means for the tyres."""
    f = (w.get("forecast") or {}).get("summary")
    past = [p for p in w["past"] if p["summary"]]
    if not f or not past:
        return None
    last = past[-1]
    diff = f["t_max_mean"] - last["summary"]["t_max_mean"]
    when = "forecast" if w["forecast"]["kind"] == "forecast" else "the weekend"
    if abs(diff) < 3:
        text = f"The {when} is close to {last['year']} ({last['summary']['t_max_mean']:.0f} °C by day)"
    else:
        warmer = diff > 0
        text = (f"The {when} is about {abs(diff):.0f} °C {'warmer' if warmer else 'cooler'} than {last['year']} "
                f"({f['t_max_mean']:.0f} against {last['summary']['t_max_mean']:.0f} °C by day): the tyres will run "
                f"{'hotter' if warmer else 'cooler'}, so set the cold pressures {'lower' if warmer else 'higher'} "
                f"than last time and expect the warm-up to {'come sooner' if warmer else 'take longer'}")
    if f["wet_days"] or (f.get("rain_chance") or 0) >= 50:
        text += ". Rain is likely: no dry-weather learning applies to a wet session"
    return text + "."
