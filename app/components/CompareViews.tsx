import { memo, useMemo } from 'react';
import { Pressable, ScrollView, StyleSheet } from 'react-native';

import { Text, View, useThemeColor } from '@/components/Themed';
import { TraceChart } from '@/components/TraceChart';
import { useColorScheme } from '@/components/useColorScheme';
import { DETECTED_CORNERS_NOTE } from '@/lib/api';
import {
  CompareResult,
  formatLap,
  IDEAL_COLOR,
  LAP_COLORS,
  lapLabel,
  Opportunity,
  TraceRole,
} from '@/lib/compare';

// Colours of the laps in a result, by the slot each lap was given when it was picked.
export function useLapColors(slots: number[]) {
  const scheme = useColorScheme() === 'dark' ? 'dark' : 'light';
  const key = slots.join(',');
  return useMemo(
    () => ({ laps: slots.map((s) => LAP_COLORS[scheme][s % LAP_COLORS[scheme].length]), ideal: IDEAL_COLOR[scheme] }),
    [scheme, key], // eslint-disable-line react-hooks/exhaustive-deps -- the slots, by value
  );
}

type Colors = ReturnType<typeof useLapColors>;

/** A short stroke of the lap's colour: the key for a lap wherever its name is written. */
export function LineKey({ color }: { color: string }) {
  return <View style={[styles.key, { backgroundColor: color }]} />;
}

const sentence = (o: Opportunity) => {
  if (!o.differences.length) return 'No single technique difference stands out here: look at the traces.';
  const text = o.differences.map((d) => d.text).join(', ');
  return `${text[0].toUpperCase()}${text.slice(1)}.`;
};

type GlanceProps = {
  data: CompareResult;
  colors: Colors;
  focus: number;
  onFocus: (i: number) => void;
  onShow: (code: string, at?: number) => void;
};

/** Where the time is for one lap: the sections where the other laps were quicker, biggest first, with the phase
 * and what the driver did differently there. */
export const WhereTheTimeIs = memo(function WhereTheTimeIs({ data, colors, focus, onFocus, onShow }: GlanceProps) {
  const lap = data.laps[focus];
  const opp = data.opportunities[focus];
  const tint = useThemeColor({}, 'tint');
  return (
    <View style={styles.section}>
      <Text style={styles.h2}>Where the time is</Text>
      <View style={styles.chips}>
        {data.laps.map((l, i) => (
          <Pressable key={i} onPress={() => onFocus(i)}
            style={StyleSheet.flatten([styles.chip, i === focus && { borderColor: tint }])}>
            <LineKey color={colors.laps[i]} />
            <Text style={i === focus ? { color: tint } : undefined}>L{l.lap} · {l.session}</Text>
          </Pressable>
        ))}
      </View>
      <Text style={styles.lead}>
        {opp.sections.length === 0
          ? `${lapLabel(lap)} is the quickest of these laps in every section.`
          : `${lapLabel(lap)} is ${opp.to_ideal.toFixed(2)} s off the ideal lap (${formatLap(data.ideal.time)}), the quickest of each section. Most of it is here:`}
      </Text>
      {opp.sections.slice(0, 3).map((o) => {
        const vs = data.laps[o.versus];
        return (
          <Pressable key={o.code} onPress={() => onShow(o.code, (o.where_m[0] + o.where_m[1]) / 2)} style={styles.card}>
            <View style={styles.cardHead}>
              <Text style={styles.code}>{o.code}</Text>
              <Text style={styles.loss}>{o.loss_s.toFixed(2)} s</Text>
              <View style={styles.phase}>
                <Text style={styles.phaseText}>{o.phase}</Text>
              </View>
            </View>
            <View style={styles.versus}>
              <Text style={styles.sub}>vs</Text>
              <LineKey color={colors.laps[o.versus]} />
              <Text style={styles.sub} numberOfLines={1}>
                {lapLabel(vs)}
              </Text>
            </View>
            <Text style={styles.why}>{sentence(o)}</Text>
            <Text style={styles.show}>Show on the traces ›</Text>
          </Pressable>
        );
      })}
      {opp.sections.length > 3 && (
        <Text style={styles.sub}>
          Also:{' '}
          {opp.sections
            .slice(3)
            .map((o) => `${o.code} ${o.loss_s.toFixed(2)} s (${o.phase})`)
            .join(' · ')}
        </Text>
      )}
    </View>
  );
});

type TableProps = { data: CompareResult; colors: Colors; ideal: boolean; onPick: (code: string) => void };

const CELL = 74;

/** Section times on the official corner numbers: the quickest in each section in bold, the others as the gap to it. */
export const SectionTable = memo(function SectionTable({ data, colors, ideal, onPick }: TableProps) {
  const wash = '#8882';
  return (
    <View style={styles.section}>
      <Text style={styles.h2}>Section times</Text>
      {data.numbering === 'detected' && <Text style={styles.note}>{DETECTED_CORNERS_NOTE}</Text>}
      <ScrollView horizontal>
        <View>
          <View style={styles.row}>
            <Text style={[styles.cell, styles.first, styles.head]}>Section</Text>
            {data.laps.map((l, i) => (
              <View key={i} style={[styles.cellBox, { width: CELL }]}>
                <View style={styles.colHead}>
                  <LineKey color={colors.laps[i]} />
                  <Text style={styles.head}>L{l.lap}</Text>
                </View>
                <Text style={styles.colSub} numberOfLines={1}>
                  {l.session}
                </Text>
              </View>
            ))}
            {ideal && (
              <View style={[styles.cellBox, { width: CELL }]}>
                <View style={styles.colHead}>
                  <LineKey color={colors.ideal} />
                  <Text style={styles.head}>Ideal</Text>
                </View>
              </View>
            )}
          </View>
          {data.sections.map((s) => (
            <Pressable key={s.code} style={styles.row} onPress={() => onPick(s.code)}>
              <Text style={[styles.cell, styles.first, styles.rowName]}>{s.code}</Text>
              {s.times.map((t, i) => {
                const best = i === s.best;
                return (
                  <Text key={i} style={[styles.cell, { width: CELL }, best && styles.best, best && { backgroundColor: wash }]}>
                    {best ? t.toFixed(2) : `+${(t - s.times[s.best]).toFixed(2)}`}
                  </Text>
                );
              })}
              {ideal && <Text style={[styles.cell, { width: CELL }]}>{s.times[s.best].toFixed(2)}</Text>}
            </Pressable>
          ))}
          <View style={styles.row}>
            <Text style={[styles.cell, styles.first, styles.rowName]}>Lap</Text>
            {data.laps.map((l, i) => (
              <Text key={i} style={[styles.cell, { width: CELL }, i === data.reference && styles.best]}>
                {formatLap(l.time)}
              </Text>
            ))}
            {ideal && <Text style={[styles.cell, { width: CELL }]}>{formatLap(data.ideal.time)}</Text>}
          </View>
          <View style={styles.row}>
            <Text style={[styles.cell, styles.first, styles.rowName]}>To ideal</Text>
            {data.laps.map((l, i) => (
              <Text key={i} style={[styles.cell, { width: CELL }]}>
                +{l.to_ideal.toFixed(2)}
              </Text>
            ))}
            {ideal && <Text style={[styles.cell, { width: CELL }]} />}
          </View>
        </View>
      </ScrollView>
      <Text style={styles.note}>
        Bold: the quickest lap in that section. The others show how much slower they were there. Tap a section to
        zoom the traces to it.
      </Text>
    </View>
  );
});

type TracesProps = {
  data: CompareResult;
  colors: Colors;
  ideal: boolean;
  zoom: string | null;
  onZoom: (code: string | null) => void;
  cursor: number | null;
  onCursor: (i: number | null) => void;
};

const CHARTS: { role: TraceRole; title: string; unit: string; height: number; domain?: [number, number] }[] = [
  { role: 'speed', title: 'Speed', unit: 'km/h', height: 140 },
  { role: 'throttle', title: 'Throttle', unit: '%', height: 100, domain: [0, 100] },
  { role: 'brake', title: 'Brake', unit: '', height: 100 },
  { role: 'steer', title: 'Steering', unit: '', height: 100 },
  { role: 'gear', title: 'Gear', unit: '', height: 80 },
];

/** Every lap on one distance axis: time gained or lost against the reference, then speed, pedals, steering and
 * gear, with one crosshair across all of them. Zoom to a section to see a corner in detail. */
export function CompareTraces({ data, colors, ideal, zoom, onZoom, cursor, onCursor }: TracesProps) {
  const tint = useThemeColor({}, 'tint');
  const tr = data.traces;
  const section = data.sections.find((s) => s.code === zoom) ?? null;
  const [i0, i1] = useMemo(() => {
    if (!section) return [0, tr.distance.length - 1];
    const a = tr.distance.findIndex((d) => d >= section.start_m);
    let b = tr.distance.length - 1;
    while (b > a && tr.distance[b] > section.end_m) b--;
    return [Math.max(a, 0), b];
  }, [section, tr.distance]);
  const d0 = tr.distance[i0];
  const distance = useMemo(() => tr.distance.slice(i0, i1 + 1).map((d) => d - d0), [tr.distance, i0, i1, d0]);
  const ref = ideal ? tr.ideal : tr.laps[data.reference];
  const refName = ideal ? 'the ideal lap' : `L${data.laps[data.reference].lap} · ${data.laps[data.reference].session}`;

  // the reference's own line is the zero line; in a zoomed section the gap counts from the section's start
  const delta = useMemo(() => {
    const sliced = (t: number[]) => {
      const out = t.slice(i0, i1 + 1).map((v, k) => v - ref.t[i0 + k]);
      return out.map((v) => v - out[0]);
    };
    const series = tr.laps.map((l, i) => ({ values: sliced(l.t), color: colors.laps[i] }));
    if (ideal) series.push({ values: sliced(tr.ideal.t), color: colors.ideal });
    return series;
  }, [tr, ref, i0, i1, ideal, colors]);
  const seriesOf = (role: TraceRole) => {
    const out = tr.laps.flatMap((l, i) => (l[role] ? [{ values: l[role]!.slice(i0, i1 + 1), color: colors.laps[i] }] : []));
    if (ideal && tr.ideal[role]) out.push({ values: tr.ideal[role]!.slice(i0, i1 + 1), color: colors.ideal });
    return out;
  };
  // the whole lap is marked section by section; a zoomed section shows each official corner in it
  const marks = section && section.corners.length > 1 ? data.track_corners : data.corners;
  const markers = marks
    .filter((c) => c.apex_m >= tr.distance[i0] && c.apex_m <= tr.distance[i1])
    .map((c) => ({ at: c.apex_m - d0, label: c.code }));
  const local = cursor != null && cursor >= i0 && cursor <= i1 ? cursor - i0 : null;
  const shared = { distance, cursor: local, onCursor: (i: number | null) => onCursor(i == null ? null : i + i0), markers };
  const at = local != null ? tr.distance[i0 + local] : null;
  const here = at != null ? data.sections.find((s) => at >= s.start_m && at <= s.end_m)?.code : null;

  return (
    <View style={styles.section}>
      <Text style={styles.h2}>Traces</Text>
      <View style={styles.chips}>
        {[null, ...data.sections.map((s) => s.code)].map((code) => (
          <Pressable key={code ?? 'lap'} onPress={() => onZoom(code)}
            style={StyleSheet.flatten([styles.chip, code === zoom && { borderColor: tint }])}>
            <Text style={code === zoom ? { color: tint } : undefined}>{code ?? 'Whole lap'}</Text>
          </Pressable>
        ))}
      </View>
      <Text style={styles.at}>
        {at != null
          ? `${Math.round(at).toLocaleString()} m${here ? ` · ${here}` : ''}`
          : section
            ? `${section.code}: ${section.start_m.toLocaleString()} to ${section.end_m.toLocaleString()} m`
            : `Whole lap: ${data.length_m.toLocaleString()} m`}
      </Text>
      <TraceChart {...shared} title={`Time vs ${refName}`} unit="s" zeroLine height={120} series={delta} />
      {CHARTS.filter((c) => tr.roles.includes(c.role)).map((c) => {
        const series = seriesOf(c.role);
        let domain = c.domain;
        if (c.role === 'gear') {
          // whole gears on the axis: a range of at least five keeps the labels whole numbers
          const top = Math.max(...series.flatMap((s) => s.values));
          domain = [Math.min(...series.flatMap((s) => s.values), top - 5), top];
        }
        return (
          <TraceChart key={c.role} {...shared} title={c.title} unit={c.unit} height={c.height} domain={domain}
            series={series} />
        );
      })}
      <Text style={styles.note}>
        Time: above zero, a lap is behind {refName} at that point
        {section ? ` (counted from the start of ${section.code})` : ''}. Drag across a chart to read every lap at the
        same point.{data.aligned_by === 'gps' ? ' The laps are placed on one GPS line, so they meet metre for metre.' : ''}
        {data.channels.gear ? ` Gear is the logged ${data.channels.gear} channel.` : ''}
        {data.numbering === 'detected' ? ` ${DETECTED_CORNERS_NOTE}` : ''}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  section: { gap: 10, backgroundColor: 'transparent' },
  h2: { fontSize: 18, fontWeight: '700' },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderWidth: 1,
    borderColor: '#8884',
    borderRadius: 16,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  key: { width: 14, height: 3, borderRadius: 2 },
  lead: { lineHeight: 20 },
  card: { borderWidth: 1, borderColor: '#8883', borderRadius: 10, padding: 12, gap: 6 },
  cardHead: { flexDirection: 'row', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' },
  code: { fontSize: 20, fontWeight: '700' },
  loss: { fontSize: 20, fontWeight: '600' },
  phase: { borderWidth: 1, borderColor: '#8886', borderRadius: 10, paddingHorizontal: 8, paddingVertical: 1 },
  phaseText: { fontSize: 13 },
  versus: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  why: { lineHeight: 20 },
  show: { fontSize: 13, opacity: 0.6 },
  sub: { opacity: 0.7, flexShrink: 1 },
  note: { fontSize: 12, opacity: 0.6, lineHeight: 17 },
  row: { flexDirection: 'row', alignItems: 'center', borderBottomWidth: 1, borderColor: '#8882' },
  cell: { fontVariant: ['tabular-nums'], fontSize: 13, paddingVertical: 6, paddingHorizontal: 6, textAlign: 'right' },
  cellBox: { paddingVertical: 4, paddingHorizontal: 6, alignItems: 'flex-end', gap: 2 },
  colHead: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  colSub: { fontSize: 11, opacity: 0.6, maxWidth: CELL - 8 },
  first: { width: 76, textAlign: 'left' },
  head: { fontWeight: '600', fontSize: 13 },
  rowName: { fontWeight: '600' },
  best: { fontWeight: '700' },
  at: { opacity: 0.7, fontVariant: ['tabular-nums'] },
});
