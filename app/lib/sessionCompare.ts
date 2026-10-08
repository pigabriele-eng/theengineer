// Client for the During tab's latest session, every lap (server/app/session_sections.py): GET
// /events/{id}/latest-session/sections answers the session's clean laps at once and their section times once worked
// out ("status": "working" meanwhile: ask again, lib/poll.ts). ?part= and ?add= ask for another session, with stints
// of other sessions mixed in (lib/sessionPick.ts). The types and what is made of them: lib/sessionLaps.ts.
import { apiFetchAgain } from '@/lib/retry';
import type { LatestSession, SessionRun } from '@/lib/sessionLaps';
import { queryOf, SessionChoice, SessionPick } from '@/lib/sessionPick';

export type { LatestSession, SessionLap, SessionRun, SessionSection } from '@/lib/sessionLaps';

/** The answer, with what the picker needs: the sessions to pick from, the latest one's code, the runs mixed in. */
export type PickedSession = LatestSession & {
  sessions?: SessionChoice[];
  latest?: string | null;
  added?: number[];
};

/** A run's own session ("R1"), as the answer names it: what a stint mixed in from another session shows. */
export const sessionOf = (r: SessionRun): string | null => (r as SessionRun & { session?: string }).session ?? null;

export async function fetchLatestSession(eventId: number, pick?: SessionPick): Promise<PickedSession> {
  // asked again while unanswered
  const res = await apiFetchAgain(`/events/${eventId}/latest-session/sections${pick ? queryOf(pick) : ''}`);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(typeof body.detail === 'string' ? body.detail : `Request failed (${res.status})`);
  }
  return res.json() as Promise<PickedSession>;
}
