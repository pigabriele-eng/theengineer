// On a session whose log was kept although it has no laps: the car did laps, but the lap beacon is missing, so
// they couldn't be timed. Says so plainly, and what times them.
import { StyleSheet } from 'react-native';

import { Text, View } from '@/components/Themed';
import type { SessionDetail } from '@/lib/api';
import { untimedLogs } from '@/lib/emptyRuns';

const WARNING = '#fab219';

export function UntimedNote({ session }: { session: SessionDetail }) {
  const logs = untimedLogs(session);
  if (!logs.length) return null;
  return (
    <View style={styles.box}>
      {logs.map((u) => (
        <View key={u.file} style={styles.item}>
          <View style={styles.head}>
            <View style={styles.badge}>
              <Text style={styles.glyph}>!</Text>
            </View>
            <Text style={styles.title}>{u.title}</Text>
          </View>
          <Text style={styles.body}>{u.reason}</Text>
          {u.fix && <Text style={styles.body}>{u.fix}</Text>}
          {logs.length > 1 && <Text style={styles.file}>{u.file}</Text>}
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  box: { gap: 12, borderLeftWidth: 4, borderColor: WARNING, paddingLeft: 12, paddingVertical: 4 },
  item: { gap: 6, backgroundColor: 'transparent' },
  head: { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: 'transparent' },
  badge: {
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: WARNING,
    alignItems: 'center',
    justifyContent: 'center',
  },
  glyph: { color: '#1a1a19', fontWeight: '700', fontSize: 13, lineHeight: 16 },
  title: { fontWeight: '700', fontSize: 16, flexShrink: 1 },
  body: { lineHeight: 20 },
  file: { fontSize: 12, opacity: 0.6 },
});
