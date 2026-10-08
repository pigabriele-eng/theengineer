// A run's driver and name, each one or two taps away: on the event page's run rows and the session page.
// Tap the driver chip for a short list (the event's drivers 1 to 4 first, then the drivers of the run's car, then the
// rest, and "New driver"), tap a name and it's set. The run's car is only shown, never changed here (Gabriele,
// 2026-10-08: "remove the option to change quickly car in the run fields because thats a fixed value per season"):
// a season remembers its car (Tools › Seasons). Tap the run's name to rename it in place. On the session page the
// run's tyres are beside its driver, a tap to change them (components/TyreTag.tsx).
import { Link, useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, TextInput } from 'react-native';

import { Text, View, useThemeColor } from '@/components/Themed';
import { SessionKind } from '@/lib/api';
import { eventsApi, KIND_NAMES, QUICK_LABELS } from '@/lib/events';
import { TyreChoices, TyreTag, useTyreTags } from '@/components/TyreTag';
import { carShort, driversFor, Garage, garageApi, GarageDriver, RunFields, RunSet } from '@/lib/garage';
import { Fonts, themed, Type, useTheme } from '@/constants/Theme';
import { seasonsApi } from '@/lib/seasons';
import { noPrint } from '@/lib/print';
import { a11yState } from '@/lib/a11yState';

export type PickerKind = 'driver';
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

/** The driver chip of a run, and its car in words (set by its season, not here). */
export function RunChips({ run, garage, open, onOpen }: {
  run: RunRef;
  garage: Garage | null;
  open: PickerKind | null;
  onOpen: (what: PickerKind | null) => void;
}) {
  const styles = useStyles();
  // a driver made a moment ago is named by the run until the garage is loaded again
  const driver = garage?.drivers.find((d) => d.id === run.driver_id)
    ?? (run.driver_id != null && run.driver ? { name: run.driver } : undefined);
  const car = garage?.cars.find((c) => c.id === run.car_id);
  const chip = (what: PickerKind, set: boolean) =>
    StyleSheet.flatten([styles.chip, !set && styles.unset, open === what && styles.chipOn]);
  return (
    <View style={styles.chips}>
      <Pressable onPress={() => onOpen(open === 'driver' ? null : 'driver')} hitSlop={4} style={chip('driver', !!driver)}
        accessibilityRole="button" accessibilityLabel={driver ? `Driver ${driver.name}: change` : `Set the driver of ${run.name}`}>
        <Text style={StyleSheet.flatten([styles.chipText, !driver && styles.dim])} numberOfLines={1}>
          {driver ? driver.name : '+ Driver'}
        </Text>
      </Pressable>
      {car && <Text style={styles.car} numberOfLines={1} accessibilityLabel={`Car ${car.name}`}>{carShort(car)}</Text>}
    </View>
  );
}

/** The event's drivers 1 to 4 (from its event info, or its season's entry), to offer first on its runs. */
export function useEventDrivers(eventId: number | null | undefined) {
  const [ids, setIds] = useState<number[]>([]);
  useEffect(() => {
    if (eventId == null) return setIds([]);
    seasonsApi.info(eventId).then((i) => setIds(i.resolved.drivers.map((d) => d.id)), () => setIds([]));
  }, [eventId]);
  return ids;
}

/** The short list the driver chip opens: tap one and it's set. eventDrivers: the event's drivers 1 to 4, offered
 * first. */
export function RunPicker({ run, garage, onPick, onClose, eventDrivers }: {
  run: RunRef;
  garage: Garage;
  onPick: (fields: RunFields) => Promise<void> | void;
  onClose: () => void;
  eventDrivers?: number[];
}) {
  return <DriverList run={run} garage={garage} onPick={onPick} onClose={onClose} eventDrivers={eventDrivers ?? []} />;
}

function DriverList({ run, garage, onPick, onClose, eventDrivers }: {
  run: RunRef;
  garage: Garage;
  onPick: (fields: RunFields) => Promise<void> | void;
  onClose: () => void;
  eventDrivers: number[];
}) {
  const styles = useStyles();
  const theme = useTheme();
  const [typing, setTyping] = useState(false);
  const [name, setName] = useState('');
  const tint = useThemeColor({}, 'tint');
  const text = useThemeColor({}, 'text');
  const ofEvent = eventDrivers.map((id) => garage.drivers.find((d) => d.id === id)).filter((d) => d != null);
  const offered = driversFor(garage, run.car_id);
  const first = offered.first.filter((d) => !eventDrivers.includes(d.id));
  const rest = offered.rest.filter((d) => !eventDrivers.includes(d.id));
  const car = garage.cars.find((c) => c.id === run.car_id);
  const add = () => name.trim() && onPick({ driver_name: name.trim() });
  const option = (d: GarageDriver) => {
    const on = d.id === run.driver_id;
    return (
      <Pressable key={d.id} onPress={() => onPick({ driver_id: d.id })} accessibilityRole="button"
        {...a11yState({ selected: on }, 'button')} style={StyleSheet.flatten([styles.option, on && styles.optionOn])}>
        <Text style={styles.optionText}>{d.name}</Text>
      </Pressable>
    );
  };
  return (
    <View style={styles.panel}>
      <PanelHead title={`Who drove ${run.name}?`} onClose={onClose} />
      {ofEvent.length > 0 && (
        <>
          <Text style={styles.group}>This event&apos;s drivers</Text>
          <View style={styles.options}>{ofEvent.map(option)}</View>
        </>
      )}
      {first.length > 0 && (
        <>
          <Text style={styles.group}>Drives {car ? carShort(car) : 'this car'}</Text>
          <View style={styles.options}>{first.map(option)}</View>
        </>
      )}
      {rest.length > 0 && (
        <>
          {(first.length > 0 || ofEvent.length > 0) && <Text style={styles.group}>Other drivers</Text>}
          <View style={styles.options}>{rest.map(option)}</View>
        </>
      )}
      {typing ? (
        <View style={styles.inputRow}>
          <TextInput value={name} onChangeText={setName} placeholder="New driver's name" placeholderTextColor={theme.textMuted}
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

function PanelHead({ title, onClose }: { title: string; onClose: () => void }) {
  const styles = useStyles();
  return (
    <View style={styles.panelHead}>
      <Text style={styles.panelTitle} numberOfLines={1}>{title}</Text>
      <Pressable onPress={onClose} hitSlop={8} accessibilityRole="button" style={styles.textButton}>
        <Text style={styles.textButtonText}>Close</Text>
      </Pressable>
    </View>
  );
}

function GarageLink() {
  const styles = useStyles();
  return (
    // Link asChild hands its child's style to a web anchor, which can't take a style array: one object
    <Link href="/garage" asChild>
      <Pressable style={styles.garageLink} accessibilityRole="link">
        <Text style={styles.garageText}>Cars, drivers and teams →</Text>
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
  const styles = useStyles();
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
  const chip = (on: boolean) => StyleSheet.flatten([styles.small, on && styles.smallOn]);
  return (
    <View style={styles.editor}>
      <View style={styles.inputRow}>
        <TextInput value={value} onChangeText={setValue} maxLength={120} autoFocus selectTextOnFocus
          accessibilityLabel="Run name" onSubmitEditing={() => submit()}
          style={StyleSheet.flatten([styles.input, styles.nameInput, { color: text }])} />
        <Pressable onPress={() => submit()} disabled={busy} accessibilityRole="button"
          style={StyleSheet.flatten([styles.button, { borderColor: tint }])}>
          {busy ? <ActivityIndicator color={tint} />
            : <Text style={StyleSheet.flatten([styles.buttonText, { color: tint }])}>Save</Text>}
        </Pressable>
        <Pressable onPress={onCancel} hitSlop={8} accessibilityRole="button" style={styles.textButton}>
          <Text style={styles.textButtonText}>Cancel</Text>
        </Pressable>
      </View>
      <View style={styles.options}>
        {QUICK_LABELS.map((q) => (
          <Pressable key={q.label} onPress={() => submit(q.label, q.kind)} disabled={busy} accessibilityRole="button"
            accessibilityLabel={`Name it ${q.label}`} style={chip(value === q.label)}>
            <Text style={styles.smallText}>{q.label}</Text>
          </Pressable>
        ))}
      </View>
      <View style={styles.options}>
        <Text style={styles.kindLabel}>Kind</Text>
        {KINDS.map((kk) => (
          <Pressable key={kk} onPress={() => setK(kk)} accessibilityRole="radio" {...a11yState({ checked: kk === k })}
            style={chip(kk === k)}>
            <Text style={styles.smallText}>{KIND_NAMES[kk]}</Text>
          </Pressable>
        ))}
      </View>
      {logSession && <Text style={styles.note}>The logger calls it {logSession}.</Text>}
      {error && <Text style={styles.error}>{error}</Text>}
    </View>
  );
}

/** The session page's top: the run's name (tap it to rename) and kind, its driver chip and its list, its car in words
 * and, for a run of an event, its tyres (a tap opens their four levels under the line). */
export function RunHeader({ run, kind, logSession, onChanged, eventId, bare = false }: {
  run: RunRef;
  kind: SessionKind;
  logSession?: string | null;
  onChanged: () => void;
  eventId?: number | null; // its event: the event's drivers 1 to 4 are offered first
  bare?: boolean; // the page's headline already names the run: one line of kind, Rename, driver, car and tyres
}) {
  const styles = useStyles();
  const { garage, reload } = useGarage();
  const eventDrivers = useEventDrivers(eventId);
  const [open, setOpen] = useState<PickerKind | null>(null);
  const [editing, setEditing] = useState(false);
  const [local, setLocal] = useState<Partial<RunRef>>({});
  const [note, setNote] = useState<string | null>(null);
  const tint = useThemeColor({}, 'tint');
  const theme = useTheme();
  const shown = { ...run, ...local };
  // read again for each run shown (the page switches runs in place)
  const tyreTags = useTyreTags(eventId, run.id);
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
      ) : bare ? (
        <View style={styles.bareLine}>
          <View style={StyleSheet.flatten([styles.kind, { backgroundColor: theme.rule }])}>
            <Text style={StyleSheet.flatten([styles.kindText, { color: theme.background }])}>{KIND_NAMES[kind]}</Text>
          </View>
          <Pressable onPress={() => setEditing(true)} accessibilityRole="button" accessibilityLabel={`Rename ${run.name}`}
            hitSlop={4} style={styles.chip} {...noPrint}>
            <Text style={styles.chipText}>Rename</Text>
          </Pressable>
          <RunChips run={shown} garage={garage} open={open} onOpen={setOpen} />
          <View style={styles.tyres}><TyreTag tags={tyreTags} id={run.id} run={run.name} size={15} /></View>
        </View>
      ) : (
        <View style={styles.titleLine}>
          <Pressable onPress={() => setEditing(true)} accessibilityRole="button" accessibilityLabel={`Rename ${run.name}`}
            style={styles.titlePress}>
            <Text style={styles.title} numberOfLines={2}>{run.name}</Text>
            <Text style={StyleSheet.flatten([styles.pencil, { color: tint }])}>✎</Text>
          </Pressable>
          <View style={StyleSheet.flatten([styles.kind, { backgroundColor: theme.rule }])}>
            <Text style={StyleSheet.flatten([styles.kindText, { color: theme.background }])}>{KIND_NAMES[kind]}</Text>
          </View>
        </View>
      )}
      {(!bare || editing) && <RunChips run={shown} garage={garage} open={open} onOpen={setOpen} />}
      {open && garage && (
        <RunPicker run={shown} garage={garage} onPick={pick} onClose={() => setOpen(null)} eventDrivers={eventDrivers} />
      )}
      <TyreChoices tags={tyreTags} id={run.id} name={run.name} />
      {note && (
        <Pressable onPress={() => setNote(null)}>
          <Text style={styles.notice}>{note}</Text>
        </Pressable>
      )}
    </View>
  );
}

// The race programme: no boxes or chips. A driver is underlined capitals (red while its list is open, faint
// when unset), a list opens under a thick ink rule, inputs are a single ink rule, the picked option is underlined red.
const useStyles = themed((c) => ({
  header: { gap: 8, backgroundColor: 'transparent' },
  titleLine: { flexDirection: 'row', alignItems: 'center', gap: 10, flexWrap: 'wrap', backgroundColor: 'transparent' },
  bareLine: { flexDirection: 'row', alignItems: 'center', columnGap: 16, rowGap: 8, flexWrap: 'wrap',
    backgroundColor: 'transparent' },
  // the tyres tag at the foot of the chips' 44 px, its words on their line
  tyres: { minHeight: 44, justifyContent: 'flex-end', paddingBottom: 1, backgroundColor: 'transparent' },
  titlePress: { flexDirection: 'row', alignItems: 'center', gap: 6, flexShrink: 1 },
  title: { fontFamily: Fonts.display, fontSize: 30, lineHeight: 32, textTransform: 'uppercase', flexShrink: 1, color: c.text },
  pencil: { fontSize: 15 },
  kind: { paddingHorizontal: 7, paddingTop: 2, paddingBottom: 1 },
  kindText: { ...Type.label, fontSize: 12, letterSpacing: 1.2 },
  notice: { fontFamily: Fonts.body, fontSize: 15, lineHeight: 21, color: c.textSecondary, borderLeftWidth: 3,
    borderColor: c.rule, paddingLeft: 8 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', columnGap: 16, rowGap: 6, backgroundColor: 'transparent' },
  // 44 px tall, a tap target: the room is above the word, its underline stays under it
  chip: { borderBottomWidth: 2, borderColor: c.rule, paddingBottom: 1, maxWidth: 220, minHeight: 44, minWidth: 44,
    justifyContent: 'flex-end' },
  chipOn: { borderColor: c.mark },
  // not set yet: the word in the caption grey (no fading: it must still read at 4.5:1)
  unset: { borderColor: c.borderStrong },
  chipText: { ...Type.link, fontSize: 13, letterSpacing: 1.2, color: c.text },
  dim: { color: c.textMuted },
  // the run's car, in words only (its season sets it): at the foot of the chips' 44 px, on their line
  car: { ...Type.label, fontSize: 13, letterSpacing: 1.2, color: c.textSecondary, alignSelf: 'flex-end', paddingBottom: 3 },
  panel: { borderTopWidth: 3, borderColor: c.rule, paddingTop: 10, gap: 10, marginBottom: 10, backgroundColor: 'transparent' },
  panelHead: { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: 'transparent' },
  panelTitle: { flex: 1, fontFamily: Fonts.body, fontWeight: '600', fontSize: 17, color: c.text },
  group: { ...Type.label, fontSize: 11, color: c.textMuted },
  options: { flexDirection: 'row', flexWrap: 'wrap', columnGap: 18, rowGap: 10, backgroundColor: 'transparent' },
  option: { borderBottomWidth: 3, borderColor: c.separator, paddingBottom: 2, minHeight: 44, justifyContent: 'flex-end' },
  optionOn: { borderColor: c.mark },
  optionText: { ...Type.link, fontSize: 14, color: c.text },
  small: { borderBottomWidth: 2, borderColor: c.separator, paddingBottom: 1, minHeight: 44, justifyContent: 'flex-end' },
  smallOn: { borderColor: c.mark },
  smallText: { ...Type.label, fontSize: 13, letterSpacing: 1, color: c.text },
  inputRow: { flexDirection: 'row', alignItems: 'center', gap: 14, flexWrap: 'wrap', backgroundColor: 'transparent' },
  input: { flex: 1, minWidth: 120, borderBottomWidth: 1, borderColor: c.rule, paddingHorizontal: 0, paddingVertical: 10,
    fontFamily: Fonts.body, fontSize: 16, backgroundColor: 'transparent' },
  nameInput: { fontFamily: Fonts.label, fontSize: 17 },
  button: { borderBottomWidth: 2, borderColor: c.rule, paddingBottom: 1, minWidth: 44, minHeight: 44, alignItems: 'center',
    justifyContent: 'flex-end' },
  buttonText: { ...Type.link },
  textButton: { borderBottomWidth: 2, borderColor: c.separator, paddingBottom: 1, minHeight: 44, justifyContent: 'flex-end' },
  textButtonText: { ...Type.link, fontSize: 12, color: c.textSecondary },
  garageLink: { alignSelf: 'flex-start', borderBottomWidth: 2, borderColor: c.rule, paddingBottom: 1, minHeight: 44,
    justifyContent: 'flex-end' },
  garageText: { ...Type.link, fontSize: 12, letterSpacing: 1.2, color: c.text },
  editor: { gap: 10, backgroundColor: 'transparent' },
  kindLabel: { ...Type.label, fontSize: 11, color: c.textMuted, alignSelf: 'center' },
  note: { fontFamily: Fonts.body, fontSize: 14, color: c.textMuted },
  error: { color: c.error },
}));
