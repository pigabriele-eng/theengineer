import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { ReactNode, useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, useWindowDimensions } from 'react-native';

import { OfficialResults, Prediction } from '@/components/PrepOfficial';
import { GripChart } from '@/components/report/TrackGrip';
import { Text, View, useThemeColor } from '@/components/Themed';
import { formatLap } from '@/lib/api';
import { dateRange } from '@/lib/events';
import {
  CornerRow,
  fetchPrep,
  fetchPrepOfficial,
  fetchPrepWeather,
  PerfRow,
  PrepAnswer,
  PrepOfficial,
  PrepReport,
  PrepWeather,
  refreshPrep,
  SetupRun,
} from '@/lib/prep';
import { pct } from '@/lib/trackGrip';

const POLL_MS = 2000;
const WIDE = 900;
const CORNERS_SHOWN = 4; // corners open before "Show all"
const RUNS_SHOWN = 6;
const VERDICT: Record<string, string> = {
  agree: 'data agrees', slight: 'data leans the same way', normal: 'data reads normal', disagree: 'data says the opposite',
  unmeasured: 'not measured',
};

const signed = (v: number | null | undefined, nd = 2) =>
  v == null ? '' : `${v > 0 ? '+' : v < 0 ? '−' : '±'}${Math.abs(v).toFixed(nd)} s`;
const span = (r: [number, number] | null | undefined, unit: string) =>
  !r ? null : r[0] === r[1] ? `${r[0].toFixed(0)} ${unit}` : `${r[0].toFixed(0)}–${r[1].toFixed(0)} ${unit}`;

/** The prep report: one tap before a weekend, what every past event at this track with this car learned, as a
 * briefing. The briefing first, then the performance year by year with the weather, corner by corner with the ideal
 * way through each, quali prep, pressures, the setup to open with, how the car behaved on each setup, and each
 * driver's recurring technique points. */
export default function PrepScreen() {
  const params = useLocalSearchParams<{ event?: string; car?: string }>();
  const eventId = params.event ? Number(params.event) : null;
  const car = params.car ?? null;
  const key = `${eventId}|${car ?? ''}`;
  const router = useRouter();
  const [answer, setAnswer] = useState<PrepAnswer | null>(null);
  const [weather, setWeather] = useState<PrepWeather | null>(null);
  const [official, setOfficial] = useState<PrepOfficial | null>(null);
  const [officialRound, setOfficialRound] = useState(0); // the car number set: ask again
  const [error, setError] = useState<string | null>(null);
  const [round, setRound] = useState(0); // a refresh starts the polling again
  const background = useThemeColor({}, 'background');
  const { width } = useWindowDimensions();
  const wide = width >= WIDE;

  // ask for the report; while the server works it out, ask again every couple of seconds
  useEffect(() => {
    if (eventId == null) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const a = await fetchPrep(eventId, car);
        if (!live) return;
        setAnswer(a);
        setError(null);
        if (a.status === 'queued' || a.status === 'running') timer = setTimeout(poll, POLL_MS);
      } catch (e) {
        if (!live) return;
        setError((e as Error).message);
        timer = setTimeout(poll, POLL_MS * 3);
      }
    };
    poll();
    return () => {
      live = false;
      if (timer) clearTimeout(timer);
    };
  }, [key, round]); // eslint-disable-line react-hooks/exhaustive-deps -- the key holds the event and the car

  // the weather comes from an outside service: it loads on its own and never holds the report up
  useEffect(() => {
    if (eventId == null) return;
    let live = true;
    setWeather(null);
    fetchPrepWeather(eventId).then((w) => live && setWeather(w), () => undefined);
    return () => {
      live = false;
    };
  }, [eventId]);

  // the official results and the prediction: a quick read of their own, also never holding the report up
  useEffect(() => {
    if (eventId == null) return;
    let live = true;
    fetchPrepOfficial(eventId, car).then((o) => live && setOfficial(o), () => undefined);
    return () => {
      live = false;
    };
  }, [key, officialRound]); // eslint-disable-line react-hooks/exhaustive-deps -- the key holds the event and the car
  const reloadOfficial = useCallback(() => setOfficialRound((n) => n + 1), []);

  const retry = useCallback(async () => {
    if (eventId == null) return;
    try {
      setAnswer(await refreshPrep(eventId, car));
      setRound((n) => n + 1);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [eventId, car]);

  if (eventId == null) {
    return <Text style={styles.pad}>Open the prep report from an event.</Text>;
  }
  const report = answer?.report ?? null;
  const working = answer?.status === 'queued' || answer?.status === 'running';
  const pickCar = (k: string) => router.setParams({ car: k });

  return (
    <ScrollView style={{ backgroundColor: background }} contentContainerStyle={styles.outer}>
      <Stack.Screen options={{ title: answer ? `Prep · ${answer.event.name}` : 'Prep report' }} />
      <View style={styles.page}>
        <View style={styles.head}>
          <Text style={styles.h1}>Prep report</Text>
          {answer && (
            <Text style={styles.sub}>
              {[answer.event.name, answer.event.track, dateRange(answer.event.start, answer.event.end)]
                .filter(Boolean).join(' · ')}
            </Text>
          )}
          {answer && answer.status !== 'none' && (
            <Text style={styles.sub}>
              Learned from {answer.past_events.length === 1 ? 'one past event' : `${answer.past_events.length} past events`}{' '}
              here ({answer.past_events.map((e) => e.start?.slice(0, 4) ?? e.name).join(', ')}) with {answer.car.label}.
            </Text>
          )}
        </View>
        {answer && <CarPicker answer={answer} onPick={pickCar} />}
        {!answer && !error && <ActivityIndicator />}
        {error && <Text style={styles.error}>Can&apos;t reach the server: {error}</Text>}
        {answer?.status === 'none' && (
          <View style={styles.banner}>
            <Text style={styles.bannerText}>{answer.reason}</Text>
            <Text style={styles.note}>
              Once a weekend here has been driven and its logs uploaded, this report gathers what it learned.
            </Text>
          </View>
        )}
        {answer?.status === 'none' && official?.loaded && (
          <OfficialSections eventId={eventId} official={official} reload={reloadOfficial} />
        )}
        {answer && working && <Progress answer={answer} />}
        {answer?.status === 'failed' && (
          <View style={styles.banner}>
            <Text style={styles.bannerText}>{answer.error ?? 'The prep report couldn’t be worked out.'}</Text>
            <Pressable accessibilityRole="button" onPress={retry} style={styles.smallButton}>
              <Text style={styles.smallButtonText}>Try again</Text>
            </Pressable>
          </View>
        )}
        {answer?.stale && report && (
          <Text style={styles.note}>
            These are from before the past events last changed; the new report replaces them when it is ready.
          </Text>
        )}
        {report && (
          <Body report={report} weather={weather} wide={wide} official={official}
            officialPart={<OfficialSections eventId={eventId} official={official} reload={reloadOfficial} />}
            openEvent={(id) => router.push({ pathname: '/report', params: { event: String(id) } })} />
        )}
      </View>
    </ScrollView>
  );
}

function CarPicker({ answer, onPick }: { answer: PrepAnswer; onPick: (key: string) => void }) {
  const tint = useThemeColor({}, 'tint');
  const choices = [...answer.cars.map((c) => ({ key: c.key, label: `${c.label} (${c.events})` })),
    ...(answer.cars.length > 1 ? [{ key: 'any', label: 'Every car here' }] : [])];
  if (choices.length < 2 && choices.every((c) => c.key === answer.car.key)) return null;
  return (
    <View style={styles.chips}>
      <Text style={styles.note}>Car:</Text>
      {choices.map((c) => {
        const on = c.key === answer.car.key;
        return (
          <Pressable key={c.key} accessibilityRole="button" onPress={() => onPick(c.key)}
            style={StyleSheet.flatten([styles.chip, on && { borderColor: tint, backgroundColor: `${tint}22` }])}>
            <Text style={StyleSheet.flatten([styles.chipText, on && { color: tint }])}>{c.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

function Progress({ answer }: { answer: PrepAnswer }) {
  const tint = useThemeColor({}, 'tint');
  const p = answer.progress;
  const share = p && p.total ? Math.min(p.done / p.total, 1) : 0;
  return (
    <View style={styles.progress}>
      <Text style={styles.progressText}>
        Gathering {answer.past_events.length === 1 ? 'the past event' : `${answer.past_events.length} past events`}…
        {p?.current ? ` ${p.current}` : ''}
      </Text>
      <View style={styles.track}>
        <View style={StyleSheet.flatten([styles.fill, { width: `${Math.round(share * 100)}%`, backgroundColor: tint }])} />
      </View>
      <Text style={styles.note}>
        The first time takes a few minutes: each past event&apos;s logs are read one at a time. After that it opens at
        once.
      </Text>
    </View>
  );
}

function Body({ report, weather, wide, official, officialPart, openEvent }: { report: PrepReport;
  weather: PrepWeather | null; wide: boolean; official: PrepOfficial | null; officialPart: ReactNode;
  openEvent: (id: number) => void }) {
  return (
    <>
      <Briefing report={report} weather={weather} official={official} />
      <Section title="Year by year">
        <Performance rows={report.performance} weather={weather} official={official} wide={wide}
          openEvent={openEvent} />
        {report.trend && <Text style={styles.para}>{report.trend}</Text>}
      </Section>
      {officialPart}
      <Corners corners={report.corners} />
      <Quali report={report} />
      <TrackGripSection report={report} />
      <Pressures report={report} weather={weather} />
      <Setup report={report} />
      <Runs report={report} />
      <Technique report={report} />
      {report.notes.length > 0 && (
        <Section title="Notes">
          {report.notes.map((n) => <Text key={n} style={styles.note}>{n}</Text>)}
        </Section>
      )}
      <Method lines={report.method} />
    </>
  );
}

/** The series' official results here and the prediction for this round (components/PrepOfficial.tsx). */
function OfficialSections({ eventId, official, reload }: { eventId: number; official: PrepOfficial | null;
  reload: () => void }) {
  return (
    <>
      <Section title="Official results here"
        sub={official?.loaded ? 'From the series\u2019 result sheets: our place in each session, its weather, and the makes.'
          : null}>
        <OfficialResults eventId={eventId} data={official} onChanged={reload} />
      </Section>
      {official?.prediction && (
        <Section title={`Prediction for ${official.year}`}
          sub="From earlier official results only (and our logged laps here); places as likely ranges.">
          <Prediction data={official} />
        </Section>
      )}
    </>
  );
}

function Section({ title, children, sub }: { title: string; children: ReactNode; sub?: string | null }) {
  return (
    <View style={styles.section}>
      <Text style={styles.h2}>{title}</Text>
      {sub ? <Text style={styles.note}>{sub}</Text> : null}
      {children}
    </View>
  );
}

function Briefing({ report, weather, official }: { report: PrepReport; weather: PrepWeather | null;
  official: PrepOfficial | null }) {
  const tint = useThemeColor({}, 'tint');
  const f = weather?.forecast?.summary;
  // the official results and the prediction go right after the lap time to aim for
  const extra = [
    official?.lines.length ? { key: 'results', title: 'Results here', text: official.lines.join(' ') } : null,
    official?.prediction?.line ? { key: 'prediction', title: `Prediction for ${official.year}`,
      text: official.prediction.line } : null,
  ].filter((x): x is { key: string; title: string; text: string } => x != null);
  const items = [...report.briefing.slice(0, 1), ...extra, ...report.briefing.slice(1)];
  return (
    <View style={StyleSheet.flatten([styles.brief, { borderColor: tint }])}>
      <Text style={styles.briefTitle}>Before the weekend</Text>
      {(f || weather?.compare) && (
        <View style={styles.item}>
          <Text style={styles.itemTitle}>{weather?.forecast?.kind === 'actual' ? 'Weather that weekend' : 'Weather'}</Text>
          <Text style={styles.itemText}>
            {[f ? `${weather?.forecast?.kind === 'actual' ? 'It was' : 'Forecast:'} ${f.text}.` : null,
              weather?.compare].filter(Boolean).join(' ')}
          </Text>
        </View>
      )}
      {items.map((b) => (
        <View key={b.key} style={styles.item}>
          <Text style={styles.itemTitle}>{b.title}</Text>
          <Text style={styles.itemText}>{b.text}</Text>
        </View>
      ))}
      {report.briefing.length === 0 && <Text style={styles.note}>Nothing stood out in the past events yet.</Text>}
      {weather?.note && !f && <Text style={styles.note}>Weather: {weather.note}</Text>}
    </View>
  );
}

function Performance({ rows, weather, official, wide, openEvent }: { rows: PerfRow[]; weather: PrepWeather | null;
  official: PrepOfficial | null; wide: boolean; openEvent: (id: number) => void }) {
  const sky = (id: number) => weather?.past.find((p) => p.event_id === id)?.summary?.text ?? null;
  // the official sessions held during the event: their conditions and temperatures at the start
  const sheets = (id: number) => (official?.weather[String(id)] ?? []).map((w) =>
    `${w.code} ${[w.conditions?.toLowerCase(), w.air_c != null ? `air ${w.air_c.toFixed(0)} °C` : null,
      w.track_c != null ? `track ${w.track_c.toFixed(0)} °C` : null].filter(Boolean).join(', ')}`).join('; ') || null;
  const conditions = (r: PerfRow) => [
    r.conditions.ambient_c ? `air ${span(r.conditions.ambient_c, '°C')} (logger)` : null,
    r.conditions.track_c ? `track ${span(r.conditions.track_c, '°C')}` : null,
    r.conditions.tyres.join(', ') || null,
    sky(r.event_id),
    sheets(r.event_id) ? `official: ${sheets(r.event_id)}` : null,
  ].filter(Boolean).join(' · ');
  const quali = (r: PerfRow) => (r.quali ? `${formatLap(r.quali.time)}${r.quali.basis === 'quali run' ? '*' : ''}` : '–');
  const race = (r: PerfRow) => (r.race_pace ? `${formatLap(r.race_pace.time)}${r.race_pace.basis === 'long runs' ? '*' : ''}`
    : '–');
  const foot = rows.some((r) => r.quali?.basis === 'quali run' || r.race_pace?.basis === 'long runs') && (
    <Text style={styles.note}>* No session marked as qualifying or race: the best quali-style run and the median lap of
      the long runs instead.</Text>
  );
  if (wide) {
    const cols = ['Event', 'Best', 'Ideal', 'Theoretical', 'Race pace', 'Quali', 'vs year before'];
    return (
      <View>
        <View style={styles.tr}>
          {cols.map((c, i) => (
            <Text key={c} style={StyleSheet.flatten([styles.th, i === 0 ? styles.cFirst : styles.cNum])}>{c}</Text>
          ))}
        </View>
        {rows.map((r) => (
          <Pressable key={r.event_id} accessibilityRole="link" onPress={() => openEvent(r.event_id)}
            style={styles.trBlock}>
            <View style={styles.tr}>
              <View style={styles.cFirst}>
                <Text style={styles.cellStrong}>{r.year}</Text>
                <Text style={styles.note} numberOfLines={1}>{r.name}</Text>
              </View>
              <View style={styles.cNum}>
                <Text style={styles.cellStrong}>{formatLap(r.best.time)}</Text>
                <Text style={styles.note} numberOfLines={1}>{r.best.driver ?? r.best.session}</Text>
              </View>
              <Text style={StyleSheet.flatten([styles.cell, styles.cNum])}>{formatLap(r.ideal)}</Text>
              <Text style={StyleSheet.flatten([styles.cell, styles.cNum])}>{formatLap(r.theoretical)}</Text>
              <Text style={StyleSheet.flatten([styles.cell, styles.cNum])}>{race(r)}</Text>
              <Text style={StyleSheet.flatten([styles.cell, styles.cNum])}>{quali(r)}</Text>
              <Text style={StyleSheet.flatten([styles.cell, styles.cNum])}>{r.change?.best != null ? signed(r.change.best) : '–'}</Text>
            </View>
            <Text style={styles.note}>{conditions(r) || 'No conditions recorded'}
              {r.drivers.length > 1 ? ` · ${r.drivers.map((d) => `${d.name} ${formatLap(d.best)}`).join(', ')}` : ''}</Text>
          </Pressable>
        ))}
        {foot}
      </View>
    );
  }
  return (
    <View style={styles.cards}>
      {rows.map((r) => (
        <Pressable key={r.event_id} accessibilityRole="link" onPress={() => openEvent(r.event_id)} style={styles.card}>
          <View style={styles.cardHead}>
            <Text style={styles.cellStrong}>{r.year}</Text>
            <Text style={styles.note} numberOfLines={1}>{r.name}</Text>
            {r.change?.best != null && <Text style={styles.delta}>{signed(r.change.best)}</Text>}
          </View>
          <View style={styles.grid}>
            <Stat label="Best" value={formatLap(r.best.time)} sub={r.best.driver ?? r.best.session} />
            <Stat label="Ideal" value={formatLap(r.ideal)} />
            <Stat label="Theoretical" value={formatLap(r.theoretical)} />
            <Stat label="Race pace" value={race(r)} />
            <Stat label="Quali" value={quali(r)} />
          </View>
          <Text style={styles.note}>{conditions(r) || 'No conditions recorded'}</Text>
        </Pressable>
      ))}
      {foot}
    </View>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string | null }) {
  return (
    <View style={styles.stat}>
      <Text style={styles.statLabel}>{label}</Text>
      <Text style={styles.statValue}>{value}</Text>
      {sub ? <Text style={styles.note} numberOfLines={1}>{sub}</Text> : null}
    </View>
  );
}

function Corners({ corners }: { corners: PrepReport['corners'] }) {
  const [all, setAll] = useState(false);
  const rows = all ? corners.rows : corners.rows.slice(0, CORNERS_SHOWN);
  if (!corners.rows.length) {
    return <Section title="Corner by corner"><Text style={styles.note}>{corners.note}</Text></Section>;
  }
  return (
    <Section title="Corner by corner" sub="Most time to find first. The ideal pass is what the quickest passes did.">
      {corners.changes && <Text style={styles.para}>{corners.changes}</Text>}
      {corners.note && <Text style={styles.note}>{corners.note}</Text>}
      {rows.map((r) => <Corner key={r.code} r={r} />)}
      {corners.rows.length > CORNERS_SHOWN && (
        <Pressable accessibilityRole="button" onPress={() => setAll(!all)} style={styles.smallButton}>
          <Text style={styles.smallButtonText}>{all ? 'Show fewer corners' : `Show all ${corners.rows.length} corners`}</Text>
        </Pressable>
      )}
    </Section>
  );
}

function Corner({ r }: { r: CornerRow }) {
  const years = Object.values(r.per_event);
  return (
    <View style={styles.corner}>
      <View style={styles.cornerHead}>
        <Text style={styles.code}>{r.code}</Text>
        <Text style={styles.cornerGain}>{r.gain_s != null ? `${r.gain_s.toFixed(2)} s a lap to find` : ''}</Text>
        {r.change && <Text style={styles.delta}>{signed(r.change.typical)} typical vs {r.change.from}</Text>}
      </View>
      <Text style={styles.note}>
        {years.map((y) => `${y.year}: best ${y.best?.toFixed(2) ?? '–'} s, typical ${y.typical?.toFixed(2) ?? '–'} s`)
          .join(' · ')}
        {r.best_by.driver ? ` · best pass by ${r.best_by.driver}` : ''}
      </Text>
      {r.ideal && <Text style={styles.para}><Text style={styles.label}>Ideal pass: </Text>{r.ideal}</Text>}
      {r.why && <Text style={styles.para}><Text style={styles.label}>Why: </Text>{r.why}</Text>}
      {r.advice.length > 0 && (
        <Text style={styles.para}><Text style={styles.label}>To change: </Text>{r.advice.join('. ')}.</Text>
      )}
      {r.drivers.map((d) => (
        <Text key={`${d.driver}-${d.text}`} style={styles.note}>{d.driver ?? 'Untagged laps'}: {d.text}</Text>
      ))}
    </View>
  );
}

function Quali({ report }: { report: PrepReport }) {
  const router = useRouter();
  const q = report.quali;
  if (!q) return null;
  return (
    <Section title="Quali prep that worked" sub={`From the tyre sensors in ${q.from}.`}>
      <Pressable accessibilityRole="link"
        onPress={() => router.push({ pathname: '/quali', params: { event: String(q.event_id) } })}>
        <Text style={styles.link}>Open the full quali prep of {q.from}</Text>
      </Pressable>
      {q.advice.filter((a) => ['plan', 'ready', 'build', 'brakes', 'push'].includes(a.key)).map((a) => (
        <Text key={a.key} style={styles.para}><Text style={styles.label}>{a.title}: </Text>{a.text}</Text>
      ))}
      {q.per_event.length > 1 && q.per_event.map((e) => (
        <Text key={e.event_id} style={styles.note}>
          {e.year}: {[e.quali ? `quali ${formatLap(e.quali.time)}` : null,
            e.push ? `push from ${e.push.front_c} °C front, ${e.push.rear_c} °C rear` : null,
            e.ready_min ? `ready ${span(e.ready_min, 'min')} after leaving` : null,
            e.peak_from_exit ? `best lap ${e.peak_from_exit[0]}–${e.peak_from_exit[1]} laps out` : null,
            e.warm_up ? `quickest warm-up ${e.warm_up.label}` : null].filter(Boolean).join(' · ')}
        </Text>
      ))}
    </Section>
  );
}

/** How the track's grip came in at each past event here (against its own first session) and what to expect from it,
 * with how sure that is, and the latest event's sessions as a chart. */
function TrackGripSection({ report }: { report: PrepReport }) {
  const g = report.track_grip;
  if (!g || (!g.guidance.length && !g.notes.length)) return null;
  const known = g.events.filter((e) => e.available);
  const latest = [...known].reverse().find((e) => e.sessions?.length);
  const withPm = (p: { pct: number | null; pm: number | null } | null | undefined) =>
    p?.pct == null ? '–' : `${pct(p.pct)}${p.pm != null ? ` ± ${pct(p.pm, false)}` : ''}`;
  return (
    <Section title="Track grip" sub="How the grip came in at past events here, each against its own first session.">
      {g.guidance.map((t) => <Text key={t} style={styles.para}>{t}</Text>)}
      {known.length > 0 && (
        <View style={styles.cards}>
          {known.map((e) => (
            <View key={e.id} style={styles.card}>
              <View style={styles.cardHead}>
                <Text style={styles.cellStrong}>{e.year}</Text>
                <Text style={styles.note} numberOfLines={1}>{e.name} · against {e.base}</Text>
              </View>
              <View style={styles.grid}>
                <Stat label="Best it got to" value={withPm(e.peak)} sub={e.peak?.session ?? 'no rise'} />
                <Stat label="Qualifying" value={e.quali ? withPm(e.quali) : e.base_kind === 'qualifying' ? '0 %' : '–'}
                  sub={e.quali?.session ?? (e.base_kind === 'qualifying' ? 'the first session' : 'none logged')} />
                <Stat label="Races vs quali" value={(e.races_vs_quali ?? []).filter(Boolean)
                  .map((r) => pct(r!.pct)).join(', ') || '–'}
                  sub={(e.races_vs_quali ?? []).filter(Boolean).map((r) => r!.session).join(', ') || null} />
                <Stat label="Most of it by" value={e.by_lap ? `lap ${e.by_lap}` : '–'} sub="of the car's weekend" />
              </View>
            </View>
          ))}
        </View>
      )}
      {g.sureness && <Text style={styles.note}>{g.sureness}</Text>}
      {latest && (
        <GripChart sessions={latest.sessions!} base={latest.base ?? ''}
          title={`${latest.name} ${latest.year}: track grip by session, % against ${latest.base}`} />
      )}
      {g.notes.map((n) => <Text key={n} style={styles.note}>{n}</Text>)}
    </Section>
  );
}

function Pressures({ report, weather }: { report: PrepReport; weather: PrepWeather | null }) {
  const router = useRouter();
  const p = report.pressures;
  if (!p) return null;
  const cold = (p.tyres ?? []).filter((t) => t.cold_bar != null);
  return (
    <Section title="Tyre pressures" sub={p.year ? `What landed the tyres in their window in ${p.year}` +
      (p.ambient_c ? `, at ${span(p.ambient_c, '°C')} air.` : '.') : null}>
      {cold.length > 0 && (
        <View style={styles.grid}>
          {cold.map((t) => (
            <Stat key={t.tyre} label={t.tyre} value={`${t.cold_bar!.toFixed(2)} bar`}
              sub={`${t.target_hot_bar.toFixed(2)} hot`} />
          ))}
        </View>
      )}
      {weather?.compare && <Text style={styles.para}>{weather.compare}</Text>}
      {(p.tyre_model?.lines ?? []).map((l) => <Text key={l} style={styles.note}>Tyre model: {l}</Text>)}
      <Pressable accessibilityRole="button" onPress={() => router.push('/tools/pressures')} style={styles.smallButton}>
        <Text style={styles.smallButtonText}>Pressure calculator for the weekend&apos;s temperatures</Text>
      </Pressable>
    </Section>
  );
}

const AGREEMENT: Record<string, string> = {
  both: 'driver and data agree', driver: 'from the drivers', data: 'from the data', disagree: 'driver and data disagree',
};

function Setup({ report }: { report: PrepReport }) {
  const rec = report.recommendation;
  if (!rec) return null;
  return (
    <Section title="Setup to start with">
      <Text style={styles.para}>
        {rec.baseline
          ? `Start from the setup of ${rec.baseline.session} (${rec.baseline.year}, best ${formatLap(rec.baseline.best_s)}), ` +
            'the quickest past run here with a setup sheet.'
          : 'No setup sheet was saved here yet: the changes are steps from wherever the car is.'}
      </Text>
      {rec.recurring.length > 0 && (
        <Text style={styles.para}><Text style={styles.label}>The car kept showing: </Text>
          {rec.recurring.map((r) => r.text).join('; ')}.</Text>
      )}
      {rec.suggestions.map((s) => (
        <View key={s.rank} style={styles.suggestion}>
          <Text style={styles.itemTitle}>{s.rank}. {s.title}</Text>
          {s.changes.length > 0 && <Text style={styles.para}>{s.changes.map((c) => c.text).join(', ')}</Text>}
          {s.reason ? <Text style={styles.para}><Text style={styles.label}>Why: </Text>{s.reason}
            {` (${AGREEMENT[s.agreement] ?? s.agreement})`}</Text> : null}
          {s.expected ? <Text style={styles.note}>Expect: {s.expected}</Text> : null}
          {s.watch ? <Text style={styles.note}>Watch: {s.watch}</Text> : null}
          {s.disagree.map((d) => <Text key={d} style={styles.note}>{d}</Text>)}
        </View>
      ))}
      {rec.suggestions.length === 0 && (
        <Text style={styles.note}>Nothing in the past runs or debriefs points to a setup change.</Text>
      )}
    </Section>
  );
}

function Runs({ report }: { report: PrepReport }) {
  const [all, setAll] = useState(false);
  const s = report.setups;
  if (!s.runs.length) return null;
  const runs = all ? s.runs : s.runs.slice(0, RUNS_SHOWN);
  return (
    <Section title="Setups and how the car behaved" sub={s.note}>
      {s.said.map((x) => <Text key={x.text} style={styles.para}>{x.text}</Text>)}
      {runs.map((r) => <Run key={r.session_id} r={r} />)}
      {s.runs.length > RUNS_SHOWN && (
        <Pressable accessibilityRole="button" onPress={() => setAll(!all)} style={styles.smallButton}>
          <Text style={styles.smallButtonText}>{all ? 'Show fewer runs' : `Show all ${s.runs.length} runs`}</Text>
        </Pressable>
      )}
    </Section>
  );
}

function Run({ r }: { r: SetupRun }) {
  return (
    <View style={styles.run}>
      <Text style={styles.cellStrong}>
        {r.year} · {r.name}{r.driver ? ` · ${r.driver}` : ''} · {formatLap(r.best)}
        {r.delta_best != null ? ` (${signed(r.delta_best)} vs ${r.compared_with})` : ''}
      </Text>
      {r.changes.length > 0 && <Text style={styles.note}>Changed: {r.changes.join(', ')}</Text>}
      {r.setup && r.changes.length === 0 && <Text style={styles.note}>Setup sheet saved</Text>}
      {r.balance && <Text style={styles.note}>Car: {r.balance}{r.tc_s_per_lap != null ? `, traction control ${r.tc_s_per_lap.toFixed(1)} s a lap` : ''}</Text>}
      {r.remarks.map((m) => (
        <Text key={m.text} style={styles.note}>“{m.text}” — {m.verdict ? VERDICT[m.verdict] ?? m.verdict : 'not checked'}
          {m.data ? `: ${m.data}` : ''}</Text>
      ))}
    </View>
  );
}

function Technique({ report }: { report: PrepReport }) {
  const drivers = report.technique.filter((d) => d.habits.length);
  if (!drivers.length) return null;
  return (
    <Section title="Driver technique" sub="The mistakes that repeat on each driver's laps, costliest a lap first.">
      {drivers.map((d) => (
        <View key={d.name ?? 'none'} style={styles.driver}>
          <Text style={styles.itemTitle}>{d.name ?? 'Untagged laps'} · {d.laps} laps</Text>
          {d.habits.map((h) => <Text key={h.text} style={styles.para}>{h.text}</Text>)}
        </View>
      ))}
    </Section>
  );
}

function Method({ lines }: { lines: string[] }) {
  const [open, setOpen] = useState(false);
  return (
    <View style={styles.section}>
      <Pressable accessibilityRole="button" onPress={() => setOpen(!open)}>
        <Text style={styles.link}>{open ? 'Hide how this is worked out' : 'How this is worked out'}</Text>
      </Pressable>
      {open && lines.map((l) => <Text key={l} style={styles.note}>{l}</Text>)}
    </View>
  );
}

const styles = StyleSheet.create({
  pad: { padding: 16 },
  outer: { padding: 16, paddingBottom: 40 },
  page: { width: '100%', maxWidth: 980, alignSelf: 'center', gap: 16 },
  head: { gap: 4 },
  h1: { fontSize: 24, fontWeight: '800' },
  h2: { fontSize: 18, fontWeight: '700' },
  sub: { fontSize: 14, opacity: 0.7 },
  note: { fontSize: 12.5, opacity: 0.65, lineHeight: 18 },
  para: { fontSize: 14.5, lineHeight: 21 },
  label: { fontWeight: '700' },
  link: { fontSize: 14, opacity: 0.7, textDecorationLine: 'underline' },
  error: { color: '#c8372d' },
  banner: { borderWidth: 1, borderColor: '#8884', borderRadius: 10, padding: 12, gap: 8 },
  bannerText: { fontSize: 15, lineHeight: 21 },
  smallButton: { alignSelf: 'flex-start', borderWidth: 1, borderColor: '#8886', borderRadius: 8, paddingHorizontal: 12,
    paddingVertical: 6 },
  smallButtonText: { fontSize: 13.5, fontWeight: '600' },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, alignItems: 'center' },
  chip: { borderWidth: 1, borderColor: '#8884', borderRadius: 14, paddingHorizontal: 10, paddingVertical: 4 },
  chipText: { fontSize: 13 },
  progress: { gap: 6 },
  progressText: { fontSize: 14 },
  track: { height: 6, borderRadius: 3, backgroundColor: '#8883', overflow: 'hidden' },
  fill: { height: 6, borderRadius: 3 },
  brief: { borderWidth: 1.5, borderRadius: 12, padding: 14, gap: 12 },
  briefTitle: { fontSize: 13, fontWeight: '800', textTransform: 'uppercase', letterSpacing: 0.6, opacity: 0.7 },
  item: { gap: 2 },
  itemTitle: { fontSize: 15, fontWeight: '700' },
  itemText: { fontSize: 14.5, lineHeight: 21 },
  section: { gap: 8 },
  tr: { flexDirection: 'row', alignItems: 'flex-start', gap: 8, backgroundColor: 'transparent' },
  trBlock: { borderTopWidth: 1, borderColor: '#8883', paddingVertical: 8, gap: 2 },
  th: { fontSize: 12, fontWeight: '700', opacity: 0.6, paddingBottom: 4 },
  cFirst: { flex: 1.6, backgroundColor: 'transparent' },
  cNum: { flex: 1, textAlign: 'right', alignItems: 'flex-end', backgroundColor: 'transparent' },
  cell: { fontSize: 15, fontVariant: ['tabular-nums'] },
  cellStrong: { fontSize: 15, fontWeight: '700', fontVariant: ['tabular-nums'] },
  cards: { gap: 10 },
  card: { borderWidth: 1, borderColor: '#8884', borderRadius: 10, padding: 10, gap: 6 },
  cardHead: { flexDirection: 'row', alignItems: 'baseline', gap: 8 },
  delta: { fontSize: 13, fontWeight: '600', fontVariant: ['tabular-nums'], marginLeft: 'auto' },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  stat: { minWidth: 92, gap: 1 },
  statLabel: { fontSize: 11.5, opacity: 0.6, fontWeight: '600' },
  statValue: { fontSize: 16, fontWeight: '700', fontVariant: ['tabular-nums'] },
  corner: { borderTopWidth: 1, borderColor: '#8883', paddingTop: 10, gap: 4 },
  cornerHead: { flexDirection: 'row', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' },
  code: { fontSize: 17, fontWeight: '800' },
  cornerGain: { fontSize: 14, fontWeight: '600' },
  suggestion: { borderLeftWidth: 3, borderColor: '#8886', paddingLeft: 10, gap: 2 },
  run: { borderTopWidth: 1, borderColor: '#8883', paddingTop: 6, gap: 1 },
  driver: { gap: 2 },
});
