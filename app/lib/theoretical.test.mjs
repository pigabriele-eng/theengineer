// The comparisons' theoretical laps. Run with `npm test`.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { COMBINED, COMBINED_KEY, flipKey, fromWords, onGraph, STINT, stintKey } from './theoretical.ts';

const trace = (t) => ({ t, speed: t.map(() => 100) });
const answer = {
  sections: ['T1', 'T2'],
  stints: [{ run: '8', session_id: 8, session: 'FP1 stint 1', driver: 'Piana', ready: true, time: 100, gap_s: 0.2,
    best_run: '8', best_lap: 3, best_time: 100.2, laps: 5, from: [['8', 3], ['8', 4]] },
  { run: '9', session_id: 9, session: 'FP1 stint 2', driver: 'Rackl', ready: false }],
  combined: { time: 99.9, gap_s: 0.3, best_run: '8', best_lap: 3, best_time: 100.2, laps: 9, from: [['8', 3], ['9', 2]] },
  traces: { step_m: 5, distance: [0, 5, 10], roles: ['speed'], stints: [trace([0, 1, 2]), null], combined: trace([0, 1, 1.9]) },
};

test('the theoretical laps on the graph, named as Gabriele asked, only on the same grid', () => {
  const keys = [COMBINED_KEY, stintKey(9), stintKey(8)];
  const got = onGraph(answer, keys, [0, 5, 10]);
  assert.deepEqual(got.map((g) => g.label), [COMBINED, `${STINT} · FP1 stint 1`]); // the stint not ready is left out
  assert.equal(got[1].sessionId, 8);
  assert.deepEqual(onGraph(answer, keys, [0, 5]), []);
  assert.deepEqual(onGraph(null, keys, [0, 5, 10]), []);
});

test('where each section comes from, and adding and taking off', () => {
  assert.equal(fromWords(answer.sections, answer.stints[0].from), 'T1 L3, T2 L4');
  assert.equal(fromWords(answer.sections, answer.combined.from, (r) => (r === '8' ? 'FP1 stint 1' : 'FP1 stint 2')),
    'T1 L3 FP1 stint 1, T2 L2 FP1 stint 2');
  assert.deepEqual(flipKey(['a'], 'b'), ['a', 'b']);
  assert.deepEqual(flipKey(['a', 'b'], 'a'), ['b']);
});
