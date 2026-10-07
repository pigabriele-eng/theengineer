import { Href, Link, useFocusEffect, useNavigation, useRouter } from 'expo-router';
import { ReactNode, useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet } from 'react-native';

import { CalendarLine, FilterBar, PlanForm, plannedLine, RemovePlanned } from '@/components/EventFilter';
import { PrepButton, usePrepAvailability } from '@/components/PrepButton';
import {
  B, Colophon, Fig, Folio, Hero, InsetPhoto, Label, Page, Section, SpecLine, Swatch, TextLink, useWide,
} from '@/components/Programme';
import { RenameEvent } from '@/components/RenameEvent';
import { Text, View } from '@/components/Themed';
import { api, formatLap } from '@/lib/api';
import {
  CalendarState, calendarApi, countByWhen, defaultFilter, Filter, filtered, Plan, todayIso, When, whenOf,
} from '@/lib/calendar';
import { dateRange, dayLabel, eventsApi, Folder, FolderSession, FolderSummary, KIND_NAMES } from '@/lib/events';
import { launchEvent } from '@/lib/openCurrent';
import { PrepAvailability } from '@/lib/prep';
import { fetchReport, Report } from '@/lib/report';
import { face, Fonts, PHOTOS, photoFor, themed, Type, useTheme } from '@/constants/Theme';

// What the page knows about an event beyond the list: its runs by day, its report and the logger it was recorded on.
type Detail = { folder?: Folder; report?: Report; logger?: string };

/** Events, newest first, as a race programme: the event on now (else the latest one driven) on the photo at the top
 * with its facts, then the index (Past, Current, Upcoming, All) and numbered sections. The lead event shows its runs
 * by day, each with its best lap and the gap to the event's best, beside the event's big figures; the next past event
 * its photo and its quickest sessions; the rest one line each. Sessions in no event have a line of their own, so they
 * get filed. Planned events (made here or from the racing calendar) wait under Upcoming until their data comes in.
 * Opened while an event is on, the app goes straight on to that event's page (lib/openCurrent.ts). */
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
  const groups: Record<When, FolderSummary[]> = {
    current: folders ? filtered(folders, 'current', today) : [],
    past: folders ? filtered(folders, 'past', today) : [],
    upcoming: folders ? filtered(folders, 'upcoming', today) : [],
  };
  const plans = new Map((calendar?.plans ?? []).map((p) => [p.event_id, p]));
  // the event at the top of the page: on now, else the latest driven, else the next one
  const lead = groups.current.find((f) => f.id != null) ?? groups.past.find((f) => f.id != null && f.sessions > 0)
    ?? groups.upcoming.find((f) => f.id != null) ?? null;
  const leadWhen = lead ? whenOf(lead, today) : null;
  // the past event after it, shown with its photo and its quickest sessions
  const second = groups.past.find((f) => f.id != null && f.sessions > 0 && f.key !== lead?.key) ?? null;

  // the lead event's runs, report and logger, and the second's runs, read again with the list
  const leadKey = lead && lead.sessions > 0 ? lead.key : null;
  const leadBestSession = lead?.best_session_id ?? null;
  const secondKey = second?.key ?? null;
  useEffect(() => {
    const put = (key: string, d: Detail) => setDetails((all) => ({ ...all, [key]: { ...all[key], ...d } }));
    for (const key of [leadKey, secondKey]) {
      if (key) eventsApi.folder(key).then((folder) => put(key, { folder }), () => {});
    }
    if (!leadKey) return;
    fetchReport({ event: Number(leadKey) }).then((a) => {
      if (a.report) put(leadKey, { report: a.report });
    }, () => {});
    if (leadBestSession != null) {
      api.session(leadBestSession).then((s) => {
        const logger = s.files.find((f) => f.logger)?.logger;
        if (logger) put(leadKey, { logger });
      }, () => {});
    }
  }, [leadKey, secondKey, leadBestSession, loads]);

  const timed = folders?.some((f) => f.best_lap_s != null) ?? false;
  const leadDetail = lead ? details[lead.key] : undefined;
  const sections: When[] = active === 'all'
    ? (['current', 'past', 'upcoming'] as When[]).filter((w) => groups[w].length > 0)
    : [active];

  const top = lead ? (
    <>
      <Hero photo={photoFor(lead.track)} tag={TAG[leadWhen!]} rest="Sessions" title={headlineOf(lead, leadDetail?.folder)}
        deck={deckOf(lead, plans.get(lead.id!))} />
      <Folio items={[
        lead.track ? (
          <>{lead.track}{leadDetail?.report ? <> <B>{metres(leadDetail.report.length_m)}</B></> : null}</>
        ) : null,
        dateRange(lead.start, lead.end),
        lead.sessions > 0 ? <><B>{lead.sessions}</B> runs · <B>{lead.clean_laps}</B> clean laps</> : 'No data yet',
        lead.best_lap_s != null ? <>Best <B>{formatLap(lead.best_lap_s)}</B></> : null,
      ]} />
    </>
  ) : (
    <Hero photo={PHOTOS.dusk} tag="Sessions" title="The Engineer"
      deck={folders ? 'No events yet. Upload logs or a zip of a whole test: each log becomes a run, and a zip an event of its own.' : undefined} />
  );

  return (
    <Page top={top}>
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
              // on now: open it to upload into it; else show it where it is in the list
              const when = whenOf(ev, today);
              if (when === 'current') router.push({ pathname: '/event/[id]', params: { id: ev.key } });
              else setFilter(when);
            }} />
        </View>
      ) : (
        <View style={wide ? styles.toolsLine : styles.toolsLinePhone}>
          <TextLink onPress={() => setMaking(true)} label="+ New event" />
          {timed && <TextLink href="/compare" label="Compare laps" />}
          <TextLink href="/drivers/tag" label="Tag drivers" />
          <TextLink href="/drivers/compare" label="Compare drivers" />
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
      {error && <Text style={styles.error}>Can&apos;t reach the server: {error}</Text>}
      {!folders && !error && <ActivityIndicator style={styles.loading} />}
      {folders?.length === 0 && (
        <Text style={styles.empty}>
          No events yet. Upload logs or a zip of a whole test: each log becomes a run, and a zip becomes an event of its
          own. Or make an event first with + New event and upload into it.
        </Text>
      )}
      {folders && folders.length > 0 && sections.map((when, i) => {
        const list = groups[when];
        const leadHere = lead && leadWhen === when && lead.sessions > 0 ? lead : null;
        const secondHere = when === 'past' ? second : null;
        const rest = list.filter((f) => f.key !== leadHere?.key && f.key !== secondHere?.key);
        return (
          <Section key={when} no={i + 1} title={TITLE[when]} dek={leadHere ? LEAD_DEK[when] : DEK[when]}>
            {list.length === 0 && <Text style={styles.empty}>{EMPTY[when]}</Text>}
            {leadHere && <Feature f={leadHere} detail={details[leadHere.key]} />}
            {secondHere && <PastHead f={secondHere} folder={details[secondHere.key]?.folder} />}
            {rest.length > 0 && (
              <View style={leadHere || secondHere ? styles.moreList : undefined}>
                {rest.map((f, k) => (
                  <ListItem key={f.key} f={f} when={when} first={k === 0} plan={f.id != null ? plans.get(f.id) : undefined}
                    prep={f.id != null ? prep[String(f.id)] : undefined} onChanged={load}
                    onRenamed={(name) => {
                      setFolders((all) => all?.map((x) => (x.key === f.key ? { ...x, name } : x)) ?? all);
                      load();
                    }} />
                ))}
              </View>
            )}
          </Section>
        );
      })}
      <Colophon left="The Engineer · Sessions" links={[
        { label: 'Seasons', href: '/seasons' },
        { label: 'Garage', href: '/garage' },
        { label: 'Racing calendar', href: '/tools/calendar' },
      ]} />
    </Page>
  );
}

const TAG: Record<When, string> = { current: 'Current event', past: 'Latest event', upcoming: 'Next event' };
const TITLE: Record<When, string> = { current: 'Current', past: 'Past', upcoming: 'Upcoming' };
const DEK: Record<When, string> = {
  current: 'On now, from the day before an event to its last day.',
  past: 'Race weekends and tests already run.',
  upcoming: 'Planned here, from the season and from your racing calendar.',
};
const LEAD_DEK: Record<When, string> = {
  current: 'On track this week. Tap a run to open it, or read the event report.',
  past: 'The latest event first: tap a run to open it, or read the event report.',
  upcoming: DEK.upcoming,
};
const EMPTY: Record<When, string> = {
  current: 'Nothing on today or tomorrow.',
  upcoming: 'Nothing planned yet. Plan a test or a race weekend with + New event, or bring them in from your racing calendar.',
  past: 'No past events yet.',
};

// ---------- words ----------

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];
const inWords = (n: number) => WORDS[n] ?? String(n);
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const metres = (m: number) => `${Math.round(m).toLocaleString('en-GB')} m`;
const pad2 = (n: number) => String(n).padStart(2, '0');

/** A track's short name for a headline: "Hockenheim" for the Hockenheimring, "Spa" for Circuit de Spa-Francorchamps. */
function shortTrack(track: string | null) {
  if (!track) return null;
  const t = track.replace(/^(Circuit|Circuito|Autodromo|Autódromo)( de| di| do| of)?\s+/i, '').trim();
  if (/^hockenheim/i.test(t)) return 'Hockenheim';
  return t.split(/\s*[,(]|\s+-\s+|-(?=[A-Z])/)[0];
}

/** What kind of event its runs make: a race weekend (qualifying or races), a practice, or a test. */
function kindOf(folder: Folder | undefined, f: FolderSummary): 'test' | 'practice' | 'weekend' {
  const kinds = new Set(folder?.days.flatMap((d) => d.sessions.map((s) => s.kind)) ?? []);
  if (kinds.has('race') || kinds.has('qualifying')) return 'weekend';
  if (kinds.size) return kinds.has('test') ? 'test' : 'practice';
  return f.series ? 'weekend' : 'test';
}
const KIND_LABEL = { test: 'Test', practice: 'Practice', weekend: 'Race weekend' } as const;

/** The headline on the photo: "Hockenheim test", "Zandvoort weekend"; the event's name without a track. */
function headlineOf(f: FolderSummary, folder?: Folder) {
  const short = shortTrack(f.track);
  return short ? `${short} ${kindOf(folder, f)}` : f.name;
}

const dayCount = (start: string | null, end: string | null) => {
  if (!start || !end) return start || end ? 1 : 0;
  return Math.round((Date.parse(end) - Date.parse(start)) / 86_400_000) + 1;
};

/** The italic line under the headline. */
function deckOf(f: FolderSummary, plan?: Plan) {
  if (f.sessions === 0) return `${f.name}: ${plannedLine(f, plan).toLowerCase()}.`;
  const days = dayCount(f.start, f.end);
  return `${f.name}: ${inWords(f.sessions)} run${f.sessions === 1 ? '' : 's'}${days ? ` over ${inWords(days)} day${days === 1 ? '' : 's'}` : ''}, ${plural(f.clean_laps, 'clean lap')}.`;
}

/** "28–30 Aug", "31 Oct–2 Nov", "Tue 3 Nov"; with the year when it isn't this one. */
function shortDates(start: string | null, end: string | null) {
  const a = start ?? end;
  const b = end ?? start;
  if (!a || !b) return null;
  const [ya, ma, da] = a.split('-').map(Number);
  const [yb, mb, db] = b.split('-').map(Number);
  const year = yb !== new Date().getFullYear() ? ` ${yb}` : '';
  if (a === b) return `${dayLabel(a)}${year}`;
  if (ya === yb && ma === mb) return `${da}–${db} ${MONTHS[mb - 1]}${year}`;
  return `${da} ${MONTHS[ma - 1]}–${db} ${MONTHS[mb - 1]}${year}`;
}

/** A session's short code for its block: FP1, Q, R1... from its name, else its kind. */
function codeOf(s: FolderSession) {
  const m = s.name.match(/\b(FP\s?\d|Q\s?\d?|R(?:ace)?\s?\d|Warm-?up)\b/i);
  if (m) return m[1].replace(/^race\s?/i, 'R').replace(/\s/g, '').replace(/^warm-?up$/i, 'WU').toUpperCase();
  return { test: 'T', practice: 'FP', qualifying: 'Q', race: 'R' }[s.kind];
}

// ---------- the lead event ----------

/** The lead event: its name and links, its runs by day (each with its best lap: a purple block for the event's best,
 * else a red bar for the gap to it), and beside them the best lap, clean laps, ideal lap and the event's facts. */
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
  let no = 0;
  let dated = 0;
  return (
    <View style={wide ? styles.feature : styles.featurePhone}>
      <View style={styles.featureMain}>
        <Label muted>{[KIND_LABEL[kindOf(folder, f)], f.series, f.track].filter(Boolean).join(' · ')}</Label>
        <Text style={wide ? styles.evTitle : styles.evTitlePhone}>{f.name}</Text>
        <Text style={styles.evMeta}>
          {[dateRange(f.start, f.end), plural(f.sessions, 'run'), best != null ? `best ${formatLap(best)}` : null]
            .filter(Boolean).join(' · ')}
        </Text>
        <View style={styles.actions}>
          <TextLink href={{ pathname: '/report', params: { event: id } }} label="Report" red arrow />
          <TextLink href={{ pathname: '/technique', params: { event: id } }} label="Technique check" arrow />
          <TextLink href={{ pathname: '/tools/stint', params: { event: id } }} label="Stint analysis" arrow />
          <TextLink href={{ pathname: '/drivers/compare', params: { event: id } }} label="Compare drivers" arrow />
          <TextLink href={{ pathname: '/event/[id]', params: { id: f.key } }} label="Event page" arrow />
        </View>
        {!folder ? <ActivityIndicator style={styles.loading} /> : (
          <View style={wide ? styles.days : styles.daysPhone}>
            {folder.days.map((day) => {
              if (day.date) dated += 1;
              return (
                <View key={day.date ?? 'none'} style={wide ? styles.day : undefined}>
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

      <View style={wide ? styles.side : undefined}>
        {best != null && (
          <Fig label="Best lap of the event" value={formatLap(best)} size={wide ? 104 : 96} bar={c.timing.best}
            note={bestRun ? [`${bestRun.name}, lap ${bestRun.best_lap ?? '?'}`, bestRun.date
              ? `${dayLabel(bestRun.date, { long: true }).split(' ')[0]}${bestRun.time ? ` ${bestRun.time}` : ''}` : null]
              .filter(Boolean).join(' · ') : f.best_session ?? undefined} />
        )}
        <View style={styles.pair}>
          <View style={styles.pairLeft}><Fig label="Clean laps" value={String(f.clean_laps)} size={64} /></View>
          <View style={styles.pairRight}>
            {report
              ? <Fig label="Ideal lap" value={formatLap(report.headline.ideal)} size={64} />
              : <Fig label="Runs" value={String(f.sessions)} size={64} />}
          </View>
        </View>
        <View style={styles.specs}>
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

// ---------- the next past event ----------

/** A past event under the lead one: its track as the headline with its photo framed beside it (the credit as the
 * caption), then its qualifying and races (a test: its three quickest runs) with their best laps, large. */
function PastHead({ f, folder }: { f: FolderSummary; folder?: Folder }) {
  const styles = useStyles();
  const wide = useWide();
  const photo = photoFor(f.track);
  const kind = kindOf(folder, f);
  const runs = folder?.days.flatMap((d) => d.sessions) ?? [];
  const timed = runs.filter((s) => s.best_lap_s != null);
  const strip = kind === 'weekend'
    ? timed.filter((s) => s.kind === 'qualifying' || s.kind === 'race').slice(0, 4)
    : [...timed].sort((a, b) => a.best_lap_s! - b.best_lap_s!).slice(0, 3);
  return (
    <View>
      <View style={wide ? styles.pastHead : styles.pastHeadPhone}>
        <View style={styles.pastText}>
          <Label muted>{[f.series, KIND_LABEL[kind], f.track].filter(Boolean).join(' · ')}</Label>
          <Text style={wide ? styles.pastTitle : styles.pastTitlePhone}>{shortTrack(f.track) ?? f.name}</Text>
          <Text style={styles.evMeta}>
            {[dateRange(f.start, f.end), f.name, plural(f.sessions, 'run'),
              f.best_lap_s != null ? `best ${formatLap(f.best_lap_s)}` : null].filter(Boolean).join(' · ')}
          </Text>
          <View style={styles.openLink}>
            <TextLink href={{ pathname: '/event/[id]', params: { id: f.key } }}
              label={kind === 'weekend' ? 'Open the weekend' : 'Open the event'} arrow />
          </View>
        </View>
        {photo !== PHOTOS.dusk && (
          <InsetPhoto photo={photo} height={wide ? 210 : 200} style={wide ? styles.pastPic : undefined} />
        )}
      </View>
      {strip.length > 0 && (
        <View style={wide ? styles.weekend : styles.weekendPhone}>
          {strip.map((s, i) => (
            <Link key={s.id} href={{ pathname: '/session/[id]', params: { id: s.id } }} asChild>
              <Pressable accessibilityRole="link" style={StyleSheet.flatten([
                wide ? styles.sess : styles.sessPhone,
                wide && i === 0 && styles.sessFirst,
                i === strip.length - 1 && styles.sessLast,
              ])}>
                <View style={wide ? styles.sessType : styles.sessTypePhone}>
                  <Text style={styles.sessTypeText}>{kind === 'weekend' ? codeOf(s) : pad2(runs.indexOf(s) + 1)}</Text>
                </View>
                <View style={wide ? undefined : styles.sessMid}>
                  <Text style={wide ? styles.sessWhen : styles.sessWhenPhone}>
                    {[s.date ? dayLabel(s.date) : null, s.time].filter(Boolean).join(' · ')}
                  </Text>
                  <Text style={styles.sessLaps}>
                    {`${kind === 'weekend' ? KIND_NAMES[s.kind] : s.name} · ${plural(s.laps, 'lap')} (${s.clean_laps} clean)`}
                  </Text>
                </View>
                <Text style={wide ? styles.sessLap : styles.sessLapPhone}>{formatLap(s.best_lap_s)}</Text>
              </Pressable>
            </Link>
          ))}
        </View>
      )}
    </View>
  );
}

// ---------- one line per event ----------

function ListItem({ f, when, first, plan, prep, onRenamed, onChanged }: {
  f: FolderSummary;
  when: When;
  first: boolean;
  plan?: Plan;
  prep: PrepAvailability[string] | undefined; // past data at its track: the Prep report button
  onRenamed: (name: string) => void;
  onChanged: () => void;
}) {
  const styles = useStyles();
  const wide = useWide();
  const c = useTheme();
  const [renaming, setRenaming] = useState(false);
  const loose = f.id == null;
  const planned = !loose && f.sessions === 0; // no data yet
  const meta = loose ? 'Open to move them into an event'
    : planned ? plannedLine(f, plan)
      : [f.series, f.track, plural(f.sessions, 'run'), f.clean_laps ? plural(f.clean_laps, 'clean lap') : null]
        .filter(Boolean).join(' · ');
  const status: { text: string; line: string } = loose ? { text: plural(f.sessions, 'run'), line: c.rule }
    : planned ? { text: when === 'past' ? 'No data' : 'Planned', line: when === 'past' ? c.textMuted : c.rule }
      : { text: `Best ${formatLap(f.best_lap_s)}`, line: c.rule };
  let body: ReactNode;
  if (renaming && f.id != null) {
    body = (
      <RenameEvent id={f.id} initial={f.name} onCancel={() => setRenaming(false)}
        onSaved={(saved) => {
          setRenaming(false);
          onRenamed(saved.name);
        }} />
    );
  } else {
    const href: Href = { pathname: '/event/[id]', params: { id: f.key } };
    body = (
      // Link asChild hands its child's style to a web anchor, which can't take a style array: one object
      <Link href={href} asChild>
        <Pressable accessibilityRole="link" style={wide ? styles.itemLink : styles.itemLinkPhone}>
          <Text style={wide ? styles.itemDate : styles.itemDatePhone}>
            {loose ? 'Unfiled' : shortDates(f.start, f.end) ?? 'Days not set'}
          </Text>
          <View style={styles.itemWhat}>
            <Text style={wide ? styles.itemName : styles.itemNamePhone}>{f.name}</Text>
            <Text style={styles.itemMeta}>{meta}</Text>
          </View>
          <Text style={StyleSheet.flatten([styles.status, { borderColor: status.line }])}>{status.text}</Text>
        </Pressable>
      </Link>
    );
  }
  return (
    <View style={StyleSheet.flatten([styles.item, first && styles.itemFirst])}>
      {body}
      {!loose && !renaming && (
        <View style={wide ? styles.itemActions : styles.itemActionsPhone}>
          <TextLink onPress={() => setRenaming(true)} label="Rename" small />
          {planned && <RemovePlanned f={f} plan={plan} onRemoved={onChanged} />}
          {f.id != null && <PrepButton eventId={f.id} info={prep} compact />}
        </View>
      )}
    </View>
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
  toolsLine: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 22, paddingTop: 12 },
  toolsLinePhone: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: 18, rowGap: 12, paddingTop: 12 },
  sync: { marginLeft: 'auto' },
  syncPhone: { width: '100%' },
  plan: { marginTop: 16, gap: 8, borderTopWidth: 3, borderColor: c.rule, paddingTop: 10, maxWidth: 640 },
  error: { color: c.error, marginTop: 16 },
  loading: { marginTop: 24, alignSelf: 'flex-start' },
  empty: { fontFamily: Type.dek.fontFamily, fontSize: 17, lineHeight: 24, color: c.textSecondary, marginTop: 4 },

  // the lead event
  feature: { flexDirection: 'row', gap: 36 },
  featurePhone: { flexDirection: 'column', gap: 26 },
  featureMain: { flex: 1, minWidth: 0 },
  side: { width: 300 },
  evTitle: { fontFamily: Fonts.display, fontSize: 50, lineHeight: 50, textTransform: 'uppercase', marginTop: 6, color: c.text },
  evTitlePhone: { fontFamily: Fonts.display, fontSize: 36, lineHeight: 37, textTransform: 'uppercase', marginTop: 6, color: c.text },
  evMeta: { fontFamily: Fonts.body, fontSize: 17, lineHeight: 24, color: c.textSecondary, marginTop: 8 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', columnGap: 22, rowGap: 12, marginTop: 16, marginBottom: 26 },
  days: { flexDirection: 'row', flexWrap: 'wrap', gap: 28 },
  daysPhone: { flexDirection: 'column', gap: 22 },
  day: { flex: 1, minWidth: 260 },
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

  // the next past event
  pastHead: { flexDirection: 'row', gap: 32, alignItems: 'stretch' },
  pastHeadPhone: { flexDirection: 'column', gap: 16 },
  pastText: { flex: 1, minWidth: 0, justifyContent: 'flex-end' },
  pastTitle: { fontFamily: Fonts.display, fontSize: 72, lineHeight: 70, textTransform: 'uppercase', marginTop: 6, color: c.text },
  pastTitlePhone: { fontFamily: Fonts.display, fontSize: 44, lineHeight: 44, textTransform: 'uppercase', marginTop: 6,
    color: c.text },
  pastPic: { width: 420 },
  openLink: { marginTop: 16 },
  weekend: { flexDirection: 'row', borderTopWidth: 3, borderColor: c.rule, marginTop: 18 },
  weekendPhone: { flexDirection: 'column', borderTopWidth: 3, borderColor: c.rule, marginTop: 18 },
  sess: { flex: 1, paddingTop: 14, paddingBottom: 16, paddingHorizontal: 18, borderRightWidth: 1, borderColor: c.rule },
  sessFirst: { paddingLeft: 0 },
  sessLast: { borderRightWidth: 0, borderBottomWidth: 0 },
  sessPhone: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingTop: 12, paddingBottom: 14, borderBottomWidth: 1,
    borderColor: c.rule },
  sessType: { alignSelf: 'flex-start', backgroundColor: c.rule, paddingHorizontal: 9, paddingTop: 5, paddingBottom: 4 },
  sessTypePhone: { width: 52, alignItems: 'center', backgroundColor: c.rule, paddingTop: 5, paddingBottom: 4 },
  sessTypeText: { fontFamily: Fonts.display, fontSize: 22, lineHeight: 24, color: c.background },
  sessMid: { flex: 1, minWidth: 0 },
  sessWhen: { ...Type.label, fontFamily: Fonts.label, fontSize: 13, letterSpacing: 0.6, color: c.textSecondary, marginTop: 10 },
  sessWhenPhone: { ...Type.label, fontFamily: Fonts.label, fontSize: 13, letterSpacing: 0.6, color: c.textSecondary },
  sessLaps: { ...Type.dek, fontSize: 15, lineHeight: 20, color: c.textSecondary, marginTop: 4 },
  sessLap: { fontFamily: Fonts.display, fontSize: 64, lineHeight: 64, marginTop: 6, color: c.text },
  sessLapPhone: { fontFamily: Fonts.display, fontSize: 40, lineHeight: 42, color: c.text },

  // one line per event
  moreList: { marginTop: 4 },
  item: { borderBottomWidth: 1, borderColor: c.rule, paddingTop: 14, paddingBottom: 13 },
  itemFirst: { borderTopWidth: 1 },
  itemLink: { flexDirection: 'row', alignItems: 'baseline', gap: 22 },
  itemLinkPhone: { flexDirection: 'column', gap: 6 },
  itemDate: { fontFamily: Fonts.display, fontSize: 34, lineHeight: 34, textTransform: 'uppercase', width: DATE_W, color: c.text },
  itemDatePhone: { ...Type.label, fontSize: 15, letterSpacing: 1.8, color: c.text },
  itemWhat: { flex: 1, minWidth: 0 },
  itemName: { fontFamily: Fonts.display, fontSize: 30, lineHeight: 32, textTransform: 'uppercase', color: c.text },
  itemNamePhone: { fontFamily: Fonts.display, fontSize: 26, lineHeight: 28, textTransform: 'uppercase', color: c.text },
  itemMeta: { fontFamily: Fonts.body, fontSize: 16, lineHeight: 22, color: c.textSecondary, marginTop: 4 },
  status: { ...Type.label, alignSelf: 'flex-start', borderBottomWidth: 3, paddingBottom: 2, color: c.text },
  itemActions: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: 18, rowGap: 8, marginTop: 10,
    marginLeft: DATE_W + 22 },
  itemActionsPhone: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: 18, rowGap: 8, marginTop: 10 },
}));
