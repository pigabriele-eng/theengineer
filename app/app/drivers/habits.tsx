import { Stack } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, StyleSheet } from 'react-native';

import HabitTracker, { useHabits } from '@/components/HabitTracker';
import { Notice, PageHead, Tabs, useText } from '@/components/Picks';
import PrintButton from '@/components/PrintButton';
import { Colophon, Page, TextLink } from '@/components/Programme';
import { Text, View } from '@/components/Themed';
import { checkingWords, keepDriver } from '@/lib/habitView';
import { themed, useTheme } from '@/constants/Theme';

// The habit tracker: each driver's recurring technique mistakes over every event, getting better or worse, set beside
// a teammate's. A driver to pick (the one with most laps first), then their tracker (components/HabitTracker.tsx),
// which reads the server's answer and asks again while the technique check is still at work.
export default function HabitsScreen() {
  const styles = useStyles();
  const t = useText();
  const theme = useTheme();
  const { data, error } = useHabits();
  const [chosen, setChosen] = useState<number | null>(null);
  const driverId = data ? keepDriver(data.drivers, chosen) : null;

  return (
    <Page>
      <Stack.Screen options={{ title: 'Driver habits' }} />
      <PageHead title="Driver habits"
        dek="Each driver’s recurring mistakes from the technique check, over every event: how often, what they cost a lap, and whether they are getting better.">
        <PrintButton title="Driver habits" />
      </PageHead>

      {data == null && !error && <ActivityIndicator color={theme.text} style={styles.gap} />}
      {data == null && error && <Text style={StyleSheet.flatten([t.error, styles.gap])}>{error}</Text>}

      {data != null && data.drivers.length === 0 && (
        <View style={StyleSheet.flatten([styles.block, styles.gap])}>
          {data.status === 'checking' && (
            <Notice busy><Text style={t.note}>{checkingWords(data.checking)}</Text></Notice>
          )}
          <Text style={t.body}>
            No habits yet. They appear once the technique check has run on events where the drivers are named.
          </Text>
          <TextLink href="/drivers/tag" label="Tag drivers" arrow />
        </View>
      )}

      {data != null && driverId != null && (
        <View style={StyleSheet.flatten([styles.block, styles.gap])}>
          {data.drivers.length > 1 && (
            <Tabs big label="Driver" value={driverId} onChange={setChosen}
              items={data.drivers.map((d) => ({ key: d.id, label: d.name,
                sub: `${d.laps} laps · ${d.events} event${d.events === 1 ? '' : 's'}` }))} />
          )}
          <HabitTracker key={driverId} driverId={driverId} />
        </View>
      )}

      <Colophon left="The Engineer · Driver habits"
        right={data ? `${data.drivers.length} drivers · ${data.events.length} events` : undefined} />
    </Page>
  );
}

const useStyles = themed(() => ({
  gap: { marginTop: 24 },
  block: { gap: 24 },
}));
