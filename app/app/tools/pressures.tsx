import { Stack } from 'expo-router';
import { ReactNode, useCallback, useEffect, useState } from 'react';
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
import {
  Corner,
  CORNERS,
  LoggedRun,
  MinimumRow,
  Minimums,
  num,
  PerCorner,
  PressurePlan,
  Reference,
  RunSummary,
  tyres,
} from '@/lib/tyres';

const empty = (): Record<Corner, string> => ({ FL: '', FR: '', RL: '', RR: '' });
const fmt = (x: number | null | undefined, digits = 2) => (x == null ? '–' : x.toFixed(digits));

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

export default function PressuresScreen() {
  const [ambient, setAmbient] = useState('');
  const [track, setTrack] = useState('');
  const [setTemp, setSetTemp] = useState('');
  const [atmos, setAtmos] = useState('1.013');
  const [targets, setTargets] = useState(empty);
  const [hotTemps, setHotTemps] = useState(empty);
  const [series, setSeries] = useState('');
  const [runs, setRuns] = useState<LoggedRun[]>([]);
  const [summary, setSummary] = useState<PerCorner<RunSummary>>({});
  const [plan, setPlan] = useState<PressurePlan | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const tint = useThemeColor({}, 'tint');
  const background = useThemeColor({}, 'background');

  const loadRuns = useCallback(() => {
    tyres.runs().then((r) => {
      setRuns(r.runs);
      setSummary(r.summary);
    }, (e) => setError(e.message));
  }, []);
  useEffect(loadRuns, [loadRuns]);
  useEffect(() => {
    tyres.minimums().then((m) => setSeries((cur) => cur || m.series_list[0] || ''), () => {});
  }, []);

  const calculate = async () => {
    const t: PerCorner<number> = {};
    const hot: PerCorner<number> = {};
    for (const c of CORNERS) {
      if (num(targets[c]) !== undefined) t[c] = num(targets[c]);
      if (num(hotTemps[c]) !== undefined) hot[c] = num(hotTemps[c]);
    }
    if (!Object.keys(t).length) {
      setError('Enter a target hot pressure for at least one tyre.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      setPlan(
        await tyres.pressures({
          targets: t,
          hot_c: hot,
          set_c: num(setTemp),
          ambient_c: num(ambient),
          track_c: num(track),
          atmospheric_bar: num(atmos),
          series: series.trim() || undefined,
        }),
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const copyFirst = () => {
    const first = CORNERS.map((c) => targets[c]).find((v) => v.trim());
    if (first) setTargets({ FL: first, FR: first, RL: first, RR: first });
  };

  return (
    <ScrollView style={{ backgroundColor: background }} contentContainerStyle={styles.container}>
      <Stack.Screen options={{ title: 'Tyre pressures' }} />
      <Text style={styles.intro}>
        The cold pressures to set now so the tyres reach your target hot pressure: by the gas law, and by what this
        car's own logged runs show.
      </Text>

      <Text style={styles.h2}>Conditions now</Text>
      <View style={styles.row}>
        <Field label="Ambient °C" value={ambient} onChangeText={setAmbient} placeholder="e.g. 18" />
        <Field label="Track °C" value={track} onChangeText={setTrack} placeholder="e.g. 30" />
      </View>
      <View style={styles.row}>
        <Field
          label="Tyre temp when setting °C"
          value={setTemp}
          onChangeText={setSetTemp}
          placeholder={ambient ? `${ambient} (ambient)` : 'e.g. 22 in the garage'}
        />
        <Field label="Air pressure bar" value={atmos} onChangeText={setAtmos} keyboardType="decimal-pad" />
      </View>

      <View style={styles.headRow}>
        <Text style={styles.h2}>Target hot pressure, bar</Text>
        <Pressable onPress={copyFirst}>
          <Text style={{ color: tint }}>Same for all</Text>
        </Pressable>
      </View>
      <CarGrid
        cell={(c) => (
          <Field
            value={targets[c]}
            onChangeText={(v) => setTargets((cur) => ({ ...cur, [c]: v }))}
            keyboardType="decimal-pad"
            placeholder="e.g. 1.85"
            accessibilityLabel={`${c} target hot pressure`}
          />
        )}
      />

      <Text style={styles.h2}>Expected hot tyre temperature, °C</Text>
      <Text style={styles.note}>Optional. Empty uses what the TPMS read when hot in your logged runs.</Text>
      <CarGrid
        cell={(c) => (
          <Field
            value={hotTemps[c]}
            onChangeText={(v) => setHotTemps((cur) => ({ ...cur, [c]: v }))}
            placeholder={summary[c]?.median_hot_c != null ? `${Math.round(summary[c]!.median_hot_c!)} (runs)` : '°C'}
            accessibilityLabel={`${c} expected hot temperature`}
          />
        )}
      />

      <Field label="Series (for the P-Book minimums)" value={series} onChangeText={setSeries}
        keyboardType="default" placeholder="e.g. GT4 Germany" />

      <Pressable style={[styles.button, { backgroundColor: tint }]} onPress={calculate} disabled={busy}>
        {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>Calculate cold pressures</Text>}
      </Pressable>
      {error && <Text style={styles.error}>{error}</Text>}

      {plan && <Results plan={plan} />}

      <MinimumsEditor series={series.trim()} />

      <LoggedRuns runs={runs} onChanged={loadRuns} />
    </ScrollView>
  );
}

function Results({ plan }: { plan: PressurePlan }) {
  const by = Object.fromEntries(plan.corners.map((c) => [c.corner, c]));
  return (
    <View style={styles.section}>
      <Text style={styles.h2}>Set these cold</Text>
      <CarGrid
        cell={(c) => {
          const p = by[c];
          if (!p) return <Text style={styles.dim}>–</Text>;
          return (
            <View style={styles.result}>
              <Text style={styles.big}>{fmt(p.data.cold_bar ?? p.gas_law.cold_bar)}</Text>
              <Text style={styles.small}>Gas law {fmt(p.gas_law.cold_bar)}</Text>
              <Text style={styles.small}>
                Your data {fmt(p.data.cold_bar)}
                {p.data.runs ? ` · ${p.data.runs} runs` : ''}
              </Text>
              {p.flags.length > 0 && <Text style={styles.error}>Below a minimum</Text>}
            </View>
          );
        }}
      />
      <Text style={styles.note}>
        The big number is the data answer where there are logged runs, else the gas law.
        {plan.set_c_source && plan.set_c_source !== 'entered' ? ` Tyre temperature taken as ${plan.set_c_source}.` : ''}
      </Text>
      {plan.minimums.message && <Text style={styles.warn}>{plan.minimums.message}</Text>}
      <Ref r={plan.minimums.reference} />
      {plan.corners.map((p) => (
        <View key={p.corner} style={styles.card}>
          <Text style={styles.cardTitle}>
            {p.corner} · target {p.target_hot_bar.toFixed(2)} bar hot
          </Text>
          {p.flags.map((f) => (
            <Text key={f} style={styles.error}>
              {f}
            </Text>
          ))}
          <Text style={styles.label}>Gas law</Text>
          <Text>{p.gas_law.text}</Text>
          {p.gas_law.hot_c_source && p.gas_law.hot_c_source !== 'entered' && (
            <Text style={styles.dim}>Hot temperature: {p.gas_law.hot_c_source}.</Text>
          )}
          {p.gas_law.runs_note && <Text style={styles.dim}>{p.gas_law.runs_note}</Text>}
          <Text style={styles.label}>Your logged runs</Text>
          <Text>{p.data.text}</Text>
        </View>
      ))}
    </View>
  );
}

function MinimumsEditor({ series }: { series: string }) {
  const [mins, setMins] = useState<Minimums | null>(null);
  const [vals, setVals] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const tint = useThemeColor({}, 'tint');

  const show = (m: Minimums) => {
    setMins(m);
    const v: Record<string, string> = {};
    for (const r of m.rows) {
      if (r.cold_min_bar != null) v[`${r.axle}-cold`] = String(r.cold_min_bar);
      if (r.hot_min_bar != null) v[`${r.axle}-hot`] = String(r.hot_min_bar);
      if (r.tyre) v.tyre = r.tyre;
      if (r.source) v.source = r.source;
    }
    setVals(v);
  };
  useEffect(() => {
    setMsg(null);
    if (series) tyres.minimums(series).then(show, (e) => setMsg(e.message));
    else setMins(null);
  }, [series]);

  const save = async () => {
    const rows: MinimumRow[] = (['front', 'rear'] as const).map((axle) => ({
      axle,
      tyre: vals.tyre?.trim() || null,
      cold_min_bar: num(vals[`${axle}-cold`]) ?? null,
      hot_min_bar: num(vals[`${axle}-hot`]) ?? null,
      source: vals.source?.trim() || null,
    }));
    setSaving(true);
    try {
      show(await tyres.saveMinimums(series, rows));
      setMsg('Saved.');
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const set = (k: string) => (v: string) => setVals((cur) => ({ ...cur, [k]: v }));
  return (
    <View style={styles.section}>
      <Text style={styles.h2}>P-Book minimums{series ? ` · ${series}` : ''}</Text>
      {!series && <Text style={styles.note}>Enter the series above to see or enter its P-Book minimums.</Text>}
      {series && mins?.message && <Text style={styles.warn}>{mins.message}</Text>}
      {series && mins?.origin === 'presets' && <Text style={styles.note}>Shipped with the app; see each source.</Text>}
      {mins && <Ref r={mins.reference} />}
      {series && (
        <>
          {(['front', 'rear'] as const).map((axle) => (
            <View key={axle} style={styles.row}>
              <Text style={styles.axle}>{axle === 'front' ? 'Front' : 'Rear'}</Text>
              <Field label="Cold min bar" value={vals[`${axle}-cold`] ?? ''} onChangeText={set(`${axle}-cold`)}
                keyboardType="decimal-pad" />
              <Field label="Hot min bar" value={vals[`${axle}-hot`] ?? ''} onChangeText={set(`${axle}-hot`)}
                keyboardType="decimal-pad" />
            </View>
          ))}
          <Field label="Tyre" value={vals.tyre ?? ''} onChangeText={set('tyre')} keyboardType="default"
            placeholder="e.g. Pirelli P Zero DHG" />
          <Field label="Source" value={vals.source ?? ''} onChangeText={set('source')} keyboardType="default"
            placeholder="P-Book edition and page" />
          <Pressable style={[styles.outline, { borderColor: tint }]} onPress={save} disabled={saving}>
            <Text style={{ color: tint }}>{saving ? 'Saving…' : 'Save minimums'}</Text>
          </Pressable>
        </>
      )}
      {msg && <Text style={styles.note}>{msg}</Text>}
    </View>
  );
}

function LoggedRuns({ runs, onChanged }: { runs: LoggedRun[]; onChanged: () => void }) {
  const [tracks, setTracks] = useState<Record<number, string>>({});
  const saveTrack = async (sessionId: number) => {
    const v = tracks[sessionId];
    if (v === undefined) return;
    await tyres.setConditions(sessionId, { track_temp_c: num(v) ?? null }).catch(() => {});
    onChanged();
  };
  return (
    <View style={styles.section}>
      <Text style={styles.h2}>Your logged runs ({runs.length})</Text>
      <Text style={styles.note}>
        Cold is where each TPMS sensor first reported after the car rolled; hot is where the pressure settled after
        12 minutes at speed. Enter a session's track temperature so the model can learn its effect.
      </Text>
      {runs.length === 0 && <Text style={styles.dim}>Upload MoTeC logs with TPMS channels on the Sessions tab.</Text>}
      {runs.map((r) => (
        <View key={`${r.file_id}-${r.set}`} style={styles.card}>
          <Text style={styles.cardTitle}>
            {r.session}
            {r.set > 0 ? ` · tyre set ${r.set + 1} (fitted at ${Math.round(r.start_s / 60)} min)` : ''}
          </Text>
          <Text style={styles.dim}>{r.file}</Text>
          <View style={styles.row}>
            <Text style={styles.small}>
              Ambient {fmt(r.ambient_c, 1)} °C{r.ambient_source ? ` (${r.ambient_source})` : ''}
            </Text>
            <Field
              label="Track °C"
              value={tracks[r.session_id] ?? (r.track_c != null ? String(r.track_c) : '')}
              onChangeText={(v) => setTracks((cur) => ({ ...cur, [r.session_id]: v }))}
              onBlur={() => saveTrack(r.session_id)}
              style={styles.smallInput}
            />
          </View>
          {CORNERS.map((c) => {
            const x = r.corners[c];
            if (!x) return null;
            return (
              <Text key={c} style={[styles.small, !x.used && styles.dim]}>
                {c} {fmt(x.cold_bar)} → {fmt(x.hot_bar)} bar
                {x.rise_bar != null ? ` (+${fmt(x.rise_bar)})` : ''} · {fmt(x.cold_c, 0)} → {fmt(x.hot_c, 0)} °C
                {x.note ? ` · ${x.note}` : ''}
              </Text>
            );
          })}
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { padding: 16, gap: 12, maxWidth: 720, width: '100%', alignSelf: 'center' },
  intro: { opacity: 0.8 },
  h2: { fontSize: 18, fontWeight: '700', marginTop: 8 },
  headRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' },
  row: { flexDirection: 'row', gap: 12, alignItems: 'flex-end' },
  field: { flex: 1, gap: 4 },
  fieldLabel: { fontSize: 12, opacity: 0.6 },
  input: {
    borderWidth: 1,
    borderColor: '#8886',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 16,
    fontVariant: ['tabular-nums'],
  },
  smallInput: { paddingVertical: 4, fontSize: 14 },
  car: { gap: 8, padding: 8, borderRadius: 12, borderWidth: 1, borderColor: '#8883' },
  carLabel: { textAlign: 'center', fontSize: 12, opacity: 0.5, textTransform: 'uppercase', letterSpacing: 1 },
  carRow: { flexDirection: 'row', gap: 12 },
  carCell: { flex: 1, gap: 4 },
  cornerName: { fontWeight: '700' },
  result: { gap: 2 },
  big: { fontSize: 26, fontWeight: '600', fontVariant: ['tabular-nums'] },
  small: { fontSize: 13, fontVariant: ['tabular-nums'] },
  button: { borderRadius: 8, padding: 14, alignItems: 'center' },
  buttonText: { color: '#fff', fontWeight: '600', fontSize: 16 },
  outline: { borderRadius: 8, padding: 12, alignItems: 'center', borderWidth: 1 },
  error: { color: '#c8372d' },
  warn: { color: '#b26a00' },
  note: { opacity: 0.7, fontSize: 13 },
  dim: { opacity: 0.55, fontSize: 13 },
  section: { gap: 10 },
  card: { paddingVertical: 10, borderBottomWidth: 1, borderColor: '#8882', gap: 4 },
  cardTitle: { fontSize: 16, fontWeight: '600' },
  label: { fontSize: 12, opacity: 0.6, textTransform: 'uppercase', letterSpacing: 0.5, marginTop: 4 },
  axle: { width: 48, fontWeight: '600', paddingBottom: 10 },
});
