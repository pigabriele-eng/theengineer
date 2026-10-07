import { Stack, useFocusEffect } from 'expo-router';
import { ReactNode, useCallback, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet } from 'react-native';

import {
  Choice, Choices, ErrorLine, Field, FormActions, Input, MainButton, Note, PageTitle, Said,
} from '@/components/Controls';
import { Colophon, Page, Section, TextLink, useWide } from '@/components/Programme';
import { Text, View } from '@/components/Themed';
import { dayLabel } from '@/lib/events';
import { carLong, Garage, garageApi, GarageCar, GarageDriver, GarageTeam, Logger } from '@/lib/garage';
import { Axle, catalogApi, Tyre, TyreSpecs, Vehicle } from '@/lib/seasons';
import { Fonts, themed, Type } from '@/constants/Theme';

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

type Kind = 'car' | 'driver' | 'team' | 'vehicle' | 'tyre';
type Editing = { kind: Kind; id: number | null } | null; // id null: a new one
type CatalogLists = { vehicles: Vehicle[]; tyres: Tyre[] };

/** Cars (number, model, vehicle, team, logger, drivers), drivers (team, cars), teams, and the vehicles and tyres the
 * cars and events pick from: add, change and remove them here, one numbered section each. Runs are tagged on the event
 * page and the session page, with the driver and car chips. */
export default function GarageScreen() {
  const styles = useStyles();
  const [garage, setGarage] = useState<Garage | null>(null);
  const [catalog, setCatalog] = useState<CatalogLists>({ vehicles: [], tyres: [] });
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Editing>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(() => {
    garageApi.get().then(
      (g) => {
        setGarage(g);
        setError(null);
      },
      (e) => setError((e as Error).message),
    );
    Promise.all([catalogApi.vehicles(), catalogApi.tyres()]).then(
      ([vehicles, tyres]) => setCatalog({ vehicles, tyres }),
      () => {}, // an older server: no lists
    );
  }, []);
  useFocusEffect(load);

  const done = (message?: string) => {
    setEditing(null);
    setNotice(message ?? null);
    load();
  };
  const isEditing = (kind: Kind, id: number | null) => editing?.kind === kind && editing.id === id;
  const edit = (kind: Kind, id: number | null) => {
    setNotice(null);
    setEditing(isEditing(kind, id) ? null : { kind, id });
  };
  const cancel = () => setEditing(null);

  return (
    <Page>
      <Stack.Screen options={{ title: 'Cars, drivers and teams' }} />
      <PageTitle kicker="Tools" title="Garage"
        dek="Your cars, drivers and teams, and the vehicles and tyres they run on. Tag a run’s driver and car on the event page, under the run." />
      {!garage && !error && <ActivityIndicator style={styles.loading} />}
      {error && <View style={styles.top}><ErrorLine>{error}</ErrorLine></View>}
      {notice && <View style={styles.top}><Said text={notice} onPress={() => setNotice(null)} /></View>}
      {garage && (
        <>
          <Part no={1} title="Cars" dek="Each with its number, model, team and the logger that records it."
            add="+ Add car" onAdd={() => edit('car', null)}>
            {isEditing('car', null) && (
              <NewForm><CarForm garage={garage} vehicles={catalog.vehicles} onDone={done} onCancel={cancel} /></NewForm>
            )}
            {garage.cars.map((c) => (
              <Item key={c.id} title={carLong(c)}
                sub={[c.team, c.loggers.length ? `logger ${c.loggers.join(', ')}` : 'no logger linked',
                  names(garage.drivers, c.driver_ids), plural(c.runs, 'run')].filter(Boolean).join(' · ')}
                open={isEditing('car', c.id)} onPress={() => edit('car', c.id)}>
                <CarForm car={c} garage={garage} vehicles={catalog.vehicles} onDone={done} onCancel={cancel} />
              </Item>
            ))}
            {garage.cars.length === 0 && !isEditing('car', null) && (
              <Note style={styles.empty}>No cars yet. Add one with its number and model, and link its logger.</Note>
            )}
          </Part>
          <Part no={2} title="Drivers" dek="Their team and the cars they drive." add="+ Add driver"
            onAdd={() => edit('driver', null)}>
            {isEditing('driver', null) && <NewForm><DriverForm garage={garage} onDone={done} onCancel={cancel} /></NewForm>}
            {garage.drivers.map((d) => (
              <Item key={d.id} title={d.name}
                sub={[d.team, d.car_ids.map((id) => carName(garage, id)).join(', '), plural(d.runs, 'run')]
                  .filter(Boolean).join(' · ')}
                open={isEditing('driver', d.id)} onPress={() => edit('driver', d.id)}>
                <DriverForm driver={d} garage={garage} onDone={done} onCancel={cancel} />
              </Item>
            ))}
            {garage.drivers.length === 0 && !isEditing('driver', null) && <Note style={styles.empty}>No drivers yet.</Note>}
          </Part>
          <Part no={3} title="Teams" add="+ Add team" onAdd={() => edit('team', null)}>
            {isEditing('team', null) && <NewForm><TeamForm onDone={done} onCancel={cancel} /></NewForm>}
            {garage.teams.map((t) => (
              <Item key={t.id} title={t.name}
                sub={[plural(t.car_ids.length, 'car'), plural(t.driver_ids.length, 'driver')].join(' · ')}
                open={isEditing('team', t.id)} onPress={() => edit('team', t.id)}>
                <TeamForm team={t} onDone={done} onCancel={cancel} />
              </Item>
            ))}
            {garage.teams.length === 0 && !isEditing('team', null) && <Note style={styles.empty}>No teams yet.</Note>}
          </Part>
          <Part no={4} title="Vehicles" dek="The car models you run; each car picks one." add="+ Add vehicle"
            onAdd={() => edit('vehicle', null)}>
            {isEditing('vehicle', null) && <NewForm><VehicleForm onDone={done} onCancel={cancel} /></NewForm>}
            {catalog.vehicles.map((v) => (
              <Item key={v.id} title={v.name}
                sub={[v.maker, v.car_class, (v.car_ids ?? []).map((id) => carName(garage, id)).filter(Boolean).join(', ')]
                  .filter(Boolean).join(' · ')}
                open={isEditing('vehicle', v.id)} onPress={() => edit('vehicle', v.id)}>
                <VehicleForm vehicle={v} onDone={done} onCancel={cancel} />
              </Item>
            ))}
            {catalog.vehicles.length === 0 && !isEditing('vehicle', null) && (
              <Note style={styles.empty}>No vehicles yet. Add the car models you run, e.g. BMW M4 GT4 Evo (G82); each car picks one.</Note>
            )}
          </Part>
          <Part no={5} title="Tyres" dek="Each tyre with its P-Book pressures: different tyres are kept apart."
            add="+ Add tyre" onAdd={() => edit('tyre', null)}>
            {isEditing('tyre', null) && <NewForm><TyreForm onDone={done} onCancel={cancel} /></NewForm>}
            {catalog.tyres.map((t) => (
              <Item key={t.id} title={t.label} sub={tyreWords(t)} open={isEditing('tyre', t.id)} onPress={() => edit('tyre', t.id)}>
                <TyreForm tyre={t} onDone={done} onCancel={cancel} />
              </Item>
            ))}
            {catalog.tyres.length === 0 && !isEditing('tyre', null) && (
              <Note style={styles.empty}>
                No tyres yet. Add each tyre you run (brand and compound) with its P-Book pressures: different tyres are kept
                apart.
              </Note>
            )}
          </Part>
          {garage.loggers.length > 0 && (
            <Part no={6} title="Loggers in the logs"
              dek="Each log carries its logger’s serial number. Link a logger to its car (edit the car) and every run from it gets the car, now and with each new upload.">
              <View style={styles.list}>
                {garage.loggers.map((l) => (
                  <View key={l.serial} style={styles.item}>
                    <View style={styles.itemHead}>
                      <View style={styles.itemText}>
                        <Text style={styles.loggerTitle}>{loggerWords(l)}</Text>
                      </View>
                      <Text style={StyleSheet.flatten([styles.status, l.car_id == null && styles.statusOff])}>
                        {l.car_id != null ? `In ${carName(garage, l.car_id)}` : 'Not linked'}
                      </Text>
                    </View>
                  </View>
                ))}
              </View>
            </Part>
          )}
        </>
      )}
      <Colophon left="The Engineer · Garage" links={[
        { label: 'Sessions', href: '/' },
        { label: 'Seasons', href: '/seasons' },
        { label: 'Tools', href: '/tools' },
      ]} />
    </Page>
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

/** A numbered section of the garage, its "+ Add" link first, then one ruled line per item. */
function Part({ no, title, dek, add, onAdd, children }: {
  no: number;
  title: string;
  dek?: string;
  add?: string;
  onAdd?: () => void;
  children: ReactNode;
}) {
  const styles = useStyles();
  return (
    <Section no={no} title={title} dek={dek}>
      {add && onAdd && <View style={styles.add}><TextLink onPress={onAdd} label={add} red /></View>}
      <View style={styles.list}>{children}</View>
    </Section>
  );
}

/** A new item's form, in a band at the top of its list. */
function NewForm({ children }: { children: ReactNode }) {
  const styles = useStyles();
  return <View style={styles.newForm}>{children}</View>;
}

/** One line of a list: its name large, what it holds under it, Edit on the right; the form opens under it. */
function Item({ title, sub, open, onPress, children }: {
  title: string;
  sub: string;
  open: boolean;
  onPress: () => void;
  children: ReactNode;
}) {
  const styles = useStyles();
  const wide = useWide();
  return (
    <View style={StyleSheet.flatten([styles.item, open && styles.itemOpen])}>
      <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={`${open ? 'Close' : 'Edit'} ${title}`}
        style={styles.itemHead}>
        <View style={styles.itemText}>
          <Text style={wide ? styles.itemTitle : styles.itemTitlePhone}>{title}</Text>
          {sub ? <Text style={styles.sub}>{sub}</Text> : null}
        </View>
        <Text style={StyleSheet.flatten([styles.edit, open && styles.editOn])}>{open ? 'Close' : 'Edit'}</Text>
      </Pressable>
      {open && <View style={styles.itemForm}>{children}</View>}
    </View>
  );
}

/** A team: one of the teams, a new one typed, or none. */
type TeamPick = { id: number | null } | { name: string };

function TeamChoice({ teams, value, onChange }: { teams: GarageTeam[]; value: TeamPick; onChange: (t: TeamPick) => void }) {
  const styles = useStyles();
  const typing = 'name' in value;
  return (
    <Choices>
      {teams.map((t) => (
        <Choice key={t.id} label={t.name} on={'id' in value && value.id === t.id} onPress={() => onChange({ id: t.id })} />
      ))}
      <Choice label="No team" on={'id' in value && value.id == null} onPress={() => onChange({ id: null })} />
      {typing ? (
        <Input value={value.name} onChangeText={(name) => onChange({ name })} placeholder="New team" autoFocus maxLength={120}
          accessibilityLabel="New team's name" style={styles.inlineInput} />
      ) : (
        <Choice label="+ New team" on={false} add onPress={() => onChange({ name: '' })} />
      )}
    </Choices>
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
  if (confirm && onRemove) {
    return (
      <View style={styles.confirm}>
        <Text style={styles.confirmText}>{removeQuestion}</Text>
        <FormActions>
          <MainButton danger label={removeLabel ?? 'Remove'} onPress={onRemove} busy={busy} />
          <TextLink onPress={() => setConfirm(false)} label="Keep it" />
        </FormActions>
      </View>
    );
  }
  return (
    <FormActions>
      <MainButton label="Save" onPress={onSave} busy={busy} />
      <TextLink onPress={onCancel} label="Cancel" />
      {onRemove && removeLabel && (
        <View style={styles.remove}><TextLink onPress={() => setConfirm(true)} label={removeLabel} small /></View>
      )}
    </FormActions>
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

function CarForm({ car, garage, vehicles, onDone, onCancel }: {
  car?: GarageCar;
  garage: Garage;
  vehicles: Vehicle[];
  onDone: (message?: string) => void;
  onCancel: () => void;
}) {
  const styles = useStyles();
  const [number, setNumber] = useState(car?.number ?? '');
  const [model, setModel] = useState(car?.model ?? (car ? car.name : garage.models[0] ?? ''));
  const [team, setTeam] = useState<TeamPick>({ id: car?.team_id ?? null });
  const [loggers, setLoggers] = useState<number[]>(car?.loggers ?? []);
  const [serial, setSerial] = useState('');
  const [driverIds, setDriverIds] = useState<number[]>(car?.driver_ids ?? []);
  const linked = car ? vehicles.find((v) => v.car_ids?.includes(car.id))?.id ?? null : null;
  const [vehicleId, setVehicleId] = useState<number | null>(linked);
  const { busy, error, setError, run } = useSaver(onDone);
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
    if (vehicleId !== linked) await catalogApi.setCarVehicle(r.car.id, vehicleId);
    return r.filled.length
      ? `${carLong(r.car)} is now set on ${plural(r.filled.length, 'run')} from its logger.` : undefined;
  });
  return (
    <View style={styles.form}>
      <View style={styles.formRow}>
        <Field label="Number">
          <Input value={number} onChangeText={setNumber} placeholder="21" maxLength={8} accessibilityLabel="Car number"
            style={styles.number} />
        </Field>
        <Field label="Model" style={styles.grow}>
          <Input value={model} onChangeText={setModel} placeholder="BMW M4 GT4 Evo (G82)" maxLength={100}
            accessibilityLabel="Car model" />
        </Field>
      </View>
      {vehicles.length > 0 ? (
        <Field label="Vehicle">
          <Choices>
            {vehicles.map((v) => (
              <Choice key={v.id} label={v.name} on={vehicleId === v.id} onPress={() => {
                setVehicleId(vehicleId === v.id ? null : v.id);
                if (vehicleId !== v.id) setModel(v.name);
              }} />
            ))}
            <Choice label="No vehicle" on={vehicleId == null} onPress={() => setVehicleId(null)} />
          </Choices>
        </Field>
      ) : garage.models.length > 0 && (
        <Choices>
          {garage.models.map((m) => <Choice key={m} label={m} on={m === model} onPress={() => setModel(m)} />)}
        </Choices>
      )}
      <Field label="Team">
        <TeamChoice teams={garage.teams} value={team} onChange={setTeam} />
      </Field>
      <Field label="Logger">
        <Choices>
          {known.map((l) => {
            const other = l.car_id != null && l.car_id !== car?.id && !loggers.includes(l.serial);
            return (
              <Choice key={l.serial} on={loggers.includes(l.serial)} onPress={() => setLoggers((x) => toggle(x, l.serial))}
                label={`${l.serial}`}
                sub={[l.venue, plural(l.runs, 'run'), other ? `in ${carName(garage, l.car_id!)}` : null]
                  .filter(Boolean).join(' · ')} />
            );
          })}
        </Choices>
        <View style={styles.serialRow}>
          <Input value={serial} onChangeText={setSerial} placeholder="Serial number" keyboardType="number-pad" maxLength={12}
            onSubmitEditing={typedSerial} accessibilityLabel="Logger serial number" style={styles.serial} />
          <TextLink onPress={typedSerial} label="Add" small />
        </View>
        <Note>Every run from a linked logger gets this car, now and with each new upload.</Note>
      </Field>
      {garage.drivers.length > 0 && (
        <Field label="Drivers">
          <Choices>
            {garage.drivers.map((d) => (
              <Choice key={d.id} label={d.name} on={driverIds.includes(d.id)} onPress={() => setDriverIds((x) => toggle(x, d.id))} />
            ))}
          </Choices>
        </Field>
      )}
      {error && <ErrorLine>{error}</ErrorLine>}
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
  const [name, setName] = useState(driver?.name ?? '');
  const [team, setTeam] = useState<TeamPick>({ id: driver?.team_id ?? null });
  const [carIds, setCarIds] = useState<number[]>(driver?.car_ids ?? []);
  const { busy, error, run } = useSaver(onDone);
  const save = () => run(async () => {
    if (!name.trim()) throw new Error("Give the driver's name.");
    const body = { name: name.trim(), ...teamFields(team), car_ids: carIds };
    if (driver) await garageApi.updateDriver(driver.id, body);
    else await garageApi.addDriver(body);
  });
  return (
    <View style={styles.form}>
      <Field label="Name">
        <Input value={name} onChangeText={setName} placeholder="Name" maxLength={120} autoFocus={!driver}
          accessibilityLabel="Driver's name" />
      </Field>
      <Field label="Team">
        <TeamChoice teams={garage.teams} value={team} onChange={setTeam} />
      </Field>
      {garage.cars.length > 0 && (
        <Field label="Drives">
          <Choices>
            {garage.cars.map((c) => (
              <Choice key={c.id} label={carLong(c)} on={carIds.includes(c.id)}
                onPress={() => setCarIds((x) => (x.includes(c.id) ? x.filter((y) => y !== c.id) : [...x, c.id]))} />
            ))}
          </Choices>
        </Field>
      )}
      {error && <ErrorLine>{error}</ErrorLine>}
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
  const [name, setName] = useState(team?.name ?? '');
  const { busy, error, run } = useSaver(onDone);
  const save = () => run(async () => {
    if (!name.trim()) throw new Error('Give the team a name.');
    if (team) await garageApi.renameTeam(team.id, name.trim());
    else await garageApi.addTeam(name.trim());
  });
  return (
    <View style={styles.form}>
      <Field label="Name">
        <Input value={name} onChangeText={setName} placeholder="Team name" maxLength={120} autoFocus={!team}
          onSubmitEditing={save} accessibilityLabel="Team name" />
      </Field>
      {error && <ErrorLine>{error}</ErrorLine>}
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

// ---------- vehicles and tyres ----------

const bar = (a?: Axle) => (a && (a.front != null || a.rear != null)
  ? `${a.front != null ? a.front.toFixed(2) : '–'}/${a.rear != null ? a.rear.toFixed(2) : '–'}` : null);

/** "30/68-18 · cold min 1.30/1.20 · hot target 1.95/1.85 bar · P-Book 2026 p.12" */
const tyreWords = (t: Tyre) => {
  const s = t.specs ?? {};
  const p = [bar(s.cold_min_bar) && `cold min ${bar(s.cold_min_bar)}`, bar(s.hot_min_bar) && `hot min ${bar(s.hot_min_bar)}`,
    bar(s.hot_target_bar) && `hot target ${bar(s.hot_target_bar)}`].filter(Boolean).join(', ');
  return [t.size, p ? `${p} bar (front/rear)` : 'no pressures yet', s.source].filter(Boolean).join(' · ');
};

function VehicleForm({ vehicle, onDone, onCancel }: { vehicle?: Vehicle; onDone: (message?: string) => void; onCancel: () => void }) {
  const styles = useStyles();
  const [name, setName] = useState(vehicle?.name ?? '');
  const [maker, setMaker] = useState(vehicle?.maker ?? '');
  const [carClass, setCarClass] = useState(vehicle?.car_class ?? '');
  const [notes, setNotes] = useState(vehicle?.notes ?? '');
  const { busy, error, run } = useSaver(onDone);
  const save = () => run(async () => {
    if (!name.trim()) throw new Error('Give the vehicle a name, e.g. BMW M4 GT4 Evo (G82).');
    const body = { name: name.trim(), maker: maker.trim() || null, car_class: carClass.trim() || null,
      notes: notes.trim() || null };
    if (vehicle) await catalogApi.updateVehicle(vehicle.id, body);
    else await catalogApi.addVehicle(body);
  });
  return (
    <View style={styles.form}>
      <Field label="Name">
        <Input value={name} onChangeText={setName} placeholder="BMW M4 GT4 Evo (G82)" maxLength={120} autoFocus={!vehicle}
          accessibilityLabel="Vehicle name" />
      </Field>
      <View style={styles.formRow}>
        <Field label="Maker" style={styles.grow}>
          <Input value={maker} onChangeText={setMaker} placeholder="BMW" maxLength={80} accessibilityLabel="Maker" />
        </Field>
        <Field label="Class" style={styles.grow}>
          <Input value={carClass} onChangeText={setCarClass} placeholder="GT4" maxLength={40} accessibilityLabel="Class" />
        </Field>
      </View>
      <Field label="Notes">
        <Input value={notes} onChangeText={setNotes} placeholder="Optional" maxLength={4000} multiline accessibilityLabel="Notes" />
      </Field>
      {error && <ErrorLine>{error}</ErrorLine>}
      <FormButtons busy={busy} onSave={save} onCancel={onCancel}
        removeLabel={vehicle ? 'Remove vehicle' : undefined}
        removeQuestion={vehicle ? `Remove ${vehicle.name}? Its cars stay, without a vehicle.` : undefined}
        onRemove={vehicle ? () => run(async () => {
          await catalogApi.removeVehicle(vehicle.id);
          return `${vehicle.name} removed.`;
        }) : undefined} />
    </View>
  );
}

const typed = (v: number | null | undefined) => (v != null ? String(v) : '');

/** A pressure as typed ("1.3" or "1,3"), in bar; null when empty. */
function pressure(text: string, what: string): number | null {
  const t = text.trim().replace(',', '.');
  if (!t) return null;
  const n = Number(t);
  if (!Number.isFinite(n) || n < 0 || n > 10) throw new Error(`${what}: a pressure in bar, e.g. 1.85.`);
  return n;
}

const ROWS: [keyof Omit<TyreSpecs, 'source'>, string][] = [
  ['cold_min_bar', 'Minimum cold'],
  ['hot_min_bar', 'Minimum hot'],
  ['hot_target_bar', 'Target hot'],
];

function TyreForm({ tyre, onDone, onCancel }: { tyre?: Tyre; onDone: (message?: string) => void; onCancel: () => void }) {
  const styles = useStyles();
  const [brand, setBrand] = useState(tyre?.brand ?? '');
  const [compound, setCompound] = useState(tyre?.compound ?? '');
  const [size, setSize] = useState(tyre?.size ?? '');
  const [source, setSource] = useState(tyre?.specs.source ?? '');
  const [notes, setNotes] = useState(tyre?.notes ?? '');
  const [p, setP] = useState<Record<string, string>>(() => {
    const out: Record<string, string> = {};
    for (const [k] of ROWS) {
      out[`${k}.front`] = typed(tyre?.specs[k]?.front);
      out[`${k}.rear`] = typed(tyre?.specs[k]?.rear);
    }
    return out;
  });
  const { busy, error, run } = useSaver(onDone);
  const save = () => run(async () => {
    if (!brand.trim() || !compound.trim()) throw new Error('Give the tyre its brand and compound.');
    const specs: TyreSpecs = { source: source.trim() || null };
    for (const [k, label] of ROWS) {
      const front = pressure(p[`${k}.front`], `${label} front`);
      const rear = pressure(p[`${k}.rear`], `${label} rear`);
      if (front != null || rear != null) specs[k] = { front, rear };
    }
    const body = { brand: brand.trim(), compound: compound.trim(), size: size.trim() || null, specs,
      notes: notes.trim() || null };
    if (tyre) await catalogApi.updateTyre(tyre.id, body);
    else await catalogApi.addTyre(body);
  });
  return (
    <View style={styles.form}>
      <View style={styles.formRow}>
        <Field label="Brand" style={styles.grow}>
          <Input value={brand} onChangeText={setBrand} placeholder="Pirelli" maxLength={80} autoFocus={!tyre}
            accessibilityLabel="Tyre brand" />
        </Field>
        <Field label="Compound" style={styles.grow}>
          <Input value={compound} onChangeText={setCompound} placeholder="P Zero DHG" maxLength={80} accessibilityLabel="Compound" />
        </Field>
      </View>
      <Field label="Size">
        <Input value={size} onChangeText={setSize} placeholder="Optional, e.g. 265/645 R18" maxLength={40}
          accessibilityLabel="Tyre size" />
      </Field>
      <Field label="P-Book pressures, bar">
        <View style={styles.pressures}>
          <View style={styles.pressureHeadRow}>
            <View style={styles.pressureLabel} />
            <Text style={styles.pressureHead}>Front</Text>
            <Text style={styles.pressureHead}>Rear</Text>
          </View>
          {ROWS.map(([k, label]) => (
            <View key={k} style={styles.pressureRow}>
              <Text style={StyleSheet.flatten([styles.pressureLabel, styles.pressureName])}>{label}</Text>
              {(['front', 'rear'] as const).map((axle) => (
                <Input key={axle} value={p[`${k}.${axle}`]} onChangeText={(v) => setP((x) => ({ ...x, [`${k}.${axle}`]: v }))}
                  placeholder="–" inputMode="decimal" maxLength={5} accessibilityLabel={`${label} ${axle}`}
                  style={styles.pressureInput} />
              ))}
            </View>
          ))}
        </View>
      </Field>
      <Field label="Source">
        <Input value={source} onChangeText={setSource} placeholder="e.g. P-Book 2026 p.12" maxLength={200}
          accessibilityLabel="Where the pressures come from" />
      </Field>
      <Field label="Notes">
        <Input value={notes} onChangeText={setNotes} placeholder="Optional" maxLength={4000} multiline accessibilityLabel="Notes" />
      </Field>
      {error && <ErrorLine>{error}</ErrorLine>}
      <FormButtons busy={busy} onSave={save} onCancel={onCancel}
        removeLabel={tyre ? 'Remove tyre' : undefined}
        removeQuestion={tyre ? `Remove ${tyre.label}? Events that named it are left without a tyre.` : undefined}
        onRemove={tyre ? () => run(async () => {
          await catalogApi.removeTyre(tyre.id);
          return `${tyre.label} removed.`;
        }) : undefined} />
    </View>
  );
}

const useStyles = themed((c) => ({
  loading: { marginTop: 28, alignSelf: 'flex-start' },
  top: { marginTop: 18, maxWidth: 720 },
  empty: { marginTop: 10 },

  add: { marginBottom: 14 },
  list: { borderTopWidth: 1, borderColor: c.rule },
  newForm: { borderBottomWidth: 1, borderColor: c.rule, paddingTop: 14, paddingBottom: 18, backgroundColor: c.band,
    paddingHorizontal: 14 },
  item: { borderBottomWidth: 1, borderColor: c.separator },
  itemOpen: { borderColor: c.rule },
  itemHead: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingTop: 12, paddingBottom: 11 },
  itemText: { flex: 1, minWidth: 0, gap: 3 },
  itemTitle: { fontFamily: Fonts.display, fontSize: 28, lineHeight: 31, textTransform: 'uppercase', color: c.text },
  itemTitlePhone: { fontFamily: Fonts.display, fontSize: 23, lineHeight: 26, textTransform: 'uppercase', color: c.text },
  loggerTitle: { fontFamily: Type.label.fontFamily, fontSize: 16, letterSpacing: 0.3, color: c.text },
  sub: { fontFamily: Fonts.body, fontSize: 15, lineHeight: 20, color: c.textSecondary },
  edit: { ...Type.link, fontSize: 12, letterSpacing: 1.2, color: c.text, borderBottomWidth: 2, borderColor: c.rule,
    paddingBottom: 1 },
  editOn: { borderColor: c.mark },
  itemForm: { paddingBottom: 20, paddingTop: 4 },
  status: { ...Type.label, fontFamily: Fonts.label, color: c.text, borderBottomWidth: 3, borderColor: c.rule, paddingBottom: 2 },
  statusOff: { color: c.textMuted, borderColor: c.textMuted },

  form: { gap: 20, maxWidth: 820 },
  formRow: { flexDirection: 'row', flexWrap: 'wrap', columnGap: 22, rowGap: 18, alignItems: 'flex-start' },
  grow: { flex: 1, minWidth: 180 },
  number: { width: 90 },
  serialRow: { flexDirection: 'row', alignItems: 'flex-end', gap: 14, marginTop: 4 },
  serial: { width: 170 },
  inlineInput: { minWidth: 150, flexGrow: 1, flexShrink: 1, flexBasis: 150 },
  remove: { marginLeft: 'auto' },
  confirm: { gap: 10, borderTopWidth: 1, borderColor: c.error, paddingTop: 10 },
  confirmText: { fontFamily: Fonts.body, fontSize: 17, lineHeight: 24, color: c.error },

  pressures: { gap: 4 },
  pressureHeadRow: { flexDirection: 'row', alignItems: 'flex-end', gap: 14, borderBottomWidth: 1, borderColor: c.rule,
    paddingBottom: 4 },
  pressureRow: { flexDirection: 'row', alignItems: 'flex-end', gap: 14 },
  pressureLabel: { width: 118 },
  pressureName: { fontFamily: Fonts.body, fontSize: 16, lineHeight: 34, color: c.text },
  pressureHead: { ...Type.label, fontFamily: Fonts.label, width: 76, textAlign: 'center', color: c.text },
  pressureInput: { width: 76, textAlign: 'center', fontFamily: Fonts.label, fontVariant: ['tabular-nums'] },
}));
