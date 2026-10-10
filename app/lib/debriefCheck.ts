// Client for the debrief check (GET /debriefs/{id}/check): each debrief point against the session's data.
import { apiFetch, DebriefCovers } from '@/lib/api';

// Balance points are read as the report's balance section reads them (degrees from the car's normal understeer),
// braking and traction against the car's other corners.
// confirmed and partly: the data backs the point; not seen: the corner is as the car usually is;
// contradicted: the data shows the opposite; cannot check: no corner, no claim, or no channel for it.
export type Verdict = 'confirmed' | 'partly' | 'not seen' | 'contradicted' | 'cannot check';
export type Agreement = 'agrees' | 'disagrees' | 'unclear';

export type CheckedPoint = {
  id: number | null;
  text: string;
  claim: string | null; // understeer, oversteer, traction, lock_up, braking_stability, abs, tyre_drop, tyre_warmup
  claim_label: string | null;
  said: string | null; // what the driver said: "understeer", "no understeer", "good traction"
  negated: boolean;
  phase: string | null;
  section: string | null; // the corner as the data times it: "T8/T9" for a point about T8
  corner: string | null; // the corner as said or tagged
  speed_band?: 'slow' | 'medium' | 'fast' | null;
  verdict: Verdict;
  agreement: Agreement;
  evidence: string; // what the data shows, one sentence
  line: string; // what was said, what the data shows and the verdict, in one line
  laps_with_it?: number;
  laps?: number;
  cause?: 'car' | 'technique' | null; // what a match or mismatch most likely comes from
  meaning?: string;
  suggestion?: string;
  // a debrief covering stints run on two or more setups: the verdict on each, in the order of `groups`
  by_group?: ({ verdict: Verdict; agreement: Agreement; line: string } | null)[];
};

export type SetupGroup = { label: string; runs: string[]; laps: number; error?: string | null };

export type DataTrait = {
  section: string;
  phase: string;
  kind: 'understeer' | 'oversteer';
  value: number; // degrees from the car's normal balance
  laps_with_it: number;
  laps: number;
  line: string;
};

export type DebriefCheck = {
  laps?: number;
  agreement?: Record<Agreement, number>;
  balance?: { per_g: number; unit: string } | null;
  unmentioned?: DataTrait[]; // the clearest balance traits in the data that no point mentions
  points: CheckedPoint[];
  error?: string;
  covers?: DebriefCovers;
  groups?: SetupGroup[]; // when the setup changed between the stints covered; the verdicts above are the last one's
};

export async function fetchDebriefCheck(id: number): Promise<DebriefCheck> {
  const res = await apiFetch(`/debriefs/${id}/check`);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.detail ?? `Request failed (${res.status})`);
  }
  return res.json() as Promise<DebriefCheck>;
}

const PHASE: Record<string, string> = { braking: 'braking', entry: 'entry', mid: 'mid-corner', exit: 'exit' };

// "T8 entry", "slow corners, exit", "Tyres"
export function placeOf(p: CheckedPoint): string {
  const where = p.corner ?? (p.speed_band ? `${p.speed_band} corners` : null);
  const phase = p.phase ? PHASE[p.phase] ?? p.phase : null;
  if (where && phase) return `${where}${p.speed_band && !p.corner ? ',' : ''} ${phase}`;
  return where ?? phase ?? 'Whole session';
}

// "said oversteer", "said no understeer"
export const saidOf = (p: CheckedPoint) => (p.said ? `said ${p.said}` : 'said');

export const CAUSE_LABEL: Record<string, string> = {
  car: 'Likely the car',
  technique: 'Likely technique',
};
