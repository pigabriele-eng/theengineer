// Where to move the ticked runs: another event, a new one, or out of every event. One line per event, ruled like the
// Sessions page's list.
import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet } from 'react-native';

import { ErrorLine } from '@/components/Controls';
import { EventForm } from '@/components/EventForm';
import { Label, TextLink } from '@/components/Programme';
import { Text, View } from '@/components/Themed';
import { dateRange, eventsApi, FolderSummary, NO_EVENT } from '@/lib/events';
import { Fonts, themed, Type } from '@/constants/Theme';

export function MoveSessions({ fromKey, count, onMove, onCancel }: {
  fromKey: string; // the folder they are in now
  count: number;
  onMove: (toKey: string, toName: string) => Promise<void>;
  onCancel: () => void;
}) {
  const styles = useStyles();
  const [folders, setFolders] = useState<FolderSummary[] | null>(null);
  const [making, setMaking] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    eventsApi.folders().then(setFolders, (e) => setError((e as Error).message));
  }, []);

  const go = async (key: string, name: string) => {
    setBusy(key);
    setError(null);
    try {
      await onMove(key, name);
    } catch (e) {
      setError((e as Error).message);
      setBusy(null);
    }
  };
  const targets = (folders ?? []).filter((f) => f.id != null && f.key !== fromKey);
  const what = `${count} ${count === 1 ? 'run' : 'runs'}`;

  const line = (key: string, name: string, sub: string, action: string) => (
    <Pressable key={key} onPress={() => go(key, name)} disabled={busy != null} style={styles.row}
      accessibilityRole="button" accessibilityLabel={`${action}: ${name}`}>
      <View style={styles.grow}>
        <Text style={styles.name} numberOfLines={1}>{name}</Text>
        {sub ? <Text style={styles.sub} numberOfLines={1}>{sub}</Text> : null}
      </View>
      {busy === key ? <ActivityIndicator /> : <Text style={styles.action}>{action} →</Text>}
    </Pressable>
  );

  return (
    <View style={styles.box}>
      <Label>Move {what} to</Label>
      {!folders && !error && <ActivityIndicator style={styles.loading} />}
      <View style={styles.list}>
        {targets.map((f) => line(f.key, f.name,
          [f.track, dateRange(f.start, f.end), `${f.sessions} ${f.sessions === 1 ? 'run' : 'runs'}`].filter(Boolean).join(' · '),
          'Move here'))}
        {fromKey !== NO_EVENT && line(NO_EVENT, 'Out of this event', 'They go to the runs not in an event', 'Move')}
      </View>
      {making ? (
        <View style={styles.making}>
          <Label>A new event</Label>
          <EventForm submitLabel={`Make it and move ${what}`} onCancel={() => setMaking(false)}
            onSubmit={async (v) => {
              const ev = await eventsApi.create(v);
              await onMove(ev.key, ev.name);
            }} />
        </View>
      ) : null}
      {error && <ErrorLine>{error}</ErrorLine>}
      <View style={styles.links}>
        {!making && <TextLink onPress={() => setMaking(true)} label="+ A new event" />}
        <TextLink onPress={onCancel} label="Cancel" />
      </View>
    </View>
  );
}

const useStyles = themed((c) => ({
  box: { gap: 10 },
  loading: { alignSelf: 'flex-start' },
  list: { borderTopWidth: 1, borderColor: c.rule },
  row: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingTop: 11, paddingBottom: 10, borderBottomWidth: 1,
    borderColor: c.separator },
  grow: { flex: 1, minWidth: 0 },
  name: { fontFamily: Fonts.display, fontSize: 22, lineHeight: 26, textTransform: 'uppercase', color: c.text },
  sub: { fontFamily: Fonts.body, fontSize: 15, lineHeight: 20, color: c.textSecondary, marginTop: 2 },
  action: { ...Type.link, fontSize: 12, letterSpacing: 1.2, color: c.text },
  making: { gap: 10, marginTop: 6 },
  links: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: 22, rowGap: 10, marginTop: 4 },
}));
