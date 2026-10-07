import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Platform, Pressable, StyleSheet, useWindowDimensions } from 'react-native';

import { Choice, FigRow, Meter, Notice, PageHead, Tabs, useText } from '@/components/Picks';
import PrintButton from '@/components/PrintButton';
import { Colophon, Fig, Label, Page, Section, TextLink, useWide } from '@/components/Programme';
import { Bars } from '@/components/ReportCharts';
import { SessionSwitcher, useEventFolder } from '@/components/SessionSwitcher';
import { TechniqueInputs } from '@/components/TechniqueInputs';
import { TechniqueTrace } from '@/components/TechniqueTrace';
import { Text, View } from '@/components/Themed';
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
  ObviousMistake,
  refreshSessionTechnique,
  SessionTechnique,
  working,
} from '@/lib/technique';
import { deltaColor, face, Fonts, phaseColor, themed, Type, useTheme } from '@/constants/Theme';

const POLL_MS = 2000;
const SIDE_BY_SIDE = 900; // from this wide the map and the close-up sit side by side
const CLOSE_UP_M = 150; // metres either side of a mistake in its close-up
const s2 = (v: number) => `${v.toFixed(2)} s`;
const m0 = (v: number) => `${Math.round(v)} m`;
const lower = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);
const HABITS_SHOWN = 6;

/** One lap's driving mistakes against perfect driving, most costly first, what to do instead and what each costs;
 * then how the gap to the perfect lap adds up, the mistakes that repeat across the session and the event, and the
 * lap on the track map and against perfect driving's speed. Opened from a session (?session=) or an event's report
 * (?event=, at the event's quickest lap); ?lap= picks the lap. A page of the race programme: the headline, the lap's
 * big figures, then numbered sections. */
export default function TechniqueScreen() {
  const t = useText();
  const styles = useStyles();
  const theme = useTheme();
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
  const { width } = useWindowDimensions();
  const sideBySide = width >= SIDE_BY_SIDE;

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
    return (
      <Page>
        <PageHead title="Technique check" dek="Open the technique check from a session, or from an event's report." />
      </Page>
    );
  }
  const head = answer ?? ev;
  const busy = head != null && working(head.status);
  const sessions = ev?.sessions.filter((s) => s.laps > 0) ?? [];
  const dek = answer
    ? [answer.session.name, answer.session.driver, answer.event?.name, answer.track].filter(Boolean).join(' · ')
    : 'Every mistake on a lap against perfect driving, and what each costs.';
  // the sections are numbered in the order they are shown
  let no = 0;
  const next = () => ++no;

  return (
    <Page>
      <Stack.Screen options={{ title: answer ? `Technique check · ${answer.session.name}` : 'Technique check' }} />
      <PageHead title="Technique check" dek={dek}>
        <PrintButton title={['Technique check', answer?.session.name].filter(Boolean).join(' · ')} />
      </PageHead>
      <Text style={StyleSheet.flatten([t.note, styles.intro])}>
        Every mistake on the lap against perfect driving: the lap&apos;s own line driven at the best the car has shown
        at every place of the track, across the {answer?.scope === 'session' ? 'session' : 'whole event'}. Each costs
        what a driver can find: the time against the realistic target, the grip a quick lap usually shows at each place.
      </Text>

      <View style={styles.states}>
        {!head && !error && <ActivityIndicator color={theme.text} style={styles.left} />}
        {error && <Text style={t.error}>Can&apos;t reach the server: {error}</Text>}
        {head && busy && <Progress head={head} />}
        {head?.status === 'failed' && (
          <Notice>
            <Text style={t.body}>{head.error ?? 'The technique check couldn’t be worked out.'}</Text>
            {sessionId != null && <TextLink label="Try again" onPress={retry} red />}
          </Notice>
        )}
        {head?.status === 'empty' && (
          <Text style={t.note}>No clean laps to check yet. Upload the logs; every clean lap is checked once they are
            imported.</Text>
        )}
        {answer?.stale && check && (
          <Text style={t.note}>
            This check is from before the sessions last changed; the new one replaces it when it is ready.
          </Text>
        )}
      </View>

      <View style={styles.pickers}>
        {folder && folder.id != null && (
          <SessionSwitcher folder={folder} current={sessionId} onlyTimed onPick={(s) => pickSession(s.id)} />
        )}
        {!folder && sessions.length > 1 && (
          <Tabs label="Session" value={sessionId} onChange={(id) => id != null && pickSession(id)}
            items={sessions.map((s) => ({ key: s.id as number | null, label: s.name,
              sub: s.best ? formatLap(s.best.time) : undefined }))} />
        )}
        {answer && answer.laps.length > 0 && (
          <View style={styles.lapBlock}>
            <View style={styles.lapHead}>
              <Label small>Lap</Label>
              {loading && <ActivityIndicator size="small" color={theme.text} />}
            </View>
            <View style={styles.laps}>
              {answer.laps.map((l) => {
                const best = l.number === answer.best_lap;
                return (
                  <Choice key={l.number} on={l.number === check?.number} onPress={() => pickLap(l.number)}
                    label={`${l.number}`} detail={`${formatLap(l.time)}${l.in_lap ? ' in' : ''}`}
                    fill={best ? theme.timing.best : undefined} ink={best ? theme.timing.onBest : undefined}
                    dim={l.in_lap}
                    accessibilityLabel={`Lap ${l.number}, ${formatLap(l.time)}${best ? ', the quickest' : ''}`} />
                );
              })}
            </View>
            <Text style={t.small}>
              Clean laps only: out-laps and in-laps say little about technique.
              {answer.best_lap != null ? ' The quickest lap’s time is in purple.' : ''}
            </Text>
          </View>
        )}
        {answer?.lap_note && <Text style={t.note}>{answer.lap_note}</Text>}
      </View>

      {check && answer && <LapSummary check={check} />}

      {check && answer && !!check.obvious?.length && (
        <Section no={next()} title="Obvious mistakes"
          dek="Wrong whatever the target: what happened in each corner, what to do instead and what it alone cost.">
          {check.obvious.map((m, i) => (
            <ObviousRow key={`${m.key}-${m.start_m}`} m={m} first={i === 0} />
          ))}
        </Section>
      )}

      {check && answer && (
        <Section no={next()} title="Mistakes on this lap"
          dek={check.mistakes.length
            ? 'Most costly first: what happened, what to do instead and what it costs. Tap one to find it on the map.'
            : undefined}>
          {check.mistakes.length === 0 && (
            <Text style={t.note}>No single mistake costs more than 0.02 s on this lap against the realistic target.</Text>
          )}
          {check.mistakes.map((m, i) => (
            <MistakeRow key={`${m.key}-${m.start_m}`} n={i + 1} m={m} on={selected === i + 1} first={i === 0}
              onPress={() => setSelected(i + 1)} />
          ))}
        </Section>
      )}

      {check && answer && (
        <Section no={next()} title="The gap" dek={`How the ${s2(check.gap)} to perfect driving adds up.`}>
          <BudgetView check={check} />
        </Section>
      )}

      {answer?.habits && <Habits habits={answer.habits} no={next()} />}

      {check && answer && (
        <Section no={next()} title="On the track"
          dek="The lap on the map and against perfect driving's speed, the picked mistake close up, then the driver's inputs.">
          <OnTheTrack answer={answer} check={check} selected={selected} onSelect={setSelected} sideBySide={sideBySide} />
        </Section>
      )}

      {check && (
        <Section no={next()} title="How this is worked out">
          <View style={styles.method}>
            {METHOD.map((m) => (
              <Text key={m} style={t.body}>{m}</Text>
            ))}
          </View>
        </Section>
      )}

      <Colophon left="The Engineer · Technique check"
        right={answer ? [answer.session.name, answer.track].filter(Boolean).join(' · ') : undefined} />
    </Page>
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
  'Obvious mistakes are wrong whatever the target: a lift on the way out of a corner (not a lift for the next ' +
    'corner, nor balancing the car at its grip limit), the power stepped on so early or so hard that the car forced ' +
    'a lift or a steering correction, and braking in a straight line, with no cornering to share the grip, below ' +
    'the deceleration the car has shown there. Each costs what it alone lost: the speed a lift took off, carried ' +
    'down the straight, or the later braking point missed. Under 0.01 s they are left out.',
  'Shift points come from the event\'s own logs: each gear\'s ratio (engine revs per km/h) and the engine\'s ' +
    'torque at full throttle (the logger\'s engine torque channel), as the car\'s ratios and torque curve are not ' +
    'published. Drive force is torque times the ratio, so the best upshift is where the next gear drives harder, or ' +
    'just short of the rev limiter where it never does. An upshift 150 rpm or more before that is early; after it, ' +
    'or held on the limiter, late. Each costs the drive it missed, carried down the straight.',
  'The perfect lap is never quicker through a section than the best pass a lap has really made there.',
  'Corners are named by their official numbers only.',
];

/** The lap on the map and against perfect driving's speed (a close-up of the picked mistake, then the whole lap), with
 * the driver's inputs under the whole lap's speed. One cursor runs through every chart. */
function OnTheTrack({ answer, check, selected, onSelect, sideBySide }: { answer: SessionTechnique; check: LapCheck;
  selected: number | null; onSelect: (n: number) => void; sideBySide: boolean }) {
  const t = useText();
  const styles = useStyles();
  const [cursor, setCursor] = useState<number | null>(null);
  const mistake = check.mistakes[(selected ?? 0) - 1] ?? null;
  const bands = useMemo(() => bandsOf(check), [check]);
  // the map doesn't follow the cursor: kept as it is while the charts are scrubbed
  const map = useMemo(() => (
    <TrackMap {...answer.map} highlight={mistake?.code}
      marks={check.mistakes.map((m, i) => ({ n: i + 1, at_m: m.at_m, from_m: m.start_m, to_m: m.end_m }))}
      selectedMark={selected} marksLengthM={answer.length_m} />
  ), [answer.map, answer.length_m, check, mistake?.code, selected]);
  const tr = check.trace;
  const corners = answer.corners ?? [];
  const fastest = check.fastest;
  const scope = answer.scope === 'event' ? 'event' : 'session';
  return (
    <View style={styles.track}>
      <View style={sideBySide ? styles.row : styles.column}>
        <View style={sideBySide ? styles.half : undefined}>{map}</View>
        {tr && mistake && (
          <View style={sideBySide ? styles.half : undefined}>
            <TechniqueTrace stepM={tr.step_m} driven={tr.driven} perfect={tr.perfect} realistic={tr.realistic}
              bands={bands} selected={selected} onSelect={onSelect} corners={corners}
              from={mistake.start_m - CLOSE_UP_M} to={mistake.end_m + CLOSE_UP_M}
              title={`Close-up of ${selected}. ${mistake.title} (${mistake.code})`} cursor={cursor} onCursor={setCursor} />
          </View>
        )}
      </View>
      {tr ? (
        <TechniqueTrace stepM={tr.step_m} driven={tr.driven} perfect={tr.perfect} realistic={tr.realistic}
          bands={bands} selected={selected} onSelect={onSelect} corners={corners} height={sideBySide ? 260 : 240}
          title="Speed over the whole lap" cursor={cursor} onCursor={setCursor} />
      ) : (
        <Text style={t.note}>The speed trace of this lap isn&apos;t available; refresh to work it out.</Text>
      )}
      {tr && (
        <View style={styles.inputs}>
          <Text style={styles.subhead}>The driver&apos;s inputs</Text>
          {fastest?.this_lap && (
            <Text style={t.note}>
              This is the {scope}&apos;s fastest lap, the one the report measures from: there is no quicker lap to lay
              under it.
            </Text>
          )}
          {tr.inputs ? (
            <TechniqueInputs stepM={tr.step_m} points={tr.driven.length} inputs={tr.inputs}
              fastest={fastest && !fastest.this_lap ? fastest.inputs : null}
              fastestLabel={fastest && !fastest.this_lap
                ? `Fastest lap: ${fastest.run} L${fastest.number} · ${formatLap(fastest.time)}` : null}
              phases={tr.model_phases} channels={answer.inputs} bands={bands} selected={selected} onSelect={onSelect}
              corners={corners} cursor={cursor} onCursor={setCursor} tall={sideBySide} />
          ) : (
            <Text style={t.note}>This lap&apos;s inputs come with the new check, worked out in the background.</Text>
          )}
        </View>
      )}
      <Text style={t.small}>
        {Platform.OS === 'web' ? 'Hover over' : 'Drag across'} a chart to read the speeds and inputs at that point on
        every chart; tap a numbered band or a mistake above to see it on the map and close up.
      </Text>
    </View>
  );
}

const bandsOf = (check: LapCheck) =>
  check.mistakes.map((m, i) => ({ n: i + 1, start_m: m.start_m, end_m: m.end_m, label: `${m.title} (${m.code})`,
    phase: m.phase }));

function Progress({ head }: { head: SessionTechnique | EventTechnique }) {
  const t = useText();
  const p = head.progress;
  const share = p && p.total ? Math.min(1, p.done / p.total) : 0;
  return (
    <Notice busy>
      <Text style={t.label}>
        Checking every clean lap{p?.total ? ` · ${p.done} of ${p.total}` : ''}
      </Text>
      {p?.current ? <Text style={t.body}>{p.current}</Text> : null}
      <Meter share={share} />
      <Text style={t.small}>Worked out once for the whole event and kept, so it opens at once next time.</Text>
    </Notice>
  );
}

function LapSummary({ check }: { check: LapCheck }) {
  const t = useText();
  const theme = useTheme();
  const wide = useWide();
  const styles = useStyles();
  const named = check.budget.mistakes;
  const size = wide ? 76 : 44;
  return (
    <View style={styles.summary}>
      <FigRow>
        {[
          <Fig key="lap" label={`Lap ${check.number}`} value={formatLap(check.time)} size={size} bar={theme.rule}
            note={check.run} />,
          <Fig key="real" label="Realistic target" value={formatLap(check.realistic)} size={size}
            bar={theme.timing.personal}
            note={`${s2(check.time - check.realistic)} to find · a quick lap's usual grip at each place`} />,
          <Fig key="perfect" label="Perfect driving" value={formatLap(check.perfect)} size={size} bar={theme.timing.best}
            note={`${s2(check.gap)} away · the car's best at every place`} />,
        ]}
      </FigRow>
      <Text style={StyleSheet.flatten([t.lead, styles.measure])}>
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

/** A mistake: its number in an ink block (red when picked), what it is, where and in which phase, its cost as a
 * figure, then what happened and what to do instead. */
function MistakeRow({ n, m, on, first, onPress }: { n: number; m: Mistake; on: boolean; first: boolean;
  onPress: () => void }) {
  const t = useText();
  const theme = useTheme();
  const wide = useWide();
  const styles = useStyles();
  return (
    <Pressable accessibilityRole="button" accessibilityState={{ selected: on }} onPress={onPress}
      style={StyleSheet.flatten([styles.mistake, !first && styles.mistakeRule, on && styles.mistakeOn])}>
      <View style={styles.mistakeHead}>
        <View style={StyleSheet.flatten([styles.no, on && styles.noOn])}>
          <Text style={styles.noText}>{n}</Text>
        </View>
        <View style={styles.flex}>
          <Text style={styles.mistakeTitle}>{m.title}</Text>
          <View style={styles.meta}>
            <View style={StyleSheet.flatten([styles.phaseKey, { backgroundColor: phaseColor(theme, m.phase) }])} />
            <Text style={styles.metaText}>
              {m.code} · {m.phase} · {Math.round(m.start_m)}–{m0(m.end_m)}
            </Text>
          </View>
        </View>
        <Text style={StyleSheet.flatten([styles.cost, { color: deltaColor(theme, m.cost_s) ?? theme.text }])}>
          {m.cost_s.toFixed(2)}
          <Text style={StyleSheet.flatten([styles.costUnit, { color: deltaColor(theme, m.cost_s) ?? theme.text }])}> s</Text>
        </Text>
      </View>
      <View style={wide ? styles.mistakeBody : styles.mistakeBodyPhone}>
        <Text style={t.body}>{m.what}</Text>
        <Text style={t.body}>
          <Text style={t.strong}>Instead: </Text>
          {m.do}
        </Text>
        <Text style={t.small}>
          {s2(m.cost_s)} against the realistic target, {s2(m.cost_perfect_s)} against perfect driving
          {m.carried_s >= 0.01 ? `; ${s2(m.carried_s)} of it carried on past ${m0(m.end_m)}` : ''}
          {m.repeats ? ` · on ${m.repeats.laps} of the session's ${m.repeats.of} clean laps` : ''}
        </Text>
      </View>
    </Pressable>
  );
}

/** An obvious mistake, in the mistake rows' style: an exclamation in the ink block, what it is and where, its cost,
 * then what happened and what to do instead. */
function ObviousRow({ m, first }: { m: ObviousMistake; first: boolean }) {
  const t = useText();
  const theme = useTheme();
  const wide = useWide();
  const styles = useStyles();
  return (
    <View style={StyleSheet.flatten([styles.mistake, !first && styles.mistakeRule])}>
      <View style={styles.mistakeHead}>
        <View style={StyleSheet.flatten([styles.no, styles.noOn])}>
          <Text style={styles.noText}>!</Text>
        </View>
        <View style={styles.flex}>
          <Text style={styles.mistakeTitle}>{m.title}</Text>
          <View style={styles.meta}>
            <View style={StyleSheet.flatten([styles.phaseKey, { backgroundColor: phaseColor(theme, m.phase) }])} />
            <Text style={styles.metaText}>
              {m.code} · {m.phase} · {Math.round(m.start_m)}–{m0(m.end_m)}
            </Text>
          </View>
        </View>
        <Text style={StyleSheet.flatten([styles.cost, { color: deltaColor(theme, m.cost_s) ?? theme.text }])}>
          {m.cost_s.toFixed(2)}
          <Text style={StyleSheet.flatten([styles.costUnit, { color: deltaColor(theme, m.cost_s) ?? theme.text }])}> s</Text>
        </Text>
      </View>
      <View style={wide ? styles.mistakeBody : styles.mistakeBodyPhone}>
        <Text style={t.body}>{m.what}</Text>
        <Text style={t.body}>
          <Text style={t.strong}>Instead: </Text>
          {m.do}
        </Text>
      </View>
    </View>
  );
}

function BudgetView({ check }: { check: LapCheck }) {
  const t = useText();
  const styles = useStyles();
  const wide = useWide();
  const b = check.budget;
  const rows = [
    { label: 'Mistakes', value: b.mistakes },
    { label: 'At the limit', value: b.at_limit },
    { label: 'Optimism', value: b.optimism },
    ...(b.pit_lane > 0 ? [{ label: 'Pit lane', value: b.pit_lane }] : []),
    { label: 'Unexplained', value: b.other },
  ];
  const words: { label: string; value: number; text: string }[] = [
    { label: 'Mistakes', value: b.mistakes,
      text: `the ${check.mistakes.length} above, against the realistic target.` },
    { label: 'At the limit', value: b.at_limit,
      text: 'flat out, braking with the ABS working or driving out on the traction control, yet slower than perfect ' +
        'driving. The car on the day (tyres, tow, wind), not the pedals.' },
    { label: 'Optimism', value: b.optimism,
      text: 'perfect driving takes the best the car has shown at every place, which no single lap puts together; the ' +
        'realistic target takes what a quick lap usually shows there.' },
    ...(b.pit_lane > 0 ? [{ label: 'Pit lane', value: b.pit_lane,
      text: `the lap ends in the pit lane, from ${m0(check.pit_from_m ?? 0)}.` }] : []),
    { label: 'Unexplained', value: b.other,
      text: `losses too small to name or with no clear cause (${s2(b.other_losses)}), less the places this lap beat ` +
        `the realistic target (${s2(b.other_gains)}).` },
  ];
  return (
    <View style={wide ? styles.budget : styles.budgetPhone}>
      <View style={wide ? styles.budgetBars : undefined}>
        <Text style={styles.subhead}>Time against perfect driving, s</Text>
        <Bars rows={rows} max={Math.max(...rows.map((r) => r.value), 0.001)} />
      </View>
      <View style={wide ? styles.budgetWords : undefined}>
        {words.map((w, i) => (
          <View key={w.label} style={StyleSheet.flatten([styles.term, i === 0 && styles.termFirst])}>
            <View style={styles.termHead}>
              <Text style={t.label}>{w.label}</Text>
              <Text style={styles.termValue}>{s2(w.value)}</Text>
            </View>
            <Text style={t.note}>{w.text.charAt(0).toUpperCase() + w.text.slice(1)}</Text>
          </View>
        ))}
      </View>
    </View>
  );
}

function Habits({ habits, no }: { habits: NonNullable<SessionTechnique['habits']>; no: number }) {
  const t = useText();
  const styles = useStyles();
  const [scope, setScope] = useState<'session' | 'event'>('session');
  const [all, setAll] = useState(false);
  const list = (scope === 'event' ? habits.event : habits.session) ?? [];
  const laps = scope === 'event' ? habits.event_laps : habits.session_laps;
  const top = useMemo(() => Math.max(...list.map((h) => h.cost_per_lap_s), 0.001), [list]);
  return (
    <Section no={no} title="Mistakes that repeat"
      dek={`The same mistake in the same place across the ${scope === 'event' ? 'event' : 'session'}'s ${laps} clean laps, most costly per lap first.`}>
      {habits.event && (
        <Tabs big value={scope} onChange={setScope} style={styles.habitTabs}
          items={[
            { key: 'session', label: 'This session', sub: `${habits.session_laps} laps` },
            { key: 'event', label: 'The event', sub: `${habits.event_laps} laps` },
          ]} />
      )}
      {list.length === 0 && <Text style={t.note}>No mistake repeats on two laps or more.</Text>}
      {list.length > 0 && (
        <View style={styles.habitHead}>
          <Text style={StyleSheet.flatten([t.label, styles.flex])}>Mistake</Text>
          <Text style={t.label}>A lap, on average</Text>
        </View>
      )}
      {(all ? list : list.slice(0, HABITS_SHOWN)).map((h) => <HabitRow key={h.key} h={h} top={top} />)}
      {list.length > HABITS_SHOWN && (
        <View style={styles.more}>
          <TextLink small label={all ? 'Show the costliest only' : `Show all ${list.length}`} onPress={() => setAll(!all)} />
        </View>
      )}
    </Section>
  );
}

function HabitRow({ h, top }: { h: Habit; top: number }) {
  const t = useText();
  const theme = useTheme();
  const styles = useStyles();
  const size = habitSize(h);
  return (
    <View style={styles.habit}>
      <View style={styles.habitLine}>
        <View style={StyleSheet.flatten([styles.phaseKey, { backgroundColor: phaseColor(theme, h.phase) }])} />
        <Text style={styles.habitTitle}>
          {h.title} · {h.code}
        </Text>
        <Text style={styles.habitCost}>{s2(h.cost_per_lap_s)}</Text>
      </View>
      <Meter share={h.cost_per_lap_s / top} color={theme.delta.loss} height={8} />
      <Text style={t.small}>
        On {h.laps} of {h.of} laps ({Math.round(h.share * 100)}%) · {h.phase} · {s2(h.cost_when_s)} when it happens
        {size ? ` · usually ${size}` : ''}
      </Text>
    </View>
  );
}

const useStyles = themed((c) => ({
  intro: { marginTop: 12, maxWidth: 760 },
  states: { gap: 10, marginTop: 14 },
  left: { alignSelf: 'flex-start' },
  pickers: { gap: 18, marginTop: 10 },
  lapBlock: { gap: 8 },
  lapHead: { flexDirection: 'row', alignItems: 'center', gap: 10, borderBottomWidth: 1, borderColor: c.rule,
    paddingBottom: 5 },
  laps: { flexDirection: 'row', flexWrap: 'wrap', columnGap: 14, rowGap: 10 },
  flex: { flex: 1, minWidth: 0 },
  measure: { maxWidth: 820 },
  summary: { marginTop: 30, gap: 18 },
  mistake: { paddingVertical: 14, gap: 10 },
  mistakeRule: { borderTopWidth: 1, borderColor: c.separator },
  mistakeOn: { backgroundColor: c.surfaceRaised, marginHorizontal: -10, paddingHorizontal: 10 },
  mistakeHead: { flexDirection: 'row', alignItems: 'flex-start', gap: 12 },
  no: { backgroundColor: c.rule, minWidth: 30, paddingHorizontal: 6, paddingTop: 4, paddingBottom: 3, alignItems: 'center' },
  noOn: { backgroundColor: c.mark },
  noText: { fontFamily: Fonts.display, fontSize: 18, lineHeight: 21, color: c.background },
  mistakeTitle: { fontFamily: face('body', 600), fontSize: 19, lineHeight: 25, color: c.text },
  meta: { flexDirection: 'row', alignItems: 'center', gap: 7, marginTop: 4 },
  phaseKey: { width: 12, height: 12 },
  metaText: { ...Type.label, fontSize: 11, letterSpacing: 1, color: c.textSecondary, flexShrink: 1 },
  cost: { fontFamily: Fonts.display, fontSize: 32, lineHeight: 34 },
  costUnit: { fontFamily: Fonts.display, fontSize: 15 },
  mistakeBody: { marginLeft: 42, gap: 6, maxWidth: 780 },
  mistakeBodyPhone: { gap: 6 },
  budget: { flexDirection: 'row', gap: 32, alignItems: 'flex-start' },
  budgetPhone: { gap: 18 },
  budgetBars: { flex: 5, minWidth: 0 },
  budgetWords: { flex: 6, minWidth: 0 },
  subhead: { ...Type.label, color: c.text, borderBottomWidth: 1, borderColor: c.rule, paddingBottom: 5, marginBottom: 8 },
  term: { paddingVertical: 9, borderTopWidth: 1, borderColor: c.separator, gap: 3 },
  termFirst: { borderTopWidth: 1, borderColor: c.rule },
  termHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 },
  termValue: { ...Type.number, fontSize: 15, color: c.text },
  habitTabs: { marginBottom: 14 },
  habitHead: { flexDirection: 'row', gap: 8, borderBottomWidth: 1, borderColor: c.rule, paddingBottom: 5 },
  habit: { gap: 6, paddingVertical: 10, borderBottomWidth: 1, borderColor: c.separator },
  habitLine: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  habitTitle: { fontFamily: face('body', 600), fontSize: 16, lineHeight: 21, flex: 1, color: c.text },
  habitCost: { ...Type.number, fontSize: 15, color: c.text },
  more: { marginTop: 12 },
  track: { gap: 22 },
  row: { flexDirection: 'row', gap: 28, alignItems: 'flex-start' },
  column: { gap: 18 },
  half: { flex: 1, minWidth: 0, gap: 12 },
  inputs: { gap: 10 },
  method: { gap: 12, maxWidth: 760 },
}));
