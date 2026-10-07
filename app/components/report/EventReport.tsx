import { Link, Stack, useRouter } from 'expo-router';
import { Fragment, ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator, LayoutChangeEvent, Pressable, ScrollView, StyleSheet, useWindowDimensions, View as Box,
} from 'react-native';

import PrintButton from '@/components/PrintButton';
import {
  B, Block, Colophon, Fig, Folio, Hero, Label, Page, Section, Swatch, TextLink, useGutter, useWide,
} from '@/components/Programme';
import { Bars, LineChart, LineSeries, useChartColors } from '@/components/ReportCharts';
import { Balance } from '@/components/report/Balance';
import { GripReport } from '@/components/report/GripReport';
import { GripBalance, LapsScope, TyreCorners, useQuickLaps } from '@/components/report/QuickLaps';
import { ServerNote } from '@/components/report/ServerNote';
import { TrackGrip } from '@/components/report/TrackGrip';
import { useEventFolder, useSessionEvent } from '@/components/SessionSwitcher';
import { Text, View } from '@/components/Themed';
import { TrackMap } from '@/components/TrackMap';
import { EventPartsRead, useEventParts } from '@/components/weekend/SessionReports';
import { formatLap } from '@/lib/api';
import { noPrint } from '@/lib/print';
import { todayIso } from '@/lib/calendar';
import { dateRange, Folder } from '@/lib/events';
import { RunNamer, runNamer } from '@/lib/runLabels';
import { poll } from '@/lib/poll';
import { fetchPartReport, fetchPartReportProgress, Part, PartScope, refreshPartReport } from '@/lib/sessionReports';
import { TrackShapeData } from '@/lib/trackshape';
import { defaultStage } from '@/lib/weekendRuns';
import {
  fetchReport,
  fetchReportProgress,
  Habit,
  LapRow,
  PHASES,
  refreshReport,
  Relation,
  Report,
  ReportAnswer,
  ReportScope,
  SectionReport,
} from '@/lib/report';
import {
  deltaColor, Fonts, inkOn, lossStep, Palette, phaseColor, Photo, PHOTOS, photoFor, TAP, tapRoom, themed, Type, useTheme,
} from '@/constants/Theme';

const MEDAL = { gold: 'Gold', silver: 'Silver', bronze: 'Bronze' } as const;
const SCORE_NAMES: Record<string, string> = {
  braking: 'Braking', turn_in: 'Turn-in', mid_corner: 'Mid-corner', traction: 'Traction',
};
// each sub-score's bar in its driving phase's colour
const SCORE_PHASE: Record<string, string> = {
  braking: 'braking', turn_in: 'entry', mid_corner: 'mid-corner', traction: 'full throttle',
};
// "Most of it on exit", "0.94 s of 1.72 s is on the way out of the corners"
const PHASE_WORDS: Record<string, { most: string; where: string; title: string }> = {
  braking: { most: 'under braking', where: 'under braking', title: 'Under braking' },
  entry: { most: 'on entry', where: 'on the way into the corners', title: 'On entry' },
  'mid-corner': { most: 'mid-corner', where: 'in the middle of the corners', title: 'Mid-corner' },
  exit: { most: 'on exit', where: 'on the way out of the corners', title: 'On exit' },
  'full throttle': { most: 'on full throttle', where: 'on full throttle', title: 'On full throttle' },
};
const SCORE_FLOOR = 95; // the sub-score bars run from 95 % to 100 %

const s2 = (v: number) => `${v.toFixed(2)} s`;
// what a report is for: the whole event, one official session of it (FP1, Q1, R1: every run of it) or one run
type Scope = { event: number; part?: undefined } | { session: number; part?: undefined } | PartScope;
const isPartScope = (s: Scope): s is PartScope => typeof s.part === 'string';
const keyOf = (s: Scope) => JSON.stringify(isPartScope(s) ? { event: s.event, part: s.part } : s);
const metres = (m: number) => `${Math.round(m).toLocaleString('en-GB')} m`;
const MAX_EVIDENCE = 5; // measures shown under a section before "Show all"
// lap time axis ticks as m:ss, with tenths only when the ticks are closer than a second
const lapTick = (v: number) => {
  const m = Math.floor(v / 60);
  const sec = Math.round((v - 60 * m) * 10) / 10;
  const text = Number.isInteger(sec) ? String(sec) : sec.toFixed(1);
  return m ? `${m}:${sec < 10 ? '0' : ''}${text}` : text;
};

/** The report's photo: Hockenheim's framed on the stadium, as the programme's report page has it. */
const reportPhoto = (track: string | null | undefined): Photo => {
  const p = photoFor(track);
  return p === PHOTOS.hockenheim ? { ...p, focus: { x: 0.5, y: 0.82 }, focusPhone: { x: 0.3, y: 0.5 } } : p;
};

/** How to go faster, for a whole event (every session of a test), one official session of it (`part`: "FP1", every
 * run of that session) or one run, as a race programme: the photo and
 * the headline, the lap's figures, the three biggest gains, section by section on the map, where the time goes, grip
 * and balance, the tyres, the track's grip, then corner by corner what to change and the evidence, trends,
 * consistency and what goes with lap time.
 *
 * The report page (app/report.tsx) renders it as a whole page: the hero, the run switcher, the numbered sections and
 * the colophon, with the run switcher's pick in the page's address. With `embedded` it renders inside another page
 * (the race weekend's After tab): no hero, page title or colophon of its own and no scrolling of its own, and the run
 * switcher keeping its pick to itself. The page around it can number its sections on from its own (`firstNo`, and
 * `onSections` says how many there are), hand it the event it has already read (`folder`), and bring the map into
 * view when a section is tapped to see it there (`onShowMap`, with the map's place in the report, where the browser
 * can't). */
export default function EventReport({
  eventId, part, sessionId, embedded, firstNo = 1, onSections, folder: hostFolder, onShowMap, parts: hostParts,
}: {
  eventId?: number;
  part?: string; // with eventId: that official session's report ("FP1", "Q1", "03_Q"; lib/sessionReports.ts)
  sessionId?: number;
  embedded?: boolean;
  firstNo?: number;
  onSections?: (count: number) => void;
  folder?: Folder | null;
  onShowMap?: (y: number) => void;
  parts?: EventPartsRead; // embedded: the event's official sessions as the page has read them, for the switcher
}) {
  const theme = useTheme();
  const styles = useStyles();
  const wide = useWide();
  const gutter = useGutter();
  const { width } = useWindowDimensions();
  const given: Scope | null = eventId != null ? (part ? { event: eventId, part } : { event: eventId })
    : sessionId != null ? { session: sessionId } : null;
  const givenKey = given ? keyOf(given) : '';
  // embedded, the switcher's pick (whole event, one official session or one run) for the report asked for; a new one
  // drops it
  const [picked, setPicked] = useState<{ of: string; scope: Scope } | null>(null);
  // opened on one official session (a weekend's session reports): while the weekend is on, the whole event's report
  // stays out of the switcher, it is for after the weekend (Gabriele, 2026-10-07)
  const [fromPart] = useState(given != null && isPartScope(given));
  const scope: Scope | null = embedded && picked?.of === givenKey ? picked.scope : given;
  const key = scope ? keyOf(scope) : '';
  const [answer, setAnswer] = useState<ReportAnswer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [focus, setFocus] = useState<string | null>(null);
  const [topH, setTopH] = useState(0);
  const [mapY, setMapY] = useState(0);
  const [shape, setShape] = useState<TrackShapeData | null>(null); // the track's shape, once the map has it
  const scroll = useRef<ScrollView>(null);
  const router = useRouter();
  // the event's sessions, to switch between the whole event's report and one session's without going back; the page
  // keeps its place and the section picked on the map
  // (embedded, the page around it has read the event already)
  const sessionEvent = useSessionEvent(hostFolder === undefined && scope && 'session' in scope ? scope.session : null);
  const read = useEventFolder(hostFolder !== undefined ? null : scope && 'event' in scope ? scope.event : sessionEvent);
  const folder = hostFolder ?? read;
  // an official session's runs, once its report has answered: what its sections worked out per run show
  const partRuns = scope && isPartScope(scope) && answer?.scope === 'part' && answer.part === scope.part
    ? answer.sessions.map((s) => s.id) : null;
  const lapsScope: LapsScope | null = !scope ? null : !(isPartScope(scope)) ? scope
    : partRuns ? (partRuns.length === 1 ? { session: partRuns[0] } : { sessions: partRuns }) : null;
  const quick = useQuickLaps(lapsScope);
  const [polls, setPolls] = useState(0); // bumped by Retry: the poll below starts again

  // ask for the report; while the server works it out, only how far it is is asked again (lib/poll.ts: less and less
  // often, ?brief), and the report once more when it's ready
  useEffect(() => {
    if (!scope) return;
    const busy = (status: string) => status === 'queued' || status === 'running';
    let read = false; // the report itself read once already
    return poll(async (live) => {
      try {
        if (read) {
          const h = await (isPartScope(scope) ? fetchPartReportProgress(scope) : fetchReportProgress(scope));
          if (!live()) return false;
          if (busy(h.status)) {
            setAnswer((a) => a && { ...a, ...h }); // its progress
            setError(null);
            return true;
          }
        }
        const a = await (isPartScope(scope) ? fetchPartReport(scope) : fetchReport(scope));
        if (!live()) return false;
        read = true;
        setAnswer(a);
        setError(null);
        return busy(a.status);
      } catch (e) {
        if (!live()) return false;
        setError((e as Error).message);
        return true;
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, polls]);

  const retry = useCallback(async () => {
    if (!scope) return;
    try {
      setAnswer(await (isPartScope(scope) ? refreshPartReport(scope) : refreshReport(scope)));
      setError(null);
      setPolls((n) => n + 1); // the poll above has stopped; start it again
    } catch (e) {
      setError((e as Error).message);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const report = answer?.report ?? null;
  // every run by its own name ("FP1 stint 1", "Q1 · Gabriele Piana"), never a number
  const names = useMemo(() => runNamer(answer), [answer]);
  const mapAt = useRef<Box>(null); // the map, embedded: on the web a DOM element to bring into view
  const showOnMap = (code: string) => {
    setFocus(code);
    if (!embedded) {
      scroll.current?.scrollTo({ y: Math.max(topH + mapY - 12, 0), animated: true });
      return;
    }
    // embedded on the web, the browser brings the map into view in whatever scrolls the page around it (a section's
    // place isn't measured again when what is above it grows); elsewhere the page scrolls to the map's place
    const node = mapAt.current as unknown as { scrollIntoView?: (o: object) => void } | null;
    // the map's top at the top of the screen (on a phone the map and the list under it are taller than the screen)
    if (node?.scrollIntoView) node.scrollIntoView({ behavior: 'smooth', block: 'start' });
    else onShowMap?.(mapY);
  };
  // how many numbered sections there are, for the page around it to number its own on from them
  const count = useRef(0);
  useEffect(() => {
    onSections?.(count.current);
  });

  if (!scope) {
    const none = <Text style={styles.note}>Open a report from an event on the Sessions page, or from a session.</Text>;
    return embedded ? none : <Page>{none}</Page>;
  }
  const isPart = isPartScope(scope);
  const isEvent = 'event' in scope && !isPart;
  // the sections worked out per event or per run (the map, grip use, balance, technique, quali prep): an official
  // session of one run shows that run's, one of several runs the event's map and leaves the others out
  const oneRun = partRuns?.length === 1 ? partRuns[0] : null;
  const runScope: ReportScope = !isPartScope(scope) ? scope
    : oneRun != null ? { session: oneRun } : { event: scope.event };
  const perRun = !isPart || oneRun != null;
  const kindName = isPartScope(scope) ? `${answer && answer.part === scope.part ? answer.title : scope.part} report`
    : isEvent ? 'Event report' : 'Session report';
  const working = answer?.status === 'queued' || answer?.status === 'running';
  const switching = answer != null && key !== keyOf(answer.scope === 'event' ? { event: answer.id }
    : answer.scope === 'part' ? { event: answer.id, part: answer.part ?? '' } : { session: answer.id });
  // the sessions have clean laps (the report is ready or being worked out), so the other sections have data too
  const hasLaps = report != null || working || answer?.sessions.some((s) => s.included) === true;
  const highlight = focus ?? report?.gains[0]?.code ?? undefined;
  const tones = report ? sectionTones(theme, report) : undefined;
  const map = 'event' in runScope
    ? <TrackMap event={runScope.event} highlight={highlight} withShape onShape={setShape} sectionColors={tones} />
    : <TrackMap session={runScope.session} highlight={highlight} withShape onShape={setShape} sectionColors={tones} />;
  const track = answer?.track ?? folder?.track ?? null;
  const runs = report?.runs_analysed ?? 0;
  // an official session's days are its runs'; its runs are called runs (an event's, sessions)
  const partDays = isPart && answer ? answer.sessions.map((s) => names.byId(s.id)?.date).filter((d): d is string => !!d)
    .sort() : [];
  const dates = partDays.length ? dateRange(partDays[0], partDays[partDays.length - 1])
    : folder ? dateRange(folder.start, folder.end) : null;
  const runWord = (n: number) => (isPart ? (n === 1 ? 'run' : 'runs') : n === 1 ? 'session' : 'sessions');
  const pdfName = [kindName, isPart ? folder?.name : answer?.title ?? folder?.name].filter(Boolean).join(' · ');

  const top = (
    <View onLayout={(e: LayoutChangeEvent) => setTopH(e.nativeEvent.layout.height)}>
      <Hero photo={reportPhoto(track)} tag={kindName}
        rest={(isPart ? folder?.name : answer?.title ?? folder?.name) ?? undefined}
        restHref={'event' in scope ? { pathname: '/event/[id]', params: { id: String(scope.event) } }
          : { pathname: '/session/[id]', params: { id: scope.session } }}
        title="How to go faster"
        deck={report ? `${[track, dates].filter(Boolean).join(', ')}: ${report.laps_analysed} clean laps from ${runs} ` +
          `${runWord(runs)}.` : undefined} />
      <Folio items={[
        track ? <>{track}{report ? <> <B>{metres(report.length_m)}</B></> : null}</> : null,
        report ? <><B>{report.laps_analysed}</B> clean laps · <B>{runs}</B> {runWord(runs)}</> : null,
        report ? <>Fastest <B>{formatLap(report.headline.fastest.time)}</B></> : null,
        report ? (report.numbering === 'official' ? 'Official corner numbers' : 'Corners numbered from the log') : null,
      ]} />
    </View>
  );

  // the numbered sections, in order: each is drawn only when it has something to show
  const sections: { title: string; dek?: string; body: ReactNode; onLayout?: (e: LayoutChangeEvent) => void }[] = [];
  if (report) {
    const h = report.headline;
    sections.push({ title: 'The lap', dek: 'What the car and the quickest passes say is there.',
      body: <TheLap report={report} names={names} width={Math.min(width, 1240) - 2 * gutter} /> });
    sections.push({ title: report.gains.length === 3 ? 'Top three gains' : 'Where to gain',
      dek: `Where a typical lap (${formatLap(h.typical)}) gives the most away to the quick passes.`,
      body: <Gains report={report} onPick={showOnMap} /> });
  }
  if (hasLaps) {
    sections.push({ title: 'Section by section',
      dek: report ? 'Each section shaded by the time a typical lap loses there. Tap one for where it starts and ends.'
        : 'The track and its sections.',
      onLayout: (e) => setMapY(e.nativeEvent.layout.y),
      body: (
        <>
          <Box ref={mapAt} style={wide ? styles.mapWrap : styles.mapWrapPhone}>
            <View style={wide ? styles.mapSide : undefined}>{map}</View>
            {report && (
              <View style={wide ? styles.rankSide : undefined}>
                <LostList report={report} tones={tones!} focus={highlight ?? null} onPick={setFocus} />
              </View>
            )}
          </Box>
          {/* banked corners grip more than the tyres would on a flat road: say which, by number */}
          {shape?.banked_note ? <Text style={styles.note}>{shape.banked_note}</Text> : null}
        </>
      ) });
  }
  if (report) {
    sections.push({ title: 'Where the time goes',
      dek: 'What a typical lap loses to the quick passes of every section, by driving phase.',
      body: <WhereTime report={report} /> });
  }
  if (hasLaps) {
    const lapsBody = (draw: (laps: NonNullable<typeof quick.laps>) => ReactNode) => (
      quick.error ? <Text style={styles.note}>These figures didn&apos;t load: {quick.error}</Text>
        : !quick.laps ? <ActivityIndicator style={styles.loading} />
          : quick.laps.length === 0 ? <Text style={styles.note}>No flying laps to measure yet.</Text>
            : draw(quick.laps)
    );
    sections.push({ title: 'Grip & balance',
      dek: 'The g the car pulls in each phase (median of the quick laps) and how it is balanced.',
      body: lapsBody((laps) => <GripBalance laps={laps} />) });
    sections.push({ title: 'Tyres',
      dek: 'Hot TPMS temperature and hot pressure per corner, median of the quick laps.',
      body: lapsBody((laps) => <TyreCorners laps={laps} />) });
    if ('event' in scope && !(isPartScope(scope))) {
      sections.push({ title: 'Track grip',
        dek: 'Grip at the limit by session, with the tyres’ state taken out: the rest is the track rubbering in, its ' +
          'temperature and the weather.',
        body: <TrackGrip event={scope.event} bare /> });
    }
    if (perRun) { // worked out for a whole event or one run: an official session of several runs leaves them out
      sections.push({ title: 'Grip use & traction control',
        dek: 'How much of the car’s grip the laps use while braking and cornering, and where traction control cuts in.',
        body: 'event' in runScope ? <GripReport event={runScope.event} bare />
          : <GripReport session={runScope.session} bare /> });
      sections.push({ title: 'Car balance & setup',
        dek: 'Where the car limits the lap, and the setup changes to try.',
        body: 'event' in runScope ? <Balance event={runScope.event} bare />
          : <Balance session={runScope.session} bare /> });
    }
  }
  if (report) {
    sections.push({ title: 'Corner by corner',
      dek: 'Each section in lap order: what to change, where its time goes, and the evidence. Tap a section’s name to see ' +
        'it on the map.',
      body: report.sections.map((s) => (
        <DrivingCard key={s.code} section={s} report={report} names={names} tone={tones![s.code]}
          onMap={() => showOnMap(s.code)} />
      )) });
    sections.push({ title: 'Trends & consistency', body: <Trends report={report} names={names} /> });
    sections.push({ title: 'What goes with lap time',
      body: <Relations relations={report.lap_time_relations} laps={report.laps_analysed} /> });
    const listTitle = isEvent ? 'Sessions in this report' : isPart ? 'Runs in this report' : 'This session';
    sections.push({ title: listTitle, body: (
      <View style={styles.rows}>
        {answer!.sessions.map((s) => {
          const run = names.byId(s.id);
          return (
          <Link key={s.id} href={{ pathname: '/session/[id]', params: { id: s.id } }} asChild>
            <Pressable style={styles.sessionRow} accessibilityRole="link">
              <Text style={StyleSheet.flatten([styles.sessionName, !s.included && styles.dim])}>
                {s.name}
                {withDriver(s.name, s.driver)}
              </Text>
              <Text style={StyleSheet.flatten([styles.sessionMeta, !s.included && styles.dim])}>
                {[run?.day && !s.name.startsWith('Day ') ? `Day ${run.day}` : null, run?.time,
                  s.included ? `${s.clean_laps} clean laps · best ${formatLap(s.best)}` : s.note ?? 'Left out']
                  .filter(Boolean).join(' · ')}
              </Text>
            </Pressable>
          </Link>
          );
        })}
      </View>
    ) });
    sections.push({ title: 'How this is worked out', body: (
      <View style={styles.rows}>
        {report.method.map((m) => (
          <Text key={m} style={styles.method}>{m}</Text>
        ))}
        <View style={styles.quali}>
          <TextLink href={{ pathname: '/quali', params: runScope }}
            label="Quali prep: warm-up, build laps, tyre windows and pressures" arrow />
        </View>
      </View>
    ) });
  }

  count.current = sections.length;
  const body = (
    <>
      {!embedded && (
        <Stack.Screen options={{ title: isPart ? kindName : answer ? `Report · ${answer.title}` : 'Report' }} />
      )}
      {folder && folder.id != null && (
        <ScopeBar folder={folder} current={'session' in scope ? scope.session : null}
          whole={!fromPart || defaultStage(folder, todayIso()) === 'after'}
          part={isPartScope(scope) ? scope.part : null} scope={runScope} pdfName={pdfName} names={names}
          given={hostParts}
          onWhole={() => (embedded ? setPicked({ of: givenKey, scope: { event: folder.id! } })
            : router.setParams({ event: String(folder.id), session: undefined, part: undefined }))}
          onPart={(code) => (embedded ? setPicked({ of: givenKey, scope: { event: folder.id!, part: code } })
            : router.setParams({ event: String(folder.id), part: code, session: undefined }))}
          onPick={(id) => (embedded ? setPicked({ of: givenKey, scope: { session: id } })
            : router.setParams({ session: String(id), event: undefined, part: undefined }))} />
      )}
      {switching && <ActivityIndicator style={styles.loading} />}
      {!answer && !error && <ActivityIndicator style={styles.loading} />}
      {error && <Text style={styles.error}>Can&apos;t reach the server: {error}</Text>}
      <ServerNote />
      {answer && working && <Progress answer={answer} />}
      {answer?.status === 'failed' && (
        <View style={styles.banner}>
          <Text style={styles.para}>{answer.error ?? 'The report couldn’t be worked out.'}</Text>
          <TextLink onPress={retry} label="Try again" red />
        </View>
      )}
      {answer?.status === 'empty' && (
        <Text style={styles.para}>
          No clean laps to analyse yet. Upload the logs of this {answer.scope === 'event' ? 'event' : 'session'}; the
          report is worked out as soon as they
          are imported.
        </Text>
      )}
      {report && (report.laps_left_out ?? 0) > 0 && (
        <Text style={styles.note}>
          Worked out from the {report.laps_analysed} quickest clean laps; the {report.laps_left_out} slower ones are left
          out to keep within the server&apos;s memory.
        </Text>
      )}
      {answer?.stale && report && (
        <Text style={styles.note}>
          These numbers are from before the sessions last changed; the new report replaces them when it is ready.
        </Text>
      )}
      {!folder && (
        <View style={styles.headLinks}>
          {hasLaps && (
            <View {...noPrint}>
              <TextLink href={{ pathname: '/technique', params: runScope }}
                label="Technique check" arrow />
            </View>
          )}
          <PrintButton title={pdfName} />
        </View>
      )}
      {/* The core report answers at once from the server's cache; the map and the other sections load themselves
          meanwhile (they take turns on the server's log lock), so nothing waits for anything else to paint. */}
      {sections.map((s, i) => (
        <Section key={s.title} no={firstNo + i} title={s.title} dek={s.dek} onLayout={s.onLayout}>{s.body}</Section>
      ))}
      {!embedded && (
        <Colophon left={`The Engineer · ${kindName}`}
          right={[isPart ? folder?.name : answer?.title, track].filter(Boolean).join(' · ')} />
      )}
    </>
  );
  // embedded, the page around it scrolls and has the hero: tapping a section to see it on the map only picks it there
  return embedded ? body : <Page top={top} scrollRef={scroll}>{body}</Page>;
}

/** Each section's colour on the map and in the list: a step of the time-lost ramp, deeper the more time a typical
 * lap loses there against the most any section loses. */
function sectionTones(theme: Palette, report: Report): Record<string, string> {
  const top = Math.max(...report.sections.map((s) => s.gain_s), 0.01);
  return Object.fromEntries(report.sections.map((s) => [s.code, lossStep(theme, Math.max(s.gain_s, 0) / top)]));
}

// ---------- the scope: whole event, one official session or one run ----------

/** What the report is for: the whole event, one of its official sessions (FP1, Q1, R1, every run of it) or one run.
 * A run alone in its session is picked by the session's name only (the same report). */
function ScopeBar({ folder, current, whole, part, scope, pdfName, names, onWhole, onPart, onPick, given }: {
  folder: NonNullable<ReturnType<typeof useEventFolder>>;
  current: number | null; // the run shown, or null
  whole: boolean; // the whole event can be picked (left out while the weekend is on, for a session's report)
  part: string | null; // the official session shown, or null
  scope: ReportScope; // for the technique check
  pdfName: string;
  names: RunNamer;
  onWhole: () => void;
  onPart: (code: string) => void;
  onPick: (id: number) => void;
  given?: EventPartsRead; // the official sessions as the page has read them: not read again
}) {
  const styles = useStyles();
  const wide = useWide();
  // the sessions with a timed lap (and the one shown)
  const own = useEventParts(given ? null : folder.id);
  const parts = ((given ?? own).answer?.parts ?? []).filter((p) => p.best != null || p.code === part);
  // runs alone in their session are reached by the session's name
  const alone = new Set(parts.filter((p) => p.runs.length === 1).map((p) => p.runs[0].id));
  const partOn = (p: Part) => p.code === part || (part == null && current != null && p.runs.length === 1
    && p.runs[0].id === current);
  // the timed runs not alone in their session, by day
  const runDays = folder.days.map((d, di) => ({ key: d.date ?? `day${di}`,
    sessions: d.sessions.filter((s) => s.best_lap_s != null && !alone.has(s.id)) }))
    .filter((d) => d.sessions.length > 0);
  return (
    // the whole bar stays off the printed page: the headline says what the report is for
    <View style={styles.scope} {...noPrint}>
      <Label>Report for</Label>
      {whole && <TextLink onPress={onWhole} label="Whole event" red={current == null && part == null} small />}
      {parts.length > 0 && whole && <Label muted>or one session</Label>}
      {parts.length > 0 && (
        <View style={styles.runs}>
          {/* each official session by its code ("FP1", "Q1", "R1"), in the order they ran */}
          {parts.map((p) => {
            const on = partOn(p);
            return (
              <Pressable key={p.code} onPress={() => onPart(p.code)} accessibilityRole="button"
                accessibilityLabel={`${p.title} report`} accessibilityState={{ selected: on }}
                style={styles.runHit}>
                <View style={StyleSheet.flatten([styles.run, on && styles.runOn])}>
                  <Text style={StyleSheet.flatten([styles.runText, on && styles.runTextOn])}>{p.code}</Text>
                </View>
              </Pressable>
            );
          })}
        </View>
      )}
      {runDays.length > 0 && <Label muted>{parts.length ? 'or one run' : 'or one session'}</Label>}
      <View style={styles.runs}>
        {runDays.map(({ key, sessions }, di) => (
          <Fragment key={key}>
            {di > 0 && <View style={styles.daySplit} />}
            {/* each run by its own name in short ("FP1 S1", "Q1"), in the event page's order, the days apart */}
            {sessions.map((s) => {
              const on = s.id === current;
              const run = names.byId(s.id);
              return (
                <Pressable key={s.id} onPress={() => onPick(s.id)} accessibilityRole="button"
                  accessibilityLabel={`Report for ${run?.name ?? s.name}`} accessibilityState={{ selected: on }}
                  style={styles.runHit}>
                  <View style={StyleSheet.flatten([styles.run, on && styles.runOn])}>
                    <Text style={StyleSheet.flatten([styles.runText, on && styles.runTextOn])}>
                      {run?.short ?? s.name}
                    </Text>
                  </View>
                </Pressable>
              );
            })}
          </Fragment>
        ))}
      </View>
      <View style={StyleSheet.flatten([styles.links, wide && styles.tech])}>
        <TextLink href={{ pathname: '/technique', params: 'event' in scope ? { event: scope.event } : { session: scope.session } }}
          label="Technique check" arrow small />
        <PrintButton title={pdfName} />
      </View>
    </View>
  );
}

function Progress({ answer }: { answer: ReportAnswer }) {
  const styles = useStyles();
  const c = useTheme();
  const p = answer.progress;
  const share = p && p.total ? p.done / p.total : 0;
  return (
    <View style={styles.banner}>
      <Label>{answer.report ? 'Updating the report' : 'Working out the report'}</Label>
      {p?.current ? <Text style={styles.para}>{p.current}</Text> : null}
      <View style={StyleSheet.flatten([styles.meter, { borderColor: c.rule }])}>
        <View style={{ height: '100%', backgroundColor: c.rule, width: `${Math.round(share * 100)}%` }} />
      </View>
      <Text style={styles.note}>
        Each session&apos;s log is read once, then kept in compact form, so later reports come quicker.
      </Text>
    </View>
  );
}

// ---------- 01 the lap ----------

function TheLap({ report, names, width }: { report: Report; names: RunNamer; width: number }) {
  const styles = useStyles();
  const wide = useWide();
  const c = useTheme();
  const h = report.headline;
  const sc = h.score;
  // the ideal lap as large as its column allows (Anton's figures are about 0.45 of their size wide)
  const left = wide ? (width * 1.55) / 2.55 - 32 : width;
  const ideal = Math.floor(Math.min(wide ? 188 : 104, left / (formatLap(h.ideal).length * 0.47)));
  const trio: [string, number, string][] = [
    ['Fastest lap', h.fastest.time, `${names.name(h.fastest.run, h.fastest.session_id)}, lap ${h.fastest.lap}`],
    ['Realistic target', h.realistic, 'a quick lap’s usual grip at each place'],
    ['Theoretical', h.theoretical, 'the car’s best at every place'],
  ];
  return (
    <View style={wide ? styles.lapFeature : undefined}>
      <View style={wide ? styles.lapLeft : undefined}>
        <Fig label="Ideal lap · best pass of every section" value={formatLap(h.ideal)} size={ideal} bar={c.timing.best}
          barHeight={12} />
        <View style={styles.trio}>
          {trio.map(([label, v, note], i) => (
            <View key={label} style={StyleSheet.flatten([styles.trioCell, i > 0 && styles.trioNext])}>
              <Fig label={label} value={formatLap(v)} size={wide ? 54 : 30} note={note} />
            </View>
          ))}
        </View>
      </View>
      <View style={wide ? styles.lapRight : styles.lapRightPhone}>
        <View style={styles.scoreHead}>
          <Label>Driving score</Label>
          {sc.medal && <Block label={MEDAL[sc.medal]} color={c.medal[sc.medal]} ink={inkOn(c.medal[sc.medal])} size={14} />}
        </View>
        <Fig value={sc.extraction.toFixed(1)} unit="%" size={wide ? 132 : 100}
          note={`of the car’s theoretical pace, on the fastest lap${sc.next_medal ? `; ${
            sc.next_medal.seconds_to_find >= 0.01 ? `${sc.next_medal.seconds_to_find.toFixed(2)} s to `
              : 'on the edge of '}${sc.next_medal.medal}` : ''}`} />
        <View style={styles.subscores}>
          {Object.entries(sc.scores).map(([k, v]) => (
            <View key={k} style={styles.subscore}>
              <Text style={styles.subName}>{SCORE_NAMES[k] ?? k}</Text>
              <View style={styles.subTrack}>
                <View style={{ height: 12, backgroundColor: phaseColor(c, SCORE_PHASE[k] ?? k),
                  width: `${Math.round(Math.max(0, Math.min(1, (v - SCORE_FLOOR) / (100 - SCORE_FLOOR))) * 100)}%` }} />
              </View>
              <Text style={styles.subValue}>{v.toFixed(1)}%</Text>
            </View>
          ))}
          <Label muted small style={styles.subNote}>Bars from {SCORE_FLOOR} % to 100 %</Label>
        </View>
      </View>
    </View>
  );
}

// ---------- 02 the gains ----------

function Gains({ report, onPick }: { report: Report; onPick: (code: string) => void }) {
  const styles = useStyles();
  const wide = useWide();
  const c = useTheme();
  if (report.gains.length === 0) {
    return <Text style={styles.para}>The typical pass is already as quick as the quick passes everywhere.</Text>;
  }
  return (
    <>
      <View style={wide ? styles.gains : undefined}>
        {report.gains.map((g, i) => (
          <Pressable key={g.code} accessibilityRole="button" accessibilityLabel={`${g.code}: show on the map`}
            onPress={() => onPick(g.code)}
            style={StyleSheet.flatten([wide ? styles.gain : styles.gainPhone, i === 0 && (wide ? styles.gainFirst
              : styles.gainFirstPhone)])}>
            <View style={styles.gainHead}>
              <View style={styles.rank}><Text style={styles.rankText}>{i + 1}</Text></View>
              <Text style={styles.gainCode}>{g.code}</Text>
            </View>
            <Fig value={g.seconds.toFixed(2)} unit="s" color={c.delta.gain}
              size={wide ? (i === 0 ? 150 : 112) : i === 0 ? 120 : 96} />
            {g.action && <Text style={styles.gainLead}>{g.action}</Text>}
            {g.advice.filter((a) => a !== g.action).map((a) => (
              <View key={a} style={styles.bulletRow}>
                <View style={styles.bulletMark} />
                <Text style={styles.bulletText}>{a}</Text>
              </View>
            ))}
            {g.main_phase && (
              <View style={styles.gainWhere}>
                <Swatch color={phaseColor(c, g.main_phase)} width={22} height={10}
                  label={`Most of it ${PHASE_WORDS[g.main_phase]?.most ?? g.main_phase}`} />
              </View>
            )}
          </Pressable>
        ))}
      </View>
      <Text style={styles.summary}>{report.summary}</Text>
    </>
  );
}

// ---------- 03 section by section ----------

function LostList({ report, tones, focus, onPick }: {
  report: Report;
  tones: Record<string, string>;
  focus: string | null;
  onPick: (code: string) => void;
}) {
  const styles = useStyles();
  const c = useTheme();
  const ranked = [...report.sections].sort((a, b) => b.gain_s - a.gain_s);
  const top = Math.max(ranked[0]?.gain_s ?? 0, 0.01);
  const picked = report.sections.find((s) => s.code === focus);
  const step = top / c.timing.loss.length;
  return (
    <View>
      <View style={styles.mapTop}>
        <Label>Time lost, s</Label>
        <Label muted small>typical lap vs quick passes</Label>
      </View>
      {ranked.map((s) => (
        <Pressable key={s.code} onPress={() => onPick(s.code)} accessibilityRole="button"
          accessibilityLabel={`${s.code}: ${s.gain_s.toFixed(2)} s, show on the map`}
          style={StyleSheet.flatten([styles.lostRow, s.code === focus && styles.lostOn])}>
          <Text style={styles.lostName}>{s.code}</Text>
          <View style={styles.lostTrack}>
            {s.gain_s >= 0.005 && (
              <View style={{ height: 14, borderWidth: 1, borderColor: c.rule, backgroundColor: tones[s.code],
                width: `${(s.gain_s / top) * 100}%` }} />
            )}
          </View>
          <Text style={styles.lostValue}>{s.gain_s.toFixed(2)}</Text>
        </Pressable>
      ))}
      <View style={styles.ramp}>
        {c.timing.loss.map((col, i) => (
          <View key={col} style={styles.rampStep}>
            <View style={StyleSheet.flatten([styles.rampCell, { backgroundColor: col }, i === 0 && styles.rampFirst,
              i === c.timing.loss.length - 1 && styles.rampLast])} />
            <Text style={styles.rampText}>
              {i === 0 ? `under ${step.toFixed(2)}` : i === c.timing.loss.length - 1 ? `${(i * step).toFixed(2)} s +`
                : `${(i * step).toFixed(2)}–${((i + 1) * step).toFixed(2)}`}
            </Text>
          </View>
        ))}
      </View>
      {picked && (
        <Text style={styles.note}>
          {picked.code} · {Math.round(picked.start_m)}–{Math.round(picked.end_m)} m · typical{' '}
          {picked.times.typical.toFixed(2)} s · quick passes {picked.times.quick.toFixed(2)} s
        </Text>
      )}
    </View>
  );
}

// ---------- 04 where the time goes ----------

function WhereTime({ report }: { report: Report }) {
  const styles = useStyles();
  const wide = useWide();
  const c = useTheme();
  const phases = PHASES.map((p) => ({ p, v: Math.max(0, report.where_total[p] ?? 0), color: phaseColor(c, p) }));
  const total = phases.reduce((a, x) => a + x.v, 0);
  if (total < 0.005) return <Text style={styles.para}>A typical lap loses nothing to the quick passes.</Text>;
  const most = phases.reduce((a, b) => (b.v > a.v ? b : a));
  // a phase's name and seconds sit over its stretch of the bar; a short stretch's go under it
  const big = (v: number) => v / total >= 0.06;
  let run = 0;
  const placed = phases.map((x) => {
    const start = run / total;
    run += x.v;
    return { ...x, start };
  });
  const labels = (show: (x: (typeof placed)[number]) => boolean) => placed.filter(show).map((x) => (
    <View key={x.p} style={StyleSheet.flatten([styles.phaseLabel, x.start > 0.82 ? { right: 0, alignItems: 'flex-end' }
      : { left: `${x.start * 100}%` }])}>
      <Text style={styles.phaseName}>{x.p}</Text>
      <Text style={styles.phaseValue}>{x.v.toFixed(2)} s</Text>
    </View>
  ));
  return (
    <View>
      {wide && <View style={styles.phaseLabels}>{labels((x) => big(x.v))}</View>}
      <View style={wide ? styles.phaseBar : styles.phaseBarPhone}
        accessibilityLabel={phases.map((x) => `${x.p} ${x.v.toFixed(2)} s`).join(', ')}>
        {phases.filter((x) => x.v > 0).map((x) => (
          <View key={x.p} style={{ flex: x.v, backgroundColor: x.color }} />
        ))}
      </View>
      {wide ? (
        <View style={styles.phaseLabelsBelow}>{labels((x) => !big(x.v) && x.v > 0)}</View>
      ) : (
        <View style={styles.phaseList}>
          {phases.map((x) => (
            <View key={x.p} style={styles.phaseRow}>
              <View style={{ width: 22, height: 14, backgroundColor: x.color }} />
              <Text style={styles.phaseRowName}>{x.p}</Text>
              <Text style={styles.phaseRowValue}>{x.v.toFixed(2)} s</Text>
            </View>
          ))}
        </View>
      )}
      <View style={wide ? styles.story : styles.storyPhone}>
        <Text style={wide ? styles.storyBody : styles.storyBodyPhone}>
          A typical lap ({formatLap(report.headline.typical)}) loses {total.toFixed(2)} s to the quick passes of every
          section, added up by what the quickest pass was doing at each metre. Most of it is{' '}
          {PHASE_WORDS[most.p]?.where ?? most.p}.
        </Text>
        <View style={StyleSheet.flatten([styles.pull, { borderColor: most.color }])}>
          <Label style={styles.pullLabel}>{PHASE_WORDS[most.p]?.title ?? most.p}</Label>
          <Text style={wide ? styles.pullQuote : styles.pullQuotePhone}>
            {most.v.toFixed(2)} s of {total.toFixed(2)} s is {PHASE_WORDS[most.p]?.where ?? most.p}
          </Text>
        </View>
      </View>
    </View>
  );
}

// ---------- corner by corner ----------

const HABIT_DIGITS: Record<string, number> = { 'km/h': 1, m: 0, s: 2, '%': 0 };
const fmtHabit = (v: number | null, unit: string) => {
  if (v == null) return '–';
  const digits = HABIT_DIGITS[unit] ?? (Math.abs(v) >= 20 ? 0 : 1);
  return `${v.toFixed(digits)}${unit === '%' ? '%' : unit ? ` ${unit}` : ''}`;
};

function DrivingCard({ section: s, report, names, tone, onMap }: {
  section: SectionReport; report: Report; names: RunNamer; tone: string | undefined; onMap: () => void;
}) {
  const styles = useStyles();
  const wide = useWide();
  const theme = useTheme();
  const [all, setAll] = useState(false);
  const t = s.times;
  // the measures behind the advice, then the most strongly linked others (the server sorts them that way)
  const telling = s.habits.filter((h, i) => h.used || (i < MAX_EVIDENCE && (h.link === 'strong' || h.link === 'clear')));
  const shown = all ? s.habits : telling;
  const hidden = s.habits.length - telling.length;
  const also = s.advice.filter((a) => a !== s.headline);
  const top = Math.max(...PHASES.map((p) => s.where[p] ?? 0), 0.001);
  return (
    <View style={styles.card}>
      <View style={styles.cardHead}>
        {tone && <View style={StyleSheet.flatten([styles.cardTone, { backgroundColor: tone }])} />}
        <Pressable accessibilityRole="button" accessibilityLabel={`Show ${s.code} on the map`} onPress={onMap}
          style={styles.cardCodeLink}>
          <Text style={styles.cardCode}>{s.code}</Text>
        </Pressable>
        <Text style={StyleSheet.flatten([styles.cardGain, s.gain_s >= 0.01 && { color: deltaColor(theme, s.gain_s) }])}>
          {s.gain_s >= 0.01 ? `${s2(s.gain_s)} to gain` : 'Nothing to gain'}
        </Text>
      </View>
      <Text style={styles.note}>
        {Math.round(s.start_m)}–{Math.round(s.end_m)} m{s.flat ? ' · flat out' : ''} · {s.quick_passes} quick passes
      </Text>
      {s.headline && <Text style={styles.cardHeadline}>{s.headline}</Text>}

      <View style={wide ? styles.row : styles.column}>
        <View style={wide ? styles.half : styles.block}>
          {also.length > 0 && (
            <View style={styles.block}>
              <Text style={styles.h4}>{s.advice.length > also.length ? 'Also' : 'What to change'}</Text>
              {also.map((a) => (
                <View key={a} style={styles.bulletRow}>
                  <View style={styles.bulletMark} />
                  <Text style={styles.bulletText}>{a}</Text>
                </View>
              ))}
            </View>
          )}
          <View style={styles.block}>
            <Text style={styles.h4}>Where the time goes</Text>
            <Bars rows={PHASES.map((p) => ({ label: cap(p), value: s.where[p] ?? 0, color: phaseColor(theme, p) }))}
              max={top} />
            <Text style={styles.note}>{s.loss_line}</Text>
          </View>
          <View style={styles.block}>
            <Text style={styles.h4}>Section times</Text>
            <Text style={styles.times}>
              Fastest lap {t.fastest_lap.toFixed(2)} · best {t.best.toFixed(2)} ({names.lap(t.best_lap)}) · typical{' '}
              {t.typical.toFixed(2)} · quick passes {t.quick.toFixed(2)} · realistic {t.realistic.toFixed(2)} ·
              theoretical {t.theoretical.toFixed(2)}
            </Text>
            <Text style={styles.note}>
              Fastest lap to the best pass {s2(s.ladder.driving)} (driving), best pass to realistic{' '}
              {s2(s.ladder.car)}, realistic to theoretical {s2(s.ladder.theoretical)}.
            </Text>
          </View>
        </View>
        <View style={wide ? styles.half : styles.block}>
          <Text style={styles.h4}>The evidence</Text>
          <SectionSpeed section={s} report={report} />
          {shown.map((h) => (
            <HabitRow key={h.key} habit={h} />
          ))}
          {hidden > 0 && (
            <TextLink onPress={() => setAll(!all)} small
              label={all ? 'Show the telling measures only' : `Show all ${s.habits.length} measures`} />
          )}
        </View>
      </View>
    </View>
  );
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** " · Gabriele Piana" after a run's name, unless the name already says who drove it ("Q1 · Gabriele Piana"). */
const withDriver = (name: string, driver: string | null | undefined) =>
  driver && !name.includes(` · ${driver}`) ? ` · ${driver}` : '';

function HabitRow({ habit: h }: { habit: Habit }) {
  const styles = useStyles();
  const link = h.link === 'strong' ? 'strong link' : h.link === 'clear' ? 'clear link' : h.link === 'weak' ? 'weak link'
    : null;
  return (
    <View style={styles.habit}>
      <Text style={StyleSheet.flatten([styles.habitLabel, h.used && styles.bold])}>{h.label}</Text>
      <Text style={styles.habitValues}>
        typical {fmtHabit(h.typical, h.unit)} · quick {fmtHabit(h.quick, h.unit)} · fastest lap{' '}
        {fmtHabit(h.fastest_lap, h.unit)}
        {h.theoretical != null ? ` · theoretical ${fmtHabit(h.theoretical, h.unit)}` : ''}
      </Text>
      {(link || h.worth_s != null) && (
        <Text style={styles.small}>
          {link ?? ''}
          {h.worth_s != null && h.worth_s >= 0.005 ? `${link ? ', ' : ''}worth ${s2(h.worth_s)}` : ''}
        </Text>
      )}
    </View>
  );
}

function SectionSpeed({ section: s, report }: { section: SectionReport; report: Report }) {
  const c = useChartColors();
  const step = report.trace.step_m;
  const i0 = Math.max(0, Math.floor(s.start_m / step));
  const i1 = Math.min(report.trace.typical.length - 1, Math.ceil(s.end_m / step));
  const x = useMemo(() => Array.from({ length: i1 - i0 + 1 }, (_, k) => (i0 + k) * step), [i0, i1, step]);
  const cut = (v: number[]) => v.slice(i0, i1 + 1);
  const series: LineSeries[] = [
    { key: 'theoretical', label: 'Theoretical', values: cut(report.trace.theoretical), color: c.s3 },
    { key: 'typical', label: 'Typical pass', values: cut(report.trace.typical), color: c.s2 },
    { key: 'quick', label: 'Quick passes', values: cut(report.trace.quick), color: c.s1 },
  ];
  const markers = report.corners.filter((k) => k.at_m >= s.start_m && k.at_m <= s.end_m)
    .map((k) => ({ at: k.at_m, label: k.code }));
  return (
    <LineChart
      x={x}
      series={series}
      legend={[...series].reverse().map((v) => ({ label: v.label, color: v.color }))}
      height={170}
      unit="metres from the line"
      formatX={(v) => `${Math.round(v)} m`}
      formatY={(v) => `${Math.round(v)}`}
      markers={markers}
      title="Speed through the section (km/h)"
      readout={(i) => [...series].reverse().map((v) => ({
        label: v.label, color: v.color, value: v.values[i] != null ? `${v.values[i]!.toFixed(1)} km/h` : '–',
      }))}
    />
  );
}

// ---------- trends and consistency ----------

function Trends({ report, names }: { report: Report; names: RunNamer }) {
  const styles = useStyles();
  const c = useChartColors();
  const tr = report.trends;
  const byRun = useMemo(() => {
    const m = new Map<string, LapRow[]>();
    for (const l of tr.laps) m.set(l.run, [...(m.get(l.run) ?? []), l]);
    return m;
  }, [tr.laps]);
  const longest = Math.max(...[...byRun.values()].map((ls) => ls.length), 0);
  const x = Array.from({ length: longest }, (_, i) => i + 1);
  const runs: LineSeries[] = [...byRun.entries()].map(([run, ls]) => ({
    key: run, label: names.name(run), muted: true, width: 1, color: c.muted,
    values: x.map((_, i) => ls.find((l) => l.index_in_run === i)?.time ?? null),
  }));
  const median = x.map((_, i) => {
    const vs = runs.map((r) => r.values[i]).filter((v): v is number => v != null).sort((a, b) => a - b);
    if (vs.length < Math.min(3, runs.length)) return null;
    return vs.length % 2 ? vs[(vs.length - 1) / 2] : (vs[vs.length / 2 - 1] + vs[vs.length / 2]) / 2;
  });
  const spreadTop = Math.max(...tr.spread.map((s) => s.spread_s), 0.001);
  return (
    <View style={styles.block}>
      <ScrollView horizontal contentContainerStyle={styles.tableScroll}>
        <View style={styles.table}>
          <View style={styles.thRow}>
            <Text style={StyleSheet.flatten([styles.th, styles.runCol])}>Session</Text>
            <Text style={styles.th}>Laps</Text>
            <Text style={styles.th}>Best</Text>
            <Text style={styles.th}>Median</Text>
            <Text style={styles.th}>Consistency</Text>
            <Text style={styles.th}>Score</Text>
          </View>
          {tr.runs.map((r) => (
            <View key={r.run} style={styles.tr}>
              <Text style={StyleSheet.flatten([styles.td, styles.runCol])} numberOfLines={1}>
                {names.name(r.run, r.session_id)}
                {withDriver(names.name(r.run, r.session_id), r.driver)}
              </Text>
              <Text style={styles.td}>{r.clean_laps}</Text>
              <Text style={styles.td}>{formatLap(r.best)}</Text>
              <Text style={styles.td}>{formatLap(r.median)}</Text>
              <Text style={styles.td}>{r.consistency != null ? `${r.consistency.toFixed(1)}%` : '–'}</Text>
              <Text style={styles.td}>{r.extraction.toFixed(1)}%</Text>
            </View>
          ))}
        </View>
      </ScrollView>
      <Text style={styles.note}>
        Consistency is 100% when every clean lap matches the session&apos;s best, 10 points off for each 1% the median
        lap is slower; score is the best lap&apos;s share of the theoretical pace.
        {tr.consistency != null ? ` Across all ${report.laps_analysed} laps: ${tr.consistency.toFixed(1)}%.` : ''}
      </Text>
      {longest >= 2 && (
        <LineChart
          x={x}
          series={[...runs, { key: 'median', label: 'Median', values: median, color: c.s1 }]}
          legend={[{ label: 'Each session', color: c.muted }, { label: 'Median of all sessions', color: c.s1 }]}
          height={200}
          unit="clean laps into the session"
          formatX={(v) => `lap ${v}`}
          formatY={lapTick}
          title="Lap times through a session"
          readout={(i) => {
            const vs = runs.filter((r) => r.values[i] != null).map((r) => ({ run: r.key, v: r.values[i] as number }));
            const rows = [];
            if (median[i] != null) rows.push({ label: 'median', value: formatLap(median[i]), color: c.s1 });
            if (vs.length) {
              // which run: by its name in short ("FP1 S1"), never a number
              const quickest = vs.reduce((a, b) => (b.v < a.v ? b : a));
              const slowest = vs.reduce((a, b) => (b.v > a.v ? b : a));
              rows.push({ label: `quickest · ${names.short(quickest.run)}`, value: formatLap(quickest.v), color: c.muted });
              if (vs.length > 1) {
                rows.push({ label: `slowest · ${names.short(slowest.run)}`, value: formatLap(slowest.v), color: c.muted });
              }
            }
            rows.push({ label: vs.length === 1 ? 'session' : 'sessions', value: String(vs.length), color: c.muted });
            return rows;
          }}
        />
      )}
      <Text style={styles.h4}>Where lap times vary most</Text>
      <Text style={styles.note}>
        The middle half of all passes of each section, quickest to slowest: the most to gain from doing the same thing
        every lap.
      </Text>
      <Bars rows={tr.spread.slice(0, 5).map((s) => ({ label: s.code, value: s.spread_s }))} max={spreadTop} />
    </View>
  );
}

// ---------- what goes with lap time ----------

function Relations({ relations, laps }: { relations: Relation[]; laps: number }) {
  const styles = useStyles();
  if (relations.length === 0) {
    return (
      <Text style={styles.para}>
        {laps < 8 ? `With ${laps} clean laps it is too early to say what goes with lap time.`
          : 'Nothing in the car\'s state goes clearly with lap time: the time is in the driving above.'}
      </Text>
    );
  }
  const warm = relations.filter((r) => !r.warm_up);
  const warming = relations.filter((r) => r.warm_up);
  return (
    <View style={styles.block}>
      <Text style={styles.note}>
        Every clean lap&apos;s time against the car&apos;s state (tyres, traction control, ABS, temperatures) and the
        driving measures, strongest first. These show what goes with a quicker lap, not what causes it.
      </Text>
      {warm.length === 0 && (
        <Text style={styles.para}>
          Once the car is warm, from the third lap of a run, nothing in its state goes clearly with lap time: the time
          left is in the driving above.
        </Text>
      )}
      {warm.map((r) => <RelationRow key={`${r.source}-${r.label}`} r={r} />)}
      {warming.length > 0 && (
        <>
          <Text style={styles.h4}>Only over each run&apos;s first laps, while the car warms up</Text>
          {warming.map((r) => <RelationRow key={`${r.source}-${r.label}`} r={r} />)}
        </>
      )}
    </View>
  );
}

function RelationRow({ r }: { r: Relation }) {
  const styles = useStyles();
  return (
    <View style={styles.relation}>
      <Text style={styles.para}>{r.text}</Text>
      <Text style={styles.small}>
        {s2(r.seconds)} over the range seen · {r.sure} (r {r.r.toFixed(2)}, {r.n} laps) · {r.compared}
      </Text>
    </View>
  );
}

const useStyles = themed((c) => ({
  // text
  para: { fontFamily: Fonts.body, fontSize: 17, lineHeight: 25, color: c.text },
  note: { ...Type.dek, fontSize: 15, lineHeight: 21, color: c.textSecondary, marginTop: 6 },
  small: { fontFamily: Fonts.label, fontSize: 12, lineHeight: 16, color: c.textMuted },
  h4: { ...Type.label, fontSize: 13, color: c.text, borderTopWidth: 3, borderColor: c.rule, paddingTop: 6, marginTop: 6 },
  bold: { fontFamily: face700() },
  // a session left out: in the caption grey, not faded (it must still read at 4.5:1)
  dim: { color: c.textMuted },
  error: { color: c.error, marginTop: 16 },
  loading: { alignSelf: 'flex-start', marginVertical: 16 },
  summary: { fontFamily: Fonts.body, fontSize: 17, lineHeight: 25, color: c.text, marginTop: 22, maxWidth: 820 },
  banner: { gap: 8, marginTop: 16, borderTopWidth: 3, borderColor: c.rule, paddingTop: 10 },
  meter: { height: 10, borderWidth: 1 },

  // the scope bar
  scope: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: 16, rowGap: 8, paddingTop: 12,
    paddingBottom: 11, borderBottomWidth: 1, borderColor: c.rule },
  // the runs by name wrap within the page's width
  runs: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: 12, rowGap: 0, maxWidth: '100%' },
  daySplit: { width: 1, height: 16, backgroundColor: c.rule },
  // each run a 44 px tap target, its name and underline at the foot of it
  runHit: { minWidth: TAP, minHeight: TAP, justifyContent: 'flex-end', alignItems: 'flex-start' },
  run: { borderBottomWidth: 3, borderColor: 'transparent', paddingBottom: 1, backgroundColor: 'transparent' },
  runOn: { borderColor: c.mark },
  runText: { fontFamily: Fonts.display, fontSize: 18, lineHeight: 20, color: c.textMuted },
  runTextOn: { color: c.text },
  tech: { marginLeft: 'auto' },
  links: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: 20, rowGap: 8 },
  headLinks: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: 20, rowGap: 8, marginTop: 16 },

  // 01 the lap
  lapFeature: { flexDirection: 'row' },
  lapLeft: { flex: 1.55, paddingRight: 32, borderRightWidth: 1, borderColor: c.rule },
  lapRight: { flex: 1, paddingLeft: 32 },
  lapRightPhone: { borderTopWidth: 6, borderColor: c.rule, marginTop: 28, paddingTop: 10 },
  trio: { flexDirection: 'row', borderTopWidth: 1, borderColor: c.rule, marginTop: 26 },
  trioCell: { flex: 1, minWidth: 0, paddingTop: 12, paddingRight: 10 },
  trioNext: { paddingLeft: 12, borderLeftWidth: 1, borderColor: c.rule },
  scoreHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 8 },
  subscores: { marginTop: 18, borderTopWidth: 3, borderColor: c.rule },
  subscore: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingTop: 7, paddingBottom: 6, borderBottomWidth: 1,
    borderColor: c.separator },
  subName: { ...Type.label, width: 92, color: c.text },
  subTrack: { flex: 1, height: 12 },
  subValue: { ...Type.number, fontFamily: face700(), fontSize: 16, width: 56, textAlign: 'right', color: c.text },
  subNote: { marginTop: 6 },

  // 02 the gains
  gains: { flexDirection: 'row' },
  gain: { flex: 1, minWidth: 0, paddingHorizontal: 22, borderLeftWidth: 1, borderColor: c.rule },
  gainFirst: { flex: 1.35, paddingLeft: 0, borderLeftWidth: 0 },
  gainPhone: { paddingTop: 18, borderTopWidth: 3, borderColor: c.rule, marginTop: 18 },
  gainFirstPhone: { paddingTop: 0, borderTopWidth: 0, marginTop: 0 },
  gainHead: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 8 },
  rank: { backgroundColor: c.rule, paddingHorizontal: 8, paddingTop: 4, paddingBottom: 3 },
  rankText: { fontFamily: Fonts.display, fontSize: 20, lineHeight: 22, color: c.background },
  gainCode: { fontFamily: Fonts.display, fontSize: 34, lineHeight: 36, textTransform: 'uppercase', color: c.text },
  gainLead: { fontFamily: Fonts.body, fontWeight: '600', fontSize: 19, lineHeight: 25, marginTop: 14, color: c.text },
  bulletRow: { flexDirection: 'row', gap: 9, paddingVertical: 5, borderTopWidth: 1, borderColor: c.separator },
  bulletMark: { width: 7, height: 7, backgroundColor: c.rule, marginTop: 8 },
  bulletText: { flex: 1, fontFamily: Fonts.body, fontSize: 16, lineHeight: 22, color: c.text },
  gainWhere: { marginTop: 12 },

  // 03 section by section
  mapWrap: { flexDirection: 'row', gap: 32 },
  mapWrapPhone: { flexDirection: 'column', gap: 22 },
  mapSide: { flex: 1.7, minWidth: 0 },
  rankSide: { flex: 1, minWidth: 0 },
  mapTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', gap: 8, borderBottomWidth: 1,
    borderColor: c.rule, paddingBottom: 6 },
  lostRow: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: TAP, paddingTop: 6, paddingBottom: 5,
    borderBottomWidth: 1, borderColor: c.separator },
  lostOn: { backgroundColor: c.band },
  lostName: { fontFamily: Fonts.display, fontSize: 19, lineHeight: 21, width: 72, color: c.text },
  lostTrack: { flex: 1, height: 14 },
  lostValue: { ...Type.number, fontFamily: face700(), fontSize: 15, width: 48, textAlign: 'right', color: c.text },
  ramp: { flexDirection: 'row', marginTop: 14 },
  rampStep: { flex: 1 },
  rampCell: { height: 12, borderTopWidth: 1, borderBottomWidth: 1, borderColor: c.rule },
  rampFirst: { borderLeftWidth: 1 },
  rampLast: { borderRightWidth: 1 },
  rampText: { fontFamily: Fonts.label, fontSize: 12, marginTop: 3, color: c.text },

  // 04 where the time goes
  phaseLabels: { position: 'relative', height: 46, marginBottom: 6 },
  phaseLabelsBelow: { position: 'relative', height: 46, marginTop: 6 },
  phaseLabel: { position: 'absolute', top: 0 },
  phaseName: { ...Type.label, color: c.text },
  phaseValue: { fontFamily: Fonts.display, fontSize: 24, lineHeight: 26, color: c.text },
  phaseBar: { flexDirection: 'row', height: 64, gap: 2 },
  phaseBarPhone: { flexDirection: 'row', height: 44, gap: 2 },
  phaseList: { marginTop: 10 },
  phaseRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingTop: 6, paddingBottom: 5, borderBottomWidth: 1,
    borderColor: c.separator },
  phaseRowName: { ...Type.label, flex: 1, color: c.text },
  phaseRowValue: { fontFamily: Fonts.display, fontSize: 20, lineHeight: 22, color: c.text },
  story: { flexDirection: 'row', gap: 32, marginTop: 26 },
  storyPhone: { flexDirection: 'column', gap: 20, marginTop: 20 },
  storyBody: { flex: 1.6, fontFamily: Fonts.body, fontSize: 18, lineHeight: 28, color: c.text },
  storyBodyPhone: { fontFamily: Fonts.body, fontSize: 17, lineHeight: 26, color: c.text },
  pull: { flex: 1, borderLeftWidth: 10, paddingLeft: 18 },
  pullLabel: { marginBottom: 8 },
  pullQuote: { fontFamily: Fonts.display, fontSize: 42, lineHeight: 44, textTransform: 'uppercase', color: c.text },
  pullQuotePhone: { fontFamily: Fonts.display, fontSize: 34, lineHeight: 36, textTransform: 'uppercase', color: c.text },

  // corner by corner
  card: { gap: 10, borderTopWidth: 3, borderColor: c.rule, paddingTop: 10, marginTop: 18 },
  cardHead: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  cardTone: { width: 16, height: 16, borderWidth: 1, borderColor: c.rule },
  // the corner's name: a 44 px tap target, the head laid out as drawn
  cardCodeLink: { flex: 1, ...tapRoom(4) },
  cardCode: { fontFamily: Fonts.display, fontSize: 34, lineHeight: 36, textTransform: 'uppercase', color: c.text },
  cardGain: { ...Type.number, fontFamily: face700(), fontSize: 17, color: c.text },
  cardHeadline: { fontFamily: Fonts.body, fontWeight: '600', fontSize: 19, lineHeight: 25, color: c.text },
  row: { flexDirection: 'row', gap: 32, alignItems: 'flex-start' },
  column: { gap: 16 },
  half: { flex: 1, minWidth: 0, gap: 12 },
  block: { gap: 8 },
  times: { ...Type.number, fontSize: 14, lineHeight: 20, color: c.text },
  habit: { gap: 1, paddingVertical: 5, borderBottomWidth: 1, borderColor: c.separator },
  habitLabel: { fontFamily: Fonts.body, fontSize: 16, color: c.text },
  habitValues: { ...Type.number, fontSize: 13, color: c.textSecondary },

  // tables and rows
  tableScroll: { flexGrow: 1 },
  table: { flex: 1, minWidth: 560 },
  thRow: { flexDirection: 'row', paddingBottom: 5, borderBottomWidth: 1, borderColor: c.rule, gap: 6 },
  tr: { flexDirection: 'row', paddingVertical: 6, borderBottomWidth: 1, borderColor: c.separator, gap: 6 },
  th: { ...Type.label, flex: 1, fontSize: 13, color: c.textSecondary, textAlign: 'right' },
  td: { ...Type.number, flex: 1, fontSize: 14, textAlign: 'right', color: c.text },
  runCol: { flex: 2, textAlign: 'left' },
  relation: { gap: 2, paddingVertical: 8, borderBottomWidth: 1, borderColor: c.separator },
  rows: { gap: 0 },
  sessionRow: { paddingVertical: 9, borderBottomWidth: 1, borderColor: c.separator, gap: 2 },
  sessionName: { fontFamily: face700(), fontSize: 17, letterSpacing: 0.3, color: c.text },
  sessionMeta: { fontFamily: Fonts.label, fontSize: 13, color: c.textSecondary },
  method: { fontFamily: Fonts.body, fontSize: 15, lineHeight: 22, color: c.textSecondary, paddingVertical: 4 },
  quali: { marginTop: 16 },
}));

function face700() {
  return Type.label.fontFamily as string;
}
