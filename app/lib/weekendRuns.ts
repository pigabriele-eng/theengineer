// What the race weekend page (During) works out from an event's runs: the latest run, each driver's latest timed run,
// the latest run's best lap against the event's best, and each run's debrief state. Pure, so `npm test` checks it.
import type { Folder, FolderSession } from './events';

// a run as the event's folder gives it, with its driver's id
type Run = FolderSession & { driver_id?: number | null };

/** A debrief of one of the event's runs, as GET /events/{id}/debriefs lists it. */
export type EventDebrief = {
  id: number;
  session_id: number;
  state: 'recorded' | 'ready' | 'failed';
  has_audio: boolean;
  points: number;
  created_at: string;
};

/** The event's runs in the order they were driven (the folder's day order, each day by time). */
export const runsInOrder = (folder: Folder | null | undefined): Run[] => folder?.days.flatMap((d) => d.sessions) ?? [];

/** The run driven last, timed or not (a run added by hand for its debrief counts). */
export const latestRun = (folder: Folder | null | undefined): Run | null => runsInOrder(folder).at(-1) ?? null;

/** The timed run driven last. */
export const latestTimedRun = (folder: Folder | null | undefined): Run | null =>
  runsInOrder(folder).filter((s) => s.best_lap_s != null && s.best_lap != null).at(-1) ?? null;

/** Each driver's latest timed run, the most recent first; runs with no driver set count as one driver. */
export function latestByDriver(folder: Folder | null | undefined): { driver: string | null; run: Run }[] {
  const latest = new Map<string, Run>();
  for (const s of runsInOrder(folder)) {
    if (s.best_lap_s == null || s.best_lap == null) continue;
    latest.set(s.driver_id != null ? `id:${s.driver_id}` : s.driver ? `name:${s.driver}` : 'none', s);
  }
  const order = runsInOrder(folder);
  return [...latest.values()].sort((a, b) => order.indexOf(b) - order.indexOf(a))
    .map((run) => ({ driver: run.driver, run }));
}

export type LapRef = { session_id: number; lap: number; name: string; time: number; driver: string | null };

const lapOf = (s: Run): LapRef => ({ session_id: s.id, lap: s.best_lap!, name: s.name, time: s.best_lap_s!,
  driver: s.driver });

/** The latest timed run's best lap and the lap it is held against: the event's best lap, or, when the latest run
 * holds it, the best lap of the event's other runs. Null with fewer than two timed runs. */
export function latestAgainstBest(folder: Folder | null | undefined): { latest: LapRef; best: LapRef; holdsBest: boolean } | null {
  const latest = latestTimedRun(folder);
  if (!latest) return null;
  const others = runsInOrder(folder).filter((s) => s.id !== latest.id && s.best_lap_s != null && s.best_lap != null)
    .sort((a, b) => a.best_lap_s! - b.best_lap_s!);
  if (!others.length) return null;
  const holdsBest = latest.best_lap_s! <= others[0].best_lap_s!;
  return { latest: lapOf(latest), best: lapOf(others[0]), holdsBest };
}

export type DebriefLine = {
  run: Run;
  state: 'ready' | 'recorded' | 'failed' | 'none';
  debrief: number | null; // the debrief a tap opens: the newest transcribed one, else the newest
  count: number;
};

/** One line per run, the latest first: its debrief state ("Transcript ready" once one is transcribed, "Recorded"
 * while one is being transcribed, "Not yet" without one) and the debrief a tap opens. */
export function debriefLines(folder: Folder | null | undefined, debriefs: EventDebrief[]): DebriefLine[] {
  return runsInOrder(folder).slice().reverse().map((run) => {
    const own = debriefs.filter((d) => d.session_id === run.id); // newest first, as the server sends them
    const ready = own.find((d) => d.state === 'ready');
    const state = ready ? 'ready' : own.some((d) => d.state === 'recorded') ? 'recorded' : own.length ? 'failed' : 'none';
    return { run, state, debrief: ready?.id ?? own[0]?.id ?? null, count: own.length };
  });
}

/** How many numbered sections the During view puts before the event page's own (Runs, Side by side, ...): three
 * things, the fastest runs of the latest session against each other (with where the time is and the traces when
 * there are two timed runs: latestAgainstBest says whether), the session reports, debriefs. */
export const duringSections = (folder: Folder | null | undefined) => (latestAgainstBest(folder) ? 6 : 4);

export type Stage = 'before' | 'during' | 'after';

const dayBefore = (iso: string) => {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10);
};

/** The weekend page's tab when none is asked for: Before while the event has no runs; During while it is on (today
 * within its days, or its newest run from today or yesterday); After once its last day has passed. */
export function defaultStage(folder: Folder | null | undefined, today: string): Stage {
  const runs = runsInOrder(folder);
  if (!folder || runs.length === 0) return 'before';
  const end = folder.end ?? folder.start;
  const start = folder.start ?? folder.end;
  const newest = runs.map((s) => s.date).filter((d): d is string => d != null).sort().at(-1) ?? null;
  if (newest != null && newest >= dayBefore(today)) return 'during';
  if (start != null && end != null && start <= today && today <= end) return 'during';
  if (end != null && end < today) return 'after';
  return 'during';
}
