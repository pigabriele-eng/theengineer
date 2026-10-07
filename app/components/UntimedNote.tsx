// On a session whose log was kept although it has no laps: the car did laps, but the lap beacon is missing, so
// they couldn't be timed. Says so plainly, and what times them.
import { StyleSheet } from 'react-native';

import { Text, View } from '@/components/Themed';
import type { SessionDetail } from '@/lib/api';
import { untimedLogs } from '@/lib/emptyRuns';
import { Fonts, inkOn, themed, Type } from '@/constants/Theme';

export function UntimedNote({ session }: { session: SessionDetail }) {
  const styles = useStyles();
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

// A ruled flag in the programme: the warning colour as a square block and a thick bar down the left, the words in ink.
const useStyles = themed((c) => ({
  box: { gap: 12, borderLeftWidth: 6, borderColor: c.status.warning, paddingLeft: 12, paddingVertical: 4 },
  item: { gap: 6, backgroundColor: 'transparent' },
  head: { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: 'transparent' },
  badge: { width: 20, height: 20, backgroundColor: c.status.warning, alignItems: 'center', justifyContent: 'center' },
  glyph: { fontFamily: Fonts.display, color: inkOn(c.status.warning), fontSize: 13, lineHeight: 16 },
  title: { ...Type.label, fontSize: 14, flexShrink: 1, color: c.text },
  body: { fontFamily: Fonts.body, fontSize: 16, lineHeight: 22, color: c.text },
  file: { fontFamily: Fonts.label, fontSize: 12, color: c.textMuted },
}));
