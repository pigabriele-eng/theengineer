// What the habit tracker (components/HabitTracker.tsx) makes of the server's answer (lib/habits.ts): one request
// shared by every tracker on screen, the teammate to set beside a driver, the words of each figure and trend, the
// costliest habit, where a habit shows most, a habit event by event, and the style differences of two drivers the
// right way round. Pure, with type-only imports, so `npm test` runs it (lib/habits.test.mjs): lib/habits.ts itself
// needs the app's API client, which Node can't load.
import type {
  HabitCorner,
  HabitDriver,
  HabitEvent,
  HabitGroup,
  HabitRow,
  HabitTrend,
  StylePair,
  StyleTrait,
} from './habits';

// ---------- one request for every tracker ----------

/** One request at a time for many callers: a call while one is on its way gets that same answer, and an answer no
 * older than `maxAgeMs` is handed out again without asking. A failed request is not kept. */
export function sharedLoader<T>(fetch: () => Promise<T>, now: () => number = Date.now) {
  let pending: Promise<T> | null = null;
  let kept: { at: number; value: T } | null = null;
  const fresh = (maxAgeMs: number) => kept != null && now() - kept.at <= maxAgeMs;
  return {
    load(maxAgeMs: number): Promise<T> {
      if (kept && fresh(maxAgeMs)) return Promise.resolve(kept.value);
      if (pending) return pending;
      const p = Promise.resolve().then(fetch).then(
        (value) => {
          kept = { at: now(), value };
          if (pending === p) pending = null;
          return value;
        },
        (e) => {
          if (pending === p) pending = null;
          throw e;
        },
      );
      pending = p;
      return p;
    },
    /** The answer kept, when it is no older than `maxAgeMs`: a tracker drawn after another shows it straight away. */
    peek(maxAgeMs: number): T | null {
      return kept && fresh(maxAgeMs) ? kept.value : null;
    },
  };
}

// ---------- who is shown ----------

type DriverIds = Pick<HabitDriver, 'id'>[];
type EventLaps = Pick<HabitEvent, 'laps'>[];

/** The driver picked, while they are still in the list; else the one with most laps (the list's first). */
export function keepDriver(drivers: DriverIds, chosen: number | null | undefined): number | null {
  if (chosen != null && drivers.some((d) => d.id === chosen)) return chosen;
  return drivers[0]?.id ?? null;
}

/** How many events two drivers both have checked laps at. */
export function sharedEvents(events: EventLaps, a: number, b: number): number {
  return events.filter((e) => (e.laps[String(a)] ?? 0) > 0 && (e.laps[String(b)] ?? 0) > 0).length;
}

/** The teammate to set beside a driver: the one they shared the most events with (on a tie, the one with more laps:
 * the list comes most laps first); nobody when they shared none. */
export function defaultMate(drivers: DriverIds, events: EventLaps, id: number): number | null {
  let best: number | null = null;
  let most = 0;
  for (const d of drivers) {
    if (d.id === id) continue;
    const n = sharedEvents(events, id, d.id);
    if (n > most) {
      best = d.id;
      most = n;
    }
  }
  return best;
}

/** The teammate shown: the one picked (null: nobody, on purpose), else the default; a pick no longer in the list,
 * or the driver themselves, falls back to the default. */
export function keepMate(drivers: DriverIds, events: EventLaps, id: number,
  chosen: number | null | undefined): number | null {
  if (chosen === null) return null;
  if (chosen !== undefined && chosen !== id && drivers.some((d) => d.id === chosen)) return chosen;
  return defaultMate(drivers, events, id);
}

// ---------- words ----------

/** A share of corners: "8%", "under 1%" for a rare one, "0%" for never. */
export function pct(rate: number): string {
  if (!(rate > 0)) return '0%';
  const n = Math.round(rate * 100);
  return n === 0 ? 'under 1%' : `${n}%`;
}

/** Time a lap: "0.21 s a lap". */
export function perLap(s: number): string {
  if (!(s > 0)) return '0 s a lap';
  return s < 0.005 ? 'under 0.01 s a lap' : `${s.toFixed(2)} s a lap`;
}

/** Both figures, how often first: "8% of corners, 0.21 s a lap". */
export const figures = (st: { rate: number; cost_per_lap_s: number }) =>
  `${pct(st.rate)} of corners, ${perLap(st.cost_per_lap_s)}`;

/** The short trend marker: better, worse, steady, or "no trend yet" until there are enough events. */
export const trendMark = (trend: HabitTrend | null | undefined) => trend?.dir ?? 'no trend yet';

/** The trend as a sentence: the server's words, or why there are none yet. */
export function trendSentence(trend: HabitTrend | null | undefined): string {
  if (!trend) return 'Not enough events yet to say whether it is changing.';
  const w = trend.words.trim();
  return /[.!?…]$/.test(w) ? w : `${w}.`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** An ISO day as "12 Jun 2026" (read as written, no time zone). */
export function dayWords(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return iso;
  return `${Number(m[3])} ${MONTHS[Number(m[2]) - 1] ?? m[2]} ${m[1]}`;
}

/** An event in a list: its track (else its name) and its day. */
export function eventLabel(e: Pick<HabitEvent, 'id' | 'name' | 'track' | 'date'>): string {
  const where = e.track || e.name || `Event ${e.id}`;
  return e.date ? `${where} · ${dayWords(e.date)}` : where;
}

/** The busy line while the technique check is still at work: "Still checking the laps of Spa, Misano…". */
export function checkingWords(names: string[]): string {
  if (names.length === 0) return 'Still checking the latest laps…';
  const shown = names.slice(0, 3).join(', ');
  return names.length > 3 ? `Still checking the laps of ${shown} and ${names.length - 3} more…`
    : `Still checking the laps of ${shown}…`;
}

const andList = (xs: string[]) =>
  xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`;

/** Where a habit shows most, by the corners' official numbers: "Most at T7 and T3 Zandvoort, T1 Monza". The
 * corner's track, else its event's name. Null without corners. */
export function cornerWords(corners: HabitCorner[], events: Pick<HabitEvent, 'id' | 'name'>[]): string | null {
  if (corners.length === 0) return null;
  const places: { place: string; codes: string[] }[] = [];
  for (const c of corners) {
    const place = c.track || events.find((e) => e.id === c.event_id)?.name || '';
    const at = places.find((p) => p.place === place);
    if (at) at.codes.push(c.code);
    else places.push({ place, codes: [c.code] });
  }
  return `Most at ${places.map((p) => (p.place ? `${andList(p.codes)} ${p.place}` : andList(p.codes))).join(', ')}`;
}

// ---------- habits ----------

const statOf = (h: HabitRow, id: number | null | undefined) => (id == null ? undefined : h.drivers[String(id)]);

/** A driver's costliest habit (time a lap, then how often), among those they have; null when they have none. */
export function topHabit(habits: HabitRow[], id: number): HabitRow | null {
  let best: HabitRow | null = null;
  for (const h of habits) {
    const s = statOf(h, id);
    if (!s || !(s.rate > 0)) continue;
    const b = best && statOf(best, id)!;
    if (!b || s.cost_per_lap_s > b.cost_per_lap_s || (s.cost_per_lap_s === b.cost_per_lap_s && s.rate > b.rate)) best = h;
  }
  return best;
}

/** The answer first: a driver's costliest habit and its figures ("Lifting on the way out, 8% of corners, 0.21 s a
 * lap."), with its trend; or that there is none yet. */
export function headline(habits: HabitRow[], id: number): { text: string; trend: HabitTrend | null; none: boolean } {
  const h = topHabit(habits, id);
  if (!h) return { text: 'No repeated mistake found yet.', trend: null, none: true };
  const s = statOf(h, id)!;
  return { text: `${h.label}, ${figures(s)}.`, trend: s.trend, none: false };
}

/** The habits to list for a driver and the teammate beside them: those at least one of them has, the driver's
 * costliest first (then the teammate's, then the server's order). */
export function habitsFor(habits: HabitRow[], id: number, mate: number | null): HabitRow[] {
  const rate = (h: HabitRow, who: number | null) => statOf(h, who)?.rate ?? 0;
  const cost = (h: HabitRow, who: number | null) => (rate(h, who) > 0 ? statOf(h, who)!.cost_per_lap_s : -1);
  return habits
    .map((h, i) => ({ h, i }))
    .filter(({ h }) => rate(h, id) > 0 || rate(h, mate) > 0)
    .sort((x, y) => cost(y.h, id) - cost(x.h, id) || cost(y.h, mate) - cost(x.h, mate) || x.i - y.i)
    .map(({ h }) => h);
}

export type HistoryLine = { event: HabitEvent; label: string; rates: (number | null)[] };

/** A habit event by event, oldest first: each event at least one of `ids` drove, with each one's share of corners
 * (null: did not drive there). */
export function history(habit: HabitRow, ids: number[], events: HabitEvent[]): HistoryLine[] {
  const by = ids.map((id) => new Map((statOf(habit, id)?.by_event ?? []).map((e) => [e.event_id, e.rate])));
  return events
    .filter((e) => by.some((m) => m.has(e.id)))
    .map((e) => ({ event: e, label: eventLabel(e), rates: by.map((m) => m.get(e.id) ?? null) }));
}

/** The full length of a history's bars: the biggest share in it rounded up to 5%, and never under 10%, so a rare
 * habit keeps short bars. */
export function barScale(rates: (number | null)[]): number {
  const most = Math.max(0, ...rates.filter((r): r is number => r != null));
  return Math.max(0.1, Math.ceil(most * 20 - 1e-9) / 20);
}

// ---------- style differences ----------

/** A style difference the right way round for `first`: "PIA brakes later than RAC". The server words it for its
 * pair's driver a (`words`) and b (`words_b`); "than RAC" is added when the words don't say it already. */
export function traitLine(trait: Pick<StyleTrait, 'words' | 'words_b'>, flipped: boolean, first: string,
  second: string): string {
  const words = (flipped ? trait.words_b : trait.words).trim();
  return / than /.test(` ${words} `) ? `${first} ${words}` : `${first} ${words} than ${second}`;
}

export type TraitGroup = { key: string; label: string; lines: { kind: string; line: string; at: string }[] };

/** How two drivers differ every time they share the car, grouped by area in the groups' order, worded for
 * `first`; null when the pair has no data or no difference. */
export function styleDifferences(pairs: StylePair[], groups: Pick<HabitGroup, 'key' | 'label'>[],
  first: { id: number; code: string }, second: { id: number; code: string }):
  { events: number; groups: TraitGroup[] } | null {
  const pair = pairs.find((p) => (p.a === first.id && p.b === second.id) || (p.a === second.id && p.b === first.id));
  if (!pair || pair.traits.length === 0) return null;
  const flipped = pair.a !== first.id;
  const out: TraitGroup[] = [];
  for (const t of pair.traits) {
    const known = groups.find((g) => g.key === t.group);
    const key = known ? t.group : 'other';
    let g = out.find((x) => x.key === key);
    if (!g) out.push((g = { key, label: known?.label ?? 'Other', lines: [] }));
    g.lines.push({
      kind: t.kind,
      line: traitLine(t, flipped, first.code, second.code),
      at: `at ${t.agree} of ${t.of} event${t.of === 1 ? '' : 's'}`,
    });
  }
  const order = (k: string) => {
    const i = groups.findIndex((g) => g.key === k);
    return i < 0 ? groups.length : i;
  };
  return { events: pair.events, groups: out.sort((x, y) => order(x.key) - order(y.key)) };
}
