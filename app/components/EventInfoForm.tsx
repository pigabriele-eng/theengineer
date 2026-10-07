// What an event was run with (tyre, car, vehicle, team, drivers 1 to 4) and a season's entry: the same short form.
// EventInfoForm saves an event's info (fields the season already gives are left to it); AskEventInfo asks for it
// after an upload, for each event the upload's runs are in that is missing some of it, filled from its season or
// from the previous event of the same car.
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator } from 'react-native';

import { Choice, Choices, ErrorLine, Field, FormActions, Input, MainButton, Note } from '@/components/Controls';
import { Block, Label, TextLink } from '@/components/Programme';
import { Text, View } from '@/components/Themed';
import { carLong, driversFor, Garage, garageApi } from '@/lib/garage';
import {
  catalogApi,
  Entry,
  EMPTY_ENTRY,
  EventInfo,
  InfoFields,
  MISSING_LABEL,
  MissingKey,
  seasonsApi,
  sourceWords,
  Tyre,
  Vehicle,
} from '@/lib/seasons';
import { Fonts, inkOn, themed, Type, useTheme } from '@/constants/Theme';

const MAX_DRIVERS = 4;

export type Lists = { garage: Garage; tyres: Tyre[]; vehicles: Vehicle[] };

/** The garage, tyres and vehicles to pick from, loaded once (and again with reload). */
export function useLists() {
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
  useEffect(reload, [reload]);
  return { lists, error, reload };
}

// The fields of the form, and the checklist item each one answers
type FieldKey = 'tyre' | 'car' | 'vehicle' | 'team' | 'drivers';
const FIELD_OF: Record<MissingKey, FieldKey> = {
  'tyre brand': 'tyre', compound: 'tyre', car: 'car', team: 'team', drivers: 'drivers',
};

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

// ---------- an event's info ----------

const ids = (info: EventInfo): Entry => ({
  tyre_kind_id: info.resolved.tyre_kind?.id ?? null,
  car_id: info.resolved.car?.id ?? null,
  vehicle_model_id: info.resolved.vehicle_model?.id ?? null,
  team_id: info.resolved.team?.id ?? null,
  drivers: info.resolved.drivers.map((d) => d.id),
});

/** The form's first values: what the event resolves to, and for what it lacks, what the previous event of the same
 * car was run with. */
export function startValue(info: EventInfo): { value: Entry; suggested: Set<keyof Entry> } {
  const value = ids(info);
  const prev = info.previous;
  const suggested = new Set<keyof Entry>();
  if (prev) {
    for (const k of ['tyre_kind_id', 'car_id', 'vehicle_model_id', 'team_id'] as const) {
      if (value[k] == null && prev[k] != null) {
        value[k] = prev[k];
        suggested.add(k);
      }
    }
    if (!value.drivers.length && prev.drivers.length) {
      value.drivers = prev.drivers;
      suggested.add('drivers');
    }
  }
  return { value, suggested };
}

/** What to save: a field left as the season (or the runs, or the car) gives it is not set on the event, so it keeps
 * following them. */
export function toSave(info: EventInfo, value: Entry): InfoFields {
  const base = info.season?.entry ?? EMPTY_ENTRY;
  const now = ids(info);
  const derived = (k: keyof typeof info.from) => info.from[k] != null && info.from[k] !== 'event';
  const one = (k: 'tyre_kind_id' | 'car_id' | 'vehicle_model_id' | 'team_id', from: keyof typeof info.from) =>
    value[k] === base[k] || (derived(from) && value[k] === now[k]) ? null : value[k];
  const same = (a: number[], b: number[]) => a.length === b.length && a.every((x, i) => x === b[i]);
  return {
    tyre_kind_id: one('tyre_kind_id', 'tyre_kind'),
    car_id: one('car_id', 'car'),
    vehicle_model_id: one('vehicle_model_id', 'vehicle_model'),
    team_id: one('team_id', 'team'),
    drivers: same(value.drivers, base.drivers) || (derived('drivers') && same(value.drivers, now.drivers))
      ? [] : value.drivers,
  };
}

/** The event's info as a short form, filled from what it has (its season's entry included) and, for what it lacks,
 * from the previous event of the same car. */
export function EventInfoForm({ info, lists, onListsChanged, focus, onSaved, onCancel, cancelLabel = 'Cancel' }: {
  info: EventInfo;
  lists: Lists;
  onListsChanged: () => void;
  focus?: MissingKey | null;
  onSaved: (info: EventInfo) => void;
  onCancel: () => void;
  cancelLabel?: string;
}) {
  const styles = useStyles();
  const [start] = useState(() => startValue(info));
  const [value, setValue] = useState<Entry>(start.value);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const prevName = info.previous?.event_name;
  const note = (k: keyof Entry, from: keyof typeof info.from) =>
    start.suggested.has(k) ? `as at ${prevName}` : value[k] === ids(info)[k] ? sourceWords(info.from[from]) : null;
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      onSaved(await seasonsApi.setInfo(info.event_id, toSave(info, value)));
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };
  return (
    <View style={styles.form}>
      <EntryFields value={value} onChange={setValue} lists={lists} onListsChanged={onListsChanged}
        focus={focus ? FIELD_OF[focus] : null}
        notes={{
          tyre: note('tyre_kind_id', 'tyre_kind'),
          car: note('car_id', 'car'),
          vehicle: note('vehicle_model_id', 'vehicle_model'),
          team: note('team_id', 'team'),
          drivers: start.suggested.has('drivers') ? `as at ${prevName}`
            : value.drivers.join() === ids(info).drivers.join() ? sourceWords(info.from.drivers) : null,
        }} />
      {error && <ErrorLine>{error}</ErrorLine>}
      <FormActions>
        <MainButton label="Save" onPress={save} busy={busy} />
        <TextLink onPress={onCancel} label={cancelLabel} />
      </FormActions>
    </View>
  );
}

/** What an event's info is missing: a red block, then each item as a link to its field in the form. */
export function MissingList({ missing, onPick }: { missing: MissingKey[]; onPick: (k: MissingKey) => void }) {
  const styles = useStyles();
  const c = useTheme();
  if (!missing.length) return null;
  return (
    <View style={styles.missing}>
      <Block label="Missing" color={c.mark} ink={inkOn(c.mark)} />
      {missing.map((k) => (
        <TextLink key={k} onPress={() => onPick(k)} label={MISSING_LABEL[k]} small />
      ))}
    </View>
  );
}

// ---------- after an upload ----------

/** After an upload: for each event its runs went into that is missing some of its info, the same short form, filled
 * from the season or the previous event of the same car. refresh: ask again (runs were moved to another event). */
export function AskEventInfo({ runIds, refresh, onSaved }: { runIds: number[]; refresh?: unknown; onSaved?: () => void }) {
  const styles = useStyles();
  const [infos, setInfos] = useState<EventInfo[] | null>(null);
  const [done, setDone] = useState<Record<number, string>>({});
  const { lists, reload } = useLists();
  const key = runIds.join(',');
  useEffect(() => {
    if (!key) return;
    seasonsApi.infoForRuns(key.split(',').map(Number)).then(setInfos, () => setInfos([])); // an older server: no form
  }, [key, refresh]);
  if (!infos || !lists) return null;
  return (
    <>
      {infos.map((info) => {
        if (done[info.event_id]) return <Text key={info.event_id} style={styles.doneText}>{done[info.event_id]}</Text>;
        if (!info.missing.length) return null;
        return (
          <View key={info.event_id} style={styles.ask}>
            <Label>Event info</Label>
            <Text style={styles.askTitle}>What was {info.event_name ?? 'this event'} run with?</Text>
            <Note>
              Missing: {info.missing.map((k) => MISSING_LABEL[k]).join(', ')}.
              {info.season ? ` The rest comes from ${info.season.name}.` : ''}
              {info.previous ? ` Filled in as at ${info.previous.event_name}: check and save.` : ''}
            </Note>
            <EventInfoForm info={info} lists={lists} onListsChanged={reload} cancelLabel="Skip"
              onSaved={(saved) => {
                setDone((d) => ({ ...d, [info.event_id]: saved.missing.length
                  ? `Saved. ${saved.event_name} still misses: ${saved.missing.map((k) => MISSING_LABEL[k]).join(', ')}.`
                  : `Saved what ${saved.event_name} was run with.` }));
                onSaved?.();
              }}
              onCancel={() => setDone((d) => ({ ...d, [info.event_id]: `Skipped the event info of ${info.event_name}: fill it in on its page.` }))} />
          </View>
        );
      })}
    </>
  );
}

const useStyles = themed((c) => ({
  fields: { gap: 22 },
  order: { fontFamily: Type.label.fontFamily, fontSize: 15, letterSpacing: 0.3, color: c.text },
  inline: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'flex-end', columnGap: 14, rowGap: 8, width: '100%' },
  inlineInput: { minWidth: 160, flexGrow: 1, flexShrink: 1, flexBasis: 160 },
  form: { gap: 22 },
  missing: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: 16, rowGap: 10, marginTop: 14 },
  ask: { gap: 10, borderTopWidth: 3, borderColor: c.rule, paddingTop: 10, marginTop: 18 },
  askTitle: { fontFamily: Fonts.display, fontSize: 28, lineHeight: 31, textTransform: 'uppercase', color: c.text },
  doneText: { fontFamily: Fonts.body, fontSize: 16, lineHeight: 22, color: c.text, marginTop: 10 },
}));
