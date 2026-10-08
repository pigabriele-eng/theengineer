// A race weekend while it is on (Gabriele, 2026-10-07: "during the race weekend the effort shifts to data
// comparison"): the answers first, then the runs. Three things for each driver's next run, each official session's
// report (FP1, Q1, R1), the fastest runs of the latest session against each other (where the time is, the traces), the debriefs of every
// run with a big button to record one for the latest. Setup suggestions live in the setup tool, on demand. Then the
// event page's own sections (its runs by day, side by side, what it was run with, its results, a run to add), passed in
// as children.
import { Href, Link, useFocusEffect, useRouter } from 'expo-router';
import { ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet } from 'react-native';

import { TopThings } from '@/components/Coaching';
import { ErrorLine, MainButton, Note } from '@/components/Controls';
import { Section, TextLink } from '@/components/Programme';
import FastestRuns from '@/components/weekend/FastestRuns';
import SessionReports from '@/components/weekend/SessionReports';
import { Text, View } from '@/components/Themed';
import { dayLabel, eventsApi, Folder } from '@/lib/events';
import { poll } from '@/lib/poll';
import { fetchEventDebriefs } from '@/lib/weekend';
import {
  debriefLines, DebriefLine, EventDebrief, latestAgainstBest, latestByDriver, latestRun,
} from '@/lib/weekendRuns';
import { face, Fonts, themed, Type, useTheme } from '@/constants/Theme';

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
  // 1 three things, 2 the fastest runs of the latest session against each other (3 where the time is, 4 the traces;
  // with two timed runs: latestAgainstBest says whether there are), then the session reports
  // just above the debriefs (Gabriele, 2026-10-08: the comparison before the session reports, the session reports moved
  // down before the debriefs; setup suggestions off the reporting pages, separate and on demand; lib/weekendRuns.ts
  // duringSections)
  const reportsNo = pair ? 5 : 3;
  const debriefsNo = reportsNo + 1;
  return (
    <>
      <Section no={1} title="Three things for next run"
        dek="For each driver’s latest run: the costliest mistakes that repeat, each at a different corner, what to do instead and what it is worth a lap.">
        <ThreeThings eventId={eventId} drivers={drivers} />
      </Section>
      <FastestRuns no={2} eventId={eventId} folder={folder} />
      <Section no={reportsNo} title="Session reports"
        dek="One report per session of the weekend (FP1, Q1, the races), from every run of it.">
        <SessionReports eventId={eventId} />
      </Section>
      <Debriefs no={debriefsNo} eventId={eventId} folder={folder} />
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

// ---------- debriefs ----------

const STATE: Record<DebriefLine['state'], string> = {
  ready: 'Transcript ready',
  recorded: 'Recorded',
  failed: 'Recorded · not transcribed',
  none: 'Not yet',
};

/** One line per run, the latest first, each to its debrief (or to record one), and a big button to record the latest
 * run's. Read again on coming back to the page, and while one is being transcribed (less and less often). */
function Debriefs({ no, eventId, folder }: { no: number; eventId: number; folder: Folder | null }) {
  const styles = useStyles();
  const router = useRouter();
  const [debriefs, setDebriefs] = useState<EventDebrief[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const stopPoll = useRef<(() => void) | null>(null);
  // read again while one is being transcribed (lib/poll.ts: less and less often, not while the page is hidden)
  const load = useCallback(() => {
    stopPoll.current?.();
    let working = false; // the last answer had one being transcribed
    stopPoll.current = poll((wanted) => fetchEventDebriefs(eventId).then((d) => {
      if (!wanted()) return false;
      setDebriefs(d);
      setError(null);
      working = d.some((x) => x.state === 'recorded');
      return working;
    }, (e) => {
      if (wanted()) setError((e as Error).message);
      return working;
    }));
  }, [eventId]);
  useFocusEffect(useCallback(() => {
    load();
    return () => {
      stopPoll.current?.();
      stopPoll.current = null;
    };
  }, [load]));

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
      {lines.length === 0 && <Note>No run yet: upload the first run’s log on the Upload page, then record its debrief.</Note>}
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
