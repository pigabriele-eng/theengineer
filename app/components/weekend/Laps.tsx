// The weekend page's first tab while the weekend is on (Gabriele, 2026-10-07: "Compare laps, during the weekend,
// should be the standard function that opens when clicking on the event ... imagine a scenario, driver in the evening
// in the hotel going through data from FP or Quali before the race on the next day"). Phone first, one hand:
// 01 the comparisons worth making, worked out by the server (server/app/compare_suggest.py: teammates head to head,
// each driver against their last session, the best lap against a typical one; like with like on tyres, real laps
// only), each with the corners where most of the gap is and what the technique check found wrong there on the slower
// lap; 02 to 05 the comparison itself, the first suggestion's already open (the laps, where the time is, the section
// times, the traces); 06 the weekend's laps to pick by hand.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, LayoutChangeEvent, Pressable, StyleSheet } from 'react-native';

import { CompareTraces, LineKey, SectionTable, useLapColors, WhereTheTimeIs } from '@/components/CompareViews';
import { ErrorLine, Note } from '@/components/Controls';
import { DriverTag } from '@/components/DriverTag';
import { SubFoldHead } from '@/components/Fold';
import { Choice } from '@/components/Picks';
import { Fig, Section, TextLink, useWide } from '@/components/Programme';
import { Text, View } from '@/components/Themed';
import { CompareResult, compareLaps, encodePicks, formatLap, MAX_LAPS, MIN_LAPS, signedSeconds } from '@/lib/compare';
import { codeOf } from '@/lib/driverTag';
import { fetchSuggestions, PickRun, PickSession, SuggestedLap, Suggestion, Suggestions } from '@/lib/lapSuggestions';
import {
  cornerWords, lapWords, mistakeNotes, mistakeWords, suggestionSpeech, suggestionTitle, toggleLap,
} from '@/lib/lapsFirst';
import { poll } from '@/lib/poll';
import { DETECTED_CORNERS_NOTE } from '@/lib/api';
import { face, Fonts, TAP, themed, Type, useTheme } from '@/constants/Theme';

type LapPick = { session_id: number; lap: number };
// what is on show: a suggestion (by its place in the list), or laps picked by hand
type Shown = { kind: 'suggestion'; index: number } | { kind: 'own'; laps: LapPick[] };

const ANSWERS_KEPT = 8;
const tag = (driver: string | null) => (driver ? { text: codeOf(driver)!, kind: 'known' as const, name: driver }
  : { text: 'Driver?', kind: 'none' as const, name: null });

/** The Laps tab. `onShow(y)`: scroll the page to y within the tab (the comparison, once a suggestion is tapped). */
export default function WeekendLaps({ eventId, onShow }: { eventId: number; onShow?: (y: number) => void }) {
  const styles = useStyles();
  const [answer, setAnswer] = useState<Suggestions | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [shown, setShown] = useState<Shown>({ kind: 'suggestion', index: 0 });
  const [tapped, setTapped] = useState(false); // a suggestion was tapped: open it now, whether its corners are known
  const [own, setOwn] = useState<LapPick[]>([]);

  // the suggestions, asked again while the server works out their corners or the technique check the mistakes at them
  // come from is worked out (lib/poll.ts)
  useEffect(() => poll((live) => fetchSuggestions(eventId).then((a) => {
    if (!live()) return false;
    setAnswer(a);
    setError(null);
    return a.status === 'working' || a.technique === 'working';
  }, (e) => {
    if (live()) setError((e as Error).message);
    return true;
  })), [eventId]);

  const suggestions = answer?.suggestions ?? [];
  const picked = shown.kind === 'suggestion' ? suggestions[shown.index] ?? null : null;
  const laps: LapPick[] = shown.kind === 'own' ? shown.laps
    : picked ? picked.laps.map(({ session_id, lap }) => ({ session_id, lap })) : [];
  const key = encodePicks(laps);
  // a suggestion opens once its corners are known (its comparison is then kept on the server: at once), or at once
  // when tapped; laps picked by hand at once
  const ready = shown.kind === 'own' || tapped || answer?.status === 'ready' || picked?.corners != null;

  const answers = useRef(new Map<string, CompareResult>());
  const [data, setData] = useState<{ key: string; result: CompareResult } | null>(null);
  const [compareError, setCompareError] = useState<string | null>(null);
  useEffect(() => {
    if (laps.length < MIN_LAPS || !ready) return;
    const known = answers.current.get(key);
    if (known) {
      setData({ key, result: known });
      setCompareError(null);
      return;
    }
    let live = true;
    setCompareError(null);
    compareLaps(laps).then((r) => {
      answers.current.set(key, r);
      const oldest = answers.current.keys().next().value;
      if (answers.current.size > ANSWERS_KEPT && oldest != null) answers.current.delete(oldest);
      if (live) setData({ key, result: r });
    }, (e) => live && setCompareError((e as Error).message));
    return () => {
      live = false;
    };
  }, [key, ready]); // eslint-disable-line react-hooks/exhaustive-deps -- the laps, by value

  const compareY = useRef(0);
  const show = (s: Shown) => {
    setShown(s);
    setTapped(true);
    onShow?.(compareY.current);
  };
  const corners = suggestions.some((s) => s.corners?.length);
  // the traces scrolled to (a section shown in the comparison): one function for good, so the views keep theirs
  const onShowNow = useRef(onShow);
  onShowNow.current = onShow;
  const toTraces = useCallback((y: number) => onShowNow.current?.(compareY.current + y), []);

  return (
    <>
      <Section no={1} title="Suggested comparisons"
        dek="Like with like on tyres: teammates head to head, each driver against their last session, the best lap against a typical one. Tap one to see it below.">
        {!answer && !error && <ActivityIndicator style={styles.left} />}
        {error && !answer && <ErrorLine>{`Can’t find the laps to compare: ${error}`}</ErrorLine>}
        {answer && suggestions.length === 0 && answer.notes.map((n) => <Note key={n} style={styles.note}>{n}</Note>)}
        <View style={styles.list}>
          {suggestions.map((s, i) => (
            <SuggestionRow key={i} no={i + 1} s={s} on={shown.kind === 'suggestion' && shown.index === i}
              onPress={() => show({ kind: 'suggestion', index: i })} />
          ))}
        </View>
        {suggestions.length > 0 && answer?.notes.map((n) => <Note key={n} style={styles.note}>{n}</Note>)}
        {answer?.status === 'working' && answer.progress && (
          <View style={styles.working}>
            <ActivityIndicator />
            <Note>{`Finding where the time is: ${answer.progress.done} of ${answer.progress.total}`}</Note>
          </View>
        )}
        {answer?.status === 'ready' && answer.technique === 'working' && corners && (
          <View style={styles.working}>
            <ActivityIndicator />
            <Note>The technique check is still running: what went wrong at each corner shows here once it’s done.</Note>
          </View>
        )}
      </Section>

      <View onLayout={(e: LayoutChangeEvent) => (compareY.current = e.nativeEvent.layout.y)}>
        <Comparison laps={laps} picked={picked} data={data?.key === key ? data.result : null} error={compareError}
          waiting={laps.length >= MIN_LAPS && !ready} answer={answer}
          onTraces={toTraces} />
      </View>

      <PickYourOwn sessions={answer?.sessions ?? null} picks={own} onPicks={setOwn}
        onCompare={() => show({ kind: 'own', laps: own })} />
    </>
  );
}

// ---------- one suggestion ----------

function SuggestionRow({ no, s, on, onPress }: { no: number; s: Suggestion; on: boolean; onPress: () => void }) {
  const styles = useStyles();
  const colors = useLapColors([0, 1]);
  const words = suggestionSpeech(s, codeOf, formatLap);
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityState={{ selected: on }}
      accessibilityLabel={`${words}${on ? ' On show below.' : ''}`} accessibilityHint="Shows this comparison below"
      style={StyleSheet.flatten([styles.row, on && styles.rowOn])}>
      <Text style={styles.rowNo}>{String(no).padStart(2, '0')}</Text>
      <View style={styles.grow}>
        <View style={styles.rowHead}>
          <Text style={styles.rowTitle}>{suggestionTitle(s, codeOf)}</Text>
          <Text style={styles.rowGap}>{`${s.gap_s.toFixed(2)} s`}</Text>
        </View>
        {s.laps.map((l, i) => <LapLine key={i} lap={l} color={colors.laps[i]} />)}
        {s.corners == null ? <Text style={styles.cornersWaiting}>Finding the corners…</Text>
          : s.corners.some((c) => c.mistake) ? (
            // with what the technique check found there: a corner a line, the mistake after it (at the start of its
            // line, "T11-T12 0.29 s" is never split)
            <View style={styles.cornerList}>
              <Text style={styles.corner}>Most of the gap:</Text>
              {s.corners.map((c) => (
                <Text key={c.code} style={styles.mistake}>
                  <Text style={styles.corner}>{cornerWords([c])}</Text>
                  {c.mistake ? ` · ${mistakeWords(c)}` : ''}
                </Text>
              ))}
            </View>
          ) : s.corners.length > 0 && (
            // each corner on one line ("T11-T12 0.29 s" never split), the row wrapping between them
            <View style={styles.corners}>
              <Text style={styles.corner}>Most of the gap:</Text>
              {s.corners.map((c, i) => (
                <Text key={c.code} style={styles.corner} numberOfLines={1}>{`${i ? '· ' : ''}${cornerWords([c])}`}</Text>
              ))}
            </View>
          )}
        {on && <Text style={styles.onShow}>On show below ↓</Text>}
      </View>
    </Pressable>
  );
}

function LapLine({ lap, color }: { lap: SuggestedLap; color: string }) {
  const styles = useStyles();
  return (
    <View style={styles.lapLine}>
      <LineKey color={color} />
      <DriverTag tag={tag(lap.driver)} run={lap.run} />
      <Text style={styles.lapTime}>{formatLap(lap.time)}</Text>
      <Text style={styles.lapWords} numberOfLines={2}>{lapWords(lap)}</Text>
    </View>
  );
}

// ---------- the comparison ----------

function Comparison({ laps, picked, data, error, waiting, answer, onTraces }: {
  laps: LapPick[];
  picked: Suggestion | null;
  data: CompareResult | null;
  error: string | null;
  waiting: boolean;
  answer: Suggestions | null;
  onTraces: (y: number) => void; // scroll to the traces, y within the comparison
}) {
  const styles = useStyles();
  const wide = useWide();
  const colors = useLapColors(laps.map((_, i) => i));
  const [focus, setFocus] = useState(0);
  const [zoom, setZoom] = useState<string | null>(null);
  const [cursor, setCursor] = useState<number | null>(null);
  const key = encodePicks(laps);
  // a new comparison opens on the whole lap, on the lap that loses time (a suggestion's slower lap)
  useEffect(() => {
    setFocus(picked?.slower ?? 0);
    setZoom(null);
    setCursor(null);
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps -- once per comparison
  const step = data?.traces.step_m ?? 5;
  // a section shown from Where the time is or the section times: the traces zoomed to it, scrolled to (as on the
  // Compare page)
  const tracesY = useRef(0);
  const showSection = useCallback((code: string | null, at?: number) => {
    setZoom(code);
    setCursor(at != null ? Math.round(at / step) : null);
    onTraces(tracesY.current - 8);
  }, [step, onTraces]);
  // what the technique check found at the suggestion's corners, on its slower lap: shown with that lap's sections
  const notes = useMemo(() => mistakeNotes(picked?.corners ?? null), [picked]);

  if (laps.length < MIN_LAPS) {
    return answer && (
      <Section no={2} title="The comparison">
        <Note>{answer.suggestions.length ? 'Tap a suggestion above, or pick laps below.'
          : 'Pick two laps or more below to compare them.'}</Note>
      </Section>
    );
  }
  const busy = error ? <ErrorLine>{`Can’t compare these laps: ${error}`}</ErrorLine> : (
    <View style={styles.working}>
      <ActivityIndicator />
      <Note>{waiting ? 'Finding where the time is…' : 'Placing the laps on one line…'}</Note>
    </View>
  );
  const fastest = data ? Math.min(...data.laps.map((l) => l.time)) : null;
  return (
    <>
      <Section no={2} title="The comparison"
        dek={picked ? suggestionTitle(picked, codeOf) : 'The laps you picked, on one line.'}>
        <View style={wide ? styles.vs : undefined}>
          <View style={styles.vsLaps}>
            {picked ? picked.laps.map((l, i) => <LapLine key={i} lap={l} color={colors.laps[i]} />)
              : data?.laps.map((l, i) => (
                <View key={i} style={styles.lapLine}>
                  <LineKey color={colors.laps[i]} />
                  <DriverTag tag={tag(l.driver)} run={l.session} />
                  <Text style={styles.lapTime}>{formatLap(l.time)}</Text>
                  <Text style={styles.lapWords} numberOfLines={2}>
                    {`${l.session} · lap ${l.lap}${fastest != null && l.time > fastest ? ` · ${signedSeconds(l.time - fastest)}` : ''}`}
                  </Text>
                </View>
              ))}
          </View>
          {picked && (
            <Fig label="Apart" value={picked.gap_s.toFixed(2)} unit="s" size={wide ? 64 : 52}
              style={wide ? styles.vsFig : styles.vsFigPhone} />
          )}
        </View>
        {data?.numbering === 'detected' && <Note style={styles.note}>{DETECTED_CORNERS_NOTE}</Note>}
        <View style={styles.links}>
          <TextLink href={{ pathname: '/compare', params: { laps: key } }} label="Open on the Compare page" arrow />
        </View>
      </Section>
      {data ? (
        <>
          <WhereTheTimeIs no={3} data={data} colors={colors} focus={Math.min(focus, data.laps.length - 1)}
            onFocus={setFocus} onShow={showSection} notes={picked && focus === picked.slower ? notes : undefined} />
          <SectionTable no={4} data={data} colors={colors} onPick={(code) => showSection(code)} />
          <View onLayout={(e: LayoutChangeEvent) => (tracesY.current = e.nativeEvent.layout.y)}>
            <CompareTraces no={5} data={data} colors={colors} zoom={zoom} onZoom={setZoom} cursor={cursor}
              onCursor={setCursor} />
          </View>
        </>
      ) : (
        <Section no={3} title="Where the time is">{busy}</Section>
      )}
    </>
  );
}

// ---------- laps picked by hand ----------

function PickYourOwn({ sessions, picks, onPicks, onCompare }: {
  sessions: PickSession[] | null;
  picks: LapPick[];
  onPicks: (p: LapPick[]) => void;
  onCompare: () => void;
}) {
  const styles = useStyles();
  // the latest session open, the others folded
  const [open, setOpen] = useState<Set<string> | null>(null);
  const opened = open ?? new Set(sessions?.length ? [sessions[sessions.length - 1].code] : []);
  const toggle = (code: string) => {
    const next = new Set(opened);
    if (next.has(code)) next.delete(code);
    else next.add(code);
    setOpen(next);
  };
  const key = encodePicks(picks);
  return (
    <Section no={6} title="Pick your own laps"
      dek={`Any ${MIN_LAPS} to ${MAX_LAPS} laps of the weekend, session by session: tick them, then Compare. Each run’s quickest lap is on purple; laps that aren’t clean are in grey.`}>
      {!sessions && <ActivityIndicator style={styles.left} />}
      {sessions?.length === 0 && <Note>No timed laps yet: upload the logs of a session on the Upload page.</Note>}
      {sessions?.map((p) => {
        const drivers = [...new Set(p.runs.map((r) => codeOf(r.driver)).filter(Boolean))].join(', ');
        const best = Math.min(...p.runs.flatMap((r) => r.laps.filter((l) => l.clean).map((l) => l.time)));
        const facts = [drivers || null, `${p.runs.length} run${p.runs.length === 1 ? '' : 's'}`,
          Number.isFinite(best) ? `best ${formatLap(best)}` : null].filter(Boolean).join(' · ');
        return (
          <View key={p.code}>
            <SubFoldHead title={p.title} facts={facts} open={opened.has(p.code)} onToggle={() => toggle(p.code)}
              what={`the laps of ${p.title}`} />
            {opened.has(p.code) && p.runs.map((r) => (
              <RunLaps key={r.id} run={r} picks={picks}
                onToggle={(lap) => onPicks(toggleLap(picks, { session_id: r.id, lap }, MAX_LAPS))} />
            ))}
          </View>
        );
      })}
      {sessions && sessions.length > 0 && (
        <View style={styles.pickBar}>
          <Text style={styles.pickCount}>
            {picks.length >= MIN_LAPS ? `${picks.length} laps ticked` : picks.length === 1 ? '1 lap: tick another'
              : 'No laps ticked'}
          </Text>
          <TextLink label="Compare" red arrow onPress={onCompare} disabled={picks.length < MIN_LAPS} />
          {picks.length >= MIN_LAPS && (
            <TextLink href={{ pathname: '/compare', params: { laps: key } }} label="On the Compare page" arrow small />
          )}
          {picks.length > 0 && <TextLink label="Clear" small onPress={() => onPicks([])} />}
        </View>
      )}
    </Section>
  );
}

function RunLaps({ run, picks, onToggle }: { run: PickRun; picks: LapPick[]; onToggle: (lap: number) => void }) {
  const styles = useStyles();
  const theme = useTheme();
  const clean = run.laps.filter((l) => l.clean);
  const best = clean.length ? clean.reduce((a, b) => (b.time < a.time ? b : a)).number : null;
  const full = picks.length >= MAX_LAPS;
  return (
    <View style={styles.pickRun}>
      <View style={styles.pickRunHead}>
        <DriverTag tag={tag(run.driver)} run={run.name} />
        <Text style={styles.pickRunName} numberOfLines={1}>{run.name}</Text>
        <Text style={styles.pickRunTyres}>{`${run.tyres} tyres${run.tyres_sure === false ? ' (guess)' : ''}`}</Text>
      </View>
      <View style={styles.lapChoices}>
        {run.laps.map((l) => {
          const on = picks.some((p) => p.session_id === run.id && p.lap === l.number);
          return (
            <Choice key={l.number} label={`L${l.number}`} detail={formatLap(l.time)} on={on} dim={!l.clean}
              disabled={full && !on} onPress={() => onToggle(l.number)}
              fill={l.number === best ? theme.timing.best : undefined}
              ink={l.number === best ? theme.timing.onBest : undefined}
              accessibilityLabel={`${run.name} lap ${l.number}, ${formatLap(l.time)}${l.number === best ? ', the run’s best' : ''}${l.clean ? '' : ', not clean'}${on ? ', ticked' : ''}`} />
          );
        })}
      </View>
    </View>
  );
}

const useStyles = themed((c) => ({
  grow: { flex: 1, minWidth: 0 },
  left: { alignSelf: 'flex-start', marginTop: 8 },
  note: { marginTop: 10 },
  working: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 14 },
  links: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: 22, rowGap: 12, marginTop: 18 },

  // the suggestions: ruled rows, the one on show marked with the programme's red rule
  list: { borderTopWidth: 1, borderColor: c.rule, maxWidth: 820 },
  row: { flexDirection: 'row', alignItems: 'flex-start', gap: 12, minHeight: TAP, paddingVertical: 14,
    paddingLeft: 10, borderBottomWidth: 1, borderColor: c.separator, borderLeftWidth: 4, borderLeftColor: 'transparent' },
  rowOn: { borderLeftColor: c.mark },
  rowNo: { fontFamily: Fonts.display, fontSize: 24, lineHeight: 28, width: 30, color: c.text },
  rowHead: { flexDirection: 'row', alignItems: 'baseline', gap: 12, marginBottom: 6 },
  rowTitle: { ...Type.label, fontSize: 16, letterSpacing: 1.2, color: c.text, flex: 1 },
  rowGap: { ...Type.number, fontFamily: face('label', 700), fontSize: 18, color: c.text },
  corners: { flexDirection: 'row', flexWrap: 'wrap', columnGap: 6, marginTop: 6 },
  corner: { fontFamily: face('body', 600), fontSize: 17, lineHeight: 24, color: c.text, flexShrink: 0 },
  cornerList: { marginTop: 6 },
  mistake: { fontFamily: Fonts.body, fontSize: 17, lineHeight: 24, color: c.text },
  cornersWaiting: { fontFamily: Fonts.body, fontSize: 16, lineHeight: 22, color: c.textSecondary, marginTop: 6 },
  onShow: { ...Type.label, fontSize: 14, color: c.textSecondary, marginTop: 6 },

  lapLine: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: 10, rowGap: 2, paddingVertical: 3 },
  lapTime: { ...Type.number, fontFamily: face('label', 700), fontSize: 18, color: c.text },
  lapWords: { fontFamily: face('label', 400), fontSize: 16, lineHeight: 21, color: c.textSecondary, flexShrink: 1 },

  // the comparison's laps
  vs: { flexDirection: 'row', alignItems: 'flex-end', gap: 32 },
  vsLaps: { flex: 1, minWidth: 0, maxWidth: 640, borderTopWidth: 1, borderColor: c.rule, paddingTop: 8 },
  vsFig: { paddingLeft: 28, borderLeftWidth: 1, borderColor: c.rule },
  vsFigPhone: { borderTopWidth: 1, borderColor: c.rule, paddingTop: 10, marginTop: 14 },

  // laps by hand
  pickRun: { borderBottomWidth: 1, borderColor: c.separator, paddingVertical: 12, gap: 10 },
  pickRunHead: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'baseline', columnGap: 10, rowGap: 4 },
  pickRunName: { fontFamily: Type.label.fontFamily, fontSize: 17, letterSpacing: 0.3, color: c.text, flexShrink: 1 },
  pickRunTyres: { fontFamily: face('label', 400), fontSize: 16, color: c.textSecondary },
  lapChoices: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: 14, rowGap: 10 },
  pickBar: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: 22, rowGap: 12, marginTop: 18,
    borderTopWidth: 3, borderColor: c.rule, paddingTop: 12 },
  pickCount: { ...Type.label, fontSize: 16, color: c.text },
}));
