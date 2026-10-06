// Client for the track map (GET /sessions/{id}/map and /events/{id}/map), and the geometry that lays it out:
// the track fitted to the screen and the corner labels placed off the track and clear of each other.
import { apiFetch } from '@/lib/api';

export type MapPoint = { x: number; y: number };

export type MapSection = {
  code: string; // official numbers as the analysis groups them: "T1", "T2-T5", "T8/T9"; C1, C2... without them
  start_m: number;
  end_m: number;
  apex_m: number | null;
  corners: string[]; // the official numbers inside the section
  apex: MapPoint | null; // where its label goes
  time: number | null; // the reference lap's time through the section, s
  min_speed: number | null; // its slowest speed at the corner, km/h, as the corner analysis has it
};

export type TrackMapData = {
  session_id: number;
  session_name: string | null;
  reference_lap: number;
  lap_time: number;
  length_m: number;
  step_m: number;
  numbering: 'official' | 'detected';
  clockwise: boolean;
  // metres east (x) and north (y), one point every step_m from the start/finish line
  x: number[];
  y: number[];
  speed: number[]; // km/h
  start: MapPoint & { dx: number; dy: number; heading: number }; // the line and the direction of travel
  sections: MapSection[];
  corners: (MapPoint & { code: string; apex_m: number })[];
  // an event's map only: false when the event's fastest lap is in a log that can't draw the track (no GPS), so the
  // map is the next quickest session's
  event_fastest?: boolean;
};

// Thrown when there is no map to draw for a known reason (no log, no clean lap, no GPS): not a failure.
export class NoTrackMap extends Error {}

export async function fetchTrackMap(target: { session?: number; event?: number }): Promise<TrackMapData> {
  const path = target.event != null ? `/events/${target.event}/map` : `/sessions/${target.session}/map`;
  const res = await apiFetch(path);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const message = body.detail ?? `Request failed (${res.status})`;
    throw res.status === 404 || res.status === 422 ? new NoTrackMap(message) : new Error(message);
  }
  return res.json() as Promise<TrackMapData>;
}

// ---------- layout ----------

export type Box = { x: number; y: number; w: number; h: number }; // x, y: top left

export type Fit = {
  width: number;
  height: number;
  px: (p: MapPoint) => MapPoint;
  pts: MapPoint[]; // the path on screen
};

/** The track north up, as large as fits in width × maxHeight with `pad` around it for the labels. */
export function fitTrack(map: TrackMapData, width: number, maxHeight: number, pad: number): Fit {
  const x0 = Math.min(...map.x), x1 = Math.max(...map.x);
  const y0 = Math.min(...map.y), y1 = Math.max(...map.y);
  const s = Math.max(0.01, Math.min((width - 2 * pad) / (x1 - x0 || 1), (maxHeight - 2 * pad) / (y1 - y0 || 1)));
  const height = Math.round((y1 - y0) * s + 2 * pad);
  const left = (width - (x1 - x0) * s) / 2;
  const px = (p: MapPoint) => ({ x: left + (p.x - x0) * s, y: pad + (y1 - p.y) * s });
  return { width, height, px, pts: map.x.map((x, i) => px({ x, y: map.y[i] })) };
}

// Rough advance widths at fontSize 1 for the characters a corner label uses (bold system sans).
const ADVANCE: Record<string, number> = { '-': 0.4, '/': 0.36, ' ': 0.28, T: 0.62, C: 0.68 };
export const labelWidth = (text: string, fontSize: number) =>
  [...text].reduce((w, ch) => w + (ADVANCE[ch] ?? 0.6) * fontSize, 0);

function pointToBox(p: MapPoint, b: Box) {
  const dx = Math.max(b.x - p.x, 0, p.x - (b.x + b.w));
  const dy = Math.max(b.y - p.y, 0, p.y - (b.y + b.h));
  return Math.hypot(dx, dy);
}

const overlaps = (a: Box, b: Box, margin: number) =>
  a.x < b.x + b.w + margin && b.x < a.x + a.w + margin && a.y < b.y + b.h + margin && b.y < a.y + a.h + margin;

export type Placed = { code: string; anchor: MapPoint; box: Box; leader: boolean };

const RADII = [11, 14, 18, 23, 29, 36, 44, 54, 66, 80];
const ANGLES = Array.from({ length: 32 }, (_, k) => (k * Math.PI) / 16);

/**
 * Each label as close to its corner as it can go without touching the track (clearance px from the path's
 * centre line), the other labels or the obstacles (the start/finish marks), on the outside of the bend when it
 * can. The most crowded corners are placed first. A label set further out gets a leader line to its corner.
 */
export function placeLabels(
  labels: { code: string; anchor: MapPoint }[],
  path: MapPoint[],
  bounds: { width: number; height: number },
  opts: { fontSize: number; clearance: number; obstacles?: Box[] },
): Placed[] {
  const h = opts.fontSize + 2;
  const obstacles = opts.obstacles ?? [];
  const n = path.length;
  const cx = path.reduce((a, p) => a + p.x, 0) / n, cy = path.reduce((a, p) => a + p.y, 0) / n;

  const preferred = (anchor: MapPoint) => {
    // the outside of the bend at the corner; on a straight, away from the middle of the track
    let i = 0, best = Infinity;
    path.forEach((p, k) => {
      const d = Math.hypot(p.x - anchor.x, p.y - anchor.y);
      if (d < best) [best, i] = [d, k];
    });
    const a = path[(i - 6 + n) % n], b = path[i], c = path[(i + 6) % n];
    const tx = c.x - a.x, ty = c.y - a.y;
    const tl = Math.hypot(tx, ty) || 1;
    let nx = -ty / tl, ny = tx / tl; // perpendicular to the track
    const mx = (a.x + c.x) / 2 - b.x, my = (a.y + c.y) / 2 - b.y; // towards the inside of the bend
    const away = Math.hypot(mx, my) > 0.04 * tl ? -(mx * nx + my * ny) : (anchor.x - cx) * nx + (anchor.y - cy) * ny;
    if (away < 0) [nx, ny] = [-nx, -ny];
    return { nx, ny };
  };

  const crossesTrack = (a: MapPoint, b: MapPoint) => {
    const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy || 1;
    return path.some((p) => {
      if (Math.hypot(p.x - a.x, p.y - a.y) < 10) return false; // the track at the corner itself
      const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2));
      return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy) < 2.5;
    });
  };

  // how far each candidate is from the track, measured once
  const trackDistance = (box: Box) => path.reduce((m, p) => Math.min(m, pointToBox(p, box)), Infinity);
  const inBounds = (box: Box) =>
    box.x >= 1 && box.y >= 1 && box.x + box.w <= bounds.width - 1 && box.y + box.h <= bounds.height - 1;

  type Cand = { box: Box; cost: number; clear: number };
  const candidates = labels.map(({ code, anchor }) => {
    const w = labelWidth(code, opts.fontSize) + 2;
    const { nx, ny } = preferred(anchor);
    const out: Cand[] = [];
    for (const r of RADII) {
      for (const a of ANGLES) {
        const ux = Math.cos(a), uy = Math.sin(a);
        // the box's nearest edge r from the corner: wide labels sit further out sideways
        const bx = anchor.x + ux * (r + (w / 2) * Math.abs(ux));
        const by = anchor.y + uy * (r + (h / 2) * Math.abs(uy));
        const box = { x: bx - w / 2, y: by - h / 2, w, h };
        if (!inBounds(box) || obstacles.some((o) => overlaps(box, o, 2))) continue;
        // a leader that has to cross the track to reach its corner reads as pointing at the wrong one
        const crosses = r > 12 && crossesTrack(anchor, nearestOn(box, anchor));
        out.push({ box, cost: r + 9 * (1 - (ux * nx + uy * ny)) + (crosses ? 60 : 0), clear: trackDistance(box) });
      }
    }
    out.sort((p, q) => p.cost - q.cost);
    return out;
  });

  // fewest places off the track first
  const order = candidates
    .map((c, k) => ({ k, free: c.filter((x) => x.clear >= opts.clearance).length }))
    .sort((a, b) => a.free - b.free);
  const placed: (Placed | null)[] = labels.map(() => null);
  const taken: Box[] = [];
  for (const { k } of order) {
    const free = (x: Cand) => !taken.some((t) => overlaps(x.box, t, 3));
    const pick =
      candidates[k].find((x) => x.clear >= opts.clearance && free(x)) ??
      candidates[k].find((x) => x.clear >= opts.clearance / 2 && free(x)) ??
      candidates[k].find(free);
    if (!pick) continue;
    taken.push(pick.box);
    const a = labels[k].anchor;
    placed[k] = { code: labels[k].code, anchor: a, box: pick.box, leader: pointToBox(a, pick.box) > 12 };
  }
  return placed.filter((p): p is Placed => p !== null);
}

const nearestOn = (box: Box, p: MapPoint): MapPoint => ({
  x: Math.max(box.x, Math.min(p.x, box.x + box.w)),
  y: Math.max(box.y, Math.min(p.y, box.y + box.h)),
});

/** Where a leader line from the corner meets the label's box. */
export const leaderEnd = (p: Placed): MapPoint => nearestOn(p.box, p.anchor);
