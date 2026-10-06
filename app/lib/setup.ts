// Client for the setup sheets on the server: the car's template, a sheet per session, run-to-run changes against
// lap time and balance, the setup in the vehicle model, and ranked setup changes from the debrief and the data.
import { apiFetch } from '@/lib/api';
import { Vehicle } from '@/lib/vehicle';

export type Confidence = 'published' | 'estimate' | 'unknown';

export type TemplateRow = {
  key: string;
  label: string;
  unit: string;
  layout: 'single' | 'axle' | 'corner';
  kind: 'number' | 'position' | 'choice';
  min: number | null;
  max: number | null;
  step: number;
  options: { value: number; label: string }[];
  up: string | null; // what a higher number means: stiffer, softer, more downforce...
  note: string;
  confidence: Confidence;
  fields: { key: string; at: string | null }[]; // at: front, rear, fl, fr, rl, rr, or null for a single value
};

export type Template = {
  key: string;
  name: string;
  vehicle_preset: string | null;
  groups: { name: string; rows: TemplateRow[] }[];
};

export type SetupValues = Record<string, number>;

export type SetupChange = {
  key: string;
  label: string;
  unit: string;
  from: number | null;
  to: number | null;
  delta?: number | null;
  text: string;
};

export type Sheet = {
  session_id: number;
  exists: boolean;
  template: string;
  values: SetupValues;
  notes: string | null;
  copied_from_session_id: number | null;
  updated_at: string | null;
  previous: { session_id: number; name: string | null; values: SetupValues; template: string } | null;
  changes: SetupChange[];
  warnings: { key: string; text: string }[];
};

type PhaseBalance = { entry: number | null; mid: number | null; exit: number | null };

// A run's balance, from the balance report's analysis of its log (GET /report/balance builds the same): the car's
// understeer per g of cornering, and the balance against that normal in each phase (+ pushes, − the rear slides).
export type RunSummary = {
  balance:
    | (PhaseBalance & {
        gradient_per_g: number | null;
        spread?: number;
        by_speed: (PhaseBalance & { speed: string })[];
      })
    | null;
  tc_s_per_lap?: number | null;
  abs_s_per_lap?: number | null;
  steering?: { value: number | null; source: string; confidence: string; reads: string } | null;
  note?: string;
};

export type LapNumbers = { clean_laps: number; best_s: number | null; top3_s: number | null };

export type RunDeltas = {
  best_s: number | null;
  top3_s: number | null;
  balance: PhaseBalance & { gradient_per_g: number | null };
  tc_s_per_lap: number | null;
  abs_s_per_lap: number | null;
};

export type HistoryRun = {
  session_id: number;
  name: string | null;
  run_time: string;
  has_setup: boolean;
  template: string | null;
  values: SetupValues | null;
  laps: LapNumbers;
  summary: RunSummary | null;
  needs_summary: boolean;
  compared_with: { session_id: number; name: string | null } | null;
  changes: SetupChange[];
  deltas: RunDeltas | null;
};

export type History = { session_id: number; event_id: number | null; runs: HistoryRun[] };

export type Observation = {
  kind: string;
  phase: string | null;
  corner: string | null;
  speed: string | null;
  weight: number;
  source: 'driver' | 'data';
  text: string;
  time_s: number | null;
  label: string;
  // a driver remark against the run's balance report: agree, slight (leans the same way), normal, disagree, unmeasured
  check?: { verdict: 'agree' | 'slight' | 'normal' | 'disagree' | 'unmeasured'; text: string; value?: number } | null;
};

export type Suggestion = {
  rank: number;
  lever: string;
  title: string;
  kind: string;
  changes: SetupChange[];
  reason: string; // the remarks behind it
  data_shows: string | null; // what the run's data measures that backs it
  confirmed: string[]; // the data's reading of the driver's remarks, where it agrees
  report: { rank: number; key: string; title: string; why: string; expect: string } | null; // the balance report's
  expected: string;
  model: string | null;
  watch: string;
  agreement: 'both' | 'driver' | 'data' | 'disagree';
  disagree: string[];
  sources: ('driver' | 'data')[];
  score: number;
};

export type Suggestions = {
  session_id: number;
  template: string;
  has_setup: boolean;
  observations: Observation[];
  measured: Observation[];
  skipped_points: { id: number; text: string; why: string }[];
  suggestions: Suggestion[];
  notes: string[];
  data: { headline: string | null; notes: string[]; checks: { label: string; value: string }[] } | null;
};

export type SetupVehicle = {
  session_id: number;
  name: string | null;
  preset: string | null;
  vehicle_model: { id: number; name: string } | null; // the garage vehicle whose specs it starts from
  vehicle: Vehicle;
  applied: { field: string; value: number; from: string }[];
  notes: string[];
};

export type SetupListItem = { session_id: number; name: string | null; template: string; run_time: string };

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await apiFetch(path, init);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const detail = body.detail;
    const message = Array.isArray(detail)
      ? detail.map((d: { loc?: string[]; msg: string }) => `${d.loc?.slice(-1)[0] ?? ''}: ${d.msg}`).join('; ')
      : detail;
    throw new Error(message ?? `Request failed (${res.status})`);
  }
  return res.json() as Promise<T>;
}

const send = (method: string, body?: unknown): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body),
});

export const setupApi = {
  templates: () => request<{ key: string; name: string }[]>('/setup/templates'),
  template: (key: string) => request<Template>(`/setup/templates/${key}`),
  withSheets: () => request<SetupListItem[]>('/setups'),
  sheet: (sessionId: number) => request<Sheet>(`/sessions/${sessionId}/setup`),
  save: (sessionId: number, body: { template?: string; values: Record<string, number | null>; notes?: string | null }) =>
    request<Sheet>(`/sessions/${sessionId}/setup`, send('PUT', body)),
  copyPrevious: (sessionId: number) => request<Sheet>(`/sessions/${sessionId}/setup/copy-previous`, send('POST')),
  history: (sessionId: number) => request<History>(`/sessions/${sessionId}/setup/history`),
  results: (sessionId: number) =>
    request<{ session_id: number; laps: LapNumbers; summary: RunSummary }>(`/sessions/${sessionId}/setup/results`),
  /** The run's setup as vehicle model inputs, on top of the vehicle named (else the session's) or the preset. */
  vehicle: (sessionId: number, vehicleId?: number | null) =>
    request<SetupVehicle>(
      `/sessions/${sessionId}/setup/vehicle${vehicleId != null ? `?vehicle_model_id=${vehicleId}` : ''}`,
    ),
  suggestions: (sessionId: number, vehicleId?: number | null) =>
    request<Suggestions>(
      `/sessions/${sessionId}/setup/suggestions${vehicleId != null ? `?vehicle_model_id=${vehicleId}` : ''}`,
    ),
};

// '+0.12', '−0.30', '–' for nothing. A real minus sign keeps the columns aligned.
export const signed = (v: number | null | undefined, digits = 2) => {
  if (v == null) return '–';
  const shown = Math.abs(v).toFixed(digits);
  return `${Number(shown) === 0 ? '±' : v > 0 ? '+' : '−'}${shown}`;
};

export const POSITION_LABEL: Record<string, string> = {
  front: 'Front',
  rear: 'Rear',
  fl: 'FL',
  fr: 'FR',
  rl: 'RL',
  rr: 'RR',
};

// A stored value as the sheet shows it: an option's name, or the number.
export function showValue(row: TemplateRow, v: number | null | undefined): string {
  if (v == null) return '–';
  if (row.kind === 'choice') return row.options.find((o) => o.value === v)?.label ?? String(v);
  return String(v);
}

export const runDate = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ''
    : d.toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
};
