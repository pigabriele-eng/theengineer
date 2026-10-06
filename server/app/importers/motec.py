"""Reader for native MoTeC i2 log files (.ld).

The .ld layout is not officially documented. This follows the community
reverse-engineered layout: a fixed file header, an event block, and a
doubly linked list of channel headers that point at raw sample arrays.
"""
from __future__ import annotations

import mmap
import struct
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

HEADER = struct.Struct("<I4xII20xI24xHHHI8sHHI4x16s16x16s16x64s64s64x64s64x1024xI66x64s126x")
EVENT = struct.Struct("<64s64s1024sH")
CHANNEL = struct.Struct("<IIIIHHHHhhhh32s8s12s40x")

LD_MARKER = 0x40

_FLOAT_TYPES = {2: np.float16, 4: np.float32}
_INT_TYPES = {2: np.int16, 4: np.int32}


def _text(raw: bytes) -> str:
    return raw.decode("latin-1").split("\0", 1)[0].strip()


@dataclass
class Channel:
    name: str
    short_name: str
    unit: str
    freq: int
    count: int
    _buf: bytes | mmap.mmap = field(repr=False)
    _offset: int = field(repr=False)
    _dtype: type | None = field(repr=False)
    _shift: int = field(repr=False)
    _mul: int = field(repr=False)
    _scale: int = field(repr=False)
    _dec: int = field(repr=False)

    @property
    def readable(self) -> bool:
        return self._dtype is not None and self.count > 0 and self.freq > 0

    @property
    def duration(self) -> float:
        return self.count / self.freq if self.freq else 0.0

    def values(self) -> np.ndarray:
        """Samples in engineering units."""
        if not self.readable:
            return np.empty(0)
        raw = np.frombuffer(self._buf, dtype=self._dtype, count=self.count, offset=self._offset)
        out = (raw.astype(np.float64) / (self._scale or 1) * 10.0 ** (-self._dec) + self._shift) * self._mul
        del raw
        _let_go(self._buf, self._offset, self.count * np.dtype(self._dtype).itemsize)
        return out

    def times(self) -> np.ndarray:
        return np.arange(self.count) / self.freq


@dataclass
class LdFile:
    date: str
    time: str
    driver: str
    vehicle: str
    venue: str
    comment: str
    device_serial: int
    device_type: str
    device_version: int
    event_name: str
    event_session: str
    channels: dict[str, Channel]

    @property
    def duration(self) -> float:
        return max((c.duration for c in self.channels.values() if c.readable), default=0.0)

    def channel(self, *names: str) -> Channel | None:
        """First readable channel matching any of the names (case-insensitive)."""
        lower = {k.lower(): c for k, c in self.channels.items()}
        for n in names:
            c = lower.get(n.lower())
            if c is not None and c.readable:
                return c
        return None


class LdFormatError(ValueError):
    pass


def _map(path: Path) -> bytes | mmap.mmap:
    """The file mapped into memory rather than read: only the channels used are paged in, and those pages can
    be dropped again under memory pressure (a log is often 50-100 MB)."""
    with path.open("rb") as f:
        try:
            return mmap.mmap(f.fileno(), 0, access=mmap.ACCESS_READ)
        except ValueError:  # an empty file can't be mapped
            return b""


def _let_go(buf: bytes | mmap.mmap, start: int, length: int) -> None:
    """The mapped pages of a channel just read no longer count as the server's memory: they stay in the system's file
    cache for the next read, but a log read channel by channel (the lap medians read every one) would otherwise add
    up to its whole size, 50-100 MB, on top of what the analysis holds."""
    if not isinstance(buf, mmap.mmap) or length <= 0:
        return
    first = start - start % mmap.PAGESIZE
    try:
        buf.madvise(mmap.MADV_DONTNEED, first, start + length - first)
    except (AttributeError, OSError, ValueError):  # no madvise here: the pages go when the log is closed
        pass


def read_ld(source: bytes | str | Path) -> LdFile:
    buf = source if isinstance(source, bytes) else _map(Path(source))
    if len(buf) < HEADER.size:
        raise LdFormatError("File is too short to be a MoTeC .ld log")
    h = HEADER.unpack_from(buf, 0)
    if h[0] != LD_MARKER:
        raise LdFormatError("Not a MoTeC .ld log (bad file marker)")
    chan_ptr, event_ptr = h[1], h[3]

    event_name = event_session = ""
    if event_ptr and event_ptr + EVENT.size <= len(buf):
        e = EVENT.unpack_from(buf, event_ptr)
        event_name, event_session = _text(e[0]), _text(e[1])

    channels: dict[str, Channel] = {}
    seen: set[int] = set()
    p = chan_ptr
    while p and p not in seen and p + CHANNEL.size <= len(buf):
        seen.add(p)
        (_prev, nxt, data_ptr, count, _counter, dtype_a, dtype, freq,
         shift, mul, scale, dec, name, short, unit) = CHANNEL.unpack_from(buf, p)
        if dtype_a == 0x07:
            np_type = _FLOAT_TYPES.get(dtype)
        elif dtype_a in (0x00, 0x03, 0x05):
            np_type = _INT_TYPES.get(dtype)
        else:
            np_type = None
        if np_type is not None and data_ptr + count * np.dtype(np_type).itemsize > len(buf):
            np_type = None  # truncated file, keep the header but don't read past the end
        ch = Channel(_text(name), _text(short), _text(unit), freq, count,
                     buf, data_ptr, np_type, shift, mul, scale, dec)
        channels.setdefault(ch.name, ch)
        p = nxt

    return LdFile(
        date=_text(h[12]), time=_text(h[13]), driver=_text(h[14]), vehicle=_text(h[15]),
        venue=_text(h[16]), comment=_text(h[18]), device_serial=h[7], device_type=_text(h[8]),
        device_version=h[9], event_name=event_name, event_session=event_session, channels=channels,
    )


def read_ldx_beacons(source: bytes | str | Path) -> list[float]:
    """Beacon (start/finish) times in seconds from the .ldx file i2 saves next to a .ld log.

    i2 stores them in microseconds from the start of the log. These are what i2 uses for lap
    boundaries, and they are far more precise than a 1 Hz lap counter.
    """
    import xml.etree.ElementTree as ET

    raw = source if isinstance(source, bytes) else Path(source).read_bytes()
    try:
        root = ET.fromstring(raw)
    except ET.ParseError as e:
        raise LdFormatError(f"Not a MoTeC .ldx file: {e}") from e
    times = [float(m.get("Time", "nan")) / 1e6 for m in root.iter("Marker") if m.get("ClassName") == "BCN"]
    return sorted(t for t in times if t == t)
