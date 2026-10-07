// The home page's list of events by year, then by championship, each level folded or open (app/(tabs)/index.tsx).
// Pure, so it is tested in lib/homeFolds.test.mjs (npm test): no imports but types.
import type { FolderSummary } from './events';

export const OTHER = 'Tests and other events'; // events in no season and no series

/** Events of one championship in one year: a season's (or a series' by name), else the tests and other events. */
export type Championship = { key: string; name: string; other: boolean; events: FolderSummary[] };
/** A year's events (by their first day; null: events with no date), by championship. */
export type Year = { key: string; year: number | null; events: number; start: string | null; end: string | null;
  championships: Championship[] };

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

/** Events (not the runs in no event) by year, newest first and "No date" last; in a year, the championships by name
 * with the tests and other events last; in a championship, the events in date order, as its rounds go. */
export function byYear(folders: FolderSummary[]): Year[] {
  const years = new Map<string, Map<string, Championship>>();
  for (const f of folders) {
    if (f.id == null) continue;
    const y = yearOf(f);
    const yk = y == null ? 'none' : String(y);
    const name = championshipOf(f);
    const ck = name ? name.toLowerCase() : 'other';
    const champs = years.get(yk) ?? new Map<string, Championship>();
    years.set(yk, champs);
    const c = champs.get(ck) ?? { key: ck, name: name ?? OTHER, other: !name, events: [] };
    champs.set(ck, c);
    c.events.push(f);
  }
  const day = (f: FolderSummary) => firstDay(f) ?? '9999';
  const out: Year[] = [...years.entries()].map(([key, champs]) => {
    const championships = [...champs.values()];
    for (const c of championships) {
      c.events.sort((a, b) => cmp(day(a), day(b)) || cmp(lastDay(a) ?? '', lastDay(b) ?? '') || (a.id! - b.id!));
    }
    championships.sort((a, b) => Number(a.other) - Number(b.other) || cmp(a.name.toLowerCase(), b.name.toLowerCase()));
    const all = championships.flatMap((c) => c.events);
    const starts = all.map(firstDay).filter((d): d is string => !!d).sort();
    const ends = all.map(lastDay).filter((d): d is string => !!d).sort();
    return { key, year: key === 'none' ? null : Number(key), events: all.length, start: starts[0] ?? null,
      end: ends[ends.length - 1] ?? null, championships };
  });
  return out.sort((a, b) => (b.year ?? -Infinity) - (a.year ?? -Infinity));
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

// The keys folds are kept under: a year, a championship in a year, an event.
export const yearKey = (y: Year) => `y:${y.key}`;
export const champKey = (y: Year, c: Championship) => `c:${y.key}:${c.key}`;
export const eventKey = (f: FolderSummary) => `e:${f.key}`;

/** Open unless tapped shut: this year and the lead event's year (else the newest year), every championship (they
 * show only in an open year), and the lead event (on now, else the latest driven, else the next); the rest folded. */
export function openByDefault(years: Year[], lead: FolderSummary | null, thisYear: number): Set<string> {
  const open = new Set<string>();
  const leadYear = lead ? yearOf(lead) : undefined;
  for (const y of years) {
    if (y.year != null && (y.year === thisYear || y.year === leadYear)) open.add(yearKey(y));
    if (y.year == null && lead && leadYear === null) open.add(yearKey(y));
    for (const c of y.championships) open.add(champKey(y, c));
  }
  if (!years.some((y) => open.has(yearKey(y))) && years.length) open.add(yearKey(years[0]));
  if (lead) open.add(eventKey(lead));
  return open;
}

/** "May", "Apr–Sep": the months a year's events span. */
export function monthSpan(start: string | null, end: string | null) {
  if (!start || !end) return null;
  const a = MONTHS[Number(start.slice(5, 7)) - 1];
  const b = MONTHS[Number(end.slice(5, 7)) - 1];
  if (start.slice(0, 4) !== end.slice(0, 4)) return `${a} ${start.slice(0, 4)}–${b} ${end.slice(0, 4)}`;
  return a === b ? a : `${a}–${b}`;
}
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// What was folded or opened, remembered on this device the way the Seasons page keeps its folds: only what was
// tapped, by key; the rest follows the default. No storage (a private window): the default, every visit.
const FOLD_KEY = 'theengineer.home.folds';
export type Folds = Record<string, boolean>;
export function readFolds(): Folds {
  try {
    const v = JSON.parse(globalThis.localStorage?.getItem(FOLD_KEY) ?? '{}');
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}
export function saveFolds(f: Folds) {
  try {
    globalThis.localStorage?.setItem(FOLD_KEY, JSON.stringify(f));
  } catch {
    // not remembered, but still folded or opened for this visit
  }
}

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

/** The event's car: the one with the most laps, by its model without the chassis code ("BMW M4 GT4 Evo" for "BMW M4
 * GT4 Evo (G82)"), and "+1" for each other car. Null when no run has a car. */
export function carLine(f: Pick<FolderSummary, 'cars'>) {
  const cars = f.cars ?? [];
  if (!cars.length) return null;
  const main = cars[0].replace(/\s*\([^)]*\)\s*$/, '').trim() || cars[0];
  return cars.length > 1 ? `${main} +${cars.length - 1}` : main;
}
