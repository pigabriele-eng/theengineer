import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator } from 'react-native';

import { OfficialSessionCard } from '@/components/OfficialSessionCard';
import { Field, SubHead, usePrepType } from '@/components/PrepParts';
import { Label, TextLink, useWide } from '@/components/Programme';
import { Text, View } from '@/components/Themed';
import { poll } from '@/lib/poll';
import { EventResults, resultsApi, roundTitle, SyncState } from '@/lib/results';
import { face, themed, useTheme } from '@/constants/Theme';


/** "Official results" on an event's page: the series round it matches, which car is ours (found from the logged laps
 * or set here), "Get results" to fetch the official sheets, and one ruled column per official session. Its own heading,
 * a sub-head under a thick rule, unless `heading` is false (inside a section of its own); "Get results" then leads the
 * panel. */
export function ResultsPanel({ eventId, heading = true }: { eventId: number; heading?: boolean }) {
  const styles = useStyles();
  const type = usePrepType();
  const theme = useTheme();
  const wide = useWide();
  const [results, setResults] = useState<EventResults | null>(null);
  const [sync, setSync] = useState<SyncState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const alive = useRef(true);
  const following = useRef<(() => void) | null>(null); // stops the poll below

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

  // while the server fetches, ask how far it got (lib/poll.ts: less and less often), then load the results it brought
  const follow = useCallback(() => {
    following.current?.();
    following.current = poll(async (live) => {
      if (!alive.current) return false;
      try {
        const st = await resultsApi.status();
        if (!alive.current || !live()) return false;
        setSync(st.sync);
        if (st.sync.running) return true;
        await load();
        return false;
      } catch (e) {
        if (alive.current) setError((e as Error).message);
        return false;
      }
    }, { now: false });
  }, [load]);

  useEffect(() => {
    alive.current = true;
    setResults(null);
    setSync(null);
    load().then((r) => {
      if (r?.sync.running) {
        setSync(r.sync);
        follow();
      }
    });
    return () => {
      alive.current = false;
      following.current?.();
    };
  }, [load, follow]);

  const getResults = async () => {
    setError(null);
    try {
      const res = await resultsApi.fetch(eventId);
      setSync(res.sync);
      if (res.sync.running) follow();
      else await load();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const running = sync?.running ?? false;
  const progress = running && sync && sync.total > 0 ? ` ${sync.done}/${sync.total}` : '';
  const syncErrors = !running ? (sync?.errors ?? []) : [];
  const noCar = results != null && results.car_number == null;
  const action = (
    <View style={styles.action}>
      {running && <ActivityIndicator size="small" color={theme.text} />}
      <TextLink label={running ? `Fetching…${progress}` : 'Get results'} onPress={getResults} disabled={running} red />
    </View>
  );

  return (
    <View style={styles.panel}>
      {heading ? <SubHead title="Official results" right={action} /> : action}
      {running && sync?.what && <Text style={type.small}>{sync.what}</Text>}
      {!results && !error && <ActivityIndicator color={theme.text} style={styles.loading} />}
      {results && <Text style={styles.round}>{roundTitle(results)}</Text>}

      {results && !editing && results.car_number != null && (
        <View style={styles.carRow}>
          <Label>
            Our car #{results.car_number}
            {results.car_number_from ? <Text style={styles.from}>{`  (${carFrom(results.car_number_from)})`}</Text> : null}
          </Label>
          <TextLink label="Change" small onPress={() => setEditing(true)} />
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

      {results?.note && <Text style={type.note}>{results.note}</Text>}
      {error && <Text style={type.error}>{error}</Text>}
      {syncErrors.length > 0 && (
        <Text style={type.error}>Some sheets could not be fetched: {syncErrors.slice(0, 3).join('; ')}</Text>
      )}
      {results && results.sessions.length === 0 && !results.note && !running && (
        <Text style={type.note}>No official results here yet. Get results fetches them.</Text>
      )}
      {results && results.sessions.length > 0 && (
        <View style={wide ? styles.cards : styles.cardsPhone}>
          {results.sessions.map((s) => (
            <View key={s.id} style={wide ? styles.cardBox : undefined}>
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
  const styles = useStyles();
  const type = usePrepType();
  const theme = useTheme();
  const [value, setValue] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
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
      <Label>{prompt ? 'Which car is yours? Enter its number' : 'Our car number'}</Label>
      <View style={styles.fieldRow}>
        <Text style={styles.hash}>#</Text>
        <Field value={value} onChangeText={setValue} placeholder="no." width={80}
          keyboardType="number-pad" maxLength={4} autoFocus={!prompt} editable={!busy}
          accessibilityLabel="Our car number" onSubmitEditing={() => number && save({ car_number: number })} />
        {/* each link in a view of its own: it lines its underline up with the field's rule */}
        <View><TextLink label="Save" red onPress={() => number && save({ car_number: number })}
          disabled={!number || busy} /></View>
        {automatic && <View><TextLink label="Automatic" small onPress={() => save({})} disabled={busy} /></View>}
        {!prompt && <View><TextLink label="Cancel" small onPress={onCancel} /></View>}
      </View>
      {error && <Text style={type.error}>{error}</Text>}
    </View>
  );
}

const useStyles = themed((c) => ({
  panel: { gap: 10 },
  action: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  loading: { alignSelf: 'flex-start' },
  round: { fontFamily: face('body', 400, true), fontSize: 17, lineHeight: 24, color: c.textSecondary },
  carRow: { flexDirection: 'row', alignItems: 'center', columnGap: 14, rowGap: 8, flexWrap: 'wrap' },
  from: { fontFamily: face('label', 500), letterSpacing: 0.4, textTransform: 'none', color: c.textSecondary },
  editor: { gap: 8, borderTopWidth: 1, borderBottomWidth: 1, borderColor: c.rule, paddingTop: 10, paddingBottom: 12 },
  fieldRow: { flexDirection: 'row', alignItems: 'flex-end', columnGap: 14, rowGap: 8, flexWrap: 'wrap' },
  hash: { fontFamily: face('label', 600), fontSize: 20, lineHeight: 30, color: c.text },
  cards: { flexDirection: 'row', flexWrap: 'wrap', columnGap: 28, rowGap: 22, marginTop: 6 },
  cardsPhone: { gap: 22, marginTop: 6 },
  cardBox: { flexGrow: 1, flexBasis: 300, minWidth: 260 },
}));
