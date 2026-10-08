// The comparisons' theoretical laps, as Gabriele named them: each stint's "stint theoretical" (its quickest in each
// corner section from all its clean laps) and the stints' "combined theoretical", each with a tap to add its trace to
// the graph, dashed, or take it off (lib/theoretical.ts). Real laps stay the traces shown at first.
import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet } from 'react-native';

import { LineKey } from '@/components/CompareViews';
import { ErrorLine, Note } from '@/components/Controls';
import { useText } from '@/components/Picks';
import { Label } from '@/components/Programme';
import { Text, View } from '@/components/Themed';
import { face, TAP, themed, Type, useTheme } from '@/constants/Theme';
import { a11yState } from '@/lib/a11yState';
import { encodePicks, fetchTheoretical, formatLap } from '@/lib/compare';
import { codeOf } from '@/lib/driverTag';
import {
  COMBINED, COMBINED_KEY, DASH, fromWords, OnGraph, stintKey, STINT, TheoreticalAnswer,
} from '@/lib/theoretical';

type Laps = { session_id: number; lap: number }[];

/** The theoretical laps of these laps, asked for once `go` (after the comparison, so it never holds that up) and
 * again a moment after the picks change; a stint not packed yet is asked for again shortly. */
export function useTheoreticals(laps: Laps, go: boolean, delay = 0) {
  const key = encodePicks(laps);
  const [got, setGot] = useState<{ key: string; answer: TheoreticalAnswer } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tries, setTries] = useState(0);
  useEffect(() => {
    if (!go || laps.length < 2) return;
    let live = true;
    const id = setTimeout(() => {
      setError(null);
      fetchTheoretical(laps).then((answer) => {
        if (!live) return;
        setGot({ key, answer });
        if (answer.stints.some((s) => !s.ready) && tries < 6) setTimeout(() => live && setTries((n) => n + 1), 10000);
      }, (e) => live && setError((e as Error).message));
    }, delay);
    return () => {
      live = false;
      clearTimeout(id);
    };
  }, [key, go, tries]); // eslint-disable-line react-hooks/exhaustive-deps -- the laps, by value
  return { answer: got?.key === key ? got.answer : null, error };
}

/** The colour and dash of a theoretical lap on the graph: a stint's in its own laps' colour, the combined one in the
 * text colour; both dashed, never solid. */
export function useTheoreticalLines(colorOfSession: (id: number) => string | null) {
  const c = useTheme();
  return (g: OnGraph) => (g.sessionId == null ? { color: c.text, dash: DASH.combined }
    : { color: colorOfSession(g.sessionId) ?? c.textSecondary, dash: DASH.stint });
}

export function TheoreticalLaps({ answer, error, waiting, on, onFlip, colorOfSession }: {
  answer: TheoreticalAnswer | null;
  error: string | null;
  waiting: boolean; // the comparison is still being made
  on: string[]; // the keys on the graph
  onFlip: (key: string) => void;
  colorOfSession: (id: number) => string | null;
}) {
  const styles = useStyles();
  const t = useText();
  const c = useTheme();
  const head = <Label style={styles.label}>Theoretical laps</Label>;
  if (error) return <View style={styles.box}>{head}<ErrorLine>{`Can’t work out the theoretical laps: ${error}`}</ErrorLine></View>;
  if (!answer) {
    return (
      <View style={styles.box}>
        {head}
        {waiting ? <Note>Once the laps are on one line.</Note>
          : <View style={styles.working}><ActivityIndicator /><Note>Finding each stint’s quickest corners…</Note></View>}
      </View>
    );
  }
  const name = (run: string) => answer.stints.find((s) => s.run === run)?.session ?? 'a stint';
  const row = (key: string, title: string, who: string, time: number, words: string, from: string, color: string,
    dash: string) => {
    const shown = on.includes(key);
    return (
      <Pressable key={key} onPress={() => onFlip(key)} accessibilityRole="checkbox" {...a11yState({ checked: shown })}
        accessibilityLabel={`${title}${who ? `, ${who}` : ''}: ${formatLap(time)}, ${words}. ${shown ? 'On the graph: tap to take it off' : 'Tap to add it to the graph'}.`}
        style={styles.row}>
        <View style={styles.headLine}>
          <Text style={StyleSheet.flatten([styles.title, styles.grow])}>
            {title}{who ? <Text style={t.body}>{` · ${who}`}</Text> : null}
          </Text>
          <Text style={styles.time}>{formatLap(time)}</Text>
        </View>
        <Text style={t.body}>{words}</Text>
        <Text style={t.note}>{from}</Text>
        <View style={styles.state}>
          {shown && <LineKey color={color} dash={dash} />}
          <Text style={styles.go}>{shown ? 'On the graph · Remove ×' : 'Add to graph →'}</Text>
        </View>
      </Pressable>
    );
  };
  return (
    <View style={styles.box}>
      {head}
      <Text style={StyleSheet.flatten([t.body, styles.dek])}>
        Not real laps: each stint’s quickest time in every corner from all its clean laps, and the quickest of the stints
        together. Dashed on the graph.
      </Text>
      <View style={styles.list}>
        {answer.stints.map((s) => (s.ready
          ? row(stintKey(s.session_id), `${STINT[0].toUpperCase()}${STINT.slice(1)}`,
            `${s.session} (${codeOf(s.driver) ?? 'no driver'})`, s.time,
            `${s.gap_s.toFixed(2)} s quicker than its best lap (L${s.best_lap}, ${formatLap(s.best_time)}), from ${s.laps} ${s.laps === 1 ? 'lap' : 'laps'}`,
            fromWords(answer.sections, s.from), colorOfSession(s.session_id) ?? c.textSecondary, DASH.stint)
          : (
            <View key={stintKey(s.session_id)} style={styles.row}>
              <Text style={t.body}>{`${STINT[0].toUpperCase()}${STINT.slice(1)} · ${s.session}: not ready yet, its laps are still being prepared.`}</Text>
            </View>
          )))}
        {answer.combined ? row(COMBINED_KEY, `${COMBINED[0].toUpperCase()}${COMBINED.slice(1)}`, '', answer.combined.time,
          `${answer.combined.gap_s.toFixed(2)} s quicker than the fastest lap (L${answer.combined.best_lap} ${name(answer.combined.best_run)}, ${formatLap(answer.combined.best_time)})`,
          fromWords(answer.sections, answer.combined.from, name), c.text, DASH.combined)
          : <Text style={StyleSheet.flatten([t.note, styles.row])}>The combined theoretical needs laps from two stints.</Text>}
      </View>
    </View>
  );
}

const useStyles = themed((c) => ({
  box: { marginTop: 28, maxWidth: 820 },
  label: { color: c.text, marginBottom: 6 },
  dek: { marginBottom: 10 },
  working: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  list: { borderTopWidth: 1, borderColor: c.rule },
  row: { gap: 4, minHeight: TAP + 8, paddingVertical: 10, borderBottomWidth: 1, borderColor: c.separator },
  headLine: { flexDirection: 'row', alignItems: 'baseline', gap: 12 },
  grow: { flex: 1, minWidth: 0 },
  title: { fontFamily: face('body', 700), fontSize: 17, lineHeight: 22, color: c.text },
  time: { ...Type.number, fontFamily: face('label', 700), fontSize: 20, color: c.text },
  state: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 4, minHeight: 24 },
  go: { ...Type.link, fontSize: 13, color: c.text },
}));
