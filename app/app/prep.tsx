import { Stack, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, useWindowDimensions } from 'react-native';

import { useBackTo } from '@/components/Back';
import { onFill } from '@/components/PrepParts';
import PrintButton from '@/components/PrintButton';
import { Block, Colophon, InsetPhoto, Label, Page, useGutter, useWide } from '@/components/Programme';
import { Text, View } from '@/components/Themed';
import WeekendBefore from '@/components/weekend/Before';
import { dateRange } from '@/lib/events';
import { PrepAnswer } from '@/lib/prep';
import { photoFor, themed, Type, useTheme } from '@/constants/Theme';

/** The prep report page (?event= and ?car=): the event's headline with the track's photo, then the race weekend's
 * "Before" view (components/weekend/Before.tsx), which holds the report itself and the car picker. */
export default function PrepScreen() {
  const styles = useStyles();
  const params = useLocalSearchParams<{ event?: string; car?: string }>();
  const eventId = params.event ? Number(params.event) : null;
  const [answer, setAnswer] = useState<PrepAnswer | null>(null);
  // the masthead's Back, opened fresh: up to the event, by its name once the report has it
  useBackTo(eventId != null ? { id: eventId, name: answer?.event.id === eventId ? answer.event.name : null } : null);
  if (eventId == null) {
    return (
      <Page>
        <Text style={StyleSheet.flatten([styles.title, styles.headTop])} accessibilityRole="header">Prep report</Text>
        <Text style={styles.dek}>Open the prep report from an event.</Text>
      </Page>
    );
  }
  const shown = answer?.event.id === eventId ? answer : null;
  return (
    <Page>
      <Stack.Screen options={{ title: shown ? `Prep · ${shown.event.name}` : 'Prep report' }} />
      <Head answer={shown} />
      <WeekendBefore eventId={eventId} car={params.car ?? null} onAnswer={setAnswer} />
      <Colophon left="The Engineer · Prep report"
        right={shown ? [shown.event.name, shown.event.track].filter(Boolean).join(' · ') : undefined} />
    </Page>
  );
}

/** The page's opening: a red tag with the track and the dates, the event's name as the headline, and the track's photo
 * beside it. */
function Head({ answer }: { answer: PrepAnswer | null }) {
  const styles = useStyles();
  const theme = useTheme();
  const wide = useWide();
  const gutter = useGutter();
  const { width } = useWindowDimensions();
  const ev = answer?.event;
  const title = ev?.name ?? 'Prep report';
  const PHOTO_W = 400;
  // Type.title's 44 px, smaller when the longest word would not fit across (Anton's capitals are about 0.47 wide)
  const room = Math.min(width, 1240) - 2 * gutter - (wide ? PHOTO_W + 36 : 0);
  const longest = Math.max(...title.split(/\s+/).map((w) => w.length), 1);
  const size = Math.max(26, Math.floor(Math.min(Type.title.fontSize ?? 44, room / (longest * 0.47))));
  const facts = ev ? [ev.track, dateRange(ev.start, ev.end)].filter(Boolean).join(' · ') : null;
  return (
    <View style={wide ? styles.head : styles.headPhone}>
      <View style={styles.headText}>
        <View style={styles.kicker}>
          <Block label="Prep report" color={theme.mark} ink={onFill(theme.mark)} />
          {facts ? <Label style={styles.kickerFacts}>{facts}</Label> : null}
        </View>
        <Text style={StyleSheet.flatten([styles.title, { fontSize: size, lineHeight: Math.round(size * 1.05) }])}
          accessibilityRole="header">{title}</Text>
        <PrintButton title={['Prep report', ev?.name, ev?.track].filter(Boolean).join(' · ')} style={styles.print} />
      </View>
      {ev?.track ? (
        <InsetPhoto photo={photoFor(ev.track)} height={wide ? 236 : 190}
          style={wide ? { width: PHOTO_W } : styles.photoPhone} />
      ) : null}
    </View>
  );
}

const useStyles = themed((c) => ({
  head: { flexDirection: 'row', alignItems: 'flex-end', gap: 36, paddingTop: 28 },
  headPhone: { paddingTop: 20, gap: 18 },
  headTop: { marginTop: 28 },
  headText: { flex: 1, minWidth: 0 },
  photoPhone: { alignSelf: 'stretch' },
  kicker: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 10, marginBottom: 12 },
  kickerFacts: { flexShrink: 1 },
  title: { ...Type.title, color: c.text },
  dek: { ...Type.dek, color: c.textSecondary, marginTop: 8, maxWidth: 640 },
  print: { marginTop: 14 },
}));
