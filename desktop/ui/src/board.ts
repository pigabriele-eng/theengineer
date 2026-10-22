// What the session board shows, worked out from the server's answers: which laps the theoreticals are asked from,
// the corners where the time is (each in plain words with its time worth), and the formats. Pure, so `npm test`
// checks it (board.test.ts).
import type { LapRef, SessionAnswer, SessionLap, SessionRun, TheoreticalAnswer, Tip } from './api';

export const MAX_LAPS = 6; // the laps one comparison takes (server/app/analysis/lapcompare.py MAX_LAPS)
export const TOP = 3; // corners on the board

export const isClean = (l: Pick<SessionLap, 'clean'>) => l.clean !== false;

/** "1:47.44"; "47.44" under a minute. */
export function lapTime(s: number | null | undefined): string {
  if (s == null || !Number.isFinite(s)) return '–';
  const m = Math.floor(s / 60);
  const rest = (s - m * 60).toFixed(2).padStart(5, '0');
  return m ? `${m}:${rest}` : rest;
}

/** "0.31 s"; thousandths under a hundredth, so a small gain doesn't read as none. */
export const seconds = (v: number) => `${v.toFixed(Math.abs(v) < 0.01 && v !== 0 ? 3 : 2)} s`;

/** A driver's three letters as the paddock writes them: "Gabriele Piana" is PIA. */
export function driverCode(name: string | null | undefined): string | null {
  if (!name) return null;
  const last = name.trim().split(/\s+/).pop() ?? '';
  return last.length <= 3 ? last.toUpperCase() : last.slice(0, 3).toUpperCase();
}

/** The laps the theoreticals are worked out from: each stint's quickest clean lap, and a lone stint's two quickest
 * (a theoretical needs two laps to choose from), at most MAX_LAPS. */
export function theoreticalPicks(runs: SessionRun[]): LapRef[] {
  const ranked = runs.map((r) => ({ r, laps: r.laps.filter(isClean).sort((a, b) => a.time - b.time) }))
    .filter((x) => x.laps.length);
  const out: LapRef[] = ranked.map((x) => ({ session_id: x.r.id, lap: x.laps[0].number }));
  if (ranked.length === 1 && ranked[0].laps.length > 1) out.push({ session_id: ranked[0].r.id, lap: ranked[0].laps[1].number });
  return out.sort((a, b) => lapOf(runs, a)!.time - lapOf(runs, b)!.time).slice(0, MAX_LAPS);
}

export const lapOf = (runs: SessionRun[], ref: LapRef) =>
  runs.find((r) => r.id === ref.session_id)?.laps.find((l) => l.number === ref.lap);

/** A corner where the time is: the theoretical's tip, with the real laps it is told between. */
export type Corner = {
  code: string;
  gain: number;
  phase: string;
  holder: LapRef; // the lap that does it best
  versus: LapRef; // the quickest real lap, which loses it here
  words: string; // what the holder does, in a sentence
  also: string | null;
};

/** The tips of the combined theoretical, else of the one stint's: the biggest first. */
export function tipsOf(answer: TheoreticalAnswer | null): Tip[] {
  if (!answer) return [];
  const tips = answer.combined?.tips ?? answer.stints.find((s) => s.ready && s.tips?.length)?.tips ?? [];
  return [...tips].sort((a, b) => b.gain_s - a.gain_s);
}

/** "and" between the last two, commas before. */
export function joinWords(parts: string[]): string {
  if (parts.length <= 1) return parts.join('');
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/** "lap 6", "lap 6 of stint 2" when the session has more stints, "lap 6 (RAC)" when it has two drivers. */
export function lapName(runs: SessionRun[], ref: LapRef, withDriver = false): string {
  const i = runs.findIndex((r) => r.id === ref.session_id);
  const code = withDriver ? driverCode(runs[i]?.driver) : null;
  const stint = runs.length > 1 && i >= 0 ? ` of stint ${i + 1}` : '';
  return `lap ${ref.lap}${stint}${code ? ` (${code})` : ''}`;
}

/** "Stint 2 · PIA", or "" for a session of one stint. */
export function stintName(runs: SessionRun[], id: number): string {
  const i = runs.findIndex((r) => r.id === id);
  if (runs.length < 2 || i < 0) return '';
  const code = driverCode(runs[i].driver);
  return `Stint ${i + 1}${code ? ` · ${code}` : ''}`;
}

/** The corners where the time is, in words: "Lap 6 turns in 5 m later and carries 3 km/h more at the slowest point
 * than lap 7." (the server says what the quicker lap does, lapcompare.py _CornerWords). A tip names the driver when
 * the laps are two drivers'. */
export function cornersOf(answer: TheoreticalAnswer | null, runs: SessionRun[], top = TOP): Corner[] {
  const drivers = new Set(runs.map((r) => r.driver ?? '')).size > 1;
  return tipsOf(answer).slice(0, top).map((t) => {
    const holder = { session_id: Number(t.from[0]), lap: t.from[1] };
    const versus = { session_id: Number(t.versus[0]), lap: t.versus[1] };
    const does = t.does.length ? t.does : t.also.slice(0, 2);
    const also = t.does.length ? t.also : t.also.slice(2);
    const words = does.length
      ? `${cap(lapName(runs, holder, drivers))} ${joinWords(does)} than ${lapName(runs, versus, drivers)}.`
      : `${cap(lapName(runs, holder, drivers))} is quicker here than ${lapName(runs, versus, drivers)}, most of it on the ${t.phase}.`;
    return { code: t.code, gain: t.gain_s, phase: t.phase, holder, versus, words,
      also: also.length ? `It also ${joinWords(also)}.` : null };
  });
}

const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

/** The laps of the session in the order they ran, with their run. */
export function allLaps(s: SessionAnswer): { run: SessionRun; lap: SessionLap }[] {
  return s.runs.flatMap((run) => run.laps.map((lap) => ({ run, lap })));
}

/** For each section, the lap holding the session's best time in it (clean laps and the rest alike: a quicker
 * section on an out-lap counts). */
export function sectionBests(s: SessionAnswer): (LapRef | null)[] {
  const n = s.sections?.length ?? 0;
  return Array.from({ length: n }, (_, k) => {
    let best: { ref: LapRef; t: number } | null = null;
    for (const { run, lap } of allLaps(s)) {
      const t = lap.sections?.[k];
      if (t != null && (best == null || t < best.t)) best = { ref: { session_id: run.id, lap: lap.number }, t };
    }
    return best?.ref ?? null;
  });
}

/** An event's name as the home list shows it: "GT4 Euro 2025", "Test May 2025", else its own name. */
export function eventLabel(name: string, series: string | null, date: string | null): string {
  const year = date?.slice(0, 4);
  if (series && year) return `${series.replace('GT4 European Series', 'GT4 Euro')} ${year}`;
  if (/test/i.test(name) && date) {
    const month = new Date(`${date}T12:00:00Z`).toLocaleString('en-GB', { month: 'long', timeZone: 'UTC' });
    return `Test ${month} ${year}`;
  }
  return name;
}

/** Interpolated y at x on rising xs. */
export function interp(x: number, xs: number[], ys: number[]): number {
  if (!xs.length) return NaN;
  if (x <= xs[0]) return ys[0];
  if (x >= xs[xs.length - 1]) return ys[ys.length - 1];
  let lo = 0;
  let hi = xs.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (xs[mid] <= x) lo = mid; else hi = mid;
  }
  const f = (x - xs[lo]) / (xs[hi] - xs[lo] || 1);
  return ys[lo] + f * (ys[hi] - ys[lo]);
}
