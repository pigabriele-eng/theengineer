// What a season's entry was run with (tyre, car, vehicle, team, drivers 1 to 4): the short form of Tools › Seasons.
// Each event takes them from its season (Gabriele, 2026-10-08: "remove event info": no form of its own on the
// weekend page or after an upload).
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator } from 'react-native';

import { Choice, Choices, ErrorLine, Field, Input, Note } from '@/components/Controls';
import { TextLink } from '@/components/Programme';
import { Text, View } from '@/components/Themed';
import { carLong, driversFor, Garage, garageApi } from '@/lib/garage';
import { catalogApi, Entry, Tyre, Vehicle } from '@/lib/seasons';
import { themed, Type } from '@/constants/Theme';

const MAX_DRIVERS = 4;

export type Lists = { garage: Garage; tyres: Tyre[]; vehicles: Vehicle[] };

/** The garage, tyres and vehicles to pick from, loaded once `on` (and again with reload): the event page's info asks
 * for them only when its form opens, so a visit doesn't read the garage twice. */
export function useLists(on = true) {
  const [lists, setLists] = useState<Lists | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(() => {
    Promise.all([garageApi.get(), catalogApi.tyres(), catalogApi.vehicles()]).then(
      ([garage, tyres, vehicles]) => {
        setLists({ garage, tyres, vehicles });
        setError(null);
      },
      (e) => setError((e as Error).message),
    );
  }, []);
  useEffect(() => {
    if (on) reload();
  }, [on, reload]);
  return { lists, error, reload };
}

// The fields of the form
type FieldKey = 'tyre' | 'car' | 'vehicle' | 'team' | 'drivers';

/** The tyre, car, vehicle, team and drivers 1 to 4 as words to pick: tap one to pick it, or add a new one in place. */
export function EntryFields({ value, onChange, lists, onListsChanged, focus, notes }: {
  value: Entry;
  onChange: (v: Entry) => void;
  lists: Lists;
  onListsChanged: () => void; // a tyre, team or driver was added
  focus?: FieldKey | null; // the field to point at (a checklist item tapped)
  notes?: Partial<Record<FieldKey, string | null>>; // where a value came from, beside its field's name
}) {
  const styles = useStyles();
  const { garage, tyres, vehicles } = lists;
  const set = (patch: Partial<Entry>) => onChange({ ...value, ...patch });
  const pickCar = (id: number | null) => {
    const car = garage.cars.find((c) => c.id === id);
    const vehicle = vehicles.find((v) => id != null && v.car_ids?.includes(id));
    set({
      car_id: id,
      // the car's team and vehicle, when none is picked yet
      team_id: value.team_id ?? car?.team_id ?? null,
      vehicle_model_id: value.vehicle_model_id ?? vehicle?.id ?? null,
    });
  };
  const toggleDriver = (id: number) => {
    const has = value.drivers.includes(id);
    if (!has && value.drivers.length >= MAX_DRIVERS) return;
    set({ drivers: has ? value.drivers.filter((d) => d !== id) : [...value.drivers, id] });
  };
  const { first, rest } = driversFor(garage, value.car_id);
  const driverName = (id: number) => garage.drivers.find((d) => d.id === id)?.name ?? `#${id}`;
  return (
    <View style={styles.fields}>
      <Field label="Tyre" focus={focus === 'tyre'} note={notes?.tyre}>
        <Choices>
          {tyres.map((t) => (
            <Choice key={t.id} label={t.label} sub={t.size} on={value.tyre_kind_id === t.id}
              onPress={() => set({ tyre_kind_id: value.tyre_kind_id === t.id ? null : t.id })} />
          ))}
          <NewTyre onAdded={(t) => {
            onListsChanged();
            set({ tyre_kind_id: t.id });
          }} />
        </Choices>
      </Field>
      <Field label="Car" focus={focus === 'car'} note={notes?.car}>
        <Choices>
          {garage.cars.map((c) => (
            <Choice key={c.id} label={carLong(c)} sub={c.team} on={value.car_id === c.id}
              onPress={() => pickCar(value.car_id === c.id ? null : c.id)} />
          ))}
          {garage.cars.length === 0 && <Note>No cars yet: add them in Cars, drivers and teams.</Note>}
        </Choices>
      </Field>
      {vehicles.length > 0 && (
        <Field label="Vehicle" focus={focus === 'vehicle'} note={notes?.vehicle}>
          <Choices>
            {vehicles.map((v) => (
              <Choice key={v.id} label={v.name} on={value.vehicle_model_id === v.id}
                onPress={() => set({ vehicle_model_id: value.vehicle_model_id === v.id ? null : v.id })} />
            ))}
          </Choices>
        </Field>
      )}
      <Field label="Team" focus={focus === 'team'} note={notes?.team}>
        <Choices>
          {garage.teams.map((t) => (
            <Choice key={t.id} label={t.name} on={value.team_id === t.id}
              onPress={() => set({ team_id: value.team_id === t.id ? null : t.id })} />
          ))}
          <NewByName placeholder="New team" label="+ New team" onAdd={async (name) => {
            const t = await garageApi.addTeam(name);
            onListsChanged();
            set({ team_id: t.id });
          }} />
        </Choices>
      </Field>
      <Field label="Drivers 1 to 4" focus={focus === 'drivers'} note={notes?.drivers}>
        {value.drivers.length > 0 && (
          <Text style={styles.order}>
            {value.drivers.map((id, i) => `${i + 1} ${driverName(id)}`).join('   ')}
          </Text>
        )}
        <Choices>
          {[...first, ...rest].map((d) => {
            const at = value.drivers.indexOf(d.id);
            return (
              <Choice key={d.id} label={at >= 0 ? `${at + 1} · ${d.name}` : d.name} on={at >= 0}
                onPress={() => toggleDriver(d.id)} />
            );
          })}
          <NewByName placeholder="New driver's name" label="+ New driver" onAdd={async (name) => {
            const d = await garageApi.addDriver({ name });
            onListsChanged();
            if (!value.drivers.includes(d.id) && value.drivers.length < MAX_DRIVERS) {
              set({ drivers: [...value.drivers, d.id] });
            }
          }} />
        </Choices>
        <Note>Tap them in order: the first tapped is driver 1.</Note>
      </Field>
    </View>
  );
}

/** "+ New …": a word that turns into a name field with Add. */
function NewByName({ label, placeholder, onAdd }: { label: string; placeholder: string; onAdd: (name: string) => Promise<void> }) {
  const styles = useStyles();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!open) return <Choice label={label} on={false} onPress={() => setOpen(true)} add />;
  const add = async () => {
    if (!name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await onAdd(name.trim());
      setName('');
      setOpen(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <View style={styles.inline}>
      <Input value={name} onChangeText={setName} placeholder={placeholder} autoFocus maxLength={120} onSubmitEditing={add}
        accessibilityLabel={placeholder} style={styles.inlineInput} />
      {busy ? <ActivityIndicator /> : <TextLink onPress={add} label="Add" small />}
      <TextLink onPress={() => setOpen(false)} label="Cancel" small />
      {error && <ErrorLine>{error}</ErrorLine>}
    </View>
  );
}

/** A tyre typed in place: brand and compound (pressures are added in the garage). */
function NewTyre({ onAdded }: { onAdded: (t: Tyre) => void }) {
  const styles = useStyles();
  const [open, setOpen] = useState(false);
  const [brand, setBrand] = useState('');
  const [compound, setCompound] = useState('');
  const [error, setError] = useState<string | null>(null);
  if (!open) return <Choice label="+ New tyre" on={false} onPress={() => setOpen(true)} add />;
  const add = async () => {
    if (!brand.trim() || !compound.trim()) return setError('Give the brand and the compound.');
    try {
      onAdded(await catalogApi.addTyre({ brand: brand.trim(), compound: compound.trim() }));
      setOpen(false);
      setBrand('');
      setCompound('');
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <View style={styles.inline}>
      <Input value={brand} onChangeText={setBrand} placeholder="Brand, e.g. Pirelli" autoFocus maxLength={80}
        accessibilityLabel="Tyre brand" style={styles.inlineInput} />
      <Input value={compound} onChangeText={setCompound} placeholder="Compound, e.g. P Zero DHG" maxLength={80}
        onSubmitEditing={add} accessibilityLabel="Tyre compound" style={styles.inlineInput} />
      <TextLink onPress={add} label="Add" small />
      <TextLink onPress={() => setOpen(false)} label="Cancel" small />
      {error && <ErrorLine>{error}</ErrorLine>}
    </View>
  );
}

const useStyles = themed((c) => ({
  fields: { gap: 22 },
  order: { fontFamily: Type.label.fontFamily, fontSize: 15, letterSpacing: 0.3, color: c.text },
  inline: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'flex-end', columnGap: 14, rowGap: 8, width: '100%' },
  inlineInput: { minWidth: 160, flexGrow: 1, flexShrink: 1, flexBasis: 160 },
}));
