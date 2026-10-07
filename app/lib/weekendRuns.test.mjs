// The race weekend page's picks from an event's runs. Run with `npm test`.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { debriefLines, duringSections, latestAgainstBest, latestByDriver, latestRun, latestTimedRun } from './weekendRuns.ts';

const run = (id, name, best, extra = {}) => ({
  id, name, kind: 'race', event_id: 1, driver: null, date: '2026-09-19', time: '13:00', log_session: null, laps: 5,
  clean_laps: 5, best_lap_s: best, best_lap: best == null ? null : 2, typical_s: null, consistency: null, has_log: true,
  ...extra,
});
const folder = (...days) => ({ id: 1, key: '1', name: 'Zandvoort', days: days.map((sessions, i) => ({ date: `2026-09-${19 + i}`, sessions })) });

test('the latest run, and the latest timed one', () => {
  const f = folder([run(1, 'Q', 102.44), run(3, 'R1', 104.48)], [run(7, 'R2', 104.88), run(8, 'By hand', null, { has_log: false })]);
  assert.equal(latestRun(f).id, 8);
  assert.equal(latestTimedRun(f).id, 7);
  assert.equal(latestRun(folder()), null);
});

test('the latest run against the event best, or against the next best when it holds the best', () => {
  const f = folder([run(1, 'Q', 102.44), run(3, 'R1', 104.48)], [run(7, 'R2', 104.88)]);
  const a = latestAgainstBest(f);
  assert.deepEqual([a.latest.session_id, a.best.session_id, a.holdsBest], [7, 1, false]);
  const b = latestAgainstBest(folder([run(1, 'Q', 102.44), run(3, 'R1', 101.9)]));
  assert.deepEqual([b.latest.session_id, b.best.session_id, b.holdsBest], [3, 1, true]);
  assert.equal(latestAgainstBest(folder([run(1, 'Q', 102.44), run(2, 'FP', null)])), null);
  assert.equal(duringSections(f), 6);
  assert.equal(duringSections(folder([run(1, 'Q', 102.44)])), 4);
});

test('each driver\'s latest timed run, the most recent first; no driver set counts as one', () => {
  const f = folder([run(1, 'Q', 102.4, { driver: 'Ann', driver_id: 4 }), run(2, 'Q2', 103, { driver: 'Ben', driver_id: 5 })],
    [run(3, 'R1', 104, { driver: 'Ann', driver_id: 4 }), run(4, 'R1b', null, { driver: 'Ben', driver_id: 5 }), run(5, 'X', 105)]);
  assert.deepEqual(latestByDriver(f).map((x) => [x.driver, x.run.id]), [[null, 5], ['Ann', 3], ['Ben', 2]]);
});

test('one debrief line per run, the latest first, with the debrief a tap opens', () => {
  const f = folder([run(1, 'Q', 102.44), run(3, 'R1', 104.48)], [run(7, 'R2', 104.88)]);
  const debriefs = [ // newest first
    { id: 12, session_id: 7, state: 'recorded', has_audio: true, points: 0, created_at: '' },
    { id: 11, session_id: 7, state: 'ready', has_audio: true, points: 4, created_at: '' },
    { id: 10, session_id: 3, state: 'failed', has_audio: true, points: 0, created_at: '' },
  ];
  assert.deepEqual(debriefLines(f, debriefs).map((l) => [l.run.id, l.state, l.debrief, l.count]),
    [[7, 'ready', 11, 2], [3, 'failed', 10, 1], [1, 'none', null, 0]]);
});
