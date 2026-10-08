import { useEffect, useMemo, useState } from 'react';
import { LayoutChangeEvent, Platform, Pressable, StyleSheet } from 'react-native';
import Svg, { Circle, G, Line, Path, Rect, Text as SvgText } from 'react-native-svg';

import { Text, View, useThemeColor } from '@/components/Themed';
import { useColorScheme } from '@/components/useColorScheme';
import { glyph, ShapeLegend, ShapePanel, useShapeColors, useTrackShape } from '@/components/TrackShape';
import { ResetZoom, usePlaneZoom, ZoomPlane } from '@/components/Zoom';
import { formatLap } from '@/lib/api';
import {
  Box,
  cornersOf,
  fetchTrackMap,
  fitTrack,
  leaderEnd,
  MapPoint,
  NoTrackMap,
  Placed,
  placeLabels,
  TrackMapData,
} from '@/lib/trackmap';
import { featureMid, featureSpan, TrackShapeData } from '@/lib/trackshape';
import { noPrint } from '@/lib/print';
import { Plane, Point, toFrame } from '@/lib/zoom';
import { a11yState } from '@/lib/a11yState';
import { byScheme, Fonts, TAP, themed, Type } from '@/constants/Theme';

type Props = {
  session?: number; // draw this session's best clean lap
  event?: number; // or the event's fastest clean lap
  highlight?: string; // the section to emphasise: its code ("T2-T5") or an official corner inside it ("T3")
  marks?: MapMark[]; // numbered points on the lap, such as a lap's mistakes
  selectedMark?: number | null; // its stretch of the lap drawn over the track
  marksLengthM?: number; // the lap length the marks' metres are measured on, when it isn't the map's own
  cursorM?: number | null; // a dot where a chart's cursor is, in the marks' metres
  withShape?: boolean; // also the track's shape: banking, crests and compressions on the map, the height below it
  onShape?: (shape: TrackShapeData | null) => void; // the shape once it has loaded (null until then, or when none)
  maxHeight?: number; // the most the drawing may take, px (it never grows past its usual size)
  compact?: boolean; // the drawing alone: no title, switch, legend or caption (a map pinned on a phone)
  onNone?: () => void; // there's no map to draw (no log, no clean lap, no GPS): the map shows nothing
  // sections in colours of their own (code -> colour), as the cards naming them wear them; the others stay grey
  sectionColors?: Record<string, string>;
  sectionKey?: string; // what those colours say, under the map
};

export type MapMark = { n: number; at_m: number; from_m: number; to_m: number };

// Chart chrome and ramps from the validated palette: neutral inks for the track and its sections, the highlight colour
// for the emphasised section, the one-hue blue ramp for speed (slow near the surface).
const PALETTE = byScheme((c) => ({
  ink: c.chart.ink,
  secondary: c.chart.ink2,
  muted: c.chart.muted,
  casing: c.chart.axis,
  accent: c.chart.series[0],
  speed: c.chart.speed,
}));

const PAD = 34; // room round the track for labels
// label size, track stroke, emphasised stroke and chequer square (the start/finish tick is 2 squares along the
// track and 4 across), px: a little larger on a wide screen
const sizes = (width: number) =>
  width >= 700 ? { font: 13, track: 7, strong: 10, check: 5 } : { font: 12, track: 5, strong: 8, check: 4 };
// SVG text on the web falls back to a serif face; use the system sans like the rest of the app
const SANS = Fonts.sans;

type Mode = 'sections' | 'speed';

const unit = (x: number, y: number) => {
  const l = Math.hypot(x, y) || 1;
  return { x: x / l, y: y / l };
};
const line = (pts: MapPoint[]) => pts.map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join('');

// The drawing, zoomed by `view` (both ways, keeping the track's shape: lib/zoom.ts) when it is given. The lines and
// marks keep their size; the corner labels are placed once, on the whole map, and move with their corners.
function layout(map: TrackMapData, width: number, maxHeight?: number, view: Plane | null = null) {
  const z = sizes(width);
  const usual = Math.min(460, Math.max(280, width * 0.72));
  const fit = fitTrack(map, width, maxHeight == null ? usual : Math.min(usual, maxHeight), PAD);
  const T = (p: MapPoint) => toFrame(view, fit.width, fit.height, p);
  const pts = view ? fit.pts.map(T) : fit.pts;
  const n = pts.length;
  const at = (m: number) => Math.min(Math.round(m / map.step_m), n);
  const pt = (i: number) => pts[((i % n) + n) % n];
  const tangent = (i: number) => unit(pt(i + 1).x - pt(i - 1).x, pt(i + 1).y - pt(i - 1).y);

  const sections = map.sections.map((s, k) => {
    const i0 = at(s.start_m);
    const i1 = k === map.sections.length - 1 ? n : Math.max(at(s.end_m), i0 + 1); // the last one closes the loop
    const run: MapPoint[] = [];
    for (let i = i0; i <= i1; i++) run.push(pt(i));
    return { ...s, i0, i1, d: line(run) };
  });
  const boundaries = sections.slice(1).map((s) => ({ p: pt(s.i0), t: tangent(s.i0) }));

  // start/finish: the line across the track at the first point, the arrow beside it on the outside
  const s0 = pts[0];
  const dir = unit(map.start.dx, -map.start.dy); // screen y runs down
  const cx = pts.reduce((a, p) => a + p.x, 0) / n, cy = pts.reduce((a, p) => a + p.y, 0) / n;
  let side = { x: -dir.y, y: dir.x };
  if ((s0.x - cx) * side.x + (s0.y - cy) * side.y < 0) side = { x: -side.x, y: -side.y };
  const a0 = { x: s0.x + side.x * 15 + dir.x * 3, y: s0.y + side.y * 15 + dir.y * 3 };
  const a1 = { x: a0.x + dir.x * 20, y: a0.y + dir.y * 20 };
  const head = (turn: number) => ({
    x: a1.x - 6 * (dir.x * Math.cos(turn) - dir.y * Math.sin(turn)),
    y: a1.y - 6 * (dir.x * Math.sin(turn) + dir.y * Math.cos(turn)),
  });
  const arrow = `M${a0.x.toFixed(1)},${a0.y.toFixed(1)}L${a1.x.toFixed(1)},${a1.y.toFixed(1)}` +
    `M${head(0.5).x.toFixed(1)},${head(0.5).y.toFixed(1)}L${a1.x.toFixed(1)},${a1.y.toFixed(1)}` +
    `L${head(-0.5).x.toFixed(1)},${head(-0.5).y.toFixed(1)}`;
  const box = (ps: MapPoint[], m: number): Box => {
    const xs = ps.map((p) => p.x), ys = ps.map((p) => p.y);
    return { x: Math.min(...xs) - m, y: Math.min(...ys) - m, w: Math.max(...xs) - Math.min(...xs) + 2 * m,
      h: Math.max(...ys) - Math.min(...ys) + 2 * m };
  };
  const obstacles = [box([s0], 2.5 * z.check), box([a0, a1, head(0.5), head(-0.5)], 2)];

  const anchors = map.sections.filter((s) => s.apex).map((s) => ({ code: s.code, anchor: fit.px(s.apex!) }));
  const labels = view ? [] : placeLabels(anchors, pts, fit, { fontSize: z.font, clearance: z.strong / 2 + 3, obstacles });

  // speed: the lap cut into runs of one colour, each run sharing its end point with the next
  const lo = Math.min(...map.speed), hi = Math.max(...map.speed);
  const bin = (v: number) => Math.min(6, Math.max(0, Math.floor(((v - lo) / (hi - lo || 1)) * 7)));
  const runs: { bin: number; d: string }[] = [];
  let start = 0;
  for (let i = 1; i <= n; i++) {
    if (i === n || bin(map.speed[i]) !== bin(map.speed[start])) {
      const run: MapPoint[] = [];
      for (let j = start; j <= i; j++) run.push(pt(j));
      runs.push({ bin: bin(map.speed[start]), d: line(run) });
      start = i;
    }
  }
  return { ...fit, pts, z, sections, boundaries, labels, s0, dir, arrow, runs, lo, hi, loop: line([...pts, pts[0]]) };
}

/** A corner label placed on the whole map, moved with its corner on the zoomed one (`at`: where a point is drawn). */
function moveLabel(l: Placed, at: (p: Point) => Point): Placed {
  const a = at(l.anchor);
  return { ...l, anchor: a, box: { ...l.box, x: l.box.x + a.x - l.anchor.x, y: l.box.y + a.y - l.anchor.y } };
}

/** The track drawn from a session's or an event's reference lap, with its corners and sections numbered as
 * the analysis numbers them, the start/finish line and the direction of travel. Tap or hover a section for
 * its distances; switch to speed to colour the lap by speed. */
export function TrackMap({ session, event, highlight, marks, selectedMark, marksLengthM, cursorM, withShape, onShape,
  maxHeight, compact, onNone, sectionColors, sectionKey }: Props) {
  const styles = useStyles();
  const shape = useTrackShape(withShape ? { session, event } : {});
  const [map, setMap] = useState<TrackMapData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [none, setNone] = useState(false);
  const [mode, setMode] = useState<Mode>('sections');
  const [width, setWidth] = useState(0);
  const [active, setActive] = useState<string | null>(null);
  const [heightAt, setHeightAt] = useState<number | null>(null); // the metre read on the height strip
  const c = PALETTE[useColorScheme()];
  const sc = useShapeColors();
  const surface = useThemeColor({}, 'surface');
  const tint = useThemeColor({}, 'tint');

  useEffect(() => {
    let live = true;
    setMap(null);
    setError(null);
    setNone(false);
    if (session == null && event == null) return;
    fetchTrackMap({ session, event })
      .then((m) => live && setMap(m))
      .catch((e: Error) => {
        if (!live) return;
        if (e instanceof NoTrackMap) {
          setNone(true);
          onNone?.();
        } else setError(e.message);
      });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, event]);

  // the map zooms both ways: the wheel or a pinch, a box dragged across it, a drag once zoomed (components/Zoom.tsx);
  // another track, or another width, starts on the whole map
  const zoom = usePlaneZoom(`${session}:${event}:${width}:${maxHeight}`);
  const whole = useMemo(() => (map && width > 0 ? layout(map, width, maxHeight) : null), [map, width, maxHeight]);
  const g = useMemo(() => {
    if (!whole || !map || !zoom.view) return whole;
    const zoomed = layout(map, width, maxHeight, zoom.view);
    const at = (p: Point) => toFrame(zoom.view, whole.width, whole.height, p);
    return { ...zoomed, labels: whole.labels.map((l) => moveLabel(l, at)) };
  }, [whole, map, width, maxHeight, zoom.view]);
  const pins = useMemo(() => {
    if (!g || !map || !marks?.length) return [];
    const n = g.pts.length;
    const scale = marksLengthM ? map.length_m / marksLengthM : 1;
    const at = (m: number) => Math.round((m * scale) / map.step_m);
    const pt = (i: number) => g.pts[((i % n) + n) % n];
    return marks.map((k) => {
      const run: MapPoint[] = [];
      for (let i = at(k.from_m); i <= Math.max(at(k.to_m), at(k.from_m) + 1); i++) run.push(pt(i));
      return { ...k, p: pt(at(k.at_m)), d: line(run) };
    }).sort((a, b) => b.n - a.n); // the costliest drawn last, on top
  }, [g, map, marks, marksLengthM]);
  const cursorPt = useMemo(() => {
    if (!g || !map || cursorM == null) return null;
    const n = g.pts.length;
    const i = Math.round((cursorM * (marksLengthM ? map.length_m / marksLengthM : 1)) / map.step_m);
    return g.pts[((i % n) + n) % n];
  }, [g, map, cursorM, marksLengthM]);
  // the shape on the map: banked stretches as a band under the track, crests and compressions as ▲ and ▼
  const shapeData = shape.status === 'ready' ? shape.data : null;
  useEffect(() => {
    onShape?.(shapeData);
  }, [shapeData, onShape]);
  const relief = useMemo(() => {
    if (!g || !map || !shapeData) return null;
    const n = g.pts.length;
    const scale = map.length_m / (shapeData.length_m || map.length_m);
    const at = (m: number) => Math.round((m * scale) / map.step_m);
    const pt = (i: number) => g.pts[((i % n) + n) % n];
    const banked = shapeData.features.filter((f) => f.kind === 'banked').map((f) => {
      const { start, end } = featureSpan(f, shapeData.length_m); // through the line: on round past it
      const run: MapPoint[] = [];
      for (let i = at(start); i <= Math.max(at(end), at(start) + 1); i++) run.push(pt(i));
      return line(run);
    });
    const rises = shapeData.features.filter((f) => f.kind !== 'banked')
      .map((f) => ({ kind: f.kind, p: pt(at(featureMid(f, shapeData.length_m))) }));
    return { banked, rises, at: (m: number) => pt(at(m)) };
  }, [g, map, shapeData]);

  if (none) return null;
  if (error) return <Text style={styles.note}>The track map didn&apos;t load: {error}</Text>;

  // the sections to emphasise: the one named as the analysis names it, else those holding the official corners it
  // names ("T3" is in "T2-T5"; a log may group its corners otherwise than the map's lap: "T8-T10" is "T8/T9" and "T10")
  const emphasis = !highlight || !map ? []
    : map.sections.some((s) => s.code === highlight) ? [highlight]
      : map.sections.filter((s) => s.corners.some((k) => cornersOf(highlight).includes(k))).map((s) => s.code);
  const emphasised = (code: string) => emphasis.includes(code);
  const focus = active ? [active] : emphasis;
  const sectionAt = (x: number, y: number) => {
    if (!g || !map) return null;
    let best = -1, dist = 22;
    g.pts.forEach((p, i) => {
      const d = Math.hypot(p.x - x, p.y - y);
      if (d < dist) [dist, best] = [d, i];
    });
    if (best < 0) return null;
    const m = best * map.step_m;
    return map.sections.find((s) => m >= s.start_m && m < s.end_m)?.code ?? map.sections[map.sections.length - 1].code;
  };

  const detail = (() => {
    const ss = map?.sections.filter((x) => focus.includes(x.code)) ?? [];
    if (ss.length === 0) return null;
    const parts = [ss.map((s) => s.code).join(' + '), `${Math.round(ss[0].start_m)}–${Math.round(ss[ss.length - 1].end_m)} m`];
    if (ss.every((s) => s.time != null)) parts.push(`${ss.reduce((t, s) => t + s.time!, 0).toFixed(2)} s`);
    const slowest = ss.flatMap((s) => (s.min_speed == null ? [] : [s.min_speed]));
    if (slowest.length > 0) parts.push(`min ${Math.min(...slowest).toFixed(1)} km/h`);
    return parts.join(' · ');
  })();

  const tone = (k: number, code: string) => {
    if (sectionColors?.[code]) return sectionColors[code];
    if (emphasised(code)) return c.accent;
    return k % 2 ? c.muted : c.secondary;
  };
  const caption = map
    ? `Drawn from ${event != null && map.session_name ? `${map.session_name}, ` : ''}lap ${map.reference_lap} ` +
      `(${formatLap(map.lap_time)})${event == null ? '' : map.event_fastest === false
        ? ', the quickest whose log can draw the track' : ', the fastest of the event'} · ${map.length_m} m · ` +
      `runs ${map.clockwise ? 'clockwise' : 'anticlockwise'}`
    : '';

  return (
    <View style={styles.wrap}>
      <View style={compact ? styles.gone : styles.head}>
        <Text style={styles.title}>Track map</Text>
        <View style={styles.toggle}>
          {(['sections', 'speed'] as Mode[]).map((m) => (
            <Pressable
              key={m}
              accessibilityRole="button"
              {...a11yState({ selected: mode === m }, 'button')}
              onPress={() => setMode(m)}
              {...(mode === m ? null : noPrint)}
              style={styles.toggleHit}>
              <View style={StyleSheet.flatten([styles.toggleItem, mode === m && { borderColor: tint }])}>
                <Text style={StyleSheet.flatten([styles.toggleText, mode !== m && styles.toggleOff])}>
                  {m === 'sections' ? 'Sections' : 'Speed'}
                </Text>
              </View>
            </Pressable>
          ))}
          <ResetZoom zoom={zoom} />
        </View>
      </View>
      <View onLayout={(e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width)}>
        {!g && <Text style={styles.note}>Loading the track map…</Text>}
        {g && map && (
          <ZoomPlane zoom={zoom} width={g.width} height={g.height}
            // the mouse over a section shows it; a tap or a click picks it, and one off the track clears it
            onCursor={(x, y) => Platform.OS === 'web' && setActive(sectionAt(x, y))}
            onLeave={() => setActive(null)}
            onRelease={(_, x, y) => setActive(sectionAt(x, y))}>
            <Svg width={g.width} height={g.height} pointerEvents="none"
              accessibilityLabel={`Track map from lap ${map.reference_lap}: ${map.sections.map((s) => s.code).join(', ')}`}>
              {relief?.banked.map((d, i) => (
                <Path key={`bank-${i}`} d={d} stroke={sc.banked} strokeWidth={g.z.track + 9} fill="none"
                  strokeLinejoin="round" strokeLinecap="round" />
              ))}
              {mode === 'speed' ? (
                <>
                  <Path d={g.loop} stroke={c.casing} strokeWidth={g.z.track + 3} fill="none" strokeLinejoin="round" />
                  {g.sections.filter((s) => emphasised(s.code) || s.code === active).map((s) => (
                    // an ink edge: the blue of the speed ramp would hide a blue one
                    <Path key={s.code} d={s.d} stroke={emphasised(s.code) ? c.ink : c.muted} fill="none"
                      strokeWidth={g.z.track + 6} strokeLinejoin="round" />
                  ))}
                  {g.runs.map((r, i) => (
                    <Path key={i} d={r.d} stroke={c.speed[r.bin]} strokeWidth={g.z.track} fill="none"
                      strokeLinejoin="round" />
                  ))}
                  {g.boundaries.map((b, i) => (
                    <Line key={i} x1={b.p.x - b.t.y * 7} y1={b.p.y + b.t.x * 7} x2={b.p.x + b.t.y * 7}
                      y2={b.p.y - b.t.x * 7} stroke={c.muted} strokeWidth={1.5} />
                  ))}
                </>
              ) : (
                <>
                  {sectionColors && (
                    <Path d={g.loop} stroke={c.ink} strokeWidth={g.z.track + 5} fill="none" strokeLinejoin="round" />
                  )}
                  {g.sections.map((s, k) => (
                    <Path key={s.code} d={s.d} fill="none" strokeLinejoin="round"
                      stroke={tone(k, s.code)}
                      strokeOpacity={emphasis.length > 0 && !emphasised(s.code) ? 0.55 : 1}
                      strokeWidth={emphasised(s.code) || s.code === active ? g.z.strong : g.z.track} />
                  ))}
                  {g.boundaries.map((b, i) => (
                    <Line key={i} x1={b.p.x - b.t.y * 6} y1={b.p.y + b.t.x * 6} x2={b.p.x + b.t.y * 6}
                      y2={b.p.y - b.t.x * 6} stroke={surface} strokeWidth={2} />
                  ))}
                </>
              )}
              {relief?.rises.map((k, i) => (
                <Path key={`rise-${i}`} d={glyph(k.kind, k.p.x, k.p.y, 6)} fill={sc.rise} stroke={surface}
                  strokeWidth={1.5} strokeLinejoin="round" />
              ))}
              {relief && heightAt != null && (
                <Circle cx={relief.at(heightAt).x} cy={relief.at(heightAt).y} r={5} fill={c.ink} stroke={surface}
                  strokeWidth={2} />
              )}
              {g.labels.map((l) => {
                const end = leaderEnd(l);
                return l.leader ? (
                  <Line key={`l-${l.code}`} x1={l.anchor.x} y1={l.anchor.y} x2={end.x} y2={end.y}
                    stroke={c.muted} strokeWidth={1} />
                ) : null;
              })}
              {g.labels.map((l) => (
                <Circle key={`a-${l.code}`} cx={l.anchor.x} cy={l.anchor.y} r={3} fill={c.ink} stroke={surface}
                  strokeWidth={1.5} />
              ))}
              {pins.filter((k) => k.n === selectedMark).map((k) => (
                <Path key={`r-${k.n}`} d={k.d} fill="none" stroke={c.ink} strokeWidth={g.z.strong}
                  strokeLinejoin="round" strokeLinecap="round" />
              ))}
              {pins.map((k) => (
                // the disc holds the whole of its number's 16 px line, so the paper figure reads on it at every edge
                <G key={`p-${k.n}`}>
                  <Circle cx={k.p.x} cy={k.p.y} r={k.n === selectedMark ? 12 : 10}
                    fill={k.n === selectedMark ? c.ink : c.secondary} stroke={surface} strokeWidth={1.5} />
                  <SvgText x={k.p.x} y={k.p.y + 4} fontSize={12} fontFamily={SANS} fontWeight="700"
                    textAnchor="middle" fill={surface}>
                    {String(k.n)}
                  </SvgText>
                </G>
              ))}
              {cursorPt && (
                <Circle cx={cursorPt.x} cy={cursorPt.y} r={6} fill={tint} stroke={surface} strokeWidth={2} />
              )}
              {g.labels.map((l) => {
                const strong = focus.includes(l.code) || emphasis.length === 0;
                return (
                  <SvgText key={`t-${l.code}`} x={l.box.x + l.box.w / 2} y={l.box.y + g.z.font} fontSize={g.z.font}
                    fontFamily={SANS} fontWeight="700" textAnchor="middle" fill={strong ? c.ink : c.secondary}>
                    {l.code}
                  </SvgText>
                );
              })}
              <G transform={`translate(${g.s0.x.toFixed(1)} ${g.s0.y.toFixed(1)}) rotate(${(
                (Math.atan2(g.dir.y, g.dir.x) * 180) / Math.PI).toFixed(1)})`}>
                <Chequer x={-g.z.check} y={-2 * g.z.check} size={g.z.check} ink={c.ink} paper={surface} />
              </G>
              <Path d={g.arrow} stroke={c.ink} strokeWidth={1.5} fill="none" strokeLinecap="round"
                strokeLinejoin="round" />
            </Svg>
          </ZoomPlane>
        )}
      </View>
      {g && map && !compact && (
        <>
          {mode === 'speed' ? (
            <View style={styles.legend}>
              <Text style={styles.small}>{Math.round(g.lo)}</Text>
              <View style={styles.ramp}>
                {c.speed.map((col) => (
                  <View key={col} style={[styles.rampStep, { backgroundColor: col }]} />
                ))}
              </View>
              <Text style={styles.small}>{Math.round(g.hi)} km/h</Text>
            </View>
          ) : null}
          <Text style={styles.detail}>
            {detail ?? (Platform.OS === 'web'
              ? 'Hover or tap a section for where it starts and ends; scroll or pinch on the map to zoom in.'
              : 'Tap a section for where it starts and ends; pinch the map to zoom in.')}
          </Text>
          {mode === 'sections' && sectionKey ? <Text style={styles.small}>{sectionKey}</Text> : null}
          <View style={styles.legend}>
            <Svg width={12} height={18}>
              <Chequer x={1.5} y={1} size={4} ink={c.ink} paper={surface} />
            </Svg>
            <Text style={styles.small}>Start/finish</Text>
            <Svg width={18} height={14}>
              <Path d="M2,7L15,7M11,4L15,7L11,10" stroke={c.ink} strokeWidth={1.5} fill="none" strokeLinecap="round"
                strokeLinejoin="round" />
            </Svg>
            <Text style={styles.small}>Direction of travel</Text>
          </View>
          {shapeData && <ShapeLegend shape={shapeData} />}
          <Text style={styles.small}>{caption}</Text>
        </>
      )}
      {shape.status === 'loading' && map && (
        <Text style={styles.note}>Working out the track&apos;s height and banking from the logs…</Text>
      )}
      {shape.status === 'error' && (
        <Text style={styles.note}>The track&apos;s height and banking didn&apos;t load: {shape.message}</Text>
      )}
      {shapeData && (
        <View style={styles.strip}>
          <ShapePanel shape={shapeData} onCursor={setHeightAt} />
        </View>
      )}
    </View>
  );
}

/** A chequered tick, 2 squares by 4 with a hairline edge, top left at x, y (along the track is x). */
function Chequer({ x, y, size, ink, paper }: { x: number; y: number; size: number; ink: string; paper: string }) {
  return (
    <G>
      {[0, 1].map((col) =>
        [0, 1, 2, 3].map((row) => (
          <Rect key={`${col}${row}`} x={x + col * size} y={y + row * size} width={size} height={size}
            fill={(col + row) % 2 === 0 ? ink : paper} />
        )),
      )}
      <Rect x={x} y={y} width={2 * size} height={4 * size} fill="none" stroke={ink} strokeWidth={1} />
    </G>
  );
}

const useStyles = themed((c) => ({
  // on the paper, under a thin ink rule: no box
  wrap: { gap: 6 },
  head: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end', flexWrap: 'wrap', gap: 8,
    borderBottomWidth: 1, borderColor: c.rule, paddingBottom: 6 },
  title: { ...Type.label, color: c.text },
  toggle: { flexDirection: 'row', alignItems: 'flex-end', gap: 14 },
  // each view's name a 44 px tap target: the room goes up, and down only as far as the head's rule
  toggleHit: { minWidth: TAP, paddingTop: 16, marginTop: -16, paddingBottom: 6, marginBottom: -6 },
  toggleItem: { borderBottomWidth: 3, borderColor: 'transparent', paddingBottom: 2, backgroundColor: 'transparent' },
  toggleText: { ...Type.label, fontSize: 13, color: c.text },
  toggleOff: { color: c.textMuted },
  legend: { flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
  ramp: { flexDirection: 'row', gap: 1 },
  rampStep: { width: 16, height: 8 },
  detail: { ...Type.dek, fontSize: 15, lineHeight: 21, color: c.textSecondary },
  small: { fontFamily: Fonts.label, fontSize: 12, letterSpacing: 0.4, color: c.textMuted },
  note: { ...Type.dek, fontSize: 14, color: c.textMuted },
  strip: { marginTop: 8 },
  gone: { display: 'none' },
}));
