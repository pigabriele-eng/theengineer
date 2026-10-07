// "Which session was 03_Q?" on the event page: a run the official timetable can't place by itself, asked with the
// sessions it could be as one-tap answers (lib/runNames.ts). Laid out like the season questions above it
// (SeasonMatch): a thick ink rule, the kind in capitals, the question large, the answers as ink blocks.
import { useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, ViewStyle } from 'react-native';

import { ErrorLine, FormActions, MainButton, Note, Said } from '@/components/Controls';
import { Label, TextLink, useWide } from '@/components/Programme';
import { Text, View } from '@/components/Themed';
import { RunNameQuestion, runNamesApi } from '@/lib/runNames';
import { Fonts, themed } from '@/constants/Theme';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** "Its log starts Sat 10:42": the track's time, as the server gives it. */
function startLine(starts: string | null) {
  const m = starts?.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (!m) return null;
  const day = DAYS[new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).getUTCDay()];
  return `Its log starts ${day} ${m[4]}:${m[5]}.`;
}

/** The event's run-name questions, asked again whenever the event is read again (`folder`: after a season answer the
 * timetable may be known); `onChanged` reloads the event after an answer renamed a run. */
export function RunNameQuestions({ eventId, folder, onChanged, style }: {
  eventId: number;
  folder: unknown;
  onChanged?: () => void;
  style?: ViewStyle;
}) {
  const styles = useStyles();
  const [questions, setQuestions] = useState<RunNameQuestion[] | null>(null);
  const [said, setSaid] = useState<string[]>([]);
  useEffect(() => {
    if (!folder) return;
    runNamesApi.event(eventId).then((r) => setQuestions(r.questions ?? []), () => setQuestions(null));
  }, [eventId, folder]);
  if (!questions || (!questions.length && !said.length)) return null;
  return (
    <View style={StyleSheet.flatten([styles.list, style])}>
      {said.map((text, i) => <Said key={`said-${i}`} text={text} />)}
      {questions.map((q) => (
        <Question key={q.session_id} q={q} onDone={(text, left) => {
          setSaid((s) => [...s, text]);
          setQuestions(left);
          onChanged?.();
        }} />
      ))}
    </View>
  );
}

function Question({ q, onDone }: { q: RunNameQuestion; onDone: (text: string, left: RunNameQuestion[]) => void }) {
  const styles = useStyles();
  const wide = useWide();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const name = q.name || 'this run';

  const send = async (code: string | null) => {
    setBusy(code ?? 'none');
    setError(null);
    try {
      const r = await runNamesApi.answer(q.session_id, code);
      const now = r.named?.find((n) => n.session_id === q.session_id)?.name;
      onDone(code == null ? `${name} keeps its name.` : `${name} is now ${now ?? q.options.find((o) => o.code === code)?.label ?? code}.`,
        r.questions ?? []);
    } catch (e) {
      setError((e as Error).message);
      setBusy(null);
    }
  };
  const starts = startLine(q.starts);

  return (
    <View style={styles.question}>
      <Label style={styles.kind}>Run name</Label>
      <Text style={wide ? styles.prompt : styles.promptPhone}>Which session was {name}?</Text>
      {starts ? <Note>{starts}</Note> : null}
      <FormActions style={styles.answers}>
        {q.options.map((o) => (
          <MainButton key={o.code} label={o.label} onPress={() => send(o.code)} busy={busy === o.code}
            disabled={busy != null} />
        ))}
        {busy === 'none' ? <ActivityIndicator /> : (
          <TextLink onPress={() => send(null)} disabled={busy != null} label="None of these" />
        )}
      </FormActions>
      {error && <ErrorLine>{error}</ErrorLine>}
    </View>
  );
}

const useStyles = themed((c) => ({
  list: { gap: 18 },
  question: { alignSelf: 'stretch', gap: 10, borderTopWidth: 3, borderColor: c.rule, paddingTop: 10 },
  kind: { color: c.mark },
  prompt: { fontFamily: Fonts.display, fontSize: 24, lineHeight: 28, textTransform: 'uppercase', color: c.text },
  promptPhone: { fontFamily: Fonts.display, fontSize: 19, lineHeight: 23, textTransform: 'uppercase', color: c.text },
  answers: { marginTop: 6 },
}));
