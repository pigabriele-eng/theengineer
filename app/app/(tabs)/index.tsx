import { Link, useFocusEffect } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { Pressable, SectionList, StyleSheet, TextInput } from 'react-native';

import { ImportLogs } from '@/components/ImportLogs';
import { Text, View, useThemeColor } from '@/components/Themed';
import { api, formatLap, Session, SessionKind } from '@/lib/api';
import { EventInfo, fetchEvents, SessionInEvent } from '@/lib/report';

const KINDS: SessionKind[] = ['test', 'practice', 'qualifying', 'race'];

export default function SessionsScreen() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [events, setEvents] = useState<EventInfo[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [kind, setKind] = useState<SessionKind>('test');
  const tint = useThemeColor({}, 'tint');
  const text = useThemeColor({}, 'text');

  const load = useCallback(() => {
    api.sessions().then(setSessions, (e) => setError(e.message));
    fetchEvents().then(setEvents, () => setEvents([]));
  }, []);
  const groups = useMemo(() => groupByEvent(sessions as SessionInEvent[], events), [sessions, events]);
  useFocusEffect(load);

  const create = async () => {
    try {
      await api.createSession({ name: name.trim() || 'New session', kind });
      setName('');
      load();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <View style={styles.container}>
      <View style={styles.newRow}>
        <TextInput
          value={name}
          onChangeText={setName}
          placeholder="Session name, e.g. Norisring FP2"
          placeholderTextColor="#888"
          style={[styles.input, { color: text, borderColor: '#8884' }]}
        />
        <Pressable style={[styles.button, { backgroundColor: tint }]} onPress={create}>
          <Text style={styles.buttonText}>Add</Text>
        </Pressable>
      </View>
      <View style={styles.kinds}>
        {KINDS.map((k) => (
          <Pressable key={k} onPress={() => setKind(k)} style={[styles.chip, k === kind && { borderColor: tint }]}>
            <Text style={k === kind ? { color: tint } : undefined}>{k}</Text>
          </Pressable>
        ))}
      </View>
      <ImportLogs onProgress={load} />
      {sessions.some((s) => s.best_lap_s != null) && (
        // Link asChild hands its child's style to a web anchor, which can't take a style array: one object
        <Link href="/compare" asChild>
          <Pressable style={StyleSheet.flatten([styles.compare, { borderColor: tint }])}>
            <Text style={[styles.compareText, { color: tint }]}>Compare laps from any sessions</Text>
          </Pressable>
        </Link>
      )}
      {error && <Text style={styles.error}>Can't reach the server: {error}</Text>}
      <SectionList
        sections={groups}
        keyExtractor={(s) => String(s.id)}
        stickySectionHeadersEnabled={false}
        ListEmptyComponent={
          <Text style={styles.empty}>
            No sessions yet. Add one above and upload a logger file to it, or upload logs or a zip of a whole test: each
            log becomes a session.
          </Text>
        }
        renderSectionHeader={({ section }) => (
          <View style={styles.group}>
            <View style={styles.rowText}>
              <Text style={styles.groupTitle}>{section.title}</Text>
              <Text style={styles.sub}>
                {section.data.length} {section.data.length === 1 ? 'session' : 'sessions'}
                {section.date ? ` · ${new Date(section.date).toLocaleDateString()}` : ''}
              </Text>
            </View>
            {/* Link asChild hands its child's style to a web anchor, which can't take a style array: one object */}
            {section.eventId != null && section.data.some((x) => x.best_lap_s != null) && (
              <Link href={{ pathname: '/report', params: { event: section.eventId } }} asChild>
                <Pressable style={StyleSheet.flatten([styles.reportButton, { borderColor: tint }])}>
                  <Text style={StyleSheet.flatten([styles.reportText, { color: tint }])}>Report</Text>
                </Pressable>
              </Link>
            )}
          </View>
        )}
        renderItem={({ item }) => (
          <Link href={{ pathname: '/session/[id]', params: { id: item.id } }} asChild>
            <Pressable style={styles.row}>
              <View style={styles.rowText}>
                <Text style={styles.title}>{item.name ?? `Session ${item.id}`}</Text>
                <Text style={styles.sub} numberOfLines={1}>
                  {[item.track_name, item.kind, new Date(item.created_at).toLocaleDateString()]
                    .filter(Boolean)
                    .join(' · ')}
                </Text>
              </View>
              <Text style={styles.time}>{formatLap(item.best_lap_s)}</Text>
            </Pressable>
          </Link>
        )}
      />
    </View>
  );
}

type Group = { title: string; eventId: number | null; date: string | null; data: SessionInEvent[] };

/** Sessions under their event (a test or a race weekend), the event with the newest session first; sessions of an
 * event in name order, which is run order for an imported test. Sessions without an event come as one group. */
function groupByEvent(sessions: SessionInEvent[], events: EventInfo[]): Group[] {
  const byId = new Map(events.map((e) => [e.id, e]));
  const groups = new Map<number | null, Group>();
  for (const s of sessions) {
    const id = s.event_id != null && byId.has(s.event_id) ? s.event_id : null;
    if (!groups.has(id)) {
      const ev = id != null ? byId.get(id)! : null;
      groups.set(id, { title: ev ? ev.name : 'Sessions without an event', eventId: id, date: ev?.date ?? null,
        data: [] });
    }
    groups.get(id)!.data.push(s);
  }
  const newest = (g: Group) => Math.max(...g.data.map((s) => Date.parse(s.created_at)));
  for (const g of groups.values()) {
    if (g.eventId != null) {
      g.data.sort((a, b) => (a.name ?? '').localeCompare(b.name ?? '', undefined, { numeric: true }));
    }
  }
  return [...groups.values()].sort((a, b) => newest(b) - newest(a));
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 16, gap: 12 },
  newRow: { flexDirection: 'row', gap: 8 },
  input: { flex: 1, borderWidth: 1, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10, fontSize: 16 },
  button: { borderRadius: 8, paddingHorizontal: 18, justifyContent: 'center' },
  buttonText: { color: '#fff', fontWeight: '600' },
  kinds: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  chip: { borderWidth: 1, borderColor: '#8884', borderRadius: 16, paddingHorizontal: 12, paddingVertical: 4 },
  compare: { borderWidth: 1, borderRadius: 8, padding: 12, alignItems: 'center' },
  compareText: { fontWeight: '600', fontSize: 15 },
  error: { color: '#c8372d' },
  empty: { opacity: 0.6, marginTop: 24, textAlign: 'center' },
  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 12, borderBottomWidth: 1, borderColor: '#8882' },
  rowText: { flex: 1, backgroundColor: 'transparent' },
  title: { fontSize: 16, fontWeight: '600' },
  sub: { opacity: 0.6, marginTop: 2 },
  time: { fontSize: 18, fontVariant: ['tabular-nums'] },
  group: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingTop: 18, paddingBottom: 6,
    borderBottomWidth: 1, borderColor: '#8884' },
  groupTitle: { fontSize: 17, fontWeight: '700' },
  reportButton: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 14, paddingVertical: 6 },
  reportText: { fontWeight: '600' },
});
