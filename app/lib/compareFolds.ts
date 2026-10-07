// The Compare page's list of sessions to pick laps from, folded by track (app/app/compare.tsx): which track is open
// when the page opens, and the folds tapped since, kept for the rest of the visit. No imports but types, so it is
// tested in lib/compareFolds.test.mjs (npm test).
import type { TrackGroup } from './compare';
import type { FolderSummary } from './events';

const same = (a: string | null | undefined, b: string | null | undefined) =>
  !!a?.trim() && !!b?.trim() && a.trim().toLowerCase() === b.trim().toLowerCase();

/** The track an event is at: the one with its track's name, else the one its runs are listed under. */
export function eventTrack(groups: TrackGroup[], ev: Pick<FolderSummary, 'name' | 'track'> | null): TrackGroup | null {
  if (!ev) return null;
  return groups.find((g) => same(g.track, ev.track))
    ?? groups.find((g) => g.sessions.some((s) => same(s.event, ev.name)))
    ?? null;
}

/** The track of the most recent session: the latest day it was driven, then the newest session (the highest id). */
export function latestTrack(groups: TrackGroup[]): TrackGroup | null {
  let best: { g: TrackGroup; date: string; id: number } | null = null;
  for (const g of groups) {
    for (const s of g.sessions) {
      const date = s.date ?? '';
      if (!best || date > best.date || (date === best.date && s.id > best.id)) best = { g, date, id: s.id };
    }
  }
  return best?.g ?? null;
}

/** The track of the picked laps (by their sessions' ids; one no longer listed is passed over). */
export const pickedTrack = (groups: TrackGroup[], picked: number[]): TrackGroup | null =>
  picked.map((id) => groups.find((g) => g.sessions.some((s) => s.id === id))).find(Boolean) ?? null;

/** The track open when the page opens, the others folded: the picked laps' track (opened with ?laps= or ?session=);
 * else, while an event is on (lib/openCurrent.ts currentEvent), that event's track; else the track of the most recent
 * session. Null when there is no track to pick from. */
export function openFirst(groups: TrackGroup[], { picked = [], current = null }: {
  picked?: number[]; // the picked laps' session ids
  current?: Pick<FolderSummary, 'name' | 'track'> | null;
}): string | null {
  return (pickedTrack(groups, picked) ?? eventTrack(groups, current) ?? latestTrack(groups))?.key ?? null;
}

// The folds tapped open or shut, by track, for the rest of the visit: module state, so they last while the app is open
// (back to the page, they are as they were left) and a fresh load or launch starts from openFirst again. Never stored.
const tapped = new Map<string, boolean>();

export const visitFolds = (): Record<string, boolean> => Object.fromEntries(tapped);
export function keepFold(key: string, open: boolean | null) {
  if (open == null) tapped.delete(key);
  else tapped.set(key, open);
}
