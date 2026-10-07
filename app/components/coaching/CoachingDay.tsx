// A coaching day (an event in coaching mode: lib/eventModes.ts), the answers first (Gabriele, 2026-10-07: coaching
// clients is "completely different" from a race weekend: "the gaps are big and the mistakes very obvious", so say
// concisely what to improve). For each driver's latest run: the three things to improve and whether the previous
// run's three were fixed (components/Coaching.tsx), then where their best lap loses time to the day's quickest lap,
// corner by corner with the technique graphs (components/coaching/CornerLoss.tsx), then the debriefs, folded. The
// event page's own sections (its runs by day, side by side, ...) follow as children. No setup section: on a coaching
// day the car is left alone unless it is unsafe.
import { useFocusEffect } from 'expo-router';
import { ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator } from 'react-native';

import { CornerByCorner } from '@/components/coaching/CornerLoss';
import { DidWeFix, TopThings } from '@/components/Coaching';
import { ErrorLine, Note } from '@/components/Controls';
import { FoldHead } from '@/components/Fold';
import { Section, TextLink } from '@/components/Programme';
import { Text, View } from '@/components/Themed';
import { DebriefRow } from '@/components/weekend/During';
import { formatLap } from '@/lib/api';
import { referenceLap } from '@/lib/coachingDay';
import { eventsApi, Folder, FolderSession } from '@/lib/events';
import { fetchEventDebriefs } from '@/lib/weekend';
import { debriefLines, EventDebrief, latestByDriver, latestRun } from '@/lib/weekendRuns';
import { Fonts, themed } from '@/constants/Theme';

const NOBODY = 'Driver not set';

/** The coaching day of one event. `folder`: the event as its page already has it (else it is read here);
 * `children`: the page's own sections, numbered on from COACHING_SECTIONS (lib/coachingDay.ts). */
export default function CoachingDay({ eventId, folder: given, children }: {
  eventId: number;
  folder?: Folder | null;
  children?: ReactNode;
}) {
  const [own, setOwn] = useState<Folder | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (given !== undefined) return;
    let live = true;
    eventsApi.folder(String(eventId)).then((f) => live && setOwn(f), (e) => live && setError((e as Error).message));
    return () => {
      live = false;
    };
  }, [eventId, given]);
  const folder = given ?? own;

  if (error) return <ErrorLine>{error}</ErrorLine>;
  if (!folder) return <ActivityIndicator style={{ marginTop: 24, alignSelf: 'flex-start' }} />;
  const drivers = latestByDriver(folder);
  const reference = referenceLap(folder);
  const setter = reference ? drivers.find((d) => d.run.id === reference.session_id) : undefined;
  const clients = drivers.filter((d) => d !== setter);
  const none = <Note>No timed run yet: this comes with the first run’s laps.</Note>;
  return (
    <>
      <Section no={1} title="Three things to improve"
        dek="From each driver’s latest run: the costliest mistakes that repeat, one per corner, what to do instead and what each is worth a lap.">
        {drivers.length === 0 && none}
        {drivers.map((d) => <DriverBlock key={d.run.id} {...d}><TopThings sessionId={d.run.id} /></DriverBlock>)}
      </Section>

      <Section no={2} title="Did we fix it?"
        dek="The three things of each driver’s run before, checked on their latest run: fixed, better or not yet, and the time it gained.">
        {drivers.length === 0 && none}
        {drivers.map((d) => <DriverBlock key={d.run.id} {...d}><DidWeFix sessionId={d.run.id} /></DriverBlock>)}
      </Section>

      <Section no={3} title="Corner by corner"
        dek={reference
          ? `Where each driver’s best lap of their latest run loses time to the day’s quickest lap (${reference.run} lap ${reference.lap}, ${formatLap(reference.time)}${reference.driver ? `, ${reference.driver}` : ''}), the most first.`
          : 'Where each driver loses time to the quickest lap of the day.'}>
        {!reference ? none : (
          <>
            {clients.map((d) => (
              <DriverBlock key={d.run.id} {...d}>
                <CornerByCorner reference={reference}
                  client={{ session_id: d.run.id, lap: d.run.best_lap!, time: d.run.best_lap_s!, run: d.run.name,
                    driver: d.driver }} />
              </DriverBlock>
            ))}
            {setter && (
              <Note>{`${setter.driver ?? 'The quickest run'} set the reference lap in ${setter.run.name}: the others are measured against it.`}</Note>
            )}
          </>
        )}
      </Section>

      <Debriefs no={4} eventId={eventId} folder={folder} />
      {children}
    </>
  );
}

/** A driver's block: their name over a thick rule and their latest run (a link to it), then what is said of it. */
function DriverBlock({ driver, run, children }: { driver: string | null; run: FolderSession; children: ReactNode }) {
  const styles = useStyles();
  return (
    <View style={styles.driver}>
      <View style={styles.driverHead}>
        <Text style={styles.driverName} accessibilityRole="header">{driver ?? NOBODY}</Text>
        <TextLink href={{ pathname: '/session/[id]', params: { id: run.id } }} small arrow
          label={`${run.name} · best ${formatLap(run.best_lap_s)}`} />
      </View>
      {children}
    </View>
  );
}

/** The debriefs, folded: one line per run, the latest first, as the race weekend lists them (Transcript ready,
 * Recorded, Not yet), each to its debrief or to record one. Read when opened. */
function Debriefs({ no, eventId, folder }: { no: number; eventId: number; folder: Folder }) {
  const styles = useStyles();
  const [open, setOpen] = useState(false);
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
    if (open) load();
    return () => {
      live.current = false;
    };
  }, [open, load]));
  const lines = debriefLines(folder, debriefs ?? []);
  const kept = lines.filter((l) => l.state !== 'none').length;
  const latest = latestRun(folder);
  return (
    <View style={styles.fold}>
      <FoldHead no={no} title="Debriefs" open={open} onToggle={() => setOpen(!open)} what="the debriefs"
        facts={debriefs ? `${kept} of ${lines.length} runs` : `${lines.length} runs`} />
      {open && (
        <View style={styles.foldBody}>
          {error && <ErrorLine>{`Can’t read the debriefs: ${error}`}</ErrorLine>}
          {!debriefs && !error && <ActivityIndicator style={{ alignSelf: 'flex-start' }} />}
          {debriefs && lines.map((l) => <DebriefRow key={l.run.id} line={l} />)}
          {latest && (
            <View style={styles.links}>
              <TextLink href={{ pathname: '/debrief', params: { session: latest.id } }}
                label={`Record a debrief for ${latest.name}`} arrow />
            </View>
          )}
        </View>
      )}
    </View>
  );
}

const useStyles = themed((c) => ({
  driver: { marginBottom: 30 },
  driverHead: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'baseline', columnGap: 16, rowGap: 6,
    borderBottomWidth: 3, borderColor: c.rule, paddingBottom: 6, marginBottom: 10 },
  driverName: { fontFamily: Fonts.display, fontSize: 28, lineHeight: 32, textTransform: 'uppercase', color: c.text },
  fold: { marginTop: 44 },
  foldBody: { marginTop: 14 },
  links: { flexDirection: 'row', flexWrap: 'wrap', columnGap: 22, rowGap: 12, marginTop: 20 },
}));
