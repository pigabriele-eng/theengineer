// The event report's filter (components/report/LapFilter.tsx): which runs' laps go into the comparison, picked by
// tyres, session and driver. Pure, so it can be tested with `npm test`.

/** A run as the filter reads it: its tyres (level), its official session's code and its driver. */
export type FilterRun = { id: number; tyres: string | null; part: string | null; driver: string | null };
/** What is picked in each row; an empty row takes every run. */
export type FilterPicks = { tyres: string[]; parts: string[]; drivers: string[] };

export const NO_PICKS: FilterPicks = { tyres: [], parts: [], drivers: [] };
export const anyPicked = (p: FilterPicks) => p.tyres.length + p.parts.length + p.drivers.length > 0;

/** The runs that are on every picked row's choices, in the order given. */
export function pickedRuns(runs: FilterRun[], p: FilterPicks): number[] {
  const on = (picked: string[], v: string | null) => picked.length === 0 || (v != null && picked.includes(v));
  return runs.filter((r) => on(p.tyres, r.tyres) && on(p.parts, r.part) && on(p.drivers, r.driver)).map((r) => r.id);
}

/** A choice added to its row, or taken off when it was on. */
export function flip(p: FilterPicks, row: keyof FilterPicks, v: string): FilterPicks {
  const now = p[row];
  return { ...p, [row]: now.includes(v) ? now.filter((x) => x !== v) : [...now, v] };
}

/** How many runs each choice of a row would leave with the other rows as picked: a choice that leaves none is shown
 * off. */
export function countsFor(runs: FilterRun[], p: FilterPicks, row: keyof FilterPicks, values: string[]) {
  return Object.fromEntries(values.map((v) => [v, pickedRuns(runs, { ...p, [row]: [v] }).length]));
}
