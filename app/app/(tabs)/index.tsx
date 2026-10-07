import { Link, useFocusEffect, useNavigation, useRouter } from 'expo-router';
import { ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, useWindowDimensions } from 'react-native';

import { DeletedNotice, DeleteEventAction } from '@/components/DeleteEvent';
import { CalendarLine, FilterBar, PlanForm, plannedLine, RemovePlanned } from '@/components/EventFilter';
import { CountryTag } from '@/components/Flag';
import { FoldHead, SubFoldHead } from '@/components/Fold';
import { PrepButton, usePrepAvailability } from '@/components/PrepButton';
import {
  Colophon, Fig, Label, Page, SpecLine, Swatch, TextLink, useWide,
} from '@/components/Programme';
import { RenameEvent } from '@/components/RenameEvent';
import { SeasonMatchCount } from '@/components/SeasonMatch';
import { Text, View } from '@/components/Themed';
import { api, formatLap } from '@/lib/api';
import {
  CalendarState, calendarApi, countByWhen, defaultFilter, Filter, filtered, Plan, todayIso, When, whenOf,
} from '@/lib/calendar';
import { Country, countryOfAny } from '@/lib/countries';
import {
  dayLabel, eventsApi, Folder, FolderSession, FolderSummary, NO_EVENT,
} from '@/lib/events';
import {
  byYear, carLine, Championship, champKey, driverLapsLine, eventKey, Folds, monthSpan, openByDefault, readFolds, saveFolds,
  shortName, Year, yearKey, yearOf,
} from '@/lib/homeFolds';
import { launchEvent } from '@/lib/openCurrent';
import { PrepAvailability } from '@/lib/prep';
import { fetchReport, Report } from '@/lib/report';
import { face, Fonts, Space, themed, Type, useTheme } from '@/constants/Theme';

// What the page knows about an event beyond the list: its runs by day, its report and the logger it was recorded on.
type Detail = { folder?: Folder; report?: Report; logger?: string };

/** Events as a race programme: the event on now (else the latest one driven, else the next) on the photo at the top
 * with its facts, then the index (Past, Current, Upcoming, All) and the events it picks by year, newest first, each
 * year by championship (a season's rounds; tests and other events last), each level folded or open with a tap. A
 * folded event is one line; open, it shows its runs by day (each with its best lap and the gap to the event's best)
 * beside the event's big figures, its links and its actions. This year, its championships and the lead event are
 * open to start with; what is tapped is remembered on the device. Sessions in no event have a line of their own,
 * so they get filed. Planned events (made here or from the racing calendar) wait under Upcoming until their data
 * comes in. Opened while an event is on, the app goes straight on to that event's page (lib/openCurrent.ts). */
export default function SessionsScreen() {
  const styles = useStyles();
  const wide = useWide();
  const [folders, setFolders] = useState<FolderSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [making, setMaking] = useState(false);
  const [calendar, setCalendar] = useState<CalendarState | null>(null);
  const [filter, setFilter] = useState<Filter | null>(null); // null: what the list opens on
  const [details, setDetails] = useState<Record<string, Detail>>({});
  const [loads, setLoads] = useState(0); // counts the list's loads: the details are read again with it
  const [folds, setFolds] = useState<Folds>(readFolds); // what was tapped folded or open on this device
  const read = useRef<Record<string, number>>({}); // the load each open event's runs were last read at
  const router = useRouter();
  const navigation = useNavigation();
  const prep = usePrepAvailability(); // events whose track has past data: the Prep report button

  const load = useCallback(() => {
    eventsApi.folders().then(
      (f) => {
        setFolders(f);
        setError(null);
        setLoads((n) => n + 1);
      },
      (e) => setError((e as Error).message),
    );
    calendarApi.state().then(setCalendar, () => {}); // the list works without it
  }, []);
  useFocusEffect(load);
  // the calendar is being read in the background: look again shortly
  useEffect(() => {
    if (!calendar?.feed?.syncing) return;
    const t = setTimeout(load, 3000);
    return () => clearTimeout(t);
  }, [calendar, load]);

  // Opened on this list while an event is on: on to its page, once per launch (Back comes back here). Not when they've
  // gone elsewhere or started making an event while the list was loading.
  useEffect(() => {
    if (!folders) return;
    const ev = launchEvent(folders, todayIso());
    if (ev && navigation.isFocused() && !making) router.push({ pathname: '/event/[id]', params: { id: ev.key } });
  }, [folders, making, navigation, router]);

  const today = todayIso();
  const counts = countByWhen(folders ?? [], today);
  const active = filter ?? defaultFilter(counts);
  const shown = folders ? filtered(folders, active, today) : [];
  const loose = shown.find((f) => f.id == null) ?? null; // the runs in no event: a line of their own, first
  const years = byYear(shown);
  const plans = new Map((calendar?.plans ?? []).map((p) => [p.event_id, p]));
  // the event at the top of the page: on now, else the latest driven, else the next one
  const all = folders ?? [];
  const lead = filtered(all, 'current', today).find((f) => f.id != null)
    ?? filtered(all, 'past', today).find((f) => f.id != null && f.sessions > 0)
    ?? filtered(all, 'upcoming', today).find((f) => f.id != null) ?? null;
  // an event's country, from its track, else the venue it was planned at, else its name ("Monza test")
  const countryOfEvent = (f: FolderSummary) => countryOfAny([f.track, f.id != null ? plans.get(f.id)?.venue : null, f.name]);

  // folded or open: what was tapped on this device, else the default
  const defaults = openByDefault(years, lead, Number(today.slice(0, 4)));
  const isOpen = (key: string) => folds[key] ?? defaults.has(key);
  const setOpen = (keys: string[], open: boolean) =>
    setFolds((f) => {
      const next = { ...f, ...Object.fromEntries(keys.map((k) => [k, open])) };
      saveFolds(next);
      return next;
    });
  const toggle = (key: string) => setOpen([key], !isOpen(key));

  // the runs of the events open on the page, read when they open and again with the list; the lead's always
  const leadKey = lead && lead.sessions > 0 ? lead.key : null;
  const opened = years.flatMap((y) => (!isOpen(yearKey(y)) ? [] : y.championships.flatMap((c) => (
    !isOpen(champKey(y, c)) ? [] : c.events.filter((f) => f.sessions > 0 && isOpen(eventKey(f))).map((f) => f.key)))));
  const wanted = [...new Set([...(leadKey ? [leadKey] : []), ...opened])].join(',');
  useEffect(() => {
    for (const key of wanted ? wanted.split(',') : []) {
      if (read.current[key] === loads) continue;
      read.current[key] = loads;
      eventsApi.folder(key).then((folder) => setDetails((d) => ({ ...d, [key]: { ...d[key], folder } })), () => {});
    }
  }, [wanted, loads]);
  // the lead event's report and logger, read again with the list
  const leadBestSession = lead?.best_session_id ?? null;
  useEffect(() => {
    if (!leadKey) return;
    const put = (d: Detail) => setDetails((all) => ({ ...all, [leadKey]: { ...all[leadKey], ...d } }));
    fetchReport({ event: Number(leadKey) }).then((a) => {
      if (a.report) put({ report: a.report });
    }, () => {});
    if (leadBestSession != null) {
      api.session(leadBestSession).then((s) => {
        const logger = s.files.find((f) => f.logger)?.logger;
        if (logger) put({ logger });
      }, () => {});
    }
  }, [leadKey, leadBestSession, loads]);

  const renamed = (key: string) => (name: string) => {
    setFolders((list) => list?.map((x) => (x.key === key ? { ...x, name } : x)) ?? list);
    load();
  };

  // no big block for the latest event on top (Gabriele, 2026-10-07: "i don't need this information"): the list starts the page
  return (
    <Page>
      <View style={wide ? styles.indexBar : styles.indexBarPhone}>
        <FilterBar filter={active} counts={counts} onPick={setFilter} />
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
              // on now: open it to upload into it; else show it where it is in the list, its year open
              const when = whenOf(ev, today);
              if (when === 'current') router.push({ pathname: '/event/[id]', params: { id: ev.key } });
              else {
                setFilter(when);
                setOpen([`y:${yearOf(ev) ?? 'none'}`], true);
              }
            }} />
        </View>
      ) : (
        <View style={wide ? styles.toolsLine : styles.toolsLinePhone}>
          {/* only what concerns the whole list here; comparing, tagging and the driver fingerprints are in each event
              and under Tools (Gabriele, 2026-10-07: that row "is normally event specific") */}
          <TextLink onPress={() => setMaking(true)} label="+ New event" />
          {calendar && (
            <View style={wide ? styles.sync : styles.syncPhone}>
              <CalendarLine calendar={calendar} onSynced={(c) => {
                setCalendar(c);
                load();
              }} />
            </View>
          )}
        </View>
      )}
      {/* the questions about which season an upload belongs to, when the app isn't sure */}
      {folders && (
        <View style={styles.seasons}>
          <SeasonMatchCount onChanged={load} />
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
      {folders && folders.length > 0 && active !== 'all' && shown.length === 0 && (
        <Text style={StyleSheet.flatten([styles.empty, styles.emptyList])}>{EMPTY[active]}</Text>
      )}
      {loose && <LooseRuns f={loose} onChanged={load} />}
      {years.map((y, i) => (
        <YearFold key={y.key} no={i + 1} y={y} isOpen={isOpen} toggle={toggle} today={today}>
          {(c) => c.events.map((f) => (
            <EventFold key={f.key} f={f} open={isOpen(eventKey(f))} onToggle={() => toggle(eventKey(f))}
              country={countryOfEvent(f)}
              detail={details[f.key]} plan={f.id != null ? plans.get(f.id) : undefined}
              prep={f.id != null ? prep[String(f.id)] : undefined} onChanged={load} onRenamed={renamed(f.key)} />
          ))}
        </YearFold>
      ))}
      <Colophon left="The Engineer · Sessions" links={[
        { label: 'Seasons', href: '/seasons' },
        { label: 'Garage', href: '/garage' },
        { label: 'Racing calendar', href: '/tools/calendar' },
      ]} />
    </Page>
  );
}

const EMPTY: Record<When, string> = {
  current: 'Nothing on today or tomorrow.',
  upcoming: 'Nothing planned yet. Plan a test or a race weekend with + New event, or bring them in from your racing calendar.',
  past: 'No past events yet.',
};

// ---------- a year, its championships ----------

/** A year of events, folded or open: its heading (how many events and championships, the months they span), then
 * each championship, folded or open (how many events, how many still to come), with its events. */
function YearFold({ no, y, isOpen, toggle, today, children }: {
  no: number;
  y: Year;
  isOpen: (key: string) => boolean;
  toggle: (key: string) => void;
  today: string;
  children: (c: Championship) => ReactNode;
}) {
  const styles = useStyles();
  const wide = useWide();
  const seasons = y.championships.filter((c) => !c.other).length;
  const facts = [plural(y.events, 'event'), seasons ? plural(seasons, 'championship') : null, monthSpan(y.start, y.end)]
    .filter(Boolean).join(' · ');
  const open = isOpen(yearKey(y));
  return (
    <View style={wide ? styles.year : styles.yearPhone}>
      <FoldHead no={no} title={y.year == null ? 'No date' : String(y.year)} facts={facts} open={open}
        onToggle={() => toggle(yearKey(y))} what={y.year == null ? 'the events with no date' : String(y.year)} />
      {open && y.championships.map((c) => {
        const key = champKey(y, c);
        const ahead = c.events.filter((f) => whenOf(f, today) === 'upcoming').length;
        return (
          <View key={c.key} style={wide ? styles.champ : styles.champPhone}>
            <SubFoldHead title={c.name} open={isOpen(key)} onToggle={() => toggle(key)} what="the championship"
              facts={[plural(c.events.length, 'event'), ahead ? `${ahead} to come` : null].filter(Boolean).join(' · ')} />
            {isOpen(key) && children(c)}
          </View>
        );
      })}
    </View>
  );
}

// ---------- words ----------

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const metres = (m: number) => `${Math.round(m).toLocaleString('en-GB')} m`;
const pad2 = (n: number) => String(n).padStart(2, '0');

/** "28–30 Aug", "31 Oct–2 Nov", "Tue 3 Nov": the year's heading above says the year. */
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

/** An event: one line (its days, name, round, track, runs and best lap, or what is planned) that folds and opens with
 * a tap; open, its runs and links (an event with data) and its actions: Rename, Delete (Remove when planned) and the
 * Prep report. Renaming takes the line's place. */
function EventFold({ f, open, onToggle, detail, plan, prep, onRenamed, onChanged, country }: {
  f: FolderSummary;
  country: Country | null; // its flag and three letters before its name
  open: boolean;
  onToggle: () => void;
  detail?: Detail;
  plan?: Plan;
  prep: PrepAvailability[string] | undefined; // past data at its track: the Prep report button
  onRenamed: (name: string) => void;
  onChanged: () => void;
}) {
  const styles = useStyles();
  const wide = useWide();
  const c = useTheme();
  const [renaming, setRenaming] = useState(false);
  const id = f.id!;
  const planned = f.sessions === 0; // no data yet
  const past = whenOf(f, todayIso()) === 'past';
  const round = f.season?.round != null ? `Round ${f.season.round}` : null;
  const meta = planned ? [round, plannedLine(f, plan)].filter(Boolean).join(' · ')
    : [round, f.track, driverLapsLine(f), carLine(f), plural(f.sessions, 'run'),
      f.clean_laps ? plural(f.clean_laps, 'clean lap') : null]
      .filter(Boolean).join(' · ');
  const status = planned ? { text: past ? 'No data' : 'Planned', line: past ? c.textMuted : c.rule }
    : { text: `Best ${formatLap(f.best_lap_s)}`, line: c.rule };
  const dates = shortDates(f.start, f.end) ?? 'Days not set';
  return (
    <View style={styles.item}>
      {renaming ? (
        <RenameEvent id={id} initial={f.name} onCancel={() => setRenaming(false)}
          onSaved={(saved) => {
            setRenaming(false);
            onRenamed(saved.name);
          }} />
      ) : (
        <Pressable onPress={onToggle} accessibilityRole="button" accessibilityState={{ expanded: open }}
          accessibilityLabel={`${f.name}, ${dates}, ${meta}, ${status.text}`}
          accessibilityHint={open ? 'Folds the event' : 'Opens the event'} style={styles.itemHead}>
          <View style={wide ? styles.itemLine : styles.itemLinePhone}>
            <Text style={wide ? styles.itemDate : styles.itemDatePhone}>{dates}</Text>
            <View style={styles.itemWhat}>
              {country ? (
                <View style={wide ? styles.nameLine : styles.nameLinePhone}>
                  <CountryTag country={country} />
                  <Text style={StyleSheet.flatten([wide ? styles.itemName : styles.itemNamePhone, styles.nameShrink])}>
                    {shortName(f)}
                  </Text>
                </View>
              ) : <Text style={wide ? styles.itemName : styles.itemNamePhone}>{shortName(f)}</Text>}
              <Text style={styles.itemMeta}>{meta}</Text>
            </View>
            <Text style={StyleSheet.flatten([styles.status, { borderColor: status.line }])}>{status.text}</Text>
          </View>
          <Text style={wide ? styles.itemMark : styles.itemMarkPhone}>{open ? '▾' : '▸'}</Text>
        </Pressable>
      )}
      {open && !renaming && (
        <View style={styles.itemBody}>
          {planned ? (
            <View style={styles.linksAlone}>
              <TextLink href={{ pathname: '/event/[id]', params: { id: f.key } }} label="Event page" arrow />
            </View>
          ) : <Feature f={f} detail={detail} />}
          <View style={styles.itemActions}>
            <TextLink onPress={() => setRenaming(true)} label="Rename" small />
            {planned ? <RemovePlanned f={f} plan={plan} onRemoved={onChanged} />
              : <DeleteEventAction id={id} name={f.name} onDeleted={onChanged} />}
            <PrepButton eventId={id} info={prep} compact />
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

const DAY_GAP = 24; // between the day columns of an open event
const MIN_DAY = 230; // narrowest a day column gets before the days go two a row

/** An event open on the page: its links, its runs by day (each with its best lap: a purple block for the event's
 * best, else a red bar for the gap to it), and beside them the best lap, clean laps, ideal lap (the lead event's,
 * from its report; runs for the others) and the event's facts. */
function Feature({ f, detail }: { f: FolderSummary; detail?: Detail }) {
  const styles = useStyles();
  const wide = useWide();
  const c = useTheme();
  const folder = detail?.folder;
  const report = detail?.report;
  const best = f.best_lap_s;
  const runs = folder?.days.flatMap((d) => d.sessions) ?? [];
  const maxGap = Math.max(0.5, ...runs.map((s) => (s.best_lap_s != null && best != null ? s.best_lap_s - best : 0)));
  const bestRun = runs.find((s) => s.id === f.best_session_id);
  const drivers = [...new Set(runs.map((s) => s.driver).filter(Boolean))] as string[];
  const id = f.id!;
  // Three or four days of driving (Gabriele, 2026-10-07: "allow for 4 columns"): the days take the page's whole
  // width side by side and the figures go under them; a window too narrow for that many columns shows two a row
  const { width } = useWindowDimensions();
  const nDays = folder?.days.length ?? 0;
  const full = wide && nDays >= 3;
  const across = Math.min(width, 1240) - 2 * Space.gutter;
  const oneRow = !full || (across - (nDays - 1) * DAY_GAP) / nDays >= MIN_DAY;
  const dayStyle = full ? (oneRow ? styles.dayAcross : styles.dayHalf) : wide ? styles.day : undefined;
  let no = 0;
  let dated = 0;
  return (
    <View style={full ? styles.featureFull : wide ? styles.feature : styles.featurePhone}>
      <View style={styles.featureMain}>
        <View style={styles.links}>
          <TextLink href={{ pathname: '/report', params: { event: id } }} label="Report" red arrow />
          <TextLink href={{ pathname: '/technique', params: { event: id } }} label="Technique check" arrow />
          <TextLink href={{ pathname: '/tools/stint', params: { event: id } }} label="Stint analysis" arrow />
          <TextLink href={{ pathname: '/drivers/compare', params: { event: id } }} label="Compare drivers" arrow />
          <TextLink href={{ pathname: '/event/[id]', params: { id: f.key } }} label="Event page" arrow />
        </View>
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
                  {day.sessions.map((s) => {
                    no += 1;
                    return <RunRow key={s.id} s={s} no={no} best={best} maxGap={maxGap} />;
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
            {report
              ? <Fig label="Ideal lap" value={formatLap(report.headline.ideal)} size={64} />
              : <Fig label="Runs" value={String(f.sessions)} size={64} />}
          </View>
        </View>
        <View style={full ? styles.specsUnder : styles.specs}>
          {f.track && <SpecLine label="Track" value={report ? `${f.track} · ${metres(report.length_m)}` : f.track} />}
          {drivers.length > 0 && <SpecLine label={drivers.length === 1 ? 'Driver' : 'Drivers'} value={drivers.join(' / ')} />}
          {report && <SpecLine label="Laps analysed" value={`${report.laps_analysed} of ${plural(report.runs_analysed, 'run')}`} />}
          {detail?.logger && <SpecLine label="Logger" value={detail.logger} />}
        </View>
      </View>
    </View>
  );
}

function RunRow({ s, no, best, maxGap }: { s: FolderSession; no: number; best: number | null; maxGap: number }) {
  const styles = useStyles();
  const c = useTheme();
  const gap = s.best_lap_s != null && best != null ? s.best_lap_s - best : null;
  const isBest = gap != null && gap < 0.0005;
  return (
    // Link asChild hands its child's style to a web anchor, which can't take a style array: one object
    <Link href={{ pathname: '/session/[id]', params: { id: s.id } }} asChild>
      <Pressable style={styles.run} accessibilityRole="link">
        <Text style={styles.runNo}>{pad2(no)}</Text>
        <View style={styles.runId}>
          <Text style={styles.runCode} numberOfLines={1}>{s.name}</Text>
          <Text style={styles.runSub} numberOfLines={1}>
            {[s.time, `${plural(s.laps, 'lap')} (${s.clean_laps} clean)`, s.driver].filter(Boolean).join(' · ')}
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
              {isBest ? <Text style={StyleSheet.flatten([styles.gap, { color: c.timing.best }])}>Event best</Text> : gap != null && (
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
  );
}

const DATE_W = 170;

const useStyles = themed((c) => ({
  // the index: the filter's words and the upload block
  indexBar: { flexDirection: 'row', alignItems: 'stretch', justifyContent: 'space-between', borderBottomWidth: 1,
    borderColor: c.rule, gap: 20 },
  indexBarPhone: { flexDirection: 'column', borderBottomWidth: 1, borderColor: c.rule },
  upload: { justifyContent: 'center', backgroundColor: c.rule, paddingVertical: 14, paddingHorizontal: 22, minWidth: 300 },
  uploadPhone: { justifyContent: 'center', backgroundColor: c.rule, paddingVertical: 14, paddingHorizontal: 16 },
  uploadBig: { fontFamily: Fonts.display, fontSize: 28, lineHeight: 30, textTransform: 'uppercase', color: c.background },
  uploadBigPhone: { fontFamily: Fonts.display, fontSize: 26, lineHeight: 28, textTransform: 'uppercase', color: c.background },
  // the faint rule colour reads as a quiet grey on the ink block, in either scheme
  uploadSmall: { ...Type.label, fontFamily: Fonts.label, letterSpacing: 1, color: c.border, marginTop: 6 },
  seasons: { paddingTop: 10 },
  toolsLine: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 22, paddingTop: 12 },
  toolsLinePhone: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: 18, rowGap: 12, paddingTop: 12 },
  sync: { marginLeft: 'auto' },
  syncPhone: { width: '100%' },
  plan: { marginTop: 16, gap: 8, borderTopWidth: 3, borderColor: c.rule, paddingTop: 10, maxWidth: 640 },
  error: { color: c.error, marginTop: 16 },
  loading: { marginTop: 24, alignSelf: 'flex-start' },
  empty: { fontFamily: Type.dek.fontFamily, fontSize: 17, lineHeight: 24, color: c.textSecondary, marginTop: 4 },

  emptyList: { marginTop: 18 },

  // a year, its championships
  year: { marginTop: 40 },
  yearPhone: { marginTop: 30 },
  champ: { marginTop: 22 },
  champPhone: { marginTop: 18 },

  // one line per event, folded or open
  item: { borderBottomWidth: 1, borderColor: c.rule, paddingTop: 14, paddingBottom: 13 },
  itemHead: { flexDirection: 'row', alignItems: 'flex-start', gap: 14 },
  itemLine: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'baseline', gap: 22 },
  itemLinePhone: { flex: 1, minWidth: 0, flexDirection: 'column', gap: 6 },
  itemDate: { fontFamily: Fonts.display, fontSize: 34, lineHeight: 34, textTransform: 'uppercase', width: DATE_W, color: c.text },
  itemDatePhone: { ...Type.label, fontSize: 15, letterSpacing: 1.8, color: c.text },
  itemWhat: { flex: 1, minWidth: 0 },
  // the flag and three letters before the name
  nameLine: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  nameLinePhone: { flexDirection: 'row', alignItems: 'center', gap: 11 },
  nameShrink: { flexShrink: 1 },
  itemName: { fontFamily: Fonts.display, fontSize: 30, lineHeight: 32, textTransform: 'uppercase', color: c.text },
  itemNamePhone: { fontFamily: Fonts.display, fontSize: 26, lineHeight: 28, textTransform: 'uppercase', color: c.text },
  itemMeta: { fontFamily: Fonts.body, fontSize: 16, lineHeight: 22, color: c.textSecondary, marginTop: 4 },
  status: { ...Type.label, alignSelf: 'flex-start', borderBottomWidth: 3, paddingBottom: 2, color: c.text },
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
  run: { flexDirection: 'row', alignItems: 'center', gap: 10, borderBottomWidth: 1, borderColor: c.separator,
    paddingTop: 9, paddingBottom: 8 },
  runNo: { fontFamily: Fonts.display, fontSize: 24, lineHeight: 26, width: 30, color: c.text },
  runId: { flex: 1, minWidth: 0 },
  runCode: { fontFamily: Type.label.fontFamily, fontSize: 17, letterSpacing: 0.3, color: c.text },
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
