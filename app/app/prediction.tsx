import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, useWindowDimensions } from 'react-native';

import { onFill, SubHead, usePrepType } from '@/components/PrepParts';
import { useBackTo } from '@/components/Back';
import PrintButton from '@/components/PrintButton';
import { CarNumber, Prediction } from '@/components/PrepOfficial';
import { Block, Colophon, Fig, Label, Page, Section, TextLink, useGutter, useWide } from '@/components/Programme';
import { useEventFolder } from '@/components/SessionSwitcher';
import { Text, View } from '@/components/Themed';
import { face, themed, Type, useTheme } from '@/constants/Theme';
import { formatLap } from '@/lib/api';
import { noPrint } from '@/lib/print';
import { PrepOfficial } from '@/lib/prep';
import { EventPrediction, PredictionCheck, resultsApi, STATUS_NAMES } from '@/lib/results';

type Tab = 'prediction' | 'actual';

/** An event's Prediction (qualifying places, our lap, pole and race finishes, each with a likely range, from the
 * official results of the rounds before it) and, once the round has official results, Predicted vs actual: each
 * number the model gave against what happened, whether it fell in the likely range, and by how much it missed.
 * ?event=12&view=actual opens the second tab. */
export default function PredictionScreen() {
  const styles = useStyles();
  const theme = useTheme();
  const gutter = useGutter();
  const { width } = useWindowDimensions();
  const router = useRouter();
  const params = useLocalSearchParams<{ event?: string; view?: string }>();
  const event = params.event ? Number(params.event) : null;
  const folder = useEventFolder(event);
  // the masthead's Back, opened fresh: up to the event
  useBackTo(event != null ? { id: event, name: folder?.id === event ? folder.name : null } : null);
  const [data, setData] = useState<EventPrediction | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    if (event == null) return;
    setError(null);
    resultsApi.prediction(event).then(setData, (e) => setError((e as Error).message));
  }, [event]);
  useEffect(load, [load]);

  const view: Tab = params.view === 'actual' && (!data || data.finished) ? 'actual' : 'prediction';
  if (event == null) {
    return (
      <Page>
        <Text style={StyleSheet.flatten([styles.title, styles.head])} accessibilityRole="header">Prediction</Text>
        <Text style={styles.dek}>Open the prediction from an event on Weekend.</Text>
      </Page>
    );
  }
  const title = view === 'actual' ? 'Predicted vs actual' : 'Prediction';
  const longest = Math.max(...title.split(/\s+/).map((w) => w.length), 1);
  const size = Math.max(26, Math.floor(Math.min(Type.title.fontSize ?? 44, (Math.min(width, 1240) - 2 * gutter)
    / (longest * 0.47))));
  const round = data?.round
    ? `${data.series_name} ${data.round.year}, round ${data.round.round}`
    : data?.year ? `${data.series_name} ${data.year}` : null;
  const show = (v: Tab) => router.setParams({ view: v === 'actual' ? 'actual' : undefined });

  return (
    <Page>
      <Stack.Screen options={{ title: folder ? `${title} · ${folder.name}` : title }} />
      <View style={styles.head}>
        <View style={styles.kicker}>
          <Block label={round ?? 'Official results'} color={theme.mark} ink={onFill(theme.mark)} />
          {folder ? <Label style={styles.kickerFacts}>{[folder.name, folder.track].filter(Boolean).join(' · ')}</Label> : null}
        </View>
        <Text style={StyleSheet.flatten([styles.title, { fontSize: size, lineHeight: Math.round(size * 1.05) }])}
          accessibilityRole="header">{title}</Text>
        <Text style={styles.dek}>
          {view === 'actual'
            ? 'What the model said before the weekend, from earlier rounds only, against the official results.'
            : 'Our qualifying places, lap and pole, and our race finishes, worked out from the official results of every earlier round, each with how far such predictions usually miss.'}
        </Text>
        <PrintButton title={[title, folder?.name, folder?.track].filter(Boolean).join(' · ')} style={styles.print} />
        <View style={styles.tabs} {...noPrint}>
          <TextLink label="Prediction" red={view === 'prediction'} onPress={() => show('prediction')} />
          {data?.finished && <TextLink label="Predicted vs actual" red={view === 'actual'} onPress={() => show('actual')} />}
          {folder && folder.id != null && <TextLink label="Event" href={`/event/${folder.id}`} small arrow />}
        </View>
      </View>
      {!data && !error && <ActivityIndicator style={styles.loading} color={theme.text} />}
      {error && <Text style={styles.error}>{`Can’t work out the prediction: ${error}`}</Text>}
      {data && (view === 'actual' ? <Actual data={data} /> : <Predicted data={data} eventId={event} onChanged={load} />)}
      <Colophon left={`The Engineer · ${title}`} right={folder ? [folder.name, folder.track].filter(Boolean).join(' · ')
        : undefined} />
    </Page>
  );
}

// ---------- the prediction ----------

/** The prepared view of the prep report's prediction (components/PrepOfficial.tsx), for this event. */
function asOfficial(d: EventPrediction): PrepOfficial {
  return {
    series: d.series, venue: d.venue, track: d.track, year: d.year ?? 0, car_number: d.car_number,
    car_number_from: d.car_number_from, team: d.team, brand: d.prediction?.brand ?? null, loaded: true, years: [],
    lines: [], track_verdict: null, makes: null, weather: {}, prediction: d.prediction, trust: d.trust, note: d.note,
  };
}

function Predicted({ data, eventId, onChanged }: { data: EventPrediction; eventId: number; onChanged: () => void }) {
  const type = usePrepType();
  const wide = useWide();
  const official = asOfficial(data);
  const logged = data.prediction?.logged_best;
  return (
    <>
      <Section no={1} title="Our car" dek="The car the prediction is for, as the event's Results section has it.">
        <CarNumber eventId={eventId} data={official} onSaved={onChanged} />
      </Section>
      <Section no={2} title={data.finished ? 'What was predicted' : 'The prediction'}
        dek={data.finished ? 'Worked out from the rounds before this one only, as it would have read before the weekend.'
          : 'Likely ranges are how far the model missed when it predicted recent rounds the same way.'}>
        {data.note && <Text style={type.note}>{data.note}</Text>}
        {data.line && <Text style={wide ? type.lead : type.leadPhone}>{data.line[0].toUpperCase() + data.line.slice(1)}</Text>}
        {logged && <Text style={type.note}>{`Our best logged lap of this event (${formatLap(logged.time_s)}) is blended in.`}</Text>}
        <Prediction data={official} />
      </Section>
    </>
  );
}

// ---------- predicted against what happened ----------

const WHAT: Record<PredictionCheck['what'], string> = {
  pole: 'Pole', our_lap: 'Our lap', position: 'Our place', class_position: 'Class place',
};
const isTime = (c: PredictionCheck) => c.what === 'pole' || c.what === 'our_lap';
const fmt = (c: PredictionCheck, v: number | null) => (v == null ? '–' : isTime(c) ? formatLap(v) : `P${v}`);
const fmtRange = (c: PredictionCheck) =>
  !c.range ? '–' : c.range[0] === c.range[1] ? fmt(c, c.range[0]) : `${fmt(c, c.range[0])}–${fmt(c, c.range[1])}`;

/** "0.31 s too slow", "2 places too far back", "spot on": which way the prediction was out. */
function missText(c: PredictionCheck) {
  if (c.miss == null) return '–';
  const m = Math.abs(c.miss);
  if (isTime(c)) return m < 0.005 ? 'spot on' : `${m.toFixed(2)} s too ${c.miss > 0 ? 'slow' : 'quick'}`;
  if (m < 0.5) return 'spot on';
  return `${m} ${m === 1 ? 'place' : 'places'} too far ${c.miss > 0 ? 'back' : 'up'}`;
}

function Actual({ data }: { data: EventPrediction }) {
  const styles = useStyles();
  const type = usePrepType();
  const theme = useTheme();
  const wide = useWide();
  const rows = data.comparison ?? [];
  const judged = rows.filter((r) => r.inside != null && !(r.wet && isTime(r)));
  const inside = judged.filter((r) => r.inside).length;
  const places = (codes: string[]) => {
    const m = rows.filter((r) => r.what === 'position' && codes.includes(r.code) && r.miss != null).map((r) => Math.abs(r.miss!));
    return m.length ? m.reduce((a, b) => a + b, 0) / m.length : null;
  };
  const q = places(['Q1', 'Q2']);
  const r = places(['R1', 'R2']);
  const codes = [...new Set(rows.map((x) => x.code))];
  return (
    <>
      <Section no={1} title="The score" dek="How many numbers landed in their likely range, and how far our places were out.">
        <View style={wide ? styles.figs : styles.figsPhone}>
          <Fig label="In the likely range" value={judged.length ? `${inside}/${judged.length}` : '–'} size={wide ? 64 : 44}
            bar={theme.rule} barHeight={4} style={styles.fig} />
          <Fig label="Quali place, off by" value={q == null ? '–' : q.toFixed(1)} unit={q == null ? undefined : 'places'}
            size={wide ? 64 : 44} bar={theme.rule} barHeight={4} style={styles.fig} />
          <Fig label="Race finish, off by" value={r == null ? '–' : r.toFixed(1)} unit={r == null ? undefined : 'places'}
            size={wide ? 64 : 44} bar={theme.rule} barHeight={4} style={styles.fig} />
        </View>
        {rows.some((x) => x.wet && isTime(x)) && (
          <Text style={type.note}>
            Lap times of a wet session are shown but not scored: the prediction is for the dry.
          </Text>
        )}
      </Section>
      <Section no={2} title="Session by session" dek="Each number predicted, its likely range, what happened and which way the prediction was out.">
        {codes.length === 0 && <Text style={type.note}>No official qualifying or race result for our car yet.</Text>}
        {codes.map((code) => (
          <View key={code} style={styles.block}>
            <SubHead title={code} kicker={rows.find((x) => x.code === code)?.wet ? 'Wet' : undefined} />
            <View style={styles.thRow}>
              <Text style={[styles.th, styles.name]}>Number</Text>
              <Text style={[styles.th, styles.num]}>Predicted</Text>
              {wide && <Text style={[styles.th, styles.num]}>Likely</Text>}
              <Text style={[styles.th, styles.num]}>Actual</Text>
              <Text style={[styles.th, styles.num]}>Was</Text>
            </View>
            {rows.filter((x) => x.code === code).map((c) => (
              <View key={c.what} style={[styles.row, c.inside === false && !(c.wet && isTime(c)) && styles.rowOut]}>
                <Text style={[styles.td, styles.name]}>{WHAT[c.what]}</Text>
                <Text style={[styles.td, styles.num]}>{fmt(c, c.predicted)}</Text>
                {wide && <Text style={[styles.td, styles.num, styles.muted]}>{fmtRange(c)}</Text>}
                <Text style={[styles.td, styles.num, styles.bold]}>
                  {c.actual == null && c.status && c.status !== 'classified' ? STATUS_NAMES[c.status] : fmt(c, c.actual)}
                </Text>
                <Text style={[styles.td, styles.num]}>{c.inside == null ? missText(c)
                  : `${missText(c)}${c.inside ? ' ✓' : ''}`}</Text>
              </View>
            ))}
          </View>
        ))}
        <Text style={type.note}>✓ in the likely range. A shaded row fell outside it. Race places are “if we finish”.</Text>
      </Section>
    </>
  );
}

const useStyles = themed((c) => ({
  head: { paddingTop: 28 },
  kicker: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 10, marginBottom: 12 },
  kickerFacts: { flexShrink: 1 },
  title: { ...Type.title, color: c.text },
  dek: { ...Type.dek, color: c.textSecondary, marginTop: 8, maxWidth: 680 },
  print: { marginTop: 14 },
  tabs: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', columnGap: 22, rowGap: 10, marginTop: 20 },
  loading: { alignSelf: 'flex-start', marginTop: 28 },
  error: { fontFamily: face('body', 400), fontSize: 16, color: c.error, marginTop: 28 },
  figs: { flexDirection: 'row', gap: 32, marginBottom: 14 },
  figsPhone: { flexDirection: 'row', flexWrap: 'wrap', columnGap: 22, rowGap: 18, marginBottom: 14 },
  fig: { flexGrow: 1, flexBasis: 140 },
  block: { marginBottom: 22 },
  thRow: { flexDirection: 'row', gap: 8, borderBottomWidth: 2, borderColor: c.rule, paddingBottom: 5 },
  th: { ...Type.label, fontFamily: face('label', 700), fontSize: 12, letterSpacing: 1.2, color: c.text },
  row: { flexDirection: 'row', gap: 8, alignItems: 'baseline', borderBottomWidth: 1, borderColor: c.separator,
    paddingTop: 7, paddingBottom: 7, paddingHorizontal: 4 },
  rowOut: { backgroundColor: c.band },
  name: { flex: 1.2, minWidth: 0 },
  num: { flex: 1, textAlign: 'right' },
  td: { fontFamily: face('label', 500), fontSize: 15, fontVariant: ['tabular-nums'], color: c.text },
  bold: { fontFamily: face('label', 700) },
  muted: { color: c.textSecondary },
}));
