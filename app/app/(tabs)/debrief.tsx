import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, TextInput } from 'react-native';

import { Text, View, useThemeColor } from '@/components/Themed';
import { api, DebriefPointIn, Session } from '@/lib/api';

// The report sections from the debrief concept. Voice recording and AI structuring arrive in step 2;
// for now points are typed in, so the shared history and data model can be used end to end.
const SECTIONS: [string, string][] = [
  ['balance', 'Car balance'],
  ['corners', 'Corner by corner'],
  ['tyres', 'Tyres'],
  ['brakes', 'Brakes and ABS'],
  ['electronics', 'Electronics'],
  ['traction', 'Traction and power'],
  ['ride', 'Ride and kerbs'],
  ['setup', 'Setup changes'],
  ['issues', 'Issues'],
  ['priorities', 'Driver priorities'],
];

export default function DebriefScreen() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [sessionId, setSessionId] = useState<number | null>(null);
  const [section, setSection] = useState(SECTIONS[0][0]);
  const [draft, setDraft] = useState('');
  const [points, setPoints] = useState<DebriefPointIn[]>([]);
  const [status, setStatus] = useState<string | null>(null);
  const tint = useThemeColor({}, 'tint');
  const background = useThemeColor({}, 'background');
  const text = useThemeColor({}, 'text');

  useFocusEffect(
    useCallback(() => {
      api.sessions().then((s) => {
        setSessions(s);
        setSessionId((cur) => cur ?? s[0]?.id ?? null);
      }, (e) => setStatus(e.message));
    }, []),
  );

  const add = () => {
    if (!draft.trim()) return;
    setPoints((p) => [...p, { section, text: draft.trim() }]);
    setDraft('');
  };

  const save = async () => {
    if (sessionId == null || points.length === 0) return;
    try {
      await api.createDebrief(sessionId, points);
      setPoints([]);
      setStatus('Debrief saved to the session');
    } catch (e) {
      setStatus((e as Error).message);
    }
  };

  const label = (key: string) => SECTIONS.find(([k]) => k === key)?.[1] ?? key;

  return (
    <ScrollView style={{ backgroundColor: background }} contentContainerStyle={styles.container}>
      <Text style={styles.note}>Voice recording comes next. For now, type the key points of the debrief.</Text>

      <Text style={styles.h2}>Session</Text>
      <View style={styles.chips}>
        {sessions.slice(0, 6).map((s) => (
          <Pressable key={s.id} onPress={() => setSessionId(s.id)}
            style={[styles.chip, s.id === sessionId && { borderColor: tint }]}>
            <Text style={s.id === sessionId ? { color: tint } : undefined}>{s.name ?? `Session ${s.id}`}</Text>
          </Pressable>
        ))}
        {sessions.length === 0 && <Text style={styles.note}>Create a session on the Sessions tab first.</Text>}
      </View>

      <Text style={styles.h2}>Section</Text>
      <View style={styles.chips}>
        {SECTIONS.map(([key, name]) => (
          <Pressable key={key} onPress={() => setSection(key)} style={[styles.chip, key === section && { borderColor: tint }]}>
            <Text style={key === section ? { color: tint } : undefined}>{name}</Text>
          </Pressable>
        ))}
      </View>

      <TextInput
        value={draft}
        onChangeText={setDraft}
        onSubmitEditing={add}
        placeholder="e.g. Entry understeer in T1, worse on new tyres"
        placeholderTextColor="#888"
        multiline
        style={[styles.input, { color: text }]}
      />
      <Pressable style={[styles.secondary, { borderColor: tint }]} onPress={add}>
        <Text style={{ color: tint, fontWeight: '600' }}>Add point</Text>
      </Pressable>

      {points.map((p, i) => (
        <View key={i} style={styles.point}>
          <Text style={styles.pointSection}>{label(p.section)}</Text>
          <Text>{p.text}</Text>
        </View>
      ))}

      <Pressable style={[styles.button, { backgroundColor: tint, opacity: points.length ? 1 : 0.4 }]} onPress={save}
        disabled={!points.length}>
        <Text style={styles.buttonText}>Save debrief</Text>
      </Pressable>
      {status && <Text style={styles.note}>{status}</Text>}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { padding: 16, gap: 12 },
  note: { opacity: 0.7 },
  h2: { fontSize: 16, fontWeight: '700', marginTop: 4 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { borderWidth: 1, borderColor: '#8884', borderRadius: 16, paddingHorizontal: 12, paddingVertical: 4 },
  input: { borderWidth: 1, borderColor: '#8884', borderRadius: 8, padding: 12, minHeight: 80, fontSize: 16 },
  secondary: { borderWidth: 1, borderRadius: 8, padding: 10, alignItems: 'center' },
  point: { borderLeftWidth: 3, borderColor: '#8886', paddingLeft: 10, gap: 2 },
  pointSection: { fontSize: 12, opacity: 0.6, textTransform: 'uppercase', letterSpacing: 0.5 },
  button: { borderRadius: 8, padding: 14, alignItems: 'center' },
  buttonText: { color: '#fff', fontWeight: '600', fontSize: 16 },
});
