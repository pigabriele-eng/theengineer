// Corner by corner time loss for a coaching day: a client's best lap against the reference lap (the day's quickest),
// one card per corner (official numbers, grouped as the analysis groups them), the most time lost first. Each card
// says what it cost, the phase where most of it went and what the client did differently, beside the corner's
// technique graph: speed, brake and throttle through the corner, the client's pass as a solid line over the
// reference pass as a dashed one. From POST /compare/laps (lib/compare.ts), which traces the laps from their lap packs.
import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, StyleSheet } from 'react-native';
import Svg, { Line } from 'react-native-svg';

import { useText } from '@/components/Picks';
import { TextLink, useWide } from '@/components/Programme';
import { Text, View } from '@/components/Themed';
import { TraceChart, useSeriesColors } from '@/components/TraceChart';
import { ResetZoom, ZOOM_HINT, ZoomGroup } from '@/components/Zoom';
import { DETECTED_CORNERS_NOTE, formatLap } from '@/lib/api';
import { CornerLoss, cornerLosses, lossText, phaseLine, pointWindow, Reference } from '@/lib/coachingDay';
import { compareLaps, CompareResult, TraceRole } from '@/lib/compare';
import { Fonts, themed, Type, useTheme } from '@/constants/Theme';

const SHOWN = 4; // cards open at first; the others one tap away
const DASH = '6,4';
const CHARTS: { role: TraceRole; title: string; unit: string; height: number; domain?: [number, number] }[] = [
  { role: 'speed', title: 'Speed', unit: 'km/h', height: 130 },
  { role: 'brake', title: 'Brake', unit: '', height: 90 },
  { role: 'throttle', title: 'Throttle', unit: '%', height: 90, domain: [0, 100] },
];

export type Lap = { session_id: number; lap: number; time: number; run: string; driver: string | null };

/** A client's lap against the reference lap, corner by corner. */
export function CornerByCorner({ client, reference }: { client: Lap; reference: Reference }) {
  const styles = useStyles();
  const t = useText();
  const theme = useTheme();
  const series = useSeriesColors();
  const [data, setData] = useState<CompareResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [all, setAll] = useState(false);
  const key = `${client.session_id}.${client.lap}:${reference.session_id}.${reference.lap}`;
  useEffect(() => {
    let live = true;
    setData(null);
    setError(null);
    compareLaps([{ session_id: client.session_id, lap: client.lap },
      { session_id: reference.session_id, lap: reference.lap }]).then(
      (d) => live && setData(d),
      (e) => live && setError((e as Error).message),
    );
    return () => {
      live = false;
    };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps -- the two laps, by value
  const losses = useMemo(() => (data ? cornerLosses(data, 0, 1) : []), [data]);

  if (error) return <Text style={t.error}>Couldn't compare the laps: {error}</Text>;
  if (!data) {
    return (
      <View style={styles.waiting}>
        <ActivityIndicator color={theme.text} />
        <Text style={t.note}>Laying the two laps over each other…</Text>
      </View>
    );
  }
  const lost = losses.filter((l) => l.loss_s >= 0.01);
  const costliest = lost.slice(0, SHOWN);
  const shown = all ? losses : costliest;
  const rest = losses.length - costliest.length; // the corners folded away while only the costliest show
  const names = { client: lapName(client), reference: lapName(reference) };
  return (
    <View style={styles.wrap}>
      <Text style={t.body}>{summary(client, reference, losses)}</Text>
      <View style={styles.legend} accessibilityRole="text"
        accessibilityLabel={`Solid line: ${names.client}. Dashed line: ${names.reference}.`}>
        <LineKey color={series.reference} label={names.client} />
        <LineKey color={series.compare} label={`${names.reference} (reference)`} dash />
      </View>
      {shown.map((l, i) => (
        <CornerCard key={l.code} no={i + 1} loss={l} data={data} colors={series} names={names} />
      ))}
      {rest > 0 && (all
        ? <TextLink label="Show the costliest only" onPress={() => setAll(false)} />
        : <TextLink label={`Show the other ${rest} corner${rest === 1 ? '' : 's'}`} onPress={() => setAll(true)} />)}
      <Text style={styles.foot}>
        Each corner's time is from the start of its stretch of track to the start of the next. The laps are placed on
        {data.aligned_by === 'gps' ? ' one GPS line' : ' one distance axis'}, so they meet metre for metre.
        {data.numbering === 'detected' ? ` ${DETECTED_CORNERS_NOTE}` : ''} {ZOOM_HINT}
      </Text>
    </View>
  );
}

/** "1:48.36 against 1:47.44: +0.92 s a lap, 1.10 s lost in 6 corners and 0.18 s made up in 2." */
function summary(client: Lap, reference: Reference, losses: CornerLoss[]) {
  const lost = losses.filter((l) => l.loss_s >= 0.01);
  const made = losses.filter((l) => l.loss_s <= -0.01);
  const sum = (xs: CornerLoss[]) => Math.abs(xs.reduce((s, l) => s + l.loss_s, 0)).toFixed(2);
  const parts = [lost.length ? `${sum(lost)} s lost in ${lost.length} corner${lost.length === 1 ? '' : 's'}` : null,
    made.length ? `${sum(made)} s made up in ${made.length}` : null].filter(Boolean).join(' and ');
  return `${formatLap(client.time)} against ${formatLap(reference.time)}: ${lossText(client.time - reference.time)} a lap${parts ? `, ${parts}` : ''}.`;
}

const lapName = (l: Lap) => `${l.driver ? `${l.driver} · ` : ''}${l.run} L${l.lap}`;

/** One corner: what it cost and why, beside its speed, brake and throttle traces. */
function CornerCard({ no, loss, data, colors, names }: {
  no: number;
  loss: CornerLoss;
  data: CompareResult;
  colors: { reference: string; compare: string };
  names: { client: string; reference: string };
}) {
  const styles = useStyles();
  const t = useText();
  const wide = useWide();
  const [cursor, setCursor] = useState<number | null>(null);
  const tr = data.traces;
  const [i0, i1] = useMemo(() => pointWindow(tr.distance, loss.start_m, loss.end_m), [tr.distance, loss]);
  const d0 = tr.distance[i0];
  const distance = useMemo(() => tr.distance.slice(i0, i1 + 1).map((d) => d - d0), [tr.distance, i0, i1, d0]);
  const markers = data.track_corners.filter((c) => c.apex_m >= tr.distance[i0] && c.apex_m <= tr.distance[i1])
    .map((c) => ({ at: c.apex_m - d0, label: c.code }));
  const lost = loss.loss_s >= 0.01;
  const gained = loss.loss_s <= -0.01;
  const verdict = lost ? `${lossText(loss.loss_s)} lost` : gained ? `${lossText(loss.loss_s)}: quicker here` : 'Level';
  const phase = phaseLine(loss);
  return (
    <View style={wide ? styles.card : styles.cardPhone}>
      <View style={wide ? styles.words : styles.wordsPhone}>
        <View style={styles.cardHead}>
          <View style={styles.cardNo}><Text style={styles.cardNoText}>{no}</Text></View>
          <Text style={styles.code} accessibilityRole="header">{loss.code}</Text>
        </View>
        <Text style={StyleSheet.flatten([styles.loss, !lost && styles.lossQuiet])}>{verdict}</Text>
        {phase && <Text style={styles.phase}>{phase}</Text>}
        {loss.words ? <Text style={t.body}>{loss.words}</Text> : lost ? (
          <Text style={t.note}>No single technique difference stands out here: look at the traces.</Text>
        ) : null}
      </View>
      <View style={styles.charts} accessibilityLabel={`${loss.code}: speed, brake and throttle through the corner, ${names.client} solid, ${names.reference} dashed`}>
        <ZoomGroup reset={loss.code}>
          <ResetZoom />
          {CHARTS.filter((c) => tr.roles.includes(c.role)).map((c) => {
            const part = (values: number[] | undefined, color: string, dash?: string) =>
              values ? [{ values: values.slice(i0, i1 + 1), color, dash }] : [];
            // the reference first, so the client's line is drawn over it
            const lines = [...part(tr.laps[1]?.[c.role], colors.compare, DASH),
              ...part(tr.laps[0]?.[c.role], colors.reference)];
            return (
              <TraceChart key={c.role} title={c.title} unit={c.unit} height={c.height} domain={c.domain}
                distance={distance} series={lines} cursor={cursor} onCursor={setCursor} markers={markers} />
            );
          })}
        </ZoomGroup>
      </View>
    </View>
  );
}

/** A line's key: a short stroke of its colour, dashed for the reference, and its name. */
function LineKey({ color, label, dash }: { color: string; label: string; dash?: boolean }) {
  const styles = useStyles();
  return (
    <View style={styles.key}>
      <Svg width={28} height={10}>
        <Line x1={1} x2={27} y1={5} y2={5} stroke={color} strokeWidth={3} strokeDasharray={dash ? DASH : undefined} />
      </Svg>
      <Text style={styles.keyText}>{label}</Text>
    </View>
  );
}

const useStyles = themed((c) => ({
  wrap: { gap: 16 },
  waiting: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 8 },
  legend: { flexDirection: 'row', flexWrap: 'wrap', columnGap: 22, rowGap: 8 },
  key: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  keyText: { ...Type.label, fontSize: 13, letterSpacing: 0.8, color: c.text },
  card: { flexDirection: 'row', alignItems: 'flex-start', gap: 24, borderTopWidth: 3, borderColor: c.rule, paddingTop: 14 },
  cardPhone: { gap: 12, borderTopWidth: 3, borderColor: c.rule, paddingTop: 12 },
  words: { width: 280, gap: 8 },
  wordsPhone: { gap: 8 },
  cardHead: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  cardNo: { backgroundColor: c.rule, paddingHorizontal: 7, paddingTop: 4, paddingBottom: 3 },
  cardNoText: { fontFamily: Fonts.display, fontSize: 18, lineHeight: 20, color: c.background },
  code: { fontFamily: Fonts.display, fontSize: 36, lineHeight: 40, textTransform: 'uppercase', color: c.text },
  loss: { ...Type.number, fontSize: 22, lineHeight: 28, color: c.text },
  lossQuiet: { fontSize: 18, lineHeight: 24, color: c.textSecondary },
  phase: { ...Type.label, fontSize: 13, color: c.textSecondary },
  charts: { flex: 1, minWidth: 0, gap: 8, alignSelf: 'stretch' },
  foot: { fontFamily: Fonts.body, fontSize: 14, lineHeight: 20, color: c.textSecondary, maxWidth: 820 },
}));
