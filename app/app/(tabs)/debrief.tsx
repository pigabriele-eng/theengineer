import {
  RecordingPresets,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  useAudioRecorder,
  useAudioRecorderState,
} from 'expo-audio';
import * as DocumentPicker from 'expo-document-picker';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
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
  WaitingRecording,
} from '@/lib/api';
import { goToData } from '@/lib/openCurrent';
import { fileRecordedAt, localTime, recordedLabel } from '@/lib/debriefTime';
import { LiveSegment, speechLang, speechSupported, startLiveSpeech } from '@/lib/liveSpeech';
import { face, Fonts, inkOn, themed, useTheme } from '@/constants/Theme';

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

// The run picked by time: the one that ended just before the recording, joined now or once its log is uploaded.
const BY_TIME = -1;

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
  const params = useLocalSearchParams<{ session?: string; go?: string }>();
  const asked = Number(params.session) || null;
  // ?go=1: opened from the record key on any page, so it records at once (once: the parameter is then cleared)
  const go = params.go === '1';
  const [sessions, setSessions] = useState<Session[]>([]);
  const [sessionId, setSessionId] = useState<number | null>(asked ?? BY_TIME);
  useEffect(() => {
    if (asked != null) setSessionId(asked);
  }, [asked]);
  const [mode, setMode] = useState<DebriefMode>('individual');
  const [language, setLanguage] = useState<DebriefLanguage>('en');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [typing, setTyping] = useState(false);
  const [full, setFull] = useState(false); // on a phone: the whole page instead of the one big button
  const [saved, setSaved] = useState<string | null>(null);
  const [waiting, setWaiting] = useState<WaitingRecording[]>([]);
  const [startedAt, setStartedAt] = useState<string | null>(null);
  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const rec = useAudioRecorderState(recorder, 250);
  // what the browser writes down while recording (web only): sent with the recording, used when the server has no
  // speech to text of its own
  const canHear = Platform.OS === 'web' && speechSupported();
  const live = useRef<{ stop(): LiveSegment[] } | null>(null);
  const [heard, setHeard] = useState<{ finals: LiveSegment[]; interim: string }>({ finals: [], interim: '' });
  useEffect(() => () => {
    try {
      live.current?.stop();
    } catch {
      // nothing to stop
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      api.sessions().then(setSessions, (e) => setStatus(e.message));
      api.waitingRecordings().then(setWaiting, () => setWaiting([]));
    }, []),
  );

  const send = async (audio: { uri: string; name: string; file?: File | Blob }, recordedAt: string, said?: LiveSegment[]) => {
    if (sessionId == null) return;
    setBusy(true);
    setStatus(null);
    setSaved(null);
    try {
      if (sessionId === BY_TIME) {
        const r = await api.recordDebriefByTime(audio, mode, language, recordedAt, said);
        if (r.debrief) {
          router.push({ pathname: '/debrief/[id]', params: { id: r.debrief.id } });
        } else if (r.waiting) {
          const w = r.waiting;
          setWaiting((ws) => [w, ...ws.filter((x) => x.id !== w.id)]);
          setSaved('Saved. No run ended just before it yet: it joins its run when that log is uploaded, or pick the run below.');
        }
        return;
      }
      const d = await api.recordDebrief(sessionId, audio, mode, language, said);
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
    setStartedAt(localTime(new Date()));
    recorder.record();
    setHeard({ finals: [], interim: '' });
    if (canHear) {
      try {
        live.current = startLiveSpeech(speechLang(language, navigator.language), Date.now(),
          (finals, interim) => setHeard({ finals, interim }));
      } catch {
        live.current = null;
      }
    }
  };

  const stopHearing = (): LiveSegment[] => {
    try {
      return live.current?.stop() ?? [];
    } catch {
      return [];
    } finally {
      live.current = null;
    }
  };

  // opened from the record key: start straight away (if the browser asks for the microphone first, that is the one tap)
  const autoStarted = useRef(false);
  useEffect(() => {
    if (!go) {
      autoStarted.current = false; // the next tap on the key records again
      return;
    }
    if (autoStarted.current) return;
    autoStarted.current = true;
    router.setParams({ go: undefined });
    start().catch((e) => setStatus((e as Error).message));
    // start reads the current choices; it only runs once, on arrival
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [go]);

  const stop = async () => {
    const said = stopHearing();
    setHeard((h) => ({ ...h, interim: '' }));
    await recorder.stop();
    await setAudioModeAsync({ allowsRecording: false });
    const uri = recorder.uri;
    if (!uri) {
      setStatus('The recording could not be saved.');
      return;
    }
    if (Platform.OS === 'web') {
      const blob = await (await fetch(uri)).blob();
      await send({ uri, name: 'debrief.webm', file: blob }, startedAt ?? localTime(new Date()), said);
    } else {
      await send({ uri, name: 'debrief.m4a' }, startedAt ?? localTime(new Date()), said);
    }
  };

  const pick = async () => {
    // WhatsApp voice notes (.opus) come typed as application/ogg or as plain bytes on some phones, so those are offered
    // too; the server takes only audio file types (server/app/routers/debriefs.py AUDIO)
    const res = await DocumentPicker.getDocumentAsync({
      type: Platform.OS === 'web'
        ? ['audio/*', 'application/ogg', '.opus', '.amr', '.3gp']
        : ['audio/*', 'application/ogg', 'application/octet-stream'],
      copyToCacheDirectory: true,
    });
    if (res.canceled) return;
    const a = res.assets[0];
    await send({ uri: a.uri, name: a.name, file: a.file }, fileRecordedAt(a.lastModified ?? a.file?.lastModified));
  };

  const off = busy || sessionId == null;
  const session = sessions.find((s) => s.id === sessionId);
  const byTime = sessionId === BY_TIME;
  // typed points go with a real run: the newest when the run is left to be found by time
  const typedFor = byTime ? sessions[0]?.id ?? null : sessionId;
  const runName = (s: Session) => s.name ?? `Session ${s.id}`;

  const liveBlock = Platform.OS === 'web' && rec.isRecording && (canHear ? (
          <View style={styles.live} accessibilityLiveRegion="polite" aria-live="polite">
            <Label small>Writing down what you say</Label>
            <Text style={styles.liveText}>
              {heard.finals.map((f) => f.text).join(' ')}
              {heard.interim ? <Text style={styles.liveInterim}>{`${heard.finals.length ? ' ' : ''}${heard.interim}`}</Text> : null}
              {!heard.finals.length && !heard.interim ? <Text style={styles.liveInterim}>Listening…</Text> : null}
            </Text>
          </View>
        ) : (
          <Text style={StyleSheet.flatten([styles.liveNote, styles.gapTop])}>
            This browser can't write down speech. The recording is kept and written up once speech to text is set up.
          </Text>
        ));

  // On a phone, opened as the app's first page or from the record key: one big red button, and a way to the data
  // (Gabriele, 2026-10-09). The choices keep their defaults (the last run by time, one driver) until More options.
  if (!wide && asked == null && !full) {
    const recording = rec.isRecording;
    return (
      <Page keyboardShouldPersistTaps="handled">
        <View style={styles.quick}>
          <Pressable accessibilityRole="button" accessibilityLabel={recording ? 'Stop and send' : 'Record a debrief'}
            disabled={busy} onPress={recording ? stop : start}
            style={StyleSheet.flatten([styles.bigKey, recording && styles.bigKeyOn, busy && styles.dim])}>
            {recording ? <View style={styles.bigStop} /> : null}
            <Text style={StyleSheet.flatten([styles.bigLabel, { color: inkOn(recording ? theme.text : theme.mark) }])}>
              {busy ? 'Sending…' : recording ? `Stop and send  ${clock(rec.durationMillis)}` : 'Record debrief'}
            </Text>
          </Pressable>
          {busy && <ActivityIndicator color={theme.text} />}
          {liveBlock}
          {saved && <Text style={t.note}>{saved}</Text>}
          {status && <Text style={t.error}>{status}</Text>}
          {!recording && (
            <Text style={t.note}>
              {`Goes with the run that ended just before. ${MODES.find(([k]) => k === mode)?.[1]}, ${
                LANGUAGES.find(([k]) => k === language)?.[1]}.`}
              {waiting.length ? ` ${waiting.length} recording${waiting.length > 1 ? 's' : ''} waiting for a run.` : ''}
            </Text>
          )}
          <View style={styles.quickLinks}>
            <TextLink label="Go to data" onPress={goToData} arrow disabled={recording} />
            <TextLink label="More options" onPress={() => setFull(true)} disabled={recording} />
          </View>
        </View>
      </Page>
    );
  }

  return (
    <Page keyboardShouldPersistTaps="handled">
      <PageHead title="Debrief"
        dek="Record what the driver says after the run. It comes back as points by corner and phase, each one checked against the data." />

      <Section no={1} title="Who and what" dek={byTime
        ? 'Goes with the run that ended just before you record. Log not uploaded yet? It joins that run after the upload.'
        : session ? `Goes with ${runName(session)}.` : undefined}>
        <View style={wide ? styles.setupWide : styles.setup}>
          <Tabs label="Session" value={sessionId} onChange={setSessionId} style={wide ? styles.setupMain : undefined}
            items={[{ key: BY_TIME, label: 'Last run, by time' },
              ...offered(sessions, sessionId).map((s) => ({ key: s.id, label: runName(s) }))]} />
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
        {liveBlock}
        <View style={styles.links}>
          <TextLink label="Upload a recording instead" onPress={pick} disabled={busy || rec.isRecording} />
        </View>
        {saved && <Text style={StyleSheet.flatten([t.note, styles.gapTop])}>{saved}</Text>}
        {status && <Text style={StyleSheet.flatten([t.error, styles.gapTop])}>{status}</Text>}
      </Section>

      {waiting.length > 0 && (
        <Section no={3} title="Waiting for their run"
          dek="Recorded when no run had just ended. Each one joins its run by itself after the upload, or pick the run now.">
          {waiting.map((w) => (
            <WaitingRow key={w.id} w={w} sessions={sessions}
              gone={() => setWaiting((ws) => ws.filter((x) => x.id !== w.id))} />
          ))}
        </Section>
      )}

      <Section no={waiting.length > 0 ? 4 : 3} title="Or type it" dek={byTime && sessions[0]
        ? `Points written by hand, filed under the report's sections. They go with ${runName(sessions[0])}.`
        : "Points written by hand, filed under the report's sections."}>
        <TextLink label={typing ? 'Hide typed points' : 'Type points by hand'} onPress={() => setTyping((v) => !v)} />
        {typing && typedFor != null && <TypedPoints sessionId={typedFor} />}
      </Section>

      <Colophon left="Debrief" right="Recorded after the run" />
    </Page>
  );
}

/** A recording waiting for its run: pick the run (it becomes that run's debrief) or delete it. */
function WaitingRow({ w, sessions, gone }: { w: WaitingRecording; sessions: Session[]; gone: () => void }) {
  const styles = useStyles();
  const t = useText();
  const [sure, setSure] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pick = async (sessionId: number) => {
    setBusy(true);
    setError(null);
    try {
      const d = await api.pickRunForRecording(w.id, sessionId);
      gone();
      router.push({ pathname: '/debrief/[id]', params: { id: d.id } });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.deleteWaitingRecording(w.id);
      gone();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <View style={styles.waiting}>
      <Label small>{`Recorded ${recordedLabel(w.recorded_at)} · ${MODES.find(([k]) => k === w.mode)?.[1] ?? w.mode}`}</Label>
      {sessions.length > 0 ? (
        <Tabs label="Goes with" value={null as number | null} onChange={(k) => k != null && !busy && pick(k)}
          items={sessions.slice(0, 6).map((s) => ({ key: s.id, label: s.name ?? `Session ${s.id}`, disabled: busy }))} />
      ) : (
        <Text style={t.note}>Upload the run’s log and it joins that run by itself.</Text>
      )}
      {sure ? (
        <View style={styles.sure}>
          <Text style={t.body}>Delete this recording for good?</Text>
          <TextLink label="Delete" onPress={remove} disabled={busy} />
          <TextLink label="Keep it" onPress={() => setSure(false)} disabled={busy} />
        </View>
      ) : (
        <TextLink label="Delete recording" onPress={() => setSure(true)} disabled={busy} />
      )}
      {error && <Text style={t.error}>{error}</Text>}
    </View>
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
  // the words heard so far under the record key: a ruled block, no box
  live: { marginTop: 22, paddingTop: 12, borderTopWidth: 1, borderColor: c.rule, gap: 8, maxWidth: 760 },
  liveText: { fontFamily: Fonts.body, fontSize: 17, lineHeight: 25, color: c.text } as TextStyle,
  liveInterim: { fontFamily: face('body', 400, true), color: c.textSecondary } as TextStyle,
  liveNote: { fontFamily: Fonts.body, fontSize: 16, lineHeight: 22, color: c.textSecondary } as TextStyle,
  typed: { gap: 18, marginTop: 20, maxWidth: 760 },
  inputLabel: { marginBottom: 6 },
  input: { borderWidth: 1, borderColor: c.rule, borderRadius: 0, padding: 12, minHeight: 88, fontSize: 16, lineHeight: 22,
    fontFamily: Fonts.body, color: c.text, backgroundColor: c.background, textAlignVertical: 'top',
    // the browser's own focus ring is rounded: a heavier ink frame shows the focus instead
    outlineWidth: 0 } as TextStyle,
  inputFocus: { borderWidth: 2, padding: 11 },
  waiting: { gap: 12, paddingVertical: 16, borderBottomWidth: 1, borderColor: c.separator },
  sure: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: 20, rowGap: 8 },
  quick: { gap: 20, paddingTop: 24, paddingBottom: 96 },
  bigKey: { minHeight: 280, backgroundColor: c.mark, borderWidth: 3, borderColor: c.rule, alignItems: 'center',
    justifyContent: 'center', gap: 18, padding: 20 },
  bigKeyOn: { backgroundColor: c.text },
  bigStop: { width: 56, height: 56, backgroundColor: c.mark },
  bigLabel: { fontFamily: Fonts.display, fontSize: 40, lineHeight: 46, textTransform: 'uppercase', textAlign: 'center' },
  quickLinks: { flexDirection: 'row', flexWrap: 'wrap', columnGap: 28, rowGap: 12 },
  points: { borderTopWidth: 1, borderColor: c.rule },
  point: { gap: 3, paddingVertical: 10, borderBottomWidth: 1, borderColor: c.separator },
}));
