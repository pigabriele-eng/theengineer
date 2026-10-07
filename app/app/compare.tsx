import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet } from 'react-native';

import { CompareTraces, LineKey, SectionTable, useLapColors, WhereTheTimeIs } from '@/components/CompareViews';
import { Choice, PageHead, useText } from '@/components/Picks';
import PrintButton from '@/components/PrintButton';
import { Colophon, Page, Section, TextLink } from '@/components/Programme';
import { Text, View } from '@/components/Themed';
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
import { face, Fonts, themed, Type, useTheme } from '@/constants/Theme';
import { noPrint } from '@/lib/print';
import { codeOf } from '@/lib/driverTag';

// A picked lap keeps its colour slot for as long as it is picked.
type Pick = { session_id: number; lap: number; slot: number };
type Shown = { picks: Pick[]; data: CompareResult };

const keyOf = (p: { session_id: number; lap: number }) => `${p.session_id}.${p.lap}`;
const ASK_AFTER_MS = 150; // taps this close together are one change of laps
const ANSWERS_KEPT = 8;
const freeSlot = (picks: Pick[]) => [0, 1, 2, 3, 4, 5].find((s) => !picks.some((p) => p.slot === s)) ?? 0;

// Compare laps: pick 2 to 6 laps from any sessions at one track (a driver's own runs, a teammate's, a client's),
// then see where the time is, the section times and the traces on one distance axis.
// Open with ?session=<id> to start from that session's best lap, or ?laps=<session>.<lap>,... for given laps.
// A page of the race programme: the headline, the laps as a ruled list, then numbered sections.
export default function CompareScreen() {
  const styles = useStyles();
  const t = useText();
  const theme = useTheme();
  const params = useLocalSearchParams<{ session?: string; laps?: string }>();
  const router = useRouter();
  const [groups, setGroups] = useState<TrackGroup[] | null>(null);
  const [picks, setPicks] = useState<Pick[]>(() =>
    decodePicks(params.laps)
      .filter((p, i, all) => all.findIndex((q) => keyOf(q) === keyOf(p)) === i)
      .slice(0, MAX_LAPS)
      .map((p, i) => ({ ...p, slot: i })),
  );
  const [adding, setAdding] = useState(false);
  const [shown, setShown] = useState<Shown | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const [zoom, setZoom] = useState<string | null>(null);
  const [cursor, setCursor] = useState<number | null>(null);
  const scroll = useRef<ScrollView>(null);
  const resultsY = useRef(0);
  const tracesY = useRef(0);

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
    router.setParams({ laps: encodePicks(picks) || undefined, session: undefined });
  }, [picks, router]);

  // compare once the picks settle; a late answer to an older pick list is dropped. The answers already had on this
  // page are kept, so going back to laps compared before shows them at once.
  const ask = useRef(0);
  const answers = useRef(new Map<string, CompareResult>());
  useEffect(() => {
    const id = ++ask.current;
    if (picks.length < MIN_LAPS) {
      setBusy(false);
      return;
    }
    const snapshot = picks;
    const key = encodePicks(snapshot);
    const show = (data: CompareResult) => {
      setShown({ picks: snapshot, data });
      setZoom((z) => (z && data.sections.some((s) => s.code === z) ? z : null));
    };
    const known = answers.current.get(key);
    if (known) {
      setBusy(false);
      setError(null);
      show(known);
      return;
    }
    const timer = setTimeout(() => {
      setBusy(true);
      setError(null);
      compareLaps(snapshot.map(({ session_id, lap }) => ({ session_id, lap })))
        .then((data) => {
          answers.current.set(key, data);
          const oldest = answers.current.keys().next().value;
          if (answers.current.size > ANSWERS_KEPT && oldest != null) answers.current.delete(oldest);
          if (id === ask.current) show(data);
        })
        .catch((e) => id === ask.current && setError((e as Error).message))
        .finally(() => id === ask.current && setBusy(false));
    }, ASK_AFTER_MS);
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
  const pdfName = ['Compare laps', ...picks.map((p) => `${sessions.get(p.session_id)?.name ?? `Session ${p.session_id}`} L${p.lap}`)]
    .join(' · ');

  return (
    <Page scrollRef={scroll}>
      <Stack.Screen options={{ title: 'Compare laps' }} />
      <PageHead title="Compare laps"
        dek={`${MIN_LAPS} to ${MAX_LAPS} laps from any sessions at one track: your own runs, a teammate's or a client's.`}>
        <PrintButton title={pdfName} />
      </PageHead>

      <Section no={1} title="The laps"
        dek={`${track?.track ? `At ${track.track}. ` : ''}Each session comes in with its best lap; tap a lap to swap it for another.`}>
        {picks.length > 0 && (
          <View style={styles.headRow}>
            <Text style={StyleSheet.flatten([styles.th, styles.grow])}>Lap</Text>
            <Text style={styles.th}>Time</Text>
            <View style={styles.removeCol} {...noPrint} />
          </View>
        )}
        {picks.map((p, i) => {
          const s = sessions.get(p.session_id);
          const time = lapTime(p);
          const code = codeOf(s?.driver);
          // the run's quickest clean lap, marked among its laps
          const bestLap = s ? [...s.laps].filter((l) => l.clean).sort((a, b) => a.time - b.time)[0]?.number : undefined;
          const more = s ? s.laps.some((l) => l.clean && !picks.some((q) => q.session_id === s.id && q.lap === l.number)) : false;
          return (
            <View key={keyOf(p)} style={styles.pick}>
              <View style={styles.pickRow}>
                <View style={styles.pickMain}>
                  <LineKey color={pickColors.laps[i]} />
                  <View style={styles.grow}>
                    <Text style={styles.pickTitle} numberOfLines={1}>
                      {code ? <Text style={styles.driverCode}>{`${code}  `}</Text> : null}
                      {s?.name ?? `Session ${p.session_id}`} · L{p.lap}
                    </Text>
                    <Text style={t.labelMuted} numberOfLines={2}>
                      {[s?.driver, s?.date, 'tap a lap below to switch'].filter(Boolean).join(' · ')}
                    </Text>
                  </View>
                  <View style={styles.right}>
                    <Text style={styles.time}>{formatLap(time)}</Text>
                    {picks.length > 1 && time != null && (
                      <Text style={StyleSheet.flatten([styles.gap, time === fastest && styles.gapBest])}>
                        {time === fastest ? 'fastest' : signedSeconds(time - fastest)}
                      </Text>
                    )}
                  </View>
                </View>
                <Pressable onPress={() => remove(p)} style={styles.removeHit} accessibilityRole="button"
                  accessibilityLabel="Remove lap" {...noPrint}>
                  <Text style={styles.removeText}>✕</Text>
                </Pressable>
              </View>
              {/* every lap of the run, one tap to switch to it (its quickest clean lap on the purple block), and one
                  tap to add another lap of the same run: laps of one run against each other */}
              {s && (
                <View style={styles.lapChoices} {...noPrint}>
                  {s.laps.map((l) => {
                    const used = l.number !== p.lap && picks.some((q) => q.session_id === s.id && q.lap === l.number);
                    return (
                      <Choice key={l.number} label={`${l.number}`} detail={formatLap(l.time)} on={l.number === p.lap}
                        disabled={used} dim={!l.clean} onPress={() => swap(p, l.number)}
                        fill={l.number === bestLap ? theme.timing.best : undefined}
                        ink={l.number === bestLap ? theme.timing.onBest : undefined}
                        accessibilityLabel={`Lap ${l.number}, ${formatLap(l.time)}${l.number === bestLap ? ', the run’s best' : ''}${l.clean ? '' : ', not clean'}${used ? ', already picked' : ''}`} />
                    );
                  })}
                  {more && picks.length < MAX_LAPS && (
                    <View style={styles.addSame}>
                      <TextLink label={`+ Another lap of ${s.name}`} onPress={() => add(s)} small />
                    </View>
                  )}
                </View>
              )}
            </View>
          );
        })}

        {picks.length < MAX_LAPS && !showList && (
          <View style={styles.action}>
            <TextLink label="+ Add a lap from another session" onPress={() => setAdding(true)} />
          </View>
        )}
        {showList && (
          <View style={styles.list} {...noPrint}>
            {!groups && !error && <ActivityIndicator color={theme.text} style={styles.left} />}
            {groups && groups.length === 0 && (
              <Text style={t.note}>No session has timed laps yet. Upload logs on the Sessions page first.</Text>
            )}
            {groups && groups.length > 0 && (
              <Text style={t.note}>
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
                  const full = picks.length >= MAX_LAPS || n >= s.laps.filter((l) => l.clean).length;
                  return (
                    <Pressable key={s.id} onPress={() => add(s)} style={StyleSheet.flatten([styles.sessionRow, full && styles.dim])}
                      disabled={full} accessibilityRole="button" accessibilityLabel={`Add ${s.name}'s best lap`}>
                      <View style={styles.grow}>
                        <Text style={styles.pickTitle}>
                          {s.driver ? <Text style={styles.driverCode}>{`${codeOf(s.driver)}  `}</Text> : null}
                          {s.name}
                        </Text>
                        <Text style={t.labelMuted}>
                          {[s.driver, s.date, `${s.laps.length} laps`, n ? `${n} picked` : null].filter(Boolean).join(' · ')}
                        </Text>
                      </View>
                      <Text style={styles.time}>{formatLap(s.best_time)}</Text>
                      <Text style={styles.addWord}>Add</Text>
                    </Pressable>
                  );
                })}
              </View>
            ))}
            {adding && picks.length >= MIN_LAPS && <TextLink label="Done" onPress={() => setAdding(false)} />}
          </View>
        )}
      </Section>

      {error && <Text style={StyleSheet.flatten([t.error, styles.gapTop])}>{error}</Text>}
      {/* comparing other laps: the last answer stays in place, dimmed, rather than moving down for this line */}
      {busy && !(data && picks.length >= MIN_LAPS) && (
        <View style={StyleSheet.flatten([styles.busy, styles.gapTop])}>
          <ActivityIndicator color={theme.text} />
          <Text style={t.note}>Placing the laps on one line…</Text>
        </View>
      )}

      {data && shown && picks.length >= MIN_LAPS && (
        <View style={StyleSheet.flatten([styles.results, stale && styles.stale])}
          onLayout={(e) => (resultsY.current = e.nativeEvent.layout.y)}>
          <WhereTheTimeIs no={2} data={data} colors={colors} focus={focus} onFocus={onFocus} onShow={showSection} />
          <SectionTable no={3} data={data} colors={colors} onPick={showSection} />
          <View onLayout={(e) => (tracesY.current = e.nativeEvent.layout.y)} style={styles.transparent}>
            <CompareTraces no={4} data={data} colors={colors} zoom={zoom} onZoom={setZoom} cursor={cursor}
              onCursor={setCursor} />
          </View>
        </View>
      )}
      <Colophon left="The Engineer · Compare laps" right={track?.track ?? undefined} />
    </Page>
  );
}

const useStyles = themed((c) => ({
  grow: { flex: 1, minWidth: 0, backgroundColor: 'transparent' },
  left: { alignSelf: 'flex-start' },
  headRow: { flexDirection: 'row', alignItems: 'flex-end', gap: 10, borderBottomWidth: 1, borderColor: c.rule,
    paddingBottom: 5 },
  th: { ...Type.label, fontSize: 11, color: c.text },
  pick: { borderBottomWidth: 1, borderColor: c.separator, paddingVertical: 10, gap: 10 },
  pickRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  pickMain: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 12 },
  pickTitle: { fontFamily: face('body', 600), fontSize: 17, lineHeight: 22, color: c.text },
  right: { alignItems: 'flex-end', backgroundColor: 'transparent' },
  time: { ...Type.number, fontFamily: face('label', 700), fontSize: 18, color: c.text },
  gap: { ...Type.number, fontSize: 13, color: c.delta.loss },
  gapBest: { ...Type.label, fontSize: 13, color: c.timing.bestInk },
  removeCol: { width: 28, alignItems: 'center' },
  // the ✕: a 44 px tap target in its 28 px column, the row laid out as drawn
  removeHit: { width: 44, marginHorizontal: -8, paddingVertical: 12, marginVertical: -12, alignItems: 'center' },
  removeText: { fontFamily: Fonts.label, fontSize: 15, color: c.textMuted },
  lapChoices: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: 14, rowGap: 10, paddingLeft: 26 },
  addSame: { paddingVertical: 6 },
  driverCode: { fontFamily: Type.label.fontFamily, letterSpacing: 0.6, color: c.text },
  dim: { opacity: 0.45 },
  action: { marginTop: 16 },
  list: { gap: 12, marginTop: 16 },
  group: { gap: 0 },
  groupName: { ...Type.label, color: c.text, borderBottomWidth: 1, borderColor: c.rule, paddingBottom: 5 },
  sessionRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 10, borderBottomWidth: 1,
    borderColor: c.separator },
  addWord: { ...Type.link, fontSize: 12, letterSpacing: 1.2, color: c.text, borderBottomWidth: 2, borderColor: c.rule,
    paddingBottom: 1 },
  busy: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  gapTop: { marginTop: 18 },
  results: { backgroundColor: 'transparent' },
  stale: { opacity: 0.5 },
  transparent: { backgroundColor: 'transparent' },
}));
