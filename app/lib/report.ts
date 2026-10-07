// Client for the report (GET /reports/events/{id}, GET /reports/sessions/{id}): how to go faster, worked out by the
// server in the background from every clean lap of an event or of one session.
import { apiFetch, Session } from '@/lib/api';
import { apiFetchAgain } from '@/lib/retry';

export type ReportScope = { event: number } | { session: number };

export type Medal = 'gold' | 'silver' | 'bronze' | null;

export type Gain = {
  code: string;
  seconds: number; // a typical pass against the quick passes
  main_phase: string | null;
  action: string | null;
  advice: string[];
  fastest_lap_to_best: number;
};

export type Habit = {
  key: string;
  label: string;
  unit: string;
  phase: string;
  typical: number;
  quick: number;
  fastest_lap: number | null;
  theoretical: number | null;
  r: number | null;
  link: 'strong' | 'clear' | 'weak' | null;
  worth_s: number | null;
  used: boolean;
};

export type SectionReport = {
  code: string;
  start_m: number;
  end_m: number;
  apex_m: number | null;
  corners: string[];
  flat: boolean;
  times: {
    fastest_lap: number;
    best: number;
    best_lap: string; // "<run>#<lap>"
    typical: number;
    quick: number;
    realistic: number;
    theoretical: number;
  };
  quick_passes: number;
  gain_s: number;
  where: Record<string, number>; // phase -> seconds a typical pass loses to the quick passes
  main_phase: string | null;
  ladder: { driving: number; car: number; theoretical: number };
  headline: string | null;
  advice: string[];
  habits: Habit[];
  spread_s: number;
  loss_line: string;
};

export type Relation = {
  label: string;
  unit: string;
  text: string;
  seconds: number;
  r: number;
  n: number;
  p: number;
  sure: 'very sure' | 'sure' | 'fairly sure';
  compared: string;
  source: string;
  warm_up: boolean; // only over each run's first laps, while the car warms up
};

export type RunTrend = {
  run: string;
  session_id: number | null;
  driver: string | null;
  clean_laps: number;
  best: number;
  best_lap: number;
  median: number;
  consistency: number | null;
  extraction: number;
};

export type LapRow = { run: string; lap: number; time: number; index_in_run: number; extraction: number };

export type Report = {
  length_m: number;
  numbering: 'official' | 'detected';
  laps_analysed: number;
  runs_analysed: number;
  headline: {
    fastest: { time: number; run: string; lap: number; session_id: number | null };
    ideal: number;
    realistic: number;
    theoretical: number;
    typical: number;
    score: {
      extraction: number;
      medal: Medal;
      scores: Record<string, number>;
      next_medal: { medal: string; seconds_to_find: number } | null;
      realistic_extraction: number;
    };
  };
  summary: string;
  gains: Gain[];
  where_total: Record<string, number>;
  sections: SectionReport[];
  trace: {
    step_m: number;
    typical: number[];
    quick: number[];
    fastest_lap: number[];
    realistic: number[];
    theoretical: number[];
  };
  lap_time_relations: Relation[];
  trends: {
    runs: RunTrend[];
    laps: LapRow[];
    spread: { code: string; spread_s: number }[];
    consistency: number | null;
  };
  method: string[];
  corners: { code: string; at_m: number }[];
  laps_left_out?: number; // a long event is worked out from its quickest laps only
};

export type ReportStatus = 'ready' | 'queued' | 'running' | 'failed' | 'empty';

export type ReportSession = {
  id: number;
  name: string; // the run's label: its own name ("FP1 stint 1"), never a number (server/app/run_labels.py)
  short?: string; // the same for narrow places ("FP1 S1")
  day?: number | null; // the event's day it ran on, when the event has more than one
  driver: string | null;
  clean_laps: number;
  best: number | null;
  included: boolean;
  note: string | null;
};

export type ReportAnswer = {
  scope: 'event' | 'session';
  id: number;
  title: string;
  track: string | null;
  status: ReportStatus;
  progress: { done: number; total: number; current: string | null } | null;
  error: string | null;
  stale: boolean; // the report shown was made before the sessions last changed; a new one is being worked out
  report: Report | null;
  sessions: ReportSession[];
  runs?: RunName[]; // every run of the event, by its label, in the event page's order (a server before it: none)
};

/** A run by its own name, as the report calls it (server/app/run_labels.py). */
export type RunName = {
  id: number;
  name: string; // "FP1 stint 1", "Q1 · Gabriele Piana", "Day 2 · FP2 stint 1", "PTS 1"
  short: string; // "FP1 S1", "Q1 PIA", "D2 FP2 S1"
  day: number | null; // 1, 2, ... when the event ran over more than one day
  date: string | null;
  time: string | null; // HH:MM the log started
  driver: string | null;
};

const path = (scope: ReportScope) =>
  'event' in scope ? `/reports/events/${scope.event}` : `/reports/sessions/${scope.session}`;

async function call<T>(p: string, init?: RequestInit): Promise<T> {
  const res = init ? await apiFetch(p, init) : await apiFetchAgain(p); // a read is asked again while unanswered
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.detail ?? `Request failed (${res.status})`);
  }
  return res.json() as Promise<T>;
}

export const fetchReport = (scope: ReportScope) => call<ReportAnswer>(path(scope));
/** How far the report is, without the report itself (?brief): what a page waiting for it asks again and again. */
export type ReportProgress = Pick<ReportAnswer, 'status' | 'progress' | 'error' | 'stale'>;
export const fetchReportProgress = (scope: ReportScope) => call<ReportProgress>(`${path(scope)}?brief=true`);
export const refreshReport = (scope: ReportScope) => call<ReportAnswer>(`${path(scope)}/refresh`, { method: 'POST' });

// The Sessions tab groups sessions by event, with a report for each event.
export type EventInfo = { id: number; name: string; date: string | null; track_id: number | null };
export type SessionInEvent = Session & { event_id: number | null };
export const fetchEvents = () => call<EventInfo[]>('/events');

// "07_D2S2#13" -> "07_D2S2 lap 13"
export const lapName = (key: string) => {
  const i = key.lastIndexOf('#');
  return i < 0 ? key : `${key.slice(0, i)} lap ${key.slice(i + 1)}`;
};

export const PHASES = ['braking', 'entry', 'mid-corner', 'exit', 'full throttle'] as const;
