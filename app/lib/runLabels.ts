// The report's runs by their own names (server/app/run_labels.py): "FP1 stint 1", "Q1 · Gabriele Piana", "PTS 1",
// never a number or a position. The report calls its runs by these names; a report kept from before a run was renamed
// still calls it by its old name, so a run is looked up by its session id (the report's runs carry it) and called by
// its name now.
import type { ReportAnswer, RunName } from './report';

export type RunNamer = {
  /** The run's name now, from the name the report gives it (and its session id, when known). */
  name: (run: string, sessionId?: number | null) => string;
  /** The same in a few characters, for a chip, a cell or a chart's readout. */
  short: (run: string, sessionId?: number | null) => string;
  /** A lap key of the report ("<run>#<lap>") in words: "FP1 stint 1 lap 13". */
  lap: (key: string) => string;
  byId: (id: number) => RunName | undefined;
};

export function runNamer(answer: ReportAnswer | null): RunNamer {
  const byId = new Map((answer?.runs ?? []).map((r) => [r.id, r]));
  // the report's own names of its runs -> their sessions
  const idOf = new Map<string, number>();
  for (const r of answer?.report?.trends.runs ?? []) if (r.session_id != null) idOf.set(r.run, r.session_id);
  for (const s of answer?.sessions ?? []) if (!idOf.has(s.name)) idOf.set(s.name, s.id);
  const find = (run: string, sessionId?: number | null) => byId.get(sessionId ?? idOf.get(run) ?? -1);
  const name = (run: string, sessionId?: number | null) => find(run, sessionId)?.name ?? run;
  return {
    name,
    short: (run, sessionId) => find(run, sessionId)?.short ?? run,
    lap: (key) => {
      const i = key.lastIndexOf('#');
      return i < 0 ? key : `${name(key.slice(0, i))} lap ${key.slice(i + 1)}`;
    },
    byId: (id) => byId.get(id),
  };
}
