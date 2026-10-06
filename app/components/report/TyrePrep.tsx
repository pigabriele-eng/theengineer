import { Link } from 'expo-router';
import { ReactNode, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  GestureResponderEvent,
  LayoutChangeEvent,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
} from 'react-native';
import Svg, { Circle, Line, Rect, Text as SvgText } from 'react-native-svg';

// Plain views: the section sits on the report's own background, and the comparison's highlighted column shows through.
import { Text, useThemeColor } from '@/components/Themed';
import { useSeriesColors } from '@/components/TraceChart';
import { formatLap } from '@/lib/api';
import { Advice, fetchTyrePrep, fixed, signed, Sim, SimPoint, TyrePrep as Report, WHEELS } from '@/lib/tyreprep';
import { chartPlate, Fonts, Palette, Radius, themed, useTheme } from '@/constants/Theme';

const PEAK_LAPS = 6; // flying laps shown lap by lap in the comparison
// SVG text takes the browser's default (serif) face on web: give it the system sans the rest of the app uses
const SVG_FONT = Fonts.sans;

/** The tyre and qualifying preparation section of the report, for one session or a whole event: the recommended
 * warm-up first, then the warm-ups side by side, when the tyres were ready to push, each tyre's window on the
 * fastest laps with the cold pressures that land in it, and the long runs. */
export function TyrePrep({ session, event, heading = true }: { session?: number; event?: number; heading?: boolean }) {
  const styles = useStyles();
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (session == null && event == null) return;
    let live = true;
    setBusy(true);
    setError(null);
    fetchTyrePrep({ session, event })
      .then((r) => live && setReport(r))
      .catch((e) => live && setError((e as Error).message))
      .finally(() => live && setBusy(false));
    return () => {
      live = false;
    };
  }, [session, event]);

  return (
    <View style={styles.wrap}>
      {heading && <Text style={styles.h2}>Tyres and qualifying preparation</Text>}
      {busy && (
        <View style={styles.loading}>
          <ActivityIndicator />
          <Text style={styles.dim}>Reading the logs{event != null ? ' of every session' : ''}…</Text>
        </View>
      )}
      {error && <Text style={styles.error}>{error}</Text>}
      {report && !busy && <Body report={report} />}
    </View>
  );
}

export default TyrePrep;

function Body({ report }: { report: Report }) {
  const advice: Record<string, Advice> = Object.fromEntries(report.advice.map((a) => [a.key, a]));
  const sims = report.sims;
  return (
    <>
      {advice.plan && <Recommendation text={advice.plan.text} />}
      {advice.no_tpms && <Para a={advice.no_tpms} />}
      {advice.no_sims && <Para a={advice.no_sims} />}
      <Tiles report={report} />

      {sims.length > 0 && (
        <Section title="Warm-up and build laps">
          <BuildTable sims={sims} fastest={report.fastest?.best.label ?? null} holdS={report.peak_hold_s}
            push={report.push} />
          {advice.build && <Para a={advice.build} />}
          {advice.brakes && <Para a={advice.brakes} />}
        </Section>
      )}

      {sims.length > 0 && report.push && (
        <Section title="When the tyres are ready">
          {advice.push && <Para a={advice.push} />}
          <ReadyChart sims={sims} push={report.push} />
          {advice.ready && <Para a={advice.ready} />}
          {advice.pressure && <Para a={advice.pressure} />}
        </Section>
      )}

      {report.windows && (
        <Section title="Tyre windows on the fastest laps">
          {advice.window && <Para a={advice.window} />}
          <WindowGrid report={report} />
          {advice.cold && <Para a={advice.cold} />}
          <NavLink href="/tools/pressures" label="Open the pressure calculator" />
        </Section>
      )}

      {report.long_runs.length > 0 && (
        <Section title="Long runs">
          {advice.fade && <Para a={advice.fade} />}
          <LongRuns report={report} />
        </Section>
      )}

      <Method report={report} />
    </>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  const styles = useStyles();
  return (
    <View style={styles.section}>
      <Text style={styles.h3}>{title}</Text>
      {children}
    </View>
  );
}

function Recommendation({ text }: { text: string }) {
  const styles = useStyles();
  const tint = useSeriesColors().reference;
  return (
    <View style={StyleSheet.flatten([styles.callout, { borderLeftColor: tint }])}>
      <Text style={styles.calloutTitle}>Recommendation</Text>
      <Text style={styles.calloutText}>{text}</Text>
    </View>
  );
}

function Para({ a }: { a: Advice }) {
  const styles = useStyles();
  return (
    <Text style={styles.para}>
      <Text style={styles.paraTitle}>{a.title}. </Text>
      {a.text}
    </Text>
  );
}

function NavLink({ href, label }: { href: '/tools/pressures' | { pathname: '/tools/stint'; params: { session: string } };
  label: string }) {
  const styles = useStyles();
  const tint = useThemeColor({}, 'tint');
  // Link hands its style to a web anchor, which can't take a style array: one object
  return (
    <Link href={href} style={StyleSheet.flatten([styles.link, { color: tint }])}>
      {label} ›
    </Link>
  );
}

// ---------------------------------------------------------------- headline numbers

function Tiles({ report }: { report: Report }) {
  const styles = useStyles();
  const { push, ready, brake_work: brakes, pressure } = report;
  const tiles: { label: string; value: string; sub: string }[] = [];
  if (push) tiles.push({ label: 'Push at', value: `${push.front_c} / ${push.rear_c} °C`, sub: 'fronts / rears, TPMS at the line' });
  if (ready) {
    tiles.push({ label: 'Ready from cold', value: `${span(ready.min, ready.max, 1)} min`,
      sub: `median ${ready.median.toFixed(1)}, ${plural(ready.runs, 'cold start')}` });
    if (ready.peak_from_exit) {
      tiles.push({ label: 'Best lap', value: `${span(ready.peak_from_exit[0], ready.peak_from_exit[1])} laps`,
        sub: 'after leaving the pits' });
    }
  }
  if (brakes && brakes.saved_min > 0) {
    tiles.push({ label: 'Brake warming', value: `${brakes.saved_min.toFixed(1)} min sooner`,
      sub: 'most against least dragging' });
  }
  if (pressure) {
    tiles.push({ label: 'Hot pressure', value: `${span(pressure.pf[0], pressure.pf[1], 2)} bar`,
      sub: pressure.wide ? 'fronts, no pace difference' : 'fronts on the near-best laps' });
  }
  if (!tiles.length) return null;
  return (
    <View style={styles.tiles}>
      {tiles.map((t) => (
        <View key={t.label} style={styles.tile}>
          <Text style={styles.tileLabel}>{t.label}</Text>
          <Text style={styles.tileValue}>{t.value}</Text>
          <Text style={styles.tileSub}>{t.sub}</Text>
        </View>
      ))}
    </View>
  );
}

// ---------------------------------------------------------------- the warm-ups side by side

const LABEL_W = 128;
const RUN_W = 136;

type Push = Report['push'];
type Row = { label: string; lines?: 2; cell: (s: Sim, theme: Palette, push: Push) => ReactNode };

/** A tyre temperature's colour: below push temperature cold, at or above it ready; none without a push temperature. */
const tempTone = (theme: Palette, push: Push, axle: 'front' | 'rear', v: number | null | undefined) =>
  push && v != null ? (v < push[`${axle}_c`] ? theme.tyre.cold : theme.tyre.ok) : undefined;

function atLine(s: Sim, axle: 'front' | 'rear', theme: Palette, push: Push) {
  const pts = s.points.slice(0, Math.max(PEAK_LAPS, s.peak_flying));
  return (
    <Text style={cells.cellText} numberOfLines={1}>
      {pts.map((p, i) => (
        <Text key={p.lap} style={StyleSheet.flatten([p.peak && cells.peakValue,
          { color: tempTone(theme, push, axle, p[axle]) }])}>
          {i ? ' ' : ''}
          {fixed(p[axle])}
        </Text>
      ))}
    </Text>
  );
}

const ROWS: Row[] = [
  { label: 'Start', lines: 2, cell: (s) => (
    <>
      <Text style={cells.cellText}>{s.cold_start ? 'Cold tyres' : 'Pre-warmed'}</Text>
      <Text style={cells.cellSub}>{s.kind === 'quali' ? 'quali sim' : 'then a long run'}</Text>
    </>
  ) },
  { label: 'Warm-up', cell: (s) => (
    <Text style={cells.cellText}>{s.warm_laps != null ? plural(s.warm_laps, 'lap') : '–'}, {s.warm_min.toFixed(1)} min</Text>
  ) },
  { label: 'Brake dragging', cell: (s) => <Text style={cells.cellText}>{fixed(s.drag_s)} s</Text> },
  { label: 'Hard stops on the straights', lines: 2, cell: (s) => <Text style={cells.cellText}>{fixed(s.straight_hard_stops)}</Text> },
  { label: 'Weaving swings', cell: (s) => <Text style={cells.cellText}>{fixed(s.weaves)}</Text> },
  { label: 'Each warm-up lap, fronts', lines: 2, cell: (s) => (
    <>
      <Text style={cells.cellText}>{signed(s.warm_gain_per_lap.front_c)} °C</Text>
      <Text style={cells.cellSub}>{signed(s.warm_gain_per_lap.front_bar, 2)} bar</Text>
    </>
  ) },
  { label: 'Fronts at the line, °C', lines: 2, cell: (s, theme, push) => atLine(s, 'front', theme, push) },
  { label: 'Rears at the line, °C', lines: 2, cell: (s, theme, push) => atLine(s, 'rear', theme, push) },
  { label: 'Up to push temperature', lines: 2, cell: (s) => (
    <Text style={cells.cellText}>{s.cold_start ? `${fixed(s.ready_min, 1)} min` : 'warm start'}</Text>
  ) },
  { label: 'Best lap', lines: 2, cell: (s) => (
    <>
      <Text style={cells.cellText} numberOfLines={1}>{formatLap(s.peak_time)} (+{s.gap_day.toFixed(2)} s)</Text>
      <Text style={cells.cellSub} numberOfLines={1}>flying lap {s.peak_flying}, {s.peak_min.toFixed(1)} min</Text>
    </>
  ) },
  { label: 'Pace held', cell: (s) => (
    <Text style={cells.cellText}>{s.hold.laps} of {plural(s.hold.after + 1, 'lap')}</Text>
  ) },
];

const rowHeight = (r: Row) => (r.lines === 2 ? 40 : 28);

function BuildTable({ sims, fastest, holdS, push }: { sims: Sim[]; fastest: string | null; holdS: number; push: Push }) {
  const styles = useStyles();
  const theme = useTheme();
  const wash = useSeriesColors().reference + '1a'; // the accent at 10 %
  // Cold starts first, quickest to temperature first; then the runs on tyres still warm from earlier.
  const ordered = [...sims].sort((a, b) =>
    Number(b.cold_start) - Number(a.cold_start) || (a.ready_min ?? 99) - (b.ready_min ?? 99));
  return (
    <View>
      <View style={styles.table}>
        <View style={{ width: LABEL_W }}>
          <View style={styles.headCell} />
          {ROWS.map((r) => (
            <View key={r.label} style={StyleSheet.flatten([styles.rowLabelCell, { height: rowHeight(r) }])}>
              <Text style={styles.rowLabel} numberOfLines={2}>{r.label}</Text>
            </View>
          ))}
        </View>
        <ScrollView horizontal showsHorizontalScrollIndicator>
          {ordered.map((s) => (
            <View key={s.label} style={StyleSheet.flatten([styles.runCol, s.label === fastest && { backgroundColor: wash }])}>
              <View style={styles.headCell}>
                <Text style={styles.runName} numberOfLines={2}>{s.label}</Text>
                {s.label === fastest && <Text style={cells.cellSub}>quickest to temperature</Text>}
              </View>
              {ROWS.map((r) => (
                <View key={r.label} style={StyleSheet.flatten([styles.cell, { height: rowHeight(r) }])}>
                  {r.cell(s, theme, push)}
                </View>
              ))}
            </View>
          ))}
        </ScrollView>
      </View>
      {push && <TempKey />}
      <Text style={styles.legend}>
        At the line: the TPMS axle average at the start of each flying lap; bold is the run&apos;s best lap. Pace
        held: laps within {holdS} s of that best. Brake dragging, hard stops and weaving count the warm-up above 60
        km/h; swings a normal flying lap also has are left out.
      </Text>
    </View>
  );
}

/** The key to the tyre temperature colours. */
function TempKey() {
  const styles = useStyles();
  const theme = useTheme();
  return (
    <View style={styles.legendRow}>
      <View style={styles.legendItem}>
        <View style={StyleSheet.flatten([styles.swatch, { backgroundColor: theme.tyre.ok }])} />
        <Text style={styles.legendText}>fronts and rears at push temperature</Text>
      </View>
      <View style={styles.legendItem}>
        <View style={StyleSheet.flatten([styles.swatch, { backgroundColor: theme.tyre.cold }])} />
        <Text style={styles.legendText}>colder</Text>
      </View>
    </View>
  );
}

// ---------------------------------------------------------------- when the tyres are ready: gap against temperature

const C = { left: 40, right: 12, top: 18, bottom: 34, height: 230 };
const GAP_MAX = 3; // s; slower laps sit on the top edge

function ReadyChart({ sims, push }: { sims: Sim[]; push: NonNullable<Report['push']> }) {
  const theme = useTheme();
  const styles = useStyles();
  const [width, setWidth] = useState(0);
  const [picked, setPicked] = useState<SimPoint | null>(null);
  const [asTable, setAsTable] = useState(false);
  const ink = useThemeColor({}, 'text');
  const surface = useThemeColor({}, 'surface');
  const ready = theme.tyre.ok; // at push temperature
  const cold = theme.tyre.cold;
  const pts = sims.flatMap((s) => s.points).filter((p) => p.front != null);
  if (!pts.length) return null;
  const isReady = (p: SimPoint) => p.front != null && p.rear != null && p.front >= push.front_c && p.rear >= push.rear_c;

  const fronts = pts.map((p) => p.front as number);
  const lo = Math.floor((Math.min(...fronts, push.front_c) - 5) / 10) * 10;
  const hi = Math.ceil((Math.max(...fronts, push.front_c) + 5) / 10) * 10;
  const w = Math.max(width - C.left - C.right, 1);
  const h = C.height - C.top - C.bottom;
  const x = (v: number) => C.left + ((v - lo) / (hi - lo)) * w;
  const y = (gap: number) => C.top + (1 - Math.min(gap, GAP_MAX) / GAP_MAX) * h;
  const xTicks = Array.from({ length: Math.floor((hi - lo) / 10) + 1 }, (_, i) => lo + i * 10)
    .filter((v, i, all) => w / all.length > 26 || i % 2 === 0);

  const nearest = (px: number, py: number) => {
    let best: SimPoint | null = null;
    let d = 24 * 24; // the hit area: within 24 px of a dot
    for (const p of pts) {
      const dd = (x(p.front as number) - px) ** 2 + (y(p.gap) - py) ** 2;
      if (dd < d) [best, d] = [p, dd];
    }
    return best;
  };
  const touch = (e: GestureResponderEvent) => setPicked(nearest(e.nativeEvent.locationX, e.nativeEvent.locationY));
  const hover = Platform.OS === 'web'
    ? {
        onMouseMove: (e: any) => setPicked(nearest(e.nativeEvent.offsetX ?? e.nativeEvent.locationX,
          e.nativeEvent.offsetY ?? e.nativeEvent.locationY)),
        onMouseLeave: () => setPicked(null),
      }
    : {};
  const ordered = [...pts].sort((a, b) => Number(isReady(a)) - Number(isReady(b))); // ready dots on top

  return (
    <View style={styles.chart}>
      <Text style={styles.chartTitle}>Each flying lap: time off the day&apos;s best against the fronts at the line</Text>
      <TempKey />
      <Text style={styles.readout} numberOfLines={2}>
        {picked
          ? `${picked.sim}, lap ${picked.lap}: ${picked.gap.toFixed(2)} s off · fronts ${fixed(picked.front)} °C, rears ` +
            `${fixed(picked.rear)} °C · ${fixed(picked.pf, 2)} bar`
          : Platform.OS === 'web' ? 'Point at a lap for its numbers.' : 'Touch a lap for its numbers.'}
      </Text>
      <View
        onLayout={(e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width)}
        onStartShouldSetResponder={() => true}
        onResponderGrant={touch}
        onResponderMove={touch}
        {...hover}>
        {width > 0 && (
          <Svg width={width} height={C.height} pointerEvents="none">
            <Rect x={C.left} y={y(push.gap_s)} width={w} height={y(0) - y(push.gap_s)} fill={ready} fillOpacity={0.1} />
            {[0, 1, 2, 3].map((g) => (
              <Line key={g} x1={C.left} x2={C.left + w} y1={y(g)} y2={y(g)} stroke={ink} strokeOpacity={g ? 0.08 : 0.25} />
            ))}
            {[0, 1, 2, 3].map((g) => (
              <SvgText fontFamily={SVG_FONT} key={g} x={C.left - 6} y={y(g) + 4} fontSize={10} fill={theme.chart.muted} textAnchor="end">
                {g === GAP_MAX ? `${g}+` : g}
              </SvgText>
            ))}
            {xTicks.map((v) => (
              <SvgText fontFamily={SVG_FONT} key={v} x={x(v)} y={C.top + h + 14} fontSize={10} fill={theme.chart.muted} textAnchor="middle">
                {v}
              </SvgText>
            ))}
            <Line x1={x(push.front_c)} x2={x(push.front_c)} y1={C.top} y2={C.top + h} stroke={ink} strokeOpacity={0.45} />
            <SvgText fontFamily={SVG_FONT} x={x(push.front_c) + 4} y={C.top - 6} fontSize={10} fill={ink} fillOpacity={0.7}>
              {`push: ${push.front_c} °C`}
            </SvgText>
            <SvgText fontFamily={SVG_FONT} x={C.left + 4} y={y(push.gap_s) - 4} fontSize={10} fill={ink} fillOpacity={0.7}>
              {`within ${push.gap_s} s of the day's best`}
            </SvgText>
            <SvgText fontFamily={SVG_FONT} x={C.left + w / 2} y={C.height - 4} fontSize={10} fill={theme.chart.muted} textAnchor="middle">
              Fronts at the line, °C (TPMS)
            </SvgText>
            <SvgText fontFamily={SVG_FONT} x={10} y={C.top + h / 2} fontSize={10} fill={theme.chart.muted} textAnchor="middle"
              transform={`rotate(-90 10 ${C.top + h / 2})`}>
              s off the best
            </SvgText>
            {ordered.map((p) => (
              <Circle key={`${p.sim}-${p.lap}`} cx={x(p.front as number)} cy={y(p.gap)} r={picked === p ? 6 : 4}
                fill={isReady(p) ? ready : cold} stroke={surface} strokeWidth={2} />
            ))}
          </Svg>
        )}
      </View>
      <Pressable onPress={() => setAsTable(!asTable)} accessibilityRole="button">
        <Text style={styles.toggle}>{asTable ? 'Hide the table' : 'Show these laps as a table'}</Text>
      </Pressable>
      {asTable && <PointsTable sims={sims} push={push} />}
    </View>
  );
}

function PointsTable({ sims, push }: { sims: Sim[]; push: Push }) {
  const styles = useStyles();
  const theme = useTheme();
  const cols: [string, number][] = [['Run, lap', 150], ['Fronts °C', 70], ['Rears °C', 70], ['Bar', 50], ['Off best', 64]];
  return (
    <ScrollView horizontal>
      <View>
        <View style={styles.tRow}>
          {cols.map(([c, wd]) => <Text key={c} style={StyleSheet.flatten([styles.tHead, { width: wd }])}>{c}</Text>)}
        </View>
        {sims.flatMap((s) => s.points.map((p) => (
          <View key={`${s.label}-${p.lap}`} style={styles.tRow}>
            <Text style={StyleSheet.flatten([styles.tCell, styles.tLeft, { width: cols[0][1] }])} numberOfLines={1}>
              {s.label}, lap {p.lap}
            </Text>
            <Text style={StyleSheet.flatten([styles.tCell, { width: cols[1][1], color: tempTone(theme, push, 'front', p.front) }])}>
              {fixed(p.front)}
            </Text>
            <Text style={StyleSheet.flatten([styles.tCell, { width: cols[2][1], color: tempTone(theme, push, 'rear', p.rear) }])}>
              {fixed(p.rear)}
            </Text>
            <Text style={StyleSheet.flatten([styles.tCell, { width: cols[3][1] }])}>{fixed(p.pf, 2)}</Text>
            <Text style={StyleSheet.flatten([styles.tCell, { width: cols[4][1] }])}>{p.gap.toFixed(2)}</Text>
          </View>
        )))}
      </View>
    </ScrollView>
  );
}

// ---------------------------------------------------------------- tyre windows, laid out like the car

function WindowGrid({ report }: { report: Report }) {
  const styles = useStyles();
  const w = report.windows!;
  const cold = Object.fromEntries((report.cold?.tyres ?? []).map((c) => [c.tyre, c]));
  return (
    <View style={styles.car}>
      <Text style={styles.carLabel}>Front</Text>
      {[WHEELS.slice(0, 2), WHEELS.slice(2)].map((row) => (
        <View key={row[0]} style={styles.carRow}>
          {row.map((wheel) => {
            const t = w.tyres[wheel];
            const c = cold[wheel];
            return (
              <View key={wheel} style={styles.carCell}>
                <Text style={styles.wheel}>{wheel}</Text>
                {t?.p && (
                  <Text style={styles.windowLine}>
                    <Text style={styles.windowMain}>{span(t.p[0], t.p[2], 2)} bar</Text>
                    <Text style={styles.dim}> · {t.p[1].toFixed(2)}</Text>
                  </Text>
                )}
                {t?.t && (
                  <Text style={styles.windowLine}>
                    <Text style={styles.windowMain}>{span(t.t[0], t.t[2])} °C</Text>
                    <Text style={styles.dim}> · {t.t[1].toFixed(0)}</Text>
                  </Text>
                )}
                {c?.cold_bar != null && <Text style={styles.coldSet}>Set {c.cold_bar.toFixed(2)} bar cold</Text>}
              </View>
            );
          })}
        </View>
      ))}
      <Text style={styles.legend}>
        TPMS lap medians on the {w.laps} fastest laps: the 10th to 90th percentile, then the middle.
        {report.cold && report.cold.runs_used > 0 ? ` Cold pressures from ${plural(report.cold.runs_used, 'logged run')}.` : ''}
      </Text>
    </View>
  );
}

// ---------------------------------------------------------------- long runs

function LongRuns({ report }: { report: Report }) {
  const styles = useStyles();
  return (
    <View style={styles.longRuns}>
      {report.long_runs.map((lr) => {
        const fade = lr.fade;
        const verdict = !fade ? 'too few laps up to temperature'
          : fade.clear ? `${signed(fade.per_lap, 2)} s a lap once up to temperature`
            : 'held its pace once up to temperature';
        return (
          <View key={`${lr.session_id}-${lr.label}`} style={styles.longRun}>
            <View style={styles.longRunHead}>
              <Text style={styles.longRunName}>{lr.label}</Text>
              <NavLink href={{ pathname: '/tools/stint', params: { session: String(lr.session_id) } }} label="Stint" />
            </View>
            <Text style={cells.cellSub}>
              {plural(lr.flying, 'flying lap')}, best {formatLap(lr.best)} · {verdict} · fronts{' '}
              {fixed(lr.front_c[0])}→{fixed(lr.front_c[lr.front_c.length - 1])} °C
            </Text>
          </View>
        );
      })}
    </View>
  );
}

// ---------------------------------------------------------------- how it is worked out

function Method({ report }: { report: Report }) {
  const styles = useStyles();
  const [open, setOpen] = useState(false);
  return (
    <View style={styles.section}>
      <Pressable onPress={() => setOpen(!open)} accessibilityRole="button">
        <Text style={styles.toggle}>{open ? 'Hide how this is worked out' : 'How this is worked out'}</Text>
      </Pressable>
      {open && (
        <View style={styles.method}>
          <Text style={styles.legend}>
            From {plural(report.sessions.length, 'session')}
            {report.scope.event_name ? ` of ${report.scope.event_name}` : ''}.
          </Text>
          {report.method.map((m) => <Text key={m} style={styles.legend}>{m}</Text>)}
          {report.skipped.map((s) => (
            <Text key={s.session_id} style={styles.legend}>Not read: {s.session}, {s.reason}.</Text>
          ))}
        </View>
      )}
    </View>
  );
}

const span = (a: number, b: number, digits = 0) =>
  a.toFixed(digits) === b.toFixed(digits) ? a.toFixed(digits) : `${a.toFixed(digits)}–${b.toFixed(digits)}`;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

const useStyles = themed((c) => ({
  wrap: { gap: 12 },
  h2: { fontSize: 20, fontWeight: '700' },
  h3: { fontSize: 13, fontWeight: '600', opacity: 0.7, textTransform: 'uppercase', letterSpacing: 0.5 },
  loading: { flexDirection: 'row', gap: 8, alignItems: 'center' },
  error: { color: c.error },
  dim: { opacity: 0.55 },
  section: { gap: 8, marginTop: 8 },
  callout: { borderLeftWidth: 3, paddingLeft: 12, paddingVertical: 4, gap: 4 },
  calloutTitle: { fontSize: 12, fontWeight: '600', opacity: 0.6, textTransform: 'uppercase', letterSpacing: 0.5 },
  calloutText: { fontSize: 16, lineHeight: 23 },
  para: { lineHeight: 20 },
  paraTitle: { fontWeight: '600' },
  link: { fontWeight: '600', paddingVertical: 4 },
  tiles: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  tile: { flexGrow: 1, flexBasis: 150, borderWidth: 1, borderColor: c.border, borderRadius: Radius.card, padding: 10, gap: 2, backgroundColor: c.surface },
  tileLabel: { fontSize: 12, opacity: 0.6 },
  tileValue: { fontSize: 20, fontWeight: '600' },
  tileSub: { fontSize: 12, opacity: 0.6 },
  table: { flexDirection: 'row', borderTopWidth: 1, borderColor: c.separator },
  headCell: { height: 48, justifyContent: 'center', paddingRight: 8, borderBottomWidth: 1, borderColor: c.separator },
  rowLabelCell: { justifyContent: 'center', borderBottomWidth: 1, borderColor: c.separator, paddingRight: 6 },
  rowLabel: { fontSize: 12, opacity: 0.65 },
  runCol: { width: RUN_W, paddingLeft: 8 },
  runName: { fontSize: 13, fontWeight: '600' },
  cell: { justifyContent: 'center', borderBottomWidth: 1, borderColor: c.separator, paddingRight: 6 },
  legend: { fontSize: 12, opacity: 0.6, lineHeight: 17, marginTop: 4 },
  chart: { gap: 4, maxWidth: 760, ...chartPlate(c) },
  chartTitle: { fontSize: 13, fontWeight: '600' },
  legendRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 14 },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  swatch: { width: 10, height: 10, borderRadius: 5 },
  legendText: { fontSize: 12, opacity: 0.7 },
  readout: { fontSize: 13, minHeight: 36, fontVariant: ['tabular-nums'] },
  toggle: { fontSize: 13, fontWeight: '600', opacity: 0.75, paddingVertical: 4 },
  tRow: { flexDirection: 'row', borderBottomWidth: 1, borderColor: c.separator, paddingVertical: 3 },
  tHead: { fontSize: 12, fontWeight: '600', opacity: 0.65, textAlign: 'right', paddingRight: 8 },
  tCell: { fontSize: 13, fontVariant: ['tabular-nums'], textAlign: 'right', paddingRight: 8 },
  tLeft: { textAlign: 'left' },
  car: { gap: 8, maxWidth: 520 },
  carLabel: { fontSize: 12, opacity: 0.6, textAlign: 'center' },
  carRow: { flexDirection: 'row', gap: 8 },
  carCell: { flex: 1, borderWidth: 1, borderColor: c.border, borderRadius: Radius.card, padding: 10, gap: 2, backgroundColor: c.surface },
  wheel: { fontWeight: '700' },
  windowLine: { fontSize: 13, fontVariant: ['tabular-nums'] },
  windowMain: { fontWeight: '600' },
  coldSet: { fontSize: 13, marginTop: 4 },
  longRuns: { gap: 8 },
  longRun: { gap: 2, borderBottomWidth: 1, borderColor: c.separator, paddingBottom: 6 },
  longRunHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  longRunName: { fontWeight: '600' },
  method: { gap: 6 },
}));

// the table's cell text, also used by the rows' cell makers outside the components (no colours of their own)
const cells = StyleSheet.create({
  cellText: { fontSize: 13, fontVariant: ['tabular-nums'] },
  cellSub: { fontSize: 12, opacity: 0.6, fontVariant: ['tabular-nums'] },
  peakValue: { fontWeight: '700' },
});
