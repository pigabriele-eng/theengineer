"""Read an SRO timing "Result List" PDF (the classification sheet every SRO series publishes for each session).

The sheet's text, laid out as on the page, has a header (session, date, track, weather at the start and the
finish) and then two lines per car:

      1      8 G.Guilvert/P.Petit           Team Speedcar          4    1:42.147                   150.1  11:36:52
     Silver Audi R8 LMS GT4                 Paul Petit

The numbers at the end are a qualifying's (lap of the best time, best time, gap to the first, gap to the car
ahead, km/h, time of day) or a race's (laps, total time, gap, km/h, lap of the best lap, best lap, its km/h).
Cars below "Not classified", "Did not start" or "Disqualified" headings have no position. Columns are found from
the heading line, so a page laid out a little wider or narrower still reads.
"""
from __future__ import annotations

import io
import re
from datetime import datetime
from dataclasses import asdict, dataclass, field

_TIME = r"(?:\d+:)?\d{1,2}:\d{2}\.\d{3}|\d{1,2}\.\d{3}"
_GAP_LAPS = re.compile(r"^(\d+)\s*LAPS?$", re.I)
_SECTIONS = {"not classified": "nc", "did not start": "dns", "disqualified": "dsq", "excluded": "dsq",
             "did not finish": "dnf", "retired": "dnf", "not started": "dns"}

# Brands from the car model's first words, for cars whose model text starts with something else.
_BRANDS = [("aston martin", "Aston Martin"), ("mercedes", "Mercedes-AMG"), ("amg", "Mercedes-AMG"),
           ("mclaren", "McLaren"), ("porsche", "Porsche"), ("bmw", "BMW"), ("audi", "Audi"), ("ford", "Ford"),
           ("toyota", "Toyota"), ("alpine", "Alpine"), ("ginetta", "Ginetta"), ("lotus", "Lotus"),
           ("chevrolet", "Chevrolet"), ("maserati", "Maserati"), ("ktm", "KTM"), ("lamborghini", "Lamborghini"),
           ("ferrari", "Ferrari"), ("cupra", "Cupra"), ("nissan", "Nissan"), ("mustang", "Ford"),
           ("supra", "Toyota"), ("cayman", "Porsche")]


def brand_of(model: str | None) -> str | None:
    if not model:
        return None
    low = model.lower()
    for key, brand in _BRANDS:
        if low.startswith(key):
            return brand
    for key, brand in _BRANDS:
        if key in low:
            return brand
    return model.split()[0]


def seconds(t: str | None) -> float | None:
    """'1:42.147' or '1:01:29.805' or '5.091' in seconds."""
    if not t or not re.fullmatch(_TIME, t):
        return None
    s = 0.0
    for part in t.split(":"):
        s = s * 60 + float(part)
    return round(s, 3)


@dataclass
class Row:
    position: int | None
    status: str  # classified, nc, dns, dnf, dsq
    car_number: str
    drivers: list[str]
    team: str | None
    car_class: str | None = None
    car_model: str | None = None
    brand: str | None = None
    entrant: str | None = None
    laps: int | None = None
    best_lap_s: float | None = None
    best_lap_no: int | None = None
    total_time_s: float | None = None
    gap_s: float | None = None  # to the first car (a race car laps down has gap_laps instead)
    gap_laps: int | None = None
    diff_s: float | None = None  # to the car ahead
    kph: float | None = None


@dataclass
class ResultList:
    title: str | None = None  # "Qualifying 1", "Race 2"
    kind: str | None = None  # qualifying, race, practice
    number: int | None = None  # the 1 of "Qualifying 1"
    date: str | None = None  # when it started, local time: "2026-09-19T11:15:00"
    track: str | None = None
    length_m: int | None = None
    weather: dict = field(default_factory=dict)  # air/track °C and conditions at the start and at the finish
    fastest: str | None = None
    rows: list[Row] = field(default_factory=list)

    def as_dict(self) -> dict:
        return asdict(self)


def pdf_text(data: bytes) -> list[str]:
    """Each page's text, laid out as on the page."""
    from pypdf import PdfReader

    return [p.extract_text(extraction_mode="layout") or "" for p in PdfReader(io.BytesIO(data)).pages]


def parse_pdf(data: bytes, kind: str | None = None) -> ResultList:
    """kind (qualifying, race, practice, test): what the session is known to be, for a sheet whose heading doesn't
    say it."""
    return parse_pages(pdf_text(data), kind)


def _header(lines: list[str], out: ResultList) -> None:
    text = "\n".join(lines)
    for line in lines[:6]:
        m = re.match(r"\s*(Qualifying|Race|Free Practice|Pre-?\s?Qualifying|Practice|(?:Official\s+)?(?:Paid\s+)?Test"
                     r"\s*Sessions?)\s*(?:-\s*Part)?\s*(\d*)\s*$", line, re.I)
        if m and out.title is None:
            out.title = f"{m.group(1).strip()} {m.group(2)}".strip()
            word = m.group(1).lower()
            out.kind = ("race" if word == "race" else "qualifying" if word.startswith("qual") else
                        "test" if "test" in word else "practice")
            out.number = int(m.group(2)) if m.group(2) else None
    m = re.search(r"^(.+?),\s*Length:\s*(\d+)\s*m", text, re.M)
    if m:
        out.track, out.length_m = m.group(1).strip(), int(m.group(2))
    out.date = _when(text)
    for key, name in (("AIR", "air_c"), ("TRACK", "track_c")):
        vals = re.findall(rf"\b{key}\s+(-?\d+(?:\.\d+)?)\s*°C", text)
        if vals:
            out.weather[f"{name}_start"] = float(vals[0])
            out.weather[f"{name}_end"] = float(vals[-1])
    cond = re.findall(r"CONDITIONS\s+([A-Za-z ]+?)(?:\s{2,}|$)", text, re.M)
    if cond:
        out.weather["conditions_start"], out.weather["conditions_end"] = cond[0].strip(), cond[-1].strip()
    m = re.search(r"FASTEST LAP:\s*(.+?)\s*$", text, re.M)
    if m:
        out.fastest = re.sub(r"\s+", " ", m.group(1))


_CLASS = re.compile(r"^\s*(Silver(?:\s*Cup)?|Pro-?\s?Am(?:\s*Cup)?|PAM|Am(?:\s*Cup)?|Pro)(?=[A-Z\s]|$)\s*(.*)$", re.I)


def class_name(c: str) -> str:
    low = re.sub(r"[\s-]", "", c.lower())
    if low.startswith("silver"):
        return "Silver"
    if low.startswith(("proam", "pam")):
        return "Pro-Am"
    if low.startswith("am"):
        return "Am"
    return c


def _class_and_model(left: str) -> tuple[str | None, str | None]:
    """'     PAM    Porsche 718 Cayman GT4 RS CS' -> ('Pro-Am', 'Porsche 718 Cayman GT4 RS CS')."""
    m = _CLASS.match(left)
    if not m:
        return None, re.sub(r"\s+", " ", left).strip() or None
    model = re.sub(r"\s+", " ", m.group(2)).strip()
    starts = lambda t: any(t.lower().startswith(k) for k, _ in _BRANDS)  # noqa: E731
    if model and not starts(model) and starts(model[1:]):  # a cut-off sub-cup name ("Pro-AM Cup S...")
        model = model[1:]
    return class_name(m.group(1)), model or None


def _drivers(text: str) -> list[str]:
    """'C.Hart/M.Cresswel l' -> ['C.Hart', 'M.Cresswell']: the page's text sometimes splits off a name's last
    letter."""
    out = []
    for d in text.split("/"):
        d = re.sub(r"\s+", " ", re.sub(r"\((?:Silver|Bronze|Gold|Platinum)\s*\)", "", d, flags=re.I)).strip()
        d = re.sub(r"(?<=[a-zß-ÿ]) ([a-zß-ÿ])$", r"\1", d)
        if d:
            out.append(d)
    return out


def _when(text: str) -> str | None:
    """'19 September 2026 11:15:00' or 'Saturday, April 11, 2026 15:50' as '2026-09-19T11:15:00'."""
    for pattern, fmt in ((r"\b(\d{1,2} [A-Z][a-z]+ \d{4}) (\d{1,2}:\d{2}(?::\d{2})?)", "%d %B %Y"),
                         (r"\b([A-Z][a-z]+ \d{1,2}, \d{4}) (\d{1,2}:\d{2}(?::\d{2})?)", "%B %d, %Y")):
        m = re.search(pattern, text)
        if m:
            try:
                day = datetime.strptime(m.group(1), fmt).date()
            except ValueError:
                continue
            hms = m.group(2) if m.group(2).count(":") == 2 else m.group(2) + ":00"
            return f"{day.isoformat()}T{int(hms.split(':')[0]):02d}:{hms.split(':', 1)[1]}"
    return None


def _cut(line: str, at: int) -> int:
    """Where a column starting near `at` starts on this line: the start of the word at or just after `at`, or
    the word that runs over `at` when it began a little early."""
    at = min(at, len(line))
    i = at
    while i > 0 and line[i - 1] != " ":
        i -= 1
    if i < at - 3:  # a long word from the column before runs past the column start
        while at < len(line) and line[at] != " ":
            at += 1
        i = at
    return i


def _tail(tokens: list[str], kind: str | None) -> dict:
    """The numbers at the end of a car's first line."""
    out: dict = {}
    t = [x for x in tokens if x]
    if kind == "race" or (kind is None and len([x for x in t if re.fullmatch(_TIME, x)]) >= 2):
        # laps total [gap] kph [bestlapno bestlap kph]
        if t and re.fullmatch(r"\d+", t[0]):
            out["laps"] = int(t.pop(0))
        if t and re.fullmatch(_TIME, t[0]):
            out["total_time_s"] = seconds(t.pop(0))
        if t and (re.fullmatch(_TIME, t[0]) or _GAP_LAPS.match(t[0])):
            g = t.pop(0)
            m = _GAP_LAPS.match(g)
            if m:
                out["gap_laps"] = int(m.group(1))
            else:
                out["gap_s"] = seconds(g)
        if t and re.fullmatch(r"\d+\.\d", t[0]):
            out["kph"] = float(t.pop(0))
        if len(t) >= 2 and re.fullmatch(r"\d+", t[0]) and re.fullmatch(_TIME, t[1]):
            out["best_lap_no"], out["best_lap_s"] = int(t[0]), seconds(t[1])
    else:
        # lap best [gap [diff]] kph daytime
        if t and re.fullmatch(r"\d+", t[0]):
            out["best_lap_no"] = int(t.pop(0))
        if t and re.fullmatch(_TIME, t[0]):
            out["best_lap_s"] = seconds(t.pop(0))
        gaps = []
        while t and (re.fullmatch(_TIME, t[0]) or _GAP_LAPS.match(t[0])) and not re.fullmatch(r"\d+\.\d", t[0]):
            gaps.append(t.pop(0))
        if gaps:
            out["gap_s"] = seconds(gaps[0])
        if len(gaps) > 1:
            out["diff_s"] = seconds(gaps[1])
        if t and re.fullmatch(r"\d+\.\d", t[0]):
            out["kph"] = float(t.pop(0))
    return out


def _split_tail(rest: str) -> tuple[str, list[str]]:
    """'Team Speedcar     4   1:42.147   150.1   11:36:52' -> ('Team Speedcar', ['4', '1:42.147', ...])."""
    parts = re.split(r"(\s{2,})", rest.strip())
    words = [p for p in parts if p.strip()]
    tail: list[str] = []
    num = re.compile(rf"^(?:{_TIME}|\d+|\d+\.\d|\d+\s*LAPS?|\d{{1,2}}:\d{{2}}:\d{{2}})$", re.I)
    while words:
        w = words[-1]
        toks = w.split()
        if all(num.match(x) for x in toks) or _GAP_LAPS.match(w):
            tail[:0] = [w] if _GAP_LAPS.match(w) else toks
            words.pop()
        else:
            break
    return "  ".join(words).strip(), tail


def parse_pages(pages: list[str], kind: str | None = None) -> ResultList:
    out = ResultList()
    seen: set[str] = set()
    for page in pages:
        lines = page.splitlines()
        if out.title is None or out.track is None:
            _header(lines, out)
            out.kind = out.kind or kind
        cols = None
        status = "classified"
        last: Row | None = None
        for i, line in enumerate(lines):
            if re.search(r"\bNr\.\s+Drivers\b", line):
                nxt = lines[i + 1] if i + 1 < len(lines) else ""
                team_at = line.find("Team")
                cols = {"nr_end": line.find("Nr.") + 3, "drivers": line.find("Drivers"), "team": team_at,
                        "car": nxt.find("Car") if "Car" in nxt else line.find("Drivers"),
                        "entrant": nxt.find("Entrant") if "Entrant" in nxt else team_at}
                status = "classified"
                continue
            if cols is None:
                continue
            low = line.strip().lower()
            if low in _SECTIONS:
                status = _SECTIONS[low]
                last = None
                continue
            if low.startswith(("fastest lap of", "page ", "ver:")) or "printed:" in low:
                cols = None if "fastest lap of" in low else cols
                last = None
                continue
            # position and number; a number of three digits can run into the drivers ("911C.de Kant")
            hm = re.match(r"^\s*(\d{1,3})?\s+(\d{1,3})(?=\s|[A-Z])", line)
            if hm and hm.end() <= cols["drivers"] + 2 and len(line) > cols["team"]:
                cut = _cut(line, cols["team"])
                drivers = line[hm.end(): cut].strip()
                team, tail = _split_tail(line[cut:])
                number = hm.group(2)
                pos = int(hm.group(1)) if hm.group(1) and status == "classified" else None
                if number in seen:  # a later page repeating the classification (e.g. by class)
                    last = None
                    continue
                row = Row(position=pos, status=status if pos is not None or status != "classified" else "nc",
                          car_number=number, drivers=_drivers(drivers),
                          team=team or None, **_tail(tail, out.kind))
                if pos is None and status == "classified":
                    row.status = "classified"
                out.rows.append(row)
                seen.add(number)
                last = row
                continue
            if last is not None and line.strip() and last.car_model is None:
                cut = _cut(line, cols["entrant"])
                cls, model = _class_and_model(line[:cut])
                last.car_class = cls
                last.car_model = model
                last.brand = brand_of(last.car_model)
                last.entrant = line[cut:].strip() or None
                last = None
    return out
