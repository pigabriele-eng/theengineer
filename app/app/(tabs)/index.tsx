import { Link, useFocusEffect, useRouter } from 'expo-router';
import { ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, useWindowDimensions } from 'react-native';

import { DeletedNotice, DeleteEventAction } from '@/components/DeleteEvent';
import { useDriverGuess } from '@/components/DriverGuess';
import { PlanForm, plannedLine, RemovePlanned } from '@/components/EventFilter';
import { CountryTag } from '@/components/Flag';
import { FoldHead } from '@/components/Fold';
import {
  Colophon, Fig, Label, Page, SpecLine, Swatch, TextLink, useWide,
} from '@/components/Programme';
import { DriverTag } from '@/components/DriverTag';
import { RunDriverLine } from '@/components/RunDriverLine';
import { closesRows, RunLinks, RunPanel, SwipeRow, useRunActions } from '@/components/RunActions';
import { filledNote, localPick, RunNameEditor, RunPicker, useEventDrivers, useGarage } from '@/components/RunChips';
import { deletedLine } from '@/components/DeleteRuns';
import { Said } from '@/components/Controls';
import { SeasonMatchCount } from '@/components/SeasonMatch';
import { Text, View } from '@/components/Themed';
import { TyreChoices, TyreTag, useTyreTags } from '@/components/TyreTag';
import { formatLap } from '@/lib/api';
import { CalendarState, calendarApi, Plan, todayIso, whenOf } from '@/lib/calendar';
import { Country, countryOfAny } from '@/lib/countries';
import { DAY_GAP, dayColumns } from '@/lib/dayColumns';
import { Garage, garageApi, RunFields } from '@/lib/garage';
import { RunsDeleted } from '@/lib/deleteRuns';
import {
  dayLabel, eventsApi, Folder, FolderSession, FolderSummary, NO_EVENT,
} from '@/lib/events';
import {
  byTrack, carLine, driverLapsLine, eventKey, eventLabel, Folds, Track, TrackOf, trackKey, UNKNOWN, yearSpan,
} from '@/lib/homeFolds';
import { weekendsOf } from '@/lib/weekendOpen';
import { DriverTag as Tag, driverTag } from '@/lib/driverTag';
import { driverState } from '@/lib/runDriver';
import { knownVenue, trackName, venueKey } from '@/lib/venues';
import { a11yState } from '@/lib/a11yState';
import { face, Fonts, Space, TAP, themed, Type, useTheme } from '@/constants/Theme';

// What the page knows about an event beyond the list: its runs by day.
type Detail = { folder?: Folder };
// a run as the event's folder gives it: with its driver's and car's ids
type Run = FolderSession & { driver_id?: number | null; car_id?: number | null };

/** The tracks (Gabriele, 2026-10-16: "group per race track and within race tracks grouping have the events like GT4
 * Euro 2025, test February 2026"; "The app should open to a list of tracks"): one heading per track, the one driven
 * at most recently first, each with its country, how many events, the years and the clean laps, all folded to start
 * with (open when there is only one). Open, a track lists its events newest first, each called by its championship
 * and year, or as a test with its month: a tap on the event opens its weekend page, the mark beside it shows its runs
 * here (each with its best lap and the gap to the event's best) beside the event's big figures, with Delete. What is
 * opened stays open while the app is, not to its next start. Runs in no event have a line of their own, so they get
 * filed; planned events (made here or from the racing calendar) wait under their track until their data comes in.
 * No Past, Current and Upcoming, no race finishes and no going straight on to the event that is on (2026-10-16). */
export default function SessionsScreen() {
  const styles = useStyles();
  const wide = useWide();
  const [folders, setFolders] = useState<FolderSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [making, setMaking] = useState(false);
  const [calendar, setCalendar] = useState<CalendarState | null>(null);
  const [details, setDetails] = useState<Record<string, Detail>>({});
  const [loads, setLoads] = useState(0); // counts the list's loads: the details are read again with it
  const [folds, setFolds] = useState<Folds>({}); // what was tapped open or folded since the app started
  const read = useRef<Record<string, number>>({}); // the load each open event's runs were last read at
  const router = useRouter();
  const { garage, reload: reloadGarage } = useGarage(); // the drivers a run's driver list offers

  const loadNo = useRef(0); // the latest load: an older one's answers, coming in late, are dropped
  const load = useCallback(() => {
    const no = ++loadNo.current;
    const latest = () => no === loadNo.current;
    eventsApi.folders().then(
      (f) => {
        if (!latest()) return;
        setFolders(weekendsOf(f)); // coaching days have a list of their own (Coaching)
        setError(null);
        setLoads((n) => n + 1);
      },
      (e) => latest() && setError((e as Error).message),
    );
    calendarApi.state().then((c) => latest() && setCalendar(c), () => {}); // the list works without it
  }, []);
  useFocusEffect(load);
  // the calendar is being read in the background: look at it again shortly (only it), and read the list once it's done
  const syncing = !!calendar?.feed?.syncing;
  useEffect(() => {
    if (!calendar?.feed?.syncing) return;
    const t = setTimeout(() => calendarApi.state().then(setCalendar, () => {}), 3000);
    return () => clearTimeout(t);
  }, [calendar]);
  const wasSyncing = useRef(false);
  useEffect(() => {
    if (wasSyncing.current && !syncing) load();
    wasSyncing.current = syncing;
  }, [syncing, load]);

  const all = folders ?? [];
  const loose = all.find((f) => f.id == null) ?? null; // the runs in no event: a line of their own, first
  const plans = new Map((calendar?.plans ?? []).map((p) => [p.event_id, p]));
  // where an event was: its track, else the venue it was planned at, else a track its name says ("Monza test")
  const trackOf: TrackOf = (f) => {
    const named = f.track ?? (f.id != null ? plans.get(f.id)?.venue : null);
    const key = venueKey(named);
    if (named && key) return { key, name: trackName(named) };
    const known = knownVenue(f.name);
    return known ? { key: known, name: trackName(f.name) } : null;
  };
  const tracks = byTrack(all, trackOf);
  // a track's country, from its name, else its events' tracks and planned venues
  const countryOf = (t: Track) => (t.key === UNKNOWN ? null
    : countryOfAny([t.name, ...t.events.flatMap((f) => [f.track, f.id != null ? plans.get(f.id)?.venue : null])]));

  // folded or open: what was tapped since the app started, else folded (a track open when it is the only one)
  const isOpen = (key: string) => folds[key] ?? (tracks.length === 1 && key === trackKey(tracks[0]));
  const toggle = (key: string) => setFolds((f) => ({ ...f, [key]: !isOpen(key) }));

  // the runs of the events open on the page, read when they open and again with the list
  const wanted = tracks.flatMap((t) => (!isOpen(trackKey(t)) ? []
    : t.events.filter((f) => f.sessions > 0 && isOpen(eventKey(f))).map((f) => f.key))).join(',');
  useEffect(() => {
    for (const key of wanted ? wanted.split(',') : []) {
      if (read.current[key] === loads) continue;
      read.current[key] = loads;
      eventsApi.folder(key).then((folder) => setDetails((d) => ({ ...d, [key]: { ...d[key], folder } })), () => {});
    }
  }, [wanted, loads]);

  // no big block for the latest event on top (Gabriele, 2026-10-07: "i don't need this information"): the list starts the page
  return (
    <Page {...closesRows}>
      <View style={wide ? styles.indexBar : styles.indexBarPhone}>
        <View style={wide ? styles.heading : styles.headingPhone}>
          <View style={wide ? styles.headWord : styles.headWordPhone}>
            <Text accessibilityRole="header" style={wide ? styles.headText : styles.headTextPhone}>Tracks</Text>
            {folders && <Text style={styles.headCount}>{tracks.length}</Text>}
          </View>
        </View>
        {/* uploads have a page of their own: one big drop box */}
        <Link href="/upload" asChild>
          <Pressable accessibilityRole="link" style={wide ? styles.upload : styles.uploadPhone}>
            <Text style={wide ? styles.uploadBig : styles.uploadBigPhone}>Upload logs or a zip →</Text>
            <Text style={styles.uploadSmall}>A new event per zip · or into an event</Text>
          </Pressable>
        </Link>
      </View>
      {making ? (
        <View style={styles.plan}>
          <Label>New event</Label>
          <PlanForm onCancel={() => setMaking(false)}
            onMade={(ev) => {
              setMaking(false);
              load();
              // on to its page, to upload into it
              router.push({ pathname: '/event/[id]', params: { id: ev.key } });
            }} />
        </View>
      ) : (
        <View style={wide ? styles.toolsLine : styles.toolsLinePhone}>
          {/* only what concerns the whole list here, on one short line under the one big action (Upload), so the
              first track shows on a phone without scrolling (Gabriele, 2026-10-07: that row "is normally event
              specific") */}
          <TextLink onPress={() => setMaking(true)} label="+ New event" small />
          <TextLink href="/seasons" label="Seasons" arrow small />
          {/* the questions about which season an upload belongs to, when the app isn't sure (its own top margin
              taken back, to sit on the line) */}
          {folders && (
            <View style={styles.seasons}>
              <SeasonMatchCount onChanged={load} />
            </View>
          )}
        </View>
      )}
      {error && <Text style={styles.error}>Can&apos;t reach the server: {error}</Text>}
      <DeletedNotice />
      {!folders && !error && <ActivityIndicator style={styles.loading} />}
      {folders?.length === 0 && (
        <Text style={styles.empty}>
          No events yet. Upload logs or a zip of a whole test: each log becomes a run, and a zip becomes an event of its
          own. Or make an event first with + New event and upload into it.
        </Text>
      )}
      {loose && <LooseRuns f={loose} onChanged={load} />}
      {tracks.map((t, i) => (
        <TrackFold key={t.key} no={i + 1} t={t} open={isOpen(trackKey(t))} onToggle={() => toggle(trackKey(t))}
          country={countryOf(t)}>
          {t.events.map((f) => (
            <EventFold key={f.key} f={f} open={isOpen(eventKey(f))} onToggle={() => toggle(eventKey(f))}
              detail={details[f.key]} plan={f.id != null ? plans.get(f.id) : undefined}
              onChanged={load} garage={garage} onGarage={reloadGarage} />
          ))}
        </TrackFold>
      ))}
      <Colophon left="The Engineer · Tracks" links={[
        { label: 'Seasons', href: '/seasons' },
        { label: 'Garage', href: '/garage' },
      ]} />
    </Page>
  );
}

// ---------- a track ----------

/** A track, folded or open: its heading (its number in the list, its name, its country's flag, how many events, the
 * years they span and their clean laps), then, open, its events. */
function TrackFold({ no, t, open, onToggle, country, children }: {
  no: number;
  t: Track;
  open: boolean;
  onToggle: () => void;
  country: Country | null;
  children: ReactNode;
}) {
  const styles = useStyles();
  const wide = useWide();
  const facts = [plural(t.events.length, 'event'), yearSpan(t.first, t.last),
    t.cleanLaps ? plural(t.cleanLaps, 'clean lap') : null].filter(Boolean).join(' · ');
  return (
    <View style={wide ? styles.track : styles.trackPhone}>
      <FoldHead no={no} title={t.name} facts={facts} open={open} onToggle={onToggle} what={`the events at ${t.name}`}
        extra={country ? <CountryTag country={country} /> : undefined} />
      {open && <View style={styles.trackEvents}>{children}</View>}
    </View>
  );
}

// ---------- words ----------

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const pad2 = (n: number) => String(n).padStart(2, '0');

/** "28–30 Aug", "31 Oct–2 Nov", "Tue 3 Nov": the event's name beside it says the year. */
function shortDates(start: string | null, end: string | null) {
  const a = start ?? end;
  const b = end ?? start;
  if (!a || !b) return null;
  const [ya, ma, da] = a.split('-').map(Number);
  const [yb, mb, db] = b.split('-').map(Number);
  if (a === b) return dayLabel(a);
  if (ya === yb && ma === mb) return `${da}–${db} ${MONTHS[mb - 1]}`;
  return `${da} ${MONTHS[ma - 1]}–${db} ${MONTHS[mb - 1]}${ya !== yb ? ` ${yb}` : ''}`;
}

// ---------- an event, folded or open ----------

/** An event under its track: one line (its days, what it is, "GT4 Euro 2025" or "Test February 2026", its round,
 * drivers, car, runs and best lap, or what is planned) that opens its weekend page, and a mark beside it that shows or
 * folds its runs here, with Delete (Remove when planned). Renaming is on its weekend page, which carries its name. */
function EventFold({ f, open, onToggle, detail, plan, onChanged, garage, onGarage }: {
  f: FolderSummary;
  open: boolean;
  onToggle: () => void;
  detail?: Detail;
  plan?: Plan;
  onChanged: () => void;
  garage: Garage | null;
  onGarage: () => void; // read the garage again (a driver made from a run's list)
}) {
  const styles = useStyles();
  const wide = useWide();
  const c = useTheme();
  const id = f.id!;
  const planned = f.sessions === 0; // no data yet
  const past = whenOf(f, todayIso()) === 'past';
  const label = eventLabel(f);
  const round = f.season?.round != null ? `Round ${f.season.round}` : null;
  const meta = planned ? [round, plannedLine(f, plan)].filter(Boolean).join(' · ')
    : [round, driverLapsLine(f), carLine(f), plural(f.sessions, 'run'),
      f.clean_laps ? plural(f.clean_laps, 'clean lap') : null]
      .filter(Boolean).join(' · ');
  const status = planned ? { text: past ? 'No data' : 'Planned', line: past ? c.textMuted : c.rule }
    : { text: `Best ${formatLap(f.best_lap_s)}`, line: c.rule };
  const dates = shortDates(f.start, f.end) ?? 'Days not set';
  return (
    <View style={styles.item}>
      {/* the event's line is one tap into its weekend page; the mark beside it shows or folds its runs here */}
      <View style={styles.itemHead}>
        {/* Link asChild hands its child's style to a web anchor, which can't take a style array: one object */}
        <Link href={{ pathname: '/event/[id]', params: { id: f.key } }} asChild>
          <Pressable accessibilityRole="link" accessibilityLabel={`${label}, ${dates}, ${meta}, ${status.text}`}
            accessibilityHint={`Opens the weekend, ${f.name}`} style={wide ? styles.itemLine : styles.itemLinePhone}>
            <Text style={wide ? styles.itemDate : styles.itemDatePhone}>{dates}</Text>
            <View style={styles.itemWhat}>
              <Text style={wide ? styles.itemName : styles.itemNamePhone}>{label} →</Text>
              <Text style={styles.itemMeta}>{meta}</Text>
            </View>
            <Text style={StyleSheet.flatten([styles.status, { borderColor: status.line }])}>{status.text}</Text>
          </Pressable>
        </Link>
        <Pressable onPress={onToggle} accessibilityRole="button" {...a11yState({ expanded: open })}
          accessibilityLabel={`${open ? 'Fold' : 'Show'} the runs of ${label}, ${dates}`} style={styles.foldButton}>
          <Text style={wide ? styles.itemMark : styles.itemMarkPhone}>{open ? '▾' : '▸'}</Text>
        </Pressable>
      </View>
      {open && (
        <View style={styles.itemBody}>
          {planned ? null : <Feature f={f} detail={detail} garage={garage} onGarage={onGarage} onChanged={onChanged} />}
          <View style={styles.itemActions}>
            {planned ? <RemovePlanned f={f} plan={plan} onRemoved={onChanged} />
              : <DeleteEventAction id={id} name={f.name} onDeleted={onChanged} />}
          </View>
        </View>
      )}
    </View>
  );
}

/** The runs in no event: one line to their folder, to move them into an event, and Delete. */
function LooseRuns({ f, onChanged }: { f: FolderSummary; onChanged: () => void }) {
  const styles = useStyles();
  const wide = useWide();
  const c = useTheme();
  return (
    <View style={StyleSheet.flatten([styles.item, styles.loose])}>
      {/* Link asChild hands its child's style to a web anchor, which can't take a style array: one object */}
      <Link href={{ pathname: '/event/[id]', params: { id: f.key } }} asChild>
        <Pressable accessibilityRole="link" style={wide ? styles.looseLine : styles.looseLinePhone}>
          <Text style={wide ? styles.itemDate : styles.itemDatePhone}>Unfiled</Text>
          <View style={styles.itemWhat}>
            <Text style={wide ? styles.itemName : styles.itemNamePhone}>{f.name}</Text>
            <Text style={styles.itemMeta}>Open to move them into an event</Text>
          </View>
          <Text style={StyleSheet.flatten([styles.status, { borderColor: c.rule }])}>{plural(f.sessions, 'run')}</Text>
        </Pressable>
      </Link>
      <View style={wide ? styles.looseActions : styles.looseActionsPhone}>
        <DeleteEventAction id={NO_EVENT} name={f.name} onDeleted={onChanged} />
      </View>
    </View>
  );
}

// ---------- an open event's runs ----------

/** An event open on the page: its links, its runs by day (each with its best lap: a purple block for the event's
 * best, else a red bar for the gap to it, and its driver, or who the driving style says, with Change, and its tyres,
 * a tap to change them), and beside them the best lap, clean laps, runs and the event's facts. */
function Feature({ f, detail, garage, onGarage, onChanged }: {
  f: FolderSummary;
  detail?: Detail;
  garage: Garage | null;
  onGarage: () => void;
  onChanged: () => void; // read the list again: the event's drivers on its line, its runs, and the guesses with them
}) {
  const styles = useStyles();
  const wide = useWide();
  const c = useTheme();
  const folder = detail?.folder;
  const best = f.best_lap_s;
  const id = f.id!;
  // a driver picked here shows at once, until the event's runs are read again after it was saved
  const [picked, setPicked] = useState<Record<number, Partial<Run>>>({});
  const saving = useRef(new Set<number>()); // the runs whose pick the server hasn't answered yet
  const [picking, setPicking] = useState<number | null>(null); // the run whose driver list is open under it
  const [said, setSaid] = useState<{ id: number; text: string } | null>(null); // what a pick did, or why it failed
  const [deleted, setDeleted] = useState<string | null>(null); // a run deleted from its row (swiped, or held)
  // who drove each run by driving style (read once the runs are in, again whenever they are read again), and the
  // event's drivers 1 to 4, offered first in a run's list: only for an open event, as this is drawn only then
  const guess = useDriverGuess(folder ? id : null, folder);
  const eventDrivers = useEventDrivers(id);
  // each run's tyres beside its driver, one tap to change them (read with the event's runs)
  const tyreTags = useTyreTags(folder ? id : null, folder);
  useEffect(() => {
    setPicked((p) => {
      const keep = Object.entries(p).filter(([k]) => saving.current.has(Number(k)));
      return keep.length === Object.keys(p).length ? p : Object.fromEntries(keep);
    });
  }, [folder]);
  const run = (s: FolderSession): Run => ({ ...s, ...picked[s.id] });
  const pick = async (s: Run, fields: RunFields) => {
    setPicking(null);
    setSaid(null);
    saving.current.add(s.id);
    setPicked((p) => ({ ...p, [s.id]: { ...p[s.id], ...localPick(garage, fields) } }));
    try {
      const r = await garageApi.setRun(s.id, fields);
      setPicked((p) => ({ ...p, [s.id]: { driver_id: r.driver_id, driver: r.driver, car_id: r.car_id } }));
      const note = filledNote(r);
      if (note) setSaid({ id: s.id, text: note });
      onGarage();
    } catch (e) {
      setPicked(({ [s.id]: _, ...rest }) => rest);
      setSaid({ id: s.id, text: (e as Error).message });
    } finally {
      saving.current.delete(s.id);
      onChanged(); // the event's runs read again: its drivers on its line, and the style's guesses with them
    }
  };
  const runs = folder?.days.flatMap((d) => d.sessions.map(run)) ?? [];
  const maxGap = Math.max(0.5, ...runs.map((s) => (s.best_lap_s != null && best != null ? s.best_lap_s - best : 0)));
  const bestRun = runs.find((s) => s.id === f.best_session_id);
  const drivers = [...new Set(runs.map((s) => s.driver).filter(Boolean))] as string[];
  // Three or four days of driving (Gabriele, 2026-10-07: "allow for 4 columns"): the days take the page's whole
  // width side by side and the figures go under them; a window too narrow for that many columns shows two a row
  const { width } = useWindowDimensions();
  const cols = dayColumns(folder?.days.length ?? 0, width, wide, Space.gutter);
  const full = cols != null;
  const oneRow = cols !== 'half';
  const dayStyle = full ? (oneRow ? styles.dayAcross : styles.dayHalf) : wide ? styles.day : undefined;
  let no = 0;
  let dated = 0;
  return (
    <View style={full ? styles.featureFull : wide ? styles.feature : styles.featurePhone}>
      <View style={styles.featureMain}>
        {/* no row of links first (Gabriele, 2026-10-07: "too many clicks to get to the information"): the event's
            line opens its weekend page, where every analysis sits with what it answers */}
        {deleted && <View style={styles.deleted}><Said text={deleted} onPress={() => setDeleted(null)} /></View>}
        {!folder ? <ActivityIndicator style={styles.loading} /> : (
          <View style={full ? (oneRow ? styles.daysAcross : styles.daysHalf) : wide ? styles.days : styles.daysPhone}>
            {folder.days.map((day) => {
              if (day.date) dated += 1;
              return (
                <View key={day.date ?? 'none'} style={dayStyle}>
                  <View style={styles.dayHead}>
                    <Label>{day.date ? `Day ${dated}` : 'No date'}</Label>
                    {day.date ? <Label>{dayLabel(day.date, { long: true })}</Label> : null}
                  </View>
                  {day.sessions.map((x) => {
                    no += 1;
                    const s = run(x);
                    const g = guess?.sessions.find((x) => x.session_id === s.id);
                    return (
                      <RunRow key={s.id} s={s} no={no} best={best} maxGap={maxGap}
                        onDriver={() => garage && setPicking(s.id)} onChanged={onChanged}
                        onTyres={tyreTags.rowOf(s.id) ? () => tyreTags.show(s.id) : undefined}
                        onDeleted={(d) => {
                          setDeleted(deletedLine(d));
                          onChanged();
                        }}
                        tag={driverTag(driverState(s, g, garage))} driver={(
                        <RunDriverLine run={s} guess={guess?.sessions.find((g) => g.session_id === s.id)} garage={garage}
                          open={picking === s.id} onOpen={(o) => setPicking(o ? s.id : null)}
                          onPick={(fields) => pick(s, fields)}>
                          <TyreTag tags={tyreTags} id={s.id} run={s.name} size={15} />
                        </RunDriverLine>
                      )}>
                        <TyreChoices tags={tyreTags} id={s.id} name={s.name} style={styles.runPicker} />
                        {picking === s.id && garage && (
                          <View style={styles.runPicker}>
                            <RunPicker run={s} garage={garage} eventDrivers={eventDrivers}
                              onPick={(fields) => pick(s, fields)} onClose={() => setPicking(null)} />
                          </View>
                        )}
                        {said?.id === s.id && (
                          <Pressable onPress={() => setSaid(null)} accessibilityRole="button" accessibilityHint="Hides this">
                            <Text style={styles.runSaid}>{said.text}</Text>
                          </Pressable>
                        )}
                      </RunRow>
                    );
                  })}
                </View>
              );
            })}
          </View>
        )}
        <View style={styles.legend}>
          <Swatch color={c.timing.best} label="Quickest of the event" />
          <Swatch color={c.timing.loss[2]} height={5} label="Gap to it" />
        </View>
      </View>

      <View style={full ? styles.sideUnder : wide ? styles.side : undefined}>
        {best != null && (
          <View style={full ? styles.underCell : undefined}>
            <Fig label="Best lap of the event" value={formatLap(best)} size={wide ? 104 : 96} bar={c.timing.best}
              note={bestRun ? [`${bestRun.name}, lap ${bestRun.best_lap ?? '?'}`, bestRun.date
                ? `${dayLabel(bestRun.date, { long: true }).split(' ')[0]}${bestRun.time ? ` ${bestRun.time}` : ''}` : null]
                .filter(Boolean).join(' · ') : f.best_session ?? undefined} />
          </View>
        )}
        <View style={full ? styles.pairUnder : styles.pair}>
          <View style={styles.pairLeft}><Fig label="Clean laps" value={String(f.clean_laps)} size={64} /></View>
          <View style={styles.pairRight}>
            <Fig label="Runs" value={String(f.sessions)} size={64} />
          </View>
        </View>
        <View style={full ? styles.specsUnder : styles.specs}>
          {f.track && <SpecLine label="Track" value={f.track} />}
          {drivers.length > 0 && <SpecLine label={drivers.length === 1 ? 'Driver' : 'Drivers'} value={drivers.join(' / ')} />}
        </View>
      </View>
    </View>
  );
}

/** One run: its line opens it (number, name, time, laps, best lap and the gap to the event's best); under it, outside
 * the link, its driver line (with its tyres) under its name, then (children) its driver list or its tyres' four
 * levels when open, the row's width. Rename and Delete at the end of its driver line open the name's editor and the
 * confirm under the row; swiped left it shows Delete too, and held a menu of Delete, Change driver, Rename and Tyres
 * (components/RunActions.tsx). */
function RunRow({ s, no, best, maxGap, tag, driver, onDriver, onTyres, onChanged, onDeleted, children }: {
  s: FolderSession;
  no: number;
  best: number | null;
  maxGap: number;
  tag: Tag; // the driver on the name line, first thing the eye meets
  driver: ReactNode;
  onDriver: () => void; // open its driver list
  onTyres?: () => void; // open its tyres' four levels
  onChanged: () => void; // renamed: read the event's runs again
  onDeleted: (d: RunsDeleted) => void;
  children?: ReactNode;
}) {
  const styles = useStyles();
  const c = useTheme();
  const [renaming, setRenaming] = useState(false);
  const run = useRunActions({ onDriver, onRename: () => setRenaming(true), onTyres });
  const gap = s.best_lap_s != null && best != null ? s.best_lap_s - best : null;
  const isBest = gap != null && gap < 0.0005;
  return (
    <View style={styles.run}>
      <SwipeRow run={run} name={s.name} disabled={renaming} bleed={RUN_PAD}>
        {/* Link asChild hands its child's style to a web anchor, which can't take a style array: one object */}
        <Link href={{ pathname: '/session/[id]', params: { id: s.id } }} asChild>
          <Pressable style={styles.runLine} accessibilityRole="link" {...run.hold} {...run.a11y}>
            <Text style={styles.runNo}>{pad2(no)}</Text>
            <View style={styles.runId}>
              <View style={styles.runNameLine}>
                <DriverTag tag={tag} run={s.name} size={15} />
                <Text style={StyleSheet.flatten([styles.runCode, styles.runCodeShrink])} numberOfLines={1}>{s.name}</Text>
              </View>
              <Text style={styles.runSub} numberOfLines={1}>
                {[s.time, `${plural(s.laps, 'lap')} (${s.clean_laps} clean)`].filter(Boolean).join(' · ')}
              </Text>
            </View>
            <View style={styles.runBest}>
              {s.best_lap_s == null ? <Text style={styles.runSub}>no lap</Text> : (
                <>
                  <View style={isBest ? { backgroundColor: c.timing.best } : undefined}>
                    <Text style={StyleSheet.flatten([styles.runTime, isBest && { color: c.timing.onBest }])}>
                      {formatLap(s.best_lap_s)}
                    </Text>
                  </View>
                  {isBest ? <Text style={StyleSheet.flatten([styles.gap, { color: c.timing.bestInk }])}>Event best</Text> : gap != null && (
                    <>
                      <View style={{ height: 5, marginTop: 3, backgroundColor: c.timing.loss[2],
                        width: Math.max(3, Math.round((gap / maxGap) * 86)) }} />
                      <Text style={styles.gap}>+{gap.toFixed(2)}</Text>
                    </>
                  )}
                </>
              )}
            </View>
          </Pressable>
        </Link>
        <View style={styles.runMore}>
          <View style={styles.runMoreDriver}>{driver}</View>
          {/* Rename and Delete in sight on every row (Gabriele, 2026-10-08: "still no way to quickly delete runs in
              the home page"; 10-09: "give option to rename runs"): the name's editor and the confirm under the row */}
          <RunLinks run={run} name={s.name} renaming={renaming} />
        </View>
      </SwipeRow>
      {renaming && (
        <View style={styles.runPicker}>
          <RunNameEditor id={s.id} name={s.name} kind={s.kind} logSession={s.log_session}
            onCancel={() => setRenaming(false)} save={(id, body) => eventsApi.updateSession(id, body)}
            onSaved={() => {
              setRenaming(false);
              onChanged();
            }} />
        </View>
      )}
      <RunPanel run={run} id={s.id} name={s.name} inEvent onDeleted={onDeleted} style={styles.runPicker} />
      {children}
    </View>
  );
}

const DATE_W = 170;
const RUN_NO_W = 30; // a run's number, before its name
const RUN_PAD = { top: 9, bottom: 8 }; // a run row's padding above and below its line: its swipe fills it

const useStyles = themed((c) => ({
  // the index: "Tracks" with how many, underlined in red as the page's one heading, and the upload block
  indexBar: { flexDirection: 'row', alignItems: 'stretch', justifyContent: 'space-between', borderBottomWidth: 1,
    borderColor: c.rule, gap: 20 },
  indexBarPhone: { flexDirection: 'column', borderBottomWidth: 1, borderColor: c.rule },
  heading: { flexDirection: 'row', alignItems: 'flex-end', paddingTop: 18, paddingBottom: 12 },
  headingPhone: { flexDirection: 'row', alignItems: 'flex-end', paddingTop: 14, paddingBottom: 10 },
  headWord: { flexDirection: 'row', alignItems: 'flex-start', paddingBottom: 6, borderBottomWidth: 6, borderColor: c.mark },
  headWordPhone: { flexDirection: 'row', alignItems: 'flex-start', paddingBottom: 6, borderBottomWidth: 5,
    borderColor: c.mark },
  headText: { fontFamily: Fonts.display, fontSize: 30, lineHeight: 32, textTransform: 'uppercase', color: c.text },
  headTextPhone: { fontFamily: Fonts.display, fontSize: 24, lineHeight: 26, textTransform: 'uppercase', color: c.text },
  headCount: { fontFamily: Type.label.fontFamily, fontSize: 13, lineHeight: 14, marginLeft: 3, color: c.text },
  upload: { justifyContent: 'center', backgroundColor: c.rule, paddingVertical: 14, paddingHorizontal: 22, minWidth: 300 },
  uploadPhone: { justifyContent: 'center', backgroundColor: c.rule, paddingVertical: 14, paddingHorizontal: 16 },
  uploadBig: { fontFamily: Fonts.display, fontSize: 28, lineHeight: 30, textTransform: 'uppercase', color: c.background },
  uploadBigPhone: { fontFamily: Fonts.display, fontSize: 26, lineHeight: 28, textTransform: 'uppercase', color: c.background },
  // the faint rule colour reads as a quiet grey on the ink block, in either scheme
  uploadSmall: { ...Type.label, fontFamily: Fonts.label, letterSpacing: 1, color: c.border, marginTop: 6 },
  seasons: { marginTop: -18 },
  toolsLine: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 22, paddingTop: 12 },
  toolsLinePhone: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: 18, rowGap: 12, paddingTop: 12 },
  plan: { marginTop: 16, gap: 8, borderTopWidth: 3, borderColor: c.rule, paddingTop: 10, maxWidth: 640 },
  error: { color: c.error, marginTop: 16 },
  loading: { marginTop: 24, alignSelf: 'flex-start' },
  empty: { fontFamily: Type.dek.fontFamily, fontSize: 17, lineHeight: 24, color: c.textSecondary, marginTop: 4 },

  // a track, its events
  track: { marginTop: 34 },
  trackPhone: { marginTop: 26 },
  trackEvents: { marginTop: 10 },

  // one line per event, folded or open
  item: { borderBottomWidth: 1, borderColor: c.rule, paddingTop: 14, paddingBottom: 13 },
  itemHead: { flexDirection: 'row', alignItems: 'flex-start', gap: 14 },
  itemLine: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'baseline', gap: 22 },
  itemLinePhone: { flex: 1, minWidth: 0, flexDirection: 'column', gap: 6 },
  itemDate: { fontFamily: Fonts.display, fontSize: 34, lineHeight: 34, textTransform: 'uppercase', width: DATE_W, color: c.text },
  itemDatePhone: { ...Type.label, fontSize: 15, letterSpacing: 1.8, color: c.text },
  itemWhat: { flex: 1, minWidth: 0 },
  itemName: { fontFamily: Fonts.display, fontSize: 30, lineHeight: 32, textTransform: 'uppercase', color: c.text },
  itemNamePhone: { fontFamily: Fonts.display, fontSize: 26, lineHeight: 28, textTransform: 'uppercase', color: c.text },
  itemMeta: { fontFamily: Fonts.body, fontSize: 16, lineHeight: 22, color: c.textSecondary, marginTop: 4 },
  status: { ...Type.label, alignSelf: 'flex-start', borderBottomWidth: 3, paddingBottom: 2, color: c.text },
  foldButton: { width: 44, minHeight: 44, alignItems: 'flex-end' },
  itemMark: { fontFamily: Fonts.label, fontSize: 20, lineHeight: 32, color: c.text, width: 20, textAlign: 'right' },
  itemMarkPhone: { fontFamily: Fonts.label, fontSize: 18, lineHeight: 20, color: c.text, width: 18, textAlign: 'right' },
  itemBody: { marginTop: 18, marginBottom: 6 },
  itemActions: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: 18, rowGap: 8, marginTop: 18 },
  loose: { marginTop: 18, borderTopWidth: 1 },
  looseLine: { flexDirection: 'row', alignItems: 'baseline', gap: 22 },
  looseLinePhone: { flexDirection: 'column', gap: 6 },
  looseActions: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: 18, rowGap: 8, marginTop: 10,
    marginLeft: DATE_W + 22 },
  looseActionsPhone: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: 18, rowGap: 8,
    marginTop: 10 },

  // an open event's runs
  feature: { flexDirection: 'row', gap: 36 },
  featureFull: { flexDirection: 'column', gap: 30 },
  featurePhone: { flexDirection: 'column', gap: 26 },
  featureMain: { flex: 1, minWidth: 0 },
  side: { width: 300 },
  sideUnder: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'flex-start', columnGap: 36, rowGap: 24 },
  underCell: { flexGrow: 1, flexBasis: 260 },
  links: { flexDirection: 'row', flexWrap: 'wrap', columnGap: 22, rowGap: 12, marginBottom: 22 },
  linksAlone: { flexDirection: 'row', flexWrap: 'wrap', columnGap: 22, rowGap: 12 },
  days: { flexDirection: 'row', flexWrap: 'wrap', gap: 28 },
  daysPhone: { flexDirection: 'column', gap: 22 },
  day: { flex: 1, minWidth: 260 },
  daysAcross: { flexDirection: 'row', columnGap: DAY_GAP },
  daysHalf: { flexDirection: 'row', flexWrap: 'wrap', columnGap: DAY_GAP, rowGap: 28 },
  dayAcross: { flexGrow: 1, flexShrink: 1, flexBasis: 0, minWidth: 0 },
  dayHalf: { flexBasis: '47%', flexGrow: 1, minWidth: 0 },
  dayHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', borderTopWidth: 3,
    borderBottomWidth: 1, borderColor: c.rule, paddingTop: 7, paddingBottom: 6 },
  run: { borderBottomWidth: 1, borderColor: c.separator, paddingTop: RUN_PAD.top, paddingBottom: RUN_PAD.bottom },
  // the run's link: at least a 44 px tap target, a run without a lap too
  runLine: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: TAP },
  // the driver line, under the run's name (past its number)
  runMore: { marginLeft: RUN_NO_W + 10, flexDirection: 'row', alignItems: 'center', gap: 8 },
  runMoreDriver: { flex: 1, minWidth: 0 },
  // the row's Delete: a 44 px target, quiet until wanted (the confirm under the row is where it turns red)
  runPicker: { marginTop: 10 },
  deleted: { marginBottom: 14, maxWidth: 640 },
  runSaid: { fontFamily: Fonts.body, fontSize: 14, lineHeight: 19, color: c.textSecondary, borderLeftWidth: 3,
    borderColor: c.rule, paddingLeft: 8, marginTop: 6 },
  runNo: { fontFamily: Fonts.display, fontSize: 24, lineHeight: 26, width: RUN_NO_W, color: c.text },
  runId: { flex: 1, minWidth: 0 },
  runCode: { fontFamily: Type.label.fontFamily, fontSize: 17, letterSpacing: 0.3, color: c.text },
  runNameLine: { flexDirection: 'row', alignItems: 'baseline', gap: 8 },
  runCodeShrink: { flexShrink: 1 },
  runSub: { fontFamily: face('label', 400), fontSize: 13, color: c.textSecondary },
  runBest: { width: 96, alignItems: 'flex-end' },
  runTime: { fontFamily: Type.label.fontFamily, fontSize: 19, fontVariant: ['tabular-nums'], paddingHorizontal: 5,
    paddingVertical: 1, color: c.text },
  gap: { fontFamily: Fonts.label, fontSize: 12, fontVariant: ['tabular-nums'], color: c.delta.loss, marginTop: 1 },
  legend: { flexDirection: 'row', flexWrap: 'wrap', columnGap: 22, rowGap: 8, alignItems: 'center', marginTop: 12 },
  pair: { flexDirection: 'row', marginTop: 26, borderTopWidth: 1, borderColor: c.rule },
  pairLeft: { paddingTop: 10, paddingRight: 14, borderRightWidth: 1, borderColor: c.rule },
  pairRight: { flex: 1, paddingTop: 10, paddingLeft: 14 },
  specs: { marginTop: 26, borderTopWidth: 3, borderColor: c.rule },
  pairUnder: { flexGrow: 1, flexBasis: 260, flexDirection: 'row', borderTopWidth: 1, borderColor: c.rule },
  specsUnder: { flexGrow: 1, flexBasis: 260, borderTopWidth: 3, borderColor: c.rule },
}));
