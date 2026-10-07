import { Link, Stack, useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet } from 'react-native';

import { useLapColors } from '@/components/CompareViews';
import { ErrorLine, FormActions, Input, MainButton, Note, Said, Tick } from '@/components/Controls';
import { EventCompare, Pick, RunKey } from '@/components/EventCompare';
import { EventForm } from '@/components/EventForm';
import { EventInfoCard } from '@/components/EventInfoCard';
import { ImportLogs } from '@/components/ImportLogs';
import { MoveSessions } from '@/components/MoveSessions';
import { PrepButton, usePrepAvailability } from '@/components/PrepButton';
import {
  B, Colophon, Fig, Folio, Hero, Label, Page, Section, Swatch, TextLink, useGutter, useWide,
} from '@/components/Programme';
import { RenameEvent } from '@/components/RenameEvent';
import { ResultsPanel } from '@/components/ResultsPanel';
import { filledNote, localPick, PickerKind, RunChips, RunNameEditor, RunPicker, useGarage } from '@/components/RunChips';
import { Text, View } from '@/components/Themed';
import { formatLap } from '@/lib/api';
import { todayIso, When, whenOf } from '@/lib/calendar';
import { MAX_LAPS } from '@/lib/compare';
import { dateRange, dayLabel, eventsApi, Folder, FolderSession, KIND_NAMES, NO_EVENT } from '@/lib/events';
import { Garage, garageApi, RunFields } from '@/lib/garage';
import { face, Fonts, PHOTOS, photoFor, themed, Type, useTheme } from '@/constants/Theme';

// A run row as the server sends it, with its driver and car ids
type Run = FolderSession & { driver_id?: number | null; car_id?: number | null };
// What opens in the band under the event's links: one at a time
type Panel = 'rename' | 'edit' | 'delete' | 'move';

const freeSlot = (picks: Pick[]) => [0, 1, 2, 3, 4, 5].find((s) => !picks.some((p) => p.slot === s)) ?? 0;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** One event as a race programme: its track on the photo with the event's facts under it, the links to its report and
 * analyses, then numbered sections: its runs by day (each with its best lap and the gap to the event's best), any two to
 * six runs side by side, what it was run with, its official results, and logs to upload into it. Runs are relabelled,
 * tagged, ticked and moved here. /event/none holds the runs in no event. ?compare=3,12 keeps the runs side by side in
 * the address. */
export default function EventScreen() {
  const styles = useStyles();
  const wide = useWide();
  const gutter = useGutter();
  const params = useLocalSearchParams<{ id: string; compare?: string }>();
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
  // the run whose driver or car list is open, and what a pick did to other runs (said under the run picked)
  const [open, setOpen] = useState<{ id: number; what: PickerKind } | null>(null);
  const [runNote, setRunNote] = useState<{ id: number; text: string } | null>(null);
  const { garage, reload: reloadGarage } = useGarage();
  const [eventDrivers, setEventDrivers] = useState<number[]>([]); // the event's drivers 1 to 4, offered first
  const [hasInfo, setHasInfo] = useState(true); // the server answers for the event's info (an older one doesn't)
  const scroll = useRef<ScrollView>(null);
  const topH = useRef(0); // the photo and its folio, above the page's body
  const compareY = useRef(0); // where Side by side starts in the body
  const prep = usePrepAvailability(); // events whose track has past data: the Prep report button

  const load = useCallback(() => {
    eventsApi.folder(key).then(
      (f) => {
        setFolder(f);
        setError(null);
        const ids = new Set(f.days.flatMap((d) => d.sessions.map((s) => s.id)));
        setPicks((ps) => (ps.every((p) => ids.has(p.id)) ? ps : ps.filter((p) => ids.has(p.id))));
      },
      (e) => setError((e as Error).message),
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
  const pickBestOfDays = () => {
    setPicks(bestOfDays.map((s, slot) => ({ id: s.id, slot })));
    setTimeout(() => showCompare(), 50);
  };
  const showCompare = () =>
    scroll.current?.scrollTo({ y: Math.max(topH.current + compareY.current - 12, 0), animated: true });
  const showPanel = (p: Panel | null) => {
    setPanel(p);
    if (p) scroll.current?.scrollTo({ y: Math.max(topH.current - 12, 0), animated: true });
  };

  // a run's driver or car: the chip changes at once, the server's answer follows (with the logger's other runs
  // when the car went on them too)
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

  const isEvent = key !== NO_EVENT;
  const eventId = isEvent ? Number(key) : null;
  const title = folder?.name ?? (isEvent ? 'Event' : 'Not in an event');
  const timed = sessions.some((s) => s.best_lap_s != null);

  // ---------- the photo and the folio ----------

  const top = folder ? (
    <View onLayout={(e) => (topH.current = e.nativeEvent.layout.height)}>
      <Hero photo={isEvent ? photoFor(folder.track) : PHOTOS.dusk} tag={isEvent ? TAG[whenOf(folder, todayIso())] : 'Unfiled'}
        rest="Sessions" restHref="/" title={headlineOf(folder, isEvent)} deck={deckOf(folder, isEvent)}
        height={wide ? 380 : 400} />
      <Folio items={isEvent ? [
        folder.track,
        dateRange(folder.start, folder.end),
        !folder.dates_by_hand && folder.log_start ? 'Dates from the logs' : null,
        folder.sessions > 0 ? <><B>{folder.sessions}</B> runs · <B>{folder.clean_laps}</B> clean laps</> : 'No runs yet',
        folder.best_lap_s != null ? <>Best <B>{formatLap(folder.best_lap_s)}</B></> : null,
      ] : [<><B>{folder.sessions}</B> runs in no event</>]} />
    </View>
  ) : undefined;

  // ---------- the event's links, and the band under them ----------

  const links = isEvent && eventId != null && folder && (
    <View style={wide ? styles.links : styles.linksPhone}>
      {timed && <TextLink href={{ pathname: '/report', params: { event: eventId } }} label="Report" red arrow />}
      {timed && <TextLink href={{ pathname: '/quali', params: { event: eventId } }} label="Quali prep" arrow />}
      {timed && <TextLink href={{ pathname: '/technique', params: { event: eventId } }} label="Technique check" arrow />}
      {timed && <TextLink href={{ pathname: '/tools/stint', params: { event: eventId } }} label="Stint analysis" arrow />}
      {timed && <TextLink href={{ pathname: '/drivers/compare', params: { event: eventId } }} label="Compare drivers" arrow />}
      <PrepButton eventId={eventId} info={prep[String(eventId)]} compact />
      <View style={wide ? styles.manage : styles.managePhone}>
        <TextLink onPress={() => showPanel(panel === 'rename' ? null : 'rename')} label="Rename" small />
        <TextLink onPress={() => showPanel(panel === 'edit' ? null : 'edit')} label="Change dates" small />
        <TextLink onPress={() => showPanel(panel === 'delete' ? null : 'delete')} label="Delete event" small />
      </View>
    </View>
  );

  // One panel at a time in a ruled band under the links: rename, change the dates, delete the event, move the ticked
  // runs.
  const band = folder && panel && (
    <View style={styles.band}>
      {panel === 'rename' && eventId != null && (
        <>
          <Label>Rename the event</Label>
          <RenameEvent id={eventId} initial={folder.name} large onCancel={() => setPanel(null)}
            onSaved={(f) => {
              setFolder(f);
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
              setPanel(null);
            }}
          />
        </>
      )}
      {panel === 'delete' && eventId != null && (
        <>
          <Label>Delete the event</Label>
          <Text style={styles.confirm}>
            Delete the event &ldquo;{folder.name}&rdquo;? Only the folder goes: its {plural(folder.sessions, 'run')}{' '}
            and their logs stay, under Not in an event.
          </Text>
          <FormActions>
            <MainButton danger label="Delete the event" onPress={async () => {
              try {
                await eventsApi.remove(eventId);
                router.replace('/');
              } catch (e) {
                setError((e as Error).message);
              }
            }} />
            <TextLink onPress={() => setPanel(null)} label="Keep it" />
          </FormActions>
        </>
      )}
      {panel === 'move' && picks.length > 0 && (
        <MoveSessions fromKey={key} count={picks.length} onMove={moveTo} onCancel={() => setPanel(null)} />
      )}
    </View>
  );

  // ---------- the sections ----------

  let no = 0;
  const runs = folder && (
    <Section no={++no} title="Runs" dek={isEvent
      ? 'Day by day, each with its best lap. Tick two to six to put them side by side; tap a name to rename it, a best lap to open the run.'
      : 'Runs filed in no event. Tick them, then Move to put them into one.'}>
      {sessions.length > 0 && isEvent && <Figures folder={folder} />}
      <View style={wide ? styles.days : styles.daysPhone}>
        {folder.days.map((d) => {
          const first = sessions.indexOf(d.sessions[0]);
          return (
            <View key={d.date ?? 'none'} style={wide ? styles.day : undefined}>
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
                  note={runNote?.id === s.id ? runNote.text : null} onNoteClose={() => setRunNote(null)} />
              ))}
            </View>
          );
        })}
      </View>
      {timed && <Legend />}
      {sessions.length === 0 && (
        <Note style={styles.empty}>
          {isEvent
            ? 'No runs in this event yet. Upload its logs below, or move runs here from another event.'
            : 'Every run is in an event.'}
        </Note>
      )}
    </Section>
  );

  const sideBySide = folder && sessions.length >= 2 && (
    <Section no={++no} title="Side by side" onLayout={(e) => (compareY.current = e.nativeEvent.layout.y)}
      dek="Two to six runs next to each other: lap times, the best time in each section, top speed, tyres.">
      {picks.length >= 2 ? (
        <EventCompare folderKey={key} picks={picks} onClear={() => setPicks([])} />
      ) : (
        <View style={styles.compareEmpty}>
          <Note>
            Tick two to six runs above (the first run on Friday and the race on Sunday, say) to see their lap times,
            section times, top speed and tyres here, next to each other.
          </Note>
          {bestOfDays.length >= 2 && (
            <View style={styles.quick}>
              <TextLink onPress={pickBestOfDays} label="The quickest run of each day" arrow />
              <Text style={styles.quickRuns}>{bestOfDays.map((s) => s.name).join(' · ')}</Text>
            </View>
          )}
        </View>
      )}
    </Section>
  );

  const info = eventId != null && hasInfo && (
    <EventInfoCard no={++no} eventId={eventId} version={folder}
      onInfo={(i) => {
        setHasInfo(i != null);
        setEventDrivers(i?.resolved.drivers.map((d) => d.id) ?? []);
      }} />
  );

  const results = eventId != null && (
    <Section no={++no} title="Results" dek="The official timing sheets of the round, with our car among them.">
      <ResultsPanel eventId={eventId} />
    </Section>
  );

  const upload = folder && (
    <Section no={++no} title={isEvent ? 'Upload' : 'Add a run'}
      dek={isEvent ? `Logs dropped or picked here go into ${folder.name}.` : 'A run made by hand, to upload a log to later.'}>
      {isEvent && eventId != null && <ImportLogs onProgress={load} into={{ id: eventId, name: folder.name }} />}
      <AddSession eventId={eventId} onAdded={load} />
    </Section>
  );

  return (
    <View style={styles.screen}>
      <Stack.Screen options={{ title, headerShown: false }} />
      <Page top={top} scrollRef={scroll}>
        {!folder && !error && <ActivityIndicator style={styles.loading} />}
        {error && (
          <View style={styles.errorBox}>
            <ErrorLine>{folder ? error : `Can’t open this event: ${error}`}</ErrorLine>
            {!folder && <TextLink href="/" label="Sessions" arrow />}
          </View>
        )}
        {links}
        {band}
        {notice && <View style={styles.notice}><Said text={notice} onPress={() => setNotice(null)} /></View>}
        {runs}
        {sideBySide}
        {info}
        {results}
        {upload}
        {folder && (
          <Colophon left={`The Engineer · ${isEvent ? 'Event' : 'Unfiled runs'}`} links={[
            { label: 'Sessions', href: '/' },
            { label: 'Seasons', href: '/seasons' },
            { label: 'Garage', href: '/garage' },
          ]} />
        )}
      </Page>
      {picks.length > 0 && (
        <View style={styles.bar}>
          <View style={StyleSheet.flatten([styles.barInner, { paddingHorizontal: gutter }])}>
            <Text style={styles.barText}>{picks.length} ticked</Text>
            {picks.length >= 2 && <TextLink onPress={showCompare} label="Side by side ↓" small />}
            <TextLink onPress={() => showPanel('move')} label="Move…" small />
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
  if (f.sessions === 0) return `${named}no runs yet. Upload its logs below.`;
  const days = f.days.filter((d) => d.date).length;
  const runs = `${inWords(f.sessions)} run${f.sessions === 1 ? '' : 's'}${days ? ` over ${inWords(days)} day${days === 1 ? '' : 's'}` : ''}`;
  const line = `${runs}, ${plural(f.clean_laps, 'clean lap')}.`;
  return named ? `${named}${line}` : `${line[0].toUpperCase()}${line.slice(1)}`;
}

/** The biggest gap of a run's best lap to the event's best: the length of a full gap bar. */
function maxGapOf(runs: FolderSession[], best: number | null) {
  return Math.max(0.5, ...runs.map((s) => (s.best_lap_s != null && best != null ? s.best_lap_s - best : 0)));
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

/** One run: tick it for side by side, tap its name to rename it in place, its driver or car to set them, its best lap
 * (a purple block for the event's best, else a red bar for the gap to it) or its laps to open it. */
function SessionRow({ s, no, color, eventBest, maxGap, picked, full, onToggle, editing, onEdit, onSaved, garage,
  eventDrivers, open, onOpen, onPick, note, onNoteClose }: {
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
}) {
  const styles = useStyles();
  const wide = useWide();
  const c = useTheme();
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
            <View style={styles.nameLine}>
              {color && <RunKey color={color} />}
              <Pressable onPress={onEdit} hitSlop={6} accessibilityRole="button" accessibilityLabel={`Rename ${s.name}`}
                style={styles.namePress}>
                <Text style={styles.runName} numberOfLines={1}>{s.name}</Text>
                <Text style={styles.pencil}>✎</Text>
              </Pressable>
            </View>
          )}
          {/* Link asChild hands its child's style to a web anchor, which can't take a style array: one object */}
          <Link href={href} asChild>
            <Pressable style={styles.detailPress} accessibilityRole="link">
              <Text style={styles.runSub} numberOfLines={2}>{detail}</Text>
            </Pressable>
          </Link>
          <RunChips run={s} garage={garage} open={open} onOpen={onOpen} />
        </View>
        {/* while the name is edited, the editor takes the row's width */}
        {!editing && (
          <Link href={href} asChild>
            <Pressable style={styles.runBest} accessibilityRole="link" accessibilityLabel={`Open ${s.name}`}>
              {s.best_lap_s == null ? <Text style={styles.noLap}>no lap</Text> : (
                <>
                  <View style={isBest ? { backgroundColor: c.timing.best } : undefined}>
                    <Text style={StyleSheet.flatten([styles.runTime, isBest && { color: c.timing.onBest }])}>
                      {formatLap(s.best_lap_s)}
                    </Text>
                  </View>
                  {isBest ? <Text style={StyleSheet.flatten([styles.gap, { color: c.timing.best }])}>Event best</Text>
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
        )}
      </View>
      {open && garage && (
        <View style={wide ? styles.under : styles.underPhone}>
          <RunPicker what={open} run={s} garage={garage} onPick={onPick} onClose={() => onOpen(null)}
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

/** A run made by hand in this event (no logs yet: to upload one to it, or for a debrief). */
function AddSession({ eventId, onAdded }: { eventId: number | null; onAdded: () => void }) {
  const styles = useStyles();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!open) {
    return (
      <View style={styles.addLink}>
        <TextLink onPress={() => setOpen(true)} label="+ Add a run by hand" small />
      </View>
    );
  }
  const add = async () => {
    setBusy(true);
    try {
      await eventsApi.createSession({ name: name.trim() || 'New session', kind: 'practice', event_id: eventId });
      setName('');
      setOpen(false);
      setError(null);
      onAdded();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <View style={styles.addForm}>
      <Label>A run by hand</Label>
      <Input value={name} onChangeText={setName} placeholder="Label, e.g. FP2" maxLength={120} onSubmitEditing={add}
        accessibilityLabel="The run's label" autoFocus />
      {error && <ErrorLine>{error}</ErrorLine>}
      <FormActions>
        <MainButton label="Add" onPress={add} busy={busy} />
        <TextLink onPress={() => setOpen(false)} label="Cancel" />
      </FormActions>
    </View>
  );
}

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
  band: { marginTop: 20, borderTopWidth: 3, borderColor: c.rule, paddingTop: 10, gap: 12, maxWidth: 680 },
  confirm: { fontFamily: Fonts.body, fontSize: 17, lineHeight: 24, color: c.text },
  notice: { marginTop: 18, maxWidth: 720 },

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
  dayHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', borderTopWidth: 3,
    borderBottomWidth: 1, borderColor: c.rule, paddingTop: 7, paddingBottom: 6 },
  legend: { flexDirection: 'row', flexWrap: 'wrap', columnGap: 22, rowGap: 8, alignItems: 'center', marginTop: 14 },

  run: { borderBottomWidth: 1, borderColor: c.separator, paddingTop: 10, paddingBottom: 9 },
  runLine: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  runLineEditing: { alignItems: 'flex-start' },
  runTick: { paddingTop: 3 },
  runNo: { fontFamily: Fonts.display, fontSize: 24, lineHeight: 28, width: 30, color: c.text },
  runId: { flex: 1, minWidth: 0, gap: 3 },
  nameLine: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  namePress: { flexDirection: 'row', alignItems: 'baseline', gap: 6, flexShrink: 1 },
  runName: { fontFamily: Type.label.fontFamily, fontSize: 17, letterSpacing: 0.3, color: c.text, flexShrink: 1 },
  pencil: { fontFamily: Fonts.label, fontSize: 13, color: c.textMuted },
  detailPress: { alignSelf: 'stretch' },
  runSub: { fontFamily: face('label', 400), fontSize: 13, lineHeight: 17, color: c.textSecondary },
  runBest: { width: 96, alignItems: 'flex-end' },
  runTime: { fontFamily: Type.label.fontFamily, fontSize: 19, fontVariant: ['tabular-nums'], paddingHorizontal: 5,
    paddingVertical: 1, color: c.text },
  noLap: { fontFamily: face('label', 400), fontSize: 13, color: c.textMuted, paddingTop: 3 },
  gap: { fontFamily: Fonts.label, fontSize: 12, fontVariant: ['tabular-nums'], color: c.delta.loss, marginTop: 1 },
  under: { paddingLeft: 72, paddingTop: 8 },
  underPhone: { paddingLeft: 0, paddingTop: 8 },

  // side by side
  compareEmpty: { gap: 16, maxWidth: 720 },
  quick: { gap: 6 },
  quickRuns: { fontFamily: face('label', 400), fontSize: 13, color: c.textSecondary },

  // upload, a run by hand
  addLink: { marginTop: 18 },
  addForm: { marginTop: 20, gap: 10, maxWidth: 420, borderTopWidth: 1, borderColor: c.rule, paddingTop: 10 },

  // the ticked runs: a strip on the paper at the foot of the screen
  bar: { borderTopWidth: 3, borderColor: c.rule, backgroundColor: c.background, paddingVertical: 10 },
  barInner: { width: '100%', maxWidth: 1240, alignSelf: 'center', flexDirection: 'row',
    flexWrap: 'wrap', alignItems: 'center', columnGap: 20, rowGap: 8 },
  barText: { ...Type.label, fontFamily: Fonts.label, fontSize: 13, color: c.text, marginRight: 'auto' },
}));

