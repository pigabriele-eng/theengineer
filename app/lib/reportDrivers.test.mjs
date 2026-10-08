// The report's Drivers section: who drove on which tyres, the level and the pair compared, each corner's numbers and
// differences in words, what was matched, the balance and grip per driver, the laps for the traces. Run with
// `npm test`.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  balanceDiffs, balanceFor, balanceRows, checkLines, codeOf, cornerNumbers, cornerOrder, DEFAULT_TRACES,
  differenceWords, flipTrace, fromApex, gapLine, gapWords, gripBySide, inSection, levelDrivers, matchedLines,
  numberRows, onTraces, pickLevel, pickPair, repick, traceLaps,
} from './reportDrivers.ts';

// a race weekend: Piana on runs 1, 3, 7, Rackl on 2, 4, 6; quali on new tyres (Piana one lap, Rackl three), the races
// on fresh ones (Piana five laps, Rackl four), and a used-tyre run of Rackl's alone
const DRIVER = { 1: 'Max Piana', 2: 'Jan Rackl', 3: 'Max Piana', 4: 'Jan Rackl', 6: 'Jan Rackl', 7: 'Max Piana', 9: 'Jan Rackl' };
const level = (tyres, runs, laps) => ({
  condition: { tyres, runs: runs.map((r) => r[0]) },
  trends: { runs: runs.map(([id, run]) => ({ run, session_id: id })), laps: laps.map(([run, lap, time]) => ({ run, lap, time })) },
});
const NEW = level('new', [[1, 'Q'], [2, 'Q (2)']], [['Q', 1, 102.44], ['Q (2)', 2, 103.6], ['Q (2)', 3, 105.36], ['Q (2)', 4, 104.1]]);
const FRESH = level('fresh', [[3, 'R1'], [4, 'R1 (2)'], [6, 'R2 (2)'], [7, 'R2 (3)']], [
  ['R1', 4, 104.84], ['R1', 5, 104.48], ['R1', 6, 104.6], ['R2 (3)', 2, 105.1], ['R2 (3)', 3, 105.7],
  ['R1 (2)', 3, 105.92], ['R1 (2)', 4, 106.3], ['R2 (2)', 5, 104.88], ['R2 (2)', 6, 106.0],
]);
const USED = level('used', [[9, 'FP1']], [['FP1', 2, 107.0], ['FP1', 3, 106.5]]);
const driverOf = (id) => DRIVER[id] ?? null;

test('each level with its drivers, the most laps first, every lap quickest first', () => {
  const levels = levelDrivers([FRESH, NEW, USED], driverOf);
  assert.deepEqual(levels.map((l) => [l.tyres, l.drivers.map((d) => [d.code, d.runs, d.laps.length])]), [
    ['fresh', [['PIA', [3, 7], 5], ['RAC', [4, 6], 4]]],
    ['new', [['RAC', [2], 3], ['PIA', [1], 1]]],
    ['used', [['RAC', [9], 2]]],
  ]);
  const pia = levels[0].drivers[0];
  assert.deepEqual(pia.laps.map((l) => l.time), [104.48, 104.6, 104.84, 105.1, 105.7]);
  // a run with no driver set is on no side
  const none = levelDrivers([FRESH], (id) => (id === 4 ? null : driverOf(id)));
  assert.deepEqual(none[0].drivers.map((d) => [d.code, d.runs]), [['PIA', [3, 7]], ['RAC', [6]]]);
});

test('the level compared: the most laps both drivers have, or the one picked; a level with one driver said', () => {
  const levels = levelDrivers([FRESH, NEW, USED], driverOf);
  let p = pickLevel(levels, null, 'fresh');
  assert.equal(p.level.tyres, 'fresh'); // min(5, 4) = 4 against min(3, 1) = 1
  assert.deepEqual(p.both.map((l) => l.tyres), ['fresh', 'new']);
  assert.equal(p.only, null);
  p = pickLevel(levels, 'new', 'new');
  assert.equal(p.level.tyres, 'new');
  // the report's tab on the used tyres, where only Rackl drove: compared on fresh tyres, and said so
  p = pickLevel(levels, null, 'used');
  assert.equal(p.level.tyres, 'fresh');
  assert.equal(p.only.tyres, 'used');
  assert.equal(p.only.driver.code, 'RAC');
  // a level picked where only one drove isn't compared on
  assert.equal(pickLevel(levels, 'used', null).level.tyres, 'fresh');
  // nowhere both: nothing to compare
  const alone = levelDrivers([USED], driverOf);
  p = pickLevel(alone, null, 'used');
  assert.equal(p.level, null);
  assert.equal(p.only, null);
});

test('the pair: the two with the most laps, or two picked; a pick of a side swaps when it is the other one', () => {
  const lv = { tyres: 'fresh', drivers: ['A Aa', 'B Bb', 'C Cc'].map((name, i) => ({ name, code: codeOf(name),
    runs: [i], laps: Array.from({ length: 5 - i }, (_, k) => ({ session_id: i, lap: k, time: 100 + k })) })) };
  assert.deepEqual(pickPair(lv).map((d) => d.name), ['A Aa', 'B Bb']);
  assert.deepEqual(pickPair(lv, ['C Cc', 'A Aa']).map((d) => d.name), ['C Cc', 'A Aa']);
  assert.deepEqual(pickPair(lv, ['Gone', 'A Aa']).map((d) => d.name), ['A Aa', 'B Bb']);
  assert.deepEqual(repick(['A Aa', 'B Bb'], 'b', 'C Cc'), ['A Aa', 'C Cc']);
  assert.deepEqual(repick(['A Aa', 'B Bb'], 'a', 'B Bb'), ['B Bb', 'A Aa']);
  assert.equal(codeOf('Kelvin van der Linde'), 'LIN');
  assert.equal(codeOf('Li'), 'Li');
});

test('gaps in words', () => {
  const codes = { a: 'PIA', b: 'RAC' };
  assert.equal(gapWords(104.48, 104.88, codes), 'PIA 0.40 s quicker');
  assert.equal(gapWords(106.5, 105.6, codes), 'RAC 0.90 s quicker');
  assert.equal(gapWords(104.881, 104.88, codes), 'Level');
});

const codes = { a: 'PIA', b: 'RAC' };
// Piana's typical passes through T10 at Zandvoort, and Rackl's as they differ
const g = (o = {}) => ({ passes: 3, brake_point: -97, brake_off: -6, peak_brake: 63.4, trail_share: 1, min_speed: 74.1,
  min_speed_at: 1, gear: 2, throttle_on: 0, full_throttle: 33, exit_speed: 139.5, time: 15.48, speed: [], brake: [],
  throttle: [], ...o });
const RAC_T10 = { brake_point: -103.5, brake_off: -25, peak_brake: 64.2, min_speed: 80.0, min_speed_at: -5,
  throttle_on: -9, exit_speed: 141.1 };

test('a corner\'s differences in words: the three biggest, in the order a lap meets them, each driver\'s joined', () => {
  assert.equal(differenceWords(g(), g(RAC_T10), codes, 'bar'),
    'PIA stays on the brakes 19 m longer, RAC carries 5.9 km/h more at the apex and picks up the throttle 9 m earlier');
  assert.equal(differenceWords(g({ brake_point: -90, peak_brake: 80 }), g({ brake_point: -99, peak_brake: 76 }), codes,
    'bar'), 'PIA brakes 9 m later and 4 bar harder');
  assert.equal(differenceWords(g(), g({ peak_brake: 70 }), codes, 'bar'), 'RAC brakes 7 bar harder');
  assert.equal(differenceWords(g({ min_speed: 155.9 }), g({ min_speed: 153.7 }), codes, null, true),
    'PIA carries 2.2 km/h more through the corner');
  // under the least difference said (2 m of braking point, half a km/h): the same
  assert.equal(differenceWords(g(), g({ brake_point: -99, min_speed: 73.6 }), codes, 'bar'), null);
});

test('a corner\'s numbers side by side, positions from the apex', () => {
  assert.deepEqual(numberRows(g(), g(RAC_T10), 'bar', false).map((r) => [r.label, r.a, r.b]), [
    ['Brake point', '97 m before', '103 m before'], ['Peak brake', '63 bar', '64 bar'],
    ['Off the brakes', '6 m before', '25 m before'], ['Minimum speed', '74.1 km/h, gear 2', '80.0 km/h, gear 2'],
    ['Slowest point', '1 m after', '5 m before'], ['Throttle on', 'at the apex', '9 m before'],
    ['Full throttle', '33 m after', '33 m after'], ['Exit speed', '139.5 km/h', '141.1 km/h'],
  ]);
  const flat = { brake_point: null, brake_off: null, peak_brake: null, throttle_on: null, full_throttle: null,
    gear: null };
  assert.deepEqual(numberRows(g(flat), g(flat), null, true).map((r) => r.label), ['Speed in the corner', 'Exit speed']);
  assert.equal(fromApex(null), '–');
});

const corner = (code, delta_s, extra = {}) => ({ code, delta_s, faster: delta_s < 0 ? 'a' : 'b', beats: 7, of: 9,
  main_phase: 'mid', ...extra });

test('a corner\'s time second, the corners biggest gap first, the close ones folded in lap order', () => {
  assert.equal(gapLine(corner('T10', -0.226, { beats: 29, of: 29 }), codes),
    'PIA 0.23 s quicker here (typical passes), on 29 of 29 laps, most of it mid-corner');
  assert.equal(gapLine(corner('T8', 0.127, { main_phase: null }), codes),
    'RAC 0.13 s quicker here (typical passes), on 7 of 9 laps');
  assert.equal(gapLine(corner('T4', 0.004), codes), 'Level here (typical passes)');
  const { shown, folded } = cornerOrder([corner('T1', -0.012), corner('T3', -0.107), corner('T6-T7', 0.014),
    corner('T10', -0.226), corner('T8', 0.127)]);
  assert.deepEqual(shown.map((c) => c.code), ['T10', 'T8', 'T3']);
  assert.deepEqual(folded.map((c) => c.code), ['T1', 'T6-T7']);
});

test('a mistake the technique check flags in a corner for one driver of the two', () => {
  const flags = {
    a: [{ kind: 'exit_lift', code: 'T10', title: 'Lifting on the way out', laps: 5, of: 29, share: 0.17 }],
    b: [{ kind: 'exit_lift', code: 'T10', title: 'Lifting on the way out', laps: 12, of: 32, share: 0.375 },
      { kind: 'braking_unused', code: 'T11', title: 'Braking grip left unused', laps: 28, of: 32, share: 0.875 },
      { kind: 'on_off_throttle', code: 'T6', title: 'Throttle on and off', laps: 3, of: 32, share: 0.09 }],
  };
  assert.deepEqual(checkLines('T10', flags, codes),
    ['RAC: lifting on the way out on 12 of 32 laps, PIA on 5 of 29 (technique check)']);
  // in a section holding the flagged corner; a flag both drivers have about as often isn't one driver's
  assert.deepEqual(checkLines('T11-T12', flags, codes), ['RAC: braking grip left unused on 28 of 32 laps (technique check)']);
  const both = { a: [{ ...flags.b[1], laps: 20, of: 29, share: 0.69 }], b: flags.b };
  assert.deepEqual(checkLines('T11-T12', both, codes), []);
  assert.deepEqual(checkLines('T6-T7', flags, codes), []); // on under a quarter of the laps
  assert.deepEqual(cornerNumbers('T2-T5'), [2, 3, 4, 5]);
  assert.deepEqual(cornerNumbers('T8/T9'), [8, 9]);
  assert.ok(inSection('T7', 'T6-T7') && inSection('T9', 'T8/T9') && !inSection('T1', 'T11-T12'));
});

test('what was matched, in a line; the sessions apart when they differ; the runs left out', () => {
  const names = { a: 'Piana', b: 'Rackl' };
  const m = { same_sessions: true, parts: ['04_R1', '05_R2'], by_side: { a: ['04_R1', '05_R2'], b: ['04_R1', '05_R2'] },
    runs: { a: [3, 7], b: [4, 6] }, left_out: [] };
  assert.deepEqual(matchedLines(m, 'Fresh', { a: 29, b: 32 }, names), [
    'Like with like: fresh tyres, clean laps in 04_R1 and 05_R2, where both drove (29 of Piana\'s, 32 of Rackl\'s); ' +
    'each corner\'s passes ranked against the laps either side in the same stint.',
  ]);
  const apart = { ...m, same_sessions: false, parts: [], by_side: { a: ['FP1'], b: ['FP2'] } };
  assert.equal(matchedLines(apart, 'Used', { a: 9, b: 11 }, names)[1],
    'Piana\'s laps are from FP1, Rackl\'s from FP2: the track can differ.');
  const out = { ...m, parts: ['FP1'], left_out: [{ session_id: 9, name: 'FP2', side: 'a' }] };
  assert.equal(matchedLines(out, 'Used', { a: 9, b: 11 }, names)[1], 'Left out: Piana\'s FP2, where only Piana drove.');
});

test('the balance where the drivers differ, one line per corner, the biggest difference first', () => {
  const c = (value) => {
    const a = Math.round(Math.abs(value) * 10) / 10; // as the server reads it (analysis/setup_advice.py describe)
    const strength = a >= 1.5 ? 'strong' : a >= 0.8 ? 'clear' : a >= 0.3 ? 'slight' : null;
    return { value, kind: strength ? (value > 0 ? 'understeer' : 'oversteer') : 'normal', strength };
  };
  const row = (code, a, b) => ({ code, a: { entry: a[0] == null ? null : c(a[0]), mid: c(a[1]), exit: c(a[2]) },
    b: { entry: b[0] == null ? null : c(b[0]), mid: c(b[1]), exit: c(b[2]) } });
  const { differ, same } = balanceDiffs([
    row('T1', [0.61, 0.6, -0.52], [0.44, 2.06, -0.39]),
    row('T3', [1.64, 2.12, -0.49], [1.1, 1.4, -0.45]), // strong against clear, 0.72° apart: differs mid
    row('T6-T7', [0.18, 0.44, -0.03], [-0.01, 1.56, 0.07]),
    row('T8', [0.31, 1.62, -0.38], [0.29, 1.8, -0.35]), // the same words
    row('T10', [0.9, 0.79, -0.68], [-0.16, 1.66, -0.7]),
    row('T4', [null, 0.1, -0.38], [0.3, 0.12, -0.33]), // entry measured for one only
  ], { a: 'PIA', b: 'RAC' });
  assert.deepEqual(differ.map((d) => d.line), [
    'T1 mid: PIA slight understeer, RAC strong understeer',
    'T6-T7 mid: PIA slight understeer, RAC strong understeer',
    'T10 entry: PIA clear understeer, RAC neutral; mid: PIA clear understeer, RAC strong understeer',
    'T3 entry: PIA strong understeer, RAC clear understeer; mid: PIA strong understeer, RAC clear understeer',
  ]);
  assert.deepEqual(same, ['T8', 'T4']);
});

test('grip use per driver: the median of their laps in the grip report', () => {
  const lap = (run, g, braking) => ({ run, lap: 1, grip_use: g, phases: { braking, trail: g, mid: g, exit: null } });
  const ids = { R1: 3, 'R1 (2)': 4, 'R2 (3)': 7 };
  const got = gripBySide([lap('R1', 80, 70), lap('R1', 82, 74), lap('R2 (3)', 90, 78), lap('R1 (2)', 78, 72),
    lap('Elsewhere', 99, 99)], (run) => ids[run], { a: [3, 7], b: [4] });
  assert.deepEqual(got.a, { laps: 3, grip_use: 82, phases: { braking: 74, trail: 82, mid: 82, exit: null } });
  assert.equal(got.b.laps, 1);
  assert.equal(gripBySide([], () => null, { a: [1], b: [2] }).a, null);
});

test('a corner\'s balance rows: its own section, or the one sharing its corners', () => {
  const cell = (value, kind, strength) => ({ value, kind, strength });
  const sections = [
    { code: 'T6-T7', a: { entry: null, mid: cell(0.44, 'understeer', 'slight'), exit: null },
      b: { entry: cell(-0.01, 'normal', null), mid: cell(1.56, 'understeer', 'strong'), exit: null } },
  ];
  assert.equal(balanceFor(sections, 'T6/T7').code, 'T6-T7');
  assert.equal(balanceFor(sections, 'T10'), null);
  assert.deepEqual(balanceRows(sections[0]), [
    { label: 'Balance on entry', a: '–', b: 'neutral' },
    { label: 'Balance mid-corner', a: 'slight understeer', b: 'strong understeer' },
  ]);
  assert.deepEqual(balanceRows(null), []);
});

test('the laps for the traces: both best laps at first, the typical ones to add, a typical lap that is the best lap once', () => {
  const lap = (session_id, n, time) => ({ session_id, lap: n, time });
  const offer = traceLaps({ a: { best: lap(3, 5, 104.48), typical: lap(7, 12, 105.6) },
    b: { best: lap(6, 3, 104.88), typical: lap(6, 9, 106.56) } });
  assert.deepEqual(offer.map((l) => [l.key, l.session_id, l.lap, l.slot, l.also]), [
    ['a:best', 3, 5, 0, null], ['a:typical', 7, 12, 2, null], ['b:best', 6, 3, 1, null], ['b:typical', 6, 9, 3, null],
  ]);
  assert.deepEqual(onTraces(offer, DEFAULT_TRACES).map((l) => l.key), ['a:best', 'b:best']);
  let keys = flipTrace(DEFAULT_TRACES, 'b:typical');
  assert.deepEqual(onTraces(offer, keys).map((l) => l.key), ['a:best', 'b:best', 'b:typical']);
  keys = flipTrace(keys, 'a:best');
  assert.deepEqual(keys, ['b:best', 'b:typical']);
  // Piana's one qualifying lap is both his best and his typical lap
  const q = traceLaps({ a: { best: lap(1, 1, 102.44), typical: lap(1, 1, 102.44) },
    b: { best: lap(2, 2, 103.6), typical: lap(2, 4, 104.1) } });
  assert.deepEqual(q.map((l) => [l.key, l.also]), [['a:best', 'typical'], ['b:best', null], ['b:typical', null]]);
});
