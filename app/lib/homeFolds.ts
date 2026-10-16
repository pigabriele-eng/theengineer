// The home page's list of tracks, each with its events, folded or open (app/(tabs)/index.tsx), and the lines its
// events show. Pure, so it is tested in lib/homeFolds.test.mjs (npm test): no imports but types.
import type { FolderSummary } from './events';

/** A track's events (not the runs in no event), newest first. `key`: the venue key (lib/venues.ts venueKey), or
 * UNKNOWN for events whose track isn't known yet. */
export type Track = { key: string; name: string; events: FolderSummary[]; driven: number; cleanLaps: number;
  first: string | null; last: string | null };
/** Where an event was: its track's key and the name the list shows; null when nothing says. */
export type TrackOf = (f: FolderSummary) => { key: string; name: string } | null;

export const UNKNOWN = 'unknown';
export const UNKNOWN_NAME = 'Track not known';

const firstDay = (f: FolderSummary) => f.start ?? f.end;
const lastDay = (f: FolderSummary) => f.end ?? f.start;
export const yearOf = (f: FolderSummary) => {
  const d = firstDay(f);
  return d ? Number(d.slice(0, 4)) : null;
};
/** The championship an event is in: its season, else the series it was given, else none. */
export const championshipOf = (f: FolderSummary) => f.season?.name ?? (f.series?.trim() || null);

/** An event's name under its championship: without the championship's name a season gives its rounds' events
 * ("Zandvoort · GT4 European Series 2026" reads "Zandvoort"). */
export function shortName(f: FolderSummary) {
  const champ = championshipOf(f);
  const tail = champ ? ` · ${champ}` : null;
  return tail && f.name.length > tail.length && f.name.toLowerCase().endsWith(tail.toLowerCase())
    ? f.name.slice(0, -tail.length) : f.name;
}

/** Newest first: by first day, then last day, then the later made; events with no date last. */
const newestFirst = (a: FolderSummary, b: FolderSummary) =>
  cmp(firstDay(b) ?? '', firstDay(a) ?? '') || cmp(lastDay(b) ?? '', lastDay(a) ?? '') || ((b.id ?? 0) - (a.id ?? 0));

/** Events (not the runs in no event) by track. The track driven at most recently first, then the tracks with only
 * planned events (no runs yet), the newest first, and the events whose track isn't known last; under a track, its
 * events newest first. Two names of one circuit ("Hockenheim GP", "Hockenheimring") are one track by its key. */
export function byTrack(folders: FolderSummary[], trackOf: TrackOf): Track[] {
  const tracks = new Map<string, Track>();
  for (const f of folders) {
    if (f.id == null) continue;
    const at = trackOf(f) ?? { key: UNKNOWN, name: UNKNOWN_NAME };
    const t = tracks.get(at.key) ?? { key: at.key, name: at.name, events: [], driven: 0, cleanLaps: 0, first: null,
      last: null };
    tracks.set(at.key, t);
    t.events.push(f);
    if (f.sessions > 0) t.driven += 1;
    t.cleanLaps += f.clean_laps;
  }
  const out = [...tracks.values()];
  for (const t of out) {
    t.events.sort(newestFirst);
    const days = t.events.flatMap((f) => [firstDay(f), lastDay(f)]).filter((d): d is string => !!d).sort();
    t.first = days[0] ?? null;
    t.last = days[days.length - 1] ?? null;
  }
  // a track's latest driven day (else its latest planned one), for its place in the list
  const latest = (t: Track) => t.events.filter((f) => f.sessions > 0).map(lastDay).filter(Boolean).sort().pop() ?? '';
  return out.sort((a, b) => Number(a.key === UNKNOWN) - Number(b.key === UNKNOWN)
    || Number(!a.driven) - Number(!b.driven)
    || cmp(latest(b) || (b.last ?? ''), latest(a) || (a.last ?? ''))
    || cmp(a.name.toLowerCase(), b.name.toLowerCase()));
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October',
  'November', 'December'];
// championships' long names, as the list says them short (Gabriele, 2026-10-16: "GT4 Euro 2025")
const SHORT: [RegExp, string][] = [[/^GT4 European Series\b/i, 'GT4 Euro'], [/^GT4 Europe\b/i, 'GT4 Euro']];

/** What an event is called under its track: its championship and year ("GT4 Euro 2025", "ADAC GT4 Germany 2026"),
 * or "Test" and its month ("Test February 2026") for an event in no championship or one named a test. */
export function eventLabel(f: FolderSummary): string {
  const champ = championshipOf(f);
  const day = firstDay(f);
  if (!champ || /\btest/i.test(f.name)) {
    return day ? `Test ${MONTH_NAMES[Number(day.slice(5, 7)) - 1]} ${day.slice(0, 4)}` : 'Test';
  }
  let name = champ.replace(/\s*\b(19|20)\d{2}\b\s*/g, ' ').replace(/\s+/g, ' ').trim();
  for (const [long, short] of SHORT) name = name.replace(long, short);
  const year = f.season?.year ?? yearOf(f);
  return year ? `${name} ${year}` : name;
}

/** "2026", "2025–2026": the years a track's events span. */
export function yearSpan(first: string | null, last: string | null) {
  if (!first || !last) return null;
  const a = first.slice(0, 4);
  const b = last.slice(0, 4);
  return a === b ? a : `${a}–${b}`;
}

// The keys folds are kept under: a track, an event.
export const trackKey = (t: Track) => `t:${t.key}`;
export const eventKey = (f: FolderSummary) => `e:${f.key}`;
export type Folds = Record<string, boolean>;

// ---------- who drove an event, in what ----------

// the small words of a surname: "van Splunteren", "de Pasquale", "von Bayern"
const PARTICLES = new Set(['van', 'von', 'de', 'der', 'den', 'di', 'da', 'del', 'della', 'dos', 'du', 'la', 'le',
  'ter', 'ten']);

/** A driver's surname: "Gabriele Piana" -> "Piana", "Max van Splunteren" -> "van Splunteren", "Gabriele" -> itself. */
export function surname(name: string) {
  const words = name.trim().split(/\s+/);
  let i = words.length - 1;
  while (i > 1 && PARTICLES.has(words[i - 1].toLowerCase())) i -= 1;
  return words.slice(Math.max(i, 0)).join(' ');
}

/** The event's drivers by surname, the most laps first: "Piana, Rackl". Null when no run has a driver. */
export function driversLine(f: Pick<FolderSummary, 'drivers'>) {
  const names = [...new Set((f.drivers ?? []).map(surname).filter(Boolean))];
  return names.length ? names.join(', ') : null;
}

/** Each driver's laps in the event, as a timing screen names drivers: "PIA 84 laps · RAC 71 laps", then the laps of
 * runs nobody is set on yet ("12 laps unassigned"). A driver's three letters are the first of their surname (the
 * surname when two drivers share them). Null when no run has laps; the drivers alone from an older server. */
export function driverLapsLine(f: Pick<FolderSummary, 'drivers' | 'driver_laps' | 'unassigned_laps'>) {
  if (!f.driver_laps) return driversLine(f);
  const codes = f.driver_laps.map((d) => surname(d.name).replace(/[^\p{L}]/gu, '').slice(0, 3).toUpperCase());
  const parts = f.driver_laps.map((d, i) => {
    const code = codes[i] && codes.indexOf(codes[i]) === codes.lastIndexOf(codes[i]) ? codes[i] : surname(d.name);
    return `${code} ${d.laps} lap${d.laps === 1 ? '' : 's'}`;
  });
  if (f.unassigned_laps) parts.push(`${f.unassigned_laps} lap${f.unassigned_laps === 1 ? '' : 's'} unassigned`);
  return parts.length ? parts.join(' · ') : null;
}

/** Our race finishes, as a timing screen gives them: "R1 P5 · R2 P3", the class place after it when the series has
 * classes ("R1 P5 (Am P2)"), "R2 DNF" when not classified. Null when there are none. */
export function finishesLine(finishes: { code: string; position: number | null; class: string | null;
  class_position: number | null; status: string | null }[] | undefined) {
  const parts = (finishes ?? []).map((f) => {
    const out = f.status && !/^(classified|finished|ok)$/i.test(f.status) && f.position == null;
    if (out) return `${f.code} ${f.status!.toUpperCase()}`;
    if (f.position == null) return null;
    const inClass = f.class && f.class_position != null ? ` (${f.class} P${f.class_position})` : '';
    return `${f.code} P${f.position}${inClass}`;
  }).filter(Boolean);
  return parts.length ? parts.join(' · ') : null;
}

/** The event's car: the one with the most laps, by its model without the chassis code ("BMW M4 GT4 Evo" for "BMW M4
 * GT4 Evo (G82)"), and "+1" for each other car. Null when no run has a car. */
export function carLine(f: Pick<FolderSummary, 'cars'>) {
  const cars = f.cars ?? [];
  if (!cars.length) return null;
  const main = cars[0].replace(/\s*\([^)]*\)\s*$/, '').trim() || cars[0];
  return cars.length > 1 ? `${main} +${cars.length - 1}` : main;
}
