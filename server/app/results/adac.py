"""ADAC GT4 Germany results, calendars and entry lists from its official site, adac-motorsport.de.

The site is built ahead of time from a content store: every page has its data as JSON at
/page-data/<page path>/page-data.json, which is what is read here (the pages themselves fill their links in with
JavaScript). A season's calendar page lists its events; an event's page holds each session's classification as a
small semicolon table, the link to the session's "ResultList" PDF and the published entry list. Only qualifying and
race classifications are kept (Qualifying 1 and 2 set the grids of Race 1 and 2), read from the tables; the PDF is
read too, for the weather, when the sync can reach it.

The site sends an incomplete certificate chain, so connections add the missing intermediate (see tls.py).
"""
from __future__ import annotations

import hashlib
import re
import threading
import time
import unicodedata
from dataclasses import dataclass, field
from datetime import date

import httpx

from app.results import tls
from app.results.gt4europe import CalendarRound, Entry
from app.results.resultlist import ResultList, Row, brand_of, seconds

SERIES = "adac-gt4-germany"
NAME = "ADAC GT4 Germany"
FIRST_YEAR = 2023  # the seasons the app keeps
BASE = "https://www.adac-motorsport.de"
CHANNEL = "adac-gt4-germany"
CERTS = ("gsgccr46ovtlsca2025.pem",)
_HEADERS = {"User-Agent": "TheEngineer/1.0 (results sync)"}
_CACHE_S = 300  # a season's event list is read once per sync, not once per round
_STATUS = {"NC": "nc", "DQ": "dsq", "DSQ": "dsq", "DNS": "dns", "DNF": "dnf", "EX": "dsq"}


@dataclass
class SessionLink:
    code: str  # Q1, Q2, R1, R2
    title: str  # as the site labels it ("1. Zeittraining")
    url: str  # the result PDF, with a fingerprint of the table so a corrected table counts as new
    result: ResultList | None = None  # already read from the event page
    pdf_url: str | None = None


@dataclass
class _Event:
    round_id: str  # its first day, "2025-10-03": the site has one event of the series a weekend
    slug: str
    name: str
    start: date
    end: date | None
    sessions: int = 0
    raw: dict = field(default_factory=dict)


def client() -> httpx.Client:
    return tls.client(CERTS)


def _page(client: httpx.Client, path: str) -> dict:
    r = client.get(f"{BASE}/page-data/{CHANNEL}/{path.strip('/')}/page-data.json", headers=_HEADERS, timeout=60,
                   follow_redirects=True)
    r.raise_for_status()
    return r.json()["result"]


def slugify(text: str) -> str:
    """'Hockenheimring Baden-Württemberg' -> 'hockenheimring-baden-wurttemberg', as the site makes its addresses."""
    t = unicodedata.normalize("NFKD", text)
    return re.sub(r"[^a-z0-9]+", "-", "".join(c for c in t if not unicodedata.combining(c)).lower()).strip("-")


def seasons(client: httpx.Client) -> dict[int, str]:
    """Year -> the season's id, which here is the year itself."""
    years = _page(client, "race-calendar").get("pageContext", {}).get("years") or []
    return {int(y): str(y) for y in years}


_events_cache: dict[str, tuple[float, list[_Event]]] = {}
_events_lock = threading.Lock()


def parse_calendar(page: dict) -> list[_Event]:
    """The season's events in date order, one per weekend (the site lists a weekend twice now and then)."""
    groups = (page.get("data", {}).get("allContentfulEvent") or {}).get("group") or []
    out: dict[str, _Event] = {}
    for g in groups:
        for n in g.get("nodes") or []:
            start = (n.get("startDate") or "")[:10]
            if not start or not n.get("name"):
                continue
            d = date.fromisoformat(start)
            name = re.sub(r"\s+", " ", n["name"]).strip()
            end = date.fromisoformat(n["endDate"][:10]) if n.get("endDate") else None
            ev = _Event(start, f"{d.year}-{d.month}-{d.day}-{slugify(name)}", name, d, end,
                        len(n.get("sessions") or []))
            have = out.get(start)
            if have is None or ev.sessions > have.sessions:
                out[start] = ev
    return sorted(out.values(), key=lambda e: e.start)


def events(client: httpx.Client, season_id: str) -> list[_Event]:
    with _events_lock:
        hit = _events_cache.get(season_id)
        if hit and time.monotonic() - hit[0] < _CACHE_S:
            return hit[1]
    evs = parse_calendar(_page(client, f"race-calendar/{season_id}"))
    with _events_lock:
        _events_cache[season_id] = (time.monotonic(), evs)
    return evs


def rounds(client: httpx.Client, season_id: str) -> list[tuple[str, str]]:
    """The season's events that have results on the site, as (round id, name), in date order."""
    return [(e.round_id, e.name) for e in events(client, season_id) if e.sessions]


def _event_page(client: httpx.Client, season_id: str, round_id: str) -> dict:
    ev = next((e for e in events(client, season_id) if e.round_id == round_id), None)
    if ev is None:
        raise ValueError(f"{NAME} {season_id} has no event on {round_id}")
    return _page(client, f"race-calendar/{season_id}/race-details/{ev.slug}")


def session_code(title: str) -> str | None:
    """'1. Qualifying' / '2. Zeittraining' -> 'Q1' / 'Q2', '1. Rennen' / 'Rennen 2' -> 'R1' / 'R2'; practice is
    not read."""
    t = title.lower()
    kind = "Q" if ("qualifying" in t or "zeittraining" in t) else "R" if ("rennen" in t or "race" in t) else None
    m = re.search(r"\d+", t)
    return kind + (m.group(0) if m else "1") if kind else None


def _local(when: str | None) -> str | None:
    """'2025-04-26T09:55+02:00' -> '2025-04-26T09:55:00' (local time, as the result sheets print it)."""
    m = re.match(r"(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(:\d{2})?", when or "")
    return f"{m.group(1)}T{m.group(2)}{m.group(3) or ':00'}" if m else None


def _table(text: str) -> list[list[str]]:
    """The rows under the table's last heading line (a table now and then starts with a broken copy of itself)."""
    heads = list(re.finditer(r"(?:Rank|Pos\.?);#;", text))
    body = text[heads[-1].start():] if heads else text
    return [line.split(";") for line in body.splitlines()[1:] if line.strip()]


def parse_table(text: str, code: str, when: str | None = None) -> ResultList:
    """One session's classification from the site's table. A qualifying row is position; number; driver 1;
    driver 2; team; car; best lap; gap. A race row has total time; gap; laps; best lap after the car."""
    race = code.startswith("R")
    out = ResultList(title=("Race " if race else "Qualifying ") + code[1:], kind="race" if race else "qualifying",
                     number=int(code[1:]), date=_local(when))
    for c in _table(text):
        if len(c) < 6 or not c[1].strip():
            continue
        rank = c[0].strip().upper()
        status = "classified" if rank.isdigit() else _STATUS.get(rank, "nc" if rank else "dnf")
        model = c[5].strip() or None
        row = Row(position=int(rank) if rank.isdigit() else None, status=status, car_number=c[1].strip().lstrip("#"),
                  drivers=[d.strip() for d in c[2:4] if d.strip()], team=c[4].strip() or None, car_model=model,
                  brand=brand_of(model))
        if race and len(c) >= 10:
            row.total_time_s, row.best_lap_s = seconds(c[6].strip()), seconds(c[9].strip())
            row.laps = int(c[8]) if c[8].strip().isdigit() else None
            gap = c[7].strip()
            row.gap_s = seconds(gap) if gap and not gap.startswith("-") else None
        elif not race and len(c) >= 7:
            row.best_lap_s = seconds(c[6].strip())
            row.gap_s = seconds(c[7].strip()) if len(c) > 7 and c[7].strip() else None
        out.rows.append(row)
    if race:
        lead = next((r.laps for r in out.rows if r.position == 1 and r.laps), None)
        for r in out.rows:
            if lead and r.laps is not None and r.laps < lead and r.status == "classified":
                r.gap_laps, r.gap_s = lead - r.laps, None  # the table's gap is not to the leader once lapped
    prev = None
    for r in out.rows:
        if r.position is not None and r.best_lap_s is not None and not race:
            r.diff_s = round(r.best_lap_s - prev, 3) if prev is not None else None
            prev = r.best_lap_s
    timed = [r for r in out.rows if r.best_lap_s and r.status not in ("dns", "dsq")]
    if timed:
        best = min(timed, key=lambda r: r.best_lap_s)
        out.fastest = f"#{best.car_number} {'/'.join(best.drivers)} {_lap(best.best_lap_s)}"
    return out


def _lap(s: float) -> str:
    m, sec = divmod(s, 60)
    return f"{int(m)}:{sec:06.3f}"


def parse_sessions(page: dict) -> list[SessionLink]:
    ev = page.get("data", {}).get("contentfulEvent") or {}
    out: dict[str, SessionLink] = {}
    for s in ev.get("sessions") or []:
        title = (s.get("name") or "").strip()
        code = session_code(title)
        text = (s.get("csvData") or {}).get("csvData") or ""
        if not code or not text.strip() or code in out:
            continue
        result = parse_table(text, code, s.get("date"))
        if not result.rows:
            continue
        pdf = next((f.get("secure_url") or f.get("url") for f in s.get("downloadFile") or []
                    if (f.get("format") or "").lower() == "pdf"), None)
        mark = hashlib.sha1(text.encode()).hexdigest()[:10]
        url = f"{pdf or BASE + '/' + CHANNEL + '/race-calendar/'}#t{mark}"
        out[code] = SessionLink(code, title, url, result, pdf)
    return sorted(out.values(), key=lambda x: x.code)


def round_sessions(client: httpx.Client, season_id: str, round_id: str) -> list[SessionLink]:
    return parse_sessions(_event_page(client, season_id, round_id))


def fetch(client: httpx.Client, url: str) -> bytes:
    r = client.get(url.split("#", 1)[0], headers=_HEADERS, timeout=60, follow_redirects=True)
    r.raise_for_status()
    return r.content


# --- the season's calendar and entry lists ------------------------------------------------------------------------

def calendar(client: httpx.Client, season_id: str) -> list[CalendarRound]:
    return [CalendarRound(e.round_id, e.name, i + 1, e.start, e.end)
            for i, e in enumerate(events(client, season_id))]


def entry_list_urls(client: httpx.Client, season_id: str) -> list[str]:
    """Every event's page: an event's entry list sits on its page once published."""
    return [f"{BASE}/page-data/{CHANNEL}/race-calendar/{season_id}/race-details/{e.slug}/page-data.json"
            for e in events(client, season_id)]


def entry_list(client: httpx.Client, url: str) -> tuple[str | None, list[Entry]]:
    r = client.get(url, headers=_HEADERS, timeout=60, follow_redirects=True)
    r.raise_for_status()
    return parse_entry_list(r.json()["result"])


def parse_entry_list(page: dict) -> tuple[str | None, list[Entry]]:
    """(round id, entries) from an event's page. The list is number; team; car; then the drivers, some years with
    each driver's home town after the name."""
    ev = page.get("data", {}).get("contentfulEvent") or {}
    rid = (ev.get("startDate") or "")[:10] or None
    lists = [x for x in ev.get("starterLists") or [] if (x.get("csvData") or {}).get("csvData")]
    if not lists:
        return rid, []
    lines = [line.split(";") for line in lists[-1]["csvData"]["csvData"].splitlines() if line.strip()]
    heads = [h.strip().lstrip("<").lower() for h in lines[0]]
    drivers = [i for i, h in enumerate(heads) if h.startswith("driver")]
    out = []
    for c in lines[1:]:
        number = re.sub(r"\D", "", c[0]) if c else ""
        if not number or len(c) < 3:
            continue
        names = [c[i].strip() for i in drivers if i < len(c) and c[i].strip()]
        out.append(Entry(number, names, c[1].strip() or None, c[2].strip() or None, None))
    return rid, out
