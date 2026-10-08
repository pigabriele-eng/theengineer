import { useRouter } from 'expo-router';
import { Fragment, ReactNode, useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet } from 'react-native';

import CornerTrace, { cornerTraceReady } from '@/components/CornerTrace';
import { FoldHead } from '@/components/Fold';
import GearMap from '@/components/GearMap';
import { OfficialResults, Prediction } from '@/components/PrepOfficial';
import { Cells, DeltaBlock, Item, Pick, SubHead, usePrepType, ValueBlock } from '@/components/PrepParts';
import { Fig, Label, Section, SpecLine, TextLink, useWide } from '@/components/Programme';
import { GripChart } from '@/components/report/TrackGrip';
import { Text, View } from '@/components/Themed';
import { ZOOM_HINT } from '@/components/Zoom';
import { formatLap } from '@/lib/api';
import { fetchGuide, gearName, Guide, GuideCorner } from '@/lib/guide';
import { poll } from '@/lib/poll';
import { cornersOf } from '@/lib/trackmap';
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
import { deltaColor, face, Fonts, themed, Type, useTheme } from '@/constants/Theme';
import { pct } from '@/lib/trackGrip';

const RUNS_SHOWN = 6;
const VERDICT: Record<string, string> = {
  agree: 'data agrees', slight: 'data leans the same way', normal: 'data reads normal', disagree: 'data says the opposite',
  unmeasured: 'not measured',
};

const span = (r: [number, number] | null | undefined, unit: string) =>
  !r ? null : r[0] === r[1] ? `${r[0].toFixed(0)} ${unit}` : `${r[0].toFixed(0)}–${r[1].toFixed(0)} ${unit}`;
const pastEvents = (n: number) => (n === 1 ? 'one past event' : `${n} past events`);

/** The race weekend's "Before" view (the prep report): what every past event at this track with this car learned, as a
 * briefing in the race programme's numbered sections, the answers first. The lap to aim for in big figures with the
 * briefing and the weather; the gear map of the best lap here; corner by corner, the most effective way through each
 * in words beside its graph (the best pass here against a typical one: speed, throttle, brake); the track's grip and
 * what the tyres did (quali prep, pressures); how the car behaved on each setup and each driver's recurring technique
 * points (no setup suggestions: those are the setup tool's, on demand); and folded at the end, the year by year, the
 * official results and the prediction. Rendered by the prep page (app/prep.tsx) under its own headline, and by the event page's Before tab.
 * The car picker sits at its top; the car picked also goes in the page's ?car=. onAnswer hands the page the event the
 * report is for (its name, track and dates for the headline). */
export default function WeekendBefore({ eventId, car: carParam, onAnswer }: { eventId: number;
  car?: string | number | null; onAnswer?: (answer: PrepAnswer) => void }) {
  const styles = useStyles();
  const type = usePrepType();
  const router = useRouter();
  const theme = useTheme();
  // the car's key ("logger:26724", or "any" for every car here); none: the server picks this event's car
  const given = carParam == null || carParam === '' ? null : String(carParam);
  const [car, setCar] = useState<string | null>(given);
  useEffect(() => setCar(given), [given]);
  const key = `${eventId}|${car ?? ''}`;
  const [answer, setAnswer] = useState<PrepAnswer | null>(null);
  const [weather, setWeather] = useState<PrepWeather | null>(null);
  const [official, setOfficial] = useState<PrepOfficial | null>(null);
  const [officialRound, setOfficialRound] = useState(0); // the car number set: ask again
  const [error, setError] = useState<string | null>(null);
  const [round, setRound] = useState(0); // a refresh starts the polling again

  // ask for the report; while the server works it out, ask again (lib/poll.ts: less and less often)
  useEffect(() => {
    return poll(async (live) => {
      try {
        const a = await fetchPrep(eventId, car);
        if (!live()) return false;
        setAnswer(a);
        setError(null);
        return a.status === 'queued' || a.status === 'running';
      } catch (e) {
        if (!live()) return false;
        setError((e as Error).message);
        return true;
      }
    });
  }, [key, round]); // eslint-disable-line react-hooks/exhaustive-deps -- the key holds the event and the car

  useEffect(() => {
    if (answer) onAnswer?.(answer);
  }, [answer]); // eslint-disable-line react-hooks/exhaustive-deps -- tell the page each new answer once

  // the weather comes from an outside service: it loads on its own and never holds the report up
  useEffect(() => {
    let live = true;
    setWeather(null);
    fetchPrepWeather(eventId).then((w) => live && setWeather(w), () => undefined);
    return () => {
      live = false;
    };
  }, [eventId]);

  // the official results and the prediction: a quick read of their own, also never holding the report up
  useEffect(() => {
    let live = true;
    fetchPrepOfficial(eventId, car).then((o) => live && setOfficial(o), () => undefined);
    return () => {
      live = false;
    };
  }, [key, officialRound]); // eslint-disable-line react-hooks/exhaustive-deps -- the key holds the event and the car
  const reloadOfficial = useCallback(() => setOfficialRound((n) => n + 1), []);

  // the gear map and the corner graphs: from the past events' lap traces, ready at once when they are kept, else
  // asked again while the server reads them or while it doesn't answer (lib/poll.ts: less and less often, for a few
  // minutes; again when the page is back in view). Still no answer after that: a plain line says so
  const [guide, setGuide] = useState<Guide | null>(null);
  useEffect(() => {
    setGuide(null);
    let failed: string | null = null; // why the last ask got no answer
    return poll(async (live) => {
      try {
        const g = await fetchGuide(eventId, car);
        if (!live()) return false;
        failed = null;
        setGuide(g);
        return g.status === 'working';
      } catch (e) {
        failed = (e as Error).message;
        return true;
      }
    }, {
      onGiveUp: () => failed != null && setGuide({ status: 'none', car: null,
        reason: `The gear map couldn’t be loaded (${failed}). It is asked for again when you come back to this page.` }),
    });
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps -- the key holds the event and the car

  const retry = useCallback(async () => {
    try {
      setAnswer(await refreshPrep(eventId, car));
      setRound((n) => n + 1);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [eventId, car]);

  const report = answer?.report ?? null;
  const working = answer?.status === 'queued' || answer?.status === 'running';
  const pickCar = (k: string) => {
    setCar(k);
    router.setParams({ car: k });
  };

  return (
    <>
      {answer && <Opening answer={answer} onPick={pickCar} />}
      {!answer && !error && <ActivityIndicator color={theme.text} style={styles.loading} />}
      {error && <Text style={StyleSheet.flatten([type.error, styles.band])}>Can&apos;t reach the server: {error}</Text>}
      {answer?.status === 'none' && (
        <View style={styles.band}>
          <Text style={styles.bandText}>{answer.reason}</Text>
          <Text style={type.note}>
            Once a weekend here has been driven and its logs uploaded, this report gathers what it learned.
          </Text>
        </View>
      )}
      {answer?.status === 'none' && official?.loaded && (
        <OfficialSections first={1} eventId={eventId} official={official} reload={reloadOfficial} />
      )}
      {answer && working && <Progress answer={answer} />}
      {answer?.status === 'failed' && (
        <View style={styles.band}>
          <Text style={styles.bandText}>{answer.error ?? 'The prep report couldn’t be worked out.'}</Text>
          <TextLink label="Try again" onPress={retry} red />
        </View>
      )}
      {answer?.stale && report && (
        <Text style={StyleSheet.flatten([type.note, styles.stale])}>
          These are from before the past events last changed; the new report replaces them when it is ready.
        </Text>
      )}
      {report && (
        <Body report={report} weather={weather} official={official} eventId={eventId} reloadOfficial={reloadOfficial}
          guide={guide} openEvent={(id) => router.push({ pathname: '/report', params: { event: String(id) } })} />
      )}
    </>
  );
}

/** Where the report learned from, and the car it is for (a pick when there are several). */
function Opening({ answer, onPick }: { answer: PrepAnswer; onPick: (key: string) => void }) {
  const styles = useStyles();
  const learned = answer.status !== 'none' && answer.past_events.length > 0
    ? `Learned from ${pastEvents(answer.past_events.length)} here (` +
      `${answer.past_events.map((e) => e.start?.slice(0, 4) ?? e.name).join(', ')}) with ${answer.car.label}.`
    : 'The briefing for a weekend, from every past weekend at its track.';
  return (
    <View>
      <Text style={styles.dek}>{learned}</Text>
      <CarPicker answer={answer} onPick={onPick} />
    </View>
  );
}

function CarPicker({ answer, onPick }: { answer: PrepAnswer; onPick: (key: string) => void }) {
  const styles = useStyles();
  const choices = [...answer.cars.map((c) => ({ key: c.key, label: `${c.label} (${c.events})` })),
    ...(answer.cars.length > 1 ? [{ key: 'any', label: 'Every car here' }] : [])];
  if (choices.length < 2 && choices.every((c) => c.key === answer.car.key)) return null;
  return (
    <View style={styles.picks}>
      <Label muted>Car</Label>
      {choices.map((c) => <Pick key={c.key} label={c.label} on={c.key === answer.car.key} onPress={() => onPick(c.key)} />)}
    </View>
  );
}

function Progress({ answer }: { answer: PrepAnswer }) {
  const styles = useStyles();
  const type = usePrepType();
  const p = answer.progress;
  const share = p && p.total ? Math.min(p.done / p.total, 1) : 0;
  return (
    <View style={styles.band}>
      <Label>
        Gathering {answer.past_events.length === 1 ? 'the past event' : `${answer.past_events.length} past events`}…
        {p?.current ? ` ${p.current}` : ''}
      </Label>
      <View style={styles.track} accessibilityRole="progressbar"
        accessibilityValue={{ min: 0, max: 100, now: Math.round(share * 100) }}>
        <View style={StyleSheet.flatten([styles.fill, { width: `${Math.round(share * 100)}%` }])} />
      </View>
      <Text style={type.note}>
        The first time takes a few minutes: each past event&apos;s logs are read one at a time. After that it opens at
        once.
      </Text>
    </View>
  );
}

type Part = { key: string; render: (no: number) => ReactNode };

function Body({ report, weather, official, eventId, reloadOfficial, openEvent, guide }: { report: PrepReport;
  weather: PrepWeather | null; official: PrepOfficial | null; eventId: number; reloadOfficial: () => void;
  openEvent: (id: number) => void; guide: Guide | null }) {
  const type = usePrepType();
  const g = report.track_grip;
  const drivers = report.technique.filter((d) => d.habits.length);
  // the sections there is something to say in, numbered in order: the answers first (the lap to aim for, the gears,
  // the corners), then the grip and the tyres, the setups run, and the year by year, results and prediction folded last
  const parts: (Part | null | false)[] = [
    { key: 'brief', render: (no) => <Briefing no={no} report={report} weather={weather} /> },
    { key: 'gears', render: (no) => <Gears no={no} guide={guide} /> },
    { key: 'corners', render: (no) => <Corners no={no} corners={report.corners} guide={guide} /> },
    !!g && (g.guidance.length > 0 || g.notes.length > 0) && {
      key: 'grip', render: (no) => <TrackGripSection no={no} report={report} /> },
    !!report.quali && { key: 'quali', render: (no) => <Quali no={no} report={report} /> },
    !!report.pressures && { key: 'pressures', render: (no) => <Pressures no={no} report={report} weather={weather} /> },
    report.setups.runs.length > 0 && { key: 'runs', render: (no) => <Runs no={no} report={report} /> },
    drivers.length > 0 && { key: 'technique', render: (no) => <Technique no={no} report={report} /> },
    report.notes.length > 0 && { key: 'notes', render: (no) => (
      <Section no={no} title="Notes">
        {report.notes.map((n) => <Text key={n} style={type.note}>{n}</Text>)}
      </Section>
    ) },
    { key: 'later', render: (no) => <Later no={no} report={report} weather={weather} official={official}
      eventId={eventId} reloadOfficial={reloadOfficial} openEvent={openEvent} /> },
  ];
  const shown = parts.filter((p): p is Part => !!p);
  return (
    <>
      {shown.map((p, i) => <Fragment key={p.key}>{p.render(i + 1)}</Fragment>)}
      <Method lines={report.method} />
    </>
  );
}

/** Folded at the end: each past event's laps and conditions, the series' official results here and the prediction
 * for this round. Interesting, not the priority before a weekend. */
function Later({ no, report, weather, official, eventId, reloadOfficial, openEvent }: { no: number;
  report: PrepReport; weather: PrepWeather | null; official: PrepOfficial | null; eventId: number;
  reloadOfficial: () => void; openEvent: (id: number) => void }) {
  const styles = useStyles();
  const type = usePrepType();
  const wide = useWide();
  const [open, setOpen] = useState(false);
  const years = report.performance.map((r) => r.year);
  const facts = [years.length ? `${years.join(', ')}` : null, 'official results',
    official?.prediction ? `prediction for ${official.year}` : null].filter(Boolean).join(' · ');
  return (
    <View style={styles.later}>
      <FoldHead no={no} title="Year by year, results, prediction" facts={facts} open={open}
        onToggle={() => setOpen(!open)} what="the year by year, the official results and the prediction" />
      {open && (
        <>
          <Section no={no + 1} title="Year by year"
            dek="Each past event here: its laps, then the conditions it was driven in.">
            <Performance rows={report.performance} weather={weather} official={official} openEvent={openEvent} />
            {report.trend && <Text style={StyleSheet.flatten([wide ? type.read : type.readPhone, { marginTop: 14 }])}>
              {report.trend}</Text>}
          </Section>
          <OfficialSections first={no + 2} eventId={eventId} official={official} reload={reloadOfficial} />
        </>
      )}
    </View>
  );
}

/** The series' official results here and the prediction for this round (components/PrepOfficial.tsx), on their own
 * when there is no past data here yet. */
function OfficialSections({ first, eventId, official, reload }: { first: number; eventId: number;
  official: PrepOfficial | null; reload: () => void }) {
  return (
    <>
      <OfficialResultsSection no={first} eventId={eventId} official={official} reload={reload} />
      {official?.prediction && <PredictionSection no={first + 1} official={official} />}
    </>
  );
}

function OfficialResultsSection({ no, eventId, official, reload }: { no: number; eventId: number;
  official: PrepOfficial | null; reload: () => void }) {
  return (
    <Section no={no} title="Official results here"
      dek={official?.loaded ? 'From the series’ result sheets: our place in each session, its weather, and the makes.'
        : undefined}>
      <OfficialResults eventId={eventId} data={official} onChanged={reload} />
    </Section>
  );
}

function PredictionSection({ no, official }: { no: number; official: PrepOfficial }) {
  return (
    <Section no={no} title={`Prediction for ${official.year}`}
      dek="From earlier official results only (and our logged laps here); places as likely ranges.">
      <Prediction data={official} />
    </Section>
  );
}

// ---------------------------------------------------------------- 01 before the weekend

function Briefing({ no, report, weather }: { no: number; report: PrepReport; weather: PrepWeather | null }) {
  const styles = useStyles();
  const type = usePrepType();
  const wide = useWide();
  const read = wide ? type.read : type.readPhone;
  const f = weather?.forecast?.summary;
  // the official results and the prediction are folded at the end of the page (Later)
  // a report kept from before setup suggestions left the reports may still hold its "setup" item: never shown
  const items = report.briefing.filter((b) => b.key !== 'setup');
  const sky = f || weather?.compare;
  return (
    <Section no={no} title="Before the weekend" dek="The few things to know, most important first.">
      <AimFigures rows={report.performance} />
      <View style={styles.items}>
        {sky && (
          <Item first label={weather?.forecast?.kind === 'actual' ? 'Weather that weekend' : 'Weather'}>
            <Text style={read}>
              {[f ? `${weather?.forecast?.kind === 'actual' ? 'It was' : 'Forecast:'} ${f.text}.` : null,
                weather?.compare].filter(Boolean).join(' ')}
            </Text>
          </Item>
        )}
        {items.map((b, i) => (
          <Item key={b.key} first={i === 0 && !sky} label={b.title}><Text style={read}>{b.text}</Text></Item>
        ))}
      </View>
      {items.length === 0 && <Text style={type.note}>Nothing stood out in the past events yet.</Text>}
      {weather?.note && !f && <Text style={StyleSheet.flatten([type.note, styles.after])}>Weather: {weather.note}</Text>}
    </Section>
  );
}

/** The lap to aim for in big figures, then the latest event's typical lap, race pace and quali lap. The lap to aim for
 * is the briefing's own (server/app/prep/brief.py): the best real lap here, never a lap stitched from sections or
 * simulated. */
function AimFigures({ rows }: { rows: PerfRow[] }) {
  const styles = useStyles();
  const theme = useTheme();
  const wide = useWide();
  if (!rows.length) return null;
  const last = rows[rows.length - 1];
  const best = rows.reduce((a, b) => (b.best.time < a.best.time ? b : a));
  const who = [best.year, best.best.session, best.best.driver].filter(Boolean).join(', ');
  const small = wide ? 48 : 28;
  return (
    <View style={wide ? styles.aim : styles.aimPhone}>
      <Fig label="Lap time to aim for" value={formatLap(best.best.time)} size={wide ? 104 : 84} bar={theme.mark}
        note={`the best lap here${who ? ` (${who})` : ''}`} style={wide ? styles.aimMain : undefined} />
      <Cells cols={3} phoneCols={3} style={wide ? styles.aimSide : styles.aimSidePhone}>
        {[
          last.typical != null && <Fig key="typical" label={`Typical · ${last.year}`} value={formatLap(last.typical)}
            size={small} note="the median clean lap" />,
          last.race_pace != null && <Fig key="race" label={`Race pace · ${last.year}`}
            value={formatLap(last.race_pace.time)} size={small}
            note={last.race_pace.basis === 'race' ? 'the median race lap' : 'the median lap of the long runs'} />,
          last.quali != null && <Fig key="quali" label={`Quali · ${last.year}`} value={formatLap(last.quali.time)}
            size={small} note={last.quali.basis === 'qualifying' ? 'the best qualifying lap' : 'the best quali-style run'} />,
        ]}
      </Cells>
    </View>
  );
}

// ---------------------------------------------------------------- 02 year by year

function Performance({ rows, weather, official, openEvent }: { rows: PerfRow[]; weather: PrepWeather | null;
  official: PrepOfficial | null; openEvent: (id: number) => void }) {
  const styles = useStyles();
  const type = usePrepType();
  const theme = useTheme();
  const wide = useWide();
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
  const quickest = Math.min(...rows.map((r) => r.best.time));
  // the quickest best lap of all the years in the event's-best purple, the value printed in the block
  const bestCell = (r: PerfRow) => (r.best.time === quickest && rows.length > 0
    ? <ValueBlock value={formatLap(r.best.time)} fill={theme.timing.best} bold />
    : <Text style={styles.td}>{formatLap(r.best.time)}</Text>);
  const foot = rows.some((r) => r.quali?.basis === 'quali run' || r.race_pace?.basis === 'long runs') && (
    <Text style={StyleSheet.flatten([type.note, styles.after])}>* No session marked as qualifying or race: the best
      quali-style run and the median lap of the long runs instead.</Text>
  );
  const drivers = (r: PerfRow) => (r.drivers.length > 1
    ? ` · ${r.drivers.map((d) => `${d.name} ${formatLap(d.best)}`).join(', ')}` : '');

  if (wide) {
    const cols = ['Event', 'Best', 'Typical', 'Race pace', 'Quali', 'vs year before'];
    return (
      <View>
        <View style={styles.thRow}>
          {cols.map((c, i) => (
            <Text key={c} style={StyleSheet.flatten([styles.th, i === 0 ? styles.cFirst : styles.cNum])}>{c}</Text>
          ))}
        </View>
        {rows.map((r) => (
          <Pressable key={r.event_id} accessibilityRole="link" accessibilityLabel={`Open the report of ${r.name}`}
            onPress={() => openEvent(r.event_id)} style={styles.tRow}>
            <View style={styles.tr}>
              <View style={styles.cFirst}>
                <Text style={styles.year}>{r.year}</Text>
                <Text style={type.small} numberOfLines={1}>{r.name}</Text>
              </View>
              <View style={styles.cNum}>
                {bestCell(r)}
                <Text style={StyleSheet.flatten([type.small, styles.right])} numberOfLines={1}>
                  {r.best.driver ?? r.best.session}</Text>
              </View>
              <View style={styles.cNum}><Text style={styles.td}>{formatLap(r.typical)}</Text></View>
              <View style={styles.cNum}><Text style={styles.td}>{race(r)}</Text></View>
              <View style={styles.cNum}><Text style={styles.td}>{quali(r)}</Text></View>
              <View style={styles.cNum}><DeltaBlock seconds={r.change?.best} /></View>
            </View>
            <Text style={StyleSheet.flatten([type.small, styles.cond])}>{conditions(r) || 'No conditions recorded'}
              {drivers(r)}</Text>
          </Pressable>
        ))}
        {foot}
      </View>
    );
  }
  return (
    <View style={styles.yearsPhone}>
      {rows.map((r) => (
        <View key={r.event_id} style={styles.yearPhone}>
          <SubHead kicker={r.name} title={r.year}
            right={r.change?.best != null ? <DeltaBlock seconds={r.change.best} /> : undefined} />
          <View style={styles.bestPhone}>
            <Label>Best</Label>
            <View style={styles.bestPhoneValue}>
              {bestCell(r)}
              <Text style={type.small} numberOfLines={1}>{r.best.driver ?? r.best.session}</Text>
            </View>
          </View>
          <SpecLine label="Typical" value={formatLap(r.typical)} />
          <SpecLine label="Race pace" value={race(r)} />
          <SpecLine label="Quali" value={quali(r)} />
          <Text style={StyleSheet.flatten([type.small, styles.cond])}>{conditions(r) || 'No conditions recorded'}
            {drivers(r)}</Text>
          <View style={styles.after}>
            <TextLink label={`The ${r.year} report`} small arrow onPress={() => openEvent(r.event_id)} />
          </View>
        </View>
      ))}
      {foot}
    </View>
  );
}

// ---------------------------------------------------------------- corner by corner

/** The gear map of the best lap here (components/GearMap.tsx), or why there isn't one yet. */
function Gears({ no, guide }: { no: number; guide: Guide | null }) {
  const type = usePrepType();
  const b = guide?.best_lap;
  const caption = b
    ? `From the best lap here: ${b.session}, lap ${b.lap} (${formatLap(b.time)})${b.year ? `, ${b.year}` : ''}` +
      `${b.driver ? `, ${b.driver}` : ''}. The number on the track is the gear held there; after each braking, the ` +
      'gear for the corner.'
    : undefined;
  return (
    <Section no={no} title="Gear map" dek="The best lap here in the gear held at each point, and where its braking starts.">
      {!guide && <Text style={type.note}>Loading the gear map…</Text>}
      {guide?.status === 'working' && <Text style={type.note}>Reading the past events&apos; laps for the gear map…</Text>}
      {guide?.status === 'none' && <Text style={type.note}>{guide.reason}</Text>}
      {guide?.status === 'ready' && !guide.map && (
        <Text style={type.note}>The best lap&apos;s log has no GPS position, so the track can&apos;t be drawn.</Text>
      )}
      {guide?.status === 'ready' && guide.map && (
        <GearMap map={guide.map} caption={caption} asLogged={guide.gears?.as_logged} />
      )}
    </Section>
  );
}

/** "3rd" through a one-corner section, "3rd T2–T4 · 6th T5" through a longer one: the lowest gear at each official
 * corner in it (from the gear map), consecutive corners with the same gear run together. */
function cornerGears(code: string, guide: Guide | null): string | null {
  const map = guide?.map;
  if (!map) return null;
  const inside = cornersOf(code);
  const at = map.corners.filter((k) => inside.includes(k.code) && k.gear != null);
  const name = (g: number) => (guide?.gears?.as_logged ? `gear ${g}` : gearName(g));
  if (!at.length) {
    const s = map.sections.find((k) => k.code === code);
    return s?.gear != null ? name(s.gear) : null;
  }
  if (at.length === 1 || at.every((k) => k.gear === at[0].gear)) return name(at[0].gear!);
  const groups: { gear: number; from: string; to: string }[] = [];
  for (const k of at) {
    const last = groups[groups.length - 1];
    if (last && last.gear === k.gear) last.to = k.code;
    else groups.push({ gear: k.gear!, from: k.code, to: k.code });
  }
  return groups.map((g) => `${name(g.gear)} ${g.from}${g.to !== g.from ? `–${g.to}` : ''}`).join(' · ');
}

/** The section the guide drew a prep row's corner in: the same code, else the one holding its first official corner. */
const guideCornerFor = (r: CornerRow, guide: Guide | null): GuideCorner | undefined => {
  const all = guide?.corners ?? [];
  return all.find((k) => k.code === r.code) ?? all.find((k) => k.corners.includes(cornersOf(r.code)[0]));
};

/** A corner code's place on the lap when the guide isn't there to order them: "T2-T5" by its 2, "C3" by its 3. */
const lapOrder = (code: string) => Number(/\d+/.exec(code)?.[0] ?? 999);

function Corners({ no, corners, guide }: { no: number; corners: PrepReport['corners']; guide: Guide | null }) {
  const styles = useStyles();
  const type = usePrepType();
  const wide = useWide();
  if (!corners.rows.length) {
    return <Section no={no} title="Corner by corner"><Text style={type.note}>{corners.note}</Text></Section>;
  }
  // in lap order: the guide's sections when it is ready, the corner numbers until then
  const order = guide?.status === 'ready' && guide.corners?.length
    ? (r: CornerRow) => {
        const k = guideCornerFor(r, guide);
        return k ? guide.corners!.indexOf(k) : 999 + lapOrder(r.code);
      }
    : (r: CornerRow) => lapOrder(r.code);
  const rows = [...corners.rows].sort((a, b) => order(a) - order(b));
  const top = [...corners.rows].sort((a, b) => (b.gain_s ?? 0) - (a.gain_s ?? 0)).slice(0, 3).map((r) => r.code);
  const graphs = guide?.status === 'working' ? 'The graphs follow once the past events’ laps are read.'
    : guide?.status === 'none' ? guide.reason : guide?.status === 'ready' ? ZOOM_HINT : null;
  return (
    <Section no={no} title="Corner by corner"
      dek={`In lap order. Top 10%: what the quickest tenth of the passes did; the graph is the best pass here ` +
        `against a typical one. Most time to find: ${top.join(', ')}.`}>
      {corners.changes && <Text style={StyleSheet.flatten([wide ? type.read : type.readPhone, styles.before])}>
        {corners.changes}</Text>}
      {corners.note && <Text style={StyleSheet.flatten([type.note, styles.before])}>{corners.note}</Text>}
      {graphs && <Text style={StyleSheet.flatten([type.note, styles.before])}>{graphs}</Text>}
      {rows.map((r) => <Corner key={r.code} r={r} guide={guide} top={top.includes(r.code)} />)}
    </Section>
  );
}

function Corner({ r, guide, top }: { r: CornerRow; guide: Guide | null; top: boolean }) {
  const styles = useStyles();
  const type = usePrepType();
  const theme = useTheme();
  const wide = useWide();
  const read = wide ? type.read : type.readPhone;
  const years = Object.values(r.per_event);
  const k = guideCornerFor(r, guide);
  const gears = cornerGears(k?.code ?? r.code, guide);
  const graph = k && cornerTraceReady(k) ? k : null;
  return (
    <View style={wide ? styles.corner : styles.cornerPhone}>
      <View style={wide ? styles.cornerText : undefined}>
        <View style={styles.cornerHead}>
          <Text style={wide ? styles.code : styles.codePhone}>{r.code}</Text>
          <View style={styles.cornerFacts}>
            {r.gain_s != null && (
              <Text style={StyleSheet.flatten([styles.gain, { color: deltaColor(theme, r.gain_s) ?? theme.text }])}>
                {r.gain_s.toFixed(2)} s a lap to find{top ? ' · top 3' : ''}
              </Text>
            )}
            {gears && <Text style={styles.gearLine}>Gear {gears}</Text>}
          </View>
        </View>
        <View style={styles.cornerMain}>
          {r.ideal && <Text style={read}><Text style={type.inLabel}>Top 10%  </Text>{r.ideal}</Text>}
          {r.why && <Text style={read}><Text style={type.inLabel}>Why  </Text>{r.why}</Text>}
          {r.advice.length > 0 && (
            <Text style={read}><Text style={type.inLabel}>To change  </Text>{r.advice.join('. ')}.</Text>
          )}
          {r.drivers.map((d) => (
            <Text key={`${d.driver}-${d.text}`} style={type.note}>{d.driver ?? 'Untagged laps'}: {d.text}</Text>
          ))}
          {r.change && (
            <View style={styles.change}>
              <DeltaBlock seconds={r.change.typical} />
              <Text style={type.small}>typical, against {r.change.from}</Text>
            </View>
          )}
          <Text style={type.small}>
            {years.map((y) => `${y.year}: best ${y.best?.toFixed(2) ?? '–'} s, typical ${y.typical?.toFixed(2) ?? '–'} s`)
              .join(' · ')}
            {r.best_by.driver ? ` · best pass by ${r.best_by.driver}` : ''}
          </Text>
        </View>
      </View>
      {graph && (
        <View style={wide ? styles.cornerGraph : styles.cornerGraphPhone}>
          <CornerTrace corner={graph} step={guide?.step_m ?? 3} brakeUnit={guide?.units?.brake} wide={wide} />
        </View>
      )}
    </View>
  );
}

// ---------------------------------------------------------------- quali, grip, pressures

function Quali({ no, report }: { no: number; report: PrepReport }) {
  const styles = useStyles();
  const type = usePrepType();
  const wide = useWide();
  const q = report.quali;
  if (!q) return null;
  const advice = q.advice.filter((a) => ['plan', 'ready', 'build', 'brakes', 'push'].includes(a.key));
  return (
    <Section no={no} title="Quali prep that worked" dek={`From the tyre sensors in ${q.from}.`}>
      <View style={styles.items}>
        {advice.map((a, i) => (
          <Item key={a.key} first={i === 0} label={a.title}><Text style={wide ? type.read : type.readPhone}>{a.text}</Text></Item>
        ))}
      </View>
      {q.per_event.length > 1 && q.per_event.map((e) => (
        <Text key={e.event_id} style={StyleSheet.flatten([type.small, styles.line])}>
          {e.year}: {[e.quali ? `quali ${formatLap(e.quali.time)}` : null,
            e.push ? `push from ${e.push.front_c} °C front, ${e.push.rear_c} °C rear` : null,
            e.ready_min ? `ready ${span(e.ready_min, 'min')} after leaving` : null,
            e.peak_from_exit ? `best lap ${e.peak_from_exit[0]}–${e.peak_from_exit[1]} laps out` : null,
            e.warm_up ? `quickest warm-up ${e.warm_up.label}` : null].filter(Boolean).join(' · ')}
        </Text>
      ))}
      <View style={styles.more}>
        <TextLink label={`The full quali prep of ${q.from}`} red arrow
          href={{ pathname: '/quali', params: { event: String(q.event_id) } }} />
      </View>
    </Section>
  );
}

/** How the track's grip came in at each past event here (against its own first session) and what to expect from it,
 * with how sure that is, and the latest event's sessions as a chart. */
function TrackGripSection({ no, report }: { no: number; report: PrepReport }) {
  const styles = useStyles();
  const type = usePrepType();
  const wide = useWide();
  const g = report.track_grip;
  if (!g || (!g.guidance.length && !g.notes.length)) return null;
  const known = g.events.filter((e) => e.available);
  const latest = [...known].reverse().find((e) => e.sessions?.length);
  const size = wide ? 44 : 32;
  const pm = (p: { pm: number | null } | null | undefined) => (p?.pm != null ? `± ${pct(p.pm, false)}` : null);
  return (
    <Section no={no} title="Track grip" dek="How the grip came in at past events here, each against its own first session.">
      {g.guidance.map((t) => <Text key={t} style={StyleSheet.flatten([wide ? type.read : type.readPhone, styles.para])}>{t}</Text>)}
      {known.map((e) => (
        <View key={e.id} style={styles.gripEvent}>
          <SubHead kicker={`${e.name} · against ${e.base}`} title={e.year} />
          <Cells cols={4} phoneCols={2}>
            {[
              <Fig key="peak" label="Best it got to" value={e.peak?.pct != null ? pct(e.peak.pct) : '–'} size={size}
                note={[pm(e.peak), e.peak?.session ?? 'no rise'].filter(Boolean).join(' · ')} />,
              <Fig key="quali" label="Qualifying"
                value={e.quali ? pct(e.quali.pct) : e.base_kind === 'qualifying' ? '0 %' : '–'} size={size}
                note={[e.quali ? pm(e.quali) : null,
                  e.quali?.session ?? (e.base_kind === 'qualifying' ? 'the first session' : 'none logged')]
                  .filter(Boolean).join(' · ')} />,
              <Fig key="races" label="Races vs quali" size={size}
                value={(e.races_vs_quali ?? []).filter(Boolean).map((r) => pct(r!.pct)).join(', ') || '–'}
                note={(e.races_vs_quali ?? []).filter(Boolean).map((r) => r!.session).join(', ') || undefined} />,
              <Fig key="by" label="Most of it by" value={e.by_lap ? `Lap ${e.by_lap}` : '–'} size={size}
                note="of the car's weekend" />,
            ]}
          </Cells>
        </View>
      ))}
      {g.sureness && <Text style={StyleSheet.flatten([type.note, styles.after])}>{g.sureness}</Text>}
      {latest && (
        <View style={styles.chart}>
          <GripChart sessions={latest.sessions!} base={latest.base ?? ''}
            title={`${latest.name} ${latest.year}: track grip by session, % against ${latest.base}`} />
        </View>
      )}
      {g.notes.map((n) => <Text key={n} style={StyleSheet.flatten([type.note, styles.after])}>{n}</Text>)}
    </Section>
  );
}

function Pressures({ no, report, weather }: { no: number; report: PrepReport; weather: PrepWeather | null }) {
  const styles = useStyles();
  const type = usePrepType();
  const wide = useWide();
  const p = report.pressures;
  if (!p) return null;
  const cold = (p.tyres ?? []).filter((t) => t.cold_bar != null);
  return (
    <Section no={no} title="Tyre pressures" dek={p.year ? `What landed the tyres in their window in ${p.year}` +
      (p.ambient_c ? `, at ${span(p.ambient_c, '°C')} air.` : '.') : 'What the tyre model found here.'}>
      {cold.length > 0 && (
        <Cells cols={4} phoneCols={2} style={styles.before}>
          {cold.map((t) => (
            <Fig key={t.tyre} label={`${t.tyre} · cold`} value={t.cold_bar!.toFixed(2)} unit="bar" size={wide ? 52 : 36}
              note={`${t.target_hot_bar.toFixed(2)} bar hot`} />
          ))}
        </Cells>
      )}
      {weather?.compare && <Text style={StyleSheet.flatten([wide ? type.read : type.readPhone, styles.para])}>
        {weather.compare}</Text>}
      {(p.tyre_model?.lines ?? []).length > 0 && (
        <View style={styles.items}>
          {(p.tyre_model?.lines ?? []).map((l, i) => (
            <Item key={l} first={i === 0} label={i === 0 ? 'Tyre model' : ''}>
              <Text style={wide ? type.read : type.readPhone}>{l}</Text>
            </Item>
          ))}
        </View>
      )}
      <View style={styles.more}>
        <TextLink label="Pressure calculator for the weekend's temperatures" arrow href="/tools/pressures" />
      </View>
    </Section>
  );
}

// ---------------------------------------------------------------- runs, technique

function Runs({ no, report }: { no: number; report: PrepReport }) {
  const styles = useStyles();
  const type = usePrepType();
  const wide = useWide();
  const [all, setAll] = useState(false);
  const s = report.setups;
  if (!s.runs.length) return null;
  const runs = all ? s.runs : s.runs.slice(0, RUNS_SHOWN);
  return (
    <Section no={no} title="Setups and how the car behaved" dek={s.note ?? undefined}>
      {s.said.map((x) => <Text key={x.text} style={StyleSheet.flatten([wide ? type.read : type.readPhone, styles.para])}>
        {x.text}</Text>)}
      <View style={wide ? styles.runs : styles.runsPhone}>
        {runs.map((r) => <Run key={r.session_id} r={r} />)}
      </View>
      {s.runs.length > RUNS_SHOWN && (
        <View style={styles.more}>
          <TextLink label={all ? 'Show fewer runs' : `Show all ${s.runs.length} runs`} onPress={() => setAll(!all)} />
        </View>
      )}
    </Section>
  );
}

function Run({ r }: { r: SetupRun }) {
  const styles = useStyles();
  const type = usePrepType();
  const wide = useWide();
  return (
    <View style={wide ? styles.run : styles.runPhone}>
      <View style={styles.runHead}>
        <View style={styles.runName}>
          <Text style={styles.runCode} numberOfLines={1}>{r.name}</Text>
          <Text style={type.small} numberOfLines={1}>{[r.year, r.driver].filter(Boolean).join(' · ')}</Text>
        </View>
        <View style={styles.runBest}>
          <Text style={styles.runTime}>{formatLap(r.best)}</Text>
          {r.delta_best != null && (
            <View style={styles.runDelta}>
              <DeltaBlock seconds={r.delta_best} />
              <Text style={type.small} numberOfLines={1}>vs {r.compared_with}</Text>
            </View>
          )}
        </View>
      </View>
      {r.changes.length > 0 && <Text style={type.small}>Changed: {r.changes.join(', ')}</Text>}
      {r.setup && r.changes.length === 0 && <Text style={type.small}>Setup sheet saved</Text>}
      {r.balance && <Text style={type.small}>Car: {r.balance}{r.tc_s_per_lap != null
        ? `, traction control ${r.tc_s_per_lap.toFixed(1)} s a lap` : ''}</Text>}
      {r.remarks.map((m) => (
        <Text key={m.text} style={type.note}>“{m.text}” — {m.verdict ? VERDICT[m.verdict] ?? m.verdict : 'not checked'}
          {m.data ? `: ${m.data}` : ''}</Text>
      ))}
    </View>
  );
}

function Technique({ no, report }: { no: number; report: PrepReport }) {
  const styles = useStyles();
  const type = usePrepType();
  const wide = useWide();
  const drivers = report.technique.filter((d) => d.habits.length);
  if (!drivers.length) return null;
  return (
    <Section no={no} title="Driver technique" dek="The mistakes that repeat on each driver's laps, costliest a lap first.">
      {drivers.map((d) => (
        <View key={d.name ?? 'none'} style={styles.driver}>
          <SubHead title={d.name ?? 'Untagged laps'} right={<Label muted>{d.laps} laps</Label>} />
          {d.habits.map((h, i) => (
            <View key={h.text} style={StyleSheet.flatten([styles.habit, i === 0 && styles.habitFirst])}>
              <Text style={wide ? type.read : type.readPhone}>{h.text}</Text>
            </View>
          ))}
        </View>
      ))}
    </Section>
  );
}

function Method({ lines }: { lines: string[] }) {
  const styles = useStyles();
  const type = usePrepType();
  const [open, setOpen] = useState(false);
  return (
    <View style={styles.method}>
      <TextLink label={open ? 'Hide how this is worked out' : 'How this is worked out'} small onPress={() => setOpen(!open)} />
      {open && (
        <View style={styles.methodLines}>
          {lines.map((l) => <Text key={l} style={type.note}>{l}</Text>)}
        </View>
      )}
    </View>
  );
}

const useStyles = themed((c) => ({
  loading: { marginTop: 24, alignSelf: 'flex-start' },
  // the opening
  dek: { ...Type.dek, color: c.textSecondary, marginTop: 8, maxWidth: 640 },
  picks: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: 18, rowGap: 8, marginTop: 16 },

  // states
  band: { marginTop: 28, borderTopWidth: 3, borderBottomWidth: 1, borderColor: c.rule, paddingTop: 12, paddingBottom: 14,
    gap: 10 },
  bandText: { fontFamily: Fonts.body, fontSize: 18, lineHeight: 26, color: c.text },
  track: { height: 8, backgroundColor: c.fill },
  fill: { height: 8, backgroundColor: c.rule },
  stale: { marginTop: 16 },

  // shared spacing
  items: { marginTop: 4 },
  before: { marginBottom: 14 },
  after: { marginTop: 12 },
  para: { marginBottom: 12, maxWidth: 820 },
  line: { marginTop: 8 },
  more: { marginTop: 20 },
  chart: { marginTop: 22 },

  // the lap to aim for
  aim: { flexDirection: 'row', alignItems: 'flex-end', gap: 36, marginBottom: 26 },
  aimPhone: { gap: 22, marginBottom: 22 },
  aimMain: { width: 420 },
  aimSide: { flex: 1, minWidth: 0 },
  aimSidePhone: {},

  // year by year
  thRow: { flexDirection: 'row', gap: 12, borderBottomWidth: 2, borderColor: c.rule, paddingBottom: 6 },
  th: { ...Type.label, fontFamily: face('label', 700), fontSize: 12, letterSpacing: 1.2, color: c.text },
  tRow: { borderBottomWidth: 1, borderColor: c.separator, paddingTop: 10, paddingBottom: 10, gap: 4 },
  tr: { flexDirection: 'row', alignItems: 'flex-start', gap: 12 },
  cFirst: { flex: 1.6, minWidth: 0 },
  cNum: { flex: 1, minWidth: 0, alignItems: 'flex-end', textAlign: 'right' },
  right: { textAlign: 'right' },
  year: { fontFamily: Fonts.display, fontSize: 26, lineHeight: 28, color: c.text },
  td: { fontFamily: face('label', 600), fontSize: 17, fontVariant: ['tabular-nums'], color: c.text, paddingVertical: 2 },
  cond: { marginTop: 6 },
  yearsPhone: { gap: 26 },
  yearPhone: {},
  bestPhone: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12,
    borderBottomWidth: 1, borderColor: c.separator, paddingTop: 4, paddingBottom: 7 },
  bestPhoneValue: { alignItems: 'flex-end', gap: 3, flexShrink: 1 },

  // corners: the words beside the graph (under it on a phone)
  corner: { flexDirection: 'row', alignItems: 'flex-start', gap: 32, borderTopWidth: 3, borderColor: c.rule,
    paddingTop: 12, paddingBottom: 22 },
  cornerPhone: { borderTopWidth: 3, borderColor: c.rule, paddingTop: 10, paddingBottom: 22, gap: 14 },
  cornerText: { width: '40%', minWidth: 0 },
  cornerGraph: { flex: 1, minWidth: 0 },
  cornerGraphPhone: {},
  cornerHead: { flexDirection: 'row', alignItems: 'flex-end', flexWrap: 'wrap', columnGap: 16, rowGap: 4,
    marginBottom: 10 },
  cornerFacts: { gap: 2, flexShrink: 1, paddingBottom: 4 },
  cornerMain: { minWidth: 0, gap: 9 },
  code: { fontFamily: Fonts.display, fontSize: 40, lineHeight: 44, color: c.text },
  codePhone: { fontFamily: Fonts.display, fontSize: 34, lineHeight: 38, color: c.text },
  gain: { fontFamily: face('label', 700), fontSize: 16, lineHeight: 20, letterSpacing: 0.2 },
  gearLine: { fontFamily: face('label', 600), fontSize: 15, lineHeight: 20, color: c.text },
  change: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  later: { marginTop: 48 },

  // runs
  runs: { flexDirection: 'row', flexWrap: 'wrap', columnGap: 36, borderTopWidth: 1, borderColor: c.rule },
  runsPhone: { borderTopWidth: 1, borderColor: c.rule },
  run: { width: '47%', flexGrow: 1, borderBottomWidth: 1, borderColor: c.separator, paddingTop: 10, paddingBottom: 11,
    gap: 3 },
  runPhone: { borderBottomWidth: 1, borderColor: c.separator, paddingTop: 10, paddingBottom: 11, gap: 3 },
  runHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 },
  runName: { flex: 1, minWidth: 0 },
  runCode: { fontFamily: face('label', 700), fontSize: 17, letterSpacing: 0.3, color: c.text },
  runBest: { alignItems: 'flex-end', gap: 3 },
  runTime: { fontFamily: face('label', 600), fontSize: 19, fontVariant: ['tabular-nums'], color: c.text },
  runDelta: { flexDirection: 'row', alignItems: 'center', gap: 6 },

  // technique
  driver: { marginTop: 6 },
  habit: { borderTopWidth: 1, borderColor: c.separator, paddingTop: 9, paddingBottom: 9 },
  habitFirst: { borderTopWidth: 0 },
  gripEvent: { marginTop: 18 },

  method: { marginTop: 40, gap: 12 },
  methodLines: { gap: 6, maxWidth: 820 },
}));
