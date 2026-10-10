// Client for the laps to compare first on a race weekend (GET /events/{id}/compare/suggestions,
// server/app/compare_suggest.py): pairs of real laps, like with like on tyres, each with the corners where most of the
// gap is, and the event's sessions with every lap of their runs, to pick laps by hand.
import { apiFetch, LapPick } from '@/lib/api';
import { TYRE_LABEL, TyreLevel } from '@/lib/tyreLevels';

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
  tyres_level?: TyreLevel | null; // the four levels (lib/tyreLevels.ts); `tyres` pairs them as new or not
  tyres_label?: string; // its label ("Very used"), added here from tyres_level
  driver: string | null;
  driver_id: number | null;
  role: 'best' | 'typical'; // typical: the stint's lap nearest its median
};

/** The technique check's costliest mistake of the slower lap at a corner (routers/technique.py, its obvious ones). */
export type CornerMistake = { kind: string; words: string; cost_s: number };

export type SuggestedCorner = { code: string; loss_s: number; phase: string; mistake?: CornerMistake | null };

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

export type PickLap = {
  number: number;
  time: number;
  clean: boolean;
  pick?: LapPick | null; // its type set by hand (components/LapType.tsx): it wins
  kind?: 'out' | 'build' | 'in' | 'slow' | null; // what it is when it isn't clean (null: clean)
};
export type PickRun = {
  id: number;
  name: string;
  driver: string | null;
  driver_id: number | null;
  kind: RunKind;
  tyres: Tyres;
  tyres_sure: boolean;
  tyres_level?: TyreLevel | null;
  tyres_label?: string; // as on a lap
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
  // the technique check the corners' mistakes come from: working while it is worked out (ask again for them)
  technique?: 'ready' | 'working' | 'none';
};

/** A lap's or a run's tyres with the label of its level ("New", "Fresh", "Used", "Very used"), when the server says
 * the level. */
const labelled = <T extends { tyres_level?: TyreLevel | null }>(x: T): T =>
  (x.tyres_level && TYRE_LABEL[x.tyres_level] ? { ...x, tyres_label: TYRE_LABEL[x.tyres_level] } : x);

export async function fetchSuggestions(eventId: number): Promise<Suggestions> {
  const res = await apiFetch(`/events/${eventId}/compare/suggestions`);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(typeof body.detail === 'string' ? body.detail : `Request failed (${res.status})`);
  }
  const a = (await res.json()) as Suggestions;
  return {
    ...a,
    suggestions: (a.suggestions ?? []).map((s) => ({ ...s, laps: [labelled(s.laps[0]), labelled(s.laps[1])] })),
    sessions: (a.sessions ?? []).map((p) => ({ ...p, runs: p.runs.map(labelled) })),
  };
}
