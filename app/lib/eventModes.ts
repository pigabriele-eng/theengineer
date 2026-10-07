// Client for an event's mode (GET/PUT /events/{id}/mode): a race weekend or a coaching day. An event never set is
// a race weekend. GET /events/folders also says each event's mode (null for the runs in no event).
import { apiFetch } from '@/lib/api';

export type EventMode = 'weekend' | 'coaching';

// What GET /events/folders adds to each folder (lib/events.ts FolderSummary).
export type WithMode = { mode?: EventMode | null };

export const isCoaching = (folder: WithMode) => folder.mode === 'coaching';

async function modeOf(res: Response): Promise<EventMode> {
  if (!res.ok) throw new Error((await res.json().catch(() => null))?.detail ?? `HTTP ${res.status}`);
  return ((await res.json()) as { mode: EventMode }).mode;
}

export async function fetchMode(eventId: number): Promise<EventMode> {
  return modeOf(await apiFetch(`/events/${eventId}/mode`));
}

export async function setMode(eventId: number, mode: EventMode): Promise<EventMode> {
  return modeOf(
    await apiFetch(`/events/${eventId}/mode`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode }),
    }),
  );
}
