// Client for the technique check (GET /technique/sessions/{id}?lap=N, GET /technique/events/{id}): one lap's obvious
// driving mistakes, what each cost, what the lap would have been without them, and the ones that repeat across the
// session and the event. Every lap is compared only with laps on the same tyres (PUT .../tyres sets a run's).
// The server works it out in the background for every clean lap of an event (or of a session in no event).
import { apiFetch } from '@/lib/api';

export type TechniqueStatus = 'ready' | 'queued' | 'running' | 'failed' | 'empty';

export type Phase = 'braking' | 'entry' | 'mid-corner' | 'exit' | 'full throttle';

/** A mistake that is wrong whatever the target: a lift on the way out of a corner, the power stepped on so early or
 * so hard that the car forced a lift or a steering correction, braking in a straight line below the car's limit, an
 * upshift before or after the revs where the next gear drives harder (or held on the rev limiter), the throttle on
 * and off through a corner, the speed stalling or dropping on the way out.
 * cost_s is what it alone cost: the speed the lift lost carried down the straight, the later braking point missed. */
/** What an obvious mistake really costs by corner and kind, measured on the laps (with it against without it,
 * driver by driver, every check at the track pooled); the model's estimate where too few laps measure it or the
 * loss is still within the noise (the flag stands either way). */
export type MeasuredCost = { key: string; code: string; kind: ObviousMistake['kind']; measured: boolean;
  /** the measured loss stands clear of the noise (cost_s is then the measured one, else the model's) */
  clear?: boolean; measured_s?: number | null; pm_s?: number | null;
  cost_s: number; model_s: number; laps_with: number; laps_without: number; events: number };

export type ObviousMistake = {
  key: string;
  kind: 'exit_lift' | 'exit_stall' | 'on_off_throttle' | 'power_step' | 'power_oversteer' | 'soft_straight_braking'
    | 'braking_unused' | 'early_shift' | 'late_shift';
  code: string;
  phase: Phase;
  start_m: number;
  end_m: number;
  at_m: number;
  cost_s: number;
  title: string;
  what: string;
  do: string;
  measured?: MeasuredCost | null;
  repeats?: { laps: number; of: number } | null; // on how many of the session's clean laps
};

export type Tyres = 'new' | 'used';
/** A run's tyres: the driver's (sure), or guessed from its laps until the driver confirms (qualifying is new, a race
 * used, for sure); with how many of the event's clean laps are on them. */
export type RunTyres = { tyres: Tyres; sure: boolean; why: string; laps?: number | null };

export type InputRole = 'speed' | 'throttle' | 'brake' | 'steer' | 'gear' | 'rpm';
/** The driver's inputs at the speed trace's points (every step_m metres): throttle %, brake pressure, steering,
 * gear and revs as the log's channels for those roles have them; null (or missing, from an older check) where the log
 * has no such channel. */
export type Inputs = Partial<Record<InputRole, number[] | null>>;
/** What to lay over the driver's inputs: their best real passes on the same tyres. */
export type ModelInputs = { best?: BestTechnique };
/** Where each section of the best-technique lap comes from: the driver's own quickest clean pass of the event (its
 * run and lap), this lap's pass with its obvious mistakes taken out (built), or this lap's own pass, already the
 * best clean one (own); and what it finds over this lap there. */
export type BestSource = { code: string; start_m: number; end_m: number; kind: 'pass' | 'built' | 'own';
  run?: string; number?: number; gain_s: number; put_right?: ObviousMistake['kind'][] };
/** The driver's best technique through every section, blended at the joins; speed among its inputs. */
export type BestTechnique = Inputs & { time: number; sources: BestSource[] };
/** A model's own phases (an index into these at each point): it brakes, drives at the grip limit or at full
 * throttle. */
export const MODEL_PHASES = ['braking', 'at the grip limit', 'full throttle'] as const;

export type LapCheck = {
  key: string;
  session_id: number;
  run: string;
  number: number;
  time: number;
  driver: string | null;
  tyres?: Tyres;
  mistakes_s: number; // what the obvious mistakes cost together, each counted once
  without_mistakes: number; // the lap's time less that
  pit_from_m: number | null;
  obvious: ObviousMistake[]; // most costly first
  trace: { step_m: number; driven: number[]; inputs?: Inputs; model?: ModelInputs } | null;
  // the event's fastest lap (the one the report measures from), its inputs to lay under this lap's; none when this
  // lap is that one
  fastest?: { session_id: number; run: string; number: number; time: number; this_lap: boolean;
    inputs: Inputs | null } | null;
};

export type LapRow = {
  number: number;
  time: number;
  tyres?: Tyres;
  mistakes_s: number;
  without_mistakes: number;
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
  tyres?: RunTyres | null;
  measured?: MeasuredCost[] | null; // the obvious mistakes, most expensive first as measured
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
    best: { number: number; time: number; without_mistakes: number } | null; tyres?: RunTyres | null }[];
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
/** How far a check is, without the check (?brief=true): what a page waiting for it asks again and again. */
export type TechniqueProgress = Head;
export const fetchTechniqueProgress = (of: { session: number } | { event: number }) =>
  call<TechniqueProgress>('session' in of ? `/technique/sessions/${of.session}?brief=true`
    : `/technique/events/${of.event}?brief=true`);
export const refreshSessionTechnique = (session: number) =>
  call<SessionTechnique>(`/technique/sessions/${session}/refresh`, { method: 'POST' });

/** The run's tyres as the driver says: the check is worked out again, every lap against laps on the same tyres. */
export const setSessionTyres = (session: number, tyres: Tyres) =>
  call<{ tyres: Tyres; status: TechniqueStatus }>(`/technique/sessions/${session}/tyres`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tyres }) });

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
