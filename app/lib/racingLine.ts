// Client for the racing line page (app/racing-line.tsx): GET /sessions/{id}/racing-line, each lap's line on the
// track with its inputs, its attitude and its tyre loads, one value every `step_m` metres. The math the page and the
// 3D view share (where each car is, the playhead, words for a difference) is in lib/racingLineMath.ts.
import { apiFetch } from '@/lib/api';
import { encodeOthers, LapRef } from '@/lib/racingLineMath';

export type { LapRef } from '@/lib/racingLineMath';

export type Wheel = 'fl' | 'fr' | 'rl' | 'rr';
export const WHEELS: Wheel[] = ['fl', 'fr', 'rl', 'rr'];

export type Road = {
  x: number[]; // the reference line, metres east of the lap's mean position
  y: number[]; // ... and north
  z: number[] | null; // height above the lap's lowest point; null when the log can't tell
  nx: number[]; // unit normal pointing to the LEFT of the direction of travel
  ny: number[];
  left: number[]; // the width used, metres left (+) of the reference line
  right: number[]; // ... and right (-)
};

export type Section = { code: string; start_m: number; end_m: number; apex_m: number };
export type Corner = { code: string; apex_m: number };

export type CornerEvents = {
  code: string;
  brake_m: number | null;
  turn_in_m: number | null;
  apex_m: number | null;
  apex_lateral: number | null;
  throttle_m: number | null;
  exit_lateral: number | null;
  min_speed: number | null;
};

export type RacingLap = {
  key: string; // "sessionId:lap"
  session_id: number;
  session_name: string | null;
  number: number;
  time: number;
  driver: string | null;
  label: string;
  shift_m: [number, number];
  t: number[];
  lateral: number[];
  speed: number[];
  throttle: number[];
  brake: number[];
  steer: number[];
  gear: number[];
  yaw_deg: number[];
  slip_deg: number[];
  roll_deg: number[];
  pitch_deg: number[];
  ax: number[];
  ay: number[];
  load: Record<Wheel, number[]>;
  events: CornerEvents[];
};

export type Difference = { code: string; lap: string; words: string; time_delta: number | null };

export type RacingLine = {
  session_id?: number; // (set by the server's router)
  session_name?: string;
  event_id?: number | null;
  reference_lap: number;
  length_m: number;
  step_m: number;
  clockwise: boolean;
  road: Road;
  sections: Section[];
  corners: Corner[];
  // summary: plain words, shown as they are
  accuracy: { summary: string; within_session_m: number | null; across_sessions_m: number | null };
  laps: RacingLap[];
  differences: Difference[];
};

/** The request for these laps of the session and of other sessions (no laps: the server picks the session's two
 * quickest clean laps). */
export function racingLinePath(sessionId: number, laps: number[], others: LapRef[]) {
  const q: string[] = [];
  if (laps.length) q.push(`laps=${laps.join(',')}`);
  if (others.length) q.push(`others=${encodeOthers(others)}`);
  return `/sessions/${sessionId}/racing-line${q.length ? `?${q.join('&')}` : ''}`;
}

export async function fetchRacingLine(sessionId: number, laps: number[], others: LapRef[]): Promise<RacingLine> {
  const res = await apiFetch(racingLinePath(sessionId, laps, others));
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const detail = typeof body.detail === 'string' ? body.detail : null;
    throw new Error(detail ?? (res.status === 422 ? 'This log has no GPS, so its line can’t be drawn.'
      : res.status === 404 ? 'That session or lap isn’t there any more.' : `Request failed (${res.status})`));
  }
  return res.json() as Promise<RacingLine>;
}
