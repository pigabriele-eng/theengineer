// The event report's filter: the runs picked by tyres, session and driver. Run with `npm test`.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { anyPicked, countsFor, flip, NO_PICKS, pickedRuns } from './lapFilter.ts';

const runs = [
  { id: 1, tyres: 'used', part: 'FP1', driver: 'Piana' },
  { id: 2, tyres: 'new', part: 'FP1', driver: 'Rackl' },
  { id: 3, tyres: 'new', part: 'Q1', driver: 'Piana' },
  { id: 4, tyres: 'fresh', part: 'R1', driver: 'Rackl' },
];

test('nothing picked takes every run; each row narrows it, a row with several choices takes any of them', () => {
  assert.equal(anyPicked(NO_PICKS), false);
  assert.deepEqual(pickedRuns(runs, NO_PICKS), [1, 2, 3, 4]);
  const newSets = flip(NO_PICKS, 'tyres', 'new');
  assert.deepEqual(pickedRuns(runs, newSets), [2, 3]); // a new set in practice goes with qualifying's
  assert.deepEqual(pickedRuns(runs, flip(newSets, 'drivers', 'Piana')), [3]);
  assert.deepEqual(pickedRuns(runs, flip(flip(newSets, 'tyres', 'fresh'), 'parts', 'R1')), [4]);
  assert.deepEqual(flip(newSets, 'tyres', 'new'), NO_PICKS); // tapped again: off
});

test('how many runs each choice would leave', () => {
  const piana = flip(NO_PICKS, 'drivers', 'Piana');
  assert.deepEqual(countsFor(runs, piana, 'tyres', ['new', 'fresh', 'used']), { new: 1, fresh: 0, used: 1 });
});
