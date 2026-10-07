// The driver's inputs under the technique check's speed trace: throttle, brake, steering and gear on the same distance
// axis (the same margins as TechniqueTrace, so the cursor lines up), with the fastest lap's laid under them as a
// quieter line, the same mistake bands, and perfect driving's own phases as a thin strip above. This lap is slot 1 of
// the validated chart palette, as in the speed trace; the fastest lap, the bands and the phases are neutral ink, so
// colour keeps meaning one thing.
import { useMemo, useState } from 'react';
import { GestureResponderEvent, LayoutChangeEvent, Platform, StyleSheet } from 'react-native';
import Svg, { Circle, Line, Path, Rect, Text as SvgText } from 'react-native-svg';

import { niceTicks, useChartColors } from '@/components/ReportCharts';
import { Band, bandFill, pointRange, TRACE_PAD_X } from '@/components/TechniqueTrace';
import { Text, View } from '@/components/Themed';
import { InputRole, Inputs, MODEL_PHASES } from '@/lib/technique';
import { chartPlate, Fonts, phaseColor, PLATE_PAD, themed, Type, useTheme } from '@/constants/Theme';

type Props = {
  stepM: number;
  points: number; // the speed trace's points: the inputs have one at each
  inputs: Inputs;
  fastest: Inputs | null; // the fastest lap's, laid under this lap's
  fastestLabel: string | null;
  phases?: number[]; // perfect driving's own, an index into MODEL_PHASES at each point
  channels?: Partial<Record<InputRole, { channel: string | null; unit: string | null }>>;
  bands: Band[];
  selected: number | null;
  onSelect?: (n: number) => void;
  corners: { code: string; at_m: number }[];
  from?: number; // metres shown; the whole lap by default
  to?: number;
  cursor: number | null; // an index into the whole lap's points, shared with the speed trace
  onCursor: (i: number | null) => void;
  tall?: boolean;
};

const CHANNELS: { role: InputRole; title: string; unit: string; digits: number; missing: string }[] = [
  { role: 'throttle', title: 'Throttle', unit: '%', digits: 0, missing: 'throttle' },
  { role: 'brake', title: 'Brake', unit: 'bar', digits: 0, missing: 'brake pressure' },
  { role: 'steer', title: 'Steering', unit: 'deg', digits: 1, missing: 'steering angle' },
  { role: 'gear', title: 'Gear', unit: '', digits: 0, missing: 'gear' },
];
const PAD = { ...TRACE_PAD_X, top: 4, bottom: 4 };
const STRIP = 8;
const AXIS_ROW = 18; // corner labels under the last chart
const SANS = Fonts.sans;

type Geometry = {
  width: number;
  i0: number;
  i1: number;
  stepM: number;
  px: (m: number) => number;
  indexAt: (sx: number) => number; // the whole lap's point under a pixel
};

export function TechniqueInputs({ stepM, points, inputs, fastest, fastestLabel, phases, channels, bands, selected,
  onSelect, corners, from, to, cursor, onCursor, tall }: Props) {
  const styles = useStyles();
  const theme = useTheme();
  const c = useChartColors();
  const [width, setWidth] = useState(0);
  const [i0, i1] = pointRange(stepM, points - 1, from, to);
  const x0 = i0 * stepM, x1 = i1 * stepM;
  const w = Math.max(width - PAD.left - PAD.right, 1);
  const geo: Geometry = {
    width, i0, i1, stepM,
    px: (m) => PAD.left + ((m - x0) / (x1 - x0 || 1)) * w,
    indexAt: (sx) => i0 + Math.max(0, Math.min(i1 - i0, Math.round(((sx - PAD.left) / w) * (i1 - i0)))),
  };
  const shown = bands.filter((b) => b.end_m >= x0 && b.start_m <= x1);
  const local = cursor != null && cursor >= i0 && cursor <= i1 ? cursor : null;
  const bandAt = (i: number) => shown.filter((b) => i * stepM >= b.start_m && i * stepM <= b.end_m)
    .sort((a, z) => a.n - z.n)[0];

  // one set of handlers for every chart: hover or drag moves the shared cursor, a tap on a band picks its mistake
  const scrub = (e: GestureResponderEvent) => onCursor(geo.indexAt(e.nativeEvent.locationX));
  const touch = {
    onStartShouldSetResponder: () => true,
    onResponderGrant: scrub,
    onResponderMove: scrub,
    onResponderRelease: () => {
      const b = local != null ? bandAt(local) : undefined;
      if (b && onSelect) onSelect(b.n);
      if (Platform.OS !== 'web') onCursor(null);
    },
    ...(Platform.OS === 'web'
      ? {
          onMouseMove: (e: any) => onCursor(geo.indexAt(e.nativeEvent.offsetX ?? e.nativeEvent.locationX)),
          onMouseLeave: () => onCursor(null),
        }
      : {}),
  };

  const have = CHANNELS.filter((ch) => inputs[ch.role]);
  const missing = CHANNELS.filter((ch) => !inputs[ch.role]);
  const fastestMissing = fastest ? have.filter((ch) => !fastest[ch.role]) : [];
  const phaseColors = MODEL_PHASES.map((p) => phaseColor(theme, p)); // the driving phases' colours, as everywhere
  const unitOf = (ch: (typeof CHANNELS)[number]) => channels?.[ch.role]?.unit ?? ch.unit;
  const height = (role: InputRole) => (role === 'gear' ? (tall ? 84 : 64) : tall ? 112 : 84);
  const sources = have.map((ch) => channels?.[ch.role]?.channel).filter((s): s is string => !!s);

  return (
    <View style={styles.wrap} onLayout={(e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width - 2 * PLATE_PAD)}>
      <View style={styles.legend}>
        <LegendLine color={c.s1} label="This lap" />
        {fastest && fastestLabel && <LegendLine color={c.axis} label={fastestLabel} thin />}
      </View>
      {phases && phases.length === points && (
        <View {...touch}>
          <View style={styles.head}>
            <Text style={styles.title}>Perfect driving</Text>
            <Text style={styles.readout}>{local != null ? MODEL_PHASES[phases[local]] ?? '' : ' '}</Text>
          </View>
          {width > 0 && <PhaseStrip geo={geo} phases={phases} colors={phaseColors} cursor={local} />}
          <View style={styles.legend}>
            {MODEL_PHASES.map((p, k) => (
              <View key={p} style={styles.legendItem}>
                <View style={StyleSheet.flatten([styles.swatch, { backgroundColor: phaseColors[k] }])} />
                <Text style={styles.legendText}>{p}</Text>
              </View>
            ))}
          </View>
        </View>
      )}
      {have.map((ch, k) => (
        <View key={ch.role} {...touch}>
          <Channel geo={geo} title={ch.title} unit={unitOf(ch)} digits={ch.digits} role={ch.role}
            values={inputs[ch.role]!} under={fastest?.[ch.role] ?? null} bands={shown} selected={selected}
            cursor={local} height={height(ch.role)} corners={k === have.length - 1 ? corners : []} />
        </View>
      ))}
      <Text style={styles.note}>
        {sources.length ? `From the log's ${sources.join(', ')} channels, every ${stepM} m. ` : ''}
        {inputs.gear ? 'Gear as the logger numbers it. ' : ''}
        {missing.length ? `This log has no ${missing.map((ch) => ch.missing).join(' or ')} channel. ` : ''}
        {fastestMissing.length
          ? `The fastest lap's log has no ${fastestMissing.map((ch) => ch.missing).join(' or ')} channel. `
          : ''}
        {phases ? 'Perfect driving’s model has no pedal positions: the strip is what it does at each place.' : ''}
      </Text>
    </View>
  );
}

function LegendLine({ color, label, thin }: { color: string; label: string; thin?: boolean }) {
  const styles = useStyles();
  return (
    <View style={styles.legendItem}>
      <Svg width={16} height={4}>
        <Line x1={0} x2={16} y1={2} y2={2} stroke={color} strokeWidth={thin ? 1.5 : 2} />
      </Svg>
      <Text style={styles.legendText}>{label}</Text>
    </View>
  );
}

function PhaseStrip({ geo, phases, colors, cursor }: { geo: Geometry; phases: number[]; colors: string[];
  cursor: number | null }) {
  const c = useChartColors();
  const runs = useMemo(() => {
    const out: { phase: number; a: number; b: number }[] = [];
    for (let i = geo.i0; i <= geo.i1; i++) {
      const last = out[out.length - 1];
      if (last && last.phase === phases[i]) last.b = i;
      else out.push({ phase: phases[i], a: i, b: i });
    }
    return out;
  }, [phases, geo.i0, geo.i1]);
  const half = geo.stepM / 2;
  const lo = geo.i0 * geo.stepM, hi = geo.i1 * geo.stepM;
  return (
    <Svg width={geo.width} height={STRIP} pointerEvents="none">
      {runs.map((r) => {
        const xa = geo.px(Math.max(lo, r.a * geo.stepM - half));
        const xb = geo.px(Math.min(hi, r.b * geo.stepM + half));
        return <Rect key={r.a} x={xa} y={0} width={Math.max(xb - xa, 0.5)} height={STRIP} fill={colors[r.phase]} />;
      })}
      {cursor != null && (
        <Line x1={geo.px(cursor * geo.stepM)} x2={geo.px(cursor * geo.stepM)} y1={0} y2={STRIP} stroke={c.text}
          strokeWidth={1.5} />
      )}
    </Svg>
  );
}

type ChannelProps = {
  geo: Geometry;
  title: string;
  unit: string;
  digits: number;
  role: InputRole;
  values: number[];
  under: number[] | null;
  bands: Band[];
  selected: number | null;
  cursor: number | null;
  height: number;
  corners: { code: string; at_m: number }[];
};

function Channel({ geo, title, unit, digits, role, values, under, bands, selected, cursor, height, corners }:
  ChannelProps) {
  const styles = useStyles();
  const theme = useTheme();
  const c = useChartColors();
  const { i0, i1, stepM, px, width } = geo;
  const axisRow = corners.length ? AXIS_ROW : 0;
  const h = height - PAD.top - PAD.bottom;
  const [lo, hi, ticks] = useMemo(() => {
    const seen = [values, under].flatMap((v) => (v ? v.slice(i0, i1 + 1) : [])).filter(Number.isFinite);
    let a = Math.min(...seen), b = Math.max(...seen);
    if (!seen.length) [a, b] = [0, 1];
    if (role === 'gear') return [a - 0.5, b + 0.5, a === b ? [a] : [a, b]];
    if (role === 'throttle') return [0, Math.max(100, b), [0, 50, 100]];
    if (role === 'brake') a = 0;
    const span = b - a || 1;
    const out: [number, number] = [a - (role === 'brake' ? 0 : span * 0.06), b + span * 0.06];
    return [...out, niceTicks(out[0], out[1], 3)] as [number, number, number[]];
  }, [values, under, i0, i1, role]);
  const py = (v: number) => PAD.top + (1 - (v - lo) / (hi - lo || 1)) * h;
  const paths = useMemo(() => {
    const path = (vals: number[]) => {
      let d = '';
      let pen = false; // a gap in the log (no value) lifts the pen
      for (let i = i0; i <= i1; i++) {
        if (!Number.isFinite(vals[i])) {
          pen = false;
          continue;
        }
        const x = px(i * stepM).toFixed(1), y = py(vals[i]).toFixed(1);
        // gear changes in steps; the rest are drawn point to point
        d += !pen ? `M${x},${y}` : role === 'gear' ? `H${x}V${y}` : `L${x},${y}`;
        pen = true;
      }
      return d;
    };
    return { lap: path(values), under: under ? path(under) : null };
    // px and py follow from width, the range and the scale
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [values, under, i0, i1, width, lo, hi, height, role, stepM]);
  const fmt = (v: number | undefined) => (v == null || !Number.isFinite(v) ? '–' : v.toFixed(digits));
  const ticksX: { label: string; x: number }[] = [];
  for (const k of [...corners].sort((a, z) => a.at_m - z.at_m)) {
    if (k.at_m < i0 * stepM || k.at_m > i1 * stepM) continue;
    const kx = px(k.at_m);
    const prev = ticksX[ticksX.length - 1];
    if (prev && kx - prev.x < (prev.label.length + k.code.length) * 3.6 + 6) continue;
    ticksX.push({ label: k.code, x: kx });
  }
  const top = PAD.top, bottom = PAD.top + h;

  return (
    <View>
      <View style={styles.head}>
        <Text style={styles.title}>{title}</Text>
        <View style={styles.readoutRow}>
          {cursor != null ? (
            <>
              <View style={StyleSheet.flatten([styles.key, { backgroundColor: c.s1 }])} />
              <Text style={styles.readout}>{`${fmt(values[cursor])}${unit ? ` ${unit}` : ''}`}</Text>
              {under && (
                <>
                  <View style={StyleSheet.flatten([styles.key, styles.keyThin, { backgroundColor: c.axis }])} />
                  <Text style={styles.readoutUnder}>{`${fmt(under[cursor])}${unit ? ` ${unit}` : ''}`}</Text>
                </>
              )}
            </>
          ) : (
            <Text style={styles.readout}> </Text>
          )}
        </View>
      </View>
      {width > 0 && (
        <Svg width={width} height={height + axisRow} pointerEvents="none"
          accessibilityLabel={`${title} along the lap${under ? ', with the fastest lap’s' : ''}`}>
          {bands.map((b) => {
            const xa = px(Math.max(b.start_m, i0 * stepM)), xb = px(Math.min(b.end_m, i1 * stepM));
            return (
              <Rect key={`b${b.n}`} x={xa} y={top} width={Math.max(xb - xa, 2)} height={h}
                {...bandFill(theme, b, b.n === selected, c.grid, c.muted)} />
            );
          })}
          {ticks.map((t) => (
            <Line key={`g${t}`} x1={PAD.left} x2={width - PAD.right} y1={py(t)} y2={py(t)} stroke={c.grid}
              strokeWidth={1} />
          ))}
          {role === 'steer' && lo < 0 && hi > 0 && (
            <Line x1={PAD.left} x2={width - PAD.right} y1={py(0)} y2={py(0)} stroke={c.muted} strokeWidth={1} />
          )}
          {ticks.map((t) => (
            <SvgText key={`t${t}`} x={PAD.left - 6} y={py(t) + 4} fontSize={10} fill={c.axis} textAnchor="end"
              fontFamily={SANS}>
              {String(Math.round(t))}
            </SvgText>
          ))}
          {paths.under && (
            <Path d={paths.under} stroke={c.axis} strokeWidth={1.5} fill="none" strokeLinejoin="round" />
          )}
          <Path d={paths.lap} stroke={c.s1} strokeWidth={2} fill="none" strokeLinejoin="round"
            strokeLinecap="round" />
          {cursor != null && (
            <Line x1={px(cursor * stepM)} x2={px(cursor * stepM)} y1={top} y2={bottom} stroke={c.text}
              strokeWidth={1} />
          )}
          {cursor != null && under && Number.isFinite(under[cursor]) && (
            <Circle cx={px(cursor * stepM)} cy={py(under[cursor])} r={3} fill={c.axis} stroke={c.surface}
              strokeWidth={1.5} />
          )}
          {cursor != null && Number.isFinite(values[cursor]) && (
            <Circle cx={px(cursor * stepM)} cy={py(values[cursor])} r={4} fill={c.s1} stroke={c.surface}
              strokeWidth={2} />
          )}
          {ticksX.map((m) => (
            <SvgText key={`m${m.label}`} x={m.x} y={height + 12} fontSize={11} fill={c.secondary}
              textAnchor="middle" fontFamily={SANS}>
              {m.label}
            </SvgText>
          ))}
        </Svg>
      )}
    </View>
  );
}

const useStyles = themed((c) => ({
  wrap: { gap: 8, ...chartPlate(c) },
  head: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end', gap: 8,
    backgroundColor: 'transparent', borderBottomWidth: 1, borderColor: c.rule, paddingBottom: 4, minHeight: 24 },
  title: { ...Type.label, fontSize: 11, color: c.text },
  readoutRow: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: 'transparent' },
  readout: { ...Type.number, fontSize: 13, color: c.text },
  readoutUnder: { ...Type.number, fontSize: 13, color: c.textSecondary },
  key: { width: 10, height: 3 },
  keyThin: { height: 2 },
  legend: { flexDirection: 'row', flexWrap: 'wrap', columnGap: 16, rowGap: 6, backgroundColor: 'transparent' },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: 'transparent' },
  legendText: { ...Type.label, fontFamily: Fonts.label, fontSize: 11, letterSpacing: 0.8, color: c.textSecondary },
  swatch: { width: 14, height: 10 },
  note: { fontFamily: Fonts.body, fontSize: 13, lineHeight: 18, color: c.textMuted },
}));
