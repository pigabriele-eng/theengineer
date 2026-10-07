// A race weekend while it is on (Gabriele, 2026-10-07: "during the race weekend the effort shifts to data
// comparison"): the answers first, then the runs. Three things for each driver's next run, each official session's
// report (FP1, Q1, R1), the latest run against the event's best (where the time is, the traces), the debriefs of every run with a big button to record one for the
// latest, and setup changes to try for it. Then the event page's own sections (its runs by day, side by side, what it
// was run with, its results, a run to add), passed in as children.
import { Href, Link, useFocusEffect, useRouter } from 'expo-router';
import { ReactNode, RefObject, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, View as Box, StyleSheet } from 'react-native';

import { TopThings } from '@/components/Coaching';
import { CompareTraces, LineKey, useLapColors, WhereTheTimeIs } from '@/components/CompareViews';
import { ErrorLine, MainButton, Note } from '@/components/Controls';
import { Fig, Label, Section, TextLink, useWide } from '@/components/Programme';
import { IdeasView } from '@/components/SetupIdeas';
import SessionReports from '@/components/weekend/SessionReports';
import { Text, View } from '@/components/Themed';
import { CompareResult, compareLaps, encodePicks, formatLap, signedSeconds } from '@/lib/compare';
import { dayLabel, eventsApi, Folder } from '@/lib/events';
import { afterOthers } from '@/lib/loadLast';
import { fetchEventDebriefs } from '@/lib/weekend';
import {
  debriefLines, DebriefLine, EventDebrief, LapRef, latestAgainstBest, latestByDriver, latestRun,
} from '@/lib/weekendRuns';
import { face, Fonts, themed, Type, useTheme } from '@/constants/Theme';

const POLL_MS = 5000; // a debrief being transcribed is looked at again this often

/** The During view of a race weekend. `folder`: the event as its page already has it (else it is read here);
 * `children`: the page's own sections, numbered on from duringSections(folder) (lib/weekendRuns.ts). */
export default function WeekendDuring({ eventId, folder: given, children }: {
  eventId: number;
  folder?: Folder | null;
  children?: ReactNode;
}) {
  const [own, setOwn] = useState<Folder | null>(null);
  useEffect(() => {
    if (given === undefined) eventsApi.folder(String(eventId)).then(setOwn, () => {});
  }, [eventId, given]);
  const folder = given ?? own;

  const styles = useStyles();
  const drivers = useMemo(() => latestByDriver(folder), [folder]);
  const pair = useMemo(() => latestAgainstBest(folder), [folder]);
  const latest = useMemo(() => latestRun(folder), [folder]);
  // 1 three things, 2 the session reports, 3 the latest run against the best (4 where the time is, 5 the traces),
  // then debriefs and setup (lib/weekendRuns.ts duringSections)
  const debriefsNo = pair ? 6 : 4;
  return (
    <>
      <Section no={1} title="Three things for next run"
        dek="For each driver’s latest run: the costliest mistakes that repeat, each at a different corner, what to do instead and what it is worth a lap.">
        <ThreeThings eventId={eventId} drivers={drivers} />
      </Section>
      <Section no={2} title="Session reports"
        dek="One report per session of the weekend (FP1, Q1, the races), from every run of it.">
        <SessionReports eventId={eventId} />
      </Section>
      <LatestAgainstBest no={3} pair={pair} />
      <Debriefs no={debriefsNo} eventId={eventId} folder={folder} />
      <Section no={debriefsNo + 1} title="Setup suggestions"
        dek={latest ? `For ${latest.name}: changes to try, from what the driver said and what the data show.` : undefined}>
        {latest ? (
          <>
            <IdeasView parts sessionId={latest.id} vehicleId={null} />
            <View style={styles.links}>
              <TextLink href={{ pathname: '/tools/setup', params: { session: latest.id, tab: 'ideas' } }}
                label="Open the setup page" arrow />
            </View>
          </>
        ) : <Note>No run yet: upload the first run’s log, or add a run by hand to record its debrief.</Note>}
      </Section>
      {children}
    </>
  );
}

// ---------- three things ----------

function ThreeThings({ eventId, drivers }: { eventId: number; drivers: ReturnType<typeof latestByDriver> }) {
  const styles = useStyles();
  return (
    <>
      {drivers.length === 0 && <Note>No timed run yet: the three things come with the first run’s laps.</Note>}
      {drivers.map(({ driver, run }) => (
        <View key={run.id} style={styles.driver}>
          <View style={styles.driverHead}>
            <Text style={styles.driverName} accessibilityRole="header">{driver ?? 'Driver not set'}</Text>
            <TextLink href={{ pathname: '/session/[id]', params: { id: run.id } }} label={run.name} arrow small />
          </View>
          <TopThings sessionId={run.id} />
        </View>
      ))}
      <View style={styles.links}>
        <TextLink href={{ pathname: '/technique', params: { event: eventId } }} label="Technique check, every corner" arrow />
      </View>
    </>
  );
}

// ---------- the latest run against the best ----------

/** True once the section is near the screen (on the web), or once the page's other reads have answered: the heavy
 * read it needs then loads last, and doesn't hold up the answers above it on the server. Stays true. */
function useLoadLast(ref: RefObject<Box | null>, on: boolean) {
  const [go, setGo] = useState(false);
  useEffect(() => {
    if (!on || go) return;
    const stop = afterOthers(() => setGo(true));
    const node = ref.current as unknown;
    let seen: IntersectionObserver | undefined;
    if (typeof IntersectionObserver !== 'undefined' && typeof Element !== 'undefined' && node instanceof Element) {
      seen = new IntersectionObserver((es) => es.some((e) => e.isIntersecting) && setGo(true),
        { rootMargin: '0px 0px 200px 0px' });
      seen.observe(node);
    }
    return () => {
      stop();
      seen?.disconnect();
    };
  }, [on, go]); // eslint-disable-line react-hooks/exhaustive-deps -- the ref is the section's, for good
  return go;
}

/** The latest run's best lap against the event's best: who, the gap, then where the time is and the traces (one
 * request, nothing to pick, made last: useLoadLast), and the full comparison one tap away. Sections `no` to
 * `no + 2`. */
function LatestAgainstBest({ no, pair }: { no: number; pair: ReturnType<typeof latestAgainstBest> }) {
  const styles = useStyles();
  const wide = useWide();
  const colors = useLapColors([0, 1]);
  const at = useRef<Box>(null); // where the sections start: on the web, a DOM element to watch come into view
  const [data, setData] = useState<CompareResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [focus, setFocus] = useState(0);
  const [zoom, setZoom] = useState<string | null>(null);
  const [cursor, setCursor] = useState<number | null>(null);
  const laps = pair ? [pair.latest, pair.best].map(({ session_id, lap }) => ({ session_id, lap })) : [];
  const key = encodePicks(laps);
  const go = useLoadLast(at, key !== '');
  useEffect(() => {
    if (!key || !go) return;
    let live = true;
    setData(null);
    setError(null);
    setFocus(0);
    setZoom(null);
    setCursor(null);
    compareLaps(laps).then((d) => live && setData(d), (e) => live && setError((e as Error).message));
    return () => {
      live = false;
    };
  }, [key, go]); // eslint-disable-line react-hooks/exhaustive-deps -- the laps, by value
  const step = data?.traces.step_m ?? 5;
  const show = useCallback((code: string | null, at?: number) => {
    setZoom(code);
    setCursor(at != null ? Math.round(at / step) : null);
  }, [step]);

  if (!pair) {
    return (
      <Section no={no} title="Latest run against the best">
        <Note>Two timed runs are needed: the latest run’s best lap is put against the event’s best.</Note>
      </Section>
    );
  }
  const gap = pair.latest.time - pair.best.time;
  const waiting = error ? <ErrorLine>{`Can’t compare the two laps: ${error}`}</ErrorLine>
    : <View style={styles.working}><ActivityIndicator /><Note>Placing the two laps on one line…</Note></View>;
  return (
    <Box ref={at}>
      <Section no={no} title="Latest run against the best"
        dek={pair.holdsBest ? 'The latest run holds the event’s best lap: here against the best of the other runs.'
          : 'The latest run’s best lap against the event’s best lap.'}>
        <View style={wide ? styles.vs : styles.vsPhone}>
          <View style={styles.vsLaps}>
            <LapLine color={colors.laps[0]} label="Latest run" lap={pair.latest} />
            <LapLine color={colors.laps[1]} label={pair.holdsBest ? 'Next best' : 'Event’s best'} lap={pair.best} />
          </View>
          <Fig label={pair.holdsBest ? 'Ahead by' : 'Gap'} value={signedSeconds(gap)} unit="s" size={wide ? 64 : 52}
            style={wide ? styles.vsFig : styles.vsFigPhone} />
        </View>
        <View style={styles.links}>
          <TextLink href={{ pathname: '/compare', params: { laps: encodePicks([pair.latest, pair.best]) } }}
            label="Open the full comparison" arrow red />
        </View>
      </Section>
      {data ? (
        <>
          <WhereTheTimeIs no={no + 1} data={data} colors={colors} focus={focus} onFocus={setFocus} onShow={show} />
          <CompareTraces no={no + 2} data={data} colors={colors} ideal={false} zoom={zoom} onZoom={setZoom}
            cursor={cursor} onCursor={setCursor} />
        </>
      ) : (
        <>
          <Section no={no + 1} title="Where the time is">{waiting}</Section>
          <Section no={no + 2} title="Traces">{waiting}</Section>
        </>
      )}
    </Box>
  );
}

function LapLine({ color, label, lap }: { color: string; label: string; lap: LapRef }) {
  const styles = useStyles();
  return (
    <View style={styles.lapLine}>
      <LineKey color={color} />
      <View style={styles.grow}>
        <Label>{label}</Label>
        <Text style={styles.lapName} numberOfLines={2}>
          {`${lap.name} · lap ${lap.lap}${lap.driver ? ` · ${lap.driver}` : ''}`}
        </Text>
      </View>
      <Text style={styles.lapTime}>{formatLap(lap.time)}</Text>
    </View>
  );
}

// ---------- debriefs ----------

const STATE: Record<DebriefLine['state'], string> = {
  ready: 'Transcript ready',
  recorded: 'Recorded',
  failed: 'Recorded · not transcribed',
  none: 'Not yet',
};

/** One line per run, the latest first, each to its debrief (or to record one), and a big button to record the latest
 * run's. Read again on coming back to the page, and every few seconds while one is being transcribed. */
function Debriefs({ no, eventId, folder }: { no: number; eventId: number; folder: Folder | null }) {
  const styles = useStyles();
  const router = useRouter();
  const [debriefs, setDebriefs] = useState<EventDebrief[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const live = useRef(true);
  const load = useCallback(() => {
    fetchEventDebriefs(eventId).then((d) => {
      if (!live.current) return;
      setDebriefs(d);
      setError(null);
    }, (e) => live.current && setError((e as Error).message));
  }, [eventId]);
  useFocusEffect(useCallback(() => {
    live.current = true;
    load();
    return () => {
      live.current = false;
    };
  }, [load]));
  const working = debriefs?.some((d) => d.state === 'recorded') ?? false;
  useEffect(() => {
    if (!working) return;
    const t = setInterval(load, POLL_MS);
    return () => clearInterval(t);
  }, [working, load]);

  const latest = latestRun(folder);
  const lines = debriefLines(folder, debriefs ?? []);
  return (
    <Section no={no} title="Debriefs"
      dek="What the driver says after each run, transcribed and kept for the engineer. Record it as soon as the run ends; the log can come later.">
      {latest && (
        <MainButton label={`Record debrief for ${latest.name}`} style={styles.record}
          onPress={() => router.push({ pathname: '/debrief', params: { session: latest.id } })} />
      )}
      {error && <ErrorLine>{`Can’t read the debriefs: ${error}`}</ErrorLine>}
      {!debriefs && !error && lines.length > 0 && <ActivityIndicator style={styles.left} />}
      <View style={styles.list}>
        {debriefs && lines.map((l) => <DebriefRow key={l.run.id} line={l} />)}
      </View>
      {lines.length === 0 && <Note>No run yet: add a run by hand at the end of the page to record its debrief.</Note>}
    </Section>
  );
}

export function DebriefRow({ line }: { line: DebriefLine }) {
  const styles = useStyles();
  const c = useTheme();
  const { run, state, debrief, count } = line;
  const href: Href = debrief != null ? { pathname: '/debrief/[id]', params: { id: debrief } }
    : { pathname: '/debrief', params: { session: run.id } };
  const when = [run.date ? dayLabel(run.date) : null, run.time].filter(Boolean).join(' ');
  const sub = [run.driver ?? 'Driver not set', when || null, count > 1 ? `${count} debriefs` : null].filter(Boolean).join(' · ');
  const tone = state === 'ready' ? c.success : state === 'none' ? c.textSecondary : c.warning;
  return (
    // Link asChild hands its child's style to a web anchor, which can't take a style array: one object
    <Link href={href} asChild>
      <Pressable accessibilityRole="link" style={styles.row}
        accessibilityLabel={`${run.name}, ${sub}: ${STATE[state]}. ${debrief != null ? 'Open the debrief' : 'Record a debrief'}`}>
        <View style={styles.grow}>
          <Text style={styles.rowName} numberOfLines={1}>{run.name}</Text>
          <Text style={styles.rowSub} numberOfLines={2}>{sub}</Text>
        </View>
        <View style={styles.rowState}>
          <Text style={StyleSheet.flatten([styles.state, { color: tone }])}>{STATE[state]}</Text>
          <Text style={styles.rowGo}>{debrief != null ? 'Read →' : 'Record →'}</Text>
        </View>
      </Pressable>
    </Link>
  );
}

const useStyles = themed((c) => ({
  grow: { flex: 1, minWidth: 0 },
  left: { alignSelf: 'flex-start', marginTop: 12 },
  links: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: 22, rowGap: 12, marginTop: 20 },
  working: { flexDirection: 'row', alignItems: 'center', gap: 10 },

  // three things
  driver: { marginBottom: 26 },
  driverHead: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'baseline', columnGap: 16, rowGap: 6,
    borderBottomWidth: 3, borderColor: c.rule, paddingBottom: 6, marginBottom: 10 },
  driverName: { fontFamily: Fonts.display, fontSize: 28, lineHeight: 32, textTransform: 'uppercase', color: c.text },

  // the latest run against the best
  vs: { flexDirection: 'row', alignItems: 'flex-end', gap: 32 },
  vsPhone: { gap: 16 },
  vsLaps: { flex: 1, minWidth: 0, maxWidth: 640 },
  vsFig: { paddingLeft: 28, borderLeftWidth: 1, borderColor: c.rule },
  vsFigPhone: { borderTopWidth: 1, borderColor: c.rule, paddingTop: 10 },
  lapLine: { flexDirection: 'row', alignItems: 'center', gap: 12, borderBottomWidth: 1, borderColor: c.separator,
    paddingVertical: 10 },
  lapName: { fontFamily: face('body', 600), fontSize: 17, lineHeight: 22, color: c.text, marginTop: 2 },
  lapTime: { ...Type.number, fontFamily: face('label', 700), fontSize: 20, color: c.text },

  // debriefs
  record: { alignSelf: 'flex-start', marginBottom: 18 },
  list: { borderTopWidth: 1, borderColor: c.rule, maxWidth: 820 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 14, minHeight: 56, paddingVertical: 10,
    borderBottomWidth: 1, borderColor: c.separator },
  rowName: { fontFamily: Type.label.fontFamily, fontSize: 18, letterSpacing: 0.3, color: c.text },
  rowSub: { fontFamily: face('label', 400), fontSize: 15, lineHeight: 20, color: c.textSecondary, marginTop: 2 },
  rowState: { alignItems: 'flex-end', gap: 2 },
  state: { ...Type.label, fontSize: 14, letterSpacing: 1.1 },
  rowGo: { ...Type.link, fontSize: 14, color: c.text },
}));
