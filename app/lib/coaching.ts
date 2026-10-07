// Client for coaching (GET /coaching/sessions/{id}/top and .../fixed): the three things to change on the next run,
// each at a different corner with what to do instead and what it is worth a lap; and "did we fix it", the previous
// run's three things checked on this run. Both read the technique check, which the server works out in the background.
import { apiFetch } from '@/lib/api';
import type { Phase, TechniqueStatus } from '@/lib/technique';

export type CoachRun = { id: number; name: string; driver: string | null; laps: number; best: number | null };

export type Thing = {
  rank: number;
  key: string; // "<code>:<kind>"
  code: string; // corner number or section ("T8-T10")
  kind: string;
  phase: Phase;
  title: string;
  laps: number; // on how many of the run's clean laps
  of: number;
  gain_s: number; // what it costs a lap, on average over the run's clean laps
  value: number | null;
  unit: string | null;
  what?: string; // on the lap where it cost the most, with the numbers
  do?: string; // what to do instead
  lap?: number;
};

export type Verdict = 'fixed' | 'better' | 'not yet';

export type FixedThing = {
  rank: number;
  key: string;
  code: string;
  kind: string;
  phase: Phase;
  title: string;
  do?: string;
  before: { cost_s: number; laps: number; of: number; value: number | null };
  after: { cost_s: number; laps: number; of: number; value: number | null };
  gained_s: number;
  verdict: Verdict;
  unit: string | null;
};

type Head = { status: TechniqueStatus; error: string | null; progress: { done: number; total: number } | null };

export type TopAnswer = Head & { session: CoachRun; things: Thing[]; gain_s: number };
export type FixedAnswer = Head & {
  session: CoachRun;
  previous: CoachRun | null;
  things: FixedThing[];
  gained_s: number | null;
  note?: string;
};

async function get<T>(path: string): Promise<T> {
  const res = await apiFetch(path);
  if (!res.ok) throw new Error((await res.json().catch(() => null))?.detail ?? `HTTP ${res.status}`);
  return (await res.json()) as T;
}

export const fetchTop = (sessionId: number) => get<TopAnswer>(`/coaching/sessions/${sessionId}/top`);

export const fetchFixed = (sessionId: number, previous?: number | null) =>
  get<FixedAnswer>(`/coaching/sessions/${sessionId}/fixed${previous != null ? `?previous=${previous}` : ''}`);

export const working = (s: TechniqueStatus) => s === 'queued' || s === 'running';
