// Client for the race weekend page: every debrief of an event's runs in one call (GET /events/{id}/debriefs).
import { apiFetch } from '@/lib/api';
import type { EventDebrief } from '@/lib/weekendRuns';

export const fetchEventDebriefs = async (eventId: number): Promise<EventDebrief[]> => {
  const res = await apiFetch(`/events/${eventId}/debriefs`);
  if (!res.ok) throw new Error((await res.json().catch(() => null))?.detail ?? `HTTP ${res.status}`);
  return (await res.json()) as EventDebrief[];
};
