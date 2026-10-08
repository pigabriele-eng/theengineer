// The During tab comparison's session (Gabriele, 2026-10-08: "quickly select other sessions or runs to compare.
// Standard it should open the latest session but should be possible to tap the session and change it to something
// else"): a button naming the session shown ("R2 · latest"); a tap lists the event's sessions in the order they ran,
// with their laps and drivers, and one more tap shows another. Under them, "Add runs from other sessions" ticks stints
// of other sessions into the comparison, each with its session and tyres. "Back to the latest" undoes it all. Held for
// the visit only (lib/sessionPick.ts).
import { useState } from 'react';
import { Pressable, StyleSheet } from 'react-native';

import { TickBox } from '@/components/Picks';
import { Label } from '@/components/Programme';
import { Text, View } from '@/components/Themed';
import { face, TAP, themed, Type } from '@/constants/Theme';
import { a11yState } from '@/lib/a11yState';
import {
  choiceDetail, flipAdd, isLatest, otherStints, pickSession, pickWords, SessionChoice, SessionPick, shownCode,
  stintDetail,
} from '@/lib/sessionPick';

export function SessionPicker({ sessions, latest, pick, onPick, tyres }: {
  sessions: SessionChoice[];
  latest: string | null;
  pick: SessionPick;
  onPick: (pick: SessionPick) => void;
  tyres: (runId: number) => string; // a stint's tyres in words ("Used", "Fresh?")
}) {
  const styles = useStyles();
  const [open, setOpen] = useState(false);
  const [adding, setAdding] = useState(pick.add.length > 0);
  const code = shownCode(pick, latest);
  const shown = sessions.find((c) => c.code === code);
  const title = shown?.title ?? code ?? 'Latest session';
  const words = pickWords(title, code === latest, pick.add.length);
  const others = otherStints(sessions, code);
  const atLatest = isLatest(pick, latest);
  return (
    <View style={styles.box}>
      <View style={styles.bar}>
        <Label style={styles.barLabel}>Session</Label>
        <Pressable onPress={() => setOpen((o) => !o)} accessibilityRole="button" {...a11yState({ expanded: open })}
          accessibilityLabel={`Session compared: ${words}. ${open ? 'Close the list' : 'Change it'}`}
          style={StyleSheet.flatten([styles.button, open && styles.buttonOpen])}>
          <Text style={StyleSheet.flatten([styles.buttonText, open && styles.buttonTextOpen])}>{words}</Text>
          <Text style={StyleSheet.flatten([styles.caret, open && styles.buttonTextOpen])}>{open ? '▴' : '▾'}</Text>
        </Pressable>
        {!atLatest && (
          <Pressable onPress={() => { onPick({ part: null, add: [] }); setAdding(false); }} accessibilityRole="button"
            accessibilityLabel={`Back to the latest session${latest ? `, ${latest}` : ''}`} style={styles.clear}>
            <Text style={styles.clearText}>Back to the latest ×</Text>
          </Pressable>
        )}
      </View>
      {open && (
        <View style={styles.panel}>
          <View accessibilityRole="radiogroup" accessibilityLabel="Sessions of the event, in the order they ran">
            {sessions.map((c) => {
              const on = c.code === code;
              return (
                <Pressable key={c.code} onPress={() => { onPick(pickSession(c.code, latest)); setOpen(false); }}
                  accessibilityRole="radio" {...a11yState({ checked: on })}
                  accessibilityLabel={`${c.title}${c.code === latest ? ', the latest' : ''}: ${choiceDetail(c)}`}
                  style={styles.row}>
                  <View style={StyleSheet.flatten([styles.dot, on && styles.dotOn])} />
                  <Text style={styles.rowTitle}>{c.title}</Text>
                  {c.code === latest && <Text style={styles.latest}>Latest</Text>}
                  <Text style={styles.rowDetail}>{choiceDetail(c)}</Text>
                </Pressable>
              );
            })}
          </View>
          {others.length > 0 && (
            <>
              <Pressable onPress={() => setAdding((a) => !a)} accessibilityRole="button"
                {...a11yState({ expanded: adding })} style={styles.addHead}>
                <Text style={styles.addHeadText}>{`Add runs from other sessions ${adding ? '▴' : '▾'}`}</Text>
              </Pressable>
              {adding && others.map((c) => (
                <View key={c.code} style={styles.group}>
                  <Label style={styles.groupLabel}>{c.title}</Label>
                  {c.runs.map((r) => {
                    const on = pick.add.includes(r.id);
                    return (
                      <Pressable key={r.id} onPress={() => onPick(flipAdd(pick, r.id))} accessibilityRole="checkbox"
                        {...a11yState({ checked: on })}
                        accessibilityLabel={`${r.name} of ${c.title}: ${tyres(r.id).replace('?', ' (a guess)')} tyres, ${stintDetail(r)}`}
                        style={styles.row}>
                        <TickBox on={on} />
                        <Text style={styles.rowTitle}>{r.name}</Text>
                        <Text style={styles.rowDetail}>{`${tyres(r.id)} · ${stintDetail(r)}`}</Text>
                      </Pressable>
                    );
                  })}
                </View>
              ))}
              {adding && (
                <Pressable onPress={() => setOpen(false)} accessibilityRole="button" style={styles.done}>
                  <Text style={styles.addHeadText}>Done</Text>
                </Pressable>
              )}
            </>
          )}
        </View>
      )}
    </View>
  );
}

const useStyles = themed((c) => ({
  box: { maxWidth: 820, marginBottom: 18 },
  bar: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: 12, rowGap: 8 },
  barLabel: { color: c.textSecondary },
  // the session shown: a square button over a rule, inverted while its list is open
  button: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: TAP, paddingHorizontal: 14,
    borderWidth: 2, borderColor: c.text },
  buttonOpen: { backgroundColor: c.text },
  buttonText: { fontFamily: face('label', 700), fontSize: 17, letterSpacing: 0.6, color: c.text },
  buttonTextOpen: { color: c.background },
  caret: { fontSize: 14, color: c.text },
  clear: { minHeight: TAP, justifyContent: 'center', paddingHorizontal: 4 },
  clearText: { ...Type.link, fontSize: 14, color: c.text, textDecorationLine: 'underline' },

  panel: { marginTop: 10, borderTopWidth: 2, borderColor: c.rule },
  row: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: 12, rowGap: 2, minHeight: TAP,
    paddingVertical: 8, borderBottomWidth: 1, borderColor: c.separator },
  dot: { width: 18, height: 18, borderRadius: 9, borderWidth: 2, borderColor: c.text },
  dotOn: { backgroundColor: c.text },
  rowTitle: { fontFamily: face('label', 700), fontSize: 17, color: c.text },
  latest: { ...Type.label, fontSize: 13, color: c.background, backgroundColor: c.text, paddingHorizontal: 6,
    paddingVertical: 2 },
  rowDetail: { fontFamily: face('body', 400), fontSize: 16, color: c.textSecondary },
  addHead: { minHeight: TAP, justifyContent: 'center', marginTop: 8 },
  addHeadText: { ...Type.link, fontSize: 14, color: c.text, textDecorationLine: 'underline' },
  group: { marginTop: 8 },
  groupLabel: { color: c.textSecondary, marginBottom: 2 },
  done: { minHeight: TAP, minWidth: TAP, justifyContent: 'center', alignSelf: 'flex-start', marginTop: 6 },
}));
