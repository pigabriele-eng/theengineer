import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Switch } from 'react-native';

import { CompareTraces, LineKey, SectionTable, useLapColors, WhereTheTimeIs } from '@/components/CompareViews';
import { Text, View, useThemeColor } from '@/components/Themed';
import {
  CompareResult,
  compareLaps,
  decodePicks,
  encodePicks,
  fetchPickable,
  formatLap,
  MAX_LAPS,
  MIN_LAPS,
  PickableSession,
  signedSeconds,
  TrackGroup,
} from '@/lib/compare';

// A picked lap keeps its colour slot for as long as it is picked.
type Pick = { session_id: number; lap: number; slot: number };
type Shown = { picks: Pick[]; data: CompareResult };

const keyOf = (p: { session_id: number; lap: number }) => `${p.session_id}.${p.lap}`;
const freeSlot = (picks: Pick[]) => [0, 1, 2, 3, 4, 5].find((s) => !picks.some((p) => p.slot === s)) ?? 0;

// Compare laps: pick 2 to 6 laps from any sessions at one track (a driver's own runs, a teammate's, a client's),
// then see where the time is, the section times and the traces on one distance axis.
// Open with ?session=<id> to start from that session's best lap, or ?laps=<session>.<lap>,... for given laps.
export default function CompareScreen() {
  const params = useLocalSearchParams<{ session?: string; laps?: string; ideal?: string }>();
  const router = useRouter();
  const [groups, setGroups] = useState<TrackGroup[] | null>(null);
  const [picks, setPicks] = useState<Pick[]>(() =>
    decodePicks(params.laps)
      .filter((p, i, all) => all.findIndex((q) => keyOf(q) === keyOf(p)) === i)
      .slice(0, MAX_LAPS)
      .map((p, i) => ({ ...p, slot: i })),
  );
  const [ideal, setIdeal] = useState(params.ideal === '1');
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [shown, setShown] = useState<Shown | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const [zoom, setZoom] = useState<string | null>(null);
  const [cursor, setCursor] = useState<number | null>(null);
  const scroll = useRef<ScrollView>(null);
  const resultsY = useRef(0);
  const tracesY = useRef(0);
  const tint = useThemeColor({}, 'tint');
  const background = useThemeColor({}, 'background');

  const sessions = useMemo(() => new Map((groups ?? []).flatMap((g) => g.sessions.map((s) => [s.id, s]))), [groups]);
  const groupOf = (id: number) => groups?.find((g) => g.sessions.some((s) => s.id === id)) ?? null;

  useEffect(() => {
    fetchPickable().then(
      (g) => {
        setGroups(g);
        const start = Number(params.session);
        if (!params.laps && start) {
          const s = g.flatMap((x) => x.sessions).find((x) => x.id === start);
          if (s) setPicks([{ session_id: s.id, lap: s.best_lap, slot: 0 }]);
        }
      },
      (e) => setError((e as Error).message),
    );
  }, []); // eslint-disable-line react-hooks/exhaustive-deps -- only on opening the screen

  // keep the picks in the address, so a comparison can be reloaded or sent on
  useEffect(() => {
    router.setParams({ laps: encodePicks(picks) || undefined, ideal: ideal ? '1' : undefined, session: undefined });
  }, [picks, ideal, router]);

  // compare once the picks settle; a late answer to an older pick list is dropped
  const ask = useRef(0);
  useEffect(() => {
    const id = ++ask.current;
    if (picks.length < MIN_LAPS) {
      setBusy(false);
      return;
    }
    const snapshot = picks;
    const timer = setTimeout(() => {
      setBusy(true);
      setError(null);
      compareLaps(snapshot.map(({ session_id, lap }) => ({ session_id, lap })))
        .then((data) => {
          if (id !== ask.current) return;
          setShown({ picks: snapshot, data });
          setZoom((z) => (z && data.sections.some((s) => s.code === z) ? z : null));
        })
        .catch((e) => id === ask.current && setError((e as Error).message))
        .finally(() => id === ask.current && setBusy(false));
    }, 350);
    return () => clearTimeout(timer);
  }, [picks]);

  const add = (s: PickableSession) => {
    setPicks((ps) => {
      if (ps.length >= MAX_LAPS) return ps;
      const taken = new Set(ps.filter((p) => p.session_id === s.id).map((p) => p.lap));
      // the session's best lap, or its next best when that one is already picked
      const lap = [...s.laps].filter((l) => l.clean && !taken.has(l.number)).sort((a, b) => a.time - b.time)[0];
      return lap ? [...ps, { session_id: s.id, lap: lap.number, slot: freeSlot(ps) }] : ps;
    });
  };
  const swap = (p: Pick, lap: number) => {
    setPicks((ps) => ps.map((q) => (q === p ? { ...q, lap } : q)));
    setEditing(null);
  };
  const remove = (p: Pick) => setPicks((ps) => ps.filter((q) => q !== p));

  // zoom the traces to a section, with the crosshair where the time goes when that is known
  const step = shown?.data.traces.step_m ?? 5;
  const showSection = useCallback(
    (code: string | null, at?: number) => {
      setZoom(code);
      setCursor(at != null ? Math.round(at / step) : null);
      scroll.current?.scrollTo({ y: resultsY.current + tracesY.current - 8, animated: true });
    },
    [step],
  );
  const onFocus = useCallback((i: number) => setFocusKey(shown ? keyOf(shown.picks[i]) : null), [shown]);

  const lapTime = (p: Pick) => sessions.get(p.session_id)?.laps.find((l) => l.number === p.lap)?.time;
  const fastest = Math.min(...picks.map((p) => lapTime(p) ?? Infinity));
  const track = picks.length ? groupOf(picks[0].session_id) : null;
  const choices = track ? [track] : (groups ?? []);
  const showList = adding || picks.length < MIN_LAPS;

  const data = shown?.data;
  const colors = useLapColors(shown?.picks.map((p) => p.slot) ?? []);
  const pickColors = useLapColors(picks.map((p) => p.slot));
  const focus = data ? Math.max(0, shown!.picks.findIndex((p) => keyOf(p) === focusKey)) : 0;
  const stale = busy || (shown != null && encodePicks(shown.picks) !== encodePicks(picks));

  return (
    <ScrollView ref={scroll} style={{ backgroundColor: background }} contentContainerStyle={styles.container}>
      <Stack.Screen options={{ title: 'Compare laps' }} />
      <Text style={styles.intro}>
        Pick {MIN_LAPS} to {MAX_LAPS} laps from any sessions at one track: your own runs, a teammate's or a client's.
        Each session comes in with its best lap; tap a lap to swap it for another.
      </Text>

      <View style={styles.section}>
        <Text style={styles.h2}>Laps{track?.track ? ` at ${track.track}` : ''}</Text>
        {picks.map((p, i) => {
          const s = sessions.get(p.session_id);
          const t = lapTime(p);
          const open = editing === keyOf(p);
          return (
            <View key={keyOf(p)} style={styles.pick}>
              <Pressable style={styles.pickRow} onPress={() => setEditing(open ? null : keyOf(p))}>
                <LineKey color={pickColors.laps[i]} />
                <View style={styles.grow}>
                  <Text style={styles.pickTitle} numberOfLines={1}>
                    {s?.name ?? `Session ${p.session_id}`} · L{p.lap}
                  </Text>
                  <Text style={styles.sub} numberOfLines={1}>
                    {[s?.driver, s?.date, open ? 'pick a lap below' : 'tap to change the lap'].filter(Boolean).join(' · ')}
                  </Text>
                </View>
                <View style={styles.right}>
                  <Text style={styles.time}>{formatLap(t)}</Text>
                  {picks.length > 1 && t != null && (
                    <Text style={styles.sub}>{t === fastest ? 'fastest' : signedSeconds(t - fastest)}</Text>
                  )}
                </View>
                <Pressable onPress={() => remove(p)} hitSlop={10} style={styles.remove} accessibilityLabel="Remove lap">
                  <Text style={styles.removeText}>✕</Text>
                </Pressable>
              </Pressable>
              {open && s && (
                <View style={styles.lapChips}>
                  {s.laps.map((l) => {
                    const used = l.number !== p.lap && picks.some((q) => q.session_id === s.id && q.lap === l.number);
                    return (
                      <Pressable key={l.number} disabled={used} onPress={() => swap(p, l.number)}
                        style={StyleSheet.flatten([styles.chip, l.number === p.lap && { borderColor: tint },
                          (!l.clean || used) && styles.dim])}>
                        <Text style={l.number === p.lap ? { color: tint } : undefined}>
                          L{l.number} {formatLap(l.time)}
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>
              )}
            </View>
          );
        })}

        {picks.length < MAX_LAPS && !showList && (
          <Pressable onPress={() => setAdding(true)} style={StyleSheet.flatten([styles.button, { borderColor: tint }])}>
            <Text style={[styles.buttonText, { color: tint }]}>Add a lap from another session</Text>
          </Pressable>
        )}
        {showList && (
          <View style={styles.list}>
            {!groups && !error && <ActivityIndicator />}
            {groups && groups.length === 0 && (
              <Text style={styles.sub}>No session has timed laps yet. Upload logs on the Sessions tab first.</Text>
            )}
            {groups && groups.length > 0 && (
              <Text style={styles.sub}>
                {picks.length === 0
                  ? 'Tap a session to add its best lap.'
                  : 'Tap a session to add its best lap; tap it again for its next best.'}
              </Text>
            )}
            {choices.map((g) => (
              <View key={g.key} style={styles.group}>
                <Text style={styles.groupName}>{g.track ?? 'Track not known'}</Text>
                {g.sessions.map((s) => {
                  const n = picks.filter((p) => p.session_id === s.id).length;
                  return (
                    <Pressable key={s.id} onPress={() => add(s)} style={styles.sessionRow}
                      disabled={picks.length >= MAX_LAPS || n >= s.laps.filter((l) => l.clean).length}>
                      <View style={styles.grow}>
                        <Text style={styles.pickTitle}>{s.name}</Text>
                        <Text style={styles.sub}>
                          {[s.driver, s.date, `${s.laps.length} laps`, n ? `${n} picked` : null].filter(Boolean).join(' · ')}
                        </Text>
                      </View>
                      <Text style={styles.time}>{formatLap(s.best_time)}</Text>
                      <Text style={[styles.plus, { color: tint }]}>＋</Text>
                    </Pressable>
                  );
                })}
              </View>
            ))}
            {adding && picks.length >= MIN_LAPS && (
              <Pressable onPress={() => setAdding(false)}>
                <Text style={[styles.sub, { color: tint }]}>Done</Text>
              </Pressable>
            )}
          </View>
        )}

        {picks.length >= MIN_LAPS && (
          <View style={styles.idealRow}>
            <View style={styles.grow}>
              <Text style={styles.pickTitle}>Ideal lap</Text>
              <Text style={styles.sub}>
                The quickest of these laps in each section, put together
                {data ? `: ${formatLap(data.ideal.time)}` : ''}
              </Text>
            </View>
            <Switch value={ideal} onValueChange={setIdeal} />
          </View>
        )}
      </View>

      {error && <Text style={styles.error}>{error}</Text>}
      {busy && (
        <View style={styles.busy}>
          <ActivityIndicator />
          <Text style={styles.sub}>Placing the laps on one line…</Text>
        </View>
      )}

      {data && shown && picks.length >= MIN_LAPS && (
        <View style={[styles.results, stale && styles.stale]} onLayout={(e) => (resultsY.current = e.nativeEvent.layout.y)}>
          <WhereTheTimeIs data={data} colors={colors} focus={focus} onFocus={onFocus} onShow={showSection} />
          <SectionTable data={data} colors={colors} ideal={ideal} onPick={showSection} />
          <View onLayout={(e) => (tracesY.current = e.nativeEvent.layout.y)} style={styles.transparent}>
            <CompareTraces data={data} colors={colors} ideal={ideal} zoom={zoom} onZoom={setZoom} cursor={cursor}
              onCursor={setCursor} />
          </View>
        </View>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { padding: 16, gap: 20, maxWidth: 1100, width: '100%', alignSelf: 'center' },
  intro: { opacity: 0.7, lineHeight: 20 },
  section: { gap: 8 },
  h2: { fontSize: 18, fontWeight: '700' },
  pick: { borderBottomWidth: 1, borderColor: '#8882', paddingBottom: 8, gap: 8 },
  pickRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  grow: { flex: 1, backgroundColor: 'transparent' },
  pickTitle: { fontSize: 16, fontWeight: '600' },
  sub: { opacity: 0.7, fontSize: 13 },
  right: { alignItems: 'flex-end', backgroundColor: 'transparent' },
  time: { fontSize: 16, fontVariant: ['tabular-nums'] },
  remove: { paddingHorizontal: 6, paddingVertical: 4 },
  removeText: { fontSize: 16, opacity: 0.6 },
  lapChips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, paddingLeft: 24 },
  chip: { borderWidth: 1, borderColor: '#8884', borderRadius: 16, paddingHorizontal: 10, paddingVertical: 4 },
  dim: { opacity: 0.45 },
  button: { borderRadius: 8, padding: 12, alignItems: 'center', borderWidth: 1 },
  buttonText: { fontWeight: '600', fontSize: 15 },
  list: { gap: 12 },
  group: { gap: 2 },
  groupName: { fontSize: 13, fontWeight: '600', opacity: 0.6, textTransform: 'uppercase', letterSpacing: 0.5 },
  sessionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderColor: '#8882',
  },
  plus: { fontSize: 20, fontWeight: '600' },
  idealRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingTop: 4 },
  error: { color: '#c8372d' },
  busy: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  results: { gap: 28 },
  stale: { opacity: 0.5 },
  transparent: { backgroundColor: 'transparent' },
});
