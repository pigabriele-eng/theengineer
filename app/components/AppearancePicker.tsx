// Tools › Appearance: System, Light or Dark, remembered on this device (lib/appearance.ts).
import { Pressable, StyleSheet } from 'react-native';

import { Text, View } from '@/components/Themed';
import { Radius, themed, Type } from '@/constants/Theme';
import { APPEARANCES, setAppearance, useAppearance } from '@/lib/appearance';

export function AppearancePicker() {
  const styles = useStyles();
  const choice = useAppearance();
  return (
    <View style={styles.group}>
      <Text style={styles.groupName}>Appearance</Text>
      <View style={styles.row}>
        <View style={styles.rowText}>
          <Text style={styles.title}>Theme</Text>
          <Text style={styles.blurb}>System follows this device&apos;s light or dark setting.</Text>
        </View>
        <View style={styles.segments} accessibilityRole="radiogroup" accessibilityLabel="Theme">
          {APPEARANCES.map((a) => {
            const on = a.value === choice;
            return (
              <Pressable key={a.value} onPress={() => setAppearance(a.value)} accessibilityRole="radio"
                accessibilityState={{ checked: on }} hitSlop={4}
                style={StyleSheet.flatten([styles.segment, on && styles.segmentOn])}>
                <Text style={StyleSheet.flatten([styles.segmentText, on && styles.segmentTextOn])}>{a.label}</Text>
              </Pressable>
            );
          })}
        </View>
      </View>
    </View>
  );
}

const useStyles = themed((c) => ({
  group: { gap: 4 },
  groupName: Type.label,
  row: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 12, paddingVertical: 12, borderBottomWidth: 1,
    borderColor: c.separator },
  rowText: { flexGrow: 1, flexShrink: 1, flexBasis: 200, gap: 2 },
  title: { fontSize: 16, fontWeight: '600' },
  blurb: { opacity: 0.6, lineHeight: 19 },
  segments: { flexDirection: 'row', borderWidth: 1, borderColor: c.border, borderRadius: Radius.control, overflow: 'hidden',
    backgroundColor: c.surface },
  segment: { paddingHorizontal: 14, paddingVertical: 8 },
  segmentOn: { backgroundColor: c.tint },
  segmentText: { fontSize: 14, fontWeight: '600', color: c.textSecondary },
  segmentTextOn: { color: c.onTint },
}));
