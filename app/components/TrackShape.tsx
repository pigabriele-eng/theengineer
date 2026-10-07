// The track's shape under the track map: the height of the road along the lap with the corners marked, the banked
// corners, crests and compressions found, and a plain summary of them. Colours are slots 1-3 of the validated chart
// palette (validated together, all pairs, on the app's light and dark surfaces): blue for the height line (and the
// map's emphasised section), orange for banking, aqua for crests and compressions, which also differ by shape
// (▲ crest, ▼ compression). Text always wears text colours.
import { useEffect, useState } from 'react';
import { GestureResponderEvent, LayoutChangeEvent, Platform, StyleSheet } from 'react-native';
import Svg, { Line, Path, Rect, Text as SvgText } from 'react-native-svg';

import { niceTicks } from '@/components/ReportCharts';
import { Text, View, useThemeColor } from '@/components/Themed';
import { useColorScheme } from '@/components/useColorScheme';
import {
  featureMid,
  featureSpan,
  featureValue,
  fetchTrackShape,
  inFeature,
  KIND_LABEL,
  ShapeFeature,
  ShapeKind,
  TrackShapeData,
} from '@/lib/trackshape';
import { byScheme, Fonts, Radius, themed } from '@/constants/Theme';

export const SHAPE_COLORS = byScheme((c) => ({
  line: c.chart.series[0], banked: c.chart.series[1], rise: c.chart.series[2], grid: c.chart.grid, axis: c.chart.muted,
  ink: c.chart.ink, secondary: c.chart.ink2,
}));
export const useShapeColors = () => SHAPE_COLORS[useColorScheme() === 'dark' ? 'dark' : 'light'];

// SVG text on the web falls back to a serif face; use the system sans like the rest of the app
const SANS = Fonts.sans;

export type ShapeState =
  | { status: 'loading' }
  | { status: 'none' } // the logs can't tell it: nothing to show
  | { status: 'error'; message: string }
  | { status: 'ready'; data: TrackShapeData };

/** The shape of a session's or an event's track, fetched once per target ('none' without one). */
export function useTrackShape(target: { session?: number; event?: number }): ShapeState {
  const { session, event } = target;
  const [state, setState] = useState<ShapeState>({ status: 'none' });
  useEffect(() => {
    let live = true;
    if (session == null && event == null) {
      setState({ status: 'none' });
      return;
    }
    setState({ status: 'loading' });
    fetchTrackShape({ session, event })
      .then((data) => live && setState(data ? { status: 'ready', data } : { status: 'none' }))
      .catch((e: Error) => live && setState({ status: 'error', message: e.message }));
    return () => {
      live = false;
    };
  }, [session, event]);
  return state;
}

/** A ▲ (crest) or ▼ (compression) centred on x, y. */
export const glyph = (kind: ShapeKind, x: number, y: number, r: number) =>
  kind === 'crest'
    ? `M${x.toFixed(1)},${(y - r).toFixed(1)}L${(x + r).toFixed(1)},${(y + 0.8 * r).toFixed(1)}L${(x - r).toFixed(1)},${(
      y + 0.8 * r).toFixed(1)}Z`
    : `M${x.toFixed(1)},${(y + r).toFixed(1)}L${(x + r).toFixed(1)},${(y - 0.8 * r).toFixed(1)}L${(x - r).toFixed(1)},${(
      y - 0.8 * r).toFixed(1)}Z`;

/** The legend keys for the kinds found: an orange stretch for banking, ▲ and ▼ for crests and compressions. */
export function ShapeLegend({ shape }: { shape: TrackShapeData }) {
  const styles = useStyles();
  const c = useShapeColors();
  const surface = useThemeColor({}, 'surface');
  const kinds = (['banked', 'crest', 'compression'] as ShapeKind[]).filter((k) => shape.features.some((f) => f.kind === k));
  if (!kinds.length) {
    return <Text style={styles.small}>No banked corners, crests or compressions found.</Text>;
  }
  return (
    <View style={styles.legend}>
      {kinds.map((k) => (
        <View key={k} style={styles.legendItem}>
          <Svg width={16} height={14}>
            {k === 'banked' ? (
              <Line x1={1} y1={7} x2={15} y2={7} stroke={c.banked} strokeWidth={5} strokeLinecap="round" />
            ) : (
              <Path d={glyph(k, 8, 7.5, 5.5)} fill={c.rise} stroke={surface} strokeWidth={1} />
            )}
          </Svg>
          <Text style={styles.small}>{KIND_LABEL[k]}</Text>
        </View>
      ))}
    </View>
  );
}

const PAD = { left: 38, right: 10, top: 14, bottom: 24 };
const ROW = 13; // a second row of corner names

/** Height along the lap: distance on x, metres above the lap's lowest point on y, the corners marked under the axis,
 * banked stretches shaded and crests and compressions marked on the line. Hover (web) or drag (touch) to read the
 * height, bank and vertical load at any point; onCursor tells the map where that is. */
export function ElevationStrip({ shape, onCursor }: { shape: TrackShapeData; onCursor?: (m: number | null) => void }) {
  const styles = useStyles();
  const c = useShapeColors();
  const surface = useThemeColor({}, 'surface');
  const [width, setWidth] = useState(0);
  const [cursor, setCursor] = useState<number | null>(null);
  const elev = shape.elevation_m;
  const n = elev.length;
  const known = elev.filter((v): v is number => v != null && Number.isFinite(v));
  if (n < 2 || known.length < 2) return null;

  const top = Math.max(...known, 1);
  const ticks = niceTicks(0, top, 3);
  const hi = Math.max(top, ticks[ticks.length - 1]);
  const w = Math.max(width - PAD.left - PAD.right, 1);
  const px = (m: number) => PAD.left + (m / shape.length_m) * w;

  // corner names under the axis at their slowest point, on a second row where they would touch another; the banked
  // corners are placed first, then those with a crest or a compression, and a name with no room on either row is
  // left out (the tooltip still names it)
  const marks: { code: string; x: number; row: number }[] = [];
  const half = (code: string) => code.length * 3.4 + 2; // half a name's width at 11 px
  const rank = (code: string) => Math.max(0, ...shape.features.filter((f) => f.corner === code)
    .map((f) => (f.kind === 'banked' ? 2 : 1)));
  const order = [...shape.corners].sort((a, b) => rank(b.code) - rank(a.code));
  for (const k of order) {
    const x = px(k.apex_m);
    const row = [0, 1].find((r) => marks.every((m) => m.row !== r || Math.abs(m.x - x) >= half(m.code) + half(k.code)));
    if (row != null) marks.push({ code: k.code, x, row });
  }
  const rows = marks.some((m) => m.row === 1) ? 2 : 1;
  const h = width >= 700 ? 130 : 102; // the plot
  const height = PAD.top + h + PAD.bottom + (rows - 1) * ROW;
  const py = (v: number) => PAD.top + (1 - v / hi) * h;
  const at = (m: number) => Math.max(0, Math.min(n - 1, Math.round(m / shape.step_m)));
  const value = (m: number) => elev[at(m)];

  let line = '', area = '', pen = false, first = 0;
  elev.forEach((v, i) => {
    if (v == null || !Number.isFinite(v)) {
      if (pen) area += `L${px((i - 1) * shape.step_m).toFixed(1)},${py(0).toFixed(1)}Z`;
      pen = false;
      return;
    }
    const x = px(i * shape.step_m).toFixed(1), y = py(v).toFixed(1);
    if (!pen) first = i;
    line += `${pen ? 'L' : 'M'}${x},${y}`;
    area += pen ? `L${x},${y}` : `M${px(first * shape.step_m).toFixed(1)},${py(0).toFixed(1)}L${x},${y}`;
    pen = true;
  });
  if (pen) area += `L${px((n - 1) * shape.step_m).toFixed(1)},${py(0).toFixed(1)}Z`;

  // banked stretches on the strip; one through the start/finish line shows at both ends
  const banked = shape.features.filter((f) => f.kind === 'banked').flatMap((f) => {
    const { start, end } = featureSpan(f, shape.length_m);
    return end <= shape.length_m ? [{ from: start, to: end }]
      : [{ from: start, to: shape.length_m }, { from: 0, to: end - shape.length_m }];
  });
  const sectionAt = (m: number) =>
    shape.corners.find((k) => m >= k.start_m && m < k.end_m)?.code ?? shape.corners[shape.corners.length - 1]?.code;
  const move = (sx: number) => {
    const m = Math.max(0, Math.min(shape.length_m, ((sx - PAD.left) / w) * shape.length_m));
    const snapped = at(m) * shape.step_m;
    setCursor(snapped);
    onCursor?.(snapped);
  };
  const leave = () => {
    setCursor(null);
    onCursor?.(null);
  };
  const scrub = (e: GestureResponderEvent) => move(e.nativeEvent.locationX);
  const hover = Platform.OS === 'web'
    ? { onMouseMove: (e: any) => move(e.nativeEvent.offsetX ?? e.nativeEvent.locationX), onMouseLeave: leave }
    : {};

  const here = cursor != null ? shape.features.filter((f) => inFeature(f, cursor)) : [];
  const bank = cursor != null ? shape.bank_deg[at(cursor)] : null;
  const load = cursor != null ? shape.load_g[at(cursor)] : null;
  const cv = cursor != null ? value(cursor) : null;
  const tipLeft = cursor != null && px(cursor) > width / 2;

  return (
    <View style={styles.wrap}>
      <Text style={styles.title}>Height along the lap</Text>
      <View
        onLayout={(e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width)}
        onStartShouldSetResponder={() => true}
        onResponderGrant={scrub}
        onResponderMove={scrub}
        onResponderRelease={() => Platform.OS !== 'web' && leave()}
        {...hover}>
        {width > 0 && (
          <Svg width={width} height={height} pointerEvents="none"
            accessibilityLabel={`Height along the lap: ${Math.round(top)} m from the lowest to the highest point`}>
            {banked.map((b, i) => (
              <Rect key={`b${i}`} x={px(b.from)} y={PAD.top} width={Math.max(px(b.to) - px(b.from), 2)} height={h}
                fill={c.banked} fillOpacity={0.16} />
            ))}
            {ticks.map((t) => (
              <Line key={`g${t}`} x1={PAD.left} x2={width - PAD.right} y1={py(t)} y2={py(t)} stroke={c.grid}
                strokeWidth={1} />
            ))}
            {ticks.map((t) => (
              <SvgText key={`t${t}`} x={PAD.left - 6} y={py(t) + 4} fontSize={11} fill={c.axis} textAnchor="end"
                fontFamily={SANS}>
                {`${t} m`}
              </SvgText>
            ))}
            <Path d={area} fill={c.line} fillOpacity={0.1} />
            <Path d={line} stroke={c.line} strokeWidth={2} fill="none" strokeLinejoin="round" strokeLinecap="round" />
            {banked.map((b, i) => (
              <Line key={`bk${i}`} x1={px(b.from)} x2={Math.max(px(b.to), px(b.from) + 2)} y1={PAD.top - 5}
                y2={PAD.top - 5} stroke={c.banked} strokeWidth={4} strokeLinecap="round" />
            ))}
            {shape.features.filter((f) => f.kind !== 'banked').map((f, i) => {
              const m = featureMid(f, shape.length_m);
              const v = value(m);
              if (v == null) return null;
              const y = f.kind === 'crest' ? Math.max(py(v) - 9, PAD.top - 6) : Math.min(py(v) + 9, PAD.top + h - 6);
              return <Path key={`r${i}`} d={glyph(f.kind, px(m), y, 5)} fill={c.rise} stroke={surface} strokeWidth={1.5} />;
            })}
            <Line x1={PAD.left} x2={width - PAD.right} y1={PAD.top + h} y2={PAD.top + h} stroke={c.axis}
              strokeWidth={1} strokeOpacity={0.6} />
            {marks.map((m) => (
              <Line key={`m${m.code}`} x1={m.x} x2={m.x} y1={PAD.top + h} y2={PAD.top + h + 4}
                stroke={c.axis} strokeWidth={1} />
            ))}
            {marks.map((m) => (
              <SvgText key={`ml${m.code}`} x={m.x} y={PAD.top + h + 16 + m.row * ROW} fontSize={11} fontWeight="600"
                fill={c.secondary} textAnchor="middle" fontFamily={SANS}>
                {m.code}
              </SvgText>
            ))}
            {cursor != null && (
              <Line x1={px(cursor)} x2={px(cursor)} y1={PAD.top} y2={PAD.top + h} stroke={c.axis} strokeWidth={1} />
            )}
            {cursor != null && cv != null && (
              <Path d={`M${px(cursor) - 4},${py(cv)}a4,4 0 1,0 8,0a4,4 0 1,0 -8,0`} fill={c.line} stroke={surface}
                strokeWidth={2} />
            )}
          </Svg>
        )}
        {cursor != null && (
          <View pointerEvents="none" style={StyleSheet.flatten([styles.tip, { borderColor: c.grid,
            backgroundColor: surface, top: PAD.top },
          tipLeft ? { right: width - px(cursor) + 10 } : { left: px(cursor) + 10 }])}>
            <Text style={styles.tipHead}>{`${Math.round(cursor)} m${sectionAt(cursor) ? ` · ${sectionAt(cursor)}` : ''}`}</Text>
            <Text style={styles.tipRow}>
              <Text style={styles.tipValue}>{cv != null ? `${cv.toFixed(1)} m` : '–'}</Text>
              <Text style={styles.tipLabel}> height</Text>
            </Text>
            {bank != null && (
              <Text style={styles.tipRow}>
                <Text style={styles.tipValue}>{`${Math.round(bank)}°`}</Text>
                <Text style={styles.tipLabel}> bank</Text>
              </Text>
            )}
            {load != null && (
              <Text style={styles.tipRow}>
                <Text style={styles.tipValue}>{`${load.toFixed(2)} g`}</Text>
                <Text style={styles.tipLabel}> vertical load</Text>
              </Text>
            )}
            {here.map((f, i) => (
              <Text key={i} style={styles.tipLabel}>{`${KIND_LABEL[f.kind]} (${featureValue(f)})`}</Text>
            ))}
          </View>
        )}
      </View>
    </View>
  );
}

/** Under the map: the height strip (when the logs can tell the height), the features found in words, and what it
 * was learned from. */
export function ShapePanel({ shape, onCursor }: { shape: TrackShapeData; onCursor?: (m: number | null) => void }) {
  const styles = useStyles();
  const height = shape.elevation_m.filter((v) => v != null && Number.isFinite(v)).length >= 2;
  const from = `${shape.laps} quick ${shape.laps === 1 ? 'lap' : 'laps'}${shape.sessions > 1
    ? ` in ${shape.sessions} sessions` : ''}`;
  return (
    <View style={styles.wrap}>
      {height ? <ElevationStrip shape={shape} onCursor={onCursor} />
        : <Text style={styles.small}>The logs can&apos;t tell the height along the lap (no GPS altitude that repeats lap
          after lap).</Text>}
      <FeatureSummary features={shape.features} />
      <Text style={styles.small}>
        {height ? `Metres above the lap's lowest point, from ${from}. ${Platform.OS === 'web' ? 'Hover or drag'
          : 'Drag'} along it to read the height, bank and vertical load.` : `From ${from}.`}
      </Text>
    </View>
  );
}

/** Each kind found, with the corners it is in and its strongest value there: the strip and map in words. */
export function FeatureSummary({ features }: { features: ShapeFeature[] }) {
  const styles = useStyles();
  const rows = (['banked', 'crest', 'compression'] as ShapeKind[]).map((kind) => {
    const by = new Map<string, ShapeFeature>();
    for (const f of features.filter((x) => x.kind === kind)) {
      const key = f.corner ?? `${Math.round(f.start_m)} m`;
      const prev = by.get(key);
      const stronger = !prev || (kind === 'crest' ? f.value < prev.value : Math.abs(f.value) > Math.abs(prev.value));
      if (stronger) by.set(key, f);
    }
    return { kind, items: [...by.entries()].map(([where, f]) => `${where} ${featureValue(f)}`) };
  }).filter((r) => r.items.length);
  if (!rows.length) return null;
  return (
    <View style={styles.summary}>
      {rows.map((r) => (
        <Text key={r.kind} style={styles.summaryRow}>
          <Text style={styles.summaryKind}>{`${r.kind === 'banked' ? 'Banked' : `${KIND_LABEL[r.kind]}s`}: `}</Text>
          {r.items.join(' · ')}
        </Text>
      ))}
    </View>
  );
}

const useStyles = themed((c) => ({
  wrap: { gap: 6 },
  title: { fontSize: 13, fontWeight: '600' },
  legend: { flexDirection: 'row', alignItems: 'center', gap: 12, flexWrap: 'wrap' },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  small: { fontSize: 12, opacity: 0.6 },
  summary: { gap: 2 },
  summaryRow: { fontSize: 13, fontVariant: ['tabular-nums'] },
  summaryKind: { fontWeight: '600' },
  tip: { position: 'absolute', borderWidth: 1, borderRadius: Radius.control, paddingHorizontal: 8, paddingVertical: 6, gap: 2,
    minWidth: 130 },
  tipHead: { fontSize: 11, opacity: 0.7, fontVariant: ['tabular-nums'] },
  tipRow: { fontSize: 12 },
  tipValue: { fontSize: 12, fontWeight: '700', fontVariant: ['tabular-nums'] },
  tipLabel: { fontSize: 12, opacity: 0.7 },
}));
