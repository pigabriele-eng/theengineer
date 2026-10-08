// Client for the Compare screen: laps from any sessions at one track (GET /compare/sessions, POST /compare/laps).
import { apiFetch, CornerNumbering, formatLap } from '@/lib/api';
import { byScheme } from '@/constants/Theme';
import type { TheoreticalAnswer } from '@/lib/theoretical';

export const MIN_LAPS = 2;
export const MAX_LAPS = 6;

export type PickableLap = { number: number; time: number; clean: boolean };

export type PickableSession = {
  id: number;
  name: string;
  driver: string | null;
  event: string | null;
  date: string | null; // ISO date of the log
  best_lap: number;
  best_time: number;
  laps: PickableLap[];
};

// Sessions grouped by track: only laps from one track can be compared.
export type TrackGroup = { key: string; track: string | null; sessions: PickableSession[] };

export type Phase = 'braking' | 'entry' | 'mid-corner' | 'exit' | 'full throttle';

export type Difference = {
  metric: string;
  text: string; // plain words, e.g. "brakes 12 m earlier"
  value: number;
  unit: string;
  lap: number;
  versus: number;
};

export type Opportunity = {
  code: string; // official corner numbers, e.g. "T8/T9" or "T2-T5"
  loss_s: number;
  versus: number; // index of the quickest other lap in this section
  phase: Phase;
  phase_loss_s: number;
  by_phase: Record<Phase, number>;
  where_m: [number, number]; // the 100 m where most of it goes
  differences: Difference[];
};

export type ComparedLap = {
  session_id: number;
  session: string;
  driver: string | null;
  event: string | null;
  lap: number;
  time: number;
  clean: boolean;
  sections_best: number;
};

export type TraceRole = 'speed' | 'throttle' | 'brake' | 'steer' | 'gear';
export type LapTrace = { t: number[] } & Partial<Record<TraceRole, number[]>>;

export type CompareSection = {
  code: string;
  start_m: number;
  end_m: number;
  apex_m: number | null;
  corners: string[];
  times: number[]; // per lap, in pick order
  best: number; // index of the quickest lap here
};

export type CompareResult = {
  track: string | null;
  length_m: number;
  numbering: CornerNumbering;
  aligned_by: 'gps' | 'wheel speed';
  reference: number; // the quickest lap: its path is the line every lap is placed on
  laps: ComparedLap[];
  sections: CompareSection[];
  corners: { code: string; apex_m: number }[]; // one per section
  track_corners: { code: string; apex_m: number }[]; // every official corner
  opportunities: { sections: Opportunity[] }[];
  channels: Partial<Record<TraceRole, string>>;
  traces: { step_m: number; distance: number[]; laps: LapTrace[]; roles: TraceRole[] };
};

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await apiFetch(path, init);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const detail = body.detail;
    // FastAPI sends a list for request validation errors
    throw new Error(typeof detail === 'string' ? detail : `Request failed (${res.status})`);
  }
  return res.json() as Promise<T>;
}

export const fetchPickable = () => request<{ tracks: TrackGroup[] }>('/compare/sessions').then((r) => r.tracks);

export const compareLaps = (laps: { session_id: number; lap: number }[]) =>
  request<CompareResult>('/compare/laps', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ laps }),
  });

// the stint and combined theoretical laps of the laps compared (lib/theoretical.ts)
export const fetchTheoretical = (laps: { session_id: number; lap: number }[]) =>
  request<TheoreticalAnswer>('/compare/theoretical', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ laps }),
  });

// Categorical slots 1-6 of the validated chart palette (light and dark steps). A lap keeps its slot while it is
// picked, so removing one lap never repaints the others.
export const LAP_COLORS = byScheme((c) => c.chart.series.slice(0, 6));

export const lapLabel = (l: { session: string; lap: number; driver: string | null }) =>
  `${l.session} · L${l.lap}${l.driver ? ` · ${l.driver}` : ''}`;

export const signedSeconds = (v: number, digits = 2) =>
  `${v > 0 ? '+' : v < 0 ? '−' : '±'}${Math.abs(v).toFixed(digits)}`;

export { formatLap };

// "picks" in the URL: session.lap pairs, e.g. "8.7,3.9"
export const encodePicks = (picks: { session_id: number; lap: number }[]) =>
  picks.map((p) => `${p.session_id}.${p.lap}`).join(',');

export const decodePicks = (text: string | undefined) =>
  (text ?? '')
    .split(',')
    .map((s) => s.split('.').map(Number))
    .filter(([s, l]) => Number.isInteger(s) && Number.isInteger(l))
    .map(([session_id, lap]) => ({ session_id, lap }));
