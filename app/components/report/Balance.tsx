// The report's car balance and setup direction section, advice first: the setup changes to try (each with its
// reason and expected effect), where the car rather than the driver limits the lap and by how much, then the
// balance per section on entry, mid-corner and exit. For one session or a whole event.
import { Link } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet } from 'react-native';

import { Text, View, useThemeColor } from '@/components/Themed';
import { SERIES, TraceChart } from '@/components/TraceChart';
import { useColorScheme } from '@/components/useColorScheme';
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

type Props = { session?: number; event?: number };

// Validated chart palette: categorical slots 1-3 (driving, car, theoretical; and the three laps in the focus charts),
// and the diverging pair for balance (blue: understeer, red: oversteer, grey: normal), light and dark steps.
const PALETTE = {
  light: { ...SERIES.light, third: '#1baf7a', under: '#2a78d6', over: '#e34948', neutral: '#f0efec' },
  dark: { ...SERIES.dark, third: '#199e70', under: '#3987e5', over: '#e66767', neutral: '#383835' },
};
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

export function Balance({ session, event }: Props) {
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
      <Text style={styles.h1}>Car balance and setup</Text>
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
  return (
    <View style={styles.labelled}>
      <Text style={styles.label}>{label}</Text>
      <Text style={styles.body}>{nb(text)}</Text>
    </View>
  );
}

function ModelLine({ model }: { model: BarModel }) {
  const tint = useThemeColor({}, 'tint');
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
      <Link href="/tools/vehicle" style={{ ...styles.link, color: tint }}>
        Open the vehicle model
      </Link>
    </View>
  );
}

// ---------- where the car limits the lap ----------

type Part = { label: string; seconds: number; color: string };

/** Seconds split into parts as one bar; the legend (with values) is left out where the parts are listed below it. */
function SplitBar({ parts, legend = true }: { parts: Part[]; legend?: boolean }) {
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
            <Text key={p.label} style={styles.legendItem}>
              <Text style={{ color: p.color }}>■</Text> {p.label} {p.seconds.toFixed(2)} s
            </Text>
          ))}
        </View>
      )}
    </View>
  );
}

function CarLimits({ r }: { r: BalanceReport }) {
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
  const pal = usePalette();
  const [cursor, setCursor] = useState<number | null>(null);
  const t = focus.trace;
  const distance = t.distance_m.map((d) => d - focus.start_m);
  const markers = t.corners.map((c) => ({ at: c.at_m - focus.start_m, label: c.code }));
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
          <Text style={styles.explainHead}>
            <Text style={{ color: colors[e.part] }}>■</Text> {e.part[0].toUpperCase() + e.part.slice(1)}{' '}
            {e.seconds.toFixed(2)} s
          </Text>
          <Text style={styles.body}>{nb(e.text)}</Text>
        </View>
      ))}
      <View style={styles.legend}>
        {laps.map((l) => (
          <Text key={l.label} style={styles.legendItem}>
            <Text style={{ color: l.color }}>━</Text> {l.label}
          </Text>
        ))}
      </View>
      <TraceChart
        title={`Speed through ${focus.code}`}
        unit="km/h"
        distance={distance}
        series={[
          { values: t.reference_speed, color: pal.reference },
          { values: t.best_speed, color: pal.compare },
          { values: t.held_speed, color: pal.third },
        ]}
        cursor={cursor}
        onCursor={setCursor}
        markers={markers}
        height={160}
      />
      <TraceChart
        title="Cornering g"
        unit="g"
        distance={distance}
        series={[
          { values: t.reference_g, color: pal.reference },
          { values: t.best_g, color: pal.compare },
          { values: t.held_g, color: pal.third },
        ]}
        cursor={cursor}
        onCursor={setCursor}
        markers={markers}
        domain={[0, Math.ceil(gMax * 10) / 10]}
        height={140}
      />
      <Text style={styles.small}>
        Distance from the start of {focus.code}, {Math.round(focus.end_m - focus.start_m)} m in all. Drag across a
        chart to read the values.
      </Text>
    </View>
  );
}

// ---------- the balance ----------

function Chip({ cell, value }: { cell: Pick<BalanceCell, 'kind' | 'strength'> | null; value: number | null }) {
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
      <View style={styles.toggle}>
        {[
          { label: 'All clean laps', on: !quick },
          { label: 'Quickest passes', on: quick },
        ].map((o) => (
          <Pressable
            key={o.label}
            onPress={() => setQuick(o.label === 'Quickest passes')}
            style={[styles.toggleItem, o.on && { borderColor: tint }]}>
            <Text style={o.on ? { color: tint } : styles.dim}>{o.label}</Text>
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

const styles = StyleSheet.create({
  root: { gap: 12 },
  busy: { flexDirection: 'row', gap: 8, alignItems: 'center' },
  h1: { fontSize: 20, fontWeight: '700' },
  h2: { fontSize: 18, fontWeight: '700' },
  h3: { fontSize: 15, fontWeight: '600', marginTop: 8 },
  headline: { fontSize: 16, lineHeight: 23, fontWeight: '500' },
  section: { gap: 10, marginTop: 12 },
  body: { lineHeight: 20 },
  note: { lineHeight: 20, opacity: 0.85 },
  small: { fontSize: 12, lineHeight: 17, opacity: 0.65 },
  dim: { opacity: 0.6 },
  flag: { fontSize: 12, lineHeight: 17, fontWeight: '700' },
  error: { color: '#c8372d' },
  card: { borderWidth: 1, borderColor: '#8884', borderRadius: 12, padding: 12, gap: 8 },
  cardHead: { flexDirection: 'row', gap: 10, alignItems: 'baseline' },
  cardNumber: { fontSize: 16, fontWeight: '700', opacity: 0.5, fontVariant: ['tabular-nums'] },
  cardTitle: { fontSize: 16, fontWeight: '700', flexShrink: 1 },
  labelled: { gap: 2 },
  label: { fontSize: 11, fontWeight: '600', opacity: 0.6, textTransform: 'uppercase', letterSpacing: 0.5 },
  model: { gap: 4, borderTopWidth: 1, borderColor: '#8883', paddingTop: 8 },
  link: { fontWeight: '600', marginTop: 2 },
  split: { flexDirection: 'row', height: 14, gap: 2, borderRadius: 4, overflow: 'hidden' },
  legend: { flexDirection: 'row', flexWrap: 'wrap', columnGap: 16, rowGap: 4, marginTop: 6 },
  legendItem: { fontSize: 13, fontVariant: ['tabular-nums'] },
  barRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  barCode: { width: 64, fontWeight: '600', fontVariant: ['tabular-nums'] },
  barTrack: { flex: 1, gap: 2 },
  bar: { height: 10, borderTopRightRadius: 4, borderBottomRightRadius: 4 },
  barWhere: { fontSize: 11, opacity: 0.6 },
  barValue: { width: 52, textAlign: 'right', fontVariant: ['tabular-nums'] },
  explain: { gap: 2 },
  explainHead: { fontWeight: '600', fontVariant: ['tabular-nums'] },
  toggle: { flexDirection: 'row', gap: 8 },
  toggleItem: { borderWidth: 1, borderColor: '#8884', borderRadius: 12, paddingHorizontal: 12, paddingVertical: 5 },
  tableHead: { flexDirection: 'row', gap: 4 },
  th: { flex: 1, fontSize: 12, fontWeight: '600', opacity: 0.6 },
  tableRow: { flexDirection: 'row', gap: 4, alignItems: 'stretch' },
  codeCol: { width: 72, flexGrow: 0, flexShrink: 0, justifyContent: 'center' },
  thCode: { width: 72, flexGrow: 0, flexShrink: 0, fontSize: 12, fontWeight: '600', opacity: 0.6 },
  code: { fontWeight: '600', fontVariant: ['tabular-nums'] },
  chip: { flex: 1, borderRadius: 6, paddingHorizontal: 6, paddingVertical: 4, justifyContent: 'center' },
  chipValue: { fontWeight: '600', fontVariant: ['tabular-nums'] },
  chipWords: { fontSize: 11, lineHeight: 14 },
  checks: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  check: { gap: 2, minWidth: 150, flexGrow: 1, flexBasis: 150, borderWidth: 1, borderColor: '#8883', borderRadius: 10,
    padding: 10 },
  checkLabel: { fontSize: 12, opacity: 0.65 },
  checkValue: { fontSize: 17, fontWeight: '600', fontVariant: ['tabular-nums'] },
});

export default Balance;
