// The report's car balance section: how the car is balanced, per section and by corner speed, on entry, mid-corner
// and exit, and how it is measured. For one session or a whole event. No setup advice: GET /report/balance also
// carries the setup changes to try (headline, recommendations, notes, checks), but those are the setup tool's, on
// demand, and are never shown in a report.
import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable } from 'react-native';

import { Text, View, useThemeColor } from '@/components/Themed';
import { useColorScheme } from '@/components/useColorScheme';
import {
  BalanceCell,
  BalanceReport,
  balanceWords,
  degrees,
  fetchBalance,
  SPEED_LABEL,
  Strength,
} from '@/lib/balance';
import { quickestLapsLine } from '@/lib/grip';
import { noPrint } from '@/lib/print';
import { byScheme, Fonts, TAP, tapRoom, themed, Type } from '@/constants/Theme';

// bare: inside a report section that already names it, so without its own heading
type Props = { session?: number; event?: number; bare?: boolean };

// Validated chart palette: the diverging pair for balance (blue: understeer, red: oversteer, grey: normal), light
// and dark steps.
const PALETTE = byScheme((c) => ({ under: c.balance.under, over: c.balance.over, neutral: c.chart.mid }));
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
      {!bare && <Text style={styles.h1}>Car balance</Text>}
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
      <BalanceTable r={r} />

      <Method r={r} />
    </>
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

// The method notes that are about the setup advice (server/app/analysis/setup_advice.py method()), left out here
const ADVICE_NOTES = ['Bar changes are run through', 'Read from the data alone'];

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
      {m.notes.filter((n) => !ADVICE_NOTES.some((a) => n.startsWith(a))).map((n) => (
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

const useStyles = themed((c) => ({
  root: { gap: 12 },
  busy: { flexDirection: 'row', gap: 8, alignItems: 'center' },
  h1: { fontSize: 20, fontWeight: '700' },
  h2: { ...Type.label, fontSize: 13, color: c.text, borderTopWidth: 3, borderColor: c.rule, paddingTop: 6, marginTop: 12 },
  h3: { ...Type.label, color: c.text, marginTop: 8 },
  section: { gap: 10, marginTop: 12 },
  body: { lineHeight: 20 },
  note: { lineHeight: 20, opacity: 0.85 },
  small: { fontFamily: Fonts.label, fontSize: 12, lineHeight: 16, color: c.textMuted },
  dim: { opacity: 0.6 },
  flag: { fontSize: 12, lineHeight: 17, fontWeight: '700' },
  error: { color: c.error },
  // the two views: 44 px tap targets around their underlined names, the one not shown in the caption grey
  toggle: { flexDirection: 'row', gap: 8 },
  toggleHit: { minWidth: TAP, marginRight: 6, ...tapRoom(13) },
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
