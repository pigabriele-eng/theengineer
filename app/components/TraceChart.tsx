import { useState } from 'react';
import { GestureResponderEvent, LayoutChangeEvent, Platform, StyleSheet } from 'react-native';
import Svg, { Line, Path, Text as SvgText } from 'react-native-svg';

import { Text, View, useThemeColor } from '@/components/Themed';
import { useColorScheme } from '@/components/useColorScheme';
import { byScheme, chartPlate, themed } from '@/constants/Theme';

// Categorical slots 1 and 2 of the validated chart palette, light and dark steps.
export const SERIES = byScheme((c) => ({ reference: c.chart.series[0], compare: c.chart.series[1] }));
export const useSeriesColors = () => SERIES[useColorScheme() === 'dark' ? 'dark' : 'light'];

type Series = { values: number[]; color: string };

type Props = {
  title: string;
  unit: string;
  distance: number[];
  series: Series[];
  cursor: number | null;
  onCursor: (i: number | null) => void;
  markers?: Marker[];
  domain?: [number, number];
  zeroLine?: boolean;
  height?: number;
};

const PAD = { left: 40, right: 8, top: 8, bottom: 18 };
const LABEL_ROW = 11; // px between rows of corner labels
const LABEL_ROWS = 3;
const LABEL_CHAR = 6; // rough width of one character at fontSize 10

type Marker = { at: number; label: string };

/** Corner labels left to right, each on the first row where it clears the label before it, so close corners
 * ("T13", "T14", "T15-T17") stay readable on a phone. A label with no room on any row is left out. */
function placeLabels(markers: Marker[], xAt: (at: number) => number) {
  const ends: number[] = []; // right edge of the last label on each row
  const out: (Marker & { x: number; row: number })[] = [];
  for (const m of [...markers].sort((a, b) => a.at - b.at)) {
    const x = xAt(m.at);
    const half = (m.label.length * LABEL_CHAR) / 2;
    let row = ends.findIndex((end) => x - half >= end + 3);
    if (row === -1) {
      if (ends.length === LABEL_ROWS) continue;
      row = ends.length;
    }
    ends[row] = x + half;
    out.push({ ...m, x, row });
  }
  return out;
}

/** One channel against distance. Charts on a screen share `cursor` so scrubbing one moves all. */
export function TraceChart({ title, unit, distance, series, cursor, onCursor, markers = [], domain, zeroLine,
  height = 140 }: Props) {
  const styles = useStyles();
  const [width, setWidth] = useState(0);
  const muted = useThemeColor({}, 'text');
  const n = distance.length;
  const all = series.flatMap((s) => s.values);
  let [lo, hi] = domain ?? [Math.min(...all), Math.max(...all)];
  if (zeroLine) {
    const m = Math.max(Math.abs(lo), Math.abs(hi), 0.05);
    [lo, hi] = [-m, m];
  }
  if (hi === lo) hi = lo + 1;
  const w = Math.max(width - PAD.left - PAD.right, 1);
  const h = height - PAD.top - PAD.bottom;
  const x = (i: number) => PAD.left + (distance[i] / distance[n - 1]) * w;
  const y = (v: number) => PAD.top + (1 - (v - lo) / (hi - lo)) * h;
  const path = (vals: number[]) => vals.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('');

  const indexAt = (px: number) => {
    const d = ((px - PAD.left) / w) * distance[n - 1];
    return Math.max(0, Math.min(n - 1, Math.round((d / distance[n - 1]) * (n - 1))));
  };
  const scrub = (e: GestureResponderEvent) => onCursor(indexAt(e.nativeEvent.locationX));
  const hover = Platform.OS === 'web'
    ? { onMouseMove: (e: any) => onCursor(indexAt(e.nativeEvent.offsetX ?? e.nativeEvent.locationX)) }
    : {};

  const fmt = (v: number) => (Math.abs(hi - lo) < 5 ? v.toFixed(2) : Math.round(v).toString());
  const labels = width > 0 && n > 1
    ? placeLabels(markers, (at) => x(Math.round((at / distance[n - 1]) * (n - 1))))
    : [];
  const svgHeight = height + Math.max(0, ...labels.map((m) => m.row)) * LABEL_ROW;

  return (
    <View style={styles.wrap}>
      <View style={styles.head}>
        <Text style={styles.title}>{title}</Text>
        {cursor != null && (
          <Text style={styles.values}>
            {series.map((s, i) => (
              <Text key={i}>
                {i > 0 ? '  ' : ''}
                <Text style={{ color: s.color }}>●</Text> {fmt(s.values[cursor])}
              </Text>
            ))}{' '}
            {unit}
          </Text>
        )}
      </View>
      <View
        onLayout={(e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width)}
        onStartShouldSetResponder={() => true}
        onResponderGrant={scrub}
        onResponderMove={scrub}
        {...hover}>
        {width > 0 && n > 1 && (
          <Svg width={width} height={svgHeight} pointerEvents="none">
            <Line x1={PAD.left} x2={width - PAD.right} y1={y(lo)} y2={y(lo)} stroke={muted} strokeOpacity={0.2} />
            {zeroLine && (
              <Line x1={PAD.left} x2={width - PAD.right} y1={y(0)} y2={y(0)} stroke={muted} strokeOpacity={0.35} />
            )}
            <SvgText x={PAD.left - 4} y={PAD.top + 8} fontSize={10} fill={muted} fillOpacity={0.6} textAnchor="end">
              {fmt(hi)}
            </SvgText>
            <SvgText x={PAD.left - 4} y={PAD.top + h} fontSize={10} fill={muted} fillOpacity={0.6} textAnchor="end">
              {fmt(lo)}
            </SvgText>
            {labels.map((m) => (
              <SvgText key={m.label} x={m.x} y={height - 4 + m.row * LABEL_ROW} fontSize={10} fill={muted}
                fillOpacity={0.6} textAnchor="middle">
                {m.label}
              </SvgText>
            ))}
            {series.map((s, i) => (
              <Path key={i} d={path(s.values)} stroke={s.color} strokeWidth={2} fill="none" strokeLinejoin="round" />
            ))}
            {cursor != null && (
              <Line x1={x(cursor)} x2={x(cursor)} y1={PAD.top} y2={PAD.top + h} stroke={muted} strokeOpacity={0.5} />
            )}
          </Svg>
        )}
      </View>
    </View>
  );
}

const useStyles = themed((c) => ({
  wrap: { gap: 2, ...chartPlate(c) },
  head: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', flexWrap: 'wrap' },
  title: { fontSize: 13, fontWeight: '600', opacity: 0.7, textTransform: 'uppercase', letterSpacing: 0.5 },
  values: { fontSize: 13, fontVariant: ['tabular-nums'] },
}));
