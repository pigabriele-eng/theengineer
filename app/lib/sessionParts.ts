// An event's official sessions (FP1, Q1, R1...) as the session reports list them: the types the server answers with
// (GET /reports/events/{id}/parts, server/app/run_parts.py), their order and their one-line summary. Pure, so it can
// be tested with `npm test`; the requests are in lib/sessionReports.ts.

/** One official session's report: the event and the session's code ("FP1", "Q1", "03_Q"). */
export type PartScope = { event: number; part: string };

export type PartStatus = 'ready' | 'queued' | 'running' | 'failed' | 'empty' | 'not started';

export type PartRun = {
  id: number;
  name: string; // the run's label on the event page ("FP1 stint 1")
  short: string; // "FP1 S1"
  driver: string | null;
  clean_laps: number;
  best: number | null;
};

/** An official session of the event. */
export type Part = {
  code: string; // "FP1", "Q1", "PQ", or a log folder's name ("03_Q") when the runs aren't named after the timetable
  title: string; // "FP1", "Pre-qualifying", "03_Q"
  official: boolean;
  runs: PartRun[]; // in the event page's order
  drivers: string[];
  driver_codes: string[]; // "PIA", "RAC"
  clean_laps: number;
  best: number | null;
  best_run: number | null;
  day: number | null;
  date: string | null; // ISO, of its first run
  time: string | null; // HH:MM its first run's log started
  status: PartStatus; // where its report is; "not started": opening it starts it
  ready: boolean;
  stale: boolean;
};

export type EventParts = {
  event_id: number;
  title: string;
  start: string | null; // the event's first and last day (ISO)
  end: string | null;
  parts: Part[]; // in the order they ran
};

/** Today as the phone has it (ISO). */
export const localToday = (now = new Date()) =>
  `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

/** Whether the weekend is on: today is one of its days. */
export const weekendOn = (answer: EventParts | null, today = localToday()) =>
  answer?.start != null && answer.end != null && answer.start <= today && today <= answer.end;

/** The sessions as listed: newest first while the weekend runs, else in timetable order. */
export function partsInOrder(answer: EventParts | null, today = localToday()): Part[] {
  if (!answer) return [];
  return weekendOn(answer, today) ? [...answer.parts].reverse() : answer.parts;
}

/** "PIA, RAC · 2 runs · best 1:43.60": who drove, how many runs and the best lap (`lap` formats a lap time). */
export function partSummary(p: Part, lap: (s: number) => string): string {
  const runs = `${p.runs.length} ${p.runs.length === 1 ? 'run' : 'runs'}`;
  return [p.driver_codes.join(', ') || null, runs, p.best != null ? `best ${lap(p.best)}` : 'no clean lap']
    .filter(Boolean).join(' · ');
}

/** What a session's report is doing, in a few words; null when there is nothing to say (ready, or not asked for yet:
 * opening it starts it). */
export function partState(p: Part): string | null {
  switch (p.status) {
    case 'queued':
    case 'running':
      return 'Being worked out';
    case 'failed':
      return 'Couldn’t be worked out';
    case 'empty':
      return 'No clean laps';
    default:
      return null;
  }
}
