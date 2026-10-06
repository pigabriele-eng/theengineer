import {
  RecordingPresets,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  useAudioRecorder,
  useAudioRecorderState,
} from 'expo-audio';
import * as DocumentPicker from 'expo-document-picker';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { ActivityIndicator, Platform, Pressable, ScrollView, StyleSheet, TextInput } from 'react-native';

import { Text, View, useThemeColor } from '@/components/Themed';
import {
  api,
  DebriefLanguage,
  DebriefMode,
  DebriefPointIn,
  SECTIONS,
  sectionName,
  Session,
} from '@/lib/api';
import { Radius, themed, useTheme } from '@/constants/Theme';

const MODES: [DebriefMode, string][] = [
  ['individual', 'One driver'],
  ['group', 'Group'],
];
const LANGUAGES: [DebriefLanguage, string][] = [
  ['en', 'English'],
  ['it', 'Italiano'],
  ['de', 'Deutsch'],
  ['multi', 'Mixed'],
];

const clock = (ms: number) => {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

export default function DebriefScreen() {
  const styles = useStyles();
  const [sessions, setSessions] = useState<Session[]>([]);
  const [sessionId, setSessionId] = useState<number | null>(null);
  const [mode, setMode] = useState<DebriefMode>('individual');
  const [language, setLanguage] = useState<DebriefLanguage>('en');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [typing, setTyping] = useState(false);
  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const rec = useAudioRecorderState(recorder, 250);
  const tint = useThemeColor({}, 'tint');

  useFocusEffect(
    useCallback(() => {
      api.sessions().then((s) => {
        setSessions(s);
        setSessionId((cur) => cur ?? s[0]?.id ?? null);
      }, (e) => setStatus(e.message));
    }, []),
  );

  const send = async (audio: { uri: string; name: string; file?: File | Blob }) => {
    if (sessionId == null) return;
    setBusy(true);
    setStatus(null);
    try {
      const d = await api.recordDebrief(sessionId, audio, mode, language);
      router.push({ pathname: '/debrief/[id]', params: { id: d.id } });
    } catch (e) {
      setStatus((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const start = async () => {
    setStatus(null);
    const perm = await requestRecordingPermissionsAsync();
    if (!perm.granted) {
      setStatus('Microphone access is needed to record a debrief.');
      return;
    }
    await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true, shouldPlayInBackground: true });
    await recorder.prepareToRecordAsync();
    recorder.record();
  };

  const stop = async () => {
    await recorder.stop();
    await setAudioModeAsync({ allowsRecording: false });
    const uri = recorder.uri;
    if (!uri) {
      setStatus('The recording could not be saved.');
      return;
    }
    if (Platform.OS === 'web') {
      const blob = await (await fetch(uri)).blob();
      await send({ uri, name: 'debrief.webm', file: blob });
    } else {
      await send({ uri, name: 'debrief.m4a' });
    }
  };

  const pick = async () => {
    const res = await DocumentPicker.getDocumentAsync({ type: 'audio/*', copyToCacheDirectory: true });
    if (res.canceled) return;
    const a = res.assets[0];
    await send({ uri: a.uri, name: a.name, file: a.file });
  };

  const chip = (selected: boolean) => [styles.chip, selected && { borderColor: tint }];
  const chipText = (selected: boolean) => (selected ? { color: tint } : undefined);

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.h2}>Session</Text>
      <View style={styles.chips}>
        {sessions.slice(0, 6).map((s) => (
          <Pressable key={s.id} onPress={() => setSessionId(s.id)} style={chip(s.id === sessionId)}>
            <Text style={chipText(s.id === sessionId)}>{s.name ?? `Session ${s.id}`}</Text>
          </Pressable>
        ))}
        {sessions.length === 0 && <Text style={styles.note}>Create a session on the Sessions tab first.</Text>}
      </View>

      <Text style={styles.h2}>Who is talking</Text>
      <View style={styles.chips}>
        {MODES.map(([key, name]) => (
          <Pressable key={key} onPress={() => setMode(key)} style={chip(key === mode)}>
            <Text style={chipText(key === mode)}>{name}</Text>
          </Pressable>
        ))}
      </View>

      <Text style={styles.h2}>Language</Text>
      <View style={styles.chips}>
        {LANGUAGES.map(([key, name]) => (
          <Pressable key={key} onPress={() => setLanguage(key)} style={chip(key === language)}>
            <Text style={chipText(key === language)}>{name}</Text>
          </Pressable>
        ))}
      </View>

      <View style={styles.recordBox}>
        <Text style={styles.clock}>{clock(rec.durationMillis)}</Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={rec.isRecording ? 'Stop and send' : 'Start recording'}
          disabled={busy || sessionId == null}
          onPress={rec.isRecording ? stop : start}
          style={[styles.record, { borderColor: tint, opacity: busy || sessionId == null ? 0.4 : 1 }]}>
          <View style={[rec.isRecording ? styles.stopIcon : styles.recIcon]} />
        </Pressable>
        <Text style={styles.note}>
          {busy ? 'Sending…' : rec.isRecording ? 'Recording. Tap to stop and send.' : 'Tap to record the debrief.'}
        </Text>
        {busy && <ActivityIndicator />}
      </View>

      <Pressable style={[styles.secondary, { borderColor: tint }]} onPress={pick} disabled={busy || rec.isRecording}>
        <Text style={{ color: tint, fontWeight: '600' }}>Upload a recording instead</Text>
      </Pressable>
      {status && <Text style={styles.error}>{status}</Text>}

      <Pressable onPress={() => setTyping((t) => !t)}>
        <Text style={[styles.link, { color: tint }]}>{typing ? 'Hide typed points' : 'Or type points by hand'}</Text>
      </Pressable>
      {typing && sessionId != null && <TypedPoints sessionId={sessionId} />}
    </ScrollView>
  );
}

function TypedPoints({ sessionId }: { sessionId: number }) {
  const styles = useStyles();
  const theme = useTheme();
  const [section, setSection] = useState(SECTIONS[0][0]);
  const [draft, setDraft] = useState('');
  const [points, setPoints] = useState<DebriefPointIn[]>([]);
  const [status, setStatus] = useState<string | null>(null);
  const tint = useThemeColor({}, 'tint');
  const text = useThemeColor({}, 'text');

  const add = () => {
    if (!draft.trim()) return;
    setPoints((p) => [...p, { section, text: draft.trim() }]);
    setDraft('');
  };

  const save = async () => {
    if (points.length === 0) return;
    try {
      await api.createDebrief(sessionId, points);
      setPoints([]);
      setStatus('Debrief saved to the session');
    } catch (e) {
      setStatus((e as Error).message);
    }
  };

  return (
    <View style={styles.typed}>
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
        placeholderTextColor={theme.textMuted}
        multiline
        style={[styles.input, { color: text }]}
      />
      <Pressable style={[styles.secondary, { borderColor: tint }]} onPress={add}>
        <Text style={{ color: tint, fontWeight: '600' }}>Add point</Text>
      </Pressable>
      {points.map((p, i) => (
        <View key={i} style={styles.point}>
          <Text style={styles.pointSection}>{sectionName(p.section)}</Text>
          <Text>{p.text}</Text>
        </View>
      ))}
      <Pressable style={[styles.button, { backgroundColor: tint, opacity: points.length ? 1 : 0.4 }]} onPress={save}
        disabled={!points.length}>
        <Text style={styles.buttonText}>Save debrief</Text>
      </Pressable>
      {status && <Text style={styles.note}>{status}</Text>}
    </View>
  );
}

const useStyles = themed((c) => ({
  container: { padding: 16, gap: 12 },
  note: { opacity: 0.7, textAlign: 'center' },
  error: { color: c.error },
  h2: { fontSize: 16, fontWeight: '700', marginTop: 4 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { borderWidth: 1, borderColor: c.border, borderRadius: Radius.chip, paddingHorizontal: 12, paddingVertical: 4, backgroundColor: c.surface },
  recordBox: { alignItems: 'center', gap: 10, paddingVertical: 16 },
  clock: { fontSize: 40, fontWeight: '600', fontVariant: ['tabular-nums'] },
  record: { width: 88, height: 88, borderRadius: 44, borderWidth: 4, alignItems: 'center', justifyContent: 'center' },
  recIcon: { width: 60, height: 60, borderRadius: 30, backgroundColor: c.error },
  stopIcon: { width: 32, height: 32, borderRadius: 4, backgroundColor: c.error },
  link: { fontWeight: '600', paddingVertical: 4 },
  typed: { gap: 12 },
  input: { borderWidth: 1, borderColor: c.border, borderRadius: Radius.control, padding: 12, minHeight: 80, fontSize: 16, backgroundColor: c.surface },
  secondary: { borderWidth: 1, borderRadius: Radius.control, padding: 10, alignItems: 'center' },
  point: { borderLeftWidth: 3, borderColor: c.borderStrong, paddingLeft: 10, gap: 2 },
  pointSection: { fontSize: 12, opacity: 0.6, textTransform: 'uppercase', letterSpacing: 0.5 },
  button: { borderRadius: 8, padding: 14, alignItems: 'center' },
  buttonText: { color: c.onTint, fontWeight: '600', fontSize: 16 },
}));
