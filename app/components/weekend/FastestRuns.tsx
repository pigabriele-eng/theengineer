// The During tab's comparison after a session (Gabriele, 2026-10-08: "latest run vs best is also not helpful, the
// standard after a session is a comparison between fastest runs within that session and a quick way to compare
// different runs"): each run's fastest lap in the latest session against the others, each driver's fastest marked and
// each run's tyres shown (like with like), then where the time is and the traces. Pick runs swaps in any other runs
// of the event with a tap; Clear goes back to the latest session's. Sections `no` to `no + 2`.
import { RefObject, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, View as Box } from 'react-native';

import { CompareTraces, LineKey, useLapColors, WhereTheTimeIs } from '@/components/CompareViews';
import { ErrorLine, Note } from '@/components/Controls';
import { Choice, useText } from '@/components/Picks';
import { Label, Section, TextLink } from '@/components/Programme';
import { Text, View } from '@/components/Themed';
import { face, themed, Type } from '@/constants/Theme';
import { CompareResult, compareLaps, encodePicks, formatLap } from '@/lib/compare';
import { codeOf } from '@/lib/driverTag';
import type { Folder } from '@/lib/events';
import { defaultRuns, driversFastest, FastRun, flipRun, MAX_RUNS, runsByPart } from '@/lib/fastestRuns';
import { afterOthers } from '@/lib/loadLast';
import { EventTyres, fetchEventTyres } from '@/lib/report';
import { EventParts, fetchParts } from '@/lib/sessionReports';
import { runsInOrder } from '@/lib/weekendRuns';

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

export default function FastestRuns({ no, eventId, folder }: { no: number; eventId: number; folder: Folder | null }) {
  const styles = useStyles();
  const t = useText();
  const at = useRef<Box>(null);
  const [parts, setParts] = useState<EventParts | null>(null);
  const [tyres, setTyres] = useState<EventTyres | null>(null);
  useEffect(() => {
    let live = true;
    fetchParts(eventId).then((x) => live && setParts(x), () => undefined);
    fetchEventTyres(eventId).then((x) => live && setTyres(x), () => undefined);
    return () => { live = false; };
  }, [eventId, folder]);

  // every timed run by session, each with its fastest lap (the event page's list knows its number)
  const byPart = useMemo(() => {
    const lap = new Map(runsInOrder(folder).map((r) => [r.id, r.best_lap ?? null]));
    return runsByPart(parts?.parts ?? [], (id) => lap.get(id) ?? null);
  }, [parts, folder]);
  const auto = useMemo(() => defaultRuns(byPart), [byPart]);
  const [picked, setPicked] = useState<number[] | null>(null); // null: the latest session's (auto)
  const [open, setOpen] = useState(false);
  const ids = picked ?? auto.ids;
  const all = useMemo(() => new Map(byPart.flatMap((p) => p.runs.map((r) => [r.id, r]))), [byPart]);
  const runs = ids.map((id) => all.get(id)).filter((r): r is FastRun => r != null);
  const fastest = driversFastest(runs);
  const tyreOf = useMemo(() => new Map((tyres?.runs ?? []).map((r) => [r.id, r.tyres])), [tyres]);
  const tyreText = (id: number) => {
    const x = tyreOf.get(id);
    return x ? `${x.label ?? x.tyres}${x.sure ? '' : '?'}` : 'Tyres not set';
  };

  // the laps on one line, made last (useLoadLast) and again a moment after the last tap
  const laps = runs.map((r) => ({ session_id: r.id, lap: r.lap }));
  const key = encodePicks(laps);
  const go = useLoadLast(at, laps.length >= 2);
  const [data, setData] = useState<CompareResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [focus, setFocus] = useState(0);
  const [zoom, setZoom] = useState<string | null>(null);
  const [cursor, setCursor] = useState<number | null>(null);
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
    }, picked ? 700 : 0);
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
  const colors = useLapColors(runs.map((_, i) => i));
  // the result shown is the one for these laps (while a new pick is worked out, the last one stays up)
  const current = data != null && data.laps.length === laps.length
    && data.laps.every((l, i) => l.session_id === laps[i].session_id && l.lap === laps[i].lap);

  const title = picked == null && auto.title ? `Fastest runs of ${auto.title}` : 'Fastest runs compared';
  if (!parts) {
    return <Section no={no} title="Fastest runs of the session"><ActivityIndicator style={styles.left} /></Section>;
  }
  if (byPart.length === 0 || all.size < 2) {
    return (
      <Section no={no} title="Fastest runs of the session">
        <Note>Two timed runs are needed: each run’s fastest lap is put against the others of its session.</Note>
      </Section>
    );
  }
  const best = runs.length ? Math.min(...runs.map((r) => r.time)) : 0;
  const waiting = error ? <ErrorLine>{`Can’t compare the laps: ${error}`}</ErrorLine>
    : laps.length < 2 ? <Note>Pick at least two runs.</Note>
      : <View style={styles.working}><ActivityIndicator /><Note>Placing the laps on one line…</Note></View>;
  return (
    <Box ref={at}>
      <Section no={no} title={title}
        dek={picked == null
          ? 'Each run’s fastest lap in the latest session, against the others; each driver’s fastest marked. Compare tyres like with like.'
          : 'The fastest lap of each run picked; each driver’s fastest marked. Compare tyres like with like.'}>
        <View style={styles.list}>
          {runs.map((r, i) => (
            <View key={r.id} style={styles.line}>
              <LineKey color={colors.laps[i]} />
              <View style={styles.grow}>
                <Text style={styles.name}>
                  {r.name}{picked != null ? ` · ${r.part}` : ''} · lap {r.lap}
                </Text>
                <Text style={t.body}>
                  {r.driver ?? 'Driver not set'} · {tyreText(r.id)} tyres
                  {fastest.has(r.id) && runs.length > 1 ? (
                    <Text style={styles.mark}>{`  ${codeOf(r.driver) ?? 'Driver'}’s fastest`}</Text>
                  ) : null}
                </Text>
              </View>
              <View style={styles.times}>
                <Text style={styles.time}>{formatLap(r.time)}</Text>
                <Text style={t.note}>{r.time === best ? 'fastest' : `+${(r.time - best).toFixed(2)} s`}</Text>
              </View>
            </View>
          ))}
        </View>
        <View style={styles.links}>
          <Choice label={open ? 'Done' : 'Pick runs'} on={false} onPress={() => setOpen(!open)}
            accessibilityLabel={open ? 'Done picking runs' : 'Pick the runs to compare'} />
          {picked != null && <Choice label="Clear" on={false} onPress={() => setPicked(null)}
            accessibilityLabel="Clear the picks: back to the fastest runs of the latest session" />}
          {laps.length >= 2 && (
            <TextLink href={{ pathname: '/compare', params: { laps: key } }} label="Open the full comparison" arrow red />
          )}
        </View>
        {open && (
          <View style={styles.pick}>
            {byPart.map(({ part, runs: rs }) => (
              <View key={part.code} style={styles.pickRow} accessibilityRole="toolbar"
                accessibilityLabel={`Pick runs of ${part.title}`}>
                <Label small>{part.title}</Label>
                <View style={styles.choices}>
                  {rs.map((r) => {
                    const on = ids.includes(r.id);
                    return (
                      <Choice key={r.id} label={r.name} on={on}
                        detail={`${codeOf(r.driver) ?? '?'} · ${tyreText(r.id)} · ${formatLap(r.time)}`}
                        disabled={!on && ids.length >= MAX_RUNS}
                        onPress={() => setPicked(flipRun(ids, r.id))}
                        accessibilityLabel={`${r.name}, ${r.driver ?? 'driver not set'}: ${tyreText(r.id)} tyres, fastest lap ${formatLap(r.time)}`} />
                    );
                  })}
                </View>
              </View>
            ))}
            <Text style={t.body}>Tap a run to add its fastest lap or take it off: up to {MAX_RUNS} at once.</Text>
          </View>
        )}
      </Section>
      {current && data ? (
        <>
          <WhereTheTimeIs no={no + 1} data={data} colors={colors} focus={focus} onFocus={setFocus} onShow={show} />
          <CompareTraces no={no + 2} data={data} colors={colors} zoom={zoom} onZoom={setZoom}
            cursor={cursor} onCursor={setCursor} />
        </>
      ) : (
        <>
          <Section no={no + 1} title="Where the time is">{waiting}</Section>
          <Section no={no + 2} title="Traces">{waiting}</Section>
        </>
      )}
    </Box>
  );
}

const useStyles = themed((c) => ({
  left: { alignSelf: 'flex-start', marginTop: 12 },
  grow: { flex: 1, minWidth: 0 },
  working: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  list: { borderTopWidth: 1, borderColor: c.rule, maxWidth: 820 },
  line: { flexDirection: 'row', alignItems: 'center', gap: 12, borderBottomWidth: 1, borderColor: c.separator,
    paddingVertical: 10 },
  name: { fontFamily: face('body', 600), fontSize: 17, lineHeight: 22, color: c.text },
  mark: { fontFamily: face('label', 700), fontSize: 16, color: c.text },
  times: { alignItems: 'flex-end' },
  time: { ...Type.number, fontFamily: face('label', 700), fontSize: 20, color: c.text },
  links: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: 22, rowGap: 12, marginTop: 16 },
  pick: { gap: 14, marginTop: 14, paddingTop: 14, borderTopWidth: 1, borderColor: c.rule },
  pickRow: { gap: 6 },
  choices: { flexDirection: 'row', flexWrap: 'wrap', columnGap: 10, rowGap: 8 },
}));
