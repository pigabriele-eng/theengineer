// The report's Drivers section (Gabriele, 2026-10-08: "in the reporting page, i would like to add a "driver"
// comparison"): two drivers of the report's runs on one tyre level, like with like, corner by corner first. Each
// corner: their speed, brake and throttle through it (the top 10% of passes, the typical ones or the bottom 10%), the
// numbers side by side, the differences in words, what the technique check finds in one driver's laps there, the
// balance on entry, mid-corner and exit, and the time in it, second. Then their lap times put on one tyre age and fuel
// load (and what wasn't), grip use, where the balance differs, and both best laps on the full-lap traces. Real laps
// only, never a summed one. The picks and words are lib/reportDrivers.ts, the requests lib/reportDriversApi.ts.
import { RefObject, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, View as Box, StyleSheet } from 'react-native';

import { LapChip, LapChips } from '@/components/compare/LapChips';
import { CompareTraces, LineKey, useLapColors } from '@/components/CompareViews';
import { Choice, Tabs, useText } from '@/components/Picks';
import { B, Label, TextLink, useWide } from '@/components/Programme';
import DriverCornerChart, { DASH } from '@/components/report/DriverCornerChart';
import { Text, View } from '@/components/Themed';
import { useColorScheme } from '@/components/useColorScheme';
import { face, Fonts, themed, Type } from '@/constants/Theme';
import { CompareResult, compareLaps, formatLap, LAP_COLORS } from '@/lib/compare';
import { fetchGrip } from '@/lib/grip';
import { afterOthers } from '@/lib/loadLast';
import {
  balanceDiffs, balanceFor, balanceRows, checkLines, codeOf, cornerOrder, DEFAULT_TRACES, differenceWords, DriverCorner,
  DriverGrip, DriversCorners, flipTrace, gapLine, gapWords, GRIP_PHASES, gripBySide, GROUPS, GroupKey, LevelReport,
  levelDrivers, matchedLines, NEGLIGIBLE_S, numberRows, onTraces, pickLevel, pickPair, repick, Side, SIDES, traceLaps,
} from '@/lib/reportDrivers';
import { DriversBalance, DriversFlags, fetchDriversBalance, fetchDriversCorners, fetchDriversFlags } from '@/lib/reportDriversApi';
import { TYRE_LABEL, TyreLevel } from '@/lib/tyreLevels';

const GRIP_WORDS = { braking: 'Braking', trail: 'Turning in', mid: 'Mid-corner', exit: 'Exit' };

/** True once the part is near the screen (on the web) or the page's other reads have answered: the full-lap traces,
 * a heavy read, load last. */
function useLoadLast(ref: RefObject<Box | null>, on: boolean) {
  const [go, setGo] = useState(false);
  useEffect(() => {
    if (!on || go) return;
    const stop = afterOthers(() => setGo(true));
    const node = ref.current as unknown;
    let seen: IntersectionObserver | undefined;
    if (typeof IntersectionObserver !== 'undefined' && typeof Element !== 'undefined' && node instanceof Element) {
      seen = new IntersectionObserver((es) => es.some((e) => e.isIntersecting) && setGo(true),
        { rootMargin: '0px 0px 200px 0px' });
      seen.observe(node);
    }
    return () => {
      stop();
      seen?.disconnect();
    };
  }, [on, go]); // eslint-disable-line react-hooks/exhaustive-deps -- the ref is the part's, for good
  return go;
}

/** Whether the report's runs have two drivers or more to compare (the section is left out otherwise). */
export function hasTwoDrivers(levels: LevelReport[], driverOf: (id: number) => string | null | undefined) {
  return new Set(levelDrivers(levels, driverOf).flatMap((l) => l.drivers.map((d) => d.name))).size >= 2;
}

const lapCount = (n: number) => `${n} ${n === 1 ? 'lap' : 'laps'}`;

export default function DriversCompare({ levels, driverOf, shown, runName, runIdOf, gripEvent }: {
  levels: LevelReport[]; // the report of every tyre level, unfiltered
  driverOf: (sessionId: number) => string | null | undefined;
  shown: TyreLevel | null; // the level the report's own tabs are on
  runName: (sessionId: number) => string; // "04_R1", "FP1 stint 2"
  runIdOf: (run: string) => number | undefined; // a run's report name to its id (for the grip report's laps)
  gripEvent: number | null; // the event whose grip use the page reads, when it does
}) {
  const styles = useStyles();
  const t = useText();
  const wide = useWide();
  const scheme = useColorScheme() === 'dark' ? 'dark' : 'light';
  const sideColor: Record<Side, string> = { a: LAP_COLORS[scheme][0], b: LAP_COLORS[scheme][1] };
  const all = useMemo(() => levelDrivers(levels, driverOf), [levels, driverOf]);
  const [pickedLevel, setPickedLevel] = useState<TyreLevel | null>(null);
  const [picked, setPicked] = useState<[string, string] | null>(null);
  const [group, setGroup] = useState<GroupKey>('median');
  const [showClose, setShowClose] = useState(false);
  const [traceKeys, setTraceKeys] = useState<string[]>(DEFAULT_TRACES);
  const { both, level, only } = pickLevel(all, pickedLevel, shown);
  const pair = level ? pickPair(level, picked) : null;
  const runs = pair ? { a: pair[0].runs, b: pair[1].runs } : null;
  const key = runs ? `${runs.a.join(',')}|${runs.b.join(',')}` : '';

  const [corners, setCorners] = useState<{ key: string; data: DriversCorners } | null>(null);
  const [error, setError] = useState<{ key: string; text: string } | null>(null);
  const [balance, setBalance] = useState<{ key: string; data: DriversBalance } | null>(null);
  const [flags, setFlags] = useState<{ key: string; data: DriversFlags } | null>(null);
  const [grip, setGrip] = useState<Record<Side, DriverGrip | null> | null>(null);
  useEffect(() => {
    if (!runs) return;
    let live = true;
    const k = key;
    fetchDriversCorners(runs.a, runs.b).then((data) => live && setCorners({ key: k, data }),
      (e) => live && setError({ key: k, text: (e as Error).message }));
    fetchDriversFlags(runs.a, runs.b).then((data) => live && setFlags({ key: k, data }), () => undefined);
    fetchDriversBalance(runs.a, runs.b).then((data) => live && setBalance({ key: k, data }), () => undefined);
    return () => {
      live = false;
    };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps -- the runs, by value
  const data = corners?.key === key ? corners.data : null;
  const failed = error?.key === key ? error.text : null;
  const bal = balance?.key === key ? balance.data : null;
  const flagged = flags?.key === key && flags.data.status === 'ready' ? flags.data : null;
  // grip use per driver, from the report's own grip use (the page reads it for the event): the runs compared
  const matchedKey = data ? `${data.matched.runs.a.join(',')}|${data.matched.runs.b.join(',')}` : '';
  useEffect(() => {
    setGrip(null);
    if (gripEvent == null || !data) return;
    let live = true;
    const stop = afterOthers(() => {
      fetchGrip({ event: gripEvent }).then((g) => {
        if (live && g.available && g.laps) setGrip(gripBySide(g.laps, runIdOf, data.matched.runs));
      }, () => undefined);
    });
    return () => {
      live = false;
      stop();
    };
  }, [gripEvent, matchedKey]); // eslint-disable-line react-hooks/exhaustive-deps -- the runs compared, by value

  // the full-lap traces: both best laps at first, the typical ones a tap away
  const traceRef = useRef<Box>(null);
  const offer = useMemo(() => (data ? traceLaps(data.sides) : []), [data]);
  const lapsOn = onTraces(offer, traceKeys);
  const go = useLoadLast(traceRef, lapsOn.length >= 2);
  const lapKey = lapsOn.map((l) => `${l.session_id}:${l.lap}`).join(',');
  const [traces, setTraces] = useState<{ key: string; data: CompareResult } | null>(null);
  const [traceError, setTraceError] = useState<string | null>(null);
  const [zoom, setZoom] = useState<string | null>(null);
  const [cursor, setCursor] = useState<number | null>(null);
  useEffect(() => {
    if (!go || lapsOn.length < 2) return;
    let live = true;
    setTraceError(null);
    compareLaps(lapsOn.map((l) => ({ session_id: l.session_id, lap: l.lap }))).then((d) => {
      if (!live) return;
      setTraces({ key: lapKey, data: d });
      setZoom(null);
      setCursor(null);
    }, (e) => live && setTraceError((e as Error).message));
    return () => {
      live = false;
    };
  }, [lapKey, go]); // eslint-disable-line react-hooks/exhaustive-deps -- the laps, by value
  const traceColors = useLapColors(lapsOn.map((l) => l.slot));
  const palette = useLapColors([0, 1, 2, 3]).laps;

  if (!both.length) {
    return <Text style={t.body}>No tyre level where two drivers both drove: nothing to compare like with like.</Text>;
  }
  if (!level || !pair || !runs) return null;
  const names: Record<Side, string> = { a: pair[0].name, b: pair[1].name };
  const codes: Record<Side, string> = { a: pair[0].code, b: pair[1].code };
  const levelWord = TYRE_LABEL[level.tyres].toLowerCase();

  const picks = (
    <View style={styles.picks}>
      {both.length > 1 && (
        <View style={styles.pickRow}>
          <Label small muted style={styles.pickLabel}>Tyres</Label>
          <View style={styles.choices}>
            {both.map((l) => (
              <Choice key={l.tyres} label={TYRE_LABEL[l.tyres]} on={l.tyres === level.tyres}
                detail={`${l.drivers[0].code} ${l.drivers[0].laps.length} · ${l.drivers[1].code} ${l.drivers[1].laps.length} laps`}
                accessibilityLabel={`Compare on ${TYRE_LABEL[l.tyres].toLowerCase()} tyres: ${l.drivers.map((d) =>
                  `${d.name} ${lapCount(d.laps.length)}`).join(', ')}`}
                onPress={() => setPickedLevel(l.tyres)} />
            ))}
          </View>
        </View>
      )}
      {SIDES.map((side, i) => (
        <View key={side} style={styles.pickRow}>
          <Label small muted style={styles.pickLabel}>{i === 0 ? 'Driver' : 'against'}</Label>
          <View style={styles.choices}>
            {level.drivers.map((d) => (
              <Choice key={d.name} label={d.code} detail={lapCount(d.laps.length)} on={pair[i].name === d.name}
                accessibilityLabel={`${i === 0 ? 'Compare' : 'Against'} ${d.name}, ${lapCount(d.laps.length)} on ` +
                  `${levelWord} tyres`}
                onPress={() => setPicked(repick([pair[0].name, pair[1].name], side, d.name))} />
            ))}
          </View>
        </View>
      ))}
    </View>
  );

  const key2 = (
    <View style={styles.keys}>
      {SIDES.map((s) => (
        <View key={s} style={styles.key}>
          <LineKey color={sideColor[s]} dash={s === 'b' ? DASH.replace(' ', ',') : undefined} />
          <Text style={styles.keyText}><B>{codes[s]}</B> {names[s]} ({s === 'a' ? 'round marks' : 'square marks'})</Text>
        </View>
      ))}
    </View>
  );

  // the head of each table: the two drivers' codes, each with their line
  const headRow = (
    <View style={styles.tableHead}>
      <Text style={styles.th} />
      {SIDES.map((s) => (
        <View key={s} style={styles.thCell}>
          <LineKey color={sideColor[s]} dash={s === 'b' ? DASH.replace(' ', ',') : undefined} />
          <Text style={styles.thText}>{codes[s]}</Text>
        </View>
      ))}
    </View>
  );

  const block = (c: DriverCorner) => {
    const g = c.groups[group];
    const rows = [...numberRows(g.a, g.b, data!.brake_unit, c.flat),
      ...balanceRows(bal ? balanceFor(bal.sections, c.code) : null)];
    const words = differenceWords(g.a, g.b, codes, data!.brake_unit, c.flat);
    const checks = checkLines(c.code, flagged, codes);
    return (
      <View key={c.code} style={styles.corner}>
        <Text style={styles.cornerCode} accessibilityRole="header">{c.code}</Text>
        <View style={wide ? styles.cornerWide : styles.cornerPhone}>
          <View style={wide ? styles.chartSide : undefined}>
            <DriverCornerChart corner={c} group={g} codes={codes} colors={sideColor} brakeUnit={data!.brake_unit}
              wide={wide} />
          </View>
          <View style={wide ? styles.numbersSide : undefined}>
            {headRow}
            {rows.map((r) => (
              <View key={r.label} style={styles.tr}>
                <Text style={styles.td}>{r.label}</Text>
                <Text style={styles.tdNum}>{r.a}</Text>
                <Text style={styles.tdNum}>{r.b}</Text>
              </View>
            ))}
            <Text style={styles.passes}>
              {GROUPS.find((x) => x.key === group)!.label}: {g.a.passes} {g.a.passes === 1 ? 'pass' : 'passes'} of{' '}
              {codes.a}, {g.b.passes} of {codes.b}
            </Text>
          </View>
        </View>
        <Text style={styles.words}>{words ? `${words}.` : 'Both drive it the same way here.'}</Text>
        {checks.map((l) => <Text key={l} style={styles.check}>{l}</Text>)}
        <Text style={styles.gap}>{gapLine(c, codes)}.</Text>
      </View>
    );
  };

  const body = () => {
    if (failed) return <Text style={styles.error}>The comparison didn&apos;t load: {failed}</Text>;
    if (!data) {
      return (
        <View style={styles.busy}>
          <ActivityIndicator />
          <Text style={t.note}>Reading both drivers&apos; laps…</Text>
        </View>
      );
    }
    const { shown: list, folded } = cornerOrder(data.corners);
    const sides = data.sides;
    const corrected = data.correction.tyres || data.correction.fuel;
    const diffs = bal ? balanceDiffs(bal.sections, codes) : null;
    const chips: LapChip[] = offer.map((l) => {
      const run = runName(l.session_id);
      const time = formatLap(l.time);
      const what = l.also ? 'best and typical' : l.kind;
      return { key: l.key, on: traceKeys.includes(l.key), color: palette[l.slot % palette.length],
        label: `${codes[l.side]} ${what} · ${run} L${l.lap} · ${time}`,
        spoken: `${names[l.side]}'s ${what} lap, lap ${l.lap} of ${run}, ${time}` };
    });
    // the traces' own key names each lap by its run: the driver's code added to it
    const tracesNow = traces && traces.key === lapKey ? { ...traces.data, laps: traces.data.laps.map((l, i) =>
      (lapsOn[i] ? { ...l, session: `${l.session}, ${codes[lapsOn[i].side]}` } : l)) } : null;
    return (
      <>
        {matchedLines(data.matched, TYRE_LABEL[level.tyres], { a: sides.a.laps, b: sides.b.laps }, names).map((l) => (
          <Text key={l} style={styles.matched}>{l}</Text>
        ))}
        <Tabs label="Passes drawn in each corner" value={group} onChange={setGroup} style={styles.groups}
          items={GROUPS.map((x) => ({ key: x.key, label: x.label }))} />
        {key2}
        {data.corners.some((c) => c.groups[group].a.gear != null || c.groups[group].b.gear != null) && (
          <Text style={t.note}>Gears as the logger numbers them.</Text>
        )}
        {list.map(block)}
        {folded.length > 0 && (
          <View style={styles.folded}>
            <Text style={t.body}>
              Within {NEGLIGIBLE_S.toFixed(2)} s of each other (typical passes) in {folded.map((c) => c.code).join(', ')}.
            </Text>
            <TextLink label={showClose ? 'Hide them' : 'Show them too'} onPress={() => setShowClose((v) => !v)} />
          </View>
        )}
        {showClose && folded.map(block)}

        <Text style={styles.h}>Lap times</Text>
        <View style={styles.lapTable}>
          {headRow}
          {[
            { label: 'Best lap', a: formatLap(sides.a.best.time), b: formatLap(sides.b.best.time),
              gap: gapWords(sides.a.best.time, sides.b.best.time, codes) },
            { label: 'Typical lap', a: formatLap(sides.a.typical.time), b: formatLap(sides.b.typical.time),
              gap: gapWords(sides.a.typical.time, sides.b.typical.time, codes) },
            ...(corrected ? [{ label: 'Typical, corrected', a: formatLap(sides.a.typical_corrected.corrected),
              b: formatLap(sides.b.typical_corrected.corrected),
              gap: gapWords(sides.a.typical_corrected.corrected, sides.b.typical_corrected.corrected, codes) }] : []),
          ].map((r) => (
            <View key={r.label}>
              <View style={styles.tr}>
                <Text style={styles.td}>{r.label}</Text>
                <Text style={styles.tdNum}>{r.a}</Text>
                <Text style={styles.tdNum}>{r.b}</Text>
              </View>
              <Text style={styles.gapRow}>{r.gap}</Text>
            </View>
          ))}
          {data.correction.tyres && sides.a.tyre_age != null && sides.b.tyre_age != null && (
            <View style={styles.tr}>
              <Text style={styles.td}>Laps on the set</Text>
              <Text style={styles.tdNum}>{Math.round(sides.a.tyre_age)}</Text>
              <Text style={styles.tdNum}>{Math.round(sides.b.tyre_age)}</Text>
            </View>
          )}
        </View>
        {data.correction.words.map((w) => <Text key={w} style={t.note}>{w}</Text>)}
        <Text style={t.note}>
          The corners above are as driven: not corrected for tyres or fuel, but each pass is ranked against the laps
          next to it in its own stint.
        </Text>

        {grip && grip.a && grip.b && (
          <>
            <Text style={styles.h}>Grip use</Text>
            <View style={styles.lapTable}>
              {headRow}
              {[{ label: 'Braking and cornering', a: grip.a.grip_use, b: grip.b.grip_use },
                ...GRIP_PHASES.map((p) => ({ label: GRIP_WORDS[p], a: grip.a!.phases[p], b: grip.b!.phases[p] }))]
                .map((r) => (
                  <View key={r.label} style={styles.tr}>
                    <Text style={styles.td}>{r.label}</Text>
                    <Text style={styles.tdNum}>{r.a == null ? '–' : `${r.a.toFixed(1)} %`}</Text>
                    <Text style={styles.tdNum}>{r.b == null ? '–' : `${r.b.toFixed(1)} %`}</Text>
                  </View>
                ))}
            </View>
            <Text style={t.note}>
              Share of the car&apos;s grip used, median of the quick laps the report&apos;s grip use reads ({grip.a.laps} of
              {' '}{codes.a}&apos;s, {grip.b.laps} of {codes.b}&apos;s).
            </Text>
          </>
        )}

        {diffs && (diffs.differ.length > 0 || diffs.same.length > 0) && (
          <>
            <Text style={styles.h}>Balance</Text>
            {diffs.differ.map((d) => <Text key={d.code} style={t.body}>{d.line}</Text>)}
            {diffs.same.length > 0 && (
              <Text style={t.note}>
                {diffs.differ.length ? 'The same for both' : 'The same balance for both'} in {diffs.same.join(', ')}.
              </Text>
            )}
            <Text style={t.note}>Understeer or oversteer as each drove it, against one normal for both. Data only.</Text>
          </>
        )}

        <Text style={styles.h}>On the full lap</Text>
        <Box ref={traceRef}>
          <LapChips chips={chips} onFlip={(k) => setTraceKeys((v) => flipTrace(v, k))} />
        </Box>
        {lapsOn.length < 2 && <Text style={t.note}>Put two laps on the traces to compare them.</Text>}
        {traceError && <Text style={styles.error}>The traces didn&apos;t load: {traceError}</Text>}
        {lapsOn.length >= 2 && !tracesNow && !traceError && <ActivityIndicator style={styles.loading} />}
        {lapsOn.length >= 2 && tracesNow && (
          <CompareTraces data={tracesNow} colors={traceColors} zoom={zoom} onZoom={setZoom} cursor={cursor}
            onCursor={setCursor} bare />
        )}
      </>
    );
  };

  return (
    <View style={styles.root}>
      {only && (
        <Text style={t.body}>
          Only {only.driver.code} drove on {TYRE_LABEL[only.tyres]} tyres; comparing on {TYRE_LABEL[level.tyres]}, where
          both drove.
        </Text>
      )}
      {picks}
      {body()}
    </View>
  );
}

const useStyles = themed((c) => ({
  root: { gap: 14 },
  picks: { gap: 4 },
  pickRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', columnGap: 12 },
  pickLabel: { minWidth: 64 },
  choices: { flexDirection: 'row', flexWrap: 'wrap', columnGap: 16, rowGap: 4, flexShrink: 1 },
  matched: { fontFamily: Fonts.body, fontSize: 16, lineHeight: 23, color: c.text, maxWidth: 820 },
  groups: { marginTop: 4 },
  keys: { flexDirection: 'row', flexWrap: 'wrap', columnGap: 20, rowGap: 6 },
  key: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  keyText: { fontFamily: face('label', 500), fontSize: 16, lineHeight: 22, color: c.text },
  corner: { gap: 10, borderTopWidth: 3, borderColor: c.rule, paddingTop: 10, marginTop: 10 },
  cornerCode: { ...Type.label, fontSize: 18, lineHeight: 22, color: c.text },
  cornerWide: { flexDirection: 'row', gap: 28, alignItems: 'flex-start' },
  cornerPhone: { gap: 12 },
  chartSide: { flex: 3, minWidth: 0 },
  numbersSide: { flex: 2, minWidth: 0 },
  tableHead: { flexDirection: 'row', gap: 8, borderBottomWidth: 1, borderColor: c.rule, paddingBottom: 4 },
  th: { flex: 5 },
  thCell: { flex: 4, flexDirection: 'row', alignItems: 'center', gap: 6 },
  thText: { ...Type.label, fontSize: 14, color: c.text },
  tr: { flexDirection: 'row', gap: 8, paddingVertical: 5, borderBottomWidth: StyleSheet.hairlineWidth,
    borderColor: c.textMuted },
  td: { flex: 5, fontFamily: face('label', 500), fontSize: 15, lineHeight: 20, color: c.textSecondary },
  tdNum: { flex: 4, fontFamily: face('label', 600), fontSize: 15, lineHeight: 20, color: c.text,
    fontVariant: ['tabular-nums'] },
  passes: { fontFamily: face('label', 500), fontSize: 14, lineHeight: 19, color: c.textSecondary, marginTop: 6 },
  words: { fontFamily: face('body', 600), fontSize: 17, lineHeight: 24, color: c.text, maxWidth: 820 },
  check: { fontFamily: Fonts.body, fontSize: 16, lineHeight: 23, color: c.text, maxWidth: 820 },
  gap: { fontFamily: Fonts.body, fontSize: 16, lineHeight: 23, color: c.textSecondary, maxWidth: 820 },
  folded: { gap: 4, marginTop: 10 },
  h: { ...Type.label, fontSize: 14, color: c.text, borderTopWidth: 3, borderColor: c.rule, paddingTop: 8,
    marginTop: 18 },
  lapTable: { maxWidth: 560 },
  gapRow: { fontFamily: face('label', 500), fontSize: 14, lineHeight: 19, color: c.textSecondary, paddingBottom: 4 },
  busy: { flexDirection: 'row', gap: 10, alignItems: 'center' },
  loading: { marginVertical: 12 },
  error: { fontFamily: Fonts.body, fontSize: 16, lineHeight: 23, color: c.error },
}));
