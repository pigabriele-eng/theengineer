// A run's driver, car and name, each one or two taps away: on the event page's run rows and the session page.
// Tap the driver chip for a short list (the drivers of the run's car first, then the rest, and "New driver"), tap a
// name and it's set. The car chip works the same way; setting the car on one run of a weekend fits the run's logger
// to the car, and every other run from that logger gets it too. Tap the run's name to rename it in place.
import { Link, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, TextInput } from 'react-native';

import { Text, View, useThemeColor } from '@/components/Themed';
import { SessionKind } from '@/lib/api';
import { eventsApi, KIND_NAMES, QUICK_LABELS } from '@/lib/events';
import {
  carLong,
  carShort,
  carsFor,
  driversFor,
  Garage,
  garageApi,
  GarageCar,
  GarageDriver,
  RunFields,
  RunSet,
} from '@/lib/garage';

export type PickerKind = 'driver' | 'car';
export type RunRef = { id: number; name: string; driver_id?: number | null; driver?: string | null; car_id?: number | null };

const KINDS: SessionKind[] = ['practice', 'qualifying', 'race', 'test'];

/** The garage, loaded now and again whenever the screen comes back into view (after a visit to the garage). */
export function useGarage() {
  const [garage, setGarage] = useState<Garage | null>(null);
  const reload = useCallback(() => {
    garageApi.get().then(setGarage, () => setGarage((g) => g ?? { teams: [], cars: [], drivers: [], loggers: [], models: [] }));
  }, []);
  useFocusEffect(reload);
  return { garage, reload };
}

/** What a pick changes on the run before the server answers, so the chip changes at once. */
export function localPick(garage: Garage | null, fields: RunFields): { driver_id?: number | null; driver?: string | null; car_id?: number | null } {
  const out: { driver_id?: number | null; driver?: string | null; car_id?: number | null } = {};
  if ('driver_id' in fields) {
    out.driver_id = fields.driver_id ?? null;
    out.driver = garage?.drivers.find((d) => d.id === fields.driver_id)?.name ?? null;
  }
  if ('car_id' in fields) out.car_id = fields.car_id ?? null;
  return out;
}

/** The words for what a pick did beyond the run itself: the car went on the logger's other runs. */
export function filledNote(r: RunSet) {
  if (!r.filled.length || r.car == null) return null;
  return `${r.car} is now set on ${r.filled.length} more run${r.filled.length === 1 ? '' : 's'} from logger ` +
    `${r.logger} too. That logger is linked to the car, so its next uploads get the car by themselves.`;
}

/** The driver and car chips of a run. */
export function RunChips({ run, garage, open, onOpen }: {
  run: RunRef;
  garage: Garage | null;
  open: PickerKind | null;
  onOpen: (what: PickerKind | null) => void;
}) {
  const tint = useThemeColor({}, 'tint');
  // a driver made a moment ago is named by the run until the garage is loaded again
  const driver = garage?.drivers.find((d) => d.id === run.driver_id)
    ?? (run.driver_id != null && run.driver ? { name: run.driver } : undefined);
  const car = garage?.cars.find((c) => c.id === run.car_id);
  const chip = (what: PickerKind, set: boolean) =>
    StyleSheet.flatten([styles.chip, !set && styles.unset, open === what && { borderColor: tint, borderStyle: 'solid' as const }]);
  return (
    <View style={styles.chips}>
      <Pressable onPress={() => onOpen(open === 'driver' ? null : 'driver')} hitSlop={4} style={chip('driver', !!driver)}
        accessibilityRole="button" accessibilityLabel={driver ? `Driver ${driver.name}: change` : `Set the driver of ${run.name}`}>
        <Text style={StyleSheet.flatten([styles.chipText, !driver && styles.dim])} numberOfLines={1}>
          {driver ? driver.name : '+ Driver'}
        </Text>
      </Pressable>
      <Pressable onPress={() => onOpen(open === 'car' ? null : 'car')} hitSlop={4} style={chip('car', !!car)}
        accessibilityRole="button" accessibilityLabel={car ? `Car ${car.name}: change` : `Set the car of ${run.name}`}>
        <Text style={StyleSheet.flatten([styles.chipText, !car && styles.dim])} numberOfLines={1}>
          {car ? carShort(car) : '+ Car'}
        </Text>
      </Pressable>
    </View>
  );
}

/** The short list a chip opens: tap one and it's set. */
export function RunPicker({ what, run, garage, onPick, onClose }: {
  what: PickerKind;
  run: RunRef;
  garage: Garage;
  onPick: (fields: RunFields) => Promise<void> | void;
  onClose: () => void;
}) {
  return what === 'driver'
    ? <DriverList run={run} garage={garage} onPick={onPick} onClose={onClose} />
    : <CarList run={run} garage={garage} onPick={onPick} onClose={onClose} />;
}

function DriverList({ run, garage, onPick, onClose }: {
  run: RunRef;
  garage: Garage;
  onPick: (fields: RunFields) => Promise<void> | void;
  onClose: () => void;
}) {
  const [typing, setTyping] = useState(false);
  const [name, setName] = useState('');
  const tint = useThemeColor({}, 'tint');
  const text = useThemeColor({}, 'text');
  const { first, rest } = driversFor(garage, run.car_id);
  const car = garage.cars.find((c) => c.id === run.car_id);
  const add = () => name.trim() && onPick({ driver_name: name.trim() });
  const option = (d: GarageDriver) => {
    const on = d.id === run.driver_id;
    return (
      <Pressable key={d.id} onPress={() => onPick({ driver_id: d.id })} accessibilityRole="button"
        accessibilityState={{ selected: on }} style={StyleSheet.flatten([styles.option, on && { borderColor: tint }])}>
        <Text style={StyleSheet.flatten([styles.optionText, on && { color: tint }])}>{d.name}</Text>
      </Pressable>
    );
  };
  return (
    <View style={styles.panel}>
      <PanelHead title={`Who drove ${run.name}?`} onClose={onClose} />
      {first.length > 0 && (
        <>
          <Text style={styles.group}>Drives {car ? carShort(car) : 'this car'}</Text>
          <View style={styles.options}>{first.map(option)}</View>
        </>
      )}
      {rest.length > 0 && (
        <>
          {first.length > 0 && <Text style={styles.group}>Other drivers</Text>}
          <View style={styles.options}>{rest.map(option)}</View>
        </>
      )}
      {typing ? (
        <View style={styles.inputRow}>
          <TextInput value={name} onChangeText={setName} placeholder="New driver's name" placeholderTextColor="#888"
            autoFocus maxLength={120} onSubmitEditing={add} accessibilityLabel="New driver's name"
            style={StyleSheet.flatten([styles.input, { color: text }])} />
          <Pressable onPress={add} accessibilityRole="button" style={StyleSheet.flatten([styles.button, { borderColor: tint }])}>
            <Text style={StyleSheet.flatten([styles.buttonText, { color: tint }])}>Add</Text>
          </Pressable>
        </View>
      ) : (
        <View style={styles.options}>
          <Pressable onPress={() => setTyping(true)} accessibilityRole="button"
            style={StyleSheet.flatten([styles.option, styles.unset])}>
            <Text style={StyleSheet.flatten([styles.optionText, { color: tint }])}>+ New driver</Text>
          </Pressable>
          {run.driver_id != null && (
            <Pressable onPress={() => onPick({ driver_id: null })} accessibilityRole="button"
              style={StyleSheet.flatten([styles.option, styles.unset])}>
              <Text style={StyleSheet.flatten([styles.optionText, styles.dim])}>No driver</Text>
            </Pressable>
          )}
        </View>
      )}
      <GarageLink />
    </View>
  );
}

function CarList({ run, garage, onPick, onClose }: {
  run: RunRef;
  garage: Garage;
  onPick: (fields: RunFields) => Promise<void> | void;
  onClose: () => void;
}) {
  const [adding, setAdding] = useState(false);
  const [number, setNumber] = useState('');
  const [model, setModel] = useState(garage.models[0] ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const tint = useThemeColor({}, 'tint');
  const text = useThemeColor({}, 'text');
  const { first, rest } = carsFor(garage, run.driver_id);
  const add = async () => {
    if (!number.trim() && !model.trim()) return setError('Give the car a number or a model.');
    setBusy(true);
    try {
      const r = await garageApi.addCar({ number: number.trim() || null, model: model.trim() || null });
      await onPick({ car_id: r.car.id });
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };
  const option = (c: GarageCar) => {
    const on = c.id === run.car_id;
    return (
      <Pressable key={c.id} onPress={() => onPick({ car_id: c.id })} accessibilityRole="button"
        accessibilityState={{ selected: on }} style={StyleSheet.flatten([styles.option, on && { borderColor: tint }])}>
        <Text style={StyleSheet.flatten([styles.optionText, on && { color: tint }])}>{carLong(c)}</Text>
        {c.team && <Text style={styles.optionSub}>{c.team}</Text>}
      </Pressable>
    );
  };
  return (
    <View style={styles.panel}>
      <PanelHead title={`Which car in ${run.name}?`} onClose={onClose} />
      {[...first, ...rest].length > 0 && <View style={styles.options}>{[...first, ...rest].map(option)}</View>}
      {adding ? (
        <View style={styles.newCar}>
          <View style={styles.inputRow}>
            <TextInput value={number} onChangeText={setNumber} placeholder="No." placeholderTextColor="#888" autoFocus
              maxLength={8} accessibilityLabel="Car number" onSubmitEditing={add}
              style={StyleSheet.flatten([styles.input, styles.number, { color: text }])} />
            <TextInput value={model} onChangeText={setModel} placeholder="Model" placeholderTextColor="#888"
              maxLength={100} accessibilityLabel="Car model" onSubmitEditing={add}
              style={StyleSheet.flatten([styles.input, { color: text }])} />
            <Pressable onPress={add} disabled={busy} accessibilityRole="button"
              style={StyleSheet.flatten([styles.button, { borderColor: tint }])}>
              {busy ? <ActivityIndicator color={tint} />
                : <Text style={StyleSheet.flatten([styles.buttonText, { color: tint }])}>Add</Text>}
            </Pressable>
          </View>
          {garage.models.length > 1 && (
            <View style={styles.options}>
              {garage.models.map((m) => (
                <Pressable key={m} onPress={() => setModel(m)} style={StyleSheet.flatten([styles.small, m === model && { borderColor: tint }])}>
                  <Text style={StyleSheet.flatten([styles.smallText, m === model && { color: tint }])}>{m}</Text>
                </Pressable>
              ))}
            </View>
          )}
          {error && <Text style={styles.error}>{error}</Text>}
        </View>
      ) : (
        <View style={styles.options}>
          <Pressable onPress={() => setAdding(true)} accessibilityRole="button"
            style={StyleSheet.flatten([styles.option, styles.unset])}>
            <Text style={StyleSheet.flatten([styles.optionText, { color: tint }])}>+ New car</Text>
          </Pressable>
          {run.car_id != null && (
            <Pressable onPress={() => onPick({ car_id: null })} accessibilityRole="button"
              style={StyleSheet.flatten([styles.option, styles.unset])}>
              <Text style={StyleSheet.flatten([styles.optionText, styles.dim])}>No car</Text>
            </Pressable>
          )}
        </View>
      )}
      <GarageLink />
    </View>
  );
}

function PanelHead({ title, onClose }: { title: string; onClose: () => void }) {
  const tint = useThemeColor({}, 'tint');
  return (
    <View style={styles.panelHead}>
      <Text style={styles.panelTitle} numberOfLines={1}>{title}</Text>
      <Pressable onPress={onClose} hitSlop={8} accessibilityRole="button">
        <Text style={{ color: tint }}>Close</Text>
      </Pressable>
    </View>
  );
}

function GarageLink() {
  const tint = useThemeColor({}, 'tint');
  return (
    // Link asChild hands its child's style to a web anchor, which can't take a style array: one object
    <Link href="/garage" asChild>
      <Pressable style={styles.garageLink} accessibilityRole="link">
        <Text style={StyleSheet.flatten([styles.garageText, { color: tint }])}>Cars, drivers and teams ›</Text>
      </Pressable>
    </Link>
  );
}

/** The run's name being edited in place: type it, or tap a quick label (FP1, Q1, Race 1…) to set name and kind at once. */
export function RunNameEditor({ id, name, kind, logSession, onSaved, onCancel, save }: {
  id: number;
  name: string;
  kind: SessionKind;
  logSession?: string | null;
  onSaved: (name: string, kind: SessionKind) => void;
  onCancel: () => void;
  save: (id: number, body: { name: string; kind: SessionKind }) => Promise<unknown>;
}) {
  const [value, setValue] = useState(name);
  const [k, setK] = useState<SessionKind>(kind);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const tint = useThemeColor({}, 'tint');
  const text = useThemeColor({}, 'text');
  const submit = async (n = value, kk = k) => {
    if (!n.trim()) return setError('Give the run a name.');
    setBusy(true);
    setError(null);
    try {
      await save(id, { name: n.trim(), kind: kk });
      onSaved(n.trim(), kk);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };
  const chip = (on: boolean) => StyleSheet.flatten([styles.small, on && { borderColor: tint }]);
  return (
    <View style={styles.editor}>
      <View style={styles.inputRow}>
        <TextInput value={value} onChangeText={setValue} maxLength={120} autoFocus selectTextOnFocus
          accessibilityLabel="Run name" onSubmitEditing={() => submit()}
          style={StyleSheet.flatten([styles.input, styles.nameInput, { color: text, borderColor: tint }])} />
        <Pressable onPress={() => submit()} disabled={busy} accessibilityRole="button"
          style={StyleSheet.flatten([styles.button, { borderColor: tint }])}>
          {busy ? <ActivityIndicator color={tint} />
            : <Text style={StyleSheet.flatten([styles.buttonText, { color: tint }])}>Save</Text>}
        </Pressable>
        <Pressable onPress={onCancel} hitSlop={8} accessibilityRole="button">
          <Text style={{ color: tint }}>Cancel</Text>
        </Pressable>
      </View>
      <View style={styles.options}>
        {QUICK_LABELS.map((q) => (
          <Pressable key={q.label} onPress={() => submit(q.label, q.kind)} disabled={busy} accessibilityRole="button"
            accessibilityLabel={`Name it ${q.label}`} style={chip(value === q.label)}>
            <Text style={StyleSheet.flatten([styles.smallText, value === q.label && { color: tint }])}>{q.label}</Text>
          </Pressable>
        ))}
      </View>
      <View style={styles.options}>
        <Text style={styles.kindLabel}>Kind</Text>
        {KINDS.map((kk) => (
          <Pressable key={kk} onPress={() => setK(kk)} accessibilityRole="radio" accessibilityState={{ checked: kk === k }}
            style={chip(kk === k)}>
            <Text style={StyleSheet.flatten([styles.smallText, kk === k && { color: tint }])}>{KIND_NAMES[kk]}</Text>
          </Pressable>
        ))}
      </View>
      {logSession && <Text style={styles.note}>The logger calls it {logSession}.</Text>}
      {error && <Text style={styles.error}>{error}</Text>}
    </View>
  );
}

/** The session page's top: the run's name (tap it to rename) and kind, its driver and car chips, and their lists. */
export function RunHeader({ run, kind, logSession, onChanged }: {
  run: RunRef;
  kind: SessionKind;
  logSession?: string | null;
  onChanged: () => void;
}) {
  const { garage, reload } = useGarage();
  const [open, setOpen] = useState<PickerKind | null>(null);
  const [editing, setEditing] = useState(false);
  const [local, setLocal] = useState<Partial<RunRef>>({});
  const [note, setNote] = useState<string | null>(null);
  const tint = useThemeColor({}, 'tint');
  const shown = { ...run, ...local };
  const pick = async (fields: RunFields) => {
    setOpen(null);
    setLocal((l) => ({ ...l, ...localPick(garage, fields) }));
    try {
      const r = await garageApi.setRun(run.id, fields);
      setLocal({ driver_id: r.driver_id, driver: r.driver, car_id: r.car_id });
      setNote(filledNote(r));
      reload();
      onChanged();
    } catch (e) {
      setLocal({});
      setNote((e as Error).message);
    }
  };
  return (
    <View style={styles.header}>
      {editing ? (
        <RunNameEditor id={run.id} name={run.name} kind={kind} logSession={logSession}
          save={(id, body) => eventsApi.updateSession(id, body)}
          onSaved={() => {
            setEditing(false);
            onChanged();
          }}
          onCancel={() => setEditing(false)} />
      ) : (
        <View style={styles.titleLine}>
          <Pressable onPress={() => setEditing(true)} accessibilityRole="button" accessibilityLabel={`Rename ${run.name}`}
            style={styles.titlePress}>
            <Text style={styles.title} numberOfLines={2}>{run.name}</Text>
            <Text style={StyleSheet.flatten([styles.pencil, { color: tint }])}>✎</Text>
          </Pressable>
          <View style={styles.kind}>
            <Text style={styles.kindText}>{KIND_NAMES[kind]}</Text>
          </View>
        </View>
      )}
      <RunChips run={shown} garage={garage} open={open} onOpen={setOpen} />
      {open && garage && (
        <RunPicker what={open} run={shown} garage={garage} onPick={pick} onClose={() => setOpen(null)} />
      )}
      {note && (
        <Pressable onPress={() => setNote(null)}>
          <Text style={styles.notice}>{note}</Text>
        </Pressable>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  header: { gap: 8, backgroundColor: 'transparent' },
  titleLine: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap', backgroundColor: 'transparent' },
  titlePress: { flexDirection: 'row', alignItems: 'center', gap: 6, flexShrink: 1 },
  title: { fontSize: 22, fontWeight: '700', flexShrink: 1 },
  pencil: { fontSize: 15 },
  kind: { borderRadius: 4, paddingHorizontal: 6, paddingVertical: 2, backgroundColor: '#8882' },
  kindText: { fontSize: 12, fontWeight: '600', opacity: 0.8 },
  notice: { fontSize: 13, opacity: 0.8, borderLeftWidth: 3, borderColor: '#8886', paddingLeft: 8 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, backgroundColor: 'transparent' },
  chip: { borderWidth: 1, borderColor: '#8886', borderRadius: 14, paddingHorizontal: 10, paddingVertical: 4,
    maxWidth: 180 },
  unset: { borderStyle: 'dashed', borderColor: '#8888' },
  chipText: { fontSize: 13, fontWeight: '600' },
  dim: { opacity: 0.6 },
  panel: { borderWidth: 1, borderColor: '#8884', borderRadius: 10, padding: 10, gap: 8, marginBottom: 10 },
  panelHead: { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: 'transparent' },
  panelTitle: { flex: 1, fontWeight: '700', fontSize: 15 },
  group: { fontSize: 11, fontWeight: '700', opacity: 0.6, textTransform: 'uppercase', letterSpacing: 0.5 },
  options: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, backgroundColor: 'transparent' },
  option: { borderWidth: 1, borderColor: '#8886', borderRadius: 18, paddingHorizontal: 14, paddingVertical: 8 },
  optionText: { fontSize: 15, fontWeight: '600' },
  optionSub: { fontSize: 11, opacity: 0.6 },
  small: { borderWidth: 1, borderColor: '#8884', borderRadius: 14, paddingHorizontal: 10, paddingVertical: 4 },
  smallText: { fontSize: 14 },
  inputRow: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap', backgroundColor: 'transparent' },
  input: { flex: 1, minWidth: 120, borderWidth: 1, borderColor: '#8884', borderRadius: 8, paddingHorizontal: 10,
    paddingVertical: 8, fontSize: 15 },
  number: { flex: 0, minWidth: 64, width: 64 },
  nameInput: { fontSize: 16, fontWeight: '600' },
  newCar: { gap: 8, backgroundColor: 'transparent' },
  button: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 14, paddingVertical: 8, minWidth: 64, alignItems: 'center' },
  buttonText: { fontWeight: '600' },
  garageLink: { alignSelf: 'flex-start', paddingVertical: 2 },
  garageText: { fontSize: 13 },
  editor: { gap: 8, backgroundColor: 'transparent' },
  kindLabel: { fontSize: 11, fontWeight: '700', opacity: 0.6, textTransform: 'uppercase', letterSpacing: 0.5,
    alignSelf: 'center' },
  note: { fontSize: 12, opacity: 0.6 },
  error: { color: '#c8372d' },
});
