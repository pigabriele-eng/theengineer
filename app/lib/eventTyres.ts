// The requests behind the tyre rows (components/TyrePicks.tsx): every run of an event with its tyres
// (GET /technique/events/{id}/tyres), the events an upload's runs are in, and one run's tyres set
// (PUT /technique/sessions/{id}/tyres, lib/technique.ts setSessionTyres).
import { apiFetch } from '@/lib/api';
import { EventTyres } from '@/lib/tyrePicks';

export { setSessionTyres } from '@/lib/technique';

async function call<T>(path: string): Promise<T> {
  const res = await apiFetch(path);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(typeof body.detail === 'string' ? body.detail : `Request failed (${res.status})`);
  }
  return res.json() as Promise<T>;
}

/** Every run of the event in the order they ran, each with its tyres: the driver's pick, else the guess and why. */
export const eventTyres = (eventId: number) => call<EventTyres>(`/technique/events/${eventId}/tyres`);

export type UploadEvent = { id: number; name: string | null };

/** The events these runs are in, in the order the runs first name them (GET /sessions lists every run with its
 * event); runs in no event are left out (their tyres are guessed and set per event). */
export async function eventsOf(runIds: number[]): Promise<UploadEvent[]> {
  const all = await call<{ id: number; event_id: number | null; event_name?: string | null }[]>('/sessions');
  const byId = new Map(all.map((s) => [s.id, s]));
  const out = new Map<number, UploadEvent>();
  for (const id of runIds) {
    const s = byId.get(id);
    if (s?.event_id != null && !out.has(s.event_id)) out.set(s.event_id, { id: s.event_id, name: s.event_name ?? null });
  }
  return [...out.values()];
}
