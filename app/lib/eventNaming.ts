// Client for naming the events an upload made (server/app/routers/event_naming.py): each new event with a name from
// its logs' headers and the events that look like the same race weekend, and putting its sessions into one of those.
import { apiFetch } from '@/lib/api';
import { Folder } from '@/lib/events';

export type EventMatch = {
  id: number;
  key: string;
  name: string;
  track: string | null;
  start: string | null;
  end: string | null;
  dates_by_hand: boolean;
  sessions: number;
  clean_laps: number;
  best_lap_s: number | null;
  // the same header event name at the same venue, the same venue on the same days, or a planned event with no data
  // yet planned there on those days
  why: 'event' | 'dates' | 'planned';
};

export type NewEvent = Omit<EventMatch, 'why'> & {
  zip: string | null; // the zip it was made for, without .zip
  venue: string | null;
  log_event: string | null; // the event name in the logs' headers, e.g. GT4_ES_R05
  suggested_name: string;
  matches: EventMatch[];
};

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await apiFetch(path, init);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(typeof body.detail === 'string' ? body.detail : `Request failed (${res.status})`);
  }
  return res.json() as Promise<T>;
}

export const namingApi = {
  // the events this import made that are still there
  newEvents: (jobId: number) => call<{ job_id: number; events: NewEvent[] }>(`/imports/${jobId}/events`),
  // every session of the event into another one; the empty event goes
  merge: (id: number, into: number) =>
    call<{ merged: number; moved: number[]; into: Folder }>(`/events/${id}/merge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ into }),
    }),
};
