// Which season an event belongs to, asked in a line with one-tap answers (server/app/season_match.py): on the event
// page, right after an upload, and on the Sessions list (SeasonMatchCount: how many are waiting, opened in place).
// After an upload it also says what joined its season by itself, with a way to take that back. Who drove an event's
// runs is answered with one driver for them all, or on the Tag drivers screen.
import { Link, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, TextInput } from 'react-native';

import { Text, View, useThemeColor } from '@/components/Themed';
import { Pending, SeasonQuestion, seasonMatchApi } from '@/lib/seasonMatch';

type Scope = { eventId?: number; runIds?: number[] };

const LABEL: Record<SeasonQuestion['kind'], string> = { round: 'Season', official: 'Series season', drivers: 'Drivers' };
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

function usePending(scope: Scope) {
  const [pending, setPending] = useState<Pending | null>(null);
  const key = `${scope.eventId ?? ''}|${(scope.runIds ?? []).join(',')}`;
  const load = useCallback(() => {
    seasonMatchApi.pending(scope).then(setPending, () => setPending(null)); // an older server: nothing shown
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps -- the scope is its key
  useFocusEffect(load);
  return { pending, load };
}

/** The waiting questions of one event (eventId) or of an upload's events (runIds, with what joined by itself). */
export function SeasonMatch({ eventId, runIds, onChanged }: Scope & { onChanged?: () => void }) {
  const { pending, load } = usePending({ eventId, runIds });
  const [said, setSaid] = useState<Record<number, string>>({});
  if (!pending) return null;
  const answered = (id: number, text: string) => {
    setSaid((s) => ({ ...s, [id]: text }));
    load();
    onChanged?.();
  };
  return <Questions pending={pending} said={said} onAnswered={answered} linked={runIds != null} showEvent={eventId == null} />;
}

/** "2 questions about seasons" on the Sessions list, opened in place. */
export function SeasonMatchCount({ onChanged }: { onChanged?: () => void }) {
  const { pending, load } = usePending({});
  const [open, setOpen] = useState(false);
  const [said, setSaid] = useState<Record<number, string>>({});
  const tint = useThemeColor({}, 'tint');
  if (!pending || (pending.count === 0 && !Object.keys(said).length)) return null;
  const answered = (id: number, text: string) => {
    setSaid((s) => ({ ...s, [id]: text }));
    load();
    onChanged?.();
  };
  return (
    <View style={styles.count}>
      <Pressable onPress={() => setOpen((o) => !o)} accessibilityRole="button" aria-expanded={open} hitSlop={6}>
        <Text style={StyleSheet.flatten([styles.countText, { color: tint }])}>
          {open ? '▾' : '▸'} {pending.count ? `${plural(pending.count, 'question')} about seasons` : 'Seasons'}
        </Text>
      </Pressable>
      {open && <Questions pending={pending} said={said} onAnswered={answered} showEvent />}
    </View>
  );
}

function Questions({ pending, said, onAnswered, linked = false, showEvent }: {
  pending: Pending;
  said: Record<number, string>;
  onAnswered: (id: number, text: string) => void;
  linked?: boolean;
  showEvent: boolean;
}) {
  const joined = linked ? pending.linked.filter((q) => !said[q.id]) : [];
  const open = pending.questions.filter((q) => !said[q.id]);
  const lines = Object.entries(said);
  if (!joined.length && !open.length && !lines.length) return null;
  return (
    <View style={styles.list}>
      {lines.map(([id, text]) => (
        <View key={`said-${id}`} style={styles.joined}>
          <Text style={styles.summary}>{text}</Text>
        </View>
      ))}
      {joined.map((q) => <Joined key={q.id} q={q} onDone={(t) => onAnswered(q.id, t)} />)}
      {open.map((q) => <Question key={q.id} q={q} showEvent={showEvent} onDone={(t) => onAnswered(q.id, t)} />)}
    </View>
  );
}

function Question({ q, showEvent, onDone }: { q: SeasonQuestion; showEvent: boolean; onDone: (text: string) => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [number, setNumber] = useState('');
  const tint = useThemeColor({}, 'tint');
  const background = useThemeColor({}, 'background');
  const color = useThemeColor({}, 'text');
  const needsNumber = q.needs.includes('car_number');
  const single = q.options.length === 1;

  const send = async (key: string) => {
    setBusy(key);
    setError(null);
    try {
      const r = await seasonMatchApi.answer(q.id, key, number);
      onDone(r.done);
    } catch (e) {
      setError((e as Error).message);
      setBusy(null);
    }
  };
  const yes = (key: string, label: string, sub?: string | null) => {
    const off = busy != null || (needsNumber && !number.trim());
    return (
      <Pressable key={key} onPress={() => send(key)} disabled={off} accessibilityRole="button"
        style={StyleSheet.flatten([styles.yes, { borderColor: tint, backgroundColor: tint }, off && busy !== key && styles.off])}>
        {busy === key ? <ActivityIndicator color={background} /> : (
          <>
            <Text style={StyleSheet.flatten([styles.yesText, { color: background }])}>{label}</Text>
            {sub ? <Text style={StyleSheet.flatten([styles.yesSub, { color: background }])}>{sub}</Text> : null}
          </>
        )}
      </Pressable>
    );
  };
  const answers = q.kind === 'drivers' ? q.options.map((o) => yes(o.key, o.label ?? o.key))
    : single ? [yes(q.options[0].key, needsNumber ? 'Add the season' : 'Yes')]
    : q.options.map((o) => yes(o.key, o.label ?? o.key, o.why));

  return (
    <View style={styles.card}>
      <Text style={styles.label} numberOfLines={1}>
        {LABEL[q.kind]}{showEvent && q.event_name ? ` · ${q.event_name}` : ''}
      </Text>
      <Text style={styles.prompt}>{q.prompt}</Text>
      {q.why ? <Text style={styles.why}>{q.why}</Text> : null}
      {q.kind === 'drivers' && q.runs != null ? <Text style={styles.why}>{plural(q.runs, 'run')} without a driver.</Text> : null}
      {needsNumber && (
        <TextInput value={number} onChangeText={setNumber} placeholder={`Your car's number in ${q.series_name ?? 'the series'}`}
          placeholderTextColor="#8889" maxLength={8} editable={busy == null} accessibilityLabel="Car number"
          onSubmitEditing={() => number.trim() && send(q.options[0].key)} returnKeyType="done"
          style={StyleSheet.flatten([styles.input, { color }])} />
      )}
      <View style={styles.answers}>
        {answers}
        {q.kind === 'drivers' && (
          // Link asChild hands its child's style to a web anchor, which can't take a style array: one object
          <Link href={{ pathname: '/drivers/tag', params: { event: String(q.event_id) } }} asChild>
            <Pressable style={StyleSheet.flatten([styles.no, { borderColor: tint }])} accessibilityRole="link">
              <Text style={StyleSheet.flatten([styles.noText, { color: tint }])}>Tag each run ›</Text>
            </Pressable>
          </Link>
        )}
        <Pressable onPress={() => send('no')} disabled={busy != null} accessibilityRole="button"
          style={StyleSheet.flatten([styles.no, { borderColor: tint }])}>
          {busy === 'no' ? <ActivityIndicator color={tint} /> : (
            <Text style={StyleSheet.flatten([styles.noText, { color: tint }])}>
              {q.kind === 'drivers' ? 'Skip' : single ? 'No' : 'None of these'}
            </Text>
          )}
        </Pressable>
      </View>
      {error && <Text style={styles.error}>{error}</Text>}
    </View>
  );
}

/** What an upload joined by itself, and the way back. */
function Joined({ q, onDone }: { q: SeasonQuestion; onDone: (text: string) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const tint = useThemeColor({}, 'tint');
  const undo = async () => {
    setBusy(true);
    setError(null);
    try {
      onDone((await seasonMatchApi.answer(q.id, 'no')).done);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };
  return (
    <View style={styles.joined}>
      <Text style={styles.label}>Joined its season</Text>
      <Text style={styles.summary}>{q.summary ?? q.prompt}</Text>
      {q.undo && (
        <Pressable onPress={undo} disabled={busy} accessibilityRole="button" hitSlop={6} style={styles.undo}>
          {busy ? <ActivityIndicator color={tint} />
            : <Text style={StyleSheet.flatten([styles.noText, { color: tint }])}>Not this season</Text>}
        </Pressable>
      )}
      {error && <Text style={styles.error}>{error}</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  list: { gap: 10, backgroundColor: 'transparent' },
  count: { gap: 8, backgroundColor: 'transparent' },
  countText: { fontSize: 14, fontWeight: '700' },
  card: { borderWidth: 1.5, borderColor: '#8886', borderRadius: 10, padding: 12, gap: 8 },
  joined: { borderWidth: 1, borderColor: '#8884', borderRadius: 10, padding: 12, gap: 6 },
  label: { fontSize: 12, opacity: 0.6, textTransform: 'uppercase', letterSpacing: 0.5 },
  prompt: { fontSize: 17, fontWeight: '700' },
  why: { fontSize: 13, opacity: 0.7 },
  summary: { fontSize: 14, lineHeight: 20 },
  input: { borderWidth: 1, borderColor: '#8886', borderRadius: 8, paddingHorizontal: 10, paddingVertical: 8, fontSize: 16 },
  answers: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, alignItems: 'stretch', backgroundColor: 'transparent' },
  yes: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 14, paddingVertical: 9, minHeight: 44, minWidth: 72,
    justifyContent: 'center', alignItems: 'center', maxWidth: '100%', gap: 2 },
  yesText: { fontWeight: '700', fontSize: 15 },
  yesSub: { fontSize: 12, opacity: 0.85 },
  off: { opacity: 0.45 },
  no: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 14, paddingVertical: 9, minHeight: 44, minWidth: 72,
    justifyContent: 'center', alignItems: 'center' },
  noText: { fontWeight: '600', fontSize: 15 },
  undo: { alignSelf: 'flex-start', paddingVertical: 4 },
  error: { color: '#c8372d' },
});
