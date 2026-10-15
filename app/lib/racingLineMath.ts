// The racing line page's math, kept apart from React and three.js so `npm test` checks it
// (lib/racingLineMath.test.mjs): where each lap's car is at a metre or at a clock time, the playhead going round the
// lap, jumping from corner to corner, the line patterns, and the plain words for a difference of line.
// Every per-place array has one value every `step_m` metres: index i is metre i * step_m (lib/racingLine.ts).
import type { RacingLap, RacingLine } from './racingLine';

export type LapRef = { session: number; lap: number };
export type Sync = 'place' | 'time'; // same place: every car at the same metre; real time: at the same clock time

export const MAX_RL_LAPS = 4;

// ---------- the address ----------

/** "7,12" -> [7, 12] (anything not a lap number left out). */
export function parseLaps(s: string | null | undefined): number[] {
  if (!s) return [];
  return s.split(',').map((x) => Number(x.trim())).filter((n) => Number.isInteger(n) && n > 0);
}

/** "34:5,35:2" -> [{session: 34, lap: 5}, {session: 35, lap: 2}]. */
export function parseOthers(s: string | null | undefined): LapRef[] {
  if (!s) return [];
  return s.split(',').map((p) => p.split(':').map((x) => Number(x.trim())))
    .filter((p) => p.length === 2 && p.every((n) => Number.isInteger(n) && n > 0))
    .map(([session, lap]) => ({ session, lap }));
}

export const encodeOthers = (refs: LapRef[]) => refs.map((r) => `${r.session}:${r.lap}`).join(',');

/** The racing line page's address for laps picked elsewhere (the During and Laps tabs: "Racing line, 3D"), the first
 * `max` of them: the first lap's session, its laps, the other sessions' laps as `others`; null with no lap. */
export function racingLineParams(laps: { session_id: number; lap: number }[], max = MAX_RL_LAPS):
  { session: string; laps: string; others?: string } | null {
  const kept = laps.slice(0, max);
  if (kept.length === 0) return null;
  const session = kept[0].session_id;
  const others = encodeOthers(kept.filter((l) => l.session_id !== session).map((l) => ({ session: l.session_id, lap: l.lap })));
  return {
    session: String(session),
    laps: kept.filter((l) => l.session_id === session).map((l) => l.lap).join(','),
    ...(others ? { others } : {}),
  };
}

// ---------- along the lap ----------

/** The value of a per-place array at a fractional index, straight between its two neighbours (kept to the ends). */
export function sample(values: ArrayLike<number> | null | undefined, f: number): number {
  if (!values || !values.length) return 0;
  const n = values.length;
  if (!(f > 0)) return values[0];
  if (f >= n - 1) return values[n - 1];
  const i = Math.floor(f);
  const a = values[i], b = values[i + 1];
  return a + (b - a) * (f - i);
}

/** An angle in degrees at a fractional index, the short way round between its neighbours. */
export function sampleAngle(values: ArrayLike<number>, f: number): number {
  const n = values.length;
  if (!n) return 0;
  if (!(f > 0)) return values[0];
  if (f >= n - 1) return values[n - 1];
  const i = Math.floor(f);
  let d = values[i + 1] - values[i];
  d -= 360 * Math.round(d / 360);
  return values[i] + d * (f - i);
}

/** How many places the lap has. */
export const placeCount = (d: Pick<RacingLine, 'road'>) => d.road.x.length;

/** The fractional index of a metre of the lap. */
export const indexOf = (d: Pick<RacingLine, 'step_m' | 'road'>, m: number) =>
  Math.max(0, Math.min(placeCount(d) - 1, m / d.step_m));

/** The fractional index where a lap's clock reaches T seconds (its `t` only ever climbs). */
export function indexAtTime(t: ArrayLike<number>, T: number): number {
  const n = t.length;
  if (!n) return 0;
  if (T <= t[0]) return 0;
  if (T >= t[n - 1]) return n - 1;
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (t[mid] <= T) lo = mid;
    else hi = mid;
  }
  const span = t[hi] - t[lo];
  return lo + (span > 0 ? (T - t[lo]) / span : 0);
}

/** Where each lap is with the playhead at metre `m` of the first lap: at the same metre (same place) or where it was
 * when the first lap's clock read what it reads at `m` (real time, a ghost race). Fractional indexes, one per lap. */
export function placesAt(d: Pick<RacingLine, 'step_m' | 'road' | 'laps'>, m: number, sync: Sync): number[] {
  const f0 = indexOf(d, m);
  if (sync === 'place' || !d.laps.length) return d.laps.map(() => f0);
  const T = sample(d.laps[0].t, f0);
  return d.laps.map((l, k) => (k === 0 ? f0 : indexAtTime(l.t, T)));
}

/** The playhead after `dt` seconds of playback at `rate` (1 = real speed): it moves at the first lap's speed there,
 * and starts the lap again at the line. */
export function advance(d: Pick<RacingLine, 'step_m' | 'road' | 'laps' | 'length_m'>, m: number, dt: number,
  rate: number): number {
  const kmh = d.laps.length ? sample(d.laps[0].speed, indexOf(d, m)) : 100;
  const next = m + (Math.max(kmh, 20) / 3.6) * dt * rate;
  const end = (placeCount(d) - 1) * d.step_m;
  return end > 0 && next >= end ? next - end : next;
}

/** The corners to jump between: the official ones, else the sections' apexes, in lap order. */
export function apexes(d: Pick<RacingLine, 'corners' | 'sections'>): { code: string; apex_m: number }[] {
  const list = d.corners.length ? d.corners : d.sections.map((s) => ({ code: s.code, apex_m: s.apex_m }));
  return [...list].sort((a, b) => a.apex_m - b.apex_m);
}

export const LEAD_M = 120; // a jump lands this far before the corner's apex

/** The playhead for the next (dir 1) or previous (dir -1) corner: LEAD_M before its apex, round the lap. */
export function cornerJump(d: Pick<RacingLine, 'corners' | 'sections' | 'length_m'>, m: number, dir: 1 | -1): number {
  const list = apexes(d);
  if (!list.length) return m;
  const L = d.length_m;
  const wrap = (x: number) => ((x % L) + L) % L;
  const starts = list.map((c) => wrap(c.apex_m - LEAD_M));
  // how far ahead (or behind) each corner's start is, round the lap; a start within 5 m counts as here
  const gaps = starts.map((s) => (dir === 1 ? wrap(s - m) : wrap(m - s)));
  let best = -1;
  for (let i = 0; i < gaps.length; i++) {
    if (gaps[i] <= 5) continue;
    if (best === -1 || gaps[i] < gaps[best]) best = i;
  }
  return best === -1 ? starts[0] : starts[best];
}

/** The section the playhead is in (the last one whose start it has passed). */
export function sectionAt<S extends { start_m: number; end_m: number }>(sections: S[], m: number): S | null {
  let hit: S | null = null;
  for (const s of sections) if (m >= s.start_m && m < s.end_m) hit = s;
  if (hit) return hit;
  return sections.length ? sections[sections.length - 1] : null;
}

// ---------- where a car is ----------

export type Pose = {
  x: number; // metres east
  y: number; // metres north
  z: number; // metres up
  yaw: number; // degrees clockwise from north
  slip: number;
  roll: number;
  pitch: number;
  lateral: number;
};

/** A lap's car at a fractional index: on the reference line moved `lateral` metres along the left normal. */
export function poseAt(d: Pick<RacingLine, 'road'>, lap: RacingLap, f: number): Pose {
  const r = d.road;
  const lateral = sample(lap.lateral, f);
  return {
    x: sample(r.x, f) + lateral * sample(r.nx, f),
    y: sample(r.y, f) + lateral * sample(r.ny, f),
    z: r.z ? sample(r.z, f) : 0,
    yaw: sampleAngle(lap.yaw_deg, f),
    slip: sample(lap.slip_deg, f),
    roll: sample(lap.roll_deg, f),
    pitch: sample(lap.pitch_deg, f),
    lateral,
  };
}

/** The direction of the reference line at a place, degrees clockwise from north. */
export function roadHeading(d: Pick<RacingLine, 'road'>, f: number): number {
  const n = placeCount(d);
  const i = Math.max(0, Math.min(n - 2, Math.floor(f)));
  const dx = d.road.x[i + 1] - d.road.x[i], dy = d.road.y[i + 1] - d.road.y[i];
  return (Math.atan2(dx, dy) * 180) / Math.PI;
}

// ---------- the line's patterns ----------

// each lap's line has a pattern of its own as well as a colour: solid, dashed, dotted, dash-dot (metres on, off...)
export const PATTERNS: { name: string; on: number[] | null; svg?: string }[] = [
  { name: 'solid', on: null },
  { name: 'dashed', on: [7, 4], svg: '8,5' },
  { name: 'dotted', on: [1.6, 2.4], svg: '2,4' },
  { name: 'dash-dot', on: [7, 2.5, 1.6, 2.5], svg: '9,3,2,3' },
];

/** Is a lap's line drawn at metre m (its pattern repeats along the lap)? */
export function patternOn(k: number, m: number): boolean {
  const on = PATTERNS[k % PATTERNS.length].on;
  if (!on) return true;
  const period = on.reduce((a, b) => a + b, 0);
  let x = ((m % period) + period) % period;
  for (let i = 0; i < on.length; i++) {
    if (x < on[i]) return i % 2 === 0;
    x -= on[i];
  }
  return false;
}

// ---------- words ----------

const one = (v: number) => Math.abs(v).toFixed(1);

/** A lap's line against the first lap's: "0.8 m further left", "the same line" within 0.1 m. */
export function lateralWords(diff: number): string {
  if (!Number.isFinite(diff)) return '–';
  if (Math.abs(diff) < 0.1) return 'the same line';
  return `${one(diff)} m further ${diff > 0 ? 'left' : 'right'}`;
}

/** Where a line is on the road against the reference line: "3.1 m left of the middle"... */
export const sideWords = (lat: number | null | undefined) =>
  lat == null || !Number.isFinite(lat) ? '–' : Math.abs(lat) < 0.1 ? 'on the reference line'
    : `${one(lat)} m ${lat > 0 ? 'left' : 'right'}`;

/** The road wheels' angle: "12° left", "straight" under half a degree. */
export const steerWords = (deg: number) =>
  Math.abs(deg) < 0.5 ? 'straight' : `${Math.round(Math.abs(deg))}° ${deg > 0 ? 'left' : 'right'}`;

/** The body's slip angle: how far the car points left or right of where it travels. */
export const slipWords = (deg: number) =>
  Math.abs(deg) < 0.5 ? 'none' : `${one(deg)}°, nose ${deg > 0 ? 'left' : 'right'} of travel`;


// ---------- where the load is ----------

export const TRACK_M = 1.65; // between the left and right tyres' middles
export const WHEELBASE_M = 2.86;

/** Where the total load sits (the four tyre places weighted by their load, % of static), from where it sits at rest
 * (all four at 100 %: the middle of the four): metres forward (+) or back, left (+) or right. */
export function loadCentre(l: { fl: number; fr: number; rl: number; rr: number }): { forward: number; left: number } {
  const sum = l.fl + l.fr + l.rl + l.rr;
  if (!(sum > 0)) return { forward: 0, left: 0 };
  return {
    forward: ((l.fl + l.fr - l.rl - l.rr) / sum) * (WHEELBASE_M / 2),
    left: ((l.fl + l.rl - l.fr - l.rr) / sum) * (TRACK_M / 2),
  };
}

/** "0.31 m forward, 0.12 m left", "at rest" when it hasn't moved 2 cm. */
export function centreWords(c: { forward: number; left: number }): string {
  const parts: string[] = [];
  if (Math.abs(c.forward) >= 0.02) parts.push(`${Math.abs(c.forward).toFixed(2)} m ${c.forward > 0 ? 'forward' : 'back'}`);
  if (Math.abs(c.left) >= 0.02) parts.push(`${Math.abs(c.left).toFixed(2)} m ${c.left > 0 ? 'left' : 'right'}`);
  return parts.length ? parts.join(', ') : 'where it is at rest';
}
