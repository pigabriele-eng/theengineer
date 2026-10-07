// Uploads joining their season (server/app/season_match.py): the questions the server keeps when it isn't sure which
// round of which season an event is (or who drove runs the driving style can't name), the links it made by itself,
// and the answers. A server without it answers 404: then nothing is shown.
import { apiFetch } from '@/lib/api';

export type MatchOption = { key: string; label: string | null; why: string | null };

export type SeasonQuestion = {
  id: number;
  event_id: number;
  event_name: string | null;
  kind: 'round' | 'official' | 'driver'; // a round of our seasons, a round on a series' calendar, a new driver
  status: 'pending' | 'linked' | 'yes' | 'no'; // linked: joined by itself
  prompt: string;
  why: string | null;
  options: MatchOption[]; // one tap each; "no" is always an answer too (driver: and "other" with a name typed in)
  needs: 'car_number'[]; // official: our car's number in the series isn't known yet
  series_name?: string | null;
  runs?: number; // driver: runs still without a driver
  summary?: string; // linked: what was done, in words
  undo?: boolean; // linked: "no" takes it back
  created_at: string | null;
};

// checking: the driving style of these events is still being read, so a driver question may follow (ask again)
export type Pending = { count: number; questions: SeasonQuestion[]; linked: SeasonQuestion[]; checking?: boolean };
export type Answered = { done: string; questions: SeasonQuestion[] };

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await apiFetch(path, init);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const detail = Array.isArray(body.detail) ? body.detail.map((d: { msg: string }) => d.msg).join('; ') : body.detail;
    throw new Error(typeof detail === 'string' ? detail : `Request failed (${res.status})`);
  }
  return res.json() as Promise<T>;
}

export const seasonMatchApi = {
  /** Waiting questions: every one, one event's, or those of the events these runs are in (with what joined by itself). */
  pending: (scope: { eventId?: number; runIds?: number[] } = {}) => {
    const q = new URLSearchParams();
    if (scope.eventId != null) q.set('event_id', String(scope.eventId));
    if (scope.runIds?.length) q.set('runs', scope.runIds.join(','));
    const qs = q.toString();
    return call<Pending>(`/season-match/pending${qs ? `?${qs}` : ''}`);
  },
  /** An option's key, 'no' (not asked again; on a link made by itself: taken back), or 'other' with a driver's
   * name typed in. */
  answer: (id: number, answer: string, carNumber?: string, driverName?: string) =>
    call<Answered>(`/season-match/${id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ answer, car_number: carNumber?.trim() || null, driver_name: driverName?.trim() || null }),
    }),
};
