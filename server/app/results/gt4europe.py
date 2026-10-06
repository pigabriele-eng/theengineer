"""GT4 European Series results from its official site, gt4europeanseries.com (SRO).

The results page has a season list and, for each season, a list of meetings (rounds); a meeting's page links one
"Result List" PDF per session. Only qualifying and race classifications are read (Qualifying 1 and 2 set the grids
of Race 1 and 2).
"""
from __future__ import annotations

import html
import re
from dataclasses import dataclass
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
