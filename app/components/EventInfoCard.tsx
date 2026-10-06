// The event page's "Event info" card: what the event was run with (tyre, car, team, drivers 1 to 4), each from the
// event itself or from its season, and a checklist of what is still missing. Tap an item (or Edit) for the form.
import { Link } from 'expo-router';
import { useEffect, useState } from 'react';
import { Pressable, StyleSheet } from 'react-native';

import { EventInfoForm, MissingList, useLists } from '@/components/EventInfoForm';
import { Text, View, useThemeColor } from '@/components/Themed';
import { EventInfo, MissingKey, seasonsApi, sourceWords } from '@/lib/seasons';

export function EventInfoCard({ eventId, version, onInfo }: {
  eventId: number;
  version?: unknown; // the event changed (runs uploaded or tagged): ask again
  onInfo?: (info: EventInfo | null) => void;
}) {
  const [info, setInfo] = useState<EventInfo | null>(null);
  const [editing, setEditing] = useState<{ focus: MissingKey | null } | null>(null);
  const { lists, reload } = useLists();
  const tint = useThemeColor({}, 'tint');

  useEffect(() => {
    seasonsApi.info(eventId).then(
      (i) => {
        setInfo(i);
        onInfo?.(i);
      },
      () => onInfo?.(null), // an older server: no card
    );
  }, [eventId, version]); // eslint-disable-line react-hooks/exhaustive-deps -- onInfo is a callback of the page

  if (!info) return null;
  const r = info.resolved;
  const line = (label: string, value: string | null, from: Parameters<typeof sourceWords>[0]) => (
    <View style={styles.line}>
      <Text style={styles.label}>{label}</Text>
      <Text style={StyleSheet.flatten([styles.value, !value && styles.unset])} numberOfLines={2}>
        {value ?? 'not set'}
        {value && sourceWords(from) ? <Text style={styles.from}>  {sourceWords(from)}</Text> : null}
      </Text>
    </View>
  );
  const car = r.car ? [r.car.number ? `#${r.car.number}` : r.car.name, r.vehicle_model?.name ?? r.car.model]
    .filter(Boolean).join(' · ') : r.vehicle_model?.name ?? null;
  return (
    <View style={StyleSheet.flatten([styles.card, info.missing.length > 0 && styles.todo])}>
      <View style={styles.head}>
        <Text style={styles.title}>Event info</Text>
        {info.season && (
          // Link asChild hands its child's style to a web anchor, which can't take a style array: one object
          <Link href="/seasons" asChild>
            <Pressable hitSlop={6} accessibilityRole="link" style={styles.seasonLink}>
              <Text style={StyleSheet.flatten([styles.season, { color: tint }])} numberOfLines={1}>
                {info.season.name}{info.season.round ? ` · round ${info.season.round.order}` : ''}
              </Text>
            </Pressable>
          </Link>
        )}
        {!editing && (
          <Pressable onPress={() => setEditing({ focus: null })} accessibilityRole="button" hitSlop={8}
            accessibilityLabel="Edit the event info" style={styles.edit}>
            <Text style={{ color: tint, fontWeight: '600' }}>Edit</Text>
          </Pressable>
        )}
      </View>
      {editing && lists ? (
        <EventInfoForm info={info} lists={lists} onListsChanged={reload} focus={editing.focus}
          onCancel={() => setEditing(null)}
          onSaved={(saved) => {
            setInfo(saved);
            onInfo?.(saved);
            setEditing(null);
          }} />
      ) : (
        <>
          <View style={styles.lines}>
            {line('Tyre', r.tyre_kind?.label ?? null, info.from.tyre_kind)}
            {line('Car', car, info.from.car ?? info.from.vehicle_model)}
            {line('Team', r.team?.name ?? null, info.from.team)}
            {line('Drivers', r.drivers.length ? r.drivers.map((d, i) => `${i + 1} ${d.name}`).join('  ') : null,
              info.from.drivers)}
          </View>
          <MissingList missing={info.missing} onPick={(k) => setEditing({ focus: k })} />
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderWidth: 1, borderColor: '#8884', borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, gap: 8 },
  todo: { borderColor: '#b26b0088' },
  head: { flexDirection: 'row', alignItems: 'center', gap: 10, flexWrap: 'wrap', backgroundColor: 'transparent' },
  title: { fontSize: 16, fontWeight: '700' },
  seasonLink: { flexShrink: 1 },
  season: { fontSize: 13, fontWeight: '600' },
  edit: { marginLeft: 'auto' },
  lines: { gap: 4, backgroundColor: 'transparent' },
  line: { flexDirection: 'row', gap: 10, backgroundColor: 'transparent' },
  label: { width: 64, fontSize: 12, fontWeight: '700', opacity: 0.6, textTransform: 'uppercase', letterSpacing: 0.4,
    paddingTop: 2 },
  value: { flex: 1, fontSize: 14 },
  unset: { opacity: 0.45 },
  from: { fontSize: 12, opacity: 0.55, fontStyle: 'italic' },
});
