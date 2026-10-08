import { Stack, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Platform, Pressable, ScrollView, StyleSheet, useWindowDimensions } from 'react-native';

import { FigRow, PageHead, Tabs, TickBox, useText } from '@/components/Picks';
import PrintButton from '@/components/PrintButton';
import { Colophon, Fig, Label, Page, Section, TextLink, useWide } from '@/components/Programme';
import { LineChart, useChartColors } from '@/components/ReportCharts';
import { SessionSwitcher, useEventFolder } from '@/components/SessionSwitcher';
import { BalanceDumbbell, ChangeBar, CornerText, FadeBars, MIN_SHIFT, OnCorner, ShiftRow, shiftColor,
  useBalanceColors } from '@/components/StintCharts';
import { Text, View } from '@/components/Themed';
import { TrackMap } from '@/components/TrackMap';
import { ResetZoom, useZoomState, ZOOM_HINT, ZoomGroup } from '@/components/Zoom';
import { formatLap } from '@/lib/api';
import {
  average,
  BalancePhase,
  clearLapTag,
  fetchStintLogs,
  fetchStintView,
  Fit,
  fixed,
  GRIP_PHASES,
  GripPhase,
  KIND_LABEL,
  LogEvent,
  putLapTag,
  SectionRow,
  signed,
  Stint,
  StintLap,
  StintView,
  stintName,
  Tag,
  TAG_LABEL,
  TAG_WORDS,
  TAGS,
  Words,
} from '@/lib/stint';
import { a11yState } from '@/lib/a11yState';
import { face, Fonts, inkOn, Palette, phaseColor, themed, Type, useTheme } from '@/constants/Theme';

const ALL = 'all';
const MAX_LOGS = 12; // the server reads at most this many logs in one view
const SIDE_MAP = 900; // from this wide the track map has a column of its own on the right; narrower, it's pinned on top

// Stint analysis: tick one or more logs, then each stint lap by lap: how the car fades (fuel burn and tyres apart,
// by phase and corner), grip and balance per phase, and how the driver adapts. Tag laps lost to a safety car, FCY or
// traffic and they leave the trends; count a lap the analysis leaves out (not a pit lap) and it joins them. Open with
// ?session=<id> to start with that session's log ticked, or ?event=<id> with every run of the event. The track map
// stays in view beside the report (on a phone, pinned on top, one tap to hide it); a corner the report names lights
// up on it when hovered or tapped. A page of the race programme: the headline, the logs and stints to pick, then
// numbered sections.
export default function StintScreen() {
  const styles = useStyles();
  const tx = useText();
  const theme = useTheme();
  const params = useLocalSearchParams<{ session?: string; event?: string }>();
  const [events, setEvents] = useState<LogEvent[] | null>(null);
  const [ticked, setTicked] = useState<number[]>([]);
  const [pickerOpen, setPickerOpen] = useState(!params.session && !params.event);
  const [view, setView] = useState<StintView | null>(null);
  const [scope, setScope] = useState<string>(ALL);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tagging, setTagging] = useState<string | null>(null);
  const request = useRef(0);
  const scroll = useRef<ScrollView>(null);
  const lapsY = useRef(0);
  const { width, height } = useWindowDimensions();
  const side = width >= SIDE_MAP;
  const sideWidth = Math.round(Math.min(440, Math.max(340, width * 0.3)));
  const [corner, setCorner] = useState<string | null>(null); // the corner pointed at in the report, on the map
  const [mapShown, setMapShown] = useState(true); // the map pinned on a phone
  const [noMap, setNoMap] = useState<string | null>(null); // the map target with nothing to draw (no GPS...)

  useEffect(() => {
    fetchStintLogs().then((evs) => {
      setEvents(evs);
      const sid = params.session ? Number(params.session) : null;
      const main = evs.flatMap((e) => e.sessions).find((s) => s.id === sid)?.files.find((f) => f.main && f.laps > 0);
      if (main) {
        setTicked([main.id]);
        return;
      }
      // ?event=<id>: every run of the event, each by its main log with laps (as "Whole event" ticks them)
      const ev = params.event ? evs.find((e) => e.id === Number(params.event)) : undefined;
      const mains = (ev?.sessions ?? []).flatMap((s) => s.files.filter((f) => f.main && f.laps > 0).slice(-1))
        .map((f) => f.id);
      if (mains.length > 0) setTicked(mains.slice(0, MAX_LOGS));
      else setPickerOpen(true);
    }, (e) => setError((e as Error).message));
  }, [params.session, params.event]);

  const load = useCallback((files: number[], keepScope: boolean) => {
    const n = ++request.current;
    if (files.length === 0) {
      setView(null);
      setBusy(false);
      return;
    }
    setBusy(true);
    setError(null);
    fetchStintView(files)
      .then((v) => {
        if (n !== request.current) return;
        setView(v);
        setScope((old) => {
          if (keepScope && (old === ALL || v.stints.some((s) => s.key === old))) return old;
          const usable = v.stints.filter((s) => s.fitted_laps >= 2);
          return usable.length === 1 ? usable[0].key : ALL;
        });
      })
      .catch((e) => n === request.current && setError((e as Error).message))
      .finally(() => n === request.current && setBusy(false));
  }, []);

  // ticking a log updates the analysis (after a short pause, so several ticks make one request)
  useEffect(() => {
    const t = setTimeout(() => load(ticked, false), 350);
    return () => clearTimeout(t);
  }, [ticked, load]);

  const toggle = (id: number) => setTicked((t) => (t.includes(id) ? t.filter((x) => x !== id) : [...t, id]));

  // the runs of the ticked logs' event, one tap away: a tap shows that run alone, "Whole event" ticks every run
  const where = useMemo(() => {
    const event = new Map<number, number | null>(); // file -> its event
    const session = new Map<number, number>(); // file -> its session
    const mains = new Map<number | null, Map<number, number>>(); // event -> session -> its main log with laps
    for (const e of events ?? []) {
      for (const s of e.sessions) {
        for (const f of s.files) {
          event.set(f.id, e.id);
          session.set(f.id, s.id);
          if (f.main && f.laps > 0) {
            if (!mains.has(e.id)) mains.set(e.id, new Map());
            mains.get(e.id)!.set(s.id, f.id);
          }
        }
      }
    }
    return { event, session, mains };
  }, [events]);
  const eventId = events == null || ticked.length === 0 ? undefined : where.event.get(ticked[0]) ?? null;
  const folder = useEventFolder(eventId);
  const eventMains = [...(where.mains.get(folder?.id ?? null)?.values() ?? [])];
  const tickedSessions = [...new Set(ticked.map((f) => where.session.get(f)))];
  const wholeEvent = eventMains.length > 0 && eventMains.length === ticked.length
    && eventMains.every((f) => ticked.includes(f));
  const current = tickedSessions.length === 1 ? tickedSessions[0] ?? -1 : wholeEvent ? null : -1;

  const tag = async (stint: Stint, lap: StintLap, to: Tag | 'none' | 'count' | null) => {
    if (stint.file_id == null) return;
    setTagging(`${stint.key}:${lap.lap}`);
    try {
      if (to == null) await clearLapTag(stint.file_id, lap.lap);
      else await putLapTag(stint.file_id, lap.lap, to);
      load(ticked, true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setTagging(null);
    }
  };

  const stint = view?.stints.find((s) => s.key === scope) ?? null;
  const many = new Set(view?.stints.map((s) => s.file_key)).size > 1;
  const words = stint ? stint.words : view?.overall.words;
  const pending = (stint ? [stint] : view?.stints ?? []).flatMap((s) => s.laps.filter((l) => l.suggestion)).length;
  const sections = stint ? stint.sections : view?.overall.sections ?? [];
  const codes = sections.map((s) => s.code);
  const fade = stint ? stint.fade : view?.overall.fade ?? [];

  // the map of what the view shows: its session's, or with runs of several sessions their event's fastest lap
  const target = useMemo(() => {
    const sessions = [...new Set((view?.logs ?? []).map((l) => l.session_id).filter((s): s is number => s != null))];
    if (sessions.length === 0) return null;
    const ev = sessions.length > 1 ? where.event.get(view!.file_ids[0]) : null;
    return ev != null ? { event: ev } : { session: sessions[0] };
  }, [view, where]);
  const targetKey = target ? JSON.stringify(target) : null;
  const showMap = target != null && noMap !== targetKey;
  const wide = width - (side && showMap ? sideWidth : 0) >= 760; // the report's own width: phase panels two a row
  const pointAt = showMap ? setCorner : undefined;
  // on a phone the pinned map keeps to about a third of the screen with its bar; beside the report it fits the window
  // with its title, switch and legend
  const map = target && (
    <TrackMap {...target} highlight={corner ?? undefined} compact={!side}
      onNone={() => setNoMap(targetKey)}
      maxHeight={side ? Math.max(160, height - 280) : Math.max(110, Math.min(220, Math.round(height / 3) - 64))} />
  );
  // on the web the mouse wheel over the map column scrolls the report
  const wheel = Platform.OS === 'web' ? {
    onWheel: (e: any) => (scroll.current as any)?.getScrollableNode?.()?.scrollBy?.(0,
      e.deltaY * (e.deltaMode === 1 ? 16 : 1)),
  } : {};

  const scopes = [
    ...(view && view.stints.length > 1
      ? [{ key: ALL, label: 'All stints', sub: `${view.overall.fitted_laps} laps in the trend` }] : []),
    ...(view?.stints ?? []).map((s) => ({ key: s.key, label: `${many ? `${s.run} · ` : ''}Stint ${s.number}`,
      sub: `laps ${s.first_lap}–${s.last_lap} · ${s.fitted_laps} in the trend` })),
  ];
  // the sections are numbered in the order they are shown
  let no = 0;
  const next = () => ++no;

  return (
    <View style={StyleSheet.flatten([styles.screen, side && styles.split])}>
      {showMap && !side && (
        <View style={styles.pinned}>
          <View style={styles.pinnedBar}>
            <Label small>Track map</Label>
            <Text style={StyleSheet.flatten([tx.small, styles.flex])} numberOfLines={1}>
              {mapShown ? (corner && codes.includes(corner) ? corner : 'Tap a corner in the report') : ''}
            </Text>
            <TextLink small label={mapShown ? 'Hide map' : 'Show map'} onPress={() => setMapShown(!mapShown)} />
          </View>
          {/* hidden, not removed: showing it again doesn't ask the server again */}
          <View style={mapShown ? undefined : styles.gone}>{map}</View>
        </View>
      )}
      <Page scrollRef={scroll}>
        <Stack.Screen options={{ title: 'Stint analysis' }} />
        <PageHead title="Stint analysis"
          dek={'How the car fades over a stint, fuel burn and tyres apart; grip and balance by phase; how the ' +
            `driver adapts.${view?.track ? ` ${view.track}.` : ''}`}>
          <PrintButton title={['Stint analysis', view?.track].filter(Boolean).join(' · ')} />
        </PageHead>
        <View style={styles.top}>
          {folder && folder.id != null && (
            <SessionSwitcher folder={folder} current={current} onlyTimed
              onWhole={eventMains.length > 1 ? () => setTicked(eventMains.slice(0, MAX_LOGS)) : undefined}
              onPick={(s) => {
                const main = where.mains.get(folder.id)?.get(s.id);
                if (main != null) setTicked([main]);
              }} />
          )}
          <Picker events={events} ticked={ticked} open={pickerOpen} setOpen={setPickerOpen} toggle={toggle}
            track={view?.track ?? null} />

          {error && <Text style={tx.error}>{error}</Text>}
          {busy && (
            <View style={styles.busy}>
              <ActivityIndicator color={theme.text} />
              <Text style={tx.note}>{view ? 'Updating…' : 'Reading the logs…'}</Text>
            </View>
          )}
          {!busy && ticked.length === 0 && events && events.length > 0 && (
            <Text style={tx.note}>Tick one or more logs to see their stints.</Text>
          )}
          {view && words && scopes.length > 0 && <Tabs big label="Stint" value={scope} onChange={setScope} items={scopes} />}
        </View>

        {view && words && (
          <>
            <Section no={next()} title={stint ? `Stint ${stint.number}` : 'The stints'}
              dek={stint
                ? `${many ? `${stint.run}: l` : 'L'}aps ${stint.first_lap} to ${stint.last_lap}, ${stint.fitted_laps} of them in the trend.`
                : `${view.stints.length} stint${view.stints.length === 1 ? '' : 's'}, ${view.overall.fitted_laps} laps in the trend.`}>
              <Summary words={words} fits={stint ? stint.fits : view.overall.fits}
                fuel={stint ? stint.fuel : view.overall.fuel} top={fade[0]}
                pending={pending} onPending={() => scroll.current?.scrollTo({ y: lapsY.current, animated: true })}
                at={{ codes, focus: corner, onCorner: pointAt }} />
            </Section>

            {fade.length > 0 && (
              <Section no={next()} title="Where the fade comes from"
                dek="Each lap's time against the stint's typical lap, fuel burn taken out, charged to the phase where it was lost: speed lost on an exit counts against the exit all the way down the straight that follows.">
                <View style={styles.narrow}>
                  <FadeBars rows={fade} focus={corner} onCorner={pointAt} />
                </View>
              </Section>
            )}

            <Section no={next()} title="Grip and balance by phase"
              dek={`Grip: the g the car pulls in each phase (90th percentile of the lap). Balance: the understeer angle against the car's normal at the same cornering g (${view.understeer_per_g ?? '–'}° per g), + understeer, − oversteer.`}>
              <PhaseTable fits={stint ? stint.fits : view.overall.fits} fade={fade} stint={stint} wide={wide} />
            </Section>

            <Section no={next()} title="Balance shift per corner"
              dek="How the balance moves from the stint's early laps to its late laps, corner by corner.">
              <CornerShift sections={sections} stints={stint ? [stint] : view.stints} onCorner={pointAt} />
            </Section>

            <Section no={next()} title={stint ? 'Laps' : 'Stints'}
              dek={stint ? 'The lap times against the stint’s typical lap, then every lap: tag the ones a safety car, an FCY or traffic slowed.'
                : 'Open a stint to see it lap by lap and tag its slow laps.'}
              onLayout={(e) => (lapsY.current = e.nativeEvent.layout.y)}>
              {stint ? (
                <View style={styles.block}>
                  <LapTimes stint={stint} />
                  <LapList stint={stint} onTag={tag} tagging={tagging} />
                  <LapTable stint={stint} unit={view.units.steer} />
                </View>
              ) : (
                <View>
                  {view.stints.map((s, i) => (
                    <StintCard key={s.key} stint={s} many={many} first={i === 0} onPress={() => {
                      setScope(s.key);
                      scroll.current?.scrollTo({ y: 0, animated: true });
                    }} />
                  ))}
                </View>
              )}
            </Section>

            {view.notes.length > 0 && (
              <View style={styles.notes}>
                {view.notes.map((n) => (
                  <Text key={n} style={tx.small}>
                    {n}
                  </Text>
                ))}
              </View>
            )}
          </>
        )}
        <Colophon left="The Engineer · Stint analysis" right={view?.track ?? undefined} />
      </Page>
      {showMap && side && (
        <View {...wheel}
          style={StyleSheet.flatten([styles.side, { width: sideWidth }])}>
          {map}
          <Text style={tx.small}>A corner you hover or tap in the report lights up here.</Text>
        </View>
      )}
    </View>
  );
}

// ---------- the logs to tick ----------

function Picker({ events, ticked, open, setOpen, toggle, track }: {
  events: LogEvent[] | null; ticked: number[]; open: boolean; setOpen: (o: boolean) => void;
  toggle: (id: number) => void; track: string | null;
}) {
  const styles = useStyles();
  const tx = useText();
  const theme = useTheme();
  const files = useMemo(() => {
    const out = new Map<number, { label: string; track: string | null }>();
    for (const e of events ?? []) {
      for (const s of e.sessions) {
        for (const f of s.files) out.set(f.id, { label: s.files.length > 1 ? `${s.name} · ${f.filename}` : s.name,
          track: e.track });
      }
    }
    return out;
  }, [events]);
  const tickedTrack = ticked.map((id) => files.get(id)?.track).find((t) => t) ?? null;
  if (events == null) return <ActivityIndicator color={theme.text} style={styles.left} />;
  if (events.length === 0) {
    return <Text style={tx.note}>No logs yet. Upload a logger file (.ld or a CSV export) to a session first.</Text>;
  }
  return (
    <View style={styles.picker}>
      <View style={styles.pickerHead}>
        <Label>Logs</Label>
        <Text style={StyleSheet.flatten([tx.small, styles.flex])} numberOfLines={1}>
          {ticked.length === 0 ? 'None ticked' : `${ticked.length} ticked${track || tickedTrack ? ` · ${track ??
            tickedTrack}` : ''}`}
        </Text>
        <TextLink small label={open ? 'Done' : 'Change'} onPress={() => setOpen(!open)} />
      </View>
      {!open && ticked.length > 0 && (
        <View style={styles.tickedRow}>
          {ticked.slice(0, ticked.length > 5 ? 4 : 5).map((id) => (
            <Pressable key={id} onPress={() => toggle(id)} style={styles.tickedItem} hitSlop={4}
              accessibilityRole="button" accessibilityLabel={`Untick ${files.get(id)?.label ?? id}`}>
              <Text style={styles.tickedText}>{files.get(id)?.label ?? `Log ${id}`}</Text>
              <Text style={styles.tickedX}>✕</Text>
            </Pressable>
          ))}
          {ticked.length > 5 && <TextLink small label={`+${ticked.length - 4} more`} onPress={() => setOpen(true)} />}
        </View>
      )}
      {open && events.map((e) => {
        const other = tickedTrack != null && e.track != null && e.track !== tickedTrack;
        return (
          <View key={e.id ?? 'none'} style={styles.event}>
            <View style={styles.eventHead}>
              <Text style={styles.eventName}>{e.name}</Text>
              {e.track ? <Text style={tx.labelMuted}>{e.track}</Text> : null}
            </View>
            {other && <Text style={tx.small}>Another track: untick the others to compare these.</Text>}
            {e.sessions.flatMap((s) => s.files.map((f) => {
              const on = ticked.includes(f.id);
              const empty = f.laps === 0;
              return (
                <Pressable key={f.id} onPress={() => toggle(f.id)} disabled={(empty || other) && !on}
                  accessibilityRole="checkbox" {...a11yState({ checked: on, disabled: (empty || other) && !on })}
                  style={StyleSheet.flatten([styles.logRow, (empty || other) && !on && styles.dim])}>
                  <TickBox on={on} />
                  <View style={styles.flex}>
                    <Text style={styles.logName}>{s.files.length > 1 ? `${s.name} · ${f.filename}` : s.name}</Text>
                    <Text style={tx.small}>
                      {empty ? 'no laps' : `${f.laps} lap${f.laps === 1 ? '' : 's'} · ${f.clean_laps} clean · best ${
                        formatLap(f.best_lap_s)}`}
                      {s.driver ? ` · ${s.driver}` : ''}
                    </Text>
                  </View>
                </Pressable>
              );
            }))}
          </View>
        );
      })}
    </View>
  );
}

// ---------- the plain-words summary ----------

// the corners a text may name, the one pointed at, and where to report a corner hovered or tapped
type PointAt = { codes: string[]; focus: string | null; onCorner?: OnCorner };

function Summary({ words, fits, fuel, top, pending, onPending, at }: {
  words: Words; fits: Partial<Record<string, Fit>>; fuel: StintView['overall']['fuel']; top?: StintView['overall']['fade'][number];
  pending: number; onPending: () => void; at: PointAt;
}) {
  const styles = useStyles();
  const tx = useText();
  const theme = useTheme();
  const wide = useWide();
  const tyres = fits.corrected_time ?? fits.time;
  // the stint's figures: s a lap, slower in red, quicker in green
  const tiles = [
    tyres && { label: fits.corrected_time ? 'Tyres' : 'Lap time', value: signed(tyres.per_lap), unit: 's/lap',
      note: tyres.clear ? 'clear trend' : `within ±${tyres.within.toFixed(2)}`, delta: tyres.per_lap },
    fuel?.fuel_s_per_lap != null && { label: 'Fuel burn', value: signed(fuel.fuel_s_per_lap), unit: 's/lap',
      note: `${fuel.kg_per_lap?.toFixed(2)} kg/lap${fuel.source === 'log' ? '' : ' (estimate)'}`,
      delta: fuel.fuel_s_per_lap },
    fuel && { label: '10 kg of fuel', value: fuel.s_per_10kg.toFixed(2), unit: 's/lap', note: 'here', delta: null },
    top && top.clear && top.per_lap > 0 && { label: 'Biggest fade', value: signed(top.per_lap), unit: 's/lap',
      note: top.label.toLowerCase(), delta: top.per_lap },
  ].filter(Boolean) as { label: string; value: string; unit: string; note: string; delta: number | null }[];
  const barOf = (d: number | null) =>
    d == null || Math.abs(d) < 0.005 ? theme.rule : d > 0 ? theme.delta.loss : theme.delta.gain;
  return (
    <View style={styles.summary}>
      <CornerText style={StyleSheet.flatten([styles.headline, wide ? null : styles.headlinePhone])}
        text={words.headline} {...at} />
      {words.advice && (
        <View style={styles.advice}>
          <CornerText style={tx.body} text={words.advice} {...at} />
        </View>
      )}
      {tiles.length > 0 && (
        <FigRow style={styles.figs}>
          {tiles.map((t) => (
            <Fig key={t.label} label={t.label} value={t.value} unit={t.unit} size={wide ? 52 : 38} bar={barOf(t.delta)}
              barHeight={6} note={t.note} />
          ))}
        </FigRow>
      )}
      {pending > 0 && (
        <View style={styles.pending}>
          <Text style={tx.body}>
            {pending === 1 ? '1 lap looks' : `${pending} laps look`} slowed by traffic, a safety car or an FCY.
          </Text>
          <TextLink small red label={`Check ${pending === 1 ? 'it' : 'them'} in the lap list ↓`} onPress={onPending} />
        </View>
      )}
      {(words.car.length > 0 || words.driver.length > 0) && (
        <View style={wide ? styles.lists : styles.listsPhone}>
          {words.car.length > 0 && (
            <View style={wide ? styles.listCol : styles.list}>
              <Text style={tx.sub}>The car</Text>
              {words.car.map((s) => <Bullet key={s} text={s} at={at} />)}
            </View>
          )}
          {words.driver.length > 0 && (
            <View style={wide ? styles.listCol : styles.list}>
              <Text style={tx.sub}>The driving</Text>
              {words.driver.map((s) => <Bullet key={s} text={s} at={at} />)}
            </View>
          )}
        </View>
      )}
      {words.fuel && <Text style={tx.small}>{words.fuel}</Text>}
      {words.left_out && <Text style={tx.small}>{words.left_out}</Text>}
    </View>
  );
}

function Bullet({ text, at }: { text: string; at: PointAt }) {
  const styles = useStyles();
  const tx = useText();
  return (
    <View style={styles.bullet}>
      <View style={styles.bulletMark} />
      <CornerText style={StyleSheet.flatten([tx.body, styles.flex])} text={text} {...at} />
    </View>
  );
}

// ---------- grip and balance by phase ----------

function PhaseTable({ fits, fade, stint, wide }: {
  fits: Partial<Record<string, Fit>>; fade: StintView['overall']['fade']; stint: Stint | null; wide: boolean;
}) {
  const theme = useTheme();
  const styles = useStyles();
  const tx = useText();
  const pal = useBalanceColors();
  const [phase, setPhase] = useState<GripPhase>('exit');
  // every phase's grip and balance lap by lap zoom together; another stint starts on every lap again
  const zoom = useZoomState(stint?.key);
  const pct = (f?: Fit) => (f && f.level ? (100 * f.change) / f.level : null);
  const gripMax = Math.max(3, ...GRIP_PHASES.map((p) => Math.abs(pct(fits[`grip_${p.key}`]) ?? 0)));
  const balMax = Math.max(0.5, ...GRIP_PHASES.map((p) => Math.abs(p.balance ? fits[`balance_${p.balance}`]?.change ?? 0 : 0)));
  const shown = wide ? GRIP_PHASES : GRIP_PHASES.filter((p) => p.key === phase);
  return (
    <View style={styles.block}>
      <View style={StyleSheet.flatten([styles.block, styles.narrow])}>
        <View>
          <View style={styles.tableHead}>
            <Text style={StyleSheet.flatten([styles.th, styles.phaseCol])}>Phase</Text>
            <Text style={StyleSheet.flatten([styles.th, styles.numCol])}>Grip</Text>
            <Text style={StyleSheet.flatten([styles.th, styles.flex])}>Grip change</Text>
            <Text style={StyleSheet.flatten([styles.th, styles.flex])}>Balance shift</Text>
          </View>
          {GRIP_PHASES.map((p) => {
            const g = fits[`grip_${p.key}`];
            const b = p.balance ? fits[`balance_${p.balance}`] : undefined;
            const gp = pct(g);
            const on = !wide && stint != null && p.key === phase;
            return (
              <Pressable key={p.key} onPress={() => setPhase(p.key)} disabled={wide || stint == null}
                accessibilityLabel={`${p.label}: grip ${fixed(g?.level, 2)} g, ${signed(gp, 1)} %, balance ${signed(b?.change)}°`}
                {...a11yState({ selected: on })}
                style={StyleSheet.flatten([styles.phaseRow, on && styles.phaseRowOn])}>
                <View style={StyleSheet.flatten([styles.phaseCol, styles.phaseName])}>
                  <View style={StyleSheet.flatten([styles.phaseKey, { backgroundColor: phaseColor(theme, p.key) }])} />
                  <Text style={StyleSheet.flatten([styles.phaseLabel, on && styles.phaseLabelOn])} numberOfLines={2}>
                    {p.label}
                  </Text>
                </View>
                <Text style={StyleSheet.flatten([styles.numCol, styles.num])}>{fixed(g?.level, 2)} g</Text>
                <View style={styles.cellBar}>
                  <ChangeBar value={gp} max={gripMax} color={(gp ?? 0) < 0 ? theme.delta.loss : theme.delta.gain} faded={!g?.clear} />
                  <Text style={StyleSheet.flatten([styles.num, styles.cellNum, !g?.clear && styles.dim])}>
                    {gp == null ? '–' : `${signed(gp, 1)} %`}
                  </Text>
                </View>
                <View style={styles.cellBar}>
                  {b ? (
                    <>
                      <ChangeBar value={b.change} max={balMax} color={shiftColor(b.change, pal)} faded={!b.clear} />
                      <Text style={StyleSheet.flatten([styles.num, styles.cellNum, !b.clear && styles.dim])}>
                        {signed(b.change)}°
                      </Text>
                    </>
                  ) : <Text style={StyleSheet.flatten([styles.num, styles.flex, styles.dim])}>–</Text>}
                </View>
              </Pressable>
            );
          })}
        </View>
        <View style={styles.captionRow}>
          <Text style={StyleSheet.flatten([tx.small, styles.flex])}>
            Change from the first to the last lap{stint ? ' of the stint' : ' of a stint, over every stint in view'}. Grip
            falling in red, rising in green; balance moving towards understeer in blue, oversteer in magenta. Faded:
            within the lap-to-lap scatter.{!wide && stint ? ' Tap a phase to see it lap by lap.' : ''}
            {stint ? ` ${ZOOM_HINT}` : ''}
          </Text>
          {stint && <ResetZoom zoom={zoom} reserve />}
        </View>
      </View>
      {stint ? (
        <ZoomGroup zoom={zoom}>
          <View style={styles.panels}>
            {shown.map((p) => (
              <PhasePanel key={p.key} stint={stint} phase={p} fade={fade.find((f) => f.key === p.key)}
                width={wide ? '48%' : '100%'} />
            ))}
          </View>
        </ZoomGroup>
      ) : (
        <Text style={tx.small}>Open a stint to see grip and balance lap by lap.</Text>
      )}
    </View>
  );
}

function PhasePanel({ stint, phase, fade, width }: {
  stint: Stint; phase: (typeof GRIP_PHASES)[number]; fade?: StintView['overall']['fade'][number]; width: `${number}%`;
}) {
  const theme = useTheme();
  const styles = useStyles();
  const tx = useText();
  const c = useChartColors();
  const laps = stint.laps.filter((l) => l.in_fit);
  if (laps.length < 2) return null;
  const x = laps.map((l) => l.lap);
  const grip = laps.map((l) => l.grip?.[phase.key] ?? null);
  const bal = phase.balance ? laps.map((l) => l.balance?.[phase.balance as BalancePhase] ?? null) : null;
  return (
    <View style={StyleSheet.flatten([styles.panel, { width }])}>
      <View style={styles.panelHead}>
        <View style={StyleSheet.flatten([styles.phaseKey, { backgroundColor: phaseColor(theme, phase.key) }])} />
        <Text style={styles.panelTitle}>{phase.label}</Text>
      </View>
      <Text style={tx.small}>
        {phase.measure}
        {fade ? ` · fade ${signed(fade.per_lap, 3)} s/lap${fade.clear ? '' : ' (within scatter)'}` : ''}
      </Text>
      <LineChart x={x} series={[{ key: 'g', label: 'Grip', values: grip, color: phaseColor(theme, phase.key) }]} legend={[]}
        height={130}
        title="Grip, g" unit="lap" formatX={(v) => `L${v}`} formatY={(v) => v.toFixed(2)}
        readout={(i) => [{ label: 'grip', value: `${fixed(grip[i], 3)} g`, color: phaseColor(theme, phase.key) }]} />
      {!bal && <Text style={tx.small}>No balance here: the car runs straight.</Text>}
      {bal && (
        <LineChart x={x} series={[{ key: 'b', label: 'Balance', values: bal, color: c.s3 }]} legend={[]} height={130}
          title="Balance, ° against normal (+ understeer)" unit="lap" formatX={(v) => `L${v}`}
          formatY={(v) => v.toFixed(2)}
          readout={(i) => [{ label: 'balance', value: `${signed(bal[i])}°`, color: c.s3 }]} />
      )}
    </View>
  );
}

// ---------- balance shift per corner ----------

function median(v: number[]) {
  const s = [...v].sort((a, b) => a - b);
  return s.length === 0 ? null : s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
}

function CornerShift({ sections, stints, onCorner }: { sections: SectionRow[]; stints: Stint[]; onCorner?: OnCorner }) {
  const styles = useStyles();
  const tx = useText();
  const [phase, setPhase] = useState<BalancePhase>('entry');
  const grouped = stints.filter((s) => s.groups);
  // the whole lap: the median of the early laps and of the late laps of each stint, as per corner
  const early: number[] = [], late: number[] = [];
  for (const s of grouped) {
    for (const l of s.laps) {
      const v = l.balance?.[phase];
      if (v == null) continue;
      if (s.groups!.early.includes(l.lap)) early.push(v);
      if (s.groups!.late.includes(l.lap)) late.push(v);
    }
  }
  const rows: ShiftRow[] = [];
  const e = median(early), la = median(late);
  if (e != null && la != null && early.length >= 2 && late.length >= 2) {
    rows.push({ label: 'Whole lap', early: e, late: la, shift: la - e, strong: true });
  }
  for (const s of sections) {
    const b = s[phase];
    if (s.corner && b) rows.push({ label: s.code, ...b });
  }
  const earlyLaps = grouped.length === 1 ? `laps ${grouped[0].groups!.early.join(', ')}` : 'first third';
  const lateLaps = grouped.length === 1 ? `laps ${grouped[0].groups!.late.join(', ')}` : 'last third';
  const moved = rows.filter((r) => !r.strong && Math.abs(r.shift) >= MIN_SHIFT).length;
  return (
    <View style={styles.block}>
      <Tabs value={phase} onChange={setPhase} items={[
        { key: 'entry', label: 'Entry' },
        { key: 'mid', label: 'Mid-corner' },
        { key: 'exit', label: 'Exit' },
      ]} />
      {rows.length === 0 ? (
        <Text style={tx.note}>
          Not enough flying laps for an early and a late group (it takes 4 in a stint), or no steering and yaw rate to
          read the balance from.
        </Text>
      ) : (
        <>
          <Text style={tx.note}>
            {moved === 0 ? 'Every corner holds within ±0.15°.' : `${moved} of ${rows.length - (rows[0]?.strong ? 1 : 0)
            } corners move more than ${MIN_SHIFT}°.`}
          </Text>
          <View style={styles.narrow}>
            <BalanceDumbbell rows={rows} early={earlyLaps} late={lateLaps} onCorner={onCorner} />
          </View>
        </>
      )}
    </View>
  );
}

// ---------- laps ----------

function LapTimes({ stint }: { stint: Stint }) {
  const c = useChartColors();
  // the laps in the trend, with a gap (and a label on the axis) where a tagged lap or an outlier was left out
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

function LapList({ stint, onTag, tagging }: {
  stint: Stint; onTag: (s: Stint, l: StintLap, to: Tag | 'none' | 'count' | null) => void; tagging: string | null;
}) {
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

const COLUMNS: { title: string; width: number; value: (l: StintLap) => string }[] = [
  { title: 'Lap', width: 44, value: (l) => `${l.lap}` },
  { title: 'Time', width: 64, value: (l) => formatLap(l.time) },
  { title: 'Fuel-corr.', width: 72, value: (l) => formatLap(l.corrected_time) },
  { title: 'Fuel kg', width: 56, value: (l) => fixed(l.fuel_kg, 2) },
  { title: 'Brake g', width: 56, value: (l) => fixed(l.grip?.braking, 2) },
  { title: 'Trail g', width: 52, value: (l) => fixed(l.grip?.trail, 2) },
  { title: 'Mid g', width: 50, value: (l) => fixed(l.grip?.mid, 2) },
  { title: 'Exit g', width: 50, value: (l) => fixed(l.grip?.exit, 2) },
  { title: 'Tract. g', width: 58, value: (l) => fixed(l.grip?.power, 2) },
  { title: 'Entry°', width: 52, value: (l) => signed(l.balance?.entry) },
  { title: 'Mid°', width: 50, value: (l) => signed(l.balance?.mid) },
  { title: 'Exit°', width: 50, value: (l) => signed(l.balance?.exit) },
  { title: 'TC s', width: 44, value: (l) => fixed(l.tc_s) },
  { title: 'ABS s', width: 48, value: (l) => fixed(l.abs_s) },
  { title: 'Tyre bar', width: 62, value: (l) => fixed(average(l.tyres?.pressure_bar), 2) },
  { title: 'Tyre °C', width: 58, value: (l) => fixed(average(l.tyres?.temperature_c), 0) },
];

function LapTable({ stint, unit }: { stint: Stint; unit: string }) {
  const styles = useStyles();
  const tx = useText();
  const [open, setOpen] = useState(false);
  return (
    <View style={styles.block}>
      <TextLink label={open ? 'Hide the numbers' : 'Every lap in numbers'} onPress={() => setOpen(!open)} arrow={!open} />
      {open && (
        <>
          <ScrollView horizontal>
            <View>
              <View style={styles.numHead}>
                {COLUMNS.map((c) => (
                  <Text key={c.title} style={StyleSheet.flatten([styles.cell, styles.th, { width: c.width }])}>
                    {c.title}
                  </Text>
                ))}
              </View>
              {stint.laps.map((l) => (
                <View key={l.lap} style={StyleSheet.flatten([styles.numRow, !l.in_fit && styles.lapOff])}>
                  {COLUMNS.map((c) => (
                    <Text key={c.title} style={StyleSheet.flatten([styles.cell, { width: c.width }, !l.in_fit && styles.muted])}>
                      {c.value(l)}
                    </Text>
                  ))}
                </View>
              ))}
            </View>
          </ScrollView>
          <Text style={tx.small}>
            Grey laps are left out of the trends. Grip in g per phase (90th percentile). Balance in {unit === 'deg' ? '°'
              : unit} of understeer angle against the car&apos;s normal at the same cornering g, + understeer.
          </Text>
        </>
      )}
    </View>
  );
}

function StintCard({ stint, many, first, onPress }: { stint: Stint; many: boolean; first: boolean; onPress: () => void }) {
  const styles = useStyles();
  const tx = useText();
  const t = stint.fits.corrected_time ?? stint.fits.time;
  return (
    <Pressable onPress={onPress} style={StyleSheet.flatten([styles.stintRow, first && styles.stintFirst])}
      accessibilityRole="button" accessibilityLabel={`Open ${stintName(stint, many)}`}>
      <View style={styles.stintHead}>
        <Text style={styles.stintTitle}>{many ? `${stint.run} · ` : ''}Stint {stint.number}</Text>
        <TextLink small label="Open" arrow onPress={onPress} />
      </View>
      <Text style={tx.labelMuted}>
        Laps {stint.first_lap}–{stint.last_lap} · {stint.fitted_laps} in the trend · best {formatLap(stint.best)}
        {t ? ` · tyres ${signed(t.per_lap)} s/lap${t.clear ? '' : ' (no clear trend)'}` : ''}
      </Text>
      <Text style={tx.body}>{stint.words.headline}</Text>
    </Pressable>
  );
}

const useStyles = themed((c) => ({
  screen: { flex: 1, backgroundColor: c.background },
  split: { flexDirection: 'row' },
  pinned: { borderBottomWidth: 1, borderColor: c.rule, paddingHorizontal: 16, paddingBottom: 6, backgroundColor: c.background },
  pinnedBar: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 40, backgroundColor: 'transparent' },
  gone: { display: 'none' },
  side: { borderLeftWidth: 1, borderColor: c.rule, padding: 16, gap: 8, backgroundColor: c.background },
  top: { gap: 18, marginTop: 18 },
  left: { alignSelf: 'flex-start' },
  flex: { flex: 1, minWidth: 0, backgroundColor: 'transparent' },
  narrow: { maxWidth: 760, backgroundColor: 'transparent' },
  block: { gap: 14, backgroundColor: 'transparent' },
  busy: { flexDirection: 'row', gap: 10, alignItems: 'center' },
  dim: { opacity: 0.45 },
  muted: { color: c.textMuted },
  notes: { gap: 6, marginTop: 24, maxWidth: 760 },
  // the logs
  picker: { gap: 8 },
  pickerHead: { flexDirection: 'row', alignItems: 'center', gap: 12, borderBottomWidth: 1, borderColor: c.rule,
    paddingBottom: 6 },
  tickedRow: { flexDirection: 'row', flexWrap: 'wrap', columnGap: 18, rowGap: 8, alignItems: 'center' },
  tickedItem: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 2 },
  tickedText: { fontFamily: face('body', 600), fontSize: 15, color: c.text },
  tickedX: { fontFamily: Fonts.label, fontSize: 12, color: c.textMuted },
  event: { gap: 2, marginTop: 8 },
  eventHead: { flexDirection: 'row', alignItems: 'baseline', flexWrap: 'wrap', columnGap: 10, marginBottom: 2 },
  eventName: { fontFamily: Fonts.display, fontSize: 20, lineHeight: 24, textTransform: 'uppercase', color: c.text },
  logRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 8, minHeight: 44, borderBottomWidth: 1,
    borderColor: c.separator },
  logName: { fontFamily: face('body', 600), fontSize: 15, color: c.text },
  // the summary
  summary: { gap: 18 },
  headline: { fontFamily: face('body', 600), fontSize: 24, lineHeight: 32, color: c.text, maxWidth: 860 },
  headlinePhone: { fontSize: 20, lineHeight: 27 },
  advice: { borderLeftWidth: 4, borderColor: c.rule, paddingLeft: 14, paddingVertical: 2, maxWidth: 820 },
  figs: { marginTop: 4 },
  pending: { gap: 8 },
  lists: { flexDirection: 'row', gap: 32, alignItems: 'flex-start' },
  listsPhone: { gap: 20 },
  listCol: { flex: 1, minWidth: 0, gap: 8 },
  list: { gap: 8 },
  bullet: { flexDirection: 'row', gap: 10, alignItems: 'flex-start' },
  bulletMark: { width: 7, height: 7, backgroundColor: c.text, marginTop: 8 },
  // grip and balance
  tableHead: { flexDirection: 'row', gap: 8, borderBottomWidth: 1, borderColor: c.rule, paddingBottom: 5 },
  th: { ...Type.label, fontSize: 11, color: c.text },
  phaseRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 9, borderBottomWidth: 1,
    borderColor: c.separator },
  phaseRowOn: { backgroundColor: c.surfaceRaised },
  phaseCol: { width: 112 },
  phaseName: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  phaseKey: { width: 12, height: 12 },
  phaseLabel: { fontFamily: Fonts.body, fontSize: 15, color: c.text, flexShrink: 1 },
  phaseLabelOn: { fontFamily: face('body', 700) },
  numCol: { width: 56 },
  num: { ...Type.number, fontSize: 13, color: c.text },
  cellBar: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: 'transparent' },
  cellNum: { width: 50, textAlign: 'right' },
  panels: { flexDirection: 'row', flexWrap: 'wrap', rowGap: 24, columnGap: 16, justifyContent: 'space-between' },
  panel: { gap: 8, borderTopWidth: 3, borderColor: c.rule, paddingTop: 8 },
  panelHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  captionRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 12 },
  panelTitle: { fontFamily: Fonts.display, fontSize: 22, lineHeight: 26, textTransform: 'uppercase', color: c.text },
  // laps
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
  tagBox: { borderWidth: 1, borderColor: c.rule, paddingHorizontal: 9, paddingVertical: 7, minWidth: 44,
    alignItems: 'center' },
  tagSuggested: { borderColor: c.mark, borderStyle: 'dashed', borderWidth: 2 },
  tagText: { ...Type.label, fontSize: 12, color: c.text },
  suggest: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: 14, rowGap: 6, marginLeft: 46 },
  numHead: { flexDirection: 'row', borderBottomWidth: 1, borderColor: c.rule, paddingBottom: 4 },
  numRow: { flexDirection: 'row', borderBottomWidth: 1, borderColor: c.separator, paddingVertical: 5 },
  cell: { ...Type.number, fontSize: 13, color: c.text, paddingRight: 6, textAlign: 'right' },
  // the stints
  stintRow: { gap: 6, paddingVertical: 14, borderTopWidth: 1, borderColor: c.separator },
  stintFirst: { borderTopWidth: 0, paddingTop: 0 },
  stintHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  stintTitle: { fontFamily: Fonts.display, fontSize: 26, lineHeight: 30, textTransform: 'uppercase', color: c.text,
    flexShrink: 1 },
}));
