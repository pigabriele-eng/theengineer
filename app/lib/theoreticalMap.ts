// The theoretical laps' corner map (Gabriele, 2026-10-15: "the theoretical stint and combined theoretical and an easy
// to identify way to know which corner belongs to which lap of which driver", and "technique suggestions or line
// suggestions in natural text based on the driven theoretical best"): from POST /compare/theoretical (lib/theoretical.ts),
// each corner's lap in each stint theoretical and in the combined theoretical, its driver and what it gains there, the
// real laps to show on the racing line, and each tip in words. Pure, so `npm test` checks it; drawn by
// components/weekend/TheoreticalMap.tsx.
import type { Theoretical, TheoreticalAnswer, Tip } from './theoretical';

const STINT = 'stint theoretical'; // as lib/theoretical.ts STINT: the name Gabriele gave it

/** The page's own name and driver for a run (lib/sessionLaps.ts SessionRun), when it knows it. */
export type RunInfo = { id: number; name: string; driver: string | null };
export type LapRef = { session_id: number; lap: number };

/** A stint of the answer, named as the page names it. */
export type Stint = { run: string; sessionId: number; name: string; driver: string | null; code: string | null;
  ready: boolean };

/** The answer's stints, with the page's names and drivers where it has them (the page's are set later than the
 * answer may have been made); `code` makes a driver's short code (lib/driverTag.ts driverCode). */
export function stintsOf(answer: TheoreticalAnswer, runs: RunInfo[], code: (name: string) => string): Stint[] {
  return answer.stints.map((s) => {
    const r = runs.find((x) => x.id === s.session_id);
    const driver = r ? r.driver : s.driver;
    return { run: s.run, sessionId: s.session_id, name: r?.name ?? s.session, driver,
      code: driver ? code(driver) : null, ready: s.ready };
  });
}

/** "stint theoretical · R1 stint 1 (PIA)", as Gabriele named it. */
export const stintTitle = (s: Stint) => `${STINT} · ${s.name} (${s.code ?? 'no driver'})`;

/** The key a driver's laps are coloured by: the driver's code, or the stint where nobody set the driver (so two
 * stints without a driver never share a colour and a name). */
export type DriverKey = { key: string; label: string };
export const keyOf = (s: Stint): DriverKey => (s.code ? { key: s.code, label: s.code } : { key: `run:${s.run}`,
  label: `${s.name}, no driver` });

/** The drivers of these stints, each once, in the order they first drove. */
export function driverKeys(stints: Stint[]): DriverKey[] {
  const out: DriverKey[] = [];
  for (const s of stints) {
    const k = keyOf(s);
    if (!out.some((x) => x.key === k.key)) out.push(k);
  }
  return out;
}

/** The lap holding a corner of a theoretical: its stint, its number, what it gains there on the real lap the
 * theoretical is told from (null when the answer doesn't say), and whether it is that lap itself. */
export type Holder = { stint: Stint; lap: number; gain: number | null; itself: boolean };
export type CornerRow = { code: string; stints: (Holder | null)[]; combined: Holder | null; laps: LapRef[] };

const lapRef = (stints: Stint[], run: string, lap: number): LapRef | null => {
  const s = stints.find((x) => x.run === run);
  return s ? { session_id: s.sessionId, lap } : null;
};

function holder(t: Theoretical, k: number, stints: Stint[]): Holder | null {
  const [run, lap] = t.from[k] ?? [];
  const stint = stints.find((s) => s.run === run);
  if (!stint || lap == null) return null;
  return { stint, lap, gain: t.gains?.[k] ?? null, itself: run === t.best_run && lap === t.best_lap };
}

/** One row per corner section, in track order: the lap holding it in each stint theoretical (null for a stint not
 * ready) and in the combined theoretical, and the real laps a tap shows on the racing line: the combined theoretical's
 * holder and the fastest lap first, then each stint's holder and its fastest lap, each lap once. */
export function cornerRows(answer: TheoreticalAnswer, stints: Stint[]): CornerRow[] {
  return answer.sections.map((code, k) => {
    const cells = answer.stints.map((s) => (s.ready ? holder(s, k, stints) : null));
    const combined = answer.combined ? holder(answer.combined, k, stints) : null;
    const pairs: [string, number][] = [];
    if (answer.combined) pairs.push(answer.combined.from[k], [answer.combined.best_run, answer.combined.best_lap]);
    answer.stints.forEach((s) => s.ready && pairs.push(s.from[k], [s.best_run, s.best_lap]));
    const laps: LapRef[] = [];
    for (const [run, lap] of pairs) {
      const ref = lapRef(stints, run, lap);
      if (ref && !laps.some((l) => l.session_id === ref.session_id && l.lap === ref.lap)) laps.push(ref);
    }
    return { code, stints: cells, combined, laps };
  });
}

/** How many of its laps a theoretical is made of: the different laps holding its corners. */
export const lapsUsed = (t: Theoretical) => new Set(t.from.map(([run, lap]) => `${run}:${lap}`)).size;

/** "a, b and c". */
export function listWords(parts: string[]): string {
  return parts.length <= 1 ? parts.join('') : `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`;
}

const PLACE: Record<string, string> = { braking: 'under braking', entry: 'on entry', 'mid-corner': 'mid-corner',
  exit: 'on the exit', 'full throttle': 'on the straight after it' };

/** A tip in one or two plain sentences: "PIA’s lap 6 brakes 6 m later and carries 3 km/h more at the slowest point
 * than lap 5: 0.12 s, most of it under braking. It also brakes 9% harder." The laps are named by their driver, and by
 * their stint when the two laps are of different stints. */
export function tipWords(tip: Tip, stints: Stint[]): string {
  const [hRun, hLap] = tip.from;
  const [vRun, vLap] = tip.versus;
  const h = stints.find((s) => s.run === hRun);
  const v = stints.find((s) => s.run === vRun);
  const apart = hRun !== vRun;
  const name = (s: Stint | undefined, lap: number, first: boolean) => {
    const of = apart && s ? ` of ${s.name}` : '';
    if (s?.code && (apart || first)) return `${s.code}’s lap ${lap}${of}`;
    return `${first ? 'Lap' : 'lap'} ${lap}${of}`;
  };
  const worth = `${tip.gain_s.toFixed(2)} s`;
  const place = PLACE[tip.phase] ? `, most of it ${PLACE[tip.phase]}` : '';
  const who = name(h, hLap, true);
  const than = name(v, vLap, false);
  if (!tip.does.length && !tip.also.length) {
    return `${who} is ${worth} quicker here than ${than}${place}, with no one difference that stands out: compare the traces.`;
  }
  const [lead, more] = tip.does.length ? [tip.does, tip.also] : [tip.also, []];
  const first = `${who} ${listWords(lead)} than ${than}: ${worth}${place}.`;
  return more.length ? `${first} It also ${listWords(more)}.` : first;
}

/** The tips of one theoretical: the combined theoretical's (null) or a stint theoretical's (its run). */
export function tipsOf(answer: TheoreticalAnswer, run: string | null): Tip[] {
  if (run == null) return answer.combined?.tips ?? [];
  const s = answer.stints.find((x) => x.run === run);
  return s && s.ready ? s.tips ?? [] : [];
}
