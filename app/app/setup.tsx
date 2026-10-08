import { Stack, useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, TextInput } from 'react-native';

import { Choice, Choices, Input, MainButton } from '@/components/Controls';
import { PageHead, useText } from '@/components/Picks';
import { Colophon, Page, TextLink, useWide } from '@/components/Programme';
import { Text, View } from '@/components/Themed';
import { eventsApi, FolderSummary } from '@/lib/events';
import { setupApi, Sheet } from '@/lib/setup';
import { Change, ChatAction, ChatMessage, setupChatApi, SetupChat } from '@/lib/setupChat';
import { face, Fonts, TAP, themed, Type, useTheme } from '@/constants/Theme';

const SHOWN_EVENTS = 8;
const RECENT = 4; // messages shown before "Show the earlier ..."

// The setup tool (Gabriele, 2026-10-08): on its own, away from the reports. Say what the car does, or let it read a
// run's debrief and data; it proposes one change at a time, and every answer ("already on the softest spring",
// "tried it, no better") moves it to the next change for the same problem. It remembers each event's limits.
export default function SetupToolScreen() {
  const t = useText();
  const styles = useStyles();
  const c = useTheme();
  const wide = useWide();
  const [events, setEvents] = useState<FolderSummary[] | null>(null);
  const [allEvents, setAllEvents] = useState(false);
  const [eventId, setEventId] = useState<number | null | undefined>(undefined);
  const [chat, setChat] = useState<SetupChat | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [showAll, setShowAll] = useState(false);
  const input = useRef<TextInput>(null);
  const scroll = useRef<ScrollView>(null);

  useEffect(() => {
    eventsApi.folders().then(
      (f) => {
        const real = f.filter((e) => e.id != null);
        setEvents(real);
        setEventId((id) => (id === undefined ? (real[0]?.id ?? null) : id));
      },
      (e) => setError((e as Error).message),
    );
  }, []);

  useEffect(() => {
    if (eventId === undefined) return;
    let live = true;
    setChat(null);
    setupChatApi.get(eventId).then(
      (r) => live && setChat(r),
      (e) => live && setError((e as Error).message),
    );
    return () => {
      live = false;
    };
  }, [eventId]);

  const send = useCallback(
    (body: { text?: string; action?: ChatAction; said?: string; variant?: string; session_id?: number | null;
      set_session?: boolean }) => {
      if (eventId === undefined) return;
      setBusy(true);
      setError(null);
      setupChatApi.send({ event_id: eventId, ...body }).then(
        (r) => {
          setChat(r);
          setBusy(false);
          if (body.text) setText('');
        },
        (e) => {
          setError((e as Error).message);
          setBusy(false);
        },
      );
    },
    [eventId],
  );

  const submit = () => {
    const said = text.trim();
    if (said) send({ text: said });
  };

  const shown = events ? (allEvents ? events : events.slice(0, SHOWN_EVENTS)) : [];

  return (
    <Page scrollRef={scroll} keyboardShouldPersistTaps="handled">
      <Stack.Screen options={{ title: 'Setup' }} />
      <PageHead title="Setup"
        dek="Tell it what the car is doing. It proposes one change at a time, with why and what to expect. Answer with a tap or in your own words, like “already on the softest spring”, and it offers the next thing to try." />

      <View style={styles.block}>
        <Text style={t.sub}>Event</Text>
        {events == null && !error && <ActivityIndicator color={c.text} style={styles.spin} />}
        {events != null && events.length === 0 && <Text style={t.note}>No events yet. Upload a run first.</Text>}
        <Choices>
          {shown.map((e) => (
            <Choice key={e.key} label={e.name} sub={e.track} on={e.id === eventId} onPress={() => setEventId(e.id)} />
          ))}
          {events != null && events.length > SHOWN_EVENTS && (
            <Choice add label={allEvents ? 'Fewer' : `All ${events.length} events`} on={false}
              onPress={() => setAllEvents((v) => !v)} />
          )}
        </Choices>
      </View>

      {chat && (
        <View style={wide ? styles.columns : undefined}>
          <View style={wide ? styles.main : undefined}>
            <View style={styles.block} accessibilityLiveRegion="polite">
              <Text style={t.sub}>Conversation</Text>
              {chat.messages.length === 0 && (
                <Text style={t.body}>What is the car doing? Pick one below or type it, for example “understeer mid-corner in T6”.</Text>
              )}
              {!showAll && chat.messages.length > RECENT && (
                <TextLink small label={chat.messages.length - RECENT === 1 ? 'Show the earlier message'
                  : `Show the earlier ${chat.messages.length - RECENT} messages`}
                  onPress={() => setShowAll(true)} />
              )}
              {(showAll ? chat.messages : chat.messages.slice(-RECENT)).map((m, i, shown) => (
                // only the latest proposal is drawn in full; earlier ones keep their line
                <Message key={`${m.at}-${i}`} m={m}
                  full={!!chat.current && i === shown.length - 1 - [...shown].reverse().findIndex((x) => !!x.change)} />
              ))}
              {chat.notes.map((n) => <Text key={n} style={t.body}>{n}</Text>)}
            </View>

            <View style={styles.block}>
              <View style={styles.replies}>
                {chat.quick_replies.map((q) => (
                  <Pressable key={q.label} accessibilityRole="button" disabled={busy}
                    onPress={() => send({ action: q.action, said: q.label })}
                    style={({ pressed }) => StyleSheet.flatten([styles.reply, pressed && styles.replyPressed,
                      busy && styles.dim])}>
                    <Text style={styles.replyText}>{q.label}</Text>
                  </Pressable>
                ))}
              </View>
              <Input ref={input} box value={text} onChangeText={setText} onSubmitEditing={submit}
                placeholder="Or type: “we're already at minimum ride height”" returnKeyType="send"
                accessibilityLabel="Your answer to the setup tool" editable={!busy} />
              <View style={styles.sendRow}>
                <MainButton label="Send" onPress={submit} busy={busy} disabled={!text.trim()} />
                {chat.messages.length > 0 && (
                  <TextLink small label="Start again" onPress={() => send({ action: { type: 'reset' }, said: 'Start again' })} />
                )}
              </View>
              {error && <Text style={t.error}>{error}</Text>}
            </View>
          </View>

          <View style={wide ? styles.side : undefined}>
            {chat.problem_labels.length > 0 && (
              <View style={styles.block}>
                <Text style={t.sub}>Working on</Text>
                {chat.problem_labels.map((p) => <Text key={p.label} style={t.body}>{p.label}</Text>)}
              </View>
            )}
            {chat.pending_titles.length > 0 && (
              <View style={styles.block}>
                <Text style={t.sub}>Trying on the next run</Text>
                <Text style={t.body}>
                  {chat.pending_titles.join('; ')}. Logged on its setup sheet by itself when its logs come in, then
                  you're told what it did.
                </Text>
              </View>
            )}
            {chat.limit_labels.length > 0 && (
              <View style={styles.block}>
                <Text style={t.sub}>Can't go further at this event</Text>
                {chat.limit_labels.map((l) => (
                  <View key={`${l.row}-${l.axle}-${l.want}`} style={styles.limitRow}>
                    <Text style={StyleSheet.flatten([t.body, styles.flex])}>{l.label}</Text>
                    <Pressable accessibilityRole="button" accessibilityLabel={`Clear: ${l.label}`} disabled={busy}
                      onPress={() => send({ action: { type: 'forget_limit', limit: { row: l.row, axle: l.axle, want: l.want } } })}
                      style={styles.clear}>
                      <Text style={styles.clearText}>Clear</Text>
                    </Pressable>
                  </View>
                ))}
              </View>
            )}

            <View style={styles.block}>
              <Text style={t.sub}>Car</Text>
              <Choices>
                {chat.variants.map((v) => (
                  <Choice key={v.key} label={v.label} on={v.key === chat.variant}
                    onPress={() => send({ variant: v.key })} />
                ))}
              </Choices>
            </View>

            <View style={styles.block}>
              <Text style={t.sub}>Run it reads</Text>
              <Text style={t.body}>
                Its debrief, logger data and setup sheet go into each proposal. Pick none to go on what you tell it.
              </Text>
              <Choices>
                {chat.runs.map((r) => (
                  <Choice key={r.id} label={r.name} on={r.id === chat.session_id}
                    sub={[r.debrief && 'debrief', r.data && 'data'].filter(Boolean).join(' · ') || 'no data'}
                    onPress={() => send({ session_id: r.id, set_session: true })} />
                ))}
                <Choice label="None" on={chat.session_id == null}
                  onPress={() => send({ session_id: null, set_session: true })} />
              </Choices>
              {chat.session_id != null && <RunLog key={chat.session_id} sessionId={chat.session_id} />}
            </View>
          </View>
        </View>
      )}
      {!chat && error && <Text style={StyleSheet.flatten([t.error, styles.gapTop])}>{error}</Text>}
      {!chat && !error && eventId !== undefined && <ActivityIndicator color={c.text} style={styles.spin} />}

      <Colophon left="The Engineer · Setup"
        right="Rules from the car's adjustments. Spring and bar rates are estimates until BMW's are known." />
    </Page>
  );
}

// The run's setup log: a baseline once, then each run copies the last and changes what changed, so the tool can
// learn what each change did. Quick from a phone: one tap copies the last run's setup.
function RunLog({ sessionId }: { sessionId: number }) {
  const t = useText();
  const styles = useStyles();
  const [sheet, setSheet] = useState<Sheet | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useFocusEffect(
    useCallback(() => {
      let live = true;
      setupApi.sheet(sessionId).then((r) => live && setSheet(r), (e) => live && setError((e as Error).message));
      return () => {
        live = false;
      };
    }, [sessionId]),
  );
  const copy = () => {
    setBusy(true);
    setupApi.copyPrevious(sessionId).then(
      (r) => {
        setSheet(r);
        setBusy(false);
      },
      (e) => {
        setError((e as Error).message);
        setBusy(false);
      },
    );
  };
  const href = { pathname: '/tools/setup', params: { session: sessionId, tab: 'sheet' } } as const;
  if (!sheet) return error ? <Text style={t.error}>{error}</Text> : null;
  return (
    <View style={styles.log}>
      <Text style={t.sub}>This run's setup</Text>
      {!sheet.exists && (
        <Text style={t.body}>
          {sheet.previous
            ? `Not logged yet. If only a few things changed since ${sheet.previous.name ?? 'the last run'}, copy it and change those.`
            : 'Not logged yet. Log the setup once as a baseline; after that each run copies the last.'}
        </Text>
      )}
      {sheet.exists && sheet.notes ? <Text style={t.body}>{sheet.notes}</Text> : null}
      {sheet.exists && (
        <Text style={t.body}>
          {sheet.changes.length > 0
            ? `Logged. Changed from ${sheet.previous?.name ?? 'the last run'}: ${sheet.changes.map((c) => c.text).join('; ')}.`
            : sheet.previous ? `Logged, the same as ${sheet.previous.name ?? 'the last run'}.` : 'Logged.'}
        </Text>
      )}
      <View style={styles.sendRow}>
        {!sheet.exists && sheet.previous && (
          <MainButton label={`Same as ${sheet.previous.name ?? 'last run'}`} onPress={copy} busy={busy} />
        )}
        <TextLink small arrow label={sheet.exists ? 'Change the sheet' : sheet.previous ? 'Log what changed' : 'Log the setup'}
          href={href} />
      </View>
      {error && <Text style={t.error}>{error}</Text>}
    </View>
  );
}

function Message({ m, full }: { m: ChatMessage; full: boolean }) {
  const t = useText();
  const styles = useStyles();
  const you = m.from === 'you';
  return (
    <View style={you ? styles.you : styles.tool}>
      <Text style={styles.who}>{you ? 'You' : 'Setup'}</Text>
      <Text style={t.body}>{m.text}</Text>
      {m.change && full && <ChangeCard ch={m.change} />}
    </View>
  );
}

function ChangeCard({ ch }: { ch: Change }) {
  const t = useText();
  const styles = useStyles();
  const wide = useWide();
  return (
    <View style={StyleSheet.flatten([styles.card, !wide && styles.cardPhone])}>
      <Text style={styles.cardTitle}>{ch.title}</Text>
      {ch.changes.map((x) => <Text key={x} style={styles.cardChange}>{x}</Text>)}
      {ch.why ? <Line label="Why" text={ch.why} /> : null}
      {ch.expected ? <Line label="Expect" text={ch.expected} /> : null}
      {ch.watch ? <Line label="Watch" text={ch.watch} /> : null}
      {ch.history ? <Line label="Your log" text={ch.history.text} /> : null}
      {ch.car ? <Line label="On this car" text={ch.car} /> : null}
      {!ch.why && !ch.expected && <Text style={t.note}>No reason given.</Text>}
    </View>
  );
}

function Line({ label, text }: { label: string; text: string }) {
  const t = useText();
  return (
    <Text style={t.body}>
      <Text style={t.strong}>{label}: </Text>
      {text}
    </Text>
  );
}

const useStyles = themed((c) => ({
  block: { marginTop: 26, gap: 10, maxWidth: 760 },
  columns: { flexDirection: 'row', alignItems: 'flex-start', gap: 48 },
  main: { flex: 3, minWidth: 0 },
  side: { flex: 2, minWidth: 0 },
  gapTop: { marginTop: 14 },
  spin: { marginTop: 16, alignSelf: 'flex-start' },
  flex: { flex: 1, minWidth: 0 },
  limitRow: { flexDirection: 'row', alignItems: 'center', gap: 12, borderBottomWidth: 1, borderColor: c.rule },
  clear: { minHeight: TAP, minWidth: TAP, justifyContent: 'center', alignItems: 'flex-end' },
  clearText: { ...Type.link, fontSize: 15, color: c.text, textDecorationLine: 'underline' },
  you: { alignSelf: 'flex-end', maxWidth: '90%', borderRightWidth: 3, borderColor: c.borderStrong, paddingRight: 12,
    paddingVertical: 4, gap: 2 },
  tool: { alignSelf: 'flex-start', maxWidth: '100%', borderLeftWidth: 3, borderColor: c.mark, paddingLeft: 12,
    paddingVertical: 4, gap: 6 },
  who: { ...Type.label, fontSize: 13, color: c.textMuted },
  card: { borderTopWidth: 2, borderBottomWidth: 1, borderColor: c.borderStrong, paddingVertical: 12, gap: 6 },
  cardPhone: { paddingVertical: 10 },
  cardTitle: { fontFamily: Fonts.display, fontSize: 22, lineHeight: 26, textTransform: 'uppercase', color: c.text },
  cardChange: { fontFamily: face('label', 600), fontSize: 17, lineHeight: 23, color: c.text },
  replies: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  reply: { minHeight: TAP, justifyContent: 'center', paddingHorizontal: 14, borderWidth: 2, borderColor: c.borderStrong,
    backgroundColor: c.background },
  replyPressed: { backgroundColor: c.rule },
  replyText: { ...Type.label, fontSize: 15, color: c.text },
  dim: { opacity: 0.45 },
  log: { marginTop: 8, gap: 10 },
  sendRow: { flexDirection: 'row', alignItems: 'center', gap: 20, flexWrap: 'wrap' },
}));
