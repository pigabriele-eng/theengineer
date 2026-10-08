// The racing calendar: connect a Google Calendar by its secret iCal address, sync it, and pick which of its entries
// are events in the app (server/app/routers/planned.py). In the programme's way: numbered sections, the steps as a
// numbered list, square tick boxes for what is in the app, the entries as ruled rows.
import { Stack } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet } from 'react-native';

import { ErrorLine, Field, FormActions, Input, MainButton, Note, PageTitle, Tick } from '@/components/Controls';
import { Colophon, Page, Section, SpecLine, TextLink, useWide } from '@/components/Programme';
import { Text, View } from '@/components/Themed';
import { CalendarEntry, CalendarState, calendarApi, clockLabel, syncSummary, todayIso } from '@/lib/calendar';
import { dateRange } from '@/lib/events';
import { a11yState } from '@/lib/a11yState';
import { Fonts, themed, Type } from '@/constants/Theme';

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
    <Page>
      <Stack.Screen options={{ title: 'Racing calendar' }} />
      <PageTitle kicker="Tools" title="Racing calendar"
        dek="Keep your tests and race weekends in Google Calendar and they show up on the Sessions tab as planned events: under Upcoming before they start, under Current from the day before. Logs you upload from that track on those days go straight into the event." />
      {error && <View style={{ marginTop: 18 }}><ErrorLine>Can’t reach the server: {error}</ErrorLine></View>}
      {!state && !error && <ActivityIndicator style={{ alignSelf: 'flex-start', marginTop: 24 }} />}
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
      <Colophon left="Racing calendar" links={[{ label: 'Seasons', href: '/seasons' }, { label: 'Garage', href: '/garage' }]} />
    </Page>
  );
}

function Connect({ replacing, autoAdd, onConnected, onCancel }: {
  replacing: boolean;
  autoAdd: boolean;
  onConnected: (s: CalendarState) => void;
  onCancel: () => void;
}) {
  const styles = useStyles();
  const wide = useWide();
  const [url, setUrl] = useState('');
  const [auto, setAuto] = useState(autoAdd);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
    <Section no={1} title={replacing ? 'Replace the address' : 'Connect your racing calendar'}
      dek="Use a calendar just for racing, so private appointments don’t turn into events. You can still switch single entries off once it’s connected.">
      <View style={styles.steps}>
        {STEPS.map((s, i) => (
          <View key={i} style={StyleSheet.flatten([styles.step, i === 0 && styles.stepFirst])}>
            <Text style={wide ? styles.stepNo : styles.stepNoPhone}>{i + 1}</Text>
            <Text style={styles.stepText}>{s}</Text>
          </View>
        ))}
      </View>
      <View style={styles.form}>
        <Field label="Secret address in iCal format">
          <Input value={url} onChangeText={setUrl} secureTextEntry autoCapitalize="none" autoCorrect={false} box
            placeholder="https://calendar.google.com/calendar/ical/…/basic.ics"
            accessibilityLabel="Secret address in iCal format" />
        </Field>
        <Note>
          This address is a key to your calendar: paste it only here, never in a chat or an email. The server keeps it
          and this screen never shows it again. If it ever gets out, click Reset next to it in Google Calendar and paste
          the new one here.
        </Note>
        <AutoAdd value={auto} onChange={setAuto} />
        {error && <ErrorLine>{error}</ErrorLine>}
        <FormActions>
          <MainButton label="Connect" onPress={connect} busy={busy} disabled={!url.trim()} />
          {replacing && <TextLink label="Cancel" onPress={onCancel} />}
        </FormActions>
      </View>
    </Section>
  );
}

/** Whether new calendar entries become events by themselves: a square tick box and what it means. */
function AutoAdd({ value, onChange, busy }: { value: boolean; onChange: (on: boolean) => void; busy?: boolean }) {
  const styles = useStyles();
  const label = 'Add new calendar entries as events by themselves';
  return (
    <Pressable onPress={() => onChange(!value)} disabled={busy} style={styles.tickRow} accessibilityRole="checkbox"
      {...a11yState({ checked: value, disabled: busy })} accessibilityLabel={label}>
      {busy ? <ActivityIndicator style={styles.tickSpinner} /> : <Tick on={value} />}
      <View style={styles.tickText}>
        <Text style={styles.tickTitle}>{label}</Text>
        <Note>
          {value
            ? 'On: each new entry becomes a planned event at the next sync.'
            : 'Off: new entries wait in the list below, left out, until you tick them.'}
        </Note>
      </View>
    </Pressable>
  );
}

function Connected({ state, onChange, onReplace }: {
  state: CalendarState;
  onChange: (s: CalendarState) => void;
  onReplace: () => void;
}) {
  const styles = useStyles();
  const feed = state.feed!;
  const [busy, setBusy] = useState<string | null>(null); // what is being done
  const [error, setError] = useState<string | null>(null);
  const [leaving, setLeaving] = useState(false);

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
  const synced = feed.syncing || busy === 'sync' ? 'Syncing…'
    : clockLabel(feed.synced_at) ?? 'Not synced yet';
  const included = state.entries.filter((e) => e.included).length;
  return (
    <>
      <Section no={1} title={feed.name ? `Connected: ${feed.name}` : 'Connected'}
        dek={feed.synced_at && !feed.syncing ? `${syncSummary(feed.summary)}.` : undefined}>
        <View style={styles.specs}>
          <SpecLine label="Calendar" value={feed.host ?? 'Calendar'} />
          {feed.ends_with ? <SpecLine label="Secret address" value={`ending …${feed.ends_with}`} /> : null}
          <SpecLine label="Last synced" value={synced} />
          <SpecLine label="Entries in the app" value={`${included} of ${state.entries.length}`} />
        </View>
        {feed.error && <Text style={styles.warn}>{feed.error}</Text>}
        {(feed.summary.repeating ?? 0) > 0 && (
          <Note style={styles.gapTop}>
            {feed.summary.repeating} repeating {feed.summary.repeating === 1 ? 'entry is' : 'entries are'} left out:
            make each test or race weekend an entry of its own.
          </Note>
        )}
        <FormActions style={styles.gapTop}>
          <MainButton label="Sync now" onPress={() => run('sync', calendarApi.sync)} busy={busy === 'sync'}
            disabled={busy != null} />
          <TextLink label="Replace the address" onPress={onReplace} disabled={busy != null} />
          <TextLink label="Disconnect" onPress={() => setLeaving(!leaving)} disabled={busy != null} />
        </FormActions>
        {leaving && (
          <View style={styles.confirm}>
            <Text style={styles.confirmText}>
              Disconnect the calendar? The server forgets its address, and its planned events that have no data yet
              are removed. Events with data stay.
            </Text>
            <FormActions>
              <MainButton label="Disconnect" danger onPress={() => run('disconnect', calendarApi.disconnect)}
                busy={busy === 'disconnect'} />
              <TextLink label="Keep it" onPress={() => setLeaving(false)} />
            </FormActions>
          </View>
        )}
        {error && <View style={styles.gapTop}><ErrorLine>{error}</ErrorLine></View>}
        <View style={styles.gapTop}>
          <AutoAdd value={feed.auto_add} busy={busy === 'auto'}
            onChange={(on) => run('auto', () => calendarApi.setAutoAdd(on))} />
        </View>
      </Section>

      <Section no={2} title="Calendar entries"
        dek="Untick an entry to leave it out of the app: its planned event is removed (an event that already has data stays) and later syncs keep it out until you tick it again.">
        {state.note && <Text style={styles.warn}>{state.note}</Text>}
        {state.entries.length === 0 && <Note>This calendar has no entries from the last 6 months or later.</Note>}
        {state.entries.length > 0 && (
          <View style={styles.tableHead}>
            <Text style={styles.th}>Entry</Text>
            <Text style={styles.th}>In the app</Text>
          </View>
        )}
        {state.entries.map((e) => (
          <EntryRow key={e.id} e={e} past={e.end < today} busy={busy === `entry${e.id}`}
            onSwitch={(on) => run(`entry${e.id}`, () => calendarApi.include(e.id, on))} />
        ))}
      </Section>
    </>
  );
}

function EntryRow({ e, past, busy, onSwitch }: {
  e: CalendarEntry;
  past: boolean;
  busy: boolean;
  onSwitch: (on: boolean) => void;
}) {
  const styles = useStyles();
  const state = !e.included ? 'Not in the app' : e.has_data ? 'In the app, with data' : 'In the app, planned';
  return (
    <View style={StyleSheet.flatten([styles.entry, past && styles.past])}>
      <View style={styles.entryText}>
        <Text style={styles.entryDate}>{[dateRange(e.start, e.end), e.venue].filter(Boolean).join(' · ')}</Text>
        <Text style={StyleSheet.flatten([styles.entryTitle, !e.included && styles.off])} numberOfLines={2}>{e.title}</Text>
        <Text style={StyleSheet.flatten([styles.entryState, e.included && styles.entryStateOn])}>{state}</Text>
      </View>
      {busy ? <ActivityIndicator style={styles.tickSpinner} /> : (
        <Tick on={e.included} onPress={() => onSwitch(!e.included)} label={`${e.title} in the app`} size={26} />
      )}
    </View>
  );
}

const useStyles = themed((c) => ({
  steps: { marginBottom: 22 },
  step: { flexDirection: 'row', alignItems: 'flex-start', gap: 14, paddingVertical: 10, borderBottomWidth: 1,
    borderColor: c.separator },
  stepFirst: { borderTopWidth: 1, borderTopColor: c.rule },
  stepNo: { fontFamily: Fonts.display, fontSize: 30, lineHeight: 32, width: 30, color: c.text },
  stepNoPhone: { fontFamily: Fonts.display, fontSize: 24, lineHeight: 27, width: 22, color: c.text },
  stepText: { flex: 1, fontFamily: Fonts.body, fontSize: 16, lineHeight: 23, color: c.text },
  form: { gap: 16, maxWidth: 680 },

  tickRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 14 },
  tickSpinner: { width: 22, height: 22 },
  tickText: { flex: 1, gap: 2 },
  tickTitle: { fontFamily: Fonts.body, fontSize: 17, lineHeight: 22, color: c.text },

  specs: { maxWidth: 680 },
  warn: { fontFamily: Fonts.body, fontSize: 16, lineHeight: 22, color: c.warning, marginTop: 12 },
  gapTop: { marginTop: 16 },
  confirm: { marginTop: 16, gap: 12, padding: 14, backgroundColor: c.band, borderTopWidth: 2, borderColor: c.error },
  confirmText: { fontFamily: Fonts.body, fontSize: 16, lineHeight: 22, color: c.text },

  tableHead: { flexDirection: 'row', justifyContent: 'space-between', paddingBottom: 6, borderBottomWidth: 2,
    borderColor: c.rule },
  th: { ...Type.label, fontFamily: Fonts.label, fontSize: 11, letterSpacing: 1.4, color: c.text },
  entry: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingVertical: 12, borderBottomWidth: 1,
    borderColor: c.separator },
  past: { opacity: 0.6 },
  entryText: { flex: 1, minWidth: 0, gap: 2 },
  entryDate: { fontFamily: Fonts.label, fontSize: 13, letterSpacing: 0.4, color: c.textSecondary,
    fontVariant: ['tabular-nums'] },
  entryTitle: { fontFamily: Fonts.display, fontSize: 20, lineHeight: 24, textTransform: 'uppercase', color: c.text },
  off: { color: c.textMuted },
  entryState: { ...Type.label, fontFamily: Fonts.label, fontSize: 11, letterSpacing: 1.2, color: c.textMuted },
  entryStateOn: { color: c.text },
}));
