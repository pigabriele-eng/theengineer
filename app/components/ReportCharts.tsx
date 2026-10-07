// Charts for the report screen. Colours are slots of the validated chart palette (categorical slots 1-3, light and
// dark steps), the chrome is neutral ink; values and labels always use text colours, never the series colour.
import { useId, useMemo, useState } from 'react';
import { LayoutChangeEvent, Platform, StyleSheet } from 'react-native';
import Svg, { Circle, ClipPath, Defs, G, Line, Path, Rect, Text as SvgText } from 'react-native-svg';

import { Text, View, useThemeColor } from '@/components/Themed';
import { useColorScheme } from '@/components/useColorScheme';
import { ResetZoom, useZoom, ZoomArea } from '@/components/Zoom';
import { extent, indexWindow, isZoomed, nearestIndex, pixelOf, Range, shownRange, valueAt } from '@/lib/zoom';
import { byScheme, chartPlate, Fonts, PLATE_PAD, themed, Type } from '@/constants/Theme';

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
  const styles = useStyles();
  const c = useChartColors();
  const [width, setWidth] = useState(0);
  const top = max ?? Math.max(...rows.map((r) => r.value), 0.001);
  const LABEL = 100, VALUE = 58, ROW = 26, BAR = 14;
  const plot = Math.max(width - LABEL - VALUE, 10);
  return (
    <View style={styles.plate} onLayout={(e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width - 2 * PLATE_PAD)}>
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

/** A bar growing from the baseline at x: a flat, square block (the programme has no rounded corners). */
function Bar({ x, y, w, h, fill }: { x: number; y: number; w: number; h: number; fill: string }) {
  if (w <= 0.5) return null;
  return <Path d={`M${x},${y}H${x + w}V${y + h}H${x}Z`} fill={fill} />;
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

/** Lines against a shared x, with a crosshair: hover (web) or drag (touch) to read every series at that x. It zooms
 * along x (components/Zoom.tsx), the y axis fitting the part shown. */
export function LineChart({ x, series, legend, height = 180, formatX, formatY, unit, markers = [], readout,
  title }: LineChartProps) {
  const styles = useStyles();
  const c = useChartColors();
  const zoom = useZoom();
  const clip = `clip${useId().replace(/[^a-zA-Z0-9]/g, '')}`;
  const [width, setWidth] = useState(0);
  const [cursor, setCursor] = useState<number | null>(null);
  const n = x.length;
  const x0 = x[0] ?? 0, x1 = x[n - 1] ?? 1;
  const full: Range = [x0, x1];
  const minSpan = n > 1 ? (2 * (x1 - x0)) / (n - 1) : undefined; // no closer than two points apart
  const view = shownRange(zoom.view, full, minSpan);
  const zoomed = isZoomed(view, full);
  const [i0, i1] = useMemo(() => indexWindow(x, view), [x, view[0], view[1]]); // eslint-disable-line react-hooks/exhaustive-deps
  const fit = useMemo(() => extent(series.map((s) => s.values), i0, i1), [series, i0, i1]);
  if (n < 2 || !fit) return null;
  let [lo, hi] = fit;
  const span = hi - lo || 1;
  lo -= span * 0.06;
  hi += span * 0.06;
  const ticks = niceTicks(lo, hi, 4);
  const w = Math.max(width - PAD.left - PAD.right, 1);
  const h = height - PAD.top - PAD.bottom;
  const px = (v: number) => pixelOf(v, view, PAD.left, w);
  const py = (v: number) => PAD.top + (1 - (v - lo) / (hi - lo)) * h;
  // the line through the points shown (and one either side, clipped at the edges); a gap lifts the pen
  const path = (vals: (number | null)[]) => {
    let d = '', pen = false;
    for (let i = i0; i <= i1; i++) {
      const v = vals[i];
      if (v == null || !Number.isFinite(v)) {
        pen = false;
        continue;
      }
      d += `${pen ? 'L' : 'M'}${px(x[i]).toFixed(1)},${py(v).toFixed(1)}`;
      pen = true;
    }
    return d;
  };
  const cursorAt = (sx: number) => setCursor(nearestIndex(x, valueAt(sx, view, PAD.left, w)));
  const inView = cursor != null && cursor < n && px(x[cursor]) >= PAD.left - 0.5 && px(x[cursor]) <= PAD.left + w + 0.5;
  const rows = inView && readout ? readout(cursor) : [];
  const tipLeft = inView && px(x[cursor]) > width / 2;
  // the ends of the x axis: the view's; on an axis of whole numbers (laps) the first and last shown
  const whole = x.every(Number.isInteger);
  const ends = whole ? [Math.ceil(view[0] - 1e-9), Math.floor(view[1] + 1e-9)] : view;
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
      <View style={styles.head}>
        {title ? <Text style={styles.chartTitle}>{title}</Text> : <View />}
        {!zoom.shared && <ResetZoom zoom={zoom} reserve />}
      </View>
      <View style={styles.legend}>
        {legend.map((l) => (
          <View key={l.label} style={styles.legendItem}>
            <View style={[styles.legendKey, { backgroundColor: l.color }]} />
            <Text style={styles.legendText}>{l.label}</Text>
          </View>
        ))}
      </View>
      <ZoomArea zoom={zoom} full={full} left={PAD.left} width={w} minSpan={minSpan} onCursor={cursorAt}
        onLeave={() => setCursor(null)} onRelease={() => Platform.OS !== 'web' && setCursor(null)}
        onLayout={(e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width)}>
        {width > 0 && (
          <Svg width={width} height={height} pointerEvents="none">
            {zoomed && (
              <Defs>
                <ClipPath id={clip}>
                  <Rect x={PAD.left} y={0} width={w} height={height} />
                </ClipPath>
              </Defs>
            )}
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
              {formatX(ends[0])}
            </SvgText>
            <SvgText x={width - PAD.right} y={height - 3} fontSize={11} fill={c.axis} textAnchor="end"
              fontFamily={SANS}>
              {`${formatX(ends[1])}`}
            </SvgText>
            <SvgText x={(PAD.left + width - PAD.right) / 2} y={height - 3} fontSize={11} fill={c.axis}
              textAnchor="middle" fontFamily={SANS}>
              {unit}
            </SvgText>
            <G clipPath={zoomed ? `url(#${clip})` : undefined}>
              {series.filter((s) => s.muted).map((s) => (
                <Path key={s.key} d={path(s.values)} stroke={s.color} strokeWidth={s.width ?? 1} fill="none"
                  strokeLinejoin="round" strokeLinecap="round" />
              ))}
              {series.filter((s) => !s.muted).map((s) => (
                <Path key={s.key} d={path(s.values)} stroke={s.color} strokeWidth={s.width ?? 2} fill="none"
                  strokeLinejoin="round" strokeLinecap="round" />
              ))}
            </G>
            {inView && (
              <Line x1={px(x[cursor])} x2={px(x[cursor])} y1={PAD.top} y2={PAD.top + h} stroke={c.axis}
                strokeWidth={1} />
            )}
            {inView && series.filter((s) => !s.muted).map((s) => {
              const v = s.values[cursor];
              return v == null || !Number.isFinite(v) ? null : (
                <Circle key={`d${s.key}`} cx={px(x[cursor])} cy={py(v)} r={4} fill={s.color} stroke={c.surface}
                  strokeWidth={2} />
              );
            })}
          </Svg>
        )}
        {inView && rows.length > 0 && (
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
      </ZoomArea>
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
  chart: { gap: 6, ...chartPlate(c) },
  plate: chartPlate(c),
  head: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8,
    backgroundColor: 'transparent' },
  chartTitle: { ...Type.label, color: c.text, flexShrink: 1 },
  legend: { flexDirection: 'row', flexWrap: 'wrap', gap: 12, backgroundColor: 'transparent' },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: 'transparent' },
  legendKey: { width: 14, height: 3 },
  legendText: { fontFamily: Fonts.label, fontSize: 12, color: c.textSecondary },
  tip: { position: 'absolute', borderWidth: 1, paddingHorizontal: 8, paddingVertical: 6, gap: 2, minWidth: 120 },
  tipHead: { fontSize: 11, opacity: 0.7, fontVariant: ['tabular-nums'] },
  tipRow: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: 'transparent' },
  tipKey: { width: 10, height: 3 },
  tipValue: { fontSize: 13, fontWeight: '600', fontVariant: ['tabular-nums'] },
  tipLabel: { fontSize: 12, opacity: 0.7 },
}));
