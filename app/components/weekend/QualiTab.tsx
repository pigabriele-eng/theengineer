// The weekend page's Quali analysis tab (Gabriele, 2026-10-15: "Quali analyisis: 1- tire preparation analysis and
// temp/pressure analysis"). The weekend's qualifying sessions (Q, Q1-Q3, PQ) are picked from its official sessions and
// each driver's run in them is read from the tyre prep report of the event (server/app/analysis/tyreprep.py, the one
// the Quali prep page shows). Sections `no` and `no + 1`. Tyre preparation: how each run's out-lap and build laps
// brought its fronts and rears up against the push temperature, lap by lap, and when they were ready to push; then the
// warm-ups side by side (components/report/TyrePrep.tsx). Temperatures and pressures: each tyre from cold to hot over
// every run, against its window on the weekend's fastest laps, with the cold pressure that lands it there. The TPMS is
// all the car logs of its tyres, and the tab says so. Long runs stay on the Quali prep page. Workings: lib/qualiTab.ts.
import { ReactNode, useEffect, useId, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, LayoutChangeEvent, Platform, StyleSheet, TextStyle, ViewStyle } from 'react-native';
import Svg, { ClipPath, Circle, Defs, G, Line, Path, Rect, Text as SvgText } from 'react-native-svg';

import { Tabs } from '@/components/Picks';
import { Cells, usePrepType } from '@/components/PrepParts';
import { Block, Label, Section, useWide } from '@/components/Programme';
import { BuildTable, Method, Paras, Recommendation } from '@/components/report/TyrePrep';
import { Text, View } from '@/components/Themed';
import { ResetZoom, useZoom, ZOOM_HINT, ZoomArea, ZoomGroup } from '@/components/Zoom';
import { face, Fonts, Palette, themed, useTheme } from '@/constants/Theme';
import { formatLap } from '@/lib/api';
import { codeOf } from '@/lib/driverTag';
import type { Folder } from '@/lib/events';
import {
  axisOf, axleSeries, isQualiCode, LapMark, lapMarks, minuteAt, NoRun, prepWords, Push, QualiRun, qualiRuns, where,
  WHERE_WORDS,
} from '@/lib/qualiTab';
import { fetchParts, Part } from '@/lib/sessionReports';
import { Advice, fetchTyrePrep, Sim, TyrePrep as Report, Wheel, WHEELS } from '@/lib/tyreprep';
import { isZoomed, pixelOf, Range, shownRange, valueAt } from '@/lib/zoom';

const SVG_FONT = Fonts.sans; // SVG text takes the browser's serif on the web otherwise
const LABEL_CHAR = 5.6; // about how wide a 12 px chart label's letter is, for the paper patch behind it
const DASHES = [undefined, '7 4', '2 3', '10 3 2 3']; // each run's line, so the runs differ by more than colour
// The one sentence on what can't be measured: the car's only tyre sensors are the TPMS (checked on the Zandvoort, Paul
// Ricard, Monza and Spa qualifying logs: pTyre bar and TTyre °C per wheel, no tyre surface channel).
const TPMS_ONLY = 'The car logs its tyres only through the TPMS sensor inside each wheel, so temperatures here are the '
  + 'air inside the tyre, which lags the tread: there is no tyre surface temperature in the logs.';
const LONG_RUNS = /^Long runs/; // the method's long-run line: long runs aren't in this tab

type Props = { no: number; eventId: number; folder: Folder | null };

/** The Quali analysis tab: tyre preparation, then temperatures and pressures, for each driver's qualifying run. */
export default function QualiTab({ no, eventId, folder }: Props) {
  const type = usePrepType();
  const styles = useStyles();
  const theme = useTheme();
  // read again when the event's runs change (an upload), not when the page's folder first arrives
  const runsKey = useMemo(() => (folder ? folder.days.flatMap((d) => d.sessions).map((s) => `${s.id}:${s.laps}`).join(',')
    : null), [folder]);
  const seenKey = useRef<string | null>(null);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    if (runsKey == null) return;
    if (seenKey.current != null && seenKey.current !== runsKey) setReload((n) => n + 1);
    seenKey.current = runsKey;
  }, [runsKey]);
  const [parts, setParts] = useState<Part[] | null>(null);
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState<string | null>(null);
  const shownEvent = useRef(eventId);
  useEffect(() => {
    let live = true;
    if (shownEvent.current !== eventId) { // another weekend: not the last one's runs meanwhile
      shownEvent.current = eventId;
      setParts(null);
      setReport(null);
    }
    setError(null);
    fetchParts(eventId)
      .then((a) => {
        const quali = a.parts.filter((p) => isQualiCode(p.code));
        if (!live) return null;
        setParts(quali);
        // the event's report: the push temperatures, windows and cold pressures are learned from all its running
        return quali.some((p) => p.runs.length) ? fetchTyrePrep({ event: eventId }) : null;
      })
      .then((r) => {
        if (live && r) setReport(r);
      })
      .catch((e) => live && setError((e as Error).message));
    return () => {
      live = false;
    };
  }, [eventId, reload]);

  const prepHead = { no, title: 'Tyre preparation',
    dek: 'How each driver’s out-lap and build laps brought the tyres up, and when they were ready to push.' };
  const hasRuns = !!parts?.some((p) => p.runs.length);
  if (error && !report) {
    return <Section {...prepHead}><Text style={type.error}>{error}</Text></Section>;
  }
  if (!parts || (hasRuns && !report)) {
    return (
      <Section {...prepHead}>
        <View style={styles.loading}>
          <ActivityIndicator color={theme.text} />
          <Text style={type.note}>Reading the qualifying logs… the first time can take a minute.</Text>
        </View>
      </Section>
    );
  }
  if (!hasRuns || !report) {
    return (
      <Section {...prepHead}>
        <Text style={type.note}>No qualifying session (Q, Q1, Q2, Q3 or PQ) in this weekend&apos;s runs yet.</Text>
      </Section>
    );
  }
  const advice: Record<string, Advice> = Object.fromEntries(report.advice.map((a) => [a.key, a]));
  if (!report.has_tpms) {
    return (
      <Section {...prepHead}>
        <Paras list={[advice.no_tpms]} />
      </Section>
    );
  }
  const { runs, none } = qualiRuns(parts, report.sims);
  return (
    <>
      <PrepSection head={prepHead} runs={runs} none={none} report={report} advice={advice} />
      <TyresSection no={no + 1} runs={runs} report={report} advice={advice} />
      <Method report={report} lines={report.method.filter((m) => !LONG_RUNS.test(m))} />
    </>
  );
}

// ---------------------------------------------------------------- a run's name, colour and line

function useRunLook() {
  const theme = useTheme();
  const series = theme.chart.series;
  return (r: QualiRun) => ({ color: series[r.slot % series.length], dash: DASHES[r.slot % DASHES.length] });
}

/** A short sample of a run's line: its colour and its dash. */
function LineSample({ color, dash, width = 26 }: { color: string; dash?: string; width?: number }) {
  return (
    <Svg width={width} height={10} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <Line x1={1} x2={width - 1} y1={5} y2={5} stroke={color} strokeWidth={3} strokeDasharray={dash} />
    </Svg>
  );
}

/** A key's coloured box and its words, in the key's own type (Swatch's capitals would stand apart from the lines'). */
function KeyBox({ color, label, width = 14, height = 12, outline }: { color: string; label: string; width?: number;
  height?: number; outline?: string }) {
  const styles = useStyles();
  return (
    <View style={styles.keyItem}>
      <View style={{ width, height, backgroundColor: color, borderWidth: outline ? 1 : 0, borderColor: outline }} />
      <Text style={styles.keyText}>{label}</Text>
    </View>
  );
}

const runName = (r: QualiRun) => {
  const code = codeOf(r.driver);
  return code ? `${r.sim.label} · ${code}` : r.sim.label;
};

function RunKey({ runs, children }: { runs: QualiRun[]; children?: ReactNode }) {
  const styles = useStyles();
  const look = useRunLook();
  return (
    <View style={styles.keyRow}>
      {runs.map((r) => {
        const { color, dash } = look(r);
        return (
          <View key={`${r.sim.session_id}-${r.sim.run}`} style={styles.keyItem}>
            <LineSample color={color} dash={dash} />
            <Text style={styles.keyText}>{runName(r)}</Text>
          </View>
        );
      })}
      {children}
    </View>
  );
}

// ---------------------------------------------------------------- 1. tyre preparation

function PrepSection({ head, runs, none, report, advice }: { head: { no: number; title: string; dek: string };
  runs: QualiRun[]; none: NoRun[]; report: Report; advice: Record<string, Advice> }) {
  const styles = useStyles();
  const type = usePrepType();
  const sims = runs.map((r) => r.sim);
  const shownFastest = report.fastest && sims.some((s) => s.label === report.fastest!.best.label)
    ? report.fastest.best.label : null;
  return (
    <Section {...head}>
      {advice.plan && <Recommendation text={advice.plan.text} />}
      {!runs.length && (
        <Text style={type.note}>
          No quali-style run in the qualifying logs: no warm-up followed by flying laps building to a best close to the
          session&apos;s best.
        </Text>
      )}
      {runs.length > 0 && (
        <Cells cols={Math.min(2, runs.length)} phoneCols={1}>
          {runs.map((r) => <RunPrep key={`${r.sim.session_id}-${r.sim.run}`} run={r} push={report.push} />)}
        </Cells>
      )}
      {none.length > 0 && (
        <Text style={StyleSheet.flatten([type.note, styles.gap])}>
          No quali-style run in {none.map((n) => n.name).join(', ')}: {none.length === 1 ? 'its log holds' : 'their logs hold'} no
          warm-up followed by flying laps (pit running, or the run is in another log).
        </Text>
      )}
      {runs.length > 0 && (
        <View style={styles.block}>
          <Label>The warm-ups side by side</Label>
          <View style={styles.gapSmall}>
            <BuildTable sims={sims} fastest={shownFastest} holdS={report.peak_hold_s} push={report.push} />
          </View>
        </View>
      )}
      {runs.length > 0 && <Text style={StyleSheet.flatten([type.note, styles.gap])}>{ZOOM_HINT}</Text>}
      <Paras list={[advice.push, advice.build, advice.brakes]} />
    </Section>
  );
}

function RunPrep({ run, push }: { run: QualiRun; push: Push | null }) {
  const styles = useStyles();
  const type = usePrepType();
  const wide = useWide();
  const look = useRunLook()(run);
  const code = codeOf(run.driver);
  return (
    <View style={styles.run}>
      <View style={styles.runHead}>
        <LineSample color={look.color} dash={look.dash} />
        <Text style={styles.runName}>{run.sim.label}</Text>
        <Text style={styles.runDriver}>{code ?? 'No driver set'}</Text>
      </View>
      <Text style={wide ? type.read : type.readPhone}>{prepWords(run.sim, push, formatLap).join(' ')}</Text>
      {run.sim.series && <WarmChart sim={run.sim} push={push} look={look} />}
    </View>
  );
}

// ---------------------------------------------------------------- the time charts: minutes from leaving the pits

type Plot = { x: (m: number) => number; y: (v: number) => number; w: number; h: number; view: Range; left: number;
  top: number };

const xStep = (span: number, px: number) => [0.5, 1, 2, 5, 10, 20].find((s) => (px / span) * s >= 44) ?? 30;

/** A chart against minutes from leaving the pits, zoomed along that axis: the frame, the axes, the pointer's minute
 * (`at`, shown by the readout above) and the plot drawn by `draw`. */
function TimeChart({ full, yAxis, yTitle, height, margin, readout, at, onAt, label, draw }: {
  full: Range;
  yAxis: { range: [number, number]; step: number };
  yTitle: string;
  height: number;
  margin: { left: number; right: number; top: number; bottom: number };
  readout: string;
  at: number | null;
  onAt: (m: number | null) => void;
  label: string; // what the chart shows, for a screen reader
  draw: (p: Plot) => ReactNode;
}) {
  const styles = useStyles();
  const ch = useTheme().chart;
  const zoom = useZoom();
  const clip = `q${useId().replace(/[^a-zA-Z0-9]/g, '')}`;
  const [width, setWidth] = useState(0);
  const view = shownRange(zoom.view, full, 0.5);
  const zoomed = isZoomed(view, full);
  const w = Math.max(width - margin.left - margin.right, 1);
  const h = height - margin.top - margin.bottom;
  const { range: yRange, step: yStep } = yAxis;
  const x = (m: number) => pixelOf(m, view, margin.left, w);
  const y = (v: number) => margin.top + (1 - (v - yRange[0]) / (yRange[1] - yRange[0])) * h;
  const yTicks = Array.from({ length: Math.round((yRange[1] - yRange[0]) / yStep) + 1 }, (_, i) => yRange[0] + i * yStep);
  const step = xStep(view[1] - view[0], w);
  const xTicks: number[] = [];
  for (let m = Math.ceil(view[0] / step) * step; m <= view[1] + 1e-9; m += step) xTicks.push(m);
  const digits = yStep < 1 ? 1 : 0;
  const pointAt = (px: number) => onAt(px < margin.left || px > margin.left + w ? null : valueAt(px, view, margin.left, w));
  return (
    <View style={styles.chart}>
      <View style={styles.chartHead}>
        <Text style={styles.readout} numberOfLines={2}>{readout}</Text>
        <ResetZoom zoom={zoom} reserve />
      </View>
      <ZoomArea zoom={zoom} full={full} left={margin.left} width={w} minSpan={0.5} onCursor={(px) => pointAt(px)}
        onLeave={() => onAt(null)} onLayout={(e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width)}>
        {width > 0 && (
          <Svg width={width} height={height} pointerEvents="none" accessibilityLabel={label}>
            <Defs>
              <ClipPath id={clip}>
                <Rect x={margin.left} y={0} width={w} height={height} />
              </ClipPath>
            </Defs>
            {yTicks.map((v) => (
              <Line key={`g${v}`} x1={margin.left} x2={margin.left + w} y1={y(v)} y2={y(v)} stroke={ch.grid} strokeWidth={1} />
            ))}
            {yTicks.map((v) => (
              <SvgText fontFamily={SVG_FONT} key={`t${v}`} x={margin.left - 6} y={y(v) + 4} fontSize={12} fill={ch.muted}
                textAnchor="end">
                {v.toFixed(digits)}
              </SvgText>
            ))}
            <Line x1={margin.left} x2={margin.left + w} y1={margin.top + h} y2={margin.top + h} stroke={ch.axis}
              strokeWidth={1.5} />
            {xTicks.map((m) => (
              <SvgText fontFamily={SVG_FONT} key={`x${m}`} x={x(m)} y={margin.top + h + 15} fontSize={12} fill={ch.muted}
                textAnchor="middle">
                {Number.isInteger(m) ? String(m) : m.toFixed(1)}
              </SvgText>
            ))}
            <SvgText fontFamily={SVG_FONT} x={margin.left + w / 2} y={height - 3} fontSize={12} fill={ch.muted}
              textAnchor="middle">
              MINUTES FROM LEAVING THE PITS
            </SvgText>
            <SvgText fontFamily={SVG_FONT} x={11} y={margin.top + h / 2} fontSize={12} fill={ch.muted} textAnchor="middle"
              transform={`rotate(-90 11 ${margin.top + h / 2})`}>
              {yTitle}
            </SvgText>
            <G clipPath={zoomed ? `url(#${clip})` : undefined}>
              {draw({ x, y, w, h, view, left: margin.left, top: margin.top })}
              {at != null && <Line x1={x(at)} x2={x(at)} y1={margin.top} y2={margin.top + h} stroke={ch.ink} strokeOpacity={0.35} />}
            </G>
          </Svg>
        )}
      </ZoomArea>
    </View>
  );
}

/** The SVG path of a series against minutes, lifting the pen where it has no reading. */
function pathOf(values: (number | null)[], minute: (i: number) => number, p: Plot) {
  let d = '';
  let down = false;
  values.forEach((v, i) => {
    if (v == null) {
      down = false;
      return;
    }
    d += `${down ? 'L' : 'M'}${p.x(minute(i)).toFixed(1)},${p.y(v).toFixed(1)}`;
    down = true;
  });
  return d;
}

const lapWords = (m: LapMark) => (m.kind === 'flying' ? `lap ${m.n}, ${formatLap(m.time)}${m.best ? ', the best' : ''}`
  : m.kind === 'warm-up' ? `lap ${m.n}, a warm-up lap` : m.kind === 'in' ? 'the in-lap' : `lap ${m.n}, a slow lap`);
const lapAt = (marks: LapMark[], m: number) => {
  const k = marks.find((x) => m >= x.start && m < x.end);
  return k ? lapWords(k) : marks.length && m < marks[0].start ? 'the out-lap' : null;
};
const indexAt = (step_s: number, n: number, m: number) => Math.max(0, Math.min(n - 1, Math.floor((m * 60) / step_s)));
const deg = (v: number | null | undefined) => (v == null ? '–' : `${Math.round(v)} °C`);

/** One run's fronts and rears (TPMS, axle averages) from leaving the pits, against the push temperatures: its laps
 * marked along the top (the best one shaded), and the moment both axles reached push temperature. */
function WarmChart({ sim, push, look }: { sim: Sim; push: Push | null; look: { color: string; dash?: string } }) {
  const theme = useTheme();
  const ch = theme.chart;
  const [at, setAt] = useState<number | null>(null);
  const series = sim.series!;
  const front = axleSeries(series, 't', 'front');
  const rear = axleSeries(series, 't', 'rear');
  const n = Math.max(front.length, rear.length);
  if (!n) return null;
  const marks = lapMarks(sim);
  const full: Range = [0, Math.max((n * series.step_s) / 60, 1)];
  const yAxis = axisOf([...front, ...rear, push?.front_c, push?.rear_c], [10, 20]) ?? { range: [0, 100], step: 20 };
  const minute = (i: number) => minuteAt(series, i);
  const i = at == null ? null : indexAt(series.step_s, n, at);
  const where = at == null ? null : lapAt(marks, at);
  const readout = at == null || i == null
    ? Platform.OS === 'web' ? 'Point at the chart for the tyres at that moment.' : 'Touch the chart for the tyres at that moment.'
    : `${at.toFixed(1)} min${where ? `, ${where}` : ''}: fronts ${deg(front[i])}, rears ${deg(rear[i])}`;
  const last = (v: (number | null)[]) => [...v].reverse().find((x) => x != null) ?? null;
  const ends = { front: last(front), rear: last(rear) };
  const label = `${sim.label}: fronts ${deg(front.find((x) => x != null))} to ${deg(ends.front)}, rears `
    + `${deg(rear.find((x) => x != null))} to ${deg(ends.rear)}`
    + (push ? `, against push temperatures of ${push.front_c} °C and ${push.rear_c} °C` : '')
    + `; best lap ${formatLap(sim.peak_time)}.`;
  return (
    <View>
      <TimeChart full={full} yAxis={yAxis} yTitle="°C, TPMS" height={240}
        margin={{ left: 40, right: 10, top: 30, bottom: 34 }} readout={readout} at={at} onAt={setAt} label={label}
        draw={(p) => {
          const top = p.top;
          const bottom = p.top + p.h;
          const lapLabel = (m: LapMark) => {
            const a = Math.max(p.x(m.start), p.left);
            const b = Math.min(p.x(m.end), p.left + p.w);
            const room = b - a - 4;
            const time = formatLap(m.time);
            const words = m.kind === 'flying' ? (m.best ? [`Best ${time}`, time, 'Best'] : [time])
              : m.kind === 'warm-up' ? ['Warm-up'] : m.kind === 'in' ? ['In-lap', 'In'] : ['Slow'];
            const text = words.find((t) => t.length * LABEL_CHAR <= room);
            return text && b > a ? (
              <SvgText key={`l${m.n}`} fontFamily={SVG_FONT} x={(a + b) / 2} y={top - 9} fontSize={12} textAnchor="middle"
                fill={m.best ? ch.ink : ch.ink2} fontWeight={m.best ? '700' : '400'}>
                {text}
              </SvgText>
            ) : null;
          };
          const outEnd = marks.length ? p.x(marks[0].start) - p.x(0) : 0;
          return (
            <>
              {marks.filter((m) => m.best).map((m) => (
                <Rect key="best" x={p.x(m.start)} y={top} width={Math.max(p.x(m.end) - p.x(m.start), 1)} height={p.h}
                  fill={ch.ink} fillOpacity={0.07} />
              ))}
              {marks.map((m) => (
                <Line key={`m${m.n}`} x1={p.x(m.start)} x2={p.x(m.start)} y1={top - 4} y2={bottom} stroke={ch.muted}
                  strokeOpacity={0.5} strokeWidth={1} />
              ))}
              {marks.map(lapLabel)}
              {outEnd > 50 && (
                <SvgText fontFamily={SVG_FONT} x={p.x(0) + outEnd / 2} y={top - 9} fontSize={12} textAnchor="middle"
                  fill={ch.ink2}>
                  Out-lap
                </SvgText>
              )}
              {push && (
                <>
                  <Line x1={p.left} x2={p.left + p.w} y1={p.y(push.front_c)} y2={p.y(push.front_c)} stroke={ch.ink2}
                    strokeWidth={1.2} />
                  <Line x1={p.left} x2={p.left + p.w} y1={p.y(push.rear_c)} y2={p.y(push.rear_c)} stroke={ch.ink2}
                    strokeWidth={1.2} strokeDasharray="5 4" />
                </>
              )}
              {push && sim.ready_min != null && (
                <Line x1={p.x(sim.ready_min)} x2={p.x(sim.ready_min)} y1={top} y2={bottom} stroke={theme.tyre.ok}
                  strokeWidth={2.5} />
              )}
              <Path d={pathOf(front, minute, p)} stroke={look.color} strokeWidth={2.5} fill="none" strokeLinejoin="round" />
              <Path d={pathOf(rear, minute, p)} stroke={look.color} strokeWidth={2} fill="none" strokeDasharray="6 4"
                strokeLinejoin="round" />
              {i != null && front[i] != null && <Circle cx={p.x(minute(i))} cy={p.y(front[i]!)} r={4} fill={look.color} />}
              {i != null && rear[i] != null && <Circle cx={p.x(minute(i))} cy={p.y(rear[i]!)} r={4} fill={look.color} />}
              {/* the words on top of the lines, each on a patch of paper */}
              {push && ([['fronts', push.front_c], ['rears', push.rear_c]] as const).map(([axle, c]) => {
                const text = `Push, ${axle} ${c} °C`;
                return (
                  <G key={axle}>
                    <Rect x={p.left + 2} y={p.y(c) - 17} width={text.length * LABEL_CHAR + 6} height={14} fill={ch.surface} />
                    <SvgText fontFamily={SVG_FONT} x={p.left + 5} y={p.y(c) - 6} fontSize={12} fill={ch.ink2}>
                      {text}
                    </SvgText>
                  </G>
                );
              })}
              {push && sim.ready_min != null && (
                <G>
                  <Rect x={p.x(sim.ready_min) + 2} y={bottom - 18} width={5 * LABEL_CHAR + 8} height={14} fill={ch.surface} />
                  <SvgText fontFamily={SVG_FONT} x={p.x(sim.ready_min) + 5} y={bottom - 7} fontSize={12} fill={ch.ink}
                    fontWeight="700">
                    Ready
                  </SvgText>
                </G>
              )}
            </>
          );
        }} />
      <WarmKey look={look} push={!!push} ready={!!push && sim.ready_min != null} />
    </View>
  );
}

/** The key under a run's warm-up chart: its two lines, the push temperatures and the ready moment, in words. */
function WarmKey({ look, push, ready }: { look: { color: string }; push: boolean; ready: boolean }) {
  const styles = useStyles();
  const theme = useTheme();
  return (
    <View style={styles.keyRow}>
      <View style={styles.keyItem}><LineSample color={look.color} /><Text style={styles.keyText}>Fronts</Text></View>
      <View style={styles.keyItem}><LineSample color={look.color} dash="6 4" /><Text style={styles.keyText}>Rears</Text></View>
      {push && (
        <View style={styles.keyItem}>
          <LineSample color={theme.chart.ink2} />
          <Text style={styles.keyText}>Push temperature (rears dashed)</Text>
        </View>
      )}
      {ready && <KeyBox color={theme.tyre.ok} width={4} height={14} label="Ready to push" />}
      <KeyBox color={theme.band} outline={theme.border} label="Best lap (shaded)" />
    </View>
  );
}

// ---------------------------------------------------------------- 2. temperatures and pressures

type Kind = 'p' | 't';
const KINDS: { key: Kind; label: string }[] = [{ key: 'p', label: 'Pressure' }, { key: 't', label: 'Temperature' }];
const unitOf = (k: Kind) => (k === 'p' ? 'bar' : '°C');
const fmt = (k: Kind, v: number | null | undefined) => (v == null ? '–' : k === 'p' ? v.toFixed(2) : String(Math.round(v)));
const range = (k: Kind, w: number[] | undefined) => {
  if (!w) return '–';
  const [a, b] = [fmt(k, w[0]), fmt(k, w[2])];
  return a === b ? `${a} ${unitOf(k)}` : `${a}–${b} ${unitOf(k)}`;
};

function TyresSection({ no, runs, report, advice }: { no: number; runs: QualiRun[]; report: Report;
  advice: Record<string, Advice> }) {
  const styles = useStyles();
  const type = usePrepType();
  const theme = useTheme();
  const [kind, setKind] = useState<Kind>('p');
  const withSeries = runs.filter((r) => r.sim.series);
  return (
    <Section no={no} title="Temperatures and pressures"
      dek="Each tyre from cold to hot over the run, against its window on the weekend’s fastest laps, with the cold pressure that lands it there.">
      <Text style={StyleSheet.flatten([type.note, styles.tpms])}>{TPMS_ONLY}</Text>
      <Paras list={[advice.window]} />
      {withSeries.length > 0 && (
        <>
          <Tabs items={KINDS} value={kind} onChange={setKind} label="Show" style={styles.gap} />
          <RunKey runs={withSeries}>
            <KeyBox color={theme.tyre.ok} label="Window on the fastest laps (dashed: its middle)" />
          </RunKey>
        </>
      )}
      <ZoomGroup reset={kind}>
        <View style={styles.car}>
          <Label muted style={styles.axle}>Front</Label>
          <Cells cols={2} phoneCols={1}>
            {WHEELS.map((w) => <TyreCell key={w} wheel={w} kind={kind} runs={runs} report={report} />)}
          </Cells>
          <Label muted style={styles.axleRear}>Rear</Label>
        </View>
      </ZoomGroup>
      <Paras list={[advice.cold]} />
    </Section>
  );
}

/** One tyre: its window on the fastest laps and the cold pressure that lands it there, each run from cold to hot
 * against the window, and where each run's best lap had it. */
function TyreCell({ wheel, kind, runs, report }: { wheel: Wheel; kind: Kind; runs: QualiRun[]; report: Report }) {
  const styles = useStyles();
  const theme = useTheme();
  const look = useRunLook();
  const win = report.windows?.tyres[wheel];
  const cold = report.cold?.tyres.find((c) => c.tyre === wheel);
  return (
    <View style={styles.tyre}>
      <View style={styles.tyreHead}>
        <Block label={wheel} color={theme.rule} ink={theme.background} size={13} />
        <Text style={styles.coldSet}>
          {cold?.cold_bar != null ? <>Set <Text style={styles.coldValue}>{cold.cold_bar.toFixed(2)}</Text> bar cold</>
            : 'Cold pressure not learned yet'}
        </Text>
      </View>
      <Text style={styles.windowLine}>
        Window <Text style={styles.windowValue}>{range('p', win?.p)}</Text>, <Text style={styles.windowValue}>
          {range('t', win?.t)}</Text>
      </Text>
      <TyreChart wheel={wheel} kind={kind} runs={runs} window={kind === 'p' ? win?.p : win?.t}
        cold={kind === 'p' ? cold?.cold_bar ?? null : null} />
      <View style={styles.bestLaps}>
        {runs.map((r) => {
          const { color, dash } = look(r);
          const p = r.sim.peak_tyres?.p[wheel];
          const t = r.sim.peak_tyres?.t[wheel];
          const wp = where(p, win?.p);
          const wt = where(t, win?.t);
          return (
            <View key={`${r.sim.session_id}-${r.sim.run}`} style={styles.bestLap}>
              <LineSample color={color} dash={dash} width={18} />
              <Text style={styles.bestText}>
                <Text style={styles.bestName}>{runName(r)}</Text>, best lap {fmt('p', p)} bar
                {wp ? ` (${WHERE_WORDS[wp]})` : ''}, {fmt('t', t)} °C{wt ? ` (${WHERE_WORDS[wt]})` : ''}
              </Text>
            </View>
          );
        })}
      </View>
    </View>
  );
}

function TyreChart({ wheel, kind, runs, window, cold }: { wheel: Wheel; kind: Kind; runs: QualiRun[];
  window: number[] | undefined; cold: number | null }) {
  const styles = useStyles();
  const theme = useTheme();
  const ch = theme.chart;
  const look = useRunLook();
  const [at, setAt] = useState<number | null>(null);
  const lines = runs.filter((r) => r.sim.series?.[kind][wheel]?.some((v) => v != null));
  if (!lines.length) {
    return <Text style={styles.noSensor}>No {kind === 'p' ? 'pressure' : 'temperature'} reading from this tyre&apos;s sensor.</Text>;
  }
  const values = (r: QualiRun) => r.sim.series![kind][wheel]!;
  const longest = Math.max(...lines.map((r) => (values(r).length * r.sim.series!.step_s) / 60));
  const full: Range = [0, Math.max(longest, 1)];
  const yAxis = axisOf([...lines.flatMap(values), ...(window ?? []), cold], kind === 'p' ? [0.1, 0.2, 0.5] : [10, 20])
    ?? { range: [0, 1], step: 1 };
  const unit = unitOf(kind);
  const readout = at == null
    ? Platform.OS === 'web' ? 'Point at the chart for each run’s reading.' : 'Touch the chart for each run’s reading.'
    : `${wheel} at ${at.toFixed(1)} min: ` + lines.map((r) => {
      const v = values(r);
      const i = Math.floor((at * 60) / r.sim.series!.step_s);
      return `${runName(r)} ${i < v.length ? `${fmt(kind, v[i])} ${unit}` : 'in the pits'}`;
    }).join(' · ');
  const label = `${wheel} ${kind === 'p' ? 'pressure' : 'temperature'} over each run: ` + lines.map((r) => {
    const v = values(r).filter((x): x is number => x != null);
    return `${runName(r)} from ${fmt(kind, v[0])} to ${fmt(kind, v[v.length - 1])} ${unit}`;
  }).join('; ') + (window ? `; window ${fmt(kind, window[0])} to ${fmt(kind, window[2])} ${unit}.` : '.');
  return (
    <TimeChart full={full} yAxis={yAxis} yTitle={kind === 'p' ? 'bar' : '°C'} height={190}
      margin={{ left: 40, right: 10, top: 12, bottom: 34 }} readout={readout} at={at} onAt={setAt} label={label}
      draw={(p) => (
        <>
          {window && (
            <>
              <Rect x={p.left} y={p.y(window[2])} width={p.w} height={Math.max(p.y(window[0]) - p.y(window[2]), 1)}
                fill={theme.tyre.ok} fillOpacity={0.16} />
              <Line x1={p.left} x2={p.left + p.w} y1={p.y(window[1])} y2={p.y(window[1])} stroke={theme.tyre.ok}
                strokeWidth={1.2} strokeDasharray="4 3" />
            </>
          )}
          {cold != null && (
            <Line x1={p.x(0)} x2={p.x(0) + Math.min(70, p.w / 3)} y1={p.y(cold)} y2={p.y(cold)} stroke={ch.ink}
              strokeWidth={2} />
          )}
          {lines.map((r) => {
            const { color, dash } = look(r);
            const s = r.sim.series!;
            const best = lapMarks(r.sim).find((m) => m.best);
            const v = r.sim.peak_tyres?.[kind][wheel];
            return (
              <G key={`${r.sim.session_id}-${r.sim.run}`}>
                <Path d={pathOf(values(r), (i) => minuteAt(s, i), p)} stroke={color} strokeWidth={2.2} fill="none"
                  strokeDasharray={dash} strokeLinejoin="round" />
                {best && v != null && (
                  <Circle cx={p.x((best.start + best.end) / 2)} cy={p.y(v)} r={4.5} fill={color} stroke={ch.ink}
                    strokeWidth={1.5} />
                )}
              </G>
            );
          })}
          {cold != null && (
            <G>
              <Rect x={p.x(0) + 1} y={p.y(cold) - 17} width={13 * LABEL_CHAR + 6} height={14} fill={ch.surface} />
              <SvgText fontFamily={SVG_FONT} x={p.x(0) + 4} y={p.y(cold) - 6} fontSize={12} fill={ch.ink}>
                {`Set cold ${cold.toFixed(2)}`}
              </SvgText>
            </G>
          )}
        </>
      )} />
  );
}

const useStyles = themed((c: Palette) => ({
  loading: { flexDirection: 'row', gap: 10, alignItems: 'center' } as ViewStyle,
  gap: { marginTop: 18 } as ViewStyle,
  gapSmall: { marginTop: 10 } as ViewStyle,
  block: { marginTop: 28 } as ViewStyle,
  tpms: { maxWidth: 820 } as TextStyle,

  run: { gap: 10 } as ViewStyle,
  runHead: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 10 } as ViewStyle,
  runName: { fontFamily: face('label', 700), fontSize: 18, letterSpacing: 0.3, color: c.text } as TextStyle,
  runDriver: { fontFamily: face('label', 600), fontSize: 14, letterSpacing: 0.8, color: c.textSecondary } as TextStyle,

  keyRow: { flexDirection: 'row', flexWrap: 'wrap', columnGap: 22, rowGap: 8, alignItems: 'center', marginTop: 14 } as ViewStyle,
  keyItem: { flexDirection: 'row', alignItems: 'center', gap: 8 } as ViewStyle,
  keyText: { fontFamily: face('label', 600), fontSize: 14, color: c.text } as TextStyle,

  chart: { marginTop: 8 } as ViewStyle,
  chartHead: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 } as ViewStyle,
  readout: { flex: 1, fontFamily: face('label', 500), fontSize: 13, lineHeight: 18, minHeight: 36,
    fontVariant: ['tabular-nums'], color: c.textSecondary } as TextStyle,

  car: { marginTop: 18 } as ViewStyle,
  axle: { textAlign: 'center', marginBottom: 6 } as TextStyle,
  axleRear: { textAlign: 'center', marginTop: 6, paddingTop: 6, borderTopWidth: 1, borderColor: c.rule } as TextStyle,
  tyre: { gap: 6 } as ViewStyle,
  tyreHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 6 } as ViewStyle,
  coldSet: { fontFamily: face('label', 600), fontSize: 14, letterSpacing: 0.4, color: c.textSecondary } as TextStyle,
  coldValue: { fontFamily: face('label', 700), fontSize: 17, color: c.text } as TextStyle,
  windowLine: { fontFamily: face('label', 500), fontSize: 14, color: c.textSecondary } as TextStyle,
  windowValue: { fontFamily: face('label', 700), fontVariant: ['tabular-nums'], color: c.text } as TextStyle,
  noSensor: { fontFamily: face('body', 400, true), fontSize: 15, lineHeight: 21, color: c.textSecondary,
    marginVertical: 12 } as TextStyle,
  bestLaps: { gap: 4 } as ViewStyle,
  bestLap: { flexDirection: 'row', alignItems: 'center', gap: 8 } as ViewStyle,
  bestText: { flex: 1, fontFamily: face('label', 500), fontSize: 14, lineHeight: 19, fontVariant: ['tabular-nums'],
    color: c.text } as TextStyle,
  bestName: { fontFamily: face('label', 700) } as TextStyle,
}));
