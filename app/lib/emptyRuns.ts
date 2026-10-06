// Runs with no laps (server/app/empty_runs.py). A log that gives no laps because the car never did one (the pit
// lane, the garage, an out-lap and in-lap) isn't kept: the import lists it as skipped with the reason, and the
// single-file upload refuses it with the reason. A log of a car that did laps it couldn't time (no start/finish
// marker, no .ldx beacons, no known line) is kept, marked "untimed", until its laps are timed.
import type { ImportJob, SessionDetail } from '@/lib/api';

export type Untimed = {
  title: string; // "Laps not timed: the lap beacon is missing"
  reason: string; // "The car did about 16 laps (78 km at racing speed), but this log has no start/finish marker…"
  fix: string | null; // what times the laps: upload the .ldx with its beacons, or a log with the marker
  laps: number; // full laps the data shows
  racing_km: number;
};

// A run of an import kept with untimed laps.
export type UntimedRun = Untimed & { session_id: number; name: string | null; file: string };

// The session's logs kept with laps that couldn't be timed (none once the laps are timed).
export function untimedLogs(s: SessionDetail): (Untimed & { file: string })[] {
  return s.files.flatMap((f) => {
    const note = (f.meta as { untimed?: Untimed }).untimed;
    return note && !s.laps.some((l) => l.file_id === f.id) ? [{ ...note, file: f.filename }] : [];
  });
}

export const untimedRuns = (job: ImportJob): UntimedRun[] => (job as ImportJob & { untimed?: UntimedRun[] }).untimed ?? [];
