// The driver on a run's name line. Run with `npm test`.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { codeOf, driverCode, driverTag } from './driverTag.ts';

test('a driver code is three letters of the surname', () => {
  assert.equal(driverCode('Max Piana'), 'PIA');
  assert.equal(driverCode('Rackl'), 'RAC');
  assert.equal(driverCode('Jos'), 'JOS');
  assert.equal(driverCode('Kelvin van der Linde'), 'LIN');
  assert.equal(driverCode('Li'), 'Li');
  assert.equal(codeOf(null), null);
});

test('known, guessed and unknown drivers', () => {
  assert.deepEqual(driverTag({ kind: 'set', name: 'Max Piana' }), { text: 'PIA', kind: 'known', name: 'Max Piana' });
  assert.equal(driverTag({ kind: 'auto', name: 'Rackl' }).text, 'RAC');
  assert.deepEqual(driverTag({ kind: 'guess', name: 'Rackl', sure: false, confirm: 3 }),
    { text: 'RAC?', kind: 'guess', name: 'Rackl' });
  assert.equal(driverTag({ kind: 'guess', name: 'Piana, then Rackl', sure: true, confirm: null }).text, 'PIA/RAC?');
  assert.deepEqual(driverTag({ kind: 'none' }), { text: 'Driver?', kind: 'none', name: null });
});
