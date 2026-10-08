// The Compare page's flags, read as the During tab's. Run with `npm test`.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { asSession } from './compareFlags.ts';
import { bestFlags, bestInEachCorner, flagWords, lapKey } from './sessionLaps.ts';

const lap = (session_id, session, n, time) => ({ session_id, session, driver: null, event: null, lap: n, time,
  clean: true, sections_best: 0 });
const section = (code, times) => ({ code, start_m: 0, end_m: 1, apex_m: null, corners: [], times, best: 0 });
// lap 0 (run 8 L5) is the quickest; run 9's L2 is best in T3, run 8's L7 in T1
const data = {
  track: 'Monza', length_m: 5000, numbering: 'official', aligned_by: 'gps', reference: 0,
  laps: [lap(8, 'FP1 stint 1', 5, 100.0), lap(9, 'FP1 stint 2', 2, 100.3), lap(8, 'FP1 stint 1', 7, 100.5)],
  sections: [section('T1', [30.0, 30.1, 29.9]), section('T2', [35.0, 35.1, 35.4]), section('T3', [35.0, 34.74, 35.2])],
  corners: [], track_corners: [], opportunities: [], channels: {},
  traces: { step_m: 5, distance: [], laps: [], roles: [] },
};

test('the compared laps flagged where they hold the best corner, as on the During tab', () => {
  const s = asSession(data);
  assert.deepEqual(s.runs.map((r) => [r.id, r.laps.map((l) => l.number)]), [[8, [5, 7]], [9, [2]]]);
  assert.deepEqual(s.fastest, { session_id: 8, lap: 5, time: 100.0 });
  const flags = bestFlags(s);
  assert.deepEqual(flags.get(lapKey({ session_id: 9, lap: 2 })), [{ code: 'T3', gain: -0.26 }]);
  assert.deepEqual(flags.get('8:7'), [{ code: 'T1', gain: -0.1 }]);
  assert.equal(flags.get('8:5'), undefined);
  assert.equal(flagWords(flags.get('9:2'), 'these laps'), 'Best of these laps in T3 −0.26 s');
  assert.deepEqual(bestInEachCorner(s).map((b) => [b.code, b.fastest]), [['T1', false], ['T2', true], ['T3', false]]);
});
