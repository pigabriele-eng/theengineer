// The Quali analysis tab's workings: the qualifying sessions, each driver's run in them and its tyres in words. Run
// with `npm test` (Node's own test runner).
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { axisOf, axleSeries, isQualiCode, lapMarks, minuteAt, prepWords, qualiRuns, where } from './qualiTab.ts';

const lap = (t) => `${Math.floor(t / 60)}:${(t % 60).toFixed(3).padStart(6, '0')}`;
const push = { front_c: 88, rear_c: 69, laps: 4, gap_s: 0.3, pf: [1.67, 1.79], pr: [1.61, 1.72] };
const sim = (extra = {}) => ({
  label: 'Q1', session_id: 1, session: 'Q1', run: 1, day: '19/09/2026', kind: 'quali', pre_warmed: false,
  cold_start: true, warm_laps: 2, warm_min: 4.3, warm_km: 7.1, drag_s: 94.2, brake_s: 20, hard_stops: 6,
  straight_brake_s: 3, straight_hard_stops: 5, weaves: 8, ready_min: 9.1, peak_lap: 2, peak_flying: 1, peak_min: 4.3,
  peak_time: 103.6, first_front: 66, first_rear: 46, peak_front: 66, peak_rear: 46, first_ready_lap: null,
  peak_after_ready: null,
  points: [{ lap: 2 }, { lap: 3 }, { lap: 4 }],
  laps: [{ n: 1, time: 110.72, clean: false, start_min: 2.43 }, { n: 2, time: 103.6, clean: true, start_min: 4.28 },
    { n: 3, time: 105.36, clean: true, start_min: 6.0 }, { n: 4, time: 103.84, clean: true, start_min: 7.76 },
    { n: 5, time: 132.28, clean: false, start_min: 9.49 }],
  ...extra,
});
const part = (code, runs) => ({ code, title: code, official: false, runs: runs.map(([id, driver]) =>
  ({ id, name: `${code} (${id})`, short: code, driver, clean_laps: 3, best: 103.6 })) });

test('qualifying sessions: Q, Q1 to Q3, pre-qualifying and log folders named so', () => {
  for (const code of ['Q', 'Q1', 'Q3', 'PQ', '03_Q', '04_PQ', 'Qualifying', 'Day 2 · Q', 'Q1 + Q2']) {
    assert.ok(isQualiCode(code), code);
  }
  for (const code of ['FP1', 'R1', '04_R1', 'PT2', 'Day 1 · PTS 1', 'Quick run', 'Race']) {
    assert.ok(!isQualiCode(code), code);
  }
});

test("each driver's run in the qualifying sessions, in order, and the runs with none", () => {
  const parts = [part('FP1', [[9, 'Ann Driver']]), part('03_Q', [[1, 'Ann Driver'], [2, null]]), part('PQ', [[7, 'Ben Racer']])];
  const sims = [sim({ session_id: 2, run: 2, label: 'Q (2) run 2' }), sim({ session_id: 2, run: 1, label: 'Q (2) run 1' }),
    sim({ session_id: 9, label: 'FP1' }), sim({ session_id: 7, label: 'PQ' })];
  const { runs, none } = qualiRuns(parts, sims);
  assert.deepEqual(runs.map((r) => [r.sim.label, r.part, r.driver, r.slot]),
    [['Q (2) run 1', '03_Q', null, 0], ['Q (2) run 2', '03_Q', null, 1], ['PQ', 'PQ', 'Ben Racer', 2]]);
  assert.deepEqual(none, [{ id: 1, name: '03_Q (1)', driver: 'Ann Driver', part: '03_Q' }]);
});

test('a cold start in words: the warm-up, the first flying lap, the best lap and when it was ready', () => {
  const words = prepWords(sim(), push, lap);
  assert.deepEqual(words, [
    'Left on cold tyres: 2 warm-up laps in 4.3 min, 94 s of brake dragging, 5 hard stops on the straights and 8 '
      + 'weaving swings.',
    'The first flying lap started with the fronts at 66 °C and the rears at 46 °C.',
    'Best lap 1:43.600 on the first flying lap, 4.3 min after leaving.',
    'No flying lap started at push temperature (fronts 88 °C and rears 69 °C at the line): the tyres got there 9.1 min '
      + 'after leaving.',
  ]);
  const ready = prepWords(sim({ first_ready_lap: 3, peak_lap: 4, peak_flying: 3, peak_after_ready: 1, ready_min: 5.8,
    peak_min: 7.8, peak_front: 87, peak_rear: 65 }), push, lap);
  assert.equal(ready[2], 'Best lap 1:43.600 on the third flying lap, 7.8 min after leaving, starting with the fronts at '
    + '87 °C and the rears at 65 °C.');
  assert.equal(ready[3], 'Ready to push (fronts 88 °C and rears 69 °C at the line) from the second flying lap, 5.8 min '
    + 'after leaving: the best lap was the one after it.');
  assert.match(prepWords(sim({ ready_min: null }), push, lap)[3], /^The tyres never reached push temperature/);
  assert.equal(prepWords(sim(), null, lap).length, 3); // no push temperature learned: nothing said about readiness
});

test('a run on tyres still warm: said so, and no minutes to readiness', () => {
  const words = prepWords(sim({ cold_start: false, pre_warmed: true, warm_laps: 1, warm_min: 1.9, drag_s: 0,
    straight_hard_stops: 0, weaves: 0, first_ready_lap: 2, peak_after_ready: 0, ready_min: 1.0 }), push, lap);
  assert.equal(words[0], 'Left on tyres still warm from earlier running (the warm-up may be in an earlier log): 1 '
    + 'warm-up lap in 1.9 min.');
  assert.equal(words[3], 'Ready to push (fronts 88 °C and rears 69 °C at the line) from the first flying lap: the best '
    + 'lap was that lap.');
});

test('a reading against its window, the axle from its two tyres, the laps on the time line', () => {
  assert.equal(where(1.6, [1.72, 1.76, 1.87]), 'low');
  assert.equal(where(1.8, [1.72, 1.76, 1.87]), 'in');
  assert.equal(where(1.9, [1.72, 1.76, 1.87]), 'high');
  assert.equal(where(null, [1, 2, 3]), null);
  assert.equal(where(1.8, undefined), null);
  const series = { step_s: 5, p: { FL: null, FR: null, RL: null, RR: null },
    t: { FL: [null, 30, 40], FR: [null, null, 50], RL: null, RR: [20, 21, 22] } };
  assert.deepEqual(axleSeries(series, 't', 'front'), [null, null, 45]); // nothing until FR, the late one, woke
  const drop = { ...series, t: { ...series.t, FL: [30, 31, null], FR: [40, 41, 42] } };
  assert.deepEqual(axleSeries(drop, 't', 'front'), [35, 36, 42]); // FL dropped out: FR alone
  assert.deepEqual(axleSeries(series, 't', 'rear'), [20, 21, 22]);
  assert.deepEqual(axleSeries(series, 'p', 'front'), []);
  assert.equal(minuteAt(series, 11) * 60, 57.5); // the middle of the 55-60 s stretch
  const marks = lapMarks(sim());
  assert.deepEqual(marks.map((m) => [m.n, m.kind, m.best]),
    [[1, 'warm-up', false], [2, 'flying', true], [3, 'flying', false], [4, 'flying', false], [5, 'in', false]]);
  assert.ok(Math.abs(marks[1].end - (4.28 + 103.6 / 60)) < 1e-9);
  assert.deepEqual(axisOf([33, 101, null], [10, 20]), { range: [20, 120], step: 20 });
  assert.deepEqual(axisOf([33, 61], [10, 20]), { range: [30, 70], step: 10 });
  assert.deepEqual(axisOf([1.28, 1.97], [0.1, 0.2]), { range: [1.2, 2.2], step: 0.2 });
  assert.deepEqual(axisOf([1.62, 1.88], [0.1, 0.2]), { range: [1.5, 2.0], step: 0.1 });
  assert.equal(axisOf([null], [10]), null);
});
