// Which season an event belongs to, asked in a line with one-tap answers (server/app/season_match.py): on the event
// page, right after an upload, and on the Sessions list (SeasonMatchCount: how many are waiting, opened in place).
// After an upload it also says what joined its season by itself, with a way to take that back. Who drove an event's
// runs is answered with one driver for them all, or on the Tag drivers screen. In the programme's way: each question
// under a thick ink rule, its kind in Archivo capitals, the question itself large, the answers as ink blocks and the
// way out as a text link.
import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { ActivityIndicator, StyleSheet, ViewStyle } from 'react-native';

import { ErrorLine, Field, FormActions, Input, MainButton, Note, Said } from '@/components/Controls';
import { Label, TextLink, useWide } from '@/components/Programme';
import { Text, View } from '@/components/Themed';
import { Pending, SeasonQuestion, seasonMatchApi } from '@/lib/seasonMatch';
import { Fonts, themed } from '@/constants/Theme';

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

/** The waiting questions of one event (eventId) or of an upload's events (runIds, with what joined by itself).
 * `style`: the space around them, only there when there is something to ask. */
export function SeasonMatch({ eventId, runIds, onChanged, style }: Scope & { onChanged?: () => void; style?: ViewStyle }) {
  const { pending, load } = usePending({ eventId, runIds });
  const [said, setSaid] = useState<Record<number, string>>({});
  if (!pending) return null;
  const answered = (id: number, text: string) => {
    setSaid((s) => ({ ...s, [id]: text }));
    load();
    onChanged?.();
  };
  return <Questions pending={pending} said={said} onAnswered={answered} linked={runIds != null} showEvent={eventId == null}
    style={style} />;
}

/** "2 questions about seasons" on the Sessions list, opened in place. */
export function SeasonMatchCount({ onChanged }: { onChanged?: () => void }) {
  const styles = useStyles();
  const { pending, load } = usePending({});
  const [open, setOpen] = useState(false);
  const [said, setSaid] = useState<Record<number, string>>({});
  if (!pending || (pending.count === 0 && !Object.keys(said).length)) return null;
  const answered = (id: number, text: string) => {
    setSaid((s) => ({ ...s, [id]: text }));
    load();
    onChanged?.();
  };
  return (
    <View style={styles.count}>
      <TextLink red onPress={() => setOpen((o) => !o)}
        label={`${open ? '−' : '+'} ${pending.count ? `${plural(pending.count, 'question')} about seasons` : 'Seasons'}`} />
      {open && <Questions pending={pending} said={said} onAnswered={answered} showEvent />}
    </View>
  );
}

function Questions({ pending, said, onAnswered, linked = false, showEvent, style }: {
  pending: Pending;
  said: Record<number, string>;
  onAnswered: (id: number, text: string) => void;
  linked?: boolean;
  showEvent: boolean;
  style?: ViewStyle;
}) {
  const styles = useStyles();
  const joined = linked ? pending.linked.filter((q) => !said[q.id]) : [];
  const open = pending.questions.filter((q) => !said[q.id]);
  const lines = Object.entries(said);
  if (!joined.length && !open.length && !lines.length) return null;
  return (
    <View style={StyleSheet.flatten([styles.list, style])}>
      {lines.map(([id, text]) => <Said key={`said-${id}`} text={text} />)}
      {joined.map((q) => <Joined key={q.id} q={q} onDone={(t) => onAnswered(q.id, t)} />)}
      {open.map((q) => <Question key={q.id} q={q} showEvent={showEvent} onDone={(t) => onAnswered(q.id, t)} />)}
    </View>
  );
}

function Question({ q, showEvent, onDone }: { q: SeasonQuestion; showEvent: boolean; onDone: (text: string) => void }) {
  const styles = useStyles();
  const wide = useWide();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [number, setNumber] = useState('');
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
  const yes = (key: string, label: string, sub?: string | null) => (
    <MainButton key={key} label={label} sub={sub} onPress={() => send(key)} busy={busy === key}
      disabled={busy != null || (needsNumber && !number.trim())} />
  );
  const answers = q.kind === 'drivers' ? q.options.map((o) => yes(o.key, o.label ?? o.key))
    : single ? [yes(q.options[0].key, needsNumber ? 'Add the season' : 'Yes')]
    : q.options.map((o) => yes(o.key, o.label ?? o.key, o.why));

  return (
    <View style={styles.question}>
      <Label style={styles.kind}>{LABEL[q.kind]}{showEvent && q.event_name ? ` · ${q.event_name}` : ''}</Label>
      <Text style={wide ? styles.prompt : styles.promptPhone}>{q.prompt}</Text>
      {q.why ? <Note>{q.why}</Note> : null}
      {q.kind === 'drivers' && q.runs != null ? <Note>{plural(q.runs, 'run')} without a driver.</Note> : null}
      {needsNumber && (
        <Field label="Car number" style={styles.number}>
          <Input value={number} onChangeText={setNumber} placeholder={`Your car's number in ${q.series_name ?? 'the series'}`}
            maxLength={8} editable={busy == null} accessibilityLabel="Car number" box
            onSubmitEditing={() => number.trim() && send(q.options[0].key)} returnKeyType="done" />
        </Field>
      )}
      <FormActions style={styles.answers}>
        {answers}
        {q.kind === 'drivers' && (
          <TextLink href={{ pathname: '/drivers/tag', params: { event: String(q.event_id) } }} label="Tag each run" arrow />
        )}
        {busy === 'no' ? <ActivityIndicator /> : (
          <TextLink onPress={() => send('no')} disabled={busy != null}
            label={q.kind === 'drivers' ? 'Skip' : single ? 'No' : 'None of these'} />
        )}
      </FormActions>
      {error && <ErrorLine>{error}</ErrorLine>}
    </View>
  );
}

/** What an upload joined by itself, and the way back. */
function Joined({ q, onDone }: { q: SeasonQuestion; onDone: (text: string) => void }) {
  const styles = useStyles();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
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
      <Label style={styles.kind}>Joined its season</Label>
      <Text style={styles.summary}>{q.summary ?? q.prompt}</Text>
      {q.undo && (busy ? <ActivityIndicator style={styles.spinner} />
        : <TextLink label="Not this season" onPress={undo} small />)}
      {error && <ErrorLine>{error}</ErrorLine>}
    </View>
  );
}

const useStyles = themed((c) => ({
  list: { gap: 18 },
  count: { gap: 14, marginTop: 18, alignItems: 'flex-start' },
  question: { alignSelf: 'stretch', gap: 10, borderTopWidth: 3, borderColor: c.rule, paddingTop: 10 },
  joined: { alignSelf: 'stretch', gap: 8, borderTopWidth: 1, borderColor: c.rule, paddingTop: 10, alignItems: 'flex-start' },
  kind: { color: c.mark },
  prompt: { fontFamily: Fonts.display, fontSize: 24, lineHeight: 28, textTransform: 'uppercase', color: c.text },
  promptPhone: { fontFamily: Fonts.display, fontSize: 19, lineHeight: 23, textTransform: 'uppercase', color: c.text },
  summary: { fontFamily: Fonts.body, fontSize: 17, lineHeight: 24, color: c.text },
  number: { maxWidth: 360 },
  answers: { marginTop: 6 },
  spinner: { alignSelf: 'flex-start' },
}));
