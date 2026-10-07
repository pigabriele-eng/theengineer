// The event list's Past / Current / Upcoming filter with the racing calendar's state under it, removing a planned
// event (made by hand or from the calendar, no data yet) and the form that plans one.
import { useState } from 'react';
import { Pressable, StyleSheet, TextInput } from 'react-native';

import { EventForm } from '@/components/EventForm';
import { TextLink, useWide } from '@/components/Programme';
import { Text, View, useThemeColor } from '@/components/Themed';
import { CalendarState, calendarApi, clockLabel, Filter, FILTERS, Plan } from '@/lib/calendar';
import { Folder, FolderSummary } from '@/lib/events';
import { Fonts, Radius, themed, Type, useTheme } from '@/constants/Theme';

/** The index of the event list: Past, Current, Upcoming and All as large words with their counts, the one shown
 * underlined in red. */
export function FilterBar({ filter, counts, onPick }: {
  filter: Filter;
  counts: Record<Filter, number>;
  onPick: (f: Filter) => void;
}) {
  const styles = useStyles();
  const wide = useWide();
  return (
    <View style={wide ? styles.tabs : styles.tabsPhone} accessibilityRole="tablist">
      {FILTERS.map(({ key, label }) => {
        const on = key === filter;
        return (
          <Pressable key={key} onPress={() => onPick(key)} accessibilityRole="tab" hitSlop={4}
            accessibilityState={{ selected: on }} accessibilityLabel={`${label}: ${counts[key]}`}
            style={StyleSheet.flatten([wide ? styles.tab : styles.tabPhone, on && styles.tabOn])}>
            <Text style={StyleSheet.flatten([wide ? styles.tabText : styles.tabTextPhone, on && styles.tabTextOn])}>
              {label}
            </Text>
            <Text style={StyleSheet.flatten([styles.count, on && styles.tabTextOn])}>{counts[key]}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/** The racing calendar's state in one line, with Sync now; an offer to bring it in when there is none. */
export function CalendarLine({ calendar, onSynced }: {
  calendar: CalendarState;
  onSynced: (c: CalendarState) => void;
}) {
  const styles = useStyles();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const feed = calendar.feed;
  if (!feed) {
    return <TextLink href="/tools/calendar" label="Bring in your racing calendar" arrow small />;
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
        Calendar{feed.name ? ` “${feed.name}”` : ''} {error ?? status}
      </Text>
      <TextLink onPress={sync} disabled={busy} label="Sync now" small />
      <TextLink href="/tools/calendar" label="Settings" small />
    </View>
  );
}

/** Remove a planned event (no data yet): the button and, once tapped, the question. In a wrapping row: the question
 * takes a line of its own. */
export function RemovePlanned({ f, plan, onRemoved }: { f: FolderSummary; plan?: Plan; onRemoved: () => void }) {
  const styles = useStyles();
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState<string | null>(null);
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
      <TextLink onPress={() => setAsking(!asking)} label="Remove" small />
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
  const styles = useStyles();
  const theme = useTheme();
  const [venue, setVenue] = useState('');
  const text = useThemeColor({}, 'text');
  return (
    <EventForm submitLabel="Make the event" onCancel={onCancel}
      datesHint={'Logs recorded at this venue on these days, or the day before, go into this event when you upload ' +
        'them. Leave the days empty to take them from the logs.'}
      extra={
        <>
          <Text style={styles.label}>Venue</Text>
          <TextInput value={venue} onChangeText={setVenue} placeholder="e.g. Hockenheimring" placeholderTextColor={theme.textMuted}
            style={StyleSheet.flatten([styles.input, { color: text }])} maxLength={255} accessibilityLabel="Venue" />
        </>
      }
      onSubmit={async (v) => onMade(await calendarApi.plan({ ...v, venue: venue.trim() || null }))} />
  );
}

const useStyles = themed((c) => ({
  tabs: { flexDirection: 'row', alignItems: 'flex-end', gap: 26, paddingTop: 18, paddingBottom: 12 },
  tabsPhone: { flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between', paddingTop: 14, paddingBottom: 10 },
  tab: { flexDirection: 'row', alignItems: 'flex-start', paddingBottom: 6, borderBottomWidth: 6, borderColor: 'transparent',
    minWidth: 44 },
  // 44 px tall on a phone too: 7 px of room above the word (in the row's own top margin), the underline stays put
  tabPhone: { flexDirection: 'row', alignItems: 'flex-start', paddingBottom: 6, borderBottomWidth: 5, borderColor: 'transparent',
    paddingTop: 7, marginTop: -7, minWidth: 44 },
  tabOn: { borderColor: c.mark },
  tabText: { fontFamily: Fonts.display, fontSize: 30, lineHeight: 32, textTransform: 'uppercase', color: c.textMuted },
  tabTextPhone: { fontFamily: Fonts.display, fontSize: 24, lineHeight: 26, textTransform: 'uppercase', color: c.textMuted },
  tabTextOn: { color: c.text },
  count: { fontFamily: Type.label.fontFamily, fontSize: 13, lineHeight: 14, marginLeft: 3, color: c.textMuted },
  calRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: 12, rowGap: 6 },
  calText: { fontFamily: Fonts.label, fontSize: 13, color: c.textSecondary, flexShrink: 1 },
  warn: { color: c.warning },
  confirm: { width: '100%', gap: 8, backgroundColor: 'transparent' },
  confirmText: { fontSize: 15, lineHeight: 21 },
  actions: { flexDirection: 'row', gap: 8, backgroundColor: 'transparent' },
  action: { borderWidth: 1, borderColor: c.border, borderRadius: Radius.control, paddingHorizontal: 14, paddingVertical: 8 },
  danger: { borderColor: c.error },
  dangerText: { color: c.error, fontWeight: '600' },
  error: { color: c.error },
  label: { fontSize: 12, opacity: 0.6, textTransform: 'uppercase', letterSpacing: 0.5 },
  input: { borderWidth: 1, borderColor: c.border, borderRadius: Radius.control, paddingHorizontal: 12, paddingVertical: 9,
    fontSize: 16, backgroundColor: c.surface },
}));
