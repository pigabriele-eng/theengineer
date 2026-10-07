// Client for the report's car balance and setup direction section (GET /report/balance?session=<id> or ?event=<id>).
// Balance values are degrees of steering against the car's own normal at the same cornering g: + more understeer
// (the front pushes), − more oversteer (the rear slides). Corners are official numbers only (T1, T2-T5, T8/T9...).
import { apiFetchAgain } from '@/lib/retry';
import type { QuickestLaps } from '@/lib/grip';

export type BalanceKind = 'understeer' | 'oversteer' | 'normal';
export type Strength = 'slight' | 'clear' | 'strong' | null;
export type BalancePhase = 'entry' | 'mid' | 'exit';

export type BalanceCell = {
  value: number;
  quick?: number | null; // the quickest tenth of passes
  laps?: number;
  kind: BalanceKind;
  strength: Strength;
};

export type BarModel = {
  preset: string;
  car: string;
  axle: 'front' | 'rear';
  from: number;
  to: number;
  positions: number;
  llt_front_share: [number, number]; // % of lateral load transfer on the front axle, before and after
  roll_gradient: [number, number]; // deg/g
  summary: string;
  note: string;
};

export type Recommendation = {
  key: string;
  title: string;
  why: string;
  expect: string;
  watch: string | null;
  model: BarModel | null;
  sections: string[] | null;
};

export type LapSplit = {
  reference: number;
  ideal: number;
  held: number;
  theoretical: number;
  driving: number;
  car: number;
  optimism: number;
};

export type CarLimitRow = {
  code: string;
  car: number; // s the quickest pass leaves against the realistic target (0 where it beats it)
  driving: number;
  optimism: number;
  where: string | null; // braking, mid-corner or on the throttle
  tc_s: number | null;
  rear_slip_exit: number | null;
  held_grip: number | null;
};

export type LapThrough = {
  lap: string; // "<run>#<lap number>"
  time: number;
  min_speed_kmh: number;
  exit_speed_kmh: number;
  throttle_lifts?: number;
  tc_s?: number;
  rear_slip_p98?: number;
  balance_low?: number;
};

export type Focus = {
  code: string;
  start_m: number;
  end_m: number;
  total: number;
  driving: number;
  car: number;
  optimism: number;
  reference: LapThrough;
  best: LapThrough;
  theoretical_peak_g: number;
  held_time: number;
  trace: {
    distance_m: number[];
    reference_speed: number[];
    best_speed: number[];
    held_speed: number[];
    reference_g: number[];
    best_g: number[];
    held_g: number[];
    corners: { code: string; at_m: number }[];
  };
  explain: { part: 'driving' | 'car' | 'theoretical'; seconds: number; text: string }[];
};

export type SpeedRow = {
  speed: 'slow' | 'medium' | 'fast';
  range_kmh: [number, number];
} & Record<BalancePhase, BalanceCell | null>;

export type BalanceRow = { code: string; min_speed_kmh: number } & Record<BalancePhase, BalanceCell | null>;

export type MethodValue = {
  value: number | null;
  range?: [number, number] | null;
  source: string;
  confidence: 'published' | 'measured' | 'estimate' | 'unknown' | string;
  reads: string;
};

export type BalanceSession = {
  name: string;
  session_id: number;
  laps: number;
  yaw_scale?: number;
  steering?: { ratio: number | null; confidence: string; source: string };
  note?: string;
};

export type BalanceReport = {
  scope: { kind: 'session' | 'event'; id: number; name: string; track: string | null };
  reference: { run: string; lap: number; time: number; lap_time: string };
  laps: number;
  headline: string;
  recommendations: Recommendation[];
  notes: string[];
  car_limits: { lap: LapSplit; total_car: number; sections: CarLimitRow[]; text: string };
  focus: Focus | null;
  balance: {
    sections: BalanceRow[];
    by_speed: SpeedRow[];
    per_g: number | null;
    by_g: { g: [number, number]; understeer_deg: number }[];
    spread: number | null;
    notes: string[];
  };
  checks: { label: string; value: string }[];
  method: {
    steering_ratio: MethodValue;
    wheelbase_mm: MethodValue;
    yaw_scale: [number, number] | null;
    notes: string[];
  };
  sessions: BalanceSession[];
  quickest_laps?: QuickestLaps; // a long event is worked out from its quickest laps only
};

export async function fetchBalance({ session, event }: { session?: number; event?: number }): Promise<BalanceReport> {
  const query = event != null ? `event=${event}` : `session=${session}`;
  const res = await apiFetchAgain(`/report/balance?${query}`);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(typeof body.detail === 'string' ? body.detail : `Request failed (${res.status})`);
  }
  return res.json() as Promise<BalanceReport>;
}

/** "06_D2S1#7" -> "06_D2S1 lap 7" */
export function lapName(key: string): string {
  const at = key.lastIndexOf('#');
  return at < 0 ? key : `${key.slice(0, at)} lap ${key.slice(at + 1)}`;
}

/** +1.5° or −0.3°, with a typeset minus. */
export function degrees(v: number): string {
  return `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(1)}°`;
}

/** "slight understeer", "strong oversteer" or "normal". */
export function balanceWords(c: Pick<BalanceCell, 'kind' | 'strength'>): string {
  return c.kind === 'normal' ? 'normal' : `${c.strength} ${c.kind}`;
}

export const SPEED_LABEL: Record<SpeedRow['speed'], string> = { slow: 'Slow', medium: 'Medium', fast: 'Fast' };
