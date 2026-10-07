import { Link, Stack, useLocalSearchParams } from 'expo-router';
import { ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet } from 'react-native';

import {
  Choice, Choices, ErrorLine, Field, FormActions, Input, MainButton, Note, PageTitle, Said,
} from '@/components/Controls';
import { EntryFields, Lists, useLists } from '@/components/EventInfoForm';
import { FoldHead } from '@/components/Fold';
import { SeasonMatch } from '@/components/SeasonMatch';
import PrintButton from '@/components/PrintButton';
import { Block, Colophon, Label, Page, Section, TextLink, useWide } from '@/components/Programme';
import { Text, View } from '@/components/Themed';
import { todayIso } from '@/lib/calendar';
import { carLong } from '@/lib/garage';
import { dateRange, parseDay } from '@/lib/events';
import { noPrint } from '@/lib/print';
import {
  EMPTY_ENTRY,
  Entry,
  EntryRow,
  NotThere,
  ourEntry,
  readCalendar,
  RoundFields,
  roundsFrom,
  Season,
  SeasonRound,
  seasonsApi,
  Series,
  seriesApi,
  SeriesCalendar,
} from '@/lib/seasons';
import { SeasonQuestion, seasonMatchApi } from '@/lib/seasonMatch';
import { face, Fonts, inkOn, themed, Type, useTheme } from '@/constants/Theme';

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const THIS_YEAR = new Date().getFullYear();

// Which seasons are open, remembered on the device the way lib/appearance.ts keeps the Light/Dark choice: only the
// seasons tapped open or shut are kept, by id; the rest follow the default. No storage (a private window): the default.
const FOLD_KEY = 'theengineer.seasons.open';
type Folds = Record<string, boolean>;
function readFolds(): Folds {
  try {
    const v = JSON.parse(globalThis.localStorage?.getItem(FOLD_KEY) ?? '{}');
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}
function saveFolds(f: Folds) {
  try {
    globalThis.localStorage?.setItem(FOLD_KEY, JSON.stringify(f));
  } catch {
    // not remembered, but still folded or opened for this visit
  }
}

/** Open unless tapped shut: this year's seasons, else those of the next year ahead; the rest are folded. */
function openByDefault(seasons: Season[]): Set<number> {
  const now = seasons.filter((s) => s.year === THIS_YEAR);
  const ahead = seasons.filter((s) => s.year > THIS_YEAR).map((s) => s.year);
  const year = now.length ? THIS_YEAR : ahead.length ? Math.min(...ahead) : null;
  return new Set(seasons.filter((s) => s.year === year).map((s) => s.id));
}

/** The questions waiting about a season: which event is one of its rounds (an option names one of its rounds, or the
 * season) and who drove its rounds' events (a driver the driving style can't name). */
function questionsOf(s: Season, questions: SeasonQuestion[]) {
  const keys = new Set([...s.rounds.map((r) => `round:${r.id}`), `season:${s.id}`]);
  const events = new Set(s.rounds.map((r) => r.event_id).filter((id): id is number => id != null));
  return questions.filter((q) => q.options.some((o) => keys.has(o.key)) || (q.kind === 'driver' && events.has(q.event_id)));
}

/** Seasons made ahead: a series and a year with our car number and our entry (tyre, car, team, drivers 1 to 4). A
 * series the server can read from its site brings its calendar (every round becomes a planned event under Upcoming,
 * or joins the event already there) and fills our entry from our car's line on the entry list; any other series is
 * made by hand, its rounds typed in. Each event of a season takes its tyre, car, team and drivers from the season
 * unless set on the event. One numbered section per season. */
export default function SeasonsScreen() {
  const styles = useStyles();
  const [seasons, setSeasons] = useState<Season[] | null>(null);
  const [series, setSeries] = useState<Series[] | null>(null); // [] when the server can't read any series' site
  const [error, setError] = useState<string | null>(null);
  const [making, setMaking] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [questions, setQuestions] = useState<SeasonQuestion[]>([]);
  const { lists, error: listsError, reload: reloadLists } = useLists();
  // folded or open: what was tapped on this device, else the default; the season a link names (?season=) opens
  const [folds, setFolds] = useState<Folds>(readFolds);
  const { season: linked } = useLocalSearchParams<{ season?: string }>();
  const scroll = useRef<ScrollView>(null);
  const scrolled = useRef(false);

  const load = useCallback(() => {
    seasonsApi.list().then(
      (s) => {
        setSeasons(s);
        setError(null);
      },
      (e) => setError((e as Error).message),
    );
    seasonMatchApi.pending().then((p) => setQuestions(p.questions), () => setQuestions([])); // an older server: none
  }, []);
  useEffect(() => {
    load();
    seriesApi.series().then(setSeries, () => setSeries([])); // 404 on a server without the results module
  }, [load]);

  const defaults = seasons ? openByDefault(seasons) : new Set<number>();
  const isOpen = (s: Season) => folds[s.id] ?? (String(s.id) === linked || defaults.has(s.id));
  const setOpen = (id: number, open: boolean) =>
    setFolds((f) => {
      const next = { ...f, [id]: open };
      saveFolds(next);
      return next;
    });
  // the season a link names: once it is laid out, scroll to it
  const placed = (id: number, y: number) => {
    if (scrolled.current || String(id) !== linked) return;
    scrolled.current = true;
    scroll.current?.scrollTo({ y: Math.max(0, y - 12), animated: false });
  };

  return (
    <Page scrollRef={scroll}>
      <Stack.Screen options={{ title: 'Seasons' }} />
      <PageTitle title="Seasons"
        dek="Make a season for the year: its rounds become planned events under Upcoming, with their dates and venue, and each round’s event takes its tyre, car, team and drivers from the season unless you set them on the event." />
      <View style={styles.top}>
        {error && <ErrorLine>{error}</ErrorLine>}
        {listsError && <ErrorLine>{listsError}</ErrorLine>}
        {notice && <Said text={notice} onPress={() => setNotice(null)} />}
        {!making && <MainButton label="+ New season" onPress={() => setMaking(true)} disabled={!lists} />}
        <PrintButton title="Seasons" />
      </View>
      {making && lists && (
        <Section no="NEW" title="New season" dek="A series and a year, our car number and what we run." print={false}>
          <NewSeason lists={lists} series={series} onListsChanged={reloadLists} onCancel={() => setMaking(false)}
            onMade={(text, id) => {
              setMaking(false);
              setNotice(text);
              setOpen(id, true); // a season just made opens
              load();
              reloadLists(); // drivers and a team may have come from the entry list
            }} />
        </Section>
      )}
      {!seasons && !error && <ActivityIndicator style={styles.loading} />}
      {seasons && seasons.length === 0 && !making && <Note style={styles.empty}>No seasons yet.</Note>}
      {seasons && lists && seasons.map((s, i) => (
        <SeasonSection key={s.id} no={i + 1} season={s} lists={lists} series={series} onListsChanged={reloadLists}
          open={isOpen(s)} onToggle={() => setOpen(s.id, !isOpen(s))} questions={questionsOf(s, questions)}
          onLayout={(y) => placed(s.id, y)}
          onChanged={(text) => {
            if (text) setNotice(text);
            load();
            reloadLists();
          }} />
      ))}
      <Colophon left="The Engineer · Seasons" links={[
        { label: 'Sessions', href: '/' },
        { label: 'Garage', href: '/garage' },
        { label: 'Racing calendar', href: '/tools/calendar' },
      ]} />
    </Page>
  );
}

/** "GT4 European Series 2026: 6 rounds, 2 planned under Upcoming, 1 joined the event you already had." */
function roundsSaid(s: Season) {
  if (!s.rounds.length) return `${s.name}: no rounds yet.`;
  const today = todayIso();
  const ahead = s.rounds.filter((r) => r.event_id != null && !r.has_data && (r.end ?? r.start ?? today) >= today).length;
  const joined = s.rounds.filter((r) => r.event_id != null && !r.made_event).length;
  return [`${s.name}: ${plural(s.rounds.length, 'round')}`, ahead ? `${ahead} planned under Upcoming` : null,
    joined ? `${joined} joined the event${joined === 1 ? '' : 's'} you already had` : null].filter(Boolean).join(', ') + '.';
}

/** Fill a season from its series' site: the calendar's rounds become its rounds, and our entry's blanks come from our
 * car's line on the latest entry list. What happened, in words. */
async function fillFromSite(season: Season, step: (t: string) => void): Promise<string> {
  const key = season.series!;
  let cal: SeriesCalendar;
  try {
    cal = await readCalendar(key, season.year, step);
  } catch (e) {
    if (e instanceof NotThere) return 'This server can’t read the series’ site: add the rounds by hand.';
    throw e;
  }
  if (!cal.rounds.length) {
    const why = cal.sync?.errors?.slice(-1)[0];
    return `The series’ site has no ${season.year} calendar yet${why ? ` (${why})` : ''}: add the rounds by hand, or try again later.`;
  }
  step(`Making ${plural(cal.rounds.length, 'round')}…`);
  const saved = await seasonsApi.update(season.id, { rounds: roundsFrom(cal) });
  const parts = [roundsSaid(saved)];
  if (saved.events_removed) parts.push(`${plural(saved.events_removed, 'planned event')} no longer on the calendar removed.`);
  if (season.car_number) {
    step(`Looking for #${season.car_number} on the entry lists…`);
    const row: EntryRow | null = await ourEntry(key, season.year, cal, season.car_number);
    if (row) {
      const filled = await seasonsApi.fillEntry(season.id, row);
      if (filled.filled?.length) parts.push(`From the entry list: ${filled.filled.join(', ')}.`);
    } else if (cal.rounds.some((r) => r.entries > 0)) {
      parts.push(`#${season.car_number} isn’t on the entry lists published so far.`);
    } else {
      parts.push('No entry list is published yet.');
    }
  }
  return parts.join(' ');
}

function NewSeason({ lists, series, onListsChanged, onCancel, onMade }: {
  lists: Lists;
  series: Series[] | null;
  onListsChanged: () => void;
  onCancel: () => void;
  onMade: (text: string, id: number) => void;
}) {
  const styles = useStyles();
  const [year, setYear] = useState(THIS_YEAR);
  const [key, setKey] = useState<string | null>(null); // a series the server reads; null: by hand
  const [seriesName, setSeriesName] = useState('');
  const [name, setName] = useState<string | null>(null); // null: from the series and year
  const [number, setNumber] = useState('');
  const [entry, setEntry] = useState<Entry>(EMPTY_ENTRY);
  const [rounds, setRounds] = useState<DraftRound[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (series?.length && key === null && !seriesName) setKey(series[0].key);
  }, [series]); // eslint-disable-line react-hooks/exhaustive-deps -- once, when the list arrives
  const picked = series?.find((s) => s.key === key) ?? null;
  const auto = `${picked ? picked.name : seriesName.trim() || 'Season'} ${year}`;
  const years = picked?.years.filter((y) => y >= THIS_YEAR - 1).slice(-3) ?? [THIS_YEAR - 1, THIS_YEAR, THIS_YEAR + 1];

  const make = async () => {
    setError(null);
    if (!picked && !seriesName.trim() && !name?.trim()) return setError('Give the series a name.');
    let manual: RoundFields[] = [];
    try {
      manual = picked ? [] : draftRounds(rounds);
    } catch (e) {
      return setError((e as Error).message);
    }
    setBusy('Making the season…');
    try {
      const season = await seasonsApi.create({ name: (name ?? auto).trim() || auto, series: picked?.key ?? null, year,
        car_number: number.trim().replace(/^#/, '') || null, entry, rounds: manual });
      const told = picked ? await fillFromSite(season, setBusy) : roundsSaid(season);
      onMade(told, season.id);
    } catch (e) {
      setError((e as Error).message);
      setBusy(null);
    }
  };

  return (
    <View style={styles.form}>
      <Field label="Year">
        <Choices>
          {years.map((y) => <Choice key={y} label={String(y)} on={y === year} onPress={() => setYear(y)} />)}
        </Choices>
      </Field>
      <Field label="Series">
        <Choices>
          {(series ?? []).map((s) => (
            <Choice key={s.key} label={s.name} on={key === s.key} onPress={() => setKey(s.key)} />
          ))}
          <Choice label={series?.length ? 'Another series, by hand' : 'By hand'} on={key === null}
            onPress={() => setKey(null)} />
        </Choices>
        {series === null && <Note>Looking for the series this app can read…</Note>}
        {picked ? (
          <Note>
            The dates of every round come from the series&apos; site, and our entry from our car&apos;s line on its entry
            lists when they are published.
          </Note>
        ) : (
          <Input value={seriesName} onChangeText={setSeriesName} placeholder="Series, e.g. GT4 Germany" maxLength={120}
            accessibilityLabel="Series name" />
        )}
      </Field>
      <View style={styles.pair}>
        <Field label="Season name" style={styles.grow}>
          <Input value={name ?? auto} onChangeText={setName} maxLength={160} accessibilityLabel="Season name" />
        </Field>
        <Field label="Our car number">
          <Input value={number} onChangeText={setNumber} placeholder="12" maxLength={8} accessibilityLabel="Our car number"
            style={styles.number} />
        </Field>
      </View>
      <Text style={styles.h3}>Our entry</Text>
      <EntryFields value={entry} onChange={setEntry} lists={lists} onListsChanged={onListsChanged} />
      {!picked && <RoundsEditor rounds={rounds} onChange={setRounds} />}
      {error && <ErrorLine>{error}</ErrorLine>}
      <FormActions>
        <MainButton label="Make the season" onPress={make} busy={busy != null} />
        <TextLink onPress={onCancel} label="Cancel" disabled={busy != null} />
      </FormActions>
      {busy && <Note>{busy}</Note>}
    </View>
  );
}

// ---------- rounds typed in ----------

type DraftRound = { name: string; venue: string; start: string; end: string };
const EMPTY_ROUND: DraftRound = { name: '', venue: '', start: '', end: '' };

/** Rounds as typed, checked: a name, days as dd/mm/yyyy. Empty rows are left out. */
function draftRounds(rows: DraftRound[]): RoundFields[] {
  return rows.filter((r) => r.name.trim() || r.venue.trim() || r.start.trim()).map((r, i) => {
    const name = r.name.trim() || r.venue.trim();
    if (!name) throw new Error(`Round ${i + 1}: give it a name or a venue.`);
    const start = r.start.trim() ? parseDay(r.start) : null;
    const end = r.end.trim() ? parseDay(r.end) : null;
    if (r.start.trim() && !start) throw new Error(`${name}: the first day isn’t a date (dd/mm/yyyy).`);
    if (r.end.trim() && !end) throw new Error(`${name}: the last day isn’t a date (dd/mm/yyyy).`);
    if (start && end && end < start) throw new Error(`${name}: the last day is before the first day.`);
    return { name, venue: r.venue.trim() || null, start: start ?? end, end: end ?? start };
  });
}

function RoundsEditor({ rounds, onChange }: { rounds: DraftRound[]; onChange: (r: DraftRound[]) => void }) {
  const styles = useStyles();
  const set = (i: number, patch: Partial<DraftRound>) => onChange(rounds.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <Field label="Rounds">
      {rounds.map((r, i) => (
        <View key={i} style={styles.roundRow}>
          <Text style={styles.roundNo}>R{i + 1}</Text>
          <View style={styles.roundInputs}>
            <Input value={r.name} onChangeText={(v) => set(i, { name: v })} placeholder="Name" maxLength={160}
              accessibilityLabel={`Round ${i + 1} name`} style={StyleSheet.flatten([styles.roundInput, styles.roundWide])} />
            <Input value={r.venue} onChangeText={(v) => set(i, { venue: v })} placeholder="Venue" maxLength={255}
              accessibilityLabel={`Round ${i + 1} venue`} style={StyleSheet.flatten([styles.roundInput, styles.roundWide])} />
            <Input value={r.start} onChangeText={(v) => set(i, { start: v })} placeholder="First day dd/mm/yyyy"
              maxLength={10} inputMode="numeric" accessibilityLabel={`Round ${i + 1} first day`} style={styles.roundInput} />
            <Input value={r.end} onChangeText={(v) => set(i, { end: v })} placeholder="Last day" maxLength={10}
              inputMode="numeric" accessibilityLabel={`Round ${i + 1} last day`} style={styles.roundInput} />
          </View>
          <TextLink onPress={() => onChange(rounds.filter((_, j) => j !== i))} label="Remove" small />
        </View>
      ))}
      <View style={styles.addRound}>
        <TextLink onPress={() => onChange([...rounds, EMPTY_ROUND])} label="+ Add a round" small />
      </View>
      <Note>Each round becomes a planned event: logs uploaded at its venue on its days go into it.</Note>
    </Field>
  );
}

// ---------- a season ----------

function SeasonSection({ no, season, lists, series, open, onToggle, questions, onLayout, onListsChanged, onChanged }: {
  no: number;
  season: Season;
  lists: Lists;
  series: Series[] | null;
  open: boolean;
  onToggle: () => void;
  questions: SeasonQuestion[]; // waiting about this season
  onLayout: (y: number) => void;
  onListsChanged: () => void;
  onChanged: (text?: string) => void;
}) {
  const styles = useStyles();
  const wide = useWide();
  const [editing, setEditing] = useState<'entry' | 'rounds' | null>(null);
  const [cal, setCal] = useState<SeriesCalendar | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  const fromSite = season.series != null && (series ?? []).some((s) => s.key === season.series);
  useEffect(() => {
    if (fromSite) seriesApi.calendar(season.series!, season.year).then(setCal, () => setCal(null));
  }, [fromSite, season.series, season.year]);
  const counts = new Map((cal?.rounds ?? []).map((r) => [r.round_id, r.entries]));
  const seriesName = (series ?? []).find((s) => s.key === season.series)?.name;

  const update = async () => {
    setError(null);
    try {
      const told = await fillFromSite(season, setBusy);
      setBusy(null);
      onChanged(told);
    } catch (e) {
      setError((e as Error).message);
      setBusy(null);
    }
  };
  const remove = async () => {
    try {
      const r = await seasonsApi.remove(season.id);
      onChanged(`${season.name} deleted${r.events_removed ? `, with ${plural(r.events_removed, 'planned event')} that had no data` : ''}. Events with data stay.`);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const { garage, tyres } = lists;
  const e = season.entry;
  const car = garage.cars.find((c) => c.id === e.car_id);
  const entry: [string, string | null][] = [
    ['Tyre', tyres.find((t) => t.id === e.tyre_kind_id)?.label ?? null],
    ['Car', car ? carLong(car) : lists.vehicles.find((v) => v.id === e.vehicle_model_id)?.name ?? null],
    ['Team', garage.teams.find((t) => t.id === e.team_id)?.name ?? null],
    ['Drivers', e.drivers.length
      ? e.drivers.map((id, i) => `${i + 1} ${garage.drivers.find((d) => d.id === id)?.name ?? '?'}`).join('  ') : null],
  ];
  return (
    <View style={wide ? styles.season : styles.seasonPhone} onLayout={(e) => onLayout(e.nativeEvent.layout.y)}>
      <SeasonHead no={no} season={season} open={open} onToggle={onToggle} questions={questions.length} />
      {open && (
        <View style={wide ? styles.seasonBody : styles.seasonBodyPhone}>
          <Text style={wide ? styles.seasonDek : styles.seasonDekPhone}>
            {[season.car_number ? `Car #${season.car_number}` : 'No car number',
              fromSite ? `${seriesName ?? season.series}, from its site` : 'made by hand'].join(' · ')}
          </Text>
          {questions.length > 0 && (
            <View style={styles.questions}>
              {[...new Set(questions.map((q) => q.event_id))].map((id) => (
                <SeasonMatch key={id} eventId={id} onChanged={() => onChanged()} />
              ))}
            </View>
          )}
          {editing === 'entry' ? (
            <View style={styles.editor}>
              <Label>Our entry</Label>
              <EntryEditor season={season} lists={lists} onListsChanged={onListsChanged} onCancel={() => setEditing(null)}
                onSaved={() => {
                  setEditing(null);
                  onChanged();
                }} />
            </View>
          ) : (
            <View style={styles.entryBlock}>
              <View style={styles.entryHead}>
                <Label>Our entry</Label>
                <TextLink onPress={() => setEditing('entry')} label="Edit" small />
              </View>
              <View style={wide ? styles.entryStrip : styles.entryLines}>
                {entry.map(([label, value], i) => (
                  <View key={label} style={StyleSheet.flatten([wide ? styles.entryCell : styles.entryLine,
                    wide && i === 0 && styles.entryCellFirst, wide && i === entry.length - 1 && styles.entryCellLast])}>
                    <Text style={styles.entryLabel}>{label}</Text>
                    <Text style={StyleSheet.flatten([styles.entryValue, !wide && styles.right, !value && styles.unset])}>
                      {value ?? 'not set'}
                    </Text>
                  </View>
                ))}
              </View>
            </View>
          )}
          {editing === 'rounds' ? (
            <View style={styles.editor}>
              <AddRounds season={season} onCancel={() => setEditing(null)} onSaved={(text) => {
                setEditing(null);
                onChanged(text);
              }} />
            </View>
          ) : (
            <View style={styles.rounds}>
              <View style={styles.roundsHead}>
                <Label>Rounds</Label>
                <Label muted>{fromSite ? 'Entry lists from the series’ site' : ''}</Label>
              </View>
              {season.rounds.map((r) => (
                <RoundRow key={r.id} r={r} season={season} entries={r.round_id ? counts.get(r.round_id) ?? 0 : 0} />
              ))}
              {season.rounds.length === 0 && (
                <Note style={styles.noRounds}>
                  No rounds yet.{fromSite ? ' Update from the series’ site, or add them by hand.' : ''}
                </Note>
              )}
            </View>
          )}
          {error && <ErrorLine>{error}</ErrorLine>}
          {busy && <Note>{busy}</Note>}
          <View style={styles.actions} {...noPrint}>
            {fromSite && (busy ? <ActivityIndicator /> : <TextLink onPress={update} label="Update from the series’ site" red arrow />)}
            {editing !== 'rounds' && <TextLink onPress={() => setEditing('rounds')} label="+ Add a round" />}
            {asking ? (
              <View style={styles.confirm}>
                <Text style={styles.confirmText}>Delete {season.name} and its planned events without data?</Text>
                <FormActions>
                  <MainButton danger label="Delete the season" onPress={remove} />
                  <TextLink onPress={() => setAsking(false)} label="Keep it" />
                </FormActions>
              </View>
            ) : (
              <TextLink onPress={() => setAsking(true)} label="Delete season" small />
            )}
          </View>
        </View>
      )}
    </View>
  );
}

/** A season's heading, folded or open (tap it): the thick rule, its number in an ink block, its name, the year and how
 * many rounds, a red block when questions about it are waiting, and the ▸ / ▾ mark. */
function SeasonHead({ no, season, open, onToggle, questions }: {
  no: number;
  season: Season;
  open: boolean;
  onToggle: () => void;
  questions: number;
}) {
  const c = useTheme();
  const facts = `${season.year} · ${plural(season.rounds.length, 'round')}`;
  const asked = questions ? plural(questions, 'open question') : null;
  return (
    <FoldHead no={no} title={season.name} facts={facts} open={open} onToggle={onToggle} what="the season"
      label={`${season.name}, ${facts}${asked ? `, ${asked}` : ''}`}
      extra={asked ? <Block label={asked} color={c.mark} ink={inkOn(c.mark)} /> : null} />
  );
}

function RoundRow({ r, season, entries }: { r: SeasonRound; season: Season; entries: number }) {
  const styles = useStyles();
  const wide = useWide();
  const c = useTheme();
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<EntryRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const toggle = () => {
    setOpen(!open);
    if (!rows && season.series && r.round_id) {
      seriesApi.entries(season.series, season.year, r.round_id).then(setRows, (e) => setError((e as Error).message));
    }
  };
  const ours = (season.car_number ?? '').trim();
  const today = todayIso();
  const state = r.event_id == null ? 'its event was deleted'
    : r.has_data ? 'has data' : (r.end ?? r.start ?? today) < today ? 'no data' : 'planned';
  const name: ReactNode = <Text style={wide ? styles.roundName : styles.roundNamePhone} numberOfLines={2}>{r.name}</Text>;
  return (
    <View style={styles.round}>
      <View style={styles.roundHead}>
        <View style={styles.roundCode}><Text style={styles.roundCodeText}>R{r.order}</Text></View>
        <View style={styles.roundText}>
          {r.event_id != null ? (
            // Link asChild hands its child's style to a web anchor, which can't take a style array: one object
            <Link href={{ pathname: '/event/[id]', params: { id: r.event_id } }} asChild>
              <Pressable accessibilityRole="link" style={styles.roundLink}>{name}</Pressable>
            </Link>
          ) : name}
          <Text style={styles.roundSub} numberOfLines={2}>
            {[dateRange(r.start, r.end) ?? 'days not known', state].join(' · ')}
          </Text>
        </View>
        {entries > 0 && <TextLink onPress={toggle} label={open ? 'Hide' : `Entry list (${entries})`} small />}
      </View>
      {open && (
        <View style={wide ? styles.entries : styles.entriesPhone}>
          {!rows && !error && <ActivityIndicator style={styles.loadingSmall} />}
          {error && <ErrorLine>{error}</ErrorLine>}
          {rows?.map((e) => {
            const us = ours !== '' && e.car_number.trim() === ours;
            return (
              <View key={e.car_number} style={StyleSheet.flatten([styles.entryRow, us && styles.entryRowUs])}>
                {us ? <Block label={`#${e.car_number}`} color={c.mark} ink={inkOn(c.mark)} size={13} style={styles.carNoBlock} />
                  : <Text style={styles.carNo}>#{e.car_number}</Text>}
                <View style={styles.roundText}>
                  <Text style={styles.entryDrivers} numberOfLines={2}>{e.drivers.join(' / ') || '–'}</Text>
                  <Text style={styles.roundSub} numberOfLines={1}>
                    {[e.team, e.car_model, e.car_class].filter(Boolean).join(' · ')}
                  </Text>
                </View>
              </View>
            );
          })}
        </View>
      )}
    </View>
  );
}

function EntryEditor({ season, lists, onListsChanged, onCancel, onSaved }: {
  season: Season;
  lists: Lists;
  onListsChanged: () => void;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const styles = useStyles();
  const [entry, setEntry] = useState<Entry>(season.entry);
  const [number, setNumber] = useState(season.car_number ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    setBusy(true);
    try {
      await seasonsApi.update(season.id, { entry, car_number: number.trim().replace(/^#/, '') || null });
      onSaved();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };
  return (
    <View style={styles.form}>
      <Field label="Our car number">
        <Input value={number} onChangeText={setNumber} placeholder="12" maxLength={8} accessibilityLabel="Our car number"
          style={styles.number} />
      </Field>
      <EntryFields value={entry} onChange={setEntry} lists={lists} onListsChanged={onListsChanged} />
      {error && <ErrorLine>{error}</ErrorLine>}
      <FormActions>
        <MainButton label="Save" onPress={save} busy={busy} />
        <TextLink onPress={onCancel} label="Cancel" />
      </FormActions>
    </View>
  );
}

/** Rounds added by hand to a season (the ones it has stay). */
function AddRounds({ season, onCancel, onSaved }: { season: Season; onCancel: () => void; onSaved: (text: string) => void }) {
  const styles = useStyles();
  const [rows, setRows] = useState<DraftRound[]>([EMPTY_ROUND]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    setError(null);
    let added: RoundFields[];
    try {
      added = draftRounds(rows);
    } catch (e) {
      return setError((e as Error).message);
    }
    if (!added.length) return onCancel();
    setBusy(true);
    const last = Math.max(0, ...season.rounds.map((r) => r.order));
    const kept: RoundFields[] = season.rounds.map((r) => ({ name: r.name, venue: r.venue, start: r.start, end: r.end,
      round_id: r.round_id, order: r.order }));
    try {
      await seasonsApi.update(season.id, { rounds: [...kept, ...added.map((r, i) => ({ ...r, order: last + i + 1 }))] });
      onSaved(`Added ${plural(added.length, 'round')} to ${season.name}.`);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };
  return (
    <View style={styles.form}>
      <RoundsEditor rounds={rows} onChange={setRows} />
      {error && <ErrorLine>{error}</ErrorLine>}
      <FormActions>
        <MainButton label="Save the rounds" onPress={save} busy={busy} />
        <TextLink onPress={onCancel} label="Cancel" />
      </FormActions>
    </View>
  );
}

const useStyles = themed((c) => ({
  top: { marginTop: 18, gap: 14, alignItems: 'flex-start' },
  loading: { marginTop: 28, alignSelf: 'flex-start' },
  loadingSmall: { alignSelf: 'flex-start' },
  empty: { marginTop: 24 },

  // forms
  form: { gap: 22, maxWidth: 900 },
  editor: { gap: 12, marginBottom: 8 },
  pair: { flexDirection: 'row', flexWrap: 'wrap', columnGap: 24, rowGap: 18 },
  grow: { flex: 1, minWidth: 220 },
  number: { width: 96 },
  h3: { fontFamily: Fonts.display, fontSize: 24, lineHeight: 27, textTransform: 'uppercase', color: c.text,
    borderTopWidth: 1, borderColor: c.rule, paddingTop: 10 },
  roundRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 12, borderBottomWidth: 1, borderColor: c.separator,
    paddingBottom: 10, marginBottom: 4 },
  roundNo: { fontFamily: Fonts.display, fontSize: 20, lineHeight: 34, width: 32, color: c.text },
  roundInputs: { flex: 1, flexDirection: 'row', flexWrap: 'wrap', columnGap: 14, rowGap: 6 },
  roundInput: { flexGrow: 1, flexBasis: 120, minWidth: 110, fontSize: 15 },
  roundWide: { flexBasis: 170 },
  addRound: { marginTop: 6, marginBottom: 4 },

  // a season: its heading, folded or open
  season: { marginTop: 40 },
  seasonPhone: { marginTop: 30 },
  seasonBody: { marginTop: 16 },
  seasonBodyPhone: { marginTop: 12 },
  seasonDek: { fontFamily: Type.dek.fontFamily, fontSize: 17, lineHeight: 24, color: c.textSecondary, marginBottom: 20 },
  seasonDekPhone: { fontFamily: Type.dek.fontFamily, fontSize: 16, lineHeight: 22, color: c.textSecondary,
    marginBottom: 16 },
  questions: { gap: 18, marginBottom: 24, maxWidth: 760 },

  // a season: our entry
  entryBlock: { marginBottom: 22 },
  entryHead: { flexDirection: 'row', alignItems: 'center', gap: 18, marginBottom: 8 },
  entryStrip: { flexDirection: 'row', borderTopWidth: 1, borderBottomWidth: 1, borderColor: c.rule },
  entryCell: { flex: 1, minWidth: 0, paddingVertical: 10, paddingHorizontal: 14, borderRightWidth: 1, borderColor: c.rule,
    gap: 4 },
  entryCellFirst: { paddingLeft: 0 },
  entryCellLast: { borderRightWidth: 0 },
  entryLines: { borderTopWidth: 1, borderColor: c.rule },
  entryLine: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', gap: 14, borderBottomWidth: 1,
    borderColor: c.separator, paddingTop: 8, paddingBottom: 7 },
  entryLabel: { ...Type.label, fontFamily: Fonts.label, color: c.text },
  entryValue: { fontFamily: Type.label.fontFamily, fontSize: 16, lineHeight: 21, color: c.text, flexShrink: 1 },
  right: { textAlign: 'right' },
  unset: { fontFamily: Type.dek.fontFamily, color: c.textMuted },

  // a season: its rounds
  rounds: {},
  roundsHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', gap: 12, borderTopWidth: 3,
    borderBottomWidth: 1, borderColor: c.rule, paddingTop: 7, paddingBottom: 6 },
  noRounds: { marginTop: 10 },
  round: { borderBottomWidth: 1, borderColor: c.separator, paddingTop: 11, paddingBottom: 10, gap: 10 },
  roundHead: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  roundCode: { width: 46, alignItems: 'center', backgroundColor: c.rule, paddingTop: 4, paddingBottom: 3 },
  roundCodeText: { fontFamily: Fonts.display, fontSize: 20, lineHeight: 22, color: c.background },
  roundText: { flex: 1, minWidth: 0, gap: 2 },
  roundLink: { alignSelf: 'flex-start' },
  roundName: { fontFamily: Fonts.display, fontSize: 26, lineHeight: 29, textTransform: 'uppercase', color: c.text },
  roundNamePhone: { fontFamily: Fonts.display, fontSize: 21, lineHeight: 24, textTransform: 'uppercase', color: c.text },
  roundSub: { fontFamily: Fonts.body, fontSize: 15, lineHeight: 20, color: c.textSecondary },
  entries: { paddingLeft: 60, gap: 0 },
  entriesPhone: { gap: 0 },
  entryRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 6, borderTopWidth: 1,
    borderColor: c.separator },
  entryRowUs: { backgroundColor: c.band },
  carNo: { width: 52, fontFamily: Type.label.fontFamily, fontSize: 15, fontVariant: ['tabular-nums'], color: c.text },
  carNoBlock: { width: 52, alignItems: 'center' },
  entryDrivers: { fontFamily: face('label', 600), fontSize: 15, color: c.text },

  actions: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: 22, rowGap: 14, marginTop: 18 },
  confirm: { width: '100%', gap: 10, borderTopWidth: 1, borderColor: c.rule, paddingTop: 10 },
  confirmText: { fontFamily: Fonts.body, fontSize: 17, lineHeight: 24, color: c.text },
}));
