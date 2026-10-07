import { Link, Stack, useFocusEffect } from 'expo-router';
import { useCallback, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet } from 'react-native';

import { CountryTag } from '@/components/Flag';
import { PageHead, useText } from '@/components/Picks';
import { Colophon, Page, useWide } from '@/components/Programme';
import { Text, View } from '@/components/Themed';
import { formatLap } from '@/lib/api';
import { coachingDays } from '@/lib/coachingDay';
import { countryOfAny } from '@/lib/countries';
import { WithMode } from '@/lib/eventModes';
import { dateRange, eventsApi, FolderSummary } from '@/lib/events';
import { carLine, driverLapsLine, shortName } from '@/lib/homeFolds';
import { Fonts, themed, Type, useTheme } from '@/constants/Theme';

type Day = FolderSummary & WithMode;

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

// The coaching days: events switched to "Coaching day" on their page (lib/eventModes.ts), newest first, each a line
// as the events list draws one (its days, flag, name, who drove how many laps, the best lap) that opens its page.
export default function CoachingScreen() {
  const t = useText();
  const theme = useTheme();
  const [days, setDays] = useState<Day[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const loadNo = useRef(0);
  const load = useCallback(() => {
    const no = ++loadNo.current;
    eventsApi.folders().then(
      (f) => {
        if (no !== loadNo.current) return;
        setDays(coachingDays(f as Day[]));
        setError(null);
      },
      (e) => no === loadNo.current && setError((e as Error).message),
    );
  }, []);
  useFocusEffect(load);

  return (
    <Page>
      <Stack.Screen options={{ title: 'Coaching' }} />
      <PageHead title="Coaching"
        dek="Days with clients, newest first. Each opens on the three things to improve, whether they were fixed, and where the time goes corner by corner." />
      {error && <Text style={StyleSheet.flatten([t.error, { marginTop: 24 }])}>{error}</Text>}
      {days == null && !error && <ActivityIndicator color={theme.text} style={{ marginTop: 24 }} />}
      {days != null && days.length === 0 && (
        <Text style={StyleSheet.flatten([t.body, { marginTop: 24, maxWidth: 640 }])}>
          No coaching days yet. To make one, open the event and switch it from Race weekend to Coaching day at the top of
          its page.
        </Text>
      )}
      {days != null && days.length > 0 && (
        <View style={{ marginTop: 26 }}>{days.map((f) => <DayRow key={f.key} f={f} />)}</View>
      )}
      <Colophon left="The Engineer · Coaching" right={days ? plural(days.length, 'coaching day') : undefined} />
    </Page>
  );
}

/** One coaching day: its dates, flag and name, who drove how many laps in what, and the best lap; a tap opens it. */
function DayRow({ f }: { f: Day }) {
  const styles = useStyles();
  const wide = useWide();
  const country = countryOfAny([f.track, f.name]);
  const dates = dateRange(f.start, f.end) ?? 'Days not set';
  const meta = [f.track, driverLapsLine(f), carLine(f), plural(f.sessions, 'run')].filter(Boolean).join(' · ');
  const best = f.best_lap_s != null ? `Best ${formatLap(f.best_lap_s)}` : 'No laps yet';
  return (
    <Link href={{ pathname: '/event/[id]', params: { id: f.key } }} asChild>
      <Pressable accessibilityRole="link" accessibilityLabel={`${f.name}, ${dates}, ${meta}, ${best}`}
        style={styles.item}>
        <View style={wide ? styles.line : styles.linePhone}>
          <Text style={wide ? styles.date : styles.datePhone}>{dates}</Text>
          <View style={styles.what}>
            <View style={wide ? styles.nameLine : styles.nameLinePhone}>
              {country && <CountryTag country={country} />}
              <Text style={StyleSheet.flatten([wide ? styles.name : styles.namePhone, styles.shrink])}>{shortName(f)}</Text>
            </View>
            <Text style={styles.meta}>{meta}</Text>
          </View>
          <Text style={styles.status}>{best}</Text>
        </View>
        <Text style={styles.mark} accessibilityElementsHidden importantForAccessibility="no">→</Text>
      </Pressable>
    </Link>
  );
}

const useStyles = themed((c) => ({
  item: { flexDirection: 'row', alignItems: 'flex-start', gap: 14, borderBottomWidth: 1, borderColor: c.rule,
    paddingTop: 14, paddingBottom: 13, minHeight: 44 },
  line: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'baseline', gap: 22 },
  linePhone: { flex: 1, minWidth: 0, flexDirection: 'column', gap: 6 },
  date: { ...Type.label, fontSize: 15, letterSpacing: 1.6, width: 210, color: c.text },
  datePhone: { ...Type.label, fontSize: 15, letterSpacing: 1.6, color: c.text },
  what: { flex: 1, minWidth: 0 },
  nameLine: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  nameLinePhone: { flexDirection: 'row', alignItems: 'center', gap: 11 },
  shrink: { flexShrink: 1 },
  name: { fontFamily: Fonts.display, fontSize: 30, lineHeight: 32, textTransform: 'uppercase', color: c.text },
  namePhone: { fontFamily: Fonts.display, fontSize: 26, lineHeight: 28, textTransform: 'uppercase', color: c.text },
  meta: { fontFamily: Fonts.body, fontSize: 16, lineHeight: 22, color: c.textSecondary, marginTop: 4 },
  status: { ...Type.label, fontSize: 13, alignSelf: 'flex-start', borderBottomWidth: 3, borderColor: c.rule,
    paddingBottom: 2, color: c.text },
  mark: { fontFamily: Fonts.label, fontSize: 20, lineHeight: 32, color: c.text, width: 20, textAlign: 'right' },
}));
