// Client for the lap guide of a coming weekend (GET /prep/events/{id}/guide, server/app/prep/guide.py): the gear map of
// the best lap at the venue and each corner's best and typical pass there (speed, throttle, brake and gear), from the
// past events with the same car. "working" while the past events' laps are still being read: ask again.
import { apiFetch } from '@/lib/api';

export type GuideStatus = 'ready' | 'working' | 'none';

export type GuidePoint = { x: number; y: number };

export type GuideMap = {
  length_m: number;
  step_m: number;
  clockwise: boolean;
  x: number[]; // metres east, one point every step_m from the start/finish line
  y: number[]; // metres north
  gear: (number | null)[] | null; // the gear held at each point (null: no gear channel in the log)
  start: GuidePoint & { dx: number; dy: number }; // the line and the direction of travel
  braking: (GuidePoint & { start_m: number; end_m: number; dx: number; dy: number; gear_in: number | null;
    gear_out: number | null })[];
  corners: (GuidePoint & { code: string; at_m: number; gear: number | null })[]; // official corners only
  sections: { code: string; start_m: number; end_m: number; apex_m: number | null; apex: GuidePoint | null;
    gear: number | null }[];
};

export type GuidePass = {
  session_id: number;
  session: string;
  driver: string | null;
  event_id: number;
  year: string | null;
  lap: number;
  lap_time: number;
  time: number; // through the section, s
  speed: (number | null)[] | null; // km/h every step_m from the corner's x0_m
  throttle: (number | null)[] | null; // %
  brake: (number | null)[] | null; // as the log has it (units.brake)
  gear: (number | null)[] | null;
};

export type GuideCorner = {
  code: string; // official numbers as the analysis groups them: "T1", "T2-T5", "T8/T9"; C1, C2... without them
  corners: string[];
  start_m: number;
  end_m: number;
  apex_m: number | null;
  marks: { code: string; at_m: number }[]; // the official corners inside it
  passes: number;
  x0_m?: number;
  best: GuidePass | null;
  typical: GuidePass | null;
  gain_s: number | null; // the typical pass against the best one
};

export type Guide = {
  status: GuideStatus;
  reason: string | null;
  car: string | null;
  numbering?: 'official' | 'detected';
  length_m?: number;
  step_m?: number;
  units?: { speed: string | null; throttle: string | null; brake: string | null };
  best_lap?: { session_id: number; session: string; driver: string | null; event_id: number; event: string;
    year: string | null; lap: number; time: number };
  gears?: { first_logged_as: number | null; as_logged: boolean };
  laps?: number;
  map?: GuideMap | null;
  corners?: GuideCorner[];
};

export async function fetchGuide(event: number, car?: string | null): Promise<Guide> {
  const q = car ? `?car=${encodeURIComponent(car)}` : '';
  const res = await apiFetch(`/prep/events/${event}/guide${q}`);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.detail ?? `Request failed (${res.status})`);
  }
  return res.json() as Promise<Guide>;
}

/** The ordinal of a gear: 1st, 2nd, 3rd, 4th... */
export const gearName = (g: number) => `${g}${g === 1 ? 'st' : g === 2 ? 'nd' : g === 3 ? 'rd' : 'th'}`;
