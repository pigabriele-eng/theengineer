"""Racelogic VBOX files (.vbo), the GPS logger of the coaching days (Gabriele, 2026-10-22: "For coaching events I
would likely use VBOX data").

A .vbo is text in sections: "File created on 03/11/2026 at 10:42:01", then [header] (one channel name a line),
[channel units], [comments], [laptiming] (the start/finish line as two points, "Start <long> <lat> <long> <lat>"),
[avi] (the video files' name and type, when a VBOX Video unit recorded them), [column names] (the short names, one
line, space separated) and [data] (one sample a line, space separated). Racelogic's own conventions are undone here:

- time is UTC as hhmmss.ss, on a clock that may cross midnight;
- latitude and longitude are in minutes (degrees times 60), and longitude is positive WEST;
- velocity is in km/h, the accelerations in g.

The channels come back under the names the analysis looks for (GPS Speed, GPS Latitude, ...), so a VBOX log reads
like any CSV export (csvlog.CsvLog). The laps are the crossings of the file's own start/finish line, so a track the
app doesn't know still gets its laps. A VBOX Video file's samples say which video file and how many milliseconds into
it each was recorded (avifileindex, avisynctime): kept as channels, they put the video on the log's clock exactly
(app/videos.py).
"""
from __future__ import annotations

import re

import numpy as np

from app.importers.csvlog import CsvLog, ExportFormatError, _channels, _log, _Series

MARK = "File created on"

# the short column names VBOX writes -> (the analysis's channel name, unit)
NAMES = {
    "sats": ("Satellites", ""), "time": ("Time", "s"), "lat": ("GPS Latitude", "deg"), "long": ("GPS Longitude", "deg"),
    "velocity": ("GPS Speed", "km/h"), "heading": ("GPS Heading", "deg"), "height": ("GPS Altitude", "m"),
    "vert-vel": ("Vertical Velocity", "km/h"), "latacc": ("Lateral Acc", "g"), "lat_acc": ("Lateral Acc", "g"),
    "longacc": ("Longitudinal Acc", "g"), "long_acc": ("Longitudinal Acc", "g"), "yaw_rate": ("Yaw Rate", "deg/s"),
    "yawrate": ("Yaw Rate", "deg/s"), "avifileindex": ("avifileindex", ""), "avitime": ("avisynctime", "ms"),
    "avisynctime": ("avisynctime", "ms"), "event": ("Event", ""), "dist": ("Distance", "m"),
}
# CAN channels a VBOX logs from the car, by the words in their names
CAN = (
    (("engine", "rpm"), ("Engine Speed", "rpm")), (("rpm",), ("Engine Speed", "rpm")),
    (("throttle",), ("Throttle Position", "%")), (("pedal",), ("Throttle Position", "%")),
    (("brake", "press"), ("Brake Pressure", "bar")), (("brake",), ("Brake Pressure", "bar")),
    (("steer",), ("Steering Angle", "deg")), (("gear",), ("Gear", "")),
)


def is_vbox(text: str) -> bool:
    head = text[:4000]
    return head.lstrip().startswith(MARK) or ("[header]" in head and "[column names]" in text[:20000])


def _sections(lines: list[str]) -> dict[str, list[str]]:
    out: dict[str, list[str]] = {"": []}
    cur = ""
    for line in lines:
        s = line.strip()
        if s.startswith("[") and s.endswith("]"):
            cur = s[1:-1].strip().lower()
            out.setdefault(cur, [])
        elif s:
            out.setdefault(cur, []).append(s)
    return out


def _seconds(hhmmss: np.ndarray) -> np.ndarray:
    """hhmmss.ss as seconds, counting on past midnight."""
    h = np.floor(hhmmss / 10000)
    m = np.floor((hhmmss - h * 10000) / 100)
    s = h * 3600 + m * 60 + (hhmmss - h * 10000 - m * 100)
    wraps = np.r_[0, np.cumsum(np.diff(s) < -43200)]
    return s + wraps * 86400


def _can_name(raw: str) -> tuple[str, str] | None:
    low = raw.lower()
    for words, out in CAN:
        if all(w in low for w in words):
            return out
    return None


def _start_line(rows: list[str]) -> tuple[float, float, float, float] | None:
    """The [laptiming] start/finish line as two (lat, lon) points in degrees."""
    for row in rows:
        parts = row.split()
        if parts and parts[0].lower() == "start" and len(parts) >= 5:
            try:
                lo1, la1, lo2, la2 = (float(p) for p in parts[1:5])
            except ValueError:
                return None
            return la1 / 60, -lo1 / 60, la2 / 60, -lo2 / 60
    return None


def _crossings(t: np.ndarray, lat: np.ndarray, lon: np.ndarray, line: tuple[float, float, float, float]) -> list[float]:
    """The times the car crosses the line segment, going the way most crossings go (a car reversing over the line
    isn't a lap)."""
    la1, lo1, la2, lo2 = line
    k = np.cos(np.radians((la1 + la2) / 2))
    ax, ay, bx, by = lo1 * k, la1, lo2 * k, la2
    px, py = lon * k, lat
    side = (bx - ax) * (py - ay) - (by - ay) * (px - ax)
    ok = np.isfinite(side)
    out: list[tuple[float, int]] = []
    for i in np.nonzero(ok[:-1] & ok[1:] & (np.sign(side[:-1]) != np.sign(side[1:])) & (side[:-1] != 0))[0]:
        f = side[i] / (side[i] - side[i + 1])
        x, y = px[i] + f * (px[i + 1] - px[i]), py[i] + f * (py[i + 1] - py[i])
        seg = (bx - ax) ** 2 + (by - ay) ** 2
        u = ((x - ax) * (bx - ax) + (y - ay) * (by - ay)) / seg if seg else -1
        if -0.25 <= u <= 1.25:  # on the line, with room for a car a little wide of the points
            out.append((float(t[i] + f * (t[i + 1] - t[i])), int(np.sign(side[i + 1]))))
    if not out:
        return []
    way = 1 if sum(d for _, d in out) >= 0 else -1
    times = [x for x, d in out if d == way]
    return [x for i, x in enumerate(times) if i == 0 or x - times[i - 1] > 10.0]  # GPS jitter on the line


def read_vbox(text: str) -> CsvLog:
    lines = text.splitlines()
    sec = _sections(lines)
    created = next((l for l in sec.get("", []) if l.startswith(MARK)), "")
    m = re.search(r"(\d{1,2}/\d{1,2}/\d{2,4}).*?(\d{1,2}:\d{2}(:\d{2})?)", created)
    date, clock = (m.group(1), m.group(2)) if m else ("", "")
    columns = " ".join(sec.get("column names", [])).split()
    rows = sec.get("data", [])
    if not columns or not rows:
        raise ExportFormatError("This VBOX file has no [column names] or no [data]")
    long_names = sec.get("header", [])
    m_data = np.full((len(rows), len(columns)), np.nan)
    for i, row in enumerate(rows):
        cells = row.split()
        for k, c in enumerate(cells[:len(columns)]):
            try:
                m_data[i, k] = float(c)
            except ValueError:
                pass
    low = [c.lower() for c in columns]
    if "time" not in low:
        raise ExportFormatError("This VBOX file has no time column")
    t = _seconds(m_data[:, low.index("time")])
    keep = np.isfinite(t) & np.r_[True, np.diff(t) > 0]
    m_data, t = m_data[keep], t[keep]
    series: list[_Series] = []
    seen: set[str] = set()
    lat = lon = None
    for k, short in enumerate(low):
        if short == "time":
            continue
        name, unit = NAMES.get(short) or _can_name(long_names[k] if k < len(long_names) else short) \
            or (columns[k].replace("_", " "), "")
        if name in seen:
            continue
        seen.add(name)
        v = m_data[:, k]
        if short == "lat":
            v = v / 60
            lat = v
        elif short == "long":
            v = -v / 60
            lon = v
        series.append(_Series(name, unit, t, v))
    if not series:
        raise ExportFormatError("This VBOX file has no channels")
    markers: list[float] = []
    line = _start_line(sec.get("laptiming", []))
    if line is not None and lat is not None and lon is not None:
        markers = _crossings(t, lat, lon, line)
    channels, beacons, offset = _channels(series, "time", markers)
    avi = sec.get("avi", [])
    meta = {"Log Date": date, "Log Time": clock, "Device": "Racelogic VBOX",
            "Comment": " ".join(sec.get("comments", []))[:200]}
    out = _log(meta, channels, "vbox", "Racelogic VBOX", beacons, offset)
    out.video = {"prefix": avi[0], "ext": avi[1]} if len(avi) >= 2 else None
    return out
