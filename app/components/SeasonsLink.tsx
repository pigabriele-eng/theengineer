// The Sessions tab's way to the Seasons screen, under the Past / Current / Upcoming filter: this year's seasons by
// name, or an offer to make one.
import { Link, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { Pressable, StyleSheet } from 'react-native';

import { Text, useThemeColor } from '@/components/Themed';
import { Season, seasonsApi } from '@/lib/seasons';

export function SeasonsLink() {
  const [seasons, setSeasons] = useState<Season[] | null>(null);
  const tint = useThemeColor({}, 'tint');
  useFocusEffect(useCallback(() => {
    seasonsApi.list().then(setSeasons, () => setSeasons(null)); // an older server: no link
  }, []));
  if (!seasons) return null;
  const year = new Date().getFullYear();
  const now = seasons.filter((s) => s.year >= year);
  const words = now.length
    ? `Seasons: ${now.map((s) => s.name).join(', ')}`
    : 'Make this year’s season: its rounds come in as planned events, with their dates';
  return (
    // Link asChild hands its child's style to a web anchor, which can't take a style array: one object
    <Link href="/seasons" asChild>
      <Pressable hitSlop={6} accessibilityRole="link" style={styles.row}>
        <Text style={StyleSheet.flatten([styles.text, { color: tint }])} numberOfLines={2}>{words} ›</Text>
      </Pressable>
    </Link>
  );
}

const styles = StyleSheet.create({
  row: { alignSelf: 'flex-start' },
  text: { fontSize: 13, fontWeight: '600' },
});
