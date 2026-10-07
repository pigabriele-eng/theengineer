// The weekend's official sessions as the session reports list them. Run with `npm test`.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { partState, partSummary, partsInOrder, weekendOn } from './sessionParts.ts';

const part = (code, extra = {}) => ({
  code, title: code, official: true, runs: [{ id: 1, name: `${code} stint 1`, short: `${code} S1`, driver: null,
    clean_laps: 5, best: 103.6 }], drivers: [], driver_codes: [], clean_laps: 5, best: 103.6, best_run: 1, day: null,
  date: '2026-09-19', time: '10:00', status: 'ready', ready: true, stale: false, ...extra,
});
const answer = { event_id: 1, title: 'Zandvoort', start: '2026-09-19', end: '2026-09-20',
  parts: [part('FP1'), part('Q1'), part('R1')] };
const lap = (s) => `${Math.floor(s / 60)}:${(s % 60).toFixed(2).padStart(5, '0')}`;

test('newest first while the weekend runs, in timetable order before and after it', () => {
  assert.deepEqual(partsInOrder(answer, '2026-09-20').map((p) => p.code), ['R1', 'Q1', 'FP1']);
  assert.deepEqual(partsInOrder(answer, '2026-09-21').map((p) => p.code), ['FP1', 'Q1', 'R1']);
  assert.deepEqual(partsInOrder(answer, '2026-09-18').map((p) => p.code), ['FP1', 'Q1', 'R1']);
  assert.equal(weekendOn({ ...answer, start: null, end: null }, '2026-09-19'), false);
  assert.deepEqual(partsInOrder(null), []);
});

test('one line: who drove, how many runs, the best lap', () => {
  const two = part('FP1', { runs: [part('FP1').runs[0], { ...part('FP1').runs[0], id: 2 }], driver_codes: ['PIA', 'RAC'] });
  assert.equal(partSummary(two, lap), 'PIA, RAC · 2 runs · best 1:43.60');
  assert.equal(partSummary(part('03_Q'), lap), '1 run · best 1:43.60');
  assert.equal(partSummary(part('FP2', { best: null }), lap), '1 run · no clean lap');
  assert.equal(partState(part('Q1')), null);
  assert.equal(partState(part('Q1', { status: 'running' })), 'Being worked out');
  assert.equal(partState(part('Q1', { status: 'empty' })), 'No clean laps');
});
