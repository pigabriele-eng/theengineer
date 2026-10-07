"""Lap packs: a session's clean laps as the comparisons read them from its log, in about 0.1 to 0.8 MB.

Comparing laps places each one on the quickest lap's GPS line (align.py). Of the whole log, that reads each lap's
speed (its distance driven) and GPS position sample by sample, from just before the lap to just after it, and the
channels the comparison measures. A pack keeps, for every clean lap, the samples of those that decide what the
comparison says: speed, GPS, the pedals, steering, the accelerations and the states worked out from the log
(laps.load_session, channels.py: phase, braking, coasting, overlap, gear, traction control and ABS working), and where
each sample sits on the session's own line, the line its compact traces (compact.py) are resampled on every metre.

A lap is then traced without its log (PackedRun.trace): its time to every metre and the channels above come from its
own samples, as from the log, and the slower ones worked out from them (the road's shape, curvature, understeer,
rear wheelspin) from its compact trace, at the metre its samples put it on. So the lap's section times, the sections
themselves, where it brakes, coasts and picks up the throttle, its grip and its steering are the log's; those few
others differ only by being read from a 1 m grid instead of from the 100 Hz samples.

Stored as whole numbers (speed, pedals and steering in the steps the log has them in, 0.1 km/h, 0.01 % and 0.001 bar
or degree at the finest, accelerations to 0.0001 g, GPS to 1e-8 degree, about a millimetre, positions to a millimetre,
as their difference from where wheel speed alone puts each sample), each as its change from the sample before, so a
47-minute session with 16 clean laps takes about 0.75 MB. A lap's samples are only unpacked when it is traced.
"""
from __future__ import annotations

import io
import json
from collections.abc import Callable
from dataclasses import dataclass, field

import numpy as np

from app.analysis.align import PAD_S, TrackLine, aligned_trace, lap_position, track_line
from app.analysis.laps import MASTER_HZ, Lap, SessionData, lap_length

FORMAT = 1
STATES = ("phase", "braking", "coasting", "overlap", "gear", "tc_on", "abs_on")
# what is kept of each sample -> (the steps it may be stored in, the order of the differences stored). The coarsest
# step that keeps every value as logged is used (a MoTeC log stores speed in steps of 0.1 km/h), else the finest.
FINE = (0.1, 0.01, 0.001, 1e-6)
ENCODING = {"speed": (FINE, 1), "lat": ((1e-8,), 1), "lon": ((1e-8,), 1), "throttle": (FINE, 1),
            "brake": (FINE[:3], 1), "steer": (FINE[:3], 1), "ax": ((1e-4,), 1), "ay": ((1e-4,), 1),
            **{r: ((1.0, 1e-6), 1) for r in STATES}}
OWN = ((1e-3,), 1)  # positions on the session's own line, less where wheel speed alone puts each sample
MIN_LINE_M = 100  # as compact.reduce_session: a shorter "lap" makes no line
# what the comparisons read from the compact traces: every other channel they measure comes from the pack
FROM_COMPACT = ("turn_g", "az", "altitude", "curvature", "understeer", "rear_slip")


class NotCovered(LookupError):
    """The pack or the compact traces don't hold this lap: read it from the log."""


@dataclass
class PackLap:
    lap: Lap
    start: int  # first sample kept (index on the session's 100 Hz clock)
    channels: dict[str, np.ndarray]  # role -> every sample from start on (ENCODING's roles the log has)
    own: np.ndarray  # where each sample sits on the session's own line (m)


@dataclass
class LapPack:
    samples: int  # on the session's 100 Hz clock
    laps: dict[int, Lap]  # its clean laps, by number
    unpack: Callable[[int], PackLap]  # one lap's samples
    length: int = 0  # metres of the session's own line (0: no clean lap)
    line: tuple[float, float] | None = None  # that line's origin (lat0, lon0); None without GPS
    meta: dict = field(default_factory=dict)
    nbytes: int = 0  # memory its packed samples take (from_bytes)

    def lap(self, number: int) -> PackLap:
        if number not in self.laps:
            raise NotCovered(f"lap {number} isn't a clean lap of this session")
        return self.unpack(number)


# ---------- building ----------

def _window(data: SessionData, lap: Lap) -> tuple[int, int]:
    """The samples align.lap_position reads for a lap: from PAD_S before it to PAD_S after it."""
    pad = round(PAD_S * MASTER_HZ)
    s0, s1 = round(lap.start * MASTER_HZ), min(round(lap.end * MASTER_HZ), len(data.t) - 1)
    return max(s0 - pad, 0), min(s1 + pad, len(data.t) - 1)


def own_line(data: SessionData) -> tuple[TrackLine | None, int]:
    """The session's own line and its length, as compact.reduce_session makes them (from its quickest clean lap);
    length 0 when there is none."""
    clean = [l for l in data.laps if l.clean]
    if not clean:
        return None, 0
    ref = min(clean, key=lambda l: l.time)
    line = track_line(data, ref)
    length = line.length if line is not None else round(lap_length(data, ref))
    return (line, length) if length >= MIN_LINE_M else (None, 0)


def _wheel(lap: Lap, start: int, speed: np.ndarray, samples: int, length: int) -> np.ndarray:
    """Where each sample sits on a line `length` long by wheel speed alone, as align.lap_position starts from before
    GPS corrects it: positions are kept as their difference from this, which changes slowly."""
    distance = np.concatenate([[0.0], np.cumsum(speed[1:] / 3.6 / MASTER_HZ)])
    s0, s1 = round(lap.start * MASTER_HZ) - start, min(round(lap.end * MASTER_HZ), samples - 1) - start
    return (distance - distance[s0]) / max(distance[s1] - distance[s0], 1.0) * length


def build(data: SessionData) -> LapPack:
    """The pack of a session read from its log, its math channels (channels.math_channels) worked out."""
    roles = [r for r in ENCODING if r in data.channels]
    line, length = own_line(data)
    kept: dict[int, PackLap] = {}
    for lap in data.laps if length else []:
        if not lap.clean:
            continue
        w0, w1 = _window(data, lap)
        idx, own = lap_position(data, lap, line, length)
        if w1 - w0 < 10 or idx[0] != w0 or idx[-1] != w1:
            continue
        pl = PackLap(lap, w0, {r: data.channels[r][w0:w1 + 1] for r in roles}, own)
        if all(np.all(np.isfinite(a)) for a in (pl.own, *pl.channels.values())):
            kept[lap.number] = pl
    return LapPack(len(data.t), {n: pl.lap for n, pl in kept.items()}, kept.__getitem__, length,
                   (line.lat0, line.lon0) if line is not None else None, {"roles": roles})


# ---------- storage ----------

def _step(parts: list[np.ndarray], steps: tuple[float, ...]) -> float:
    """The coarsest of the steps every value is a whole number of (to the precision a log stores it in, float32 at
    worst), else the finest."""
    for step in steps[:-1]:
        if all(np.all(np.abs(x - np.rint(x / step) * step) <= 1e-6 * step + 2e-7 * np.abs(x))
               for x in map(np.asarray, parts)):
            return step
    return steps[-1]


def _encode(parts: list[np.ndarray], step: float, order: int) -> tuple[np.ndarray, np.ndarray]:
    """Each part in whole steps: its first values (one per order), then its differences of that order."""
    qs = [np.rint(np.asarray(p, float) / step).astype(np.int64) for p in parts]
    heads = np.array([[np.diff(x, n=k)[0] for k in range(order)] for x in qs], np.int64).reshape(-1, order)
    diffs = np.concatenate([np.diff(x, n=order) for x in qs]) if qs else np.zeros(0, np.int64)
    for dt in (np.int8, np.int16, np.int32):
        if not len(diffs) or np.abs(diffs).max() <= np.iinfo(dt).max:
            return heads, diffs.astype(dt)
    return heads, diffs


def _decode(head: np.ndarray, diffs: np.ndarray, step: float) -> np.ndarray:
    x = diffs.astype(np.int64)
    for k in reversed(range(len(head))):
        x = np.concatenate([[head[k]], head[k] + np.cumsum(x)])
    return x * step


def to_bytes(pack: LapPack, meta: dict | None = None) -> bytes:
    laps = [pack.lap(n) for n in pack.laps]
    roles = [r for r in ENCODING if laps and r in laps[0].channels]
    parts = {r: [pl.channels[r] for pl in laps] for r in roles}
    parts["own"] = [pl.own - _wheel(pl.lap, pl.start, pl.channels["speed"], pack.samples, pack.length) for pl in laps]
    how = {r: OWN if r == "own" else ENCODING[r] for r in parts}
    code = {r: (_step(parts[r], how[r][0]), how[r][1]) for r in parts}  # role -> (step, order)
    head = {"format": FORMAT, "samples": pack.samples, "length": pack.length, "roles": roles,
            "line": list(pack.line) if pack.line is not None else None, "code": code, **(meta or {})}
    arrays = {
        "meta": np.frombuffer(json.dumps(head).encode(), np.uint8),
        "laps": np.array([[pl.lap.number, pl.lap.start, pl.lap.end, pl.lap.time] for pl in laps], float).reshape(-1, 4),
        "spans": np.array([[pl.start, len(pl.own)] for pl in laps], np.int64).reshape(-1, 2),
    }
    for role, values in parts.items():
        arrays[f"{role}_heads"], arrays[f"{role}_diffs"] = _encode(values, *code[role])
    buf = io.BytesIO()
    np.savez_compressed(buf, **arrays)
    return buf.getvalue()


def from_bytes(blob: bytes) -> LapPack:
    """The pack as stored, its laps' samples unpacked only when asked for. ValueError when it is in another format."""
    with np.load(io.BytesIO(blob)) as z:
        meta = json.loads(z["meta"].tobytes())
        if meta.get("format") != FORMAT:
            raise ValueError("Lap pack in another format")
        rows, spans = z["laps"], z["spans"]
        enc = {role: (z[f"{role}_heads"], z[f"{role}_diffs"]) for role in [*meta["roles"], "own"]}
    laps = {int(r[0]): Lap(int(r[0]), float(r[1]), float(r[2]), float(r[3]), True) for r in rows}
    where = {int(r[0]): i for i, r in enumerate(rows)}
    code = meta["code"]  # role -> (step, order)
    # where each lap's differences start: each lap keeps its samples less one per order
    offsets = {role: np.concatenate([[0], np.cumsum(spans[:, 1] - code[role][1])]).astype(int) for role in enc}

    def unpack(number: int) -> PackLap:
        i = where[number]
        got = {}
        for role, (heads, diffs) in enc.items():
            a, b = offsets[role][i], offsets[role][i + 1]
            got[role] = _decode(heads[i], diffs[a:b], code[role][0])
        start = int(spans[i, 0])
        own = got.pop("own") + _wheel(laps[number], start, got["speed"], int(meta["samples"]), int(meta["length"]))
        return PackLap(laps[number], start, got, own)

    line = tuple(meta["line"]) if meta["line"] is not None else None
    held = sum(h.nbytes + d.nbytes for h, d in enc.values())
    return LapPack(int(meta["samples"]), laps, unpack, int(meta["length"]), line, meta, held)


# ---------- tracing a lap without its log ----------

class _Clock:
    """The session's 100 Hz clock as laps.load_session makes it (np.arange), without holding it."""

    def __init__(self, n: int):
        self.n = n

    def __len__(self) -> int:
        return self.n

    def __getitem__(self, key):
        if isinstance(key, slice):
            key = np.arange(*key.indices(self.n))
        return np.asarray(key) * (1 / MASTER_HZ)


class _Stretch:
    """A stretch of one of the session's 100 Hz channels, indexed as the whole channel is."""

    def __init__(self, values: np.ndarray, start: int, n: int):
        self.values, self.start, self.n = values, start, n

    def __len__(self) -> int:
        return self.n

    def __getitem__(self, key):
        if isinstance(key, slice):
            a, b, step = key.indices(self.n)
            if a < self.start or b > self.start + len(self.values):
                raise NotCovered("outside the samples kept")
            return self.values[a - self.start:b - self.start:step]
        k = np.asarray(key) - self.start
        if k.size and (k.min() < 0 or k.max() >= len(self.values)):
            raise NotCovered("outside the samples kept")
        return self.values[k]


def window_data(pack: LapPack, number: int) -> SessionData:
    """One lap of the pack as the session's data, for align.track_line, laps.lap_length and align.aligned_trace:
    its clock, distance, the channels kept and its positions on the session's own line ("own"), from just before it
    to just after it (reading anywhere else raises NotCovered)."""
    pl = pack.lap(number)
    n, s = pack.samples, pl.start
    speed = pl.channels["speed"]
    distance = np.concatenate([[0.0], np.cumsum(speed[1:] / 3.6 / MASTER_HZ)])  # as laps.load_session
    channels = {role: _Stretch(v, s, n) for role, v in pl.channels.items()}
    channels["own"] = _Stretch(pl.own, s, n)
    return SessionData(_Clock(n), _Stretch(distance, s, n), channels, {}, [pl.lap])


@dataclass
class OwnTraces:
    """A session's compact traces (compact.py), only the roles asked for: role -> [lap, metre of its own line]."""
    numbers: np.ndarray  # lap numbers
    pad: int  # metres kept before the line's first
    traces: dict[str, np.ndarray]
    sources: dict[str, str]  # role -> the logger channel it came from
    length: int = 0  # metres of the line
    line: tuple[float, float] | None = None  # its origin (lat0, lon0)

    def nbytes(self) -> int:
        return sum(a.nbytes for a in self.traces.values())


def own_traces(src, roles: tuple[str, ...], fmt: int) -> OwnTraces:
    """The roles asked for (those it has) of a stored compact traces file (compact.to_bytes) of format fmt; ValueError
    when it is in another format."""
    with np.load(src) as z:
        meta = json.loads(z["meta"].tobytes())
        if meta.get("format") != fmt:
            raise ValueError("Compact traces in another format")
        line = (meta["line"]["lat0"], meta["line"]["lon0"]) if meta["line"] is not None else None
        return OwnTraces(z["numbers"].astype(int), int(meta["pad"]),
                         {r: z[f"trace_{r}"] for r in roles if r in meta["roles"]}, dict(meta["sources"]),
                         int(meta["length"]), line)


@dataclass
class PackedRun:
    """A session's clean laps ready to trace without its log: its pack and its compact traces, both up to date."""
    pack: LapPack
    own: OwnTraces
    only: frozenset[int] | None = None  # the laps that count as its clean laps (a pick of them); None: all

    def holds(self, numbers) -> bool:
        return all(n in self.pack.laps for n in numbers) and set(numbers) <= set(self.own.numbers.tolist())

    def clean_laps(self) -> list[Lap]:
        """Its clean laps in lap order, as the log's (only those picked, when only is set)."""
        return [l for n, l in self.pack.laps.items() if self.only is None or n in self.only]

    def window(self, number: int) -> SessionData:
        return window_data(self.pack, number)

    def trace(self, number: int, line: TrackLine | None, length: int, roles) -> dict[str, np.ndarray]:
        """align.aligned_trace(data, lap, line, length) for the roles asked for (those the session has): distance,
        time and the channels the pack keeps from the lap's own samples, every other role from its compact trace at
        the metre its samples put it on. NotCovered when the pack or the compact traces don't hold the lap."""
        i = np.flatnonzero(self.own.numbers == number)
        if not len(i):
            raise NotCovered(f"lap {number} has no compact trace")
        data = window_data(self.pack, number)
        tr = aligned_trace(data, data.laps[0], line, length)
        out = {k: v for k, v in tr.items() if k in ("distance", "t") or k in roles}
        j = tr["own"] + self.own.pad  # each metre of the line, as a metre of the compact trace
        for r in roles:
            if r in out or r not in self.own.traces:
                continue
            arr = self.own.traces[r][int(i[0])]
            if arr.dtype == np.int8:  # a state: the nearest metre's, as compact.laps_on
                out[r] = arr[np.clip(np.rint(j).astype(int), 0, len(arr) - 1)].astype(float)
            else:
                out[r] = np.interp(j, np.arange(len(arr), dtype=float), arr)
        return out


def matches(pack: LapPack, own: OwnTraces) -> bool:
    """Whether the pack and the compact traces were made from the same log on the same line (so its positions on that
    line are the compact traces' metres)."""
    return pack.length == own.length and pack.line == own.line
