import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { StyleSheet, useWindowDimensions } from 'react-native';

import { useBackTo } from '@/components/Back';
import { onFill } from '@/components/PrepParts';
import PrintButton from '@/components/PrintButton';
import { Block, Colophon, Label, Page, useGutter } from '@/components/Programme';
import { TyrePrep } from '@/components/report/TyrePrep';
import { SessionSwitcher, useEventFolder, useSessionEvent } from '@/components/SessionSwitcher';
import { Text, View } from '@/components/Themed';
import { themed, Type, useTheme } from '@/constants/Theme';

/** Quali prep on its own page, for a whole event or one session, in the programme's numbered sections: the plan (the
 * recommended warm-up and its figures), then the warm-ups and build laps side by side, when the tyres were ready to
 * push, each tyre's window with the cold pressures that land in it, and the long runs. */
export default function QualiScreen() {
  const styles = useStyles();
  const theme = useTheme();
  const gutter = useGutter();
  const { width } = useWindowDimensions();
  const params = useLocalSearchParams<{ event?: string; session?: string }>();
  const event = params.event ? Number(params.event) : null;
  const session = event == null && params.session ? Number(params.session) : null;
  const router = useRouter();
  // the event's sessions, to switch between the whole event and one session without going back
  const sessionEvent = useSessionEvent(session);
  const folder = useEventFolder(event ?? sessionEvent);
  // the masthead's Back, opened fresh: up to the event
  const backEvent = event ?? sessionEvent;
  useBackTo(backEvent != null ? { id: backEvent, name: folder?.id === backEvent ? folder.name : null } : null);

  if (event == null && session == null) {
    return (
      <Page>
        <Text style={StyleSheet.flatten([styles.title, styles.head])} accessibilityRole="header">Quali prep</Text>
        <Text style={styles.dek}>Open quali prep from an event on Weekend, or from a run.</Text>
      </Page>
    );
  }
  const current = session != null ? folder?.days.flatMap((d) => d.sessions).find((s) => s.id === session) : null;
  const title = current ? `Quali prep · ${current.name}` : 'Quali prep';
  // Type.title's 44 px, smaller when the longest word would not fit across (Anton's capitals are about 0.47 wide)
  const longest = Math.max(...title.split(/\s+/).map((w) => w.length), 1);
  const size = Math.max(26, Math.floor(Math.min(Type.title.fontSize ?? 44, (Math.min(width, 1240) - 2 * gutter)
    / (longest * 0.47))));
  return (
    <Page>
      <Stack.Screen options={{ title: folder ? `Quali prep · ${folder.name}` : 'Quali prep' }} />
      <View style={styles.head}>
        <View style={styles.kicker}>
          <Block label={session != null ? 'One session' : 'Whole event'} color={theme.mark} ink={onFill(theme.mark)} />
          {folder ? <Label style={styles.kickerFacts}>{[folder.name, folder.track].filter(Boolean).join(' · ')}</Label> : null}
        </View>
        <Text style={StyleSheet.flatten([styles.title, { fontSize: size, lineHeight: Math.round(size * 1.05) }])}
          accessibilityRole="header">{title}</Text>
        <Text style={styles.dek}>
          How the tyres were brought up to temperature for a quick lap, from the TPMS of every quali-style run
          {session != null ? ' in this session' : ' of the event'}.
        </Text>
        <PrintButton title={[title, folder?.name, folder?.track].filter(Boolean).join(' · ')} style={styles.print} />
      </View>
      {folder && folder.id != null && (
        <View style={styles.switcher}>
          <SessionSwitcher folder={folder} current={session} onlyTimed
            onWhole={() => router.setParams({ event: String(folder.id), session: undefined })}
            onPick={(s) => router.setParams({ session: String(s.id), event: undefined })} />
        </View>
      )}
      {event != null ? <TyrePrep key={`e${event}`} event={event} heading={false} />
        : <TyrePrep key={`s${session}`} session={session!} heading={false} />}
      <Colophon left="The Engineer · Quali prep" right={folder ? [folder.name, folder.track].filter(Boolean).join(' · ')
        : undefined} />
    </Page>
  );
}

const useStyles = themed((c) => ({
  head: { paddingTop: 28 },
  kicker: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 10, marginBottom: 12 },
  kickerFacts: { flexShrink: 1 },
  title: { ...Type.title, color: c.text },
  dek: { ...Type.dek, color: c.textSecondary, marginTop: 8, maxWidth: 680 },
  switcher: { marginTop: 22 },
  print: { marginTop: 14 },
}));
