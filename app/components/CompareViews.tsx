import { memo, useMemo } from 'react';
import { Pressable, ScrollView, StyleSheet } from 'react-native';

import { Tabs, useText } from '@/components/Picks';
import { Fig, Section, Swatch, useWide } from '@/components/Programme';
import { Text, View } from '@/components/Themed';
import { TraceChart } from '@/components/TraceChart';
import { useColorScheme } from '@/components/useColorScheme';
import { ResetZoom, useZoomState, ZOOM_HINT, ZoomGroup } from '@/components/Zoom';
import { DETECTED_CORNERS_NOTE } from '@/lib/api';
import { isZoomed, shownRange } from '@/lib/zoom';
import {
  CompareResult,
  formatLap,
  LAP_COLORS,
  lapLabel,
  LapTrace,
  Opportunity,
  TraceRole,
} from '@/lib/compare';
import { noPrint } from '@/lib/print';
import { deltaColor, deltaWash, face, Fonts, phaseColor, TAP, themed, Type, useTheme } from '@/constants/Theme';

const NONE: NonNullable<TracesProps['extra']> = [];

// Colours of the laps in a result, by the slot each lap was given when it was picked.
export function useLapColors(slots: number[]) {
  const scheme = useColorScheme() === 'dark' ? 'dark' : 'light';
  const key = slots.join(',');
  return useMemo(
    () => ({ laps: slots.map((s) => LAP_COLORS[scheme][s % LAP_COLORS[scheme].length]) }),
    [scheme, key], // eslint-disable-line react-hooks/exhaustive-deps -- the slots, by value
  );
}

type Colors = ReturnType<typeof useLapColors>;

/** A short flat stroke of the lap's colour: the key for a lap wherever its name is written. */
export function LineKey({ color, dash }: { color: string; dash?: string }) {
  const styles = useStyles();
  if (dash) {  // a theoretical lap's: dashed as on the charts (DASH in lib/theoretical.ts: long dashes, or dots)
    const style = Number(dash.split(',')[0]) > 3 ? 'dashed' : 'dotted';
    return <View style={StyleSheet.flatten([styles.dashKey, { borderColor: color, borderStyle: style }])} />;
  }
  return <View style={StyleSheet.flatten([styles.key, { backgroundColor: color }])} />;
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
  no?: number;
  // a line to add under a section's words, by its code (the weekend page's Laps tab: what the technique check found
  // there on this lap)
  notes?: Record<string, string>;
};

/** Where the time is for one lap: the sections where the other laps were quicker, biggest first, with the phase
 * and what the driver did differently there. The three biggest side by side, as the programme's columns. */
export const WhereTheTimeIs = memo(function WhereTheTimeIs({ data, colors, focus, onFocus, onShow, no = 2,
  notes }: GlanceProps) {
  const styles = useStyles();
  const t = useText();
  const theme = useTheme();
  const wide = useWide();
  const lap = data.laps[focus];
  const opp = data.opportunities[focus];
  const top3 = opp.sections.slice(0, 3);
  return (
    <Section no={no} title="Where the time is" dek="For the lap picked: the sections where another of these laps was quicker, biggest first.">
      <Tabs value={focus} onChange={onFocus} style={styles.tabs}
        items={data.laps.map((l, i) => ({ key: i, label: `L${l.lap} · ${l.session}`, swatch: colors.laps[i] }))} />
      <Text style={StyleSheet.flatten([t.lead, styles.measure])}>
        {opp.sections.length === 0
          ? `${lapLabel(lap)} is the quickest of these laps in every section.`
          : `Where ${lapLabel(lap)} loses most to the quickest of the other laps, section by section:`}
      </Text>
      {top3.length > 0 && (
        <View style={wide ? styles.cols : styles.colsPhone}>
          {top3.map((o, i) => {
            const vs = data.laps[o.versus];
            return (
              <Pressable key={o.code} onPress={() => onShow(o.code, (o.where_m[0] + o.where_m[1]) / 2)}
                accessibilityRole="button"
                accessibilityLabel={`${o.code}: ${o.loss_s.toFixed(2)} s. ${notes?.[o.code] ? `${notes[o.code]}. ` : ''}Show on the traces`}
                style={StyleSheet.flatten([wide ? styles.col : styles.colPhone,
                  wide ? i > 0 && styles.colRule : i > 0 && styles.colTop])}>
                <View style={styles.colHead}>
                  <View style={styles.colNo}><Text style={styles.colNoText}>{i + 1}</Text></View>
                  <Text style={styles.code}>{o.code}</Text>
                </View>
                <Fig value={o.loss_s.toFixed(2)} unit="s" size={wide ? 64 : 52}
                  color={deltaColor(theme, o.loss_s) ?? theme.text} />
                <View style={styles.versus}>
                  <Text style={t.labelMuted}>Against</Text>
                  <LineKey color={colors.laps[o.versus]} />
                  <Text style={StyleSheet.flatten([t.labelMuted, styles.shrink])} numberOfLines={1}>{lapLabel(vs)}</Text>
                </View>
                <Text style={t.body}>{sentence(o)}</Text>
                {notes?.[o.code] && <Text style={styles.note}>{notes[o.code]}</Text>}
                <Swatch color={phaseColor(theme, o.phase)} label={`Mostly ${o.phase}`} width={14} height={10} />
                <Text style={styles.show} {...noPrint}>Show on the traces →</Text>
              </Pressable>
            );
          })}
        </View>
      )}
      {opp.sections.length > 3 && (
        <Text style={StyleSheet.flatten([t.note, styles.also])}>
          Also:{' '}
          {opp.sections
            .slice(3)
            .map((o) => `${o.code} ${o.loss_s.toFixed(2)} s (${o.phase})`)
            .join(' · ')}
        </Text>
      )}
    </Section>
  );
});

type TableProps = { data: CompareResult; colors: Colors; onPick: (code: string) => void; no?: number };

const CELL = 74;

/** Section times on the official corner numbers: the quickest in each section on a purple block, the others as the
 * gap to it on a wash that deepens with the gap. */
export const SectionTable = memo(function SectionTable({ data, colors, onPick, no = 3 }: TableProps) {
  const theme = useTheme();
  const styles = useStyles();
  const t = useText();
  const biggest = Math.max(0.05, ...data.sections.flatMap((s) => s.times.map((x) => x - s.times[s.best])));
  return (
    <Section no={no} title="Section times" dek="Each section of the lap, every lap against the quickest there. Tap a section to zoom the traces to it.">
      {data.numbering === 'detected' && <Text style={t.note}>{DETECTED_CORNERS_NOTE}</Text>}
      <ScrollView horizontal showsHorizontalScrollIndicator>
        <View>
          <View style={styles.headRow}>
            <Text style={StyleSheet.flatten([styles.th, styles.first])}>Section</Text>
            {data.laps.map((l, i) => (
              <View key={i} style={StyleSheet.flatten([styles.cellBox, { width: CELL }])}>
                <View style={styles.colHeadKey}>
                  <LineKey color={colors.laps[i]} />
                  <Text style={styles.th}>L{l.lap}</Text>
                </View>
                <Text style={styles.colSub} numberOfLines={1}>
                  {l.session}
                </Text>
              </View>
            ))}
          </View>
          {data.sections.map((s) => (
            <Pressable key={s.code} style={styles.row} onPress={() => onPick(s.code)} accessibilityRole="button"
              accessibilityLabel={`${s.code}: zoom the traces`}>
              <Text style={StyleSheet.flatten([styles.rowName, styles.first])}>{s.code}</Text>
              {s.times.map((x, i) => {
                const best = i === s.best;
                const gap = x - s.times[s.best];
                return (
                  <View key={i} style={StyleSheet.flatten([styles.cellFill, { width: CELL,
                    backgroundColor: best ? theme.timing.best : deltaWash(theme, gap, biggest) }])}>
                    <Text style={StyleSheet.flatten([styles.cell, best && styles.best])}>
                      {best ? x.toFixed(2) : `+${gap.toFixed(2)}`}
                    </Text>
                  </View>
                );
              })}
            </Pressable>
          ))}
          <View style={StyleSheet.flatten([styles.row, styles.footFirst])}>
            <Text style={StyleSheet.flatten([styles.footName, styles.first])}>Lap</Text>
            {data.laps.map((l, i) => (
              <View key={i} style={StyleSheet.flatten([styles.cellFill, { width: CELL }])}>
                <Text style={StyleSheet.flatten([styles.cell, styles.strong])}>{formatLap(l.time)}</Text>
              </View>
            ))}
          </View>
        </View>
      </ScrollView>
      <View style={styles.legend}>
        <Swatch color={theme.timing.best} label="Quickest of these laps" />
        <Swatch color={theme.delta.lossSteps[0]} label="Slower" />
        <Swatch color={theme.delta.lossSteps[theme.delta.lossSteps.length - 1]} label="Much slower" />
      </View>
      <Text style={t.small}>
        Times in seconds. On purple, the quickest lap in that section; the others show how much slower they were there,
        the deeper the wash the more.
      </Text>
    </Section>
  );
});

type TracesProps = {
  data: CompareResult;
  colors: Colors;
  zoom: string | null;
  onZoom: (code: string | null) => void;
  cursor: number | null;
  onCursor: (i: number | null) => void;
  no?: number;
  // theoretical laps added to the graph (lib/theoretical.ts onGraph), drawn dashed after the real laps
  extra?: { key: string; label: string; trace: LapTrace; color: string; dash: string }[];
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
export function CompareTraces({ data, colors, zoom, onZoom, cursor, onCursor, no = 4, extra = NONE }: TracesProps) {
  const styles = useStyles();
  const t = useText();
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
  const ref = tr.laps[data.reference];
  const refName = `L${data.laps[data.reference].lap} · ${data.laps[data.reference].session}`;
  // the charts zoom together, within the section picked; another section starts from all of it
  const free = useZoomState(`${zoom}`);
  const full: [number, number] = [0, distance[distance.length - 1] ?? 0];
  const zoomedIn = isZoomed(free.view, full);
  const shown = shownRange(free.view, full);

  // the reference's own line is the zero line; in a zoomed section the gap counts from the section's start
  const delta = useMemo(() => {
    const sliced = (x: number[]) => {
      const out = x.slice(i0, i1 + 1).map((v, k) => v - ref.t[i0 + k]);
      return out.map((v) => v - out[0]);
    };
    return [...tr.laps.map((l, i) => ({ values: sliced(l.t), color: colors.laps[i] })),
      ...extra.map((x) => ({ values: sliced(x.trace.t), color: x.color, dash: x.dash }))];
  }, [tr, ref, i0, i1, colors, extra]);
  // each chart's lines, kept from one render to the next so a chart only redraws them when they or its view change
  const byRole = useMemo(() => {
    const part = (values: number[] | undefined, color: string, dash?: string) =>
      (values ? [{ values: values.slice(i0, i1 + 1), color, dash }] : []);
    const out: Partial<Record<TraceRole, { values: number[]; color: string; dash?: string }[]>> = {};
    for (const role of tr.roles) {
      out[role] = [...tr.laps.flatMap((l, i) => part(l[role], colors.laps[i])),
        ...extra.flatMap((x) => part(x.trace[role], x.color, x.dash))];
    }
    return out;
  }, [tr, i0, i1, colors, extra]);
  const seriesOf = (role: TraceRole) => byRole[role] ?? [];
  // whole gears on the axis, the same however far the charts are zoomed: a range of at least five keeps the labels
  // whole numbers
  const gears = useMemo((): [number, number] | undefined => {
    const all = byRole.gear?.flatMap((s) => s.values).filter(Number.isFinite) ?? [];
    if (!all.length) return undefined;
    const top = all.reduce((a, b) => Math.max(a, b));
    return [Math.min(all.reduce((a, b) => Math.min(a, b)), top - 5), top];
  }, [byRole]);
  // the whole lap is marked section by section; a zoomed section, or a zoom into under half the lap or section,
  // shows each official corner in it
  const marks = (section && section.corners.length > 1) || (zoomedIn && shown[1] - shown[0] < (full[1] - full[0]) / 2)
    ? data.track_corners : data.corners;
  const markers = marks
    .filter((c) => c.apex_m >= tr.distance[i0] && c.apex_m <= tr.distance[i1])
    .map((c) => ({ at: c.apex_m - d0, label: c.code }));
  const local = cursor != null && cursor >= i0 && cursor <= i1 ? cursor - i0 : null;
  const shared = { distance, cursor: local, onCursor: (i: number | null) => onCursor(i == null ? null : i + i0), markers };
  const at = local != null ? tr.distance[i0 + local] : null;
  const here = at != null ? data.sections.find((s) => at >= s.start_m && at <= s.end_m)?.code : null;

  return (
    <Section no={no} title="Traces" dek="Every lap on one distance axis, one crosshair across all the charts. Zoom to a section to see its corners.">
      <Tabs label="Zoom" value={zoom} onChange={onZoom} style={styles.tabs}
        items={[null, ...data.sections.map((s) => s.code)].map((code) => ({ key: code, label: code ?? 'Whole lap' }))} />
      <View style={styles.legend}>
        {data.laps.map((l, i) => (
          <Swatch key={i} color={colors.laps[i]} label={`L${l.lap} · ${l.session}`} width={14} height={4} />
        ))}
        {extra.map((x) => (
          <View key={x.key} style={styles.dashLegend}>
            <LineKey color={x.color} dash={x.dash} />
            <Text style={styles.dashLabel}>{x.label}</Text>
          </View>
        ))}
      </View>
      <View style={styles.atRow}>
        <Text style={styles.at}>
          {at != null
            ? `${Math.round(at).toLocaleString()} m${here ? ` · ${here}` : ''}`
            : zoomedIn
              ? `Zoomed: ${Math.round(shown[0] + d0).toLocaleString()} to ${Math.round(shown[1] + d0).toLocaleString()} m`
              : section
                ? `${section.code}: ${section.start_m.toLocaleString()} to ${section.end_m.toLocaleString()} m`
                : `Whole lap: ${data.length_m.toLocaleString()} m`}
        </Text>
        <ResetZoom zoom={free} reserve />
      </View>
      <ZoomGroup zoom={free}>
      <View style={styles.charts}>
        <TraceChart {...shared} title={`Time vs ${refName}`} unit="s" zeroLine height={120} series={delta} />
        {CHARTS.filter((c) => tr.roles.includes(c.role)).map((c) => (
          <TraceChart key={c.role} {...shared} title={c.title} unit={c.unit} height={c.height}
            domain={c.role === 'gear' ? gears : c.domain} series={seriesOf(c.role)} />
        ))}
      </View>
      </ZoomGroup>
      <Text style={StyleSheet.flatten([t.small, styles.measure])}>
        Time: above zero, a lap is behind {refName} at that point
        {section ? ` (counted from the start of ${section.code})` : ''}. Hover over or touch a chart to read every lap
        at the same point. {ZOOM_HINT}
        {data.aligned_by === 'gps' ? ' The laps are placed on one GPS line, so they meet metre for metre.' : ''}
        {data.channels.gear ? ` Gear is the logged ${data.channels.gear} channel.` : ''}
        {data.numbering === 'detected' ? ` ${DETECTED_CORNERS_NOTE}` : ''}
      </Text>
    </Section>
  );
}

const useStyles = themed((c) => ({
  key: { width: 14, height: 4 },
  dashKey: { width: 18, height: 0, borderTopWidth: 3 },
  tabs: { marginBottom: 16 },
  measure: { maxWidth: 820 },
  shrink: { flexShrink: 1 },
  cols: { flexDirection: 'row', alignItems: 'stretch', marginTop: 18, borderTopWidth: 1, borderColor: c.rule },
  colsPhone: { marginTop: 18, borderTopWidth: 1, borderColor: c.rule },
  col: { flex: 1, minWidth: 0, gap: 10, paddingTop: 14, paddingHorizontal: 18 },
  colPhone: { gap: 10, paddingVertical: 14 },
  colRule: { borderLeftWidth: 1, borderColor: c.rule },
  colTop: { borderTopWidth: 1, borderColor: c.separator },
  colHead: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  colNo: { backgroundColor: c.rule, paddingHorizontal: 6, paddingTop: 3, paddingBottom: 2 },
  colNoText: { fontFamily: Fonts.display, fontSize: 15, lineHeight: 18, color: c.background },
  code: { fontFamily: Fonts.display, fontSize: 30, lineHeight: 34, textTransform: 'uppercase', color: c.text },
  versus: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  show: { ...Type.link, fontSize: 12, letterSpacing: 1.2, color: c.text, alignSelf: 'flex-start', borderBottomWidth: 2,
    borderColor: c.rule, paddingBottom: 1, marginTop: 2 },
  also: { marginTop: 14 },
  note: { fontFamily: face('body', 700), fontSize: 16, lineHeight: 23, color: c.text, borderLeftWidth: 3,
    borderColor: c.mark, paddingLeft: 10 },
  // the section table: hairlines between rows, an ink rule under the head, colour as flat blocks in the cells
  headRow: { flexDirection: 'row', alignItems: 'flex-end', borderBottomWidth: 1, borderColor: c.rule },
  row: { flexDirection: 'row', alignItems: 'stretch', height: TAP, borderBottomWidth: 1, borderColor: c.separator },
  footFirst: { borderTopWidth: 3, borderColor: c.rule },
  th: { ...Type.label, fontSize: 11, color: c.text },
  cellBox: { paddingVertical: 5, paddingHorizontal: 6, alignItems: 'flex-end', gap: 2 },
  colHeadKey: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  colSub: { ...Type.label, fontSize: 9, letterSpacing: 0.6, color: c.textMuted, maxWidth: CELL - 8 },
  first: { width: 80, paddingRight: 6, alignSelf: 'center', textAlign: 'left' },
  rowName: { fontFamily: Fonts.display, fontSize: 17, lineHeight: 20, color: c.text },
  footName: { ...Type.label, fontSize: 11, color: c.text },
  cellFill: { justifyContent: 'center', borderRightWidth: 2, borderColor: c.background },
  cell: { ...Type.number, fontSize: 14, paddingHorizontal: 6, textAlign: 'right', color: c.text },
  best: { fontFamily: face('label', 700), color: c.timing.onBest },
  strong: { fontFamily: face('label', 700) },
  legend: { flexDirection: 'row', flexWrap: 'wrap', columnGap: 22, rowGap: 8, marginTop: 14, marginBottom: 6 },
  dashLegend: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  dashLabel: { ...Type.label, fontFamily: Fonts.label, fontSize: 13, letterSpacing: 0.7, color: c.text },
  atRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: 18, rowGap: 6, marginTop: 10,
    marginBottom: 6, minHeight: 22 },
  at: { ...Type.number, fontSize: 13, color: c.textSecondary },
  charts: { gap: 14 },
}));
