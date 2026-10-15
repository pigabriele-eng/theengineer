// A stint's balance shift, shared by the Stint analysis page (app/tools/stint.tsx) and the weekend's Stint analysis tab
// (components/weekend/StintTab.tsx): corner by corner, the balance on the stint's early laps against its late laps in
// one phase (entry, mid-corner, exit); and lap by lap, the whole lap's balance in that phase beside one corner's
// (Gabriele, 2026-10-15: "balance shift throughout stint").
import { useState } from 'react';

import { Tabs, useText } from '@/components/Picks';
import { LineChart, useChartColors } from '@/components/ReportCharts';
import { BalanceDumbbell, MIN_SHIFT, OnCorner, ShiftRow } from '@/components/StintCharts';
import { Text, View } from '@/components/Themed';
import { BalancePhase, SectionRow, signed, Stint } from '@/lib/stint';
import { PHASE_LABEL } from '@/lib/stintTab';
import { themed } from '@/constants/Theme';

export const PHASE_TABS: { key: BalancePhase; label: string }[] = [
  { key: 'entry', label: 'Entry' },
  { key: 'mid', label: 'Mid-corner' },
  { key: 'exit', label: 'Exit' },
];

function median(v: number[]) {
  const s = [...v].sort((a, b) => a - b);
  return s.length === 0 ? null : s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
}

/** The balance shift per corner in one phase, picked with tabs: the whole lap first, then every corner, early laps
 * against late laps (a dumbbell). The phase is its own, or `phase` and `onPhase` when the page shares it. */
export function CornerShift({ sections, stints, onCorner, phase: shared, onPhase }: {
  sections: SectionRow[]; stints: Stint[]; onCorner?: OnCorner; phase?: BalancePhase;
  onPhase?: (p: BalancePhase) => void;
}) {
  const styles = useStyles();
  const tx = useText();
  const [own, setOwn] = useState<BalancePhase>('entry');
  const phase = shared ?? own;
  const setPhase = onPhase ?? setOwn;
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
      <Tabs value={phase} onChange={setPhase} items={PHASE_TABS} />
      {rows.length === 0 ? (
        <Text style={tx.note}>
          Not enough flying laps for an early and a late group (it takes 4 in a stint), or no steering and yaw rate to
          read the balance from.
        </Text>
      ) : (
        <>
          <Text style={tx.note}>
            {moved === 0 ? 'Every corner holds within ±0.15°.' : `${moved} of ${rows.length - (rows[0]?.strong ? 1 : 0)
            } corners move more than ${MIN_SHIFT}°.`}
          </Text>
          <View style={styles.narrow}>
            <BalanceDumbbell rows={rows} early={earlyLaps} late={lateLaps} onCorner={onCorner} />
          </View>
        </>
      )}
    </View>
  );
}

/** One phase's balance lap by lap through the stint, on the laps in the trend: the whole lap's, and one corner's
 * (picked with tabs, the corners that have a balance in this phase) with how its trend stands against the scatter. */
export function BalanceLaps({ stint, phase, corner, onCorner }: {
  stint: Stint; phase: BalancePhase; corner: string | null; onCorner: (code: string) => void;
}) {
  const styles = useStyles();
  const tx = useText();
  const c = useChartColors();
  const laps = stint.laps.filter((l) => l.in_fit);
  const by = stint.balance_laps;
  const corners = (by?.corners ?? []).filter((k) => k[phase]?.values.some((v) => v != null));
  const picked = corners.find((k) => k.code === corner) ?? null;
  const at = new Map((by?.laps ?? []).map((n, i) => [n, i]));
  const x = laps.map((l) => l.lap);
  const whole = laps.map((l) => l.balance?.[phase] ?? null);
  const own = picked ? laps.map((l) => picked[phase]?.values[at.get(l.lap) ?? -1] ?? null) : null;
  if (x.length < 2 || whole.every((v) => v == null)) return null;
  const t = picked?.[phase]?.trend;
  const name = PHASE_LABEL[phase].toLowerCase();
  return (
    <View style={styles.block}>
      {corners.length > 0 && (
        <Tabs label="Corner" value={picked?.code ?? null} onChange={(k) => k != null && onCorner(k)}
          items={corners.map((k) => ({ key: k.code as string | null, label: k.code }))} />
      )}
      <LineChart x={x} height={180} unit="lap" formatX={(v) => `L${v}`} formatY={(v) => signed(v, 1)}
        title={`${picked ? `${picked.code} and the whole lap` : 'The whole lap'}: ${name} balance, ° against normal (+ understeer)`}
        series={[{ key: 'whole', label: 'Whole lap', values: whole, color: c.s1 },
          ...(picked && own ? [{ key: 'corner', label: picked.code, values: own, color: c.s2 }] : [])]}
        legend={[{ label: `Whole lap, ${name}`, color: c.s1 },
          ...(picked ? [{ label: `${picked.code}, ${name}`, color: c.s2 }] : [])]}
        readout={(i) => [{ label: 'whole lap', value: `${signed(whole[i])}°`, color: c.s1 },
          ...(picked && own ? [{ label: picked.code, value: own[i] == null ? '–' : `${signed(own[i])}°`,
            color: c.s2 }] : [])]} />
      {picked && t && (
        <Text style={tx.note}>
          {`${picked.code} ${name}, by the trend through every lap: ${signed(t.change)}° from lap ${x[0]} to lap ${
            x[x.length - 1]}, ${t.clear ? 'a clear trend, bigger than the lap-to-lap scatter'
            : `within the lap-to-lap scatter (±${t.within.toFixed(2)}° a lap): a lean to watch, not a sure change`}.`}
        </Text>
      )}
    </View>
  );
}

const useStyles = themed(() => ({
  narrow: { maxWidth: 760, backgroundColor: 'transparent' },
  block: { gap: 14, backgroundColor: 'transparent' },
}));
