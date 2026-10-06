// The race-track picture behind the pages (constants/Theme.ts BACKDROP), dimmed so text keeps its full contrast. It
// stays put while the pages scroll over it; cards, charts and track maps sit on their own solid surface above it.
import { Image, StyleSheet, View } from 'react-native';

import { useColorScheme } from '@/components/useColorScheme';
import Colors from '@/constants/Colors';
import { BACKDROP } from '@/constants/Theme';

export function Backdrop() {
  const scheme = useColorScheme();
  const source = BACKDROP[scheme];
  if (!source) return null;
  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <Image source={source} resizeMode="cover" accessibilityIgnoresInvertColors
        style={StyleSheet.flatten([styles.image, { opacity: Colors[scheme].backdropOpacity }])} />
    </View>
  );
}

const styles = StyleSheet.create({
  image: { width: '100%', height: '100%' },
});
