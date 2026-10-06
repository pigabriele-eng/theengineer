// Where to move the picked sessions: another event, a new one, or out of every event.
import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet } from 'react-native';

import { EventForm } from '@/components/EventForm';
import { Text, View, useThemeColor } from '@/components/Themed';
import { dateRange, eventsApi, FolderSummary, NO_EVENT } from '@/lib/events';

export function MoveSessions({ fromKey, count, onMove, onCancel }: {
  fromKey: string; // the folder they are in now
  count: number;
  onMove: (toKey: string, toName: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [folders, setFolders] = useState<FolderSummary[] | null>(null);
  const [making, setMaking] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const tint = useThemeColor({}, 'tint');

  useEffect(() => {
    eventsApi.folders().then(setFolders, (e) => setError((e as Error).message));
  }, []);

  const go = async (key: string, name: string) => {
    setBusy(key);
    setError(null);
    try {
      await onMove(key, name);
    } catch (e) {
      setError((e as Error).message);
      setBusy(null);
    }
  };
  const targets = (folders ?? []).filter((f) => f.id != null && f.key !== fromKey);
  const what = `${count} ${count === 1 ? 'session' : 'sessions'}`;

  return (
    <View style={styles.box}>
      <Text style={styles.title}>Move {what} to…</Text>
      {!folders && !error && <ActivityIndicator />}
      {targets.map((f) => (
        <Pressable key={f.key} onPress={() => go(f.key, f.name)} disabled={busy != null} style={styles.row}
          accessibilityRole="button">
          <View style={styles.grow}>
            <Text style={styles.name} numberOfLines={1}>{f.name}</Text>
            <Text style={styles.sub} numberOfLines={1}>
              {[f.track, dateRange(f.start, f.end), `${f.sessions} ${f.sessions === 1 ? 'session' : 'sessions'}`]
                .filter(Boolean).join(' · ')}
            </Text>
          </View>
          {busy === f.key ? <ActivityIndicator /> : <Text style={{ color: tint }}>Move here</Text>}
        </Pressable>
      ))}
      {making ? (
        <EventForm submitLabel={`Make it and move ${what}`} onCancel={() => setMaking(false)}
          onSubmit={async (v) => {
            const ev = await eventsApi.create(v);
            await onMove(ev.key, ev.name);
          }} />
      ) : (
        <Pressable onPress={() => setMaking(true)} style={styles.row} accessibilityRole="button">
          <Text style={StyleSheet.flatten([styles.name, { color: tint }])}>＋ A new event…</Text>
        </Pressable>
      )}
      {fromKey !== NO_EVENT && (
        <Pressable onPress={() => go(NO_EVENT, 'no event')} disabled={busy != null} style={styles.row}
          accessibilityRole="button">
          <View style={styles.grow}>
            <Text style={styles.name}>Out of this event</Text>
            <Text style={styles.sub}>They go to the sessions not in an event</Text>
          </View>
          {busy === NO_EVENT ? <ActivityIndicator /> : <Text style={{ color: tint }}>Move</Text>}
        </Pressable>
      )}
      {error && <Text style={styles.error}>{error}</Text>}
      <Pressable onPress={onCancel} hitSlop={8} accessibilityRole="button">
        <Text style={{ color: tint }}>Cancel</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  box: { gap: 4, borderWidth: 1, borderColor: '#8884', borderRadius: 10, padding: 12 },
  title: { fontSize: 16, fontWeight: '700', marginBottom: 4 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 10, borderBottomWidth: 1,
    borderColor: '#8882' },
  grow: { flex: 1, backgroundColor: 'transparent' },
  name: { fontSize: 15, fontWeight: '600' },
  sub: { fontSize: 12, opacity: 0.6 },
  error: { color: '#c8372d' },
});
