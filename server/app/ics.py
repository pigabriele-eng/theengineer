"""A small reader for iCalendar feeds (.ics), enough for a calendar of tests and race weekends.

It reads each event's UID, title, location and the days it covers, as the calendar shows them: an all-day event's
DTEND is the day after its last day; a timed event covers the days of its start and end where it was planned (a time
with a TZID is that zone's wall clock, so its date is the local date as written; a UTC time is moved to the calendar's
own zone, X-WR-TIMEZONE, when it is known). An end at midnight doesn't count its day. Long lines folded over several
lines are joined first, and text escapes (\\n, \\, and \\;) undone. Repeating events (RRULE, RDATE, or one
occurrence of them, RECURRENCE-ID) and cancelled ones are marked, for the caller to leave out.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import UTC, date, datetime, timedelta

MAX_TITLE = 160
MAX_LOCATION = 255
MAX_UID = 255


@dataclass
class Entry:
    uid: str
    title: str
    location: str | None
    start: date  # the first day
    end: date  # the last day (inclusive)
    all_day: bool
    cancelled: bool = False
    repeats: bool = False


@dataclass
class Calendar:
    name: str | None = None
    timezone: str | None = None
    entries: list[Entry] = field(default_factory=list)
    unreadable: int = 0  # events without a UID or a start


_FOLD = re.compile(rb"\r?\n[ \t]")
_DATE = re.compile(r"(\d{4})(\d{2})(\d{2})")
_DATETIME = re.compile(r"(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)")
_DURATION = re.compile(r"([+-]?)P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?")


def parse(data: bytes | str) -> Calendar:
    """The calendar's events. Raises ValueError when the text isn't an iCalendar file."""
    raw = data.encode() if isinstance(data, str) else data
    raw = _FOLD.sub(b"", raw.lstrip(b"\xef\xbb\xbf"))  # unfold before decoding: a fold can split a character
    text = raw.decode("utf-8", errors="replace")
    lines = [ln for ln in text.replace("\r\n", "\n").replace("\r", "\n").split("\n") if ln.strip()]
    if not lines or lines[0].strip().upper() != "BEGIN:VCALENDAR":
        raise ValueError("not an iCalendar file")
    cal = Calendar()
    stack: list[str] = []
    props: list[tuple[str, dict, str]] = []
    events: list[list[tuple[str, dict, str]]] = []
    for line in lines:
        parsed = _content_line(line)
        if parsed is None:
            continue
        name, params, value = parsed
        if name == "BEGIN":
            stack.append(value.strip().upper())
            if stack[-1] == "VEVENT":
                props = []
            continue
        if name == "END":
            done = value.strip().upper()
            if stack and stack[-1] == done:
                stack.pop()
                if done == "VEVENT":
                    events.append(props)
            continue
        if stack == ["VCALENDAR"]:
            if name == "X-WR-CALNAME":
                cal.name = _text(value)[:MAX_TITLE] or None
            elif name == "X-WR-TIMEZONE":
                cal.timezone = value.strip() or None
        elif stack and stack[-1] == "VEVENT":  # not the properties of an alarm inside it
            props.append((name, params, value))
    for p in events:
        entry = _entry(p, cal.timezone)
        if entry is None:
            cal.unreadable += 1
        else:
            cal.entries.append(entry)
    return cal


def _content_line(line: str) -> tuple[str, dict, str] | None:
    """NAME;PARAM=VALUE;PARAM="QUOTED:VALUE":value -> (NAME, {PARAM: VALUE}, value)."""
    quoted, colon = False, -1
    for i, ch in enumerate(line):
        if ch == '"':
            quoted = not quoted
        elif ch == ":" and not quoted:
            colon = i
            break
    if colon < 0:
        return None
    head, value = line[:colon], line[colon + 1:]
    parts, buf, quoted = [], "", False
    for ch in head:
        if ch == '"':
            quoted = not quoted
        elif ch == ";" and not quoted:
            parts.append(buf)
            buf = ""
            continue
        buf += ch
    parts.append(buf)
    params = {}
    for p in parts[1:]:
        k, _, v = p.partition("=")
        params[k.strip().upper()] = v.strip().strip('"')
    return parts[0].strip().upper(), params, value


def _text(value: str) -> str:
    """A TEXT value with its escapes undone, on one line."""
    out, i = [], 0
    while i < len(value):
        ch = value[i]
        if ch == "\\" and i + 1 < len(value):
            nxt = value[i + 1]
            out.append(" " if nxt in "nN" else nxt)
            i += 2
            continue
        out.append(ch)
        i += 1
    return " ".join("".join(out).split())


def _zone(name: str | None):
    if not name:
        return None
    try:
        from zoneinfo import ZoneInfo
        return ZoneInfo(name)
    except Exception:  # an unknown zone name, or no time zone data on this machine
        return None


def _when(value: str, params: dict, calendar_tz: str | None) -> tuple[date, datetime | None] | None:
    """A DATE (all day: no time) or a DATE-TIME as the wall clock where it was planned."""
    v = value.strip()
    if params.get("VALUE", "").upper() == "DATE" or re.fullmatch(r"\d{8}", v):
        m = _DATE.fullmatch(v[:8])
        if not m:
            return None
        try:
            return date(int(m[1]), int(m[2]), int(m[3])), None
        except ValueError:
            return None
    m = _DATETIME.fullmatch(v)
    if not m:
        return None
    try:
        dt = datetime(int(m[1]), int(m[2]), int(m[3]), int(m[4]), int(m[5]), min(int(m[6]), 59))
    except ValueError:
        return None
    if m[7] == "Z":  # UTC: on the calendar's own clock when it says which (TZID times are local already)
        zone = _zone(calendar_tz)
        if zone is not None:
            dt = dt.replace(tzinfo=UTC).astimezone(zone).replace(tzinfo=None)
    return dt.date(), dt


def _duration(value: str) -> timedelta | None:
    m = _DURATION.fullmatch(value.strip())
    if not m or m[1] == "-":
        return None
    w, d, h, mi, s = (int(x) if x else 0 for x in m.groups()[1:])
    return timedelta(weeks=w, days=d, hours=h, minutes=mi, seconds=s)


def _entry(props: list[tuple[str, dict, str]], calendar_tz: str | None) -> Entry | None:
    first: dict[str, tuple[dict, str]] = {}
    repeats = False
    for name, params, value in props:
        first.setdefault(name, (params, value))
        if name in ("RRULE", "RDATE", "RECURRENCE-ID"):
            repeats = True
    uid = first.get("UID", ({}, ""))[1].strip()[:MAX_UID]
    if not uid or "DTSTART" not in first:
        return None
    start = _when(first["DTSTART"][1], first["DTSTART"][0], calendar_tz)
    if start is None:
        return None
    start_day, start_at = start
    all_day = start_at is None
    end_day = start_day
    if "DTEND" in first and (end := _when(first["DTEND"][1], first["DTEND"][0], calendar_tz)) is not None:
        end_day = _last_day(*end, start_day)
    elif "DURATION" in first and (span := _duration(first["DURATION"][1])) is not None:
        if all_day:
            end_day = _last_day(start_day + timedelta(days=max(span.days, 1)), None, start_day)
        else:
            end_at = start_at + span
            end_day = _last_day(end_at.date(), end_at, start_day)
    title = _text(first.get("SUMMARY", ({}, ""))[1])[:MAX_TITLE] or "Calendar event"
    location = _text(first.get("LOCATION", ({}, ""))[1])[:MAX_LOCATION] or None
    cancelled = first.get("STATUS", ({}, ""))[1].strip().upper() == "CANCELLED"
    return Entry(uid=uid, title=title, location=location, start=start_day, end=end_day, all_day=all_day,
                 cancelled=cancelled, repeats=repeats)


def _last_day(day: date, at: datetime | None, start_day: date) -> date:
    """The last day an end covers: an all-day end (a date) and an end at midnight are the day after it."""
    if at is None or (at.hour, at.minute, at.second) == (0, 0, 0):
        day = day - timedelta(days=1)
    return max(day, start_day)
