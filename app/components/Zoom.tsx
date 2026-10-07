// Zooming charts along their x axis (Gabriele, 2026-10-07: "add possibility to zoom on graphs"). On a computer the
// wheel (or a trackpad pinch) zooms about the pointer, a drag draws a box to zoom into and, once zoomed, a drag pans.
// On a phone two fingers pinch and one finger pans a zoomed chart sideways; a vertical swipe still scrolls the page.
// A double tap or double click, or the Reset zoom link, shows the whole axis again. Charts in one ZoomGroup share
// their zoom: zoom the speed trace into a corner and the throttle, brake and every other trace there follow. The
// math is in lib/zoom.ts.
import { createContext, ReactNode, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { GestureResponderEvent, LayoutChangeEvent, Platform, StyleProp, StyleSheet, View, ViewStyle } from 'react-native';

import { TextLink } from '@/components/Programme';
import {
  boxView, dragView, isDoubleTap, isZoomed, panBy, pinchView, Range, valueAt, wheelFactor, zoomAround,
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
export function ResetZoom({ zoom, reserve }: { zoom?: Zoom; reserve?: boolean }) {
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
const TAP_PX = 6; // a touch that moves less than this is a tap
let lastPageWheel = 0; // when the page last scrolled under a wheel: a chart arriving under the pointer lets it go on
let watching = false;

type AreaProps = {
  zoom: Zoom;
  full: Range; // the whole axis, in its own units
  view: Range; // the part shown
  left: number; // the plot area, in pixels from the area's left edge
  width: number;
  minSpan?: number; // the narrowest view, in axis units (a hundredth of the axis by default)
  onCursor: (px: number) => void; // the pointer's or finger's x, to move the crosshair to
  onLeave?: () => void; // the mouse left the chart
  onRelease?: (touch: boolean) => void; // a tap, a click or a scrub ended (not a zoom or a pan)
  onLayout?: (e: LayoutChangeEvent) => void;
  style?: StyleProp<ViewStyle>;
  children: ReactNode;
};

/** The part of a chart that takes the zoom gestures and the crosshair: wrap the plot in it. */
export function ZoomArea({ zoom, full, view, left, width, minSpan, onCursor, onLeave, onRelease, onLayout, style,
  children }: AreaProps) {
  const styles = useStyles();
  const ref = useRef<View>(null);
  const [box, setBox] = useState<Range | null>(null);
  const live = useRef({ zoom, full, view, left, width, minSpan, onCursor, onLeave, onRelease });
  live.current = { zoom, full, view, left, width, minSpan, onCursor, onLeave, onRelease };
  // the gesture under way: the pointers down (their x), where it started and on which view
  const g = useRef({ mode: 'idle' as Mode, pts: new Map<number, number>(), x0: 0, start: view, pinch: [0, 0] as Range,
    moved: false, lastTap: null as { t: number; x: number } | null, origin: 0 }).current;

  // a new view at most once a frame; the latest asked for is the base of the next wheel step, also while React has
  // yet to draw the one last sent
  const pending = useRef<{ v: Range | null } | null>(null);
  const sent = useRef<{ v: Range | null; before: Range | null } | null>(null);
  const frame = useRef(0);
  const current = (): Range => {
    const ask = pending.current ?? (sent.current && sent.current.before === live.current.zoom.view ? sent.current : null);
    return ask ? ask.v ?? live.current.full : live.current.view;
  };
  const apply = (v: Range | null) => {
    pending.current = { v };
    if (frame.current) return;
    const run = () => {
      frame.current = 0;
      const p = pending.current;
      pending.current = null;
      if (!p) return;
      sent.current = { v: p.v, before: live.current.zoom.view };
      live.current.zoom.setView(p.v);
    };
    frame.current = typeof requestAnimationFrame === 'function' ? requestAnimationFrame(run) : (setTimeout(run, 16) as any);
  };
  useEffect(() => () => {
    if (frame.current && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frame.current);
  }, []);

  const h = useMemo(() => {
    const L = () => live.current;
    const zoomed = () => isZoomed(current(), L().full);
    const down = (id: number, x: number, mouse: boolean, shift = false) => {
      g.pts.set(id, x);
      if (g.pts.size === 1) {
        g.x0 = x;
        g.start = current();
        g.moved = false;
        g.mode = mouse ? (shift || !zoomed() ? 'box' : 'pan') : zoomed() ? 'pan' : 'scrub';
        L().onCursor(x);
      } else if (g.pts.size === 2) {
        const [a, b] = [...g.pts.values()];
        g.mode = 'pinch';
        g.pinch = [a, b];
        g.start = current();
        setBox(null);
      }
    };
    const move = (id: number, x: number) => {
      if (!g.pts.has(id)) return;
      g.pts.set(id, x);
      const { full, left, width, minSpan } = L();
      if (g.mode !== 'pinch' && Math.abs(x - g.x0) > TAP_PX) g.moved = true;
      if (g.mode === 'pinch') {
        const [a, b] = [...g.pts.values()];
        apply(pinchView(g.start, full, g.pinch, [a, b], left, width, minSpan));
      } else if (g.mode === 'box') {
        if (g.moved) setBox([g.x0, x]);
        L().onCursor(x);
      } else if (g.mode === 'pan') {
        if (g.moved) apply(dragView(g.start, full, x - g.x0, width, minSpan));
        L().onCursor(x);
      } else if (g.mode === 'scrub') {
        L().onCursor(x);
      }
    };
    const up = (id: number, x: number, touch: boolean) => {
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
        const { full, left, width, minSpan } = L();
        const v = boxView(g.start, full, g.x0, x, left, width, TAP_PX, minSpan);
        if (v) apply(v);
        return;
      }
      if (was === 'pan' && g.moved) return;
      if (touch && !g.moved) {
        const t = Date.now();
        if (isDoubleTap(g.lastTap, t, x)) {
          g.lastTap = null;
          apply(null);
          return;
        }
        g.lastTap = { t, x };
      }
      L().onRelease?.(touch);
    };
    const cancel = () => {
      g.pts.clear();
      g.mode = 'idle';
      setBox(null);
    };
    const wheel = (e: WheelEvent, x: number) => {
      const pinch = e.ctrlKey; // a trackpad pinch
      if (!pinch && Date.now() - lastPageWheel < 400) return; // the page is scrolling under the pointer
      const { full, left, width, minSpan } = L();
      const base = current();
      if (!pinch && Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        if (!isZoomed(base, full)) return;
        e.preventDefault();
        apply(panBy(base, full, (e.deltaX / (width || 1)) * (base[1] - base[0]), minSpan));
        return;
      }
      if (!pinch && e.deltaY > 0 && !isZoomed(base, full)) return; // nothing to zoom out of: the page scrolls
      e.preventDefault();
      const anchor = valueAt(Math.min(left + width, Math.max(left, x)), base, left, width);
      apply(zoomAround(base, full, anchor, wheelFactor(e.deltaY, e.deltaMode, pinch), minSpan));
    };
    return { down, move, up, cancel, wheel };
    // the handlers read everything else from `live`
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // the web: pointer events and the wheel, straight on the element (React's wheel listener can't stop the page
  // scrolling). touch-action pan-y leaves vertical swipes to the browser, so the page scrolls; sideways drags and
  // pinches come here.
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
    el.style.touchAction = 'pan-y';
    el.style.userSelect = 'none';
    el.style.setProperty('-webkit-user-select', 'none');
    const rel = (e: MouseEvent) => e.clientX - el.getBoundingClientRect().left;
    const onDown = (e: PointerEvent) => {
      const mouse = e.pointerType === 'mouse';
      if (mouse && e.button !== 0) return;
      if (mouse) {
        e.preventDefault(); // no text selected by the drag
        el.setPointerCapture?.(e.pointerId);
      }
      h.down(e.pointerId, rel(e), mouse, e.shiftKey);
    };
    const onMove = (e: PointerEvent) => {
      if (g.pts.has(e.pointerId)) h.move(e.pointerId, rel(e));
      else if (e.pointerType === 'mouse' && g.mode === 'idle') live.current.onCursor(rel(e)); // hover
    };
    const onUp = (e: PointerEvent) => h.up(e.pointerId, rel(e), e.pointerType !== 'mouse');
    const onCancel = () => h.cancel(); // the browser took the touch to scroll the page
    const onLeave = (e: PointerEvent) => {
      if (e.pointerType === 'mouse' && !g.pts.size) live.current.onLeave?.();
    };
    const onWheel = (e: WheelEvent) => h.wheel(e, rel(e));
    const onDouble = () => apply(null);
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

  // iOS and Android: the responder's touches, each finger by its identifier, x from the area's left edge
  const native = Platform.OS === 'web' ? {} : {
    onStartShouldSetResponder: () => true,
    onMoveShouldSetResponder: () => true,
    // a scroll of the page may take the touch over, except in the middle of a pinch
    onResponderTerminationRequest: () => g.mode !== 'pinch',
    onResponderGrant: (e: GestureResponderEvent) => {
      g.origin = e.nativeEvent.pageX - e.nativeEvent.locationX;
      sync(e);
    },
    onResponderMove: (e: GestureResponderEvent) => sync(e),
    onResponderRelease: (e: GestureResponderEvent) => {
      for (const id of [...g.pts.keys()]) h.up(id, e.nativeEvent.pageX - g.origin, true);
    },
    onResponderTerminate: () => h.cancel(),
  };
  function sync(e: GestureResponderEvent) {
    const touches = e.nativeEvent.touches ?? [];
    const now = new Map(touches.map((t) => [Number(t.identifier), t.pageX - g.origin]));
    for (const [id, x] of [...g.pts]) if (!now.has(id)) h.up(id, x, true);
    for (const [id, x] of now) {
      if (g.pts.has(id)) h.move(id, x);
      else if (g.mode !== 'done') h.down(id, x, false);
    }
  }

  const lo = box ? Math.max(left, Math.min(box[0], box[1])) : 0;
  const hi = box ? Math.min(left + width, Math.max(box[0], box[1])) : 0;
  return (
    <View ref={ref} onLayout={onLayout} style={style} {...native}>
      {children}
      {box && hi > lo && (
        <View pointerEvents="none" style={StyleSheet.flatten([styles.box, { left: lo, width: hi - lo }])}>
          <View style={styles.boxFill} />
        </View>
      )}
    </View>
  );
}

const useStyles = themed((c) => ({
  box: { position: 'absolute', top: 0, bottom: 0, borderLeftWidth: 1, borderRightWidth: 1, borderColor: c.chart.ink2,
    backgroundColor: 'transparent' },
  boxFill: { flex: 1, backgroundColor: c.chart.ink, opacity: 0.08 },
}));
