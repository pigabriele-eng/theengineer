// The day columns of an event's runs, on the home page and the event page. Events are three or four days of driving
// (Gabriele, 2026-10-07: "allow for 4 columns"): on a wide screen three or four days sit side by side across the
// page's whole width when each column gets at least MIN_DAY (MIN_EVENT_DAY on the event page), else two a row. One or
// two days keep each page's usual layout, and on a phone the days stack.

export const DAY_GAP = 24; // between the day columns
export const MIN_DAY = 230; // narrowest a day column gets before the days go two a row
// the event page's run rows also carry a tick box: narrower than this, the run's name ("01_D1S1") is cut short
export const MIN_EVENT_DAY = 260;
const PAGE_MAX = 1240; // the page body's widest, gutters included (Page in components/Programme.tsx)

/** How three or more days sit on a wide screen: 'across' (one row, side by side) or 'half' (two a row: the window is
 * too narrow for that many columns of `minDay`); null for one or two days, or on a phone. `gutter` is the page's side
 * margin. */
export function dayColumns(nDays: number, width: number, wide: boolean, gutter: number,
  minDay = MIN_DAY): 'across' | 'half' | null {
  if (!wide || nDays < 3) return null;
  const across = Math.min(width, PAGE_MAX) - 2 * gutter;
  return (across - (nDays - 1) * DAY_GAP) / nDays >= minDay ? 'across' : 'half';
}
