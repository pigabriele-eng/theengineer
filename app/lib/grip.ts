// Client for the grip use and traction control report (GET /report/grip?session=<id> or ?event=<id>).
import { apiFetch } from '@/lib/api';

export type PhaseKey = 'braking' | 'trail' | 'mid' | 'exit';
export const PHASES: { key: PhaseKey; label: string }[] = [
  { key: 'braking', label: 'Braking' },
  { key: 'trail', label: 'Turn-in' },
  { key: 'mid', label: 'Mid-corner' },
  { key: 'exit', label: 'Exit' },
];

export type Stat = { r: number; n: number; p: number; slope: number; intercept?: number };
export type LapId = { run: string; lap: number; time: number };

export type GripLap = {
  run: string;
  lap: number;
  time: number;
  quick: boolean; // within 1 % of the best
  grip_use: number | null; // % of the car's grip, braking and cornering only
  phases: Record<PhaseKey, number | null>;
  tc_s: number | null; // seconds of TC with the throttle open
  rear_tyre_c: number | null;
  tc_switch: number | null;
};

export type Spot = {
  start_m: number;
  end_m: number;
  r: number;
  phase: PhaseKey;
  grip_fast: number;
  grip_slow: number;
};

export type SectionPhase = {
  grip_use: number | null; // typical quick pass
  fast: number | null; // quickest third
  slow: number | null; // slowest third
  time_s: number | null;
  r: number | null;
};

export type GripSection = {
  code: string;
  start_m: number;
  end_m: number;
  apex_m: number | null;
  passes: number;
  time: number;
  grip_use: number | null;
  grip_use_fast: number | null;
  grip_use_slow: number | null;
  r: number | null;
  s_per_pct: number | null;
  worth_s: number | null;
  flat_out: boolean;
  phases: Record<PhaseKey, SectionPhase>;
  spots: Spot[];
  note: string;
};

export type Verdict = 'cost' | 'minor' | 'pushing' | 'none' | 'unknown';

export type TcZone = {
  start_m: number;
  end_m: number;
  section: string;
  where: string;
  verdict: Verdict;
  quick_share: number;
  tc_s: number;
  slip_pct: number | null;
  speed_loss_kmh: number | null;
  speed_per_tc_s: number | null;
  speed_r: number | null;
  speed_p: number | null;
  time_cost_s: number;
  torque_cut_nm: number | null;
  points: [number, number, boolean][]; // TC s, speed 150 m on against the same entry speed (km/h), quick lap
  note: string;
  advice: string;
};

export type GripTc = {
  available: boolean;
  channel?: string | null;
  zones: TcZone[];
  lost_per_lap_s?: number | null;
  per_lap_s?: number | null;
  vs_rear_temp?: Stat | null;
  vs_rear_temp_within?: Stat | null;
  vs_time?: Stat | null;
  vs_time_within?: Stat | null;
  switch?: { channel: string | null; positions: number[]; vs_tc: Stat | null } | null;
  notes: string[];
};

// g per unit of the road's vertical load there (load: 1 on a level road), as the grip limit is; shaped: the points
// on a banked corner, a crest or a compression
export type GgLap = LapId & {
  m: number[]; speed: number[]; ax: number[]; ay: number[]; use: number[]; load?: number[]; shaped?: boolean[];
};

export type Headline = { key: string; label: string; value: string; detail: string; action: string };

export type GripResult = {
  available: boolean;
  notes: string[];
  runs: { name: string; clean_laps: number; best: number | null }[];
  numbering?: 'official' | 'detected';
  length_m?: number;
  clean_laps?: number;
  quick_laps?: number;
  fastest?: LapId;
  typical?: LapId;
  headlines?: Headline[];
  limits?: {
    speeds_kmh: number[];
    directions_deg: number[];
    envelope_g: number[][];
    bands_kmh: [number, number | null][];
  };
  grip?: {
    typical: number | null;
    best_lap: number | null;
    vs_time: Stat | null;
    vs_time_quick: Stat | null;
    vs_time_within: Stat | null;
    s_per_pct: number | null;
    phases: Record<'fast' | 'slow', Record<PhaseKey, { grip_use: number | null; time_s: number | null }>>;
  };
  sections?: GripSection[];
  laps?: GripLap[];
  tc?: GripTc;
  gg?: { fastest: GgLap; typical: GgLap };
  map?: { x: number[]; y: number[]; step_m: number; grip_use: (number | null)[]; tc: (number | null)[] | null } | null;
  channels?: { accelerometers: boolean; tc: string | null; tyre_temps: boolean; brake_unit: string };
  quickest_laps?: QuickestLaps; // a long event is worked out from its quickest laps only
};

/** How many of how many clean laps a long event's report used (only there when it left some out). */
export type QuickestLaps = { used: number; of: number };

export function quickestLapsLine(q: QuickestLaps): string {
  return `Worked out from the quickest ${q.used} of ${q.of} clean laps, to keep within the server's memory.`;
}

export type GripScope = { session?: number; event?: number };

export async function fetchGrip({ session, event }: GripScope): Promise<GripResult> {
  const q = event != null ? `event=${event}` : `session=${session}`;
  const res = await apiFetch(`/report/grip?${q}`);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.detail ?? `Request failed (${res.status})`);
  }
  return res.json() as Promise<GripResult>;
}

export const signedR = (r: number | null | undefined) =>
  r == null ? '–' : `${r > 0 ? '+' : r < 0 ? '−' : ''}${Math.abs(r).toFixed(2)}`;
