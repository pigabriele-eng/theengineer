import { Href, Link, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { Pressable, StyleSheet } from 'react-native';

import { Text, View } from '@/components/Themed';
import { fetchPrepAvailability, pastCaption, PrepAvailability } from '@/lib/prep';
import { face, themed, Type } from '@/constants/Theme';

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

/** The one-tap prep report for an event whose venue has past data, with the years it learns from. For an upcoming
 * event it is the main action: a square ink block with paper text. For one already running or done, a text link in
 * capitals over a heavy underline. `compact` is the smaller size for a row of small links. */
export function PrepButton({ eventId, info, prominent, compact }: {
  eventId: number;
  info: PrepAvailability[string] | undefined;
  prominent?: boolean;
  compact?: boolean;
}) {
  const styles = useStyles();
  if (!info) return null;
  const filled = prominent ?? info.upcoming;
  const href: Href = { pathname: '/prep', params: { event: String(eventId) } };
  const caption = pastCaption(info);
  return (
    // Link asChild hands its child's style to a web anchor, which can't take a style array: one object
    <Link href={href} asChild>
      <Pressable accessibilityRole="link" accessibilityLabel={`Prep report from ${caption}`} hitSlop={6}
        style={StyleSheet.flatten([filled ? styles.block : styles.link, filled && compact && styles.blockCompact])}>
        <View style={styles.inner}>
          <Text style={StyleSheet.flatten([compact ? styles.labelSmall : styles.label, filled && styles.onInk])}>
            Prep report →
          </Text>
          <Text numberOfLines={1} style={StyleSheet.flatten([styles.caption, filled && styles.captionOnInk])}>
            {caption}
          </Text>
        </View>
      </Pressable>
    </Link>
  );
}

const useStyles = themed((c) => ({
  // the main action: an ink block, square
  block: { alignSelf: 'flex-start', backgroundColor: c.rule, paddingHorizontal: 14, paddingTop: 9, paddingBottom: 8 },
  blockCompact: { paddingHorizontal: 10, paddingTop: 5, paddingBottom: 4 },
  // otherwise a text link: capitals over a heavy underline
  link: { alignSelf: 'flex-start', borderBottomWidth: 2, borderColor: c.rule, paddingBottom: 1 },
  inner: { flexDirection: 'row', alignItems: 'baseline', columnGap: 10, rowGap: 2, flexWrap: 'wrap' },
  label: { ...Type.link, color: c.text },
  labelSmall: { ...Type.link, fontSize: 12, letterSpacing: 1.2, color: c.text },
  onInk: { color: c.background },
  caption: { fontFamily: face('label', 500), fontSize: 12, letterSpacing: 0.4, color: c.textSecondary },
  // the faint rule colour reads as a quiet grey on the ink block, in either scheme
  captionOnInk: { color: c.border },
}));
