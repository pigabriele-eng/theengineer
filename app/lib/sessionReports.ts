// Client for the session reports (server/app/routers/reports.py): one report per official session of a weekend
// (FP1, Q1, R1...), made from every run of that session (both drivers' stints). GET /reports/events/{id}/parts lists
// the event's sessions (lib/sessionParts.ts); GET /reports/events/{id}/sessions/{code} is one session's report,
// answered like the event's.
import { apiFetch } from '@/lib/api';
import { ReportAnswer } from '@/lib/report';
import { apiFetchAgain } from '@/lib/retry';
import type { EventParts, PartScope } from '@/lib/sessionParts';

export type { EventParts, Part, PartRun, PartScope, PartStatus } from '@/lib/sessionParts';

const base = (s: PartScope) => `/reports/events/${s.event}/sessions/${encodeURIComponent(s.part)}`;

async function call<T>(p: string, init?: RequestInit): Promise<T> {
  const res = init ? await apiFetch(p, init) : await apiFetchAgain(p); // a read is asked again while unanswered
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.detail ?? `Request failed (${res.status})`);
  }
  return res.json() as Promise<T>;
}

export const fetchParts = (eventId: number) => call<EventParts>(`/reports/events/${eventId}/parts`);
export const fetchPartReport = (s: PartScope) => call<ReportAnswer>(base(s));
export const refreshPartReport = (s: PartScope) => call<ReportAnswer>(`${base(s)}/refresh`, { method: 'POST' });
