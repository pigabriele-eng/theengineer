import { Stack, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, TextInput, TextStyle } from 'react-native';

import {
  Dot,
  HabitList,
  LapStrip,
  SectionDeltaChart,
  SectionHabits,
  sectionWords,
  StyleTable,
  TechniqueList,
} from '@/components/DriverTrends';
import { FigRow, MainAction, Meter, PageHead, Tabs, useText } from '@/components/Picks';
import PrintButton from '@/components/PrintButton';
import { Colophon, Fig, Page, Section, Swatch, TextLink, useWide } from '@/components/Programme';
import { Text, View } from '@/components/Themed';
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
import { face, Fonts, inkOn, themed, Type, useTheme } from '@/constants/Theme';

type Mode = 'drivers' | 'sessions';
const POLL_MS = 1000;
const MAX_POLL_FAILURES = 20;

// Two drivers (or two groups of sessions) at one track and car, over all their clean laps. ?event=<id> opens on the
// track and car of that event's sessions. A page of the race programme: the headline, the two sides to pick, then
// the result in numbered sections.
export default function CompareDriversScreen() {
  const styles = useStyles();
  const t = useText();
  const theme = useTheme();
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

  return (
    <Page>
      <Stack.Screen options={{ title: 'Compare drivers' }} />
      <PageHead title="Compare drivers"
        dek="Two drivers, or two groups of sessions, in the same car at the same track, over all their clean laps: where each gains or loses, how often, the technique behind it and the habits that repeat.">
        <PrintButton title={['Compare drivers', sides ? `${sides.a.label} vs ${sides.b.label}` : null, group?.track]
          .filter(Boolean).join(' · ')} />
      </PageHead>

      {groups == null && !error && <ActivityIndicator color={theme.text} style={styles.loading} />}
      {groups != null && groups.length === 0 && (
        <Text style={StyleSheet.flatten([t.note, styles.loading])}>
          No sessions with clean laps yet. Upload logs on the Sessions page first.
        </Text>
      )}

      {group && sides && (
        <Section no={1} title="The two sides"
          dek={`${group.track ?? 'Track not known'}${group.car ? ` · ${group.car}` : ''} · ${group.sessions.length} sessions · ${group.laps} clean laps`}>
          <View style={styles.block}>
            {groups!.length > 1 && (
              <Tabs label="Track and car" value={groupIdx} onChange={pickGroup}
                items={groups!.map((g, i) => ({ key: i, label: `${g.track ?? 'Track not known'}${g.car ? ` · ${g.car}` : ''}`,
                  sub: `${g.laps} clean laps` }))} />
            )}
            <Tabs big value={mode} onChange={setMode} items={[
              { key: 'drivers', label: 'Two drivers' },
              { key: 'sessions', label: 'Two groups of sessions' },
            ]} />

            {mode === 'drivers' ? (
              <DriverSides group={group} driverOf={driverOf} setDriverOf={setDriverOf} colors={colors} />
            ) : (
              <SessionSides group={group} sideOf={sideOf} setSideOf={setSideOf} names={names} setNames={setNames}
                colors={colors} />
            )}

            <MainAction onPress={start} disabled={!!problem} busy={running}
              label={problem ??
                `Compare ${sides.a.label} and ${sides.b.label} (${sides.a.session_ids.length + sides.b.session_ids.length} sessions)`} />
            {running && job && (
              <View style={styles.progress}>
                <Text style={t.note}>
                  {job.status === 'queued'
                    ? 'Waiting for another comparison to finish…'
                    : job.done >= job.total
                      ? 'Comparing the laps…'
                      : `Reading ${job.current ?? 'the runs'} (${job.done + 1} of ${job.total} runs)…`}
                </Text>
                <Meter share={job.done / Math.max(job.total, 1)} />
              </View>
            )}
          </View>
        </Section>
      )}
      {error && <Text style={StyleSheet.flatten([t.error, styles.loading])}>{error}</Text>}

      {result && <Results key={job?.id} result={result} colors={colors} />}
      <Colophon left="The Engineer · Compare drivers" right={group?.track ?? undefined} />
    </Page>
  );
}

/** A side's key: its colour as a flat block with its letter on it. */
function SideKey({ side, color }: { side: Side; color: string }) {
  const styles = useStyles();
  return (
    <View style={StyleSheet.flatten([styles.sideKey, { backgroundColor: color }])}>
      <Text style={StyleSheet.flatten([styles.sideKeyText, { color: inkOn(color) }])}>{side.toUpperCase()}</Text>
    </View>
  );
}

function DriverSides({ group, driverOf, setDriverOf, colors }: {
  group: OptionGroup;
  driverOf: Partial<Record<Side, number>>;
  setDriverOf: (d: Partial<Record<Side, number>>) => void;
  colors: Record<Side, string>;
}) {
  const styles = useStyles();
  const t = useText();
  const untagged = group.sessions.filter((s) => s.driver_id == null).length;
  return (
    <View style={styles.block}>
      {group.drivers.length < 2 && (
        <Text style={t.note}>
          {group.drivers.length === 0 ? 'No session here has a driver yet.' : 'Only one driver has sessions here.'} Tag the
          sessions with their drivers, or compare two groups of sessions.
        </Text>
      )}
      {group.drivers.length > 0 &&
        SIDES.map((side) => (
          <View key={side} style={styles.sideRow}>
            <SideKey side={side} color={colors[side]} />
            <Tabs style={styles.flex} value={driverOf[side] ?? null}
              onChange={(id) => id != null && setDriverOf({ ...driverOf, [side]: id })}
              items={group.drivers.map((d) => ({ key: d.id as number | null, label: d.name,
                sub: `${d.laps} laps · best ${formatLap(d.best)}` }))} />
          </View>
        ))}
      {untagged > 0 && (
        <TextLink small href="/drivers/tag" arrow
          label={`${untagged} session${untagged === 1 ? '' : 's'} here ${untagged === 1 ? 'has' : 'have'} no driver: tag drivers`} />
      )}
    </View>
  );
}

function SessionSides({ group, sideOf, setSideOf, names, setNames, colors }: {
  group: OptionGroup;
  sideOf: Record<number, Side>;
  setSideOf: (s: Record<number, Side>) => void;
  names: Record<Side, string>;
  setNames: (n: Record<Side, string>) => void;
  colors: Record<Side, string>;
}) {
  const styles = useStyles();
  const t = useText();
  const theme = useTheme();
  const [focused, setFocused] = useState<Side | null>(null);
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
            <View style={styles.nameLabel}>
              <SideKey side={side} color={colors[side]} />
              <Text style={t.label}>Name of group {side.toUpperCase()}</Text>
            </View>
            <TextInput
              value={names[side]}
              onChangeText={(v) => setNames({ ...names, [side]: v })}
              maxLength={120}
              placeholderTextColor={theme.textMuted}
              onFocus={() => setFocused(side)}
              onBlur={() => setFocused((f) => (f === side ? null : f))}
              style={StyleSheet.flatten([styles.input, focused === side && styles.inputFocus])}
              accessibilityLabel={`Name of group ${side.toUpperCase()}`}
            />
          </View>
        ))}
      </View>
      <View>
        <View style={styles.headRow}>
          <Text style={StyleSheet.flatten([styles.th, styles.flex])}>Session</Text>
          <Text style={StyleSheet.flatten([styles.th, styles.sideCol])}>Side</Text>
        </View>
        {group.sessions.map((s) => (
          <View key={s.id} style={styles.sessionRow}>
            <View style={styles.flex}>
              <Text style={styles.sessionName}>{s.name}</Text>
              <Text style={t.labelMuted}>
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
                  <Text style={StyleSheet.flatten([styles.sideToggleText, on && { color: inkOn(colors[side]) }])}>
                    {side.toUpperCase()}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        ))}
      </View>
    </View>
  );
}

function Results({ result, colors }: { result: Comparison; colors: Record<Side, string> }) {
  const styles = useStyles();
  const t = useText();
  const theme = useTheme();
  const wide = useWide();
  const { labels, summary } = result;
  const biggest = [...result.sections].filter((s) => s.clear).sort((x, y) => Math.abs(y.delta_s) - Math.abs(x.delta_s))[0];
  const [selected, setSelected] = useState<string | null>(biggest?.code ?? result.sections[0]?.code ?? null);
  const [cursor, setCursor] = useState<number | null>(null);
  const section = result.sections.find((s) => s.code === selected) ?? null;
  const gap = result.median_gap_s;
  const quicker: Side = gap > 0 ? 'b' : 'a';
  const step = result.delta_trace.step_m;
  const distance = useMemo(() => result.delta_trace.gap_s.map((_, i) => i * step), [result, step]);
  const markers = result.sections.map((s) => ({ at: s.anchor_m, label: s.code }));
  const onCursor = useCallback((i: number | null) => setCursor(i), []);
  let no = 1;
  const next = () => ++no;

  return (
    <>
      <Section no={next()} title="The typical lap"
        dek={`${result.track ?? 'Track not known'} · the median lap of each driver over all their clean laps.`}>
        <Text style={StyleSheet.flatten([styles.headline, wide ? null : styles.headlinePhone])}>
          {Math.abs(gap) < 0.005
            ? `${labels.a} and ${labels.b} are level on a typical lap.`
            : `${labels[quicker]} is ${Math.abs(gap).toFixed(2)} s quicker on a typical lap.`}
        </Text>
        <FigRow style={styles.figs}>
          {SIDES.map((side) => (
            <Fig key={side} label={labels[side]} value={formatLap(summary[side].median)} size={wide ? 76 : 40}
              bar={colors[side]}
              note={`median lap · best ${formatLap(summary[side].best)} · ${summary[side].laps} laps in ${summary[side].runs} runs${
                summary[side].consistency != null ? ` · consistency ${summary[side].consistency!.toFixed(0)}/100` : ''}`} />
          ))}
        </FigRow>
        {result.numbering === 'detected' && <Text style={StyleSheet.flatten([t.note, styles.gapTop])}>{DETECTED_CORNERS_NOTE}</Text>}
      </Section>

      <Section no={next()} title="Where the time goes" dek="Section by section, in lap order: who is quicker, by how much and how often.">
        <View style={styles.narrow}>
          <SectionDeltaChart result={result} colors={colors} selected={selected} onSelect={setSelected} />
        </View>
      </Section>

      {section && (
        <Section no={next()} title={section.code} dek={`${sectionWords(section, labels)}.`}>
          <View style={styles.block}>
            <Text style={StyleSheet.flatten([t.body, styles.narrow])}>
              Split by what the drivers were doing ({labels.a} against {labels.b}, + = {labels.a} slower):{' '}
              {Object.entries(section.gap_by_phase)
                .filter(([, v]) => Math.abs(v) >= 0.005)
                .map(([p, v]) => `${PHASE_SHORT[p as keyof typeof PHASE_SHORT]} ${seconds(v)}`)
                .join(', ') || 'no difference'}
              .
            </Text>
            <Text style={t.sub}>Every lap in {section.code}</Text>
            <LapStrip result={result} section={section} colors={colors} />
            <View style={wide ? styles.twoCols : styles.block}>
              <View style={wide ? styles.col : undefined}>
                <Text style={StyleSheet.flatten([t.sub, styles.subGap])}>Technique</Text>
                <TechniqueList result={result} section={section} colors={colors} />
              </View>
              <View style={wide ? styles.col : styles.block}>
                <Text style={StyleSheet.flatten([t.sub, styles.subGap])}>Habits here</Text>
                <SectionHabits result={result} code={section.code} colors={colors} />
              </View>
            </View>
          </View>
        </Section>
      )}

      <Section no={next()} title="Along the lap" dek="Both lines are the median over every clean lap of each driver, metre by metre, from the start/finish line.">
        <View style={styles.charts}>
          <TraceChart
            title={`Gap, + = ${labels.a} behind`}
            unit="s"
            distance={distance}
            series={[{ values: result.delta_trace.gap_s, color: theme.chart.ink }]}
            cursor={cursor}
            onCursor={onCursor}
            markers={markers}
            zeroLine
          />
          <View style={styles.legendRow}>
            {SIDES.map((side) => (
              <Swatch key={side} color={colors[side]} label={labels[side]} width={14} height={4} />
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
        </View>
      </Section>

      <Section no={next()} title="Habits that cost time"
        dek="Patterns that repeat over many laps, how often they happen and what they cost against the laps without them.">
        <View style={wide ? styles.twoCols : styles.block}>
          {SIDES.map((side) => (
            <View key={side} style={wide ? styles.col : undefined}>
              <HabitList result={result} side={side} colors={colors} />
            </View>
          ))}
        </View>
      </Section>

      <Section no={next()} title="Driving style" dek="Lap-wide habits, the median lap of each driver.">
        <StyleTable result={result} colors={colors} />
      </Section>

      <Section no={next()} title="Runs" dek="The runs on each side.">
        <View style={styles.runs}>
          <View style={styles.headRow}>
            <View style={styles.runKey} />
            <Text style={StyleSheet.flatten([styles.th, styles.flex])}>Session</Text>
            <Text style={StyleSheet.flatten([styles.th, styles.runCell])}>Clean laps</Text>
            <Text style={StyleSheet.flatten([styles.th, styles.runCell])}>Best</Text>
            <Text style={StyleSheet.flatten([styles.th, styles.runCell])}>Median</Text>
          </View>
          {[...result.runs]
            .sort((x, y) => x.session.localeCompare(y.session, undefined, { numeric: true }))
            .map((r) => (
              <View key={r.run} style={styles.runRow}>
                <View style={styles.runKey}><Dot color={colors[r.side]} /></View>
                <Text style={StyleSheet.flatten([styles.runName, styles.flex])} numberOfLines={1}>
                  {r.session}
                </Text>
                <Text style={styles.runCell}>{r.laps}</Text>
                <Text style={styles.runCell}>{formatLap(r.best)}</Text>
                <Text style={styles.runCell}>{formatLap(r.median)}</Text>
              </View>
            ))}
        </View>
      </Section>
    </>
  );
}

const useStyles = themed((c) => ({
  loading: { marginTop: 24, alignSelf: 'flex-start' },
  block: { gap: 16 },
  flex: { flex: 1, minWidth: 0 },
  narrow: { maxWidth: 820 },
  gapTop: { marginTop: 12 },
  sideRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 14 },
  sideKey: { width: 26, height: 26, alignItems: 'center', justifyContent: 'center' },
  sideKeyText: { fontFamily: Fonts.display, fontSize: 15, lineHeight: 18 },
  names: { flexDirection: 'row', columnGap: 24, rowGap: 14, flexWrap: 'wrap' },
  nameBox: { flex: 1, minWidth: 220, gap: 6 },
  nameLabel: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  // the browser's own focus ring is rounded: the rule turns red instead
  input: { fontFamily: Fonts.body, fontSize: 17, color: c.text, borderBottomWidth: 2, borderColor: c.rule,
    paddingVertical: 6, paddingHorizontal: 0, outlineWidth: 0 } as TextStyle,
  inputFocus: { borderColor: c.mark },
  headRow: { flexDirection: 'row', alignItems: 'flex-end', gap: 8, borderBottomWidth: 1, borderColor: c.rule,
    paddingBottom: 5 },
  th: { ...Type.label, fontSize: 11, color: c.text },
  sideCol: { width: 88, textAlign: 'center' },
  sessionRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 8, borderBottomWidth: 1,
    borderColor: c.separator },
  sessionName: { fontFamily: face('body', 600), fontSize: 16, color: c.text },
  sideToggle: { width: 40, height: 36, borderWidth: 1, borderColor: c.rule, alignItems: 'center', justifyContent: 'center' },
  sideToggleText: { fontFamily: Fonts.display, fontSize: 16, lineHeight: 19, color: c.text },
  progress: { gap: 8, maxWidth: 640 },
  headline: { fontFamily: face('body', 600), fontSize: 26, lineHeight: 34, color: c.text, maxWidth: 860 },
  headlinePhone: { fontSize: 21, lineHeight: 28 },
  figs: { marginTop: 18 },
  twoCols: { flexDirection: 'row', gap: 32, alignItems: 'flex-start' },
  col: { flex: 1, minWidth: 0, gap: 10 },
  subGap: { marginBottom: 4 },
  charts: { gap: 14 },
  legendRow: { flexDirection: 'row', columnGap: 22, rowGap: 8, flexWrap: 'wrap' },
  runs: { maxWidth: 760 },
  runRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 8, borderBottomWidth: 1,
    borderColor: c.separator },
  runKey: { width: 14 },
  runName: { fontFamily: Fonts.body, fontSize: 15, color: c.text },
  runCell: { ...Type.number, width: 76, textAlign: 'right', fontSize: 14, color: c.text },
}));
