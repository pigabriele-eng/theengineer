// The Setup section of the session page: is there a sheet, what changed from the previous run, and the way in.
import { Link, useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet } from 'react-native';

import { Text, View, useThemeColor } from '@/components/Themed';
import { setupApi, Sheet } from '@/lib/setup';
import { Radius, themed } from '@/constants/Theme';

const SHOWN = 4;

export function SetupCard({ sessionId }: { sessionId: number }) {
  const styles = useStyles();
  const [sheet, setSheet] = useState<Sheet | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const tint = useThemeColor({}, 'tint');
  const router = useRouter();

  // Again on coming back from the sheet, so the summary is current.
  useFocusEffect(
    useCallback(() => {
      let live = true;
      setupApi.sheet(sessionId).then(
        (s) => live && setSheet(s),
        (e) => live && setError(e.message),
      );
      return () => {
        live = false;
      };
    }, [sessionId]),
  );

  const copy = async () => {
    setBusy(true);
    setError(null);
    try {
      await setupApi.copyPrevious(sessionId);
      router.push({ pathname: '/tools/setup', params: { session: sessionId } });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const count = sheet ? Object.keys(sheet.values).length : 0;
  const prev = sheet?.previous?.name ?? 'the previous run';
  const line = !sheet
    ? ''
    : !sheet.exists
      ? 'No setup sheet for this run yet.'
      : !sheet.previous
        ? `${count} values on the sheet.`
        : sheet.changes.length
          ? `${count} values · ${sheet.changes.length} changed from ${prev}:`
          : `${count} values · same setup as ${prev}.`;

  return (
    <View style={styles.section}>
      <Text style={styles.h2}>Setup</Text>
      {!sheet && !error && <ActivityIndicator style={styles.left} />}
      {line ? <Text style={styles.sub}>{line}</Text> : null}
      {sheet?.changes.slice(0, SHOWN).map((c) => (
        <Text key={c.key} style={styles.change}>
          {c.text}
        </Text>
      ))}
      {sheet && sheet.changes.length > SHOWN && (
        <Text style={styles.sub}>and {sheet.changes.length - SHOWN} more</Text>
      )}
      {error && <Text style={styles.error}>{error}</Text>}
      <View style={styles.actions}>
        {sheet && !sheet.exists && sheet.previous && (
          <Pressable
            style={StyleSheet.flatten([styles.button, { borderColor: tint }])}
            onPress={copy}
            disabled={busy}>
            {busy ? (
              <ActivityIndicator color={tint} />
            ) : (
              <Text style={[styles.buttonText, { color: tint }]}>Copy from {prev}</Text>
            )}
          </Pressable>
        )}
        {/* Link asChild hands its child's style to a web anchor, which can't take a style array: one object */}
        <Link href={{ pathname: '/tools/setup', params: { session: sessionId } }} asChild>
          <Pressable style={StyleSheet.flatten([styles.button, { borderColor: tint }])}>
            <Text style={[styles.buttonText, { color: tint }]}>{sheet?.exists ? 'Setup sheet' : 'Fill in the sheet'}</Text>
          </Pressable>
        </Link>
        <Link href={{ pathname: '/tools/setup', params: { session: sessionId, tab: 'ideas' } }} asChild>
          <Pressable style={StyleSheet.flatten([styles.button, { borderColor: tint }])}>
            <Text style={[styles.buttonText, { color: tint }]}>Setup suggestions</Text>
          </Pressable>
        </Link>
      </View>
    </View>
  );
}

const useStyles = themed((c) => ({
  section: { gap: 6 },
  h2: { fontSize: 18, fontWeight: '700' },
  left: { alignSelf: 'flex-start' },
  sub: { opacity: 0.7 },
  change: { fontWeight: '600' },
  error: { color: c.error },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 4 },
  button: {
    borderRadius: Radius.control,
    borderWidth: 1,
    paddingVertical: 10,
    paddingHorizontal: 14,
    alignItems: 'center',
    flexGrow: 1,
    backgroundColor: 'transparent',
  },
  buttonText: { fontWeight: '600', fontSize: 15 },
}));
