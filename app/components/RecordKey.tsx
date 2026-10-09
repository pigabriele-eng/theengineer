import { router, usePathname } from 'expo-router';
import { Platform, Pressable, StyleSheet, ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Text, View } from '@/components/Themed';
import { noPrint } from '@/lib/print';
import { Type, themed } from '@/constants/Theme';

/** Record a debrief from any page in one tap (Gabriele, 2026-10-09: "Accessing the record debrief is too many
 * taps"): the record key, an ink square with the red one in it, sits in the bottom corner of every page. It opens the
 * Debrief page recording at once (?go=1), for the run that ended just before (found by time). Not on the Debrief page
 * itself, nor on paper. */
export default function RecordKey() {
  const styles = useStyles();
  const insets = useSafeAreaInsets();
  const path = usePathname();
  if (path.startsWith('/debrief') || path.startsWith('/sign-in')) return null;
  return (
    <View pointerEvents="box-none" {...noPrint}
      style={StyleSheet.flatten([styles.place, { bottom: insets.bottom + 16, right: insets.right + 16 }])}>
      <Pressable accessibilityRole="button" accessibilityLabel="Record a debrief" accessibilityHint="Starts recording at once"
        onPress={() => router.push({ pathname: '/debrief', params: { go: '1' } })} style={styles.key}>
        <View style={styles.dot} />
      </Pressable>
      <Text style={styles.caption}>Debrief</Text>
    </View>
  );
}

const useStyles = themed((c) => ({
  // fixed to the window on the web (it stays put as the page scrolls), over the screen in the app
  place: { position: (Platform.OS === 'web' ? 'fixed' : 'absolute') as ViewStyle['position'], alignItems: 'center',
    gap: 4, zIndex: 20 },
  key: { width: 64, height: 64, borderWidth: 3, borderColor: c.rule, backgroundColor: c.background,
    alignItems: 'center', justifyContent: 'center' },
  dot: { width: 34, height: 34, backgroundColor: c.mark },
  caption: { ...Type.label, fontSize: 16, letterSpacing: 1.2, color: c.text, backgroundColor: c.background,
    paddingHorizontal: 4 },
}));
