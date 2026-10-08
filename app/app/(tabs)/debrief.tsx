import {
  RecordingPresets,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  useAudioRecorder,
  useAudioRecorderState,
} from 'expo-audio';
import * as DocumentPicker from 'expo-document-picker';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Platform, Pressable, StyleSheet, TextInput, TextStyle } from 'react-native';

import { MainAction, PageHead, Tabs, useText } from '@/components/Picks';
import { Colophon, Fig, Label, Page, Section, TextLink, useWide } from '@/components/Programme';
import { Text, View } from '@/components/Themed';
import {
  api,
  DebriefLanguage,
  DebriefMode,
  DebriefPointIn,
  SECTIONS,
  sectionName,
  Session,
} from '@/lib/api';
import { Fonts, themed, useTheme } from '@/constants/Theme';

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

/** The runs offered: the six newest, and the one picked first when it is older (opened with ?session=). */
const offered = (sessions: Session[], picked: number | null) => {
  const newest = sessions.slice(0, 6);
  const own = newest.some((s) => s.id === picked) ? null : sessions.find((s) => s.id === picked);
  return own ? [own, ...newest] : newest;
};

const clock = (ms: number) => {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

export default function DebriefScreen() {
  const styles = useStyles();
  const t = useText();
  const wide = useWide();
  const theme = useTheme();
  // ?session=<id>: the run to record for, already picked (the weekend page's and a run's "Record debrief")
  const asked = Number(useLocalSearchParams<{ session?: string }>().session) || null;
  const [sessions, setSessions] = useState<Session[]>([]);
  const [sessionId, setSessionId] = useState<number | null>(asked);
  useEffect(() => {
    if (asked != null) setSessionId(asked);
  }, [asked]);
  const [mode, setMode] = useState<DebriefMode>('individual');
  const [language, setLanguage] = useState<DebriefLanguage>('en');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [typing, setTyping] = useState(false);
  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const rec = useAudioRecorderState(recorder, 250);

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

  const off = busy || sessionId == null;
  const session = sessions.find((s) => s.id === sessionId);

  return (
    <Page keyboardShouldPersistTaps="handled">
      <PageHead title="Debrief"
        dek="Record what the driver says after the run. It comes back as points by corner and phase, each one checked against the data." />

      <Section no={1} title="Who and what" dek={session ? `Goes with ${session.name ?? `session ${session.id}`}.` : undefined}>
        <View style={wide ? styles.setupWide : styles.setup}>
          {sessions.length > 0 ? (
            <Tabs label="Session" value={sessionId} onChange={setSessionId} style={wide ? styles.setupMain : undefined}
              items={offered(sessions, sessionId).map((s) => ({ key: s.id, label: s.name ?? `Session ${s.id}` }))} />
          ) : (
            <View style={wide ? styles.setupMain : undefined}>
              <Label muted small>Session</Label>
              <Text style={StyleSheet.flatten([t.note, styles.gapTop])}>Upload a run’s log on the Upload page first.</Text>
            </View>
          )}
          <Tabs label="Who is talking" value={mode} onChange={setMode}
            items={MODES.map(([key, name]) => ({ key, label: name }))} />
          <Tabs label="Language" value={language} onChange={setLanguage}
            items={LANGUAGES.map(([key, name]) => ({ key, label: name }))} />
        </View>
      </Section>

      <Section no={2} title="Record">
        <View style={wide ? styles.recordWide : styles.record}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={rec.isRecording ? 'Stop and send' : 'Start recording'}
            disabled={off}
            onPress={rec.isRecording ? stop : start}
            style={StyleSheet.flatten([styles.button, off && styles.dim])}>
            <View style={rec.isRecording ? styles.stopIcon : styles.recIcon} />
          </Pressable>
          <View style={styles.recordWords}>
            <Fig label={rec.isRecording ? 'Recording' : 'Length'} value={clock(rec.durationMillis)} size={wide ? 88 : 64} />
            <Text style={t.italic}>
              {busy ? 'Sending…' : rec.isRecording ? 'Recording. Tap the square to stop and send.' : 'Tap the red square to record the debrief.'}
            </Text>
            {busy && <ActivityIndicator style={styles.left} color={theme.text} />}
          </View>
        </View>
        <View style={styles.links}>
          <TextLink label="Upload a recording instead" onPress={pick} disabled={busy || rec.isRecording} />
        </View>
        {status && <Text style={StyleSheet.flatten([t.error, styles.gapTop])}>{status}</Text>}
      </Section>

      <Section no={3} title="Or type it" dek="Points written by hand, filed under the report's sections.">
        <TextLink label={typing ? 'Hide typed points' : 'Type points by hand'} onPress={() => setTyping((v) => !v)} />
        {typing && sessionId != null && <TypedPoints sessionId={sessionId} />}
      </Section>

      <Colophon left="Debrief" right="Recorded after the run" />
    </Page>
  );
}

function TypedPoints({ sessionId }: { sessionId: number }) {
  const styles = useStyles();
  const t = useText();
  const theme = useTheme();
  const [section, setSection] = useState(SECTIONS[0][0]);
  const [draft, setDraft] = useState('');
  const [points, setPoints] = useState<DebriefPointIn[]>([]);
  const [status, setStatus] = useState<string | null>(null);
  const [focus, setFocus] = useState(false);

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
      <Tabs label="Section" value={section} onChange={setSection}
        items={SECTIONS.map(([key, name]) => ({ key, label: name }))} />
      <View>
        <Label small style={styles.inputLabel}>The point</Label>
        <TextInput
          value={draft}
          onChangeText={setDraft}
          onSubmitEditing={add}
          placeholder="e.g. Entry understeer in T1, worse on new tyres"
          placeholderTextColor={theme.textMuted}
          multiline
          onFocus={() => setFocus(true)}
          onBlur={() => setFocus(false)}
          style={StyleSheet.flatten([styles.input, focus && styles.inputFocus])}
        />
      </View>
      <TextLink label="Add point" onPress={add} disabled={!draft.trim()} />
      {points.length > 0 && (
        <View style={styles.points}>
          {points.map((p, i) => (
            <View key={i} style={styles.point}>
              <Label muted small>{sectionName(p.section)}</Label>
              <Text style={t.body}>{p.text}</Text>
            </View>
          ))}
        </View>
      )}
      <MainAction label={`Save debrief${points.length ? ` (${points.length})` : ''}`} onPress={save}
        disabled={!points.length} />
      {status && <Text style={t.note}>{status}</Text>}
    </View>
  );
}

const useStyles = themed((c) => ({
  setup: { gap: 22 },
  setupWide: { flexDirection: 'row', flexWrap: 'wrap', columnGap: 48, rowGap: 22, alignItems: 'flex-start' },
  setupMain: { flexBasis: 360, flexGrow: 1, flexShrink: 1, minWidth: 0 },
  gapTop: { marginTop: 8 },
  record: { flexDirection: 'row', alignItems: 'center', gap: 20 },
  recordWide: { flexDirection: 'row', alignItems: 'center', gap: 36 },
  recordWords: { flexShrink: 1, minWidth: 0, gap: 8 },
  // the record key: a square ink frame with the red square in it, a smaller ink square to stop
  button: { width: 96, height: 96, borderWidth: 3, borderColor: c.rule, alignItems: 'center', justifyContent: 'center' },
  recIcon: { width: 56, height: 56, backgroundColor: c.mark },
  stopIcon: { width: 34, height: 34, backgroundColor: c.text },
  dim: { opacity: 0.4 },
  left: { alignSelf: 'flex-start' },
  links: { marginTop: 22 },
  typed: { gap: 18, marginTop: 20, maxWidth: 760 },
  inputLabel: { marginBottom: 6 },
  input: { borderWidth: 1, borderColor: c.rule, borderRadius: 0, padding: 12, minHeight: 88, fontSize: 16, lineHeight: 22,
    fontFamily: Fonts.body, color: c.text, backgroundColor: c.background, textAlignVertical: 'top',
    // the browser's own focus ring is rounded: a heavier ink frame shows the focus instead
    outlineWidth: 0 } as TextStyle,
  inputFocus: { borderWidth: 2, padding: 11 },
  points: { borderTopWidth: 1, borderColor: c.rule },
  point: { gap: 3, paddingVertical: 10, borderBottomWidth: 1, borderColor: c.separator },
}));
