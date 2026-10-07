// Uploads joining their season (server/app/season_match.py): the questions the server keeps when it isn't sure which
// round of which season an event is (or who drove its runs), the links it made by itself, and the answers. A server
// without it answers 404: then nothing is shown.
import { apiFetch } from '@/lib/api';

/** A car our drivers are on in a series round's entry list, the likeliest first: one tap answers with its number. */
export type CarChoice = { car_number: string; label: string; why: string | null };

export type MatchOption = { key: string; label: string | null; why: string | null; numbers?: CarChoice[] };

export type SeasonQuestion = {
  id: number;
  event_id: number;
  event_name: string | null;
  kind: 'round' | 'official' | 'drivers'; // a round of our seasons, a round on a series' calendar, who drove
  status: 'pending' | 'linked' | 'yes' | 'no'; // linked: joined by itself
  prompt: string;
  why: string | null;
  options: MatchOption[]; // one tap each; "no" is always an answer too
  needs: 'car_number'[]; // official: our car's number in the series isn't known yet
  series_name?: string | null;
  runs?: number; // drivers: runs still without a driver
  summary?: string; // linked: what was done, in words
  undo?: boolean; // linked: "no" takes it back
  created_at: string | null;
};

export type Pending = { count: number; questions: SeasonQuestion[]; linked: SeasonQuestion[] };
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
  /** An option's key, or 'no' (not asked again; on a link made by itself: taken back). */
  answer: (id: number, answer: string, carNumber?: string) =>
    call<Answered>(`/season-match/${id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ answer, car_number: carNumber?.trim() || null }),
    }),
};
