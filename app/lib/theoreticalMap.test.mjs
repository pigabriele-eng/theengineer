// The theoretical laps' corner map and its tips. Run with `npm test`.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { driverCode } from './driverTag.ts';
import { STINT } from './theoretical.ts';
import {
  cornerRows, driverKeys, lapsUsed, listWords, stintsOf as stintsWith, stintTitle, tipsOf, tipWords,
} from './theoreticalMap.ts';

const stintsOf = (answer, runs) => stintsWith(answer, runs, driverCode);

const tip = (over) => ({ code: 'T3', from: ['8', 6], versus: ['8', 5], gain_s: 0.123, phase: 'braking', phase_s: 0.09,
  does: ['brakes 6 m later', 'carries 3 km/h more at the slowest point'], also: ['brakes 9% harder'], ...over });
const answer = {
  sections: ['T1', 'T2-T5', 'T6'],
  stints: [
    { run: '8', session_id: 8, session: '04_R1', driver: null, ready: true, time: 100, gap_s: 0.2, best_run: '8',
      best_lap: 5, best_time: 100.2, laps: 12, from: [['8', 5], ['8', 6], ['8', 6]], gains: [0, 0.123, 0.077],
      tips: [tip({}), tip({ code: 'T6', gain_s: 0.077 })] },
    { run: '9', session_id: 9, session: '04_R1 (2)', driver: 'Rackl', ready: true, time: 101, gap_s: 0.1, best_run: '9',
      best_lap: 2, best_time: 101.1, laps: 9, from: [['9', 3], ['9', 2], ['9', 2]], gains: [0.1, 0, 0], tips: [] },
    { run: '10', session_id: 10, session: '05_R2', driver: null, ready: false },
  ],
  combined: { time: 99.8, gap_s: 0.4, best_run: '8', best_lap: 5, best_time: 100.2, laps: 21,
    from: [['9', 3], ['8', 6], ['8', 6]], gains: [0.2, 0.123, 0.077],
    tips: [tip({ code: 'T1', from: ['9', 3], versus: ['8', 5], gain_s: 0.2, phase: 'exit', does: [], also: [] })] },
  traces: { step_m: 5, distance: [], roles: [], stints: [], combined: null },
};
// the page knows stint 1's driver (set after the answer was made) and its own names
const runs = [{ id: 8, name: 'R1 stint 1', driver: 'Gabriele Piana' }, { id: 9, name: 'R1 stint 2', driver: 'Rackl' }];

test('each stint named as Gabriele asked, with the page’s names and drivers', () => {
  const stints = stintsOf(answer, runs);
  assert.ok(stintTitle(stints[0]).startsWith(`${STINT} · `)); // the one name, as lib/theoretical.ts has it
  assert.deepEqual(stints.map(stintTitle), ['stint theoretical · R1 stint 1 (PIA)', 'stint theoretical · R1 stint 2 (RAC)',
    'stint theoretical · 05_R2 (no driver)']);
  assert.deepEqual(driverKeys(stints).map((k) => k.label), ['PIA', 'RAC', '05_R2, no driver']);
  assert.equal(lapsUsed(answer.stints[0]), 2);
  assert.equal(lapsUsed(answer.combined), 2);
});

test('each corner’s lap in every theoretical, and the real laps a tap shows', () => {
  const stints = stintsOf(answer, runs);
  const rows = cornerRows(answer, stints);
  assert.deepEqual(rows.map((r) => r.code), ['T1', 'T2-T5', 'T6']); // track order, as the server names them
  const [t1, t2] = rows;
  assert.equal(t1.stints[0].itself, true); // the stint's fastest lap holds it itself
  assert.equal(t1.stints[1].lap, 3);
  assert.equal(t1.stints[1].gain, 0.1);
  assert.equal(t1.stints[1].stint.code, 'RAC');
  assert.equal(t1.stints[2], null); // not ready
  assert.equal(t1.combined.stint.name, 'R1 stint 2');
  assert.equal(t1.combined.gain, 0.2);
  // the combined theoretical's holder and the fastest lap first, then each stint's pair, each lap once
  assert.deepEqual(t1.laps, [{ session_id: 9, lap: 3 }, { session_id: 8, lap: 5 }, { session_id: 9, lap: 2 }]);
  assert.deepEqual(t2.laps, [{ session_id: 8, lap: 6 }, { session_id: 8, lap: 5 }, { session_id: 9, lap: 2 }]);
  // an answer made before the gains were added: no figure, the laps still
  const old = { ...answer, stints: answer.stints.map(({ gains, ...s }) => s) };
  assert.equal(cornerRows(old, stints)[1].stints[0].gain, null);
});

test('a tip in one or two plain sentences', () => {
  const stints = stintsOf(answer, runs);
  assert.equal(tipWords(tip({}), stints), 'PIA’s lap 6 brakes 6 m later and carries 3 km/h more at the slowest point '
    + 'than lap 5: 0.12 s, most of it under braking. It also brakes 9% harder.');
  // only what else differs
  assert.equal(tipWords(tip({ does: [], also: ['is 3 km/h faster out of it'], phase: 'full throttle' }), stints),
    'PIA’s lap 6 is 3 km/h faster out of it than lap 5: 0.12 s, most of it on the straight after it.');
  // laps of two stints: each named by its driver and its stint
  assert.equal(tipWords(answer.combined.tips[0], stints), 'RAC’s lap 3 of R1 stint 2 is 0.20 s quicker here than '
    + 'PIA’s lap 5 of R1 stint 1, most of it on the exit, with no one difference that stands out: compare the traces.');
  // nobody set the driver
  assert.equal(tipWords(tip({ also: [] }), stintsOf(answer, [])),
    'Lap 6 brakes 6 m later and carries 3 km/h more at the slowest point than lap 5: 0.12 s, most of it under braking.');
  assert.equal(listWords(['a']), 'a');
  assert.equal(listWords(['a', 'b', 'c']), 'a, b and c');
});

test('the tips of each theoretical', () => {
  assert.equal(tipsOf(answer, null)[0].code, 'T1');
  assert.deepEqual(tipsOf(answer, '8').map((t) => t.code), ['T3', 'T6']);
  assert.deepEqual(tipsOf(answer, '10'), []);
  assert.deepEqual(tipsOf({ ...answer, combined: null }, null), []);
});
