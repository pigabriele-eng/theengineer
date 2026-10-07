// A coaching day's list, reference lap and corner losses. Run with `npm test`.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { coachingDays, cornerLosses, lossText, phaseLine, pointWindow, referenceLap } from './coachingDay.ts';

const run = (id, driver, best, extra = {}) => ({
  id, name: `Run ${id}`, kind: 'test', event_id: 1, driver, date: '2026-10-02', time: null, log_session: null,
  laps: 10, clean_laps: best == null ? 0 : 8, best_lap_s: best, best_lap: best == null ? null : 4, typical_s: null,
  consistency: null, has_log: true, ...extra,
});

test('the coaching days, in the order given, without the runs in no event', () => {
  const f = (id, mode) => ({ id, key: id == null ? 'none' : String(id), mode });
  assert.deepEqual(coachingDays([f(null, null), f(3, 'coaching'), f(2, 'weekend'), f(1, 'coaching'), f(4)])
    .map((x) => x.id), [3, 1]);
});

test("the reference lap is the event's quickest run's best lap", () => {
  const days = [{ date: null, sessions: [run(1, 'Client', 110), run(2, 'Coach', 105, { best_lap: 7 })] }];
  assert.deepEqual(referenceLap({ days, best_session_id: 2 }),
    { session_id: 2, lap: 7, time: 105, run: 'Run 2', driver: 'Coach' });
  assert.equal(referenceLap({ days, best_session_id: null }), null);
});

test('corner losses against the reference, the most lost first, with the words of the opportunity', () => {
  const sections = [
    { code: 'T1', start_m: 0, end_m: 400, times: [10.5, 10.1] },
    { code: 'T2-T5', start_m: 400, end_m: 1500, times: [30.0, 30.05] },
    { code: 'T6', start_m: 1500, end_m: 2000, times: [12.25, 12.0] },
  ];
  const opportunities = [
    { to_ideal: 0.65, sections: [
      { code: 'T1', loss_s: 0.4, versus: 1, phase: 'braking', phase_loss_s: 0.3,
        differences: [{ text: 'brakes 12 m earlier' }, { text: 'minimum speed 4 km/h lower' }] },
      { code: 'T6', loss_s: 0.25, versus: 1, phase: 'exit', phase_loss_s: 0.2, differences: [] },
    ] },
    { to_ideal: 0.05, sections: [] },
  ];
  const out = cornerLosses({ sections, opportunities });
  assert.deepEqual(out.map((c) => [c.code, c.loss_s, c.phase]), [['T1', 0.4, 'braking'], ['T6', 0.25, 'exit'],
    ['T2-T5', -0.05, null]]);
  assert.equal(out[0].words, 'Brakes 12 m earlier, minimum speed 4 km/h lower.');
  assert.equal(out[1].words, null);
});

test('points in a stretch of the lap, and losses in words', () => {
  assert.deepEqual(pointWindow([0, 5, 10, 15, 20, 25], 7, 20), [2, 4]);
  assert.deepEqual(pointWindow([0, 5, 10], 50, 60), [2, 2]);
  assert.equal(lossText(0.416), '+0.42 s');
  assert.equal(lossText(-0.05), '−0.05 s');
});

test('where in the corner the time went, said as it is', () => {
  assert.equal(phaseLine({ loss_s: 0.2, phase: 'exit', phase_loss_s: 0.15 }), 'Most of it on the way out: +0.15 s');
  assert.equal(phaseLine({ loss_s: 0.22, phase: 'exit', phase_loss_s: 0.09 }), 'The biggest part on the way out: +0.09 s');
  assert.equal(phaseLine({ loss_s: 0.2, phase: 'braking', phase_loss_s: 0.25 }), 'Under braking alone: +0.25 s');
  assert.equal(phaseLine({ loss_s: -0.1, phase: 'exit', phase_loss_s: 0.05 }), null);
  assert.equal(phaseLine({ loss_s: 0.2, phase: null, phase_loss_s: null }), null);
});
