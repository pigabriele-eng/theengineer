"""A part of a stored log, read as a log of its own: what a run split from a longer log reads (app/run_split.py).

Such a run's LoggerFile points at the stored log with meta "window" [from_s, to_s], in seconds of the stored log, and
timing.read_file hands every reader the log cut to that window and shifted so the part starts at 0: its channels, the
line crossings a CSV export lists (beacons), and the header's date and time of day moved on to when the part began.
Nothing is copied from the file: a MoTeC channel reads its part of the mapped log, a CSV channel keeps its samples in
the window. A MoTeC channel starts at its first sample at or after from_s, so a window starting on a whole second
starts every channel (whole hertz) on a sample of its own.
"""
from __future__ import annotations

import dataclasses
import math
from datetime import datetime, timedelta

import numpy as np

from app.importers.csvlog import CsvChannel, CsvLog
from app.importers.motec import Channel, LdFile

DATE_FORMATS = ("%d/%m/%Y", "%Y-%m-%d", "%d.%m.%Y", "%d/%m/%y")  # as the importer reads a logger's date
TIME_FORMATS = ("%H:%M:%S", "%H:%M", "%I:%M:%S %p", "%I:%M %p")  # MoTeC 10:00:00, AiM 10:00 AM


def window(ld: LdFile, from_s: float, to_s: float) -> LdFile:
    """The log from from_s to to_s (seconds into it), starting at 0."""
    date, time = shift_clock(ld.date, ld.time, from_s)
    out = dataclasses.replace(ld, date=date, time=time,
                              channels={name: _channel(c, from_s, to_s) for name, c in ld.channels.items()})
    if isinstance(out, CsvLog):
        out.beacons = beacons_in(ld.beacons, from_s, to_s)
        out.time_offset = round(ld.time_offset + from_s, 3)
    return out


def _channel(c: Channel | CsvChannel, from_s: float, to_s: float) -> Channel | CsvChannel:
    if isinstance(c, CsvChannel):
        t = c.times()
        keep = (t >= from_s) & (t < to_s)
        return dataclasses.replace(c, _t=t[keep] - from_s, _v=c.values()[keep])
    if not c.readable:
        return c
    i0 = min(c.count, math.ceil(from_s * c.freq - 1e-6))
    i1 = min(c.count, max(i0, math.ceil(to_s * c.freq - 1e-6)))
    return dataclasses.replace(c, count=i1 - i0, _offset=c._offset + i0 * np.dtype(c._dtype).itemsize)


def beacons_in(beacons: list[float] | None, from_s: float, to_s: float) -> list[float]:
    """Line crossings (seconds into the log) inside the window, on the window's clock."""
    return [b - from_s for b in beacons or () if from_s <= b < to_s]


def shift_clock(date: str | None, time: str | None, seconds: float) -> tuple[str | None, str | None]:
    """A log header's date and time of day moved on by seconds, each written as it was. A time that can't be read
    stays as it is; so does a date that can't, and then the time only goes round the clock."""
    tf = next((f for f in TIME_FORMATS if _reads(time, f)), None)
    if not seconds or tf is None:
        return date, time
    df = next((f for f in DATE_FORMATS if _reads(date, f)), None)
    day = datetime.strptime(date.strip(), df).date() if df else datetime(2000, 1, 1).date()
    at = datetime.combine(day, datetime.strptime(time.strip(), tf).time()) + timedelta(seconds=seconds)
    return (at.strftime(df) if df else date), at.strftime(tf)


def _reads(text: str | None, fmt: str) -> bool:
    try:
        datetime.strptime((text or "").strip(), fmt)
        return True
    except ValueError:
        return False
