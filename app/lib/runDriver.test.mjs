// What a home-page run row says about its driver. Run with `npm test` (Node's own test runner).
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { driverState, driverWords } from './runDriver.ts';

const garage = { drivers: [{ id: 1, name: 'Ann Driver' }, { id: 2, name: 'Ben Racer' }] };
const run = (fields = {}) => ({ id: 7, name: 'FP1', driver_id: null, driver: null, ...fields });
const guess = (fields = {}) => ({
  session_id: 7, driver_id: null, agrees: null, stints: [], auto: null,
  suggestion: { group: 0, label: 'Style A', driver_id: null, driver: null, confidence: 'likely', share: 1, laps: 10 },
  ...fields,
});
const named = (id, name, confidence = 'likely') =>
  ({ group: 0, label: name, driver_id: id, driver: name, confidence, share: 1, laps: 10 });

test('a driver set by a person is shown by name, whatever the style says', () => {
  const st = driverState(run({ driver_id: 2, driver: 'Ben Racer' }), guess({ suggestion: named(1, 'Ann Driver') }), garage);
  assert.deepEqual(st, { kind: 'set', name: 'Ben Racer' });
  assert.equal(driverWords(st), 'Ben Racer');
});

test('a driver the app set from the driving style is marked as such', () => {
  const st = driverState(run({ driver_id: 1 }), guess({ driver_id: 1, auto: { source: 'fingerprint', match: 0.9 } }), garage);
  assert.deepEqual(st, { kind: 'auto', name: 'Ann Driver', how: 'by style' });
  const q = driverState(run({ driver_id: 1 }), guess({ driver_id: 1, auto: { source: 'quali', match: null } }), garage);
  assert.equal(q.how, 'by qualifying order'); // Q1 PIA, Q2 SYL: not the style
});

test('no driver: the style guess, Probably when not sure, with the driver to confirm', () => {
  const likely = driverState(run(), guess({ suggestion: named(1, 'Ann Driver') }), garage);
  assert.deepEqual(likely, { kind: 'guess', name: 'Ann Driver', sure: false, confirm: 1 });
  assert.equal(driverWords(likely), 'Probably Ann Driver');
  const sure = driverState(run(), guess({ suggestion: named(2, 'Ben Racer', 'sure') }), garage);
  assert.equal(driverWords(sure), 'Ben Racer');
});

test('never a placeholder: a style no driver is named for is no driver', () => {
  const st = driverState(run(), guess(), garage);
  assert.deepEqual(st, { kind: 'none' });
  assert.equal(driverWords(st), 'No driver');
  assert.deepEqual(driverState(run(), undefined, garage), { kind: 'none' });
});

test('a driver change at a stop is said only when every stint is named, with nothing to confirm', () => {
  const stint = (driver_id, label) => ({ first_lap: 1, last_lap: 5, laps: 5, group: 0, label, driver_id });
  const both = driverState(run(), guess({ stints: [stint(1, 'Ann Driver'), stint(2, 'Ben Racer')] }), garage);
  assert.deepEqual(both, { kind: 'guess', name: 'Ann Driver, then Ben Racer', sure: true, confirm: null });
  const half = driverState(run(), guess({ stints: [stint(1, 'Ann Driver'), stint(null, 'Style B')] }), garage);
  assert.deepEqual(half, { kind: 'none' });
});

test('the run\'s own driver wins over a guess read before it was cleared or changed', () => {
  // just set here, the guess still from before: shown as set, not guessed
  assert.equal(driverState(run({ driver_id: 2 }), guess({ suggestion: named(1, 'Ann Driver') }), garage).kind, 'set');
  // a driver made a moment ago, not in the garage yet: the run's own name for it
  assert.deepEqual(driverState(run({ driver_id: 9, driver: 'New Person' }), undefined, garage),
    { kind: 'set', name: 'New Person' });
});
