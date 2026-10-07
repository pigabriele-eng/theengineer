// The weekend page's Laps tab: which tab it opens on, and the suggestions in words. Run with `npm test`.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  askedTab, cornerWords, lapWords, openingTab, suggestionSpeech, suggestionTitle, toggleLap,
} from './lapsFirst.ts';

const lap = (extra = {}) => ({
  session_id: 1, lap: 1, time: 102.44, run: '03_Q', session: '03_Q', kind: 'qualifying', tyres: 'new',
  tyres_sure: true, driver: 'Anna Berg', driver_id: 1, role: 'best', ...extra,
});
const code = (d) => (d ? d.split(' ').at(-1).slice(0, 3).toUpperCase() : null);
const time = (t) => t.toFixed(2);

test('Laps while the weekend is on; Before and After as before; the address can ask for any tab', () => {
  assert.equal(openingTab('during'), 'laps');
  assert.equal(openingTab('after'), 'after');
  assert.equal(openingTab('before'), 'before');
  assert.equal(askedTab('laps'), 'laps');
  assert.equal(askedTab('after'), 'after');
  assert.equal(askedTab('report'), null);
  assert.equal(askedTab(undefined), null);
});

test('a suggestion in words', () => {
  const q = { kind: 'teammates', tyres: 'new', slower: 1, gap_s: 1.16,
    laps: [lap(), lap({ session_id: 2, lap: 2, time: 103.6, run: '03_Q (2)', driver: 'Bo Lind', driver_id: 2 })],
    corners: [{ code: 'T10', loss_s: 0.411, phase: 'entry' }, { code: 'T11-T12', loss_s: 0.286, phase: 'entry' }] };
  assert.equal(suggestionTitle(q, code), 'Teammates · qualifying');
  assert.equal(cornerWords(q.corners), 'T10 0.41 s · T11-T12 0.29 s');
  assert.equal(lapWords(q.laps[1]), '03_Q (2) · lap 2 · new tyres');
  assert.equal(suggestionSpeech(q, code, time),
    'Teammates · qualifying. BER 102.44, 03_Q · lap 1 · new tyres, against LIN 103.60, 03_Q (2) · lap 2 · new tyres. '
    + '1.16 seconds apart. Most of the gap: T10, 0.41 seconds; T11-T12, 0.29 seconds.');

  const used = { ...q, tyres: 'used' };
  assert.equal(suggestionTitle(used, code), 'Teammates · used tyres');
  const progress = { ...q, kind: 'progress', tyres: 'used', corners: null,
    laps: [lap({ session: 'R2', kind: 'race', tyres: 'used' }), lap({ session: 'R1', kind: 'race', tyres: 'used' })] };
  assert.equal(suggestionTitle(progress, code), 'BER · R2 against R1');
  assert.ok(!suggestionSpeech(progress, code, time).includes('Most of the gap'));
  const typical = lap({ run: 'FP1 stint 2', lap: 8, role: 'typical', kind: 'practice', tyres: 'used', tyres_sure: false });
  const consistency = { ...q, kind: 'consistency', tyres: 'used', laps: [lap({ run: 'FP1 stint 2' }), typical] };
  assert.equal(suggestionTitle(consistency, code), 'BER · best and typical lap, FP1 stint 2');
  assert.equal(lapWords(typical), 'FP1 stint 2 · lap 8 · typical lap · used tyres (guess)');
  assert.equal(suggestionTitle({ ...progress, laps: [lap({ driver: null, session: 'R2' }), lap({ session: 'R1' })] }, code),
    'R2 against R1');
});

test('laps ticked by hand: on, off, at most six', () => {
  const a = { session_id: 1, lap: 2 };
  const b = { session_id: 1, lap: 3 };
  assert.deepEqual(toggleLap([], a, 6), [a]);
  assert.deepEqual(toggleLap([a, b], { session_id: 1, lap: 2 }, 6), [b]);
  assert.deepEqual(toggleLap([a], b, 1), [a]);
});
