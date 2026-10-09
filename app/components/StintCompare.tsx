// The stint tool's "Compare stints" tab: two stints side by side, to see whether a setup change worked (Gabriele,
// 2026-10-09: "in the stint analysis, add stint comparison to validate setup changes"). The stint before the change
// and the stint after it (the latest stint against the one before it to start with, by the same driver on the same
// tyres where there is one): what the setup sheets say changed, how like with like the two are, the lap time with
// each lap on one tyre age and fuel load, grip and balance by phase, the corners where the balance moved, the tyre
// fade and the driver aids (GET /stint/compare, server/app/routers/stint_compare.py).
import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet } from 'react-native';

import { Choice, Choices } from '@/components/Controls';
import { FigRow, useText } from '@/components/Picks';
import { Fig, Label, Section, TextLink, useWide } from '@/components/Programme';
import { LineChart, useChartColors } from '@/components/ReportCharts';
import { OnCorner } from '@/components/StintCharts';
import { Text, View } from '@/components/Themed';
import { face, TAP, themed, useTheme } from '@/constants/Theme';
import { formatLap } from '@/lib/api';
import { signed } from '@/lib/stint';
import { balanceWords, CompareChoice, Diff, fetchStintCompare, PHASE_WORDS, StintCompare } from '@/lib/stintCompare';

type Pick = { files: string; a: string; b: string }; // picked among these logs' stints

export default function StintCompareView({ files, refresh, others, onAdd, codes, focus, onCorner }: {
  files: number[]; // the ticked logs: their stints are the ones to pick from
  refresh: unknown; // changes when the stints are read again (a lap tagged)
  others: { fileId: number; name: string }[]; // runs of the event not ticked: one tap adds one
  onAdd: (fileId: number) => void;
  codes: string[]; // the corners a text may name
  focus: string | null;
  onCorner?: OnCorner;
}) {
  const styles = useStyles();
  const tx = useText();
  const theme = useTheme();
  const wide = useWide();
  const [picked, setPick] = useState<Pick | null>(null);
  const [data, setData] = useState<StintCompare | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const key = files.join(',');
  const pick = picked && picked.files === key ? picked : null; // other logs: the suggested pair again

  useEffect(() => {
    if (files.length === 0) return;
    let live = true;
    setBusy(true);
    setError(null);
    fetchStintCompare(files, pick?.a, pick?.b)
      .then((d) => live && setData(d))
      .catch((e) => {
        if (!live) return;
        setData(null);
        setError((e as Error).message);
      })
      .finally(() => live && setBusy(false));
    return () => {
      live = false;
    };
  }, [key, refresh, pick?.a, pick?.b]); // eslint-disable-line react-hooks/exhaustive-deps

  const choose = (side: 'a' | 'b', k: string) => {
    if (!data) return;
    const now = { a: data.picked.a, b: data.picked.b };
    const other = side === 'a' ? 'b' : 'a';
    // the other side's stint swaps over
    const next = now[other] === k ? { ...now, [side]: k, [other]: now[side] } : { ...now, [side]: k };
    setPick({ files: key, ...next });
  };

  const add = others.length > 0 && (
    <View style={styles.block}>
      <Label small>Add a run to compare</Label>
      <Choices>
        {others.map((o) => <Choice key={o.fileId} add label={`+ ${o.name}`} on={false} onPress={() => onAdd(o.fileId)} />)}
      </Choices>
    </View>
  );

  if (!data) {
    return (
      <Section no={1} title="Compare two stints"
        dek="Did a setup change work? The stint before it against the stint after it, like with like.">
        <View style={styles.block}>
          {busy && (
            <View style={styles.busy}>
              <ActivityIndicator color={theme.text} />
              <Text style={tx.note}>Comparing…</Text>
            </View>
          )}
          {!busy && error && <Text style={tx.body}>{error}</Text>}
          {add}
        </View>
      </Section>
    );
  }

  const { a, b, lap_time: time } = data;
  const names = { a: a.name, b: b.name };
  const barOf = (d: number | null) =>
    d == null || Math.abs(d) < 0.005 ? theme.rule : d > 0 ? theme.delta.loss : theme.delta.gain;
  let no = 0;
  const next = () => ++no;

  return (
    <>
      <Section no={next()} title="Compare two stints"
        dek="Did a setup change work? The stint before it against the stint after it, like with like.">
        <View style={styles.block}>
          <Picker label="Before the change" choices={data.choices} on={data.picked.a}
            onPick={(k) => choose('a', k)} />
          <Picker label="After the change" choices={data.choices} on={data.picked.b}
            onPick={(k) => choose('b', k)} />
          {data.picked.default && data.picked.why && (
            <Text style={tx.note}>Picked to start with: {data.picked.why.charAt(0).toLowerCase() + data.picked.why.slice(1)}</Text>
          )}
          {add}
          {busy && (
            <View style={styles.busy}>
              <ActivityIndicator color={theme.text} />
              <Text style={tx.note}>Updating…</Text>
            </View>
          )}
          {error && <Text style={tx.error}>{error}</Text>}

          <Text style={StyleSheet.flatten([styles.headline, wide ? null : styles.headlinePhone])}>
            {data.words.headline}
          </Text>
          {time && (
            <FigRow style={styles.figs}>
              {[
                <Fig key="gap" label="Lap time" value={signed(time.change, 2)} unit="s/lap" size={wide ? 52 : 38}
                  bar={barOf(time.change)} barHeight={6}
                  note={time.clear ? 'a clear difference' : `within ±${time.within.toFixed(2)} s`} />,
                <Fig key="a" label={names.a} value={formatLap(time.a)} size={wide ? 40 : 30}
                  note={`typical · best ${formatLap(time.best.a)}`} />,
                <Fig key="b" label={names.b} value={formatLap(time.b)} size={wide ? 40 : 30}
                  note={`typical · best ${formatLap(time.best.b)}`} />,
              ]}
            </FigRow>
          )}
          {data.words.car.length > 0 && (
            <View style={styles.list}>
              <Text style={tx.sub}>The car</Text>
              {data.words.car.map((s) => <Bullet key={s} text={s} />)}
            </View>
          )}
        </View>
      </Section>

      <Section no={next()} title="What changed on the car"
        dek={`From ${names.a} to ${names.b}, as their setup sheets say.`}>
        <SetupChanges data={data} />
      </Section>

      <Section no={next()} title="Like with like"
        dek="A setup change shows best with the same driver, on the same tyres, in the same session.">
        <View style={styles.block}>
          {data.like_for_like.map((c) => (
            <View key={c.text} style={styles.check}>
              <Text style={StyleSheet.flatten([styles.mark, !c.ok && styles.markOff])}
                accessibilityLabel={c.ok ? 'Like with like' : 'Not like with like'}>{c.ok ? '✓' : '≠'}</Text>
              <Text style={StyleSheet.flatten([tx.body, styles.flex])}>{c.text}</Text>
            </View>
          ))}
          {data.correction.words.map((w) => <Text key={w} style={tx.body}>{w}</Text>)}
        </View>
      </Section>

      {a.times.length >= 2 && b.times.length >= 2 && (
        <Section no={next()} title="Lap times"
          dek={`Each lap in the trend by its lap in the stint${data.correction.tyres || data.correction.fuel
            ? ', on one tyre age and fuel load' : ''}, in seconds against ${names.a}'s typical lap.`}>
          <LapTimes data={data} />
        </Section>
      )}

      {data.phases.length > 0 && (
        <Section no={next()} title="Grip and balance by phase"
          dek={`The mean over each stint's laps in the trend. Balance: the understeer angle against the car's normal at the same cornering g, + understeer, − oversteer. "Not clear": within the lap-to-lap scatter.`}>
          <View style={styles.block}>
            {data.phases.map((p) => (
              <View key={p.key} style={styles.phase}>
                <Text style={tx.sub}>{p.label}</Text>
                {p.grip && (
                  <Row label="Grip" text={`${p.grip.a.toFixed(2)} → ${p.grip.b.toFixed(2)} g`}
                    change={`${p.grip.pct != null ? `${p.grip.pct > 0 ? '+' : p.grip.pct < 0 ? '−' : ''}${Math.abs(p.grip.pct).toFixed(1)} %` : signed(p.grip.change, 3)}`}
                    d={p.grip} />
                )}
                {p.balance && (
                  <Row label="Balance" text={`${deg(p.balance.a)} → ${deg(p.balance.b)}`}
                    change={Math.abs(p.balance.change) < 0.05 ? 'the same' : balanceWords(p.balance.change)}
                    d={p.balance} />
                )}
              </View>
            ))}
          </View>
        </Section>
      )}

      {data.corners.length > 0 && (
        <Section no={next()} title="Corners where the balance moved"
          dek={`Each stint's early and late laps in that corner: fewer laps than the figures above, so only big moves show.${
            onCorner ? ' Tap one to see it on the map.' : ''}`}>
          <View>
            {data.corners.map((c) => {
              const text = `${c.code} ${PHASE_WORDS[c.phase]}: ${balanceWords(c.change)} (${deg(c.a)} → ${deg(c.b)})`;
              if (!onCorner) return <Text key={`${c.code}${c.phase}`} style={tx.body}>{text}</Text>;
              const on = codes.includes(c.code) && focus === c.code;
              return (
                <Pressable key={`${c.code}${c.phase}`} onPress={() => onCorner(on ? null : c.code)}
                  accessibilityRole="button" accessibilityLabel={`${text}. Show ${c.code} on the track map`}
                  style={StyleSheet.flatten([styles.corner, on && styles.cornerOn])}>
                  <Text style={StyleSheet.flatten([tx.body, styles.flex])}>{text}</Text>
                </Pressable>
              );
            })}
          </View>
        </Section>
      )}

      {(data.fade || data.aids.length > 0) && (
        <Section no={next()} title="Tyres and driver aids">
          <View style={styles.block}>
            {data.fade && (
              <Text style={tx.body}>
                Lap time lost each lap on the set{data.fade.a.fuel_out && data.fade.b.fuel_out ? ' (fuel burn taken out)' : ''}:
                {' '}{signed(data.fade.a.per_lap, 3)} s on {names.a}, {signed(data.fade.b.per_lap, 3)} s on {names.b}.
              </Text>
            )}
            {data.aids.map((x) => (
              <Row key={x.key} label={x.label} text={`${x.a.toFixed(1)} → ${x.b.toFixed(1)} s a lap`}
                change={signed(x.change, 1)} d={x} />
            ))}
          </View>
        </Section>
      )}
    </>
  );
}

const deg = (v: number) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(1)}°`;

function Picker({ label, choices, on, onPick }: { label: string; choices: CompareChoice[]; on: string;
  onPick: (k: string) => void }) {
  const styles = useStyles();
  return (
    <View style={styles.picker}>
      <Label small>{label}</Label>
      <Choices>
        {choices.map((c) => (
          <Choice key={c.key} label={c.name} on={c.key === on} onPress={() => onPick(c.key)}
            sub={[c.driver ?? 'driver?', c.tyres_label ? `${c.tyres_label}${c.tyres_sure ? '' : '?'}` : null,
              `${c.laps} lap${c.laps === 1 ? '' : 's'}`].filter(Boolean).join(' · ')} />
        ))}
      </Choices>
    </View>
  );
}

function SetupChanges({ data }: { data: StintCompare }) {
  const styles = useStyles();
  const tx = useText();
  const { setup, a, b } = data;
  const session = { [a.name]: a.session_id, [b.name]: b.session_id };
  if (setup.same_run) {
    return (
      <Text style={tx.body}>
        Both stints are from one run: a change made at the stop isn't on a setup sheet, as a run has one sheet.
      </Text>
    );
  }
  return (
    <View style={styles.block}>
      {setup.changes.map((c) => (
        <View key={c.key} style={styles.bullet}>
          <View style={styles.bulletMark} />
          <Text style={StyleSheet.flatten([tx.body, styles.flex])}>{c.text}</Text>
        </View>
      ))}
      {setup.tried.map((t) => <Text key={t} style={tx.body}>Tried on {b.name}: {t}.</Text>)}
      {setup.a_sheet && setup.b_sheet && setup.changes.length === 0 && setup.tried.length === 0 && (
        <Text style={tx.body}>The two setup sheets are the same: nothing changed on the car, as far as they say.</Text>
      )}
      {setup.missing.map((n) => (
        <View key={n} style={styles.missing}>
          <Text style={tx.body}>No setup sheet for {n}.</Text>
          <TextLink small label={`Log ${n}'s setup`}
            href={{ pathname: '/tools/setup', params: { session: session[n], tab: 'sheet' } }} />
        </View>
      ))}
    </View>
  );
}

function Row({ label, text, change, d }: { label: string; text: string; change: string; d: Diff }) {
  const styles = useStyles();
  const tx = useText();
  return (
    <View style={styles.row}>
      <Text style={StyleSheet.flatten([tx.label, styles.rowLabel])}>{label}</Text>
      <Text style={StyleSheet.flatten([tx.body, styles.flex])}>
        {text}: <Text style={tx.strong}>{change}</Text>
        {d.clear ? '' : ` · not clear (±${d.within.toFixed(d.within < 0.1 ? 2 : 1)})`}
      </Text>
    </View>
  );
}

function Bullet({ text }: { text: string }) {
  const styles = useStyles();
  const tx = useText();
  return (
    <View style={styles.bullet}>
      <View style={styles.bulletMark} />
      <Text style={StyleSheet.flatten([tx.body, styles.flex])}>{text}</Text>
    </View>
  );
}

function LapTimes({ data }: { data: StintCompare }) {
  const c = useChartColors();
  const { a, b } = data;
  const x = [...new Set([...a.times, ...b.times].map((r) => r.tyre_lap))].sort((p, q) => p - q);
  const ref = data.lap_time?.a ?? a.times[0].corrected;
  const at = (rows: StintCompare['a']['times']) => {
    const by = new Map(rows.map((r) => [r.tyre_lap, r]));
    return x.map((t) => (by.has(t) ? by.get(t)!.corrected - ref : null));
  };
  const va = at(a.times), vb = at(b.times);
  const rowOf = (rows: StintCompare['a']['times'], t: number) => rows.find((r) => r.tyre_lap === t);
  return (
    <LineChart x={x} height={200} unit="lap in the stint" formatX={(v) => `${v}`} formatY={(v) => signed(v, 2)}
      title={`Lap times, s against ${formatLap(ref)}`}
      series={[{ key: 'a', label: a.name, values: va, color: c.s1, width: 1.5 },
        { key: 'b', label: b.name, values: vb, color: c.s2, width: 3 }]}
      legend={[{ label: `${a.name} (before, thin)`, color: c.s1 }, { label: `${b.name} (after, thick)`, color: c.s2 }]}
      readout={(i) => [rowOf(a.times, x[i]), rowOf(b.times, x[i])].flatMap((r, k) => (r ? [{
        label: `${k === 0 ? a.name : b.name} lap ${r.lap}`, value: formatLap(r.corrected), color: k === 0 ? c.s1 : c.s2,
      }] : []))} />
  );
}

const useStyles = themed((c) => ({
  block: { gap: 14 },
  picker: { gap: 6 },
  busy: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  headline: { fontFamily: face('body', 600), fontSize: 24, lineHeight: 32, color: c.text, maxWidth: 860 },
  headlinePhone: { fontSize: 20, lineHeight: 27 },
  figs: { marginTop: 4 },
  list: { gap: 8, maxWidth: 820 },
  bullet: { flexDirection: 'row', gap: 10, alignItems: 'flex-start' },
  bulletMark: { width: 7, height: 7, backgroundColor: c.text, marginTop: 8 },
  flex: { flex: 1, minWidth: 0 },
  check: { flexDirection: 'row', gap: 12, alignItems: 'flex-start', maxWidth: 820 },
  mark: { fontFamily: face('label', 700), fontSize: 18, lineHeight: 23, width: 20, color: c.text },
  markOff: { color: c.error },
  missing: { gap: 2 },
  phase: { gap: 8, maxWidth: 820 },
  row: { flexDirection: 'row', gap: 12, alignItems: 'baseline', flexWrap: 'wrap' },
  rowLabel: { width: 130 },
  // a whole row is the tap target: it lights its corner up on the map
  corner: { minHeight: TAP, flexDirection: 'row', alignItems: 'center', borderBottomWidth: 1, borderColor: c.rule,
    paddingVertical: 8, maxWidth: 820 },
  cornerOn: { borderLeftWidth: 4, borderLeftColor: c.mark, paddingLeft: 10 },
}));
