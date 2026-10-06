import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Platform, Pressable, ScrollView, StyleSheet, useWindowDimensions } from 'react-native';

import { Bars, useChartColors } from '@/components/ReportCharts';
import { TechniqueTrace } from '@/components/TechniqueTrace';
import { SessionSwitcher, useEventFolder } from '@/components/SessionSwitcher';
import { Text, View, useThemeColor } from '@/components/Themed';
import { TrackMap } from '@/components/TrackMap';
import { formatLap } from '@/lib/api';
import {
  EventTechnique,
  fetchEventTechnique,
  fetchSessionTechnique,
  Habit,
  habitSize,
  LapCheck,
  Mistake,
  refreshSessionTechnique,
  SessionTechnique,
  working,
} from '@/lib/technique';

const POLL_MS = 2000;
const WIDE = 900;
const CLOSE_UP_M = 150; // metres either side of a mistake in its close-up
const s2 = (v: number) => `${v.toFixed(2)} s`;
const m0 = (v: number) => `${Math.round(v)} m`;
const lower = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);
const HABITS_SHOWN = 6;

/** One lap's driving mistakes against perfect driving, most costly first, what to do instead and what each costs;
 * then how the gap to the perfect lap adds up, the mistakes that repeat across the session and the event, and the
 * lap on the track map and against perfect driving's speed. Opened from a session (?session=) or an event's report
 * (?event=, at the event's quickest lap); ?lap= picks the lap. */
export default function TechniqueScreen() {
  const params = useLocalSearchParams<{ session?: string; event?: string; lap?: string }>();
  const router = useRouter();
  const eventParam = params.event ? Number(params.event) : null;
  const [sessionId, setSessionId] = useState<number | null>(params.session ? Number(params.session) : null);
  const [lap, setLap] = useState<number | null>(params.lap ? Number(params.lap) : null);
  const [answer, setAnswer] = useState<SessionTechnique | null>(null);
  const [ev, setEv] = useState<EventTechnique | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [nonce, setNonce] = useState(0);
  const [selected, setSelected] = useState<number | null>(1);
  const background = useThemeColor({}, 'background');
  const { width } = useWindowDimensions();
  const wide = width >= WIDE;

  // the session's check of one lap; while the server works it out, ask again every couple of seconds
  useEffect(() => {
    if (sessionId == null) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setLoading(true);
    const poll = async () => {
      try {
        const a = await fetchSessionTechnique(sessionId, lap);
        if (!live) return;
        setAnswer(a);
        setError(null);
        setLoading(false);
        if (working(a.status)) timer = setTimeout(poll, POLL_MS);
      } catch (e) {
        if (!live) return;
        setError((e as Error).message);
        setLoading(false);
        timer = setTimeout(poll, POLL_MS * 3);
      }
    };
    poll();
    return () => {
      live = false;
      if (timer) clearTimeout(timer);
    };
  }, [sessionId, lap, nonce]);

  // the event: where to open (its quickest lap) and its other sessions to switch to, by day
  const eventId = eventParam ?? answer?.event?.id ?? null;
  const folder = useEventFolder(eventId ?? (answer ? null : undefined));
  const sessionSettled = sessionId == null || (answer != null && !working(answer.status));
  useEffect(() => {
    if (eventId == null || !sessionSettled) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const a = await fetchEventTechnique(eventId);
        if (!live) return;
        setEv(a);
        if (working(a.status)) timer = setTimeout(poll, POLL_MS);
        else if (a.best) setSessionId((cur) => cur ?? a.best!.session_id);
      } catch (e) {
        if (live) setError((e as Error).message);
      }
    };
    poll();
    return () => {
      live = false;
      if (timer) clearTimeout(timer);
    };
  }, [eventId, sessionSettled, nonce]);

  const check = answer?.lap ?? null;
  useEffect(() => setSelected(check?.mistakes.length ? 1 : null), [check?.key]);

  const pickLap = (n: number) => {
    setLap(n);
    router.setParams({ session: String(sessionId), lap: String(n) });
  };
  const pickSession = (id: number) => {
    if (id === sessionId) return;
    setSessionId(id);
    setLap(null);
    setAnswer(null);
    router.setParams({ session: String(id), lap: undefined });
  };
  const retry = useCallback(async () => {
    if (sessionId == null) return;
    try {
      setAnswer(await refreshSessionTechnique(sessionId));
      setNonce((k) => k + 1);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [sessionId]);

  if (sessionId == null && eventParam == null) {
    return <Text style={styles.pad}>Open the technique check from a session, or from an event&apos;s report.</Text>;
  }
  const head = answer ?? ev;
  const busy = head != null && working(head.status);
  const sessions = ev?.sessions.filter((s) => s.laps > 0) ?? [];
  const mistake = check?.mistakes[(selected ?? 0) - 1] ?? null;

  return (
    <ScrollView style={{ backgroundColor: background }} contentContainerStyle={styles.outer}>
      <Stack.Screen options={{ title: answer ? `Technique check · ${answer.session.name}` : 'Technique check' }} />
      <View style={styles.page}>
        <View style={styles.head}>
          <Text style={styles.h1}>Technique check</Text>
          {answer && (
            <Text style={styles.sub}>
              {answer.session.name}
              {answer.session.driver ? ` · ${answer.session.driver}` : ''}
              {answer.event ? ` · ${answer.event.name}` : ''}
              {answer.track ? ` · ${answer.track}` : ''}
            </Text>
          )}
          <Text style={styles.note}>
            Every mistake on the lap against perfect driving: the lap&apos;s own line driven at the best the car has
            shown at every place of the track, across the {answer?.scope === 'session' ? 'session' : 'whole event'}.
            Each costs what a driver can find: the time against the realistic target, the grip a quick lap usually
            shows at each place.
          </Text>
        </View>

        {!head && !error && <ActivityIndicator />}
        {error && <Text style={styles.error}>Can&apos;t reach the server: {error}</Text>}
        {head && busy && <Progress head={head} />}
        {head?.status === 'failed' && (
          <View style={styles.banner}>
            <Text style={styles.bannerText}>{head.error ?? 'The technique check couldn’t be worked out.'}</Text>
            {sessionId != null && (
              <Pressable accessibilityRole="button" onPress={retry} style={styles.smallButton}>
                <Text style={styles.smallButtonText}>Try again</Text>
              </Pressable>
            )}
          </View>
        )}
        {head?.status === 'empty' && (
          <Text style={styles.note}>No clean laps to check yet. Upload the logs; every clean lap is checked once they
            are imported.</Text>
        )}
        {answer?.stale && check && (
          <Text style={styles.note}>
            This check is from before the sessions last changed; the new one replaces it when it is ready.
          </Text>
        )}

        {folder && folder.id != null && (
          <SessionSwitcher folder={folder} current={sessionId} onlyTimed onPick={(s) => pickSession(s.id)} />
        )}
        {!folder && sessions.length > 1 && (
          <View style={styles.block}>
            <Text style={styles.h4}>Session</Text>
            <View style={styles.chips}>
              {sessions.map((s) => (
                <Chip key={s.id} on={s.id === sessionId} onPress={() => pickSession(s.id)}
                  label={s.name} detail={s.best ? formatLap(s.best.time) : undefined} />
              ))}
            </View>
          </View>
        )}
        {answer && answer.laps.length > 0 && (
          <View style={styles.block}>
            <Text style={styles.h4}>Lap {loading ? '…' : ''}</Text>
            <View style={styles.chips}>
              {answer.laps.map((l) => (
                <Chip key={l.number} on={l.number === check?.number} onPress={() => pickLap(l.number)}
                  label={`${l.number}`} detail={`${formatLap(l.time)}${l.number === answer.best_lap ? ' best' : ''}` +
                    `${l.in_lap ? ' in' : ''}`} />
              ))}
            </View>
            <Text style={styles.note}>Clean laps only: out-laps and in-laps say little about technique.</Text>
          </View>
        )}
        {answer?.lap_note && <Text style={styles.note}>{answer.lap_note}</Text>}

        {check && answer && (
          <>
            <LapSummary check={check} />
            <Section title={check.mistakes.length ? 'Mistakes on this lap, most costly first' : 'Mistakes on this lap'}>
              {check.mistakes.length === 0 && (
                <Text style={styles.note}>
                  No single mistake costs more than 0.02 s on this lap against the realistic target.
                </Text>
              )}
              {check.mistakes.map((m, i) => (
                <MistakeCard key={`${m.key}-${m.start_m}`} n={i + 1} m={m} on={selected === i + 1}
                  onPress={() => setSelected(i + 1)} />
              ))}
            </Section>
            <Section title={`How the ${s2(check.gap)} to perfect driving adds up`}>
              <BudgetView check={check} />
            </Section>
          </>
        )}

        {answer?.habits && <Habits habits={answer.habits} />}

        {check && answer && (
          <Section title="On the track">
            <View style={wide ? styles.row : styles.column}>
              <View style={wide ? styles.half : undefined}>
                <TrackMap {...answer.map} highlight={mistake?.code}
                  marks={check.mistakes.map((m, i) => ({ n: i + 1, at_m: m.at_m, from_m: m.start_m, to_m: m.end_m }))}
                  selectedMark={selected} marksLengthM={answer.length_m} />
              </View>
              {check.trace && mistake && (
                <View style={wide ? styles.half : undefined}>
                  <TechniqueTrace stepM={check.trace.step_m} driven={check.trace.driven} perfect={check.trace.perfect}
                    realistic={check.trace.realistic} bands={bandsOf(check)} selected={selected}
                    onSelect={setSelected} corners={answer.corners ?? []}
                    from={mistake.start_m - CLOSE_UP_M} to={mistake.end_m + CLOSE_UP_M}
                    title={`Close-up of ${selected}. ${mistake.title} (${mistake.code})`} />
                </View>
              )}
            </View>
            {check.trace ? (
              <TechniqueTrace stepM={check.trace.step_m} driven={check.trace.driven} perfect={check.trace.perfect}
                realistic={check.trace.realistic} bands={bandsOf(check)} selected={selected} onSelect={setSelected}
                corners={answer.corners ?? []} height={240} title="Speed over the whole lap" />
            ) : (
              <Text style={styles.note}>The speed trace of this lap isn&apos;t available; refresh to work it out.</Text>
            )}
            <Text style={styles.note}>
              {Platform.OS === 'web' ? 'Hover over' : 'Drag across'} a chart to read the speeds; tap a numbered band or a
              mistake above to see it on the map and close up.
            </Text>
          </Section>
        )}

        {check && (
          <Section title="How this is worked out">
            {METHOD.map((m) => (
              <Text key={m} style={styles.method}>{m}</Text>
            ))}
          </Section>
        )}
      </View>
    </ScrollView>
  );
}


const METHOD = [
  'Perfect driving is the theoretical lap on this lap\'s own line. At every place of the track (every 5 m) it ' +
    'takes the most cornering the car has shown there across the event, and the hardest braking and drive it ' +
    'showed there while cornering that hard (the 90th percentile of the quick laps, never less than the fastest ' +
    'lap), braking at the last moment and back to full throttle as soon as the grip allows. A banked corner keeps ' +
    'its own grip and lends it to no other. Where this lap\'s line asks for more cornering than the quick laps ' +
    'showed (moving across the road to pass or take a tow), it takes what this lap itself showed there. Like ' +
    'the report\'s targets it is measured from the fastest lap: the ' +
    'simulation\'s own error, found by driving the fastest lap at its own limits, is taken out at every metre.',
  'The lap is cut where the driver\'s actions change (lift, brake point, release, slowest point, throttle ' +
    'pick-up, full throttle, any lift on a straight). Each piece costs the time lost from its start to its end, ' +
    'with perfect driving taking over from wherever the driver left the car: so a slow exit is charged with the ' +
    'time it costs all the way down the next straight. The pieces add up to the whole gap.',
  'No lap puts the best of every place together, as the perfect lap does, so each cost is the time against the ' +
    'realistic target (the same lap at the grip a quick lap usually shows at each place, as in the report): the ' +
    'time a driver can find. The rest of the gap, the perfect lap\'s optimism, is shown on its own.',
  'Where the pedals were at the limit (flat out, braking with the ABS working, driving out with the traction ' +
    'control working) and the car still fell short, that is the car on the day, not a mistake. ABS and traction ' +
    'control on their own aren\'t mistakes: the event\'s quicker laps use more of both.',
  'Corners are named by their official numbers only.',
];

const bandsOf = (check: LapCheck) =>
  check.mistakes.map((m, i) => ({ n: i + 1, start_m: m.start_m, end_m: m.end_m, label: `${m.title} (${m.code})` }));

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={styles.section}>
      <Text style={styles.h2}>{title}</Text>
      {children}
    </View>
  );
}

function Chip({ label, detail, on, onPress }: { label: string; detail?: string; on: boolean; onPress: () => void }) {
  const c = useChartColors();
  return (
    <Pressable accessibilityRole="button" accessibilityState={{ selected: on }} onPress={onPress}
      style={StyleSheet.flatten([styles.chip, { borderColor: on ? c.text : c.grid }])}>
      <Text style={StyleSheet.flatten([styles.chipLabel, on && styles.bold])}>{label}</Text>
      {detail ? <Text style={styles.chipDetail}>{detail}</Text> : null}
    </Pressable>
  );
}

function Progress({ head }: { head: SessionTechnique | EventTechnique }) {
  const c = useChartColors();
  const p = head.progress;
  const share = p && p.total ? Math.min(1, p.done / p.total) : 0;
  return (
    <View style={styles.banner}>
      <Text style={styles.bannerText}>
        Checking every clean lap{p?.current ? `: ${p.current}` : '…'}
      </Text>
      <View style={[styles.meter, { backgroundColor: c.grid }]}>
        <View style={[styles.meterFill, { backgroundColor: c.s1, width: `${Math.round(share * 100)}%` }]} />
      </View>
      <Text style={styles.note}>Worked out once for the whole event and kept, so it opens at once next time.</Text>
    </View>
  );
}

function LapSummary({ check }: { check: LapCheck }) {
  const named = check.budget.mistakes;
  return (
    <View style={styles.block}>
      <View style={styles.tiles}>
        <Tile label={`Lap ${check.number}`} value={formatLap(check.time)} detail={check.run} />
        <Tile label="Realistic target" value={formatLap(check.realistic)}
          detail={`${s2(check.time - check.realistic)} to find · a quick lap's usual grip at each place`} />
        <Tile label="Perfect driving" value={formatLap(check.perfect)}
          detail={`${s2(check.gap)} away · the car's best at every place`} />
      </View>
      <Text style={styles.summary}>
        {check.mistakes.length
          ? `${check.mistakes.length} mistake${check.mistakes.length === 1 ? '' : 's'} on this lap cost ${s2(named)} ` +
            `against the realistic target; the biggest: ${lower(check.mistakes[0].title)} in ` +
            `${check.mistakes[0].code} (${s2(check.mistakes[0].cost_s)}).`
          : 'No mistake on this lap costs more than 0.02 s against the realistic target.'}
        {check.pit_from_m != null ? ` The lap ends in the pit lane from ${m0(check.pit_from_m)}.` : ''}
      </Text>
    </View>
  );
}

function Tile({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <View style={styles.tile}>
      <Text style={styles.label}>{label}</Text>
      <Text style={styles.tileValue}>{value}</Text>
      <Text style={styles.note}>{detail}</Text>
    </View>
  );
}

function MistakeCard({ n, m, on, onPress }: { n: number; m: Mistake; on: boolean; onPress: () => void }) {
  const c = useChartColors();
  return (
    <Pressable accessibilityRole="button" accessibilityState={{ selected: on }} onPress={onPress}
      style={StyleSheet.flatten([styles.card, { borderColor: on ? c.text : c.grid }])}>
      <View style={styles.cardHead}>
        <View style={[styles.badge, { backgroundColor: on ? c.text : c.axis }]}>
          <Text style={[styles.badgeText, { color: c.surface }]}>{n}</Text>
        </View>
        <Text style={styles.cardTitle}>{m.title}</Text>
        <Text style={styles.cost}>{s2(m.cost_s)}</Text>
      </View>
      <Text style={styles.meta}>
        {m.code} · {m.phase} · {Math.round(m.start_m)}–{m0(m.end_m)}
      </Text>
      <Text style={styles.what}>{m.what}</Text>
      <Text style={styles.what}>
        <Text style={styles.bold}>Instead: </Text>
        {m.do}
      </Text>
      <Text style={styles.note}>
        {s2(m.cost_s)} against the realistic target, {s2(m.cost_perfect_s)} against perfect driving
        {m.carried_s >= 0.01 ? `; ${s2(m.carried_s)} of it carried on past ${m0(m.end_m)}` : ''}
        {m.repeats ? ` · on ${m.repeats.laps} of the session's ${m.repeats.of} clean laps` : ''}
      </Text>
    </Pressable>
  );
}

function BudgetView({ check }: { check: LapCheck }) {
  const b = check.budget;
  const rows = [
    { label: 'Mistakes', value: b.mistakes },
    { label: 'At the limit', value: b.at_limit },
    { label: 'Optimism', value: b.optimism },
    ...(b.pit_lane > 0 ? [{ label: 'Pit lane', value: b.pit_lane }] : []),
    { label: 'Unexplained', value: b.other },
  ];
  return (
    <View style={styles.block}>
      <Bars rows={rows} max={Math.max(...rows.map((r) => r.value), 0.001)} />
      <Text style={styles.budgetLine}>
        <Text style={styles.bold}>Mistakes {s2(b.mistakes)}</Text>: the {check.mistakes.length} above, against the
        realistic target.
      </Text>
      <Text style={styles.budgetLine}>
        <Text style={styles.bold}>At the limit {s2(b.at_limit)}</Text>: flat out, braking with the ABS working or
        driving out on the traction control, yet slower than perfect driving. The car on the day (tyres, tow, wind),
        not the pedals.
      </Text>
      <Text style={styles.budgetLine}>
        <Text style={styles.bold}>Optimism {s2(b.optimism)}</Text>: perfect driving takes the best the car has
        shown at every place, which no single lap puts together; the realistic target takes what a quick lap usually
        shows there.
      </Text>
      {b.pit_lane > 0 && (
        <Text style={styles.budgetLine}>
          <Text style={styles.bold}>Pit lane {s2(b.pit_lane)}</Text>: the lap ends in the pit lane, from{' '}
          {m0(check.pit_from_m ?? 0)}.
        </Text>
      )}
      <Text style={styles.budgetLine}>
        <Text style={styles.bold}>Unexplained {s2(b.other)}</Text>: losses too small to name or with no clear cause (
        {s2(b.other_losses)}), less the places this lap beat the realistic target ({s2(b.other_gains)}).
      </Text>
    </View>
  );
}

function Habits({ habits }: { habits: NonNullable<SessionTechnique['habits']> }) {
  const [scope, setScope] = useState<'session' | 'event'>('session');
  const [all, setAll] = useState(false);
  const list = (scope === 'event' ? habits.event : habits.session) ?? [];
  const laps = scope === 'event' ? habits.event_laps : habits.session_laps;
  const top = useMemo(() => Math.max(...list.map((h) => h.cost_per_lap_s), 0.001), [list]);
  return (
    <Section title="Mistakes that repeat">
      {habits.event && (
        <View style={styles.chips}>
          <Chip label="This session" detail={`${habits.session_laps} laps`} on={scope === 'session'}
            onPress={() => setScope('session')} />
          <Chip label="The event" detail={`${habits.event_laps} laps`} on={scope === 'event'}
            onPress={() => setScope('event')} />
        </View>
      )}
      <Text style={styles.note}>
        The same mistake in the same place across the {scope === 'event' ? 'event' : 'session'}&apos;s {laps} clean
        laps, most costly per lap first: how often it happens and what it costs a lap on average.
      </Text>
      {list.length === 0 && <Text style={styles.note}>No mistake repeats on two laps or more.</Text>}
      {(all ? list : list.slice(0, HABITS_SHOWN)).map((h) => <HabitRow key={h.key} h={h} top={top} />)}
      {list.length > HABITS_SHOWN && (
        <Pressable accessibilityRole="button" onPress={() => setAll(!all)}>
          <Text style={styles.link}>{all ? 'Show the costliest only' : `Show all ${list.length}`}</Text>
        </Pressable>
      )}
    </Section>
  );
}

function HabitRow({ h, top }: { h: Habit; top: number }) {
  const c = useChartColors();
  const size = habitSize(h);
  return (
    <View style={[styles.habit, { borderColor: c.grid }]}>
      <View style={styles.cardHead}>
        <Text style={styles.habitTitle}>
          {h.title} · {h.code}
        </Text>
        <Text style={styles.cost}>{s2(h.cost_per_lap_s)}</Text>
      </View>
      <View style={[styles.meter, { backgroundColor: c.grid }]}>
        <View style={[styles.meterFill, { backgroundColor: c.s1, width: `${Math.round((h.cost_per_lap_s / top) * 100)}%` }]} />
      </View>
      <Text style={styles.note}>
        On {h.laps} of {h.of} laps ({Math.round(h.share * 100)}%) · {h.phase} · {s2(h.cost_per_lap_s)} a lap on average,{' '}
        {s2(h.cost_when_s)} when it happens{size ? ` · usually ${size}` : ''}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  outer: { paddingVertical: 16, alignItems: 'center' },
  page: { width: '100%', maxWidth: 1100, paddingHorizontal: 16, gap: 20 },
  pad: { padding: 16 },
  head: { gap: 4 },
  h1: { fontSize: 24, fontWeight: '700' },
  h2: { fontSize: 20, fontWeight: '700' },
  h4: { fontSize: 13, fontWeight: '600', opacity: 0.7, textTransform: 'uppercase', letterSpacing: 0.5 },
  sub: { opacity: 0.7 },
  note: { fontSize: 12, opacity: 0.65, lineHeight: 17 },
  error: { color: '#c8372d' },
  row: { flexDirection: 'row', gap: 24, alignItems: 'flex-start' },
  column: { gap: 16 },
  half: { flex: 1, minWidth: 0, gap: 12 },
  block: { gap: 8 },
  section: { gap: 12 },
  banner: { gap: 8, padding: 12, borderRadius: 8, borderWidth: 1, borderColor: '#8884' },
  bannerText: { fontSize: 14 },
  meter: { height: 6, borderRadius: 3, overflow: 'hidden' },
  meterFill: { height: 6, borderRadius: 3 },
  smallButton: { alignSelf: 'flex-start', borderWidth: 1, borderColor: '#8886', borderRadius: 6, paddingHorizontal: 12,
    paddingVertical: 6 },
  smallButtonText: { fontWeight: '600' },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  chip: { borderWidth: 1, borderRadius: 6, paddingHorizontal: 10, paddingVertical: 5, flexDirection: 'row',
    alignItems: 'baseline', gap: 6 },
  chipLabel: { fontSize: 14, fontVariant: ['tabular-nums'] },
  chipDetail: { fontSize: 12, opacity: 0.65, fontVariant: ['tabular-nums'] },
  tiles: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  tile: { flexBasis: 160, flexGrow: 1, gap: 2 },
  label: { fontSize: 12, opacity: 0.65, textTransform: 'uppercase', letterSpacing: 0.5 },
  tileValue: { fontSize: 22, fontWeight: '600', fontVariant: ['tabular-nums'] },
  summary: { fontSize: 15, lineHeight: 21 },
  card: { borderWidth: 1, borderRadius: 10, padding: 14, gap: 6 },
  cardHead: { flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: 'transparent' },
  badge: { width: 22, height: 22, borderRadius: 11, alignItems: 'center', justifyContent: 'center' },
  badgeText: { fontSize: 12, fontWeight: '700' },
  cardTitle: { fontSize: 16, fontWeight: '700', flex: 1 },
  cost: { fontSize: 16, fontWeight: '600', fontVariant: ['tabular-nums'] },
  meta: { fontSize: 13, opacity: 0.7 },
  what: { fontSize: 14, lineHeight: 20 },
  bold: { fontWeight: '700' },
  budgetLine: { fontSize: 13, lineHeight: 19, opacity: 0.85 },
  habit: { gap: 4, paddingVertical: 8, borderBottomWidth: 1 },
  habitTitle: { fontSize: 15, fontWeight: '600', flex: 1 },
  method: { fontSize: 13, lineHeight: 19, opacity: 0.8 },
  link: { fontSize: 13, fontWeight: '600', textDecorationLine: 'underline', paddingVertical: 4 },
});
