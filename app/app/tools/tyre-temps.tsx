import { Stack } from 'expo-router';
import { ReactNode, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  TextInputProps,
} from 'react-native';

import { Text, View, useThemeColor } from '@/components/Themed';
import { api, Session } from '@/lib/api';
import {
  Axle,
  Corner,
  CORNERS,
  num,
  parsePyrometer,
  PerCorner,
  Reading,
  Reference,
  TempAnalysis,
  tyres,
} from '@/lib/tyres';

type Mode = 'pyrometer' | 'paste' | 'log';
const MODES: [Mode, string][] = [
  ['pyrometer', 'Type readings'],
  ['paste', 'Paste readings'],
  ['log', 'IR sensors in a log'],
];
type Pos = 'inside' | 'middle' | 'outside';
const SHORT: Record<Pos, string> = { inside: 'In', middle: 'Mid', outside: 'Out' };
// Seen from above, the outside edge of a left tyre is on the left, of a right tyre on the right.
const ACROSS: Record<Corner, Pos[]> = {
  FL: ['outside', 'middle', 'inside'],
  RL: ['outside', 'middle', 'inside'],
  FR: ['inside', 'middle', 'outside'],
  RR: ['inside', 'middle', 'outside'],
};

// Four tyres laid out like the car seen from above, front at the top.
function CarGrid({ cell }: { cell: (c: Corner) => ReactNode }) {
  return (
    <View style={styles.car}>
      <Text style={styles.carLabel}>Front</Text>
      {[CORNERS.slice(0, 2), CORNERS.slice(2)].map((row) => (
        <View key={row[0]} style={styles.carRow}>
          {row.map((c) => (
            <View key={c} style={styles.carCell}>
              <Text style={styles.cornerName}>{c}</Text>
              {cell(c)}
            </View>
          ))}
        </View>
      ))}
    </View>
  );
}

// A figure from an older public booklet, with a link to it.
function Ref({ r }: { r: Reference }) {
  const tint = useThemeColor({}, 'tint');
  return (
    <Text style={styles.dim}>
      {r.text}{' '}
      <Text style={{ color: tint }} onPress={() => Linking.openURL(r.source)}>
        Source
      </Text>
    </Text>
  );
}

function Field(props: TextInputProps & { label?: string }) {
  const color = useThemeColor({}, 'text');
  const { label, style, ...rest } = props;
  return (
    <View style={styles.field}>
      {label && <Text style={styles.fieldLabel}>{label}</Text>}
      <TextInput
        placeholderTextColor="#8889"
        keyboardType="numbers-and-punctuation"
        {...rest}
        style={[styles.input, { color }, style]}
      />
    </View>
  );
}

export default function TyreTempsScreen() {
  const [mode, setMode] = useState<Mode>('pyrometer');
  const [vals, setVals] = useState<Record<string, string>>({});
  const [paste, setPaste] = useState('');
  const [sessions, setSessions] = useState<Session[]>([]);
  const [sessionId, setSessionId] = useState<number | null>(null);
  const [spread, setSpread] = useState<Record<Axle, string>>({ front: '', rear: '' });
  const [spreadSource, setSpreadSource] = useState<string | null>(null);
  const [reference, setReference] = useState<Reference | null>(null);
  const [defaultSpread, setDefaultSpread] = useState<number | null>(null);
  const [series, setSeries] = useState('');
  const [result, setResult] = useState<TempAnalysis | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const tint = useThemeColor({}, 'tint');
  const background = useThemeColor({}, 'background');

  useEffect(() => {
    tyres.tempSettings().then((s) => {
      setSpread({ front: String(s.target_spread_c), rear: String(s.target_spread_c) });
      setSpreadSource(s.target_spread_source);
      setDefaultSpread(s.target_spread_c);
      setReference(s.reference);
    }, (e) => setError(e.message));
    api.sessions().then((s) => {
      setSessions(s);
      setSessionId((cur) => cur ?? s[0]?.id ?? null);
    }, () => {});
  }, []);

  const set = (k: string) => (v: string) => setVals((cur) => ({ ...cur, [k]: v }));

  const readings = (): PerCorner<Reading> => {
    const out: PerCorner<Reading> = {};
    for (const c of CORNERS) {
      const [inside, middle, outside] = (['inside', 'middle', 'outside'] as const).map((p) => num(vals[`${c}-${p}`]));
      if (inside === undefined || middle === undefined || outside === undefined) continue;
      out[c] = { inside, middle, outside, pressure_bar: num(vals[`${c}-p`]), camber_deg: num(vals[`${c}-camber`]) };
    }
    return out;
  };

  const applyPaste = () => {
    const { readings: r, errors } = parsePyrometer(paste);
    const next = { ...vals };
    for (const [c, x] of Object.entries(r) as [Corner, Reading][]) {
      next[`${c}-inside`] = String(x.inside);
      next[`${c}-middle`] = String(x.middle);
      next[`${c}-outside`] = String(x.outside);
      if (x.pressure_bar != null) next[`${c}-p`] = String(x.pressure_bar);
      if (x.camber_deg != null) next[`${c}-camber`] = String(x.camber_deg);
    }
    setVals(next);
    setError(errors.length ? errors.join('\n') : null);
    if (Object.keys(r).length) setMode('pyrometer');
  };

  const analyse = async () => {
    // send a target only when it differs from the default, so the reply says whose number it is
    const entered = Object.fromEntries(
      (['front', 'rear'] as const).map((a) => [a, num(spread[a])]).filter(([, v]) => v !== undefined),
    ) as Partial<Record<Axle, number>>;
    const target = Object.values(entered).some((v) => v !== defaultSpread) ? entered : undefined;
    setBusy(true);
    setError(null);
    try {
      if (mode === 'log') {
        if (sessionId == null) throw new Error('Pick a session with a log first.');
        setResult(await tyres.logTemps(sessionId, target));
      } else {
        const r = readings();
        if (!Object.keys(r).length) throw new Error('Enter inside, middle and outside for at least one tyre.');
        setResult(
          await tyres.analyzeTemps({
            readings: r,
            target_spread_c: target,
            series: series.trim() || undefined,
          }),
        );
      }
    } catch (e) {
      setResult(null);
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const chip = (selected: boolean) => [styles.chip, selected && { borderColor: tint }];
  const chipText = (selected: boolean) => (selected ? { color: tint } : undefined);

  return (
    <ScrollView style={{ backgroundColor: background }} contentContainerStyle={styles.container}>
      <Stack.Screen options={{ title: 'Tyre temperatures' }} />
      <Text style={styles.intro}>
        Temperatures across each tyre straight after a run: inside (nearest the car's centre), middle and outside, in
        °C. You get camber and pressure advice per tyre and the car's balance.
      </Text>

      <View style={styles.chips}>
        {MODES.map(([key, name]) => (
          <Pressable key={key} onPress={() => setMode(key)} style={chip(key === mode)}>
            <Text style={chipText(key === mode)}>{name}</Text>
          </Pressable>
        ))}
      </View>

      {mode === 'pyrometer' && (
        <>
          <CarGrid
            cell={(c) => (
              <View style={styles.cell}>
                <View style={styles.across}>
                  {ACROSS[c].map((p) => (
                    <Field
                      key={p}
                      label={SHORT[p]}
                      value={vals[`${c}-${p}`] ?? ''}
                      onChangeText={set(`${c}-${p}`)}
                      accessibilityLabel={`${c} ${p} temperature`}
                      style={styles.tempInput}
                    />
                  ))}
                </View>
                <View style={styles.across}>
                  <Field label="Hot bar" value={vals[`${c}-p`] ?? ''} onChangeText={set(`${c}-p`)}
                    keyboardType="decimal-pad" placeholder="opt." style={styles.tempInput} />
                  <Field label="Camber °" value={vals[`${c}-camber`] ?? ''} onChangeText={set(`${c}-camber`)}
                    placeholder="opt." style={styles.tempInput} />
                </View>
              </View>
            )}
          />
          <Text style={styles.note}>Hot pressure and camber are optional; with them the advice gives new values.</Text>
        </>
      )}

      {mode === 'paste' && (
        <>
          <Text style={styles.note}>
            One tyre per line: corner, inside, middle, outside, and optionally hot pressure and camber. For example
            {'\n'}FL 92 88 84 1.85 -3.5
          </Text>
          <Field value={paste} onChangeText={setPaste} multiline keyboardType="default"
            placeholder={'FL 92 88 84\nFR 90 87 85\nRL 80 78 77\nRR 79 78 76'} style={styles.paste} />
          <Pressable style={[styles.outline, { borderColor: tint }]} onPress={applyPaste}>
            <Text style={{ color: tint }}>Use these readings</Text>
          </Pressable>
        </>
      )}

      {mode === 'log' && (
        <>
          <Text style={styles.note}>
            Uses IR tyre sensors (inside, middle and outside channels) in the session's log, averaged at racing speed.
            TPMS temperatures can't be used: they measure the air inside the tyre.
          </Text>
          <View style={styles.chips}>
            {sessions.slice(0, 8).map((s) => (
              <Pressable key={s.id} onPress={() => setSessionId(s.id)} style={chip(s.id === sessionId)}>
                <Text style={chipText(s.id === sessionId)}>{s.name ?? `Session ${s.id}`}</Text>
              </Pressable>
            ))}
            {sessions.length === 0 && <Text style={styles.note}>No sessions yet.</Text>}
          </View>
        </>
      )}

      <Text style={styles.h2}>Target spread, °C</Text>
      <Text style={styles.note}>How much hotter the inside edge should run than the outside.</Text>
      <View style={styles.row}>
        <Field label="Front" value={spread.front} onChangeText={(v) => setSpread((s) => ({ ...s, front: v }))} />
        <Field label="Rear" value={spread.rear} onChangeText={(v) => setSpread((s) => ({ ...s, rear: v }))} />
      </View>
      {spreadSource && <Text style={styles.dim}>{spreadSource}</Text>}
      {reference && <Ref r={reference} />}
      {mode !== 'log' && (
        <Field label="Series (optional, checks pressures against its P-Book hot minimum)" value={series}
          onChangeText={setSeries} keyboardType="default" placeholder="e.g. GT4 Germany" />
      )}

      <Pressable style={[styles.button, { backgroundColor: tint }]} onPress={analyse} disabled={busy}>
        {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>Analyse</Text>}
      </Pressable>
      {error && <Text style={styles.error}>{error}</Text>}

      {result && <Results result={result} />}
    </ScrollView>
  );
}

const VERDICT: Record<string, string> = {
  ok: 'OK',
  'less negative camber': 'Less camber',
  'more negative camber': 'More camber',
  lower: 'Lower',
  raise: 'Raise',
};

function Results({ result }: { result: TempAnalysis }) {
  const by = Object.fromEntries(result.tyres.map((t) => [t.corner, t]));
  return (
    <View style={styles.section}>
      <Text style={styles.h2}>Advice{result.file ? ` · ${result.file}` : ''}</Text>
      <CarGrid
        cell={(c) => {
          const t = by[c];
          if (!t) return <Text style={styles.dim}>–</Text>;
          return (
            <View style={{ gap: 2 }}>
              <Text style={styles.big}>{t.average_c.toFixed(0)} °C</Text>
              <Text style={styles.small}>
                Camber: {VERDICT[t.camber.verdict] ?? t.camber.verdict} ({t.camber.spread_c > 0 ? '+' : ''}
                {t.camber.spread_c.toFixed(0)})
              </Text>
              <Text style={styles.small}>Pressure: {VERDICT[t.pressure.verdict] ?? t.pressure.verdict}</Text>
            </View>
          );
        }}
      />
      {result.balance.map((b) => (
        <View key={b.kind} style={{ gap: 2 }}>
          <Text>{b.text}</Text>
          {b.references.map((r) => (
            <Ref key={r.text} r={r} />
          ))}
        </View>
      ))}
      {result.tyres.map((t) => (
        <View key={t.corner} style={styles.card}>
          <Text style={styles.cardTitle}>
            {t.corner} · in {t.inside} · mid {t.middle} · out {t.outside} °C
          </Text>
          <Text style={styles.label}>Camber</Text>
          <Text>{t.camber.text}</Text>
          {t.camber.references.map((r) => (
            <Ref key={r.text} r={r} />
          ))}
          <Text style={styles.label}>Pressure</Text>
          <Text style={t.pressure.below_minimum ? styles.error : undefined}>{t.pressure.text}</Text>
        </View>
      ))}
      <Text style={styles.dim}>
        Target spread front {result.target_spread_c.front} °C, rear {result.target_spread_c.rear} °C (
        {result.target_spread_source === 'entered' ? 'entered' : 'estimate'}). Change one thing at a time and measure
        again.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { padding: 16, gap: 12, maxWidth: 720, width: '100%', alignSelf: 'center' },
  intro: { opacity: 0.8 },
  h2: { fontSize: 18, fontWeight: '700', marginTop: 8 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { borderWidth: 1, borderColor: '#8886', borderRadius: 16, paddingHorizontal: 12, paddingVertical: 6 },
  row: { flexDirection: 'row', gap: 12, alignItems: 'flex-end' },
  field: { flex: 1, gap: 2 },
  fieldLabel: { fontSize: 11, opacity: 0.6 },
  input: {
    borderWidth: 1,
    borderColor: '#8886',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 16,
    fontVariant: ['tabular-nums'],
  },
  tempInput: { paddingHorizontal: 6, textAlign: 'center' },
  paste: { minHeight: 110, textAlignVertical: 'top', fontFamily: 'SpaceMono' },
  car: { gap: 8, padding: 8, borderRadius: 12, borderWidth: 1, borderColor: '#8883' },
  carLabel: { textAlign: 'center', fontSize: 12, opacity: 0.5, textTransform: 'uppercase', letterSpacing: 1 },
  carRow: { flexDirection: 'row', gap: 12 },
  carCell: { flex: 1, gap: 4 },
  cornerName: { fontWeight: '700' },
  cell: { gap: 6 },
  across: { flexDirection: 'row', gap: 4 },
  big: { fontSize: 22, fontWeight: '600', fontVariant: ['tabular-nums'] },
  small: { fontSize: 13, fontVariant: ['tabular-nums'] },
  button: { borderRadius: 8, padding: 14, alignItems: 'center' },
  buttonText: { color: '#fff', fontWeight: '600', fontSize: 16 },
  outline: { borderRadius: 8, padding: 12, alignItems: 'center', borderWidth: 1 },
  error: { color: '#c8372d' },
  note: { opacity: 0.7, fontSize: 13 },
  dim: { opacity: 0.55, fontSize: 13 },
  section: { gap: 10 },
  card: { paddingVertical: 10, borderBottomWidth: 1, borderColor: '#8882', gap: 4 },
  cardTitle: { fontSize: 16, fontWeight: '600', fontVariant: ['tabular-nums'] },
  label: { fontSize: 12, opacity: 0.6, textTransform: 'uppercase', letterSpacing: 0.5, marginTop: 4 },
});
