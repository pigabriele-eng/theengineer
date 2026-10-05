// Client for the technique check (GET /technique/sessions/{id}?lap=N, GET /technique/events/{id}): one lap's
// driving mistakes against perfect driving, what each costs, and the ones that repeat across the session and the event.
// The server works it out in the background for every clean lap of an event (or of a session in no event).
import { apiFetch } from '@/lib/api';

export type TechniqueStatus = 'ready' | 'queued' | 'running' | 'failed' | 'empty';

export type Phase = 'braking' | 'entry' | 'mid-corner' | 'exit' | 'full throttle';

export type Mistake = {
  key: string; // "<code>:<kind>", the same mistake on every lap
  kind: string;
  code: string; // official corner number or section ("T2-T5")
  phase: Phase;
  start_m: number; // the stretch of the lap it covers, metres from the line
  end_m: number;
  at_m: number; // where to mark it
  cost_s: number; // against the realistic target (the car at 95% of its grip): time a driver can find
  cost_perfect_s: number; // against perfect driving (the car at 100%)
  carried_s: number; // of cost_s, what it carries on past its stretch (a slow exit, all down the next straight)
  title: string;
  what: string; // what the driver did against what perfect driving does, with the numbers
  do: string; // what to do instead
  value: number | null;
  unit: string;
  repeats: { laps: number; of: number } | null; // on how many of the session's clean laps
};

export type Budget = {
  mistakes: number; // the named mistakes
  at_limit: number; // flat out, on the ABS or on the traction control, yet the car below its best
  optimism: number; // the perfect lap's optimism: the car at 100% rather than 95% of its grip
  pit_lane: number; // the lap ends in the pit lane
  other: number; // small losses no single mistake explains, less the places the lap beat the target
  other_losses: number;
  other_gains: number;
};

export type LapCheck = {
  key: string;
  session_id: number;
  run: string;
  number: number;
  time: number;
  driver: string | null;
  perfect: number; // this lap's line at the car's limits
  realistic: number; // the same at 95% of the grip
  gap: number; // to perfect
  pit_from_m: number | null;
  budget: Budget;
  mistakes: Mistake[];
  trace: { step_m: number; driven: number[]; perfect: number[]; realistic: number[] } | null;
};

export type LapRow = {
  number: number;
  time: number;
  gap_s: number;
  mistakes_s: number;
  count: number;
  top: string | null;
  top_code: string | null;
  in_lap: boolean;
};

export type Habit = {
  key: string;
  kind: string;
  code: string;
  phase: Phase;
  title: string;
  laps: number; // laps with it
  of: number; // laps checked
  share: number;
  cost_per_lap_s: number; // averaged over every lap checked
  cost_when_s: number; // averaged over the laps with it
  cost_perfect_per_lap_s: number;
  value: number | null; // its usual size
  unit: string;
};

type Head = {
  scope: 'event' | 'session';
  id: number;
  title: string;
  track: string | null;
  status: TechniqueStatus;
  progress: { done: number; total: number; current: string | null } | null;
  error: string | null;
  stale: boolean; // from before the sessions last changed; a new check is being worked out
  grip: number; // the realistic target's share of the car's grip
};

export type SessionTechnique = Head & {
  session: { id: number; name: string; driver: string | null };
  event: { id: number; name: string } | null;
  map: { event: number } | { session: number };
  laps: LapRow[];
  best_lap?: number | null;
  lap: LapCheck | null;
  lap_note: string | null;
  habits: { session: Habit[]; session_laps: number; event: Habit[] | null; event_laps: number | null } | null;
  sections?: { code: string; start_m: number; end_m: number; apex_m: number | null; corners: string[] }[];
  corners?: { code: string; at_m: number }[];
  length_m?: number;
  numbering?: 'official' | 'detected';
};

export type EventTechnique = Head & {
  sessions: { id: number; name: string; driver: string | null; laps: number;
    best: { number: number; time: number; gap_s: number } | null }[];
  best: { session_id: number; number: number; time: number } | null;
  habits: Habit[] | null;
  laps_checked: number;
};

async function call<T>(p: string, init?: RequestInit): Promise<T> {
  const res = await apiFetch(p, init);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.detail ?? `Request failed (${res.status})`);
  }
  return res.json() as Promise<T>;
}

export const fetchSessionTechnique = (session: number, lap?: number | null) =>
  call<SessionTechnique>(`/technique/sessions/${session}${lap != null ? `?lap=${lap}` : ''}`);
export const fetchEventTechnique = (event: number) => call<EventTechnique>(`/technique/events/${event}`);
export const refreshSessionTechnique = (session: number) =>
  call<SessionTechnique>(`/technique/sessions/${session}/refresh`, { method: 'POST' });

export const working = (s: TechniqueStatus | undefined) => s === 'queued' || s === 'running';

const DIGITS: Record<string, number> = { 'km/h': 0, m: 0, s: 1, g: 2, '%': 0 };
const SIZE_WORDS: Record<string, (s: string) => string> = {
  brake_early: (s) => `${s} early`,
  lift_before_brake: (s) => `${s} off the throttle before braking`,
  over_slowed: (s) => `${s} too slow off the brake`,
  lockup: (s) => `front wheels ${s} slower than the car`,
  soft_braking: (s) => `${s} short of the car's braking`,
  slow_brake_build: (s) => `${s} to build the pressure`,
  early_ease: (s) => `${s} short of the car's braking after the peak`,
  lift_corner: (s) => `${s} slower than the grip allows`,
  coasting: (s) => `${s} with neither pedal`,
  min_speed: (s) => `${s} slower than the grip allows`,
  late_throttle: (s) => `${s} late`,
  slow_throttle: (s) => `${s} late`,
  lift: (s) => `${s} off full throttle`,
};
/** A habit's usual size in words: "22 m early", "1.2 s with neither pedal", "3 lifts". */
export const habitSize = (h: Pick<Habit, 'value' | 'unit' | 'kind'>) => {
  if (h.value == null) return null;
  if (!h.unit) {
    const n = Math.round(h.value);
    const word = h.kind === 'exit_lift' ? 'lift' : h.kind === 'steering' ? 'correction' : '';
    return word ? `${n} ${word}${n === 1 ? '' : 's'}` : null;
  }
  const v = h.value.toFixed(DIGITS[h.unit] ?? 1);
  const size = h.unit === '%' ? `${v}%` : `${v} ${h.unit}`;
  return SIZE_WORDS[h.kind]?.(size) ?? size;
};
