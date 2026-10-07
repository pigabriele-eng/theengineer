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
  cost_s: number; // against the realistic target (a quick lap's usual grip at each place): time a driver can find
  cost_perfect_s: number; // against perfect driving (the car at 100%)
  carried_s: number; // of cost_s, what it carries on past its stretch (a slow exit, all down the next straight)
  title: string;
  what: string; // what the driver did against what perfect driving does, with the numbers
  do: string; // what to do instead
  value: number | null;
  unit: string;
  repeats: { laps: number; of: number } | null; // on how many of the session's clean laps
};

/** A mistake that is wrong whatever the target: a lift on the way out of a corner, the power stepped on so early or
 * so hard that the car forced a lift or a steering correction, braking in a straight line below the car's limit, an
 * upshift before or after the revs where the next gear drives harder (or held on the rev limiter), the throttle on
 * and off through a corner.
 * cost_s is what it alone cost: the speed the lift lost carried down the straight, the later braking point missed. */
export type ObviousMistake = {
  key: string;
  kind: 'exit_lift' | 'on_off_throttle' | 'power_step' | 'soft_straight_braking' | 'early_shift' | 'late_shift';
  code: string;
  phase: Phase;
  start_m: number;
  end_m: number;
  at_m: number;
  cost_s: number;
  title: string;
  what: string;
  do: string;
};

export type Budget = {
  mistakes: number; // the named mistakes
  at_limit: number; // flat out, on the ABS or on the traction control, yet the car below its best
  optimism: number; // the perfect lap's optimism: the car's best at every place rather than a quick lap's usual
  pit_lane: number; // the lap ends in the pit lane
  other: number; // small losses no single mistake explains, less the places the lap beat the target
  other_losses: number;
  other_gains: number;
};

export type InputRole = 'throttle' | 'brake' | 'steer' | 'gear';
/** The driver's inputs at the speed trace's points (every step_m metres): throttle %, brake pressure, steering and
 * gear as the log's channels for those roles have them; null where the log has no such channel. */
export type Inputs = Record<InputRole, number[] | null>;
/** Perfect driving's own phases (trace.model_phases indexes these). Its model has no pedal positions and never
 * coasts: it brakes, drives at the grip limit (part throttle) or at full throttle. */
export const MODEL_PHASES = ['braking', 'at the grip limit', 'full throttle'] as const;

export type LapCheck = {
  key: string;
  session_id: number;
  run: string;
  number: number;
  time: number;
  driver: string | null;
  perfect: number; // this lap's line at the car's limits
  realistic: number; // the same at the grip a quick lap usually shows at each place
  gap: number; // to perfect
  pit_from_m: number | null;
  budget: Budget;
  mistakes: Mistake[];
  obvious?: ObviousMistake[]; // most costly first; they may overlap the mistakes above
  trace: { step_m: number; driven: number[]; perfect: number[]; realistic: number[]; inputs?: Inputs;
    model_phases?: number[] } | null;
  // the event's fastest lap (the one the report measures from), its inputs to lay under this lap's; none when this
  // lap is that one
  fastest?: { session_id: number; run: string; number: number; time: number; this_lap: boolean;
    inputs: Inputs | null } | null;
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
  inputs?: Record<InputRole, { channel: string | null; unit: string | null }>; // the log's channel for each input
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
