// The report's car balance and setup direction section, advice first: the setup changes to try (each with its
// reason and expected effect), where the car rather than the driver limits the lap and by how much, then the
// balance per section on entry, mid-corner and exit. For one session or a whole event.
import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet } from 'react-native';

import { TextLink } from '@/components/Programme';
import { Text, View, useThemeColor } from '@/components/Themed';
import { TraceChart } from '@/components/TraceChart';
import { useColorScheme } from '@/components/useColorScheme';
import { ResetZoom, ZOOM_HINT, ZoomGroup } from '@/components/Zoom';
import {
  BalanceCell,
  BalanceReport,
  balanceWords,
  BarModel,
  CarLimitRow,
  degrees,
  fetchBalance,
  Focus,
  lapName,
  Recommendation,
  SPEED_LABEL,
  Strength,
} from '@/lib/balance';
import { quickestLapsLine } from '@/lib/grip';
import { noPrint } from '@/lib/print';
import { byScheme, Fonts, TAP, tapRoom, themed, Type } from '@/constants/Theme';

// bare: inside a report section that already names it, so without its own heading
type Props = { session?: number; event?: number; bare?: boolean };

// Validated chart palette: categorical slots 1-3 (driving, car, theoretical; and the three laps in the focus charts),
// and the diverging pair for balance (blue: understeer, red: oversteer, grey: normal), light and dark steps.
const PALETTE = byScheme((c) => ({
  reference: c.chart.series[0], compare: c.chart.series[1], third: c.chart.series[2],
  under: c.balance.under, over: c.balance.over, neutral: c.chart.mid,
}));
const WASH: Record<NonNullable<Strength>, string> = { slight: '2e', clear: '5c', strong: '8f' }; // alpha by strength

function usePalette() {
  return PALETTE[useColorScheme() === 'dark' ? 'dark' : 'light'];
}

/** Keeps a number with its unit and a corner range in one piece when text wraps on a phone ("11 %", "T15-T17"). */
function nb(text: string): string {
  return text
    .replace(/(\d) (%|°C|°\/g|s\b|km\/h|bar\b|mm\b|m\b|g\b)/g, '$1 $2')
    .replace(/\bT(\d+)-T(\d+)/g, 'T$1‑T$2');
}

// Same thresholds as the server (app/analysis/setup_advice.py STRENGTH), for the quickest passes' values.
function describe(v: number): Pick<BalanceCell, 'kind' | 'strength'> {
  const a = Math.round(Math.abs(v) * 10) / 10; // as printed
  const strength: Strength = a >= 1.5 ? 'strong' : a >= 0.8 ? 'clear' : a >= 0.3 ? 'slight' : null;
  return { kind: strength == null ? 'normal' : v > 0 ? 'understeer' : 'oversteer', strength };
}

export function Balance({ session, event, bare }: Props) {
  const styles = useStyles();
  const [report, setReport] = useState<BalanceReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (session == null && event == null) return;
    let live = true;
    setBusy(true);
    setError(null);
    setReport(null);
    fetchBalance({ session, event })
      .then((r) => live && setReport(r))
      .catch((e) => live && setError((e as Error).message))
      .finally(() => live && setBusy(false));
    return () => {
      live = false;
    };
  }, [session, event]);

  return (
    <View style={styles.root}>
      {!bare && <Text style={styles.h1}>Car balance and setup</Text>}
      {busy && (
        <View style={styles.busy}>
          <ActivityIndicator />
          <Text style={styles.dim}>
            {event != null ? 'Reading every run of the event, one at a time…' : 'Reading the log…'}
          </Text>
        </View>
      )}
      {error && <Text style={styles.error}>{error}</Text>}
      {report && <ReportView r={report} />}
    </View>
  );
}

function ReportView({ r }: { r: BalanceReport }) {
  const styles = useStyles();
  return (
    <>
      <Text style={styles.dim}>
        {r.scope.name}
        {r.scope.track ? ` · ${r.scope.track}` : ''} · {r.laps} clean laps · fastest {r.reference.lap_time} (
        {r.reference.run} lap {r.reference.lap})
      </Text>
      {r.quickest_laps && <Text style={styles.dim}>{quickestLapsLine(r.quickest_laps)}</Text>}
      <Text style={styles.headline}>{nb(r.headline)}</Text>

      {r.recommendations.length > 0 && (
        <View style={styles.section}>
          <Text style={styles.h2}>Setup changes to try</Text>
          {r.recommendations.map((rec, i) => (
            <RecommendationCard key={rec.key} rec={rec} index={i} />
          ))}
        </View>
      )}
      {r.notes.map((n) => (
        <Text key={n} style={styles.note}>
          {nb(n)}
        </Text>
      ))}

      <CarLimits r={r} />
      {r.focus && <FocusView focus={r.focus} />}
      <BalanceTable r={r} />

      {r.checks.length > 0 && (
        <View style={styles.section}>
          <Text style={styles.h2}>Numbers to check after a change</Text>
          <View style={styles.checks}>
            {r.checks.map((c) => (
              <View key={c.label} style={styles.check}>
                <Text style={styles.checkLabel}>{c.label}</Text>
                <Text style={styles.checkValue}>{nb(c.value)}</Text>
              </View>
            ))}
          </View>
        </View>
      )}

      <Method r={r} />
    </>
  );
}

function RecommendationCard({ rec, index }: { rec: Recommendation; index: number }) {
  const styles = useStyles();
  const tint = useThemeColor({}, 'tint');
  return (
    <View style={[styles.card, index === 0 && { borderColor: tint }]}>
      <View style={styles.cardHead}>
        <Text style={styles.cardNumber}>{index + 1}</Text>
        <Text style={styles.cardTitle}>{rec.title}</Text>
      </View>
      <Labelled label="Why" text={rec.why} />
      <Labelled label="Expect" text={rec.expect} />
      {rec.watch && <Labelled label="Watch" text={rec.watch} />}
      {rec.model && <ModelLine model={rec.model} />}
    </View>
  );
}

function Labelled({ label, text }: { label: string; text: string }) {
  const styles = useStyles();
  return (
    <View style={styles.labelled}>
      <Text style={styles.label}>{label}</Text>
      <Text style={styles.body}>{nb(text)}</Text>
    </View>
  );
}

function ModelLine({ model }: { model: BarModel }) {
  const styles = useStyles();
  const [a, b] = model.llt_front_share;
  const [ra, rb] = model.roll_gradient;
  return (
    <View style={styles.model}>
      <Text style={styles.label}>Vehicle model</Text>
      <Text style={styles.body}>
        {nb(
          `${model.car}, ${model.axle} bar setting ${model.from} → ${model.to} of ${model.positions}: front share of ` +
            `lateral load transfer ${a.toFixed(1)} % → ${b.toFixed(1)} %, roll gradient ${ra.toFixed(2)} → ` +
            `${rb.toFixed(2)} °/g.`,
        )}
      </Text>
      <Text style={styles.small}>{nb(model.note)}</Text>
      <TextLink href="/tools/vehicle" label="Open the vehicle model" arrow small />
    </View>
  );
}

// ---------- where the car limits the lap ----------

type Part = { label: string; seconds: number; color: string };

/** Seconds split into parts as one bar; the legend (with values) is left out where the parts are listed below it. */
function SplitBar({ parts, legend = true }: { parts: Part[]; legend?: boolean }) {
  const styles = useStyles();
  const shown = parts.filter((p) => p.seconds > 0);
  const total = shown.reduce((s, p) => s + p.seconds, 0);
  return (
    <View>
      <View style={styles.split}>
        {shown.map((p) => (
          // flex shares summing to under 1 would leave the bar short, so they are per cent of the total
          <View key={p.label} style={{ flex: (100 * p.seconds) / total, backgroundColor: p.color }} />
        ))}
      </View>
      {legend && (
        <View style={styles.legend}>
          {parts.map((p) => (
            <View key={p.label} style={styles.keyed}>
              <View style={[styles.key, { backgroundColor: p.color }]} />
              <Text style={styles.legendItem}>{p.label} {p.seconds.toFixed(2)} s</Text>
            </View>
          ))}
        </View>
      )}
    </View>
  );
}

function CarLimits({ r }: { r: BalanceReport }) {
  const styles = useStyles();
  const pal = usePalette();
  const { lap, sections, total_car } = r.car_limits;
  const rows = sections.filter((s) => s.car >= 0.03).sort((a, b) => b.car - a.car);
  const max = Math.max(...rows.map((s) => s.car), 0.01);
  const small = sections.length - rows.length;
  return (
    <View style={styles.section}>
      <Text style={styles.h2}>Where the car limits the lap</Text>
      <Text style={styles.body}>
        Fastest lap {formatTime(lap.reference)} against the theoretical {formatTime(lap.theoretical)}:{' '}
        {(lap.reference - lap.theoretical).toFixed(2)} s.
      </Text>
      <SplitBar
        parts={[
          { label: 'Driving', seconds: lap.driving, color: pal.reference },
          { label: 'Car', seconds: lap.car, color: pal.compare },
          { label: 'Theoretical', seconds: lap.optimism, color: pal.third },
        ]}
      />
      <Text style={styles.small}>{nb(r.car_limits.text)}</Text>

      {rows.length > 0 && (
        <>
          <Text style={styles.h3}>
            The car's share per section: {total_car.toFixed(2)} s in all
          </Text>
          {rows.map((s) => (
            <CarRow key={s.code} row={s} max={max} color={pal.compare} />
          ))}
          {small > 0 && (
            <Text style={styles.small}>
              {small} other section{small === 1 ? '' : 's'} under 0.03 s each, or already beating the realistic target.
            </Text>
          )}
        </>
      )}
    </View>
  );
}

function CarRow({ row, max, color }: { row: CarLimitRow; max: number; color: string }) {
  const styles = useStyles();
  return (
    <View style={styles.barRow}>
      <Text style={styles.barCode}>{row.code}</Text>
      <View style={styles.barTrack}>
        <View style={[styles.bar, { width: `${(row.car / max) * 100}%`, backgroundColor: color }]} />
        {row.where && <Text style={styles.barWhere}>{row.where}</Text>}
      </View>
      <Text style={styles.barValue}>{row.car.toFixed(2)} s</Text>
    </View>
  );
}

function FocusView({ focus }: { focus: Focus }) {
  const styles = useStyles();
  const pal = usePalette();
  const [cursor, setCursor] = useState<number | null>(null);
  const t = focus.trace;
  const distance = useMemo(() => t.distance_m.map((d) => d - focus.start_m), [t, focus.start_m]);
  const markers = useMemo(() => t.corners.map((c) => ({ at: c.at_m - focus.start_m, label: c.code })),
    [t, focus.start_m]);
  // the lines, kept from one move of the cursor to the next (zooming redraws only the part shown)
  const speed = useMemo(() => [
    { values: t.reference_speed, color: pal.reference },
    { values: t.best_speed, color: pal.compare },
    { values: t.held_speed, color: pal.third },
  ], [t, pal]);
  const corneringG = useMemo(() => [
    { values: t.reference_g, color: pal.reference },
    { values: t.best_g, color: pal.compare },
    { values: t.held_g, color: pal.third },
  ], [t, pal]);
  const colors = { driving: pal.reference, car: pal.compare, theoretical: pal.third };
  const laps = [
    { label: `Fastest lap (${lapName(focus.reference.lap)})`, color: pal.reference },
    { label: `Quickest pass (${lapName(focus.best.lap)})`, color: pal.compare },
    { label: 'Realistic target', color: pal.third },
  ];
  const gMax = Math.max(...t.reference_g, ...t.best_g, ...t.held_g);
  return (
    <View style={styles.section}>
      <Text style={styles.h2}>
        Why {focus.code} is {focus.total.toFixed(2)} s off the theoretical lap
      </Text>
      <SplitBar
        parts={[
          { label: 'Driving', seconds: focus.driving, color: pal.reference },
          { label: 'Car', seconds: focus.car, color: pal.compare },
          { label: 'Theoretical', seconds: focus.optimism, color: pal.third },
        ]}
        legend={false}
      />
      {focus.explain.map((e) => (
        <View key={e.part} style={styles.explain}>
          <View style={styles.keyed}>
            <View style={[styles.key, { backgroundColor: colors[e.part] }]} />
            <Text style={styles.explainHead}>
              {e.part[0].toUpperCase() + e.part.slice(1)} {e.seconds.toFixed(2)} s
            </Text>
          </View>
          <Text style={styles.body}>{nb(e.text)}</Text>
        </View>
      ))}
      <ZoomGroup reset={focus.code}>
        <View style={styles.legendRow}>
          <View style={styles.legend}>
            {laps.map((l) => (
              <View key={l.label} style={styles.keyed}>
                <View style={[styles.keyLine, { backgroundColor: l.color }]} />
                <Text style={styles.legendItem}>{l.label}</Text>
              </View>
            ))}
          </View>
          <ResetZoom reserve />
        </View>
        <TraceChart
          title={`Speed through ${focus.code}`}
          unit="km/h"
          distance={distance}
          series={speed}
          cursor={cursor}
          onCursor={setCursor}
          markers={markers}
          height={160}
        />
        <TraceChart
          title="Cornering g"
          unit="g"
          distance={distance}
          series={corneringG}
          cursor={cursor}
          onCursor={setCursor}
          markers={markers}
          domain={[0, Math.ceil(gMax * 10) / 10]}
          height={140}
        />
      </ZoomGroup>
      <Text style={styles.small}>
        Distance from the start of {focus.code}, {Math.round(focus.end_m - focus.start_m)} m in all. Hover over or
        touch a chart to read the values. {ZOOM_HINT}
      </Text>
    </View>
  );
}

// ---------- the balance ----------

function Chip({ cell, value }: { cell: Pick<BalanceCell, 'kind' | 'strength'> | null; value: number | null }) {
  const styles = useStyles();
  const pal = usePalette();
  if (cell == null || value == null) {
    return (
      <View style={[styles.chip, { backgroundColor: 'transparent' }]}>
        <Text style={styles.dim}>–</Text>
      </View>
    );
  }
  const bg =
    cell.kind === 'normal' || cell.strength == null
      ? pal.neutral
      : (cell.kind === 'understeer' ? pal.under : pal.over) + WASH[cell.strength];
  return (
    <View style={[styles.chip, { backgroundColor: bg }]}>
      <Text style={styles.chipValue}>{degrees(value)}</Text>
      <Text style={styles.chipWords}>{balanceWords(cell)}</Text>
    </View>
  );
}

function BalanceTable({ r }: { r: BalanceReport }) {
  const styles = useStyles();
  const tint = useThemeColor({}, 'tint');
  const [quick, setQuick] = useState(false);
  const b = r.balance;
  if (!b.sections.some((s) => s.entry || s.mid || s.exit)) {
    return (
      <View style={styles.section}>
        <Text style={styles.h2}>Balance</Text>
        <Text style={styles.body}>No steering or yaw rate channel to read the balance from.</Text>
      </View>
    );
  }
  const pick = (c: BalanceCell | null) => {
    if (!c) return { cell: null, value: null };
    if (!quick) return { cell: c, value: c.value };
    return c.quick == null ? { cell: null, value: null } : { cell: describe(c.quick), value: c.quick };
  };
  return (
    <View style={styles.section}>
      <Text style={styles.h2}>Balance per section</Text>
      <Text style={styles.small}>
        Steering against the car's normal at the same cornering g ({b.per_g?.toFixed(2)}° per g). Blue: understeer, the
        front pushes. Red: oversteer, the rear slides. Grey: within ±0.3° of normal.
      </Text>
      <View style={styles.toggle} accessibilityRole="tablist">
        {[
          { label: 'All clean laps', on: !quick },
          { label: 'Quickest passes', on: quick },
        ].map((o) => (
          <Pressable
            key={o.label}
            onPress={() => setQuick(o.label === 'Quickest passes')}
            {...(o.on ? null : noPrint)}
            accessibilityRole="tab"
            accessibilityState={{ selected: o.on }}
            style={styles.toggleHit}>
            <View style={[styles.toggleItem, o.on && { borderColor: tint }]}>
              <Text style={o.on ? { color: tint } : styles.toggleOff}>{o.label}</Text>
            </View>
          </Pressable>
        ))}
      </View>
      <View style={styles.tableHead}>
        <Text style={styles.thCode}>Section</Text>
        <Text style={styles.th}>Entry</Text>
        <Text style={styles.th}>Mid</Text>
        <Text style={styles.th}>Exit</Text>
      </View>
      {b.sections.map((s) => (
        <View key={s.code} style={styles.tableRow}>
          <View style={styles.codeCol}>
            <Text style={styles.code}>{s.code}</Text>
            <Text style={styles.small}>{Math.round(s.min_speed_kmh)} km/h</Text>
          </View>
          {(['entry', 'mid', 'exit'] as const).map((p) => {
            const { cell, value } = pick(s[p]);
            return <Chip key={p} cell={cell} value={value} />;
          })}
        </View>
      ))}

      {b.by_speed.length > 0 && (
        <>
          <Text style={styles.h3}>By corner speed, all clean laps</Text>
          {b.by_speed.map((row) => (
            <View key={row.speed} style={styles.tableRow}>
              <View style={styles.codeCol}>
                <Text style={styles.code}>{SPEED_LABEL[row.speed]}</Text>
                <Text style={styles.small}>
                  {row.range_kmh[0] === 0
                    ? `under ${row.range_kmh[1]}`
                    : row.range_kmh[1] >= 400
                      ? `over ${row.range_kmh[0]}`
                      : `${row.range_kmh[0]}–${row.range_kmh[1]}`}{' '}
                  km/h
                </Text>
              </View>
              {(['entry', 'mid', 'exit'] as const).map((p) => (
                <Chip key={p} cell={row[p]} value={row[p]?.value ?? null} />
              ))}
            </View>
          ))}
        </>
      )}
      {b.notes.map((n) => (
        <Text key={n} style={styles.note}>
          {nb(n)}
        </Text>
      ))}
    </View>
  );
}

function Method({ r }: { r: BalanceReport }) {
  const styles = useStyles();
  const m = r.method;
  const sr = m.steering_ratio;
  const wb = m.wheelbase_mm;
  const ratio =
    sr.value == null
      ? 'not known'
      : sr.range && sr.range[0] !== sr.range[1]
        ? `${sr.value.toFixed(1)} (${sr.range[0].toFixed(1)}–${sr.range[1].toFixed(1)})`
        : sr.value.toFixed(1);
  const skipped = r.sessions.filter((s) => s.note);
  return (
    <View style={styles.section}>
      <Text style={styles.h2}>How it is measured</Text>
      <View style={styles.checks}>
        <Fact label="Steering ratio" value={ratio} reads={sr.reads} source={sr.source} estimate={sr.confidence} />
        <Fact
          label="Wheelbase"
          value={wb.value == null ? 'not known' : `${Math.round(wb.value)} mm`}
          reads={wb.reads}
          source={wb.source}
          estimate={wb.confidence}
        />
        {m.yaw_scale && (
          <Fact
            label="Yaw gyro scale"
            value={
              m.yaw_scale[0] === m.yaw_scale[1]
                ? m.yaw_scale[0].toFixed(3)
                : `${m.yaw_scale[0].toFixed(3)}–${m.yaw_scale[1].toFixed(3)}`
            }
            reads="measured in these logs"
            source="against the accelerometer in steady corners"
            estimate="measured"
          />
        )}
      </View>
      {m.notes.map((n) => (
        <Text key={n} style={styles.small}>
          • {nb(n)}
        </Text>
      ))}
      <Text style={styles.small}>
        {r.sessions.length === 1 ? 'One run' : `${r.sessions.length} runs`}, {r.laps} clean laps.
        {skipped.map((s) => ` ${s.name}: ${s.note}.`).join('')}
      </Text>
    </View>
  );
}

function Fact({ label, value, reads, source, estimate }: {
  label: string; value: string; reads: string; source: string; estimate: string;
}) {
  const styles = useStyles();
  const flagged = estimate === 'estimate' || estimate === 'unknown';
  return (
    <View style={styles.check}>
      <Text style={styles.checkLabel}>{label}</Text>
      <Text style={styles.checkValue}>{value}</Text>
      <Text style={flagged ? styles.flag : styles.small}>{reads}</Text>
      <Text style={styles.small}>{source}</Text>
    </View>
  );
}

function formatTime(s: number): string {
  const m = Math.floor(s / 60);
  const rest = s - 60 * m;
  return m ? `${m}:${rest.toFixed(3).padStart(6, '0')}` : rest.toFixed(3);
}

const useStyles = themed((c) => ({
  root: { gap: 12 },
  busy: { flexDirection: 'row', gap: 8, alignItems: 'center' },
  h1: { fontSize: 20, fontWeight: '700' },
  h2: { ...Type.label, fontSize: 13, color: c.text, borderTopWidth: 3, borderColor: c.rule, paddingTop: 6, marginTop: 12 },
  h3: { ...Type.label, color: c.text, marginTop: 8 },
  headline: { fontFamily: Fonts.body, fontSize: 19, lineHeight: 25, fontWeight: '600', color: c.text },
  section: { gap: 10, marginTop: 12 },
  body: { lineHeight: 20 },
  note: { lineHeight: 20, opacity: 0.85 },
  small: { fontFamily: Fonts.label, fontSize: 12, lineHeight: 16, color: c.textMuted },
  dim: { opacity: 0.6 },
  flag: { fontSize: 12, lineHeight: 17, fontWeight: '700' },
  error: { color: c.error },
  card: { gap: 8, borderTopWidth: 3, borderColor: c.rule, paddingTop: 10 },
  cardHead: { flexDirection: 'row', gap: 10, alignItems: 'baseline' },
  cardNumber: { fontFamily: Fonts.display, fontSize: 20, lineHeight: 22, color: c.background, backgroundColor: c.rule, paddingHorizontal: 7, paddingTop: 3 },
  cardTitle: { fontFamily: Fonts.body, fontSize: 18, lineHeight: 24, fontWeight: '600', flexShrink: 1, color: c.text },
  labelled: { gap: 2 },
  label: { ...Type.label, fontSize: 11, color: c.textSecondary },
  model: { gap: 4, borderTopWidth: 1, borderColor: c.separator, paddingTop: 8 },
  split: { flexDirection: 'row', height: 14, gap: 2, overflow: 'hidden' },
  legend: { flexDirection: 'row', flexWrap: 'wrap', columnGap: 16, rowGap: 4, marginTop: 6, flexShrink: 1 },
  legendRow: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'flex-end',
    gap: 8 },
  legendItem: { fontSize: 13, fontVariant: ['tabular-nums'] },
  // a legend's colour key: a flat square (a short line for a line), its words in the text's own ink beside it
  keyed: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: 'transparent' },
  key: { width: 10, height: 10 },
  keyLine: { width: 16, height: 3 },
  barRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  barCode: { width: 64, fontWeight: '600', fontVariant: ['tabular-nums'] },
  barTrack: { flex: 1, gap: 2 },
  bar: { height: 10 },
  barWhere: { fontSize: 11, opacity: 0.6 },
  barValue: { width: 52, textAlign: 'right', fontVariant: ['tabular-nums'] },
  explain: { gap: 2 },
  explainHead: { fontWeight: '600', fontVariant: ['tabular-nums'] },
  // the two views: 44 px tap targets around their underlined names, the one not shown in the caption grey
  toggle: { flexDirection: 'row', gap: 8 },
  toggleHit: { minWidth: TAP, marginRight: 6, ...tapRoom(12) },
  toggleItem: { borderBottomWidth: 3, borderColor: 'transparent', paddingBottom: 2, backgroundColor: 'transparent' },
  toggleOff: { color: c.textMuted },
  tableHead: { flexDirection: 'row', gap: 4 },
  th: { ...Type.label, flex: 1, fontSize: 11, color: c.textSecondary },
  tableRow: { flexDirection: 'row', gap: 4, alignItems: 'stretch' },
  codeCol: { width: 72, flexGrow: 0, flexShrink: 0, justifyContent: 'center' },
  thCode: { ...Type.label, width: 72, flexGrow: 0, flexShrink: 0, fontSize: 11, color: c.textSecondary },
  code: { fontWeight: '600', fontVariant: ['tabular-nums'] },
  chip: { flex: 1, paddingHorizontal: 6, paddingVertical: 4, justifyContent: 'center' },
  chipValue: { fontWeight: '600', fontVariant: ['tabular-nums'] },
  chipWords: { fontSize: 11, lineHeight: 14 },
  checks: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  check: { gap: 2, minWidth: 150, flexGrow: 1, flexBasis: 150, borderTopWidth: 3, borderColor: c.rule, paddingTop: 10 },
  checkLabel: { ...Type.label, fontSize: 11, color: c.textSecondary },
  checkValue: { fontFamily: Fonts.display, fontSize: 26, lineHeight: 30, color: c.text },
}));

export default Balance;
