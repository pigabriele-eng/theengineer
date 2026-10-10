// Where the masthead's Back goes (Gabriele, 2026-10-08: "add 'back' to step one page back"). With pages visited in
// the app, one page back. Without (a fresh load, a link opened from elsewhere, the home-screen app opened on a deep
// page), the page above this one: an event's pages go up to the event, a tool to the Tools page, a driver page to
// Drivers, everything else to the race weekends. Pure, so `npm test` checks it (lib/backTo.test.mjs); the button and
// the record of visited pages are components/Back.tsx.

/** A page Back can go to: its path and what a screen reader calls it ("Back to …"). */
export type Place = { path: string; name: string };

/** The event a page belongs to, as the page knows it (its id, and its name once read). */
export type EventRef = { id: number | string; name?: string | null };

export const HOME: Place = { path: '/', name: 'the race weekends' };
const TOOLS: Place = { path: '/tools', name: 'Tools' };
const DRIVERS: Place = { path: '/drivers', name: 'Drivers' };

// the pages that belong to an event when they have one: a run, its report, technique check, quali prep, prep report,
// prediction and a debrief's report
const EVENT_PAGES = ['/report', '/technique', '/quali', '/prep', '/prediction'];
const EVENT_PREFIXES = ['/session/', '/debrief/'];

/** A path without a trailing slash (the home page stays "/"). */
function clean(path: string): string {
  return path.replace(/\/+$/, '') || '/';
}

/** The page above `path`, or null on the race weekends (the top). `event`: the event the page belongs to, for a run,
 * a report, a technique check, quali prep, a prep report, a prediction or a debrief's report. */
export function parentOf(path: string, event?: EventRef | null): Place | null {
  const p = clean(path);
  if (p === '/') return null;
  if (p.startsWith('/tools/') || p === '/garage' || p === '/seasons') return TOOLS;
  if (p.startsWith('/drivers/')) return DRIVERS;
  const ofEvent = EVENT_PAGES.includes(p) || EVENT_PREFIXES.some((x) => p.startsWith(x));
  if (ofEvent && event != null && /^\d+$/.test(String(event.id))) {
    return { path: `/event/${event.id}`, name: event.name?.trim() || 'the event' };
  }
  // an event's page, /compare and the top-level pages (Coaching, Drivers, Setup, Upload, Debrief, Tools)
  return HOME;
}

const NAMES: Record<string, string> = {
  '/': HOME.name,
  '/tools': 'Tools',
  '/drivers': 'Drivers',
  '/coaching': 'Coaching',
  '/setup': 'Setup',
  '/upload': 'Upload',
  '/debrief': 'Debrief',
  '/compare': 'Compare laps',
  '/garage': 'the garage',
  '/seasons': 'Seasons',
  '/manual': 'the manual',
};

/** What a screen reader calls the page at `path`, when it can say: null for one it can't name from its path. */
export function nameOf(path: string): string | null {
  const p = clean(path);
  if (NAMES[p]) return NAMES[p];
  if (p.startsWith('/event/')) return 'the event';
  if (p.startsWith('/session/')) return 'the run';
  return null;
}

// a page whose own switcher shows another one in its place (a run's "other runs of the event" swaps the id in the address)
const shape = (p: string) => p.replace(/^\/(session|event|debrief)\/[^/]+$/, '/$1/[id]');

// the masthead's pages that sit together under the race weekends (app/(tabs)): reaching one closes the pages opened
// over them, and one page back from any of them is the race weekends
const TAB_PAGES = ['/upload', '/debrief', '/tools'];

/** The pages visited in this load, newest last, after the app shows `path`, as the navigator keeps them: the page
 * before last again is a step back (it comes off), the same page again changes nothing, another run in the run page's
 * place takes its place, the race weekends or another page of theirs (Upload, Debrief, Tools) starts again from the
 * race weekends, any other page goes on top. */
export function step(trail: string[], path: string): string[] {
  const p = clean(path);
  const n = trail.length;
  if (n && trail[n - 1] === p) return trail;
  if (p === '/') return ['/'];
  if (TAB_PAGES.includes(p)) return ['/', p];
  if (n >= 2 && trail[n - 2] === p) return trail.slice(0, -1);
  if (n && shape(trail[n - 1]) === shape(p) && shape(p) !== p) return [...trail.slice(0, -1), p];
  return [...trail, p];
}

/** What Back does on `path`: 'history', one page back (`place`: where that is, when it can be named); 'parent', up to
 * the page above. Null on the race weekends, where there is no Back. History counts only when a page was visited
 * before this one in the app and the navigator can go back (`canGoBack`): a fresh load of a deep page has none, even
 * though the navigator keeps the race weekends under it. */
export function backFrom(trail: string[], path: string, event: EventRef | null | undefined, canGoBack: boolean):
  { to: 'history'; place: Place | null } | { to: 'parent'; place: Place } | null {
  const parent = parentOf(path, event);
  if (!parent) return null;
  const n = trail.length;
  if (n >= 2 && trail[n - 1] === clean(path) && canGoBack) {
    const prev = trail[n - 2];
    const name = prev === parent.path ? parent.name : nameOf(prev);
    return { to: 'history', place: name ? { path: prev, name } : null };
  }
  return { to: 'parent', place: parent };
}

/** The screen reader's words for Back: where it goes when that is known, else just "Back". */
export function backLabel(place: Place | null): string {
  return place ? `Back to ${place.name}` : 'Back';
}
