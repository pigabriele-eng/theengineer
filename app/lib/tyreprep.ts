// Client for the tyre and qualifying preparation report (GET /report/tyre-prep?session=<id> or ?event=<id>):
// the quali-style runs found in the logs, how their warm-ups compare, when the tyres were ready and peaked, each
// tyre's window on the fastest laps, the cold pressures that land in it and the long-run fade.
import { apiFetchAgain } from '@/lib/retry';
import { Trend } from '@/lib/stint';

export type Wheel = 'FL' | 'FR' | 'RL' | 'RR';
export const WHEELS: Wheel[] = ['FL', 'FR', 'RL', 'RR'];

type PerWheel = Record<Wheel, number | null>;
export type TyreReadings = { p: PerWheel; t: PerWheel }; // TPMS bar and °C

// One flying lap of a quali-style run, with the TPMS axle averages at the line it started from.
export type SimPoint = {
  sim: string;
  session_id: number;
  lap: number;
  flying: number; // 1 = the run's first flying lap
  time: number;
  gap: number; // s off the day's best lap
  front: number | null;
  rear: number | null;
  pf: number | null; // hot pressure, front axle (bar)
  pr: number | null;
  peak: boolean; // the build's best lap
};

// The warm-up of a run, in the few numbers the comparison uses.
export type Procedure = {
  label: string;
  warm_laps: number | null;
  warm_min: number;
  drag_s: number | null; // brakes on against the throttle, above 60 km/h
  straight_brake_s: number | null; // braking where the session's fastest lap doesn't brake
  straight_hard_stops: number | null;
  weaves: number | null; // steering swings on the straights, beyond a normal lap's
  ready_min: number | null;
  peak_lap: number;
  peak_flying: number;
  peak_min: number;
  peak_time: number;
};

export type Sim = Procedure & {
  session_id: number;
  session: string;
  run: number;
  day: string;
  kind: 'quali' | 'quali_start'; // a quali sim pits soon after its best; a quali-style start carries on
  pre_warmed: boolean;
  cold_start: boolean;
  warm_km: number;
  brake_s: number | null;
  hard_stops: number | null;
  warm_gain_per_lap: { front_c: number | null; rear_c: number | null; front_bar: number | null; rear_bar: number | null };
  first_front: number | null;
  first_rear: number | null;
  peak_from_exit: number | null; // laps from leaving the pits to the best one, warm-up laps included
  gap_day: number;
  peak_front: number | null;
  peak_rear: number | null;
  peak_pf: number | null;
  peak_pr: number | null;
  hold: { laps: number; after: number; last_lap: number; minutes: number };
  bleed: PerWheel | null; // pressure change over the stop after the run
  bleed_kind: 'bled' | 'changed' | 'none' | null;
  points: SimPoint[];
  first_ready_lap: number | null;
  peak_after_ready: number | null;
};

export type Advice = { key: string; title: string; text: string };

export type LongRun = {
  session_id: number;
  session: string;
  label: string;
  flying: number;
  best: number;
  median: number;
  best_lap: number;
  fade: Trend | null; // lap time per lap once the tyres were up to temperature
  fade_laps: number;
  front_c: (number | null)[]; // first and last fitted lap
  rear_c: (number | null)[];
  pressure: (number | null)[];
  notes: string[];
};

export type TyrePrep = {
  scope: { session: number | null; event: number | null; event_name: string | null; series: string | null };
  sessions: { session_id: number; name: string; day: string; best: number | null }[];
  skipped: { session_id: number; session: string; reason: string }[];
  has_tpms: boolean;
  push: { front_c: number; rear_c: number; laps: number; gap_s: number; pf: number[] | null; pr: number[] | null } | null;
  peak_hold_s: number; // a run's pace held while its laps stayed this close to its best
  ready: {
    min: number;
    max: number;
    median: number;
    runs: number;
    peak_on_ready: number;
    of: number;
    peak_from_exit: number[] | null;
  } | null;
  fastest: { best: Procedure; runs: number } | null;
  brake_work: { most: Procedure; least: Procedure; saved_min: number; runs: number } | null;
  build: {
    warm_lap: { front_c: number | null; rear_c: number | null; front_bar: number | null; rear_bar: number | null };
    flying: { lap: number; runs: number; front: number | null; rear: number | null; pf: number | null; pr: number | null }[];
    runs: number;
  } | null;
  pressure: { laps: number; pf: number[]; span_bar: number; wide: boolean } | null;
  sims: Sim[];
  windows: {
    laps: number;
    of: number;
    within_s: number;
    best: number;
    tyres: Partial<Record<Wheel, { p?: number[]; t?: number[] }>>; // 10th, 50th and 90th percentile
  } | null;
  cold: {
    targets: Partial<Record<Wheel, number>>;
    runs_used: number;
    set_before: Partial<Record<Wheel, number[]>>;
    tyres: {
      tyre: Wheel;
      target_hot_bar: number;
      cold_bar: number | null;
      rise_bar: number | null;
      runs: number | null;
      typical_error_bar: number | null;
      text: string;
      flags: string[]; // the target against the P-Book minimums and the hot window
    }[];
  } | null;
  long_runs: LongRun[];
  advice: Advice[];
  method: string[];
};

export async function fetchTyrePrep(scope: { session?: number; event?: number }): Promise<TyrePrep> {
  const q = scope.session != null ? `session=${scope.session}` : `event=${scope.event}`;
  const res = await apiFetchAgain(`/report/tyre-prep?${q}`);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.detail ?? `Request failed (${res.status})`);
  }
  return res.json();
}

export const fixed = (x: number | null | undefined, digits = 0) => (x == null ? '–' : x.toFixed(digits));
export const signed = (x: number | null | undefined, digits = 0) =>
  x == null ? '–' : `${x > 0 ? '+' : x < 0 ? '−' : '±'}${Math.abs(x).toFixed(digits)}`;
