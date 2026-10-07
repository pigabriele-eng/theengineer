import { Stack, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';

import { Colophon, Page, Section, useWide } from '@/components/Programme';
import { View } from '@/components/Themed';
import {
  Actions,
  ErrorLine,
  Field,
  MainAction,
  Note,
  Opening,
  Options,
  SheetRow,
  SubHead,
  Working,
} from '@/components/ToolForm';
import { AxleCard, CurveChart, useAxleColors } from '@/components/TyreCurve';
import { TyreModelView } from '@/components/TyreModelView';
import { api, Session } from '@/lib/api';
import { DEFAULT_PRESET, Preset, TyreFit, Vehicle, vehicleApi } from '@/lib/vehicle';
import { Fonts, themed } from '@/constants/Theme';

type FieldDef = { key: keyof Vehicle; label: string; unit: string; percent?: boolean };

// The car values the fit depends on; the rest of the preset is not used by it.
const FIELDS: FieldDef[] = [
  { key: 'mass_kg', label: 'Mass with driver and fuel', unit: 'kg' },
  { key: 'front_weight_fraction', label: 'Front weight', unit: '%', percent: true },
  { key: 'cog_height_mm', label: 'CoG height', unit: 'mm' },
  { key: 'wheelbase_mm', label: 'Wheelbase', unit: 'mm' },
  { key: 'downforce_n', label: 'Downforce at 200 km/h (0 = none)', unit: 'N' },
  { key: 'aero_balance_front', label: 'Aero balance front', unit: '%', percent: true },
];

type Mode = 'all' | 'one';
const MODES: { value: Mode; label: string }[] = [
  { value: 'all', label: 'Every log' },
  { value: 'one', label: 'One log' },
];

/** Tyre fit: the tyre curve per axle, from the model built up from every log of the car on a tyre, or fitted from the
 * logs picked here. */
export default function TyreFitScreen() {
  const styles = useStyles();
  const [mode, setMode] = useState<Mode>('all');
  return (
    <Page keyboardShouldPersistTaps="handled">
      <Stack.Screen options={{ title: 'Tyre fit' }} />
      <Opening title="Tyre fit"
        dek="Where each axle’s grip peaks and at what slip angle, and which TPMS temperature and hot pressure give the most: from every log of the car on a tyre, or from the logs you pick." />
      <View style={styles.modes}>
        <Options big label="Fit from" value={mode} onPick={setMode} options={MODES} />
      </View>
      {/* both stay mounted, so a single-log fit survives a look at the other mode */}
      <View style={mode !== 'all' ? styles.hidden : undefined}>
        <TyreModelView />
      </View>
      <View style={mode !== 'one' ? styles.hidden : undefined}>
        <SingleLogFit />
      </View>
      <Colophon left="The Engineer · Tyre fit" links={[
        { label: 'Tyre pressures', href: '/tools/pressures' },
        { label: 'Tyre temperatures', href: '/tools/tyre-temps' },
        { label: 'Vehicle model', href: '/tools/vehicle' },
      ]} />
    </Page>
  );
}

function SingleLogFit() {
  const styles = useStyles();
  const wide = useWide();
  const [sessions, setSessions] = useState<Session[]>([]);
  const [picked, setPicked] = useState<number[]>([]);
  const [preset, setPreset] = useState<Preset | null>(null);
  const [form, setForm] = useState<Record<string, string>>({});
  const [ratio, setRatio] = useState('');
  const [fit, setFit] = useState<TyreFit | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  return (
    <>
      <Section no={1} title="Sessions"
        dek="A simplified lateral tyre curve per axle (peak grip, slip angle at the peak, shape) fitted from the steady cornering in the logs you pick: lateral g, yaw rate, steering and speed.">
        {sessions.length === 0 && <Note>Upload a logger file to a session first.</Note>}
        <Options multi label="Sessions" value={picked}
          onPick={(id) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]))}
          options={sessions.map((s) => ({ value: s.id, label: s.name ?? `Session ${s.id}` }))} />
      </Section>

      <Section no={2} title="Car" dek={preset ? `${preset.name}: estimates unless published; edit to your numbers.` : undefined}>
        {!preset && !error && <Working>Reading the car’s values…</Working>}
        <View style={wide ? styles.sheet : undefined}>
          <View style={styles.sheetTop} />
          {FIELDS.map((f) => (
            <SheetRow key={f.key} label={f.label}
              sub={`${f.unit}${preset?.values[f.key] ? ` · ${preset.values[f.key]!.confidence}` : ''}`}>
              <Field width={96} align="right" value={form[f.key] ?? ''}
                onChangeText={(t) => setForm((s) => ({ ...s, [f.key]: t }))} keyboardType="decimal-pad" selectTextOnFocus
                accessibilityLabel={`${f.label}, ${f.unit}`} />
            </SheetRow>
          ))}
          <SheetRow label="Steering ratio (optional)"
            sub="Steering wheel ÷ road wheel. Empty: the logger’s road-wheel angle if it has one, else inferred from the data.">
            <Field width={96} align="right" value={ratio} onChangeText={setRatio} keyboardType="decimal-pad"
              placeholder="auto" accessibilityLabel="Steering ratio" />
          </SheetRow>
        </View>
        <Actions>
          <MainAction label="Fit tyre curves" onPress={run} busy={busy} disabled={!picked.length || !preset} />
          {!picked.length ? <Note small>Pick at least one session above.</Note> : null}
        </Actions>
        {busy && <Note small style={styles.gapTop}>Reading every log; several sessions can take a minute.</Note>}
        {error ? <View style={styles.gapTop}><ErrorLine>{error}</ErrorLine></View> : null}
      </Section>

      {fit && <FitResult fit={fit} />}
    </>
  );
}

function FitResult({ fit }: { fit: TyreFit }) {
  const styles = useStyles();
  const wide = useWide();
  const colors = useAxleColors();
  const steering = fit.sessions[0]?.steering;
  const scale = fit.sessions[0]?.yaw_rate_scale ?? 1;
  return (
    <Section no={3} title="Result" dek={`${fit.samples.toLocaleString()} samples from ${fit.corners} corners in ${fit.sessions.length} session${fit.sessions.length === 1 ? '' : 's'}, ${fit.speed_range_kmh[0]}–${fit.speed_range_kmh[1]} km/h.`}>
      {(steering || Math.abs(scale - 1) > 0.03) && (
        <Note small style={styles.gapBottom}>
          {steering &&
            (steering.source === 'logger'
              ? `Steering: the logger’s road-wheel angle (about ${steering.ratio}:1).`
              : `Steering ratio ${steering.ratio}:1 (${steering.source === 'data' ? 'inferred from the data' : 'entered'}).`)}
          {Math.abs(scale - 1) > 0.03 &&
            ` The yaw-rate sensor read ${Math.round(Math.abs(1 - 1 / scale) * 100)} % ${scale > 1 ? 'low' : 'high'}` +
              ' against lateral g; corrected.'}
        </Note>
      )}
      <CurveChart curves={fit.curves} binned={fit.binned} fits={fit.axles} />
      <View style={wide ? styles.cards : styles.cardsPhone}>
        <AxleCard title="Front axle" f={fit.axles.front} color={colors.front} />
        <AxleCard title="Rear axle" f={fit.axles.rear} color={colors.rear} />
      </View>
      {fit.skipped.length > 0 && (
        <Note small style={styles.gapTop}>
          Not used: {fit.skipped.map((s) => `session ${s.session_id} (${s.reason})`).join('; ')}.
        </Note>
      )}
      <SubHead style={styles.subGap}>How it is estimated</SubHead>
      {fit.assumptions.map((a) => (
        <Note key={a} small style={styles.assumption}>{a}</Note>
      ))}
    </Section>
  );
}

const useStyles = themed((c) => ({
  modes: { marginTop: 18, borderBottomWidth: 1, borderColor: c.rule },
  hidden: { display: 'none' },
  sheet: { maxWidth: 720 },
  sheetTop: { height: 2, backgroundColor: c.rule },
  gapTop: { marginTop: 12 },
  gapBottom: { marginBottom: 14 },
  subGap: { marginTop: 26 },
  cards: { flexDirection: 'row', gap: 32, marginTop: 24 },
  cardsPhone: { gap: 26, marginTop: 24 },
  assumption: { borderBottomWidth: 1, borderColor: c.separator, paddingVertical: 6, fontFamily: Fonts.body },
}));

