// The racing line page's math: the address, where each car is, the playhead and the words. Run with `npm test`.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  advance, cornerJump, encodeOthers, racingLineParams, indexAtTime, lateralWords, parseLaps, parseOthers, patternOn, placesAt, poseAt,
  sample, sampleAngle, sectionAt, slipWords, steerWords,
} from './racingLineMath.ts';

// a straight 100 m road north, one place every 2 m, and two laps: the second 1 m to the left and slower
const n = 51;
const road = { x: Array(n).fill(0), y: Array.from({ length: n }, (_, i) => i * 2), z: null,
  nx: Array(n).fill(-1), ny: Array(n).fill(0), left: Array(n).fill(5), right: Array(n).fill(-5) };
const lap = (lat, kmh) => ({ lateral: Array(n).fill(lat), speed: Array(n).fill(kmh),
  t: Array.from({ length: n }, (_, i) => (i * 2) / (kmh / 3.6)), yaw_deg: Array(n).fill(0), slip_deg: Array(n).fill(0),
  roll_deg: Array(n).fill(0), pitch_deg: Array(n).fill(0) });
const d = { road, step_m: 2, length_m: 100, laps: [lap(0, 72), lap(1, 36)],
  corners: [{ code: 'T1', apex_m: 300 }, { code: 'T2', apex_m: 900 }], sections: [] };

test('the address reads and writes the laps', () => {
  assert.deepEqual(parseLaps('7, 12,x,0'), [7, 12]);
  assert.deepEqual(parseOthers('34:5,35:2,bad'), [{ session: 34, lap: 5 }, { session: 35, lap: 2 }]);
  assert.equal(encodeOthers([{ session: 34, lap: 5 }]), '34:5');
});

test('values between places, angles the short way round', () => {
  assert.equal(sample([0, 10], 0.25), 2.5);
  assert.equal(sample([0, 10], 5), 10);
  assert.equal(sampleAngle([350, 10], 0.5), 360);
});

test('same place puts every car at one metre; real time where each was at the same clock time', () => {
  assert.deepEqual(placesAt(d, 40, 'place'), [20, 20]);
  const [a, b] = placesAt(d, 40, 'time'); // the first lap at 20 m/s reached 40 m in 2 s; the second, at 10 m/s, 20 m
  assert.equal(a, 20);
  assert.ok(Math.abs(b - 10) < 1e-9);
  assert.ok(Math.abs(indexAtTime([0, 1, 2], 1.5) - 1.5) < 1e-9);
});

test('a car sits on the line moved along the left normal', () => {
  const p = poseAt(d, d.laps[1], 10);
  assert.equal(p.x, -1); // left of north is west
  assert.equal(p.y, 20);
  assert.equal(p.z, 0);
});

test('the playhead moves at the first lap’s speed and goes round', () => {
  assert.ok(Math.abs(advance(d, 0, 1, 0.5) - 10) < 1e-9);
  assert.ok(Math.abs(advance(d, 95, 1, 1) - 15) < 1e-9);
});

test('a corner jump lands 120 m before the next apex, round the lap', () => {
  const big = { ...d, length_m: 1000 };
  assert.equal(cornerJump(big, 0, 1), 180);
  assert.equal(cornerJump(big, 180, 1), 780);
  assert.equal(cornerJump(big, 800, 1), 180);
  assert.equal(cornerJump(big, 800, -1), 780);
  assert.equal(cornerJump(big, 900, -1), 780);
});

test('sections and patterns', () => {
  const s = [{ code: 'T1', start_m: 0, end_m: 50 }, { code: 'T2', start_m: 50, end_m: 100 }];
  assert.equal(sectionAt(s, 60).code, 'T2');
  assert.equal(patternOn(0, 3), true);
  assert.equal(patternOn(1, 2), true);
  assert.equal(patternOn(1, 8), false);
});

test('plain words for a difference of line and of attitude', () => {
  assert.equal(lateralWords(0.84), '0.8 m further left');
  assert.equal(lateralWords(-1.25), '1.3 m further right');
  assert.equal(lateralWords(0.04), 'the same line');
  assert.equal(steerWords(-12.4), '12° right');
  assert.equal(slipWords(2.14), '2.1°, nose left of travel');
});

test('the load centre moves toward the loaded tyres', async () => {
  const { loadCentre, centreWords } = await import('./racingLineMath.ts');
  const still = loadCentre({ fl: 100, fr: 100, rl: 100, rr: 100 });
  assert.equal(Math.abs(still.forward) + Math.abs(still.left), 0);
  assert.equal(centreWords(still), 'where it is at rest');
  const braking = loadCentre({ fl: 150, fr: 150, rl: 50, rr: 50 }); // all of it forward: half the shift of the wheelbase
  assert.ok(Math.abs(braking.forward - 0.715) < 1e-9 && braking.left === 0);
  const right = loadCentre({ fl: 50, fr: 150, rl: 50, rr: 150 });
  assert.equal(centreWords(right), '0.41 m right');
});

test('the racing line for laps picked on the weekend page: the first session and its laps, the rest as others, four at most', () => {
  assert.equal(racingLineParams([]), null);
  assert.deepEqual(racingLineParams([{ session_id: 7, lap: 12 }]), { session: '7', laps: '12' });
  assert.deepEqual(racingLineParams([{ session_id: 7, lap: 12 }, { session_id: 8, lap: 3 }, { session_id: 7, lap: 5 }]),
    { session: '7', laps: '12,5', others: '8:3' });
  const six = [1, 2, 3, 4, 5, 6].map((n) => ({ session_id: 9, lap: n }));
  assert.deepEqual(racingLineParams(six), { session: '9', laps: '1,2,3,4' });
  // what the page reads back
  const p = racingLineParams([{ session_id: 7, lap: 12 }, { session_id: 8, lap: 3 }]);
  assert.deepEqual([parseLaps(p.laps), parseOthers(p.others)], [[12], [{ session: 8, lap: 3 }]]);
});
