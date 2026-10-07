import { Fragment, ReactNode, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  GestureResponderEvent,
  LayoutChangeEvent,
  Platform,
  ScrollView,
  StyleSheet,
  TextStyle,
  View,
} from 'react-native';
import Svg, { Circle, Line, Rect, Text as SvgText } from 'react-native-svg';

// Plain views: the sections sit on the page's own paper.
import { Cells, Item, SubHead, usePrepType, ValueBlock } from '@/components/PrepParts';
import { Block, Fig, Label, Section, Swatch, TextLink, useWide } from '@/components/Programme';
import { Text } from '@/components/Themed';
import { formatLap } from '@/lib/api';
import { Advice, fetchTyrePrep, fixed, signed, Sim, SimPoint, TyrePrep as Report, WHEELS } from '@/lib/tyreprep';
import { face, Fonts, Palette, themed, Type, useTheme } from '@/constants/Theme';

const PEAK_LAPS = 6; // flying laps shown lap by lap in the comparison
// SVG text takes the browser's default (serif) face on web: give it the label face the rest of the charts use
const SVG_FONT = Fonts.sans;

/** The tyre and qualifying preparation, for one session or a whole event, in the programme's numbered sections: the
 * plan (the recommended warm-up and the headline figures), the warm-ups side by side, when the tyres were ready to
 * push, each tyre's window on the fastest laps with the cold pressures that land in it, and the long runs. */
export function TyrePrep({ session, event, heading = true }: { session?: number; event?: number; heading?: boolean }) {
  const styles = useStyles();
  const type = usePrepType();
  const theme = useTheme();
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
    <View>
      {heading && <SubHead title="Tyres and qualifying preparation" style={styles.heading} />}
      {busy && (
        <View style={styles.loading}>
          <ActivityIndicator color={theme.text} />
          <Text style={type.note}>Reading the logs{event != null ? ' of every session' : ''}…</Text>
        </View>
      )}
      {error && <Text style={StyleSheet.flatten([type.error, styles.loadingGap])}>{error}</Text>}
      {report && !busy && <Body report={report} />}
    </View>
  );
}

export default TyrePrep;

type Part = { key: string; render: (no: number) => ReactNode };

function Body({ report }: { report: Report }) {
  const advice: Record<string, Advice> = Object.fromEntries(report.advice.map((a) => [a.key, a]));
  const sims = report.sims;
  const tiles = tilesOf(report);
  const parts: (Part | false)[] = [
    (!!advice.plan || !!advice.no_tpms || !!advice.no_sims || tiles.length > 0) && { key: 'plan', render: (no) => (
      <Section no={no} title="The plan" dek="The warm-up to copy, when to push, and the figures behind it.">
        {advice.plan && <Recommendation text={advice.plan.text} />}
        <Paras list={[advice.no_tpms, advice.no_sims]} />
        <Tiles tiles={tiles} />
      </Section>
    ) },
    sims.length > 0 && { key: 'build', render: (no) => (
      <Section no={no} title="Warm-up and build laps" dek="The quali-style runs side by side: cold starts first, the quickest to temperature first.">
        <BuildTable sims={sims} fastest={report.fastest?.best.label ?? null} holdS={report.peak_hold_s}
          push={report.push} />
        <Paras list={[advice.build, advice.brakes]} />
      </Section>
    ) },
    sims.length > 0 && !!report.push && { key: 'ready', render: (no) => (
      <Section no={no} title="When the tyres are ready" dek="Each flying lap against the front tyres' temperature at the line.">
        <Paras list={[advice.push]} />
        <ReadyChart sims={sims} push={report.push!} />
        <Paras list={[advice.ready, advice.pressure]} />
      </Section>
    ) },
    !!report.windows && { key: 'windows', render: (no) => (
      <Section no={no} title="Tyre windows" dek="Where each tyre ran on the fastest laps, and the cold pressures that land it there.">
        <Paras list={[advice.window]} />
        <WindowGrid report={report} />
        <Paras list={[advice.cold]} />
        <View style={{ marginTop: 18 }}><TextLink href="/tools/pressures" label="Open the pressure calculator" arrow /></View>
      </Section>
    ) },
    report.long_runs.length > 0 && { key: 'long', render: (no) => (
      <Section no={no} title="Long runs" dek="How the pace held once the tyres were up to temperature.">
        <Paras list={[advice.fade]} />
        <LongRuns report={report} />
      </Section>
    ) },
  ];
  const shown = parts.filter((p): p is Part => !!p);
  return (
    <>
      {shown.map((p, i) => <Fragment key={p.key}>{p.render(i + 1)}</Fragment>)}
      <Method report={report} />
    </>
  );
}

function Recommendation({ text }: { text: string }) {
  const styles = useStyles();
  const type = usePrepType();
  const wide = useWide();
  return (
    <View style={styles.callout}>
      <Label>Recommendation</Label>
      <Text style={wide ? type.lead : type.leadPhone}>{text}</Text>
    </View>
  );
}

/** Pieces of advice, each its title in Archivo capitals beside its text. */
function Paras({ list }: { list: (Advice | undefined)[] }) {
  const styles = useStyles();
  const type = usePrepType();
  const wide = useWide();
  const shown = list.filter((a): a is Advice => !!a);
  if (!shown.length) return null;
  return (
    <View style={styles.paras}>
      {shown.map((a, i) => (
        <Item key={a.key} label={a.title} first={i === 0}>
          <Text style={wide ? type.read : type.readPhone}>{a.text}</Text>
        </Item>
      ))}
    </View>
  );
}

// ---------------------------------------------------------------- headline numbers

type Tile = { label: string; value: string; unit: string; sub: string };

function tilesOf(report: Report): Tile[] {
  const { push, ready, brake_work: brakes, pressure } = report;
  const tiles: Tile[] = [];
  if (push) tiles.push({ label: 'Push at', value: `${push.front_c} / ${push.rear_c}`, unit: '°C',
    sub: 'fronts / rears, TPMS at the line' });
  if (ready) {
    tiles.push({ label: 'Ready from cold', value: span(ready.min, ready.max, 1), unit: 'min',
      sub: `median ${ready.median.toFixed(1)}, ${plural(ready.runs, 'cold start')}` });
    if (ready.peak_from_exit) {
      tiles.push({ label: 'Best lap', value: span(ready.peak_from_exit[0], ready.peak_from_exit[1]), unit: 'laps',
        sub: 'after leaving the pits' });
    }
  }
  if (brakes && brakes.saved_min > 0) {
    tiles.push({ label: 'Brake warming', value: brakes.saved_min.toFixed(1), unit: 'min',
      sub: 'sooner, most against least dragging' });
  }
  if (pressure) {
    tiles.push({ label: 'Hot pressure', value: span(pressure.pf[0], pressure.pf[1], 2), unit: 'bar',
      sub: pressure.wide ? 'fronts, no pace difference' : 'fronts on the near-best laps' });
  }
  return tiles;
}

function Tiles({ tiles }: { tiles: Tile[] }) {
  const styles = useStyles();
  const wide = useWide();
  if (!tiles.length) return null;
  return (
    <Cells cols={Math.min(3, tiles.length)} phoneCols={2} style={styles.tiles}>
      {tiles.map((t) => (
        <Fig key={t.label} label={t.label} value={t.value} unit={t.unit} size={wide ? 56 : 30} note={t.sub} />
      ))}
    </Cells>
  );
}

// ---------------------------------------------------------------- the warm-ups side by side

const LABEL_W = 150;
const LABEL_W_PHONE = 112;
const RUN_W = 176;

type Push = Report['push'];
type CellStyles = ReturnType<typeof useStyles>;
type Row = { label: string; lines?: 2; cell: (s: Sim, theme: Palette, push: Push, st: CellStyles) => ReactNode };

/** A tyre temperature's colour: below push temperature cold, at or above it ready; none without a push temperature. */
const tempTone = (theme: Palette, push: Push, axle: 'front' | 'rear', v: number | null | undefined) =>
  push && v != null ? (v < push[`${axle}_c`] ? theme.tyre.cold : theme.tyre.ok) : undefined;

/** The axle's temperature at the start of each flying lap, each in a block of its colour; the best lap underlined. */
function atLine(s: Sim, axle: 'front' | 'rear', theme: Palette, push: Push, st: CellStyles) {
  const pts = s.points.slice(0, Math.max(PEAK_LAPS, s.peak_flying));
  return (
    <View style={st.blocks}>
      {pts.map((p) => {
        const tone = tempTone(theme, push, axle, p[axle]);
        return tone
          ? <ValueBlock key={p.lap} value={fixed(p[axle])} fill={tone} bold={p.peak} under={p.peak} style={st.tempBlock} />
          : <Text key={p.lap} style={StyleSheet.flatten([st.cellText, p.peak && st.peakValue])}>{fixed(p[axle])}</Text>;
      })}
    </View>
  );
}

const ROWS: Row[] = [
  { label: 'Start', lines: 2, cell: (s, _t, _p, st) => (
    <>
      <Text style={st.cellText}>{s.cold_start ? 'Cold tyres' : 'Pre-warmed'}</Text>
      <Text style={st.cellSub}>{s.kind === 'quali' ? 'quali sim' : 'then a long run'}</Text>
    </>
  ) },
  { label: 'Warm-up', cell: (s, _t, _p, st) => (
    <Text style={st.cellText}>{s.warm_laps != null ? plural(s.warm_laps, 'lap') : '–'}, {s.warm_min.toFixed(1)} min</Text>
  ) },
  { label: 'Brake dragging', cell: (s, _t, _p, st) => <Text style={st.cellText}>{fixed(s.drag_s)} s</Text> },
  { label: 'Hard stops on the straights', lines: 2, cell: (s, _t, _p, st) => (
    <Text style={st.cellText}>{fixed(s.straight_hard_stops)}</Text>) },
  { label: 'Weaving swings', cell: (s, _t, _p, st) => <Text style={st.cellText}>{fixed(s.weaves)}</Text> },
  { label: 'Each warm-up lap, fronts', lines: 2, cell: (s, _t, _p, st) => (
    <>
      <Text style={st.cellText}>{signed(s.warm_gain_per_lap.front_c)} °C</Text>
      <Text style={st.cellSub}>{signed(s.warm_gain_per_lap.front_bar, 2)} bar</Text>
    </>
  ) },
  { label: 'Fronts at the line, °C', lines: 2, cell: (s, theme, push, st) => atLine(s, 'front', theme, push, st) },
  { label: 'Rears at the line, °C', lines: 2, cell: (s, theme, push, st) => atLine(s, 'rear', theme, push, st) },
  { label: 'Up to push temperature', lines: 2, cell: (s, _t, _p, st) => (
    <Text style={st.cellText}>{s.cold_start ? `${fixed(s.ready_min, 1)} min` : 'warm start'}</Text>
  ) },
  { label: 'Best lap', lines: 2, cell: (s, _t, _p, st) => (
    <>
      <Text style={st.cellText} numberOfLines={1}>{formatLap(s.peak_time)} (+{s.gap_day.toFixed(2)} s)</Text>
      <Text style={st.cellSub} numberOfLines={1}>flying lap {s.peak_flying}, {s.peak_min.toFixed(1)} min</Text>
    </>
  ) },
  { label: 'Pace held', cell: (s, _t, _p, st) => (
    <Text style={st.cellText}>{s.hold.laps} of {plural(s.hold.after + 1, 'lap')}</Text>
  ) },
];

const rowHeight = (r: Row) => (r.lines === 2 ? 44 : 32);
const HEAD_H = 56;

function BuildTable({ sims, fastest, holdS, push }: { sims: Sim[]; fastest: string | null; holdS: number; push: Push }) {
  const styles = useStyles();
  const type = usePrepType();
  const theme = useTheme();
  const wide = useWide();
  // Cold starts first, quickest to temperature first; then the runs on tyres still warm from earlier.
  const ordered = [...sims].sort((a, b) =>
    Number(b.cold_start) - Number(a.cold_start) || (a.ready_min ?? 99) - (b.ready_min ?? 99));
  return (
    <View>
      <View style={styles.table}>
        <View style={{ width: wide ? LABEL_W : LABEL_W_PHONE }}>
          <View style={styles.headCell}><Text style={styles.th}>Run</Text></View>
          {ROWS.map((r) => (
            <View key={r.label} style={StyleSheet.flatten([styles.rowLabelCell, { height: rowHeight(r) }])}>
              <Text style={styles.rowLabel} numberOfLines={2}>{r.label}</Text>
            </View>
          ))}
        </View>
        <ScrollView horizontal showsHorizontalScrollIndicator style={styles.scroller}>
          {ordered.map((s) => (
            // the run quickest to temperature: a band of the darker paper down its column
            <View key={s.label} style={StyleSheet.flatten([styles.runCol, s.label === fastest && styles.runColOn])}>
              <View style={styles.headCell}>
                <Text style={styles.runName} numberOfLines={s.label === fastest ? 1 : 2}>{s.label}</Text>
                {s.label === fastest && <Block label="Quickest to temp." color={theme.rule} ink={theme.background}
                  size={10} style={styles.quickest} />}
              </View>
              {ROWS.map((r) => (
                <View key={r.label} style={StyleSheet.flatten([styles.cell, { height: rowHeight(r) }])}>
                  {r.cell(s, theme, push, styles)}
                </View>
              ))}
            </View>
          ))}
        </ScrollView>
      </View>
      {push && <TempKey style={styles.keyAfter} />}
      <Text style={StyleSheet.flatten([type.note, styles.legendText])}>
        At the line: the TPMS axle average at the start of each flying lap; underlined is the run&apos;s best lap. Pace
        held: laps within {holdS} s of that best. Brake dragging, hard stops and weaving count the warm-up above 60
        km/h; swings a normal flying lap also has are left out.
      </Text>
    </View>
  );
}

/** The key to the tyre temperature colours. */
function TempKey({ style }: { style?: object }) {
  const styles = useStyles();
  const theme = useTheme();
  return (
    <View style={StyleSheet.flatten([styles.legendRow, style])}>
      <Swatch color={theme.tyre.ok} label="Fronts and rears at push temperature" />
      <Swatch color={theme.tyre.cold} label="Colder" />
    </View>
  );
}

// ---------------------------------------------------------------- when the tyres are ready: gap against temperature

const C = { left: 40, right: 12, top: 20, bottom: 36, height: 250 };
const GAP_MAX = 3; // s; slower laps sit on the top edge

function ReadyChart({ sims, push }: { sims: Sim[]; push: NonNullable<Report['push']> }) {
  const theme = useTheme();
  const styles = useStyles();
  const [width, setWidth] = useState(0);
  const [picked, setPicked] = useState<SimPoint | null>(null);
  const [asTable, setAsTable] = useState(false);
  const ch = theme.chart;
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
      <Label>Each flying lap: time off the day&apos;s best against the fronts at the line</Label>
      <TempKey style={styles.keyChart} />
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
            <Rect x={C.left} y={y(push.gap_s)} width={w} height={y(0) - y(push.gap_s)} fill={ready} fillOpacity={0.12} />
            {[1, 2, 3].map((g) => (
              <Line key={g} x1={C.left} x2={C.left + w} y1={y(g)} y2={y(g)} stroke={ch.grid} strokeWidth={1} />
            ))}
            <Line x1={C.left} x2={C.left + w} y1={y(0)} y2={y(0)} stroke={ch.axis} strokeWidth={1.5} />
            {[0, 1, 2, 3].map((g) => (
              <SvgText fontFamily={SVG_FONT} key={g} x={C.left - 7} y={y(g) + 4} fontSize={11} fill={ch.muted} textAnchor="end">
                {g === GAP_MAX ? `${g}+` : g}
              </SvgText>
            ))}
            {xTicks.map((v) => (
              <SvgText fontFamily={SVG_FONT} key={v} x={x(v)} y={C.top + h + 15} fontSize={11} fill={ch.muted} textAnchor="middle">
                {v}
              </SvgText>
            ))}
            <Line x1={x(push.front_c)} x2={x(push.front_c)} y1={C.top} y2={C.top + h} stroke={ch.ink} strokeWidth={1.5} />
            <SvgText fontFamily={SVG_FONT} x={x(push.front_c) + 5} y={C.top - 7} fontSize={11} fill={ch.ink}>
              {`PUSH: ${push.front_c} °C`}
            </SvgText>
            <SvgText fontFamily={SVG_FONT} x={C.left + 5} y={y(push.gap_s) - 5} fontSize={11} fill={ch.ink2}>
              {`within ${push.gap_s} s of the day's best`}
            </SvgText>
            <SvgText fontFamily={SVG_FONT} x={C.left + w / 2} y={C.height - 4} fontSize={11} fill={ch.muted} textAnchor="middle">
              FRONTS AT THE LINE, °C (TPMS)
            </SvgText>
            <SvgText fontFamily={SVG_FONT} x={11} y={C.top + h / 2} fontSize={11} fill={ch.muted} textAnchor="middle"
              transform={`rotate(-90 11 ${C.top + h / 2})`}>
              S OFF THE BEST
            </SvgText>
            {ordered.map((p) => (
              <Circle key={`${p.sim}-${p.lap}`} cx={x(p.front as number)} cy={y(p.gap)} r={picked === p ? 6.5 : 4.5}
                fill={isReady(p) ? ready : cold} stroke={picked === p ? ch.ink : ch.surface} strokeWidth={2} />
            ))}
          </Svg>
        )}
      </View>
      <View style={styles.toggle}>
        <TextLink label={asTable ? 'Hide the table' : 'Show these laps as a table'} small onPress={() => setAsTable(!asTable)} />
      </View>
      {asTable && <PointsTable sims={sims} push={push} />}
    </View>
  );
}

function PointsTable({ sims, push }: { sims: Sim[]; push: Push }) {
  const styles = useStyles();
  const theme = useTheme();
  const cols: [string, number][] = [['Run, lap', 170], ['Fronts °C', 76], ['Rears °C', 76], ['Bar', 56], ['Off best', 70]];
  const temp = (axle: 'front' | 'rear', v: number | null) => {
    const tone = tempTone(theme, push, axle, v);
    return tone ? <ValueBlock value={fixed(v)} fill={tone} /> : <Text style={styles.cellText}>{fixed(v)}</Text>;
  };
  return (
    <ScrollView horizontal style={styles.pointsTable}>
      <View>
        <View style={styles.tHeadRow}>
          {cols.map(([c, wd], i) => (
            <Text key={c} style={StyleSheet.flatten([styles.th, { width: wd }, i > 0 && styles.tRight])}>{c}</Text>
          ))}
        </View>
        {sims.flatMap((s) => s.points.map((p) => (
          <View key={`${s.label}-${p.lap}`} style={styles.tRow}>
            <Text style={StyleSheet.flatten([styles.cellText, { width: cols[0][1] }])} numberOfLines={1}>
              {s.label}, lap {p.lap}
            </Text>
            <View style={StyleSheet.flatten([styles.tNum, { width: cols[1][1] }])}>{temp('front', p.front)}</View>
            <View style={StyleSheet.flatten([styles.tNum, { width: cols[2][1] }])}>{temp('rear', p.rear)}</View>
            <View style={StyleSheet.flatten([styles.tNum, { width: cols[3][1] }])}>
              <Text style={styles.cellText}>{fixed(p.pf, 2)}</Text></View>
            <View style={StyleSheet.flatten([styles.tNum, { width: cols[4][1] }])}>
              <Text style={styles.cellText}>{p.gap.toFixed(2)}</Text></View>
          </View>
        )))}
      </View>
    </ScrollView>
  );
}

// ---------------------------------------------------------------- tyre windows, laid out like the car

function WindowGrid({ report }: { report: Report }) {
  const styles = useStyles();
  const type = usePrepType();
  const theme = useTheme();
  const wide = useWide();
  const w = report.windows!;
  const cold = Object.fromEntries((report.cold?.tyres ?? []).map((c) => [c.tyre, c]));
  return (
    <View style={styles.car}>
      <Label muted style={styles.axle}>Front</Label>
      <Cells cols={2} phoneCols={2}>
        {WHEELS.map((wheel) => {
          const t = w.tyres[wheel];
          const c = cold[wheel];
          return (
            <View key={wheel} style={styles.wheelCell}>
              <View style={styles.wheelHead}>
                <Block label={wheel} color={theme.rule} ink={theme.background} size={13} />
                {c?.cold_bar != null && (
                  <Text style={styles.coldSet}>Set <Text style={styles.coldValue}>{c.cold_bar.toFixed(2)}</Text> bar cold</Text>
                )}
              </View>
              {t?.p && (
                <Fig value={span(t.p[0], t.p[2], 2)} unit="bar" size={wide ? 36 : 24}
                  note={`middle ${t.p[1].toFixed(2)} bar`} />
              )}
              {t?.t && (
                <Text style={styles.windowTemp}>
                  {span(t.t[0], t.t[2])} °C <Text style={type.small}> middle {t.t[1].toFixed(0)}</Text>
                </Text>
              )}
            </View>
          );
        })}
      </Cells>
      <Label muted style={styles.axleRear}>Rear</Label>
      <Text style={StyleSheet.flatten([type.note, styles.legendText])}>
        TPMS lap medians on the {w.laps} fastest laps: the 10th to 90th percentile, then the middle.
        {report.cold && report.cold.runs_used > 0 ? ` Cold pressures from ${plural(report.cold.runs_used, 'logged run')}.` : ''}
      </Text>
    </View>
  );
}

// ---------------------------------------------------------------- long runs

function LongRuns({ report }: { report: Report }) {
  const styles = useStyles();
  const type = usePrepType();
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
              <TextLink href={{ pathname: '/tools/stint', params: { session: String(lr.session_id) } }} label="Stint"
                small arrow />
            </View>
            <Text style={type.small}>
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
  const type = usePrepType();
  const [open, setOpen] = useState(false);
  return (
    <View style={styles.method}>
      <TextLink label={open ? 'Hide how this is worked out' : 'How this is worked out'} small onPress={() => setOpen(!open)} />
      {open && (
        <View style={styles.methodLines}>
          <Text style={type.note}>
            From {plural(report.sessions.length, 'session')}
            {report.scope.event_name ? ` of ${report.scope.event_name}` : ''}.
          </Text>
          {report.method.map((m) => <Text key={m} style={type.note}>{m}</Text>)}
          {report.skipped.map((s) => (
            <Text key={s.session_id} style={type.note}>Not read: {s.session}, {s.reason}.</Text>
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
  heading: { marginTop: 24 },
  loading: { flexDirection: 'row', gap: 10, alignItems: 'center', marginTop: 28 },
  loadingGap: { marginTop: 28 },
  callout: { borderLeftWidth: 6, borderColor: c.mark, paddingLeft: 16, paddingTop: 2, paddingBottom: 4, gap: 8,
    marginBottom: 22, maxWidth: 900 },
  paras: { marginTop: 18, marginBottom: 4 },
  tiles: { marginTop: 4 },

  // the warm-ups side by side
  table: { flexDirection: 'row' },
  scroller: { flex: 1 },
  headCell: { height: HEAD_H, justifyContent: 'flex-end', paddingRight: 8, paddingBottom: 6, gap: 4, borderBottomWidth: 2,
    borderColor: c.rule },
  th: { ...Type.label, fontFamily: face('label', 700), fontSize: 12, letterSpacing: 1.2, color: c.text } as TextStyle,
  rowLabelCell: { justifyContent: 'center', borderBottomWidth: 1, borderColor: c.separator, paddingRight: 8 },
  rowLabel: { ...Type.label, fontFamily: face('label', 600), fontSize: 11, lineHeight: 14, letterSpacing: 0.7,
    color: c.textSecondary } as TextStyle,
  runCol: { width: RUN_W, paddingLeft: 10 },
  runColOn: { backgroundColor: c.band },
  runName: { fontFamily: face('label', 700), fontSize: 15, lineHeight: 18, color: c.text },
  quickest: { marginTop: 1 },
  cell: { justifyContent: 'center', borderBottomWidth: 1, borderColor: c.separator, paddingRight: 8 },
  cellText: { fontFamily: face('label', 600), fontSize: 14, fontVariant: ['tabular-nums'], color: c.text } as TextStyle,
  cellSub: { fontFamily: face('label', 500), fontSize: 12, fontVariant: ['tabular-nums'], color: c.textSecondary } as TextStyle,
  peakValue: { fontFamily: face('label', 700), textDecorationLine: 'underline' } as TextStyle,
  blocks: { flexDirection: 'row', gap: 2, alignItems: 'center' },
  tempBlock: { paddingHorizontal: 3 },
  legendRow: { flexDirection: 'row', flexWrap: 'wrap', columnGap: 22, rowGap: 8, alignItems: 'center' },
  keyAfter: { marginTop: 14 },
  keyChart: { marginTop: 10 },
  legendText: { marginTop: 10, maxWidth: 900 },

  // the chart: on the paper, no plate
  chart: { marginTop: 22, maxWidth: 820, borderTopWidth: 1, borderColor: c.rule, paddingTop: 10 },
  readout: { fontFamily: face('label', 500), fontSize: 13, lineHeight: 18, minHeight: 38, marginTop: 8,
    fontVariant: ['tabular-nums'], color: c.textSecondary } as TextStyle,
  toggle: { marginTop: 10 },
  pointsTable: { marginTop: 14 },
  tHeadRow: { flexDirection: 'row', borderBottomWidth: 2, borderColor: c.rule, paddingBottom: 5 },
  tRow: { flexDirection: 'row', alignItems: 'center', borderBottomWidth: 1, borderColor: c.separator, paddingVertical: 4 },
  tRight: { textAlign: 'right', paddingRight: 8 },
  tNum: { alignItems: 'flex-end', paddingRight: 8 },

  // tyre windows
  car: { maxWidth: 640, marginTop: 18 },
  axle: { textAlign: 'center', marginBottom: 6 },
  axleRear: { textAlign: 'center', marginTop: 6, paddingTop: 6, borderTopWidth: 1, borderColor: c.rule },
  wheelCell: { gap: 8 },
  wheelHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 6 },
  coldSet: { ...Type.label, fontFamily: face('label', 600), fontSize: 11, letterSpacing: 0.8, color: c.textSecondary } as TextStyle,
  coldValue: { fontFamily: face('label', 700), fontSize: 15, color: c.text },
  windowTemp: { fontFamily: face('label', 600), fontSize: 16, fontVariant: ['tabular-nums'], color: c.text } as TextStyle,

  // long runs
  longRuns: { marginTop: 14, borderTopWidth: 1, borderColor: c.rule },
  longRun: { gap: 3, borderBottomWidth: 1, borderColor: c.separator, paddingTop: 10, paddingBottom: 10 },
  longRunHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 12 },
  longRunName: { fontFamily: face('label', 700), fontSize: 17, letterSpacing: 0.3, color: c.text, flexShrink: 1 },

  method: { marginTop: 40, gap: 12 },
  methodLines: { gap: 6, maxWidth: 820 },
}));
