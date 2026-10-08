// The Compare page's flags (Gabriele, 2026-10-08: "in "compare laps" page the app should also flag all laps with better
// corners"): the laps compared, read as the During tab reads a session (lib/sessionLaps.ts), so both flag a lap and
// list the best in each corner the same way, from the comparison's own section times. Pure, so `npm test` checks it.
import type { CompareResult } from './compare.ts';
import type { LatestSession, SessionRun } from './sessionLaps.ts';

/** The laps of a comparison as a session: one stint per session (in the order first picked), each lap with its time
 * in each of the comparison's sections; the fastest is the comparison's quickest lap. */
export function asSession(data: CompareResult): LatestSession {
  const runs = new Map<number, SessionRun>();
  data.laps.forEach((l, i) => {
    const run = runs.get(l.session_id) ?? { id: l.session_id, name: l.session, short: l.session, driver: l.driver,
      driver_id: null, laps: [] };
    run.laps.push({ number: l.lap, time: l.time, sections: data.sections.map((s) => s.times[i]) });
    runs.set(l.session_id, run);
  });
  const f = data.laps[data.reference];
  return {
    event_id: 0, status: 'ready', session: null, runs: [...runs.values()], left_out: 0,
    fastest: f ? { session_id: f.session_id, lap: f.lap, time: f.time } : null,
    sections: data.sections.map(({ code, start_m, end_m, apex_m, corners }) => ({ code, start_m, end_m, apex_m, corners })),
    numbering: data.numbering, progress: null, note: null,
  };
}
