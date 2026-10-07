import { Stack, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { StyleSheet } from 'react-native';

import PrintButton from '@/components/PrintButton';
import { Colophon, Fig, Page, Section, TextLink, useWide } from '@/components/Programme';
import { SetupLoader } from '@/components/SetupLoader';
import { Text, View } from '@/components/Themed';
import {
  Actions,
  ErrorLine,
  Field,
  FieldGrid,
  MainAction,
  Note,
  Opening,
  Options,
  SheetRow,
  Stepper,
  SubHead,
  useTableStyles,
  WarnLine,
  Working,
} from '@/components/ToolForm';
import { toolLists, VehicleDetail, VehicleItem } from '@/lib/toolLists';
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
import { Fonts, themed, Type, useTheme } from '@/constants/Theme';

type Axle = 'front' | 'rear';
type FieldDef = { key: keyof Vehicle; label: string; unit: string; percent?: boolean };

const k = (s: string) => s as keyof Vehicle;

const CAR_FIELDS: FieldDef[] = [
  { key: 'mass_kg', label: 'Mass with driver and fuel', unit: 'kg' },
  { key: 'front_weight_fraction', label: 'Front weight', unit: '%', percent: true },
  { key: 'cog_height_mm', label: 'CoG height', unit: 'mm' },
  { key: 'wheelbase_mm', label: 'Wheelbase', unit: 'mm' },
  { key: 'tyre_radius_mm', label: 'Tyre loaded radius', unit: 'mm' },
];

const axleFields = (a: Axle): FieldDef[] => [
  { key: k(`track_${a}_mm`), label: 'Track', unit: 'mm' },
  { key: k(`roll_centre_${a}_mm`), label: 'Roll centre height', unit: 'mm' },
  { key: k(`spring_${a}_n_per_mm`), label: 'Spring rate', unit: 'N/mm' },
  { key: k(`spring_mr_${a}`), label: 'Spring motion ratio', unit: 'spring ÷ wheel' },
  { key: k(`arb_mr_${a}`), label: 'Bar motion ratio', unit: 'link ÷ wheel' },
  { key: k(`tyre_vertical_${a}_n_per_mm`), label: 'Tyre vertical stiffness', unit: 'N/mm' },
  { key: k(`unsprung_${a}_kg`), label: 'Unsprung mass per corner', unit: 'kg' },
];
const AXLE_ROWS = axleFields('front').map((f, i) => ({ front: f, rear: axleFields('rear')[i] }));

const AERO_FIELDS: FieldDef[] = [
  { key: 'downforce_n', label: 'Downforce (0 = none)', unit: 'N' },
  { key: 'aero_balance_front', label: 'Aero balance front', unit: '%', percent: true },
  { key: 'aero_ref_speed_kmh', label: 'at speed', unit: 'km/h' },
  { key: 'braking_g', label: 'Braking', unit: 'g' },
  { key: 'acceleration_g', label: 'Acceleration', unit: 'g' },
];

const NUMERIC: FieldDef[] = [...CAR_FIELDS, ...axleFields('front'), ...axleFields('rear'), ...AERO_FIELDS];

type BarState = { rates: string; setting: number | null; rate: string };

const toText = (v: Partial<Record<keyof Vehicle, unknown>>, f: FieldDef) => {
  const x = v[f.key];
  if (typeof x !== 'number') return ''; // a value the vehicle's specs don't have yet
  return f.percent ? String(Math.round(x * 1000) / 10) : String(x);
};

const CONFIDENCE: Record<string, string> = { stored: "this vehicle's specs" };

/** The vehicle model: the vehicle and a run's setup in, the car's values as a spec sheet (the car, the two axles side
 * by side, aero), then its ride, roll and load transfer as large figures and a table, and what a change would do. */
export default function VehicleScreen() {
  const styles = useStyles();
  const wide = useWide();
  // ?session=<id> loads that run's setup sheet; ?vehicle=<id> picks the vehicle (else the session's)
  const params = useLocalSearchParams<{ session?: string; vehicle?: string }>();
  const [vehicles, setVehicles] = useState<VehicleItem[] | null>(null);
  const [vehicleId, setVehicleId] = useState<number | null>(null); // null: none in the garage, the built-in preset
  const [preset, setPreset] = useState<Preset | VehicleDetail | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
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

  const fill = (v: Partial<Record<keyof Vehicle, unknown>>) => {
    setForm(Object.fromEntries(NUMERIC.map((f) => [f.key, toText(v, f)])));
    const bar = (a: Axle): BarState => ({
      rates: (v[k(`arb_${a}_settings_n_per_mm`)] as number[] | null)?.join(', ') ?? '',
      setting: (v[k(`arb_${a}_setting`)] as number | null) ?? null,
      rate: String(v[k(`arb_${a}_n_per_mm`)] ?? 0),
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

  // the garage's vehicles: the one asked for, else the session's, else the first
  useEffect(() => {
    toolLists.vehicles(params.session ? Number(params.session) : undefined).then(
      (r) => {
        setVehicles(r.vehicles);
        const asked = params.vehicle ? Number(params.vehicle) : null;
        const pick = [asked, r.session_vehicle_id].find((id) => id != null && r.vehicles.some((v) => v.id === id));
        setVehicleId(pick ?? r.vehicles[0]?.id ?? null);
      },
      (e) => {
        setVehicles([]);
        setError(e.message);
      },
    );
  }, []);

  // the picked vehicle's stored specs fill the inputs (the rest from the preset its name points to); with no
  // vehicle in the garage, the built-in preset
  useEffect(() => {
    if (vehicles == null) return;
    let live = true;
    setPreset(null);
    setResult(null);
    setWhatIf(null);
    setSaved(null);
    const load: Promise<Preset | VehicleDetail> =
      vehicleId != null ? toolLists.vehicle(vehicleId) : vehicleApi.preset(DEFAULT_PRESET);
    load.then(
      (p) => {
        if (!live) return;
        setPreset(p);
        fill(p.vehicle);
        if (!('missing' in p) || (!p.missing.length && !p.problem))
          vehicleApi.model(p.vehicle as Vehicle).then((r) => live && setResult(r), (e) => setError(e.message));
      },
      (e) => live && setError(e.message),
    );
    return () => {
      live = false;
    };
  }, [vehicles == null, vehicleId]);

  const pickedVehicle = vehicles?.find((v) => v.id === vehicleId) ?? null;
  const saveToVehicle = async () => {
    if (vehicleId == null) return;
    setSaving(true);
    setError(null);
    setSaved(null);
    try {
      const d = await toolLists.saveVehicle(vehicleId, vehicle());
      setPreset(d);
      setSaved(`Saved as ${d.name}'s specs.`);
      toolLists.vehicles().then((r) => setVehicles(r.vehicles), () => {});
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

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

  const missing = preset && 'missing' in preset ? preset.missing : [];
  const sourceOf = (key: keyof Vehicle) => {
    const v = preset?.values[key];
    return v ? CONFIDENCE[v.confidence] ?? v.confidence : missing.includes(key) ? 'needed' : null;
  };
  const setField = (key: keyof Vehicle) => (t: string) => setForm((s) => ({ ...s, [key]: t }));

  // one value on a line of the sheet
  const input = (f: FieldDef) => {
    const needed = missing.includes(f.key);
    const source = sourceOf(f.key);
    return (
      <SheetRow key={f.key} label={f.label} sub={[f.unit, source].filter(Boolean).join(' · ')} warn={needed}
        note={showSources ? preset?.values[f.key]?.note : null}>
        <Field width={92} align="right" value={form[f.key] ?? ''} onChangeText={setField(f.key)} keyboardType="decimal-pad"
          placeholder={needed ? 'needed' : undefined} warn={needed} selectTextOnFocus
          accessibilityLabel={`${f.label}, ${f.unit}`} />
      </SheetRow>
    );
  };

  // a line of the axles' table: the value front and rear side by side
  const axleRow = ({ front, rear }: { front: FieldDef; rear: FieldDef }) => {
    const sf = sourceOf(front.key);
    const sr = sourceOf(rear.key);
    const source = sf === sr ? sf : [sf && `front ${sf}`, sr && `rear ${sr}`].filter(Boolean).join(', ');
    const nf = preset?.values[front.key]?.note;
    const nr = preset?.values[rear.key]?.note;
    return (
      <SheetRow key={front.key} label={front.label} sub={[front.unit, source].filter(Boolean).join(' · ')}
        warn={missing.includes(front.key) || missing.includes(rear.key)}
        note={showSources ? (nf === nr ? nf : [nf && `Front: ${nf}`, nr && `Rear: ${nr}`].filter(Boolean).join(' ')) : null}>
        {[front, rear].map((f, i) => (
          <View key={f.key} style={wide ? styles.axleCell : styles.axleCellPhone}>
            <Field width={wide ? AXLE_W : AXLE_W_PHONE} align="right" value={form[f.key] ?? ''} onChangeText={setField(f.key)}
              keyboardType="decimal-pad" placeholder={missing.includes(f.key) ? 'needed' : undefined}
              warn={missing.includes(f.key)} selectTextOnFocus
              accessibilityLabel={`${i === 0 ? 'Front' : 'Rear'} ${f.label.toLowerCase()}, ${f.unit}`} />
          </View>
        ))}
      </SheetRow>
    );
  };

  const setBar = (a: Axle, patch: Partial<BarState>) => setBars((s) => ({ ...s, [a]: { ...s[a], ...patch } }));
  const ratesOf = (a: Axle) => bars[a].rates.split(/[,;\s]+/).filter(Boolean).map(Number);
  const barRow = () => {
    const prov = (a: Axle) => preset?.values[k(`arb_${a}_settings_n_per_mm`)];
    const rateNow = (a: Axle) => {
      const rates = ratesOf(a);
      return rates.length ? rates[(bars[a].setting ?? 1) - 1] ?? '–' : bars[a].rate;
    };
    const conf = [prov('front')?.confidence, prov('rear')?.confidence].filter(Boolean);
    return (
      <SheetRow key="bar" label="Anti-roll bar"
        sub={`N/mm at the link: ${rateNow('front')} front, ${rateNow('rear')} rear${conf.length ? ` · ${conf[0]}` : ''}`}
        note={showSources ? [prov('front')?.note, prov('rear')?.note].filter(Boolean).filter((n, i, all) => all.indexOf(n) === i).join(' ') : null}>
        {(['front', 'rear'] as Axle[]).map((a) => {
          const rates = ratesOf(a);
          const b = bars[a];
          return (
            <View key={a} style={wide ? styles.axleCell : styles.axleCellPhone}>
              {rates.length ? (
                <Stepper label={`${a === 'front' ? 'Front' : 'Rear'} bar`} value={String(b.setting ?? 1)} of={`/${rates.length}`}
                  onStep={(d) => setBar(a, { setting: Math.min(rates.length, Math.max(1, (b.setting ?? 1) + d)) })} />
              ) : (
                <Field width={wide ? AXLE_W : AXLE_W_PHONE} align="right" value={b.rate} onChangeText={(t) => setBar(a, { rate: t })}
                  keyboardType="decimal-pad" accessibilityLabel={`${a === 'front' ? 'Front' : 'Rear'} bar rate, N/mm`} />
              )}
            </View>
          );
        })}
      </SheetRow>
    );
  };

  return (
    <Page keyboardShouldPersistTaps="handled">
      <Stack.Screen options={{ title: 'Vehicle model' }} />
      <Opening title="Vehicle model"
        dek={`Weight transfer, roll stiffness and ride frequencies from springs, bars and motion ratios${preset ? `. Starting point: ${startingPoint(preset)}` : '.'}`}>
        <PrintButton title="Vehicle model" />
      </Opening>

      <Section no={1} title="Vehicle" dek="The car model is per vehicle: its stored specs fill the sheet below, and a run’s setup goes on top.">
        <VehiclePicker vehicles={vehicles} vehicleId={vehicleId} onPick={setVehicleId} />
        {missing.length > 0 && (
          <View style={styles.gapTop}>
            <WarnLine>
              {pickedVehicle?.name}’s specs don’t have every input yet: fill in the ones marked “needed”, then save them
              to the vehicle.
            </WarnLine>
          </View>
        )}
        {preset && 'problem' in preset && preset.problem ? (
          <View style={styles.gapTop}><WarnLine>{preset.problem}</WarnLine></View>
        ) : null}
        <View style={styles.loader}>
          <SetupLoader
            initial={params.session ? Number(params.session) : undefined}
            ready={preset != null}
            vehicleId={vehicleId}
            onLoad={(v) => {
              fill(v);
              setWhatIf(null);
              vehicleApi.model(v).then(setResult, (e) => setError(e.message));
            }}
          />
        </View>
      </Section>

      <Section no={2} title="The car" dek="Mass, its centre of gravity and the aero, as the model takes them.">
        <View style={styles.sources}>
          <TextLink small onPress={() => setShowSources((s) => !s)}
            label={showSources ? 'Hide where each value comes from' : 'Show where each value comes from'} />
        </View>
        <View style={wide ? styles.twoCols : undefined}>
          <View style={wide ? styles.col : undefined}>
            <SubHead>Car</SubHead>
            {CAR_FIELDS.map(input)}
          </View>
          <View style={wide ? styles.col : styles.stacked}>
            <SubHead>Aero and longitudinal</SubHead>
            {AERO_FIELDS.map(input)}
          </View>
        </View>
      </Section>

      <Section no={3} title="Axles" dek="Front and rear side by side: track, roll centres, springs, bars and the tyres’ own spring.">
        <View style={styles.axleTable}>
          <View style={styles.axleHead}>
            <Text style={StyleSheet.flatten([styles.axleHeadText, styles.axleHeadName])}>Value</Text>
            <Text style={StyleSheet.flatten([styles.axleHeadText, wide ? styles.axleCell : styles.axleCellPhone, styles.right])}>Front</Text>
            <Text style={StyleSheet.flatten([styles.axleHeadText, wide ? styles.axleCell : styles.axleCellPhone, styles.right])}>Rear</Text>
          </View>
          {AXLE_ROWS.slice(0, 4).map(axleRow)}
          {barRow()}
          {AXLE_ROWS.slice(4).map(axleRow)}
        </View>
        <SubHead style={styles.subGap}>Anti-roll bar rates</SubHead>
        <Note small>Rate at each setting, softest first, in N/mm at the link. Empty: one rate, set above.</Note>
        <FieldGrid columns={wide ? 2 : 1} style={styles.ratesGrid}>
          {(['front', 'rear'] as Axle[]).map((a) => (
            <Field key={a} label={a === 'front' ? 'Front bar' : 'Rear bar'} unit="N/mm" value={bars[a].rates}
              onChangeText={(t) => setBar(a, { rates: t })} placeholder="e.g. 20, 30, 40, 50, 60" />
          ))}
        </FieldGrid>
        <Actions>
          <MainAction label="Calculate" onPress={calculate} />
          {pickedVehicle && (
            <TextLink onPress={saveToVehicle} disabled={saving}
              label={saving ? 'Saving…' : `Save as ${pickedVehicle.name}’s specs`} />
          )}
        </Actions>
        {saved ? <Note small style={styles.gapTop}>{saved}</Note> : null}
        {error ? <View style={styles.gapTop}><ErrorLine>{error}</ErrorLine></View> : null}
      </Section>

      {result && <Results r={result} />}

      {result && (
        <Section no={5} title="What if" dek="Pick one or more changes to the setup above and compare.">
          <Options multi label="Changes" value={picked}
            onPick={(i) => setPicked((p) => (p.includes(i) ? p.filter((x) => x !== i) : [...p, i]))}
            options={quick.map((q, i) => ({ value: i, label: q.label }))} />
          <Actions>
            <MainAction label="Compare" onPress={compare} busy={busy} disabled={!picked.length} />
          </Actions>
          {whatIf && <WhatIf w={whatIf} />}
        </Section>
      )}

      <Colophon left="The Engineer · Vehicle model" links={[
        { label: 'Setup', href: '/tools/setup' },
        { label: 'Tyre fit', href: '/tools/tyre-fit' },
        { label: 'Garage', href: '/garage' },
      ]} />
    </Page>
  );
}

function startingPoint(p: Preset | VehicleDetail): string {
  if (!('stored' in p)) return `${p.name}, with every value it does not publish marked as an estimate.`;
  const stored = `${p.stored.length} value${p.stored.length === 1 ? '' : 's'} from its specs`;
  if (p.base) return `${p.name}: ${stored}, the rest from the ${p.base.name} values (published or estimate).`;
  return `${p.name}: ${stored}.`;
}

// The garage's vehicles: the car model is per vehicle, and its stored specs fill the inputs.
function VehiclePicker({
  vehicles,
  vehicleId,
  onPick,
}: {
  vehicles: VehicleItem[] | null;
  vehicleId: number | null;
  onPick: (id: number) => void;
}) {
  const styles = useStyles();
  if (vehicles == null) return <Working>Reading the garage…</Working>;
  return (
    <View style={styles.picker}>
      {vehicles.length === 0 ? (
        <Note>
          No vehicles in the garage yet, so the inputs start from the built-in values. Add your vehicle there to keep
          its specs.
        </Note>
      ) : (
        <Options label="Vehicle" value={vehicleId} onPick={onPick}
          options={vehicles.map((v) => ({
            value: v.id,
            label: v.name,
            sub: `${v.stored ? `${v.stored} spec${v.stored === 1 ? '' : 's'} stored` : 'no specs yet'}${v.missing.length ? ` · ${v.missing.length} needed` : ''}`,
          }))} />
      )}
      <TextLink href="/garage" label="Add a vehicle in the garage" arrow small />
    </View>
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
const share = (x: number) => (x * 100).toFixed(1);

function Results({ r }: { r: ModelResult }) {
  const styles = useStyles();
  const t = useTableStyles();
  const c = useTheme();
  const wide = useWide();
  const f = r.axles.front;
  const b = r.axles.rear;
  const lt = (a: 'front' | 'rear', part: 'geometric' | 'elastic' | 'unsprung' | 'total') =>
    r.axles[a].lateral_load_transfer_n_per_g[part].toFixed(0);
  const size = wide ? 64 : 48;
  const figs = [
    { label: 'Ride freq. rear ÷ front', value: r.ride_frequency_ratio.toFixed(2) },
    { label: 'Roll stiffness front', value: share(r.roll_stiffness_front_share), unit: '%' },
    { label: 'Roll gradient', value: r.roll_gradient_deg_per_g.toFixed(2), unit: '°/g' },
    { label: 'Load transfer front', value: share(r.lateral_load_transfer_front_share), unit: '%' },
  ];
  const rows: { label: string; a: string; b: string; strong?: boolean }[] = [
    { label: 'Wheel rate, N/mm', a: f.wheel_rate_n_per_mm.toFixed(0), b: b.wheel_rate_n_per_mm.toFixed(0) },
    { label: 'Ride frequency, Hz', a: f.ride_frequency_hz.toFixed(2), b: b.ride_frequency_hz.toFixed(2) },
    { label: 'Roll stiffness, Nm/deg', a: f.roll_stiffness_nm_per_deg.toFixed(0), b: b.roll_stiffness_nm_per_deg.toFixed(0) },
  ];
  const transfer: { label: string; a: string; b: string; strong?: boolean }[] = [
    { label: 'Geometric (roll centre)', a: lt('front', 'geometric'), b: lt('rear', 'geometric') },
    { label: 'Elastic (springs, bars)', a: lt('front', 'elastic'), b: lt('rear', 'elastic') },
    { label: 'Unsprung', a: lt('front', 'unsprung'), b: lt('rear', 'unsprung') },
    { label: 'Total', a: lt('front', 'total'), b: lt('rear', 'total'), strong: true },
  ];
  const table = (head: string, list: typeof rows) => (
    <View style={styles.resultTable}>
      <View style={t.head}>
        <Text style={StyleSheet.flatten([t.th, styles.flex])}>{head}</Text>
        <Text style={StyleSheet.flatten([t.th, t.num, styles.numCol])}>Front</Text>
        <Text style={StyleSheet.flatten([t.th, t.num, styles.numCol])}>Rear</Text>
      </View>
      {list.map((x) => (
        <View key={x.label} style={t.row}>
          <Text style={StyleSheet.flatten([t.name, styles.flex, x.strong && styles.strong])}>{x.label}</Text>
          <Text style={StyleSheet.flatten([t.td, t.num, styles.numCol, x.strong && styles.strong])}>{x.a}</Text>
          <Text style={StyleSheet.flatten([t.td, t.num, styles.numCol, x.strong && styles.strong])}>{x.b}</Text>
        </View>
      ))}
    </View>
  );
  const frontLoad = r.balance.front_weight_share;
  const frontLlt = r.balance.lateral_load_transfer_front_share;
  return (
    <Section no={4} title="Results" dek="The car as the sheet describes it: its ride, its roll and where the load goes in a corner.">
      <View style={wide ? styles.figs : styles.figsPhone}>
        {figs.map((x, i) => (
          <View key={x.label} style={StyleSheet.flatten([wide ? styles.figCell : styles.figCellPhone,
            wide ? i > 0 && styles.figRule : i % 2 === 1 && styles.figRule])}>
            <Fig label={x.label} value={x.value} unit={x.unit} size={size} />
          </View>
        ))}
      </View>
      <View style={wide ? styles.twoCols : undefined}>
        <View style={wide ? styles.col : undefined}>{table('Per axle', rows)}</View>
        <View style={wide ? styles.col : styles.stacked}>{table('Lateral load transfer, N per g', transfer)}</View>
      </View>
      <Note small style={styles.gapTop}>
        Longitudinal transfer {r.longitudinal.per_g_n.toFixed(0)} N per g: +{r.longitudinal.braking_front_gain_n.toFixed(0)} N
        on the front braking at {r.longitudinal.braking_g} g, +{r.longitudinal.acceleration_rear_gain_n.toFixed(0)} N on the
        rear accelerating at {r.longitudinal.acceleration_g} g.
      </Note>

      <SubHead style={styles.subGap}>Balance</SubHead>
      <View style={wide ? styles.balance : styles.balancePhone}>
        <View style={wide ? styles.balanceFigs : styles.balanceFigsPhone}>
          <Fig label="Front share of the load" value={share(frontLoad)} unit="%" size={wide ? 56 : 44}
            bar={c.rule} barHeight={6} style={styles.balanceFig} />
          <Fig label="Of the load transfer" value={share(frontLlt)} unit="%" size={wide ? 56 : 44}
            bar={frontLlt > frontLoad ? c.balance.under : c.balance.over} barHeight={6} style={styles.balanceFig}
            note={frontLlt > frontLoad ? 'More than its share: towards understeer' : 'Less than its share: towards oversteer'} />
        </View>
        <View style={wide ? styles.flex : undefined}>
          <Text style={styles.body}>{r.balance.reading}</Text>
          {r.balance.reading_at_speed ? <Text style={StyleSheet.flatten([styles.body, styles.gapTop])}>{r.balance.reading_at_speed}</Text> : null}
          <Note small style={styles.gapTop}>
            More front share of the load transfer than of the load means more understeer tendency at the limit, all
            else equal.
          </Note>
        </View>
      </View>
    </Section>
  );
}

function WhatIf({ w }: { w: WhatIfResult }) {
  const styles = useStyles();
  const t = useTableStyles();
  const wide = useWide();
  return (
    <View style={styles.whatIf}>
      <Text style={styles.summary}>{w.summary}</Text>
      <View style={t.head}>
        <Text style={StyleSheet.flatten([t.th, styles.flex])}>Measure</Text>
        {wide && <Text style={StyleSheet.flatten([t.th, t.num, styles.wideCol])}>Now → with the change</Text>}
        <Text style={StyleSheet.flatten([t.th, t.num, styles.numCol])}>Change</Text>
      </View>
      {w.deltas.map((d) => (
        <View key={d.key} style={t.row}>
          <View style={styles.flex}>
            <Text style={t.name}>{d.label}</Text>
            {!wide && <Text style={StyleSheet.flatten([t.td, t.muted, styles.small])}>{fmt(d.baseline)} → {fmt(d.changed)} {d.unit}</Text>}
          </View>
          {wide && (
            <Text style={StyleSheet.flatten([t.td, t.num, t.muted, styles.wideCol])}>
              {fmt(d.baseline)} → {fmt(d.changed)} {d.unit}
            </Text>
          )}
          <Text style={StyleSheet.flatten([t.td, t.num, styles.numCol, styles.strong, d.delta === 0 && t.muted])}>
            {d.delta > 0 ? '+' : d.delta < 0 ? '−' : ''}{fmt(Math.abs(d.delta))}
          </Text>
        </View>
      ))}
    </View>
  );
}

const AXLE_W = 104; // a column of the axles' table: an input, or the bar's stepper
const AXLE_W_PHONE = 92;

const useStyles = themed((c) => ({
  gapTop: { marginTop: 12 },
  subGap: { marginTop: 28 },
  stacked: { marginTop: 26 },
  picker: { gap: 14 },
  loader: { marginTop: 20 },
  sources: { marginBottom: 16 },
  twoCols: { flexDirection: 'row', gap: 36 },
  col: { flex: 1, minWidth: 0 },
  axleTable: { maxWidth: 820 },
  axleHead: { flexDirection: 'row', alignItems: 'flex-end', gap: 14, borderBottomWidth: 2, borderColor: c.rule, paddingBottom: 5 },
  axleHeadText: { ...Type.label, fontFamily: Fonts.label, fontSize: 11, letterSpacing: 1.1, color: c.textSecondary },
  axleHeadName: { flex: 1 },
  axleCell: { alignItems: 'flex-end', width: AXLE_W },
  axleCellPhone: { alignItems: 'flex-end', width: AXLE_W_PHONE },
  right: { textAlign: 'right' },
  ratesGrid: { marginTop: 12, maxWidth: 820 },
  figs: { flexDirection: 'row', borderTopWidth: 1, borderBottomWidth: 1, borderColor: c.rule, marginBottom: 26 },
  figsPhone: { flexDirection: 'row', flexWrap: 'wrap', borderTopWidth: 1, borderColor: c.rule, marginBottom: 22 },
  figCell: { flex: 1, minWidth: 0, paddingTop: 12, paddingBottom: 14, paddingHorizontal: 16 },
  figCellPhone: { width: '50%', paddingTop: 10, paddingBottom: 12, paddingHorizontal: 10, borderBottomWidth: 1,
    borderColor: c.rule },
  figRule: { borderLeftWidth: 1, borderColor: c.rule },
  resultTable: {},
  flex: { flex: 1, minWidth: 0 },
  numCol: { width: 76 },
  wideCol: { width: 220 },
  strong: { fontFamily: Type.label.fontFamily },
  small: { fontSize: 13 },
  balance: { flexDirection: 'row', gap: 36, alignItems: 'flex-start', marginTop: 6 },
  balancePhone: { gap: 18, marginTop: 6 },
  balanceFigs: { flexDirection: 'row', gap: 24, width: 480 },
  balanceFigsPhone: { flexDirection: 'row', gap: 18 },
  balanceFig: { flex: 1, minWidth: 0 },
  body: { fontFamily: Fonts.body, fontSize: 17, lineHeight: 24, color: c.text },
  whatIf: { marginTop: 24 },
  summary: { fontFamily: Fonts.body, fontSize: 17, lineHeight: 24, color: c.text, marginBottom: 14 },
}));
