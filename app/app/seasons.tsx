import { Link, Stack } from 'expo-router';
import { ReactNode, useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, TextInput } from 'react-native';

import { Chip, EntryFields, Lists, useLists } from '@/components/EventInfoForm';
import { Text, View, useThemeColor } from '@/components/Themed';
import { todayIso } from '@/lib/calendar';
import { carLong } from '@/lib/garage';
import { dateRange, parseDay } from '@/lib/events';
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
import { Radius, themed, useTheme } from '@/constants/Theme';

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const THIS_YEAR = new Date().getFullYear();

/** Seasons made ahead: a series and a year with our car number and our entry (tyre, car, team, drivers 1 to 4). A
 * series the server can read from its site brings its calendar (every round becomes a planned event under Upcoming,
 * or joins the event already there) and fills our entry from our car's line on the entry list; any other series is
 * made by hand, its rounds typed in. Each event of a season takes its tyre, car, team and drivers from the season
 * unless set on the event. */
export default function SeasonsScreen() {
  const styles = useStyles();
  const [seasons, setSeasons] = useState<Season[] | null>(null);
  const [series, setSeries] = useState<Series[] | null>(null); // [] when the server can't read any series' site
  const [error, setError] = useState<string | null>(null);
  const [making, setMaking] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const { lists, error: listsError, reload: reloadLists } = useLists();
  const tint = useThemeColor({}, 'tint');

  const load = useCallback(() => {
    seasonsApi.list().then(
      (s) => {
        setSeasons(s);
        setError(null);
      },
      (e) => setError((e as Error).message),
    );
  }, []);
  useEffect(() => {
    load();
    seriesApi.series().then(setSeries, () => setSeries([])); // 404 on a server without the results module
  }, [load]);

  return (
    <ScrollView contentContainerStyle={styles.outer}>
      <Stack.Screen options={{ title: 'Seasons' }} />
      <View style={styles.page}>
        <Text style={styles.intro}>
          Make a season for the year: its rounds become planned events under Upcoming, with their dates and venue, and
          each round&apos;s event takes its tyre, car, team and drivers from the season unless you set them on the event.
        </Text>
        {error && <Text style={styles.error}>{error}</Text>}
        {listsError && <Text style={styles.error}>{listsError}</Text>}
        {notice && (
          <Pressable onPress={() => setNotice(null)}>
            <Text style={styles.notice}>{notice}</Text>
          </Pressable>
        )}
        {making && lists ? (
          <NewSeason lists={lists} series={series} onListsChanged={reloadLists} onCancel={() => setMaking(false)}
            onMade={(text) => {
              setMaking(false);
              setNotice(text);
              load();
              reloadLists(); // drivers and a team may have come from the entry list
            }} />
        ) : (
          <Pressable onPress={() => setMaking(true)} accessibilityRole="button" disabled={!lists}
            style={StyleSheet.flatten([styles.newButton, { borderColor: tint }])}>
            <Text style={StyleSheet.flatten([styles.newText, { color: tint }])}>＋ New season</Text>
          </Pressable>
        )}
        {!seasons && !error && <ActivityIndicator />}
        {seasons && seasons.length === 0 && !making && (
          <Text style={styles.empty}>No seasons yet.</Text>
        )}
        {seasons && lists && seasons.map((s) => (
          <SeasonCard key={s.id} season={s} lists={lists} series={series} onListsChanged={reloadLists}
            onChanged={(text) => {
              if (text) setNotice(text);
              load();
              reloadLists();
            }} />
        ))}
      </View>
    </ScrollView>
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
  onMade: (text: string) => void;
}) {
  const styles = useStyles();
  const theme = useTheme();
  const [year, setYear] = useState(THIS_YEAR);
  const [key, setKey] = useState<string | null>(null); // a series the server reads; null: by hand
  const [seriesName, setSeriesName] = useState('');
  const [name, setName] = useState<string | null>(null); // null: from the series and year
  const [number, setNumber] = useState('');
  const [entry, setEntry] = useState<Entry>(EMPTY_ENTRY);
  const [rounds, setRounds] = useState<DraftRound[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const tint = useThemeColor({}, 'tint');
  const text = useThemeColor({}, 'text');
  const onTint = useThemeColor({}, 'onTint');
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
      onMade(told);
    } catch (e) {
      setError((e as Error).message);
      setBusy(null);
    }
  };

  const input = StyleSheet.flatten([styles.input, { color: text }]);
  return (
    <View style={styles.form}>
      <Text style={styles.h2}>New season</Text>
      <Group label="Year">
        <View style={styles.chips}>
          {years.map((y) => <Chip key={y} label={String(y)} on={y === year} onPress={() => setYear(y)} />)}
        </View>
      </Group>
      <Group label="Series">
        <View style={styles.chips}>
          {(series ?? []).map((s) => (
            <Chip key={s.key} label={s.name} on={key === s.key} onPress={() => setKey(s.key)} />
          ))}
          <Chip label={series?.length ? 'Another series, by hand' : 'By hand'} on={key === null}
            onPress={() => setKey(null)} dashed={!!series?.length} />
        </View>
        {series === null && <Text style={styles.note}>Looking for the series this app can read…</Text>}
        {picked ? (
          <Text style={styles.note}>
            The dates of every round come from the series&apos; site, and our entry from our car&apos;s line on its entry
            lists when they are published.
          </Text>
        ) : (
          <TextInput value={seriesName} onChangeText={setSeriesName} placeholder="Series, e.g. GT4 Germany"
            placeholderTextColor={theme.textMuted} maxLength={120} accessibilityLabel="Series name" style={input} />
        )}
      </Group>
      <Group label="Season name">
        <TextInput value={name ?? auto} onChangeText={setName} maxLength={160} accessibilityLabel="Season name"
          style={input} />
      </Group>
      <Group label="Our car number">
        <TextInput value={number} onChangeText={setNumber} placeholder="12" placeholderTextColor={theme.textMuted} maxLength={8}
          accessibilityLabel="Our car number" style={StyleSheet.flatten([input, styles.number])} />
      </Group>
      <Text style={styles.h3}>Our entry</Text>
      <EntryFields value={entry} onChange={setEntry} lists={lists} onListsChanged={onListsChanged} />
      {!picked && <RoundsEditor rounds={rounds} onChange={setRounds} />}
      {error && <Text style={styles.error}>{error}</Text>}
      <View style={styles.buttons}>
        <Pressable onPress={make} disabled={busy != null} accessibilityRole="button"
          style={StyleSheet.flatten([styles.save, { backgroundColor: tint }])}>
          {busy ? <ActivityIndicator color={onTint} />
            : <Text style={StyleSheet.flatten([styles.saveText, { color: onTint }])}>Make the season</Text>}
        </Pressable>
        <Pressable onPress={onCancel} hitSlop={8} accessibilityRole="button" disabled={busy != null}>
          <Text style={{ color: tint }}>Cancel</Text>
        </Pressable>
      </View>
      {busy && <Text style={styles.note}>{busy}</Text>}
    </View>
  );
}

function Group({ label, children }: { label: string; children: ReactNode }) {
  const styles = useStyles();
  return (
    <View style={styles.group}>
      <Text style={styles.label}>{label}</Text>
      {children}
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
  const theme = useTheme();
  const tint = useThemeColor({}, 'tint');
  const text = useThemeColor({}, 'text');
  const set = (i: number, patch: Partial<DraftRound>) => onChange(rounds.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const input = StyleSheet.flatten([styles.input, styles.roundInput, { color: text }]);
  return (
    <View style={styles.group}>
      <Text style={styles.label}>Rounds</Text>
      {rounds.map((r, i) => (
        <View key={i} style={styles.roundRow}>
          <Text style={styles.roundNo}>R{i + 1}</Text>
          <TextInput value={r.name} onChangeText={(v) => set(i, { name: v })} placeholder="Name" placeholderTextColor={theme.textMuted}
            maxLength={160} accessibilityLabel={`Round ${i + 1} name`} style={StyleSheet.flatten([input, styles.wide])} />
          <TextInput value={r.venue} onChangeText={(v) => set(i, { venue: v })} placeholder="Venue"
            placeholderTextColor={theme.textMuted} maxLength={255} accessibilityLabel={`Round ${i + 1} venue`}
            style={StyleSheet.flatten([input, styles.wide])} />
          <TextInput value={r.start} onChangeText={(v) => set(i, { start: v })} placeholder="First day dd/mm/yyyy"
            placeholderTextColor={theme.textMuted} maxLength={10} inputMode="numeric" accessibilityLabel={`Round ${i + 1} first day`}
            style={input} />
          <TextInput value={r.end} onChangeText={(v) => set(i, { end: v })} placeholder="Last day" placeholderTextColor={theme.textMuted}
            maxLength={10} inputMode="numeric" accessibilityLabel={`Round ${i + 1} last day`} style={input} />
          <Pressable onPress={() => onChange(rounds.filter((_, j) => j !== i))} hitSlop={8} accessibilityRole="button"
            accessibilityLabel={`Remove round ${i + 1}`}>
            <Text style={styles.remove}>✕</Text>
          </Pressable>
        </View>
      ))}
      <Pressable onPress={() => onChange([...rounds, EMPTY_ROUND])} accessibilityRole="button" hitSlop={6}
        style={styles.addRound}>
        <Text style={{ color: tint, fontWeight: '600' }}>＋ Add a round</Text>
      </Pressable>
      <Text style={styles.note}>Each round becomes a planned event: logs uploaded at its venue on its days go into it.</Text>
    </View>
  );
}

// ---------- a season ----------

function SeasonCard({ season, lists, series, onListsChanged, onChanged }: {
  season: Season;
  lists: Lists;
  series: Series[] | null;
  onListsChanged: () => void;
  onChanged: (text?: string) => void;
}) {
  const styles = useStyles();
  const [editing, setEditing] = useState<'entry' | 'rounds' | null>(null);
  const [cal, setCal] = useState<SeriesCalendar | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  const tint = useThemeColor({}, 'tint');
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
  const entryWords = [
    tyres.find((t) => t.id === e.tyre_kind_id)?.label,
    car ? carLong(car) : lists.vehicles.find((v) => v.id === e.vehicle_model_id)?.name,
    garage.teams.find((t) => t.id === e.team_id)?.name,
    e.drivers.length ? e.drivers.map((id, i) => `${i + 1} ${garage.drivers.find((d) => d.id === id)?.name ?? '?'}`).join('  ') : null,
  ];
  return (
    <View style={styles.card}>
      <Text style={styles.cardTitle}>{season.name}</Text>
      <Text style={styles.sub}>
        {[season.car_number ? `#${season.car_number}` : 'no car number', fromSite ? `${seriesName ?? season.series}, from its site` : 'made by hand',
          plural(season.rounds.length, 'round')].join(' · ')}
      </Text>
      {editing === 'entry' ? (
        <EntryEditor season={season} lists={lists} onListsChanged={onListsChanged} onCancel={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            onChanged();
          }} />
      ) : (
        <Pressable onPress={() => setEditing('entry')} accessibilityRole="button" accessibilityLabel="Edit our entry"
          style={styles.entry}>
          <Text style={styles.label}>Our entry</Text>
          <Text style={styles.entryText}>
            {entryWords.map((w, i) => (
              <Text key={i} style={w ? undefined : styles.dim}>
                {i ? '  ·  ' : ''}{w ?? ['no tyre', 'no car', 'no team', 'no drivers'][i]}
              </Text>
            ))}
          </Text>
          <Text style={{ color: tint, fontSize: 13 }}>Edit</Text>
        </Pressable>
      )}
      {editing === 'rounds' ? (
        <AddRounds season={season} onCancel={() => setEditing(null)} onSaved={(text) => {
          setEditing(null);
          onChanged(text);
        }} />
      ) : (
        <View style={styles.rounds}>
          {season.rounds.map((r) => (
            <RoundRow key={r.id} r={r} season={season} entries={r.round_id ? counts.get(r.round_id) ?? 0 : 0} />
          ))}
          {season.rounds.length === 0 && (
            <Text style={styles.note}>No rounds yet.{fromSite ? ' Update from the series’ site, or add them by hand.' : ''}</Text>
          )}
        </View>
      )}
      {error && <Text style={styles.error}>{error}</Text>}
      {busy && <Text style={styles.note}>{busy}</Text>}
      <View style={styles.actions}>
        {fromSite && (
          <Pressable onPress={update} disabled={busy != null} accessibilityRole="button"
            style={StyleSheet.flatten([styles.action, { borderColor: tint }])}>
            {busy ? <ActivityIndicator color={tint} />
              : <Text style={StyleSheet.flatten([styles.actionText, { color: tint }])}>Update from the series’ site</Text>}
          </Pressable>
        )}
        {editing !== 'rounds' && (
          <Pressable onPress={() => setEditing('rounds')} accessibilityRole="button"
            style={StyleSheet.flatten([styles.action, styles.quiet])}>
            <Text style={styles.actionText}>Add a round</Text>
          </Pressable>
        )}
        <Pressable onPress={() => (asking ? remove() : setAsking(true))} accessibilityRole="button"
          style={StyleSheet.flatten([styles.action, styles.quiet, asking && styles.danger])}>
          <Text style={StyleSheet.flatten([styles.actionText, asking && styles.dangerText])}>
            {asking ? 'Tap again: delete it and its planned events without data' : 'Delete season'}
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

function RoundRow({ r, season, entries }: { r: SeasonRound; season: Season; entries: number }) {
  const styles = useStyles();
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<EntryRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const tint = useThemeColor({}, 'tint');
  const toggle = () => {
    setOpen(!open);
    if (!rows && season.series && r.round_id) {
      seriesApi.entries(season.series, season.year, r.round_id).then(setRows, (e) => setError((e as Error).message));
    }
  };
  const ours = (season.car_number ?? '').trim();
  return (
    <View style={styles.round}>
      <View style={styles.roundHead}>
        <Text style={styles.order}>R{r.order}</Text>
        <View style={styles.roundText}>
          {r.event_id != null ? (
            // Link asChild hands its child's style to a web anchor, which can't take a style array: one object
            <Link href={{ pathname: '/event/[id]', params: { id: r.event_id } }} asChild>
              <Pressable accessibilityRole="link">
                <Text style={StyleSheet.flatten([styles.roundName, { color: tint }])} numberOfLines={1}>{r.name} ›</Text>
              </Pressable>
            </Link>
          ) : (
            <Text style={styles.roundName} numberOfLines={1}>{r.name}</Text>
          )}
          <Text style={styles.sub} numberOfLines={2}>
            {[dateRange(r.start, r.end) ?? 'days not known', r.event_id == null ? 'its event was deleted'
              : r.has_data ? 'has data' : (r.end ?? r.start ?? todayIso()) < todayIso() ? 'no data' : 'planned'].join(' · ')}
          </Text>
        </View>
        {entries > 0 && (
          <Pressable onPress={toggle} accessibilityRole="button" hitSlop={6}>
            <Text style={{ color: tint, fontSize: 13 }}>{open ? 'Hide' : `Entry list (${entries})`}</Text>
          </Pressable>
        )}
      </View>
      {open && (
        <View style={styles.entries}>
          {!rows && !error && <ActivityIndicator />}
          {error && <Text style={styles.error}>{error}</Text>}
          {rows?.map((e) => {
            const us = ours !== '' && e.car_number.trim() === ours;
            return (
              <View key={e.car_number} style={StyleSheet.flatten([styles.entryRow, us && { borderColor: tint, borderWidth: 1 }])}>
                <Text style={StyleSheet.flatten([styles.carNo, us && { color: tint }])}>#{e.car_number}</Text>
                <View style={styles.roundText}>
                  <Text style={styles.entryDrivers} numberOfLines={2}>{e.drivers.join(' / ') || '–'}</Text>
                  <Text style={styles.sub} numberOfLines={1}>
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
  const theme = useTheme();
  const [entry, setEntry] = useState<Entry>(season.entry);
  const [number, setNumber] = useState(season.car_number ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const tint = useThemeColor({}, 'tint');
  const text = useThemeColor({}, 'text');
  const onTint = useThemeColor({}, 'onTint');
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
    <View style={styles.editor}>
      <Group label="Our car number">
        <TextInput value={number} onChangeText={setNumber} placeholder="12" placeholderTextColor={theme.textMuted} maxLength={8}
          accessibilityLabel="Our car number" style={StyleSheet.flatten([styles.input, styles.number, { color: text }])} />
      </Group>
      <EntryFields value={entry} onChange={setEntry} lists={lists} onListsChanged={onListsChanged} />
      {error && <Text style={styles.error}>{error}</Text>}
      <View style={styles.buttons}>
        <Pressable onPress={save} disabled={busy} accessibilityRole="button"
          style={StyleSheet.flatten([styles.save, { backgroundColor: tint }])}>
          {busy ? <ActivityIndicator color={onTint} />
            : <Text style={StyleSheet.flatten([styles.saveText, { color: onTint }])}>Save</Text>}
        </Pressable>
        <Pressable onPress={onCancel} hitSlop={8} accessibilityRole="button">
          <Text style={{ color: tint }}>Cancel</Text>
        </Pressable>
      </View>
    </View>
  );
}

/** Rounds added by hand to a season (the ones it has stay). */
function AddRounds({ season, onCancel, onSaved }: { season: Season; onCancel: () => void; onSaved: (text: string) => void }) {
  const styles = useStyles();
  const [rows, setRows] = useState<DraftRound[]>([EMPTY_ROUND]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const tint = useThemeColor({}, 'tint');
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
    <View style={styles.editor}>
      <RoundsEditor rounds={rows} onChange={setRows} />
      {error && <Text style={styles.error}>{error}</Text>}
      <View style={styles.buttons}>
        <Pressable onPress={save} disabled={busy} accessibilityRole="button"
          style={StyleSheet.flatten([styles.action, { borderColor: tint }])}>
          {busy ? <ActivityIndicator color={tint} />
            : <Text style={StyleSheet.flatten([styles.actionText, { color: tint }])}>Save the rounds</Text>}
        </Pressable>
        <Pressable onPress={onCancel} hitSlop={8} accessibilityRole="button">
          <Text style={{ color: tint }}>Cancel</Text>
        </Pressable>
      </View>
    </View>
  );
}

const useStyles = themed((c) => ({
  outer: { padding: 16, paddingBottom: 32 },
  page: { width: '100%', maxWidth: 900, alignSelf: 'center', gap: 14 },
  intro: { opacity: 0.7, lineHeight: 20 },
  error: { color: c.error },
  notice: { fontSize: 13, opacity: 0.85, borderLeftWidth: 3, borderColor: c.borderStrong, paddingLeft: 8 },
  empty: { opacity: 0.6, textAlign: 'center', marginTop: 12 },
  newButton: { borderWidth: 1, borderRadius: Radius.control, paddingVertical: 10, alignItems: 'center' },
  newText: { fontWeight: '600', fontSize: 15 },
  form: { borderWidth: 1, borderColor: c.border, borderRadius: Radius.card, padding: 12, gap: 14, backgroundColor: c.surface },
  h2: { fontSize: 18, fontWeight: '700' },
  h3: { fontSize: 15, fontWeight: '700', marginTop: 4 },
  group: { gap: 6, backgroundColor: 'transparent' },
  label: { fontSize: 11, fontWeight: '700', opacity: 0.6, textTransform: 'uppercase', letterSpacing: 0.5 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, backgroundColor: 'transparent' },
  note: { fontSize: 12, opacity: 0.6 },
  input: { borderWidth: 1, borderColor: c.border, borderRadius: Radius.control, paddingHorizontal: 10, paddingVertical: 8, fontSize: 15, backgroundColor: c.surface },
  number: { width: 90 },
  buttons: { flexDirection: 'row', alignItems: 'center', gap: 16, flexWrap: 'wrap', backgroundColor: 'transparent' },
  save: { borderRadius: Radius.control, paddingHorizontal: 18, paddingVertical: 9, minWidth: 80, alignItems: 'center' },
  saveText: { fontWeight: '600' },
  roundRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6, backgroundColor: 'transparent',
    borderBottomWidth: 1, borderColor: c.separator, paddingBottom: 6 },
  roundNo: { width: 26, fontWeight: '700', opacity: 0.7 },
  roundInput: { paddingVertical: 6, fontSize: 14, flexGrow: 1, flexBasis: 110, minWidth: 100 },
  wide: { flexBasis: 160 },
  remove: { color: c.error, fontSize: 16, paddingHorizontal: 4 },
  addRound: { alignSelf: 'flex-start', paddingVertical: 4 },
  card: { borderWidth: 1, borderColor: c.border, borderRadius: Radius.card, padding: 12, gap: 10, backgroundColor: c.surface },
  cardTitle: { fontSize: 18, fontWeight: '700' },
  sub: { opacity: 0.65, fontSize: 13 },
  dim: { opacity: 0.45 },
  entry: { gap: 3, borderLeftWidth: 3, borderColor: c.border, paddingLeft: 8 },
  entryText: { fontSize: 14 },
  editor: { gap: 12, backgroundColor: 'transparent' },
  rounds: { gap: 0, backgroundColor: 'transparent' },
  round: { borderBottomWidth: 1, borderColor: c.separator, paddingVertical: 7, gap: 6, backgroundColor: 'transparent' },
  roundHead: { flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: 'transparent' },
  order: { width: 30, fontWeight: '700', opacity: 0.6, fontVariant: ['tabular-nums'] },
  roundText: { flex: 1, gap: 1, backgroundColor: 'transparent' },
  roundName: { fontSize: 15, fontWeight: '600' },
  entries: { gap: 4, paddingLeft: 30, backgroundColor: 'transparent' },
  entryRow: { flexDirection: 'row', gap: 10, alignItems: 'center', paddingHorizontal: 6, paddingVertical: 4,
    borderRadius: Radius.control, borderColor: 'transparent' },
  carNo: { width: 44, fontWeight: '700', fontVariant: ['tabular-nums'] },
  entryDrivers: { fontSize: 14 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, backgroundColor: 'transparent' },
  action: { borderWidth: 1, borderColor: c.border, borderRadius: Radius.control, paddingHorizontal: 12, paddingVertical: 7 },
  actionText: { fontWeight: '600', fontSize: 14 },
  quiet: { borderStyle: 'dashed' },
  danger: { borderColor: c.error, borderStyle: 'solid' },
  dangerText: { color: c.error },
}));
