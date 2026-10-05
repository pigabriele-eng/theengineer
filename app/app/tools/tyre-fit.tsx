import { Stack, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { ActivityIndicator, LayoutChangeEvent, Pressable, ScrollView, StyleSheet, TextInput } from 'react-native';
import Svg, { Circle, Line, Path, Text as SvgText } from 'react-native-svg';

import { Text, View, useThemeColor } from '@/components/Themed';
import { useSeriesColors } from '@/components/TraceChart';
import { api, Session } from '@/lib/api';
import { AxleFit, DEFAULT_PRESET, Preset, TyreFit, Vehicle, vehicleApi } from '@/lib/vehicle';

type Field = { key: keyof Vehicle; label: string; unit: string; percent?: boolean };

// The car values the fit depends on; the rest of the preset is not used by it.
const FIELDS: Field[] = [
  { key: 'mass_kg', label: 'Mass with driver and fuel', unit: 'kg' },
  { key: 'front_weight_fraction', label: 'Front weight', unit: '%', percent: true },
  { key: 'cog_height_mm', label: 'CoG height', unit: 'mm' },
  { key: 'wheelbase_mm', label: 'Wheelbase', unit: 'mm' },
  { key: 'downforce_n', label: 'Downforce at 200 km/h (0 = none)', unit: 'N' },
  { key: 'aero_balance_front', label: 'Aero balance front', unit: '%', percent: true },
];

export default function TyreFitScreen() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [picked, setPicked] = useState<number[]>([]);
  const [preset, setPreset] = useState<Preset | null>(null);
  const [form, setForm] = useState<Record<string, string>>({});
  const [ratio, setRatio] = useState('');
  const [fit, setFit] = useState<TyreFit | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const tint = useThemeColor({}, 'tint');
  const background = useThemeColor({}, 'background');
  const text = useThemeColor({}, 'text');

  useFocusEffect(
    useCallback(() => {
      api.sessions().then(setSessions, (e) => setError(e.message));
      vehicleApi.preset(DEFAULT_PRESET).then((p) => {
        setPreset(p);
        setForm((f) =>
          Object.keys(f).length
            ? f
            : Object.fromEntries(
                FIELDS.map((x) => {
                  const v = p.vehicle[x.key] as number;
                  return [x.key, x.percent ? String(Math.round(v * 1000) / 10) : String(v)];
                }),
              ),
        );
      }, (e) => setError(e.message));
    }, []),
  );

  const run = async () => {
    if (!preset) return;
    setBusy(true);
    setError(null);
    setFit(null);
    try {
      const vehicle: Record<string, unknown> = { ...preset.vehicle, aero_ref_speed_kmh: 200 };
      for (const f of FIELDS) {
        const x = Number((form[f.key] ?? '').replace(',', '.'));
        if (!Number.isFinite(x) || !form[f.key]?.trim()) throw new Error(`Check "${f.label}"`);
        vehicle[f.key] = f.percent ? x / 100 : x;
      }
      const r = ratio.trim() ? Number(ratio.replace(',', '.')) : null;
      if (r != null && !(r > 0)) throw new Error('The steering ratio must be a positive number');
      setFit(await vehicleApi.tyreFit({ session_ids: picked, vehicle: vehicle as Vehicle, steering_ratio: r }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const chip = (on: boolean) => [styles.chip, on && { borderColor: tint }];

  return (
    <ScrollView style={{ backgroundColor: background }} contentContainerStyle={styles.container}>
      <Stack.Screen options={{ title: 'Tyre fit' }} />
      <Text style={styles.intro}>
        A simplified lateral tyre curve per axle (peak grip, slip angle at the peak, shape) fitted from the steady
        cornering in your logs: lateral g, yaw rate, steering and speed.
      </Text>

      <View style={styles.section}>
        <Text style={styles.h2}>Sessions</Text>
        {sessions.length === 0 && <Text style={styles.sub}>Upload a logger file to a session first.</Text>}
        <View style={styles.chips}>
          {sessions.map((s) => {
            const on = picked.includes(s.id);
            return (
              <Pressable
                key={s.id}
                onPress={() => setPicked((p) => (on ? p.filter((x) => x !== s.id) : [...p, s.id]))}
                style={chip(on)}>
                <Text style={on ? { color: tint } : undefined}>{s.name ?? `Session ${s.id}`}</Text>
              </Pressable>
            );
          })}
        </View>
      </View>

      <View style={styles.section}>
        <Text style={styles.h2}>Car</Text>
        {preset && <Text style={styles.sub}>{preset.name}: estimates unless published; edit to your numbers.</Text>}
        {FIELDS.map((f) => (
          <View key={f.key} style={styles.fieldRow}>
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
        ))}
        <View style={styles.fieldRow}>
          <View style={styles.fieldLabel}>
            <Text>Steering ratio (optional)</Text>
            <Text style={styles.unit}>
              Steering wheel ÷ road wheel. Empty: the logger's road-wheel angle if it has one, else inferred from the
              data.
            </Text>
          </View>
          <TextInput
            style={[styles.input, { color: text, borderColor: '#8884' }]}
            value={ratio}
            onChangeText={setRatio}
            keyboardType="decimal-pad"
            placeholder="auto"
            placeholderTextColor="#8888"
          />
        </View>
      </View>

      <Pressable
        style={[styles.button, { backgroundColor: tint, opacity: picked.length && preset ? 1 : 0.5 }]}
        onPress={run}
        disabled={!picked.length || !preset || busy}>
        {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>Fit tyre curves</Text>}
      </Pressable>
      {busy && <Text style={styles.sub}>Reading every log; several sessions can take a minute.</Text>}
      {error && <Text style={styles.error}>{error}</Text>}

      {fit && <FitResult fit={fit} />}
    </ScrollView>
  );
}

function FitResult({ fit }: { fit: TyreFit }) {
  const colors = useSeriesColors();
  const steering = fit.sessions[0]?.steering;
  const scale = fit.sessions[0]?.yaw_rate_scale ?? 1;
  return (
    <View style={styles.section}>
      <Text style={styles.h2}>Result</Text>
      <Text style={styles.sub}>
        {fit.samples.toLocaleString()} samples from {fit.corners} corners in {fit.sessions.length} session
        {fit.sessions.length === 1 ? '' : 's'}, {fit.speed_range_kmh[0]}–{fit.speed_range_kmh[1]} km/h.
        {steering &&
          (steering.source === 'logger'
            ? ` Steering: the logger's road-wheel angle (about ${steering.ratio}:1).`
            : ` Steering ratio ${steering.ratio}:1 (${steering.source === 'data' ? 'inferred from the data' : 'entered'}).`)}
        {Math.abs(scale - 1) > 0.03 &&
          ` The yaw-rate sensor read ${Math.round(Math.abs(1 - 1 / scale) * 100)} % ${scale > 1 ? 'low' : 'high'}` +
            ' against lateral g; corrected.'}
      </Text>
      <CurveChart fit={fit} />
      <View style={styles.legend}>
        <Text>
          <Text style={{ color: colors.reference }}>●</Text> Front <Text style={{ color: colors.compare }}>●</Text> Rear
        </Text>
        <Text style={styles.unit}>Lines: fitted curve. Dots: median slip angle at each grip level.</Text>
      </View>
      <Axle title="Front axle" f={fit.axles.front} color={colors.reference} />
      <Axle title="Rear axle" f={fit.axles.rear} color={colors.compare} />
      {fit.skipped.length > 0 && (
        <Text style={styles.sub}>
          Not used: {fit.skipped.map((s) => `session ${s.session_id} (${s.reason})`).join('; ')}.
        </Text>
      )}
      <Text style={styles.subhead}>How it is estimated</Text>
      {fit.assumptions.map((a) => (
        <Text key={a} style={styles.note}>
          · {a}
        </Text>
      ))}
    </View>
  );
}

function Axle({ title, f, color }: { title: string; f: AxleFit; color: string }) {
  const range = (r?: [number, number], digits = 2) => (r ? ` (${r[0].toFixed(digits)}–${r[1].toFixed(digits)})` : '');
  return (
    <View style={styles.card}>
      <Text style={[styles.subhead, { color }]}>{title}</Text>
      <Row
        label="Peak grip (mu)"
        value={f.peak_reached ? `${f.peak_mu.toFixed(2)}${range(f.peak_mu_range)}` : `above ${f.mu_observed_max.toFixed(2)}`}
      />
      <Row
        label="Slip angle at the peak"
        value={f.peak_reached ? `${f.slip_at_peak_deg.toFixed(1)}°${range(f.slip_at_peak_range_deg, 1)}` : 'not reached'}
      />
      <Row label="Shape" value={`${f.shape.toFixed(2)}${f.shape_fitted ? '' : ' (assumed)'}`} />
      <Row label="Grip reached" value={`mu ${f.mu_observed_max.toFixed(2)} at ${f.slip_at_mu_max_deg.toFixed(1)}°`} />
      <Row label="Cornering stiffness" value={`${f.cornering_stiffness_mu_per_deg.toFixed(2)} mu/deg`} />
      <Row label="Slip offset" value={`${f.slip_offset_deg.toFixed(1)}°`} />
      <Row
        label="Fit quality"
        value={`R² ${f.r2 ?? '–'} · slip scatter ${f.slip_scatter_deg.toFixed(1)}° · ${f.samples.toLocaleString()} samples`}
      />
      {f.note && <Text style={styles.note}>{f.note}</Text>}
    </View>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={styles.num}>{value}</Text>
    </View>
  );
}

const PAD = { left: 36, right: 8, top: 8, bottom: 22 };

/** Grip (mu) against slip angle: each axle's fitted curve and the binned data it was fitted through. */
function CurveChart({ fit, height = 220 }: { fit: TyreFit; height?: number }) {
  const [width, setWidth] = useState(0);
  const colors = useSeriesColors();
  const muted = useThemeColor({}, 'text');
  const xs = fit.curves.alpha_deg;
  const axles = [
    { key: 'front' as const, color: colors.reference },
    { key: 'rear' as const, color: colors.compare },
  ];
  const lo = Math.min(0, ...axles.flatMap((a) => fit.binned[a.key].alpha_deg));
  const hi = Math.max(xs[xs.length - 1], ...axles.flatMap((a) => fit.binned[a.key].alpha_deg));
  const top = Math.ceil(Math.max(...axles.flatMap((a) => [...fit.curves[a.key], ...fit.binned[a.key].mu])) * 5) / 5;
  const w = Math.max(width - PAD.left - PAD.right, 1);
  const h = height - PAD.top - PAD.bottom;
  const x = (deg: number) => PAD.left + ((deg - lo) / (hi - lo || 1)) * w;
  const y = (mu: number) => PAD.top + (1 - Math.max(mu, 0) / (top || 1)) * h;
  const ticks = Array.from({ length: Math.floor(hi) - Math.ceil(lo) + 1 }, (_, i) => Math.ceil(lo) + i).filter(
    (t) => t % (hi - lo > 8 ? 2 : 1) === 0,
  );
  return (
    <View onLayout={(e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width)}>
      {width > 0 && (
        <Svg width={width} height={height}>
          {[0, top / 2, top].map((m) => (
            <Line key={m} x1={PAD.left} x2={width - PAD.right} y1={y(m)} y2={y(m)} stroke={muted} strokeOpacity={0.15} />
          ))}
          {[top / 2, top].map((m) => (
            <SvgText key={m} x={PAD.left - 4} y={y(m) + 4} fontSize={10} fill={muted} fillOpacity={0.6} textAnchor="end">
              {m.toFixed(1)}
            </SvgText>
          ))}
          <SvgText x={PAD.left - 4} y={PAD.top + h} fontSize={10} fill={muted} fillOpacity={0.6} textAnchor="end">
            mu
          </SvgText>
          {ticks.map((t) => (
            <SvgText key={t} x={x(t)} y={height - 6} fontSize={10} fill={muted} fillOpacity={0.6} textAnchor="middle">
              {`${t}°`}
            </SvgText>
          ))}
          {axles.map((a) =>
            fit.binned[a.key].alpha_deg.map((deg, i) => (
              <Circle key={`${a.key}${i}`} cx={x(deg)} cy={y(fit.binned[a.key].mu[i])} r={2.5} fill={a.color} fillOpacity={0.5} />
            )),
          )}
          {axles.map((a) => (
            <Path
              key={a.key}
              d={xs.map((deg, i) => `${i ? 'L' : 'M'}${x(deg).toFixed(1)},${y(fit.curves[a.key][i]).toFixed(1)}`).join('')}
              stroke={a.color}
              strokeWidth={2}
              fill="none"
            />
          ))}
        </Svg>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { padding: 16, gap: 16, paddingBottom: 48 },
  intro: { opacity: 0.8 },
  section: { gap: 8 },
  h2: { fontSize: 18, fontWeight: '700' },
  sub: { opacity: 0.7 },
  subhead: { fontWeight: '600' },
  note: { fontSize: 12, opacity: 0.7 },
  unit: { fontSize: 12, opacity: 0.6 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { borderWidth: 1, borderColor: '#8884', borderRadius: 16, paddingHorizontal: 12, paddingVertical: 6 },
  fieldRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 4 },
  fieldLabel: { flex: 1, gap: 1 },
  input: {
    borderWidth: 1,
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 6,
    width: 96,
    textAlign: 'right',
    fontVariant: ['tabular-nums'],
  },
  button: { borderRadius: 8, padding: 14, alignItems: 'center' },
  buttonText: { color: '#fff', fontWeight: '600', fontSize: 16 },
  error: { color: '#c8372d' },
  legend: { gap: 2 },
  card: { gap: 4, padding: 12, borderRadius: 8, borderWidth: 1, borderColor: '#8883' },
  row: { flexDirection: 'row', justifyContent: 'space-between', gap: 12 },
  rowLabel: { opacity: 0.7 },
  num: { fontVariant: ['tabular-nums'], textAlign: 'right', flexShrink: 1 },
});
