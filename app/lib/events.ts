// Client for events as folders (server/app/routers/events.py): the events with their dates and sessions by day,
// making, renaming, re-dating and deleting events, moving sessions between them, and sessions side by side.
import { apiFetch, ImportJob, SessionKind } from '@/lib/api';

export const NO_EVENT = 'none'; // the folder of the sessions in no event

export type FolderSummary = {
  id: number | null; // null: the sessions in no event
  key: string; // the event id, or "none"
  name: string;
  series: string | null;
  track: string | null;
  start: string | null; // ISO dates: set by hand, else the logs' first and last day
  end: string | null;
  dates_by_hand: boolean;
  log_start: string | null;
  log_end: string | null;
  sessions: number;
  clean_laps: number;
  best_lap_s: number | null;
  best_session_id: number | null;
  best_session: string | null;
  // the season (championship) it is in, as a round of it or put in it by hand; null: none (in the list only)
  season?: FolderSeason | null;
  // who drove it and in what (in the list only): the runs' drivers and cars (a car by its model, else its name),
  // each once, the most laps first
  drivers?: string[];
  driver_laps?: { name: string; laps: number }[]; // each driver's laps in all, the most first
  unassigned_laps?: number; // laps of runs without a driver yet
  cars?: string[];
};

export type FolderSeason = { id: number; name: string; year: number; round: number | null };

export type FolderSession = {
  id: number;
  name: string;
  kind: SessionKind;
  event_id: number | null;
  driver: string | null;
  date: string | null; // the day its log was recorded
  time: string | null; // HH:MM the log started
  log_session: string | null; // the session the logger names, e.g. D1S1
  laps: number;
  clean_laps: number;
  best_lap_s: number | null;
  best_lap: number | null;
  typical_s: number | null;
  consistency: number | null;
  has_log: boolean;
};

export type Day = { date: string | null; sessions: FolderSession[] };
export type Folder = FolderSummary & { days: Day[] };

export type ComparedSession = FolderSession & {
  state: 'ready' | 'working' | 'failed' | 'no laps';
  note: string | null;
  ideal_s: number | null; // its best sections added up
  top_speed_kmh: number | null;
  tyres: { pressure?: Record<string, number>; temp?: Record<string, number> };
  tyre_units: { pressure?: string; temp?: string };
  conditions: { label: string; unit: string; value: number }[];
};

export type ComparedSection = {
  code: string; // official corner numbers, e.g. "T2-T5"
  corners: string[];
  start_m: number;
  end_m: number;
  apex_m: number | null;
  times: (number | null)[]; // each session's best time here, in pick order
  laps: (number | null)[]; // the lap it came from
  best: number | null; // index of the quickest
};

export type SideBySide = {
  status: 'ready' | 'working';
  progress: { done: number; total: number; current: string | null } | null;
  track: string | null;
  numbering: 'official' | 'detected' | null;
  length_m: number | null;
  reference: { session_id: number; lap: number; time: number } | null;
  sessions: ComparedSession[];
  sections: ComparedSection[];
};

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await apiFetch(path, init);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(typeof body.detail === 'string' ? body.detail : `Request failed (${res.status})`);
  }
  return res.json() as Promise<T>;
}

const send = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

export type EventFields = { name?: string; start?: string | null; end?: string | null };

// What deleting an event with its runs removes (server/app/event_delete.py): its runs, their laps, their logs, every
// stored file (logs, lap traces, technique checks, recordings) and the bytes they take in storage (null: unknown).
export type EventSize = { event_id: number | null; name: string; runs: number; laps: number; logs: number; files: number;
  bytes: number | null };
export type EventDeleted = Omit<EventSize, 'event_id'> & { deleted: number | null; rows: Record<string, number> };

export const eventsApi = {
  folders: () => call<FolderSummary[]>('/events/folders'),
  folder: (key: string) => call<Folder>(`/events/${key}`),
  create: (body: { name: string; start?: string | null; end?: string | null }) =>
    call<Folder>('/events/folders', send('POST', body)),
  update: (id: number, body: EventFields) => call<Folder>(`/events/${id}`, send('PATCH', body)),
  remove: (id: number) => call<{ deleted: number; sessions_kept: number[] }>(`/events/${id}`, { method: 'DELETE' }),
  // the event with its runs, their logs and everything kept for them: for good. NO_EVENT: the runs in no event
  size: (id: number | typeof NO_EVENT) => call<EventSize>(id === NO_EVENT ? '/loose-runs/size' : `/events/${id}/size`),
  removeWithRuns: (id: number | typeof NO_EVENT) =>
    call<EventDeleted>(id === NO_EVENT ? '/loose-runs' : `/events/${id}?runs=delete`, { method: 'DELETE' }),
  // move sessions into an event, or out of their events with NO_EVENT
  move: (key: string, sessionIds: number[]) =>
    call<Folder>(`/events/${key}/sessions`, send('POST', { session_ids: sessionIds })),
  createSession: (body: { name: string; kind: SessionKind; event_id: number | null }) =>
    call<{ id: number }>('/sessions', send('POST', body)),
  updateSession: (id: number, body: { name?: string; kind?: SessionKind; event_id?: number | null }) =>
    call<FolderSession>(`/sessions/${id}`, send('PATCH', body)),
  compare: (key: string, sessionIds: number[]) =>
    call<SideBySide>(`/events/${key}/compare?sessions=${sessionIds.join(',')}`),
  // Every file in one request, each log a session in the event given; without one, a zip makes an event of its own.
  // On the web each file goes with the name given: a dropped folder's files with their path in it ("T01/D1S1/a.ld").
  importInto: (files: PickedFile[], eventId: number | null) => {
    const form = new FormData();
    for (const f of files) {
      const part = formFile(f, f.mimeType || 'application/octet-stream');
      if (f.file) form.append('files', part, f.name);
      else form.append('files', part);
    }
    if (eventId != null) form.append('event_id', String(eventId));
    return call<ImportJob>('/imports', { method: 'POST', body: form });
  },
};

type PickedFile = { uri: string; name: string; file?: File | Blob; mimeType?: string };

/** Bytes as storage sizes read: "764 MB", "2.4 MB", "1.3 GB". */
export function storageSize(bytes: number) {
  const mb = bytes / 1024 ** 2;
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  return mb >= 10 ? `${Math.round(mb)} MB` : `${mb.toFixed(1)} MB`;
}

// On web we have a File or Blob; on iOS FormData takes a { uri, name, type } descriptor (as in lib/api.ts).
const formFile = (f: PickedFile, type: string) =>
  f.file ? (f.file instanceof File ? f.file : new File([f.file], f.name, { type: f.file.type || type }))
    : ({ uri: f.uri, name: f.name, type } as any); // eslint-disable-line @typescript-eslint/no-explicit-any

// ---------- dates ----------

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// An ISO date as a calendar day, the same wherever the phone is (no time zone shift).
const parts = (iso: string) => {
  const [y, m, d] = iso.split('-').map(Number);
  return { y, m, d, wd: new Date(Date.UTC(y, m - 1, d)).getUTCDay() };
};

/** "Mon 5 May 2025"; with long, "Monday 5 May". */
export function dayLabel(iso: string, opts: { long?: boolean; year?: boolean } = {}) {
  const p = parts(iso);
  const wd = opts.long ? WEEKDAYS[p.wd] : DAYS[p.wd];
  return `${wd} ${p.d} ${MONTHS[p.m - 1]}${opts.year ? ` ${p.y}` : ''}`;
}

/** "Fri 3 – Sun 5 Oct 2025", "Fri 31 Oct – Sun 2 Nov 2025", "Mon 5 May 2025". */
export function dateRange(start: string | null, end: string | null) {
  if (!start && !end) return null;
  const a = parts((start ?? end)!);
  const b = parts((end ?? start)!);
  if (a.y === b.y && a.m === b.m && a.d === b.d) return dayLabel((start ?? end)!, { year: true });
  const left = `${DAYS[a.wd]} ${a.d}${a.m !== b.m || a.y !== b.y ? ` ${MONTHS[a.m - 1]}` : ''}${a.y !== b.y ? ` ${a.y}` : ''}`;
  return `${left} – ${DAYS[b.wd]} ${b.d} ${MONTHS[b.m - 1]} ${b.y}`;
}

/** A date as typed: 5/5/2025, 05.05.2025 or 2025-05-05 (day first, as on the loggers). ISO, or null if not a date. */
export function parseDay(text: string): string | null {
  const t = text.trim();
  let y: number, m: number, d: number;
  let hit = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (hit) [y, m, d] = [Number(hit[1]), Number(hit[2]), Number(hit[3])];
  else {
    hit = t.match(/^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{2}|\d{4})$/);
    if (!hit) return null;
    [d, m, y] = [Number(hit[1]), Number(hit[2]), Number(hit[3])];
    if (y < 100) y += 2000;
  }
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** An ISO date as the form shows it: 05/05/2025. */
export const typedDay = (iso: string | null) => {
  if (!iso) return '';
  const p = parts(iso);
  return `${String(p.d).padStart(2, '0')}/${String(p.m).padStart(2, '0')}/${p.y}`;
};

/** "Day 1 · Monday 5 May", or "Date not known" for sessions without a log date. */
export function dayTitle(days: Day[], i: number) {
  const day = days[i];
  if (!day.date) return 'Date not known';
  const n = days.slice(0, i + 1).filter((x) => x.date).length;
  return `Day ${n} · ${dayLabel(day.date, { long: true })}`;
}

// ---------- session labels ----------

export const KIND_NAMES: Record<SessionKind, string> = {
  test: 'Test',
  practice: 'Practice',
  qualifying: 'Qualifying',
  race: 'Race',
};

// One tap names a session and sets its kind.
export const QUICK_LABELS: { label: string; kind: SessionKind }[] = [
  { label: 'FP1', kind: 'practice' },
  { label: 'FP2', kind: 'practice' },
  { label: 'FP3', kind: 'practice' },
  { label: 'Q1', kind: 'qualifying' },
  { label: 'Q2', kind: 'qualifying' },
  { label: 'Race 1', kind: 'race' },
  { label: 'Race 2', kind: 'race' },
  { label: 'Warm-up', kind: 'practice' },
  { label: 'Test', kind: 'test' },
];

/** Every session of a folder in day order, for switching between them. */
export const sessionsInOrder = (folder: Folder | null) => folder?.days.flatMap((d) => d.sessions) ?? [];
