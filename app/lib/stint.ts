// Client for the stint analysis (GET /sessions/{id}/stint): each run on one set of tyres, lap by lap, and its fade.
import { apiFetch, formatLap } from '@/lib/api';

export type LapKind = 'flying' | 'out' | 'in' | 'pit' | 'slow';
export type Phase = 'entry' | 'mid' | 'exit';

export type StintLap = {
  lap: number;
  tyre_lap: number; // laps into the stint, the first lap is 1
  kind: LapKind;
  in_fit: boolean; // counted in the stint's trend
  outlier: boolean;
  off_trend_s: number | null;
  time: number;
  grip_use: number | null; // % of the grip the car showed on its best laps
  peak_lat_g: number;
  sustained_lat_g: number | null; // best one-second average
  balance: Record<Phase, number | null> | null; // + more understeer than the car's average at the same g
  tc_s: number | null;
  abs_s: number | null;
  tyres: { pressure_bar?: Record<string, number>; temperature_c?: Record<string, number> } | null;
};

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

export type Stint = {
  number: number;
  first_lap: number;
  last_lap: number;
  best: number | null;
  median: number | null;
  understeer_gradient: number | null;
  fits: Partial<Record<string, Trend>>;
  laps: StintLap[];
  notes: string[];
};

export type StintAnalysis = {
  run?: string;
  lap_source?: string;
  steer_channel?: string | null;
  steer_unit?: string;
  understeer_gradient?: number | null;
  stops?: { start_s: number; end_s: number; duration_s: number }[];
  stints: Stint[];
  notes: string[];
};

export async function fetchStint(sessionId: number): Promise<StintAnalysis> {
  const res = await apiFetch(`/sessions/${sessionId}/stint`);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.detail ?? `Request failed (${res.status})`);
  }
  return res.json() as Promise<StintAnalysis>;
}

export const KIND_LABEL: Record<LapKind, string> = {
  flying: '',
  out: 'out',
  in: 'in',
  pit: 'pit',
  slow: 'slow',
};

export const signed = (v: number | null | undefined, digits = 2) =>
  v == null ? '–' : `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(digits)}`;

export const fixed = (v: number | null | undefined, digits = 1) => (v == null ? '–' : v.toFixed(digits));

export const average = (corners: Record<string, number> | undefined) => {
  const v = Object.values(corners ?? {});
  return v.length === 4 ? v.reduce((a, b) => a + b, 0) / 4 : null;
};

// The headline numbers of a stint, as short phrases for the summary row.
export function fadeWords(stint: Stint): { label: string; value: string }[] {
  const out: { label: string; value: string }[] = [];
  const t = stint.fits.time;
  if (t) out.push({ label: 'Lap time', value: t.clear ? `${signed(t.per_lap)} s/lap` : 'steady' });
  const g = stint.fits.grip_use;
  if (g) out.push({ label: 'Grip in use', value: g.clear ? `${signed(g.per_lap, 1)} pts/lap` : 'steady' });
  if (stint.best != null) out.push({ label: 'Best', value: formatLap(stint.best) });
  return out;
}
