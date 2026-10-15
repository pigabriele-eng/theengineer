// The Quali analysis tab's workings (components/weekend/QualiTab.tsx). Gabriele, 2026-10-15: "Quali analyisis: 1- tire
// preparation analysis and temp/pressure analysis". The weekend's qualifying sessions are picked out of its official
// sessions (Q, Q1-Q3, PQ, or a log folder named so: "03_Q"), each driver's run in them is found in the tyre prep
// report (server/app/analysis/tyreprep.py), and its warm-up, when its tyres were ready and where each tyre ran are
// put in words and numbers. Pure, so `npm test` checks it.
import type { Part } from './sessionParts';
import type { Sim, TyrePrep, TyreSeries, Wheel } from './tyreprep';

export type Push = NonNullable<TyrePrep['push']>;

const DAY = /^Day \d+ · /; // a session the timetable doesn't name, told apart by its day (server/app/run_parts.py)
const ORDER = /^\d+[_\- ]+/; // a log folder's order in front of its name: "03_Q" is Q (server/app/run_tyres.py)
const QUALI = /^(?:PQ|QP|Q\d?|QUALI\w*|PRE-?QUALI\w*)(?!\w)/i;

/** Whether an official session is a qualifying one: Q, Q1 to Q3, pre-qualifying (PQ), or a log folder named so. */
export const isQualiCode = (code: string) => QUALI.test(code.replace(DAY, '').replace(ORDER, ''));

export type QualiRun = {
  sim: Sim;
  part: string; // the official session it ran in: "Q1", "PQ", "03_Q"
  driver: string | null; // by name
  slot: number; // its colour, in the order the runs are listed
};

export type NoRun = { id: number; name: string; driver: string | null; part: string };

/** Each driver's run in the qualifying sessions, in the sessions' order then the runs': the report's quali-style runs
 * of those sessions (a log can hold more than one). `none`: the runs it found no quali-style run in (pit running). */
export function qualiRuns(parts: Part[], sims: Sim[]): { runs: QualiRun[]; none: NoRun[] } {
  const runs: QualiRun[] = [];
  const none: NoRun[] = [];
  for (const p of parts.filter((x) => isQualiCode(x.code))) {
    for (const r of p.runs) {
      const mine = sims.filter((s) => s.session_id === r.id).sort((a, b) => a.run - b.run);
      if (!mine.length) none.push({ id: r.id, name: r.name, driver: r.driver, part: p.code });
      for (const sim of mine) runs.push({ sim, part: p.code, driver: r.driver, slot: runs.length });
    }
  }
  return { runs, none };
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const list = (xs: string[]) => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);
const ordinal = (k: number) => ['first', 'second', 'third', 'fourth', 'fifth', 'sixth'][k - 1] ?? `${k}th`;

/** The flying lap (1 the first) a lap of the run was, or null. */
const flyingOf = (s: Sim, lap: number | null) => {
  const i = lap == null ? -1 : s.points.findIndex((p) => p.lap === lap);
  return i < 0 ? null : i + 1;
};

/** The run's tyre preparation in plain words, a sentence each: how it left and what the warm-up did, the tyres at the
 * first flying lap, the best lap, and when the tyres were ready to push. `lap` formats a lap time. */
export function prepWords(s: Sim, push: Push | null, lap: (t: number) => string): string[] {
  const work = [s.warm_laps != null ? `${plural(s.warm_laps, 'warm-up lap')} in ${s.warm_min.toFixed(1)} min`
    : `${s.warm_min.toFixed(1)} min of warm-up`];
  if (s.drag_s) work.push(`${Math.round(s.drag_s)} s of brake dragging`);
  if (s.straight_hard_stops) work.push(`${plural(s.straight_hard_stops, 'hard stop')} on the straights`);
  if (s.weaves) work.push(plural(s.weaves, 'weaving swing'));
  const start = s.cold_start ? 'Left on cold tyres'
    : s.pre_warmed ? 'Left on tyres still warm from earlier running (the warm-up may be in an earlier log)'
      : 'Left the pits';
  const out = [`${start}: ${list(work)}.`];
  if (s.first_front != null && s.first_rear != null) {
    out.push(`The first flying lap started with the fronts at ${s.first_front} °C and the rears at ${s.first_rear} °C.`);
  }
  let best = `Best lap ${lap(s.peak_time)} on the ${ordinal(s.peak_flying)} flying lap, ${s.peak_min.toFixed(1)} min after leaving`;
  if (s.peak_flying > 1 && s.peak_front != null && s.peak_rear != null) {
    best += `, starting with the fronts at ${s.peak_front} °C and the rears at ${s.peak_rear} °C`;
  }
  out.push(`${best}.`);
  if (!push) return out;
  const at = `fronts ${push.front_c} °C and rears ${push.rear_c} °C at the line`;
  const first = flyingOf(s, s.first_ready_lap);
  if (first != null) {
    let t = `Ready to push (${at}) from the ${ordinal(first)} flying lap`;
    if (s.cold_start && s.ready_min != null) t += `, ${s.ready_min.toFixed(1)} min after leaving`;
    const k = s.peak_after_ready;
    t += k == null ? '.' : k === 0 ? ': the best lap was that lap.' : k === 1 ? ': the best lap was the one after it.'
      : k > 1 ? `: the best lap came ${k} laps later.` : ': the best lap came before that.';
    out.push(t);
  } else if (s.ready_min != null) {
    out.push(`No flying lap started at push temperature (${at}): the tyres got there ${s.ready_min.toFixed(1)} min after `
      + 'leaving.');
  } else {
    out.push(`The tyres never reached push temperature (${at}) on this run.`);
  }
  return out;
}

export type Where = 'low' | 'in' | 'high';
export const WHERE_WORDS: Record<Where, string> = { low: 'below', in: 'in', high: 'above' };

/** Where a reading sits against a window (its 10th, 50th and 90th percentile): below, in or above it. */
export function where(v: number | null | undefined, window: number[] | undefined): Where | null {
  if (v == null || !window || window.length < 3) return null;
  return v < window[0] ? 'low' : v > window[2] ? 'high' : 'in';
}

/** An axle's readings over the run: the average of its two tyres, or the one reporting when the other drops out (as
 * the server's axle values are); nothing until both have woken, so the axle doesn't jump when the second one does. */
export function axleSeries(series: TyreSeries, kind: 'p' | 't', axle: 'front' | 'rear'): (number | null)[] {
  const pair = (axle === 'front' ? ['FL', 'FR'] : ['RL', 'RR']).map((w) => series[kind][w as Wheel] ?? []);
  const n = Math.max(0, ...pair.map((x) => x.length));
  const woke = Math.max(...pair.filter((x) => x.some((v) => v != null)).map((x) => x.findIndex((v) => v != null)), 0);
  return Array.from({ length: n }, (_, i) => {
    const v = pair.map((x) => x[i]).filter((x): x is number => x != null);
    return i < woke || !v.length ? null : v.reduce((a, b) => a + b, 0) / v.length;
  });
}

/** The minute (from leaving) each reading of a series stands for: the middle of its stretch. */
export const minuteAt = (series: TyreSeries, i: number) => ((i + 0.5) * series.step_s) / 60;

export type LapMark = { n: number; start: number; end: number; time: number; kind: 'flying' | 'warm-up' | 'in' | 'slow';
  best: boolean };

/** The run's laps on its time line (minutes from leaving): the warm-up laps before the first flying lap, the flying
 * laps, a slow lap between them and the in-lap; the best one marked. */
export function lapMarks(s: Sim): LapMark[] {
  const laps = s.laps.filter((l) => l.start_min != null);
  const firstFlying = laps.findIndex((l) => l.clean);
  return laps.map((l, i) => ({
    n: l.n, start: l.start_min!, end: l.start_min! + l.time / 60, time: l.time, best: l.n === s.peak_lap,
    kind: l.clean ? 'flying' : firstFlying < 0 || i < firstFlying ? 'warm-up' : i === laps.length - 1 ? 'in' : 'slow',
  }));
}

/** A chart's value axis: its range rounded out to a tick step with a little room, and the step (the smallest of
 * `steps` that gives at most `ticks` gaps), so every tick sits on a round number. */
export function axisOf(values: (number | null | undefined)[], steps: number[], ticks = 6):
  { range: [number, number]; step: number } | null {
  const v = values.filter((x): x is number => x != null && Number.isFinite(x));
  if (!v.length) return null;
  const lo = Math.min(...v);
  const hi = Math.max(...v);
  const round = (x: number) => Math.round(x * 1000) / 1000; // 1.2000000000000002 is 1.2
  for (const step of steps) {
    const a = round(Math.floor((lo - step / 4) / step) * step);
    const b = round(Math.ceil((hi + step / 4) / step) * step);
    if ((b - a) / step <= ticks || step === steps[steps.length - 1]) return { range: [a, b > a ? b : round(a + step)], step };
  }
  return null;
}
