// The During tab's fastest runs of a session. Run with `npm test`.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { defaultRuns, driversFastest, flipRun, MAX_RUNS, runsByPart } from './fastestRuns.ts';

const part = (title, runs) => ({ code: title, title, runs });
const run = (id, driver, best) => ({ id, name: `Run ${id}`, short: `R${id}`, driver, clean_laps: 3, best });

test('by default the latest session with a timed run, quickest first', () => {
  const parts = [part('FP1', [run(1, 'Piana', 101.2), run(2, 'Rackl', 100.9)]),
    part('FP2', [run(3, 'Piana', 100.5), run(4, 'Rackl', 100.7), run(5, 'Piana', 100.4), run(6, 'Rackl', null)]),
    part('Q', [run(7, 'Piana', null)])];
  const by = runsByPart(parts, (id) => (id === 4 ? null : id * 10));
  assert.deepEqual(by.map((p) => p.part.title), ['FP1', 'FP2']); // Q has no timed run; run 4 no fastest lap number
  const d = defaultRuns(by);
  assert.equal(d.title, 'FP2');
  assert.deepEqual(d.ids, [5, 3]);
  assert.deepEqual(defaultRuns([]), { title: null, ids: [] });
});

test("each driver's fastest is marked", () => {
  const runs = [{ id: 1, driver: 'Piana', time: 100.5 }, { id: 2, driver: 'Rackl', time: 100.7 },
    { id: 3, driver: 'Piana', time: 100.4 }, { id: 4, driver: null, time: 101 }];
  assert.deepEqual([...driversFastest(runs)].sort(), [2, 3, 4]);
});

test('ticking runs, at most a comparison of them', () => {
  assert.deepEqual(flipRun([1, 2], 2), [1]);
  assert.deepEqual(flipRun([1], 3), [1, 3]);
  const full = Array.from({ length: MAX_RUNS }, (_, i) => i);
  assert.deepEqual(flipRun(full, 99), full);
});
