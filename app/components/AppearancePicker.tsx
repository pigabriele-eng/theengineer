// Tools › Appearance: System, Light or Dark, remembered on this device (lib/appearance.ts). A numbered section of the
// Tools page: the three choices as the programme's tabs (Anton capitals, the one in use over a red underline), each
// with a sample of its paper and ink.
import { Pressable, StyleSheet } from 'react-native';

import { Section, useWide } from '@/components/Programme';
import { Text, View } from '@/components/Themed';
import Colors from '@/constants/Colors';
import { Fonts, themed, Type } from '@/constants/Theme';
import { Appearance, APPEARANCES, setAppearance, useAppearance } from '@/lib/appearance';
import { a11yState } from '@/lib/a11yState';

const NOTE: Record<Appearance, string> = {
  system: 'Follows this device',
  light: 'The programme as printed',
  dark: 'The programme inverted',
};

export function AppearancePicker({ no }: { no: number }) {
  const styles = useStyles();
  const wide = useWide();
  const choice = useAppearance();
  return (
    <Section no={no} title="Appearance" dek="Light is the programme as printed; dark is the same page inverted. System follows this device’s own setting.">
      <View style={wide ? styles.row : styles.rowPhone} accessibilityRole="radiogroup" accessibilityLabel="Theme">
        {APPEARANCES.map((a) => {
          const on = a.value === choice;
          return (
            <Pressable key={a.value} onPress={() => setAppearance(a.value)} accessibilityRole="radio"
              {...a11yState({ checked: on })} accessibilityLabel={`${a.label}: ${NOTE[a.value]}`} hitSlop={4}
              style={StyleSheet.flatten([wide ? styles.choice : styles.choicePhone, on && styles.choiceOn])}>
              <Sample kind={a.value} />
              <View style={styles.words}>
                <Text style={StyleSheet.flatten([wide ? styles.name : styles.namePhone, on && styles.nameOn])}>{a.label}</Text>
                <Text style={styles.note}>{NOTE[a.value]}</Text>
              </View>
            </Pressable>
          );
        })}
      </View>
    </Section>
  );
}

/** A sample of the scheme: its paper with a line of its ink (System: the two halves side by side). */
function Sample({ kind }: { kind: Appearance }) {
  const styles = useStyles();
  const halves = kind === 'system' ? (['light', 'dark'] as const) : [kind];
  return (
    <View style={styles.sample} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      {halves.map((s) => (
        <View key={s} style={StyleSheet.flatten([styles.half, { backgroundColor: Colors[s].background }])}>
          <View style={{ height: 4, backgroundColor: Colors[s].rule }} />
          <Text style={StyleSheet.flatten([styles.sampleText, { color: Colors[s].text }])}>Aa</Text>
        </View>
      ))}
    </View>
  );
}

const useStyles = themed((c) => ({
  row: { flexDirection: 'row', gap: 30, borderTopWidth: 1, borderBottomWidth: 1, borderColor: c.rule, paddingVertical: 14 },
  rowPhone: { flexDirection: 'column', borderTopWidth: 1, borderColor: c.rule },
  choice: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingBottom: 8, borderBottomWidth: 5,
    borderColor: 'transparent' },
  choicePhone: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingTop: 10, paddingBottom: 9, borderBottomWidth: 1,
    borderColor: c.rule },
  choiceOn: { borderBottomWidth: 5, borderColor: c.mark },
  words: { flexShrink: 1 },
  name: { fontFamily: Fonts.display, fontSize: 30, lineHeight: 32, textTransform: 'uppercase', color: c.textMuted },
  namePhone: { fontFamily: Fonts.display, fontSize: 26, lineHeight: 28, textTransform: 'uppercase', color: c.textMuted },
  nameOn: { color: c.text },
  note: { ...Type.label, fontFamily: Fonts.label, fontSize: 11, letterSpacing: 1, color: c.textSecondary, marginTop: 2 },
  sample: { flexDirection: 'row', width: 46, height: 34, borderWidth: 1, borderColor: c.rule },
  half: { flex: 1, overflow: 'hidden' },
  sampleText: { fontFamily: Fonts.display, fontSize: 15, lineHeight: 18, paddingLeft: 3, paddingTop: 3 },
}));
