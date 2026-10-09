import {
  RecordingPresets,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  useAudioRecorder,
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
import { a11yState } from '@/lib/a11yState';
import { goToData } from '@/lib/openCurrent';
import { fileRecordedAt, localTime, recordedLabel } from '@/lib/debriefTime';
import { LiveSegment, speechLang, speechSupported, startLiveSpeech } from '@/lib/liveSpeech';
import { extFor, silentWav, STOP_WAIT_MS, WebRecorder } from '@/lib/webRecorder';
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

// idle: nothing recorded; paused: a part recorded, more can follow (one debrief in several parts); stopping: the
// recording is being finished and sent
type Phase = 'idle' | 'recording' | 'paused' | 'stopping';

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
  // Mixed by default: Gabriele's debriefs switch between Italian, English and German, and a recording told it is one
  // language comes out garbled where it isn't (2026-10-09)
  const [language, setLanguage] = useState<DebriefLanguage>('multi');
  // Deepgram writes the debrief once it's sent: the words the phone shows while recording are only a rough preview
  const [server, setServer] = useState<'deepgram' | 'phone' | null>(null);
  useEffect(() => {
    api.health().then((h) => setServer(h.speech ?? null), () => setServer(null));
  }, []);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [typing, setTyping] = useState(false);
  const [full, setFull] = useState(false); // on a phone: the whole page instead of the one big button
  const [saved, setSaved] = useState<string | null>(null);
  const [waiting, setWaiting] = useState<WaitingRecording[]>([]);
  const [startedAt, setStartedAt] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const [ms, setMs] = useState(0);
  const [parts, setParts] = useState(0);
  const [sure, setSure] = useState(false); // asked whether to delete the recording
  // the phone app records with expo-audio; the browser with lib/webRecorder.ts, whose stop can't hang
  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const web = useRef<WebRecorder | null>(null);
  const native = useRef<{ ran: number; since: number | null }>({ ran: 0, since: null });
  // what the browser writes down while recording (web only): sent with the recording, used when the server has no
  // speech to text of its own
  const canHear = Platform.OS === 'web' && speechSupported();
  const live = useRef<{ stop(): LiveSegment[] } | null>(null);
  const before = useRef<LiveSegment[]>([]); // the words of the parts recorded before this one
  const [heard, setHeard] = useState<{ finals: LiveSegment[]; interim: string }>({ finals: [], interim: '' });
  useEffect(() => () => {
    try {
      live.current?.stop();
    } catch {
      // nothing to stop
    }
    web.current?.discard(); // leaving the page lets go of the microphone
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

  const elapsed = () => web.current?.ms
    ?? native.current.ran + (native.current.since != null ? Date.now() - native.current.since : 0);
  useEffect(() => {
    if (phase !== 'recording') return;
    const tick = setInterval(() => setMs(elapsed()), 250);
    return () => clearInterval(tick);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  // the browser writes the words down part by part, each stamped from the start of the whole recording
  const listen = () => {
    if (!canHear) return;
    try {
      live.current = startLiveSpeech(speechLang(language, navigator.language), Date.now() - elapsed(),
        (finals, interim) => setHeard({ finals: [...before.current, ...finals], interim }));
    } catch {
      live.current = null;
    }
  };
  const quiet = () => {
    try {
      before.current = [...before.current, ...(live.current?.stop() ?? [])];
    } catch {
      // no words from this part
    } finally {
      live.current = null;
    }
    setHeard({ finals: before.current, interim: '' });
  };

  const start = async () => {
    if (phase !== 'idle') return;
    setStatus(null);
    setSaved(null);
    setSure(false);
    before.current = [];
    setHeard({ finals: [], interim: '' });
    if (Platform.OS === 'web') {
      let r: WebRecorder;
      try {
        r = await WebRecorder.open();
      } catch {
        setStatus('Microphone access is needed to record a debrief.');
        return;
      }
      r.onEnded = () => {
        quiet();
        setMs(r.ms);
        setPhase('paused');
        setStatus('The phone stopped the recording. Send what was recorded, or delete it.');
      };
      web.current = r;
      r.start();
    } else {
      const perm = await requestRecordingPermissionsAsync();
      if (!perm.granted) {
        setStatus('Microphone access is needed to record a debrief.');
        return;
      }
      await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true, shouldPlayInBackground: true });
      await recorder.prepareToRecordAsync();
      recorder.record();
      native.current = { ran: 0, since: Date.now() };
    }
    setStartedAt(localTime(new Date()));
    setMs(0);
    setParts(1);
    setPhase('recording');
    listen();
  };

  /** Pauses: the part is kept, and Carry on records the next part of the same debrief. */
  const pause = () => {
    if (phase !== 'recording') return;
    quiet();
    if (web.current) {
      web.current.pause();
    } else {
      recorder.pause();
      native.current = { ran: elapsed(), since: null };
    }
    setMs(elapsed());
    setPhase('paused');
  };

  const carryOn = () => {
    if (phase !== 'paused') return;
    setSure(false);
    if (web.current) {
      if (!web.current.resume()) {
        setStatus('The phone stopped the recording, so it can\'t carry on. Send what was recorded, or delete it.');
        return;
      }
    } else {
      recorder.record();
      native.current = { ...native.current, since: Date.now() };
    }
    setStatus(null);
    setParts((n) => n + 1);
    setPhase('recording');
    listen();
  };

  const reset = () => {
    web.current = null;
    native.current = { ran: 0, since: null };
    before.current = [];
    setHeard({ finals: [], interim: '' });
    setMs(0);
    setParts(0);
    setSure(false);
    setPhase('idle');
  };

  /** Throws the recording away: nothing is sent. */
  const discard = () => {
    quiet();
    if (web.current) {
      web.current.discard();
    } else {
      Promise.race([recorder.stop(), new Promise((r) => setTimeout(r, STOP_WAIT_MS))])
        .then(() => setAudioModeAsync({ allowsRecording: false }))
        .catch(() => {});
    }
    reset();
    setStatus(null);
    setSaved('Recording deleted. Nothing was sent.');
  };

  /** Stops and sends: answers at once ("Sending…"), and never waits more than a few seconds on the phone. */
  const stopAndSend = async () => {
    if (phase !== 'recording' && phase !== 'paused') return;
    setPhase('stopping');
    setSure(false);
    quiet();
    const said = before.current;
    const at = startedAt ?? localTime(new Date());
    try {
      let audio: { uri: string; name: string; file?: Blob };
      if (web.current) {
        const blob = await web.current.finish();
        if (blob.size > 0) {
          audio = { uri: '', name: `debrief${extFor(blob.type)}`, file: blob };
        } else if (said.length) {
          // the phone gave no sound but wrote the words down: those still make the debrief
          audio = { uri: '', name: 'debrief.wav', file: new Blob([silentWav() as BlobPart], { type: 'audio/wav' }) };
        } else {
          reset();
          setStatus('Nothing was recorded: the phone gave no sound. Check the microphone and record again.');
          return;
        }
      } else {
        await Promise.race([recorder.stop(), new Promise((r) => setTimeout(r, STOP_WAIT_MS))]);
        await setAudioModeAsync({ allowsRecording: false });
        if (!recorder.uri) {
          reset();
          setStatus('The recording could not be saved.');
          return;
        }
        audio = { uri: recorder.uri, name: 'debrief.m4a' };
      }
      reset();
      await send(audio, at, said);
    } catch (e) {
      reset();
      setStatus((e as Error).message);
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
  // typed points go with the run picked for them (Gabriele, 2026-10-09), else the newest run
  const [typedRun, setTypedRun] = useState<number | null>(null);
  const typedFor = typedRun ?? (byTime ? sessions[0]?.id ?? null : sessionId);
  const runName = (s: Session) => s.name ?? `Session ${s.id}`;

  const recording = phase === 'recording';
  const held = phase === 'paused';
  const sending = phase === 'stopping' || busy;
  const active = phase !== 'idle';
  const partsLine = parts > 1 ? `, ${parts} parts` : '';

  // under the record button while a recording is going: pause it (more parts follow), send it, or delete it
  const controls = active && !sending && (sure ? (
    <View style={styles.sure}>
      <Text style={t.body}>Delete this recording? Nothing is sent.</Text>
      <TextLink label="Delete" red onPress={discard} />
      <TextLink label="Keep it" onPress={() => setSure(false)} />
    </View>
  ) : (
    <View style={styles.controls}>
      {held && <MainAction label={`Send debrief  ${clock(ms)}${partsLine}`} onPress={stopAndSend} />}
      <View style={styles.quickLinks}>
        {recording && <TextLink label="Pause" onPress={pause} />}
        <TextLink label="Delete" onPress={() => {
          pause();
          setSure(true);
        }} />
      </View>
    </View>
  ));

  const liveBlock = Platform.OS === 'web' && (recording || held) && (canHear ? (
          <View style={styles.live} accessibilityLiveRegion="polite" aria-live="polite">
            <Label small>{server === 'deepgram' ? 'Rough preview from the phone' : 'Writing down what you say'}</Label>
            {server === 'deepgram' && (
              <Text style={styles.liveNote}>Deepgram writes the debrief properly once you send it.</Text>
            )}
            <Text style={styles.liveText}>
              {heard.finals.map((f) => f.text).join(' ')}
              {heard.interim ? <Text style={styles.liveInterim}>{`${heard.finals.length ? ' ' : ''}${heard.interim}`}</Text> : null}
              {!heard.finals.length && !heard.interim
                ? <Text style={styles.liveInterim}>{held ? 'Paused. Nothing written down yet.' : 'Listening…'}</Text> : null}
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
    const keyLabel = sending ? 'Sending…' : recording ? `Stop and send  ${clock(ms)}`
      : held ? `Carry on recording  ${clock(ms)}` : 'Record debrief';
    return (
      <Page keyboardShouldPersistTaps="handled">
        <View style={styles.quick}>
          <Pressable accessibilityRole="button"
            accessibilityLabel={recording ? 'Stop and send' : held ? 'Carry on recording' : 'Record a debrief'}
            {...a11yState({ disabled: sending, busy: sending })}
            disabled={sending} onPress={recording ? stopAndSend : held ? carryOn : start}
            style={StyleSheet.flatten([styles.bigKey, (recording || sending) && styles.bigKeyOn])}>
            {recording ? <View style={styles.bigStop} /> : null}
            {sending ? <ActivityIndicator size="large" color={inkOn(theme.text)} /> : null}
            <Text style={StyleSheet.flatten([styles.bigLabel,
              { color: inkOn(recording || sending ? theme.text : theme.mark) }])}>
              {keyLabel}
            </Text>
          </Pressable>
          {controls}
          {liveBlock}
          {saved && <Text style={t.note}>{saved}</Text>}
          {status && <Text style={t.error}>{status}</Text>}
          {!active && (
            <Text style={t.note}>
              {`Goes with the run that ended just before. ${MODES.find(([k]) => k === mode)?.[1]}, ${
                LANGUAGES.find(([k]) => k === language)?.[1]}.`}
              {waiting.length ? ` ${waiting.length} recording${waiting.length > 1 ? 's' : ''} waiting for a run.` : ''}
            </Text>
          )}
          <View style={styles.quickLinks}>
            <TextLink label="Go to data" onPress={goToData} arrow disabled={active} />
            <TextLink label="More options" onPress={() => setFull(true)} disabled={active} />
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
            accessibilityLabel={recording ? 'Stop and send' : held ? 'Carry on recording' : 'Start recording'}
            {...a11yState({ disabled: off || sending, busy: sending })}
            disabled={off || sending}
            onPress={recording ? stopAndSend : held ? carryOn : start}
            style={StyleSheet.flatten([styles.button, (off || sending) && styles.dim])}>
            <View style={recording ? styles.stopIcon : styles.recIcon} />
          </Pressable>
          <View style={styles.recordWords}>
            <Fig label={recording ? 'Recording' : held ? 'Paused' : 'Length'} value={clock(ms)} size={wide ? 88 : 64} />
            <Text style={t.italic}>
              {sending ? 'Sending…' : recording ? 'Recording. Tap the square to stop and send.'
                : held ? `Paused${partsLine}. Tap the red square to carry on, or send it.`
                : 'Tap the red square to record the debrief.'}
            </Text>
            {sending && <ActivityIndicator style={styles.left} color={theme.text} />}
          </View>
        </View>
        {controls && <View style={styles.gapTop}>{controls}</View>}
        {liveBlock}
        <View style={styles.links}>
          <TextLink label="Upload a recording instead" onPress={pick} disabled={sending || active} />
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

      <Section no={waiting.length > 0 ? 4 : 3} title="Or type it"
        dek="Points written by hand, filed under the report's sections, for the run you pick.">
        <TextLink label={typing ? 'Hide typed points' : 'Type points by hand'} onPress={() => setTyping((v) => !v)} />
        {typing && (
          <View style={styles.typedRun}>
            <Tabs label="Goes with" value={typedFor} onChange={setTypedRun}
              items={offered(sessions, typedFor).map((s) => ({ key: s.id, label: runName(s) }))} />
          </View>
        )}
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
  typedRun: { marginTop: 20 },
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
  controls: { gap: 16, alignItems: 'flex-start' },
  quickLinks: { flexDirection: 'row', flexWrap: 'wrap', columnGap: 28, rowGap: 12 },
  points: { borderTopWidth: 1, borderColor: c.rule },
  point: { gap: 3, paddingVertical: 10, borderBottomWidth: 1, borderColor: c.separator },
}));
