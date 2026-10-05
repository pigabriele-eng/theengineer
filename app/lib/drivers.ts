// Drivers on sessions (who drove each run) and the driver comparison over many laps (POST /compare/drivers/jobs).
import { apiFetch, Session } from '@/lib/api';

export type Driver = { id: number; name: string };

// Sessions from GET /sessions carry these too; the shared Session type leaves them out.
export type Tagged = Session & { driver_id?: number | null; event_id?: number | null };

export type EventRow = { id: number; name: string; date: string | null; track_id: number | null };

// One driver for a session: an existing one by id, or by name (an existing driver of that name, else a new one).
// Neither clears the driver.
export type DriverPick = { driver_id?: number | null; driver_name?: string };

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await apiFetch(path, init);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const detail = Array.isArray(body.detail) ? body.detail.map((d: { msg: string }) => d.msg).join('; ') : body.detail;
    throw new Error(detail ?? `Request failed (${res.status})`);
  }
  return (res.status === 204 ? undefined : res.json()) as Promise<T>;
}

const send = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

export const driversApi = {
  list: () => request<Driver[]>('/drivers'),
  events: () => request<EventRow[]>('/events'),
  // Many sessions at once: a selection, whole events, or both.
  assign: (pick: DriverPick, sessionIds: number[], eventIds: number[] = []) =>
    request<{ driver: Driver | null; session_ids: number[] }>(
      '/drivers/assign',
      send('POST', { ...pick, session_ids: sessionIds, event_ids: eventIds }),
    ),
  setSession: (sessionId: number, pick: DriverPick) =>
    request<{ driver: Driver | null; session_ids: number[] }>(`/sessions/${sessionId}/driver`, send('PUT', pick)),
  remove: (driverId: number) => request<void>(`/drivers/${driverId}`, { method: 'DELETE' }),
};

// ---------- comparison ----------

export type Side = 'a' | 'b';
export const SIDES: Side[] = ['a', 'b'];

export type OptionSession = {
  id: number;
  name: string;
  event_id: number | null;
  event: string | null;
  date: string | null;
  driver_id: number | null;
  driver: string | null;
  clean_laps: number;
  best: number;
};

export type OptionGroup = {
  track_id: number | null;
  track: string | null;
  car_id: number | null;
  car: string | null;
  laps: number;
  sessions: OptionSession[];
  drivers: { id: number; name: string; sessions: number; laps: number; best: number }[];
};

export type Phase = 'braking' | 'trail' | 'mid' | 'exit' | 'power';

// Where in a section time goes, as "mostly <...>"
export const PHASE_NAME: Record<Phase, string> = {
  braking: 'in the braking',
  trail: 'at turn-in',
  mid: 'mid-corner',
  exit: 'on the exit',
  power: 'on the straight after',
};

// The same, as a short label for a split by phase
export const PHASE_SHORT: Record<Phase, string> = {
  braking: 'braking',
  trail: 'turn-in',
  mid: 'mid-corner',
  exit: 'exit',
  power: 'straight after',
};

export type TechniqueRow = {
  metric: string;
  label: string;
  unit: string;
  better: boolean | null; // true when a higher value is quicker, null when it is a matter of style
  a: number;
  b: number;
  diff: number; // a minus b
  worth_s: number | null; // seconds a's typical value costs (+) or gains (−) against b's, when lap times show it
  r: number | null;
  explains: boolean; // worth points the same way as the section's delta
};

export type SectionResult = {
  code: string;
  start_m: number;
  end_m: number;
  apex_m: number | null;
  anchor_m: number; // positions in the technique rows are metres from here (the slowest point), − before it
  corners: string[];
  median: Record<Side, number>;
  best: Record<Side, number>;
  spread: Record<Side, number>;
  delta_s: number; // median a minus median b: + means a is slower here
  faster: Side;
  beats: Record<Side, number>; // share of each side's laps quicker than the other side's median lap here
  consistency: number; // beats of the quicker side
  clear: boolean;
  gap_by_phase: Record<Phase, number>;
  main_phase: Phase;
  theoretical: number;
  technique: TechniqueRow[];
  why: TechniqueRow | null;
  times: Record<Side, number[]>; // section time of every lap, in the order of Comparison.laps for that side
};

export type HabitSection = {
  code: string;
  laps: number;
  of: number;
  share: number;
  cost_s: number; // each time it happens
  basis: 'own laps' | 'all laps';
  per_lap_s: number;
  value: number;
  quick: number | null;
};

export type Habit = {
  kind: string;
  label: string;
  unit: string;
  advice: string;
  per_lap_s: number;
  sections: HabitSection[];
};

export type SideSummary = {
  label: string;
  laps: number;
  runs: number;
  best: number;
  median: number;
  consistency: number | null;
  median_extraction: number;
  style: Record<string, number>;
};

export type Comparison = {
  track: string | null;
  labels: Record<Side, string>;
  length_m: number;
  numbering: 'official' | 'detected';
  median_gap_s: number;
  typical_gap_s: number;
  summary: Record<Side, SideSummary>;
  sections: SectionResult[];
  habits: Record<Side, Habit[]>;
  laps: { side: Side; run: string; lap: number; time: number }[];
  runs: { run: string; side: Side; session_id: number; session: string; laps: number; best: number | null;
    median: number | null }[];
  delta_trace: { step_m: number; gap_s: number[] };
  speed_trace: { step_m: number; a: number[]; b: number[] };
};

export type CompareJob = {
  id: string;
  status: 'queued' | 'running' | 'done' | 'failed';
  total: number;
  done: number;
  current: string | null;
  error: string | null;
  result: Comparison | null;
};

export type CompareSide = { label: string; session_ids: number[] };

export const compareApi = {
  options: () => request<OptionGroup[]>('/compare/options'),
  start: (a: CompareSide, b: CompareSide) => request<CompareJob>('/compare/drivers/jobs', send('POST', { a, b })),
  job: (id: string) => request<CompareJob>(`/compare/drivers/jobs/${id}`),
};

// ---------- words ----------

export const seconds = (v: number, digits = 2) => `${v > 0 ? '+' : v < 0 ? '−' : '±'}${Math.abs(v).toFixed(digits)} s`;
export const pct = (v: number) => `${Math.round(v * 100)}%`;

const POSITIONS = new Set(['brake_point', 'throttle_on', 'full_throttle']);

// "4 m later", "0.12 s more", "3.1 km/h higher": the first side against the second, in plain words.
export function differenceWords(row: TechniqueRow): string {
  const d = row.diff;
  const mag = Math.abs(d);
  if (mag < 1e-9) return 'same';
  const n = (v: number) => (v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2));
  if (POSITIONS.has(row.metric)) return `${n(mag)} m ${d > 0 ? 'later' : 'earlier'}`;
  const unit = row.unit === '%' ? ' pts' : row.unit ? ` ${row.unit}` : '';
  if (row.unit === 's') return `${n(mag)} s ${d > 0 ? 'more' : 'less'}`;
  return `${n(mag)}${unit} ${d > 0 ? 'higher' : 'lower'}`;
}

// A technique value for one side: positions as metres before (−) or after the slowest point.
export function valueWords(row: TechniqueRow, v: number): string {
  if (POSITIONS.has(row.metric)) return `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(0)} m`;
  const mag = Math.abs(v);
  const digits = row.unit === 's' ? 2 : mag >= 100 ? 0 : mag >= 10 ? 1 : 2;
  return row.unit ? `${v.toFixed(digits)} ${row.unit}` : v.toFixed(digits);
}

export function habitValueWords(h: Habit, s: HabitSection): string {
  const v = s.value;
  const quick = (digits: number, unit: string) => (s.quick != null ? `, ${s.quick.toFixed(digits)}${unit} on the quick laps` : '');
  switch (h.kind) {
    case 'early_lift':
      return `lifting ${v.toFixed(2)} s before braking${quick(2, ' s')}`;
    case 'coast_turn_in':
    case 'coast_mid':
      return `coasting ${v.toFixed(2)} s${quick(2, ' s')}`;
    case 'tc_exit':
      return `traction control working ${v.toFixed(2)} s${quick(2, ' s')}`;
    case 'overlap':
      return `both pedals together ${v.toFixed(2)} s${quick(2, ' s')}`;
    case 'early_brake':
      return `braking ${v.toFixed(0)} m earlier than the quick laps`;
    case 'late_throttle':
      return `on the throttle ${v.toFixed(0)} m later than the quick laps`;
    case 'scattered_brakes':
      return `braking ${v.toFixed(0)} m away from the usual point`;
    case 'slow_throttle':
      return `throttle in at ${v.toFixed(0)} %/s${quick(0, ' %/s')}`;
    case 'no_trail':
      return `${v.toFixed(0)}% of braking done turning, ${s.quick?.toFixed(0)}% on the quick laps`;
    case 'lift_fast':
      return `down to ${v.toFixed(0)}% throttle, ${s.quick?.toFixed(0)}% on the quick laps`;
    case 'steering_corrections':
      return `steering corrections ${v.toFixed(1)}${quick(1, '')}`;
    default:
      return `${v.toFixed(2)}${quick(2, '')}`;
  }
}
