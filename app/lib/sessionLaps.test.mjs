// The During tab's latest session, every lap: the default picks, a tap on a lap, the flags. Run with `npm test`.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  addPick, bestInEachCorner, defaultPicks, fastestSections, flagWords, flaggedCount, flipPick, gains, gapWords,
  MAX_PICKS,
} from './sessionLaps.ts';

const lap = (number, time, sections = null) => ({ number, time, sections });
const run = (id, laps, driver = null) => ({ id, name: `R2 stint ${id}`, short: `R2 S${id}`, driver, driver_id: null, laps });
const SECTIONS = ['T1', 'T2-T5', 'T6', 'T8/T9'].map((code, k) => ({ code, start_m: k * 1000, end_m: k * 1000 + 999,
  apex_m: null, corners: [] }));

// stint 1's lap 3 is the fastest (100.0); its laps 2 and 4 are quicker in some sections; stint 2's lap 1 in one
const answer = {
  event_id: 1, status: 'ready', session: { code: 'R2', title: 'R2' }, left_out: 2, numbering: 'official',
  progress: null, note: null, sections: SECTIONS, fastest: { session_id: 1, lap: 3, time: 100.0 },
  runs: [
    run(1, [lap(2, 100.4, [25.05, 25.4, 24.9, 25.05]), lap(3, 100.0, [25.0, 25.2, 25.0, 24.8]),
      lap(4, 100.3, [24.88, 25.33, 24.985, 25.105])], 'Ann'),
    run(2, [lap(1, 100.2, [25.1, 25.15, 25.1, 24.85]), lap(2, 100.6, null)], 'Ben'),
  ],
};

test('the sections where a lap was quicker than the fastest lap, the biggest gain first; under 0.02 s left out', () => {
  const fast = fastestSections(answer);
  assert.deepEqual(fast, [25.0, 25.2, 25.0, 24.8]);
  assert.deepEqual(gains(answer.runs[0].laps[0], fast, SECTIONS), [{ code: 'T6', gain: -0.1 }]);
  // lap 4: T1 −0.12, T6 −0.015 (too small to count)
  assert.deepEqual(gains(answer.runs[0].laps[2], fast, SECTIONS), [{ code: 'T1', gain: -0.12 }]);
  assert.deepEqual(gains(answer.runs[1].laps[0], fast, SECTIONS), [{ code: 'T2-T5', gain: -0.05 }]);
  assert.deepEqual(gains(answer.runs[0].laps[1], fast, SECTIONS), []); // the fastest lap itself
  assert.deepEqual(gains(answer.runs[1].laps[1], fast, SECTIONS), []); // no section times
  assert.deepEqual(gains(answer.runs[0].laps[0], null, SECTIONS), []); // not worked out yet
  assert.equal(flaggedCount(answer), 3);
});

test('the flag in words, at most three sections', () => {
  assert.equal(flagWords([{ code: 'T6', gain: -0.12 }, { code: 'T10', gain: -0.05 }]),
    'Quicker than the fastest lap in T6 −0.12 s · T10 −0.05 s');
  const many = ['T1', 'T2', 'T3', 'T4'].map((code, i) => ({ code, gain: -0.1 + i * 0.01 }));
  assert.equal(flagWords(many), 'Quicker than the fastest lap in T1 −0.10 s · T2 −0.09 s · T3 −0.08 s');
  assert.equal(flagWords([]), null);
  assert.equal(gapWords(100.42, 100, false), '+0.42 s');
  assert.equal(gapWords(100, 100, true), 'Fastest');
  assert.equal(gapWords(100, 100, false), '+0.00 s'); // a lap as quick as the fastest, set later
});

test('the best lap in each corner, real laps only; the fastest lap where none was 0.02 s quicker', () => {
  const best = bestInEachCorner(answer);
  assert.deepEqual(best.map((b) => [b.code, b.run.id, b.lap.number, b.gain, b.fastest]), [
    ['T1', 1, 4, -0.12, false],
    ['T2-T5', 2, 1, -0.05, false],
    ['T6', 1, 2, -0.1, false],
    ['T8/T9', 1, 3, 0, true],
  ]);
  assert.deepEqual(bestInEachCorner({ ...answer, sections: null }), []);
});

test('on the traces at first: the fastest lap of each stint, the quickest stints when there are more than six', () => {
  assert.deepEqual(defaultPicks(answer.runs), [{ session_id: 1, lap: 3, slot: 0 }, { session_id: 2, lap: 1, slot: 1 }]);
  const stints = Array.from({ length: 8 }, (_, i) => run(i + 1, [lap(1, 101 - (i % 4) * 0.1 + i * 0.001), lap(2, 102)]));
  const picks = defaultPicks(stints);
  assert.equal(picks.length, MAX_PICKS);
  // stints 1 and 5 are the slowest (101.0, 101.004): left out; the rest in the order they ran
  assert.deepEqual(picks.map((p) => p.session_id), [2, 3, 4, 6, 7, 8]);
  assert.deepEqual(picks.map((p) => p.slot), [0, 1, 2, 3, 4, 5]);
  assert.deepEqual(defaultPicks([run(1, [])]), []);
});

test('a tap puts a lap on the traces or takes it off; a seventh says to take one off first', () => {
  let picks = defaultPicks(answer.runs);
  ({ picks } = flipPick(picks, { session_id: 1, lap: 3 })); // off: stint 2's lap keeps its colour
  assert.deepEqual(picks, [{ session_id: 2, lap: 1, slot: 1 }]);
  ({ picks } = flipPick(picks, { session_id: 1, lap: 4 })); // on, in the free colour
  assert.deepEqual(picks.at(-1), { session_id: 1, lap: 4, slot: 0 });
  const full = Array.from({ length: MAX_PICKS }, (_, i) => ({ session_id: 9, lap: i + 1, slot: i }));
  assert.deepEqual(flipPick(full, { session_id: 1, lap: 2 }), { picks: full, full: true });
  assert.deepEqual(flipPick(full, { session_id: 9, lap: 1 }).picks.length, MAX_PICKS - 1);
  // the best in a corner tapped: on the traces, and a lap already there stays
  assert.deepEqual(addPick(full, { session_id: 9, lap: 2 }), { picks: full, full: false });
  assert.deepEqual(addPick(full, { session_id: 1, lap: 2 }), { picks: full, full: true });
  assert.deepEqual(addPick([], { session_id: 1, lap: 2 }).picks, [{ session_id: 1, lap: 2, slot: 0 }]);
});
