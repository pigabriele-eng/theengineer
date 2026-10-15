// The comparisons' theoretical laps (Gabriele, 2026-10-08: "add the theoretical lap time per run and a theoretical
// lap time for both compared stints together. call them "stint theoretical" and "combined theoretical" and give the
// possibility to add the traces of such laps to the graph"), from POST /compare/theoretical (lib/compare.ts
// fetchTheoretical) for the laps compared. Only these two, on the comparisons, always named so; every report's best
// and typical laps stay real laps.
import type { LapTrace, TraceRole } from './compare.ts';
import type { TheoreticalSpec } from './racingLineMath.ts';

export const STINT = 'stint theoretical';
export const COMBINED = 'combined theoretical';
export const DASH = { stint: '7,4', combined: '2,3' }; // never solid, so never taken for a real lap

/** What the lap holding a corner of a theoretical does differently from the real lap the theoretical is told from
 * (server/app/analysis/lapcompare.py _CornerWords): what it gains there, the phase where most of it comes ("braking",
 * "entry", "mid-corner", "exit", "full throttle"), the differences in the racing line page's words (`does`: "brakes
 * 6 m later", "is 0.8 m nearer the inside at the apex") and what else differs (`also`: "brakes 9% harder"). */
export type Tip = {
  code: string;
  from: [string, number];
  versus: [string, number];
  gain_s: number;
  phase: string;
  phase_s: number;
  does: string[];
  also: string[];
};

/** A theoretical lap: its time (the quickest real lap it starts from less what the sections gain on it), that gain,
 * that real lap, how many laps it is made from, the [run, lap] holding each section and what it gains there on that
 * real lap (`gains`, 0 where that lap holds it itself), and its tips: each corner it gains 0.02 s or more in, the
 * biggest first (both missing from an answer made before they were added). */
export type Theoretical = {
  time: number;
  gap_s: number;
  best_run: string;
  best_lap: number;
  best_time: number;
  laps: number;
  from: [string, number][];
  gains?: number[];
  tips?: Tip[];
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

/** The theoretical laps of this answer to drive in 3D beside the real laps (components/racingline/RacingLineView.tsx):
 * each ready stint's and the combined one, or only those whose keys are given, with the real lap holding each
 * section. */
export function stitchSpecs(answer: TheoreticalAnswer | null, keys?: string[]): TheoreticalSpec[] {
  if (!answer) return [];
  const spec = (kind: TheoreticalSpec['kind'], from: [string, number][]): TheoreticalSpec => ({
    kind, from: answer.sections.map((code, k) => ({ code, session_id: Number(from[k][0]), lap: from[k][1] })),
  });
  const out: { key: string; spec: TheoreticalSpec }[] = answer.stints.flatMap((s) => (s.ready
    ? [{ key: stintKey(s.session_id), spec: spec('stint', s.from) }] : []));
  if (answer.combined) out.push({ key: COMBINED_KEY, spec: spec('combined', answer.combined.from) });
  return out.filter((o) => !keys || keys.includes(o.key)).map((o) => o.spec);
}
