// Client for the laps to compare first on a race weekend (GET /events/{id}/compare/suggestions,
// server/app/compare_suggest.py): pairs of real laps, like with like on tyres, each with the corners where most of the
// gap is, and the event's sessions with every lap of their runs, to pick laps by hand.
import { apiFetch } from '@/lib/api';

export type Tyres = 'new' | 'used';
export type RunKind = 'qualifying' | 'race' | 'practice' | 'test';

export type SuggestedLap = {
  session_id: number;
  lap: number;
  time: number;
  run: string; // the run's name as the event page shows it ("FP1 stint 1", "Q1", "03_Q (2)")
  session: string; // the official session it ran in ("FP1", "Q1", "R1", or its log folder's name)
  kind: RunKind;
  tyres: Tyres;
  tyres_sure: boolean; // false: guessed from the laps (a test or practice run nobody said the tyres of)
  driver: string | null;
  driver_id: number | null;
  role: 'best' | 'typical'; // typical: the stint's lap nearest its median
};

export type SuggestedCorner = { code: string; loss_s: number; phase: string };

export type Suggestion = {
  kind: 'teammates' | 'progress' | 'consistency';
  tyres: Tyres;
  laps: [SuggestedLap, SuggestedLap];
  slower: 0 | 1; // the lap the corners are about: where it loses to the other
  gap_s: number;
  corners: SuggestedCorner[] | null; // null while it is worked out
  numbering?: 'official' | 'detected';
  error?: string;
  median_s?: number; // consistency: the stint's median and how many clean laps it has
  stint_laps?: number;
};

export type PickLap = { number: number; time: number; clean: boolean };
export type PickRun = {
  id: number;
  name: string;
  driver: string | null;
  driver_id: number | null;
  kind: RunKind;
  tyres: Tyres;
  tyres_sure: boolean;
  laps: PickLap[];
};
export type PickSession = { code: string; title: string; runs: PickRun[] };

export type Suggestions = {
  event_id: number;
  status: 'working' | 'ready';
  progress: { done: number; total: number } | null;
  suggestions: Suggestion[];
  notes: string[];
  sessions: PickSession[];
};

export async function fetchSuggestions(eventId: number): Promise<Suggestions> {
  const res = await apiFetch(`/events/${eventId}/compare/suggestions`);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(typeof body.detail === 'string' ? body.detail : `Request failed (${res.status})`);
  }
  return res.json() as Promise<Suggestions>;
}
