// The During tab's comparison after a session (Gabriele, 2026-10-08: "the standard after a session is a comparison
// between fastest runs within that session and a quick way to compare different runs"; "latest run vs best is also
// not helpful"): by default each run's fastest lap in the latest session, compared with each other, each driver's
// fastest marked; any other runs picked with a tap. Pure, so it can be tested with `npm test`.
import type { Part } from './sessionParts.ts';

export const MAX_RUNS = 6; // the laps a comparison takes (lib/compare.ts MAX_LAPS)

/** A run as the comparison lists it: its fastest lap and who drove it. */
export type FastRun = { id: number; name: string; driver: string | null; lap: number; time: number; part: string };

/** Every run of the event with a timed lap, by session (in the order they ran); `lapOf`: a run's fastest lap number. */
export function runsByPart(parts: Part[], lapOf: (id: number) => number | null): { part: Part; runs: FastRun[] }[] {
  return parts.map((part) => ({
    part,
    runs: part.runs.flatMap((r) => {
      const lap = lapOf(r.id);
      return r.best != null && lap != null
        ? [{ id: r.id, name: r.name, driver: r.driver, lap, time: r.best, part: part.title }] : [];
    }),
  })).filter((p) => p.runs.length > 0);
}

/** The runs compared by default: the latest session's, quickest first, as many as a comparison takes. */
export function defaultRuns(byPart: { part: Part; runs: FastRun[] }[]): { title: string | null; ids: number[] } {
  const last = byPart.at(-1);
  if (!last) return { title: null, ids: [] };
  return { title: last.part.title, ids: [...last.runs].sort((a, b) => a.time - b.time).slice(0, MAX_RUNS).map((r) => r.id) };
}

/** Each driver's fastest run among these (a run without a driver counts on its own). */
export function driversFastest(runs: FastRun[]): Set<number> {
  const best = new Map<string, FastRun>();
  for (const r of runs) {
    const k = r.driver ?? `#${r.id}`;
    const b = best.get(k);
    if (!b || r.time < b.time) best.set(k, r);
  }
  return new Set([...best.values()].map((r) => r.id));
}

/** A run ticked or unticked: at most MAX_RUNS, in the order picked. */
export function flipRun(ids: number[], id: number): number[] {
  if (ids.includes(id)) return ids.filter((x) => x !== id);
  return ids.length >= MAX_RUNS ? ids : [...ids, id];
}
