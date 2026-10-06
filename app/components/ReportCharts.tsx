// Charts for the report screen. Colours are slots of the validated chart palette (categorical slots 1-3, light and
// dark steps), the chrome is neutral ink; values and labels always use text colours, never the series colour.
import { useState } from 'react';
import { GestureResponderEvent, LayoutChangeEvent, Platform, StyleSheet } from 'react-native';
import Svg, { Circle, Line, Path, Text as SvgText } from 'react-native-svg';

import { Text, View, useThemeColor } from '@/components/Themed';
import { useColorScheme } from '@/components/useColorScheme';
import { byScheme, Fonts, Radius, themed } from '@/constants/Theme';

const PALETTE = byScheme((c) => ({
  s1: c.chart.series[0], s2: c.chart.series[1], s3: c.chart.series[2], grid: c.chart.grid, axis: c.chart.muted,
  muted: c.chart.axis, text: c.chart.ink, secondary: c.chart.ink2, surface: c.chart.surface,
}));
export const useChartColors = () => PALETTE[useColorScheme() === 'dark' ? 'dark' : 'light'];

// SVG text on the web falls back to a serif face; use the system sans like the rest of the app
const SANS = Fonts.sans;

/** Horizontal bars, one per row, value at the tip: where a typical pass loses time, by phase. */
export function Bars({ rows, unit = 's', digits = 2, max }: {
  rows: { label: string; value: number; color?: string }[]; // color: the row's own (a driving phase)
  unit?: string;
  digits?: number;
  max?: number; // shared scale across several bar charts
}) {
  const c = useChartColors();
  const [width, setWidth] = useState(0);
  const top = max ?? Math.max(...rows.map((r) => r.value), 0.001);
  const LABEL = 100, VALUE = 58, ROW = 26, BAR = 14;
  const plot = Math.max(width - LABEL - VALUE, 10);
  return (
    <View onLayout={(e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width)}>
      {width > 0 && (
        <Svg width={width} height={rows.length * ROW} accessibilityLabel={rows.map((r) =>
          `${r.label} ${r.value.toFixed(digits)} ${unit}`).join(', ')}>
          <Line x1={LABEL} x2={LABEL} y1={0} y2={rows.length * ROW} stroke={c.grid} strokeWidth={1} />
          {rows.map((r, i) => {
            const w = Math.max(0, (r.value / top) * plot);
            const y = i * ROW + (ROW - BAR) / 2;
            return (
              <Bar key={r.label} x={LABEL} y={y} w={w} h={BAR} fill={r.color ?? c.s1} />
            );
          })}
          {rows.map((r, i) => (
            <SvgText key={`l-${r.label}`} x={LABEL - 8} y={i * ROW + ROW / 2 + 4} fontSize={12} fill={c.secondary}
              textAnchor="end" fontFamily={SANS}>
              {r.label}
            </SvgText>
          ))}
          {rows.map((r, i) => (
            <SvgText key={`v-${r.label}`} x={LABEL + Math.max(0, (r.value / top) * plot) + 6} y={i * ROW + ROW / 2 + 4}
              fontSize={12} fill={c.text} fontFamily={SANS}>
              {`${r.value.toFixed(digits)} ${unit}`}
            </SvgText>
          ))}
        </Svg>
      )}
    </View>
  );
}

/** A bar growing from the baseline at x, its far end rounded (4 px), square at the baseline. */
function Bar({ x, y, w, h, fill }: { x: number; y: number; w: number; h: number; fill: string }) {
  if (w <= 0.5) return null;
  const r = Math.min(4, w, h / 2);
  const d = `M${x},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h - r}Q${x + w},${y + h} ${x + w - r},${
    y + h}H${x}Z`;
  return <Path d={d} fill={fill} />;
}

export type LineSeries = { key: string; label: string; values: (number | null)[]; color: string; width?: number;
  muted?: boolean };

type LineChartProps = {
  x: number[]; // shared x for every series
  series: LineSeries[];
  legend: { label: string; color: string }[];
  height?: number;
  formatX: (v: number) => string;
  formatY: (v: number) => string;
  unit: string;
  markers?: { at: number; label: string }[]; // labelled ticks along the x axis
  readout?: (i: number) => { label: string; value: string; color: string }[]; // the tooltip rows at x[i]
  title?: string;
};

const PAD = { left: 44, right: 12, top: 10, bottom: 34 };

/** Lines against a shared x, with a crosshair: hover (web) or drag (touch) to read every series at that x. */
export function LineChart({ x, series, legend, height = 180, formatX, formatY, unit, markers = [], readout,
  title }: LineChartProps) {
  const styles = useStyles();
  const c = useChartColors();
  const [width, setWidth] = useState(0);
  const [cursor, setCursor] = useState<number | null>(null);
  const n = x.length;
  const all = series.flatMap((s) => s.values.filter((v): v is number => v != null && Number.isFinite(v)));
  if (n < 2 || all.length === 0) return null;
  let lo = Math.min(...all), hi = Math.max(...all);
  const span = hi - lo || 1;
  lo -= span * 0.06;
  hi += span * 0.06;
  const ticks = niceTicks(lo, hi, 4);
  const w = Math.max(width - PAD.left - PAD.right, 1);
  const h = height - PAD.top - PAD.bottom;
  const x0 = x[0], x1 = x[n - 1];
  const px = (v: number) => PAD.left + ((v - x0) / (x1 - x0 || 1)) * w;
  const py = (v: number) => PAD.top + (1 - (v - lo) / (hi - lo)) * h;
  const path = (vals: (number | null)[]) => {
    let d = '', pen = false;
    vals.forEach((v, i) => {
      if (v == null || !Number.isFinite(v)) {
        pen = false;
        return;
      }
      d += `${pen ? 'L' : 'M'}${px(x[i]).toFixed(1)},${py(v).toFixed(1)}`;
      pen = true;
    });
    return d;
  };
  const indexAt = (sx: number) => {
    const v = x0 + ((sx - PAD.left) / w) * (x1 - x0);
    let best = 0;
    for (let i = 1; i < n; i++) if (Math.abs(x[i] - v) < Math.abs(x[best] - v)) best = i;
    return best;
  };
  const scrub = (e: GestureResponderEvent) => setCursor(indexAt(e.nativeEvent.locationX));
  const hover = Platform.OS === 'web'
    ? {
        onMouseMove: (e: any) => setCursor(indexAt(e.nativeEvent.offsetX ?? e.nativeEvent.locationX)),
        onMouseLeave: () => setCursor(null),
      }
    : {};
  const rows = cursor != null && readout ? readout(cursor) : [];
  const tipLeft = cursor != null && px(x[cursor]) > width / 2;
  // x labels: the markers, each kept only where it clears the one before it
  const placed: { at: number; label: string; x: number }[] = [];
  for (const m of [...markers].sort((a, b) => a.at - b.at)) {
    const mx = px(m.at);
    if (mx < PAD.left - 2 || mx > width - PAD.right + 2) continue;
    const prev = placed[placed.length - 1];
    if (prev && mx - prev.x < (prev.label.length + m.label.length) * 3.6 + 6) continue;
    placed.push({ ...m, x: mx });
  }

  return (
    <View style={styles.chart}>
      {title ? <Text style={styles.chartTitle}>{title}</Text> : null}
      <View style={styles.legend}>
        {legend.map((l) => (
          <View key={l.label} style={styles.legendItem}>
            <View style={[styles.legendKey, { backgroundColor: l.color }]} />
            <Text style={styles.legendText}>{l.label}</Text>
          </View>
        ))}
      </View>
      <View
        onLayout={(e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width)}
        onStartShouldSetResponder={() => true}
        onResponderGrant={scrub}
        onResponderMove={scrub}
        onResponderRelease={() => Platform.OS !== 'web' && setCursor(null)}
        {...hover}>
        {width > 0 && (
          <Svg width={width} height={height} pointerEvents="none">
            {ticks.map((t) => (
              <Line key={`g${t}`} x1={PAD.left} x2={width - PAD.right} y1={py(t)} y2={py(t)} stroke={c.grid}
                strokeWidth={1} />
            ))}
            {ticks.map((t) => (
              <SvgText key={`t${t}`} x={PAD.left - 6} y={py(t) + 4} fontSize={11} fill={c.axis} textAnchor="end"
                fontFamily={SANS}>
                {formatY(t)}
              </SvgText>
            ))}
            <Line x1={PAD.left} x2={width - PAD.right} y1={PAD.top + h} y2={PAD.top + h} stroke={c.axis}
              strokeWidth={1} strokeOpacity={0.6} />
            {placed.map((m) => (
              <Line key={`m${m.label}`} x1={m.x} x2={m.x} y1={PAD.top + h} y2={PAD.top + h + 4} stroke={c.axis}
                strokeWidth={1} />
            ))}
            {placed.map((m) => (
              <SvgText key={`ml${m.label}`} x={m.x} y={PAD.top + h + 16} fontSize={11} fill={c.secondary}
                textAnchor="middle" fontFamily={SANS}>
                {m.label}
              </SvgText>
            ))}
            <SvgText x={PAD.left} y={height - 3} fontSize={11} fill={c.axis} fontFamily={SANS}>
              {formatX(x0)}
            </SvgText>
            <SvgText x={width - PAD.right} y={height - 3} fontSize={11} fill={c.axis} textAnchor="end"
              fontFamily={SANS}>
              {`${formatX(x1)}`}
            </SvgText>
            <SvgText x={(PAD.left + width - PAD.right) / 2} y={height - 3} fontSize={11} fill={c.axis}
              textAnchor="middle" fontFamily={SANS}>
              {unit}
            </SvgText>
            {series.filter((s) => s.muted).map((s) => (
              <Path key={s.key} d={path(s.values)} stroke={s.color} strokeWidth={s.width ?? 1} fill="none"
                strokeLinejoin="round" strokeLinecap="round" />
            ))}
            {series.filter((s) => !s.muted).map((s) => (
              <Path key={s.key} d={path(s.values)} stroke={s.color} strokeWidth={s.width ?? 2} fill="none"
                strokeLinejoin="round" strokeLinecap="round" />
            ))}
            {cursor != null && (
              <Line x1={px(x[cursor])} x2={px(x[cursor])} y1={PAD.top} y2={PAD.top + h} stroke={c.axis}
                strokeWidth={1} />
            )}
            {cursor != null && series.filter((s) => !s.muted).map((s) => {
              const v = s.values[cursor];
              return v == null || !Number.isFinite(v) ? null : (
                <Circle key={`d${s.key}`} cx={px(x[cursor])} cy={py(v)} r={4} fill={s.color} stroke={c.surface}
                  strokeWidth={2} />
              );
            })}
          </Svg>
        )}
        {cursor != null && rows.length > 0 && (
          <View pointerEvents="none" style={StyleSheet.flatten([styles.tip, { borderColor: c.grid,
            backgroundColor: c.surface, top: PAD.top },
          tipLeft ? { right: width - px(x[cursor]) + 10 } : { left: px(x[cursor]) + 10 }])}>
            <Text style={styles.tipHead}>{formatX(x[cursor])}</Text>
            {rows.map((r) => (
              <View key={r.label} style={styles.tipRow}>
                <View style={[styles.tipKey, { backgroundColor: r.color }]} />
                <Text style={styles.tipValue}>{r.value}</Text>
                <Text style={styles.tipLabel}>{r.label}</Text>
              </View>
            ))}
          </View>
        )}
      </View>
    </View>
  );
}

/** About `count` round values between lo and hi. */
export function niceTicks(lo: number, hi: number, count: number) {
  const raw = (hi - lo) / Math.max(count, 1);
  const mag = 10 ** Math.floor(Math.log10(raw || 1));
  const step = [1, 2, 2.5, 5, 10].map((k) => k * mag).find((s) => s >= raw) ?? raw;
  const out: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(Number(v.toFixed(6)));
  return out;
}

const useStyles = themed((c) => ({
  chart: { gap: 6 },
  chartTitle: { fontSize: 13, fontWeight: '600' },
  legend: { flexDirection: 'row', flexWrap: 'wrap', gap: 12, backgroundColor: 'transparent' },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: 'transparent' },
  legendKey: { width: 14, height: 2, borderRadius: 1 },
  legendText: { fontSize: 12, opacity: 0.75 },
  tip: { position: 'absolute', borderWidth: 1, borderRadius: Radius.control, paddingHorizontal: 8, paddingVertical: 6, gap: 2,
    minWidth: 120 },
  tipHead: { fontSize: 11, opacity: 0.7, fontVariant: ['tabular-nums'] },
  tipRow: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: 'transparent' },
  tipKey: { width: 10, height: 2, borderRadius: 1 },
  tipValue: { fontSize: 13, fontWeight: '600', fontVariant: ['tabular-nums'] },
  tipLabel: { fontSize: 12, opacity: 0.7 },
}));
