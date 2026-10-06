import { Link, useFocusEffect, useNavigation, useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet } from 'react-native';

import { DriverLinks } from '@/components/DriverPicker';
import { FilterBar, PlanForm, plannedLine, RemovePlanned } from '@/components/EventFilter';
import { ImportLogs } from '@/components/ImportLogs';
import { PrepButton, usePrepAvailability } from '@/components/PrepButton';
import { RenameEvent } from '@/components/RenameEvent';
import { SeasonsLink } from '@/components/SeasonsLink';
import { Text, View, useThemeColor } from '@/components/Themed';
import { formatLap } from '@/lib/api';
import { CalendarState, calendarApi, countByWhen, defaultFilter, Filter, filtered, Plan, todayIso, whenOf } from '@/lib/calendar';
import { dateRange, eventsApi, FolderSummary } from '@/lib/events';
import { launchEvent } from '@/lib/openCurrent';
import { PrepAvailability } from '@/lib/prep';

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** Events as folders, newest first: each a test or a race weekend with its dates, track, sessions and best lap. Open
 * one for its sessions by day. Sessions in no event have a folder of their own, first, so they get filed. A filter
 * shows past, current (from the day before to the last day) or upcoming events, opening on what's on now; planned
 * events (made here or from the racing calendar) wait under Upcoming until their data comes in. Opened while an event
 * is on, the app goes straight on to that event's page (lib/openCurrent.ts). */
export default function SessionsScreen() {
  const [folders, setFolders] = useState<FolderSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [making, setMaking] = useState(false);
  const [calendar, setCalendar] = useState<CalendarState | null>(null);
  const [filter, setFilter] = useState<Filter | null>(null); // null: what the list opens on
  const router = useRouter();
  const navigation = useNavigation();
  const tint = useThemeColor({}, 'tint');
  const background = useThemeColor({}, 'background');
  const prep = usePrepAvailability(); // events whose track has past data: the Prep report button

  const load = useCallback(() => {
    eventsApi.folders().then(
      (f) => {
        setFolders(f);
        setError(null);
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
  const shown = folders ? filtered(folders, active, today) : null;
  const plans = new Map((calendar?.plans ?? []).map((p) => [p.event_id, p]));

  const timed = folders?.some((f) => f.best_lap_s != null) ?? false;
  return (
    <ScrollView style={{ backgroundColor: background }} contentContainerStyle={styles.outer}>
      <View style={styles.page}>
        <ImportLogs onProgress={load} events={folders} />
        {making ? (
          <View style={styles.panel}>
            <Text style={styles.panelTitle}>New event</Text>
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
          <View style={styles.links}>
            <Pressable onPress={() => setMaking(true)} accessibilityRole="button"
              style={StyleSheet.flatten([styles.linkButton, { borderColor: tint }])}>
              <Text style={StyleSheet.flatten([styles.linkText, { color: tint }])}>＋ New event</Text>
            </Pressable>
            {timed && (
              // Link asChild hands its child's style to a web anchor, which can't take a style array: one object
              <Link href="/compare" asChild>
                <Pressable style={StyleSheet.flatten([styles.linkButton, { borderColor: tint }])}>
                  <Text style={StyleSheet.flatten([styles.linkText, { color: tint }])}>Compare laps</Text>
                </Pressable>
              </Link>
            )}
          </View>
        )}
        <DriverLinks />
        {error && <Text style={styles.error}>Can&apos;t reach the server: {error}</Text>}
        {!folders && !error && <ActivityIndicator />}
        {folders && folders.length === 0 && (
          <Text style={styles.empty}>
            No events yet. Upload logs or a zip of a whole test above: each log becomes a session, and a zip becomes an
            event of its own. Or make an event first and upload into it.
          </Text>
        )}
        {folders && (
          <FilterBar filter={active} counts={counts} onPick={setFilter} calendar={calendar}
            onSynced={(c) => {
              setCalendar(c);
              load();
            }} />
        )}
        {folders && <SeasonsLink />}
        {shown && shown.length === 0 && folders && folders.length > 0 && (
          <Text style={styles.empty}>{EMPTY[active]}</Text>
        )}
        {shown?.map((f) => (
          <FolderCard key={f.key} f={f} plan={f.id != null ? plans.get(f.id) : undefined} onChanged={load}
            prep={f.id != null ? prep[String(f.id)] : undefined}
            onRenamed={(name) => {
              setFolders((all) => all?.map((x) => (x.key === f.key ? { ...x, name } : x)) ?? all);
              load();
            }} />
        ))}
      </View>
    </ScrollView>
  );
}

const EMPTY: Record<Filter, string> = {
  current: 'Nothing on today or tomorrow.',
  upcoming: 'Nothing planned yet. Plan a test or a race weekend with ＋ New event, or bring them in from your racing calendar.',
  past: 'No past events yet.',
  all: 'No events yet.',
};

function FolderCard({ f, plan, prep, onRenamed, onChanged }: {
  f: FolderSummary;
  plan?: Plan;
  prep: PrepAvailability[string] | undefined; // past data at its track: the Prep report button
  onRenamed: (name: string) => void;
  onChanged: () => void;
}) {
  const [renaming, setRenaming] = useState(false);
  const tint = useThemeColor({}, 'tint');
  const range = dateRange(f.start, f.end);
  const loose = f.id == null;
  const planned = !loose && f.sessions === 0; // no data yet
  const sub = planned ? plannedLine(f, plan)
    : [loose ? null : f.track, plural(f.sessions, 'session'), f.clean_laps ? plural(f.clean_laps, 'clean lap') : null]
      .filter(Boolean).join(' · ');
  if (renaming && f.id != null) {
    return (
      <View style={StyleSheet.flatten([styles.card, styles.editing])}>
        <RenameEvent id={f.id} initial={f.name} onCancel={() => setRenaming(false)}
          onSaved={(saved) => {
            setRenaming(false);
            onRenamed(saved.name);
          }} />
        <Text style={styles.sub} numberOfLines={1}>{[range, sub].filter(Boolean).join(' · ')}</Text>
      </View>
    );
  }
  return (
    <View style={StyleSheet.flatten([styles.card, loose && styles.loose])}>
      {/* Link asChild hands its child's style to a web anchor, which can't take a style array: one object */}
      <Link href={{ pathname: '/event/[id]', params: { id: f.key } }} asChild>
        <Pressable style={styles.cardLink} accessibilityRole="link">
          <View style={styles.cardText}>
            <Text style={styles.title} numberOfLines={2}>{f.name}</Text>
            <Text style={styles.date} numberOfLines={1}>
              {loose ? 'Open to move them into an event' : range ?? (planned ? 'Days not set yet' : 'No dates yet')}
            </Text>
            <Text style={styles.sub} numberOfLines={2}>{sub}</Text>
          </View>
          {!planned && (
            <View style={styles.right}>
              <Text style={styles.time}>{formatLap(f.best_lap_s)}</Text>
              {f.best_session && <Text style={styles.sub} numberOfLines={1}>{f.best_session}</Text>}
            </View>
          )}
          <Text style={styles.chevron}>›</Text>
        </Pressable>
      </Link>
      {!loose && (
        <View style={styles.cardActions}>
          <Pressable onPress={() => setRenaming(true)} accessibilityRole="button" accessibilityLabel={`Rename ${f.name}`}
            hitSlop={8} style={styles.rename}>
            <Text style={StyleSheet.flatten([styles.renameText, { color: tint }])}>✎ Rename</Text>
          </Pressable>
          {planned && <RemovePlanned f={f} plan={plan} onRemoved={onChanged} />}
        </View>
      )}
      {f.id != null && <PrepButton eventId={f.id} info={prep} compact />}
    </View>
  );
}

const styles = StyleSheet.create({
  outer: { padding: 16, paddingBottom: 32 },
  page: { width: '100%', maxWidth: 820, alignSelf: 'center', gap: 12 },
  links: { flexDirection: 'row', gap: 8 },
  linkButton: { flex: 1, borderWidth: 1, borderRadius: 8, paddingVertical: 10, alignItems: 'center' },
  linkText: { fontWeight: '600', fontSize: 15 },
  panel: { borderWidth: 1, borderColor: '#8884', borderRadius: 10, padding: 12, gap: 8 },
  panelTitle: { fontSize: 16, fontWeight: '700' },
  error: { color: '#c8372d' },
  empty: { opacity: 0.6, marginTop: 24, textAlign: 'center', lineHeight: 20 },
  card: { borderWidth: 1, borderColor: '#8884', borderRadius: 10, paddingHorizontal: 14, paddingVertical: 12, gap: 6 },
  cardLink: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  loose: { borderStyle: 'dashed' },
  editing: { gap: 8 },
  cardActions: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: 18, rowGap: 8,
    backgroundColor: 'transparent' },
  rename: { alignSelf: 'flex-start', paddingVertical: 2 },
  renameText: { fontWeight: '600', fontSize: 14 },
  cardText: { flex: 1, gap: 2, backgroundColor: 'transparent' },
  title: { fontSize: 17, fontWeight: '700' },
  date: { fontSize: 14, opacity: 0.85 },
  sub: { opacity: 0.6, fontSize: 13 },
  right: { alignItems: 'flex-end', maxWidth: 120, backgroundColor: 'transparent' },
  time: { fontSize: 18, fontVariant: ['tabular-nums'] },
  chevron: { fontSize: 22, opacity: 0.4 },
});
