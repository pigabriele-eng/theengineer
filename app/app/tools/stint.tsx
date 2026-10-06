import { Stack, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, useWindowDimensions } from 'react-native';

import { LineChart, useChartColors } from '@/components/ReportCharts';
import { SessionSwitcher, useEventFolder } from '@/components/SessionSwitcher';
import { BalanceDumbbell, ChangeBar, FadeBars, MIN_SHIFT, ShiftRow, shiftColor, useBalanceColors }
  from '@/components/StintCharts';
import { Text, View, useThemeColor } from '@/components/Themed';
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

const ALL = 'all';
const MAX_LOGS = 12; // the server reads at most this many logs in one view

// Stint analysis: tick one or more logs, then each stint lap by lap: how the car fades (fuel burn and tyres apart,
// by phase and corner), grip and balance per phase, and how the driver adapts. Tag laps lost to a safety car, FCY or
// traffic and they leave the trends. Open with ?session=<id> to start with that session's log ticked, or ?event=<id>
// with every run of the event.
export default function StintScreen() {
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
  const background = useThemeColor({}, 'background');
  const { width } = useWindowDimensions();
  const wide = width >= 760;

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

  const tag = async (stint: Stint, lap: StintLap, to: Tag | 'none' | null) => {
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

  return (
    <ScrollView ref={scroll} style={{ backgroundColor: background }} contentContainerStyle={styles.container}>
      <Stack.Screen options={{ title: 'Stint analysis' }} />
      <View style={styles.page}>
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

        {error && <Text style={styles.error}>{error}</Text>}
        {busy && (
          <View style={styles.busy}>
            <ActivityIndicator />
            <Text style={styles.dim}>{view ? 'Updating…' : 'Reading the logs…'}</Text>
          </View>
        )}
        {!busy && ticked.length === 0 && events && events.length > 0 && (
          <Text style={styles.dim}>Tick one or more logs to see their stints.</Text>
        )}

        {view && words && (
          <>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
              {view.stints.length > 1 && (
                <ScopeChip on={scope === ALL} onPress={() => setScope(ALL)} title="All stints"
                  sub={`${view.overall.fitted_laps} flying laps`} />
              )}
              {view.stints.map((s) => (
                <ScopeChip key={s.key} on={scope === s.key} onPress={() => setScope(s.key)}
                  title={`${many ? `${s.run} · ` : ''}Stint ${s.number}`}
                  sub={`laps ${s.first_lap}–${s.last_lap} · ${s.fitted_laps} in the trend`} />
              ))}
            </ScrollView>

            <Summary words={words} fits={stint ? stint.fits : view.overall.fits}
              fuel={stint ? stint.fuel : view.overall.fuel} top={(stint ? stint.fade : view.overall.fade)[0]}
              pending={pending} onPending={() => scroll.current?.scrollTo({ y: lapsY.current, animated: true })} />

            {(stint ? stint.fade : view.overall.fade).length > 0 && (
              <Section title="Where the fade comes from"
                intro="Each lap's time against the stint's typical lap, fuel burn taken out, charged to the phase where it was lost: speed lost on an exit counts against the exit all the way down the straight that follows.">
                <View style={styles.narrow}>
                  <FadeBars rows={stint ? stint.fade : view.overall.fade} />
                </View>
              </Section>
            )}

            <Section title="Grip and balance by phase"
              intro={`Grip: the g the car pulls in each phase (90th percentile of the lap). Balance: the understeer angle against the car's normal at the same cornering g (${view.understeer_per_g ?? '–'}° per g), + understeer, − oversteer.`}>
              <PhaseTable fits={stint ? stint.fits : view.overall.fits} fade={stint ? stint.fade : view.overall.fade}
                stint={stint} wide={wide} />
            </Section>

            <Section title="Balance shift per corner"
              intro="How the balance moves from the stint's early laps to its late laps, corner by corner.">
              <CornerShift sections={stint ? stint.sections : view.overall.sections}
                stints={stint ? [stint] : view.stints} />
            </Section>

            {stint ? (
              <View onLayout={(e) => (lapsY.current = e.nativeEvent.layout.y)} style={styles.section}>
                <Text style={styles.h2}>Laps</Text>
                <LapTimes stint={stint} />
                <LapList stint={stint} onTag={tag} tagging={tagging} />
                <LapTable stint={stint} unit={view.units.steer} />
              </View>
            ) : (
              <View onLayout={(e) => (lapsY.current = e.nativeEvent.layout.y)} style={styles.section}>
                <Text style={styles.h2}>Stints</Text>
                <Text style={styles.small}>Open a stint to see it lap by lap and tag its slow laps.</Text>
                {view.stints.map((s) => (
                  <StintCard key={s.key} stint={s} many={many} onPress={() => {
                    setScope(s.key);
                    scroll.current?.scrollTo({ y: 0, animated: true });
                  }} />
                ))}
              </View>
            )}

            {view.notes.map((n) => (
              <Text key={n} style={styles.small}>
                {n}
              </Text>
            ))}
          </>
        )}
      </View>
    </ScrollView>
  );
}

// ---------- the logs to tick ----------

function Picker({ events, ticked, open, setOpen, toggle, track }: {
  events: LogEvent[] | null; ticked: number[]; open: boolean; setOpen: (o: boolean) => void;
  toggle: (id: number) => void; track: string | null;
}) {
  const tint = useThemeColor({}, 'tint');
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
  if (events == null) return <ActivityIndicator />;
  if (events.length === 0) {
    return <Text style={styles.dim}>No logs yet. Upload a logger file (.ld or a CSV export) to a session first.</Text>;
  }
  return (
    <View style={styles.card}>
      <View style={styles.pickerHead}>
        <View style={styles.flex}>
          <Text style={styles.h3}>Logs</Text>
          <Text style={styles.small}>
            {ticked.length === 0 ? 'None ticked' : `${ticked.length} ticked${track || tickedTrack ? ` · ${track ??
              tickedTrack}` : ''}`}
          </Text>
        </View>
        <Pressable onPress={() => setOpen(!open)} style={styles.button} accessibilityRole="button">
          <Text style={{ color: tint, fontWeight: '600' }}>{open ? 'Done' : 'Change'}</Text>
        </Pressable>
      </View>
      {!open && ticked.length > 0 && (
        <View style={styles.tickedRow}>
          {ticked.slice(0, ticked.length > 5 ? 4 : 5).map((id) => (
            <Pressable key={id} onPress={() => toggle(id)} style={styles.tickedChip}
              accessibilityLabel={`Untick ${files.get(id)?.label ?? id}`}>
              <Text style={styles.tickedText}>{files.get(id)?.label ?? `Log ${id}`}</Text>
              <Text style={styles.dim}>✕</Text>
            </Pressable>
          ))}
          {ticked.length > 5 && (
            <Pressable onPress={() => setOpen(true)} style={styles.tickedChip} accessibilityRole="button">
              <Text style={StyleSheet.flatten([styles.tickedText, { color: tint }])}>+{ticked.length - 4} more</Text>
            </Pressable>
          )}
        </View>
      )}
      {open && events.map((e) => {
        const other = tickedTrack != null && e.track != null && e.track !== tickedTrack;
        return (
          <View key={e.id ?? 'none'} style={styles.event}>
            <Text style={styles.eventName}>
              {e.name}
              {e.track ? <Text style={styles.dim}>{`  ${e.track}`}</Text> : null}
            </Text>
            {other && <Text style={styles.small}>Another track: untick the others to compare these.</Text>}
            {e.sessions.flatMap((s) => s.files.map((f) => {
              const on = ticked.includes(f.id);
              const empty = f.laps === 0;
              return (
                <Pressable key={f.id} onPress={() => toggle(f.id)} disabled={(empty || other) && !on}
                  accessibilityRole="checkbox" accessibilityState={{ checked: on, disabled: (empty || other) && !on }}
                  style={StyleSheet.flatten([styles.logRow, (empty || other) && !on && styles.dim])}>
                  <View style={StyleSheet.flatten([styles.box, on && { backgroundColor: tint, borderColor: tint }])}>
                    {on && <Text style={styles.tick}>✓</Text>}
                  </View>
                  <View style={styles.flex}>
                    <Text style={styles.logName}>{s.files.length > 1 ? `${s.name} · ${f.filename}` : s.name}</Text>
                    <Text style={styles.small}>
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

function ScopeChip({ on, onPress, title, sub }: { on: boolean; onPress: () => void; title: string; sub: string }) {
  const tint = useThemeColor({}, 'tint');
  return (
    <Pressable onPress={onPress} accessibilityRole="tab" accessibilityState={{ selected: on }}
      style={StyleSheet.flatten([styles.chip, on && { borderColor: tint, borderWidth: 2 }])}>
      <Text style={StyleSheet.flatten([styles.chipTitle, on && { color: tint }])}>{title}</Text>
      <Text style={styles.chipSub}>{sub}</Text>
    </Pressable>
  );
}

// ---------- the plain-words summary ----------

function Summary({ words, fits, fuel, top, pending, onPending }: {
  words: Words; fits: Partial<Record<string, Fit>>; fuel: StintView['overall']['fuel']; top?: StintView['overall']['fade'][number];
  pending: number; onPending: () => void;
}) {
  const tint = useThemeColor({}, 'tint');
  const tyres = fits.corrected_time ?? fits.time;
  const tiles = [
    tyres && { label: fits.corrected_time ? 'Tyres' : 'Lap time', value: `${signed(tyres.per_lap)} s/lap`,
      sub: tyres.clear ? 'clear trend' : `within ±${tyres.within.toFixed(2)}` },
    fuel?.fuel_s_per_lap != null && { label: 'Fuel burn', value: `${signed(fuel.fuel_s_per_lap)} s/lap`,
      sub: `${fuel.kg_per_lap?.toFixed(2)} kg/lap${fuel.source === 'log' ? '' : ' (estimate)'}` },
    fuel && { label: '10 kg of fuel', value: `${fuel.s_per_10kg.toFixed(2)} s/lap`, sub: 'here' },
    top && top.clear && top.per_lap > 0 && { label: 'Biggest fade', value: `${signed(top.per_lap)} s/lap`,
      sub: top.label.toLowerCase() },
  ].filter(Boolean) as { label: string; value: string; sub: string }[];
  return (
    <View style={styles.card}>
      <Text style={styles.headline}>{words.headline}</Text>
      {words.advice && (
        <View style={StyleSheet.flatten([styles.advice, { borderLeftColor: tint }])}>
          <Text style={styles.body}>{words.advice}</Text>
        </View>
      )}
      {tiles.length > 0 && (
        <View style={styles.tiles}>
          {tiles.map((t) => (
            <View key={t.label} style={styles.tile}>
              <Text style={styles.tileLabel}>{t.label}</Text>
              <Text style={styles.tileValue}>{t.value}</Text>
              <Text style={styles.tileSub}>{t.sub}</Text>
            </View>
          ))}
        </View>
      )}
      {pending > 0 && (
        <Pressable onPress={onPending} accessibilityRole="link">
          <Text style={{ color: tint }}>
            {pending === 1 ? '1 lap looks' : `${pending} laps look`} slowed by traffic, a safety car or an FCY: check
            {pending === 1 ? ' it' : ' them'} in the lap list ↓
          </Text>
        </Pressable>
      )}
      {words.car.length > 0 && (
        <View style={styles.list}>
          <Text style={styles.h3}>The car</Text>
          {words.car.map((s) => <Bullet key={s} text={s} />)}
        </View>
      )}
      {words.driver.length > 0 && (
        <View style={styles.list}>
          <Text style={styles.h3}>Your driving</Text>
          {words.driver.map((s) => <Bullet key={s} text={s} />)}
        </View>
      )}
      {words.fuel && <Text style={styles.small}>{words.fuel}</Text>}
      {words.left_out && <Text style={styles.small}>{words.left_out}</Text>}
    </View>
  );
}

function Bullet({ text }: { text: string }) {
  return (
    <View style={styles.bullet}>
      <Text style={styles.bulletDot}>•</Text>
      <Text style={StyleSheet.flatten([styles.body, styles.flex])}>{text}</Text>
    </View>
  );
}

function Section({ title, intro, children }: { title: string; intro?: string; children: React.ReactNode }) {
  return (
    <View style={styles.section}>
      <Text style={styles.h2}>{title}</Text>
      {intro && <Text style={styles.small}>{intro}</Text>}
      {children}
    </View>
  );
}

// ---------- grip and balance by phase ----------

function PhaseTable({ fits, fade, stint, wide }: {
  fits: Partial<Record<string, Fit>>; fade: StintView['overall']['fade']; stint: Stint | null; wide: boolean;
}) {
  const c = useChartColors();
  const pal = useBalanceColors();
  const tint = useThemeColor({}, 'tint');
  const [phase, setPhase] = useState<GripPhase>('exit');
  const pct = (f?: Fit) => (f && f.level ? (100 * f.change) / f.level : null);
  const gripMax = Math.max(3, ...GRIP_PHASES.map((p) => Math.abs(pct(fits[`grip_${p.key}`]) ?? 0)));
  const balMax = Math.max(0.5, ...GRIP_PHASES.map((p) => Math.abs(p.balance ? fits[`balance_${p.balance}`]?.change ?? 0 : 0)));
  const shown = wide ? GRIP_PHASES : GRIP_PHASES.filter((p) => p.key === phase);
  return (
    <View style={styles.block}>
      <View style={StyleSheet.flatten([styles.block, styles.narrow])}>
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
              style={StyleSheet.flatten([styles.phaseRow, on && { borderColor: tint }])}>
              <Text style={StyleSheet.flatten([styles.phaseCol, styles.body, on && { color: tint, fontWeight: '600' }])}>
                {p.label}
              </Text>
              <Text style={StyleSheet.flatten([styles.numCol, styles.num])}>{fixed(g?.level, 2)} g</Text>
              <View style={styles.cellBar}>
                <ChangeBar value={gp} max={gripMax} color={(gp ?? 0) < 0 ? c.s2 : c.s1} faded={!g?.clear} />
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
                ) : <Text style={StyleSheet.flatten([styles.dim, styles.flex])}>–</Text>}
              </View>
            </Pressable>
          );
        })}
        <Text style={styles.small}>
          Change from the first to the last lap{stint ? ' of the stint' : ' of a stint, over every stint in view'}. Grip
          falling in orange, rising in blue; balance moving towards understeer in blue, oversteer in red. Faded: within
          the lap-to-lap scatter.{!wide && stint ? ' Tap a phase to see it lap by lap.' : ''}
        </Text>
      </View>
      {stint ? (
        <View style={styles.panels}>
          {shown.map((p) => (
            <PhasePanel key={p.key} stint={stint} phase={p} fade={fade.find((f) => f.key === p.key)}
              width={wide ? '48.5%' : '100%'} />
          ))}
        </View>
      ) : (
        <Text style={styles.small}>Open a stint to see grip and balance lap by lap.</Text>
      )}
    </View>
  );
}

function PhasePanel({ stint, phase, fade, width }: {
  stint: Stint; phase: (typeof GRIP_PHASES)[number]; fade?: StintView['overall']['fade'][number]; width: `${number}%`;
}) {
  const c = useChartColors();
  const laps = stint.laps.filter((l) => l.in_fit);
  if (laps.length < 2) return null;
  const x = laps.map((l) => l.lap);
  const grip = laps.map((l) => l.grip?.[phase.key] ?? null);
  const bal = phase.balance ? laps.map((l) => l.balance?.[phase.balance as BalancePhase] ?? null) : null;
  return (
    <View style={StyleSheet.flatten([styles.panel, { width }])}>
      <Text style={styles.h3}>{phase.label}</Text>
      <Text style={styles.small}>
        {phase.measure}
        {fade ? ` · fade ${signed(fade.per_lap, 3)} s/lap${fade.clear ? '' : ' (within scatter)'}` : ''}
      </Text>
      <LineChart x={x} series={[{ key: 'g', label: 'Grip', values: grip, color: c.s1 }]} legend={[]} height={130}
        title="Grip, g" unit="lap" formatX={(v) => `L${v}`} formatY={(v) => v.toFixed(2)}
        readout={(i) => [{ label: 'grip', value: `${fixed(grip[i], 3)} g`, color: c.s1 }]} />
      {!bal && <Text style={styles.small}>No balance here: the car runs straight.</Text>}
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

function CornerShift({ sections, stints }: { sections: SectionRow[]; stints: Stint[] }) {
  const tint = useThemeColor({}, 'tint');
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
      <View style={styles.toggle}>
        {(['entry', 'mid', 'exit'] as BalancePhase[]).map((p) => (
          <Pressable key={p} onPress={() => setPhase(p)} accessibilityRole="tab" accessibilityState={{ selected: p === phase }}
            style={StyleSheet.flatten([styles.toggleItem, p === phase && { borderColor: tint, borderWidth: 2 }])}>
            <Text style={p === phase ? { color: tint, fontWeight: '600' } : undefined}>
              {p === 'entry' ? 'Entry' : p === 'mid' ? 'Mid-corner' : 'Exit'}
            </Text>
          </Pressable>
        ))}
      </View>
      {rows.length === 0 ? (
        <Text style={styles.small}>
          Not enough flying laps for an early and a late group (it takes 4 in a stint), or no steering and yaw rate to
          read the balance from.
        </Text>
      ) : (
        <>
          <Text style={styles.small}>
            {moved === 0 ? 'Every corner holds within ±0.15°.' : `${moved} of ${rows.length - (rows[0]?.strong ? 1 : 0)
            } corners move more than ${MIN_SHIFT}°.`}
          </Text>
          <BalanceDumbbell rows={rows} early={earlyLaps} late={lateLaps} />
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

function LapList({ stint, onTag, tagging }: {
  stint: Stint; onTag: (s: Stint, l: StintLap, to: Tag | 'none' | null) => void; tagging: string | null;
}) {
  const tint = useThemeColor({}, 'tint');
  const background = useThemeColor({}, 'background');
  return (
    <View style={styles.block}>
      <Text style={styles.small}>
        Tag a lap lost to a safety car, an FCY or traffic: it stays in the list, marked, and leaves the trends, the
        fade and the averages. Tap the tag again to clear it.
      </Text>
      {stint.laps.map((l) => {
        const taggable = l.kind === 'flying' || l.kind === 'slow';
        const busy = tagging === `${stint.key}:${l.lap}`;
        const status = l.tag ? `${TAG_LABEL[l.tag]} · left out`
          : l.kind !== 'flying' ? `${KIND_LABEL[l.kind]} · left out`
            : l.outlier ? `${signed(l.off_trend_s, 1)} s off the trend · left out`
              : l.in_fit ? (l.off_trend_s != null ? `${signed(l.off_trend_s)} s to the trend` : 'in the trend') : 'left out';
        return (
          <View key={l.lap} style={StyleSheet.flatten([styles.lapRow, l.tag && styles.lapTagged])}>
            <View style={styles.lapMain}>
              <Text style={styles.lapNo}>L{l.lap}</Text>
              <View style={styles.flex}>
                <Text style={StyleSheet.flatten([styles.lapTime, !l.in_fit && styles.dim])}>{formatLap(l.time)}</Text>
                <Text style={styles.small}>{status}</Text>
              </View>
              {busy && <ActivityIndicator size="small" />}
              {taggable && (
                <View style={styles.tagRow}>
                  {TAGS.map((t) => {
                    const on = l.tag === t;
                    const suggested = !l.tag && l.suggestion?.options.includes(t);
                    return (
                      <Pressable key={t} onPress={() => onTag(stint, l, on ? null : t)} disabled={busy}
                        hitSlop={4} accessibilityRole="button" accessibilityState={{ selected: on }}
                        accessibilityLabel={on ? `Clear the ${TAG_WORDS[t]} tag on lap ${l.lap}`
                          : `Tag lap ${l.lap} ${TAG_WORDS[t]}`}
                        style={StyleSheet.flatten([styles.tagChip, suggested && { borderColor: tint, borderStyle: 'dashed' },
                          on && { backgroundColor: tint, borderColor: tint }])}>
                        <Text style={StyleSheet.flatten([styles.tagText, on && { color: background, fontWeight: '700' }])}>
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
                <Text style={styles.small}>
                  {l.suggestion.likely
                    ? `Looks like ${l.suggestion.options.map((t) => TAG_WORDS[t]).join(' or ')}: ${l.suggestion.why}.`
                    : `${l.suggestion.why.charAt(0).toUpperCase()}${l.suggestion.why.slice(1)}`}
                </Text>
                <Pressable onPress={() => onTag(stint, l, 'none')} disabled={busy} hitSlop={6} accessibilityRole="button">
                  <Text style={{ color: tint, fontSize: 13 }}>No, it counts</Text>
                </Pressable>
              </View>
            )}
            {l.checked && !l.tag && (
              <View style={styles.suggest}>
                <Text style={styles.small}>You checked this lap: it counts.</Text>
                <Pressable onPress={() => onTag(stint, l, null)} disabled={busy} hitSlop={6} accessibilityRole="button">
                  <Text style={{ color: tint, fontSize: 13 }}>Undo</Text>
                </Pressable>
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
  const [open, setOpen] = useState(false);
  const tint = useThemeColor({}, 'tint');
  return (
    <View style={styles.block}>
      <Pressable onPress={() => setOpen(!open)} accessibilityRole="button">
        <Text style={{ color: tint }}>{open ? 'Hide the numbers' : 'Every lap in numbers'}</Text>
      </Pressable>
      {open && (
        <>
          <ScrollView horizontal>
            <View>
              <View style={styles.row}>
                {COLUMNS.map((c) => (
                  <Text key={c.title} style={StyleSheet.flatten([styles.cell, styles.th, { width: c.width }])}>
                    {c.title}
                  </Text>
                ))}
              </View>
              {stint.laps.map((l) => (
                <View key={l.lap} style={styles.row}>
                  {COLUMNS.map((c) => (
                    <Text key={c.title} style={StyleSheet.flatten([styles.cell, { width: c.width }, !l.in_fit && styles.dim])}>
                      {c.value(l)}
                    </Text>
                  ))}
                </View>
              ))}
            </View>
          </ScrollView>
          <Text style={styles.small}>
            Grey laps are left out of the trends. Grip in g per phase (90th percentile). Balance in {unit === 'deg' ? '°'
              : unit} of understeer angle against the car's normal at the same cornering g, + understeer.
          </Text>
        </>
      )}
    </View>
  );
}

function StintCard({ stint, many, onPress }: { stint: Stint; many: boolean; onPress: () => void }) {
  const t = stint.fits.corrected_time ?? stint.fits.time;
  return (
    <Pressable onPress={onPress} style={styles.card} accessibilityRole="button">
      <Text style={styles.h3}>{stintName(stint, many)}</Text>
      <Text style={styles.small}>
        {stint.fitted_laps} laps in the trend · best {formatLap(stint.best)}
        {t ? ` · tyres ${signed(t.per_lap)} s/lap${t.clear ? '' : ' (no clear trend)'}` : ''}
      </Text>
      <Text style={styles.body}>{stint.words.headline}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: { padding: 16, alignItems: 'center' },
  page: { width: '100%', maxWidth: 1040, gap: 16 },
  flex: { flex: 1, backgroundColor: 'transparent' },
  narrow: { maxWidth: 720, backgroundColor: 'transparent' },
  block: { gap: 10, backgroundColor: 'transparent' },
  busy: { flexDirection: 'row', gap: 8, alignItems: 'center' },
  card: { borderWidth: 1, borderColor: '#8883', borderRadius: 12, padding: 14, gap: 10 },
  h2: { fontSize: 18, fontWeight: '700' },
  h3: { fontSize: 15, fontWeight: '700' },
  headline: { fontSize: 17, fontWeight: '600', lineHeight: 24 },
  body: { fontSize: 14, lineHeight: 20 },
  small: { fontSize: 12, opacity: 0.7, lineHeight: 17 },
  dim: { opacity: 0.45 },
  error: { color: '#c8372d' },
  section: { gap: 10 },
  advice: { borderLeftWidth: 3, paddingLeft: 10, paddingVertical: 2 },
  tiles: { flexDirection: 'row', flexWrap: 'wrap', columnGap: 20, rowGap: 10 },
  tile: { minWidth: 120, gap: 1 },
  tileLabel: { fontSize: 11, opacity: 0.6, textTransform: 'uppercase', letterSpacing: 0.5 },
  tileValue: { fontSize: 20, fontWeight: '600', fontVariant: ['tabular-nums'] },
  tileSub: { fontSize: 12, opacity: 0.6 },
  list: { gap: 4 },
  bullet: { flexDirection: 'row', gap: 8 },
  bulletDot: { fontSize: 14, lineHeight: 20, opacity: 0.6 },
  chips: { gap: 8 },
  chip: { borderWidth: 1, borderColor: '#8884', borderRadius: 12, paddingHorizontal: 12, paddingVertical: 7 },
  chipTitle: { fontSize: 14, fontWeight: '600' },
  chipSub: { fontSize: 12, opacity: 0.6 },
  pickerHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  button: { paddingHorizontal: 12, paddingVertical: 8 },
  tickedRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  tickedChip: { flexDirection: 'row', alignItems: 'center', gap: 8, borderWidth: 1, borderColor: '#8884',
    borderRadius: 16, paddingHorizontal: 12, paddingVertical: 6 },
  tickedText: { fontSize: 13 },
  event: { gap: 2, marginTop: 4 },
  eventName: { fontSize: 13, fontWeight: '700', marginBottom: 2 },
  logRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 8, minHeight: 44 },
  box: { width: 22, height: 22, borderRadius: 5, borderWidth: 2, borderColor: '#8888', alignItems: 'center',
    justifyContent: 'center' },
  tick: { color: '#fff', fontSize: 14, fontWeight: '800', lineHeight: 16 },
  logName: { fontSize: 14 },
  toggle: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  toggleItem: { borderWidth: 1, borderColor: '#8884', borderRadius: 12, paddingHorizontal: 12, paddingVertical: 6 },
  tableHead: { flexDirection: 'row', gap: 8, paddingHorizontal: 6 },
  th: { fontSize: 12, fontWeight: '600', opacity: 0.7 },
  phaseRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 8, paddingHorizontal: 6,
    borderWidth: 1, borderColor: 'transparent', borderRadius: 8 },
  phaseCol: { width: 92 },
  numCol: { width: 52 },
  num: { fontSize: 13, fontVariant: ['tabular-nums'] },
  cellBar: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: 'transparent' },
  cellNum: { width: 50, textAlign: 'right' },
  panels: { flexDirection: 'row', flexWrap: 'wrap', gap: 12, justifyContent: 'space-between' },
  panel: { borderWidth: 1, borderColor: '#8883', borderRadius: 12, padding: 12, gap: 8 },
  lapRow: { borderBottomWidth: 1, borderColor: '#8882', paddingVertical: 6, gap: 4 },
  lapTagged: { opacity: 0.85 },
  lapMain: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  lapNo: { width: 34, fontSize: 14, fontWeight: '600', fontVariant: ['tabular-nums'] },
  lapTime: { fontSize: 15, fontVariant: ['tabular-nums'] },
  tagRow: { flexDirection: 'row', gap: 6 },
  tagChip: { borderWidth: 1, borderColor: '#8886', borderRadius: 14, paddingHorizontal: 10, paddingVertical: 7,
    minWidth: 44, alignItems: 'center' },
  tagText: { fontSize: 13 },
  suggest: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: 12, rowGap: 2, marginLeft: 44 },
  row: { flexDirection: 'row', borderBottomWidth: 1, borderColor: '#8882', paddingVertical: 4 },
  cell: { fontVariant: ['tabular-nums'], fontSize: 13, paddingRight: 6, textAlign: 'right' },
});
