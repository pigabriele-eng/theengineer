import { Link, Stack } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet } from 'react-native';

import { DriverSection, NameStyle } from '@/components/drivers/DriverPrint';
import { Notice, PageHead, useText } from '@/components/Picks';
import PrintButton from '@/components/PrintButton';
import { Colophon, Label, Page, Section, TextLink } from '@/components/Programme';
import { Text, View } from '@/components/Themed';
import { Driver, driversApi } from '@/lib/drivers';
import { FingerprintDb, fingerprintsApi, LapLink } from '@/lib/fingerprints';
import { poll } from '@/lib/poll';
import { tapRoom, themed, useTheme } from '@/constants/Theme';

// The driver fingerprint database: how each driver drives, learned from the runs tagged with their name and set
// against their teammates in the same car, which habits go with quicker laps in all the data, and the styles still
// waiting for a name. The server keeps it worked out after every upload, so the page only reads it.
export default function FingerprintsScreen() {
  const styles = useStyles();
  const t = useText();
  const theme = useTheme();
  const [db, setDb] = useState<FingerprintDb | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [drivers, setDrivers] = useState<Driver[]>([]);
  const stopPoll = useRef<(() => void) | null>(null);
  const live = useRef(true); // false once the page is gone: an answer still on its way is dropped, not polled on

  // read again while the latest uploads are still being added (lib/poll.ts: less and less often)
  const load = useCallback(() => {
    stopPoll.current?.();
    stopPoll.current = poll((wanted) => fingerprintsApi.all().then(
      (d) => {
        if (!live.current || !wanted()) return false;
        setDb(d);
        setError(null);
        return !!d.updating;
      },
      (e) => {
        if (live.current && wanted()) setError((e as Error).message);
        return false;
      },
    ));
  }, []);
  const loadDrivers = useCallback(() => {
    driversApi.list().then((d) => live.current && setDrivers(d), () => live.current && setDrivers([]));
  }, []);
  useEffect(() => {
    live.current = true;
    load();
    loadDrivers();
    return () => {
      live.current = false;
      stopPoll.current?.();
    };
  }, [load, loadDrivers]);
  const named = useCallback(() => {
    load();
    loadDrivers(); // a new driver may have been added
  }, [load, loadDrivers]);

  let no = 0;
  const next = () => ++no;
  const pace = db?.links.filter((l) => !l.outcome) ?? [];
  const outcome = db?.links.filter((l) => l.outcome) ?? [];

  return (
    <Page>
      <Stack.Screen options={{ title: 'Driver fingerprints' }} />
      <PageHead title="Driver fingerprints"
        dek="How each driver drives, from braking to throttle to steering, learned from the runs tagged with their name and set against their teammates in the same car. Every upload adds to it.">
        <PrintButton title="Driver fingerprints" />
      </PageHead>

      {db == null && !error && <ActivityIndicator color={theme.text} style={styles.gap} />}
      {error && <Text style={StyleSheet.flatten([t.error, styles.gap])}>{error}</Text>}
      {db?.updating && (
        <Notice busy style={styles.gap}><Text style={t.note}>Adding the latest uploads to the fingerprints…</Text></Notice>
      )}

      {db != null && db.drivers.length === 0 && (
        <View style={StyleSheet.flatten([styles.block, styles.gap])}>
          <Text style={t.body}>
            No fingerprints yet. After an upload the app asks once who each driver it can't name is, and learns
            their style from the answer. From then on it sets the driver of every run by itself, at every event, and
            shows it as set from the driving style so you can change it.
          </Text>
          <TextLink href="/drivers/tag" label="Tag drivers" arrow />
        </View>
      )}

      {db?.drivers.map((d) => <DriverSection key={d.driver_id} no={next()} d={d} drivers={drivers} onNamed={named} />)}

      {db != null && db.links.length > 0 && (
        <Section no={next()} title="What goes with quicker laps"
          dek="Every lap against the typical lap of its own run, all drivers and events together, so track, tyres and fuel are taken out.">
          <View style={styles.block}>
            {pace.map((l) => <LinkRow key={l.kind} l={l} />)}
            {outcome.length > 0 && (
              <View style={styles.list}>
                <Text style={t.sub}>Results of pace, not advice</Text>
                <Text style={t.note}>
                  These follow from going quicker rather than make the car quicker: a quicker lap spends less time
                  braking and more at full throttle anyway.
                </Text>
                {outcome.map((l) => <LinkRow key={l.kind} l={l} />)}
              </View>
            )}
            <Text style={t.small}>
              Link: how closely the habit follows lap time, from 0 (not at all) to 1 (always). From {db.links[0].laps} laps.
            </Text>
          </View>
        </Section>
      )}

      {db != null && db.unnamed.length > 0 && (
        <Section no={next()} title="Drivers waiting for a name"
          dek="Drivers the app tells apart by their style at these events but can't name yet. Name one once, and every run in that style gets the name and teaches their fingerprint.">
          <View style={styles.list}>
            {db.unnamed.map((u) => (
              <View key={`${u.event_id}-${u.label}`} style={styles.row}>
                <Link href={{ pathname: '/event/[id]', params: { id: String(u.event_id) } }} asChild>
                  <Pressable accessibilityRole="link" style={styles.rowLink}>
                    <Text style={t.body}><Text style={t.strong}>{u.label}</Text> at {u.event ?? `Event ${u.event_id}`}</Text>
                  </Pressable>
                </Link>
                <Text style={t.num}>{u.laps} laps</Text>
                <NameStyle ids={u.session_ids} label="This is…" drivers={drivers} onNamed={named} />
              </View>
            ))}
          </View>
        </Section>
      )}

      {db != null && db.kinds.length > 0 && (
        <Section no={next()} title="What is measured"
          dek="Each corner of every clean lap, averaged over the lap. A driver's fingerprint is how they differ from their teammates in the same car.">
          <View style={styles.list}>
            {db.kinds.map((k) => (
              <View key={k.kind} style={styles.glossary}>
                <Label small>{k.label}</Label>
                <Text style={t.note}>{k.explain}</Text>
              </View>
            ))}
          </View>
        </Section>
      )}

      <Colophon left="The Engineer · Driver fingerprints"
        right={db ? `${db.drivers.length} drivers · ${db.events} events` : undefined} />
    </Page>
  );
}

function LinkRow({ l }: { l: LapLink }) {
  const styles = useStyles();
  const t = useText();
  return (
    <View style={styles.row}>
      <View style={styles.flex}>
        <Label small>{l.label}</Label>
        <Text style={t.body}>{l.words}.</Text>
      </View>
      <Text style={t.num}>link {Math.abs(l.r).toFixed(2)}</Text>
    </View>
  );
}

const useStyles = themed((c) => ({
  gap: { marginTop: 24 },
  block: { gap: 26 },
  list: { gap: 12 },
  flex: { flex: 1, minWidth: 0 },
  // the event's link: room above and below makes it a 44 px tap target, the row laid out as drawn
  rowLink: { flex: 1, minWidth: 0, ...tapRoom(11) },
  row: { flexDirection: 'row', alignItems: 'baseline', gap: 16, flexWrap: 'wrap' },
  rowPhone: { gap: 4 },
  figs: { flexDirection: 'row', flexWrap: 'wrap', columnGap: 16, rowGap: 2 },
  trait: { gap: 3, borderLeftWidth: 3, borderColor: c.rule, paddingLeft: 12 },
  traitHead: { flexDirection: 'row', gap: 12, alignItems: 'baseline', flexWrap: 'wrap' },
  advice: { gap: 3 },
  gain: { color: c.mark },
  glossary: { gap: 2, maxWidth: 720 },
  name: { width: '100%', gap: 12, borderLeftWidth: 3, borderColor: c.mark, paddingLeft: 12, marginTop: 4 },
}));
