// The driver on a run's name line, first thing the eye meets: the driver's code in bold ink (PIA), a guess from the
// driving style in the muted ink (PIA?), or "Driver?" when nobody knows. With `onPress`, a guess or "Driver?" opens
// the run's driver list; inside a link (`onPress` left out) it is only words.
import { Pressable, StyleSheet } from 'react-native';

import { Text } from '@/components/Themed';
import { DriverTag as Tag } from '@/lib/driverTag';
import { Fonts, tapRoom, themed, Type } from '@/constants/Theme';

export function DriverTag({ tag, run, onPress, size = 17 }: { tag: Tag; run: string; onPress?: () => void;
  size?: number }) {
  const styles = useStyles();
  const label = tag.kind === 'known' ? `Driver ${tag.name}`
    : tag.kind === 'guess' ? `Probably ${tag.name}, going by the driving style` : 'Driver not set';
  const text = (
    <Text style={StyleSheet.flatten([tag.kind === 'known' ? styles.known : styles.unsure, { fontSize: size }])}
      accessibilityLabel={onPress ? undefined : label} numberOfLines={1}>
      {tag.text}
    </Text>
  );
  if (!onPress || tag.kind === 'known') return text;
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={`${label}: set the driver of ${run}`}
      style={styles.press}>
      {text}
    </Pressable>
  );
}

const useStyles = themed((c) => ({
  known: { fontFamily: Type.label.fontFamily, letterSpacing: 0.6, color: c.text },
  unsure: { fontFamily: Fonts.label, letterSpacing: 0.6, color: c.textMuted, textDecorationLine: 'underline',
    textDecorationStyle: 'dotted' },
  // the words are about 22 px tall: room to a 44 px target above and below without moving the line
  press: { ...tapRoom(11) },
}));
