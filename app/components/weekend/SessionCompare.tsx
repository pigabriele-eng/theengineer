// The During tab's first sections (Gabriele, 2026-10-08: the During tab "should open on: full comparison of the session
// uploaded latest with traces; full comparison should flag laps that have better sections"): every clean lap of the
// official session holding the run uploaded last (FP1, Q1, R1..., server/app/session_sections.py), stint by stint,
// each with its driver, its run's tyres (a tap on the stint's tag changes them, components/TyreTag.tsx), its time and
// its gap to the session's fastest lap. A lap holding the session's best time in a corner is flagged in words with
// those corners and what it gained there on the fastest lap, biggest gain first. Then the quickest lap in each corner, then where the time is and the traces
// of the laps picked: each stint's fastest lap at first, any lap with a tap. Real laps only, never a summed lap
// (lib/sessionLaps.ts). Sections `no` to `no + 3`; only `no` before the event has a timed run (lib/weekendRuns.ts
// duringSections).
import { RefObject, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, View as Box, StyleSheet } from 'react-native';

import { CompareTraces, LineKey, useLapColors, WhereTheTimeIs } from '@/components/CompareViews';
import { ErrorLine, Note } from '@/components/Controls';
import { TickBox, useText } from '@/components/Picks';
import { Label, Section, TextLink } from '@/components/Programme';
import { Text, View } from '@/components/Themed';
import { TyreChoices, TyreTag, TyreTags, useTyreTags } from '@/components/TyreTag';
import { face, TAP, themed, Type } from '@/constants/Theme';
import { CompareResult, compareLaps, encodePicks, formatLap } from '@/lib/compare';
import { codeOf } from '@/lib/driverTag';
import type { Folder } from '@/lib/events';
import { afterOthers } from '@/lib/loadLast';
import { poll } from '@/lib/poll';
import { fetchLatestSession } from '@/lib/sessionCompare';
import {
  addPick, bestFlags, bestInEachCorner, defaultPicks, fastestSections, flagWords, flipPick, gapWords,
  isFastest, lapKey, LapPick, LapRef, LatestSession, MAX_PICKS, MIN_GAIN_S, seconds, SessionLap, SessionRun,
} from '@/lib/sessionLaps';
import { TYRE_LABEL } from '@/lib/tyreLevels';
import { tyreTag } from '@/lib/tyreTag';
import { sessionCompareSections } from '@/lib/weekendRuns';
import { a11yState } from '@/lib/a11yState';

const FULL = `${MAX_PICKS} laps are on the traces already: take one off first.`;

/** True once the section is near the screen (on the web), or once the page's other reads have answered: the heavy
 * read it needs then loads last, and doesn't hold up the answers above it on the server. Stays true. */
function useLoadLast(ref: RefObject<Box | null>, on: boolean) {
  const [go, setGo] = useState(false);
  useEffect(() => {
    if (!on || go) return;
    const stop = afterOthers(() => setGo(true));
    const node = ref.current as unknown;
    let seen: IntersectionObserver | undefined;
    if (typeof IntersectionObserver !== 'undefined' && typeof Element !== 'undefined' && node instanceof Element) {
      seen = new IntersectionObserver((es) => es.some((e) => e.isIntersecting) && setGo(true),
        { rootMargin: '0px 0px 200px 0px' });
      seen.observe(node);
    }
    return () => {
      stop();
      seen?.disconnect();
    };
  }, [on, go]); // eslint-disable-line react-hooks/exhaustive-deps -- the ref is the section's, for good
  return go;
}

export default function SessionCompare({ no, eventId, folder }: { no: number; eventId: number; folder: Folder | null }) {
  const styles = useStyles();
  const t = useText();
  const traces = useRef<Box>(null);
  const tags = useTyreTags(eventId); // the event's tyres, shared with the page's run list

  // the session's laps at once, their section times once worked out (asked again meanwhile, lib/poll.ts); read again
  // when the event's runs change (an upload)
  const [answer, setAnswer] = useState<LatestSession | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  useEffect(() => {
    const stop = poll((wanted) => fetchLatestSession(eventId).then((a) => {
      if (!wanted()) return false;
      setAnswer(a);
      setFailed(null);
      return a.status === 'working';
    }, (e) => {
      if (wanted()) setFailed((e as Error).message);
      return false;
    }));
    return stop;
  }, [eventId, folder]);

  // the laps on the traces: each stint's fastest at first, then as tapped (for this session's laps only)
  const sessionKey = answer?.session ? `${answer.session.code}|${answer.runs.map((r) => r.id).join(',')}` : '';
  const auto = useMemo(() => (answer ? defaultPicks(answer.runs) : []),
    [sessionKey]); // eslint-disable-line react-hooks/exhaustive-deps -- the session's runs, by value
  const [own, setOwn] = useState<{ key: string; picks: LapPick[] } | null>(null);
  const picks = own?.key === sessionKey ? own.picks : auto;
  const [full, setFull] = useState<'laps' | 'corners' | null>(null);
  const flip = (l: LapRef) => {
    const r = flipPick(picks, l);
    setFull(r.full ? 'laps' : null);
    if (!r.full) setOwn({ key: sessionKey, picks: r.picks });
  };
  const add = (l: LapRef) => {
    const r = addPick(picks, l);
    setFull(r.full ? 'corners' : null);
    if (!r.full) setOwn({ key: sessionKey, picks: r.picks });
  };
  const palette = useLapColors([0, 1, 2, 3, 4, 5]).laps;
  const colorOf = (l: LapRef) => {
    const p = picks.find((x) => x.session_id === l.session_id && x.lap === l.lap);
    return p ? palette[p.slot % palette.length] : null;
  };

  // the picked laps on one line, made last (useLoadLast) and again a moment after the last tap
  const laps = picks.map((p) => ({ session_id: p.session_id, lap: p.lap }));
  const key = encodePicks(laps);
  const go = useLoadLast(traces, laps.length >= 2);
  const [data, setData] = useState<CompareResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [focus, setFocus] = useState(0);
  const [zoom, setZoom] = useState<string | null>(null);
  const [cursor, setCursor] = useState<number | null>(null);
  const tapped = own != null;
  useEffect(() => {
    if (!go || laps.length < 2) return;
    let live = true;
    const id = setTimeout(() => {
      setError(null);
      compareLaps(laps).then((d) => {
        if (!live) return;
        setData(d);
        setFocus(0);
        setZoom(null);
        setCursor(null);
      }, (e) => live && setError((e as Error).message));
    }, tapped ? 700 : 0);
    return () => {
      live = false;
      clearTimeout(id);
    };
  }, [key, go]); // eslint-disable-line react-hooks/exhaustive-deps -- the laps, by value
  const step = data?.traces.step_m ?? 5;
  const show = useCallback((code: string | null, x?: number) => {
    setZoom(code);
    setCursor(x != null ? Math.round(x / step) : null);
  }, [step]);
  const colors = useLapColors(picks.map((p) => p.slot));
  // the result shown is the one for these laps (while a new pick is worked out, the sections say so)
  const current = data != null && data.laps.length === laps.length
    && data.laps.every((l, i) => l.session_id === laps[i].session_id && l.lap === laps[i].lap);

  // four sections once the event has a timed run, else one, as the page numbers them (lib/weekendRuns.ts)
  const four = sessionCompareSections(folder) === 4;
  const title = answer?.session ? `${answer.session.title}: every lap` : 'Latest session: every lap';
  if (!answer || answer.status === 'empty' || answer.runs.length === 0) {
    const body = failed ? <ErrorLine>{`Can’t read the latest session: ${failed}`}</ErrorLine>
      : !answer ? <ActivityIndicator style={styles.left} />
        : <Note>No timed run yet: every lap of the latest session shows here once its log is uploaded.</Note>;
    return (
      <>
        <Section no={no} title={title}>{body}</Section>
        {four && <Section no={no + 1} title="Best in each corner">{body}</Section>}
        {four && <Section no={no + 2} title="Where the time is">{body}</Section>}
        {four && <Section no={no + 3} title="Traces">{body}</Section>}
      </>
    );
  }

  const fast = fastestSections(answer);
  const fastest = answer.fastest;
  const fastRun = fastest ? answer.runs.find((r) => r.id === fastest.session_id) : undefined;
  const working = answer.status === 'working';
  const progress = answer.progress?.total ? ` ${answer.progress.done} of ${answer.progress.total}` : '';
  const finding = (
    <View style={styles.working} accessibilityLiveRegion="polite">
      <ActivityIndicator />
      <Note>{`Finding each lap’s time in every corner…${progress}`}</Note>
    </View>
  );
  const flags = bestFlags(answer);
  const flagged = flags.size;
  const leftOut = answer.left_out === 0 ? 'every lap is clean'
    : `${answer.left_out} ${answer.left_out === 1 ? 'lap' : 'laps'} that aren’t clean left out`;
  const tyreText = (id: number) => tyreTag(tags.rowOf(id), TYRE_LABEL)?.text ?? 'Tyres not set';
  const waiting = error ? <ErrorLine>{`Can’t compare the laps: ${error}`}</ErrorLine>
    : laps.length < 2 ? <Note>Put at least two laps on the traces: tap them in the list above.</Note>
      : <View style={styles.working}><ActivityIndicator /><Note>Placing the laps on one line…</Note></View>;
  return (
    <>
      <Section no={no} title={title}
        dek={`Every clean lap of the session, stint by stint, against its fastest lap (${leftOut}). A flag marks a lap with the session’s best time in a corner, and what it gained there on the fastest lap; tap a lap to put it on the traces or take it off.`}>
        {fastest && fastRun && (
          <Text style={StyleSheet.flatten([t.body, styles.summary])}>
            <Text style={t.strong}>{`Fastest: ${formatLap(fastest.time)}`}</Text>
            {`, lap ${fastest.lap} of ${fastRun.name} (${fastRun.driver ?? 'driver not set'}).`}
            {!working && fast ? ` ${flagged === 0 ? 'It is also the quickest lap in every corner.'
              : `${flagged} other ${flagged === 1 ? 'lap holds' : 'laps hold'} the session’s best in a corner.`}` : ''}
          </Text>
        )}
        {working && finding}
        {answer.note && <Note style={styles.noteGap}>{answer.note}</Note>}
        <View style={styles.list}>
          {answer.runs.map((r) => (
            <View key={r.id} style={styles.stint}>
              <StintHead run={r} tags={tags} />
              {r.laps.map((l) => {
                const ref = { session_id: r.id, lap: l.number };
                return (
                  <LapRow key={l.number} run={r} lap={l} tyres={tyreText(r.id)} color={colorOf(ref)}
                    best={isFastest(answer, ref)} fastest={fastest?.time ?? null}
                    flag={flagWords(flags.get(lapKey(ref)))} onPress={() => flip(ref)} />
                );
              })}
            </View>
          ))}
        </View>
        {full === 'laps' && <Text style={styles.full} accessibilityLiveRegion="polite">{FULL}</Text>}
        <View style={styles.links}>
          <Text style={t.note}>{`${picks.length} of ${MAX_PICKS} laps on the traces`}</Text>
          {laps.length >= 2 && (
            <TextLink href={{ pathname: '/compare', params: { laps: key } }} label="Open on the Compare page" arrow />
          )}
        </View>
      </Section>
      <Section no={no + 1} title="Best in each corner"
        dek={`The session’s quickest lap in each section and what it gained on the fastest lap (${MIN_GAIN_S.toFixed(2)} s or more); tap one to put it on the traces.`}>
        {working ? finding : !fast ? <Note>{answer.note ?? 'Two clean laps are needed to compare the corners.'}</Note> : (
          <View style={styles.list}>
            {bestInEachCorner(answer).map((b) => {
              const ref = { session_id: b.run.id, lap: b.lap.number };
              const color = colorOf(ref);
              const who = `${b.run.name} · lap ${b.lap.number} · ${b.run.driver ?? 'driver not set'}`;
              return (
                <Pressable key={b.code} onPress={() => add(ref)} accessibilityRole="button" style={styles.corner}
                  accessibilityLabel={`${b.code}: ${b.fastest ? 'the fastest lap is the quickest here' : `${who}, ${seconds(b.gain)} on the fastest lap`}. ${color ? 'On the traces' : 'Put it on the traces'}`}>
                  <Text style={styles.code}>{b.code}</Text>
                  <View style={styles.grow}>
                    <Text style={styles.cornerWho}>{b.fastest ? 'The fastest lap itself' : who}</Text>
                    {!b.fastest && <Text style={styles.gain}>{`${seconds(b.gain)} on the fastest lap`}</Text>}
                  </View>
                  <View style={styles.cornerState}>
                    {color && <LineKey color={color} />}
                    <Text style={styles.cornerGo}>{color ? 'On the traces' : 'Add →'}</Text>
                  </View>
                </Pressable>
              );
            })}
          </View>
        )}
        {full === 'corners' && <Text style={styles.full} accessibilityLiveRegion="polite">{FULL}</Text>}
      </Section>
      <Box ref={traces}>
        {current && data ? (
          <>
            <WhereTheTimeIs no={no + 2} data={data} colors={colors} focus={focus} onFocus={setFocus} onShow={show} />
            <CompareTraces no={no + 3} data={data} colors={colors} zoom={zoom} onZoom={setZoom}
              cursor={cursor} onCursor={setCursor} />
          </>
        ) : (
          <>
            <Section no={no + 2} title="Where the time is">{waiting}</Section>
            <Section no={no + 3} title="Traces">{waiting}</Section>
          </>
        )}
      </Box>
    </>
  );
}

/** A stint's head: its name, its driver and its tyres (a tap on them opens the four levels under it). */
function StintHead({ run, tags }: { run: SessionRun; tags: TyreTags }) {
  const styles = useStyles();
  const t = useText();
  const best = Math.min(...run.laps.map((l) => l.time));
  return (
    <>
      <View style={styles.stintHead}>
        <Label style={styles.stintName}>{run.name}</Label>
        <View style={styles.who}>
          <Text style={t.body}>{`${run.driver ?? 'Driver not set'} ·`}</Text>
          {tags.rowOf(run.id) ? <TyreTag tags={tags} id={run.id} run={run.name} size={16} />
            : <Text style={t.body}>Tyres not set</Text>}
          <Text style={t.note}>{`· ${run.laps.length} ${run.laps.length === 1 ? 'lap' : 'laps'}, best ${formatLap(best)}`}</Text>
        </View>
      </View>
      <TyreChoices tags={tags} id={run.id} name={run.name} style={styles.choices} />
    </>
  );
}

/** One lap: a tap puts it on the traces or takes it off. Its driver, its run's tyres, its time and gap, and its flag
 * (the corners where it holds the session’s best), in words. */
function LapRow({ run, lap, tyres, color, best, fastest, flag, onPress }: {
  run: SessionRun;
  lap: SessionLap;
  tyres: string;
  color: string | null; // its colour on the traces, null when it isn't on them
  best: boolean;
  fastest: number | null;
  flag: string | null;
  onPress: () => void;
}) {
  const styles = useStyles();
  const gap = gapWords(lap.time, fastest, best);
  const driver = run.driver ?? 'driver not set';
  return (
    <Pressable onPress={onPress} accessibilityRole="checkbox" {...a11yState({ checked: color != null })}
      accessibilityLabel={`Lap ${lap.number} of ${run.name} on the traces: ${driver}, ${tyres.replace('?', ' (a guess)')} tyres, ${formatLap(lap.time)}, ${best ? 'the fastest lap' : `${gap} on the fastest lap`}.${flag ? ` ${flag}.` : ''}`}
      style={styles.lap}>
      <View style={styles.lapLine}>
        <TickBox on={color != null} size={20} />
        <View style={styles.keyBox}>{color ? <LineKey color={color} /> : null}</View>
        <Text style={styles.lapNo}>{`L${lap.number}`}</Text>
        <Text style={styles.lapWho} numberOfLines={1}>{`${codeOf(run.driver) ?? 'No driver'} · ${tyres}`}</Text>
        <Text style={styles.lapTime}>{formatLap(lap.time)}</Text>
        <Text style={best ? styles.gapBest : styles.gap}>{gap}</Text>
      </View>
      {flag && (
        <View style={styles.flag}>
          <Text style={styles.flagText}>{flag}</Text>
        </View>
      )}
    </Pressable>
  );
}

const useStyles = themed((c) => ({
  left: { alignSelf: 'flex-start', marginTop: 12 },
  grow: { flex: 1, minWidth: 0 },
  working: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 12 },
  summary: { marginBottom: 14, maxWidth: 820 },
  noteGap: { marginBottom: 12 },
  list: { borderTopWidth: 1, borderColor: c.rule, maxWidth: 820 },
  links: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: 22, rowGap: 12, marginTop: 16 },
  full: { fontFamily: face('body', 600), fontSize: 16, lineHeight: 22, color: c.error, marginTop: 12 },

  // a stint: its head over a rule, then its laps
  stint: { paddingTop: 16 },
  stintHead: { gap: 2, borderBottomWidth: 2, borderColor: c.rule, paddingBottom: 4 },
  stintName: { color: c.text },
  // the driver, the tyres (a tag: a tap changes them) and the stint's laps, wrapping on a phone
  who: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: 6 },
  choices: { paddingTop: 10 },

  // a lap: a 44 px tap target or more
  lap: { minHeight: TAP, justifyContent: 'center', paddingVertical: 8, borderBottomWidth: 1, borderColor: c.separator },
  lapLine: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  keyBox: { width: 18, alignItems: 'center' },
  lapNo: { ...Type.number, fontFamily: face('label', 700), fontSize: 16, color: c.text, minWidth: 30 },
  lapWho: { fontFamily: face('label', 500), fontSize: 15, color: c.textSecondary, flex: 1, minWidth: 0 },
  lapTime: { ...Type.number, fontSize: 17, color: c.text },
  gap: { ...Type.number, fontSize: 15, color: c.textSecondary, minWidth: 64, textAlign: 'right' },
  gapBest: { ...Type.label, fontSize: 13, color: c.text, minWidth: 64, textAlign: 'right' },
  // the flag: a rule in the "better" colour and the words beside it (never the colour alone)
  flag: { marginTop: 6, marginLeft: 30, borderLeftWidth: 3, borderColor: c.success, paddingLeft: 8 },
  flagText: { fontFamily: face('body', 600), fontSize: 16, lineHeight: 22, color: c.success },

  // the best in each corner
  corner: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: TAP + 8, paddingVertical: 8,
    borderBottomWidth: 1, borderColor: c.separator },
  code: { ...Type.label, fontSize: 15, color: c.text, width: 74 },
  cornerWho: { fontFamily: face('body', 600), fontSize: 16, lineHeight: 21, color: c.text },
  gain: { ...Type.number, fontSize: 15, color: c.success, marginTop: 2 },
  cornerState: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  cornerGo: { ...Type.link, fontSize: 13, color: c.text },
}));
