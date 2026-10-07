// After an upload made an event (a zip or a dropped folder becomes an event named after it): name it from what its
// logs say, or put its runs into the event that already holds the same race weekend. Either can be skipped.
import { useState } from 'react';
import { ActivityIndicator, Pressable } from 'react-native';

import { ErrorLine, Note, Said } from '@/components/Controls';
import { Label, TextLink } from '@/components/Programme';
import { RenameEvent } from '@/components/RenameEvent';
import { Text, View } from '@/components/Themed';
import { formatLap } from '@/lib/api';
import { EventMatch, namingApi, NewEvent } from '@/lib/eventNaming';
import { dateRange } from '@/lib/events';
import { Fonts, themed, Type } from '@/constants/Theme';

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

export type Settled = { text: string; id: number; name: string }; // what was done, and the event to open

export function NameNewEvent({ ev, onSettled }: { ev: NewEvent; onSettled: (s: Settled) => void }) {
  const styles = useStyles();
  const [joining, setJoining] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const found = [dateRange(ev.start, ev.end), ev.venue ?? ev.track, plural(ev.sessions, 'run'),
    ev.best_lap_s != null ? `best ${formatLap(ev.best_lap_s)}` : null].filter(Boolean).join(' · ');
  const why = (m: EventMatch) => (m.why === 'event' && ev.log_event ? `same event, ${ev.log_event}`
    : m.why === 'planned' ? 'planned at this track, no data yet' : 'same track, same weekend');

  const join = async (m: EventMatch) => {
    setJoining(m.id);
    setError(null);
    try {
      const r = await namingApi.merge(ev.id, m.id);
      onSettled({ text: `Put ${plural(r.moved.length, 'run')} from ${ev.zip ?? ev.name} into ${r.into.name}.`,
        id: m.id, name: r.into.name });
    } catch (e) {
      setError((e as Error).message);
      setJoining(null);
    }
  };

  return (
    <View style={styles.band}>
      <Label>New event{ev.zip ? ` from ${ev.zip}` : ''}</Label>
      {ev.matches.length > 0 && (
        <View style={styles.block}>
          <Text style={styles.title}>Same race weekend as an event you have?</Text>
          <View style={styles.matches}>
            {ev.matches.map((m) => (
              <Pressable key={m.id} onPress={() => join(m)} disabled={joining != null} accessibilityRole="button"
                accessibilityLabel={`Put its ${plural(ev.sessions, 'run')} into ${m.name}`} style={styles.match}>
                <View style={styles.matchText}>
                  <Text style={styles.matchName}>{m.name}</Text>
                  <Text style={styles.matchSub}>
                    {[dateRange(m.start, m.end), plural(m.sessions, 'run'), why(m)].filter(Boolean).join(' · ')}
                  </Text>
                </View>
                {joining === m.id ? <ActivityIndicator /> : (
                  <Text style={styles.matchAction}>Put its {plural(ev.sessions, 'run')} in →</Text>
                )}
              </Pressable>
            ))}
          </View>
        </View>
      )}
      <Text style={ev.matches.length ? styles.or : styles.title}>
        {ev.matches.length ? 'Or keep it as an event of its own, named:' : 'Name this event'}
      </Text>
      <RenameEvent id={ev.id} initial={ev.suggested_name} autoFocus={false} cancelLabel="Skip"
        onSaved={(f) => onSettled({ text: `Named the event ${f.name}.`, id: ev.id, name: f.name })}
        onCancel={() => onSettled({ text: `Kept the name ${ev.name}.`, id: ev.id, name: ev.name })} />
      <Note>Found in the logs: {found}</Note>
      {error && <ErrorLine>{error}</ErrorLine>}
    </View>
  );
}

/** What was done with a new event, and a link to the event it ended up in. */
export function SettledLine({ s }: { s: Settled }) {
  const styles = useStyles();
  return (
    <View style={styles.done}>
      <Said text={s.text} />
      <TextLink href={{ pathname: '/event/[id]', params: { id: s.id } }} label={`Open ${s.name}`} arrow small />
    </View>
  );
}

const useStyles = themed((c) => ({
  band: { gap: 12, borderTopWidth: 3, borderColor: c.rule, paddingTop: 10 },
  block: { gap: 10 },
  title: { fontFamily: Fonts.display, fontSize: 28, lineHeight: 31, textTransform: 'uppercase', color: c.text },
  matches: { borderTopWidth: 1, borderColor: c.rule },
  match: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: 14, rowGap: 6, paddingTop: 11,
    paddingBottom: 10, borderBottomWidth: 1, borderColor: c.separator },
  matchText: { flex: 1, minWidth: 200 },
  matchName: { fontFamily: Fonts.display, fontSize: 22, lineHeight: 26, textTransform: 'uppercase', color: c.text },
  matchSub: { fontFamily: Fonts.body, fontSize: 15, lineHeight: 20, color: c.textSecondary, marginTop: 2 },
  matchAction: { ...Type.link, fontSize: 13, letterSpacing: 1.2, color: c.text, borderBottomWidth: 2, borderColor: c.mark,
    paddingBottom: 1 },
  or: { fontFamily: Type.dek.fontFamily, fontSize: 17, lineHeight: 24, color: c.textSecondary, marginTop: 4 },
  done: { gap: 8 },
}));
