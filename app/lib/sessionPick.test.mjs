// The During tab's session picker: the latest session at first, another with a tap, stints mixed in. Run with
// `npm test`.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  choiceDetail, flipAdd, isLatest, LATEST, otherStints, pickSession, pickWords, queryOf, shownCode, stintDetail,
} from './sessionPick.ts';

const run = (id, laps, driver = 'Piana') => ({ id, name: `stint ${id}`, short: `S${id}`, driver, laps });
const CHOICES = [
  { code: 'FP1', title: 'FP1', laps: 14, drivers: ['Piana', 'Rackl'], runs: [run(1, 8), run(2, 6, 'Rackl')] },
  { code: 'Q1', title: 'Q1', laps: 3, drivers: ['Piana'], runs: [run(3, 3), run(4, 0)] },
  { code: 'R1', title: 'R1', laps: 20, drivers: ['Rackl'], runs: [run(5, 20, 'Rackl')] },
];

test('the latest session at first, asked for with no query', () => {
  assert.equal(queryOf(LATEST), '');
  assert.ok(isLatest(LATEST, 'R1'));
  assert.equal(shownCode(LATEST, 'R1'), 'R1');
});

test('another session with a tap; the latest picked again is the default', () => {
  const fp1 = pickSession('FP1', 'R1');
  assert.deepEqual(fp1, { part: 'FP1', add: [] });
  assert.equal(queryOf(fp1), '?part=FP1');
  assert.ok(!isLatest(fp1, 'R1'));
  assert.deepEqual(pickSession('R1', 'R1'), LATEST);
  assert.equal(queryOf({ part: 'Day 2 · PTS 1', add: [] }), '?part=Day%202%20%C2%B7%20PTS%201');
});

test('stints of other sessions ticked in and out, asked for in id order', () => {
  let pick = flipAdd(pickSession('FP1', 'R1'), 5);
  pick = flipAdd(pick, 3);
  assert.equal(queryOf(pick), '?part=FP1&add=3,5');
  assert.ok(!isLatest(flipAdd(LATEST, 5), 'R1'));  // the latest with a stint mixed in isn't the default
  pick = flipAdd(pick, 5);
  assert.deepEqual(pick.add, [3]);
  // a new session drops the stints mixed in
  assert.deepEqual(pickSession('Q1', 'R1').add, []);
});

test('the words', () => {
  assert.equal(pickWords('R1', true, 0), 'R1 · latest');
  assert.equal(pickWords('FP1', false, 1), 'FP1 + 1 stint');
  assert.equal(pickWords('FP1', false, 2), 'FP1 + 2 stints');
  assert.equal(choiceDetail(CHOICES[0]), '14 laps · Piana, Rackl');
  assert.equal(choiceDetail({ ...CHOICES[1], laps: 1, drivers: [] }), '1 lap · Driver not set');
  assert.equal(stintDetail(run(9, 1, null)), '1 lap · Driver not set');
});

test('the stints to mix in: the other sessions, timed stints only, in the order they ran', () => {
  const others = otherStints(CHOICES, 'FP1');
  assert.deepEqual(others.map((c) => [c.code, c.runs.map((r) => r.id)]), [['Q1', [3]], ['R1', [5]]]);
  assert.deepEqual(otherStints(CHOICES, 'R1').map((c) => c.code), ['FP1', 'Q1']);
});
