// Our official race finishes per event, for the home list's "R1 P5 · R2 P3" (GET /results/finishes, the results
// module). One call for the whole list. An event whose round isn't known yet has none; GET /results/events/{id} works
// that out, so the upload asks for it once an import is done (warmResults). A server without it: nothing is shown.
import { apiFetch } from '@/lib/api';

export type Finish = {
  code: string; // "R1"
  label: string; // "Race 1"
  position: number | null; // overall
  class: string | null; // "Am", "Silver"
  class_position: number | null;
  status: string | null; // "classified", "DNF", ...
  car_number: string | null;
};

export type Finishes = { events: Record<string, Finish[]>; qualifying?: Record<string, Finish[]> };

export async function fetchFinishes(): Promise<Finishes | null> {
  try {
    const res = await apiFetch('/results/finishes');
    return res.ok ? ((await res.json()) as Finishes) : null;
  } catch {
    return null;
  }
}

/** Work out these events' official rounds now (after an upload), so their finishes show on the list at once. */
export function warmResults(eventIds: number[]) {
  for (const id of new Set(eventIds)) apiFetch(`/results/events/${id}`).catch(() => {});
}
