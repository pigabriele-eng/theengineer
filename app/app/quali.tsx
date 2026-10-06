import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { ScrollView, StyleSheet } from 'react-native';

import { TyrePrep } from '@/components/report/TyrePrep';
import { SessionSwitcher, useEventFolder, useSessionEvent } from '@/components/SessionSwitcher';
import { Text, View, useThemeColor } from '@/components/Themed';

/** Quali prep on its own page, for a whole event or one session: the recommended warm-up first, then the warm-ups
 * and build laps side by side, when the tyres were ready to push, each tyre's window with the cold pressures that
 * land in it, and the long runs. */
export default function QualiScreen() {
  const params = useLocalSearchParams<{ event?: string; session?: string }>();
  const event = params.event ? Number(params.event) : null;
  const session = event == null && params.session ? Number(params.session) : null;
  const background = useThemeColor({}, 'background');
  const router = useRouter();
  // the event's sessions, to switch between the whole event and one session without going back
  const sessionEvent = useSessionEvent(session);
  const folder = useEventFolder(event ?? sessionEvent);

  if (event == null && session == null) {
    return <Text style={styles.pad}>Open quali prep from an event on the Sessions tab, or from a session.</Text>;
  }
  return (
    <ScrollView style={{ backgroundColor: background }} contentContainerStyle={styles.outer}>
      <Stack.Screen options={{ title: folder ? `Quali prep · ${folder.name}` : 'Quali prep' }} />
      <View style={styles.page}>
        <View style={styles.head}>
          <Text style={styles.h1}>Quali prep</Text>
          {folder && (
            <Text style={styles.sub}>{[folder.name, folder.track].filter(Boolean).join(' · ')}</Text>
          )}
        </View>
        {folder && folder.id != null && (
          <SessionSwitcher folder={folder} current={session} onlyTimed
            onWhole={() => router.setParams({ event: String(folder.id), session: undefined })}
            onPick={(s) => router.setParams({ session: String(s.id), event: undefined })} />
        )}
        {event != null ? <TyrePrep key={`e${event}`} event={event} heading={false} />
          : <TyrePrep key={`s${session}`} session={session!} heading={false} />}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  outer: { paddingVertical: 16, alignItems: 'center' },
  page: { width: '100%', maxWidth: 1100, paddingHorizontal: 16, gap: 20 },
  pad: { padding: 16 },
  head: { gap: 4 },
  h1: { fontSize: 24, fontWeight: '700' },
  sub: { opacity: 0.7 },
});
