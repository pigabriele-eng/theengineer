// Client for the track's grip level session by session at an event, apart from the tyres' state
// (server/app/routers/track_grip.py), and the prep report's guidance from past events (server/app/prep/track_grip.py).
import { apiFetch } from '@/lib/api';

/** The tyres' state on a session's quick laps (medians): TPMS °C and hot bar per axle. */
export type TyreState = { front_c: number | null; front_bar: number | null; rear_c: number | null; rear_bar: number | null };

/** One official session (one or more logs), its track grip against the first session, in %. */
export type GripSession = {
  key?: string;
  name: string;
  kind: 'qualifying' | 'race' | 'other';
  start: string | null; // ISO date and time
  track: number; // the track's grip, % against the base session
  pm: number | null; // its 90 % range, ± %; null from fewer than 3 quick laps
  range: [number, number] | null;
  wet: boolean; // the logger's wiper switch was on
  ambient_c: number | null;
  track_c: number | null;
  laps?: number; // quick laps measured
  best?: number; // its best lap, s
  measured?: number; // grip at the limit as measured, % against the base
  tyres?: number; // the share the tyre model puts down to the tyres' state, %
  base?: boolean;
  drivers?: string[];
  state?: TyreState;
};

export type TrackGripResult = {
  available: boolean;
  base?: string;
  sessions: GripSession[];
  read: string[];
  headline: { from: string; to: string; change_pct: number; pm: number | null; sure: boolean; by_lap?: number } | null;
  tyre_model?: { used: boolean; sessions?: number; laps?: number; tyre?: string | null };
  basis?: { limit_m: number; length_m: number; road_load: boolean; laps: number };
  method: string[];
  notes: string[];
  track?: string | null;
};

export type TrackGripAnswer = {
  event: { id: number; name: string };
  car: { key: string; label: string };
  status: 'ready' | 'waiting' | 'empty';
  reason: string | null;
  result: TrackGripResult | null;
};

export async function fetchTrackGrip(event: number, car?: string): Promise<TrackGripAnswer> {
  const q = car ? `?car=${encodeURIComponent(car)}` : '';
  const res = await apiFetch(`/track-grip/events/${event}${q}`);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.detail ?? `Request failed (${res.status})`);
  }
  return res.json();
}

/** A change in % against the base: whole numbers from 2 %, one decimal below. */
export const pct = (x: number | null | undefined, sign = true) => {
  if (x == null) return '–';
  const a = Math.abs(x);
  const n = a >= 2 ? a.toFixed(0) : a.toFixed(1);
  return `${sign ? (x > 0 ? '+' : x < 0 ? '−' : '') : ''}${n} %`;
};

// ---------- the prep report's section ----------

type Point = { session: string; pct: number | null; pm: number | null };

export type PrepGripEvent = {
  id: number;
  name: string;
  year: string;
  available: boolean;
  note: string | null;
  base?: string;
  base_kind?: string;
  sessions?: GripSession[];
  peak?: Point | null; // the best the track got to before the races, against the first session
  quali?: Point | null;
  races_vs_quali?: (Point | null)[];
  by_lap?: number | null; // most of the rise came by this lap of the car's weekend
  wet?: string[];
  tyre_model?: boolean;
  read?: string[];
};

export type PrepTrackGrip = {
  events: PrepGripEvent[];
  guidance: string[];
  sureness: string | null;
  notes: string[];
};
