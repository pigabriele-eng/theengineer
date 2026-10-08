// The tyres tag on a run row (lib/tyreTag.ts): what it shows, a guess against the driver's pick, and what a tap
// sends. Run with `npm test`.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { rowOf } from './tyrePicks.ts';
import { merged, tagSpeech, tapSends, toggled, tyreTag } from './tyreTag.ts';

const LABELS = { new: 'New', fresh: 'Fresh', used: 'Used', worn: 'Very used' };
// rows as lib/tyrePicks.ts rowOf makes them from GET /technique/events/{id}/tyres
const row = (id, level, mine, why = '') => ({ id, name: `Run ${id}`, driver: null, level, mine, why });

test('the tag: the level, with a "?" while it is the app’s guess', () => {
  assert.deepEqual(tyreTag(row(1, 'used', false, 'no new set seen before it'), LABELS),
    { text: 'Used?', label: 'Used', level: 'used', mine: false });
  assert.deepEqual(tyreTag(row(2, 'worn', true), LABELS), { text: 'Very used', label: 'Very used', level: 'worn', mine: true });
  assert.equal(tyreTag(row(3, 'new', false), LABELS).text, 'New?'); // qualifying, sure by rule: still the app's pick
  assert.equal(tyreTag(row(4, 'fresh', true), LABELS).text, 'Fresh');
  assert.equal(tyreTag(null, LABELS), null); // no tyres known (no event, no laps): no tag
  assert.equal(tyreTag(undefined, LABELS), null);
});

test('the "?" follows the server: set by the driver or not', () => {
  const run = (tyres) => ({ id: 7, name: 'R1', short: 'R1', day: 2, date: null, time: null, driver: null, tyres });
  const t = { tyres: 'fresh', label: 'Fresh', pair: 'used', sure: true, why: 'race: on the qualifying set' };
  assert.equal(tyreTag(rowOf(run({ ...t, set_by_driver: false })), LABELS).text, 'Fresh?'); // sure by rule: a guess
  assert.equal(tyreTag(rowOf(run({ ...t, why: 'set by you', guess: 'used', set_by_driver: true })), LABELS).text, 'Fresh');
  assert.equal(tyreTag(rowOf(run(null)), LABELS), null); // no laps: no tyres, no tag
});

test('what a screen reader says', () => {
  assert.equal(tagSpeech(tyreTag(row(1, 'used', false), LABELS), '01_D1S1'), 'Tyres of 01_D1S1: Used, a guess. Change');
  assert.equal(tagSpeech(tyreTag(row(1, 'worn', true), LABELS), 'R1'), 'Tyres of R1: Very used. Change');
});

test('what a tap on a level sends', () => {
  assert.deepEqual(tapSends(row(5, 'used', false), 'fresh'), { id: 5, tyres: 'fresh' });
  // the guess tapped as it is: sent, so it becomes the driver's
  assert.deepEqual(tapSends(row(5, 'used', false), 'used'), { id: 5, tyres: 'used' });
  // the driver's pick tapped again: nothing to send
  assert.equal(tapSends(row(5, 'used', true), 'used'), null);
  assert.deepEqual(tapSends(row(5, 'used', true), 'new'), { id: 5, tyres: 'new' });
});

test('one tap opens a run’s levels, a second on its tag closes them', () => {
  assert.equal(toggled(null, 3), 3);
  assert.equal(toggled(3, 3), null);
  assert.equal(toggled(3, 4), 4); // another run's tag: its levels instead
});

test('a read never puts a guess back over a pick being saved', () => {
  const shown = new Map([[1, row(1, 'fresh', true)], [2, row(2, 'used', false)]]);
  const read = new Map([[1, row(1, 'used', false)], [2, row(2, 'worn', false)], [3, row(3, 'new', false)]]);
  const out = merged(read, shown, [1]);
  assert.deepEqual([...out.values()].map((r) => [r.id, r.level, r.mine]),
    [[1, 'fresh', true], [2, 'worn', false], [3, 'new', false]]);
  assert.deepEqual(merged(read, null, [1]).get(1), read.get(1)); // nothing shown yet: the read as it is
  assert.equal(merged(read, shown, []).get(1).level, 'used');
});
