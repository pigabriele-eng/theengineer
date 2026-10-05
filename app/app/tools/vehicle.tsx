import { Stack } from 'expo-router';
import { ReactNode, useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, TextInput } from 'react-native';

import { Text, View, useThemeColor } from '@/components/Themed';
import {
  Change,
  DEFAULT_PRESET,
  ModelResult,
  pct,
  Preset,
  Vehicle,
  vehicleApi,
  WhatIfResult,
} from '@/lib/vehicle';

type Axle = 'front' | 'rear';
type Field = { key: keyof Vehicle; label: string; unit: string; percent?: boolean };

const k = (s: string) => s as keyof Vehicle;

const CAR_FIELDS: Field[] = [
  { key: 'mass_kg', label: 'Mass with driver and fuel', unit: 'kg' },
  { key: 'front_weight_fraction', label: 'Front weight', unit: '%', percent: true },
  { key: 'cog_height_mm', label: 'CoG height', unit: 'mm' },
  { key: 'wheelbase_mm', label: 'Wheelbase', unit: 'mm' },
  { key: 'tyre_radius_mm', label: 'Tyre loaded radius', unit: 'mm' },
];

const axleFields = (a: Axle): Field[] => [
  { key: k(`track_${a}_mm`), label: 'Track', unit: 'mm' },
  { key: k(`roll_centre_${a}_mm`), label: 'Roll centre height', unit: 'mm' },
  { key: k(`spring_${a}_n_per_mm`), label: 'Spring rate', unit: 'N/mm' },
  { key: k(`spring_mr_${a}`), label: 'Spring motion ratio', unit: 'spring ÷ wheel' },
  { key: k(`arb_mr_${a}`), label: 'Bar motion ratio', unit: 'link ÷ wheel' },
  { key: k(`tyre_vertical_${a}_n_per_mm`), label: 'Tyre vertical stiffness', unit: 'N/mm' },
  { key: k(`unsprung_${a}_kg`), label: 'Unsprung mass per corner', unit: 'kg' },
];

const AERO_FIELDS: Field[] = [
  { key: 'downforce_n', label: 'Downforce (0 = none)', unit: 'N' },
  { key: 'aero_balance_front', label: 'Aero balance front', unit: '%', percent: true },
  { key: 'aero_ref_speed_kmh', label: 'at speed', unit: 'km/h' },
  { key: 'braking_g', label: 'Braking', unit: 'g' },
  { key: 'acceleration_g', label: 'Acceleration', unit: 'g' },
];

const NUMERIC: Field[] = [...CAR_FIELDS, ...axleFields('front'), ...axleFields('rear'), ...AERO_FIELDS];

type BarState = { rates: string; setting: number | null; rate: string };

const toText = (v: Vehicle, f: Field) => {
  const x = v[f.key] as number;
  return f.percent ? String(Math.round(x * 1000) / 10) : String(x);
};

export default function VehicleScreen() {
  const [preset, setPreset] = useState<Preset | null>(null);
  const [form, setForm] = useState<Record<string, string>>({});
  const [bars, setBars] = useState<Record<Axle, BarState>>({
    front: { rates: '', setting: null, rate: '0' },
    rear: { rates: '', setting: null, rate: '0' },
  });
  const [result, setResult] = useState<ModelResult | null>(null);
  const [picked, setPicked] = useState<number[]>([]);
  const [whatIf, setWhatIf] = useState<WhatIfResult | null>(null);
  const [showSources, setShowSources] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const tint = useThemeColor({}, 'tint');
  const background = useThemeColor({}, 'background');
  const text = useThemeColor({}, 'text');

  const fill = (v: Vehicle) => {
    setForm(Object.fromEntries(NUMERIC.map((f) => [f.key, toText(v, f)])));
    const bar = (a: Axle): BarState => ({
      rates: (v[k(`arb_${a}_settings_n_per_mm`)] as number[] | null)?.join(', ') ?? '',
      setting: v[k(`arb_${a}_setting`)] as number | null,
      rate: String(v[k(`arb_${a}_n_per_mm`)]),
    });
    setBars({ front: bar('front'), rear: bar('rear') });
  };

  // The setup in the form as the server expects it, or an error naming the field to fix.
  const vehicle = useCallback((): Vehicle => {
    const out: Record<string, unknown> = {};
    for (const f of NUMERIC) {
      const x = Number((form[f.key] ?? '').replace(',', '.'));
      if (!Number.isFinite(x) || form[f.key]?.trim() === '') throw new Error(`Check "${f.label}"`);
      out[f.key] = f.percent ? x / 100 : x;
    }
    for (const a of ['front', 'rear'] as Axle[]) {
      const rates = bars[a].rates.split(/[,;\s]+/).filter(Boolean).map(Number);
      if (rates.some((x) => !Number.isFinite(x))) throw new Error(`Check the ${a} bar rates`);
      out[`arb_${a}_settings_n_per_mm`] = rates.length ? rates : null;
      out[`arb_${a}_setting`] = rates.length ? Math.min(Math.max(bars[a].setting ?? 1, 1), rates.length) : null;
      out[`arb_${a}_n_per_mm`] = Number(bars[a].rate) || 0;
    }
    return out as Vehicle;
  }, [form, bars]);

  const calculate = useCallback(async () => {
    setError(null);
    setWhatIf(null);
    try {
      setResult(await vehicleApi.model(vehicle()));
    } catch (e) {
      setError((e as Error).message);
    }
  }, [vehicle]);

  useEffect(() => {
    vehicleApi.preset(DEFAULT_PRESET).then(
      (p) => {
        setPreset(p);
        fill(p.vehicle);
        vehicleApi.model(p.vehicle).then(setResult, (e) => setError(e.message));
      },
      (e) => setError(e.message),
    );
  }, []);

  const quick = whatIfOptions(bars);
  const compare = async () => {
    setBusy(true);
    setError(null);
    try {
      setWhatIf(await vehicleApi.whatIf(vehicle(), picked.map((i) => quick[i].change)));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const input = (f: Field) => (
    <View key={f.key} style={styles.field}>
      <View style={styles.fieldRow}>
        <View style={styles.fieldLabel}>
          <Text>{f.label}</Text>
          <Text style={styles.unit}>
            {f.unit}
            {preset?.values[f.key] ? ` · ${preset.values[f.key]!.confidence}` : ''}
          </Text>
        </View>
        <TextInput
          style={[styles.input, { color: text, borderColor: '#8884' }]}
          value={form[f.key] ?? ''}
          onChangeText={(t) => setForm((s) => ({ ...s, [f.key]: t }))}
          keyboardType="decimal-pad"
          selectTextOnFocus
        />
      </View>
      {showSources && preset?.values[f.key] && <Text style={styles.note}>{preset.values[f.key]!.note}</Text>}
    </View>
  );

  const barEditor = (a: Axle) => {
    const b = bars[a];
    const rates = b.rates.split(/[,;\s]+/).filter(Boolean).map(Number);
    const setBar = (patch: Partial<BarState>) => setBars((s) => ({ ...s, [a]: { ...s[a], ...patch } }));
    const prov = preset?.values[k(`arb_${a}_settings_n_per_mm`)];
    return (
      <View style={styles.field}>
        <View style={styles.fieldRow}>
          <View style={styles.fieldLabel}>
            <Text>Anti-roll bar</Text>
            <Text style={styles.unit}>
              {rates.length ? `${rates[(b.setting ?? 1) - 1] ?? '–'} N/mm at the link` : 'N/mm at the link'}
              {prov ? ` · ${prov.confidence}` : ''}
            </Text>
          </View>
          {rates.length ? (
            <View style={styles.stepper}>
              <Pressable onPress={() => setBar({ setting: Math.max(1, (b.setting ?? 1) - 1) })} hitSlop={8}>
                <Text style={[styles.step, { color: tint }]}>−</Text>
              </Pressable>
              <Text style={styles.stepValue}>
                {b.setting ?? 1} of {rates.length}
              </Text>
              <Pressable onPress={() => setBar({ setting: Math.min(rates.length, (b.setting ?? 1) + 1) })} hitSlop={8}>
                <Text style={[styles.step, { color: tint }]}>+</Text>
              </Pressable>
            </View>
          ) : (
            <TextInput
              style={[styles.input, { color: text, borderColor: '#8884' }]}
              value={b.rate}
              onChangeText={(t) => setBar({ rate: t })}
              keyboardType="decimal-pad"
            />
          )}
        </View>
        <Text style={styles.unit}>Rate at each setting, softest first (empty: one rate)</Text>
        <TextInput
          style={[styles.input, styles.wide, { color: text, borderColor: '#8884' }]}
          value={b.rates}
          onChangeText={(t) => setBar({ rates: t })}
          placeholder="e.g. 20, 30, 40, 50, 60"
          placeholderTextColor="#8888"
        />
        {showSources && prov && <Text style={styles.note}>{prov.note}</Text>}
      </View>
    );
  };

  return (
    <ScrollView style={{ backgroundColor: background }} contentContainerStyle={styles.container}>
      <Stack.Screen options={{ title: 'Vehicle model' }} />
      <Text style={styles.intro}>
        Weight transfer, roll stiffness and ride frequencies from springs, bars and motion ratios
        {preset ? `. Starting point: ${preset.name}, with every value it does not publish marked as an estimate.` : '.'}
      </Text>
      <Pressable onPress={() => setShowSources((s) => !s)}>
        <Text style={{ color: tint }}>{showSources ? 'Hide' : 'Show'} where each value comes from</Text>
      </Pressable>

      <Section title="Car">{CAR_FIELDS.map(input)}</Section>
      <Section title="Front">
        {axleFields('front').slice(0, 4).map(input)}
        {barEditor('front')}
        {axleFields('front').slice(4).map(input)}
      </Section>
      <Section title="Rear">
        {axleFields('rear').slice(0, 4).map(input)}
        {barEditor('rear')}
        {axleFields('rear').slice(4).map(input)}
      </Section>
      <Section title="Aero and longitudinal">{AERO_FIELDS.map(input)}</Section>

      <Pressable style={[styles.button, { backgroundColor: tint }]} onPress={calculate}>
        <Text style={styles.buttonText}>Calculate</Text>
      </Pressable>
      {error && <Text style={styles.error}>{error}</Text>}

      {result && <Results r={result} />}

      {result && (
        <Section title="What if">
          <Text style={styles.sub}>Pick one or more changes to the setup above and compare.</Text>
          <View style={styles.chips}>
            {quick.map((q, i) => {
              const on = picked.includes(i);
              return (
                <Pressable
                  key={q.label}
                  onPress={() => setPicked((p) => (on ? p.filter((x) => x !== i) : [...p, i]))}
                  style={[styles.chip, on && { borderColor: tint }]}>
                  <Text style={on ? { color: tint } : undefined}>{q.label}</Text>
                </Pressable>
              );
            })}
          </View>
          <Pressable
            style={[styles.button, { backgroundColor: tint, opacity: picked.length ? 1 : 0.5 }]}
            onPress={compare}
            disabled={!picked.length || busy}>
            {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>Compare</Text>}
          </Pressable>
          {whatIf && (
            <View style={styles.card}>
              <Text style={styles.summary}>{whatIf.summary}</Text>
              {whatIf.deltas.map((d) => (
                <View key={d.key} style={styles.deltaRow}>
                  <Text>{d.label}</Text>
                  <View style={styles.row}>
                    <Text style={[styles.num, styles.sub, styles.rowLabel]}>
                      {fmt(d.baseline)} → {fmt(d.changed)} {d.unit}
                    </Text>
                    <Text style={[styles.num, styles.delta, d.delta === 0 && styles.dim]}>
                      {d.delta > 0 ? '+' : ''}
                      {fmt(d.delta)}
                    </Text>
                  </View>
                </View>
              ))}
            </View>
          )}
        </Section>
      )}
    </ScrollView>
  );
}

function whatIfOptions(bars: Record<Axle, BarState>): { label: string; change: Change }[] {
  const bar = (a: Axle, name: string) =>
    bars[a].rates.trim()
      ? [
          { label: `${name} bar 1 softer`, change: { field: k(`arb_${a}_setting`), add: -1 } },
          { label: `${name} bar 1 stiffer`, change: { field: k(`arb_${a}_setting`), add: 1 } },
        ]
      : [
          { label: `${name} bar −20 %`, change: { field: k(`arb_${a}_n_per_mm`), percent: -20 } },
          { label: `${name} bar +20 %`, change: { field: k(`arb_${a}_n_per_mm`), percent: 20 } },
        ];
  const spring = (a: Axle, name: string) => [
    { label: `${name} spring −10 %`, change: { field: k(`spring_${a}_n_per_mm`), percent: -10 } },
    { label: `${name} spring +10 %`, change: { field: k(`spring_${a}_n_per_mm`), percent: 10 } },
  ];
  return [
    ...bar('front', 'Front'),
    ...bar('rear', 'Rear'),
    ...spring('front', 'Front'),
    ...spring('rear', 'Rear'),
    { label: 'Front roll centre +10 mm', change: { field: 'roll_centre_front_mm', add: 10 } },
    { label: 'Rear roll centre +10 mm', change: { field: 'roll_centre_rear_mm', add: 10 } },
    { label: 'CoG 10 mm lower', change: { field: 'cog_height_mm', add: -10 } },
  ];
}

const fmt = (x: number) => (Math.abs(x) >= 100 ? x.toFixed(0) : Math.abs(x) >= 10 ? x.toFixed(1) : x.toFixed(2));

function Results({ r }: { r: ModelResult }) {
  const f = r.axles.front;
  const b = r.axles.rear;
  const lt = (a: 'front' | 'rear', part: 'geometric' | 'elastic' | 'unsprung' | 'total') =>
    r.axles[a].lateral_load_transfer_n_per_g[part].toFixed(0);
  return (
    <Section title="Results">
      <View style={styles.card}>
        <View style={styles.row}>
          <Text style={[styles.rowLabel, styles.dim]} />
          <Text style={[styles.col, styles.dim]}>Front</Text>
          <Text style={[styles.col, styles.dim]}>Rear</Text>
        </View>
        <Pair label="Wheel rate, N/mm" a={f.wheel_rate_n_per_mm.toFixed(0)} b={b.wheel_rate_n_per_mm.toFixed(0)} />
        <Pair label="Ride frequency, Hz" a={f.ride_frequency_hz.toFixed(2)} b={b.ride_frequency_hz.toFixed(2)} />
        <Pair
          label="Roll stiffness, Nm/deg"
          a={f.roll_stiffness_nm_per_deg.toFixed(0)}
          b={b.roll_stiffness_nm_per_deg.toFixed(0)}
        />
        <Text style={styles.subhead}>Lateral load transfer, N per g</Text>
        <Pair label="Geometric (roll centre)" a={lt('front', 'geometric')} b={lt('rear', 'geometric')} />
        <Pair label="Elastic (springs, bars)" a={lt('front', 'elastic')} b={lt('rear', 'elastic')} />
        <Pair label="Unsprung" a={lt('front', 'unsprung')} b={lt('rear', 'unsprung')} />
        <Pair label="Total" a={lt('front', 'total')} b={lt('rear', 'total')} />
      </View>
      <View style={styles.facts}>
        <Fact label="Ride freq. rear ÷ front" value={r.ride_frequency_ratio.toFixed(2)} />
        <Fact label="Roll stiffness front" value={pct(r.roll_stiffness_front_share)} />
        <Fact label="Roll gradient" value={`${r.roll_gradient_deg_per_g.toFixed(2)} °/g`} />
        <Fact label="Load transfer front" value={pct(r.lateral_load_transfer_front_share)} />
      </View>
      <Text style={styles.sub}>
        Longitudinal transfer {r.longitudinal.per_g_n.toFixed(0)} N per g: +{r.longitudinal.braking_front_gain_n.toFixed(0)} N
        on the front braking at {r.longitudinal.braking_g} g, +{r.longitudinal.acceleration_rear_gain_n.toFixed(0)} N on the
        rear accelerating at {r.longitudinal.acceleration_g} g.
      </Text>
      <View style={styles.card}>
        <Text style={styles.subhead}>Balance</Text>
        <Text style={styles.sub}>
          Front share of load {pct(r.balance.front_weight_share)} · of lateral load transfer{' '}
          {pct(r.balance.lateral_load_transfer_front_share)}
        </Text>
        <Text>{r.balance.reading}</Text>
        {r.balance.reading_at_speed && <Text>{r.balance.reading_at_speed}</Text>}
        <Text style={styles.note}>
          More front share of the load transfer than of the load means more understeer tendency at the limit, all
          else equal.
        </Text>
      </View>
    </Section>
  );
}

function Pair({ label, a, b }: { label: string; a: string; b: string }) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={styles.col}>{a}</Text>
      <Text style={styles.col}>{b}</Text>
    </View>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.fact}>
      <Text style={styles.factLabel}>{label}</Text>
      <Text style={styles.factValue}>{value}</Text>
    </View>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <View style={styles.section}>
      <Text style={styles.h2}>{title}</Text>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { padding: 16, gap: 16, paddingBottom: 48 },
  intro: { opacity: 0.8 },
  section: { gap: 8 },
  h2: { fontSize: 18, fontWeight: '700' },
  field: { gap: 4, paddingVertical: 4, borderBottomWidth: 1, borderColor: '#8882' },
  fieldRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  fieldLabel: { flex: 1, gap: 1 },
  unit: { fontSize: 12, opacity: 0.6 },
  note: { fontSize: 12, opacity: 0.7 },
  input: {
    borderWidth: 1,
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 6,
    width: 96,
    textAlign: 'right',
    fontVariant: ['tabular-nums'],
  },
  wide: { width: '100%', textAlign: 'left' },
  stepper: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  step: { fontSize: 24, fontWeight: '600', paddingHorizontal: 6 },
  stepValue: { fontVariant: ['tabular-nums'] },
  button: { borderRadius: 8, padding: 14, alignItems: 'center' },
  buttonText: { color: '#fff', fontWeight: '600', fontSize: 16 },
  error: { color: '#c8372d' },
  card: { gap: 6, padding: 12, borderRadius: 8, borderWidth: 1, borderColor: '#8883' },
  row: { flexDirection: 'row', alignItems: 'baseline', gap: 8 },
  rowLabel: { flex: 1 },
  col: { width: 64, textAlign: 'right', fontVariant: ['tabular-nums'] },
  num: { fontVariant: ['tabular-nums'] },
  delta: { width: 64, textAlign: 'right', fontWeight: '600' },
  deltaRow: { gap: 2, paddingVertical: 4, borderBottomWidth: 1, borderColor: '#8882' },
  subhead: { fontWeight: '600', marginTop: 4 },
  sub: { opacity: 0.7 },
  summary: { fontWeight: '600' },
  facts: { flexDirection: 'row', flexWrap: 'wrap', gap: 20 },
  fact: { gap: 2, minWidth: 130 },
  factLabel: { fontSize: 12, opacity: 0.6, textTransform: 'uppercase', letterSpacing: 0.5 },
  factValue: { fontSize: 22, fontWeight: '600', fontVariant: ['tabular-nums'] },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { borderWidth: 1, borderColor: '#8884', borderRadius: 16, paddingHorizontal: 12, paddingVertical: 6 },
  dim: { opacity: 0.5 },
});
