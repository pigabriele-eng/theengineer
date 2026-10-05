// The tyre curve pieces shared by the single-log fit and the model built from every log of a car: grip (mu)
// against slip angle per axle, the axle's numbers, and a pointer hook the tyre charts read out with.
import { useState } from 'react';
import { GestureResponderEvent, LayoutChangeEvent, Platform, Pressable, StyleSheet } from 'react-native';
import Svg, { Circle, G, Line, Path, Text as SvgText } from 'react-native-svg';

import { LegendItem, Readout, useChartColors } from '@/components/report/GripCharts';
import { Text, View } from '@/components/Themed';
import { AxleFit } from '@/lib/vehicle';

type Axle = 'front' | 'rear';
export type Curves = { alpha_deg: number[]; front: number[]; rear: number[] };
export type Binned = Record<Axle, { alpha_deg: number[]; mu: number[]; count: number[] }>;

// SVG text falls back to a serif face on the web; use the page's sans-serif instead.
export const CHART_FONT = Platform.OS === 'web' ? 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif' : undefined;

/** Front and rear in the app's series colours: front the reference blue, rear the compare orange. */
export function useAxleColors() {
  const c = useChartColors();
  return { front: c.s1, rear: c.s2 };
}

/** Width of the chart, and where the finger (or the mouse on the web) is inside it. */
export function usePointer() {
  const [width, setWidth] = useState(0);
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  const grab = (e: GestureResponderEvent) => setAt({ x: e.nativeEvent.locationX, y: e.nativeEvent.locationY });
  const props = {
    onLayout: (e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width),
    onStartShouldSetResponder: () => true,
    onResponderGrant: grab,
    onResponderMove: grab,
    ...(Platform.OS === 'web'
      ? {
          onMouseMove: (e: any) =>
            setAt({ x: e.nativeEvent.offsetX ?? e.nativeEvent.locationX, y: e.nativeEvent.offsetY ?? e.nativeEvent.locationY }),
          onMouseLeave: () => setAt(null),
        }
      : {}),
  };
  return { width, at, props };
}

/** The item nearest the pointer, within reach (px); -1 when none. */
export function nearest<T>(items: T[], pos: (t: T) => [number, number], at: { x: number; y: number } | null, reach = 28) {
  if (!at) return -1;
  let best = -1;
  let bd = reach * reach;
  items.forEach((it, i) => {
    const [x, y] = pos(it);
    const d = (x - at.x) ** 2 + (y - at.y) ** 2;
    if (d < bd) {
      bd = d;
      best = i;
    }
  });
  return best;
}

const PAD = { left: 36, right: 44, top: 8, bottom: 34 };
const NAMES: Record<Axle, string> = { front: 'Front', rear: 'Rear' };

/** Grip (mu) against slip angle: each axle's fitted curve and the binned data it was fitted through. */
export function CurveChart({ curves, binned, fits, height: fixed }: {
  curves: Curves;
  binned: Binned;
  fits: Record<Axle, AxleFit>;
  height?: number; // grows with the width unless given
}) {
  const { width, at, props } = usePointer();
  const height = fixed ?? Math.round(Math.min(Math.max(width * 0.45, 240), 340));
  const [table, setTable] = useState(false);
  const c = useChartColors();
  const colors = useAxleColors();
  const axles: Axle[] = ['front', 'rear'];
  // a curve whose peak the data never reached stops a little past the data: beyond, it is the fit's guess
  const reach = (a: Axle) =>
    fits[a].peak_reached ? Infinity : Math.max(...binned[a].alpha_deg) * 1.1;
  const drawn = Object.fromEntries(
    axles.map((a) => [a, curves.alpha_deg.flatMap((deg, i) => (deg <= reach(a) ? [[deg, curves[a][i]]] : []))]),
  ) as Record<Axle, number[][]>;
  const lo = Math.min(0, ...axles.flatMap((a) => binned[a].alpha_deg));
  const hi = Math.max(...axles.flatMap((a) => [...drawn[a].map((d) => d[0]), ...binned[a].alpha_deg]));
  const top =
    Math.ceil(Math.max(...axles.flatMap((a) => [...drawn[a].map((d) => d[1]), ...binned[a].mu])) * 5) / 5;
  const w = Math.max(width - PAD.left - PAD.right, 1);
  const h = height - PAD.top - PAD.bottom;
  const x = (deg: number) => PAD.left + ((deg - lo) / (hi - lo || 1)) * w;
  const y = (mu: number) => PAD.top + (1 - Math.max(mu, 0) / (top || 1)) * h;
  const step = hi - lo > 16 ? 4 : hi - lo > 8 ? 2 : 1;
  const ticks = Array.from({ length: Math.floor(hi) - Math.ceil(lo) + 1 }, (_, i) => Math.ceil(lo) + i).filter(
    (t) => t % step === 0,
  );
  const points = axles.flatMap((a) =>
    binned[a].alpha_deg.map((deg, i) => ({ axle: a, deg, mu: binned[a].mu[i], n: binned[a].count[i] })),
  );
  const hit = nearest(points, (p) => [x(p.deg), y(p.mu)], at);
  const p = hit >= 0 ? points[hit] : null;
  // direct labels at the end of each curve, pushed apart when they would touch
  const ends = axles.map((a) => {
    const last = drawn[a][drawn[a].length - 1] ?? [hi, 0];
    return { a, x: x(last[0]), y: y(last[1]) };
  });
  if (Math.abs(ends[0].y - ends[1].y) < 13) {
    const mid = (ends[0].y + ends[1].y) / 2;
    const up = ends[0].y <= ends[1].y ? 0 : 1;
    ends[up].y = mid - 7;
    ends[1 - up].y = mid + 7;
  }
  return (
    <View style={styles.chart}>
      <Readout hint="Touch a dot to read it.">
        {p
          ? `${NAMES[p.axle]}: mu ${p.mu.toFixed(2)} at ${p.deg.toFixed(1)}° of slip, ${p.n.toLocaleString()} samples`
          : null}
      </Readout>
      <View {...props}>
        {width > 0 && (
          <Svg width={width} height={height} pointerEvents="none">
            {[0, top / 2, top].map((m) => (
              <Line key={m} x1={PAD.left} x2={width - PAD.right} y1={y(m)} y2={y(m)} stroke={c.grid} strokeWidth={1} />
            ))}
            {[top / 2, top].map((m) => (
              <SvgText key={m} x={PAD.left - 5} y={y(m) + 4} fontSize={10} fill={c.muted} textAnchor="end" fontFamily={CHART_FONT}>
                {m.toFixed(1)}
              </SvgText>
            ))}
            <SvgText x={PAD.left - 5} y={y(0) + 4} fontSize={10} fill={c.muted} textAnchor="end" fontFamily={CHART_FONT}>
              0
            </SvgText>
            {ticks.map((t) => (
              <SvgText key={t} x={x(t)} y={height - PAD.bottom + 14} fontSize={10} fill={c.muted} textAnchor="middle" fontFamily={CHART_FONT}>
                {`${t < 0 ? '−' : ''}${Math.abs(t)}°`}
              </SvgText>
            ))}
            <SvgText x={PAD.left + w / 2} y={height - 4} fontSize={11} fill={c.ink2} textAnchor="middle" fontFamily={CHART_FONT}>
              Slip angle
            </SvgText>
            <SvgText x={PAD.left + 4} y={PAD.top + 10} fontSize={11} fill={c.ink2} fontFamily={CHART_FONT}>
              Grip (mu)
            </SvgText>
            {points.map((q, i) => (
              <Circle key={i} cx={x(q.deg)} cy={y(q.mu)} r={4} fill={colors[q.axle]} fillOpacity={0.55} stroke={c.surface} strokeWidth={1} />
            ))}
            {axles.map((a) => (
              <Path
                key={a}
                d={drawn[a].map(([deg, mu], i) => `${i ? 'L' : 'M'}${x(deg).toFixed(1)},${y(mu).toFixed(1)}`).join('')}
                stroke={colors[a]}
                strokeWidth={2}
                fill="none"
              />
            ))}
            {ends.map((e) => (
              <G key={e.a}>
                <SvgText x={e.x + 6} y={e.y + 4} fontSize={11} fill={c.ink2} fontFamily={CHART_FONT}>
                  {NAMES[e.a]}
                </SvgText>
              </G>
            ))}
            {p && <Circle cx={x(p.deg)} cy={y(p.mu)} r={7} fill="none" stroke={c.ink} strokeWidth={1.5} />}
          </Svg>
        )}
      </View>
      <View style={styles.legendRow}>
        <LegendItem color={colors.front} label="Front" />
        <LegendItem color={colors.rear} label="Rear" />
        <Text style={styles.legendText}>
          Lines: fitted curve, stopped just past the data when the peak is not in them. Dots: median slip angle at
          each grip level.
        </Text>
      </View>
      <Pressable onPress={() => setTable((t) => !t)} accessibilityRole="button">
        <Text style={styles.link}>{table ? 'Hide the points' : 'Show the points as a table'}</Text>
      </Pressable>
      {table && (
        <View style={styles.table}>
          <View style={styles.tr}>
            {['Axle', 'Grip (mu)', 'Slip angle', 'Samples'].map((t) => (
              <Text key={t} style={[styles.td, styles.th]}>
                {t}
              </Text>
            ))}
          </View>
          {points.map((q, i) => (
            <View key={i} style={styles.tr}>
              <Text style={styles.td}>{NAMES[q.axle]}</Text>
              <Text style={[styles.td, styles.num]}>{q.mu.toFixed(2)}</Text>
              <Text style={[styles.td, styles.num]}>{`${q.deg.toFixed(1)}°`}</Text>
              <Text style={[styles.td, styles.num]}>{q.n.toLocaleString()}</Text>
            </View>
          ))}
        </View>
      )}
    </View>
  );
}

/** One axle's fitted curve in numbers. */
export function AxleCard({ title, f, color }: { title: string; f: AxleFit; color: string }) {
  const range = (r?: [number, number], digits = 2) => (r ? ` (${r[0].toFixed(digits)}–${r[1].toFixed(digits)})` : '');
  return (
    <View style={styles.card}>
      <View style={styles.cardHead}>
        <View style={[styles.swatch, { backgroundColor: color }]} />
        <Text style={styles.subhead}>{title}</Text>
      </View>
      <Row
        label="Peak grip (mu)"
        value={f.peak_reached ? `${f.peak_mu.toFixed(2)}${range(f.peak_mu_range)}` : `above ${f.mu_observed_max.toFixed(2)}`}
      />
      <Row
        label="Slip angle at the peak"
        value={f.peak_reached ? `${f.slip_at_peak_deg.toFixed(1)}°${range(f.slip_at_peak_range_deg, 1)}` : 'not reached'}
      />
      <Row label="Shape" value={`${f.shape.toFixed(2)}${f.shape_fitted ? '' : ' (assumed)'}`} />
      <Row label="Grip reached" value={`mu ${f.mu_observed_max.toFixed(2)} at ${f.slip_at_mu_max_deg.toFixed(1)}°`} />
      <Row label="Cornering stiffness" value={`${f.cornering_stiffness_mu_per_deg.toFixed(2)} mu/deg`} />
      <Row label="Slip offset" value={`${f.slip_offset_deg.toFixed(1)}°`} />
      <Row
        label="Fit quality"
        value={`R² ${f.r2 ?? '–'} · slip scatter ${f.slip_scatter_deg?.toFixed(1) ?? '–'}° · ${f.samples.toLocaleString()} samples`}
      />
      {f.note && <Text style={styles.note}>{f.note}</Text>}
    </View>
  );
}

export function Row({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={styles.rowValue}>{value}</Text>
    </View>
  );
}

export const tableStyles = StyleSheet.create({
  table: { borderWidth: 1, borderColor: '#8883', borderRadius: 8, overflow: 'hidden' },
  tr: { flexDirection: 'row', borderBottomWidth: StyleSheet.hairlineWidth, borderColor: '#8884' },
  td: { flex: 1, paddingHorizontal: 8, paddingVertical: 4, fontSize: 13 },
  th: { fontWeight: '600', opacity: 0.8 },
  num: { fontVariant: ['tabular-nums'], textAlign: 'right' },
  link: { fontSize: 13, opacity: 0.75, textDecorationLine: 'underline' },
});

const styles = StyleSheet.create({
  ...tableStyles,
  chart: { gap: 6 },
  legendRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 10 },
  legendText: { fontSize: 12, opacity: 0.75 },
  card: { gap: 4, padding: 12, borderRadius: 8, borderWidth: 1, borderColor: '#8883' },
  cardHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  swatch: { width: 10, height: 10, borderRadius: 5 },
  subhead: { fontWeight: '600' },
  note: { fontSize: 12, opacity: 0.7 },
  row: { flexDirection: 'row', justifyContent: 'space-between', gap: 12 },
  rowLabel: { opacity: 0.7, flexShrink: 0 },
  rowValue: { fontVariant: ['tabular-nums'], textAlign: 'right', flexShrink: 1 },
});
