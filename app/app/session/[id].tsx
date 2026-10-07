import * as DocumentPicker from 'expo-document-picker';
import { Link, Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { Fragment, ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, TextStyle, useWindowDimensions, ViewStyle } from 'react-native';

import { LapCompare } from '@/components/LapCompare';
import { SessionResults } from '@/components/OfficialSessionCard';
import {
  B, Block, Colophon, Fig, Folio, Hero, Label, Page, Section, Swatch, TextLink, useGutter, useWide,
} from '@/components/Programme';
import { median, tyreStep, TyreMeasure } from '@/components/report/QuickLaps';
import { RunHeader } from '@/components/RunChips';
import PrintButton from '@/components/PrintButton';
import { SessionSwitcher, useEventFolder } from '@/components/SessionSwitcher';
import { SetupCard } from '@/components/SetupCard';
import { Text, View } from '@/components/Themed';
import { TrackMap } from '@/components/TrackMap';
import { UntimedNote } from '@/components/UntimedNote';
import { Analysis, api, Debrief, DETECTED_CORNERS_NOTE, formatLap, SessionDetail } from '@/lib/api';
import { Tagged } from '@/lib/drivers';
import { dayLabel, KIND_NAMES, sessionsInOrder } from '@/lib/events';
import { noPrint } from '@/lib/print';
import { fetchReport } from '@/lib/report';
import { fetchStintView, StintLap, StintView } from '@/lib/stint';
import { face, Fonts, Palette, photoFor, themed, Type, useTheme } from '@/constants/Theme';

const EVENT_POLL_MS = 5000;
const SAME_S = 0.0015; // section times are kept to the millisecond: closer than this is the same time
const CORNERS = ['fl', 'fr', 'rl', 'rr'] as const;
const CORNER_NAMES = ['FL', 'FR', 'RL', 'RR'];
const WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve',
  'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty'];
const inWords = (n: number) => WORDS[n] ?? String(n);
const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const metres = (m: number) => `${Math.round(m).toLocaleString('en-GB')} m`;
// "T2-T5" -> "T2-5", "T8/T9" -> "T8/9": the official numbers, short enough for a column
const shortCode = (code: string) => code.replace(/([-/])T/g, '$1');

type Status = 'fastest' | 'clean' | 'out' | 'in' | 'pit' | 'slow' | 'other';
const STATUS_NAME: Record<Status, string> = {
  fastest: 'Fastest', clean: 'Clean', out: 'Out', in: 'In', pit: 'Pit', slow: 'Slow', other: 'Not clean',
};

type ChartLap = {
  number: number;
  time: number;
  clean: boolean;
  status: Status;
  sec: (number | null)[]; // each section's time, in lap order (clean laps only)
  p: (number | null)[]; // hot pressure FL, FR, RL, RR, bar
  t: (number | null)[]; // TPMS temperature, °C
};
type ChartStint = { number: number; first: number; last: number; flying: number; words: string | null };
type Chart = {
  codes: string[];
  laps: ChartLap[];
  stints: ChartStint[]; // none until the stint view is in
  runBest: (number | null)[];
  eventBest: (number | null)[] | null; // null until the event's report is in
  best: number | null; // the run's quickest clean lap
  bestIsEvent: boolean; // ...and it is the quickest of the event
  mid: Record<TyreMeasure, number | null>; // the middle of the run's clean laps, all four corners
  tyres: boolean;
};

/** The lap chart from the run's laps (its main log), the corner times of its analysis, the stint tool's lap kinds and
 * tyre readings, and the event report's best pass of each section. */
function buildChart(session: SessionDetail, analysis: Analysis | null, stints: StintView | null,
  eventSections: Record<string, number> | null, eventBestLap: number | null): Chart {
  const fileId = analysis?.file_id ?? session.laps[0]?.file_id;
  const laps = session.laps.filter((l) => l.file_id === fileId).sort((a, b) => a.number - b.number);
  const byLap = new Map<number, StintLap>();
  for (const s of stints?.stints ?? []) if (s.file_id == null || s.file_id === fileId) s.laps.forEach((l) => byLap.set(l.lap, l));
  const corners = analysis?.corners ?? [];
  const codes = corners.map((c) => c.code);
  const clean = laps.filter((l) => l.clean);
  const best = clean.length ? Math.min(...clean.map((l) => l.time_s)) : null;
  const rows: ChartLap[] = laps.map((l) => {
    const sl = byLap.get(l.number);
    const status: Status = l.clean ? (l.time_s === best ? 'fastest' : 'clean')
      : sl && sl.kind !== 'flying' ? sl.kind : 'other';
    return {
      number: l.number,
      time: l.time_s,
      clean: l.clean,
      status,
      sec: corners.map((c) => (l.clean ? c.laps[String(l.number)]?.time ?? null : null)),
      p: CORNERS.map((k) => sl?.tyres?.pressure_bar?.[k] ?? null),
      t: CORNERS.map((k) => sl?.tyres?.temperature_c?.[k] ?? null),
    };
  });
  const cleanRows = rows.filter((r) => r.clean);
  const runBest = codes.map((_, i) => {
    const v = cleanRows.map((r) => r.sec[i]).filter((x): x is number => x != null);
    return v.length ? Math.min(...v) : null;
  });
  // the event's best pass of each section (never slower than this run's); none when its report names other sections
  const eventBest = eventSections && codes.length && codes.every((code) => eventSections[code] != null)
    ? codes.map((code, i) => Math.min(eventSections[code], runBest[i] ?? Infinity)) : null;
  const all = (pick: (r: ChartLap) => (number | null)[]) => cleanRows.flatMap(pick);
  const tyres = rows.some((r) => r.p.some((v) => v != null) || r.t.some((v) => v != null));
  return {
    codes,
    laps: rows,
    stints: (stints?.stints ?? []).filter((s) => s.file_id == null || s.file_id === fileId).map((s) => ({
      number: s.number, first: s.first_lap, last: s.last_lap, flying: s.laps.filter((l) => l.kind === 'flying').length,
      words: s.words.headline || null,
    })),
    runBest,
    eventBest,
    best,
    bestIsEvent: best != null && eventBestLap != null && best <= eventBestLap + 0.0005,
    mid: { pressure_bar: median(all((r) => r.p)), temperature_c: median(all((r) => r.t)) },
    tyres,
  };
}

/** One run as a race programme's lap chart: the photo and the run's name, its four figures (best lap, theoretical
 * best, what is left on the table, laps), then every lap in numbers (section times against the run's and the event's
 * best, hot pressure and TPMS temperature at each corner) by stint; then the track, corner by corner, lap against lap,
 * the setup and the debriefs. */
export default function SessionScreen() {
  const styles = useStyles();
  const theme = useTheme();
  const wide = useWide();
  const { id } = useLocalSearchParams<{ id: string }>();
  const sessionId = Number(id);
  const [session, setSession] = useState<SessionDetail | null>(null);
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [debriefs, setDebriefs] = useState<Debrief[]>([]);
  const [stints, setStints] = useState<StintView | null>(null);
  const [eventSections, setEventSections] = useState<Record<string, number> | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();
  // the other sessions of its event, to switch to without going back: the page stays where it is, the last
  // session's numbers dimmed until the new one's arrive
  const eventId = (session as { event_id?: number | null } | null)?.event_id;
  const folder = useEventFolder(eventId);
  const [analysisFor, setAnalysisFor] = useState<number | null>(null);
  const current = useRef(sessionId);
  current.current = sessionId;

  const load = useCallback(async () => {
    // the run, its debriefs and its lap analysis asked for at once, not one after the other
    const asked = {
      session: api.session(sessionId), debriefs: api.debriefs(sessionId), analysis: api.analysis(sessionId),
    };
    asked.debriefs.catch(() => undefined); // (their failures are shown below, once the run is in)
    asked.analysis.catch(() => undefined);
    const mine = () => current.current === sessionId; // not switched again meanwhile
    let s: SessionDetail;
    try {
      s = await asked.session;
    } catch (e) {
      if (mine()) setError((e as Error).message);
      return;
    }
    if (!mine()) return;
    setSession(s);
    setError(null);
    // the debriefs and the analysis each on their own: one failing doesn't hold the other up, and the chart is
    // drawn (without the analysis) even when the analysis fails
    await Promise.all([
      asked.debriefs.then(
        (d) => mine() && setDebriefs(d),
        (e) => {
          if (!mine()) return;
          setDebriefs([]);
          setError((e as Error).message);
        },
      ),
      (s.files.length ? asked.analysis : Promise.resolve(null)).then( // a run without a log has no analysis
        (a) => {
          if (!mine()) return;
          setAnalysis(a);
          setAnalysisFor(sessionId);
        },
        (e) => {
          if (!mine()) return;
          setAnalysis(null);
          setAnalysisFor(sessionId);
          setError((e as Error).message);
        },
      ),
    ]);
  }, [sessionId]);
  useEffect(() => {
    load();
  }, [load]);

  // the stint tool's view of the run's main log: each lap's kind (out, in, pit), its stint and its tyre readings
  const mainFile = analysisFor === sessionId ? analysis?.file_id ?? session?.files[0]?.id : undefined;
  useEffect(() => {
    if (mainFile == null) return;
    let live = true;
    setStints(null);
    fetchStintView([mainFile]).then((v) => live && setStints(v), () => live && setStints(null));
    return () => {
      live = false;
    };
  }, [mainFile]);

  // the event's best pass of each section, from its report (asked for again while the server works it out)
  useEffect(() => {
    if (eventId == null) {
      setEventSections(null);
      return;
    }
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const a = await fetchReport({ event: eventId });
        if (!live) return;
        if (a.report) setEventSections(Object.fromEntries(a.report.sections.map((s) => [s.code, s.times.best])));
        if (a.status === 'queued' || a.status === 'running') timer = setTimeout(poll, EVENT_POLL_MS);
      } catch {
        // no report: the chart compares with this run only
      }
    };
    poll();
    return () => {
      live = false;
      if (timer) clearTimeout(timer);
    };
  }, [eventId]);

  const upload = async () => {
    const pick = await DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true });
    if (pick.canceled) return;
    const asset = pick.assets[0];
    setBusy(true);
    setError(null);
    try {
      await api.uploadFile(sessionId, { uri: asset.uri, name: asset.name, file: asset.file });
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const stale = (session != null && session.id !== sessionId) || (analysisFor != null && analysisFor !== sessionId);
  const ready = session != null && analysisFor === session.id;
  const order = sessionsInOrder(folder);
  const at = order.findIndex((s) => s.id === sessionId);
  const inFolder = at >= 0 ? order[at] : null;
  const eventBestLap = folder?.best_lap_s ?? null;
  const chart = useMemo(
    () => (session && ready ? buildChart(session, analysis, stints, eventSections, eventBestLap) : null),
    [session, ready, analysis, stints, eventSections, eventBestLap],
  );

  if (!session) {
    return (
      <Page>
        <Stack.Screen options={{ title: 'Session' }} />
        {error ? <Text style={styles.error}>Can&apos;t reach the server: {error}</Text> : <ActivityIndicator style={styles.loading} />}
      </Page>
    );
  }

  const title = session.name ?? `Session ${session.id}`;
  const track = session.track_name ?? folder?.track ?? null;
  const hasClean = session.laps.some((l) => l.clean);
  const laps = chart?.laps ?? [];
  const cleanCount = laps.filter((l) => l.clean).length;
  const offCount = laps.length - cleanCount;
  const stintCount = chart?.stints.length ?? 0;
  const deck = laps.length
    ? `${inFolder?.date ? `${dayLabel(inFolder.date, { long: true })}${inFolder.time ? `, ${inFolder.time}` : ''}. ` : ''}` +
      `${capital(inWords(laps.length))} ${laps.length === 1 ? 'lap' : 'laps'}, ` +
      `${cleanCount === laps.length ? (laps.length === 1 ? 'clean' : 'all of them clean')
        : `${inWords(cleanCount)} of them clean`}${stintCount > 1 ? `, in ${inWords(stintCount)} stints` : ''}.`
    : 'No timed laps yet.';

  const top = (
    <>
      <Hero photo={photoFor(track)} tag="Lap chart" height={wide ? 400 : 440}
        rest={[session.event_name, at >= 0 ? `Run ${at + 1} of ${order.length}` : null].filter(Boolean).join(' · ') || undefined}
        restHref={eventId != null ? { pathname: '/event/[id]', params: { id: String(eventId) } } : undefined}
        title={title} deck={deck} deckGap={/[_gjpqy,]/.test(title) ? 22 : undefined} />
      <Folio items={[
        track ? <>{track}{analysis?.length_m ? <> <B>{metres(analysis.length_m)}</B></> : null}</> : null,
        <><B>{KIND_NAMES[session.kind]}</B>{inFolder?.driver ? ` · ${inFolder.driver}` : ''}</>,
        chart?.mid.pressure_bar != null ? <>Hot pressures, run&apos;s middle <B>{chart.mid.pressure_bar.toFixed(2)} bar</B></> : null,
        eventBestLap != null ? <>Event best <B>{formatLap(eventBestLap)}</B></> : null,
      ]} />
    </>
  );

  const sections: { title: string; dek?: string; body: ReactNode }[] = [];
  if (chart && laps.length) {
    sections.push({ title: 'The run',
      dek: 'The best lap against the best of each section, from this run and from the whole event.',
      body: <RunFigures chart={chart} analysis={analysis} cleanCount={cleanCount} offCount={offCount} /> });
    sections.push({ title: 'Lap chart',
      dek: chart.tyres ? 'Every lap in numbers: section times, then hot pressure and TPMS temperature at each corner.'
        : 'Every lap in numbers: its time and the time of each section.',
      body: <LapChart chart={chart} runs={order.filter((s) => s.best_lap_s != null).length} /> });
  }
  if (hasClean && ready) {
    sections.push({ title: 'The track', dek: 'Its sections, numbered as the lap chart has them.',
      body: <TrackMap key={`${session.id}-${session.files.length}-${session.best_lap_s}`} session={session.id} withShape /> });
  }
  if (analysis && ready && analysis.corners.length > 0) {
    sections.push({ title: 'Corner by corner',
      dek: `Each section on the best lap (L${analysis.reference_lap}) against its quickest pass in this run.`,
      body: <Corners analysis={analysis} /> });
    sections.push({ title: 'Lap against lap', dek: 'Any two laps of the run, trace on trace.',
      body: <LapCompare key={`${session.id}-${analysis.file_id}`} sessionId={session.id} analysis={analysis} laps={session.laps} bare /> });
  }
  sections.push({ title: debriefs.length ? 'The car & debriefs' : 'The car',
    dek: debriefs.length ? 'Its setup sheet for this run, and what the driver said.' : 'Its setup sheet for this run.',
    body: (
      <View style={styles.stack}>
        <SetupCard sessionId={sessionId} bare />
        {debriefs.length > 0 && (
          <View>
            <Text style={styles.subhead}>Debriefs</Text>
            {debriefs.map((d) => (
              <Link key={d.id} href={{ pathname: '/debrief/[id]', params: { id: d.id } }} asChild>
                <Pressable style={styles.debrief} accessibilityRole="link">
                  <Text style={styles.debriefTitle}>
                    {new Date(d.created_at).toLocaleString()} · {d.mode === 'group' ? 'group' : 'driver'}
                  </Text>
                  <Text style={styles.debriefText} numberOfLines={2}>
                    {d.status === 'ready' ? d.summary || `${d.points.length} points`
                      : d.status === 'failed' ? 'Not processed yet' : 'Processing…'}
                  </Text>
                </Pressable>
              </Link>
            ))}
          </View>
        )}
      </View>
    ) });

  return (
    <Page top={top}>
      <Stack.Screen options={{ title: [title, track].filter(Boolean).join(' · ') }} />
      {folder && (
        <SessionSwitcher folder={folder} current={sessionId} onPick={(s) => router.setParams({ id: String(s.id) })} />
      )}
      {stale && <ActivityIndicator style={styles.loading} />}
      <View style={StyleSheet.flatten([styles.body, stale && styles.stale])}>
        {session.id === sessionId && (
          <View style={styles.runLine}>
            <RunHeader key={session.id} bare
              run={{ id: session.id, name: title, driver_id: (session as Tagged).driver_id, car_id: (session as Tagged).car_id }}
              kind={session.kind} eventId={(session as Tagged).event_id}
              logSession={session.files.map((f) => (f.meta as { event_session?: string }).event_session).find(Boolean)}
              onChanged={() => api.session(sessionId).then(
                (s) => current.current === sessionId && setSession(s),
                (e) => current.current === sessionId && setError(e.message),
              )} />
          </View>
        )}
        <View style={styles.actions} {...noPrint}>
          {hasClean && (
            <TextLink href={{ pathname: '/report', params: { session: sessionId } }} label="Report: how to go faster" red arrow />
          )}
          {hasClean && <TextLink href={{ pathname: '/technique', params: { session: sessionId } }} label="Technique check" />}
          {hasClean && <TextLink href={{ pathname: '/quali', params: { session: sessionId } }} label="Quali prep" />}
          {session.laps.length > 0 && (
            <TextLink href={{ pathname: '/tools/stint', params: { session: sessionId } }} label="Stint analysis" />
          )}
          {session.best_lap_s != null && (
            <TextLink href={{ pathname: '/compare', params: { session: sessionId } }} label="Compare" />
          )}
          <View style={styles.upload}>
            <TextLink onPress={upload} disabled={busy} label={busy ? 'Uploading…' : 'Upload a logger file'} />
            {busy && <ActivityIndicator color={theme.text} />}
          </View>
          <PrintButton title={['Lap chart', title, session.event_name].filter(Boolean).join(' · ')} />
        </View>
        {!session.laps.length && (
          <Text style={styles.note}>Upload a logger file: a MoTeC .ld (with its .ldx) or a CSV export.</Text>
        )}
        {error && <Text style={styles.error}>{error}</Text>}
        <UntimedNote session={session} />
        <SessionResults sessionId={sessionId} />
        {!ready && !stale && <ActivityIndicator style={styles.loading} />}
        {analysis?.numbering === 'detected' && analysis.corners.length > 0 && (
          <Text style={styles.note}>{DETECTED_CORNERS_NOTE}</Text>
        )}
        {sections.map((s, i) => (
          <Section key={s.title} no={i + 1} title={s.title} dek={s.dek}>{s.body}</Section>
        ))}
      </View>
      <Colophon left="The Engineer · Lap chart" right={[title, track].filter(Boolean).join(' · ')} />
    </Page>
  );
}

// ---------- 01 the run ----------

function RunFigures({ chart, analysis, cleanCount, offCount }: {
  chart: Chart;
  analysis: Analysis | null;
  cleanCount: number;
  offCount: number;
}) {
  const styles = useStyles();
  const c = useTheme();
  const wide = useWide();
  const gutter = useGutter();
  const { width } = useWindowDimensions();
  const fastest = chart.laps.find((l) => l.status === 'fastest');
  const theo = analysis?.corners.length ? analysis.theoretical_best : null;
  const left = chart.best != null && theo != null ? Math.max(chart.best - theo, 0) : null;
  // the four figures share the column: as big as the mockup's, smaller when a lap time would not fit
  const cell = (Math.min(width, 1240) - 2 * gutter) / (wide ? 4 : 2) - (wide ? 36 : 12);
  const size = Math.floor(Math.min(wide ? 76 : 50, cell / 3.6));
  const figs = [
    <Fig key="best" label={fastest ? `Best lap · L${fastest.number}` : 'Best lap'} value={formatLap(chart.best)} size={size}
      bar={chart.bestIsEvent ? c.timing.best : c.timing.personal}
      note={chart.bestIsEvent ? 'quickest of the event' : 'quickest of this run'} />,
    <Fig key="theo" label="Theoretical best" value={formatLap(theo)} size={size} bar={c.timing.personal}
      note="this run’s best sections added up" />,
    <Fig key="left" label="Left on the table" value={left != null ? left.toFixed(2) : '–'} unit={left != null ? 's' : undefined}
      size={size} color={left != null ? c.delta.loss : undefined} bar={c.delta.loss} note="between the two" />,
    <Fig key="laps" label="Laps" value={String(chart.laps.length)} size={size} bar={c.rule}
      note={`${cleanCount} clean · ${offCount} out, in or pit`} />,
  ];
  return (
    <View style={wide ? styles.figs : styles.figsPhone}>
      {figs.map((f, i) => (
        <View key={i} style={wide
          ? StyleSheet.flatten([styles.figCell, i > 0 && styles.figNext])
          : StyleSheet.flatten([styles.figCellPhone, i % 2 === 1 && styles.figNextPhone, i > 1 && styles.figLowerPhone])}>
          {f}
        </View>
      ))}
    </View>
  );
}

// ---------- 02 the lap chart ----------

// column widths of the lap chart on a wide screen
const W = { lap: 40, stat: 74, time: 74, gap: 52, sec: 48, sp: 10, p: 40, t: 34, row: 33 };

/** How a section time reads: purple the event's best pass, green the run's, the slower tint otherwise. */
function secTone(c: Palette, chart: Chart, lap: ChartLap, i: number): { bg?: string; fg?: string; bold?: boolean } {
  const v = lap.sec[i];
  if (v == null) return {};
  const e = chart.eventBest?.[i];
  const r = chart.runBest[i];
  if (e != null && v <= e + SAME_S) return { bg: c.timing.best, fg: c.timing.onBest, bold: true };
  if (r != null && v <= r + SAME_S) return { bg: c.timing.personal, fg: c.timing.onBest, bold: true };
  return { bg: c.timing.slowerTint, fg: c.text };
}

/** A tyre reading's colour on a clean lap: its step on the cold-to-hot scale against the run's middle. */
function tyreTone(c: Palette, chart: Chart, lap: ChartLap, v: number | null, m: TyreMeasure) {
  const mid = chart.mid[m];
  if (!lap.clean || v == null || mid == null) return {};
  const k = tyreStep(v, mid, m);
  return { bg: c.tyre.scale[k], fg: c.tyre.onScale[k] };
}

const pText = (v: number | null) => (v == null ? '–' : v.toFixed(2));
const tText = (v: number | null) => (v == null ? '–' : String(Math.round(v)));
const sum = (vs: (number | null)[]) => (vs.every((v) => v != null) ? (vs as number[]).reduce((a, b) => a + b, 0) : null);

function LapChart({ chart, runs }: { chart: Chart; runs: number }) {
  const styles = useStyles();
  const wide = useWide();
  const c = useTheme();
  const fastestColor = chart.bestIsEvent ? c.timing.best : c.timing.personal;
  return (
    <View>
      <View style={styles.legends}>
        {chart.codes.length > 0 && (
          <View style={styles.legendGroup}>
            <Label small muted>Section times</Label>
            <View style={styles.legendRow}>
              {chart.eventBest && <Swatch color={c.timing.best} label="Best of the event" />}
              <Swatch color={c.timing.personal} label="Best of this run" />
              <Swatch color={c.timing.slowerTint} outline={c.timing.slower} label="Slower" />
            </View>
          </View>
        )}
        <View style={styles.legendGroup}>
          <Label small muted>Lap</Label>
          <View style={styles.legendRow}>
            <StatusMark status="fastest" fastest={fastestColor} />
            <StatusMark status="clean" fastest={fastestColor} />
            <StatusMark status="out" fastest={fastestColor} label="Out / In" />
            <StatusMark status="pit" fastest={fastestColor} />
          </View>
        </View>
        {chart.tyres && (
          <View style={styles.legendGroup}>
            <Label small muted>Tyres · cold to hot</Label>
            <View style={styles.legendRow}>
              <View style={styles.scale}>
                {c.tyre.scale.map((s) => <View key={s} style={StyleSheet.flatten([styles.scaleStep, { backgroundColor: s }])} />)}
              </View>
              <Text style={styles.legendText}>
                Against the run&apos;s middle: {chart.mid.temperature_c != null ? `${Math.round(chart.mid.temperature_c)} °C` : '–'}
                {' · '}{chart.mid.pressure_bar != null ? `${chart.mid.pressure_bar.toFixed(2)} bar` : '–'}
              </Text>
            </View>
          </View>
        )}
      </View>

      {wide ? <ChartTable chart={chart} fastest={fastestColor} /> : <ChartBlocks chart={chart} fastest={fastestColor} />}

      <Text style={styles.chartNote}>
        Times in seconds.{chart.eventBest ? ` Purple: the quickest pass of the section in all ${runs} runs of the event;` : ''}
        {chart.eventBest ? ' green' : ' Green'}: the quickest in this run. Out, in and pit laps have no section times and stay
        out of the colours.{chart.tyres ? ' Pressures are hot and temperatures from the TPMS; each is coloured against the ' +
          'middle of the run’s clean laps, steps of 0.03 and 0.06 bar, 4 and 10 °C (no published window to compare with).'
          : ''}
      </Text>
    </View>
  );
}

/** A lap's status: Fastest and Pit as flat blocks, Clean underlined green, out and in laps underlined grey. */
function StatusMark({ status, fastest, label }: { status: Status; fastest: string; label?: string }) {
  const styles = useStyles();
  const c = useTheme();
  const name = label ?? STATUS_NAME[status];
  if (status === 'fastest') return <Block label={name} color={fastest} ink={c.timing.onBest} size={11} />;
  if (status === 'pit') return <Block label={name} color={c.rule} ink={c.background} size={11} />;
  return (
    <View style={StyleSheet.flatten([styles.st, { borderColor: status === 'clean' ? c.delta.gain : c.textMuted }])}>
      <Text style={StyleSheet.flatten([styles.stText, status !== 'clean' && { color: c.textSecondary }])}>{name}</Text>
    </View>
  );
}

/** A cell of the wide lap chart: a fixed width, the figure right-aligned, an optional flat colour behind it. */
function Cell({ w, children, bg, fg, bold, left, style, text }: {
  w: number;
  children?: ReactNode;
  bg?: string;
  fg?: string;
  bold?: boolean;
  left?: boolean;
  style?: ViewStyle;
  text?: TextStyle;
}) {
  const styles = useStyles();
  return (
    <View style={StyleSheet.flatten([styles.cell, { width: w }, left && styles.cellLeft, bg ? { backgroundColor: bg } : null, style])}>
      {typeof children === 'string' || typeof children === 'number' ? (
        <Text style={StyleSheet.flatten([styles.cellText, bold && styles.bold, text, fg ? { color: fg } : null])}>{children}</Text>
      ) : children}
    </View>
  );
}

function ChartTable({ chart, fastest }: { chart: Chart; fastest: string }) {
  const styles = useStyles();
  const c = useTheme();
  const n = chart.codes.length;
  const lapW = W.lap + W.stat + W.time + W.gap;
  const width = lapW + n * W.sec + (chart.tyres ? 2 * W.sp + 4 * W.p + 4 * W.t : 0);
  const stintAt = new Map(chart.stints.map((s) => [s.first, s]));
  const foot = (label: string, values: (number | null)[], color: string, first: boolean) => (
    <View style={StyleSheet.flatten([styles.tr, styles.foot, first && styles.footFirst])}>
      <View style={StyleSheet.flatten([styles.footLabel, { width: lapW }])}>
        <Text style={styles.footName}>{label}</Text>
        <Text style={styles.footTime}>{formatLap(sum(values))}</Text>
      </View>
      {values.map((v, i) => (
        <Cell key={i} w={W.sec} bg={v != null ? color : undefined} fg={c.timing.onBest} bold>{v != null ? v.toFixed(2) : '–'}</Cell>
      ))}
    </View>
  );
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator contentContainerStyle={styles.tableScroll}>
      <View style={{ width }}>
        <View style={styles.groupHead}>
          <Text style={StyleSheet.flatten([styles.groupText, { width: lapW }])}>Lap</Text>
          {n > 0 && <Text style={StyleSheet.flatten([styles.groupText, { width: n * W.sec }])}>Section times, s</Text>}
          {chart.tyres && (
            <>
              <View style={{ width: W.sp }} />
              <Text style={StyleSheet.flatten([styles.groupText, { width: 4 * W.p }])}>Hot pressure, bar</Text>
              <View style={{ width: W.sp }} />
              <Text style={StyleSheet.flatten([styles.groupText, { width: 4 * W.t }])}>TPMS, °C</Text>
            </>
          )}
        </View>
        <View style={styles.colHead}>
          <Cell w={W.lap} left text={styles.headLap}>#</Cell>
          <Cell w={W.stat} left text={styles.headText}>Status</Cell>
          <Cell w={W.time} text={styles.headText}>Time</Cell>
          <Cell w={W.gap} text={styles.headText}>Gap</Cell>
          {chart.codes.map((code) => <Cell key={code} w={W.sec} text={styles.headText}>{shortCode(code)}</Cell>)}
          {chart.tyres && (
            <>
              <View style={{ width: W.sp }} />
              {CORNER_NAMES.map((k) => <Cell key={`p${k}`} w={W.p} text={styles.headText}>{k}</Cell>)}
              <View style={{ width: W.sp }} />
              {CORNER_NAMES.map((k) => <Cell key={`t${k}`} w={W.t} text={styles.headText}>{k}</Cell>)}
            </>
          )}
        </View>
        {chart.laps.map((l) => {
          const s = stintAt.get(l.number);
          const off = !l.clean;
          const gap = l.clean && chart.best != null && l.time > chart.best ? `+${(l.time - chart.best).toFixed(2)}` : '';
          return (
            <Fragment key={l.number}>
              {s && <StintHead stint={s} wide />}
              <View style={StyleSheet.flatten([styles.tr, off && styles.off])}>
                <Cell w={W.lap} left text={StyleSheet.flatten([styles.lapNo, off && styles.offText])}>{l.number}</Cell>
                <Cell w={W.stat} left><StatusMark status={l.status} fastest={fastest} /></Cell>
                <Cell w={W.time} bg={l.status === 'fastest' ? fastest : undefined} fg={l.status === 'fastest' ? c.timing.onBest : undefined}
                  text={StyleSheet.flatten([styles.timeText, off && styles.offText])}>{formatLap(l.time)}</Cell>
                <Cell w={W.gap} text={styles.gapText}>{gap}</Cell>
                {l.sec.map((v, i) => {
                  const tone = secTone(c, chart, l, i);
                  return <Cell key={i} w={W.sec} bg={tone.bg} fg={tone.fg} bold={tone.bold}>{v != null ? v.toFixed(2) : ''}</Cell>;
                })}
                {chart.tyres && (
                  <>
                    <View style={{ width: W.sp }} />
                    {l.p.map((v, i) => {
                      const tone = tyreTone(c, chart, l, v, 'pressure_bar');
                      return <Cell key={`p${i}`} w={W.p} bg={tone.bg} fg={tone.fg ?? (off ? c.textMuted : undefined)}>{pText(v)}</Cell>;
                    })}
                    <View style={{ width: W.sp }} />
                    {l.t.map((v, i) => {
                      const tone = tyreTone(c, chart, l, v, 'temperature_c');
                      return <Cell key={`t${i}`} w={W.t} bg={tone.bg} fg={tone.fg ?? (off ? c.textMuted : undefined)}>{tText(v)}</Cell>;
                    })}
                  </>
                )}
              </View>
            </Fragment>
          );
        })}
        {n > 0 && foot('Best of this run', chart.runBest, c.timing.personal, true)}
        {n > 0 && chart.eventBest && foot('Best of the event', chart.eventBest, c.timing.best, false)}
      </View>
    </ScrollView>
  );
}

function StintHead({ stint: s, wide }: { stint: ChartStint; wide?: boolean }) {
  const styles = useStyles();
  return (
    <View style={styles.stint}>
      <View style={styles.stintLine}>
        <Text style={styles.stintName}>Stint {s.number}</Text>
        <Label small muted>
          {s.first === s.last ? `Lap ${s.first}` : `Laps ${s.first}–${s.last}`}
          {s.flying ? ` · ${s.flying} flying` : ''}
        </Label>
      </View>
      {wide && s.words && s.flying > 0 ? <Text style={styles.stintWords}>{s.words}</Text> : null}
    </View>
  );
}

// the phone's strips: ten sections a line at most
const lines = (n: number) => {
  const rows = Math.max(1, Math.ceil(n / 10));
  const per = Math.ceil(n / rows);
  return Array.from({ length: rows }, (_, r) => Array.from({ length: Math.min(per, n - r * per) }, (_, k) => r * per + k));
};

function ChartBlocks({ chart, fastest }: { chart: Chart; fastest: string }) {
  const styles = useStyles();
  const c = useTheme();
  const gutter = useGutter();
  const strips = lines(chart.codes.length);
  const stintAt = new Map(chart.stints.map((s) => [s.first, s]));
  const tyreRow = (l: ChartLap | null, m: TyreMeasure) => (
    <View style={styles.tg}>
      <Text style={styles.tk}>{m === 'pressure_bar' ? 'BAR' : '°C'}</Text>
      {CORNERS.map((k, i) => {
        if (!l) return <Text key={k} style={styles.tHead}>{CORNER_NAMES[i]}</Text>;
        const v = (m === 'pressure_bar' ? l.p : l.t)[i];
        const tone = tyreTone(c, chart, l, v, m);
        return (
          <View key={k} style={StyleSheet.flatten([styles.tCell, tone.bg ? { backgroundColor: tone.bg } : null])}>
            <Text style={StyleSheet.flatten([styles.tText, tone.fg ? { color: tone.fg } : null, !l.clean && styles.offText])}>
              {m === 'pressure_bar' ? pText(v) : tText(v)}
            </Text>
          </View>
        );
      })}
    </View>
  );
  const strip = (cells: (i: number) => ReactNode) => strips.map((idx, r) => (
    <View key={r} style={styles.strip}>{idx.map((i) => <Fragment key={i}>{cells(i)}</Fragment>)}</View>
  ));
  const footBlock = (label: string, values: (number | null)[], color: string) => (
    <View style={styles.pFoot}>
      <View style={styles.pTop}>
        <Label>{label}</Label>
        <Text style={StyleSheet.flatten([styles.pTime, styles.pushRight])}>{formatLap(sum(values))}</Text>
      </View>
      {strip((i) => (
        <View style={StyleSheet.flatten([styles.sCell, values[i] != null ? { backgroundColor: color } : null])}>
          <Text style={StyleSheet.flatten([styles.sText, styles.bold, { color: c.timing.onBest }])}>
            {values[i] != null ? values[i]!.toFixed(2) : '–'}
          </Text>
        </View>
      ))}
    </View>
  );
  return (
    <View>
      <View style={styles.keyHead}>
        {chart.codes.length > 0 && strip((i) => <Text style={styles.sName}>{shortCode(chart.codes[i])}</Text>)}
        {chart.tyres && (
          <View style={styles.tyreHead}>
            {tyreRow(null, 'pressure_bar')}
            {tyreRow(null, 'temperature_c')}
          </View>
        )}
      </View>
      {chart.laps.map((l) => {
        const s = stintAt.get(l.number);
        const off = !l.clean;
        const gap = l.clean && chart.best != null && l.time > chart.best ? `+${(l.time - chart.best).toFixed(2)}` : '';
        return (
          <Fragment key={l.number}>
            {s && <StintHead stint={s} />}
            <View style={StyleSheet.flatten([styles.pLap, off && styles.off, off && { marginHorizontal: -gutter, paddingHorizontal: gutter }])}>
              <View style={styles.pTop}>
                <Text style={StyleSheet.flatten([styles.pNo, off && styles.offText])}>{l.number}</Text>
                <View style={l.status === 'fastest' ? { backgroundColor: fastest } : undefined}>
                  <Text style={StyleSheet.flatten([styles.pTime, l.status === 'fastest' && { color: c.timing.onBest },
                    off && styles.offText])}>
                    {formatLap(l.time)}
                  </Text>
                </View>
                <Text style={styles.gapText}>{gap}</Text>
                <View style={styles.pushRight}><StatusMark status={l.status} fastest={fastest} /></View>
              </View>
              {l.clean && chart.codes.length > 0 && strip((i) => {
                const tone = secTone(c, chart, l, i);
                return (
                  <View style={StyleSheet.flatten([styles.sCell, tone.bg ? { backgroundColor: tone.bg } : null])}>
                    <Text style={StyleSheet.flatten([styles.sText, tone.bold && styles.bold, tone.fg ? { color: tone.fg } : null])}>
                      {l.sec[i] != null ? l.sec[i]!.toFixed(2) : '–'}
                    </Text>
                  </View>
                );
              })}
              {chart.tyres && (
                <View style={styles.tyreHead}>
                  {tyreRow(l, 'pressure_bar')}
                  {tyreRow(l, 'temperature_c')}
                </View>
              )}
            </View>
          </Fragment>
        );
      })}
      {chart.codes.length > 0 && (
        <View style={styles.pFootRule}>
          {footBlock('Best of this run', chart.runBest, c.timing.personal)}
          {chart.eventBest && footBlock('Best of the event · ideal', chart.eventBest, c.timing.best)}
        </View>
      )}
    </View>
  );
}

// ---------- corner by corner ----------

function Corners({ analysis }: { analysis: Analysis }) {
  const styles = useStyles();
  const ref = String(analysis.reference_lap);
  const head = ['Section', 'Apex', `Lap ${analysis.reference_lap}`, 'Best', 'Brake', 'Min speed', 'Full throttle'];
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.tableScroll}>
      <View style={styles.cornerTable}>
        <View style={styles.thRow}>
          {head.map((h, i) => (
            <Text key={h} style={StyleSheet.flatten([styles.th, i === 0 && styles.firstCol])}>{h}</Text>
          ))}
        </View>
        {analysis.corners.map((cn) => {
          const r = cn.laps[ref];
          const top = cn.laps[String(cn.best_lap)];
          return (
            <View key={cn.code} style={styles.trRow}>
              <Text style={StyleSheet.flatten([styles.td, styles.firstCol, styles.code])}>{cn.code}</Text>
              <Text style={styles.td}>{Math.round(cn.apex_m)} m</Text>
              <Text style={styles.td}>{r ? `${r.time.toFixed(2)} s` : '–'}</Text>
              <Text style={styles.td}>{top ? `${top.time.toFixed(2)} s · L${cn.best_lap}` : '–'}</Text>
              <Text style={styles.td}>{r?.brake_point != null ? `${r.brake_point} m` : '–'}</Text>
              <Text style={styles.td}>{r ? `${r.min_speed.toFixed(1)} km/h` : '–'}</Text>
              <Text style={styles.td}>{r?.full_throttle != null ? `${r.full_throttle} m` : '–'}</Text>
            </View>
          );
        })}
        <Text style={styles.chartNote}>
          Apex, brake point and full throttle in metres from the line, on lap {analysis.reference_lap}.
        </Text>
      </View>
    </ScrollView>
  );
}

const useStyles = themed((c) => ({
  body: { backgroundColor: 'transparent' },
  stale: { opacity: 0.45, pointerEvents: 'none' },
  loading: { alignSelf: 'flex-start', marginVertical: 16 },
  error: { color: c.error, marginTop: 12 },
  note: { fontFamily: Fonts.body, fontSize: 15, lineHeight: 21, color: c.textSecondary, marginTop: 12 },
  bold: { fontFamily: face700() },
  runLine: { paddingTop: 12, paddingBottom: 12, borderBottomWidth: 1, borderColor: c.separator },
  actions: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: 22, rowGap: 12, paddingTop: 14,
    paddingBottom: 4 },
  upload: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  stack: { gap: 24 },
  subhead: { ...Type.label, fontSize: 13, color: c.text, borderTopWidth: 3, borderColor: c.rule, paddingTop: 6 },

  // 01 the run
  figs: { flexDirection: 'row', borderTopWidth: 1, borderColor: c.rule },
  figsPhone: { flexDirection: 'row', flexWrap: 'wrap', borderTopWidth: 1, borderColor: c.rule },
  figCell: { flex: 1, minWidth: 0, paddingTop: 12, paddingHorizontal: 18 },
  figNext: { borderLeftWidth: 1, borderColor: c.rule },
  figCellPhone: { width: '50%', paddingTop: 10, paddingBottom: 12, paddingRight: 12 },
  figNextPhone: { paddingLeft: 12, paddingRight: 0, borderLeftWidth: 1, borderColor: c.rule },
  figLowerPhone: { borderTopWidth: 1, borderColor: c.rule },

  // legends
  legends: { flexDirection: 'row', flexWrap: 'wrap', columnGap: 34, rowGap: 14, paddingVertical: 12, borderTopWidth: 1,
    borderBottomWidth: 1, borderColor: c.rule, marginBottom: 18 },
  legendGroup: { gap: 6, flexShrink: 1, maxWidth: '100%' },
  legendRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: 14, rowGap: 6 },
  legendText: { ...Type.label, fontFamily: Fonts.label, fontSize: 12, letterSpacing: 0.7, color: c.text, flexShrink: 1 },
  scale: { flexDirection: 'row', gap: 2 },
  scaleStep: { width: 26, height: 14 },
  st: { borderBottomWidth: 3, paddingTop: 2, paddingBottom: 1 },
  stText: { ...Type.label, fontSize: 11, letterSpacing: 1.1, color: c.text },
  chartNote: { fontFamily: Type.dek.fontFamily, fontSize: 15, lineHeight: 21, color: c.textSecondary, marginTop: 14,
    maxWidth: 760 },

  // the wide lap chart
  tableScroll: { flexGrow: 1 },
  groupHead: { flexDirection: 'row', borderBottomWidth: 3, borderColor: c.rule, paddingBottom: 5 },
  groupText: { ...Type.label, fontSize: 11, letterSpacing: 1.1, color: c.text },
  colHead: { flexDirection: 'row', borderBottomWidth: 1, borderColor: c.rule, paddingTop: 6, paddingBottom: 5 },
  headText: { fontFamily: Fonts.display, fontSize: 14, lineHeight: 17, letterSpacing: 0.2, color: c.text },
  headLap: { fontFamily: Fonts.display, fontSize: 14, lineHeight: 17, color: c.text },
  tr: { flexDirection: 'row', height: W.row, borderBottomWidth: 1, borderColor: c.separator },
  off: { backgroundColor: c.band },
  offText: { color: c.textMuted },
  cell: { height: '100%', justifyContent: 'center', alignItems: 'flex-end', paddingHorizontal: 5, borderRightWidth: 2,
    borderColor: 'transparent' },
  cellLeft: { alignItems: 'flex-start', paddingLeft: 0 },
  cellText: { ...Type.number, fontFamily: face500(), fontSize: 14, color: c.text },
  lapNo: { fontFamily: Fonts.display, fontSize: 20, lineHeight: 24, color: c.text },
  timeText: { ...Type.number, fontFamily: face700(), fontSize: 16, color: c.text },
  gapText: { ...Type.number, fontFamily: face600(), fontSize: 13, color: c.delta.loss },
  foot: { alignItems: 'stretch' },
  footFirst: { borderTopWidth: 3, borderTopColor: c.rule },
  footLabel: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingRight: 5 },
  footName: { ...Type.label, fontSize: 12, color: c.text },
  footTime: { fontFamily: Fonts.display, fontSize: 20, lineHeight: 24, color: c.text },
  stint: { paddingTop: 14, paddingBottom: 6, borderBottomWidth: 3, borderColor: c.rule, gap: 3 },
  stintLine: { flexDirection: 'row', alignItems: 'baseline', gap: 12 },
  stintName: { fontFamily: Fonts.display, fontSize: 22, lineHeight: 24, textTransform: 'uppercase', color: c.text },
  stintWords: { fontFamily: Type.dek.fontFamily, fontSize: 14, lineHeight: 19, color: c.textSecondary },

  // the phone's lap chart
  keyHead: { borderTopWidth: 3, borderBottomWidth: 1, borderColor: c.rule, paddingVertical: 6, gap: 2 },
  strip: { flexDirection: 'row', gap: 2, marginTop: 2 },
  sName: { flex: 1, minWidth: 0, textAlign: 'center', fontFamily: Fonts.display, fontSize: 11, lineHeight: 16, color: c.text },
  sCell: { flex: 1, minWidth: 0, height: 22, alignItems: 'center', justifyContent: 'center' },
  sText: { ...Type.number, fontFamily: face600(), fontSize: 11.5, color: c.text },
  tyreHead: { flexDirection: 'row', gap: 10, marginTop: 4 },
  tg: { flex: 1, flexDirection: 'row', gap: 2, alignItems: 'center' },
  tk: { width: 26, ...Type.label, fontSize: 10, letterSpacing: 0.6, color: c.text },
  tHead: { flex: 1, textAlign: 'center', fontFamily: Fonts.display, fontSize: 11, lineHeight: 14, color: c.text },
  tCell: { flex: 1, minWidth: 0, height: 20, alignItems: 'center', justifyContent: 'center' },
  tText: { ...Type.number, fontFamily: face600(), fontSize: 12, color: c.text },
  pLap: { paddingVertical: 9, borderBottomWidth: 1, borderColor: c.separator },
  pTop: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 6 },
  pNo: { width: 34, fontFamily: Fonts.display, fontSize: 24, lineHeight: 26, color: c.text },
  pTime: { ...Type.number, fontFamily: face700(), fontSize: 19, paddingHorizontal: 4, paddingVertical: 1, color: c.text },
  pushRight: { marginLeft: 'auto' },
  pFootRule: { borderTopWidth: 3, borderColor: c.rule, marginTop: 12 },
  pFoot: { paddingVertical: 8, borderBottomWidth: 1, borderColor: c.separator },

  // corner by corner
  cornerTable: { flex: 1, minWidth: 600 },
  thRow: { flexDirection: 'row', gap: 8, paddingBottom: 5, borderBottomWidth: 1, borderColor: c.rule },
  trRow: { flexDirection: 'row', gap: 8, paddingVertical: 7, borderBottomWidth: 1, borderColor: c.separator },
  th: { ...Type.label, flex: 1, fontSize: 11, color: c.textSecondary, textAlign: 'right' },
  td: { ...Type.number, flex: 1, fontSize: 14, color: c.text, textAlign: 'right' },
  firstCol: { flex: 0.8, textAlign: 'left' },
  code: { fontFamily: Fonts.display, fontSize: 17, lineHeight: 20 },

  // debriefs
  debrief: { paddingVertical: 9, borderBottomWidth: 1, borderColor: c.separator, gap: 2 },
  debriefTitle: { fontFamily: face700(), fontSize: 15, letterSpacing: 0.3, color: c.text },
  debriefText: { fontFamily: Fonts.body, fontSize: 15, lineHeight: 21, color: c.textSecondary },
}));

function face700() {
  return Type.label.fontFamily as string;
}
function face600() {
  return face('label', 600);
}
function face500() {
  return face('label', 500);
}
