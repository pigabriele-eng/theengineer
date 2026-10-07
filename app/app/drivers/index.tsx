import { Stack } from 'expo-router';
import { ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, StyleSheet } from 'react-native';

import { DriverSection } from '@/components/drivers/DriverPrint';
import HabitTracker, { useHabits } from '@/components/HabitTracker';
import { Notice, PageHead, useText } from '@/components/Picks';
import { Colophon, Page, Section, TextLink } from '@/components/Programme';
import { Text, View } from '@/components/Themed';
import { Driver, driversApi } from '@/lib/drivers';
import { DriverPrint, FingerprintDb, fingerprintsApi } from '@/lib/fingerprints';
import { checkingWords } from '@/lib/habitView';
import { HabitTracker as Habits } from '@/lib/habits';
import { poll } from '@/lib/poll';
import { themed, useTheme } from '@/constants/Theme';

const SUMMARY = 3; // the clearest traits and lap time notes of each driver; the rest on the fingerprints page

/** A driver on the page: their fingerprint, their habits, or both. */
type Row = { id: number; name: string; laps: number; print: DriverPrint | null; lastEvent: number | null };

/** Every driver with a fingerprint or habits, the most laps first, and the latest event each drove (to compare at). */
function rowsOf(db: FingerprintDb | null, habits: Habits | null): Row[] {
  const rows = new Map<number, Row>();
  for (const d of db?.drivers ?? []) {
    const last = [...d.events].sort((a, b) => (a.date ?? '').localeCompare(b.date ?? ''))[d.events.length - 1];
    rows.set(d.driver_id, { id: d.driver_id, name: d.driver, laps: d.laps, print: d, lastEvent: last?.event_id ?? null });
  }
  for (const d of habits?.drivers ?? []) {
    const last = [...(habits?.events ?? [])].reverse().find((e) => (e.laps[String(d.id)] ?? 0) > 0);
    const had = rows.get(d.id);
    rows.set(d.id, had ? { ...had, laps: Math.max(had.laps, d.laps), lastEvent: had.lastEvent ?? last?.id ?? null }
      : { id: d.id, name: d.name, laps: d.laps, print: null, lastEvent: last?.id ?? null });
  }
  return [...rows.values()].sort((a, b) => b.laps - a.laps || a.name.localeCompare(b.name));
}

// The drivers: one section for each, their fingerprint (how they drive, against teammates in the same car) and their
// habit tracker (their recurring mistakes over every event, getting better or worse), then "Compare with…". Tagging
// runs with drivers, which teaches both, is one tap away.
export default function DriversScreen() {
  const styles = useStyles();
  const t = useText();
  const theme = useTheme();
  const habits = useHabits();
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
    loadDrivers();
  }, [load, loadDrivers]);

  const loaded = db != null || error != null;
  const rows = rowsOf(db, habits.data);
  const busy = [
    db?.updating ? 'Adding the latest uploads to the fingerprints…' : null,
    habits.data?.status === 'checking' ? checkingWords(habits.data.checking) : null,
  ].filter((x): x is string => !!x);

  return (
    <Page>
      <Stack.Screen options={{ title: 'Drivers' }} />
      <PageHead title="Drivers"
        dek="How each driver drives and the habits they are working on, learned from the runs tagged with their name. Every upload adds to it.">
        <View style={styles.links}>
          <TextLink href="/drivers/tag" label="Tag drivers" arrow />
          <TextLink href="/drivers/compare" label="Compare drivers" arrow />
        </View>
      </PageHead>

      {!loaded && <ActivityIndicator color={theme.text} style={styles.gap} />}
      {error && <Text style={StyleSheet.flatten([t.error, styles.gap])}>{error}</Text>}
      {busy.length > 0 && (
        <Notice busy style={styles.gap}>{busy.map((b) => <Text key={b} style={t.note}>{b}</Text>)}</Notice>
      )}

      {loaded && habits.data != null && rows.length === 0 && (
        <View style={StyleSheet.flatten([styles.block, styles.gap])}>
          <Text style={t.body}>
            No drivers yet. Tag the runs of an event with who drove them: the app learns each driver's style from
            that, names the drivers of later runs by itself, and tracks their habits.
          </Text>
          <TextLink href="/drivers/tag" label="Tag drivers" arrow />
        </View>
      )}

      {rows.map((r, i) => {
        const more = <DriverMore r={r} />;
        return r.print ? (
          <DriverSection key={r.id} no={i + 1} d={r.print} drivers={drivers} onNamed={named} summary={SUMMARY}>
            {more}
          </DriverSection>
        ) : (
          <Section key={r.id} no={i + 1} title={r.name} dek={`${r.laps} laps checked for habits.`}>{more}</Section>
        );
      })}

      <Colophon left="The Engineer · Drivers" right={loaded ? `${rows.length} drivers` : undefined}
        links={[{ label: 'Fingerprints in full', href: '/drivers/fingerprints' }, { label: 'Tag drivers', href: '/drivers/tag' }]} />
    </Page>
  );
}

/** Under a driver's fingerprint: their habit tracker, then the driver to compare them with. */
function DriverMore({ r }: { r: Row }): ReactNode {
  const styles = useStyles();
  const t = useText();
  return (
    <>
      <View style={styles.list}>
        <Text style={t.sub}>Habits</Text>
        {/* The habit tracker (components/HabitTracker.tsx, by the driver detection work); the page says once above
            when the technique check is still at work. */}
        <HabitTracker driverId={r.id} hideChecking />
      </View>
      <TextLink label="Compare with…" arrow
        href={r.lastEvent != null ? { pathname: '/drivers/compare', params: { event: String(r.lastEvent) } } : '/drivers/compare'} />
    </>
  );
}

const useStyles = themed(() => ({
  gap: { marginTop: 24 },
  block: { gap: 26 },
  list: { gap: 12 },
  links: { flexDirection: 'row', flexWrap: 'wrap', columnGap: 24, rowGap: 12, marginTop: 6 },
}));
