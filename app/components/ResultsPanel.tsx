import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, TextInput } from 'react-native';

import { OfficialSessionCard } from '@/components/OfficialSessionCard';
import { Text, View, useThemeColor } from '@/components/Themed';
import { EventResults, resultsApi, roundTitle, SyncState } from '@/lib/results';

const POLL_MS = 3000;

/** "Official results" on an event's page: the series round it matches, which car is ours (found from the logged laps
 * or set here), a "Get results" button that fetches the official sheets, and one card per official session. */
export function ResultsPanel({ eventId }: { eventId: number }) {
  const [results, setResults] = useState<EventResults | null>(null);
  const [sync, setSync] = useState<SyncState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const tint = useThemeColor({}, 'tint');
  const alive = useRef(true);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await resultsApi.event(eventId);
      if (!alive.current) return null;
      setResults(r);
      setError(null);
      return r;
    } catch (e) {
      if (alive.current) setError((e as Error).message);
      return null;
    }
  }, [eventId]);

  // while the server fetches, ask how far it got every few seconds, then load the results it brought
  const poll = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      if (!alive.current) return;
      try {
        const st = await resultsApi.status();
        if (!alive.current) return;
        setSync(st.sync);
        if (st.sync.running) poll();
        else await load();
      } catch (e) {
        if (alive.current) setError((e as Error).message);
      }
    }, POLL_MS);
  }, [load]);

  useEffect(() => {
    alive.current = true;
    setResults(null);
    setSync(null);
    load().then((r) => {
      if (r?.sync.running) {
        setSync(r.sync);
        poll();
      }
    });
    return () => {
      alive.current = false;
      if (timer.current) clearTimeout(timer.current);
    };
  }, [load, poll]);

  const getResults = async () => {
    setError(null);
    try {
      const res = await resultsApi.fetch(eventId);
      setSync(res.sync);
      if (res.sync.running) poll();
      else await load();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const running = sync?.running ?? false;
  const progress = running && sync && sync.total > 0 ? ` ${sync.done}/${sync.total}` : '';
  const syncErrors = !running ? (sync?.errors ?? []) : [];
  const noCar = results != null && results.car_number == null;

  return (
    <View style={styles.panel}>
      <View style={styles.headRow}>
        <Text style={styles.h2}>Official results</Text>
        <Pressable onPress={getResults} disabled={running} accessibilityRole="button"
          style={StyleSheet.flatten([styles.button, { borderColor: tint }, running && styles.dim])}>
          {running && <ActivityIndicator size="small" />}
          <Text style={StyleSheet.flatten([styles.buttonText, { color: tint }])}>
            {running ? `Fetching…${progress}` : 'Get results'}
          </Text>
        </Pressable>
      </View>
      {running && sync?.what && <Text style={styles.small}>{sync.what}</Text>}
      {!results && !error && <ActivityIndicator />}
      {results && <Text style={styles.sub}>{roundTitle(results)}</Text>}

      {results && !editing && results.car_number != null && (
        <View style={styles.carRow}>
          <Text style={styles.sub}>
            Our car #{results.car_number}
            {results.car_number_from ? ` (${carFrom(results.car_number_from)})` : ''}
          </Text>
          <Pressable onPress={() => setEditing(true)} accessibilityRole="button" hitSlop={6}
            accessibilityLabel="Change our car number">
            <Text style={StyleSheet.flatten([styles.edit, { color: tint }])}>✎ Change</Text>
          </Pressable>
        </View>
      )}
      {results && (editing || noCar) && (
        <CarEditor eventId={eventId} initial={results.car_number ?? ''} prompt={noCar} automatic={results.car_number_from === 'set'}
          onCancel={() => setEditing(false)}
          onSaved={(r) => {
            setResults(r);
            setEditing(false);
          }} />
      )}

      {results?.note && <Text style={styles.note}>{results.note}</Text>}
      {error && <Text style={styles.error}>{error}</Text>}
      {syncErrors.length > 0 && (
        <Text style={styles.error}>Some sheets could not be fetched: {syncErrors.slice(0, 3).join('; ')}</Text>
      )}
      {results && results.sessions.length === 0 && !results.note && !running && (
        <Text style={styles.small}>No official results here yet. Tap Get results to fetch them.</Text>
      )}
      {results && results.sessions.length > 0 && (
        <View style={styles.cards}>
          {results.sessions.map((s) => (
            <View key={s.id} style={styles.cardBox}>
              <OfficialSessionCard s={s} />
            </View>
          ))}
        </View>
      )}
    </View>
  );
}

const carFrom = (from: string) => (from === 'set' ? 'set by you' : `found from ${from}`);

/** "Our car #__": the number typed in and saved; Automatic goes back to finding it from the logged laps. */
function CarEditor({ eventId, initial, prompt, automatic, onCancel, onSaved }: {
  eventId: number;
  initial: string;
  prompt: boolean;
  automatic: boolean;
  onCancel: () => void;
  onSaved: (r: EventResults) => void;
}) {
  const [value, setValue] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const tint = useThemeColor({}, 'tint');
  const text = useThemeColor({}, 'text');
  const save = async (body: { car_number?: string }) => {
    setBusy(true);
    setError(null);
    try {
      onSaved(await resultsApi.link(eventId, body));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const number = value.trim().replace(/^#/, '');
  return (
    <View style={styles.editor}>
      {prompt && <Text style={styles.sub}>Which car is yours? Enter its number.</Text>}
      <View style={styles.carRow}>
        <Text style={styles.sub}>Our car #</Text>
        <TextInput value={value} onChangeText={setValue} placeholder="no." placeholderTextColor="#888"
          keyboardType="number-pad" maxLength={4} autoFocus={!prompt} editable={!busy}
          onSubmitEditing={() => number && save({ car_number: number })}
          style={StyleSheet.flatten([styles.input, { color: text }])} />
        <Pressable onPress={() => number && save({ car_number: number })} disabled={!number || busy}
          accessibilityRole="button"
          style={StyleSheet.flatten([styles.button, { borderColor: tint }, (!number || busy) && styles.dim])}>
          <Text style={StyleSheet.flatten([styles.buttonText, { color: tint }])}>Save</Text>
        </Pressable>
        {automatic && (
          <Pressable onPress={() => save({})} disabled={busy} accessibilityRole="button" style={styles.quiet}>
            <Text style={styles.buttonText}>Automatic</Text>
          </Pressable>
        )}
        {!prompt && (
          <Pressable onPress={onCancel} accessibilityRole="button" hitSlop={6}>
            <Text style={styles.small}>Cancel</Text>
          </Pressable>
        )}
      </View>
      {error && <Text style={styles.error}>{error}</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  panel: { gap: 6, backgroundColor: 'transparent' },
  headRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12,
    flexWrap: 'wrap', backgroundColor: 'transparent' },
  h2: { fontSize: 18, fontWeight: '700' },
  sub: { fontSize: 14, opacity: 0.8 },
  small: { fontSize: 12, opacity: 0.6 },
  note: { fontSize: 13, opacity: 0.8, borderLeftWidth: 3, borderColor: '#8886', paddingLeft: 8 },
  error: { color: '#c8372d', fontSize: 13 },
  button: { flexDirection: 'row', alignItems: 'center', gap: 6, borderWidth: 1, borderRadius: 8,
    paddingHorizontal: 12, paddingVertical: 7 },
  buttonText: { fontWeight: '600', fontSize: 14 },
  quiet: { borderWidth: 1, borderStyle: 'dashed', borderColor: '#8884', borderRadius: 8, paddingHorizontal: 12,
    paddingVertical: 7 },
  dim: { opacity: 0.5 },
  carRow: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap', backgroundColor: 'transparent' },
  edit: { fontSize: 13, fontWeight: '600' },
  editor: { gap: 6, backgroundColor: 'transparent' },
  input: { width: 70, borderWidth: 1, borderColor: '#8884', borderRadius: 8, paddingHorizontal: 10,
    paddingVertical: 6, fontSize: 15 },
  cards: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, backgroundColor: 'transparent' },
  cardBox: { flexGrow: 1, flexBasis: 300, minWidth: 260, backgroundColor: 'transparent' },
});
