"""Readers for logger CSV exports: MoTeC i2, AiM Race Studio and Cosworth Pi Toolbox.

Each export comes back as a CsvLog, which answers like a native MoTeC log (LdFile): header fields, channels by
name, duration. Lap splitting, math channels, insights, comparisons and the channel scan run on it unchanged.
Times start at 0 at the first exported sample. Speeds come back in km/h, angular rates in deg/s, pressures in
bar, temperatures in °C and distances in m, whatever the export used; other units are left as exported.

Layouts read (checked against public example files from each program where they exist):

- MoTeC i2 "Export Data" CSV: ``"Format","MoTeC CSV File"`` then key/value rows (Venue, Vehicle, Driver,
  Device, Comment, Log Date, Log Time, Sample Rate, Duration, Range, Beacon Markers, Segment Times), with a
  second key/value pair in columns 5 and 6 on some rows (Session, Origin/Start/End Time, ...). Blank rows, a
  row of channel names, a row of units, blank rows, then one row per sample. The Time column can be missing
  (time then runs from Start Time at the Sample Rate). Beacon Markers are one space-separated cell or one cell
  each. Race Studio 2's own "MoTeC CSV" export (keys User, Data Source "AIM Data Logger", Date, Time, Segment;
  units such as sec and km) is the same layout and is reported as AiM.
- AiM Race Studio 3 CSV: ``"Format","AiM CSV File"`` then Session (or Venue), Vehicle, Racer, Championship,
  Comment, Date, Time, Sample Rate, Duration, Segment, Beacon Markers (the time each segment ends, the last one
  being the end of the export), Segment Times; a blank row, channel names, units, a blank row, the data.
  Quoted or not; an empty Time column is rebuilt from the Sample Rate.
- Cosworth Pi Toolbox ASCII export (saved as .txt or .csv): ``PiToolboxVersionedASCIIDataSet``, ``Version 2``,
  an {OutingInformation} block of tab-separated key/value rows, then {ChannelBlock}s, each a header row of
  ``Time`` and ``name[unit]`` columns and tab-separated rows: either one block per channel, each on its own
  time base, or one block holding every channel, with empty cells where a channel has no sample. Channel
  names may carry a leading ``*``. "End of lap" entries in an {EventBlock} are the lap markers. Decimal commas
  and "nan" / "-nan(ind)" cells are accepted.
- Any other table, which is how Pi Toolbox's export of displayed data and similar spreadsheets arrive: a row
  of channel names (units in ``[]`` or ``()``, or a row of units below), comma, semicolon or tab separated,
  the first column time or distance. This layout is read from its column names alone; it has not been checked
  against a real Pi Toolbox file.

In every layout the x axis may be distance instead of time (an export "by distance"): time is then rebuilt
from the speed channel, and wherever the distance starts again from zero, a new lap is marked.
"""
from __future__ import annotations

import csv
import re
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

from app.importers.motec import LD_MARKER, LdFile, LdFormatError, read_ld


class ExportFormatError(LdFormatError):
    pass


@dataclass
class CsvChannel:
    """One exported channel: its samples and their times in seconds from the first exported sample."""
    name: str
    unit: str
    freq: int  # typical sample rate, whole hertz
    _t: np.ndarray = field(repr=False)
    _v: np.ndarray = field(repr=False)

    @classmethod
    def of(cls, name: str, unit: str, t: np.ndarray, v: np.ndarray) -> CsvChannel:
        ok = np.isfinite(t) & np.isfinite(v)
        order = np.argsort(t[ok], kind="stable")
        t, v = t[ok][order], v[ok][order]
        rising = np.r_[True, np.diff(t) > 0] if len(t) else np.zeros(0, bool)
        t, v = t[rising], v[rising]
        step = float(np.median(np.diff(t))) if len(t) > 1 else 0.0
        return cls(name, unit, max(1, round(1 / step)) if step > 0 else 1, t, v)

    @property
    def short_name(self) -> str:
        return self.name

    @property
    def count(self) -> int:
        return len(self._v)

    @property
    def readable(self) -> bool:
        return self.count > 0

    @property
    def duration(self) -> float:
        return float(self._t[-1]) + 1 / self.freq if self.count else 0.0

    def values(self) -> np.ndarray:
        return self._v

    def times(self) -> np.ndarray:
        return self._t


@dataclass
class CsvLog(LdFile):
    """A logger CSV export with the same interface as a native MoTeC log."""
    logger: str = ""  # motec, aim, cosworth, or csv when the table does not say
    layout: str = ""  # the export layout it was read as
    beacons: list[float] = field(default_factory=list)  # line crossings (s) the export lists, for lap timing
    time_offset: float = 0.0  # the export's own time at the first sample


def read_log(path: str | Path) -> LdFile:
    """Any stored logger file by its type: a native MoTeC .ld log or a CSV export."""
    return read_ld(path) if Path(path).suffix.lower() == ".ld" else read_csv_log(path)


# ---------- units, names, numbers ----------

# exported unit (lower case, no degree sign) -> (unit used here, factor)
_UNITS = {
    "kph": ("km/h", 1.0), "kmh": ("km/h", 1.0), "km/hr": ("km/h", 1.0), "m/s": ("km/h", 3.6),
    "mph": ("km/h", 1.609344), "rad/s": ("deg/s", 57.29578), "psi": ("bar", 0.0689476), "kpa": ("bar", 0.01),
    "km": ("m", 1000.0), "ft": ("m", 0.3048), "mi": ("m", 1609.344), "sec": ("s", 1.0), "ms": ("s", 0.001),
    "c": ("C", 1.0), "degc": ("C", 1.0),
}
_FAHRENHEIT = ("f", "degf")
SECONDS = ("s", "sec", "ms")
LENGTHS = ("m", "km", "ft", "mi")


def _clean_unit(unit: str) -> str:
    return unit.replace("°", "").replace("º", "").strip()


def _convert(unit: str, v: np.ndarray) -> tuple[str, np.ndarray]:
    u = _clean_unit(unit)
    if u.lower() in _FAHRENHEIT:
        return "C", (v - 32.0) * 5.0 / 9.0
    to = _UNITS.get(u.lower())
    if to is None:
        return u, v
    return to[0], v * to[1]


def _split_name(raw: str) -> tuple[str, str]:
    """"ecu_speed[kph]", "*Time [s]" or "Speed (km/h)" -> name and unit."""
    s = raw.strip().lstrip("*").strip()
    m = re.match(r"^(.*?)\s*[\[(]([^\[\]()]*)[\])]$", s)
    return (m.group(1).strip(), m.group(2).strip()) if m and m.group(1).strip() else (s, "")


def _num(cell: str) -> float:
    s = cell.strip().strip('"')
    try:
        return float(s.replace(",", "."))
    except ValueError:
        return np.nan  # empty, text, "-nan(ind)", ...


def _matrix(rows: list[list[str]], width: int) -> np.ndarray:
    """Rows of cells as floats, NaN where a cell is empty or not a number."""
    fixed = [r[:width] + [""] * (width - len(r)) for r in rows]
    try:
        out = np.array(fixed, dtype=float)
    except ValueError:
        out = np.array([[_num(c) for c in r] for r in fixed], dtype=float)
    return out.reshape(len(fixed), width)


# ---------- the x axis ----------

TIME_NAMES = ("time", "elapsed time", "session time")
DISTANCE_NAMES = ("distance", "dist", "lap distance", "lap_distance", "lapdist")


def _axis_kind(name: str, unit: str, first: bool) -> str | None:
    """Whether a column is the export's time or distance axis: by its name, or by its unit when it comes first."""
    n, u = name.strip().lower(), _clean_unit(unit).lower()
    if n in TIME_NAMES or (first and u in SECONDS):
        return "time"
    if n in DISTANCE_NAMES or (first and u in LENGTHS):
        return "distance"
    return None


def _unwrap(d: np.ndarray) -> tuple[np.ndarray, list[int]]:
    """Distance that starts again from zero each lap, as one running distance, and where each lap starts."""
    ok = np.isfinite(d)
    if not ok.any():
        return d, []
    d = np.interp(np.arange(len(d)), np.flatnonzero(ok), d[ok])
    steps = np.diff(d)
    span = float(np.nanmax(d) - np.nanmin(d)) if len(d) else 0.0
    resets = np.flatnonzero(steps < -0.5 * max(span, 1.0))
    if not len(resets):
        return np.maximum.accumulate(d), []
    typical = float(np.median(steps[steps > 0])) if np.any(steps > 0) else 0.0
    add = np.zeros(len(d))
    for i in resets:
        add[i + 1:] += d[i] - d[i + 1] + typical
    return np.maximum.accumulate(d + add), [int(i) + 1 for i in resets]


def _speed_of(series: list[_Series]) -> _Series | None:
    from app.analysis.laps import DEFAULT_CHANNEL_MAP  # the engine's own speed names, in its order

    by_name = {s.name.lower(): s for s in reversed(series)}
    return next((by_name[n.lower()] for n in DEFAULT_CHANNEL_MAP["speed"] if n.lower() in by_name), None)


@dataclass
class _Series:
    name: str
    unit: str
    x: np.ndarray  # time (s) or distance (m)
    v: np.ndarray


def _channels(series: list[_Series], axis: str, markers: list[float]) -> tuple[dict, list[float], float]:
    """Channels on one clock that starts at 0, the lap markers on that clock, and the export's time at 0."""
    if axis == "distance":
        speed = _speed_of(series)
        if speed is None:
            raise ExportFormatError("This export is by distance and has no speed channel to rebuild its time from")
        d_speed, resets = _unwrap(speed.x)
        vs = np.maximum(np.nan_to_num(_convert(speed.unit, speed.v)[1]) / 3.6, 1.0)  # standing still counts as 1 m/s
        t_speed = np.r_[0.0, np.cumsum(np.diff(d_speed) / ((vs[1:] + vs[:-1]) / 2))]
        for s in series:
            s.x = np.interp(_unwrap(s.x)[0], d_speed, t_speed)
        markers, offset = [float(t_speed[i]) for i in resets], 0.0
    else:
        firsts = [float(np.nanmin(s.x)) for s in series if np.isfinite(s.x).any()]
        offset = min(firsts) if firsts else 0.0
    channels: dict[str, CsvChannel] = {}
    for s in series:
        unit, v = _convert(s.unit, s.v)
        channels.setdefault(s.name, CsvChannel.of(s.name, unit, s.x - offset, v))
    duration = max((c.duration for c in channels.values() if c.readable), default=0.0)
    return channels, _beacons(markers, offset, duration), offset


def _beacons(markers: list[float], offset: float, duration: float) -> list[float]:
    """Markers on the log's clock, without the end-of-export marker AiM adds.

    An export of part of a log may count its markers from the start of the export rather than on the log's
    own clock; whichever reading puts more markers inside the export is used.
    """
    shifted = [m - offset for m in markers if 0 <= m - offset < duration - 0.5]
    raw = [m for m in markers if 0 <= m < duration - 0.5]
    return sorted(shifted if len(shifted) >= len(raw) else raw)


def _log(meta: dict, channels: dict, logger: str, layout: str, beacons: list[float], offset: float) -> CsvLog:
    def get(*keys: str) -> str:
        return next((str(meta[k]).strip() for k in keys if str(meta.get(k, "")).strip()), "")

    if not any(c.readable for c in channels.values()):
        raise ExportFormatError("The export has no channel data")
    return CsvLog(
        date=get("Log Date", "Date", "DateAndTime"), time=get("Log Time", "Time"),
        driver=get("Driver", "Racer", "User", "DriverName", "RacerName"), vehicle=get("Vehicle", "CarName"),
        venue=get("Venue", "TrackName"), comment=get("Comment", "ShortComment", "LongComment"), device_serial=0,
        device_type=get("Device", "Data Source"), device_version=0,
        event_name=get("Championship", "ChampionshipName", "EventName"),
        event_session=get("Session", "SessionType", "SessionNumber"), channels=channels,
        logger=logger, layout=layout, beacons=beacons, time_offset=round(offset, 3),
    )


# ---------- reading ----------

def _decode(raw: bytes) -> str:
    try:
        return raw.decode("utf-8-sig")
    except UnicodeDecodeError:
        return raw.decode("cp1252", errors="replace")  # Pi Toolbox and older Windows exports


def read_csv_log(source: bytes | str | Path) -> CsvLog:
    raw = source if isinstance(source, bytes) else Path(source).read_bytes()
    if raw[:4] == LD_MARKER.to_bytes(4, "little"):
        raise ExportFormatError("This is a native MoTeC .ld log, not a CSV export")
    lines = _decode(raw).splitlines()
    first = next((l for l in lines if l.strip()), "")
    if first.strip().startswith("PiToolboxVersionedASCIIDataSet"):
        return _read_pi_ascii(lines)
    delim = max((",", ";", "\t"), key=first.count)
    head = next(csv.reader([first], delimiter=delim), [])
    if len(head) >= 2 and head[0].strip().lower() == "format":
        return _read_headed(lines, delim, head[1].strip())
    return _read_table(lines, delim)


MULTI_KEYS = ("Beacon Markers", "Segment Times")


def _is_units(row: list[str]) -> bool:
    cells = [c for c in row if c.strip()]
    return bool(cells) and sum(np.isfinite(_num(c)) for c in cells) < len(cells) / 2


def _read_headed(lines: list[str], delim: str, fmt: str) -> CsvLog:
    """MoTeC i2 and AiM Race Studio exports: key/value header, a blank row, names, units, data."""
    meta: dict = {}
    used = 0
    for row in csv.reader(lines, delimiter=delim):
        used += 1
        if not any(c.strip() for c in row):
            break
        key = row[0].strip()
        if key in MULTI_KEYS:
            meta[key] = [tok for c in row[1:] for tok in c.split()]
        elif key:
            meta[key] = row[1].strip() if len(row) > 1 else ""
        if len(row) > 5 and row[4].strip():  # MoTeC's second column of keys
            meta.setdefault(row[4].strip(), row[5].strip())
    rows = [r for r in csv.reader(lines[used:], delimiter=delim) if any(c.strip() for c in r)]
    if not rows:
        raise ExportFormatError("The export has a header but no channels")
    names = [c.strip() for c in rows[0]]
    while names and not names[-1]:
        names.pop()
    units = [""] * len(names)
    body = rows[1:]
    if body and _is_units(body[0]):
        units = [c.strip() for c in body[0][:len(names)]] + [""] * max(0, len(names) - len(body[0]))
        body = body[1:]
    if delim != ",":
        body = [[c.replace(",", ".") for c in r] for r in body]
    if not body:
        raise ExportFormatError("The export has no data rows")

    aim = "aim" in fmt.lower() or "aim" in str(meta.get("Data Source", "")).lower()
    if "motec" in fmt.lower():
        layout = "Race Studio 2 MoTeC CSV" if aim else "MoTeC i2 CSV export"
    else:
        layout = "AiM Race Studio CSV export"
    rate, start = _num(str(meta.get("Sample Rate", ""))), _num(str(meta.get("Start Time", "")))
    markers = [x for x in (_num(b) for b in meta.get("Beacon Markers", [])) if np.isfinite(x)]
    return _from_columns(names, units, _matrix(body, len(names)), meta, markers, "aim" if aim else "motec", layout,
                         rate, start if np.isfinite(start) else 0.0)


def _from_columns(names: list[str], units: list[str], m: np.ndarray, meta: dict, markers: list[float],
                  logger: str, layout: str, rate: float = np.nan, start: float = 0.0) -> CsvLog:
    """A table with one x axis column (time or distance), or rows at a known sample rate."""
    kinds = [_axis_kind(n, u, k == 0) for k, (n, u) in enumerate(zip(names, units, strict=True))]
    xi = next((k for k, kind in enumerate(kinds) if kind == "time" and np.isfinite(m[:, k]).any()), None)
    axis = "time"
    if xi is None and kinds and kinds[0] == "distance":
        xi, axis = 0, "distance"
    if xi is not None:
        _, x = _convert(units[xi] or ("s" if axis == "time" else "m"), m[:, xi])
    elif np.isfinite(rate) and rate > 0:
        x = start + np.arange(len(m)) / rate
    else:
        raise ExportFormatError("The export has no time or distance column and no sample rate")
    series = [_Series(n, u, x, m[:, k]) for k, (n, u) in enumerate(zip(names, units, strict=True))
              if k != xi and n and n.lower() not in TIME_NAMES]
    channels, beacons, offset = _channels(series, axis, markers)
    return _log(meta, channels, logger, layout + (" (by distance)" if axis == "distance" else ""), beacons, offset)


def _read_table(lines: list[str], delim: str) -> CsvLog:
    """A plain table: a row of names (units in brackets, or a row of units below), then data."""
    rows = list(csv.reader(lines, delimiter=delim))
    at = next((k for k, r in enumerate(rows) if sum(bool(c.strip()) for c in r) >= 2), None)
    if at is None:
        raise ExportFormatError("Not a logger export: no row of channel names found")
    split = [_split_name(c) for c in rows[at]]
    names, units = [n for n, _ in split], [u for _, u in split]
    body = [r for r in rows[at + 1:] if any(c.strip() for c in r)]
    if body and _is_units(body[0]):
        units = [u or (body[0][k].strip() if k < len(body[0]) else "") for k, u in enumerate(units)]
        body = body[1:]
    if delim != ",":
        body = [[c.replace(",", ".") for c in r] for r in body]
    if not body:
        raise ExportFormatError("Not a logger export: no data rows")
    pi = any("[" in c for c in rows[at])  # Pi Toolbox writes units as name[unit]
    return _from_columns(names, units, _matrix(body, len(names)), {}, [], "cosworth" if pi else "csv",
                         "Pi Toolbox table export" if pi else "CSV table")


def _read_pi_ascii(lines: list[str]) -> CsvLog:
    """Pi Toolbox's versioned ASCII export: outing information, channel blocks, events."""
    meta: dict = {}
    series: list[_Series] = []
    markers: list[float] = []
    axis, blocks = "time", 0
    i, n = 0, len(lines)
    while i < n:
        line = lines[i].strip()
        i += 1
        if line == "{OutingInformation}":
            while i < n and not lines[i].strip().startswith("{"):
                key, _, value = lines[i].strip().partition("\t")
                if key.strip():
                    meta[key.strip()] = value.strip()
                i += 1
            continue
        if line not in ("{ChannelBlock}", "{EventBlock}"):
            continue
        while i < n and not lines[i].strip():
            i += 1
        if i >= n:
            break
        header = [c.strip() for c in lines[i].rstrip("\r\n").split("\t")]
        i += 1
        start = i
        while i < n and not lines[i].strip().startswith("{"):
            i += 1
        rows = [l.rstrip("\r\n").split("\t") for l in lines[start:i] if l.strip()]
        if line == "{EventBlock}":
            markers += [_num(r[0]) for r in rows if len(r) > 1 and "lap" in " ".join(r[1:]).lower()]
            continue
        blocks += 1
        m = _matrix([[c.replace(",", ".") for c in r] for r in rows], len(header))
        x_name, x_unit = _split_name(header[0])
        axis = _axis_kind(x_name, x_unit, True) or "time"
        _, x = _convert(x_unit or ("s" if axis == "time" else "m"), m[:, 0])
        series += [_Series(name, unit, x, m[:, k]) for k, (name, unit) in enumerate(map(_split_name, header))
                   if k > 0 and name]
    if not series:
        raise ExportFormatError("The Pi Toolbox export has no channel blocks")
    channels, beacons, offset = _channels(series, axis, [x for x in markers if np.isfinite(x)])
    layout = "Pi Toolbox ASCII export" + (", one block per channel" if blocks > 1 else "")
    return _log(meta, channels, "cosworth", layout + (" (by distance)" if axis == "distance" else ""), beacons,
                offset)
