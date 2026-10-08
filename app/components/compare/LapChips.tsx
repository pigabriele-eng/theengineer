// The laps on a graph as chips (as the During tab's "On the traces", components/weekend/SessionCompare.tsx): each lap
// on it with its colour key and an × that takes it off, and the laps that can go on it with a +. Each chip is a full
// tap target and says to a screen reader what it does to which lap.
import { Pressable } from 'react-native';

import { LineKey } from '@/components/CompareViews';
import { Label } from '@/components/Programme';
import { Text, View } from '@/components/Themed';
import { face, TAP, themed } from '@/constants/Theme';

export type LapChip = {
  key: string;
  label: string; // "PIA best · 04_R1 L5 · 1:44.480"
  spoken: string; // "Piana's best lap, lap 5 of 04_R1, 1:44.480"
  color: string;
  dash?: string;
  on: boolean;
};

export function LapChips({ chips, onFlip, label = 'On the traces', more = 'Add to the traces' }: {
  chips: LapChip[];
  onFlip: (key: string) => void;
  label?: string;
  more?: string;
}) {
  const styles = useStyles();
  const on = chips.filter((c) => c.on);
  const off = chips.filter((c) => !c.on);
  const chip = (c: LapChip) => (
    <Pressable key={c.key} onPress={() => onFlip(c.key)} accessibilityRole="button"
      accessibilityLabel={c.on ? `Take ${c.spoken} off the traces` : `Put ${c.spoken} on the traces`}
      style={styles.chip}>
      {c.on ? <LineKey color={c.color} dash={c.dash} /> : null}
      <Text style={styles.chipText}>{c.label}</Text>
      <Text style={styles.chipX} accessibilityElementsHidden importantForAccessibility="no">{c.on ? '×' : '+'}</Text>
    </Pressable>
  );
  return (
    <View style={styles.wrap}>
      {on.length > 0 && (
        <View>
          <Label style={styles.label}>{label}</Label>
          <View style={styles.chips}>{on.map(chip)}</View>
        </View>
      )}
      {off.length > 0 && (
        <View>
          <Label style={styles.label} muted>{more}</Label>
          <View style={styles.chips}>{off.map(chip)}</View>
        </View>
      )}
    </View>
  );
}

const useStyles = themed((c) => ({
  wrap: { gap: 14, maxWidth: 820 },
  label: { marginBottom: 8 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: TAP, paddingHorizontal: 12, borderWidth: 1,
    borderColor: c.rule, flexShrink: 1 },
  chipText: { fontFamily: face('label', 600), fontSize: 16, color: c.text, flexShrink: 1 },
  chipX: { fontFamily: face('label', 700), fontSize: 20, lineHeight: 22, color: c.text },
}));
