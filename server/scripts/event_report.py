"""Summarise a folder of MoTeC runs from one track into a JSON report.

    python scripts/event_report.py <folder> <out.json>

Each sub-folder is one run; the longest .ld in it is used. Laps are timed on one start/finish line for all
runs (learned from the first log with a lap marker), so corners line up across runs.
"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.analysis.event import Run, summarize
from app.analysis.laps import lap_starts, load_session, timing_line_at
from app.importers.motec import read_ld


def main(folder: str, out: str) -> None:
    runs_dirs = sorted(p for p in Path(folder).iterdir() if p.is_dir())
    logs = {}
    for d in runs_dirs:
        lds = [read_ld(p) for p in sorted(d.glob("*.ld"))]
        if lds:
            logs[d.name] = max(lds, key=lambda ld: ld.duration)
    line = None
    for ld in logs.values():
        starts, source = lap_starts(ld)
        if source == "marker":
            line = timing_line_at(ld, list(starts))
            break
    runs = []
    for name, ld in logs.items():
        data = load_session(ld, line=line)
        runs.append(Run(name, data, ld, {"date": ld.date, "time": ld.time, "session": ld.event_session,
                                         "event": ld.event_name, "venue": ld.venue}))
    report = summarize(runs)
    report["timing_line"] = line.__dict__ if line else None
    Path(out).write_text(json.dumps(report, indent=1))
    print(f"{len(runs)} runs, reference {report['reference']}, ideal {report['ideal_lap']}")


if __name__ == "__main__":
    main(*sys.argv[1:3])
