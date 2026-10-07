// Client for the stint tool: the logs to choose from (GET /stint/logs), the stints of the ticked logs
// (GET /stint?files=1,2) and the lap tags (PUT/DELETE /lap-tags).
import { apiFetch } from '@/lib/api';
import { apiFetchAgain } from '@/lib/retry';

export type LapKind = 'flying' | 'out' | 'in' | 'pit' | 'slow';
export type Tag = 'sc' | 'fcy' | 'traffic';
export type BalancePhase = 'entry' | 'mid' | 'exit';
export type GripPhase = 'braking' | 'trail' | 'mid' | 'exit' | 'power';

// A trend through a stint's flying laps (also used by the tyre prep report).
export type Trend = {
  label: string;
  unit: string;
  per_lap: number;
  se: number;
  within: number; // half-width of the 95 % band on per_lap
  laps: number;
  start: number;
  change: number; // first to last fitted lap
  clear: boolean;
};

export type Fit = Omit<Trend, 'label' | 'unit' | 'start'> & {
  level: number; // the mean over the fitted laps
  start?: number;
  stints?: number; // pooled over this many stints
};

export type Suggestion = { tag: Tag; options: Tag[]; likely: boolean; why: string };

export type StintLap = {
  lap: number;
  tyre_lap: number; // laps into the stint, the first lap is 1
  kind: LapKind;
  tag: Tag | null; // the user's tag: the lap stays out of the trends
  checked: boolean; // the user looked and said the lap counts
  counted: boolean; // the user counted a lap the analysis leaves out (never a pit lap): it is in every figure
  suggestion: Suggestion | null;
  in_fit: boolean;
  outlier: boolean;
  off_trend_s: number | null;
  time: number;
  fuel_kg: number | null; // burnt on this lap
  corrected_time: number | null; // with the fuel burnt since the stint's first lap put back on
  grip: Record<GripPhase, number | null> | null; // g
  balance: Record<BalancePhase, number | null> | null; // ° against the car's normal, + understeer
  tc_s: number | null;
  abs_s: number | null;
  coast_s: number | null;
  peak_lat_g: number | null;
  sustained_lat_g: number | null;
  shift_rpm: number | null;
  tyres: { pressure_bar?: Record<string, number>; temperature_c?: Record<string, number> } | null;
};

export type BalanceShift = { early: number; late: number; shift: number };

export type SectionRow = {
  code: string;
  corner: boolean;
  entry?: BalanceShift;
  mid?: BalanceShift;
  exit?: BalanceShift;
  fade: Partial<Record<GripPhase, number>>; // s a lap
  driver: Record<string, { change: number; clear: boolean }>;
};

export type FadeRow = {
  key: GripPhase;
  label: string;
  per_lap: number; // s a lap, + slower
  within: number;
  clear: boolean;
  corners: { code: string; per_lap: number }[];
  grip_change: number | null;
  grip_pct: number | null;
};

export type Words = {
  scope?: string;
  headline: string;
  advice: string | null;
  fuel: string | null;
  car: string[];
  driver: string[];
  left_out?: string | null;
};

export type Fuel = {
  source: 'log' | 'estimate';
  note: string;
  kg_per_lap: number | null;
  s_per_10kg: number;
  mass_kg: number;
  mass_source: string;
  fuel_s_per_lap: number | null;
};

export type Stint = {
  key: string;
  file_key: string;
  run: string;
  session_id: number | null;
  file_id: number | null;
  number: number;
  first_lap: number;
  last_lap: number;
  best: number | null;
  median: number | null;
  fitted_laps: number;
  fits: Partial<Record<string, Fit>>;
  fuel: Fuel | null;
  laps: StintLap[];
  groups: { early: number[]; late: number[] } | null;
  sections: SectionRow[];
  fade: FadeRow[];
  words: Words;
};

export type StintView = {
  track: string | null;
  file_ids: number[];
  logs: { key: string; name: string; session_id: number | null; file_id: number | null; laps: number;
    notes: string[] }[];
  understeer_per_g: number | null;
  units: { steer: string; steer_role: string | null; brake: string };
  overall: {
    fits: Partial<Record<string, Fit>>;
    sections: SectionRow[];
    fuel: Fuel | null;
    stints: number;
    fitted_laps: number;
    fade: FadeRow[];
    words: Words;
  };
  stints: Stint[];
  notes: string[];
};

export type LogFile = {
  id: number;
  filename: string;
  duration_s: number | null;
  laps: number;
  clean_laps: number;
  best_lap_s: number | null;
  main: boolean;
};

export type LogEvent = {
  id: number | null;
  name: string;
  track: string | null;
  date: string | null;
  sessions: { id: number; name: string; driver: string | null; files: LogFile[] }[];
};

async function ok<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(typeof body.detail === 'string' ? body.detail : `Request failed (${res.status})`);
  }
  return res.json() as Promise<T>;
}

export async function fetchStintLogs(): Promise<LogEvent[]> {
  return (await ok<{ events: LogEvent[] }>(await apiFetchAgain('/stint/logs'))).events;
}

export async function fetchStintView(files: number[]): Promise<StintView> {
  return ok<StintView>(await apiFetchAgain(`/stint?files=${files.join(',')}`));
}

/** Tag a lap (sc, fcy, traffic); 'none': the user looked and the lap counts; 'count': a lap the analysis leaves
 * out (an out-lap, in-lap, slow lap or outlier; not a pit lap) joins the trends. */
export async function putLapTag(fileId: number, lap: number, tag: Tag | 'none' | 'count'): Promise<void> {
  await ok(await apiFetch('/lap-tags', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ file_id: fileId, lap, tag }),
  }));
}

export async function clearLapTag(fileId: number, lap: number): Promise<void> {
  const res = await apiFetch(`/lap-tags?file_id=${fileId}&lap=${lap}`, { method: 'DELETE' });
  if (!res.ok) throw new Error(`Request failed (${res.status})`);
}

export const TAG_LABEL: Record<Tag, string> = { sc: 'SC', fcy: 'FCY', traffic: 'Traffic' };
export const TAG_WORDS: Record<Tag, string> = { sc: 'safety car', fcy: 'FCY', traffic: 'traffic' };
export const TAGS: Tag[] = ['sc', 'fcy', 'traffic'];

export const KIND_LABEL: Record<LapKind, string> = { flying: '', out: 'out-lap', in: 'in-lap', pit: 'pit', slow: 'slow' };

export const GRIP_PHASES: { key: GripPhase; label: string; measure: string; balance: BalancePhase | null }[] = [
  { key: 'braking', label: 'Braking', measure: 'deceleration in a straight line', balance: null },
  { key: 'trail', label: 'Trail braking', measure: 'combined g', balance: 'entry' },
  { key: 'mid', label: 'Mid-corner', measure: 'lateral g', balance: 'mid' },
  { key: 'exit', label: 'Exit', measure: 'combined g', balance: 'exit' },
  { key: 'power', label: 'Traction', measure: 'forward g at full throttle below 140 km/h', balance: null },
];

export const signed = (v: number | null | undefined, digits = 2) => {
  if (v == null) return '–';
  const text = Math.abs(v).toFixed(digits);
  return Number(text) === 0 ? text : `${v > 0 ? '+' : '−'}${text}`;
};

export const fixed = (v: number | null | undefined, digits = 1) => (v == null ? '–' : v.toFixed(digits));

export const average = (corners: Record<string, number> | undefined) => {
  const v = Object.values(corners ?? {});
  return v.length === 4 ? v.reduce((a, b) => a + b, 0) / 4 : null;
};

export const stintName = (s: Stint, many: boolean) =>
  `${many ? `${s.run} · ` : ''}Stint ${s.number} · laps ${s.first_lap}–${s.last_lap}`;
