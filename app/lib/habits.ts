// The habit tracker (server: routers/habits.py): each driver's recurring technique mistakes over every event, from
// the technique check's flagged mistakes, getting better or worse over time, and drivers side by side.
import { apiFetch } from '@/lib/api';
import { sharedLoader } from '@/lib/habitView';

/** Whether a habit is getting better or worse: earlier events against recent ones. */
export type HabitTrend = { dir: 'better' | 'worse' | 'steady'; words: string };

export type HabitEventStat = {
  event_id: number;
  rate: number; // share of the corners driven where it happened, 0-1
  cost_per_lap_s: number;
  laps: number;
};

export type HabitStat = {
  rate: number; // share of the corners driven where it happened, 0-1, over every event
  cost_per_lap_s: number; // the time it cost a lap, on average
  laps: number; // clean laps checked
  events: number;
  trend: HabitTrend | null; // null until the driver has two events with enough laps
  by_event: HabitEventStat[]; // oldest first; only the events the driver drove
};

/** Where a habit shows most: a corner of one event, and the share of the driver's laps there it happened on. */
export type HabitCorner = { code: string; event_id: number; track: string | null; rate: number };

export type HabitDriverStat = HabitStat & {
  corners: HabitCorner[]; // up to three, most often first
  types: Record<string, number>; // corner type key -> share of those corners where it happened
};

export type HabitRow = {
  kind: string;
  label: string;
  group: string; // a HabitGroup key
  do: string; // what to do instead, in one line
  drivers: Record<string, HabitDriverStat>; // by driver id
};

export type HabitGroup = { key: string; label: string; drivers: Record<string, HabitStat> };

export type CornerType = {
  key: 'slow' | 'medium' | 'fast' | 'flat';
  label: string;
  note: string; // what puts a corner in this type
  drivers: Record<string, HabitStat>; // any flagged mistake in a corner of this type
};

export type HabitDriver = { id: number; name: string; code: string; laps: number; events: number };

export type HabitEvent = {
  id: number;
  name: string;
  track: string | null;
  date: string | null; // ISO day
  laps: Record<string, number>; // driver id -> clean laps checked
};

/** A way two drivers differ every time they share the car, from their fingerprints. */
export type StyleTrait = {
  kind: string;
  group: string; // a HabitGroup key
  label: string;
  explain: string;
  words: string; // for driver a: "brakes later"
  words_b: string; // for driver b: "brakes earlier"
  agree: number; // events where it went this way
  of: number; // events the two shared
  size: number; // how far apart, in spreads of the event's laps
};

export type StylePair = { a: number; b: number; events: number; traits: StyleTrait[] };

export type HabitTracker = {
  status: 'ready' | 'checking';
  checking: string[]; // events whose technique check is still being worked out
  drivers: HabitDriver[]; // most laps first
  events: HabitEvent[]; // oldest first
  groups: HabitGroup[];
  corner_types: CornerType[];
  corner_types_note: string; // what makes a corner count there: its mistakes costing 0.1 s or more
  habits: HabitRow[]; // most costly first
  pairs: StylePair[];
};

async function get<T>(path: string): Promise<T> {
  const res = await apiFetch(path);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(typeof body.detail === 'string' ? body.detail : `Request failed (${res.status})`);
  }
  return res.json() as Promise<T>;
}

export const habitsApi = {
  all: () => get<HabitTracker>('/drivers/habits'),
};

// ---------- one request for every tracker on screen ----------

/** How long an answer is handed out again without asking: a page showing a tracker for each driver makes one
 * request. */
export const HABITS_KEEP_MS = 30_000;

const shared = sharedLoader(() => habitsApi.all());

/** The habit tracker, shared: one request while one is on its way, and an answer up to `maxAgeMs` old (30 s by
 * default) handed out again. Polling while the check is still at work asks for a fresher one. */
export const loadHabits = (maxAgeMs: number = HABITS_KEEP_MS) => shared.load(maxAgeMs);

/** The answer already here, when it is no older than 30 s: a tracker drawn after another shows it at once. */
export const peekHabits = (): HabitTracker | null => shared.peek(HABITS_KEEP_MS);
