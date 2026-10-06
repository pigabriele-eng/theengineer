"""GT4 European Series results from its official site, gt4europeanseries.com (SRO).

The results page has a season list and, for each season, a list of meetings (rounds); a meeting's page links one
"Result List" PDF per session. Only qualifying and race classifications are read (Qualifying 1 and 2 set the grids
of Race 1 and 2).
"""
from __future__ import annotations

import html
import re
from dataclasses import dataclass
from datetime import date, datetime
from urllib.parse import quote

import httpx

SERIES = "gt4-europe"
NAME = "GT4 European Series"
BASE = "https://www.gt4europeanseries.com"
_HEADERS = {"User-Agent": "TheEngineer/1.0 (results sync)"}


@dataclass
class SessionLink:
    code: str  # Q1, Q2, R1, R2
    title: str  # as the site labels it
    url: str


def _get(client: httpx.Client, url: str) -> httpx.Response:
    r = client.get(url, headers=_HEADERS, timeout=60, follow_redirects=True)
    r.raise_for_status()
    return r


def _options(page: str, select_id: str) -> list[tuple[str, str]]:
    m = re.search(rf'id="{select_id}".*?</select>', page, re.S) or re.search(
        rf'name="{select_id}".*?</select>', page, re.S)
    if not m:
        return []
    return [(v, html.unescape(t).strip()) for v, t in re.findall(r'value="(\d+)"[^>]*>([^<]*)', m.group(0))
            if v != "0"]


def seasons(client: httpx.Client) -> dict[int, str]:
    """Year -> the site's season id."""
    page = _get(client, f"{BASE}/results").text
    return {int(t): v for v, t in _options(page, "filter_season_id") if t.isdigit()}


def rounds(client: httpx.Client, season_id: str) -> list[tuple[str, str]]:
    """The season's meetings as (meeting id, name), in the order the site lists them."""
    page = _get(client, f"{BASE}/results?filter_season_id={season_id}").text
    return _options(page, "filter_meeting_id")


def session_code(title: str) -> str | None:
    """'Qualifying 1' -> 'Q1', 'Race 2' -> 'R2'; practice and pre-qualifying are not read."""
    m = re.match(r"\s*(Qualifying|Race)\s*(\d*)\s*$", title, re.I)
    if not m:
        return None
    return ("Q" if m.group(1).lower().startswith("q") else "R") + (m.group(2) or "1")


def round_sessions(client: httpx.Client, season_id: str, round_id: str) -> list[SessionLink]:
    page = _get(client, f"{BASE}/results?filter_season_id={season_id}&filter_meeting_id={round_id}").text
    out = []
    for href, title in re.findall(
            r'href="(/images/results/[^"]+)"\s*>\s*<span class="link-boxes__title"><span>([^<]*)', page):
        code = session_code(html.unescape(title))
        if code:
            out.append(SessionLink(code, html.unescape(title).strip(), BASE + quote(html.unescape(href))))
    return out


def fetch(client: httpx.Client, url: str) -> bytes:
    return _get(client, url).content


# --- the season's calendar and entry lists ------------------------------------------------------------------------

@dataclass
class CalendarRound:
    round_id: str  # the same meeting id the results use
    name: str
    order: int
    start: date | None
    end: date | None


@dataclass
class Entry:
    car_number: str
    drivers: list[str]
    team: str | None
    car_model: str | None
    car_class: str | None


def _ics_date(text: str, key: str) -> date | None:
    m = re.search(rf"^{key}[^:]*:(\d{{8}})", text, re.M)
    return datetime.strptime(m.group(1), "%Y%m%d").date() if m else None


def calendar(client: httpx.Client, season_id: str) -> list[CalendarRound]:
    """The season's rounds in order, past and still to come, with their first and last day (from each round's
    calendar file, whose last day is the meeting's own last day)."""
    page = _get(client, f"{BASE}/calendar?filter_season_id={season_id}").text
    out: list[CalendarRound] = []
    for mid, slug in re.findall(r'href="/event/(\d+)/([^"/#?]+)"', page):
        if any(r.round_id == mid for r in out):
            continue
        ics = _get(client, f"{BASE}/feed/get_event_calendar?meeting_id={mid}").text
        m = re.search(r"^DESCRIPTION:(.*?)\s*Round\s*\d+\s*$", ics, re.M)
        name = html.unescape(m.group(1)).strip() if m and m.group(1).strip() else (
            html.unescape(slug).replace("-", " ").strip().title())
        out.append(CalendarRound(mid, name, len(out) + 1, _ics_date(ics, "DTSTART"), _ics_date(ics, "DTEND")))
    return out


def entry_list_urls(client: httpx.Client, season_id: str) -> list[str]:
    page = _get(client, f"{BASE}/entry-lists?filter_season_id={season_id}").text
    return [BASE + quote(html.unescape(h)) for h in dict.fromkeys(re.findall(r'href="(/entry-list/[^"]+)"', page))]


def _cell(text: str) -> str:
    return re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", text))).strip()


def entry_list(client: httpx.Client, url: str) -> tuple[str | None, list[Entry]]:
    """(meeting id, entries) of one published entry list."""
    return parse_entry_list(_get(client, url).text)


def parse_entry_list(page: str) -> tuple[str | None, list[Entry]]:
    m = re.search(r'id="filter_meeting_id".*?value="(\d+)"\s+selected', page, re.S)
    meeting = m.group(1) if m else None
    table = re.search(r'<table class="table">(.*?)</table>', page, re.S)
    if not table:
        return meeting, []
    heads = [_cell(h).lower() for h in re.findall(r"<th[^>]*>(.*?)</th>", table.group(1), re.S)]
    out = []
    for row in re.findall(r"<tr[^>]*>(.*?)</tr>", table.group(1), re.S):
        cells = [_cell(c) for c in re.findall(r"<td[^>]*>(.*?)</td>", row, re.S)]
        if len(cells) != len(heads) or not cells:
            continue
        by = dict(zip(heads, cells, strict=True))
        drivers = [re.sub(r"\s*\(R\)\s*$", "", v).strip() for k, v in by.items() if k.startswith("driver") and v]
        number = re.sub(r"\D", "", by.get("car #", ""))
        if number:
            out.append(Entry(number, drivers, by.get("team") or None, by.get("car") or None,
                             by.get("cat") or by.get("class") or None))
    return meeting, out
