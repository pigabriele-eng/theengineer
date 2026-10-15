// The theoretical laps of the laps compared, as a map of the corners (Gabriele, 2026-10-15, Driving performance: "the
// theoretical stint and combined theoretical and an easy to identify way to know which corner belongs to which lap of
// which driver", and "technique suggestions or line suggestions in natural text based on the driven theoretical
// best"): each stint theoretical and the combined theoretical with its time, its gap to the real lap it is told from
// and the laps it is made of; then one row per corner with the lap holding it in each, its driver in a colour key and
// in words, and what it gains there; then, corner by corner, what that lap does differently, in words. From POST
// /compare/theoretical (lib/theoretical.ts, lib/theoreticalMap.ts). A tap on a corner hands its real laps to
// `onCorner`, to show them on the 3D racing line.
import { useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet } from 'react-native';

import { ErrorLine, Note } from '@/components/Controls';
import { Tabs, useText } from '@/components/Picks';
import { Block, Label, useWide } from '@/components/Programme';
import { Text, View } from '@/components/Themed';
import { useTheoreticals } from '@/components/TheoreticalLaps';
import { face, inkOn, legibleFill, TAP, themed, Type, useTheme } from '@/constants/Theme';
import { a11yState } from '@/lib/a11yState';
import { formatLap } from '@/lib/compare';
import { driverCode } from '@/lib/driverTag';
import type { SessionRun } from '@/lib/sessionLaps';
import { COMBINED, type TheoreticalAnswer, type Tip } from '@/lib/theoretical';
import {
  cornerRows, CornerRow, DriverKey, driverKeys, Holder, keyOf, LapRef, lapsUsed, Stint, stintsOf, stintTitle,
  tipsOf, tipWords,
} from '@/lib/theoreticalMap';

// the drivers' colours: chart slots the laps on the traces take last (purple, amber, pink, blue), so a driver's key is
// seldom taken for a lap's line
const DRIVER_SLOTS = [6, 3, 4, 0, 2, 5];
const Combined = `${COMBINED[0].toUpperCase()}${COMBINED.slice(1)}`;
const cap = (s: string) => `${s[0].toUpperCase()}${s.slice(1)}`;
// a gain under a hundredth keeps its thousandths: "−0.00 s" would read as no gain
const minus = (v: number) => `−${v.toFixed(v > 0 && v < 0.01 ? 3 : 2)} s`;

/** The colour of each driver (lib/theoreticalMap.ts keyOf), always shown with the driver's code. */
function useDriverColors(stints: Stint[]) {
  const c = useTheme();
  return useMemo(() => {
    const keys = driverKeys(stints);
    const series = c.chart.series;
    const fill = new Map(keys.map((k, i) => [k.key, legibleFill(series[DRIVER_SLOTS[i % DRIVER_SLOTS.length]])]));
    return { keys, fill: (s: Stint) => fill.get(keyOf(s).key) ?? c.textMuted };
  }, [stints, c]);
}

export function TheoreticalMap({ laps, runs, onCorner, given }: {
  laps: LapRef[]; // the laps compared: each stint's fastest by default
  runs: SessionRun[]; // the session's stints, for their names and drivers
  onCorner?: (code: string, laps: LapRef[]) => void; // a corner tapped, with the real laps it involves
  // the answer for these laps when the page has asked for it already (useTheoreticals): not asked for again
  given?: { answer: TheoreticalAnswer | null; error: string | null };
}) {
  const styles = useStyles();
  const t = useText();
  const own = useTheoreticals(laps, given == null && laps.length >= 2);
  const theo = given ?? own;
  const answer = theo.answer;
  if (laps.length < 2) return <Note>Pick at least two laps, one from each stint, for the theoretical laps.</Note>;
  if (theo.error) return <ErrorLine>{`Can’t work out the theoretical laps: ${theo.error}`}</ErrorLine>;
  if (!answer) {
    return (
      <View style={styles.working} accessibilityLiveRegion="polite">
        <ActivityIndicator />
        <Text style={t.body}>Finding each stint’s quickest corners…</Text>
      </View>
    );
  }
  return <Ready answer={answer} runs={runs} onCorner={onCorner} />;
}

function Ready({ answer, runs, onCorner }: { answer: TheoreticalAnswer; runs: SessionRun[];
  onCorner?: (code: string, laps: LapRef[]) => void }) {
  const styles = useStyles();
  const t = useText();
  const stints = useMemo(() => stintsOf(answer, runs, driverCode), [answer, runs]);
  const colors = useDriverColors(stints);
  const rows = useMemo(() => cornerRows(answer, stints), [answer, stints]);
  const [picked, setPicked] = useState<string | null>(null);
  const tap = onCorner ? (key: string, code: string, laps: LapRef[]) => {
    setPicked(key);
    onCorner(code, laps);
  } : undefined;
  const unset = stints.filter((s) => !s.code).length;
  return (
    <View style={styles.box}>
      <Label style={styles.label}>Theoretical laps</Label>
      <Text style={StyleSheet.flatten([t.body, styles.dek])}>
        Not real laps: each stint’s quickest time in every corner from all its clean laps, and the quickest of the
        stints together.
      </Text>
      <Summaries answer={answer} stints={stints} fill={colors.fill} />

      <Label style={StyleSheet.flatten([styles.label, styles.gapTop])}>Which lap holds each corner</Label>
      <Text style={StyleSheet.flatten([t.body, styles.dek])}>
        {`Each corner’s lap in each theoretical, its driver and what it gains there on the stint’s fastest lap (on the fastest lap for the ${COMBINED}).${onCorner ? ' Tap a corner to see its laps on the 3D racing line.' : ''}`}
      </Text>
      <View style={styles.legend}>
        <Text style={t.note}>Drivers:</Text>
        {colors.keys.map((k: DriverKey) => (
          <DriverBlock key={k.key} label={k.label} fill={colors.fill(stints.find((s) => keyOf(s).key === k.key)!)} />
        ))}
      </View>
      {unset > 0 && (
        <Note style={styles.noteGap}>
          {`Set the ${unset === 1 ? 'stint’s driver on its run row' : 'stints’ drivers on their run rows'} to see who drove each lap.`}
        </Note>
      )}
      <CornerMap rows={rows} stints={stints} answer={answer} fill={colors.fill} picked={picked} onTap={tap} />

      <Tips answer={answer} stints={stints} fill={colors.fill} picked={picked} onTap={tap} />
    </View>
  );
}

/** A driver's key: a flat block of the driver's colour with the code on it. */
function DriverBlock({ label, fill }: { label: string; fill: string }) {
  return <Block label={label} color={fill} ink={inkOn(fill)} size={13} />;
}

/** Each stint theoretical and the combined theoretical: its time, its gap to the real lap it is told from and how many
 * laps it is made of. */
function Summaries({ answer, stints, fill }: { answer: TheoreticalAnswer; stints: Stint[]; fill: (s: Stint) => string }) {
  const styles = useStyles();
  const t = useText();
  const wide = useWide();
  const of = (run: string) => stints.find((s) => s.run === run);
  const items = answer.stints.map((s, i) => {
    const st = stints[i];
    if (!s.ready) {
      return (
        <View key={s.run} style={wide ? styles.sumWide : styles.sum}>
          <Label style={styles.sumTitle}>{stintTitle(st)}</Label>
          <Text style={t.body}>Not ready yet: its laps are still being prepared.</Text>
        </View>
      );
    }
    return (
      <View key={s.run} style={wide ? styles.sumWide : styles.sum}>
        <View style={styles.sumHead}>
          <DriverBlock label={keyOfLabel(st)} fill={fill(st)} />
          <Label style={StyleSheet.flatten([styles.sumTitle, styles.grow])}>{stintTitle(st)}</Label>
        </View>
        <Text style={styles.sumTime}>{formatLap(s.time)}</Text>
        <Text style={t.body}>{`${s.gap_s.toFixed(2)} s quicker than lap ${s.best_lap}, the stint’s fastest (${formatLap(s.best_time)})`}</Text>
        <Text style={t.note}>{`Made of ${lapsUsed(s)} of its ${s.laps} clean ${s.laps === 1 ? 'lap' : 'laps'}`}</Text>
      </View>
    );
  });
  const c = answer.combined;
  const best = c ? of(c.best_run) : undefined;
  return (
    <View style={wide ? styles.sums : null}>
      {items}
      <View style={wide ? styles.sumWide : styles.sum}>
        <Label style={styles.sumTitle}>{COMBINED}</Label>
        {c ? (
          <>
            <Text style={styles.sumTime}>{formatLap(c.time)}</Text>
            <Text style={t.body}>
              {`${c.gap_s.toFixed(2)} s quicker than the fastest lap, lap ${c.best_lap} of ${best?.name ?? 'a stint'}${best?.code ? ` (${best.code})` : ''}, ${formatLap(c.best_time)}`}
            </Text>
            <Text style={t.note}>
              {`Made of ${lapsUsed(c)} laps of ${new Set(c.from.map(([run]) => run)).size} ${new Set(c.from.map(([run]) => run)).size === 1 ? 'stint' : 'stints'}, from ${c.laps} clean laps`}
            </Text>
          </>
        ) : <Text style={t.body}>Needs laps from two stints.</Text>}
      </View>
    </View>
  );
}

const keyOfLabel = (s: Stint) => s.code ?? 'No driver';

/** One theoretical's lap in one corner: the driver's key, the lap and what it gains there; quietly "fastest lap" where
 * the real lap it is told from holds the corner itself. `stint`: name the stint too (the combined theoretical's). */
function Cell({ h, fill, stint }: { h: Holder | null; fill: (s: Stint) => string; stint?: boolean }) {
  const styles = useStyles();
  if (!h) return <Text style={styles.quiet}>Not ready</Text>;
  return (
    <View style={styles.cell}>
      <DriverBlock label={keyOfLabel(h.stint)} fill={fill(h.stint)} />
      <Text style={styles.lap}>{`L${h.lap}`}</Text>
      {stint && <Text style={styles.cellStint} numberOfLines={1}>{h.stint.name}</Text>}
      {h.itself ? <Text style={styles.quiet}>fastest lap</Text>
        : h.gain != null ? <Text style={styles.gain}>{minus(h.gain)}</Text> : null}
    </View>
  );
}

const cellWords = (h: Holder | null, stint: boolean) => (!h ? 'not ready'
  : `lap ${h.lap}${stint ? ` of ${h.stint.name}` : ''}, ${h.stint.code ?? 'driver not set'}, ${h.itself ? 'the fastest lap itself'
    : h.gain != null ? `${h.gain.toFixed(2)} s quicker` : ''}`);

/** One row per corner, in track order: on a wide screen a column per stint theoretical and one for the combined
 * theoretical; on a phone the theoreticals stack under the corner, each named. */
function CornerMap({ rows, stints, answer, fill, picked, onTap }: {
  rows: CornerRow[];
  stints: Stint[];
  answer: TheoreticalAnswer;
  fill: (s: Stint) => string;
  picked: string | null;
  onTap?: (key: string, code: string, laps: LapRef[]) => void;
}) {
  const styles = useStyles();
  const wide = useWide();
  const names = answer.stints.map((_, i) => stints[i]);
  return (
    <View style={styles.map}>
      {wide && (
        <View style={styles.headRow}>
          <Text style={StyleSheet.flatten([styles.colHead, styles.codeCol])}>Corner</Text>
          {names.map((s) => <Text key={s.run} style={StyleSheet.flatten([styles.colHead, styles.col])}>{stintTitle(s)}</Text>)}
          <Text style={StyleSheet.flatten([styles.colHead, styles.col])}>{COMBINED}</Text>
        </View>
      )}
      {rows.map((r) => {
        const key = `map:${r.code}`;
        const on = picked === key;
        const label = `${r.code}. ${names.map((s, i) => `${stintTitle(s)}: ${cellWords(r.stints[i], false)}`).join('. ')}. ${Combined}: ${cellWords(r.combined, true)}.`;
        const body = wide ? (
          <>
            <Text style={StyleSheet.flatten([styles.code, styles.codeCol])}>{r.code}</Text>
            {r.stints.map((h, i) => <View key={names[i].run} style={styles.col}><Cell h={h} fill={fill} /></View>)}
            <View style={styles.col}><Cell h={r.combined} fill={fill} stint /></View>
          </>
        ) : (
          <>
            <Text style={StyleSheet.flatten([styles.code, styles.codeColPhone])}>{r.code}</Text>
            <View style={styles.grow}>
              {r.stints.map((h, i) => (
                <View key={names[i].run} style={styles.line}>
                  <Text style={styles.lineName} numberOfLines={1}>{names[i].name}</Text>
                  <Cell h={h} fill={fill} />
                </View>
              ))}
              <View style={styles.line}>
                <Text style={styles.lineName} numberOfLines={1}>Combined</Text>
                <Cell h={r.combined} fill={fill} stint />
              </View>
            </View>
          </>
        );
        const style = StyleSheet.flatten([styles.row, wide ? styles.rowWide : null, on && styles.rowOn]);
        return onTap ? (
          <Pressable key={r.code} style={style} onPress={() => onTap(key, r.code, r.laps)} accessibilityRole="button"
            {...a11yState({ selected: on }, 'button')} accessibilityLabel={`${label} Show on the 3D racing line.`}>
            {body}
          </Pressable>
        ) : <View key={r.code} style={style} accessible accessibilityLabel={label}>{body}</View>;
      })}
    </View>
  );
}

/** What the lap holding each corner of one theoretical does differently from the real lap it is told from, the
 * biggest gain first: the combined theoretical's at first, a stint theoretical's with a tap. */
function Tips({ answer, stints, fill, picked, onTap }: {
  answer: TheoreticalAnswer;
  stints: Stint[];
  fill: (s: Stint) => string;
  picked: string | null;
  onTap?: (key: string, code: string, laps: LapRef[]) => void;
}) {
  const styles = useStyles();
  const t = useText();
  const [of, setOf] = useState<string | null>(answer.combined ? null : answer.stints.find((s) => s.ready)?.run ?? null);
  const ready = answer.stints.filter((s) => s.ready);
  const items = [
    ...(answer.combined ? [{ key: null, label: Combined, sub: 'On the fastest lap' }] : []),
    ...ready.map((s) => {
      const st = stints.find((x) => x.run === s.run)!;
      return { key: s.run, label: `${cap(stintTitle(st))}`, sub: 'On its fastest lap' };
    }),
  ];
  const shown = items.some((i) => i.key === of) ? of : items[0]?.key ?? null; // the laps changed: the first again
  const tips = tipsOf(answer, shown);
  const told = shown == null ? answer.combined : ready.find((s) => s.run === shown);
  const ref = (run: string, lap: number): LapRef | null => {
    const s = stints.find((x) => x.run === run);
    return s ? { session_id: s.sessionId, lap } : null;
  };
  return (
    <>
      <Label style={StyleSheet.flatten([styles.label, styles.gapTop])}>What the theoretical best does differently</Label>
      <Text style={StyleSheet.flatten([t.body, styles.dek])}>
        Each corner where the theoretical’s lap gains 0.02 s or more on the real lap it is measured from, the biggest
        first: its line and technique there, against that lap.
      </Text>
      {items.length > 1 && <Tabs items={items} value={shown} onChange={setOf} style={styles.tabs} />}
      {!told ? <Note>No theoretical lap yet.</Note> : told.tips == null
        ? <Note>This server doesn’t word the corners yet: it needs updating.</Note>
        : tips.length === 0 ? <Note>{`No corner gains 0.02 s or more on lap ${told.best_lap}: it is the theoretical’s best in every corner.`}</Note>
          : (
            <View style={styles.tips}>
              {tips.map((tip: Tip) => {
                const h = stints.find((s) => s.run === tip.from[0]);
                const key = `tip:${shown ?? 'combined'}:${tip.code}`;
                const on = picked === key;
                const words = tipWords(tip, stints);
                const laps = [ref(...tip.from), ref(...tip.versus)].filter((l): l is LapRef => l != null);
                const body = (
                  <>
                    <View style={styles.tipHead}>
                      <Text style={styles.code}>{tip.code}</Text>
                      {h && <DriverBlock label={keyOfLabel(h)} fill={fill(h)} />}
                      <Text style={styles.lap}>{`L${tip.from[1]}`}</Text>
                      <Text style={styles.gain}>{minus(tip.gain_s)}</Text>
                    </View>
                    <Text style={t.body}>{words}</Text>
                  </>
                );
                return onTap ? (
                  <Pressable key={tip.code} style={StyleSheet.flatten([styles.tip, on && styles.rowOn])}
                    onPress={() => onTap(key, tip.code, laps)} accessibilityRole="button" {...a11yState({ selected: on }, 'button')}
                    accessibilityLabel={`${tip.code}, ${tip.gain_s.toFixed(2)} s: ${words} Show on the 3D racing line.`}>
                    {body}
                  </Pressable>
                ) : <View key={tip.code} style={styles.tip}>{body}</View>;
              })}
            </View>
          )}
    </>
  );
}

const useStyles = themed((c) => ({
  box: { maxWidth: 980 },
  label: { color: c.text, marginBottom: 6 },
  dek: { marginBottom: 12, maxWidth: 820 },
  gapTop: { marginTop: 28 },
  noteGap: { marginBottom: 10 },
  working: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  grow: { flex: 1, minWidth: 0 },

  // the theoreticals: side by side on a wide screen, one under the other on a phone
  sums: { flexDirection: 'row', flexWrap: 'wrap', gap: 24 },
  sum: { borderTopWidth: 2, borderColor: c.rule, paddingTop: 8, paddingBottom: 14, gap: 4 },
  sumWide: { flexBasis: 260, flexGrow: 1, borderTopWidth: 2, borderColor: c.rule, paddingTop: 8, gap: 4 },
  sumHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  sumTitle: { color: c.text },
  sumTime: { ...Type.number, fontFamily: face('label', 700), fontSize: 30, lineHeight: 36, color: c.text },

  legend: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 10, marginBottom: 12 },

  // the map: an ink rule over it, a faint one between corners
  map: { borderTopWidth: 2, borderColor: c.rule },
  headRow: { flexDirection: 'row', alignItems: 'flex-end', gap: 12, paddingVertical: 8, borderBottomWidth: 1,
    borderColor: c.rule },
  colHead: { ...Type.label, fontSize: 13, color: c.textSecondary },
  row: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, minHeight: TAP, paddingVertical: 8,
    borderBottomWidth: 1, borderColor: c.separator, borderLeftWidth: 4, borderLeftColor: 'transparent', paddingLeft: 6 },
  rowWide: { alignItems: 'center', gap: 12 },
  // the corner last shown on the racing line: a red rule at its left
  rowOn: { borderLeftColor: c.mark },
  code: { ...Type.label, fontSize: 15, color: c.text },
  codeCol: { width: 72 },
  codeColPhone: { width: 58, paddingTop: 3 },
  col: { flex: 1, minWidth: 0 },
  line: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 28 },
  lineName: { fontFamily: face('label', 500), fontSize: 14, color: c.textSecondary, width: 82 },
  cell: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', columnGap: 8, rowGap: 2, flexShrink: 1 },
  lap: { ...Type.number, fontFamily: face('label', 700), fontSize: 16, color: c.text },
  cellStint: { fontFamily: face('label', 500), fontSize: 14, color: c.textSecondary, flexShrink: 1 },
  gain: { ...Type.number, fontSize: 15, color: c.success },
  quiet: { fontFamily: face('label', 500), fontSize: 14, color: c.textMuted },

  // the tips
  tabs: { marginBottom: 12 },
  tips: { borderTopWidth: 2, borderColor: c.rule, maxWidth: 820 },
  tip: { gap: 6, paddingVertical: 12, minHeight: TAP, borderBottomWidth: 1, borderColor: c.separator, borderLeftWidth: 4,
    borderLeftColor: 'transparent', paddingLeft: 6 },
  tipHead: { flexDirection: 'row', alignItems: 'center', gap: 10 },
}));

export default TheoreticalMap;
