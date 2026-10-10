// Corner by corner, from the answer's `events` and `differences`: for each section (its official numbers, as the server
// gives them) every lap's brake point, turn-in, where it is at the apex, throttle point and slowest speed, the laps
// after the first with how far each point is from the first lap's; then what differs, in the server's plain words.
// A table on a wide screen; on a phone each lap is a line of words. Tapping a corner's name moves the 3D view there.
import { Pressable, StyleSheet } from 'react-native';

import { Text, View } from '@/components/Themed';
import { LapKey } from '@/components/racingline/LapKey';
import { Fonts, TAP, themed, Type } from '@/constants/Theme';
import type { CornerEvents, RacingLine } from '@/lib/racingLine';
import { LEAD_M, sideWords } from '@/lib/racingLineMath';

const metres = (v: number | null | undefined) => (v == null ? '–' : `${Math.round(v).toLocaleString('en-GB')} m`);
const versus = (v: number | null | undefined, ref: number | null | undefined) => {
  if (v == null || ref == null) return '';
  const d = Math.round(v - ref);
  return d === 0 ? ' (same)' : ` (${Math.abs(d)} m ${d < 0 ? 'earlier' : 'later'})`;
};
const kmh = (v: number | null | undefined) => (v == null ? '–' : `${Math.round(v)} km/h`);

const COLS: { key: keyof CornerEvents; name: string }[] = [
  { key: 'brake_m', name: 'Brake point' },
  { key: 'turn_in_m', name: 'Turn-in' },
  { key: 'apex_lateral', name: 'At the apex' },
  { key: 'throttle_m', name: 'Throttle' },
  { key: 'min_speed', name: 'Slowest' },
];

function cell(key: keyof CornerEvents, e: CornerEvents | undefined, ref: CornerEvents | undefined, first: boolean) {
  if (!e) return '–';
  if (key === 'apex_lateral') return sideWords(e.apex_lateral);
  if (key === 'min_speed') {
    const d = !first && e.min_speed != null && ref?.min_speed != null ? e.min_speed - ref.min_speed : null;
    return `${kmh(e.min_speed)}${d != null && Math.abs(d) >= 0.5 ? ` (${d > 0 ? '+' : '−'}${Math.abs(d).toFixed(0)})` : ''}`;
  }
  const v = e[key] as number | null;
  return `${metres(v)}${first ? '' : versus(v, ref?.[key] as number | null)}`;
}

export function CornerTable({ data, colors, wide, onSeek }: { data: RacingLine; colors: string[]; wide: boolean;
  onSeek: (m: number) => void }) {
  const styles = useStyles();
  const first = data.laps[0];
  const lapName = (key: string) => data.laps.find((l) => l.key === key)?.label ?? key;
  return (
    <View style={styles.list}>
      {data.sections.map((s) => {
        const ref = first?.events.find((e) => e.code === s.code);
        const diffs = data.differences.filter((d) => d.code === s.code);
        return (
          <View key={s.code} style={styles.corner}>
            <Pressable onPress={() => onSeek(Math.max(0, s.apex_m - LEAD_M))} accessibilityRole="button"
              accessibilityLabel={`${s.code}: show it in the 3D view`} style={styles.codeHit}>
              <Text style={styles.code}>{s.code}</Text>
              <Text style={styles.codeNote}>Show in 3D →</Text>
            </Pressable>
            {wide ? (
              <View style={styles.table}>
                <View style={styles.tr}>
                  <Text style={StyleSheet.flatten([styles.th, styles.lapCol])}>Lap</Text>
                  {COLS.map((col) => <Text key={col.key} style={StyleSheet.flatten([styles.th, styles.col])}>{col.name}</Text>)}
                </View>
                {data.laps.map((l, k) => {
                  const e = l.events.find((x) => x.code === s.code);
                  return (
                    <View key={l.key} style={styles.tr}>
                      <View style={StyleSheet.flatten([styles.lapCol, styles.lapCell])}>
                        <LapKey k={k} color={colors[k % colors.length]} width={24} />
                        <Text style={styles.td}>{l.label}</Text>
                      </View>
                      {COLS.map((col) => (
                        <Text key={col.key} style={StyleSheet.flatten([styles.td, styles.col])}>
                          {cell(col.key, e, ref, k === 0)}
                        </Text>
                      ))}
                    </View>
                  );
                })}
              </View>
            ) : (
              data.laps.map((l, k) => {
                const e = l.events.find((x) => x.code === s.code);
                return (
                  <View key={l.key} style={styles.phoneLap}>
                    <View style={styles.lapCell}>
                      <LapKey k={k} color={colors[k % colors.length]} width={24} />
                      <Text style={styles.lapName}>{l.label}</Text>
                    </View>
                    <Text style={styles.words}>
                      {COLS.map((col) => `${col.name}: ${cell(col.key, e, ref, k === 0)}`).join(' · ')}
                    </Text>
                  </View>
                );
              })
            )}
            {diffs.map((d) => (
              <Text key={d.lap} style={styles.words}>
                <Text style={styles.strong}>{`${lapName(d.lap)}: `}</Text>
                {d.words}
              </Text>
            ))}
          </View>
        );
      })}
    </View>
  );
}

const useStyles = themed((c) => ({
  list: { gap: 0 },
  corner: { borderTopWidth: 1, borderColor: c.rule, paddingVertical: 10, gap: 8 },
  codeHit: { flexDirection: 'row', alignItems: 'baseline', gap: 12, minHeight: TAP, alignSelf: 'flex-start',
    justifyContent: 'flex-start', paddingTop: 6 },
  code: { fontFamily: Fonts.display, fontSize: 26, lineHeight: 30, color: c.text },
  codeNote: { ...Type.link, fontSize: 13, color: c.text, borderBottomWidth: 2, borderColor: c.rule },
  table: { gap: 0 },
  tr: { flexDirection: 'row', borderBottomWidth: 1, borderColor: c.separator, paddingVertical: 6, gap: 8,
    alignItems: 'center' },
  th: { ...Type.label, fontSize: 13, color: c.textMuted },
  td: { ...Type.number, fontSize: 16, color: c.text },
  lapCol: { width: 150 },
  lapCell: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  col: { flex: 1, minWidth: 0 },
  phoneLap: { gap: 4 },
  lapName: { ...Type.label, fontSize: 14, color: c.text },
  words: { fontFamily: Fonts.body, fontSize: 16, lineHeight: 23, color: c.text },
  strong: { fontFamily: Fonts.label, color: c.text },
}));
