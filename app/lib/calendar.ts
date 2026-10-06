// Client for planned events and the racing calendar (server/app/routers/planned.py), and the Past / Current /
// Upcoming filter of the event list.
import { apiFetch } from '@/lib/api';
import { Folder, FolderSummary } from '@/lib/events';

export type CalendarEntry = {
  id: number;
  title: string;
  location: string | null;
  venue: string | null; // the location's first part
  start: string; // ISO days, the last one included
  end: string;
  included: boolean; // on: an event in the app; off: left out, also on later syncs
  event_id: number | null;
  has_data: boolean;
};

export type CalendarFeed = {
  host: string | null; // all the app ever sees of the secret address: its host and last four characters
  ends_with: string | null;
  name: string | null; // the calendar's own name
  auto_add: boolean; // new calendar entries become events by themselves
  checked_at: string | null;
  synced_at: string | null;
  error: string | null; // what went wrong with the last try
  summary: Partial<Record<'added' | 'updated' | 'removed' | 'waiting' | 'switched_off' | 'repeating', number>>;
  syncing: boolean;
};

export type Plan = { event_id: number; venue: string | null; from_calendar: boolean };

export type CalendarState = {
  feed: CalendarFeed | null;
  entries: CalendarEntry[];
  plans: Plan[];
  note: string | null;
};

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await apiFetch(path, init);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(typeof body.detail === 'string' ? body.detail : `Request failed (${res.status})`);
  }
  return res.json() as Promise<T>;
}

const send = (method: string, body?: unknown): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body),
});

export const calendarApi = {
  state: () => call<CalendarState>('/calendar'),
  // The secret address goes to the server once, here, and never comes back.
  connect: (url: string, autoAdd: boolean) =>
    call<CalendarState>('/calendar', send('PUT', { url, auto_add: autoAdd })),
  setAutoAdd: (on: boolean) => call<CalendarState>('/calendar', send('PATCH', { auto_add: on })),
  disconnect: () => call<CalendarState>('/calendar', { method: 'DELETE' }),
  sync: () => call<CalendarState>('/calendar/sync', { method: 'POST' }),
  include: (entryId: number, on: boolean) =>
    call<CalendarState>(`/calendar/entries/${entryId}`, send('PATCH', { included: on })),
  plan: (body: { name: string; venue: string | null; start: string | null; end: string | null }) =>
    call<Folder>('/planned-events', send('POST', body)),
  removePlanned: (eventId: number) => call<{ deleted: number }>(`/planned-events/${eventId}`, { method: 'DELETE' }),
};

/** "2 added, 1 updated" from what a sync changed. */
export function syncSummary(s: CalendarFeed['summary']) {
  const parts = [
    s.added ? `${s.added} added` : null,
    s.updated ? `${s.updated} updated` : null,
    s.removed ? `${s.removed} removed` : null,
    s.waiting ? `${s.waiting} waiting for you to switch on` : null,
  ].filter(Boolean);
  return parts.length ? parts.join(', ') : 'no changes';
}

/** "14:05" today, else "3 Oct 14:05". */
export function clockLabel(iso: string | null) {
  if (!iso) return null;
  const t = new Date(iso);
  const hm = `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`;
  if (todayIso(t) === todayIso()) return hm;
  return `${t.getDate()} ${t.toLocaleString('en-GB', { month: 'short' })} ${hm}`;
}

// ---------- the filter ----------

export type When = 'past' | 'current' | 'upcoming';
export type Filter = When | 'all';

export const FILTERS: { key: Filter; label: string }[] = [
  { key: 'past', label: 'Past' },
  { key: 'current', label: 'Current' },
  { key: 'upcoming', label: 'Upcoming' },
  { key: 'all', label: 'All' },
];

/** Today on this phone, as an ISO day. */
export function todayIso(now: Date = new Date()) {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

const addDays = (iso: string, n: number) => {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
};

/** Current from the day before an event (travel and setup) to its last day; upcoming before that; past after. A
 * planned event without days yet is upcoming. */
export function whenOf(f: FolderSummary, today: string): When {
  const start = f.start ?? f.end;
  const end = f.end ?? f.start;
  if (!start || !end) return f.sessions > 0 ? 'past' : 'upcoming';
  if (end < today) return 'past';
  return addDays(start, -1) <= today ? 'current' : 'upcoming';
}

export function countByWhen(folders: FolderSummary[], today: string): Record<Filter, number> {
  const n: Record<Filter, number> = { past: 0, current: 0, upcoming: 0, all: folders.length };
  for (const f of folders) n[whenOf(f, today)] += 1;
  return n;
}

/** What the list opens on: what's on now, else the events already driven, else what's coming. */
export function defaultFilter(n: Record<Filter, number>): Filter {
  if (n.current) return 'current';
  if (n.past) return 'past';
  if (n.upcoming) return 'upcoming';
  return 'all';
}

/** The folders a filter shows: the next event first for upcoming and current, the newest first otherwise. */
export function filtered(folders: FolderSummary[], filter: Filter, today: string) {
  const shown = filter === 'all' ? folders : folders.filter((f) => whenOf(f, today) === filter);
  if (filter !== 'upcoming' && filter !== 'current') return shown;
  const key = (f: FolderSummary) => f.start ?? f.end ?? '9999';
  return [...shown].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
}
