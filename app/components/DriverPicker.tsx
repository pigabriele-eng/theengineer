// Who drove: pick one of the drivers, type a new name, or nobody. Used on the tagging screen (the session page and the
// event page's run rows use the chips in RunChips.tsx).
import { Link } from 'expo-router';
import { Pressable, StyleSheet, TextInput } from 'react-native';

import { Text, View, useThemeColor } from '@/components/Themed';
import { Driver, DriverPick } from '@/lib/drivers';

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
      {/* Link asChild hands its child's style to a web anchor, which can't take a style array: one object */}
      <Link href="/garage" asChild>
        <Pressable style={styles.garage} accessibilityRole="link">
          <Text style={{ color: tint }}>Cars, drivers and teams ›</Text>
        </Pressable>
      </Link>
    </View>
  );
}

const styles = StyleSheet.create({
  choice: { gap: 8 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { borderWidth: 1, borderColor: '#8884', borderRadius: 16, paddingHorizontal: 12, paddingVertical: 5 },
  input: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 8, fontSize: 16 },
  dim: { opacity: 0.5 },
  garage: { alignSelf: 'flex-start' },
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
