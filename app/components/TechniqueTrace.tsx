// The technique check's speed trace: the lap's speed against perfect driving's and the realistic target's, with the
// lap's mistakes marked as numbered bands. Series colours are slots 1 and 3 of the validated chart palette (as in
// the report), the realistic target a dashed neutral line; each band wears the colour of its driving phase, as
// the phase strip and the report do, with the phase named in the legend.
import { useMemo, useState } from 'react';
import { GestureResponderEvent, LayoutChangeEvent, Platform, StyleSheet } from 'react-native';
import Svg, { Circle, Line, Path, Rect, Text as SvgText } from 'react-native-svg';

import { niceTicks, useChartColors } from '@/components/ReportCharts';
import { Text, View } from '@/components/Themed';
import { chartPlate, Fonts, Palette, phaseColor, themed, Type, useTheme } from '@/constants/Theme';

export type Band = { n: number; start_m: number; end_m: number; label: string; phase?: string };

/** A mistake band's fill and how much of it shows: its phase's colour, stronger when picked. */
export function bandFill(theme: Palette, b: Band, picked: boolean, grid: string, muted: string) {
  if (!b.phase) return { fill: picked ? muted : grid, fillOpacity: picked ? 0.75 : 0.7 };
  return { fill: phaseColor(theme, b.phase), fillOpacity: picked ? 0.45 : 0.2 };
}

type Props = {
  stepM: number;
  driven: number[];
  perfect: number[];
  realistic: number[];
  bands: Band[]; // numbered in order of cost
  selected: number | null;
  onSelect?: (n: number) => void;
  corners: { code: string; at_m: number }[];
  from?: number; // metres shown; the whole lap by default
  to?: number;
  height?: number;
  title: string;
  // the cursor as an index into the whole lap's points, when charts share it (TechniqueInputs); its own otherwise
  cursor?: number | null;
  onCursor?: (i: number | null) => void;
};

const PAD = { left: 40, right: 10, top: 22, bottom: 34 };
export const TRACE_PAD_X = { left: PAD.left, right: PAD.right }; // charts under this one line up with it
const SANS = Fonts.sans;

export function TechniqueTrace({ stepM, driven, perfect, realistic, bands, selected, onSelect, corners, from, to,
  height = 220, title, cursor: sharedCursor, onCursor }: Props) {
  const theme = useTheme();
  const styles = useStyles();
  const c = useChartColors();
  const [width, setWidth] = useState(0);
  const [own, setOwn] = useState<number | null>(null);
  const last = driven.length - 1;
  const [i0, i1] = pointRange(stepM, last, from, to);
  const at = onCursor ? sharedCursor ?? null : own;
  const cursor = at != null && at >= i0 && at <= i1 ? at - i0 : null; // index into the points shown
  const setCursor = (k: number | null) => (onCursor ?? setOwn)(k == null ? null : k + i0);
  const x = useMemo(() => Array.from({ length: i1 - i0 + 1 }, (_, k) => (i0 + k) * stepM), [i0, i1, stepM]);
  const series = [
    { key: 'realistic', label: 'Realistic target', values: realistic.slice(i0, i1 + 1), color: c.axis,
      dash: '5,4', width: 1.5 },
    { key: 'perfect', label: 'Perfect driving', values: perfect.slice(i0, i1 + 1), color: c.s3, width: 2 },
    { key: 'driven', label: 'Your lap', values: driven.slice(i0, i1 + 1), color: c.s1, width: 2 },
  ];
  const all = series.flatMap((s) => s.values);
  let lo = Math.min(...all), hi = Math.max(...all);
  const span = hi - lo || 1;
  lo -= span * 0.05;
  hi += span * 0.05;
  const ticks = niceTicks(lo, hi, 4);
  const w = Math.max(width - PAD.left - PAD.right, 1);
  const h = height - PAD.top - PAD.bottom;
  const x0 = x[0], x1 = x[x.length - 1];
  const px = (v: number) => PAD.left + ((v - x0) / (x1 - x0 || 1)) * w;
  const py = (v: number) => PAD.top + (1 - (v - lo) / (hi - lo)) * h;
  const path = (vals: number[]) => vals.map((v, i) => `${i ? 'L' : 'M'}${px(x[i]).toFixed(1)},${py(v).toFixed(1)}`)
    .join('');
  const shown = bands.filter((b) => b.end_m >= x0 && b.start_m <= x1);
  // numbers over the bands, the costliest first, each kept only where it clears those already placed
  const badges: { n: number; x: number }[] = [];
  for (const b of [...shown].sort((a, z) => a.n - z.n)) {
    const bx = px((Math.max(b.start_m, x0) + Math.min(b.end_m, x1)) / 2);
    if (badges.every((o) => Math.abs(o.x - bx) >= 17) || b.n === selected) badges.push({ n: b.n, x: bx });
  }
  const ticksX: { label: string; x: number }[] = [];
  for (const k of [...corners].sort((a, z) => a.at_m - z.at_m)) {
    const kx = px(k.at_m);
    if (k.at_m < x0 || k.at_m > x1) continue;
    const prev = ticksX[ticksX.length - 1];
    if (prev && kx - prev.x < (prev.label.length + k.code.length) * 3.6 + 6) continue;
    ticksX.push({ label: k.code, x: kx });
  }

  const indexAt = (sx: number) => Math.max(0, Math.min(x.length - 1, Math.round(((sx - PAD.left) / w) * (x.length - 1))));
  const bandAt = (m: number) => shown.filter((b) => m >= b.start_m && m <= b.end_m).sort((a, z) => a.n - z.n)[0];
  const scrub = (e: GestureResponderEvent) => setCursor(indexAt(e.nativeEvent.locationX));
  const hover = Platform.OS === 'web'
    ? {
        onMouseMove: (e: any) => setCursor(indexAt(e.nativeEvent.offsetX ?? e.nativeEvent.locationX)),
        onMouseLeave: () => setCursor(null),
      }
    : {};
  const release = () => {
    if (cursor != null && onSelect) {
      const b = bandAt(x[cursor]);
      if (b) onSelect(b.n);
    }
    if (Platform.OS !== 'web') setCursor(null);
  };
  const under = cursor != null ? bandAt(x[cursor]) : undefined;
  const tipLeft = cursor != null && px(x[cursor]) > width / 2;

  return (
    <View style={styles.chart}>
      <Text style={styles.title}>{title}</Text>
      <View style={styles.legend}>
        {[...series].reverse().map((s) => (
          <View key={s.key} style={styles.legendItem}>
            <Svg width={16} height={4}>
              <Line x1={0} x2={16} y1={2} y2={2} stroke={s.color} strokeWidth={2} strokeDasharray={s.dash} />
            </Svg>
            <Text style={styles.legendText}>{s.label}</Text>
          </View>
        ))}
        <View style={styles.legendItem}>
          <View style={StyleSheet.flatten([styles.bandKey, { backgroundColor: c.grid }])} />
          <Text style={styles.legendText}>Mistake, numbered by cost, in its phase&apos;s colour:</Text>
        </View>
        {[...new Set(shown.map((b) => b.phase).filter((p): p is string => !!p))].map((p) => (
          <View key={p} style={styles.legendItem}>
            <View style={StyleSheet.flatten([styles.bandKey, { backgroundColor: phaseColor(theme, p) }])} />
            <Text style={styles.legendText}>{p}</Text>
          </View>
        ))}
      </View>
      <View
        onLayout={(e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width)}
        onStartShouldSetResponder={() => true}
        onResponderGrant={scrub}
        onResponderMove={scrub}
        onResponderRelease={release}
        {...hover}>
        {width > 0 && (
          <Svg width={width} height={height} pointerEvents="none"
            accessibilityLabel={`${title}: your lap against perfect driving, ${shown.length} mistakes marked`}>
            {shown.map((b) => (
              <Rect key={`b${b.n}`} x={px(Math.max(b.start_m, x0))} y={PAD.top}
                width={Math.max(px(Math.min(b.end_m, x1)) - px(Math.max(b.start_m, x0)), 2)} height={h}
                {...bandFill(theme, b, b.n === selected, c.grid, c.muted)} />
            ))}
            {ticks.map((t) => (
              <Line key={`g${t}`} x1={PAD.left} x2={width - PAD.right} y1={py(t)} y2={py(t)} stroke={c.grid}
                strokeWidth={1} />
            ))}
            {ticks.map((t) => (
              <SvgText key={`t${t}`} x={PAD.left - 6} y={py(t) + 4} fontSize={11} fill={c.axis} textAnchor="end"
                fontFamily={SANS}>
                {Math.round(t)}
              </SvgText>
            ))}
            <Line x1={PAD.left} x2={width - PAD.right} y1={PAD.top + h} y2={PAD.top + h} stroke={c.muted}
              strokeWidth={1} />
            {ticksX.map((m) => (
              <Line key={`m${m.label}`} x1={m.x} x2={m.x} y1={PAD.top + h} y2={PAD.top + h + 4} stroke={c.muted}
                strokeWidth={1} />
            ))}
            {ticksX.map((m) => (
              <SvgText key={`ml${m.label}`} x={m.x} y={PAD.top + h + 16} fontSize={11} fill={c.secondary}
                textAnchor="middle" fontFamily={SANS}>
                {m.label}
              </SvgText>
            ))}
            <SvgText x={PAD.left} y={height - 3} fontSize={11} fill={c.axis} fontFamily={SANS}>
              {`${Math.round(x0)} m`}
            </SvgText>
            <SvgText x={width - PAD.right} y={height - 3} fontSize={11} fill={c.axis} textAnchor="end"
              fontFamily={SANS}>
              {`${Math.round(x1)} m`}
            </SvgText>
            <SvgText x={(PAD.left + width - PAD.right) / 2} y={height - 3} fontSize={11} fill={c.axis}
              textAnchor="middle" fontFamily={SANS}>
              km/h, by metres from the line
            </SvgText>
            {series.map((s) => (
              <Path key={s.key} d={path(s.values)} stroke={s.color} strokeWidth={s.width} fill="none"
                strokeDasharray={s.dash} strokeLinejoin="round" strokeLinecap="round" />
            ))}
            {/* the mistake's number in a square block: ink when picked, grey otherwise */}
            {badges.map((b) => (
              <Rect key={`c${b.n}`} x={b.x - 8} y={PAD.top - 19} width={16} height={16}
                fill={b.n === selected ? c.text : c.axis} stroke={c.surface} strokeWidth={1.5} />
            ))}
            {badges.map((b) => (
              <SvgText key={`n${b.n}`} x={b.x} y={PAD.top - 7} fontSize={11} fill={c.surface}
                textAnchor="middle" fontFamily={SANS}>
                {String(b.n)}
              </SvgText>
            ))}
            {cursor != null && (
              <Line x1={px(x[cursor])} x2={px(x[cursor])} y1={PAD.top} y2={PAD.top + h} stroke={c.text}
                strokeWidth={1} />
            )}
            {cursor != null && series.map((s) => (
              <Circle key={`d${s.key}`} cx={px(x[cursor])} cy={py(s.values[cursor])} r={4} fill={s.color}
                stroke={c.surface} strokeWidth={2} />
            ))}
          </Svg>
        )}
        {cursor != null && (
          <View pointerEvents="none" style={StyleSheet.flatten([styles.tip, { top: PAD.top },
          tipLeft ? { right: width - px(x[cursor]) + 10 } : { left: px(x[cursor]) + 10 }])}>
            <Text style={styles.tipHead}>{`${Math.round(x[cursor])} m`}</Text>
            {[...series].reverse().map((s) => (
              <View key={s.key} style={styles.tipRow}>
                <View style={StyleSheet.flatten([styles.tipKey, { backgroundColor: s.color }])} />
                <Text style={styles.tipValue}>{`${s.values[cursor].toFixed(1)} km/h`}</Text>
                <Text style={styles.tipLabel}>{s.key === 'driven' ? 'yours' : s.key}</Text>
              </View>
            ))}
            {under && <Text style={styles.tipBand}>{`${under.n}. ${under.label}`}</Text>}
          </View>
        )}
      </View>
    </View>
  );
}

/** The first and last of a trace's points (every stepM metres, last the final index) shown from..to metres. */
export function pointRange(stepM: number, last: number, from?: number, to?: number): [number, number] {
  return [Math.max(0, Math.floor((from ?? 0) / stepM)), Math.min(last, Math.ceil((to ?? last * stepM) / stepM))];
}

const useStyles = themed((c) => ({
  chart: { gap: 8, ...chartPlate(c) },
  title: { ...Type.label, fontSize: 12, color: c.text, borderBottomWidth: 1, borderColor: c.rule, paddingBottom: 5 },
  legend: { flexDirection: 'row', flexWrap: 'wrap', columnGap: 16, rowGap: 6, backgroundColor: 'transparent' },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: 'transparent' },
  legendText: { ...Type.label, fontFamily: Fonts.label, fontSize: 11, letterSpacing: 0.8, color: c.textSecondary },
  bandKey: { width: 14, height: 10 },
  tip: { position: 'absolute', borderWidth: 1, borderColor: c.rule, backgroundColor: c.background, paddingHorizontal: 8,
    paddingVertical: 6, gap: 2, minWidth: 130, maxWidth: 220 },
  tipHead: { ...Type.label, fontSize: 11, color: c.textMuted },
  tipRow: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: 'transparent' },
  tipKey: { width: 10, height: 3 },
  tipValue: { ...Type.number, fontSize: 13, color: c.text },
  tipLabel: { fontFamily: Fonts.body, fontSize: 12, color: c.textSecondary },
  tipBand: { fontFamily: Fonts.body, fontSize: 12, lineHeight: 16, color: c.text, marginTop: 2 },
}));
