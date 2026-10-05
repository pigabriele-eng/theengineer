// Client for the setup sheets on the server: the car's template, a sheet per session, run-to-run changes against
// lap time and balance, the setup in the vehicle model, and ranked setup changes from driver feedback.
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

export type RunSummary = {
  balance: (PhaseBalance & { by_speed: (PhaseBalance & { speed: string })[]; gradient_per_g: number | null }) | null;
  corners: { code: string; apex_m: number; apex_kmh: number; speed: 'slow' | 'medium' | 'fast' }[];
  tc_s_per_lap?: number | null;
  abs_s_per_lap?: number | null;
  tyres?: { pressure_bar?: Record<string, number>; temperature_c?: Record<string, number> } | null;
  steer_channel?: string | null;
  steer_unit?: string;
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
};

export type Suggestion = {
  rank: number;
  lever: string;
  title: string;
  kind: string;
  changes: SetupChange[];
  reason: string;
  expected: string;
  model: string | null;
  watch: string;
  sources: ('driver' | 'data')[];
  score: number;
};

export type Suggestions = {
  session_id: number;
  template: string;
  has_setup: boolean;
  observations: Observation[];
  skipped_points: { id: number; text: string; why: string }[];
  suggestions: Suggestion[];
  notes: string[];
};

export type SetupVehicle = {
  session_id: number;
  name: string | null;
  preset: string;
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
  vehicle: (sessionId: number) => request<SetupVehicle>(`/sessions/${sessionId}/setup/vehicle`),
  suggestions: (sessionId: number) => request<Suggestions>(`/sessions/${sessionId}/setup/suggestions`),
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
