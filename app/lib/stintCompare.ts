// Client for the stint tool's comparison of two stints (GET /stint/compare): did a setup change work?
import { apiFetchAgain } from '@/lib/retry';

export type Diff = {
  a: number;
  b: number;
  change: number; // b - a
  within: number; // the 95 % band on the change: smaller than this is lap-to-lap scatter
  clear: boolean;
  laps: [number, number];
  pct?: number; // grip: the change in % of a
};

export type CompareChoice = {
  key: string;
  session_id: number;
  file_id: number | null;
  number: number;
  name: string; // "FP2", or "FP2 · Stint 2" when its log has several
  run: string;
  driver: string | null;
  tyres: string | null;
  tyres_label: string | null;
  tyres_sure: boolean;
  laps: number; // in the trend
  best: number | null;
  order: number;
};

export type CompareSide = CompareChoice & {
  laps_in_trend: number;
  tyre_age: number | null; // laps on the set, the median of its laps in the trend, when known
  times: { lap: number; tyre_lap: number; time: number; corrected: number }[]; // corrected: on one tyre age and fuel
};

export type SetupChange = { key: string; label: string; unit: string; from: number | null; to: number | null;
  delta: number | null; text: string };

export type StintCompare = {
  track: string | null;
  file_ids: number[];
  choices: CompareChoice[];
  picked: { a: string; b: string; default: boolean; why: string | null };
  a: CompareSide;
  b: CompareSide;
  setup: { same_run: boolean; a_sheet: boolean; b_sheet: boolean; changes: SetupChange[]; tried: string[];
    missing: string[] };
  like_for_like: { ok: boolean; text: string }[];
  lap_time: (Diff & { best: { a: number | null; b: number | null } }) | null;
  correction: { tyres: boolean; fuel: boolean; words: string[]; tyre_age: number | null };
  phases: { key: string; label: string; measure: string; balance_phase: 'entry' | 'mid' | 'exit' | null;
    grip: Diff | null; balance: Diff | null }[];
  corners: { code: string; phase: 'entry' | 'mid' | 'exit'; a: number; b: number; change: number }[];
  fade: { a: { per_lap: number; within: number; clear: boolean; fuel_out: boolean };
    b: { per_lap: number; within: number; clear: boolean; fuel_out: boolean }; change: number } | null;
  aids: (Diff & { key: string; label: string })[];
  understeer_per_g: number | null;
  words: { headline: string; car: string[] };
};

export async function fetchStintCompare(files: number[], a?: string | null, b?: string | null):
  Promise<StintCompare> {
  const pick = a && b ? `&a=${encodeURIComponent(a)}&b=${encodeURIComponent(b)}` : '';
  const res = await apiFetchAgain(`/stint/compare?files=${files.join(',')}${pick}`);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(typeof body.detail === 'string' ? body.detail : `Request failed (${res.status})`);
  }
  return res.json() as Promise<StintCompare>;
}

export const PHASE_WORDS: Record<'entry' | 'mid' | 'exit', string> = { entry: 'entry', mid: 'mid-corner', exit: 'exit' };

/** "+0.4° towards understeer", "0.3° towards oversteer": a balance change (+ understeer) in words. */
export function balanceWords(change: number): string {
  return `${Math.abs(change).toFixed(1)}° towards ${change > 0 ? 'understeer' : 'oversteer'}`;
}
