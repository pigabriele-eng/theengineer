// Who drove: pick one of the drivers, type a new name, or nobody. Used on the session page and the tagging screen.
import { Link } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, TextInput } from 'react-native';

import { Text, View, useThemeColor } from '@/components/Themed';
import { Driver, DriverPick, driversApi } from '@/lib/drivers';

// The choice being made: a driver's id, a new name, or null for "no driver".
export type Choice = { id: number } | { name: string } | null;

export const toPick = (c: Choice): DriverPick =>
  c == null ? { driver_id: null } : 'id' in c ? { driver_id: c.id } : { driver_name: c.name.trim() };

export function DriverChoice({ drivers, value, onChange, allowNone = true }: {
  drivers: Driver[];
  value: Choice | undefined;
  onChange: (c: Choice | undefined) => void;
  allowNone?: boolean;
}) {
  const tint = useThemeColor({}, 'tint');
  const text = useThemeColor({}, 'text');
  const typed = value != null && 'name' in value ? value.name : '';
  const chip = (selected: boolean) => StyleSheet.flatten([styles.chip, selected && { borderColor: tint }]);
  return (
    <View style={styles.choice}>
      <View style={styles.chips}>
        {drivers.map((d) => {
          const on = value != null && 'id' in value && value.id === d.id;
          return (
            <Pressable key={d.id} onPress={() => onChange({ id: d.id })} style={chip(on)} accessibilityState={{ selected: on }}>
              <Text style={on ? { color: tint } : undefined}>{d.name}</Text>
            </Pressable>
          );
        })}
        {allowNone && (
          <Pressable onPress={() => onChange(null)} style={chip(value === null)} accessibilityState={{ selected: value === null }}>
            <Text style={value === null ? { color: tint } : styles.dim}>No driver</Text>
          </Pressable>
        )}
      </View>
      <TextInput
        value={typed}
        onChangeText={(name) => onChange(name ? { name } : undefined)}
        placeholder={drivers.length ? 'Or a new driver: name' : 'Driver name'}
        placeholderTextColor="#888"
        style={StyleSheet.flatten([styles.input, { color: text, borderColor: typed ? tint : '#8884' }])}
        maxLength={120}
      />
    </View>
  );
}

// The session page's driver line: who drove it, and a way to set or change that.
export function SessionDriver({ sessionId, driverId, onChanged }: {
  sessionId: number;
  driverId: number | null | undefined;
  onChanged: () => void;
}) {
  const [drivers, setDrivers] = useState<Driver[]>([]);
  const [editing, setEditing] = useState(false);
  const [choice, setChoice] = useState<Choice | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const tint = useThemeColor({}, 'tint');
  const background = useThemeColor({}, 'background');

  useEffect(() => {
    driversApi.list().then(setDrivers, () => setDrivers([]));
  }, [driverId]);

  const name = drivers.find((d) => d.id === driverId)?.name;
  const save = async () => {
    if (choice === undefined || (choice != null && 'name' in choice && !choice.name.trim())) return setEditing(false);
    setBusy(true);
    setError(null);
    try {
      await driversApi.setSession(sessionId, toPick(choice));
      setEditing(false);
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={styles.box}>
      <View style={styles.line}>
        <Text style={styles.label}>Driver</Text>
        <Text style={StyleSheet.flatten([styles.name, !name && styles.dim])}>{name ?? 'not set'}</Text>
        {!editing && (
          <Pressable
            hitSlop={8}
            onPress={() => {
              setChoice(driverId != null ? { id: driverId } : undefined);
              setEditing(true);
            }}>
            <Text style={{ color: tint }}>{name ? 'Change' : 'Set'}</Text>
          </Pressable>
        )}
      </View>
      {editing && (
        <>
          <DriverChoice drivers={drivers} value={choice} onChange={setChoice} />
          <View style={styles.line}>
            <Pressable onPress={save} disabled={busy} style={StyleSheet.flatten([styles.save, { backgroundColor: tint }])}>
              {busy ? (
                <ActivityIndicator color={background} />
              ) : (
                <Text style={StyleSheet.flatten([styles.saveText, { color: background }])}>Save</Text>
              )}
            </Pressable>
            <Pressable onPress={() => setEditing(false)} hitSlop={8}>
              <Text style={{ color: tint }}>Cancel</Text>
            </Pressable>
          </View>
        </>
      )}
      {error && <Text style={styles.error}>{error}</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  box: { gap: 8 },
  choice: { gap: 8 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { borderWidth: 1, borderColor: '#8884', borderRadius: 16, paddingHorizontal: 12, paddingVertical: 5 },
  input: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 8, fontSize: 16 },
  line: { flexDirection: 'row', alignItems: 'center', gap: 12, flexWrap: 'wrap' },
  label: { fontSize: 12, opacity: 0.6, textTransform: 'uppercase', letterSpacing: 0.5 },
  name: { fontSize: 16, fontWeight: '600' },
  dim: { opacity: 0.5 },
  save: { borderRadius: 8, paddingHorizontal: 18, paddingVertical: 8, minWidth: 80, alignItems: 'center' },
  saveText: { fontWeight: '600' },
  error: { color: '#c8372d' },
  links: { flexDirection: 'row', gap: 8 },
  linkButton: { flex: 1, borderWidth: 1, borderRadius: 8, paddingVertical: 10, alignItems: 'center' },
  linkText: { fontWeight: '600', fontSize: 16 },
});

// The Sessions tab's way in: tag sessions with their drivers, and compare two drivers over many laps.
export function DriverLinks() {
  const tint = useThemeColor({}, 'tint');
  // Link asChild hands its child's style to a web anchor, which can't take a style array: one object
  const button = StyleSheet.flatten([styles.linkButton, { borderColor: tint }]);
  return (
    <View style={styles.links}>
      <Link href="/drivers/tag" asChild>
        <Pressable style={button}>
          <Text style={StyleSheet.flatten([styles.linkText, { color: tint }])}>Tag drivers</Text>
        </Pressable>
      </Link>
      <Link href="/drivers/compare" asChild>
        <Pressable style={button}>
          <Text style={StyleSheet.flatten([styles.linkText, { color: tint }])}>Compare drivers</Text>
        </Pressable>
      </Link>
    </View>
  );
}
