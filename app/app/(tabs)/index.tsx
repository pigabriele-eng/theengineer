import { Link, useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet } from 'react-native';

import { DriverLinks } from '@/components/DriverPicker';
import { EventForm } from '@/components/EventForm';
import { ImportLogs } from '@/components/ImportLogs';
import { Text, View, useThemeColor } from '@/components/Themed';
import { formatLap } from '@/lib/api';
import { dateRange, eventsApi, FolderSummary } from '@/lib/events';

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** Events as folders, newest first: each a test or a race weekend with its dates, track, sessions and best lap. Open
 * one for its sessions by day. Sessions in no event have a folder of their own, first, so they get filed. */
export default function SessionsScreen() {
  const [folders, setFolders] = useState<FolderSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [making, setMaking] = useState(false);
  const router = useRouter();
  const tint = useThemeColor({}, 'tint');
  const background = useThemeColor({}, 'background');

  const load = useCallback(() => {
    eventsApi.folders().then(
      (f) => {
        setFolders(f);
        setError(null);
      },
      (e) => setError((e as Error).message),
    );
  }, []);
  useFocusEffect(load);

  const timed = folders?.some((f) => f.best_lap_s != null) ?? false;
  return (
    <ScrollView style={{ backgroundColor: background }} contentContainerStyle={styles.outer}>
      <View style={styles.page}>
        <ImportLogs onProgress={load} events={folders} />
        {making ? (
          <View style={styles.panel}>
            <Text style={styles.panelTitle}>New event</Text>
            <EventForm submitLabel="Make the event" onCancel={() => setMaking(false)}
              onSubmit={async (v) => {
                const ev = await eventsApi.create(v);
                setMaking(false);
                load();
                router.push({ pathname: '/event/[id]', params: { id: ev.key } });
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
        {folders && folders.length > 0 && <Text style={styles.h2}>Events</Text>}
        {folders?.map((f) => <FolderCard key={f.key} f={f} />)}
      </View>
    </ScrollView>
  );
}

function FolderCard({ f }: { f: FolderSummary }) {
  const range = dateRange(f.start, f.end);
  const loose = f.id == null;
  return (
    // Link asChild hands its child's style to a web anchor, which can't take a style array: one object
    <Link href={{ pathname: '/event/[id]', params: { id: f.key } }} asChild>
      <Pressable style={StyleSheet.flatten([styles.card, loose && styles.loose])} accessibilityRole="link">
        <View style={styles.cardText}>
          <Text style={styles.title} numberOfLines={2}>{f.name}</Text>
          <Text style={styles.date} numberOfLines={1}>
            {loose ? 'Open to move them into an event' : range ?? 'No dates yet'}
          </Text>
          <Text style={styles.sub} numberOfLines={2}>
            {[loose ? null : f.track, plural(f.sessions, 'session'), f.clean_laps ? plural(f.clean_laps, 'clean lap') : null]
              .filter(Boolean).join(' · ')}
          </Text>
        </View>
        <View style={styles.right}>
          <Text style={styles.time}>{formatLap(f.best_lap_s)}</Text>
          {f.best_session && <Text style={styles.sub} numberOfLines={1}>{f.best_session}</Text>}
        </View>
        <Text style={styles.chevron}>›</Text>
      </Pressable>
    </Link>
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
  h2: { fontSize: 13, fontWeight: '700', opacity: 0.6, textTransform: 'uppercase', letterSpacing: 0.5, marginTop: 8 },
  card: { flexDirection: 'row', alignItems: 'center', gap: 12, borderWidth: 1, borderColor: '#8884', borderRadius: 10,
    paddingHorizontal: 14, paddingVertical: 12 },
  loose: { borderStyle: 'dashed' },
  cardText: { flex: 1, gap: 2, backgroundColor: 'transparent' },
  title: { fontSize: 17, fontWeight: '700' },
  date: { fontSize: 14, opacity: 0.85 },
  sub: { opacity: 0.6, fontSize: 13 },
  right: { alignItems: 'flex-end', maxWidth: 120, backgroundColor: 'transparent' },
  time: { fontSize: 18, fontVariant: ['tabular-nums'] },
  chevron: { fontSize: 22, opacity: 0.4 },
});
