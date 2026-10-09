// The transcript without a speaker name in front of every sentence. Run with `npm test`.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { editable, readable } from './transcriptText.ts';

const driver = { S0: { role: 'driver', name: null } };

test('one person speaking reads as plain text, no names', () => {
  const t = 'S0: Big understeer into turn one.\nS0: Rears gone after eight laps.\n\nS0: Brakes fine.';
  assert.deepEqual(readable(t, driver), [{ who: null, text: 'Big understeer into turn one. Rears gone after eight laps. Brakes fine.' }]);
  assert.equal(editable(t), 'Big understeer into turn one.\nRears gone after eight laps.\nBrakes fine.');
});

test('several people: named only where the speaker changes', () => {
  const t = 'S0: Understeer in T1.\nS0: And T2.\nS1: Entry or mid?\nS0: Mid.';
  const sp = { S0: { role: 'driver', name: 'Gabriele' }, S1: { role: 'engineer', name: null } };
  assert.deepEqual(readable(t, sp), [
    { who: 'Gabriele', text: 'Understeer in T1. And T2.' },
    { who: 'Engineer', text: 'Entry or mid?' },
    { who: 'Gabriele', text: 'Mid.' },
  ]);
  assert.equal(readable(t, null)[1].who, 'Speaker 2');
  assert.equal(editable(t), 'S0: Understeer in T1.\nAnd T2.\nS1: Entry or mid?\nS0: Mid.');
});

test('lines typed without a label keep the speaker before them', () => {
  assert.deepEqual(readable('Plain text\nmore', driver), [{ who: null, text: 'Plain text more' }]);
});
