// The racing calendar: connect a Google Calendar by its secret iCal address, sync it, and pick which of its entries
// are events in the app (server/app/routers/planned.py).
import { Stack } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Switch, TextInput } from 'react-native';

import { Text, View, useThemeColor } from '@/components/Themed';
import { CalendarEntry, CalendarState, calendarApi, clockLabel, syncSummary, todayIso } from '@/lib/calendar';
import { dateRange } from '@/lib/events';

const STEPS = [
  'On a computer, open calendar.google.com (the Google Calendar phone app doesn’t show this address).',
  'Once: make a calendar just for racing. On the left, next to “Other calendars”, click + › Create new calendar, ' +
    'name it e.g. “Racing” and click Create calendar. Put your tests and race weekends in it: all-day events over ' +
    'their days, with the track as the location.',
  'On the left under “My calendars”, point at the racing calendar, click ⋮ › Settings and sharing.',
  'Scroll down to “Integrate calendar”.',
  'At “Secret address in iCal format”, click the copy button next to the hidden address (confirm if Google warns ' +
    'you about sharing it).',
  'Paste it below and tap Connect.',
];

export default function CalendarScreen() {
  const [state, setState] = useState<CalendarState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [replacing, setReplacing] = useState(false);
  const background = useThemeColor({}, 'background');

  const load = useCallback(() => {
    calendarApi.state().then(
      (s) => {
        setState(s);
        setError(null);
      },
      (e) => setError((e as Error).message),
    );
  }, []);
  useEffect(load, [load]);
  // a sync started in the background: look again shortly
  useEffect(() => {
    if (!state?.feed?.syncing) return;
    const t = setTimeout(load, 3000);
    return () => clearTimeout(t);
  }, [state, load]);

  const feed = state?.feed ?? null;
  return (
    <ScrollView style={{ backgroundColor: background }} contentContainerStyle={styles.outer}>
      <Stack.Screen options={{ title: 'Racing calendar' }} />
      <View style={styles.page}>
        <Text style={styles.intro}>
          Keep your tests and race weekends in Google Calendar and they show up on the Sessions tab as planned events:
          under Upcoming before they start, under Current from the day before. Logs you upload from that track on
          those days go straight into the event.
        </Text>
        {error && <Text style={styles.error}>Can&apos;t reach the server: {error}</Text>}
        {!state && !error && <ActivityIndicator />}
        {state && (!feed || replacing) && (
          <Connect replacing={replacing} autoAdd={feed?.auto_add ?? true} onCancel={() => setReplacing(false)}
            onConnected={(s) => {
              setState(s);
              setReplacing(false);
            }} />
        )}
        {state && feed && !replacing && (
          <Connected state={state} onChange={setState} onReplace={() => setReplacing(true)} />
        )}
      </View>
    </ScrollView>
  );
}

function Connect({ replacing, autoAdd, onConnected, onCancel }: {
  replacing: boolean;
  autoAdd: boolean;
  onConnected: (s: CalendarState) => void;
  onCancel: () => void;
}) {
  const [url, setUrl] = useState('');
  const [auto, setAuto] = useState(autoAdd);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const tint = useThemeColor({}, 'tint');
  const text = useThemeColor({}, 'text');

  const connect = async () => {
    setBusy(true);
    setError(null);
    try {
      const s = await calendarApi.connect(url, auto);
      setUrl(''); // the secret leaves the screen as soon as the server has it
      onConnected(s);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={styles.section}>
      <Text style={styles.h2}>{replacing ? 'Replace the address' : 'Connect your racing calendar'}</Text>
      <Text style={styles.tip}>
        Use a calendar just for racing, so private appointments don&apos;t turn into events. You can still switch single
        entries off once it&apos;s connected.
      </Text>
      {STEPS.map((s, i) => (
        <View key={i} style={styles.step}>
          <Text style={styles.stepNo}>{i + 1}.</Text>
          <Text style={styles.stepText}>{s}</Text>
        </View>
      ))}
      <Text style={styles.label}>Secret address in iCal format</Text>
      <TextInput value={url} onChangeText={setUrl} secureTextEntry autoCapitalize="none" autoCorrect={false}
        placeholder="https://calendar.google.com/calendar/ical/…/basic.ics" placeholderTextColor="#888"
        style={StyleSheet.flatten([styles.input, { color: text }])} accessibilityLabel="Secret address in iCal format" />
      <Text style={styles.note}>
        This address is a key to your calendar: paste it only here, never in a chat or an email. The server keeps it
        and this screen never shows it again. If it ever gets out, click Reset next to it in Google Calendar and paste
        the new one here.
      </Text>
      <AutoAdd value={auto} onChange={setAuto} />
      {error && <Text style={styles.error}>{error}</Text>}
      <View style={styles.buttons}>
        <Pressable onPress={connect} disabled={busy || !url.trim()} accessibilityRole="button"
          style={StyleSheet.flatten([styles.button, { borderColor: tint, opacity: url.trim() ? 1 : 0.5 }])}>
          {busy ? <ActivityIndicator color={tint} />
            : <Text style={StyleSheet.flatten([styles.buttonText, { color: tint }])}>Connect</Text>}
        </Pressable>
        {replacing && (
          <Pressable onPress={onCancel} accessibilityRole="button" style={styles.plain}>
            <Text style={{ color: tint }}>Cancel</Text>
          </Pressable>
        )}
      </View>
    </View>
  );
}

function AutoAdd({ value, onChange }: { value: boolean; onChange: (on: boolean) => void }) {
  return (
    <View style={styles.switchRow}>
      <View style={styles.switchText}>
        <Text style={styles.switchTitle}>Add new calendar entries as events by themselves</Text>
        <Text style={styles.note}>
          {value
            ? 'On: each new entry becomes a planned event at the next sync.'
            : 'Off: new entries wait in the list below, switched off, until you switch them on.'}
        </Text>
      </View>
      <Switch value={value} onValueChange={onChange} accessibilityLabel="Add new calendar entries as events by themselves" />
    </View>
  );
}

function Connected({ state, onChange, onReplace }: {
  state: CalendarState;
  onChange: (s: CalendarState) => void;
  onReplace: () => void;
}) {
  const feed = state.feed!;
  const [busy, setBusy] = useState<string | null>(null); // what is being done
  const [error, setError] = useState<string | null>(null);
  const [leaving, setLeaving] = useState(false);
  const tint = useThemeColor({}, 'tint');

  const run = async (what: string, call: () => Promise<CalendarState>) => {
    setBusy(what);
    setError(null);
    try {
      onChange(await call());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const today = todayIso();
  const status = feed.syncing || busy === 'sync' ? 'Syncing…'
    : feed.synced_at ? `Last synced ${clockLabel(feed.synced_at)}: ${syncSummary(feed.summary)}.` : 'Not synced yet.';
  const action = StyleSheet.flatten([styles.action, { borderColor: tint }]);
  const actionText = StyleSheet.flatten([styles.actionText, { color: tint }]);
  return (
    <View style={styles.section}>
      <View style={styles.box}>
        <Text style={styles.h2}>Connected{feed.name ? `: “${feed.name}”` : ''}</Text>
        <Text style={styles.note}>
          {feed.host ?? 'Calendar'}{feed.ends_with ? `, secret address ending …${feed.ends_with}` : ''}
        </Text>
        <Text>{status}</Text>
        {feed.error && <Text style={styles.warn}>{feed.error}</Text>}
        {(feed.summary.repeating ?? 0) > 0 && (
          <Text style={styles.note}>
            {feed.summary.repeating} repeating {feed.summary.repeating === 1 ? 'entry is' : 'entries are'} left out:
            make each test or race weekend an entry of its own.
          </Text>
        )}
        <View style={styles.actions}>
          <Pressable onPress={() => run('sync', calendarApi.sync)} disabled={busy != null} style={action}
            accessibilityRole="button">
            <Text style={actionText}>Sync now</Text>
          </Pressable>
          <Pressable onPress={onReplace} disabled={busy != null} style={styles.action} accessibilityRole="button">
            <Text style={styles.actionText}>Replace the address</Text>
          </Pressable>
          <Pressable onPress={() => setLeaving(!leaving)} disabled={busy != null} style={styles.action}
            accessibilityRole="button">
            <Text style={styles.actionText}>Disconnect</Text>
          </Pressable>
        </View>
        {leaving && (
          <View style={styles.confirm}>
            <Text>
              Disconnect the calendar? The server forgets its address, and its planned events that have no data yet
              are removed. Events with data stay.
            </Text>
            <View style={styles.actions}>
              <Pressable onPress={() => run('disconnect', calendarApi.disconnect)} accessibilityRole="button"
                style={StyleSheet.flatten([styles.action, styles.danger])}>
                <Text style={StyleSheet.flatten([styles.actionText, styles.dangerText])}>Disconnect</Text>
              </Pressable>
              <Pressable onPress={() => setLeaving(false)} style={styles.action} accessibilityRole="button">
                <Text style={styles.actionText}>Keep it</Text>
              </Pressable>
            </View>
          </View>
        )}
        {error && <Text style={styles.error}>{error}</Text>}
      </View>

      <AutoAdd value={feed.auto_add} onChange={(on) => run('auto', () => calendarApi.setAutoAdd(on))} />

      <Text style={styles.h2}>Calendar entries</Text>
      <Text style={styles.note}>
        Switch an entry off to leave it out of the app: its planned event is removed (an event that already has data
        stays) and later syncs keep it out until you switch it on again.
      </Text>
      {state.note && <Text style={styles.warn}>{state.note}</Text>}
      {state.entries.length === 0 && (
        <Text style={styles.note}>This calendar has no entries from the last 6 months or later.</Text>
      )}
      {state.entries.map((e) => (
        <EntryRow key={e.id} e={e} past={e.end < today} busy={busy === `entry${e.id}`}
          onSwitch={(on) => run(`entry${e.id}`, () => calendarApi.include(e.id, on))} />
      ))}
    </View>
  );
}

function EntryRow({ e, past, busy, onSwitch }: {
  e: CalendarEntry;
  past: boolean;
  busy: boolean;
  onSwitch: (on: boolean) => void;
}) {
  const state = !e.included ? 'Left out' : e.has_data ? 'In the app, with data' : 'In the app, planned';
  return (
    <View style={StyleSheet.flatten([styles.entry, past && styles.past])}>
      <View style={styles.switchText}>
        <Text style={styles.entryTitle} numberOfLines={2}>{e.title}</Text>
        <Text style={styles.note} numberOfLines={2}>
          {[dateRange(e.start, e.end), e.venue].filter(Boolean).join(' · ')}
        </Text>
        <Text style={StyleSheet.flatten([styles.entryState, !e.included && styles.off])}>{state}</Text>
      </View>
      {busy ? <ActivityIndicator /> : (
        <Switch value={e.included} onValueChange={onSwitch} accessibilityLabel={`${e.title} in the app`} />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  outer: { padding: 16, paddingBottom: 40 },
  page: { width: '100%', maxWidth: 720, alignSelf: 'center', gap: 14 },
  intro: { fontSize: 15, lineHeight: 21 },
  section: { gap: 10 },
  h2: { fontSize: 17, fontWeight: '700' },
  tip: { fontSize: 14, lineHeight: 20, opacity: 0.85 },
  step: { flexDirection: 'row', gap: 8 },
  stepNo: { width: 18, fontWeight: '700', opacity: 0.7 },
  stepText: { flex: 1, fontSize: 14, lineHeight: 20 },
  label: { fontSize: 12, opacity: 0.6, textTransform: 'uppercase', letterSpacing: 0.5, marginTop: 6 },
  input: { borderWidth: 1, borderColor: '#8884', borderRadius: 8, paddingHorizontal: 12, paddingVertical: 9,
    fontSize: 16 },
  note: { fontSize: 13, opacity: 0.65, lineHeight: 18 },
  error: { color: '#c8372d' },
  warn: { color: '#b26b00' },
  buttons: { flexDirection: 'row', alignItems: 'center', gap: 16 },
  button: { borderWidth: 1.5, borderRadius: 8, paddingHorizontal: 22, paddingVertical: 10, minWidth: 120,
    alignItems: 'center' },
  buttonText: { fontWeight: '700', fontSize: 16 },
  plain: { paddingVertical: 10 },
  box: { borderWidth: 1, borderColor: '#8884', borderRadius: 10, padding: 14, gap: 6 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 4, backgroundColor: 'transparent' },
  action: { borderWidth: 1, borderColor: '#8884', borderRadius: 8, paddingHorizontal: 14, paddingVertical: 8 },
  actionText: { fontWeight: '600' },
  danger: { borderColor: '#c8372d' },
  dangerText: { color: '#c8372d' },
  confirm: { gap: 8, marginTop: 6, backgroundColor: 'transparent' },
  switchRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  switchText: { flex: 1, gap: 2, backgroundColor: 'transparent' },
  switchTitle: { fontSize: 15, fontWeight: '600' },
  entry: { flexDirection: 'row', alignItems: 'center', gap: 12, borderWidth: 1, borderColor: '#8884',
    borderRadius: 10, paddingHorizontal: 14, paddingVertical: 10 },
  past: { opacity: 0.7 },
  entryTitle: { fontSize: 16, fontWeight: '600' },
  entryState: { fontSize: 13, fontWeight: '600', opacity: 0.8 },
  off: { opacity: 0.5 },
});
