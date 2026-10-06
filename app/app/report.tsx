import { Link, Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, LayoutChangeEvent, Pressable, ScrollView, StyleSheet, useWindowDimensions } from 'react-native';

import { Bars, LineChart, LineSeries, useChartColors } from '@/components/ReportCharts';
import { Balance } from '@/components/report/Balance';
import { GripReport } from '@/components/report/GripReport';
import { TrackGrip } from '@/components/report/TrackGrip';
import { SessionSwitcher, useEventFolder, useSessionEvent } from '@/components/SessionSwitcher';
import { Text, View, useThemeColor } from '@/components/Themed';
import { TrackMap } from '@/components/TrackMap';
import { formatLap } from '@/lib/api';
import { TrackShapeData } from '@/lib/trackshape';
import {
  fetchReport,
  Habit,
  lapName,
  LapRow,
  PHASES,
  refreshReport,
  Relation,
  Report,
  ReportAnswer,
  ReportScope,
  SectionReport,
} from '@/lib/report';
import { deltaColor, deltaMark, Palette, phaseColor, Radius, themed, useTheme } from '@/constants/Theme';

const POLL_MS = 2000;
const WIDE = 900;
const MEDAL = { gold: 'Gold', silver: 'Silver', bronze: 'Bronze' } as const;
const SCORE_NAMES: Record<string, string> = {
  braking: 'Braking', turn_in: 'Turn-in', mid_corner: 'Mid-corner', traction: 'Traction',
};

const s2 = (v: number) => `${v.toFixed(2)} s`;
const MAX_EVIDENCE = 5; // measures shown under a section before "Show all"
// lap time axis ticks as m:ss, with tenths only when the ticks are closer than a second
const lapTick = (v: number) => {
  const m = Math.floor(v / 60);
  const sec = Math.round((v - 60 * m) * 10) / 10;
  const text = Number.isInteger(sec) ? String(sec) : sec.toFixed(1);
  return m ? `${m}:${sec < 10 ? '0' : ''}${text}` : text;
};

/** How to go faster, for a whole event (every session of a test) or one session: the advice first, then corner by
 * corner what to change and the evidence, then trends, consistency and what goes with lap time. */
export default function ReportScreen() {
  const theme = useTheme();
  const styles = useStyles();
  const params = useLocalSearchParams<{ event?: string; session?: string }>();
  const scope: ReportScope | null = params.event ? { event: Number(params.event) }
    : params.session ? { session: Number(params.session) } : null;
  const key = scope ? JSON.stringify(scope) : '';
  const [answer, setAnswer] = useState<ReportAnswer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [focus, setFocus] = useState<string | null>(null);
  const [mapY, setMapY] = useState(0);
  const [shape, setShape] = useState<TrackShapeData | null>(null); // the track's shape, once the map has it
  const scroll = useRef<ScrollView>(null);
  const { width } = useWindowDimensions();
  const wide = width >= WIDE;
  const router = useRouter();
  // the event's sessions, to switch between the whole event's report and one session's without going back; the page
  // keeps its place and the section picked on the map
  const sessionEvent = useSessionEvent(scope && 'session' in scope ? scope.session : null);
  const folder = useEventFolder(scope && 'event' in scope ? scope.event : sessionEvent);

  // ask for the report; while the server works it out, ask again every couple of seconds
  useEffect(() => {
    if (!scope) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const a = await fetchReport(scope);
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const retry = useCallback(async () => {
    if (!scope) return;
    try {
      setAnswer(await refreshReport(scope));
      setError(null);
      // the poll above has stopped; start it again through a fresh fetch loop
      const again = async () => {
        const a = await fetchReport(scope);
        setAnswer(a);
        if (a.status === 'queued' || a.status === 'running') setTimeout(again, POLL_MS);
      };
      setTimeout(again, POLL_MS);
    } catch (e) {
      setError((e as Error).message);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const report = answer?.report ?? null;
  const showOnMap = (code: string) => {
    setFocus(code);
    scroll.current?.scrollTo({ y: Math.max(mapY - 12, 0), animated: true });
  };

  if (!scope) {
    return <Text style={styles.pad}>Open a report from an event on the Sessions tab, or from a session.</Text>;
  }
  const working = answer?.status === 'queued' || answer?.status === 'running';
  const switching = answer != null && key !== JSON.stringify(answer.scope === 'event' ? { event: answer.id }
    : { session: answer.id });
  // the sessions have clean laps (the report is ready or being worked out), so the other sections have data too
  const hasLaps = report != null || working || answer?.sessions.some((s) => s.included) === true;
  const highlight = focus ?? report?.gains[0]?.code ?? undefined;
  const tones = report ? sectionTones(theme, report) : undefined;
  const toneKey = tones ? 'Sections in red by the time a typical lap can gain there: the deeper, the more.' : undefined;
  const map = 'event' in scope
    ? <TrackMap event={scope.event} highlight={highlight} withShape onShape={setShape} sectionColors={tones} sectionKey={toneKey} />
    : <TrackMap session={scope.session} highlight={highlight} withShape onShape={setShape} sectionColors={tones}
      sectionKey={toneKey} />;

  return (
    <ScrollView ref={scroll} contentContainerStyle={styles.outer}>
      <Stack.Screen options={{ title: answer ? `Report · ${answer.title}` : 'Report' }} />
      <View style={styles.page}>
        <View style={styles.head}>
          <Text style={styles.h1}>How to go faster</Text>
          {answer && (
            <Text style={styles.sub}>
              {answer.title}
              {answer.track ? ` · ${answer.track}` : ''}
              {report ? ` · ${report.laps_analysed} clean laps from ${report.runs_analysed} ` +
                `${report.runs_analysed === 1 ? 'session' : 'sessions'}` : ''}
            </Text>
          )}
        </View>
        {folder && folder.id != null && (
          <SessionSwitcher folder={folder} current={'session' in scope ? scope.session : null} onlyTimed
            onWhole={() => router.setParams({ event: String(folder.id), session: undefined })}
            onPick={(s) => router.setParams({ session: String(s.id), event: undefined })} />
        )}
        {switching && <ActivityIndicator />}

        {!answer && !error && <ActivityIndicator />}
        {error && <Text style={styles.error}>Can&apos;t reach the server: {error}</Text>}
        {answer && working && <Progress answer={answer} />}
        {answer?.status === 'failed' && (
          <View style={styles.banner}>
            <Text style={styles.bannerText}>{answer.error ?? 'The report couldn’t be worked out.'}</Text>
            <Pressable accessibilityRole="button" onPress={retry} style={styles.smallButton}>
              <Text style={styles.smallButtonText}>Try again</Text>
            </Pressable>
          </View>
        )}
        {answer?.status === 'empty' && (
          <Text style={styles.note}>
            No clean laps to analyse yet. Upload the logs of this {answer.scope}; the report is worked out as soon as
            they are imported.
          </Text>
        )}
        {report && (report.laps_left_out ?? 0) > 0 && (
          <Text style={styles.note}>
            Worked out from the {report.laps_analysed} quickest clean laps; the {report.laps_left_out} slower ones are
            left out to keep within the server&apos;s memory.
          </Text>
        )}
        {answer?.stale && report && (
          <Text style={styles.note}>
            These numbers are from before the sessions last changed; the new report replaces them when it is ready.
          </Text>
        )}
        {hasLaps && (
          <Link href={{ pathname: '/technique', params: 'event' in scope ? { event: scope.event }
            : { session: scope.session } }} asChild>
            <Pressable style={styles.smallButton}>
              <Text style={styles.smallButtonText}>Technique check: each lap&apos;s mistakes against perfect driving</Text>
            </Pressable>
          </Link>
        )}

        {/* The core report answers at once from the server's cache; the map and the other sections load themselves
            meanwhile (they take turns on the server's log lock), so nothing waits for anything else to paint. */}
        {hasLaps && (
          <View style={wide ? styles.row : styles.column}>
            {report && (
              <View style={wide ? styles.half : undefined}>
                <Glance report={report} onPick={setFocus} focus={highlight ?? null} />
              </View>
            )}
            <View style={wide ? styles.half : undefined}
              onLayout={(e: LayoutChangeEvent) => setMapY(e.nativeEvent.layout.y)}>
              {map}
            </View>
          </View>
        )}
        {/* banked corners grip more than the tyres would on a flat road: say which, by number */}
        {hasLaps && shape?.banked_note ? <Text style={styles.bullet}>{shape.banked_note}</Text> : null}

        {report && (
          <>
            <Section title="Where the time goes">
              <Text style={styles.note}>
                What a typical lap ({formatLap(report.headline.typical)}) loses to the quick passes of every section,
                added up by what the quickest pass was doing at each metre.
              </Text>
              <Bars rows={PHASES.map((p) => ({ label: cap(p), value: report.where_total[p] ?? 0, color: phaseColor(theme, p) }))} />
            </Section>

            <Section title="Corner by corner">
              <Text style={styles.note}>
                Each section in lap order: what to change, where its time goes, and the evidence. Tap a section&apos;s
                name to see it on the map.
              </Text>
              {report.sections.map((s) => (
                <DrivingCard key={s.code} section={s} report={report} wide={wide} onMap={() => showOnMap(s.code)} />
              ))}
            </Section>
          </>
        )}

        {hasLaps && (
          <>
            <View style={styles.section}>
              {'event' in scope ? <GripReport event={scope.event} /> : <GripReport session={scope.session} />}
            </View>
            {'event' in scope && (
              <View style={styles.section}>
                <TrackGrip event={scope.event} />
              </View>
            )}
            <View style={styles.section}>
              {'event' in scope ? <Balance event={scope.event} /> : <Balance session={scope.session} />}
            </View>
            <View style={styles.section}>
              <Text style={styles.h2}>Tyres and qualifying preparation</Text>
              <Link href={{ pathname: '/quali', params: 'event' in scope ? { event: scope.event }
                : { session: scope.session } }} asChild>
                <Pressable style={styles.smallButton}>
                  <Text style={styles.smallButtonText}>Quali prep: warm-up, build laps, tyre windows and pressures</Text>
                </Pressable>
              </Link>
            </View>
          </>
        )}

        {report && (
          <>
            <Section title="Trends and consistency">
              <Trends report={report} />
            </Section>

            <Section title="What goes with lap time">
              <Relations relations={report.lap_time_relations} laps={report.laps_analysed} />
            </Section>

            <Section title="Sessions in this report">
              {answer!.sessions.map((s) => (
                <Link key={s.id} href={{ pathname: '/session/[id]', params: { id: s.id } }} asChild>
                  <Pressable style={styles.sessionRow}>
                    <Text style={StyleSheet.flatten([styles.sessionName, !s.included && styles.dim])}>
                      {s.name}
                      {s.driver ? ` · ${s.driver}` : ''}
                    </Text>
                    <Text style={StyleSheet.flatten([styles.sessionMeta, !s.included && styles.dim])}>
                      {s.included ? `${s.clean_laps} clean laps · best ${formatLap(s.best)}` : s.note ?? 'Left out'}
                    </Text>
                  </Pressable>
                </Link>
              ))}
            </Section>

            <Section title="How this is worked out">
              {report.method.map((m) => (
                <Text key={m} style={styles.method}>{m}</Text>
              ))}
            </Section>
          </>
        )}
      </View>
    </ScrollView>
  );
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Each section's colour on the map and on its cards: red, deeper the more time a typical lap can gain there. */
function sectionTones(theme: Palette, report: Report): Record<string, string> {
  const top = Math.max(...report.sections.map((s) => s.gain_s), 0.01);
  return Object.fromEntries(report.sections.map((s) => [s.code, s.gain_s >= 0.01 ? deltaMark(theme, s.gain_s, top)
    : theme.chart.axis]));
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  const styles = useStyles();
  return (
    <View style={styles.section}>
      <Text style={styles.h2}>{title}</Text>
      {children}
    </View>
  );
}

function Progress({ answer }: { answer: ReportAnswer }) {
  const styles = useStyles();
  const c = useChartColors();
  const p = answer.progress;
  const share = p && p.total ? p.done / p.total : 0;
  return (
    <View style={styles.progress}>
      <Text style={styles.bannerText}>
        {answer.report ? 'Updating the report' : 'Working out the report'}
        {p?.current ? `: ${p.current}` : '…'}
      </Text>
      <View style={[styles.meter, { backgroundColor: c.grid }]}>
        <View style={[styles.meterFill, { backgroundColor: c.s1, width: `${Math.round(share * 100)}%` }]} />
      </View>
      <Text style={styles.note}>
        Each session&apos;s log is read once, then kept in compact form, so later reports come quicker.
      </Text>
    </View>
  );
}

// ---------- at a glance ----------

function Glance({ report, onPick, focus }: { report: Report; onPick: (code: string) => void; focus: string | null }) {
  const theme = useTheme();
  const styles = useStyles();
  const h = report.headline;
  const sc = h.score;
  const border = useChartColors().grid;
  const tones = sectionTones(theme, report);
  return (
    <View style={styles.glance}>
      <View style={styles.scoreRow}>
        <View>
          <Text style={styles.label}>Driving score</Text>
          <Text style={styles.hero}>{sc.extraction.toFixed(1)}%</Text>
          <Text style={styles.note}>of the car&apos;s theoretical pace, on the fastest lap</Text>
        </View>
        {sc.medal && (
          <View style={[styles.medal, { borderColor: border }]}>
            <Text style={styles.medalText}>{MEDAL[sc.medal]}</Text>
            {sc.next_medal && (
              <Text style={styles.note}>
                {sc.next_medal.seconds_to_find >= 0.01 ? `${sc.next_medal.seconds_to_find.toFixed(2)} s to `
                  : 'on the edge of '}
                {sc.next_medal.medal}
              </Text>
            )}
          </View>
        )}
      </View>
      <Text style={styles.scores}>
        {Object.entries(sc.scores).map(([k, v]) => `${SCORE_NAMES[k] ?? k} ${v.toFixed(1)}%`).join(' · ')}
      </Text>
      <View style={styles.tiles}>
        <Tile label="Fastest lap" value={formatLap(h.fastest.time)}
          detail={`${h.fastest.run}, lap ${h.fastest.lap}`} />
        <Tile label="Ideal lap" value={formatLap(h.ideal)} detail="best pass of every section" />
        <Tile label="Realistic target" value={formatLap(h.realistic)} detail="a quick lap's usual grip at each place" />
        <Tile label="Theoretical lap" value={formatLap(h.theoretical)} detail="the car's best at every place" />
      </View>

      <Text style={styles.h3}>Top three ways to gain time</Text>
      {report.gains.length === 0 && (
        <Text style={styles.note}>The typical pass is already as quick as the quick passes everywhere.</Text>
      )}
      {report.gains.map((g, i) => (
        <Pressable key={g.code} accessibilityRole="button" onPress={() => onPick(g.code)}
          style={StyleSheet.flatten([styles.gain, { borderColor: g.code === focus ? theme.tint : border,
            borderLeftColor: tones[g.code] ?? border }])}>
          <View style={styles.gainHead}>
            <Text style={styles.gainRank}>{i + 1}</Text>
            <Text style={styles.gainCode}>{g.code}</Text>
            <Text style={StyleSheet.flatten([styles.gainSeconds, { color: deltaColor(theme, g.seconds) }])}>{s2(g.seconds)}</Text>
          </View>
          {g.action && <Text style={styles.gainAction}>{g.action}</Text>}
          {g.advice.filter((a) => a !== g.action).map((a) => (
            <Text key={a} style={styles.bullet}>• {a}</Text>
          ))}
          {g.main_phase && g.advice.length > 0 && <Text style={styles.note}>Most of it on {g.main_phase}.</Text>}
        </Pressable>
      ))}
      <Text style={styles.summary}>{report.summary}</Text>
    </View>
  );
}

function Tile({ label, value, detail }: { label: string; value: string; detail: string }) {
  const styles = useStyles();
  return (
    <View style={styles.tile}>
      <Text style={styles.label}>{label}</Text>
      <Text style={styles.tileValue}>{value}</Text>
      <Text style={styles.note}>{detail}</Text>
    </View>
  );
}

// ---------- corner by corner ----------

const HABIT_DIGITS: Record<string, number> = { 'km/h': 1, m: 0, s: 2, '%': 0 };
const fmtHabit = (v: number | null, unit: string) => {
  if (v == null) return '–';
  const digits = HABIT_DIGITS[unit] ?? (Math.abs(v) >= 20 ? 0 : 1);
  return `${v.toFixed(digits)}${unit === '%' ? '%' : unit ? ` ${unit}` : ''}`;
};

function DrivingCard({ section: s, report, wide, onMap }: {
  section: SectionReport; report: Report; wide: boolean; onMap: () => void;
}) {
  const styles = useStyles();
  const c = useChartColors();
  const [all, setAll] = useState(false);
  const t = s.times;
  // the measures behind the advice, then the most strongly linked others (the server sorts them that way)
  const telling = s.habits.filter((h, i) => h.used || (i < MAX_EVIDENCE && (h.link === 'strong' || h.link === 'clear')));
  const shown = all ? s.habits : telling;
  const hidden = s.habits.length - telling.length;
  const also = s.advice.filter((a) => a !== s.headline);
  const top = Math.max(...PHASES.map((p) => s.where[p] ?? 0), 0.001);
  const theme = useTheme();
  const tone = sectionTones(theme, report)[s.code];
  return (
    <View style={[styles.card, { borderColor: c.grid, borderLeftColor: tone ?? c.grid }]}>
      <View style={styles.cardHead}>
        <Pressable accessibilityRole="button" accessibilityLabel={`Show ${s.code} on the map`} onPress={onMap}>
          <Text style={styles.cardCode}>{s.code}</Text>
        </Pressable>
        <Text style={StyleSheet.flatten([styles.cardGain, s.gain_s >= 0.01 && { color: deltaColor(theme, s.gain_s) }])}>
          {s.gain_s >= 0.01 ? `${s2(s.gain_s)} to gain` : 'Nothing to gain'}
        </Text>
      </View>
      <Text style={styles.note}>
        {Math.round(s.start_m)}–{Math.round(s.end_m)} m{s.flat ? ' · flat out' : ''} · {s.quick_passes} quick passes
      </Text>
      {s.headline && <Text style={styles.cardHeadline}>{s.headline}</Text>}

      <View style={wide ? styles.row : styles.column}>
        <View style={wide ? styles.half : styles.block}>
          {also.length > 0 && (
            <View style={styles.block}>
              <Text style={styles.h4}>{s.advice.length > also.length ? 'Also' : 'What to change'}</Text>
              {also.map((a) => (
                <Text key={a} style={styles.bullet}>• {a}</Text>
              ))}
            </View>
          )}
          <View style={styles.block}>
            <Text style={styles.h4}>Where the time goes</Text>
            <Bars rows={PHASES.map((p) => ({ label: cap(p), value: s.where[p] ?? 0, color: phaseColor(theme, p) }))}
              max={top} />
            <Text style={styles.note}>{s.loss_line}</Text>
          </View>
          <View style={styles.block}>
            <Text style={styles.h4}>Section times</Text>
            <Text style={styles.times}>
              Fastest lap {t.fastest_lap.toFixed(2)} · best {t.best.toFixed(2)} ({lapName(t.best_lap)}) · typical{' '}
              {t.typical.toFixed(2)} · quick passes {t.quick.toFixed(2)} · realistic {t.realistic.toFixed(2)} ·
              theoretical {t.theoretical.toFixed(2)}
            </Text>
            <Text style={styles.note}>
              Fastest lap to the best pass {s2(s.ladder.driving)} (driving), best pass to realistic{' '}
              {s2(s.ladder.car)}, realistic to theoretical {s2(s.ladder.theoretical)}.
            </Text>
          </View>
        </View>
        <View style={wide ? styles.half : styles.block}>
          <Text style={styles.h4}>The evidence</Text>
          <SectionSpeed section={s} report={report} />
          {shown.map((h) => (
            <HabitRow key={h.key} habit={h} />
          ))}
          {hidden > 0 && (
            <Pressable accessibilityRole="button" onPress={() => setAll(!all)}>
              <Text style={styles.link}>{all ? 'Show the telling measures only' : `Show all ${s.habits.length} measures`}</Text>
            </Pressable>
          )}
        </View>
      </View>
    </View>
  );
}

function HabitRow({ habit: h }: { habit: Habit }) {
  const styles = useStyles();
  const link = h.link === 'strong' ? 'strong link' : h.link === 'clear' ? 'clear link' : h.link === 'weak' ? 'weak link'
    : null;
  return (
    <View style={styles.habit}>
      <Text style={StyleSheet.flatten([styles.habitLabel, h.used && styles.bold])}>{h.label}</Text>
      <Text style={styles.habitValues}>
        typical {fmtHabit(h.typical, h.unit)} · quick {fmtHabit(h.quick, h.unit)} · fastest lap{' '}
        {fmtHabit(h.fastest_lap, h.unit)}
        {h.theoretical != null ? ` · theoretical ${fmtHabit(h.theoretical, h.unit)}` : ''}
      </Text>
      {(link || h.worth_s != null) && (
        <Text style={styles.note}>
          {link ?? ''}
          {h.worth_s != null && h.worth_s >= 0.005 ? `${link ? ', ' : ''}worth ${s2(h.worth_s)}` : ''}
        </Text>
      )}
    </View>
  );
}

function SectionSpeed({ section: s, report }: { section: SectionReport; report: Report }) {
  const c = useChartColors();
  const step = report.trace.step_m;
  const i0 = Math.max(0, Math.floor(s.start_m / step));
  const i1 = Math.min(report.trace.typical.length - 1, Math.ceil(s.end_m / step));
  const x = useMemo(() => Array.from({ length: i1 - i0 + 1 }, (_, k) => (i0 + k) * step), [i0, i1, step]);
  const cut = (v: number[]) => v.slice(i0, i1 + 1);
  const series: LineSeries[] = [
    { key: 'theoretical', label: 'Theoretical', values: cut(report.trace.theoretical), color: c.s3 },
    { key: 'typical', label: 'Typical pass', values: cut(report.trace.typical), color: c.s2 },
    { key: 'quick', label: 'Quick passes', values: cut(report.trace.quick), color: c.s1 },
  ];
  const markers = report.corners.filter((k) => k.at_m >= s.start_m && k.at_m <= s.end_m)
    .map((k) => ({ at: k.at_m, label: k.code }));
  return (
    <LineChart
      x={x}
      series={series}
      legend={[...series].reverse().map((v) => ({ label: v.label, color: v.color }))}
      height={170}
      unit="metres from the line"
      formatX={(v) => `${Math.round(v)} m`}
      formatY={(v) => `${Math.round(v)}`}
      markers={markers}
      title="Speed through the section (km/h)"
      readout={(i) => [...series].reverse().map((v) => ({
        label: v.label, color: v.color, value: v.values[i] != null ? `${v.values[i]!.toFixed(1)} km/h` : '–',
      }))}
    />
  );
}

// ---------- trends and consistency ----------

function Trends({ report }: { report: Report }) {
  const styles = useStyles();
  const c = useChartColors();
  const tr = report.trends;
  const byRun = useMemo(() => {
    const m = new Map<string, LapRow[]>();
    for (const l of tr.laps) m.set(l.run, [...(m.get(l.run) ?? []), l]);
    return m;
  }, [tr.laps]);
  const longest = Math.max(...[...byRun.values()].map((ls) => ls.length), 0);
  const x = Array.from({ length: longest }, (_, i) => i + 1);
  const runs: LineSeries[] = [...byRun.entries()].map(([run, ls]) => ({
    key: run, label: run, muted: true, width: 1, color: c.muted,
    values: x.map((_, i) => ls.find((l) => l.index_in_run === i)?.time ?? null),
  }));
  const median = x.map((_, i) => {
    const vs = runs.map((r) => r.values[i]).filter((v): v is number => v != null).sort((a, b) => a - b);
    if (vs.length < Math.min(3, runs.length)) return null;
    return vs.length % 2 ? vs[(vs.length - 1) / 2] : (vs[vs.length / 2 - 1] + vs[vs.length / 2]) / 2;
  });
  const spreadTop = Math.max(...tr.spread.map((s) => s.spread_s), 0.001);
  return (
    <View style={styles.block}>
      <View style={styles.table}>
        <View style={styles.tr}>
          <Text style={[styles.th, styles.runCol]}>Session</Text>
          <Text style={styles.th}>Laps</Text>
          <Text style={styles.th}>Best</Text>
          <Text style={styles.th}>Median</Text>
          <Text style={styles.th}>Consistency</Text>
          <Text style={styles.th}>Score</Text>
        </View>
        {tr.runs.map((r) => (
          <View key={r.run} style={styles.tr}>
            <Text style={[styles.td, styles.runCol]} numberOfLines={1}>
              {r.run}
              {r.driver ? ` · ${r.driver}` : ''}
            </Text>
            <Text style={styles.td}>{r.clean_laps}</Text>
            <Text style={styles.td}>{formatLap(r.best)}</Text>
            <Text style={styles.td}>{formatLap(r.median)}</Text>
            <Text style={styles.td}>{r.consistency != null ? `${r.consistency.toFixed(1)}%` : '–'}</Text>
            <Text style={styles.td}>{r.extraction.toFixed(1)}%</Text>
          </View>
        ))}
      </View>
      <Text style={styles.note}>
        Consistency is 100% when every clean lap matches the session&apos;s best, 10 points off for each 1% the median
        lap is slower; score is the best lap&apos;s share of the theoretical pace.
        {tr.consistency != null ? ` Across all ${report.laps_analysed} laps: ${tr.consistency.toFixed(1)}%.` : ''}
      </Text>
      {longest >= 2 && (
        <LineChart
          x={x}
          series={[...runs, { key: 'median', label: 'Median', values: median, color: c.s1 }]}
          legend={[{ label: 'Each session', color: c.muted }, { label: 'Median of all sessions', color: c.s1 }]}
          height={200}
          unit="clean laps into the session"
          formatX={(v) => `lap ${v}`}
          formatY={lapTick}
          title="Lap times through a session"
          readout={(i) => {
            const vs = runs.map((r) => r.values[i]).filter((v): v is number => v != null);
            const rows = [];
            if (median[i] != null) rows.push({ label: 'median', value: formatLap(median[i]), color: c.s1 });
            if (vs.length) {
              rows.push({ label: 'quickest', value: formatLap(Math.min(...vs)), color: c.muted });
              rows.push({ label: 'slowest', value: formatLap(Math.max(...vs)), color: c.muted });
            }
            rows.push({ label: vs.length === 1 ? 'session' : 'sessions', value: String(vs.length), color: c.muted });
            return rows;
          }}
        />
      )}
      <Text style={styles.h4}>Where lap times vary most</Text>
      <Text style={styles.note}>
        The middle half of all passes of each section, quickest to slowest: the most to gain from doing the same thing
        every lap.
      </Text>
      <Bars rows={tr.spread.slice(0, 5).map((s) => ({ label: s.code, value: s.spread_s }))} max={spreadTop} />
    </View>
  );
}

// ---------- what goes with lap time ----------

function Relations({ relations, laps }: { relations: Relation[]; laps: number }) {
  const styles = useStyles();
  if (relations.length === 0) {
    return (
      <Text style={styles.note}>
        {laps < 8 ? `With ${laps} clean laps it is too early to say what goes with lap time.`
          : 'Nothing in the car\'s state goes clearly with lap time: the time is in the driving above.'}
      </Text>
    );
  }
  const warm = relations.filter((r) => !r.warm_up);
  const warming = relations.filter((r) => r.warm_up);
  return (
    <View style={styles.block}>
      <Text style={styles.note}>
        Every clean lap&apos;s time against the car&apos;s state (tyres, traction control, ABS, temperatures) and the
        driving measures, strongest first. These show what goes with a quicker lap, not what causes it.
      </Text>
      {warm.length === 0 && (
        <Text style={styles.relationText}>
          Once the car is warm, from the third lap of a run, nothing in its state goes clearly with lap time: the time
          left is in the driving above.
        </Text>
      )}
      {warm.map((r) => <RelationRow key={`${r.source}-${r.label}`} r={r} />)}
      {warming.length > 0 && (
        <>
          <Text style={styles.h4}>Only over each run&apos;s first laps, while the car warms up</Text>
          {warming.map((r) => <RelationRow key={`${r.source}-${r.label}`} r={r} />)}
        </>
      )}
    </View>
  );
}

function RelationRow({ r }: { r: Relation }) {
  const styles = useStyles();
  return (
    <View style={styles.relation}>
      <Text style={styles.relationText}>{r.text}</Text>
      <Text style={styles.note}>
        {s2(r.seconds)} over the range seen · {r.sure} (r {r.r.toFixed(2)}, {r.n} laps) · {r.compared}
      </Text>
    </View>
  );
}

const useStyles = themed((c) => ({
  outer: { paddingVertical: 16, alignItems: 'center' },
  page: { width: '100%', maxWidth: 1100, paddingHorizontal: 16, gap: 20 },
  pad: { padding: 16 },
  head: { gap: 4 },
  h1: { fontSize: 24, fontWeight: '700' },
  h2: { fontSize: 20, fontWeight: '700' },
  h3: { fontSize: 16, fontWeight: '700', marginTop: 8 },
  h4: { fontSize: 13, fontWeight: '600', opacity: 0.7, textTransform: 'uppercase', letterSpacing: 0.5 },
  sub: { opacity: 0.7 },
  note: { fontSize: 12, opacity: 0.65, lineHeight: 17 },
  error: { color: c.error },
  row: { flexDirection: 'row', gap: 24, alignItems: 'flex-start' },
  column: { gap: 16 },
  half: { flex: 1, minWidth: 0, gap: 12 },
  block: { gap: 8 },
  section: { gap: 12 },
  banner: { gap: 8, padding: 12, borderRadius: Radius.card, borderWidth: 1, borderColor: c.border, backgroundColor: c.surface },
  bannerText: { fontSize: 14 },
  progress: { gap: 8, padding: 12, borderRadius: Radius.card, borderWidth: 1, borderColor: c.border, backgroundColor: c.surface },
  meter: { height: 6, borderRadius: 3, overflow: 'hidden' },
  meterFill: { height: 6, borderRadius: 3 },
  smallButton: { alignSelf: 'flex-start', borderWidth: 1, borderColor: c.borderStrong, borderRadius: Radius.control, paddingHorizontal: 12,
    paddingVertical: 6 },
  smallButtonText: { fontWeight: '600' },
  glance: { gap: 10 },
  scoreRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 },
  label: { fontSize: 12, opacity: 0.65, textTransform: 'uppercase', letterSpacing: 0.5 },
  hero: { fontSize: 48, fontWeight: '600', lineHeight: 56 },
  medal: { borderWidth: 1, borderRadius: Radius.control, paddingHorizontal: 12, paddingVertical: 8, alignItems: 'flex-end', gap: 2 },
  medalText: { fontSize: 18, fontWeight: '700' },
  scores: { fontSize: 13, opacity: 0.8 },
  tiles: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  tile: { flexBasis: '46%', flexGrow: 1, gap: 2 },
  tileValue: { fontSize: 22, fontWeight: '600' },
  gain: { borderWidth: 1, borderLeftWidth: 4, borderRadius: Radius.card, padding: 12, gap: 4, backgroundColor: c.surface },
  gainHead: { flexDirection: 'row', alignItems: 'baseline', gap: 10, backgroundColor: 'transparent' },
  gainRank: { fontSize: 14, opacity: 0.6, fontWeight: '700' },
  gainCode: { fontSize: 18, fontWeight: '700', flex: 1 },
  gainSeconds: { fontSize: 18, fontWeight: '600' },
  gainAction: { fontSize: 15, fontWeight: '600' },
  bullet: { fontSize: 14, lineHeight: 20 },
  summary: { fontSize: 14, lineHeight: 20, opacity: 0.85 },
  card: { borderWidth: 1, borderLeftWidth: 4, borderRadius: Radius.card, padding: 14, gap: 10, backgroundColor: c.surface },
  cardHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 },
  cardCode: { fontSize: 22, fontWeight: '700', textDecorationLine: 'underline' },
  cardGain: { fontSize: 15, fontWeight: '600' },
  cardHeadline: { fontSize: 16, fontWeight: '600', lineHeight: 22 },
  times: { fontSize: 13, lineHeight: 19, fontVariant: ['tabular-nums'] },
  habit: { gap: 1, paddingVertical: 4 },
  habitLabel: { fontSize: 14 },
  habitValues: { fontSize: 13, opacity: 0.85, fontVariant: ['tabular-nums'] },
  bold: { fontWeight: '700' },
  link: { fontSize: 13, fontWeight: '600', textDecorationLine: 'underline', paddingVertical: 4 },
  table: { gap: 0 },
  tr: { flexDirection: 'row', paddingVertical: 5, borderBottomWidth: 1, borderColor: c.separator, gap: 6 },
  th: { flex: 1, fontSize: 11, opacity: 0.65, textTransform: 'uppercase', textAlign: 'right' },
  td: { flex: 1, fontSize: 13, textAlign: 'right', fontVariant: ['tabular-nums'] },
  runCol: { flex: 2, textAlign: 'left' },
  relation: { gap: 2, paddingVertical: 6, borderBottomWidth: 1, borderColor: c.separator },
  relationText: { fontSize: 15, lineHeight: 21 },
  sessionRow: { paddingVertical: 8, borderBottomWidth: 1, borderColor: c.separator, gap: 2 },
  sessionName: { fontSize: 15, fontWeight: '600' },
  sessionMeta: { fontSize: 13, opacity: 0.7 },
  dim: { opacity: 0.45 },
  method: { fontSize: 13, lineHeight: 19, opacity: 0.8 },
}));
