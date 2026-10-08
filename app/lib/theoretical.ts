// The comparisons' theoretical laps (Gabriele, 2026-10-08: "add the theoretical lap time per run and a theoretical
// lap time for both compared stints together. call them "stint theoretical" and "combined theoretical" and give the
// possibility to add the traces of such laps to the graph"), from POST /compare/theoretical (lib/compare.ts
// fetchTheoretical) for the laps compared. Only these two, on the comparisons, always named so; every report's best
// and typical laps stay real laps.
import type { LapTrace, TraceRole } from './compare.ts';

export const STINT = 'stint theoretical';
export const COMBINED = 'combined theoretical';
export const DASH = { stint: '7,4', combined: '2,3' }; // never solid, so never taken for a real lap

/** A theoretical lap: its time (the quickest real lap it starts from less what the sections gain on it), that gain,
 * that real lap, how many laps it is made from and the [run, lap] holding each section. */
export type Theoretical = {
  time: number;
  gap_s: number;
  best_run: string;
  best_lap: number;
  best_time: number;
  laps: number;
  from: [string, number][];
};
export type StintTheoretical = { run: string; session_id: number; session: string; driver: string | null }
  & ({ ready: false } | ({ ready: true } & Theoretical));
export type TheoreticalAnswer = {
  sections: string[];
  stints: StintTheoretical[];
  combined: Theoretical | null;
  traces: { step_m: number; distance: number[]; roles: TraceRole[]; stints: (LapTrace | null)[]; combined: LapTrace | null };
};

/** A theoretical lap's key on the graph: "stint:<session id>" or "combined". */
export const stintKey = (sessionId: number) => `stint:${sessionId}`;
export const COMBINED_KEY = 'combined';

/** Where each section of a theoretical lap comes from, in words: "T1-T2 L6 Run 2, T3 L6 Run 3"; `name` names a run
 * (its session id as a string) and is left out for a stint's own. */
export function fromWords(sections: string[], from: [string, number][], name?: (run: string) => string): string {
  return sections.map((code, k) => {
    const [run, lap] = from[k] ?? ['', 0];
    return `${code} L${lap}${name ? ` ${name(run)}` : ''}`;
  }).join(', ');
}

/** The theoretical laps on the graph that this answer holds, each with its trace, in the order added; only when the
 * answer's grid is the comparison's (the same laps, the same line). */
export type OnGraph = { key: string; label: string; trace: LapTrace; sessionId: number | null };
export function onGraph(answer: TheoreticalAnswer | null, keys: string[], distance: number[] | undefined): OnGraph[] {
  if (!answer || !distance || answer.traces.distance.length !== distance.length
    || answer.traces.distance.some((d, i) => d !== distance[i])) return [];
  return keys.flatMap((key): OnGraph[] => {
    if (key === COMBINED_KEY) {
      return answer.traces.combined ? [{ key, label: COMBINED, trace: answer.traces.combined, sessionId: null }] : [];
    }
    const i = answer.stints.findIndex((s) => stintKey(s.session_id) === key);
    const trace = i >= 0 ? answer.traces.stints[i] : null;
    return trace ? [{ key, label: `${STINT} · ${answer.stints[i].session}`, trace, sessionId: answer.stints[i].session_id }] : [];
  });
}

/** A key added or taken off the graph. */
export const flipKey = (keys: string[], key: string) =>
  (keys.includes(key) ? keys.filter((k) => k !== key) : [...keys, key]);
