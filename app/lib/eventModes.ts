// Client for an event's mode (GET/PUT /events/{id}/mode): a race weekend or a coaching day. An event never set is
// a race weekend. GET /events/folders also says each event's mode (null for the runs in no event).
import { useSyncExternalStore } from 'react';

import { apiFetch } from '@/lib/api';

export type EventMode = 'weekend' | 'coaching';

// What GET /events/folders adds to each folder (lib/events.ts FolderSummary).
export type WithMode = { mode?: EventMode | null };

export const isCoaching = (folder: WithMode) => folder.mode === 'coaching';

// Each event's mode as the server last said it, so the masthead can underline Coaching on a coaching day's page.
const known = new Map<number, EventMode>();
const listeners = new Set<() => void>();
let version = 0;

function note(eventId: number, mode: EventMode): EventMode {
  if (known.get(eventId) !== mode) {
    known.set(eventId, mode);
    version++;
    listeners.forEach((f) => f());
  }
  return mode;
}

/** An event's mode once it has been read or set (null before, and for no event). */
export function useKnownMode(eventId: number | null): EventMode | null {
  useSyncExternalStore((f) => {
    listeners.add(f);
    return () => {
      listeners.delete(f);
    };
  }, () => version, () => version);
  return eventId == null ? null : known.get(eventId) ?? null;
}

async function modeOf(res: Response): Promise<EventMode> {
  if (!res.ok) throw new Error((await res.json().catch(() => null))?.detail ?? `HTTP ${res.status}`);
  return ((await res.json()) as { mode: EventMode }).mode;
}

export async function fetchMode(eventId: number): Promise<EventMode> {
  return note(eventId, await modeOf(await apiFetch(`/events/${eventId}/mode`)));
}

export async function setMode(eventId: number, mode: EventMode): Promise<EventMode> {
  return note(eventId, await modeOf(
    await apiFetch(`/events/${eventId}/mode`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode }),
    }),
  ));
}
