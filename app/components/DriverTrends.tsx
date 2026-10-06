// The pieces of the driver comparison: where each driver gains or loses per section, every lap's section time,
// the technique behind a section's delta, and each driver's habits that cost time.
import { useState } from 'react';
import { GestureResponderEvent, LayoutChangeEvent, Platform, Pressable, StyleSheet } from 'react-native';
import Svg, { Circle, Line, Text as SvgText } from 'react-native-svg';

import { Text, View, useThemeColor } from '@/components/Themed';
import {
  Comparison,
  differenceWords,
  Habit,
  habitValueWords,
  pct,
  PHASE_NAME,
  seconds,
  SectionResult,
  Side,
  SIDES,
  TechniqueRow,
  valueWords,
} from '@/lib/drivers';
import { Radius, themed } from '@/constants/Theme';

type Colors = Record<Side, string>;

const Dot = ({ color }: { color: string }) => {
  const styles = useStyles();
  return <View style={StyleSheet.flatten([styles.dot, { backgroundColor: color }])} />;
};

// ---------- where the time goes: one diverging bar per section, in lap order ----------

export function SectionDeltaChart({ result, colors, selected, onSelect }: {
  result: Comparison;
  colors: Colors;
  selected: string | null;
  onSelect: (code: string) => void;
}) {
  const styles = useStyles();
  const [hover, setHover] = useState<string | null>(null);
  const muted = useThemeColor({}, 'text');
  const { labels } = result;
  const max = Math.max(0.05, ...result.sections.map((s) => Math.abs(s.delta_s)));
  return (
    <View style={styles.chart}>
      <View style={styles.legendRow}>
        <View style={styles.legendItem}>
          <Dot color={colors.a} />
          <Text style={styles.legendText} numberOfLines={1}>
            {labels.a} quicker
          </Text>
        </View>
        <View style={styles.legendItem}>
          <Text style={styles.legendText} numberOfLines={1}>
            {labels.b} quicker
          </Text>
          <Dot color={colors.b} />
        </View>
      </View>
      {result.sections.map((s) => {
        const side = s.faster;
        const width = `${(Math.abs(s.delta_s) / max) * 50}%` as const;
        const isOn = selected === s.code;
        return (
          <Pressable
            key={s.code}
            onPress={() => onSelect(s.code)}
            onHoverIn={() => setHover(s.code)}
            onHoverOut={() => setHover((h) => (h === s.code ? null : h))}
            accessibilityRole="button"
            accessibilityLabel={sectionWords(s, labels)}
            style={StyleSheet.flatten([
              styles.barRow,
              hover === s.code && styles.hover,
              isOn && styles.selected,
            ])}>
            <View style={styles.barLine}>
              <Text style={styles.code} numberOfLines={1}>
                {s.code}
              </Text>
              <View style={styles.track}>
                <View style={StyleSheet.flatten([styles.baseline, { backgroundColor: muted }])} />
                <View
                  style={StyleSheet.flatten([
                    styles.bar,
                    side === 'a' ? styles.barLeft : styles.barRight,
                    { width, backgroundColor: colors[side], opacity: s.clear ? 1 : 0.35 },
                  ])}
                />
              </View>
              <Text style={styles.value}>{Math.abs(s.delta_s).toFixed(2)} s</Text>
            </View>
            <Text style={StyleSheet.flatten([styles.barSub, !s.clear && styles.dim])} numberOfLines={2}>
              {s.clear
                ? `${labels[side]} quicker on ${pct(s.consistency)} of laps, mostly ${PHASE_NAME[s.main_phase]}`
                : `No clear difference: ${labels[side]} quicker on ${pct(s.consistency)} of laps`}
            </Text>
          </Pressable>
        );
      })}
      <Text style={styles.note}>
        Bars: the difference between the two drivers' median section times. Faint bars are sections where the quicker
        driver beats the other's median on fewer than 60% of laps. Tap a section for the laps and the technique.
      </Text>
    </View>
  );
}

export function sectionWords(s: SectionResult, labels: Record<Side, string>): string {
  return `${s.code}: ${labels[s.faster]} quicker by ${Math.abs(s.delta_s).toFixed(2)} s (median), on ${pct(
    s.consistency,
  )} of laps, mostly ${PHASE_NAME[s.main_phase]}`;
}

// ---------- every lap's time in one section ----------

const STRIP = { left: 8, right: 8, row: 34, top: 6, axis: 22 };

export function LapStrip({ result, section, colors }: { result: Comparison; section: SectionResult; colors: Colors }) {
  const styles = useStyles();
  const [width, setWidth] = useState(0);
  const [hit, setHit] = useState<{ side: Side; i: number } | null>(null);
  const ink = useThemeColor({}, 'text');
  const surface = useThemeColor({}, 'surface');
  const lapsOf = { a: result.laps.filter((l) => l.side === 'a'), b: result.laps.filter((l) => l.side === 'b') };
  const session = (run: string) => result.runs.find((r) => r.run === run)?.session ?? run;
  const all = [...section.times.a, ...section.times.b];
  let lo = Math.min(...all);
  let hi = Math.max(...all);
  const pad = Math.max((hi - lo) * 0.04, 0.01);
  lo -= pad;
  hi += pad;
  const w = Math.max(width - STRIP.left - STRIP.right, 1);
  const x = (v: number) => STRIP.left + ((v - lo) / (hi - lo)) * w;
  const rowY = (k: number) => STRIP.top + STRIP.row * k + STRIP.row / 2;
  const height = STRIP.top + STRIP.row * 2 + STRIP.axis;
  const jitter = (i: number) => ((i * 7) % 5) * 3 - 6;
  const ticks = [lo + pad, (lo + hi) / 2, hi - pad];

  // the dot nearest the pointer, within 24 px: dots are small, so the hit area is much bigger than the mark
  const nearest = (px: number, py: number): { side: Side; i: number } | null => {
    let found: { side: Side; i: number; d: number } | null = null;
    for (let k = 0; k < SIDES.length; k++) {
      const side = SIDES[k];
      const times = section.times[side];
      for (let i = 0; i < times.length; i++) {
        const d = Math.hypot(x(times[i]) - px, (rowY(k) + jitter(i) - py) * 0.5);
        if (found == null || d < found.d) found = { side, i, d };
      }
    }
    return found != null && found.d < 24 ? { side: found.side, i: found.i } : null;
  };
  const pick = (e: GestureResponderEvent) => setHit(nearest(e.nativeEvent.locationX, e.nativeEvent.locationY));
  const hover = Platform.OS === 'web'
    ? {
        onMouseMove: (e: any) =>
          setHit(nearest(e.nativeEvent.offsetX ?? e.nativeEvent.locationX, e.nativeEvent.offsetY ?? e.nativeEvent.locationY)),
        onMouseLeave: () => setHit(null),
      }
    : {};

  const lap = hit ? lapsOf[hit.side][hit.i] : null;
  const other: Side | null = hit ? (hit.side === 'a' ? 'b' : 'a') : null;
  return (
    <View style={styles.chart}>
      <View style={styles.legendRow}>
        {SIDES.map((side) => (
          <View key={side} style={styles.legendItem}>
            <Dot color={colors[side]} />
            <Text style={styles.legendText} numberOfLines={1}>
              {result.labels[side]} · median {section.median[side].toFixed(2)} s
            </Text>
          </View>
        ))}
      </View>
      <Text style={styles.readout} numberOfLines={2}>
        {lap && hit && other
          ? `${result.labels[hit.side]}, lap ${lap.lap} of ${session(lap.run)}: ${section.times[hit.side][hit.i].toFixed(
              3,
            )} s (${seconds(section.times[hit.side][hit.i] - section.median[other])} against ${result.labels[other]}'s median)`
          : `Each dot is one lap's time in ${section.code}; the line is the median. ${
              Platform.OS === 'web' ? 'Point at' : 'Touch'
            } a dot for the lap.`}
      </Text>
      <View
        onLayout={(e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width)}
        onStartShouldSetResponder={() => true}
        onResponderGrant={pick}
        onResponderMove={pick}
        {...hover}>
        {width > 0 && (
          <Svg width={width} height={height} pointerEvents="none">
            {SIDES.map((side, k) => (
              <Line key={side} x1={STRIP.left} x2={width - STRIP.right} y1={rowY(k)} y2={rowY(k)} stroke={ink}
                strokeOpacity={0.08} />
            ))}
            {SIDES.map((side, k) =>
              section.times[side].map((v, i) => (
                <Circle key={`${side}${i}`} cx={x(v)} cy={rowY(k) + jitter(i)} r={hit?.side === side && hit.i === i ? 6 : 4}
                  fill={colors[side]} stroke={surface} strokeWidth={2} />
              )),
            )}
            {SIDES.map((side, k) => (
              <Line key={`m${side}`} x1={x(section.median[side])} x2={x(section.median[side])} y1={rowY(k) - 13}
                y2={rowY(k) + 13} stroke={ink} strokeWidth={2} strokeLinecap="round" />
            ))}
            <Line x1={STRIP.left} x2={width - STRIP.right} y1={height - STRIP.axis + 2} y2={height - STRIP.axis + 2}
              stroke={ink} strokeOpacity={0.2} />
            {ticks.map((t, i) => (
              <SvgText key={i} x={x(t)} y={height - 6} fontSize={10} fill={ink} fillOpacity={0.6}
                textAnchor={i === 0 ? 'start' : i === 2 ? 'end' : 'middle'}>
                {t.toFixed(2)} s
              </SvgText>
            ))}
          </Svg>
        )}
      </View>
    </View>
  );
}

// ---------- the technique behind a section's delta ----------

const SHOWN = 6;

export function TechniqueList({ result, section, colors }: { result: Comparison; section: SectionResult; colors: Colors }) {
  const styles = useStyles();
  const [all, setAll] = useState(false);
  const tint = useThemeColor({}, 'tint');
  const { labels } = result;
  const rows = all ? section.technique : section.technique.slice(0, SHOWN);
  if (section.technique.length === 0) {
    return <Text style={styles.dim}>Not enough laps on both sides here to compare the technique.</Text>;
  }
  return (
    <View style={styles.list}>
      {rows.map((r) => (
        <View key={r.metric} style={styles.techRow}>
          <View style={styles.techHead}>
            <Text style={styles.techLabel}>{r.label}</Text>
            {r.worth_s != null && <Text style={StyleSheet.flatten([styles.worth, r.explains && styles.explains])}>{worthWords(r, labels)}</Text>}
          </View>
          <View style={styles.techValues}>
            {SIDES.map((side) => (
              <View key={side} style={styles.legendItem}>
                <Dot color={colors[side]} />
                <Text style={styles.techValue}>{valueWords(r, r[side])}</Text>
              </View>
            ))}
            <Text style={styles.techDiff}>
              {labels.a}: {differenceWords(r)}
            </Text>
          </View>
        </View>
      ))}
      {section.technique.length > SHOWN && (
        <Pressable onPress={() => setAll(!all)} hitSlop={8}>
          <Text style={{ color: tint }}>{all ? 'Show fewer' : `Show all ${section.technique.length} measures`}</Text>
        </Pressable>
      )}
      <Text style={styles.note}>
        Positions are metres from the slowest point of the section (− before it). "Worth" is what the difference in
        typical values comes to in section time, judged from how the time moves with it lap to lap. Each is estimated on
        its own, so they overlap, and none is counted as more than the whole difference.
      </Text>
    </View>
  );
}

function worthWords(r: TechniqueRow, labels: Record<Side, string>): string {
  const w = r.worth_s!;
  return `${w > 0 ? 'costs' : 'gains'} ${labels.a} ${Math.abs(w).toFixed(2)} s`;
}

// ---------- habits ----------

// One section's habits for both drivers, or a single line when neither has one there.
export function SectionHabits({ result, code, colors }: { result: Comparison; code: string; colors: Colors }) {
  const styles = useStyles();
  const has = (side: Side) => result.habits[side].some((h) => h.sections.some((s) => s.code === code));
  if (!SIDES.some(has)) return <Text style={styles.dim}>Neither driver has a repeated habit here that costs time.</Text>;
  return (
    <>
      {SIDES.filter(has).map((side) => (
        <HabitList key={side} result={result} side={side} colors={colors} only={code} />
      ))}
    </>
  );
}

export function HabitList({ result, side, colors, only }: {
  result: Comparison;
  side: Side;
  colors: Colors;
  only?: string; // one section's habits
}) {
  const styles = useStyles();
  const habits = result.habits[side]
    .map((h) => ({ ...h, sections: only ? h.sections.filter((s) => s.code === only) : h.sections }))
    .filter((h) => h.sections.length > 0);
  const label = result.labels[side];
  return (
    <View style={styles.list}>
      <View style={styles.legendItem}>
        <Dot color={colors[side]} />
        <Text style={styles.habitOwner}>{label}</Text>
      </View>
      {habits.length === 0 && (
        <Text style={styles.dim}>{only ? `No repeated habit here that costs time.` : 'No repeated habit that costs time.'}</Text>
      )}
      {habits.map((h) => (
        <HabitCard key={h.kind} habit={h} perLap={!only} />
      ))}
    </View>
  );
}

function HabitCard({ habit, perLap }: { habit: Habit; perLap: boolean }) {
  const styles = useStyles();
  return (
    <View style={styles.habit}>
      <View style={styles.techHead}>
        <Text style={styles.techLabel}>{habit.label}</Text>
        {perLap && <Text style={styles.worth}>about {habit.per_lap_s.toFixed(2)} s a lap</Text>}
      </View>
      {habit.sections.map((s) => (
        <Text key={s.code} style={styles.habitLine}>
          <Text style={styles.habitCode}>{s.code}</Text> · {s.laps} of {s.of} laps ({pct(s.share)}) · {s.cost_s.toFixed(2)} s
          each time{s.basis === 'all laps' ? ' (against both drivers’ laps)' : ''} · {habitValueWords(habit, s)}
        </Text>
      ))}
      <Text style={styles.advice}>{habit.advice}</Text>
    </View>
  );
}

// ---------- lap-wide style ----------

const STYLE_ROWS: [string, string, (v: number) => string][] = [
  ['coasting_s', 'Coasting', (v) => `${v.toFixed(2)} s`],
  ['brake_throttle_overlap_s', 'Brake and throttle together', (v) => `${v.toFixed(2)} s`],
  ['tc_s', 'Traction control working', (v) => `${v.toFixed(2)} s`],
  ['abs_s', 'ABS working', (v) => `${v.toFixed(2)} s`],
  ['throttle_rate_pct_s', 'Throttle application', (v) => `${v.toFixed(0)} %/s`],
  ['peak_brake', 'Peak brake pressure', (v) => v.toFixed(1)],
  ['grip_braking', 'Grip used braking', (v) => `${v.toFixed(1)}%`],
  ['grip_trail', 'Grip used turning in', (v) => `${v.toFixed(1)}%`],
  ['grip_mid', 'Grip used mid-corner', (v) => `${v.toFixed(1)}%`],
  ['grip_exit', 'Grip used on exit', (v) => `${v.toFixed(1)}%`],
];

export function StyleTable({ result, colors }: { result: Comparison; colors: Colors }) {
  const styles = useStyles();
  const rows = STYLE_ROWS.filter(([k]) => SIDES.every((s) => result.summary[s].style[k] != null));
  return (
    <View>
      <View style={styles.tableRow}>
        <Text style={StyleSheet.flatten([styles.tableLabel, styles.head])}>Per lap (median)</Text>
        {SIDES.map((side) => (
          <View key={side} style={styles.tableCellHead}>
            <Dot color={colors[side]} />
            <Text style={styles.head} numberOfLines={1}>
              {result.labels[side]}
            </Text>
          </View>
        ))}
      </View>
      {rows.map(([k, label, fmt]) => (
        <View key={k} style={styles.tableRow}>
          <Text style={styles.tableLabel}>{label}</Text>
          {SIDES.map((side) => (
            <Text key={side} style={styles.tableCell}>
              {fmt(result.summary[side].style[k])}
            </Text>
          ))}
        </View>
      ))}
    </View>
  );
}

const useStyles = themed((c) => ({
  chart: { gap: 6 },
  dot: { width: 10, height: 10, borderRadius: 5 },
  legendRow: { flexDirection: 'row', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 6, flexShrink: 1 },
  legendText: { fontSize: 13, opacity: 0.8, flexShrink: 1 },
  barRow: { paddingVertical: 6, paddingHorizontal: 6, borderRadius: Radius.control, borderWidth: 1, borderColor: 'transparent', gap: 2 },
  hover: { backgroundColor: c.fill },
  selected: { backgroundColor: c.fill, borderColor: c.borderStrong },
  barLine: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  code: { width: 66, fontWeight: '600', fontVariant: ['tabular-nums'] },
  track: { flex: 1, height: 18, justifyContent: 'center' },
  baseline: { position: 'absolute', left: '50%', width: 1, top: 0, bottom: 0, opacity: 0.3 },
  bar: { position: 'absolute', height: 12, top: 3 },
  // the data end is rounded, the end on the baseline square
  barLeft: { right: '50%', borderTopLeftRadius: 4, borderBottomLeftRadius: 4 },
  barRight: { left: '50%', borderTopRightRadius: 4, borderBottomRightRadius: 4 },
  value: { width: 56, textAlign: 'right', fontVariant: ['tabular-nums'] },
  barSub: { fontSize: 12, opacity: 0.7, marginLeft: 74 },
  dim: { opacity: 0.5 },
  note: { fontSize: 12, opacity: 0.6, lineHeight: 17 },
  readout: { fontSize: 13, minHeight: 36, fontVariant: ['tabular-nums'] },
  list: { gap: 10 },
  techRow: { gap: 4, paddingBottom: 8, borderBottomWidth: 1, borderColor: c.separator },
  techHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' },
  techLabel: { fontWeight: '600', fontSize: 15, flexShrink: 1 },
  worth: { fontSize: 13, opacity: 0.7, fontVariant: ['tabular-nums'] },
  explains: { opacity: 1, fontWeight: '600' },
  techValues: { flexDirection: 'row', alignItems: 'center', gap: 14, flexWrap: 'wrap' },
  techValue: { fontVariant: ['tabular-nums'] },
  techDiff: { opacity: 0.7, fontSize: 13 },
  habitOwner: { fontWeight: '700', fontSize: 16 },
  habit: { gap: 4, paddingBottom: 8, borderBottomWidth: 1, borderColor: c.separator },
  habitLine: { lineHeight: 20, fontVariant: ['tabular-nums'] },
  habitCode: { fontWeight: '600' },
  advice: { opacity: 0.7, fontSize: 13, lineHeight: 18 },
  tableRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 5, borderBottomWidth: 1, borderColor: c.separator, gap: 8 },
  tableLabel: { flex: 1 },
  tableCellHead: { width: 92, flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: 4 },
  tableCell: { width: 92, textAlign: 'right', fontVariant: ['tabular-nums'] },
  head: { fontWeight: '600', opacity: 0.7, fontSize: 13 },
}));
