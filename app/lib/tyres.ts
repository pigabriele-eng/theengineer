// Client for the tyre tools on the server (/tyres/...): pressure calculator, P-Book minimums, tyre temperatures.
import { API_URL } from './api';

export const CORNERS = ['FL', 'FR', 'RL', 'RR'] as const;
export type Corner = (typeof CORNERS)[number];
export type Axle = 'front' | 'rear';
export type PerCorner<T> = Partial<Record<Corner, T>>;

export type CornerRun = {
  corner: Corner;
  start_s: number;
  cold_bar: number;
  cold_c: number | null;
  hot_bar: number | null;
  hot_c: number | null;
  rise_bar: number | null;
  running_s: number;
  gas_law_hot_bar: number | null;
  used: boolean;
  note: string | null;
};

// One cold start in a log: set 0 is the tyres the car left on, set 1 the next set fitted at a stop.
export type LoggedRun = {
  session_id: number;
  session: string;
  file_id: number;
  file: string;
  set: number;
  start_s: number;
  ambient_c: number | null;
  ambient_source: string | null;
  track_c: number | null;
  atmospheric_bar: number | null;
  corners: PerCorner<CornerRun>;
};

export type RunSummary = {
  runs: number;
  median_cold_bar?: number;
  median_cold_c?: number;
  median_hot_bar?: number;
  median_hot_c?: number;
  median_rise_bar?: number;
};

export type MinimumRow = {
  tyre: string | null;
  axle: Axle;
  cold_min_bar: number | null;
  hot_min_bar: number | null;
  source: string | null;
};

// A figure from an older public Pirelli booklet: shown for reference only, never as the DHG P_Book value.
export type Reference = { text: string; source: string };

export type Minimums = {
  series: string | null;
  rows: MinimumRow[];
  origin: 'entered' | 'presets' | null;
  series_list: string[];
  message?: string;
  reference: Reference;
};

export type PressureInput = {
  targets: PerCorner<number>;
  hot_c?: PerCorner<number>;
  set_c?: number;
  ambient_c?: number;
  track_c?: number;
  atmospheric_bar?: number;
  series?: string;
  car_id?: number;
};

export type CornerPlan = {
  corner: Corner;
  axle: Axle;
  target_hot_bar: number;
  gas_law: {
    cold_bar: number | null;
    hot_c: number | null;
    hot_c_source: string | null;
    text: string;
    runs_note?: string;
  };
  data: {
    cold_bar: number | null;
    rise_bar?: number;
    runs: number;
    typical_error_bar?: number | null;
    text: string;
    extrapolating?: boolean;
  };
  flags: string[];
};

export type PressurePlan = {
  atmospheric_bar: number;
  set_c: number | null;
  set_c_source: string | null;
  corners: CornerPlan[];
  minimums: {
    series: string | null;
    rows: MinimumRow[];
    origin: string | null;
    message?: string;
    reference: Reference;
  };
  runs_used: number;
};

export type Reading = { inside: number; middle: number; outside: number; pressure_bar?: number; camber_deg?: number };

export type TyreAdvice = {
  corner: Corner;
  inside: number;
  middle: number;
  outside: number;
  average_c: number;
  camber: { spread_c: number; target_spread_c: number; verdict: string; text: string; references: Reference[] };
  pressure: { middle_vs_edges_c: number; verdict: string; text: string; below_minimum?: boolean };
};

export type TempAnalysis = {
  source: string;
  file?: string;
  tyres: TyreAdvice[];
  balance: { kind: 'axle' | 'side'; difference_c: number; text: string; references: Reference[] }[];
  target_spread_c: Record<Axle, number>;
  target_spread_source: string;
};

export type TempSettings = { target_spread_c: number; target_spread_source: string; reference: Reference };

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, init);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const detail = Array.isArray(body.detail) ? body.detail.map((d: { msg: string }) => d.msg).join('; ') : body.detail;
    throw new Error(detail ?? `Request failed (${res.status})`);
  }
  return res.json() as Promise<T>;
}

const send = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

export const tyres = {
  runs: (carId?: number) =>
    request<{ runs: LoggedRun[]; summary: PerCorner<RunSummary> }>(
      `/tyres/runs${carId != null ? `?car_id=${carId}` : ''}`,
    ),
  setConditions: (sessionId: number, body: { ambient_temp_c?: number | null; track_temp_c?: number | null }) =>
    request<{ ambient_temp_c: number | null; track_temp_c: number | null }>(
      `/sessions/${sessionId}/conditions`,
      send('PATCH', body),
    ),
  minimums: (series?: string) =>
    request<Minimums>(`/tyres/minimums${series ? `?series=${encodeURIComponent(series)}` : ''}`),
  saveMinimums: (series: string, rows: MinimumRow[]) =>
    request<Minimums>('/tyres/minimums', send('PUT', { series, rows })),
  pressures: (input: PressureInput) => request<PressurePlan>('/tyres/pressures', send('POST', input)),
  tempSettings: () => request<TempSettings>('/tyres/temps/settings'),
  analyzeTemps: (body: {
    readings: PerCorner<Reading>;
    target_spread_c?: Partial<Record<Axle, number>>;
    series?: string;
  }) => request<TempAnalysis>('/tyres/temps', send('POST', body)),
  logTemps: (sessionId: number, spread: Partial<Record<Axle, number>> = {}) => {
    const q = new URLSearchParams();
    if (spread.front != null) q.set('spread_front', String(spread.front));
    if (spread.rear != null) q.set('spread_rear', String(spread.rear));
    return request<TempAnalysis>(`/sessions/${sessionId}/tyre-temps?${q}`);
  },
};

// A typed number, or undefined when the field is empty or not a number (a decimal comma is accepted).
export const num = (s: string | undefined): number | undefined => {
  const t = (s ?? '').trim().replace(',', '.');
  if (!t) return undefined;
  const n = Number(t);
  return Number.isFinite(n) ? n : undefined;
};

const CORNER_NAMES: Record<string, Corner> = { FL: 'FL', LF: 'FL', FR: 'FR', RF: 'FR', RL: 'RL', LR: 'RL', RR: 'RR' };

// Pasted pyrometer readings, one tyre per line: "FL 92 88 84" (inside, middle, outside), optionally followed by the
// hot pressure and the camber: "FL 92 88 84 1.85 -3.5". Spaces, tabs or semicolons between values.
export function parsePyrometer(text: string): { readings: PerCorner<Reading>; errors: string[] } {
  const readings: PerCorner<Reading> = {};
  const errors: string[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const [name, ...rest] = line.split(/[\s;]+/);
    const corner = CORNER_NAMES[name.toUpperCase()];
    const vals = rest.map(num);
    if (!corner || vals.length < 3 || vals.slice(0, 3).some((v) => v === undefined)) {
      errors.push(`Could not read "${line}"`);
      continue;
    }
    const [inside, middle, outside, pressure_bar, camber_deg] = vals as number[];
    readings[corner] = { inside, middle, outside, pressure_bar, camber_deg };
  }
  return { readings, errors };
}
