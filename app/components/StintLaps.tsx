// A stint's laps, shared by the Stint analysis page (app/tools/stint.tsx) and the weekend's Stint analysis tab
// (components/weekend/StintTab.tsx): the lap times against the stint's typical lap, raw and with the fuel burnt put
// back on (the tyres alone), and every lap with its tags. Tag a lap lost to a safety car, an FCY or traffic and it
// leaves the trends, the fade and the averages; count a lap the analysis leaves out (not a pit lap) and it joins them.
import { ActivityIndicator, Pressable, StyleSheet } from 'react-native';

import { useText } from '@/components/Picks';
import { TextLink } from '@/components/Programme';
import { LineChart, useChartColors } from '@/components/ReportCharts';
import { Text, View } from '@/components/Themed';
import { formatLap } from '@/lib/api';
import { a11yState } from '@/lib/a11yState';
import { KIND_LABEL, signed, Stint, StintLap, Tag, TAG_LABEL, TAG_WORDS, TAGS } from '@/lib/stint';
import { face, Fonts, inkOn, Palette, TAP, themed, Type, useTheme } from '@/constants/Theme';

/** A lap tagged (sc, fcy, traffic), looked at and counting ('none'), counted although left out ('count'), or its tag
 * cleared (null). */
export type OnTag = (s: Stint, l: StintLap, to: Tag | 'none' | 'count' | null) => void;

/** The laps in the trend against the stint's typical lap, raw and fuel-corrected, with a gap (and a label on the
 * axis) where a tagged lap or an outlier was left out. */
export function LapTimes({ stint }: { stint: Stint }) {
  const c = useChartColors();
  const laps = stint.laps.filter((l) => l.in_fit || l.tag || l.outlier);
  const fitted = laps.filter((l) => l.in_fit);
  if (fitted.length < 2) return null;
  const x = laps.map((l) => l.lap);
  const times = fitted.map((l) => l.time).sort((a, b) => a - b);
  const mid = times[Math.floor((times.length - 1) / 2)];
  const raw = laps.map((l) => (l.in_fit ? l.time - mid : null));
  const cor = laps.map((l) => (l.in_fit && l.corrected_time != null ? l.corrected_time - mid : null));
  const hasFuel = cor.some((v) => v != null);
  const markers = stint.laps.filter((l) => l.tag || l.outlier).map((l) => ({
    at: l.lap, label: `L${l.lap} ${l.tag ? TAG_LABEL[l.tag] : 'outlier'}` }));
  return (
    <LineChart x={x} height={180} unit="lap" formatX={(v) => `L${v}`} formatY={(v) => signed(v, 2)}
      title={`Lap times, s against ${formatLap(mid)} (gaps: laps left out)`}
      series={[{ key: 'raw', label: 'Lap time', values: raw, color: c.s1 },
        ...(hasFuel ? [{ key: 'cor', label: 'Fuel-corrected', values: cor, color: c.s2 }] : [])]}
      legend={[{ label: 'Lap time', color: c.s1 },
        ...(hasFuel ? [{ label: 'Fuel-corrected (the tyres alone)', color: c.s2 }] : [])]}
      markers={markers}
      readout={(i) => [{ label: laps[i].in_fit ? 'lap time' : 'left out', value: formatLap(laps[i].time), color: c.s1 },
        ...(hasFuel && laps[i].in_fit ? [{ label: 'fuel-corrected', value: formatLap(laps[i].corrected_time),
          color: c.s2 }] : [])]} />
  );
}

/** A lap's time the programme's way: the stint's fastest on purple, a lap tagged SC, FCY or traffic on the flag
 * yellow, a pit lap on ink; an out/in-lap or one left out in grey, a clean lap in ink. */
function lapTone(theme: Palette, l: StintLap, fastest: number | null): { fill?: string; ink: string } {
  if (l.tag) return { fill: theme.lap.flag, ink: inkOn(theme.lap.flag) };
  if (l.kind === 'pit') return { fill: theme.lap.pit, ink: theme.background };
  if (l.kind === 'out' || l.kind === 'in') return { ink: theme.textMuted };
  if (l.lap === fastest) return { fill: theme.timing.best, ink: theme.timing.onBest };
  return { ink: l.in_fit ? theme.text : theme.textMuted };
}

/** Every lap of the stint: its time, whether it is in the trend, and the SC, FCY and Traffic tags (a suggested one
 * dashed), with the suggestion's reason and the way to count a lap left out. */
export function LapList({ stint, onTag, tagging }: { stint: Stint; onTag: OnTag; tagging: string | null }) {
  const theme = useTheme();
  const styles = useStyles();
  const tx = useText();
  // the stint's quickest lap in the trend
  const fastest = stint.laps.filter((l) => l.in_fit && !l.tag)
    .reduce<StintLap | null>((b, l) => (b == null || l.time < b.time ? l : b), null)?.lap ?? null;
  return (
    <View>
      <Text style={StyleSheet.flatten([tx.note, styles.lapIntro])}>
        Tag a lap lost to a safety car, an FCY or traffic: it stays in the list, marked, and leaves the trends, the
        fade and the averages. Tap the tag again to clear it. A lap left out (an out-lap, in-lap, slow lap or one far
        off the trend) can be counted: it then goes into every figure like any other lap.
      </Text>
      <View style={styles.lapHead}>
        <Text style={StyleSheet.flatten([styles.th, styles.lapNoCol])}>Lap</Text>
        <Text style={StyleSheet.flatten([styles.th, styles.flex])}>Time</Text>
        <Text style={styles.th}>Tag</Text>
      </View>
      {stint.laps.map((l) => {
        const taggable = l.kind === 'flying' || l.kind === 'slow';
        const busy = tagging === `${stint.key}:${l.lap}`;
        const countable = !l.in_fit && l.kind !== 'pit';
        const trendWords = l.off_trend_s != null ? `${signed(l.off_trend_s)} s to the trend` : 'in the trend';
        const status = l.counted ? (l.kind !== 'flying' ? `${KIND_LABEL[l.kind]} · in the trend` : trendWords)
          : l.tag ? `${TAG_LABEL[l.tag]} · left out`
            : l.kind !== 'flying' ? `${KIND_LABEL[l.kind]} · left out`
              : l.outlier ? `${signed(l.off_trend_s, 1)} s off the trend · left out`
                : l.in_fit ? trendWords : 'left out';
        const tone = lapTone(theme, l, fastest);
        return (
          <View key={l.lap} style={StyleSheet.flatten([styles.lapRow, !l.in_fit && styles.lapOff])}>
            <View style={styles.lapMain}>
              <Text style={StyleSheet.flatten([styles.lapNo, !l.in_fit && styles.muted])}>{l.lap}</Text>
              <View style={styles.flex}>
                <View style={StyleSheet.flatten([styles.lapTimeBox, tone.fill ? { backgroundColor: tone.fill } : null])}>
                  <Text style={StyleSheet.flatten([styles.lapTime, { color: tone.ink }])}>{formatLap(l.time)}</Text>
                </View>
                <Text style={tx.small}>{status}</Text>
              </View>
              {busy && <ActivityIndicator size="small" color={theme.text} />}
              {taggable && (
                <View style={styles.tagRow}>
                  {TAGS.map((t) => {
                    const on = l.tag === t;
                    const suggested = !l.tag && l.suggestion?.options.includes(t);
                    return (
                      <Pressable key={t} onPress={() => onTag(stint, l, on ? null : t)} disabled={busy}
                        hitSlop={4} accessibilityRole="button" {...a11yState({ selected: on }, 'button')}
                        accessibilityLabel={on ? `Clear the ${TAG_WORDS[t]} tag on lap ${l.lap}`
                          : `Tag lap ${l.lap} ${TAG_WORDS[t]}`}
                        style={StyleSheet.flatten([styles.tagBox, suggested && styles.tagSuggested,
                          on && { backgroundColor: theme.lap.flag, borderColor: theme.lap.flag }])}>
                        <Text style={StyleSheet.flatten([styles.tagText, on && { color: inkOn(theme.lap.flag) }])}>
                          {TAG_LABEL[t]}
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>
              )}
            </View>
            {l.suggestion && !l.tag && (
              <View style={styles.suggest}>
                <Text style={tx.note}>
                  {l.suggestion.likely
                    ? `Looks like ${l.suggestion.options.map((t) => TAG_WORDS[t]).join(' or ')}: ${l.suggestion.why}.`
                    : `${l.suggestion.why.charAt(0).toUpperCase()}${l.suggestion.why.slice(1)}`}
                </Text>
                {/* a lap left out is counted with the button below; one in the trend only needs the hint dismissed */}
                {l.in_fit && <TextLink small label="No, it counts" onPress={() => onTag(stint, l, 'none')} disabled={busy} />}
              </View>
            )}
            {l.checked && l.in_fit && (
              <View style={styles.suggest}>
                <Text style={tx.note}>You checked this lap: it counts.</Text>
                <TextLink small label="Undo" onPress={() => onTag(stint, l, null)} disabled={busy} />
              </View>
            )}
            {l.counted && (
              <View style={styles.suggest}>
                <Text style={tx.label}>✓ Counted by you</Text>
                <TextLink small label="Undo" onPress={() => onTag(stint, l, null)} disabled={busy} />
              </View>
            )}
            {countable && (
              <View style={styles.suggest}>
                <TextLink small red label="Count this lap" onPress={() => onTag(stint, l, 'count')} disabled={busy} />
              </View>
            )}
            {l.kind === 'pit' && (
              <View style={styles.suggest}>
                <Text style={tx.small}>Can&apos;t be counted: the time standing in the pits swamps the lap.</Text>
              </View>
            )}
          </View>
        );
      })}
    </View>
  );
}

const useStyles = themed((c) => ({
  flex: { flex: 1, minWidth: 0, backgroundColor: 'transparent' },
  muted: { color: c.textMuted },
  th: { ...Type.label, fontSize: 11, color: c.text },
  lapIntro: { maxWidth: 760, marginBottom: 12 },
  lapHead: { flexDirection: 'row', alignItems: 'flex-end', gap: 10, borderBottomWidth: 1, borderColor: c.rule,
    paddingBottom: 5 },
  lapNoCol: { width: 36 },
  lapRow: { borderBottomWidth: 1, borderColor: c.separator, paddingVertical: 8, gap: 6 },
  lapOff: { backgroundColor: c.band },
  lapMain: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  lapNo: { width: 36, fontFamily: Fonts.display, fontSize: 22, lineHeight: 26, color: c.text },
  lapTimeBox: { alignSelf: 'flex-start', paddingHorizontal: 4, paddingVertical: 1 },
  lapTime: { ...Type.number, fontFamily: face('label', 700), fontSize: 16 },
  tagRow: { flexDirection: 'row', gap: 6 },
  // a full tap target
  tagBox: { borderWidth: 1, borderColor: c.rule, paddingHorizontal: 9, paddingVertical: 7, minWidth: TAP,
    minHeight: TAP, alignItems: 'center', justifyContent: 'center' },
  tagSuggested: { borderColor: c.mark, borderStyle: 'dashed', borderWidth: 2 },
  tagText: { ...Type.label, fontSize: 12, color: c.text },
  suggest: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: 14, rowGap: 6, marginLeft: 46 },
}));
