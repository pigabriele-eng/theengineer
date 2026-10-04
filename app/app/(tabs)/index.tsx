import { Link, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { FlatList, Pressable, StyleSheet, TextInput } from 'react-native';

import { Text, View, useThemeColor } from '@/components/Themed';
import { api, formatLap, Session, SessionKind } from '@/lib/api';

const KINDS: SessionKind[] = ['test', 'practice', 'qualifying', 'race'];

export default function SessionsScreen() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [kind, setKind] = useState<SessionKind>('test');
  const tint = useThemeColor({}, 'tint');
  const text = useThemeColor({}, 'text');

  const load = useCallback(() => {
    api.sessions().then(setSessions, (e) => setError(e.message));
  }, []);
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
      {error && <Text style={styles.error}>Can't reach the server: {error}</Text>}
      <FlatList
        data={sessions}
        keyExtractor={(s) => String(s.id)}
        ListEmptyComponent={<Text style={styles.empty}>No sessions yet. Add one above, then upload a logger file.</Text>}
        renderItem={({ item }) => (
          <Link href={{ pathname: '/session/[id]', params: { id: item.id } }} asChild>
            <Pressable style={styles.row}>
              <View style={styles.rowText}>
                <Text style={styles.title}>{item.name ?? `Session ${item.id}`}</Text>
                <Text style={styles.sub}>
                  {item.kind} · {new Date(item.created_at).toLocaleDateString()}
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

const styles = StyleSheet.create({
  container: { flex: 1, padding: 16, gap: 12 },
  newRow: { flexDirection: 'row', gap: 8 },
  input: { flex: 1, borderWidth: 1, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10, fontSize: 16 },
  button: { borderRadius: 8, paddingHorizontal: 18, justifyContent: 'center' },
  buttonText: { color: '#fff', fontWeight: '600' },
  kinds: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  chip: { borderWidth: 1, borderColor: '#8884', borderRadius: 16, paddingHorizontal: 12, paddingVertical: 4 },
  error: { color: '#c8372d' },
  empty: { opacity: 0.6, marginTop: 24, textAlign: 'center' },
  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 12, borderBottomWidth: 1, borderColor: '#8882' },
  rowText: { flex: 1, backgroundColor: 'transparent' },
  title: { fontSize: 16, fontWeight: '600' },
  sub: { opacity: 0.6, marginTop: 2 },
  time: { fontSize: 18, fontVariant: ['tabular-nums'] },
});
