// Zooming a chart along its x axis (distance, or lap number): the math behind the wheel, the box, the drag and the
// pinch, kept apart from React so `npm test` checks it (components/Zoom.tsx has the gestures). Gabriele, 2026-10-07:
// "add possibility to zoom on graphs". A view is a [from, to] range in the axis's own units; null is the whole axis.

export type Range = [number, number];

/** The narrowest a view gets, as a share of the whole axis: a 4.5 km lap down to 45 m. */
export const MIN_SHARE = 0.01;

const spanOf = (r: Range) => r[1] - r[0];
const least = (full: Range, minSpan = 0) => Math.min(spanOf(full), Math.max(minSpan, spanOf(full) * MIN_SHARE));

/** A view kept inside the whole axis and no narrower than its least span (`minSpan`, or MIN_SHARE of the axis);
 * null when it shows the whole axis. */
export function clampView(view: Range, full: Range, minSpan?: number): Range | null {
  const whole = spanOf(full);
  if (!(whole > 0) || !Number.isFinite(view[0]) || !Number.isFinite(view[1])) return null;
  let [a, b] = view[0] <= view[1] ? view : [view[1], view[0]];
  const narrowest = least(full, minSpan);
  if (b - a < narrowest) {
    const mid = (a + b) / 2;
    [a, b] = [mid - narrowest / 2, mid + narrowest / 2];
  }
  if (b - a >= whole * (1 - 1e-6)) return null;
  if (a < full[0]) [a, b] = [full[0], b + full[0] - a];
  if (b > full[1]) [a, b] = [a - (b - full[1]), full[1]];
  return [Math.max(a, full[0]), Math.min(b, full[1])];
}

/** The range a chart shows: its zoom, kept inside its own axis, or the whole axis. */
export const shownRange = (view: Range | null, full: Range, minSpan?: number): Range =>
  (view && clampView(view, full, minSpan)) || full;

/** Is the chart zoomed in? */
export const isZoomed = (view: Range | null, full: Range) =>
  !!view && (view[0] > full[0] + spanOf(full) * 1e-6 || view[1] < full[1] - spanOf(full) * 1e-6);

/** The axis value under a pixel (`left` and `width` are the plot area's), and the pixel of a value. */
export const valueAt = (px: number, view: Range, left: number, width: number) =>
  view[0] + ((px - left) / (width || 1)) * spanOf(view);
export const pixelOf = (v: number, view: Range, left: number, width: number) =>
  left + ((v - view[0]) / (spanOf(view) || 1)) * width;

/** Zoom in (factor below 1) or out (above 1) keeping the value at `anchor` under the pointer; null when the result
 * is the whole axis. */
export function zoomAround(view: Range, full: Range, anchor: number, factor: number, minSpan?: number): Range | null {
  const span = spanOf(view);
  const t = span > 0 ? Math.min(1, Math.max(0, (anchor - view[0]) / span)) : 0.5;
  const next = Math.min(spanOf(full), Math.max(span * factor, least(full, minSpan)));
  return clampView([anchor - t * next, anchor + (1 - t) * next], full, minSpan);
}

/** The wheel's zoom factor. A mouse notch (about 100 px) zooms by about a fifth; a trackpad pinch arrives as small
 * steps with ctrl held, so it counts for more per pixel. Scrolling up (negative) zooms in. */
export function wheelFactor(deltaY: number, deltaMode = 0, pinch = false) {
  const px = deltaMode === 1 ? deltaY * 16 : deltaMode === 2 ? deltaY * 400 : deltaY;
  return Math.exp(Math.max(-200, Math.min(200, px)) * (pinch ? 0.01 : 0.002));
}

/** Slide the view by `delta` axis units, kept inside the axis. */
export const panBy = (view: Range, full: Range, delta: number, minSpan?: number) =>
  clampView([view[0] + delta, view[1] + delta], full, minSpan);

/** The view a drag of `dx` pixels leaves, from the view the drag started on: the line follows the finger. */
export const dragView = (start: Range, full: Range, dx: number, width: number, minSpan?: number) =>
  panBy(start, full, (-dx / (width || 1)) * spanOf(start), minSpan);

/** The view a box dragged from pixel x0 to x1 zooms into; null when it is too narrow to be a box (a click) or would
 * show the whole axis. */
export function boxView(view: Range, full: Range, x0: number, x1: number, left: number, width: number,
  minPx = 6, minSpan?: number): Range | null {
  if (Math.abs(x1 - x0) < minPx) return null;
  const at = (px: number) => valueAt(Math.min(left + width, Math.max(left, px)), view, left, width);
  return clampView([at(Math.min(x0, x1)), at(Math.max(x0, x1))], full, minSpan);
}

/** A two-finger pinch: from the view at its start, with the fingers then at pixels p and now at q, the view that keeps
 * the value between the fingers between them, scaled by how far they have spread. Fingers too close to measure only
 * pan. */
export function pinchView(start: Range, full: Range, p: [number, number], q: [number, number], left: number,
  width: number, minSpan?: number): Range | null {
  const before = Math.abs(p[1] - p[0]), now = Math.abs(q[1] - q[0]);
  const span = before > 12 && now > 12
    ? Math.min(spanOf(full), Math.max(least(full, minSpan), (spanOf(start) * before) / now))
    : spanOf(start);
  const mid = valueAt((p[0] + p[1]) / 2, start, left, width);
  const a = mid - (((q[0] + q[1]) / 2 - left) / (width || 1)) * span;
  return clampView([a, a + span], full, minSpan);
}

/** The first and last points of a sorted axis that draw the view: the points inside it and one either side, so the
 * line runs to the edges (the chart clips what is past them). */
export function indexWindow(xs: ArrayLike<number>, view: Range): [number, number] {
  const n = xs.length;
  if (!n) return [0, -1];
  return [Math.max(0, firstAtLeast(xs, view[0]) - 1), Math.min(n - 1, firstAtLeast(xs, view[1], true))];
}

// the first index whose value is at least v (above v when `above`); n when there is none
function firstAtLeast(xs: ArrayLike<number>, v: number, above = false) {
  let lo = 0, hi = xs.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (above ? xs[mid] <= v : xs[mid] < v) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** The point of a sorted axis nearest a value. */
export function nearestIndex(xs: ArrayLike<number>, v: number) {
  const n = xs.length;
  if (n < 2) return 0;
  const i = Math.min(n - 1, Math.max(1, firstAtLeast(xs, v)));
  return v - xs[i - 1] <= xs[i] - v ? i - 1 : i;
}

/** The lowest and highest finite values of some series over points i0..i1 (gaps, null or NaN, left out); null when
 * there are none. */
export function extent(series: ArrayLike<number | null>[], i0: number, i1: number): Range | null {
  let lo = Infinity, hi = -Infinity;
  for (const s of series) {
    for (let i = Math.max(0, i0); i <= Math.min(i1, s.length - 1); i++) {
      const v = s[i];
      if (v == null || !Number.isFinite(v)) continue;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
  }
  return lo <= hi ? [lo, hi] : null;
}

/** A second tap close enough in time and place to the last one to be a double tap. */
export const isDoubleTap = (last: { t: number; x: number } | null, t: number, x: number, ms = 350, px = 30) =>
  !!last && t - last.t <= ms && Math.abs(x - last.x) <= px;

// ---------- in two directions: a map, the g-g diagram ----------
// A drawing that keeps its shape zooms both ways at once: by a scale `k` (1 is the whole drawing), about the point of
// the unzoomed drawing (in its pixels) now at the middle of the frame. The frame is the drawing's own w by h pixels.

export type Point = { x: number; y: number };
export type Plane = { k: number; cx: number; cy: number };

/** The most a drawing zooms in. */
export const MAX_SCALE = 12;

/** A zoom kept between the whole drawing and MAX_SCALE (or `maxK`), with the frame inside the drawing; null when it
 * shows the whole drawing. */
export function clampPlane(v: Plane, w: number, h: number, maxK = MAX_SCALE): Plane | null {
  if (!(w > 0) || !(h > 0) || ![v.k, v.cx, v.cy].every(Number.isFinite)) return null;
  const k = Math.min(maxK, v.k);
  if (k <= 1 + 1e-6) return null;
  const within = (c: number, size: number) => Math.min(size - size / (2 * k), Math.max(size / (2 * k), c));
  return { k, cx: within(v.cx, w), cy: within(v.cy, h) };
}

/** Where a point of the unzoomed drawing is drawn, and the point of the unzoomed drawing under a pixel. */
export const toFrame = (v: Plane | null, w: number, h: number, p: Point): Point =>
  v ? { x: (p.x - v.cx) * v.k + w / 2, y: (p.y - v.cy) * v.k + h / 2 } : p;
export const fromFrame = (v: Plane | null, w: number, h: number, p: Point): Point =>
  v ? { x: (p.x - w / 2) / v.k + v.cx, y: (p.y - h / 2) / v.k + v.cy } : p;

const whole = (w: number, h: number): Plane => ({ k: 1, cx: w / 2, cy: h / 2 });

/** Zoom by `factor` (below 1 in, as wheelFactor gives it) keeping the point under pixel `at` where it is. */
export function zoomPlaneAt(v: Plane | null, w: number, h: number, at: Point, factor: number, maxK?: number) {
  const base = v ?? whole(w, h);
  const under = fromFrame(v, w, h, at);
  const k = Math.max(1, Math.min(maxK ?? MAX_SCALE, base.k / factor));
  return clampPlane({ k, cx: under.x - (at.x - w / 2) / k, cy: under.y - (at.y - h / 2) / k }, w, h, maxK);
}

/** The zoom a drag of dx, dy pixels leaves, from the zoom it started on: the drawing follows the finger. */
export const dragPlane = (start: Plane | null, w: number, h: number, dx: number, dy: number, maxK?: number) =>
  start ? clampPlane({ k: start.k, cx: start.cx - dx / start.k, cy: start.cy - dy / start.k }, w, h, maxK) : null;

/** The zoom that fits a box dragged from pixel a to b, keeping the drawing's shape; null for a box too small to be
 * one (a click). */
export function boxPlane(v: Plane | null, w: number, h: number, a: Point, b: Point, minPx = 6, maxK?: number) {
  if (Math.abs(b.x - a.x) < minPx && Math.abs(b.y - a.y) < minPx) return null;
  const p = fromFrame(v, w, h, a), q = fromFrame(v, w, h, b);
  const bw = Math.max(Math.abs(q.x - p.x), 1e-9), bh = Math.max(Math.abs(q.y - p.y), 1e-9);
  const k = Math.max(1, Math.min(maxK ?? MAX_SCALE, w / bw, h / bh));
  return clampPlane({ k, cx: (p.x + q.x) / 2, cy: (p.y + q.y) / 2 }, w, h, maxK);
}

/** A two-finger pinch: from the zoom at its start, with the fingers then at p and now at q, the zoom that keeps the
 * point between the fingers between them, scaled by how far they have spread. Fingers too close to measure only pan. */
export function pinchPlane(start: Plane | null, w: number, h: number, p: [Point, Point], q: [Point, Point],
  maxK?: number) {
  const base = start ?? whole(w, h);
  const before = Math.hypot(p[1].x - p[0].x, p[1].y - p[0].y), now = Math.hypot(q[1].x - q[0].x, q[1].y - q[0].y);
  const k = before > 12 && now > 12 ? Math.max(1, Math.min(maxK ?? MAX_SCALE, (base.k * now) / before)) : base.k;
  const mid = (r: [Point, Point]) => ({ x: (r[0].x + r[1].x) / 2, y: (r[0].y + r[1].y) / 2 });
  const under = fromFrame(start, w, h, mid(p));
  const m = mid(q);
  return clampPlane({ k, cx: under.x - (m.x - w / 2) / k, cy: under.y - (m.y - h / 2) / k }, w, h, maxK);
}
