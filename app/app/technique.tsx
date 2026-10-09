import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Platform, Pressable, ScrollView, StyleSheet, useWindowDimensions } from 'react-native';

import { TYRE_LABEL, TYRE_LEVELS } from '@/lib/tyreLevels';
import { Choice, FigRow, Meter, Notice, PageHead, Tabs, useText } from '@/components/Picks';
import { useBackTo } from '@/components/Back';
import PrintButton from '@/components/PrintButton';
import { Colophon, Fig, Label, Page, Section, TextLink, useGutter, useWide } from '@/components/Programme';
import { SessionSwitcher, useEventFolder, useSessionEvent } from '@/components/SessionSwitcher';
import { TechniqueInputs } from '@/components/TechniqueInputs';
import { TechniqueTrace } from '@/components/TechniqueTrace';
import { Text, View } from '@/components/Themed';
import { TrackMap } from '@/components/TrackMap';
import { ZOOM_HINT, ZoomGroup } from '@/components/Zoom';
import { formatLap, prefetch } from '@/lib/api';
import { poll } from '@/lib/poll';
import {
  BestSource,
  BestTechnique,
  MeasuredCost,
  EventTechnique,
  fetchEventTechnique,
  fetchSessionTechnique,
  fetchTechniqueProgress,
  Habit,
  habitSize,
  LapCheck,
  ObviousMistake,
  refreshSessionTechnique,
  RunTyres,
  SessionTechnique,
  setSessionTyres,
  Tyres,
  working,
} from '@/lib/technique';
import { a11yState } from '@/lib/a11yState';
import { deltaColor, face, Fonts, inkOn, phaseColor, themed, Type, useTheme } from '@/constants/Theme';

const SIDE_BY_SIDE = 900; // from this wide the charts are taller
const SIDE_MAP = 1000; // from this wide the track map has a column of its own on the right; narrower, it's pinned on top
const CLOSE_UP_M = 150; // metres either side of a mistake in its close-up
const s2 = (v: number) => `${v.toFixed(2)} s`;
const m0 = (v: number) => `${Math.round(v)} m`;
const lower = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);
const HABITS_SHOWN = 6;

/** One lap's obvious driving mistakes, most costly first, what to do instead and what each cost, and what the lap
 * would have been without them; then the mistakes that repeat across the session and the event, and the lap on the
 * track map and against the driver's best real passes on the same tyres. Opened from a session (?session=) or an event's report
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
  const [focus, setFocus] = useState<string | null>(null); // the corner last tapped, lit on the map
  const [cursor, setCursor] = useState<number | null>(null); // the charts' shared cursor, a dot on the map
  const [mapShown, setMapShown] = useState(true); // the map pinned on a phone
  const scroll = useRef<ScrollView>(null);
  const { width, height } = useWindowDimensions();
  const side = width >= SIDE_MAP;
  const sideWidth = Math.round(Math.min(440, Math.max(320, width * 0.28)));
  const sideBySide = width - (side ? sideWidth : 0) >= SIDE_BY_SIDE;

  // the event's check is asked for once more when the session's (the same check) comes in after it was being worked
  // out: the event's answer from before then still says "working"
  const evWorking = useRef(false);
  const [evRound, setEvRound] = useState(0);

  // the session's check of one lap; while the server works it out, only how far it is is asked again (lib/poll.ts:
  // less and less often, ?brief), and the check once more when it's ready
  useEffect(() => {
    if (sessionId == null) return;
    setLoading(true);
    let read = false; // the check itself read once already
    let waited = false; // ... and it was being worked out
    return poll(async (live) => {
      try {
        if (read) {
          const h = await fetchTechniqueProgress({ session: sessionId });
          if (!live()) return false;
          if (working(h.status)) {
            setAnswer((a) => a && { ...a, ...h }); // its progress
            return true;
          }
        }
        const a = await fetchSessionTechnique(sessionId, lap);
        if (!live()) return false;
        read = true;
        setAnswer(a);
        setError(null);
        setLoading(false);
        if (working(a.status)) {
          waited = true;
          return true;
        }
        if (waited && evWorking.current) setEvRound((k) => k + 1);
        return false;
      } catch (e) {
        if (!live()) return false;
        setError((e as Error).message);
        setLoading(false);
        return true;
      }
    });
  }, [sessionId, lap, nonce]);

  // the event: where to open (its quickest lap) and its other sessions to switch to, by day. Its parts (the event's
  // check, its sessions and its track map) are asked for at once, not after the session's check: the event comes
  // with the link from a run, else from the run itself (a light read), until the check names it
  const lookedUp = useSessionEvent(eventParam == null && answer == null ? sessionId : null);
  const lastEvent = useRef<number | null>(null); // a session picked here is of the same event
  const eventId = eventParam ?? answer?.event?.id ?? lookedUp ?? lastEvent.current;
  if (eventId != null) lastEvent.current = eventId;
  const folder = useEventFolder(eventId ?? (answer ? null : undefined));
  // the masthead's Back, opened fresh: up to the event
  useBackTo(eventId != null ? { id: eventId, name: folder?.id === eventId ? folder.name : null } : null);
  // the lap's track map: the event's for a session of an event (as the check's `map` says), else the session's own
  const mapPath = eventId != null ? `/events/${eventId}/map`
    : sessionId != null && lookedUp === null ? `/sessions/${sessionId}/map` : null;
  useEffect(() => {
    if (mapPath) prefetch(mapPath);
  }, [mapPath]);
  // the event's check, asked for at once. Opened at the event, how far it is is asked again while it's worked out
  // (?brief), and the check once more when it's ready (its answer picks the session); opened at a session, the
  // session's check (the same one) is what's asked again, and the event's once more when that is in (evRound)
  const eventLed = sessionId == null;
  useEffect(() => {
    if (eventId == null) return;
    let read = false;
    return poll(async (live) => {
      try {
        if (read) {
          const h = await fetchTechniqueProgress({ event: eventId });
          if (!live()) return false;
          if (working(h.status)) {
            setEv((a) => a && { ...a, ...h });
            return true;
          }
        }
        const a = await fetchEventTechnique(eventId);
        if (!live()) return false;
        read = true;
        evWorking.current = working(a.status);
        setEv(a);
        if (working(a.status)) return eventLed;
        if (a.best) setSessionId((cur) => cur ?? a.best!.session_id);
        return false;
      } catch (e) {
        if (live()) setError((e as Error).message);
        return false;
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eventId, nonce, evRound]);

  const check = answer?.lap ?? null;
  useEffect(() => setSelected(check?.obvious.length ? 1 : null), [check?.key]);

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
  // the driver says which tyres the run was on: the check is worked out again, every lap against the same tyres
  const pickTyres = useCallback(async (tyres: Tyres) => {
    if (sessionId == null) return;
    try {
      await setSessionTyres(sessionId, tyres);
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
    : 'Every obvious mistake on a lap, what each cost, and the lap without them.';
  // the sections are numbered in the order they are shown
  let no = 0;
  const next = () => ++no;

  // the map stays in view while the page scrolls: a column of its own on a computer, pinned on top on a phone. It
  // lights the corner last tapped (or the picked mistake's) and follows the charts' cursor with a dot
  const picked = check?.obvious[(selected ?? 0) - 1] ?? null;
  const pick = (n: number) => {
    setSelected(n);
    setFocus(check?.obvious[n - 1]?.code ?? null);
  };
  const map = answer && check ? (
    <TrackMap {...answer.map} highlight={focus ?? picked?.code} compact={!side}
      marks={check.obvious.map((m, i) => ({ n: i + 1, at_m: m.at_m, from_m: m.start_m, to_m: m.end_m }))}
      selectedMark={selected} marksLengthM={answer.length_m}
      cursorM={cursor != null && check.trace ? cursor * check.trace.step_m : null}
      maxHeight={side ? Math.max(180, height - 220) : Math.max(110, Math.min(200, Math.round(height / 3) - 64))} />
  ) : null;
  // on the web the mouse wheel over the map column scrolls the page
  const wheel = Platform.OS === 'web' ? {
    onWheel: (e: any) => (scroll.current as any)?.getScrollableNode?.()?.scrollBy?.(0,
      e.deltaY * (e.deltaMode === 1 ? 16 : 1)),
  } : {};

  return (
    <View style={StyleSheet.flatten([styles.screen, side && styles.split])}>
    {map && !side && (
      <View style={styles.pinned}>
        <View style={styles.pinnedBar}>
          <Label small>Track map</Label>
          <Text style={StyleSheet.flatten([t.small, styles.flex])} numberOfLines={1}>
            {mapShown ? focus ?? picked?.code ?? 'Tap a mistake to find it' : ''}
          </Text>
          <TextLink small label={mapShown ? 'Hide map' : 'Show map'} onPress={() => setMapShown(!mapShown)} />
        </View>
        {/* hidden, not removed: showing it again doesn't ask the server again */}
        <View style={mapShown ? undefined : styles.gone}>{map}</View>
      </View>
    )}
    <Page scrollRef={scroll}>
      <Stack.Screen options={{ title: answer ? `Technique check · ${answer.session.name}` : 'Technique check' }} />
      <PageHead title="Technique check" dek={dek}>
        <PrintButton title={['Technique check', answer?.session.name].filter(Boolean).join(' · ')} />
      </PageHead>
      <Text style={StyleSheet.flatten([t.note, styles.intro])}>
        Every obvious mistake on the lap (a lift on the way out, the speed stalling, the throttle on and off, braking
        grip left unused, an early or late upshift, oversteer on the power), where it happened and what it cost, and
        what the lap would have been without them. Each lap is compared only with laps on the same tyres.
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
                    label={`${l.number}`}
                    detail={`${formatLap(l.time)}${l.in_lap ? ' in' : l.build ? ' build' : ''}`}
                    fill={best ? theme.timing.best : undefined} ink={best ? theme.timing.onBest : undefined}
                    dim={l.in_lap || l.build}
                    accessibilityLabel={`Lap ${l.number}, ${formatLap(l.time)}${best ? ', the quickest' : ''}${
                      l.build ? ', a build lap' : ''}`} />
                );
              })}
            </View>
            <Text style={t.small}>
              Clean laps only: out-laps and in-laps say little about technique.
              {answer.laps.some((l) => l.build)
                ? ' In qualifying, a lap 2% or more slower than the run’s quickest is a build lap: it is marked and left out of the mistakes that repeat.'
                : ''}
              {answer.best_lap != null ? ' The quickest lap’s time is in purple.' : ''}
            </Text>
          </View>
        )}
        {answer?.lap_note && <Text style={t.note}>{answer.lap_note}</Text>}
        {answer?.tyres && <TyresLine tyres={answer.tyres} onPick={pickTyres} />}
      </View>

      {check && answer && <LapSummary check={check} room={width - (side ? sideWidth : 0)} />}

      {check && answer && (
        <Section no={next()} title="Mistakes on this lap"
          dek={check.obvious.length
            ? 'Most costly first: what happened in each corner, what to do instead and what it cost. Tap one to find it on the map.'
            : undefined}>
          {check.obvious.length === 0 && <Text style={t.note}>No obvious mistake on this lap.</Text>}
          {check.obvious.map((m, i) => (
            <MistakeRow key={`${m.key}-${m.start_m}`} n={i + 1} m={m} on={selected === i + 1} first={i === 0}
              onPress={() => pick(i + 1)} />
          ))}
        </Section>
      )}

      {answer?.habits && <Habits habits={answer.habits} no={next()} />}

      {!!answer?.measured?.length && <MeasuredCosts list={answer.measured} no={next()} />}

      {check && answer && (
        <Section no={next()} title="On the track"
          dek="The picked mistake close up, then the whole lap: speed and the driver's inputs, with wheelspin and traction control where the log has them, against your best real passes on the same tyres.">
          <OnTheTrack answer={answer} check={check} selected={selected} onSelect={pick} sideBySide={sideBySide}
            cursor={cursor} onCursor={setCursor} />
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
    {map && side && (
      <View {...wheel} style={StyleSheet.flatten([styles.side, { width: sideWidth }])}>
        {map}
        <Text style={t.small}>A mistake you tap lights its corner here; the dot follows the charts.</Text>
      </View>
    )}
    </View>
  );
}


const METHOD = [
  'Obvious mistakes are wrong whatever the lap: a lift on the way out of a corner (not a lift for the next ' +
    'corner), the throttle on and off through a corner, the speed that stops climbing or drops on the way out ' +
    '(whatever the pedal shows), the power stepped on so early or so hard that the car forced a lift or a steering ' +
    'correction, oversteer on the power while still turning, braking in a straight line below the deceleration the ' +
    'car has shown there, braking grip left unused up to the turn-in against the best braking there on the other ' +
    'laps, and an upshift early or late. Every lift counts, however small; a gearshift cut or the lift for the next ' +
    'braking zone does not.',
  'Each costs what it alone lost: the speed a lift took off, carried down the straight, the later braking point ' +
    'missed, or the drive an early upshift missed. Where enough laps have it and enough do not, its cost is also ' +
    'measured on the laps themselves, driver by driver, every event at this track pooled.',
  'The lap without mistakes is the lap\'s own time less what its obvious mistakes cost. Mistakes in the same corner ' +
    'that overlap (a lift and the speed stalling it causes) are one loss, counted once at the most any of them cost.',
  'Qualifying is always on a new set with low fuel; the races run on the qualifying set (Fresh); tests and practice ' +
    'run new sets sometimes. So a lap on new tyres is only ever compared with laps on new tyres, and a lap on any ' +
    'other set (Fresh, Used, Very used) with those: the best braking at a corner, the best real passes laid over the ' +
    'lap and the targets the check works from all come from those laps alone. Until you say which, a practice run\'s ' +
    'tyres are guessed from the event\'s laps in the order they ran: a lap at the start of a run as quick as ' +
    'qualifying, or clearly quicker than anything on the set before, starts a new set; the runs after it step down ' +
    'to Fresh, Used (10 laps on the set) and Very used (25).',
  'Shift points come from the event\'s own logs: each gear\'s ratio (engine revs per km/h) and the engine\'s ' +
    'torque at full throttle (the logger\'s engine torque channel), as the car\'s ratios and torque curve are not ' +
    'published. Drive force is torque times the ratio, so the best upshift is where the next gear drives harder, or ' +
    'just short of the rev limiter where it never does. An upshift 150 rpm or more before that is early; after it, ' +
    'or held on the limiter, late.',
  'Corners are named by their official numbers only.',
];

/** The lap's speed and the driver's inputs (with wheelspin and traction control) against the best real passes: a close-up
 * of the picked mistake, then the whole lap. One cursor runs through every chart. */
function OnTheTrack({ answer, check, selected, onSelect, sideBySide, cursor, onCursor: setCursor }: {
  answer: SessionTechnique; check: LapCheck; selected: number | null; onSelect: (n: number) => void;
  sideBySide: boolean; cursor: number | null; onCursor: (i: number | null) => void }) {
  const t = useText();
  const styles = useStyles();
  const [picked, setOverlay] = useState<Overlay | null>(null);
  const best = check.trace?.model?.best ?? null;
  const overlay: Overlay = best ? picked ?? 'best' : 'off';
  const mistake = check.obvious[(selected ?? 0) - 1] ?? null;
  const bands = useMemo(() => bandsOf(check), [check]);
  const tr = check.trace;
  const corners = answer.corners ?? [];
  const fastest = check.fastest;
  const scope = answer.scope === 'event' ? 'event' : 'session';
  // the driver's inputs, with the speed on top: one set of charts for the close-up and for the whole lap
  const inputsOf = (from?: number, to?: number) => tr?.inputs ? (
    <TechniqueInputs stepM={tr.step_m} points={tr.driven.length}
      inputs={{ ...tr.inputs, speed: tr.driven }}
      fastest={fastest && !fastest.this_lap ? fastest.inputs : null}
      fastestLabel={fastest && !fastest.this_lap
        ? `Fastest lap: ${fastest.run} L${fastest.number} · ${formatLap(fastest.time)}` : null}
      model={overlay === 'best' ? best : null}
      modelLabel={OVERLAYS.find((o) => o.key === overlay)?.legend ?? null}
      marks={check.obvious.map((m) => ({ at_m: m.at_m, code: m.code }))}
      channels={answer.inputs} bands={bands} selected={selected} onSelect={onSelect}
      corners={corners} from={from} to={to} cursor={cursor} onCursor={setCursor} tall={sideBySide} />
  ) : null;
  return (
    <View style={styles.track}>
      {fastest?.this_lap && (
        <Text style={t.note}>
          This is the {scope}&apos;s fastest lap, the one the report measures from: there is no quicker lap to lay
          under it.
        </Text>
      )}
      {tr?.inputs && best && (
        <Tabs label="Laid over the lap, dashed" value={overlay} onChange={setOverlay} items={OVERLAYS} />
      )}
      {tr?.inputs && overlay === 'best' && best && <BestSources best={best} />}
      {tr && mistake && (
        tr.inputs ? (
          <View style={styles.inputs}>
            <Text style={styles.subhead}>{`Close-up of ${selected}. ${mistake.title} (${mistake.code})`}</Text>
            {inputsOf(mistake.start_m - CLOSE_UP_M, mistake.end_m + CLOSE_UP_M)}
          </View>
        ) : (
          <TechniqueTrace stepM={tr.step_m} driven={tr.driven} best={best?.speed}
            bands={bands} selected={selected} onSelect={onSelect} corners={corners}
            from={mistake.start_m - CLOSE_UP_M} to={mistake.end_m + CLOSE_UP_M}
            title={`Close-up of ${selected}. ${mistake.title} (${mistake.code})`} cursor={cursor} onCursor={setCursor} />
        )
      )}
      {/* the whole lap's charts zoom together; the close-up zooms on its own */}
      <ZoomGroup>
      {!tr ? (
        <Text style={t.note}>The speed trace of this lap isn&apos;t available; refresh to work it out.</Text>
      ) : tr.inputs ? (
        <View style={styles.inputs}>
          <Text style={styles.subhead}>The whole lap</Text>
          {inputsOf()}
        </View>
      ) : (
        <>
          <TechniqueTrace stepM={tr.step_m} driven={tr.driven} best={best?.speed}
            bands={bands} selected={selected} onSelect={onSelect} corners={corners} height={sideBySide ? 260 : 240}
            title="Speed over the whole lap" cursor={cursor} onCursor={setCursor} />
          <Text style={t.note}>This lap&apos;s inputs come with the new check, worked out in the background.</Text>
        </>
      )}
      </ZoomGroup>
      <Text style={t.small}>
        {Platform.OS === 'web' ? 'Hover over' : 'Drag across'} a chart to read the speed and inputs at that point on
        every chart; tap a numbered band or a mistake above to see it on the map and close up. {ZOOM_HINT} The whole
        lap&apos;s charts zoom together.
      </Text>
    </View>
  );
}

type Overlay = 'best' | 'off';
const OVERLAYS: { key: Overlay; label: string; legend: string | null }[] = [
  { key: 'best', label: 'Best real passes', legend: 'Best real passes' },
  { key: 'off', label: 'Off', legend: null },
];

const PUT_RIGHT: Partial<Record<ObviousMistake['kind'], string>> = {
  exit_lift: 'exit lift', exit_stall: 'exit stall', on_off_throttle: 'throttle on and off', power_step: 'stepped power',
  soft_straight_braking: 'soft braking', braking_unused: 'braking grip unused', power_oversteer: 'power oversteer',
  early_shift: 'early upshift', late_shift: 'late upshift',
};

/** Where the dashed line comes from, section by section, and what each pass finds over this lap there. */
function BestSources({ best }: { best: BestTechnique }) {
  const t = useText();
  const fixed = (x: BestSource) => (x.put_right?.length
    ? `, ${x.put_right.map((k) => PUT_RIGHT[k] ?? k).join(' and ')} put right` : '');
  const from = (x: BestSource) => (x.kind === 'pass' ? `${x.run} L${x.number}${fixed(x)}`
    : x.kind === 'built' ? `this lap${fixed(x) || ', mistakes taken out'}` : 'this lap');
  return (
    <View style={{ gap: 4 }}>
      <Text style={t.note}>
        The dashed line through each corner is the driver&apos;s own quickest clean pass of the event on the same
        tyres (no obvious mistake in it) where it beats this lap&apos;s; where none does, this lap&apos;s own pass with
        its obvious mistakes taken out (built). Every upshift is at the ideal revs; the gear and revs show the ideal
        shift points.
      </Text>
      {best.sources.map((x) => (
        <Text key={`${x.code}${x.start_m}`} style={t.small}>
          {`${x.code} · ${from(x)}${x.gain_s >= 0.005 ? ` · ${s2(x.gain_s)}` : ''}`}
        </Text>
      ))}
    </View>
  );
}

const bandsOf = (check: LapCheck) =>
  check.obvious.map((m, i) => ({ n: i + 1, start_m: m.start_m, end_m: m.end_m, label: `${m.title} (${m.code})`,
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

function LapSummary({ check, room }: { check: LapCheck; room: number }) {
  const t = useText();
  const theme = useTheme();
  const wide = useWide();
  const gutter = useGutter();
  const styles = useStyles();
  const ob = check.obvious;
  // the three figures share the page's column (beside the map on a computer): as big as fits on one line each
  const cell = (Math.min(room, 1240) - 2 * gutter) / (wide ? 3 : 2) - (wide ? 36 : 18);
  const size = Math.floor(Math.min(wide ? 76 : 44, cell / 3.6));
  return (
    <View style={styles.summary}>
      <FigRow>
        {[
          <Fig key="lap" label={`Lap ${check.number}`} value={formatLap(check.time)} size={size} bar={theme.rule}
            note={check.run} />,
          <Fig key="without" label="Without the mistakes" value={formatLap(check.without_mistakes)} size={size}
            bar={theme.timing.personal} note="the lap's own time less what its mistakes cost" />,
          <Fig key="lost" label="Lost to mistakes" value={s2(check.mistakes_s)} size={size} bar={theme.delta.loss}
            note={`${ob.length} mistake${ob.length === 1 ? '' : 's'}, overlaps counted once`} />,
        ]}
      </FigRow>
      <Text style={StyleSheet.flatten([t.lead, styles.measure])}>
        {ob.length
          ? `${ob.length} mistake${ob.length === 1 ? '' : 's'} on this lap cost ${s2(check.mistakes_s)}; the biggest: ` +
            `${lower(ob[0].title)} (${s2(ob[0].cost_s)}).`
          : 'No obvious mistake on this lap.'}
        {check.pit_from_m != null ? ` The lap ends in the pit lane from ${m0(check.pit_from_m)}.` : ''}
      </Text>
    </View>
  );
}

/** The run's tyres (New, Fresh, Used, Very used): the driver's, or guessed from the event's laps with a tap to confirm
 * or change. */
function TyresLine({ tyres, onPick }: { tyres: RunTyres; onPick: (t: Tyres) => void }) {
  const t = useText();
  const styles = useStyles();
  const word = `${TYRE_LABEL[tyres.tyres]} tyres`;
  const group = tyres.tyres === 'new' ? 'new tyres' : 'tyres that aren\'t new (Fresh, Used, Very used)';
  return (
    <View style={styles.lapBlock}>
      <View style={styles.lapHead}>
        <Label small>Tyres</Label>
      </View>
      <Text style={t.body}>
        {tyres.sure ? `${word} (${tyres.why}).` : `${word}, guessed (${tyres.why}). Is that right?`}
        {tyres.laps != null ? ` Compared with the event's ${tyres.laps} clean laps on ${group}.` : ''}
      </Text>
      <View style={styles.laps}>
        {TYRE_LEVELS.map((k) => (
          <Choice key={k} on={tyres.sure && tyres.tyres === k} onPress={() => onPick(k)}
            label={TYRE_LABEL[k]} accessibilityLabel={`This run was on ${TYRE_LABEL[k].toLowerCase()} tyres`} />
        ))}
      </View>
    </View>
  );
}

/** A mistake: its number in an ink block (red when picked), what it is, where and in which phase, what it cost as a
 * figure, then what happened, what to do instead, what the laps measure it at and how often it repeats. */
function MistakeRow({ n, m, on, first, onPress }: { n: number; m: ObviousMistake; on: boolean; first: boolean;
  onPress: () => void }) {
  const t = useText();
  const theme = useTheme();
  const wide = useWide();
  const styles = useStyles();
  return (
    <Pressable accessibilityRole="button" {...a11yState({ selected: on }, 'button')} onPress={onPress}
      style={StyleSheet.flatten([styles.mistake, !first && styles.mistakeRule, on && styles.mistakeOn])}>
      <View style={styles.mistakeHead}>
        <View style={StyleSheet.flatten([styles.no, on && styles.noOn])}>
          <Text style={StyleSheet.flatten([styles.noText, on && styles.noOnText])}>{n}</Text>
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
          {m.cost_s < 0.005 ? '<0.01' : m.cost_s.toFixed(2)}
          <Text style={StyleSheet.flatten([styles.costUnit, { color: deltaColor(theme, m.cost_s) ?? theme.text }])}> s</Text>
        </Text>
      </View>
      <View style={wide ? styles.mistakeBody : styles.mistakeBodyPhone}>
        <Text style={t.body}>{m.what}</Text>
        <Text style={t.body}>
          <Text style={t.strong}>Instead: </Text>
          {m.do}
        </Text>
        {(m.measured || m.repeats) && (
          <Text style={t.small}>
            {m.measured ? measuredLine(m.measured) : ''}
            {m.repeats ? `${m.measured ? ' · ' : ''}On ${m.repeats.laps} of the session's ${m.repeats.of} clean laps.` : ''}
          </Text>
        )}
      </View>
    </Pressable>
  );
}

/** What the laps say a mistake costs, or why the model's estimate stands. */
function measuredLine(x: MeasuredCost) {
  const laps = x.laps_with + x.laps_without;
  const over = `${x.laps_with} with it, ${x.laps_without} without` + (x.events > 1 ? `, over ${x.events} events here` : '');
  if (!x.measured) return `Too few laps to measure it yet (${over}): the cost shown is the model's estimate.`;
  const range = `${s2(x.measured_s ?? 0)} ± ${s2(x.pm_s ?? 0)}`;
  if (x.clear === false)
    return `Not measurable yet (${laps} laps): ${range} on the laps, within the noise; the model's estimate is ${s2(x.model_s)}. Still a mistake.`;
  return `Measured on the laps: ${range} each time (${over}); the model's estimate is ${s2(x.model_s)}.`;
}

/** The obvious mistakes ranked by what they really cost on the laps. */
function MeasuredCosts({ list, no }: { list: MeasuredCost[]; no: number }) {
  const t = useText();
  const theme = useTheme();
  const styles = useStyles();
  const top = Math.max(...list.map((x) => x.cost_s), 0.001);
  return (
    <Section no={no} title="What mistakes really cost"
      dek="Each obvious mistake's loss measured on the laps: the time from its corner to the end of the next, laps with it against laps without it, driver by driver, every event at this track pooled. Most expensive first.">
      {list.map((x) => (
        <View key={x.key} style={styles.habit}>
          <View style={styles.habitLine}>
            <Text style={styles.habitTitle}>{(PUT_RIGHT[x.kind] ?? x.kind).replace(/^./, (c) => c.toUpperCase())} · {x.code}</Text>
            <Text style={styles.habitCost}>{s2(x.cost_s)}</Text>
          </View>
          <Meter share={x.cost_s / top} color={x.clear ?? x.measured ? theme.delta.loss : theme.textMuted} height={8} />
          <Text style={t.small}>{measuredLine(x)}</Text>
        </View>
      ))}
    </Section>
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
  noOnText: { color: inkOn(c.mark) }, // white on the red: 4.5:1
  noText: { fontFamily: Fonts.display, fontSize: 18, lineHeight: 21, color: c.background },
  mistakeTitle: { fontFamily: face('body', 600), fontSize: 19, lineHeight: 25, color: c.text },
  meta: { flexDirection: 'row', alignItems: 'center', gap: 7, marginTop: 4 },
  phaseKey: { width: 12, height: 12 },
  metaText: { ...Type.label, fontSize: 11, letterSpacing: 1, color: c.textSecondary, flexShrink: 1 },
  cost: { fontFamily: Fonts.display, fontSize: 32, lineHeight: 34 },
  costUnit: { fontFamily: Fonts.display, fontSize: 15 },
  mistakeBody: { marginLeft: 42, gap: 6, maxWidth: 780 },
  mistakeBodyPhone: { gap: 6 },
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
  screen: { flex: 1, backgroundColor: c.background },
  split: { flexDirection: 'row' },
  pinned: { borderBottomWidth: 1, borderColor: c.rule, paddingHorizontal: 16, paddingBottom: 6,
    backgroundColor: c.background },
  pinnedBar: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 40, backgroundColor: 'transparent' },
  side: { borderLeftWidth: 1, borderColor: c.rule, padding: 16, gap: 8, backgroundColor: c.background },
  gone: { display: 'none' },
  row: { flexDirection: 'row', gap: 28, alignItems: 'flex-start' },
  column: { gap: 18 },
  half: { flex: 1, minWidth: 0, gap: 12 },
  inputs: { gap: 10 },
  method: { gap: 12, maxWidth: 760 },
}));
