import { Stack, useFocusEffect } from 'expo-router';
import { ReactNode, useCallback, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, TextInput, useWindowDimensions } from 'react-native';

import { Text, View, useThemeColor } from '@/components/Themed';
import { dayLabel } from '@/lib/events';
import { carLong, Garage, garageApi, GarageCar, GarageDriver, GarageTeam, Logger } from '@/lib/garage';
import { Radius, themed, useTheme } from '@/constants/Theme';

const WIDE = 900;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

type Editing = { kind: 'car' | 'driver' | 'team'; id: number | null } | null; // id null: a new one

/** Cars (number, model, team, logger, drivers), drivers (team, cars) and teams: add, change and remove them here.
 * Runs are tagged on the event page and the session page, with the driver and car chips. */
export default function GarageScreen() {
  const styles = useStyles();
  const [garage, setGarage] = useState<Garage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Editing>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const { width } = useWindowDimensions();
  const wide = width >= WIDE;

  const load = useCallback(() => {
    garageApi.get().then(
      (g) => {
        setGarage(g);
        setError(null);
      },
      (e) => setError((e as Error).message),
    );
  }, []);
  useFocusEffect(load);

  const done = (message?: string) => {
    setEditing(null);
    setNotice(message ?? null);
    load();
  };
  const isEditing = (kind: 'car' | 'driver' | 'team', id: number | null) => editing?.kind === kind && editing.id === id;
  const edit = (kind: 'car' | 'driver' | 'team', id: number | null) => {
    setNotice(null);
    setEditing(isEditing(kind, id) ? null : { kind, id });
  };

  const cars = garage && (
    <Section title="Cars" add="Add car" onAdd={() => edit('car', null)}>
      {isEditing('car', null) && <CarForm garage={garage} onDone={done} onCancel={() => setEditing(null)} />}
      {garage.cars.map((c) => (
        <Item key={c.id} title={carLong(c)}
          sub={[c.team, c.loggers.length ? `logger ${c.loggers.join(', ')}` : 'no logger linked',
            names(garage.drivers, c.driver_ids), plural(c.runs, 'run')].filter(Boolean).join(' · ')}
          open={isEditing('car', c.id)} onPress={() => edit('car', c.id)}>
          <CarForm car={c} garage={garage} onDone={done} onCancel={() => setEditing(null)} />
        </Item>
      ))}
      {garage.cars.length === 0 && !isEditing('car', null) && (
        <Text style={styles.note}>No cars yet. Add one with its number and model, and link its logger.</Text>
      )}
    </Section>
  );
  const drivers = garage && (
    <Section title="Drivers" add="Add driver" onAdd={() => edit('driver', null)}>
      {isEditing('driver', null) && <DriverForm garage={garage} onDone={done} onCancel={() => setEditing(null)} />}
      {garage.drivers.map((d) => (
        <Item key={d.id} title={d.name}
          sub={[d.team, d.car_ids.map((id) => carName(garage, id)).join(', '), plural(d.runs, 'run')]
            .filter(Boolean).join(' · ')}
          open={isEditing('driver', d.id)} onPress={() => edit('driver', d.id)}>
          <DriverForm driver={d} garage={garage} onDone={done} onCancel={() => setEditing(null)} />
        </Item>
      ))}
      {garage.drivers.length === 0 && !isEditing('driver', null) && <Text style={styles.note}>No drivers yet.</Text>}
    </Section>
  );
  const teams = garage && (
    <Section title="Teams" add="Add team" onAdd={() => edit('team', null)}>
      {isEditing('team', null) && <TeamForm onDone={done} onCancel={() => setEditing(null)} />}
      {garage.teams.map((t) => (
        <Item key={t.id} title={t.name}
          sub={[plural(t.car_ids.length, 'car'), plural(t.driver_ids.length, 'driver')].join(' · ')}
          open={isEditing('team', t.id)} onPress={() => edit('team', t.id)}>
          <TeamForm team={t} onDone={done} onCancel={() => setEditing(null)} />
        </Item>
      ))}
      {garage.teams.length === 0 && !isEditing('team', null) && <Text style={styles.note}>No teams yet.</Text>}
    </Section>
  );
  const loggers = garage && garage.loggers.length > 0 && (
    <Section title="Loggers in the logs">
      <Text style={styles.note}>
        Each log carries its logger&apos;s serial number. Link a logger to its car (edit the car) and every run from it
        gets the car, now and with each new upload.
      </Text>
      {garage.loggers.map((l) => (
        <View key={l.serial} style={styles.item}>
          <Text style={styles.itemTitle}>{loggerWords(l)}</Text>
          <Text style={StyleSheet.flatten([styles.sub, l.car_id == null && styles.dim])}>
            {l.car_id != null ? `in ${carName(garage, l.car_id)}` : 'not linked to a car'}
          </Text>
        </View>
      ))}
    </Section>
  );

  return (
    <ScrollView contentContainerStyle={styles.outer}>
      <Stack.Screen options={{ title: 'Cars, drivers and teams' }} />
      <View style={styles.page}>
        <Text style={styles.intro}>
          Your cars, drivers and teams. Tag a run&apos;s driver and car on the event page: tap the chips under the run.
        </Text>
        {!garage && !error && <ActivityIndicator />}
        {error && <Text style={styles.error}>{error}</Text>}
        {notice && (
          <Pressable onPress={() => setNotice(null)}>
            <Text style={styles.notice}>{notice}</Text>
          </Pressable>
        )}
        {garage && (wide ? (
          <View style={styles.columns}>
            <View style={styles.column}>{cars}{loggers}</View>
            <View style={styles.column}>{drivers}</View>
            <View style={styles.column}>{teams}</View>
          </View>
        ) : (
          <>
            {cars}
            {drivers}
            {teams}
            {loggers}
          </>
        ))}
      </View>
    </ScrollView>
  );
}

const names = (drivers: GarageDriver[], ids: number[]) =>
  ids.map((id) => drivers.find((d) => d.id === id)?.name).filter(Boolean).join(', ');

const carName = (garage: Garage, id: number) => {
  const c = garage.cars.find((x) => x.id === id);
  return c ? (c.number ? `#${c.number}` : c.name) : '';
};

const loggerWords = (l: Logger) =>
  [`${l.serial}`, l.venue, l.last ? dayLabel(l.last, { year: true }) : null, plural(l.runs, 'run')]
    .filter(Boolean).join(' · ');

function Section({ title, add, onAdd, children }: { title: string; add?: string; onAdd?: () => void; children: ReactNode }) {
  const styles = useStyles();
  const tint = useThemeColor({}, 'tint');
  return (
    <View style={styles.section}>
      <View style={styles.sectionHead}>
        <Text style={styles.h2}>{title}</Text>
        {add && onAdd && (
          <Pressable onPress={onAdd} accessibilityRole="button" style={StyleSheet.flatten([styles.add, { borderColor: tint }])}>
            <Text style={StyleSheet.flatten([styles.addText, { color: tint }])}>+ {add}</Text>
          </Pressable>
        )}
      </View>
      {children}
    </View>
  );
}

function Item({ title, sub, open, onPress, children }: {
  title: string;
  sub: string;
  open: boolean;
  onPress: () => void;
  children: ReactNode;
}) {
  const styles = useStyles();
  const tint = useThemeColor({}, 'tint');
  return (
    <View style={styles.item}>
      <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={`Edit ${title}`} style={styles.itemHead}>
        <View style={styles.itemText}>
          <Text style={styles.itemTitle}>{title}</Text>
          {sub ? <Text style={styles.sub}>{sub}</Text> : null}
        </View>
        <Text style={{ color: tint }}>{open ? 'Close' : 'Edit'}</Text>
      </Pressable>
      {open && children}
    </View>
  );
}

function Chip({ label, on, onPress, dashed }: { label: string; on: boolean; onPress: () => void; dashed?: boolean }) {
  const styles = useStyles();
  const tint = useThemeColor({}, 'tint');
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityState={{ selected: on }}
      style={StyleSheet.flatten([styles.chip, dashed && styles.dashed, on && { borderColor: tint, borderStyle: 'solid' as const }])}>
      <Text style={StyleSheet.flatten([styles.chipText, on && { color: tint }])}>{label}</Text>
    </Pressable>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  const styles = useStyles();
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      {children}
    </View>
  );
}

/** A team: one of the teams, a new one typed, or none. */
type TeamPick = { id: number | null } | { name: string };

function TeamChoice({ teams, value, onChange }: { teams: GarageTeam[]; value: TeamPick; onChange: (t: TeamPick) => void }) {
  const styles = useStyles();
  const theme = useTheme();
  const text = useThemeColor({}, 'text');
  const typing = 'name' in value;
  return (
    <View style={styles.chips}>
      {teams.map((t) => (
        <Chip key={t.id} label={t.name} on={'id' in value && value.id === t.id} onPress={() => onChange({ id: t.id })} />
      ))}
      <Chip label="No team" on={'id' in value && value.id == null} onPress={() => onChange({ id: null })} dashed />
      {typing ? (
        <TextInput value={value.name} onChangeText={(name) => onChange({ name })} placeholder="New team" autoFocus
          placeholderTextColor={theme.textMuted} maxLength={120} accessibilityLabel="New team's name"
          style={StyleSheet.flatten([styles.input, styles.inlineInput, { color: text }])} />
      ) : (
        <Chip label="+ New team" on={false} onPress={() => onChange({ name: '' })} dashed />
      )}
    </View>
  );
}

const teamFields = (t: TeamPick) =>
  'name' in t ? (t.name.trim() ? { team_name: t.name.trim() } : { team_id: null }) : { team_id: t.id };

function FormButtons({ busy, onSave, onCancel, removeLabel, removeQuestion, onRemove }: {
  busy: boolean;
  onSave: () => void;
  onCancel: () => void;
  removeLabel?: string;
  removeQuestion?: string;
  onRemove?: () => void;
}) {
  const styles = useStyles();
  const [confirm, setConfirm] = useState(false);
  const tint = useThemeColor({}, 'tint');
  const onTint = useThemeColor({}, 'onTint');
  return (
    <View style={styles.buttons}>
      <Pressable onPress={onSave} disabled={busy} accessibilityRole="button"
        style={StyleSheet.flatten([styles.save, { backgroundColor: tint }])}>
        {busy ? <ActivityIndicator color={onTint} />
          : <Text style={StyleSheet.flatten([styles.saveText, { color: onTint }])}>Save</Text>}
      </Pressable>
      <Pressable onPress={onCancel} hitSlop={8} accessibilityRole="button">
        <Text style={{ color: tint }}>Cancel</Text>
      </Pressable>
      {onRemove && removeLabel && (
        <Pressable onPress={() => (confirm ? onRemove() : setConfirm(true))} hitSlop={8} accessibilityRole="button"
          style={styles.remove}>
          <Text style={styles.danger}>{confirm ? `${removeQuestion} Tap again to remove.` : removeLabel}</Text>
        </Pressable>
      )}
    </View>
  );
}

function useSaver(onDone: (message?: string) => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (work: () => Promise<string | undefined | void>) => {
    setBusy(true);
    setError(null);
    try {
      const message = await work();
      onDone(message || undefined);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };
  return { busy, error, setError, run };
}

function CarForm({ car, garage, onDone, onCancel }: {
  car?: GarageCar;
  garage: Garage;
  onDone: (message?: string) => void;
  onCancel: () => void;
}) {
  const styles = useStyles();
  const theme = useTheme();
  const [number, setNumber] = useState(car?.number ?? '');
  const [model, setModel] = useState(car?.model ?? (car ? car.name : garage.models[0] ?? ''));
  const [team, setTeam] = useState<TeamPick>({ id: car?.team_id ?? null });
  const [loggers, setLoggers] = useState<number[]>(car?.loggers ?? []);
  const [serial, setSerial] = useState('');
  const [driverIds, setDriverIds] = useState<number[]>(car?.driver_ids ?? []);
  const { busy, error, setError, run } = useSaver(onDone);
  const text = useThemeColor({}, 'text');
  const tint = useThemeColor({}, 'tint');
  const toggle = <T,>(list: T[], v: T) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  const typedSerial = () => {
    const n = Number(serial.trim());
    if (!Number.isInteger(n) || n <= 0) return setError('A logger serial number is a whole number, e.g. 26580.');
    setLoggers((l) => (l.includes(n) ? l : [...l, n]));
    setSerial('');
  };
  const known = [...garage.loggers, ...loggers.filter((s) => !garage.loggers.some((l) => l.serial === s))
    .map((s) => ({ serial: s, runs: 0, last: null, venue: null, car_id: car?.id ?? null }))];
  const save = () => run(async () => {
    if (!number.trim() && !model.trim()) throw new Error('Give the car a number or a model.');
    const body = { number: number.trim() || null, model: model.trim() || null, ...teamFields(team), loggers,
      driver_ids: driverIds };
    const r = car ? await garageApi.updateCar(car.id, body) : await garageApi.addCar(body);
    return r.filled.length
      ? `${carLong(r.car)} is now set on ${plural(r.filled.length, 'run')} from its logger.` : undefined;
  });
  return (
    <View style={styles.form}>
      <View style={styles.formRow}>
        <Field label="Number">
          <TextInput value={number} onChangeText={setNumber} placeholder="21" placeholderTextColor={theme.textMuted} maxLength={8}
            accessibilityLabel="Car number" style={StyleSheet.flatten([styles.input, styles.number, { color: text }])} />
        </Field>
        <View style={styles.grow}>
          <Field label="Model">
            <TextInput value={model} onChangeText={setModel} placeholder="BMW M4 GT4 Evo (G82)" placeholderTextColor={theme.textMuted}
              maxLength={100} accessibilityLabel="Car model" style={StyleSheet.flatten([styles.input, { color: text }])} />
          </Field>
        </View>
      </View>
      {garage.models.length > 0 && (
        <View style={styles.chips}>
          {garage.models.map((m) => <Chip key={m} label={m} on={m === model} onPress={() => setModel(m)} />)}
        </View>
      )}
      <Field label="Team">
        <TeamChoice teams={garage.teams} value={team} onChange={setTeam} />
      </Field>
      <Field label="Logger">
        <View style={styles.chips}>
          {known.map((l) => {
            const other = l.car_id != null && l.car_id !== car?.id && !loggers.includes(l.serial);
            return (
              <Chip key={l.serial} on={loggers.includes(l.serial)} onPress={() => setLoggers((x) => toggle(x, l.serial))}
                label={[`${l.serial}`, l.venue, plural(l.runs, 'run'), other ? `in ${carName(garage, l.car_id!)}` : null]
                  .filter(Boolean).join(' · ')} />
            );
          })}
        </View>
        <View style={styles.formRow}>
          <TextInput value={serial} onChangeText={setSerial} placeholder="Serial number" placeholderTextColor={theme.textMuted}
            keyboardType="number-pad" maxLength={12} onSubmitEditing={typedSerial} accessibilityLabel="Logger serial number"
            style={StyleSheet.flatten([styles.input, styles.serial, { color: text }])} />
          <Pressable onPress={typedSerial} accessibilityRole="button" hitSlop={8}>
            <Text style={{ color: tint }}>Add</Text>
          </Pressable>
        </View>
        <Text style={styles.note}>Every run from a linked logger gets this car, now and with each new upload.</Text>
      </Field>
      {garage.drivers.length > 0 && (
        <Field label="Drivers">
          <View style={styles.chips}>
            {garage.drivers.map((d) => (
              <Chip key={d.id} label={d.name} on={driverIds.includes(d.id)} onPress={() => setDriverIds((x) => toggle(x, d.id))} />
            ))}
          </View>
        </Field>
      )}
      {error && <Text style={styles.error}>{error}</Text>}
      <FormButtons busy={busy} onSave={save} onCancel={onCancel}
        removeLabel={car ? 'Remove car' : undefined}
        removeQuestion={car ? `Remove ${carLong(car)}? Its ${plural(car.runs, 'run')} stay, without a car.` : undefined}
        onRemove={car ? () => run(async () => {
          await garageApi.removeCar(car.id);
          return `${carLong(car)} removed.`;
        }) : undefined} />
    </View>
  );
}

function DriverForm({ driver, garage, onDone, onCancel }: {
  driver?: GarageDriver;
  garage: Garage;
  onDone: (message?: string) => void;
  onCancel: () => void;
}) {
  const styles = useStyles();
  const theme = useTheme();
  const [name, setName] = useState(driver?.name ?? '');
  const [team, setTeam] = useState<TeamPick>({ id: driver?.team_id ?? null });
  const [carIds, setCarIds] = useState<number[]>(driver?.car_ids ?? []);
  const { busy, error, run } = useSaver(onDone);
  const text = useThemeColor({}, 'text');
  const save = () => run(async () => {
    if (!name.trim()) throw new Error("Give the driver's name.");
    const body = { name: name.trim(), ...teamFields(team), car_ids: carIds };
    if (driver) await garageApi.updateDriver(driver.id, body);
    else await garageApi.addDriver(body);
  });
  return (
    <View style={styles.form}>
      <Field label="Name">
        <TextInput value={name} onChangeText={setName} placeholder="Name" placeholderTextColor={theme.textMuted} maxLength={120}
          autoFocus={!driver} accessibilityLabel="Driver's name" style={StyleSheet.flatten([styles.input, { color: text }])} />
      </Field>
      <Field label="Team">
        <TeamChoice teams={garage.teams} value={team} onChange={setTeam} />
      </Field>
      {garage.cars.length > 0 && (
        <Field label="Drives">
          <View style={styles.chips}>
            {garage.cars.map((c) => (
              <Chip key={c.id} label={carLong(c)} on={carIds.includes(c.id)}
                onPress={() => setCarIds((x) => (x.includes(c.id) ? x.filter((y) => y !== c.id) : [...x, c.id]))} />
            ))}
          </View>
        </Field>
      )}
      {error && <Text style={styles.error}>{error}</Text>}
      <FormButtons busy={busy} onSave={save} onCancel={onCancel}
        removeLabel={driver ? 'Remove driver' : undefined}
        removeQuestion={driver ? `Remove ${driver.name}? Their ${plural(driver.runs, 'run')} stay, without a driver.` : undefined}
        onRemove={driver ? () => run(async () => {
          await garageApi.removeDriver(driver.id);
          return `${driver.name} removed.`;
        }) : undefined} />
    </View>
  );
}

function TeamForm({ team, onDone, onCancel }: { team?: GarageTeam; onDone: (message?: string) => void; onCancel: () => void }) {
  const styles = useStyles();
  const theme = useTheme();
  const [name, setName] = useState(team?.name ?? '');
  const { busy, error, run } = useSaver(onDone);
  const text = useThemeColor({}, 'text');
  const save = () => run(async () => {
    if (!name.trim()) throw new Error('Give the team a name.');
    if (team) await garageApi.renameTeam(team.id, name.trim());
    else await garageApi.addTeam(name.trim());
  });
  return (
    <View style={styles.form}>
      <Field label="Name">
        <TextInput value={name} onChangeText={setName} placeholder="Team name" placeholderTextColor={theme.textMuted} maxLength={120}
          autoFocus={!team} onSubmitEditing={save} accessibilityLabel="Team name"
          style={StyleSheet.flatten([styles.input, { color: text }])} />
      </Field>
      {error && <Text style={styles.error}>{error}</Text>}
      <FormButtons busy={busy} onSave={save} onCancel={onCancel}
        removeLabel={team ? 'Remove team' : undefined}
        removeQuestion={team ? `Remove ${team.name}? Its cars and drivers stay, without a team.` : undefined}
        onRemove={team ? () => run(async () => {
          await garageApi.removeTeam(team.id);
          return `${team.name} removed.`;
        }) : undefined} />
    </View>
  );
}

const useStyles = themed((c) => ({
  outer: { padding: 16, paddingBottom: 32 },
  page: { width: '100%', maxWidth: 1180, alignSelf: 'center', gap: 20 },
  intro: { opacity: 0.7, lineHeight: 20 },
  columns: { flexDirection: 'row', gap: 24, alignItems: 'flex-start' },
  column: { flex: 1, gap: 20 },
  section: { gap: 6 },
  sectionHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  h2: { fontSize: 18, fontWeight: '700' },
  add: { borderWidth: 1, borderRadius: Radius.control, paddingHorizontal: 12, paddingVertical: 6 },
  addText: { fontWeight: '600' },
  item: { borderBottomWidth: 1, borderColor: c.separator, paddingVertical: 8, gap: 8 },
  itemHead: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  itemText: { flex: 1, gap: 2, backgroundColor: 'transparent' },
  itemTitle: { fontSize: 16, fontWeight: '600' },
  sub: { opacity: 0.65, fontSize: 13 },
  note: { fontSize: 12, opacity: 0.6 },
  notice: { fontSize: 13, opacity: 0.85, borderLeftWidth: 3, borderColor: c.borderStrong, paddingLeft: 8 },
  dim: { opacity: 0.45 },
  error: { color: c.error },
  form: { gap: 12, borderWidth: 1, borderColor: c.border, borderRadius: Radius.card, padding: 12, marginBottom: 8, backgroundColor: c.surface },
  formRow: { flexDirection: 'row', gap: 10, alignItems: 'center', flexWrap: 'wrap' },
  grow: { flex: 1, minWidth: 180 },
  field: { gap: 6 },
  label: { fontSize: 11, fontWeight: '700', opacity: 0.6, textTransform: 'uppercase', letterSpacing: 0.5 },
  input: { borderWidth: 1, borderColor: c.border, borderRadius: Radius.control, paddingHorizontal: 10, paddingVertical: 8, fontSize: 15, backgroundColor: c.surface },
  number: { width: 80 },
  serial: { width: 160 },
  inlineInput: { minWidth: 140, paddingVertical: 5 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  chip: { borderWidth: 1, borderColor: c.borderStrong, borderRadius: Radius.chip, paddingHorizontal: 12, paddingVertical: 6,
    maxWidth: '100%', backgroundColor: c.surface },
  dashed: { borderStyle: 'dashed' },
  chipText: { fontSize: 14 },
  buttons: { flexDirection: 'row', alignItems: 'center', gap: 16, flexWrap: 'wrap' },
  save: { borderRadius: 8, paddingHorizontal: 18, paddingVertical: 9, minWidth: 80, alignItems: 'center' },
  saveText: { fontWeight: '600' },
  remove: { marginLeft: 'auto', flexShrink: 1 },
  danger: { color: c.error },
}));
