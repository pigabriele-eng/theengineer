// After an upload made an event (a zip becomes an event named after the zip): name it from what its logs say, or put
// its sessions into the event that already holds the same race weekend. Either can be skipped.
import { Link } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet } from 'react-native';

import { RenameEvent } from '@/components/RenameEvent';
import { Text, View, useThemeColor } from '@/components/Themed';
import { formatLap } from '@/lib/api';
import { EventMatch, namingApi, NewEvent } from '@/lib/eventNaming';
import { dateRange } from '@/lib/events';

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

export type Settled = { text: string; id: number; name: string }; // what was done, and the event to open

export function NameNewEvent({ ev, onSettled }: { ev: NewEvent; onSettled: (s: Settled) => void }) {
  const [joining, setJoining] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const tint = useThemeColor({}, 'tint');
  const background = useThemeColor({}, 'background');
  const found = [dateRange(ev.start, ev.end), ev.venue ?? ev.track, plural(ev.sessions, 'session'),
    ev.best_lap_s != null ? `best ${formatLap(ev.best_lap_s)}` : null].filter(Boolean).join(' · ');
  const why = (m: EventMatch) => (m.why === 'event' && ev.log_event ? `same event, ${ev.log_event}`
    : m.why === 'planned' ? 'planned at this track, no data yet' : 'same track, same weekend');

  const join = async (m: EventMatch) => {
    setJoining(m.id);
    setError(null);
    try {
      const r = await namingApi.merge(ev.id, m.id);
      onSettled({ text: `Put ${plural(r.moved.length, 'session')} from ${ev.zip ?? ev.name} into ${r.into.name}.`,
        id: m.id, name: r.into.name });
    } catch (e) {
      setError((e as Error).message);
      setJoining(null);
    }
  };

  return (
    <View style={styles.card}>
      <Text style={styles.label}>New event{ev.zip ? ` from ${ev.zip}.zip` : ''}</Text>
      {ev.matches.length > 0 && (
        <View style={styles.block}>
          <Text style={styles.title}>Same race weekend as an event you have?</Text>
          {ev.matches.map((m) => (
            <Pressable key={m.id} onPress={() => join(m)} disabled={joining != null} accessibilityRole="button"
              style={StyleSheet.flatten([styles.join, { borderColor: tint, backgroundColor: tint }])}>
              {joining === m.id ? <ActivityIndicator color={background} /> : (
                <>
                  <Text style={StyleSheet.flatten([styles.joinText, { color: background }])}>
                    Put its {plural(ev.sessions, 'session')} into {m.name}
                  </Text>
                  <Text style={StyleSheet.flatten([styles.joinSub, { color: background }])}>
                    {[dateRange(m.start, m.end), plural(m.sessions, 'session'), why(m)].filter(Boolean).join(' · ')}
                  </Text>
                </>
              )}
            </Pressable>
          ))}
        </View>
      )}
      <Text style={ev.matches.length ? styles.or : styles.title}>
        {ev.matches.length ? 'Or keep it as an event of its own, named:' : 'Name this event'}
      </Text>
      <RenameEvent id={ev.id} initial={ev.suggested_name} autoFocus={false} cancelLabel="Skip"
        onSaved={(f) => onSettled({ text: `Named the event ${f.name}.`, id: ev.id, name: f.name })}
        onCancel={() => onSettled({ text: `Kept the name ${ev.name}.`, id: ev.id, name: ev.name })} />
      <Text style={styles.found}>Found in the logs: {found}</Text>
      {error && <Text style={styles.error}>{error}</Text>}
    </View>
  );
}

/** What was done with a new event, and a link to the event it ended up in. */
export function SettledLine({ s }: { s: Settled }) {
  const tint = useThemeColor({}, 'tint');
  return (
    <View style={styles.done}>
      <Text style={styles.doneText}>{s.text}</Text>
      {/* Link asChild hands its child's style to a web anchor, which can't take a style array: one object */}
      <Link href={{ pathname: '/event/[id]', params: { id: s.id } }} asChild>
        <Pressable hitSlop={6}>
          <Text style={StyleSheet.flatten([styles.open, { color: tint }])}>Open {s.name} ›</Text>
        </Pressable>
      </Link>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderWidth: 1.5, borderColor: '#8886', borderRadius: 10, padding: 12, gap: 8 },
  label: { fontSize: 12, opacity: 0.6, textTransform: 'uppercase', letterSpacing: 0.5 },
  block: { gap: 8, backgroundColor: 'transparent' },
  title: { fontSize: 17, fontWeight: '700' },
  or: { fontSize: 14, opacity: 0.75, marginTop: 4 },
  join: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 9, gap: 2, minHeight: 44,
    justifyContent: 'center' },
  joinText: { fontWeight: '700', fontSize: 15 },
  joinSub: { fontSize: 12, opacity: 0.85 },
  found: { fontSize: 13, opacity: 0.65 },
  error: { color: '#c8372d' },
  done: { gap: 2 },
  doneText: { fontWeight: '600' },
  open: { fontWeight: '600' },
});
