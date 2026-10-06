import { Stack, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, TextInput } from 'react-native';

import { Text, View, useThemeColor } from '@/components/Themed';
import { AxleCard, CurveChart, useAxleColors } from '@/components/TyreCurve';
import { TyreModelView } from '@/components/TyreModelView';
import { api, Session } from '@/lib/api';
import { DEFAULT_PRESET, Preset, TyreFit, Vehicle, vehicleApi } from '@/lib/vehicle';
import { Radius, themed, useTheme } from '@/constants/Theme';

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

type Mode = 'all' | 'one';
const MODES: { key: Mode; label: string }[] = [
  { key: 'all', label: 'All data for this car and tyre' },
  { key: 'one', label: 'One log' },
];

export default function TyreFitScreen() {
  const styles = useStyles();
  const [mode, setMode] = useState<Mode>('all');
  const tint = useThemeColor({}, 'tint');
  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Stack.Screen options={{ title: 'Tyre fit' }} />
      <View style={styles.modes} accessibilityRole="tablist">
        {MODES.map((m) => {
          const on = m.key === mode;
          return (
            <Pressable
              key={m.key}
              onPress={() => setMode(m.key)}
              accessibilityRole="tab"
              accessibilityState={{ selected: on }}
              style={on ? [styles.mode, styles.modeOn, { borderColor: tint }] : styles.mode}>
              <Text style={on ? [styles.modeText, { color: tint }] : styles.modeText}>{m.label}</Text>
            </Pressable>
          );
        })}
      </View>
      {/* both stay mounted, so a single-log fit survives a look at the other mode */}
      <View style={[styles.pane, mode !== 'all' && styles.hidden]}>
        <Text style={styles.intro}>
          One tyre model from every session of the car on this tyre: different tyres are different models, and a
          session's tyre is the one set on its event. Each log is summarised once, in the background, and the model
          grows with every run. It shows where the grip peaks and how grip changes with TPMS temperature, hot
          pressure and laps on the tyre.
        </Text>
        <TyreModelView />
      </View>
      <View style={[styles.pane, mode !== 'one' && styles.hidden]}>
        <SingleLogFit />
      </View>
    </ScrollView>
  );
}

function SingleLogFit() {
  const styles = useStyles();
  const theme = useTheme();
  const [sessions, setSessions] = useState<Session[]>([]);
  const [picked, setPicked] = useState<number[]>([]);
  const [preset, setPreset] = useState<Preset | null>(null);
  const [form, setForm] = useState<Record<string, string>>({});
  const [ratio, setRatio] = useState('');
  const [fit, setFit] = useState<TyreFit | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const tint = useThemeColor({}, 'tint');
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
    <>
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
              style={[styles.input, { color: text, borderColor: theme.border }]}
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
            style={[styles.input, { color: text, borderColor: theme.border }]}
            value={ratio}
            onChangeText={setRatio}
            keyboardType="decimal-pad"
            placeholder="auto"
            placeholderTextColor={theme.textMuted}
          />
        </View>
      </View>

      <Pressable
        style={[styles.button, { backgroundColor: tint, opacity: picked.length && preset ? 1 : 0.5 }]}
        onPress={run}
        disabled={!picked.length || !preset || busy}>
        {busy ? <ActivityIndicator color={theme.onTint} /> : <Text style={styles.buttonText}>Fit tyre curves</Text>}
      </Pressable>
      {busy && <Text style={styles.sub}>Reading every log; several sessions can take a minute.</Text>}
      {error && <Text style={styles.error}>{error}</Text>}

      {fit && <FitResult fit={fit} />}
    </>
  );
}

function FitResult({ fit }: { fit: TyreFit }) {
  const styles = useStyles();
  const colors = useAxleColors();
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
      <CurveChart curves={fit.curves} binned={fit.binned} fits={fit.axles} />
      <AxleCard title="Front axle" f={fit.axles.front} color={colors.front} />
      <AxleCard title="Rear axle" f={fit.axles.rear} color={colors.rear} />
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

const useStyles = themed((c) => ({
  container: { padding: 16, gap: 16, paddingBottom: 48 },
  modes: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  mode: { borderWidth: 1, borderColor: c.border, borderRadius: Radius.control, paddingHorizontal: 14, paddingVertical: 8, backgroundColor: c.surface },
  modeOn: { borderWidth: 2, paddingHorizontal: 13, paddingVertical: 7 },
  modeText: { fontWeight: '600' },
  pane: { gap: 16 },
  hidden: { display: 'none' },
  intro: { opacity: 0.8 },
  section: { gap: 8 },
  h2: { fontSize: 18, fontWeight: '700' },
  sub: { opacity: 0.7 },
  subhead: { fontWeight: '600' },
  note: { fontSize: 12, opacity: 0.7 },
  unit: { fontSize: 12, opacity: 0.6 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { borderWidth: 1, borderColor: c.border, borderRadius: Radius.chip, paddingHorizontal: 12, paddingVertical: 6, backgroundColor: c.surface },
  fieldRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 4 },
  fieldLabel: { flex: 1, gap: 1 },
  input: {
    borderWidth: 1,
    borderRadius: Radius.control,
    paddingHorizontal: 8,
    paddingVertical: 6,
    width: 96,
    textAlign: 'right',
    fontVariant: ['tabular-nums'],
  },
  button: { borderRadius: Radius.control, padding: 14, alignItems: 'center' },
  buttonText: { color: c.onTint, fontWeight: '600', fontSize: 16 },
  error: { color: c.error },
}));
