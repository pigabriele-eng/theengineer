// The event list's Past / Current / Upcoming filter with the racing calendar's state under it, removing a planned
// event (made by hand or from the calendar, no data yet) and the form that plans one.
import { Link } from 'expo-router';
import { useState } from 'react';
import { Pressable, StyleSheet, TextInput } from 'react-native';

import { EventForm } from '@/components/EventForm';
import { Text, View, useThemeColor } from '@/components/Themed';
import { CalendarState, calendarApi, clockLabel, Filter, FILTERS, Plan } from '@/lib/calendar';
import { Folder, FolderSummary } from '@/lib/events';

export function FilterBar({ filter, counts, onPick, calendar, onSynced }: {
  filter: Filter;
  counts: Record<Filter, number>;
  onPick: (f: Filter) => void;
  calendar: CalendarState | null; // null: not known (yet)
  onSynced: (c: CalendarState) => void;
}) {
  const tint = useThemeColor({}, 'tint');
  return (
    <View style={styles.bar}>
      <View style={styles.chips} accessibilityRole="tablist">
        {FILTERS.map(({ key, label }) => {
          const on = key === filter;
          return (
            <Pressable key={key} onPress={() => onPick(key)} accessibilityRole="tab"
              accessibilityState={{ selected: on }} accessibilityLabel={`${label}: ${counts[key]}`}
              style={StyleSheet.flatten([styles.chip, on && { borderColor: tint, borderWidth: 1.5 }])}>
              <Text style={StyleSheet.flatten([styles.chipText, on && { color: tint, fontWeight: '700' }])}>{label}</Text>
              <Text style={StyleSheet.flatten([styles.count, on && { color: tint, opacity: 1 }])}>{counts[key]}</Text>
            </Pressable>
          );
        })}
      </View>
      {calendar && <CalendarLine calendar={calendar} onSynced={onSynced} tint={tint} />}
    </View>
  );
}

function CalendarLine({ calendar, onSynced, tint }: {
  calendar: CalendarState;
  onSynced: (c: CalendarState) => void;
  tint: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const feed = calendar.feed;
  const link = StyleSheet.flatten([styles.calLink, { color: tint }]);
  if (!feed) {
    return (
      // Link asChild hands its child's style to a web anchor, which can't take a style array: one object
      <Link href="/tools/calendar" asChild>
        <Pressable hitSlop={6} accessibilityRole="link">
          <Text style={link}>Bring in your tests and race weekends from Google Calendar ›</Text>
        </Pressable>
      </Link>
    );
  }
  const sync = async () => {
    setBusy(true);
    setError(null);
    try {
      onSynced(await calendarApi.sync());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const status = busy || feed.syncing ? 'syncing…'
    : feed.error ? feed.error
      : feed.synced_at ? `synced ${clockLabel(feed.synced_at)}` : 'not synced yet';
  return (
    <View style={styles.calRow}>
      <Text style={StyleSheet.flatten([styles.calText, feed.error && !busy ? styles.warn : null])} numberOfLines={3}>
        Calendar{feed.name ? ` “${feed.name}”` : ''}: {error ?? status}
      </Text>
      <Pressable onPress={sync} disabled={busy} hitSlop={6} accessibilityRole="button">
        <Text style={link}>Sync now</Text>
      </Pressable>
      <Link href="/tools/calendar" asChild>
        <Pressable hitSlop={6} accessibilityRole="link">
          <Text style={link}>Settings</Text>
        </Pressable>
      </Link>
    </View>
  );
}

/** Remove a planned event (no data yet): the button and, once tapped, the question. In a wrapping row: the question
 * takes a line of its own. */
export function RemovePlanned({ f, plan, onRemoved }: { f: FolderSummary; plan?: Plan; onRemoved: () => void }) {
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const tint = useThemeColor({}, 'tint');
  const remove = async () => {
    try {
      await calendarApi.removePlanned(f.id!);
      setAsking(false);
      onRemoved();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <>
      <Pressable onPress={() => setAsking(!asking)} hitSlop={8} accessibilityRole="button"
        accessibilityLabel={`Remove ${f.name}`} style={styles.removeButton}>
        <Text style={StyleSheet.flatten([styles.removeText, { color: tint }])}>✕ Remove</Text>
      </Pressable>
      {asking && (
        <View style={styles.confirm}>
          <Text style={styles.confirmText}>
            Remove the planned event “{f.name}”?
            {plan?.from_calendar
              ? ' Later calendar syncs leave it out; switch it back on in the calendar settings.'
              : ''}
          </Text>
          <View style={styles.actions}>
            <Pressable onPress={remove} accessibilityRole="button" style={StyleSheet.flatten([styles.action, styles.danger])}>
              <Text style={styles.dangerText}>Remove it</Text>
            </Pressable>
            <Pressable onPress={() => setAsking(false)} accessibilityRole="button" style={styles.action}>
              <Text>Keep it</Text>
            </Pressable>
          </View>
          {error && <Text style={styles.error}>{error}</Text>}
        </View>
      )}
    </>
  );
}

/** The line under a planned event's name: its venue and where it was planned. */
export const plannedLine = (f: FolderSummary, plan?: Plan) =>
  [plan?.venue ?? f.track, plan?.from_calendar ? 'Planned in your calendar' : 'Planned', 'no data yet']
    .filter(Boolean).join(' · ');

/** A new event with its venue: a planned event that uploads from that venue on its days go into. */
export function PlanForm({ onCancel, onMade }: { onCancel: () => void; onMade: (f: Folder) => void }) {
  const [venue, setVenue] = useState('');
  const text = useThemeColor({}, 'text');
  return (
    <EventForm submitLabel="Make the event" onCancel={onCancel}
      datesHint={'Logs recorded at this venue on these days, or the day before, go into this event when you upload ' +
        'them. Leave the days empty to take them from the logs.'}
      extra={
        <>
          <Text style={styles.label}>Venue</Text>
          <TextInput value={venue} onChangeText={setVenue} placeholder="e.g. Hockenheimring" placeholderTextColor="#888"
            style={StyleSheet.flatten([styles.input, { color: text }])} maxLength={255} accessibilityLabel="Venue" />
        </>
      }
      onSubmit={async (v) => onMade(await calendarApi.plan({ ...v, venue: venue.trim() || null }))} />
  );
}

const styles = StyleSheet.create({
  bar: { gap: 8, marginTop: 8 },
  chips: { flexDirection: 'row', gap: 6 },
  chip: { flexGrow: 1, flexDirection: 'row', justifyContent: 'center', alignItems: 'baseline', gap: 5,
    borderWidth: 1, borderColor: '#8884', borderRadius: 18, paddingHorizontal: 8, paddingVertical: 7 },
  chipText: { fontSize: 15 },
  count: { fontSize: 12, opacity: 0.6, fontVariant: ['tabular-nums'] },
  calRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: 14, rowGap: 4 },
  calText: { fontSize: 13, opacity: 0.75, flexShrink: 1 },
  calLink: { fontSize: 13, fontWeight: '600' },
  warn: { color: '#b26b00', opacity: 1 },
  removeButton: { paddingVertical: 2 },
  removeText: { fontWeight: '600', fontSize: 14 },
  confirm: { width: '100%', gap: 8, backgroundColor: 'transparent' },
  confirmText: { fontSize: 15, lineHeight: 21 },
  actions: { flexDirection: 'row', gap: 8, backgroundColor: 'transparent' },
  action: { borderWidth: 1, borderColor: '#8884', borderRadius: 8, paddingHorizontal: 14, paddingVertical: 8 },
  danger: { borderColor: '#c8372d' },
  dangerText: { color: '#c8372d', fontWeight: '600' },
  error: { color: '#c8372d' },
  label: { fontSize: 12, opacity: 0.6, textTransform: 'uppercase', letterSpacing: 0.5 },
  input: { borderWidth: 1, borderColor: '#8884', borderRadius: 8, paddingHorizontal: 12, paddingVertical: 9,
    fontSize: 16 },
});
