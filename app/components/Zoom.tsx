// Zooming charts (Gabriele, 2026-10-07: "add possibility to zoom on graphs"). On a computer the wheel (or a trackpad
// pinch) zooms about the pointer, a drag draws a box to zoom into and, once zoomed, a drag pans. On a phone two
// fingers pinch and one finger pans a zoomed chart sideways; a vertical swipe still scrolls the page. A double tap or
// double click, or the Reset zoom link, shows the whole chart again. A chart zooms along its x axis (ZoomArea), or a
// map both ways at once, keeping its shape (ZoomPlane). Charts in one ZoomGroup share their zoom: zoom the speed
// trace into a corner and the throttle, brake and every other trace there follow. The math is in lib/zoom.ts.
import { createContext, ReactNode, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { GestureResponderEvent, LayoutChangeEvent, Platform, StyleProp, StyleSheet, View, ViewStyle } from 'react-native';

import { TextLink } from '@/components/Programme';
import {
  boxPlane, boxView, dragPlane, dragView, isDoubleTap, isZoomed, panBy, pinchPlane, pinchView, Plane, Point, Range,
  shownRange, valueAt, wheelFactor, zoomAround, zoomPlaneAt,
} from '@/lib/zoom';
import { themed } from '@/constants/Theme';

export type Zoom = {
  view: Range | null; // null: the whole axis
  setView: (view: Range | null) => void;
  shared: boolean; // one of a ZoomGroup's charts (the group shows the Reset zoom link), or zoomed on its own
};

const ZoomContext = createContext<Zoom | null>(null);

/** A zoom to share between charts: give it to a ZoomGroup. It goes back to the whole axis when `reset` changes. */
export function useZoomState(reset?: unknown): Zoom {
  const [view, setView] = useState<Range | null>(null);
  const [last, setLast] = useState(reset);
  if (last !== reset) {
    setLast(reset);
    setView(null);
  }
  return useMemo(() => ({ view: last !== reset ? null : view, setView, shared: true }), [view, last, reset]);
}

/** Every chart inside zooms together: on `zoom` when the page reads it too, on a zoom of its own otherwise. */
export function ZoomGroup({ zoom, reset, children }: { zoom?: Zoom; reset?: unknown; children: ReactNode }) {
  const own = useZoomState(reset);
  return <ZoomContext.Provider value={zoom ?? own}>{children}</ZoomContext.Provider>;
}

/** A chart's zoom: its group's, or its own when it stands alone. */
export function useZoom(): Zoom {
  const group = useContext(ZoomContext);
  const [view, setView] = useState<Range | null>(null);
  return group ?? { view, setView, shared: false };
}

/** "Reset zoom", only while zoomed: the group's (inside a ZoomGroup) or the zoom given. Left off the printed page.
 * `reserve` keeps its place while not zoomed, so the charts under it don't move when a zoom starts. */
export function ResetZoom({ zoom, reserve }: { zoom?: { view: unknown; setView: (v: null) => void };
  reserve?: boolean }) {
  const group = useContext(ZoomContext);
  const z = zoom ?? group;
  if (!z?.view) {
    return reserve ? (
      <View style={{ opacity: 0 }} pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
        <TextLink small label="Reset zoom" disabled />
      </View>
    ) : null;
  }
  return <TextLink small label="Reset zoom" onPress={() => z.setView(null)} />;
}

/** How to zoom, for the line under a page's charts. */
export const ZOOM_HINT = 'Pinch or scroll on a chart to zoom in, or drag a box across it with the mouse; '
  + 'double-tap or double-click for the whole view again.';

type Mode = 'idle' | 'box' | 'pan' | 'scrub' | 'pinch' | 'done';
type Pt = Point;
const TAP_PX = 6; // a touch that moves less than this is a tap
let lastPageWheel = 0; // when the page last scrolled under a wheel: a chart arriving under the pointer lets it go on
let watching = false;

// What a chart's zoom does with each gesture, on the zoom it keeps (`S`: a range of its axis, or a map's scale and
// centre; null for the whole chart). Each returns the new zoom.
type Ops<S> = {
  zoomed: (s: S) => boolean;
  pinch: (start: S, p: [Pt, Pt], q: [Pt, Pt]) => S;
  drag: (start: S, dx: number, dy: number) => S;
  box: (start: S, a: Pt, b: Pt) => S | undefined; // undefined: too small to be a box
  wheel: (base: S, at: Pt, factor: number) => S;
  slide: (base: S, dx: number, dy: number) => S; // a sideways scroll on a zoomed chart
};

type Live<S> = {
  view: S; // the zoom as the page has it
  setView: (s: S) => void;
  ops: Ops<S>;
  onCursor: (x: number, y: number) => void;
  onLeave?: () => void;
  onRelease?: (touch: boolean, x: number, y: number) => void;
};

/** The gestures, on the web (pointer events and the wheel, straight on the element) and on phones (the responder's
 * touches): the element's ref, the props for the native responder, and the box being dragged. `plane`: a drawing
 * zoomed both ways, which a finger pans every way once zoomed. */
function useGestures<S>(cfg: Live<S>, whole: S, plane: boolean) {
  const ref = useRef<View>(null);
  const [box, setBox] = useState<[Pt, Pt] | null>(null);
  const live = useRef(cfg);
  live.current = cfg;
  // the gesture under way: the pointers down, where it started and on which zoom
  const g = useRef({ mode: 'idle' as Mode, pts: new Map<number, Pt>(), p0: { x: 0, y: 0 } as Pt, start: whole,
    pinch: [{ x: 0, y: 0 }, { x: 0, y: 0 }] as [Pt, Pt], moved: false, captured: false,
    lastTap: null as { t: number; x: number } | null, origin: { x: 0, y: 0 } as Pt }).current;

  // a new zoom at most once a frame; the latest asked for is the base of the next wheel step, also while React has
  // yet to draw the one last sent
  const pending = useRef<{ v: S } | null>(null);
  const sent = useRef<{ v: S; before: S } | null>(null);
  const frame = useRef(0);
  const current = (): S => {
    if (pending.current) return pending.current.v;
    if (sent.current && sent.current.before === live.current.view) return sent.current.v;
    return live.current.view;
  };
  const apply = (v: S) => {
    pending.current = { v };
    if (frame.current) return;
    const run = () => {
      frame.current = 0;
      const p = pending.current;
      pending.current = null;
      if (!p) return;
      sent.current = { v: p.v, before: live.current.view };
      live.current.setView(p.v);
    };
    frame.current = typeof requestAnimationFrame === 'function' ? requestAnimationFrame(run) : (setTimeout(run, 16) as any);
  };
  useEffect(() => () => {
    if (frame.current && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frame.current);
  }, []);

  const h = useMemo(() => {
    const L = () => live.current;
    const zoomed = () => L().ops.zoomed(current());
    const two = (): [Pt, Pt] => {
      const [a, b] = [...g.pts.values()];
      return [a, b];
    };
    const down = (id: number, p: Pt, mouse: boolean, shift = false) => {
      g.pts.set(id, p);
      if (g.pts.size === 1) {
        g.p0 = p;
        g.start = current();
        g.moved = false;
        g.captured = false;
        g.mode = mouse ? (shift || !zoomed() ? 'box' : 'pan') : zoomed() ? 'pan' : 'scrub';
        L().onCursor(p.x, p.y);
      } else if (g.pts.size === 2) {
        g.mode = 'pinch';
        g.pinch = two();
        g.start = current();
        setBox(null);
      }
    };
    const move = (id: number, p: Pt) => {
      if (!g.pts.has(id)) return;
      g.pts.set(id, p);
      const { ops } = L();
      if (g.mode !== 'pinch' && Math.hypot(p.x - g.p0.x, p.y - g.p0.y) > TAP_PX) g.moved = true;
      if (g.mode === 'pinch') {
        apply(ops.pinch(g.start, g.pinch, two()));
      } else if (g.mode === 'box') {
        if (g.moved) setBox([g.p0, p]);
        L().onCursor(p.x, p.y);
      } else if (g.mode === 'pan') {
        if (g.moved) apply(ops.drag(g.start, p.x - g.p0.x, p.y - g.p0.y));
        L().onCursor(p.x, p.y);
      } else if (g.mode === 'scrub') {
        L().onCursor(p.x, p.y);
      }
    };
    const up = (id: number, p: Pt, touch: boolean) => {
      if (!g.pts.delete(id)) return;
      if (g.mode === 'pinch') {
        g.mode = g.pts.size ? 'done' : 'idle'; // the finger left on the glass doesn't pan from where it is
        return;
      }
      if (g.pts.size) return;
      const was = g.mode;
      g.mode = 'idle';
      if (was === 'done') return;
      if (was === 'box' && g.moved) {
        setBox(null);
        const v = L().ops.box(g.start, g.p0, p);
        if (v !== undefined) apply(v);
        return;
      }
      if (was === 'pan' && g.moved) return;
      if (touch && !g.moved) {
        const t = Date.now();
        if (isDoubleTap(g.lastTap, t, p.x)) {
          g.lastTap = null;
          apply(whole);
          return;
        }
        g.lastTap = { t, x: p.x };
      }
      L().onRelease?.(touch, p.x, p.y);
    };
    const cancel = () => {
      g.pts.clear();
      g.mode = 'idle';
      setBox(null);
    };
    const wheel = (e: WheelEvent, at: Pt) => {
      const pinch = e.ctrlKey; // a trackpad pinch
      if (!pinch && Date.now() - lastPageWheel < 400) return; // the page is scrolling under the pointer
      const { ops } = L();
      const base = current();
      if (!pinch && Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        if (!ops.zoomed(base)) return;
        e.preventDefault();
        apply(ops.slide(base, e.deltaX, plane ? e.deltaY : 0));
        return;
      }
      if (!pinch && e.deltaY > 0 && !ops.zoomed(base)) return; // nothing to zoom out of: the page scrolls
      e.preventDefault();
      apply(ops.wheel(base, at, wheelFactor(e.deltaY, e.deltaMode, pinch)));
    };
    return { down, move, up, cancel, wheel };
    // the handlers read everything else from `live`
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // the web: pointer events and the wheel on the element itself (React's wheel listener can't stop the page
  // scrolling). touch-action pan-y leaves vertical swipes to the browser, so the page scrolls; sideways drags and
  // pinches come here (on a zoomed map every drag does: it pans every way).
  useEffect(() => {
    if (Platform.OS !== 'web') return;
    const el = ref.current as unknown as HTMLElement | null;
    if (!el || typeof el.addEventListener !== 'function') return;
    if (!watching && typeof window !== 'undefined') {
      watching = true;
      window.addEventListener('wheel', (e) => {
        if (!e.defaultPrevented) lastPageWheel = Date.now();
      }, { passive: true });
    }
    el.style.userSelect = 'none';
    el.style.setProperty('-webkit-user-select', 'none');
    const rel = (e: MouseEvent): Pt => {
      const r = el.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    const onDown = (e: PointerEvent) => {
      const mouse = e.pointerType === 'mouse';
      if (mouse && e.button !== 0) return;
      if (mouse) e.preventDefault(); // no text selected by the drag
      h.down(e.pointerId, rel(e), mouse, e.shiftKey);
    };
    const onMove = (e: PointerEvent) => {
      if (g.pts.has(e.pointerId)) {
        h.move(e.pointerId, rel(e));
        // the mouse is held once it drags (a box or a pan), so it can leave the chart; a click stays a click
        if (e.pointerType === 'mouse' && g.moved && !g.captured) {
          g.captured = true;
          el.setPointerCapture?.(e.pointerId);
        }
      } else if (e.pointerType === 'mouse' && g.mode === 'idle') {
        const p = rel(e);
        live.current.onCursor(p.x, p.y); // hover
      }
    };
    const onUp = (e: PointerEvent) => h.up(e.pointerId, rel(e), e.pointerType !== 'mouse');
    const onCancel = () => h.cancel(); // the browser took the touch to scroll the page
    const onLeave = (e: PointerEvent) => {
      if (e.pointerType === 'mouse' && !g.pts.size) live.current.onLeave?.();
    };
    const onWheel = (e: WheelEvent) => h.wheel(e, rel(e));
    const onDouble = () => apply(whole);
    el.addEventListener('pointerdown', onDown);
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onUp);
    el.addEventListener('pointercancel', onCancel);
    el.addEventListener('pointerleave', onLeave);
    el.addEventListener('wheel', onWheel, { passive: false });
    el.addEventListener('dblclick', onDouble);
    return () => {
      el.removeEventListener('pointerdown', onDown);
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', onUp);
      el.removeEventListener('pointercancel', onCancel);
      el.removeEventListener('pointerleave', onLeave);
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('dblclick', onDouble);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const panAll = plane && cfg.ops.zoomed(cfg.view);
  useEffect(() => {
    const el = ref.current as unknown as HTMLElement | null;
    if (Platform.OS === 'web' && el?.style) el.style.touchAction = panAll ? 'none' : 'pan-y';
  }, [panAll]);

  // iOS and Android: the responder's touches, each finger by its identifier, from the area's top left corner
  const native = Platform.OS === 'web' ? {} : {
    onStartShouldSetResponder: () => true,
    onMoveShouldSetResponder: () => true,
    // a scroll of the page may take the touch over, except in the middle of a pinch or a zoomed map's pan
    onResponderTerminationRequest: () => g.mode !== 'pinch' && !(plane && g.mode === 'pan'),
    onResponderGrant: (e: GestureResponderEvent) => {
      g.origin = { x: e.nativeEvent.pageX - e.nativeEvent.locationX, y: e.nativeEvent.pageY - e.nativeEvent.locationY };
      sync(e);
    },
    onResponderMove: (e: GestureResponderEvent) => sync(e),
    onResponderRelease: (e: GestureResponderEvent) => {
      const at = { x: e.nativeEvent.pageX - g.origin.x, y: e.nativeEvent.pageY - g.origin.y };
      for (const id of [...g.pts.keys()]) h.up(id, at, true);
    },
    onResponderTerminate: () => h.cancel(),
  };
  function sync(e: GestureResponderEvent) {
    const touches = e.nativeEvent.touches ?? [];
    const now = new Map(touches.map((t) => [Number(t.identifier), { x: t.pageX - g.origin.x, y: t.pageY - g.origin.y }]));
    for (const [id, p] of [...g.pts]) if (!now.has(id)) h.up(id, p, true);
    for (const [id, p] of now) {
      if (g.pts.has(id)) h.move(id, p);
      else if (g.mode !== 'done') h.down(id, p, false);
    }
  }
  return { ref, native, box };
}

type AreaProps = {
  zoom: Zoom;
  full: Range; // the whole axis, in its own units
  view?: Range; // no longer read: the area works out the range shown from `zoom` and `full` itself
  left: number; // the plot area, in pixels from the area's left edge
  width: number;
  minSpan?: number; // the narrowest view, in axis units (a hundredth of the axis by default)
  onCursor: (x: number, y: number) => void; // the pointer's or finger's place, to move the crosshair to
  onLeave?: () => void; // the mouse left the chart
  onRelease?: (touch: boolean, x: number, y: number) => void; // a tap, a click or a scrub ended (not a zoom or a pan)
  onLayout?: (e: LayoutChangeEvent) => void;
  style?: StyleProp<ViewStyle>;
  children: ReactNode;
};

/** The part of a chart zoomed along its x axis that takes the gestures and the crosshair: wrap the plot in it. */
export function ZoomArea({ zoom, full, left, width, minSpan, onCursor, onLeave, onRelease, onLayout, style,
  children }: AreaProps) {
  const styles = useStyles();
  const at = useRef({ full, left, width, minSpan });
  at.current = { full, left, width, minSpan };
  const ops = useMemo<Ops<Range | null>>(() => {
    const A = () => at.current;
    const shown = (s: Range | null) => shownRange(s, A().full, A().minSpan);
    return {
      zoomed: (s) => isZoomed(shown(s), A().full),
      pinch: (s, p, q) => pinchView(shown(s), A().full, [p[0].x, p[1].x], [q[0].x, q[1].x], A().left, A().width,
        A().minSpan),
      drag: (s, dx) => dragView(shown(s), A().full, dx, A().width, A().minSpan),
      box: (s, a, b) => boxView(shown(s), A().full, a.x, b.x, A().left, A().width, TAP_PX, A().minSpan) ?? undefined,
      wheel: (s, p, factor) => {
        const v = shown(s);
        const anchor = valueAt(Math.min(A().left + A().width, Math.max(A().left, p.x)), v, A().left, A().width);
        return zoomAround(v, A().full, anchor, factor, A().minSpan);
      },
      slide: (s, dx) => {
        const v = shown(s);
        return panBy(v, A().full, (dx / (A().width || 1)) * (v[1] - v[0]), A().minSpan);
      },
    };
  }, []);
  const { ref, native, box } = useGestures<Range | null>({ view: zoom.view, setView: zoom.setView, ops, onCursor,
    onLeave, onRelease }, null, false);
  const lo = box ? Math.max(left, Math.min(box[0].x, box[1].x)) : 0;
  const hi = box ? Math.min(left + width, Math.max(box[0].x, box[1].x)) : 0;
  return (
    <View ref={ref} onLayout={onLayout} style={style} {...native}>
      {children}
      {box && hi > lo && (
        <View pointerEvents="none" style={StyleSheet.flatten([styles.box, { top: 0, bottom: 0, left: lo, width: hi - lo }])}>
          <View style={styles.boxFill} />
        </View>
      )}
    </View>
  );
}

/** A map's or a diagram's zoom: both ways at once, keeping its shape; back to the whole drawing when `reset`
 * changes. */
export type PlaneZoom = { view: Plane | null; setView: (v: Plane | null) => void };
export function usePlaneZoom(reset?: unknown): PlaneZoom {
  const [view, setView] = useState<Plane | null>(null);
  const [last, setLast] = useState(reset);
  if (last !== reset) {
    setLast(reset);
    setView(null);
  }
  return useMemo(() => ({ view: last !== reset ? null : view, setView }), [view, last, reset]);
}

type PlaneProps = {
  zoom: PlaneZoom;
  width: number; // the drawing, px: the frame it zooms in
  height: number;
  maxScale?: number;
  onCursor?: (x: number, y: number) => void; // the pointer or finger, in the frame's pixels
  onLeave?: () => void;
  onRelease?: (touch: boolean, x: number, y: number) => void; // a tap or a click (not a zoom or a pan)
  onLayout?: (e: LayoutChangeEvent) => void;
  style?: StyleProp<ViewStyle>;
  children: ReactNode;
};

/** The part of a map or a diagram that zooms both ways: the wheel or a pinch about the pointer, a box dragged across
 * it, a drag (any way) once zoomed; a double tap or double click for the whole drawing again. Draw what it holds
 * through `toFrame(zoom.view, width, height, point)`. */
export function ZoomPlane({ zoom, width, height, maxScale, onCursor, onLeave, onRelease, onLayout, style,
  children }: PlaneProps) {
  const styles = useStyles();
  const at = useRef({ width, height, maxScale });
  at.current = { width, height, maxScale };
  const ops = useMemo<Ops<Plane | null>>(() => {
    const A = () => at.current;
    return {
      zoomed: (s) => !!s,
      pinch: (s, p, q) => pinchPlane(s, A().width, A().height, p, q, A().maxScale),
      drag: (s, dx, dy) => dragPlane(s, A().width, A().height, dx, dy, A().maxScale),
      box: (s, a, b) => boxPlane(s, A().width, A().height, a, b, TAP_PX, A().maxScale) ?? undefined,
      wheel: (s, p, factor) => zoomPlaneAt(s, A().width, A().height, p, factor, A().maxScale),
      slide: (s, dx, dy) => dragPlane(s, A().width, A().height, -dx, -dy, A().maxScale),
    };
  }, []);
  const { ref, native, box } = useGestures<Plane | null>({ view: zoom.view, setView: zoom.setView, ops,
    onCursor: onCursor ?? (() => {}), onLeave, onRelease }, null, true);
  return (
    <View ref={ref} onLayout={onLayout} style={style} {...native}>
      {children}
      {box && (
        <View pointerEvents="none" style={StyleSheet.flatten([styles.box, styles.boxAround, {
          left: Math.min(box[0].x, box[1].x), top: Math.min(box[0].y, box[1].y),
          width: Math.abs(box[1].x - box[0].x), height: Math.abs(box[1].y - box[0].y) }])}>
          <View style={styles.boxFill} />
        </View>
      )}
    </View>
  );
}

const useStyles = themed((c) => ({
  box: { position: 'absolute', borderLeftWidth: 1, borderRightWidth: 1, borderColor: c.chart.ink2,
    backgroundColor: 'transparent' },
  boxAround: { borderTopWidth: 1, borderBottomWidth: 1 },
  boxFill: { flex: 1, backgroundColor: c.chart.ink, opacity: 0.08 },
}));
