"""Compact lap traces: what the report engine needs from a session, small enough to hold a whole test in memory.

A log is read once and reduced: every clean lap placed on the session's own track line (GPS) and resampled every
metre, with only the channels the engine reads, as float32 (int8 for states and flags). A 47-minute log at 100 Hz
holds about 100 MB of channels; its 13 clean laps reduce to about 3.5 MB, and a whole test (10 sessions, 116 laps)
to about 30 MB. The engine then runs on these without opening the logs again.

To analyse several sessions together, each session's laps are moved onto one line, the fastest lap's: its own line
is projected onto that one, which gives where each of its metres sits on the other.
"""
from __future__ import annotations

import io
import json
from dataclasses import dataclass, field, replace

import numpy as np

from app.heavy import release_memory
from app.analysis.align import MAX_OFFSET_M, TrackLine, lap_position, track_line
from app.analysis.channels import math_channels
from app.analysis.insights import LapRecord, Prepared, targets
from app.analysis.laps import MASTER_HZ, CornerSpec, SessionData, lap_length, load_session, make_sections
from app.analysis.scan import lap_medians
from app.importers.motec import LdFile

FORMAT = 2  # 2: accelerometers logged in m/s² (or g mislabelled) read as g
PAD_M = 40  # metres kept before the line and after it, so another session's line can start a little earlier or later
FLOAT_ROLES = ("speed", "ax", "ay", "curvature", "throttle", "brake", "steer", "understeer", "rear_slip",
               "front_lock", "slide_rate")
STATE_ROLES = ("phase", "gear", "braking", "coasting", "overlap", "tc_on", "abs_on")
TYRE_ROLES = tuple(f"tyre_{k}_{w}" for k in ("p", "t") for w in ("fl", "fr", "rl", "rr"))
EARTH_R = 6_371_000.0
LINE_SMOOTH_M = 151  # the offset between two sessions' lines is averaged over this many metres


@dataclass
class CompactSession:
    """One session's clean laps, each on the session's own line from PAD_M before it to PAD_M after it."""
    name: str
    length: int  # metres of the session's line: one lap
    numbers: np.ndarray  # lap numbers
    times: np.ndarray  # lap times as timed (s)
    index_in_run: np.ndarray  # 0 for the run's first clean lap
    traces: dict[str, np.ndarray]  # role -> [lap, metre]; "t" (float64, 0 on the line) and the roles above
    tyres: dict[str, np.ndarray] = field(default_factory=dict)  # role -> median per lap
    line: TrackLine | None = None
    driver: str | None = None
    units: dict[str, str] = field(default_factory=dict)  # role -> the logger channel's unit
    pad: int = PAD_M
    sources: dict[str, str] = field(default_factory=dict)  # role -> the logger channel it came from
    # every slow channel of the log, for the channel scan: name -> (unit, median per lap, typical spread in a lap)
    channels: dict[str, tuple[str, np.ndarray, float]] = field(default_factory=dict)

    @property
    def n_laps(self) -> int:
        return len(self.numbers)

    def nbytes(self) -> int:
        return sum(a.nbytes for a in self.traces.values())


def reduce_session(data: SessionData, name: str, driver: str | None = None, ld: LdFile | None = None,
                   medians: bool = True) -> CompactSession:
    """The session's clean laps on its own line (from its fastest clean lap), every metre. With the log, also the
    units of its channels and (unless medians is False) each lap's median of every channel it recorded, for the
    channel scan."""
    if "phase" not in data.channels:
        math_channels(data)
    c = data.channels
    clean = [l for l in data.laps if l.clean]
    units = {}
    if ld is not None:
        for role, ch_name in data.sources.items():
            ch = ld.channel(ch_name)
            if ch is not None and ch.unit:
                units[role] = ch.unit
    empty = CompactSession(name, 0, np.zeros(0, int), np.zeros(0), np.zeros(0, int), {}, driver=driver,
                           units=units, sources=dict(data.sources))
    if not clean:
        return empty
    ref = min(clean, key=lambda l: l.time)
    line = track_line(data, ref)
    length = line.length if line is not None else round(lap_length(data, ref))
    if length < 100:
        return empty
    grid = np.arange(-PAD_M, length + PAD_M + 1, dtype=float)
    n = len(clean)
    roles_f = [r for r in FLOAT_ROLES if r in c]
    roles_s = [r for r in STATE_ROLES if r in c]
    traces = {"t": np.empty((n, len(grid)))}
    traces.update({r: np.empty((n, len(grid)), np.float32) for r in roles_f})
    traces.update({r: np.empty((n, len(grid)), np.int8) for r in roles_s})
    tyres = {r: np.full(n, np.nan, np.float32) for r in TYRE_ROLES if r in c}
    for i, lap in enumerate(clean):
        idx, d = lap_position(data, lap, line, length)
        tt = data.t[idx]
        traces["t"][i] = np.interp(grid, d, tt) - np.interp(0.0, d, tt)
        for r in roles_f:
            traces[r][i] = np.interp(grid, d, c[r][idx])
        for r in roles_s:
            traces[r][i] = np.rint(np.interp(grid, d, c[r][idx]))
        i0, i1 = round(lap.start * MASTER_HZ), min(round(lap.end * MASTER_HZ), len(data.t) - 1)
        for r in tyres:
            tyres[r][i] = np.median(c[r][i0:i1 + 1])
    cs = CompactSession(name, length, np.array([l.number for l in clean]), np.array([l.time for l in clean]),
                        np.arange(n), traces, tyres, line, driver, units, PAD_M, dict(data.sources))
    if ld is not None and medians:
        cs.channels = channel_medians(ld, clean)
    return cs


def channel_medians(ld: LdFile, laps: list) -> dict[str, tuple[str, np.ndarray, float]]:
    return {k: (unit, med.astype(np.float32), sd) for k, (unit, med, sd) in lap_medians(ld, laps).items()}


KEEP_ROLES = {*FLOAT_ROLES, *STATE_ROLES, *TYRE_ROLES, "lat", "lon"}


def reduce_log(ld: LdFile, name: str, channel_map: dict | None = None, beacons: list[float] | None = None,
               line=None) -> CompactSession:
    """reduce_session straight from a log, in the order that needs the least memory: the full-rate channels the
    traces don't keep are dropped as soon as the math channels are made from them, and all of them are freed before
    every channel of the log is read for its lap medians."""
    data = load_session(ld, channel_map, beacons=beacons, line=line)
    math_channels(data)
    for role in [r for r in data.channels if r not in KEEP_ROLES]:
        del data.channels[role]
    release_memory()
    cs = reduce_session(data, name, ld=ld, medians=False)
    clean = [l for l in data.laps if l.clean]
    del data
    release_memory()
    if cs.n_laps:
        cs.channels = channel_medians(ld, clean)
    return cs


def keep_laps(cs: CompactSession, keep: np.ndarray) -> CompactSession:
    """The session with only the laps marked in keep (each keeps its place in the run)."""
    return replace(cs, numbers=cs.numbers[keep], times=cs.times[keep], index_in_run=cs.index_in_run[keep],
                   traces={k: v[keep] for k, v in cs.traces.items()}, tyres={k: v[keep] for k, v in cs.tyres.items()},
                   channels={k: (unit, med[keep], sd) for k, (unit, med, sd) in cs.channels.items()})


# ---------- storage ----------

def to_bytes(cs: CompactSession) -> bytes:
    meta = {"format": FORMAT, "name": cs.name, "driver": cs.driver, "length": cs.length, "pad": cs.pad,
            "units": cs.units, "roles": list(cs.traces), "tyres": list(cs.tyres), "sources": cs.sources,
            "line": {"lat0": cs.line.lat0, "lon0": cs.line.lon0} if cs.line is not None else None,
            "channels": [[k, unit, sd if np.isfinite(sd) else None] for k, (unit, _, sd) in cs.channels.items()]}
    arrays = {"meta": np.frombuffer(json.dumps(meta).encode(), np.uint8), "numbers": cs.numbers,
              "times": cs.times, "index_in_run": cs.index_in_run}
    if cs.channels:
        arrays["channel_medians"] = np.array([m for _, m, _ in cs.channels.values()], np.float32)
    arrays.update({f"trace_{k}": v for k, v in cs.traces.items()})
    arrays.update({f"tyre_{k}": v for k, v in cs.tyres.items()})
    if cs.line is not None:
        arrays["line_x"], arrays["line_y"] = cs.line.x.astype(np.float32), cs.line.y.astype(np.float32)
    buf = io.BytesIO()
    np.savez_compressed(buf, **arrays)
    return buf.getvalue()


def from_file(path_or_bytes) -> CompactSession:
    src = io.BytesIO(path_or_bytes) if isinstance(path_or_bytes, bytes) else path_or_bytes
    with np.load(src) as z:
        meta = json.loads(z["meta"].tobytes())
        if meta.get("format") != FORMAT:
            raise ValueError("Cached traces are in an older format")
        line = None
        if meta["line"] is not None:
            line = TrackLine(meta["line"]["lat0"], meta["line"]["lon0"], z["line_x"].astype(float),
                             z["line_y"].astype(float))
        meds = z["channel_medians"] if meta["channels"] else []
        channels = {k: (unit, meds[i], sd if sd is not None else np.nan)
                    for i, (k, unit, sd) in enumerate(meta["channels"])}
        return CompactSession(meta["name"], meta["length"], z["numbers"], z["times"], z["index_in_run"],
                              {k: z[f"trace_{k}"] for k in meta["roles"]},
                              {k: z[f"tyre_{k}"] for k in meta["tyres"]}, line, meta["driver"], meta["units"],
                              meta["pad"], meta["sources"], channels)


# ---------- several sessions on one line ----------

def _to_latlon(line: TrackLine) -> tuple[np.ndarray, np.ndarray]:
    lat = line.lat0 + np.degrees(line.y / EARTH_R)
    lon = line.lon0 + np.degrees(line.x / (EARTH_R * np.cos(np.radians(line.lat0))))
    return lat, lon


def _project(line: TrackLine, x: np.ndarray, y: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Where each point sits on the line, in metres to a fraction of a metre, and how far off it is."""
    lx, ly = line.x.astype(np.float32), line.y.astype(np.float32)
    n = len(lx)
    pos = np.empty(len(x))
    off = np.empty(len(x))
    for a in range(0, len(x), 500):
        px, py = x[a:a + 500].astype(np.float32), y[a:a + 500].astype(np.float32)
        d2 = (px[:, None] - lx) ** 2 + (py[:, None] - ly) ** 2
        j = d2.argmin(1)
        off[a:a + 500] = np.sqrt(d2[np.arange(len(j)), j])
        # along the line between the neighbouring points, for the fraction of a metre
        jm, jp = (j - 1) % n, (j + 1) % n
        ux, uy = lx[jp] - lx[jm], ly[jp] - ly[jm]
        frac = ((px - lx[j]) * ux + (py - ly[j]) * uy) / np.maximum(ux * ux + uy * uy, 1e-6) * 2
        pos[a:a + 500] = j + np.clip(frac, -1, 1)
    return pos, off


def positions_on(cs: CompactSession, line: TrackLine | None, length: int) -> np.ndarray:
    """For each metre 0..length of the target line, the matching metre of the session's own line (fractional;
    below 0 or beyond the session's length near the timing line)."""
    k = np.arange(length + 1, dtype=float)
    if line is None or cs.line is None:
        return k * cs.length / length  # no GPS: stretched, as laps are without GPS
    if cs.line is line:
        return k
    lat, lon = _to_latlon(cs.line)
    x, y = line.xy(lat, lon)
    g, off = _project(line, x, y)
    i = np.arange(len(g), dtype=float)
    expected = i * length / cs.length
    g = g + length * np.round((expected - g) / length)  # the line is a loop: take the copy nearest the expected
    good = (off <= MAX_OFFSET_M) & (np.abs(g - expected) < 200)
    if np.count_nonzero(good) < 0.5 * len(g):
        return k * cs.length / length  # the two lines don't match (a different layout?): stretched
    # Logged GPS moves in steps of a few metres, so both lines are stepped: only the slow change of the offset
    # between them is kept. It is the same at both ends of the lap, so it is smoothed round the loop.
    r = np.interp(i, i[good], (g - expected)[good])
    r = np.convolve(np.pad(r, LINE_SMOOTH_M // 2, mode="wrap"), np.ones(LINE_SMOOTH_M) / LINE_SMOOTH_M, "valid")
    g = np.maximum.accumulate(expected + r)
    s = np.interp(k, g, i)
    s = np.where(k < g[0], k - g[0], s)  # before the session line's first metre: one for one
    return np.where(k > g[-1], i[-1] + (k - g[-1]), s)


def laps_on(cs: CompactSession, line: TrackLine | None, length: int) -> list[dict[str, np.ndarray]]:
    """The session's laps on the target line, 0 to length metres both ends included, timed from 0 m."""
    j = positions_on(cs, line, length) + cs.pad
    n = cs.traces["t"].shape[1]
    base = np.arange(n, dtype=float)
    nearest = np.clip(np.rint(j).astype(int), 0, n - 1)
    out = []
    for i in range(cs.n_laps):
        tr: dict[str, np.ndarray] = {"distance": np.arange(length + 1, dtype=float)}
        t = np.interp(j, base, cs.traces["t"][i])
        tr["t"] = t - t[0]
        for r, arr in cs.traces.items():
            if r == "t":
                continue
            tr[r] = np.interp(j, base, arr[i]).astype(np.float32) if arr.dtype != np.int8 else arr[i][nearest]
        out.append(tr)
    return out


@dataclass
class Extras:
    """What the report needs besides the traces: per lap (by LapRecord.key) its session and tyre medians, per run
    its lap times and every slow channel's lap medians (for the channel scan), and the logger's units."""
    session_of: dict[str, int | None] = field(default_factory=dict)
    tyres: dict[str, dict[str, float]] = field(default_factory=dict)
    scan: list[tuple[str, list[float], dict[str, tuple[str, np.ndarray, float]]]] = field(default_factory=list)
    units: dict[str, str] = field(default_factory=dict)


def prepare_compact(sessions: list[tuple[int | None, CompactSession]], corners: list[CornerSpec] | None = None
                    ) -> tuple[Prepared, Extras] | None:
    """The engine's preparation (insights.prepare) from compact sessions: every clean lap on the fastest lap's line,
    the car's limits and the theoretical lap. Session names must be unique."""
    with_laps = [(sid, s) for sid, s in sessions if s.n_laps]
    if not with_laps:
        return None
    _, ref_s = min(with_laps, key=lambda p: float(p[1].times.min()))
    ref_i = int(np.argmin(ref_s.times))
    line, length = ref_s.line, ref_s.length
    laps, extras = [], Extras()
    reference = None
    for sid, s in with_laps:
        for i, tr in enumerate(laps_on(s, line, length)):
            x = LapRecord(s.name, int(s.numbers[i]), float(s.times[i]), s.driver, tr, int(s.index_in_run[i]))
            laps.append(x)
            extras.session_of[x.key] = sid
            extras.tyres[x.key] = {k: float(v[i]) for k, v in s.tyres.items() if np.isfinite(v[i])}
            if s is ref_s and i == ref_i:
                reference = x
        mapped = set(s.sources.values())  # the engine's own roles are measured lap by lap already
        extras.scan.append((s.name, [float(t) for t in s.times],
                            {k: v for k, v in s.channels.items() if k not in mapped}))
        extras.units = {**s.units, **extras.units}
    assert reference is not None
    t = targets(laps, reference.trace)
    sections, numbering = make_sections(reference.trace, corners)
    prep = Prepared(line, len(reference.trace["distance"]), reference, laps, t.limits, t.sim, sections, numbering,
                    t.perfect, t.held, t.realistic)
    return prep, extras
