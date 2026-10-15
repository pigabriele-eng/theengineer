// The quickest lap in each corner section and what it gained there on the fastest lap, one row per section: on the
// During tab (components/weekend/SessionCompare.tsx: the session's or one stint's, against its own fastest lap; a tap
// puts that lap on the traces, again takes it off) and on the Compare page (a tap zooms the traces to the corner). From
// lib/sessionLaps.ts bestInEachCorner and stintCorners.
import { Pressable, StyleSheet } from 'react-native';

import { LineKey } from '@/components/CompareViews';
import { useWide } from '@/components/Programme';
import { Text, View } from '@/components/Themed';
import { TAP, themed, Type, face } from '@/constants/Theme';
import { a11yState } from '@/lib/a11yState';
import { CornerBest, kindWords, LapRef, seconds } from '@/lib/sessionLaps';

export function BestInEachCorner({ rows, colorOf, onPress, action, against = 'the fastest lap' }: {
  rows: CornerBest[];
  against?: string; // the lap the gains are on: "the fastest lap", "the stint’s fastest lap"
  colorOf: (l: LapRef) => string | null; // the lap's colour on the traces, null when it isn't on them
  onPress: (b: CornerBest, ref: LapRef) => void;
  // what a tap does, in words (and whether the row is a tick): During's "Add →" / "On the traces · Remove ×" by default
  action?: (b: CornerBest, color: string | null) => { words: string; checkbox: boolean };
}) {
  const itself = `${against[0].toUpperCase()}${against.slice(1)} itself`;
  const styles = useStyles();
  const wide = useWide();
  const act = action ?? ((_: CornerBest, color: string | null) =>
    ({ words: color ? 'On the traces · Remove ×' : 'Add →', checkbox: true }));
  return (
    <View style={styles.list}>
      {rows.map((b) => {
        const ref = { session_id: b.run.id, lap: b.lap.number };
        const color = colorOf(ref);
        const { words, checkbox } = act(b, color);
        const kind = kindWords(b.lap); // an out-lap or in-lap can hold a corner's best too
        const who = `${b.run.name} · lap ${b.lap.number}${kind ? ` (${kind})` : ''} · ${b.run.driver ?? 'driver not set'}`;
        return (
          <Pressable key={b.code} onPress={() => onPress(b, ref)} accessibilityRole={checkbox ? 'checkbox' : 'button'}
            {...(checkbox ? a11yState({ checked: color != null }) : {})} style={styles.corner}
            accessibilityLabel={`${b.code}: ${b.fastest ? `${against} is the quickest here` : `${who}, ${seconds(b.gain)} on ${against}`}${checkbox ? ', on the traces' : `. ${words}`}`}>
            <Text style={styles.code}>{b.code}</Text>
            <View style={styles.grow}>
              <Text style={styles.cornerWho}>{b.fastest ? itself : who}</Text>
              {!b.fastest && <Text style={styles.gain}>{`${seconds(b.gain)} on ${against}`}</Text>}
              {/* on a phone what a tap does goes under the lap, so the lap's words keep the width */}
              {!wide && (
                <View style={StyleSheet.flatten([styles.cornerState, styles.cornerStatePhone])}>
                  {color && <LineKey color={color} />}
                  <Text style={styles.cornerGo}>{words}</Text>
                </View>
              )}
            </View>
            {wide && (
              <View style={styles.cornerState}>
                {color && <LineKey color={color} />}
                <Text style={styles.cornerGo}>{words}</Text>
              </View>
            )}
          </Pressable>
        );
      })}
    </View>
  );
}

const useStyles = themed((c) => ({
  list: { borderTopWidth: 1, borderColor: c.rule, maxWidth: 820 },
  grow: { flex: 1, minWidth: 0 },
  corner: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: TAP + 8, paddingVertical: 8,
    borderBottomWidth: 1, borderColor: c.separator },
  code: { ...Type.label, fontSize: 15, color: c.text, width: 74 },
  cornerWho: { fontFamily: face('body', 600), fontSize: 16, lineHeight: 21, color: c.text },
  gain: { ...Type.number, fontSize: 15, color: c.success, marginTop: 2 },
  cornerState: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  cornerStatePhone: { marginTop: 6 },
  cornerGo: { ...Type.link, fontSize: 13, color: c.text },
}));
