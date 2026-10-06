import { Link, Stack, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, TextInput } from 'react-native';

import {
  HabitList,
  LapStrip,
  SectionDeltaChart,
  SectionHabits,
  sectionWords,
  StyleTable,
  TechniqueList,
} from '@/components/DriverTrends';
import { Text, View, useThemeColor } from '@/components/Themed';
import { TraceChart, useSeriesColors } from '@/components/TraceChart';
import { DETECTED_CORNERS_NOTE, formatLap } from '@/lib/api';
import {
  CompareJob,
  compareApi,
  Comparison,
  OptionGroup,
  PHASE_SHORT,
  seconds,
  Side,
  SIDES,
} from '@/lib/drivers';

type Mode = 'drivers' | 'sessions';
const POLL_MS = 1000;
const MAX_POLL_FAILURES = 20;

// Two drivers (or two groups of sessions) at one track and car, over all their clean laps. ?event=<id> opens on the
// track and car of that event's sessions.
export default function CompareDriversScreen() {
  const { event } = useLocalSearchParams<{ event?: string }>();
  const [groups, setGroups] = useState<OptionGroup[] | null>(null);
  const [groupIdx, setGroupIdx] = useState(0);
  const [mode, setMode] = useState<Mode>('drivers');
  const [driverOf, setDriverOf] = useState<Partial<Record<Side, number>>>({});
  const [sideOf, setSideOf] = useState<Record<number, Side>>({});
  const [names, setNames] = useState<Record<Side, string>>({ a: 'Group A', b: 'Group B' });
  const [job, setJob] = useState<CompareJob | null>(null);
  const [result, setResult] = useState<Comparison | null>(null);
  const [error, setError] = useState<string | null>(null);
  const failures = useRef(0);
  const tint = useThemeColor({}, 'tint');
  const background = useThemeColor({}, 'background');
  const text = useThemeColor({}, 'text');
  const series = useSeriesColors();
  const colors: Record<Side, string> = { a: series.reference, b: series.compare };

  useEffect(() => {
    compareApi.options().then(
      (g) => {
        setGroups(g);
        const at = Math.max(0, g.findIndex((x) => x.sessions.some((s) => event && s.event_id === Number(event))));
        setGroupIdx(at);
        const d = g[at]?.drivers ?? [];
        if (d.length >= 2) setDriverOf({ a: d[0].id, b: d[1].id });
        else setMode('sessions');
      },
      (e) => setError(e.message),
    );
  }, []);

  const group = groups?.[groupIdx] ?? null;
  const pickGroup = (i: number) => {
    setGroupIdx(i);
    const d = groups?.[i]?.drivers ?? [];
    setDriverOf(d.length >= 2 ? { a: d[0].id, b: d[1].id } : {});
    setSideOf({});
  };

  // the two sides as sent to the server: names and sessions
  const sides = useMemo(() => {
    if (!group) return null;
    const out = {} as Record<Side, { label: string; session_ids: number[] }>;
    for (const side of SIDES) {
      if (mode === 'drivers') {
        const d = group.drivers.find((x) => x.id === driverOf[side]);
        out[side] = { label: d?.name ?? '', session_ids: group.sessions.filter((s) => d && s.driver_id === d.id).map((s) => s.id) };
      } else {
        out[side] = { label: names[side].trim(), session_ids: group.sessions.filter((s) => sideOf[s.id] === side).map((s) => s.id) };
      }
    }
    return out;
  }, [group, mode, driverOf, sideOf, names]);

  const running = job != null && (job.status === 'queued' || job.status === 'running');
  const problem = !sides
    ? null
    : SIDES.some((s) => sides[s].session_ids.length === 0)
      ? mode === 'drivers'
        ? 'Pick a driver for each side.'
        : 'Put at least one session on each side.'
      : sides.a.label === sides.b.label
        ? 'Pick two different drivers, or give the groups different names.'
        : !sides.a.label || !sides.b.label
          ? 'Give each group a name.'
          : null;

  const start = async () => {
    if (!sides || problem) return;
    setError(null);
    setResult(null);
    failures.current = 0;
    try {
      setJob(await compareApi.start(sides.a, sides.b));
    } catch (e) {
      setError((e as Error).message);
    }
  };

  // Follow the comparison until it is done.
  useEffect(() => {
    if (!job || !running) return;
    const timer = setTimeout(async () => {
      try {
        const next = await compareApi.job(job.id);
        failures.current = 0;
        setJob(next);
        if (next.status === 'done') setResult(next.result);
        if (next.status === 'failed') setError(next.error);
      } catch (e) {
        failures.current += 1;
        if (failures.current < MAX_POLL_FAILURES) setJob({ ...job });
        else {
          setError((e as Error).message);
          setJob({ ...job, status: 'failed' });
        }
      }
    }, POLL_MS);
    return () => clearTimeout(timer);
  }, [job, running]);

  const chip = (on: boolean) => StyleSheet.flatten([styles.chip, on && { borderColor: tint }]);

  return (
    <ScrollView style={{ backgroundColor: background }} contentContainerStyle={styles.container}>
      <Stack.Screen options={{ title: 'Compare drivers' }} />
      <Text style={styles.intro}>
        Two drivers, or two groups of sessions, in the same car at the same track, over all their clean laps: where each
        gains or loses, how often, the technique behind it and the habits that repeat.
      </Text>

      {groups == null && !error && <ActivityIndicator />}
      {groups != null && groups.length === 0 && (
        <Text style={styles.dim}>No sessions with clean laps yet. Upload logs on the Sessions tab first.</Text>
      )}

      {groups != null && groups.length > 1 && (
        <View style={styles.block}>
          <Text style={styles.h3}>Track and car</Text>
          <View style={styles.chips}>
            {groups.map((g, i) => (
              <Pressable key={`${g.track_id}-${g.car_id}`} onPress={() => pickGroup(i)} style={chip(i === groupIdx)}>
                <Text style={i === groupIdx ? { color: tint } : undefined}>
                  {g.track ?? 'Track not known'}
                  {g.car ? ` · ${g.car}` : ''}
                </Text>
                <Text style={styles.chipSub}>{g.laps} clean laps</Text>
              </Pressable>
            ))}
          </View>
        </View>
      )}

      {group && sides && (
        <>
          {groups!.length === 1 && (
            <Text style={styles.sub}>
              {group.track ?? 'Track not known'}
              {group.car ? ` · ${group.car}` : ''} · {group.sessions.length} sessions · {group.laps} clean laps
            </Text>
          )}
          <View style={styles.segment}>
            {(['drivers', 'sessions'] as Mode[]).map((m) => (
              <Pressable key={m} onPress={() => setMode(m)} style={chip(mode === m)}>
                <Text style={mode === m ? { color: tint } : undefined}>{m === 'drivers' ? 'Two drivers' : 'Two groups of sessions'}</Text>
              </Pressable>
            ))}
          </View>

          {mode === 'drivers' ? (
            <DriverSides group={group} driverOf={driverOf} setDriverOf={setDriverOf} colors={colors} chip={chip} tint={tint} />
          ) : (
            <SessionSides group={group} sideOf={sideOf} setSideOf={setSideOf} names={names} setNames={setNames}
              colors={colors} tint={tint} text={text} background={background} />
          )}

          <Pressable
            onPress={start}
            disabled={!!problem || running}
            style={StyleSheet.flatten([styles.button, { backgroundColor: tint }, (!!problem || running) && styles.disabled])}>
            {running ? (
              <ActivityIndicator color={background} />
            ) : (
              <Text style={StyleSheet.flatten([styles.buttonText, { color: background }])}>
                {problem ??
                  `Compare ${sides.a.label} and ${sides.b.label} (${sides.a.session_ids.length + sides.b.session_ids.length} sessions)`}
              </Text>
            )}
          </Pressable>
          {running && job && (
            <View style={styles.block}>
              <Text style={styles.sub}>
                {job.status === 'queued'
                  ? 'Waiting for another comparison to finish…'
                  : job.done >= job.total
                    ? 'Comparing the laps…'
                    : `Reading ${job.current ?? 'the runs'} (${job.done + 1} of ${job.total} runs)…`}
              </Text>
              <View style={styles.progress}>
                <View style={StyleSheet.flatten([styles.progressFill, { width: `${(100 * job.done) / Math.max(job.total, 1)}%`, backgroundColor: tint }])} />
              </View>
            </View>
          )}
        </>
      )}
      {error && <Text style={styles.error}>{error}</Text>}

      {result && <Results key={job?.id} result={result} colors={colors} />}
    </ScrollView>
  );
}

function DriverSides({ group, driverOf, setDriverOf, colors, chip, tint }: {
  group: OptionGroup;
  driverOf: Partial<Record<Side, number>>;
  setDriverOf: (d: Partial<Record<Side, number>>) => void;
  colors: Record<Side, string>;
  chip: (on: boolean) => object;
  tint: string;
}) {
  const untagged = group.sessions.filter((s) => s.driver_id == null).length;
  return (
    <View style={styles.block}>
      {group.drivers.length < 2 && (
        <Text style={styles.sub}>
          {group.drivers.length === 0 ? 'No session here has a driver yet.' : 'Only one driver has sessions here.'} Tag the
          sessions with their drivers, or compare two groups of sessions.
        </Text>
      )}
      {group.drivers.length > 0 &&
        SIDES.map((side) => (
          <View key={side} style={styles.sideRow}>
            <View style={StyleSheet.flatten([styles.sideDot, styles.sideDotTop, { backgroundColor: colors[side] }])} />
            <View style={styles.chips}>
              {group.drivers.map((d) => {
                const on = driverOf[side] === d.id;
                return (
                  <Pressable key={d.id} onPress={() => setDriverOf({ ...driverOf, [side]: d.id })} style={chip(on)}>
                    <Text style={on ? { color: tint } : undefined}>{d.name}</Text>
                    <Text style={styles.chipSub}>
                      {d.laps} laps · best {formatLap(d.best)}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          </View>
        ))}
      {untagged > 0 && (
        <Link href="/drivers/tag" style={StyleSheet.flatten([styles.link, { color: tint }])}>
          {untagged} session{untagged === 1 ? '' : 's'} here {untagged === 1 ? 'has' : 'have'} no driver: tag drivers
        </Link>
      )}
    </View>
  );
}

function SessionSides({ group, sideOf, setSideOf, names, setNames, colors, tint, text, background }: {
  group: OptionGroup;
  sideOf: Record<number, Side>;
  setSideOf: (s: Record<number, Side>) => void;
  names: Record<Side, string>;
  setNames: (n: Record<Side, string>) => void;
  colors: Record<Side, string>;
  tint: string;
  text: string;
  background: string;
}) {
  const toggle = (id: number, side: Side) => {
    const next = { ...sideOf };
    if (next[id] === side) delete next[id];
    else next[id] = side;
    setSideOf(next);
  };
  return (
    <View style={styles.block}>
      <View style={styles.names}>
        {SIDES.map((side) => (
          <View key={side} style={styles.nameBox}>
            <View style={StyleSheet.flatten([styles.sideDot, { backgroundColor: colors[side] }])} />
            <TextInput
              value={names[side]}
              onChangeText={(v) => setNames({ ...names, [side]: v })}
              maxLength={120}
              style={StyleSheet.flatten([styles.input, { color: text }])}
              accessibilityLabel={`Name of group ${side.toUpperCase()}`}
            />
          </View>
        ))}
      </View>
      {group.sessions.map((s) => (
        <View key={s.id} style={styles.sessionRow}>
          <View style={styles.sessionText}>
            <Text style={styles.sessionName}>{s.name}</Text>
            <Text style={styles.chipSub}>
              {[s.date, s.driver, `${s.clean_laps} laps`, `best ${formatLap(s.best)}`].filter(Boolean).join(' · ')}
            </Text>
          </View>
          {SIDES.map((side) => {
            const on = sideOf[s.id] === side;
            return (
              <Pressable
                key={side}
                onPress={() => toggle(s.id, side)}
                accessibilityRole="checkbox"
                accessibilityState={{ checked: on }}
                accessibilityLabel={`${s.name} in ${names[side] || `group ${side.toUpperCase()}`}`}
                style={StyleSheet.flatten([styles.sideToggle, on && { backgroundColor: colors[side], borderColor: colors[side] }])}>
                <Text style={on ? { color: background, fontWeight: '700' } : { color: tint }}>{side.toUpperCase()}</Text>
              </Pressable>
            );
          })}
        </View>
      ))}
    </View>
  );
}

function Results({ result, colors }: { result: Comparison; colors: Record<Side, string> }) {
  const { labels, summary } = result;
  const biggest = [...result.sections].filter((s) => s.clear).sort((x, y) => Math.abs(y.delta_s) - Math.abs(x.delta_s))[0];
  const [selected, setSelected] = useState<string | null>(biggest?.code ?? result.sections[0]?.code ?? null);
  const [cursor, setCursor] = useState<number | null>(null);
  const ink = useThemeColor({}, 'text');
  const section = result.sections.find((s) => s.code === selected) ?? null;
  const gap = result.median_gap_s;
  const quicker: Side = gap > 0 ? 'b' : 'a';
  const step = result.delta_trace.step_m;
  const distance = useMemo(() => result.delta_trace.gap_s.map((_, i) => i * step), [result, step]);
  const markers = result.sections.map((s) => ({ at: s.anchor_m, label: s.code }));
  const onCursor = useCallback((i: number | null) => setCursor(i), []);

  return (
    <View style={styles.results}>
      <Text style={styles.headline}>
        {Math.abs(gap) < 0.005
          ? `${labels.a} and ${labels.b} are level on a typical lap`
          : `${labels[quicker]} is ${Math.abs(gap).toFixed(2)} s quicker on a typical lap`}
      </Text>
      <Text style={styles.sub}>
        {result.track ?? 'Track not known'} · median lap of each driver over all clean laps
      </Text>
      <View style={styles.kpis}>
        {SIDES.map((side) => (
          <View key={side} style={styles.kpi}>
            <View style={styles.kpiHead}>
              <View style={StyleSheet.flatten([styles.sideDot, { backgroundColor: colors[side] }])} />
              <Text style={styles.kpiName} numberOfLines={1}>
                {labels[side]}
              </Text>
            </View>
            <Text style={styles.kpiValue}>{formatLap(summary[side].median)}</Text>
            <Text style={styles.kpiSub}>median lap</Text>
            <Text style={styles.kpiSub}>
              best {formatLap(summary[side].best)} · {summary[side].laps} laps in {summary[side].runs} runs
            </Text>
            {summary[side].consistency != null && (
              <Text style={styles.kpiSub}>consistency {summary[side].consistency!.toFixed(0)}/100</Text>
            )}
          </View>
        ))}
      </View>
      {result.numbering === 'detected' && <Text style={styles.note}>{DETECTED_CORNERS_NOTE}</Text>}

      <Text style={styles.h2}>Where the time goes</Text>
      <SectionDeltaChart result={result} colors={colors} selected={selected} onSelect={setSelected} />

      {section && (
        <View style={styles.block}>
          <Text style={styles.h2}>{section.code}</Text>
          <Text style={styles.sectionLine}>{sectionWords(section, labels)}.</Text>
          <Text style={styles.sub}>
            Split by what the drivers were doing ({labels.a} against {labels.b}, + = {labels.a} slower):{' '}
            {Object.entries(section.gap_by_phase)
              .filter(([, v]) => Math.abs(v) >= 0.005)
              .map(([p, v]) => `${PHASE_SHORT[p as keyof typeof PHASE_SHORT]} ${seconds(v)}`)
              .join(', ') || 'no difference'}
            .
          </Text>
          <LapStrip result={result} section={section} colors={colors} />
          <Text style={styles.h3}>Technique</Text>
          <TechniqueList result={result} section={section} colors={colors} />
          <Text style={styles.h3}>Habits here</Text>
          <SectionHabits result={result} code={section.code} colors={colors} />
        </View>
      )}

      <Text style={styles.h2}>Along the lap</Text>
      <TraceChart
        title={`Gap, + = ${labels.a} behind`}
        unit="s"
        distance={distance}
        series={[{ values: result.delta_trace.gap_s, color: ink }]}
        cursor={cursor}
        onCursor={onCursor}
        markers={markers}
        zeroLine
      />
      <View style={styles.legendRow}>
        {SIDES.map((side) => (
          <View key={side} style={styles.kpiHead}>
            <View style={StyleSheet.flatten([styles.sideDot, { backgroundColor: colors[side] }])} />
            <Text style={styles.sub}>{labels[side]}</Text>
          </View>
        ))}
      </View>
      <TraceChart
        title="Typical speed"
        unit="km/h"
        distance={distance}
        series={SIDES.map((side) => ({ values: result.speed_trace[side], color: colors[side] }))}
        cursor={cursor}
        onCursor={onCursor}
        markers={markers}
      />
      <Text style={styles.note}>
        Both lines are the median over every clean lap of each driver, metre by metre, from the start/finish line.
      </Text>

      <Text style={styles.h2}>Habits that cost time</Text>
      <Text style={styles.sub}>
        Patterns that repeat over many laps, how often they happen and what they cost against the laps without them.
      </Text>
      {SIDES.map((side) => (
        <HabitList key={side} result={result} side={side} colors={colors} />
      ))}

      <Text style={styles.h2}>Driving style</Text>
      <StyleTable result={result} colors={colors} />

      <Text style={styles.h2}>Runs</Text>
      <View style={styles.runRow}>
        <Text style={StyleSheet.flatten([styles.runName, styles.head])}>Session</Text>
        <Text style={StyleSheet.flatten([styles.runCell, styles.head])}>Clean laps</Text>
        <Text style={StyleSheet.flatten([styles.runCell, styles.head])}>Best</Text>
        <Text style={StyleSheet.flatten([styles.runCell, styles.head])}>Median</Text>
      </View>
      {[...result.runs]
        .sort((x, y) => x.session.localeCompare(y.session, undefined, { numeric: true }))
        .map((r) => (
          <View key={r.run} style={styles.runRow}>
            <View style={StyleSheet.flatten([styles.sideDot, { backgroundColor: colors[r.side] }])} />
            <Text style={styles.runName} numberOfLines={1}>
              {r.session}
            </Text>
            <Text style={styles.runCell}>{r.laps}</Text>
            <Text style={styles.runCell}>{formatLap(r.best)}</Text>
            <Text style={styles.runCell}>{formatLap(r.median)}</Text>
          </View>
        ))}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { padding: 16, gap: 12, maxWidth: 900, width: '100%', alignSelf: 'center' },
  intro: { opacity: 0.7, lineHeight: 20 },
  block: { gap: 8 },
  h2: { fontSize: 18, fontWeight: '700', marginTop: 12 },
  h3: { fontSize: 15, fontWeight: '700', marginTop: 8 },
  sub: { opacity: 0.7, lineHeight: 19 },
  dim: { opacity: 0.5 },
  note: { fontSize: 12, opacity: 0.6, lineHeight: 17 },
  error: { color: '#c8372d' },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, flex: 1 },
  chip: { borderWidth: 1, borderColor: '#8884', borderRadius: 12, paddingHorizontal: 12, paddingVertical: 6 },
  chipSub: { fontSize: 12, opacity: 0.6, fontVariant: ['tabular-nums'] },
  segment: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  sideRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  sideDot: { width: 12, height: 12, borderRadius: 6 },
  sideDotTop: { marginTop: 4 },
  link: { fontSize: 14 },
  names: { flexDirection: 'row', gap: 12, flexWrap: 'wrap' },
  nameBox: { flexDirection: 'row', alignItems: 'center', gap: 8, flex: 1, minWidth: 150 },
  input: { flex: 1, minWidth: 0, borderWidth: 1, borderColor: '#8884', borderRadius: 8, paddingHorizontal: 10, paddingVertical: 8, fontSize: 16 },
  sessionRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 8, borderBottomWidth: 1, borderColor: '#8882' },
  sessionText: { flex: 1, backgroundColor: 'transparent' },
  sessionName: { fontWeight: '600' },
  sideToggle: { width: 40, height: 34, borderRadius: 8, borderWidth: 1, borderColor: '#8884', alignItems: 'center', justifyContent: 'center' },
  button: { borderRadius: 8, padding: 14, alignItems: 'center' },
  disabled: { opacity: 0.5 },
  buttonText: { fontWeight: '600', fontSize: 16, textAlign: 'center' },
  progress: { height: 4, borderRadius: 2, backgroundColor: '#8883', overflow: 'hidden' },
  progressFill: { height: 4 },
  results: { gap: 10, marginTop: 8 },
  headline: { fontSize: 22, fontWeight: '700', lineHeight: 28 },
  kpis: { flexDirection: 'row', gap: 16, flexWrap: 'wrap' },
  kpi: { flex: 1, minWidth: 150, gap: 2 },
  kpiHead: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  kpiName: { fontWeight: '600', flexShrink: 1 },
  kpiValue: { fontSize: 26, fontWeight: '600' },
  kpiSub: { fontSize: 12, opacity: 0.65, fontVariant: ['tabular-nums'] },
  sectionLine: { fontSize: 15, lineHeight: 21 },
  legendRow: { flexDirection: 'row', gap: 16, flexWrap: 'wrap' },
  runRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 6, borderBottomWidth: 1, borderColor: '#8882' },
  runName: { flex: 1 },
  runCell: { width: 72, textAlign: 'right', fontVariant: ['tabular-nums'] },
  head: { fontWeight: '600', opacity: 0.7, fontSize: 13 },
});
