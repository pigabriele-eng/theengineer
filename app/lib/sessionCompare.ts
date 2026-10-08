// Client for the During tab's latest session, every lap (server/app/session_sections.py): GET
// /events/{id}/latest-session/sections answers the session's clean laps at once and their section times once worked
// out ("status": "working" meanwhile: ask again, lib/poll.ts). The types and what is made of them: lib/sessionLaps.ts.
import { apiFetchAgain } from '@/lib/retry';
import type { LatestSession } from '@/lib/sessionLaps';

export type { LatestSession, SessionLap, SessionRun, SessionSection } from '@/lib/sessionLaps';

export async function fetchLatestSession(eventId: number): Promise<LatestSession> {
  const res = await apiFetchAgain(`/events/${eventId}/latest-session/sections`); // asked again while unanswered
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(typeof body.detail === 'string' ? body.detail : `Request failed (${res.status})`);
  }
  return res.json() as Promise<LatestSession>;
}
