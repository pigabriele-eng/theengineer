import { Link, Stack, useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, useWindowDimensions } from 'react-native';

import { useLapColors } from '@/components/CompareViews';
import { DeleteEvent } from '@/components/DeleteEvent';
import { DeleteRuns, deletedLine } from '@/components/DeleteRuns';
import { DriverGuessLine, useDriverGuess } from '@/components/DriverGuess';
import { DriverTag } from '@/components/DriverTag';
import { ErrorLine, Note, Said, Tick } from '@/components/Controls';
import { EventCompare, Pick, RunKey } from '@/components/EventCompare';
import { EventForm } from '@/components/EventForm';
import { HeroCountry } from '@/components/Flag';
import { MoveSessions } from '@/components/MoveSessions';
import { Tabs } from '@/components/Picks';
import {
  B, Colophon, Fig, Folio, Hero, Label, Page, Section, Swatch, TextLink, useGutter, useWide,
} from '@/components/Programme';
import PrintButton from '@/components/PrintButton';
import { RenameEvent } from '@/components/RenameEvent';
import { ResultsPanel } from '@/components/ResultsPanel';
import { RunNameQuestions } from '@/components/RunNames';
import { byTouch, closesRows, RunLinks, RunPanel, SwipeRow, useRunActions } from '@/components/RunActions';
import { SeasonMatch } from '@/components/SeasonMatch';
import {
  filledNote, localPick, PickerKind, RunChips, RunNameEditor, RunPicker, useEventDrivers, useGarage,
} from '@/components/RunChips';
import { Text, View } from '@/components/Themed';
import { TyreChoices, TyreTag, TyreTags, useTyreTags } from '@/components/TyreTag';
import CoachingDay from '@/components/coaching/CoachingDay';
import WeekendBefore from '@/components/weekend/Before';
import WeekendDuring from '@/components/weekend/During';
import WeekendLaps from '@/components/weekend/Laps';
import SessionReports, { useEventParts } from '@/components/weekend/SessionReports';
import EventReport from '@/components/report/EventReport';
import { formatLap, prefetch } from '@/lib/api';
import { todayIso, When, whenOf } from '@/lib/calendar';
import { MAX_LAPS } from '@/lib/compare';
import { countryOfAny } from '@/lib/countries';
import { DAY_GAP, dayColumns, MIN_EVENT_DAY } from '@/lib/dayColumns';
import { RunsDeleted } from '@/lib/deleteRuns';
import { dateRange, dayLabel, eventsApi, Folder, FolderSession, KIND_NAMES, NO_EVENT } from '@/lib/events';
import { EventGuess } from '@/lib/fingerprints';
import { Garage, garageApi, RunFields } from '@/lib/garage';
import { defaultStage, duringSections } from '@/lib/weekendRuns';
import { askedTab, openingTab, WeekendTab } from '@/lib/lapsFirst';
import { driverTag } from '@/lib/driverTag';
import { driverState } from '@/lib/runDriver';
import { encodePicks } from '@/lib/compare';
import { COACHING_SECTIONS } from '@/lib/coachingDay';
import { EventMode, fetchMode, setMode as saveMode } from '@/lib/eventModes';
import { noPrint } from '@/lib/print';
import { a11yState } from '@/lib/a11yState';
import { face, Fonts, PHOTOS, photoFor, TAP, tapRoom, themed, Type, useTheme } from '@/constants/Theme';

// A run row as the server sends it, with its driver and car ids
type Run = FolderSession & { driver_id?: number | null; car_id?: number | null };
// What opens in the band under the event's links: one at a time
type Panel = 'rename' | 'edit' | 'delete' | 'move' | 'delete runs';
// A race weekend's three stages (Gabriele, 2026-10-07): getting ready for it, while it is on, and after it (the runs
// to compare and the full report)

const freeSlot = (picks: Pick[]) => [0, 1, 2, 3, 4, 5].find((s) => !picks.some((p) => p.slot === s)) ?? 0;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** One event as a race programme: its track on the photo with the event's facts under it, the links to its report and
 * analyses (the Prediction, and Predicted vs actual once the weekend has begun), then numbered sections: its runs by
 * day (each with its driver, tyres, best lap and the gap to the event's best), any two to six runs side by side and its
 * official results (runs come from logs, uploaded on the Upload page). Runs are relabelled, tagged, ticked and moved
 * here. /event/none holds the runs in no event. ?compare=3,12 keeps the runs side by side in the address. */
export default function EventScreen() {
  const styles = useStyles();
  const wide = useWide();
  const gutter = useGutter();
  const { width } = useWindowDimensions();
  const params = useLocalSearchParams<{ id: string; compare?: string; stage?: string; car?: string }>();
  const key = params.id === NO_EVENT ? NO_EVENT : String(Number(params.id));
  const router = useRouter();
  const [folder, setFolder] = useState<Folder | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [picks, setPicks] = useState<Pick[]>(() =>
    (params.compare ?? '').split(',').map(Number).filter((n) => Number.isInteger(n) && n > 0)
      .filter((n, i, all) => all.indexOf(n) === i).slice(0, MAX_LAPS).map((id, slot) => ({ id, slot })));
  const [panel, setPanel] = useState<Panel | null>(null);
  const [editing, setEditing] = useState<number | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // the run whose driver list is open, and what a pick did to other runs (said under the run picked)
  const [open, setOpen] = useState<{ id: number; what: PickerKind } | null>(null);
  const [runNote, setRunNote] = useState<{ id: number; text: string } | null>(null);
  const { garage, reload: reloadGarage } = useGarage();
  // the event's drivers 1 to 4 (its info, else its season's entry), offered first in a run's driver list
  const eventDrivers = useEventDrivers(key === NO_EVENT ? null : Number(key));
  // a race weekend or a coaching day (lib/eventModes.ts): switched with one tap in the folio
  const [mode, setModeState] = useState<EventMode | null>(null);
  useEffect(() => {
    if (key === NO_EVENT) return;
    let live = true;
    // unknown (an older server): a race weekend, the default
    fetchMode(Number(key)).then((m) => live && setModeState(m), () => live && setModeState('weekend'));
    return () => {
      live = false;
    };
  }, [key]);
  const changeMode = (m: EventMode) => {
    if (key === NO_EVENT || m === mode) return;
    const was = mode;
    setModeState(m);
    saveMode(Number(key), m).then(setModeState, () => setModeState(was));
  };
  const scroll = useRef<ScrollView>(null);
  const topH = useRef(0); // the photo and its folio, above the page's body
  const compareY = useRef(0); // where Side by side starts in the body
  const reportY = useRef(0); // where the report starts in the body (After)
  const lapsY = useRef(0); // where the Laps tab starts in the body
  const [reportSections, setReportSections] = useState(0); // how many numbered sections the report has
  // how many times the event came from the server (not counting the chips' changes made here at once): what's
  // worked out from its runs is asked for again with it. 1 from the start, and still 1 once the event is first read
  // (nothing has changed since), so what needs only the event's number (who drove each run, the run names the
  // timetable can't place, the event's drivers) is asked for at once, and once a visit.
  const [reads, setReads] = useState(0);
  const version = Math.max(reads, 1);
  // who drove each run by driving style, asked again whenever the runs change (a driver set, a run added)
  const guess = useDriverGuess(key === NO_EVENT ? null : Number(key), version);
  // each run's tyres, on its row with one tap to change them: read with the event's runs (none for runs in no event)
  const tyreTags = useTyreTags(key === NO_EVENT ? null : Number(key), version);

  const loadNo = useRef(0); // the latest load: an older one's answer, coming in late, is dropped
  const load = useCallback(() => {
    const no = ++loadNo.current;
    eventsApi.folder(key).then(
      (f) => {
        if (no !== loadNo.current) return;
        setFolder(f);
        setReads((n) => n + 1);
        setError(null);
        const ids = new Set(f.days.flatMap((d) => d.sessions.map((s) => s.id)));
        setPicks((ps) => (ps.every((p) => ids.has(p.id)) ? ps : ps.filter((p) => ids.has(p.id))));
      },
      (e) => no === loadNo.current && setError((e as Error).message),
    );
  }, [key]);
  useFocusEffect(load);

  // the runs side by side stay in the address, so going to a run and back keeps them
  const pickKey = picks.map((p) => p.id).join(',');
  useEffect(() => {
    if ((params.compare ?? '') !== pickKey) router.setParams({ compare: pickKey || undefined });
  }, [pickKey]); // eslint-disable-line react-hooks/exhaustive-deps -- only when the picks change

  const sessions = useMemo(() => folder?.days.flatMap((d) => d.sessions) ?? [], [folder]);
  const toggle = (s: FolderSession) =>
    setPicks((ps) => {
      if (ps.some((p) => p.id === s.id)) return ps.filter((p) => p.id !== s.id);
      if (ps.length >= MAX_LAPS) return ps;
      return [...ps, { id: s.id, slot: freeSlot(ps) }];
    });
  const pickedColors = useLapColors(picks.map((p) => p.slot));
  const colorOf = (id: number) => {
    const i = picks.findIndex((p) => p.id === id);
    return i < 0 ? null : pickedColors.laps[i];
  };

  // one tap: the quickest run of each day (Friday's best against Sunday's, say)
  const bestOfDays = folder?.days
    .filter((d) => d.date)
    .map((d) => d.sessions.filter((s) => s.best_lap_s != null).sort((a, b) => a.best_lap_s! - b.best_lap_s!)[0])
    .filter((s): s is FolderSession => s != null)
    .slice(0, MAX_LAPS) ?? [];
  const showCompare = () =>
    scroll.current?.scrollTo({ y: Math.max(topH.current + compareY.current - 12, 0), animated: true });
  const showPanel = (p: Panel | null) => {
    setPanel(p);
    if (p) scroll.current?.scrollTo({ y: Math.max(topH.current - 12, 0), animated: true });
  };

  // a run's driver: the chip changes at once, the server's answer follows
  const patchRuns = (patch: (r: Run) => Run) =>
    setFolder((f) => f && { ...f, days: f.days.map((d) => ({ ...d, sessions: d.sessions.map((r) => patch(r as Run)) })) });
  const pickFor = async (s: Run, fields: RunFields) => {
    setOpen(null);
    const local = localPick(garage, fields);
    patchRuns((r) => (r.id === s.id ? { ...r, ...local } : r));
    try {
      const r = await garageApi.setRun(s.id, fields);
      const filled = new Set(r.filled);
      patchRuns((x) => (x.id === s.id ? { ...x, driver_id: r.driver_id, driver: r.driver, car_id: r.car_id }
        : filled.has(x.id) ? { ...x, car_id: r.car_id } : x));
      setReads((n) => n + 1); // the server has the run's driver and car: ask again for what follows from them
      const note = filledNote(r);
      setRunNote(note ? { id: s.id, text: note } : null);
      reloadGarage();
    } catch (e) {
      setRunNote({ id: s.id, text: (e as Error).message });
      load();
    }
  };

  const moveTo = async (toKey: string, toName: string) => {
    const ids = picks.map((p) => p.id);
    await eventsApi.move(toKey, ids);
    setPicks([]);
    setPanel(null);
    setNotice(`Moved ${plural(ids.length, 'run')} to ${toName}. Reports of both events are being worked out again.`);
    load();
  };
  const runsDeleted = (d: RunsDeleted) => {
    setPicks([]);
    setPanel(null);
    setNotice(deletedLine(d));
    load();
  };
  // one run deleted from its row (swiped, or held): the other ticks stay
  const runDeleted = (d: RunsDeleted) => {
    setPicks((ps) => ps.filter((p) => !d.deleted.includes(p.id)));
    setNotice(deletedLine(d));
    load();
  };

  const isEvent = key !== NO_EVENT;
  const eventId = isEvent ? Number(key) : null;
  const title = folder?.name ?? (isEvent ? 'Event' : 'Not in an event');
  const timed = sessions.some((s) => s.best_lap_s != null);
  // its country (the flag and three letters in the hero's kicker), from its track, else its name ("Monza test")
  const country = isEvent && folder ? countryOfAny([folder.track, folder.name]) : null;
  // a weekend opens on Laps while it is on (Gabriele, 2026-10-07: "Compare laps, during the weekend, should be the
  // standard function that opens when clicking on the event"), Before while it has no runs, After once it is over
  // (lib/weekendRuns.ts defaultStage, lib/lapsFirst.ts openingTab); a tap keeps the pick in the address
  const asked = askedTab(params.stage);
  const stage: WeekendTab = asked ?? openingTab(defaultStage(folder, todayIso()));
  // the stage is known once the event is read, or at once when the address asks for one
  const stageKnown = asked != null || folder != null;
  // Opened on no stage, the page waits for the event's runs to know which; meanwhile the reads that During and After
  // both make and that need only the event's number start (prefetch, lib/api.ts), so they don't wait for it too.
  useEffect(() => {
    if (!isEvent || asked != null || folder != null) return;
    prefetch(`/events/${key}/info`, `/results/events/${key}`, `/events/${key}/debriefs`, `/reports/events/${key}/parts`,
      `/events/${key}/compare/suggestions`);
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps -- once a visit, on opening
  const pickStage = (s: WeekendTab) => router.setParams({ stage: s });
  // a coaching day opens on its own answers (components/coaching/CoachingDay.tsx): no Laps, Before, During and After
  const coaching = isEvent && mode === 'coaching';
  const laps = isEvent && !coaching && stage === 'laps';
  const during = isEvent && !coaching && stage === 'during';
  const after = isEvent && !coaching && stage === 'after';
  // the runs by day are part of During and After, and follow a coaching day's answers
  const showRuns = !isEvent || during || after || coaching;
  // After's session reports and its report's switcher both list the official sessions: read once, here
  const eventParts = useEventParts(after ? eventId : null);

  // ---------- the photo and the folio ----------

  const top = folder ? (
    <View onLayout={(e) => (topH.current = e.nativeEvent.layout.height)}>
      <Hero photo={isEvent ? photoFor(folder.track) : PHOTOS.dusk} tag={isEvent ? TAG[whenOf(folder, todayIso())] : 'Unfiled'}
        rest={coaching ? 'Coaching' : 'Weekend'} restHref={coaching ? '/coaching' : '/'} title={headlineOf(folder, isEvent)} deck={deckOf(folder, isEvent)}
        // a lower photo than other pages: the weekend page is read for its answers, which start under it
        height={wide ? 320 : 290} badge={country ? <HeroCountry country={country} /> : undefined} />
      <Folio items={isEvent ? [
        folder.track,
        dateRange(folder.start, folder.end),
        !folder.dates_by_hand && folder.log_start ? 'Dates from the logs' : null,
        folder.sessions > 0 ? <><B>{folder.sessions}</B> runs · <B>{folder.clean_laps}</B> clean laps</> : 'No runs yet',
        folder.best_lap_s != null ? <>Best <B>{formatLap(folder.best_lap_s)}</B></> : null,
        mode && <ModeSwitch mode={mode} onChange={changeMode} />,
      ] : [<><B>{folder.sessions}</B> run{folder.sessions === 1 ? '' : 's'} in no event</>]} />
    </View>
  ) : undefined;

  // ---------- the stage tabs, and the band under them ----------

  // Laps | Before | During | After, and print: nothing else to choose from first (every analysis is in the
  // section it belongs to, or in the More line at the end); a coaching day has none of them
  const stageBar = isEvent && mode != null && !coaching && eventId != null && folder && (
    <View style={wide ? styles.links : styles.linksPhone}>
      <Tabs big value={stage} onChange={pickStage} items={[
        { key: 'laps', label: 'Laps', sub: 'Compare' },
        { key: 'before', label: 'Before', sub: 'Prep' },
        { key: 'during', label: 'During', sub: sessions.length ? plural(sessions.length, 'run') : 'No runs yet' },
        { key: 'after', label: 'After', sub: 'Compare, report' },
      ]} />
      <View style={wide ? styles.manage : styles.managePhone} {...noPrint}>
        {/* the whole-event report is for after the weekend (Gabriele, 2026-10-07): it is in After, not here */}
        <PrintButton title={['Event', folder.name, folder.track].filter(Boolean).join(' · ')} />
      </View>
    </View>
  );

  // The rest of what the event offers, in one line at the end of the page: the analyses and the event's own actions.
  const more = isEvent && eventId != null && folder && (
    <View style={styles.more} {...noPrint}>
      <Label>More</Label>
      <View style={styles.moreLinks}>
        {(after || coaching) && timed && <TextLink href={{ pathname: '/report', params: { event: eventId } }} label="Full report" arrow small />}
        {timed && <TextLink href={{ pathname: '/technique', params: { event: eventId } }} label="Technique check" arrow small />}
        {timed && <TextLink href={{ pathname: '/quali', params: { event: eventId } }} label="Quali prep" arrow small />}
        {timed && <TextLink href={{ pathname: '/tools/stint', params: { event: eventId } }} label="Stint analysis" arrow small />}
        {timed && <TextLink href={{ pathname: '/drivers/compare', params: { event: eventId } }} label="Compare drivers" arrow small />}
        {timed && <TextLink href="/drivers/fingerprints" label="Driver fingerprints" arrow small />}
        <TextLink href={{ pathname: '/prediction', params: { event: eventId } }} label="Prediction" arrow small />
        {whenOf(folder, todayIso()) !== 'upcoming' && (
          <TextLink href={{ pathname: '/prediction', params: { event: eventId, view: 'actual' } }}
            label="Predicted vs actual" arrow small />
        )}
      </View>
      <View style={styles.moreLinks}>
        <TextLink onPress={() => showPanel(panel === 'rename' ? null : 'rename')} label="Rename" small />
        <TextLink onPress={() => showPanel(panel === 'edit' ? null : 'edit')} label="Change dates" small />
        <TextLink onPress={() => showPanel(panel === 'delete' ? null : 'delete')} label="Delete logs or event" small />
      </View>
    </View>
  );

  // Before the weekend: the prep report itself (the lap to aim for, corner by corner, grip, the setups run),
  // at once when the address asks for Before
  const before = isEvent && mode != null && eventId != null && stageKnown && !during && !laps && !coaching && (
    <WeekendBefore eventId={eventId} car={params.car ?? null} />
  );

  // While the weekend is on: the laps to compare first, the first suggestion already open, every lap to pick by hand
  // (components/weekend/Laps.tsx). A suggestion tapped scrolls down to its comparison.
  const lapsTab = laps && eventId != null && (
    <View onLayout={(e) => (lapsY.current = e.nativeEvent.layout.y)}>
      <WeekendLaps eventId={eventId} version={version} onRunDeleted={runDeleted} onRunRenamed={load}
        onShow={(y) => scroll.current?.scrollTo({ y: Math.max(topH.current + lapsY.current + y - 12, 0), animated: true })} />
    </View>
  );

  // One panel at a time in a ruled band under the links: rename, change the dates, delete the event, move or delete
  // the ticked runs.
  const band = folder && panel && (
    <View style={styles.band} {...noPrint}>
      {panel === 'rename' && eventId != null && (
        <>
          <Label>Rename the event</Label>
          <RenameEvent id={eventId} initial={folder.name} large onCancel={() => setPanel(null)}
            onSaved={(f) => {
              setFolder(f);
              setReads((n) => n + 1);
              setPanel(null);
            }} />
        </>
      )}
      {panel === 'edit' && eventId != null && (
        <>
          <Label>Change the dates</Label>
          <EventForm
            initial={{ name: folder.name, start: folder.dates_by_hand ? folder.start : null,
              end: folder.dates_by_hand ? folder.end : null }}
            datesHint={folder.log_start
              ? `Leave the dates empty to take them from the logs (${dateRange(folder.log_start, folder.log_end)}).`
              : 'Leave the dates empty to take them from the logs.'}
            submitLabel="Save"
            onCancel={() => setPanel(null)}
            onSubmit={async (v) => {
              setFolder(await eventsApi.update(eventId, v));
              setReads((n) => n + 1);
              setPanel(null);
            }}
          />
        </>
      )}
      {panel === 'delete' && eventId != null && (
        <DeleteEvent id={eventId} name={folder.name} onCancel={() => setPanel(null)}
          onDeleted={(how, said) => {
            if (how !== 'empty') return router.replace('/');
            // its runs went, the event stays: said here, the page empty for the right logs
            setPicks([]);
            setPanel(null);
            setNotice(said ?? null);
            load();
          }} />
      )}
      {panel === 'move' && picks.length > 0 && (
        <MoveSessions fromKey={key} count={picks.length} onMove={moveTo} onCancel={() => setPanel(null)} />
      )}
      {panel === 'delete runs' && picks.length > 0 && (
        <DeleteRuns ids={picks.map((p) => p.id)}
          names={picks.map((p) => sessions.find((s) => s.id === p.id)?.name ?? `Run ${p.id}`)} inEvent={isEvent}
          onDeleted={runsDeleted} onCancel={() => setPanel(null)} />
      )}
    </View>
  );

  // The questions about the event's season (or who drove it), when the server isn't sure: under the band, above the
  // runs. Nothing when there are none.
  const seasonQuestion = eventId != null && <SeasonMatch eventId={eventId} onChanged={load} style={styles.season} />;
  // runs the official timetable can't place by itself: "Which session was 03_Q?"
  const runNameQuestion = eventId != null && <RunNameQuestions eventId={eventId} folder={version} onChanged={load} style={styles.season} />;

  // ---------- the sections ----------

  // three or four days side by side across the page, two a row when the window is too narrow for that many columns
  const cols = dayColumns(folder?.days.length ?? 0, width, wide, gutter, MIN_EVENT_DAY);
  const daysStyle = cols === 'across' ? styles.daysAcross : cols === 'half' ? styles.daysHalf
    : wide ? styles.days : styles.daysPhone;
  const dayStyle = cols === 'across' ? styles.dayAcross : cols === 'half' ? styles.dayHalf : wide ? styles.day : undefined;

  // During's own sections come first (lib/weekendRuns.ts duringSections), a coaching day's answers likewise
  // (lib/coachingDay.ts COACHING_SECTIONS); Before is the prep report alone; After opens on the session reports, then
  // the runs
  let no = coaching ? COACHING_SECTIONS : during ? duringSections(folder) : 0;
  // each official session's report (FP1, Q1, R1), at the top of After (in During, among its own sections)
  const sessionReports = after && eventId != null && (
    <Section no={++no} title="Session reports"
      dek="One report per session of the weekend (FP1, Q1, the races), from every run of it; the whole weekend’s is below the runs.">
      <SessionReports eventId={eventId} parts={eventParts} />
    </Section>
  );
  const runs = folder && showRuns && (
    <Section no={++no} title="Runs" dek={(isEvent
      ? 'Day by day, each with its driver and best lap. Tick two to six, then Compare laps at the foot of the screen; tap a name to rename it, a best lap to open the run.'
      : 'Runs filed in no event. Tick them, then Move to put them into one, or Delete to remove them for good.')
      + (byTouch ? ' Swipe a run left to delete it, or hold it for more.' : '')}>
      {sessions.length > 0 && isEvent && <Figures folder={folder} />}
      <View style={daysStyle}>
        {folder.days.map((d) => {
          const first = sessions.indexOf(d.sessions[0]);
          return (
            <View key={d.date ?? 'none'} style={dayStyle}>
              <DayHead days={folder.days} date={d.date} />
              {d.sessions.map((s, i) => (
                <SessionRow key={s.id} s={s} no={first + i + 1} color={colorOf(s.id)} picked={picks.some((p) => p.id === s.id)}
                  eventBest={folder.best_lap_s} maxGap={maxGapOf(sessions, folder.best_lap_s)}
                  full={picks.length >= MAX_LAPS} onToggle={() => toggle(s)} editing={editing === s.id}
                  onEdit={() => setEditing(editing === s.id ? null : s.id)}
                  onSaved={() => {
                    setEditing(null);
                    load();
                  }}
                  garage={garage} eventDrivers={eventDrivers} open={open?.id === s.id ? open.what : null}
                  onOpen={(what) => setOpen(what ? { id: s.id, what } : null)} onPick={(fields) => pickFor(s, fields)}
                  note={runNote?.id === s.id ? runNote.text : null} onNoteClose={() => setRunNote(null)}
                  guess={guess?.sessions.find((g) => g.session_id === s.id)} guessMode={guess?.mode}
                  inEvent={isEvent} onDeleted={runDeleted} tags={isEvent ? tyreTags : null} />
              ))}
            </View>
          );
        })}
      </View>
      {timed && <Legend />}
      {isEvent && bestOfDays.length >= 2 && picks.length === 0 && (
        <View style={styles.quick} {...noPrint}>
          <TextLink onPress={() => setPicks(bestOfDays.map((s, slot) => ({ id: s.id, slot })))}
            label="Tick the quickest run of each day" arrow small />
          <Text style={styles.quickRuns}>{bestOfDays.map((s) => s.name).join(' · ')}</Text>
        </View>
      )}
      {sessions.length === 0 && (
        <Note style={styles.empty}>
          {isEvent
            ? 'No runs in this event yet. Upload its logs on the Upload page, or move runs here from another event.'
            : 'Every run is in an event.'}
        </Note>
      )}
    </Section>
  );

  // the ticked runs' lap times, sections, top speed and tyres, next to each other (what the lap comparison doesn't
  // show): only once two are ticked
  const sideBySide = folder && showRuns && picks.length >= 2 && (
    <Section no={++no} title="Side by side" onLayout={(e) => (compareY.current = e.nativeEvent.layout.y)}
      dek="The ticked runs next to each other: lap times, the best time in each section, top speed, tyres.">
      <EventCompare folderKey={key} picks={picks} onClear={() => setPicks([])} />
    </Section>
  );

  // After the weekend: the full report, under the runs and their Compare bar, its sections numbered on from theirs
  // (components/report/EventReport.tsx). Tapping a section to see it on the map scrolls up to the map.
  const reportNo = no + 1;
  const report = after && eventId != null && stageKnown && (
    <View onLayout={(e) => (reportY.current = e.nativeEvent.layout.y)}>
      <EventReport eventId={eventId} embedded firstNo={reportNo} onSections={setReportSections} parts={eventParts}
        folder={folder} // the page's own read of the event: the report doesn't read it again
        onShowMap={(y) => scroll.current?.scrollTo({ y: Math.max(topH.current + reportY.current + y - 12, 0),
          animated: true })} />
    </View>
  );
  if (report) no += reportSections;

  // what the event was run with (tyre, car, team, drivers) comes from its season (Tools › Seasons): no section of its
  // own here (Gabriele, 2026-10-08: "remove event info")

  const results = eventId != null && (
    <Section no={++no} title="Results" dek="The official timing sheets of the round, with our car among them.">
      <ResultsPanel eventId={eventId} heading={false} />
    </Section>
  );

  // runs come only from logs, uploaded on the Upload page (Gabriele, 2026-10-07: "remove upload window in the event
  // window"; 2026-10-08: "remove add a run by hand"): runs made by hand before still show among the others

  // the ticked runs' best laps, opened together on the lap comparison: one tap from the bar
  const tickedLaps = picks.map((p) => sessions.find((s) => s.id === p.id))
    .filter((s): s is FolderSession => s?.best_lap != null).map((s) => ({ session_id: s.id, lap: s.best_lap! }));
  const compareHref = tickedLaps.length >= 2 ? { pathname: '/compare' as const, params: { laps: encodePicks(tickedLaps) } } : null;

  return (
    <View style={styles.screen} {...closesRows}>
      <Stack.Screen options={{ title, headerShown: false }} />
      <Page top={top} scrollRef={scroll}>
        {!folder && !error && <ActivityIndicator style={styles.loading} />}
        {error && (
          <View style={styles.errorBox}>
            <ErrorLine>{folder ? error : `Can’t open this event: ${error}`}</ErrorLine>
            {!folder && <TextLink href="/" label="Weekend" arrow />}
          </View>
        )}
        {stageBar}
        {band}
        {notice && <View style={styles.notice}><Said text={notice} onPress={() => setNotice(null)} /></View>}
        {seasonQuestion}
        {runNameQuestion}
        {/* the mode decides what the page opens on: nothing until it is known, so a coaching day never shows a weekend
            first (a stage the address asks for waits for it too: it comes quicker than the event) */}
        {isEvent && mode == null ? (folder && <ActivityIndicator style={styles.loading} />) : coaching && eventId != null ? (
          <CoachingDay eventId={eventId} folder={folder}>
            {runs}
            {sideBySide}
            {results}
          </CoachingDay>
        ) : during && eventId != null ? (
          <WeekendDuring eventId={eventId} folder={folder}>
            {runs}
            {sideBySide}
            {results}
          </WeekendDuring>
        ) : after ? (
          <>
            {sessionReports}
            {runs}
            {sideBySide}
            {report}
            {results}
          </>
        ) : laps ? lapsTab : isEvent ? before : (
          <>
            {runs}
            {sideBySide}
          </>
        )}
        {more}
        {folder && (
          <Colophon left={`The Engineer · ${isEvent ? 'Event' : 'Unfiled runs'}`} links={[
            { label: 'Weekend', href: '/' },
            { label: 'Seasons', href: '/seasons' },
            { label: 'Garage', href: '/garage' },
          ]} />
        )}
      </Page>
      {picks.length > 0 && (
        <View style={styles.bar}>
          <View style={StyleSheet.flatten([styles.barInner, { paddingHorizontal: gutter }])}>
            <Text style={styles.barText}>
              {picks.length >= 2 ? plural(picks.length, 'run') : '1 run: tick another to compare'}
            </Text>
            {compareHref && <TextLink href={compareHref} label="Compare laps" red arrow />}
            {picks.length >= 2 && <TextLink onPress={showCompare} label="Side by side ↓" small />}
            <TextLink onPress={() => showPanel('move')} label="Move…" small />
            <TextLink onPress={() => showPanel('delete runs')} label="Delete…" small />
            <TextLink onPress={() => setPicks([])} label="Clear" small />
          </View>
        </View>
      )}
    </View>
  );
}

// ---------- words ----------

const TAG: Record<When, string> = { current: 'Current event', past: 'Past event', upcoming: 'Next event' };
const WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];
const inWords = (n: number) => WORDS[n] ?? String(n);
const pad2 = (n: number) => String(n).padStart(2, '0');

/** A track's short name for a headline: "Hockenheim" for the Hockenheimring, "Spa" for Circuit de Spa-Francorchamps. */
function shortTrack(track: string | null) {
  if (!track) return null;
  const t = track.replace(/^(Circuit|Circuito|Autodromo|Autódromo)( de| di| do| of)?\s+/i, '').trim();
  if (/^hockenheim/i.test(t)) return 'Hockenheim';
  return t.split(/\s*[,(]|\s+-\s+|-(?=[A-Z])/)[0];
}

/** What kind of event its runs make: a race weekend (qualifying or races), a practice, or a test. */
function kindOf(f: Folder): 'test' | 'practice' | 'weekend' {
  const kinds = new Set(f.days.flatMap((d) => d.sessions.map((s) => s.kind)));
  if (kinds.has('race') || kinds.has('qualifying')) return 'weekend';
  if (kinds.size) return kinds.has('test') ? 'test' : 'practice';
  return f.series ? 'weekend' : 'test';
}

/** The headline on the photo, as on the Sessions page: "Hockenheim test", "Zandvoort weekend"; else the event's name. */
function headlineOf(f: Folder, isEvent: boolean) {
  if (!isEvent) return 'Not in an event';
  const short = shortTrack(f.track);
  return short ? `${short} ${kindOf(f)}` : f.name;
}

/** The italic line under the headline: the event's name and what it holds. */
function deckOf(f: Folder, isEvent: boolean) {
  if (!isEvent) return f.sessions ? 'Runs filed in no event: tick them and move them into one.' : 'Every run is in an event.';
  const named = shortTrack(f.track) ? `${f.name}: ` : '';
  if (f.sessions === 0) return `${named}no runs yet. Upload its logs on the Upload page.`;
  const days = f.days.filter((d) => d.date).length;
  const runs = `${inWords(f.sessions)} run${f.sessions === 1 ? '' : 's'}${days ? ` over ${inWords(days)} day${days === 1 ? '' : 's'}` : ''}`;
  const line = `${runs}, ${plural(f.clean_laps, 'clean lap')}.`;
  return named ? `${named}${line}` : `${line[0].toUpperCase()}${line.slice(1)}`;
}

/** The biggest gap of a run's best lap to the event's best: the length of a full gap bar. */
function maxGapOf(runs: FolderSession[], best: number | null) {
  return Math.max(0.5, ...runs.map((s) => (s.best_lap_s != null && best != null ? s.best_lap_s - best : 0)));
}

// ---------- race weekend or coaching day ----------

const MODES: { key: EventMode; label: string }[] = [
  { key: 'weekend', label: 'Race weekend' },
  { key: 'coaching', label: 'Coaching day' },
];

// the folio's 13 px words are 13 to 17 px tall: room above and below to a tap target's height
const MODE_ROOM = Math.ceil((TAP - 13) / 2);

/** The event's mode in the folio, one tap to switch: the one it is in bold over a red underline. Words in a line of
 * text (a folio item is text), each a button. */
function ModeSwitch({ mode, onChange }: { mode: EventMode; onChange: (m: EventMode) => void }) {
  const styles = useStyles();
  return (
    <Text accessibilityRole="radiogroup" accessibilityLabel="What this event is">
      {MODES.map((m, i) => (
        <Text key={m.key}>
          {i > 0 ? ' / ' : ''}
          <Text onPress={() => onChange(m.key)} accessibilityRole="radio" {...a11yState({ checked: m.key === mode })}
            style={m.key === mode ? styles.modeOn : styles.modeOff}>{m.label}</Text>
        </Text>
      ))}
    </Text>
  );
}

// ---------- the event's figures ----------

/** The event in big figures: its best lap over a purple bar (the run and day it came from under it), its clean laps
 * and runs. In a strip split by ink rules on a wide screen; the best lap across the page, the others in a pair, on a
 * phone. */
function Figures({ folder }: { folder: Folder }) {
  const styles = useStyles();
  const wide = useWide();
  const c = useTheme();
  const best = folder.best_lap_s;
  const bestRun = folder.days.flatMap((d) => d.sessions).find((s) => s.id === folder.best_session_id);
  const days = folder.days.filter((d) => d.date).length;
  const note = bestRun ? [`${bestRun.name}, lap ${bestRun.best_lap ?? '?'}`, bestRun.date
    ? `${dayLabel(bestRun.date, { long: true }).split(' ')[0]}${bestRun.time ? ` ${bestRun.time}` : ''}` : null]
    .filter(Boolean).join(' · ') : folder.best_session ?? undefined;
  const others = [
    { label: 'Clean laps', value: String(folder.clean_laps) },
    { label: 'Runs', value: String(folder.sessions) },
    days ? { label: days === 1 ? 'Day' : 'Days', value: String(days) } : null,
  ].filter((x): x is { label: string; value: string } => x != null);
  return (
    <View style={wide ? styles.figs : styles.figsPhone}>
      {best != null && (
        <View style={wide ? styles.figBest : styles.figBestPhone}>
          <Fig label="Best lap of the event" value={formatLap(best)} size={wide ? 88 : 80} bar={c.timing.best} note={note} />
        </View>
      )}
      <View style={wide ? styles.figRest : styles.figRestPhone}>
        {others.map((o, i) => (
          <View key={o.label} style={StyleSheet.flatten([wide ? styles.figCell : styles.figCellPhone,
            wide ? i === others.length - 1 && styles.figCellLast : i === 0 && styles.figCellFirst])}>
            <Fig label={o.label} value={o.value} size={wide ? 64 : 56} />
          </View>
        ))}
      </View>
    </View>
  );
}

function Legend() {
  const styles = useStyles();
  const c = useTheme();
  return (
    <View style={styles.legend}>
      <Swatch color={c.timing.best} label="Quickest of the event" />
      <Swatch color={c.timing.loss[2]} height={5} label="Gap to it" />
    </View>
  );
}

function DayHead({ days, date }: { days: Folder['days']; date: string | null }) {
  const styles = useStyles();
  const n = date ? days.filter((d) => d.date && d.date <= date).length : 0;
  return (
    <View style={styles.dayHead}>
      <Label>{date ? `Day ${n}` : 'Date not known'}</Label>
      {date ? <Label>{dayLabel(date, { long: true })}</Label> : null}
    </View>
  );
}

// ---------- one run ----------

/** One run: tick it for side by side, tap its name (or Rename) to rename it in place, its driver to set it, its tyres
 * to change them (the four levels open under it), its best lap (a purple block for the event's best, else a red bar
 * for the gap to it) or its laps to open it, and Rename and Delete under its best lap. Swiped left it shows Delete too; held, a menu of
 * Delete, Change driver, Rename and Tyres (components/RunActions.tsx; Tyres opens the same four levels). */
function SessionRow({ s, no, color, eventBest, maxGap, picked, full, onToggle, editing, onEdit, onSaved, garage,
  eventDrivers, open, onOpen, onPick, note, onNoteClose, guess, guessMode, inEvent, onDeleted, tags }: {
  s: Run;
  no: number;
  color: string | null; // its colour in side by side, when ticked
  eventBest: number | null;
  maxGap: number;
  picked: boolean;
  full: boolean;
  onToggle: () => void;
  editing: boolean;
  onEdit: () => void;
  onSaved: () => void;
  garage: Garage | null;
  eventDrivers: number[];
  open: PickerKind | null;
  onOpen: (what: PickerKind | null) => void;
  onPick: (fields: RunFields) => void;
  note: string | null;
  onNoteClose: () => void;
  guess?: EventGuess['sessions'][number]; // who the driving style says drove it
  guessMode?: EventGuess['mode'];
  inEvent: boolean;
  onDeleted: (d: RunsDeleted) => void;
  tags: TyreTags | null; // the event's tyres tags (none for runs in no event)
}) {
  const styles = useStyles();
  const wide = useWide();
  const c = useTheme();
  const run = useRunActions({ onDriver: () => onOpen('driver'), onRename: () => !editing && onEdit(),
    onTyres: inEvent && tags ? () => tags.show(s.id) : undefined });
  const detail = [
    KIND_NAMES[s.kind],
    s.log_session && !s.name.includes(s.log_session) ? s.log_session : null,
    s.time,
    s.laps ? `${plural(s.laps, 'lap')}${s.clean_laps !== s.laps ? ` (${s.clean_laps} clean)` : ''}` : s.has_log ? 'no laps' : 'no log',
  ].filter(Boolean).join(' · ');
  const href = { pathname: '/session/[id]', params: { id: s.id } } as const;
  const gap = s.best_lap_s != null && eventBest != null ? s.best_lap_s - eventBest : null;
  const isBest = gap != null && gap < 0.0005;
  return (
    <View style={styles.run}>
      <SwipeRow run={run} name={s.name} disabled={editing} bleed={RUN_PAD}>
        <View style={StyleSheet.flatten([styles.runLine, editing && styles.runLineEditing])}>
          <View style={styles.runTick}>
            <Tick on={picked} onPress={onToggle} disabled={full && !picked} label={`Side by side: ${s.name}`} />
          </View>
          <Text style={styles.runNo}>{pad2(no)}</Text>
          <View style={styles.runId}>
            {editing ? (
              <RunNameEditor id={s.id} name={s.name} kind={s.kind} logSession={s.log_session} onSaved={onSaved}
                onCancel={onEdit} save={(id, body) => eventsApi.updateSession(id, body)} />
            ) : (
              // the driver and the name together (the name shortened rather than parted from its driver), then the
              // tyres, on the same line where it has room, else under them
              <View style={styles.nameLine}>
                <View style={styles.nameWho}>
                  {color && <RunKey color={color} />}
                  <DriverTag tag={driverTag(driverState(s, guess, garage))} run={s.name} onPress={() => onOpen('driver')} />
                  <Pressable onPress={onEdit} accessibilityRole="button" accessibilityLabel={`Rename ${s.name}`}
                    style={styles.namePress} {...run.hold}>
                    <Text style={styles.runName} numberOfLines={1}>{s.name}</Text>
                    <Text style={styles.pencil}>✎</Text>
                  </Pressable>
                </View>
                {tags && <TyreTag tags={tags} id={s.id} run={s.name} />}
              </View>
            )}
            {/* words only: the run opens from its best lap, a target the row's height (a second, 17 px link to the
                same run was too small to tap) */}
            <Text style={styles.runSub} numberOfLines={2}>{detail}</Text>
            <RunChips run={s} garage={garage} open={open} onOpen={onOpen} />
            <DriverGuessLine guess={guess} mode={guessMode} onPick={onPick} onName={() => onOpen('driver')} />
          </View>
          {/* while the name is edited, the editor takes the row's width. Link asChild hands its child's style to a web
              anchor, which can't take a style array: one object */}
          {!editing && (
            <View style={styles.runEnd}>
            <Link href={href} asChild>
              <Pressable style={styles.runBest} accessibilityRole="link" accessibilityLabel={`Open ${s.name}`}
                {...run.hold} {...run.a11y}>
                {s.best_lap_s == null ? <Text style={styles.noLap}>no lap</Text> : (
                  <>
                    <View style={isBest ? { backgroundColor: c.timing.best } : undefined}>
                      <Text style={StyleSheet.flatten([styles.runTime, isBest && { color: c.timing.onBest }])}>
                        {formatLap(s.best_lap_s)}
                      </Text>
                    </View>
                    {isBest ? <Text style={StyleSheet.flatten([styles.gap, { color: c.timing.bestInk }])}>Event best</Text>
                      : gap != null && (
                        <>
                          <View style={{ height: 5, marginTop: 3, backgroundColor: c.timing.loss[2],
                            width: Math.max(3, Math.round((gap / maxGap) * 86)) }} />
                          <Text style={styles.gap}>+{gap.toFixed(2)}</Text>
                        </>
                      )}
                  </>
                )}
              </Pressable>
            </Link>
            {/* Rename and Delete in sight (Gabriele, 2026-10-09: "i still do not see a way to quickly remove runs",
                "give option to rename runs") */}
            <RunLinks run={run} name={s.name} renaming={editing} style={styles.runLinks} />
            </View>
          )}
        </View>
      </SwipeRow>
      <RunPanel run={run} id={s.id} name={s.name} inEvent={inEvent} onDeleted={onDeleted}
        style={wide ? styles.under : styles.underPhone} />
      {tags && <TyreChoices tags={tags} id={s.id} name={s.name} style={wide ? styles.under : styles.underPhone} />}
      {open && garage && (
        <View style={wide ? styles.under : styles.underPhone}>
          <RunPicker run={s} garage={garage} onPick={onPick} onClose={() => onOpen(null)}
            eventDrivers={eventDrivers} />
        </View>
      )}
      {note && (
        <View style={wide ? styles.under : styles.underPhone}>
          <Said text={note} onPress={onNoteClose} />
        </View>
      )}
    </View>
  );
}

// a run row's padding above and below its line (styles.run): its swipe fills it
const RUN_PAD = { top: 10, bottom: 9 };

const useStyles = themed((c) => ({
  screen: { flex: 1, backgroundColor: c.background },
  loading: { marginTop: 32, alignSelf: 'flex-start' },
  errorBox: { marginTop: 20, gap: 12 },

  // the event's links, and the band under them
  links: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: 22, rowGap: 12, paddingTop: 16 },
  linksPhone: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: 18, rowGap: 14, paddingTop: 14 },
  manage: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: 18, rowGap: 10, marginLeft: 'auto' },
  managePhone: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: 18, rowGap: 10, width: '100%',
    borderTopWidth: 1, borderColor: c.separator, paddingTop: 12 },
  // the mode switch: a tap target's height around the words (inline padding, the folio's height unchanged)
  modeOn: { fontFamily: Type.label.fontFamily, textDecorationLine: 'underline', textDecorationColor: c.mark,
    paddingVertical: MODE_ROOM },
  modeOff: { color: c.textSecondary, paddingVertical: MODE_ROOM },
  more: { marginTop: 40, borderTopWidth: 3, borderColor: c.rule, paddingTop: 10, gap: 14 },
  moreLinks: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: 22, rowGap: 14 },
  band: { marginTop: 20, borderTopWidth: 3, borderColor: c.rule, paddingTop: 10, gap: 12, maxWidth: 680 },
  confirm: { fontFamily: Fonts.body, fontSize: 17, lineHeight: 24, color: c.text },
  notice: { marginTop: 18, maxWidth: 720 },
  season: { marginTop: 22, maxWidth: 680 },

  // runs
  empty: { marginTop: 8 },
  figs: { flexDirection: 'row', alignItems: 'stretch', borderBottomWidth: 1, borderColor: c.rule, paddingBottom: 18,
    marginBottom: 26 },
  figsPhone: { borderBottomWidth: 1, borderColor: c.rule, paddingBottom: 14, marginBottom: 22, gap: 18 },
  figBest: { width: 380, paddingRight: 28, borderRightWidth: 1, borderColor: c.rule },
  figBestPhone: {},
  figRest: { flex: 1, flexDirection: 'row' },
  figRestPhone: { flexDirection: 'row', borderTopWidth: 1, borderColor: c.rule },
  figCell: { flex: 1, paddingHorizontal: 22, borderRightWidth: 1, borderColor: c.rule },
  figCellPhone: { flex: 1, paddingTop: 10, paddingHorizontal: 12, borderLeftWidth: 1, borderColor: c.rule },
  figCellFirst: { borderLeftWidth: 0, paddingLeft: 0 },
  figCellLast: { borderRightWidth: 0 },
  days: { flexDirection: 'row', flexWrap: 'wrap', columnGap: 32, rowGap: 28 },
  daysPhone: { flexDirection: 'column', gap: 24 },
  day: { flex: 1, minWidth: 340 },
  daysAcross: { flexDirection: 'row', columnGap: DAY_GAP },
  daysHalf: { flexDirection: 'row', flexWrap: 'wrap', columnGap: DAY_GAP, rowGap: 28 },
  dayAcross: { flexGrow: 1, flexShrink: 1, flexBasis: 0, minWidth: 0 },
  dayHalf: { flexBasis: '47%', flexGrow: 1, minWidth: 0 },
  dayHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', borderTopWidth: 3,
    borderBottomWidth: 1, borderColor: c.rule, paddingTop: 7, paddingBottom: 6 },
  legend: { flexDirection: 'row', flexWrap: 'wrap', columnGap: 22, rowGap: 8, alignItems: 'center', marginTop: 14 },

  run: { borderBottomWidth: 1, borderColor: c.separator, paddingTop: RUN_PAD.top, paddingBottom: RUN_PAD.bottom },
  runLine: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  runLineEditing: { alignItems: 'flex-start' },
  runTick: { paddingTop: 3 },
  runNo: { fontFamily: Fonts.display, fontSize: 24, lineHeight: 28, width: 30, color: c.text },
  runId: { flex: 1, minWidth: 0, gap: 3 },
  nameLine: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: 10, rowGap: 0 },
  nameWho: { flexDirection: 'row', alignItems: 'center', gap: 6, flexShrink: 1, minWidth: 0 },
  // Rename: the name's 23 px line with room to a 44 px target above and below; the run's details start under that room
  namePress: { flexDirection: 'row', alignItems: 'baseline', gap: 6, flexShrink: 1, minWidth: TAP, ...tapRoom(11) },
  runName: { fontFamily: Type.label.fontFamily, fontSize: 17, letterSpacing: 0.3, color: c.text, flexShrink: 1 },
  pencil: { fontFamily: Fonts.label, fontSize: 13, color: c.textMuted },
  runSub: { fontFamily: face('label', 400), fontSize: 13, lineHeight: 17, color: c.textSecondary, marginTop: 8 },
  // the run opens from here: as tall as the row, and never under a tap target's height
  runEnd: { width: 96, alignItems: 'flex-end', alignSelf: 'stretch' },
  runBest: { width: 96, alignItems: 'flex-end', flexGrow: 1, minHeight: TAP },
  // Rename over Delete: side by side they'd reach into the run's own lines on a phone
  runLinks: { flexDirection: 'column', alignItems: 'flex-end', gap: 0 },
  runTime: { fontFamily: Type.label.fontFamily, fontSize: 19, fontVariant: ['tabular-nums'], paddingHorizontal: 5,
    paddingVertical: 1, color: c.text },
  noLap: { fontFamily: face('label', 400), fontSize: 13, color: c.textMuted, paddingTop: 3 },
  gap: { fontFamily: Fonts.label, fontSize: 12, fontVariant: ['tabular-nums'], color: c.delta.loss, marginTop: 1 },
  under: { paddingLeft: 72, paddingTop: 8 },
  underPhone: { paddingLeft: 0, paddingTop: 8 },

  // side by side
  quick: { gap: 6 },
  quickRuns: { fontFamily: face('label', 400), fontSize: 13, color: c.textSecondary },

  // the ticked runs: a strip on the paper at the foot of the screen
  bar: { borderTopWidth: 3, borderColor: c.rule, backgroundColor: c.background, paddingVertical: 10 },
  barInner: { width: '100%', maxWidth: 1240, alignSelf: 'center', flexDirection: 'row',
    flexWrap: 'wrap', alignItems: 'center', columnGap: 20, rowGap: 8 },
  barText: { ...Type.label, fontFamily: Fonts.label, fontSize: 13, color: c.text, marginRight: 'auto' },
}));

