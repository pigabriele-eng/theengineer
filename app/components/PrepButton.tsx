import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { Pressable, StyleSheet } from 'react-native';

import { Text, View, useThemeColor } from '@/components/Themed';
import { fetchPrepAvailability, pastCaption, PrepAvailability } from '@/lib/prep';

/** Which events have past data at their venue (for the Prep report button), asked for whenever the screen shows. A
 * failure leaves the buttons out: the rest of the screen stands. */
export function usePrepAvailability(): PrepAvailability {
  const [info, setInfo] = useState<PrepAvailability>({});
  useFocusEffect(
    useCallback(() => {
      let live = true;
      fetchPrepAvailability().then((a) => live && setInfo(a), () => undefined);
      return () => {
        live = false;
      };
    }, []),
  );
  return info;
}

/** The one-tap prep report for an event whose venue has past data: filled (prominent) for an upcoming event, outlined
 * for one already running or done. */
export function PrepButton({ eventId, info, prominent, compact }: {
  eventId: number;
  info: PrepAvailability[string] | undefined;
  prominent?: boolean;
  compact?: boolean;
}) {
  const router = useRouter();
  const tint = useThemeColor({}, 'tint');
  const background = useThemeColor({}, 'background');
  if (!info) return null;
  const filled = prominent ?? info.upcoming;
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={`Prep report from ${pastCaption(info)}`}
      onPress={() => router.push({ pathname: '/prep', params: { event: String(eventId) } })}
      style={StyleSheet.flatten([styles.button, compact && styles.compact, { borderColor: tint },
        filled && { backgroundColor: tint }])}>
      <View style={styles.inner}>
        <Text style={StyleSheet.flatten([styles.label, { color: filled ? background : tint }])}>Prep report</Text>
        <Text numberOfLines={1}
          style={StyleSheet.flatten([styles.caption, { color: filled ? background : tint }])}>
          {pastCaption(info)}
        </Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 7 },
  compact: { alignSelf: 'flex-start', paddingVertical: 5 },
  inner: { flexDirection: 'row', alignItems: 'baseline', gap: 8, backgroundColor: 'transparent', flexWrap: 'wrap' },
  label: { fontWeight: '700', fontSize: 14 },
  caption: { fontSize: 12, opacity: 0.85 },
});
