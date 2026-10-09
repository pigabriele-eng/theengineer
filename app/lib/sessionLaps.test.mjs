// The During tab's latest session, every lap: the default picks, a tap on a lap, the flags. Run with `npm test`.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  addPick, bestFlags, bestInEachCorner, defaultPicks, dropPick, fastestSections, flagWords, flipPick, gapWords, kindWords,
  lapKey, MAX_PICKS,
} from './sessionLaps.ts';

const lap = (number, time, sections = null) => ({ number, time, sections });
const run = (id, laps, driver = null) => ({ id, name: `R2 stint ${id}`, short: `R2 S${id}`, driver, driver_id: null, laps });
const SECTIONS = ['T1', 'T2-T5', 'T6', 'T8/T9'].map((code, k) => ({ code, start_m: k * 1000, end_m: k * 1000 + 999,
  apex_m: null, corners: [] }));

// stint 1's lap 3 is the fastest (100.0); its laps 2 and 4 are quicker in some sections, stint 2's lap 1 in two
const answer = {
  event_id: 1, status: 'ready', session: { code: 'R2', title: 'R2' }, left_out: 2, numbering: 'official',
  progress: null, note: null, sections: SECTIONS, fastest: { session_id: 1, lap: 3, time: 100.0 },
  runs: [
    run(1, [lap(2, 100.4, [25.05, 25.4, 24.9, 25.05]), lap(3, 100.0, [25.0, 25.2, 25.0, 24.8]),
      lap(4, 100.3, [24.88, 25.33, 24.985, 25.105])], 'Ann'),
    run(2, [lap(1, 100.2, [24.86, 25.15, 25.1, 24.85]), lap(2, 100.6, null)], 'Ben'),
  ],
};

test('a lap is flagged with the corners where it holds the session’s best, the biggest gain first', () => {
  assert.deepEqual(fastestSections(answer), [25.0, 25.2, 25.0, 24.8]);
  const flags = bestFlags(answer);
  assert.deepEqual([...flags.keys()].sort(), ['1:2', '2:1']);
  // stint 2 lap 1 holds T1 (−0.14) and T2-T5 (−0.05)
  assert.deepEqual(flags.get(lapKey({ session_id: 2, lap: 1 })), [{ code: 'T1', gain: -0.14 }, { code: 'T2-T5', gain: -0.05 }]);
  assert.deepEqual(flags.get('1:2'), [{ code: 'T6', gain: -0.1 }]);
  // stint 1 lap 4 was 0.12 s quicker than the fastest lap in T1, but not the best there: no flag
  assert.equal(flags.get('1:4'), undefined);
  assert.equal(flags.get('1:3'), undefined); // the fastest lap itself
  assert.equal(bestFlags({ ...answer, sections: null }).size, 0); // not worked out yet
});

test('the flag in words', () => {
  assert.equal(flagWords([{ code: 'T6', gain: -0.12 }, { code: 'T10', gain: -0.05 }]),
    'Best of the session in T6 −0.12 s · T10 −0.05 s');
  assert.equal(flagWords([]), null);
  assert.equal(flagWords(undefined), null);
  assert.equal(gapWords(100.42, 100, false), '+0.42 s');
  assert.equal(gapWords(100, 100, true), 'Fastest');
  assert.equal(gapWords(100, 100, false), '+0.00 s'); // a lap as quick as the fastest, set later
});

test('the best lap in each corner, real laps only; the fastest lap where none was 0.02 s quicker', () => {
  const best = bestInEachCorner(answer);
  assert.deepEqual(best.map((b) => [b.code, b.run.id, b.lap.number, b.gain, b.fastest]), [
    ['T1', 2, 1, -0.14, false],
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
  // the × on a lap above the traces: off them, the others keep their colours, down to none
  const two = [{ session_id: 1, lap: 2, slot: 0 }, { session_id: 2, lap: 5, slot: 1 }];
  assert.deepEqual(dropPick(two, { session_id: 1, lap: 2 }), [{ session_id: 2, lap: 5, slot: 1 }]);
  assert.deepEqual(dropPick(dropPick(two, { session_id: 1, lap: 2 }), { session_id: 2, lap: 5 }), []);
  assert.deepEqual(dropPick(two, { session_id: 3, lap: 1 }), two); // not on them: nothing changes
});

test('out-laps and in-laps: their quicker corners count, they are never on the traces at first', () => {
  // a qualifying run: out-lap, build lap, two pushes, a third push that turns into the in-lap (quickest through T1);
  // a section null on a lap that isn't clean where it wasn't driven on the line
  const q = run(1, [
    { number: 1, time: 160.0, clean: false, kind: 'out', sections: [40.1, null, 26.0, 25.9] },
    { number: 2, time: 112.0, clean: false, kind: 'build', sections: [27.0, 28.0, 27.5, 27.0] },
    { number: 3, time: 100.0, clean: true, kind: null, sections: [25.0, 25.2, 25.0, 24.8] },
    { number: 4, time: 100.3, clean: true, kind: null, sections: [25.1, 25.2, 25.1, 24.9] },
    { number: 5, time: 130.0, clean: false, kind: 'in', sections: [24.85, 25.3, 30.0, 49.85] },
  ], 'Ann');
  const qa = { ...answer, runs: [q], fastest: { session_id: 1, lap: 3, time: 100.0 } };
  assert.deepEqual(bestInEachCorner(qa).map((b) => [b.code, b.lap.number, b.gain]),
    [['T1', 5, -0.15], ['T2-T5', 3, 0], ['T6', 3, 0], ['T8/T9', 3, 0]]);
  assert.deepEqual(bestFlags(qa).get('1:5'), [{ code: 'T1', gain: -0.15 }]);
  assert.equal(kindWords(q.laps[4]), 'in-lap');
  assert.equal(kindWords(q.laps[1]), 'build lap');
  assert.equal(kindWords(q.laps[2]), null);
  assert.equal(kindWords({ clean: false }), 'slow lap'); // not clean, not said what
  assert.equal(kindWords({}), null); // an answer from before: clean
  // a quick part lap that isn't clean is never a stint's lap on the traces at first
  const r = run(2, [{ number: 1, time: 99.0, clean: false, kind: 'in', sections: null }, lap(2, 100.4)]);
  assert.deepEqual(defaultPicks([q, r]), [{ session_id: 1, lap: 3, slot: 0 }, { session_id: 2, lap: 2, slot: 1 }]);
});
