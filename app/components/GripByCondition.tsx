// Grip against a condition (TPMS temperature, hot pressure or laps on the tyre): the laps of every session grouped
// by the condition, each group's grip at the same slip angle against the average lap, one panel per axle on a
// shared scale. The groups hold about the same number of laps each, so they are spaced evenly and labelled by
// their edges; the window with the most grip is shaded when the data show one.
import { useState } from 'react';
import { StyleSheet } from 'react-native';
import Svg, { Circle, G, Line, Rect, Text as SvgText } from 'react-native-svg';

import { Readout, useChartColors } from '@/components/report/GripCharts';
import { Swatch, TextLink } from '@/components/Programme';
import { Text, View } from '@/components/Themed';
import { useTableStyles } from '@/components/ToolForm';
import { CHART_FONT, useAxleColors, usePointer } from '@/components/TyreCurve';
import { AXLES, Axle, Condition, ConditionGroup, ConditionKey, GripWindow, gripNum, gripPct } from '@/lib/tyreModel';
import { Fonts, themed, Type } from '@/constants/Theme';

const NAMES: Record<Axle, string> = { front: 'Front', rear: 'Rear' };
const AXIS: Record<ConditionKey, string> = {
  temperature: 'TPMS temperature, °C',
  pressure: 'Hot pressure, bar',
  tyre_laps: 'Laps on the tyre',
};

const edge = (key: ConditionKey, v: number) => (key === 'pressure' ? v.toFixed(2) : v.toFixed(0));

/** A group's range of the condition, short: "1.62–1.70", "93–94", "4–5", "21+". */
export function groupRange(key: ConditionKey, g: { from: number; to: number }) {
  if (key === 'tyre_laps') {
    const last = g.to - 1;
    return g.to >= 1000 ? `${g.from}+` : last === g.from ? `${g.from}` : `${g.from}–${last}`;
  }
  return `${edge(key, g.from)}–${edge(key, g.to)}`;
}

/** A group's range of the condition in words: "1.62–1.70 bar hot", "93–94 °C", "laps 4–5 on the tyre". */
export function groupWords(key: ConditionKey, g: { from: number; to: number }) {
  if (key === 'tyre_laps') {
    const r = groupRange(key, g);
    return g.to >= 1000 ? `lap ${g.from} on the tyre and later` : `lap${r.includes('–') ? 's' : ''} ${r} on the tyre`;
  }
  return `${groupRange(key, g)} ${key === 'pressure' ? 'bar hot' : '°C'}`;
}

/** Round tick values over [lo, hi], about n of them, as fractions (0.05 = 5 %). */
function gripTicks(lo: number, hi: number, n: number) {
  const span = (hi - lo) * 100 || 1;
  const step = [1, 2, 2.5, 5, 10, 20].find((k) => span / k <= n) ?? 50;
  const out: number[] = [];
  for (let v = Math.ceil((lo * 100) / step) * step; v <= hi * 100 + 1e-9; v += step) out.push(v / 100);
  return out;
}

const inWindow = (g: ConditionGroup, w: GripWindow | null) =>
  !!w && (w.confidence === 'high' || w.confidence === 'medium') && g.from >= w.from - 1e-9 && g.to <= w.to + 1e-9;

export function GripByCondition({ cond, condKey }: { cond: Condition; condKey: ConditionKey }) {
  const styles = useStyles();
  const [table, setTable] = useState(false);
  const [width, setWidth] = useState(0);
  const wide = width >= 760;
  const vals = AXLES.flatMap((a) =>
    cond[a].bins.flatMap((b) => (b.grip == null ? [] : [b.grip, b.low ?? b.grip, b.high ?? b.grip])),
  );
  if (!vals.length) {
    return <Text style={styles.sub}>Too few laps with this reading to group them yet.</Text>;
  }
  const lo0 = Math.min(0, ...vals);
  const hi0 = Math.max(0, ...vals);
  const pad = (hi0 - lo0) * 0.08 || 0.01;
  const domain: [number, number] = [lo0 - pad, hi0 + pad];
  return (
    <View style={styles.wrap}>
      {/* side by side when there is room, on the same scale */}
      <View style={wide ? styles.panelsWide : styles.panels} onLayout={(e) => setWidth(e.nativeEvent.layout.width)}>
        {AXLES.map((a) => (
          <View key={a} style={wide ? styles.panelWide : undefined}>
            <Panel axle={a} groups={cond[a].bins} window={cond[a].window} condKey={condKey} domain={domain} />
          </View>
        ))}
      </View>
      <Text style={styles.legendText}>
        Dot: grip at the same slip angle against the average lap. Whisker: the middle 90 % when the sessions and laps
        are drawn again at random (none from fewer than 3 sessions). Shaded: the range with the most grip, when the
        data show one.
      </Text>
      <TextLink small onPress={() => setTable((t) => !t)} label={table ? 'Hide the table' : 'Show as a table'} />
      {table && <GroupTable cond={cond} condKey={condKey} />}
    </View>
  );
}

const PAD = { l: 44, r: 8, t: 18, b: 34 };

function Panel({ axle, groups, window, condKey, domain }: {
  axle: Axle;
  groups: ConditionGroup[];
  window: GripWindow | null;
  condKey: ConditionKey;
  domain: [number, number];
}) {
  const styles = useStyles();
  const c = useChartColors();
  const color = useAxleColors()[axle];
  const { width, at, props } = usePointer();
  const height = 190;
  const w = Math.max(width - PAD.l - PAD.r, 1);
  const h = height - PAD.t - PAD.b;
  const n = Math.max(groups.length, 1);
  const slot = w / n;
  const X = (i: number) => PAD.l + (i + 0.5) * slot;
  const Y = (v: number) => PAD.t + (1 - (v - domain[0]) / (domain[1] - domain[0])) * h;
  // the group under the finger: the whole column is its hit target
  const col = at ? Math.floor((at.x - PAD.l) / slot) : -1;
  const hit = col >= 0 && col < groups.length && groups[col].grip != null ? col : -1;
  const g = hit >= 0 ? groups[hit] : null;
  const inside = groups.map((x) => inWindow(x, window));
  const first = inside.indexOf(true);
  const last = inside.lastIndexOf(true);
  const ticks = gripTicks(domain[0], domain[1], 4);
  const everyOther = slot < 34; // edge labels need about 30 px each
  return (
    <View style={styles.panel}>
      <View style={styles.panelHead}>
        <Swatch color={color} width={14} height={14} />
        <Text style={styles.subhead}>{NAMES[axle]} axle</Text>
      </View>
      <Readout hint="Touch a group to read it.">
        {g
          ? `${groupWords(condKey, g)}: ${gripPct(g.grip!)} grip` +
            (g.low != null && g.high != null
              ? ` (${gripPct(g.low)} to ${gripPct(g.high)})`
              : ', no range from fewer than 3 sessions') +
            `, ${g.laps} laps from ${g.sessions} session${g.sessions === 1 ? '' : 's'}`
          : null}
      </Readout>
      <View {...props}>
        {width > 0 && (
          <Svg width={width} height={height} pointerEvents="none">
            {first >= 0 && (
              <G>
                <Rect x={PAD.l + first * slot} y={PAD.t} width={(last - first + 1) * slot} height={h} fill={color} fillOpacity={0.1} />
                <SvgText x={PAD.l + first * slot + 4} y={PAD.t - 5} fontSize={12} fill={c.ink2} fontFamily={CHART_FONT}>
                  Most grip
                </SvgText>
              </G>
            )}
            {ticks.map((v) => (
              <G key={v}>
                <Line x1={PAD.l} x2={width - PAD.r} y1={Y(v)} y2={Y(v)} stroke={Math.abs(v) < 1e-9 ? c.ink : c.grid}
                  strokeWidth={1} />
                <SvgText x={PAD.l - 5} y={Y(v) + 4} fontSize={12} fill={c.muted} textAnchor="end" fontFamily={CHART_FONT}>
                  {Math.abs(v) < 1e-9 ? 'avg' : gripPct(v, 0).replace(' %', '%')}
                </SvgText>
              </G>
            ))}
            {condKey === 'tyre_laps'
              ? groups.map((x, i) => (
                  <SvgText key={i} x={X(i)} y={height - PAD.b + 14} fontSize={12} fill={c.muted} textAnchor="middle" fontFamily={CHART_FONT}>
                    {groupRange(condKey, x)}
                  </SvgText>
                ))
              : [...groups.map((x) => x.from), groups[groups.length - 1]?.to ?? 0].map((v, i) =>
                  // when crowded: both ends, and every other edge between them that doesn't touch an end
                  everyOther && i > 0 && i < groups.length && (i % 2 === 1 || i > groups.length - 2) ? null : (
                    <SvgText key={i} x={PAD.l + i * slot} y={height - PAD.b + 14} fontSize={12} fill={c.muted}
                      textAnchor={i === 0 ? 'start' : i === groups.length ? 'end' : 'middle'} fontFamily={CHART_FONT}>
                      {edge(condKey, v)}
                    </SvgText>
                  ),
                )}
            {condKey !== 'tyre_laps' &&
              groups.slice(1).map((_, i) => (
                <Line key={i} x1={PAD.l + (i + 1) * slot} x2={PAD.l + (i + 1) * slot} y1={PAD.t + h} y2={PAD.t + h + 4}
                  stroke={c.muted} strokeWidth={1} />
              ))}
            <SvgText x={PAD.l + w / 2} y={height - 4} fontSize={12} fill={c.ink2} textAnchor="middle" fontFamily={CHART_FONT}>
              {AXIS[condKey]}
            </SvgText>
            {groups.map((x, i) =>
              x.grip == null ? null : (
                <G key={i}>
                  {x.low != null && x.high != null && (
                    <G>
                      <Line x1={X(i)} x2={X(i)} y1={Y(x.low)} y2={Y(x.high)} stroke={color} strokeWidth={2} />
                      <Line x1={X(i) - 4} x2={X(i) + 4} y1={Y(x.low)} y2={Y(x.low)} stroke={color} strokeWidth={2} />
                      <Line x1={X(i) - 4} x2={X(i) + 4} y1={Y(x.high)} y2={Y(x.high)} stroke={color} strokeWidth={2} />
                    </G>
                  )}
                  <Circle cx={X(i)} cy={Y(x.grip)} r={4.5} fill={color} stroke={c.surface} strokeWidth={1.5} />
                </G>
              ),
            )}
            {g && <Circle cx={X(hit)} cy={Y(g.grip!)} r={7.5} fill="none" stroke={c.ink} strokeWidth={1.5} />}
          </Svg>
        )}
      </View>
    </View>
  );
}

function GroupTable({ cond, condKey }: { cond: Condition; condKey: ConditionKey }) {
  const styles = useStyles();
  const t = useTableStyles();
  const colors = useAxleColors();
  const head = condKey === 'tyre_laps' ? 'Laps on tyre' : `${cond.label} (${cond.unit})`;
  return (
    <View style={t.table}>
      <View style={t.head}>
        <Text style={StyleSheet.flatten([t.th, styles.axleCol])}>Axle</Text>
        <Text style={StyleSheet.flatten([t.th, styles.wide])}>{head}</Text>
        <Text style={StyleSheet.flatten([t.th, t.num, styles.col])}>Grip</Text>
        <Text style={StyleSheet.flatten([t.th, t.num, styles.wide])}>Middle 90 %</Text>
        <Text style={StyleSheet.flatten([t.th, t.num, styles.col])}>Laps</Text>
      </View>
      {AXLES.flatMap((a) =>
        cond[a].bins.map((b, i) => (
          <View key={`${a}${i}`} style={t.row}>
            <View style={StyleSheet.flatten([styles.axleCol, styles.axleCell])}>
              <Swatch color={colors[a]} width={10} height={10} />
              <Text style={t.name}>{NAMES[a]}</Text>
            </View>
            <Text style={StyleSheet.flatten([t.td, styles.wide])}>
              {groupRange(condKey, b)}
              {inWindow(b, cond[a].window) ? ' ★' : ''}
            </Text>
            <Text style={StyleSheet.flatten([t.td, t.num, styles.col])}>{b.grip == null ? '–' : gripPct(b.grip)}</Text>
            <Text style={StyleSheet.flatten([t.td, t.num, styles.wide])}>
              {b.low == null || b.high == null ? '–' : `${gripNum(b.low, 0)} to ${gripNum(b.high, 0)} %`}
            </Text>
            <Text style={StyleSheet.flatten([t.td, t.num, styles.col])}>{b.laps}</Text>
          </View>
        )),
      )}
      <Text style={t.foot}>★ in the range with the most grip. –: too few laps or sessions.</Text>
    </View>
  );
}

const useStyles = themed((c) => ({
  wrap: { gap: 14 },
  panels: { gap: 20 },
  panelsWide: { flexDirection: 'row', gap: 32 },
  panelWide: { flex: 1, minWidth: 0 },
  panel: { gap: 6 },
  panelHead: { flexDirection: 'row', alignItems: 'center', gap: 9, borderTopWidth: 3, borderColor: c.rule, paddingTop: 8 },
  subhead: { ...Type.label, fontSize: 14, letterSpacing: 1.4, color: c.text },
  sub: { fontFamily: Fonts.body, fontSize: 16, lineHeight: 23, color: c.textSecondary },
  legendText: { fontFamily: Type.dek.fontFamily, fontSize: 14, lineHeight: 20, color: c.textSecondary },
  axleCol: { flex: 0.9, minWidth: 0 },
  axleCell: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  col: { flex: 0.8, minWidth: 0 },
  wide: { flex: 1.5, minWidth: 0 },
}));
