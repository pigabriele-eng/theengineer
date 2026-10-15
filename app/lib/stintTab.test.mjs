// The Stint analysis tab's order and words. Run with `npm test`.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { balanceWords, fuelSplit, runGroup, shifts, splitWords, stintChoices, wholeLap } from './stintTab.ts';

const fit = (per_lap, change, clear, within = 0.05) => ({ per_lap, change, clear, within, se: within / 2, laps: 9,
  level: 1 });
const lap = (n, extra = {}) => ({ lap: n, in_fit: true, fuel_kg: 2, balance: { entry: 0.1, mid: 0.2, exit: -0.1 },
  ...extra });

function stint(over = {}) {
  return {
    key: '3:1', file_key: '3', run: '04_R1', session_id: 3, number: 1, first_lap: 1, last_lap: 15, fitted_laps: 9,
    groups: { early: [4, 5, 6], late: [12, 13, 14] },
    laps: [lap(1, { in_fit: false }), ...[4, 5, 6, 8, 10, 11, 12, 13, 14].map((n) => lap(n))],
    sections: [
      { code: 'T1', corner: true, entry: { early: 0.1, late: 0.15, shift: 0.05 }, fade: {}, driver: {} },
      { code: 'T3', corner: true, exit: { early: 0.2, late: -0.2, shift: -0.4 }, fade: {}, driver: {} },
      { code: 'T8', corner: true, entry: { early: 0.1, late: 0.56, shift: 0.46 }, fade: {}, driver: {} },
      { code: 'S1', corner: false, entry: { early: 0, late: 2, shift: 2 }, fade: {}, driver: {} },
    ],
    balance_laps: { laps: [4, 5, 6, 8, 10, 11, 12, 13, 14], corners: [
      { code: 'T3', exit: { values: [], trend: { per_lap: -0.04, within: 0.02, change: -0.4, clear: true, laps: 9 } } },
      { code: 'T8', entry: { values: [], trend: { per_lap: 0.05, within: 0.1, change: 0.5, clear: false, laps: 9 } } },
    ] },
    fits: { time: fit(0.13, 1.3, true, 0.07), corrected_time: fit(0.15, 1.5, true, 0.07),
      balance_entry: fit(0, 0, false), balance_mid: fit(0.02, 0.2, true), balance_exit: fit(-0.005, -0.05, true) },
    fuel: { source: 'log', note: '', kg_per_lap: 1.9, s_per_10kg: 0.1, mass_kg: 1600, mass_source: '',
      fuel_s_per_lap: -0.02 },
    ...over,
  };
}

test('a race first, then practice and tests, qualifying last', () => {
  assert.equal(runGroup('04_R1'), 0);
  assert.equal(runGroup('R1 stint 2'), 0);
  assert.equal(runGroup('Race 1'), 0);
  assert.equal(runGroup('Test', 'race'), 0);
  assert.equal(runGroup('FP1'), 1);
  assert.equal(runGroup('Practice'), 1);
  assert.equal(runGroup('D1S1', 'test'), 1);
  assert.equal(runGroup('03_Q (2)'), 2);
  assert.equal(runGroup('Q1'), 2);
  assert.equal(runGroup('Warm-up', 'qualifying'), 2);
});

test('the stints to pick: race first, each with its driver, the short ones left out by name', () => {
  const runs = [{ id: 1, name: '03_Q', driver: 'PIA' }, { id: 2, name: 'FP1', driver: null },
    { id: 3, name: '04_R1', driver: 'RAC' }];
  const stints = [
    stint({ key: '1:1', file_key: '1', run: '03_Q', session_id: 1, fitted_laps: 2 }),
    stint({ key: '2:1', file_key: '2', run: 'FP1', session_id: 2, number: 1, first_lap: 1, last_lap: 6 }),
    stint({ key: '2:2', file_key: '2', run: 'FP1', session_id: 2, number: 2, first_lap: 7, last_lap: 12 }),
    stint(),
  ];
  const { choices, short } = stintChoices(stints, runs);
  assert.deepEqual(choices.map((c) => c.label), ['04_R1 · RAC', 'FP1 · stint 1 · No driver', 'FP1 · stint 2 · No driver']);
  assert.equal(choices[0].sub, 'laps 1–15 · 9 in the trend');
  assert.deepEqual(short, ['03_Q']);
  // the picked stint stays in the list even when too short
  assert.equal(stintChoices(stints, runs, '1:1').choices.at(-1).key, '1:1');
});

test('where the balance moved most, and how sure', () => {
  const s = stint();
  assert.deepEqual(shifts(s).map((x) => `${x.code} ${x.phase}`), ['T8 entry', 'T3 exit', 'T1 entry']); // corners only
  const w = balanceWords(s);
  assert.equal(w.headline, 'The balance moves most at T8 on entry: +0.46° towards understeer, from the early laps (4, 5 and 6) to the late laps (12, 13 and 14).');
  assert.equal(w.next, 'Then T3 on exit (−0.40°, towards oversteer).');
  assert.equal(w.sure, 'Lap by lap, 1 of the 2 shifts over 0.15° stands clear of the lap-to-lap scatter: T3 on exit; the others are a lean to watch.');
  assert.equal(w.whole, 'Over the whole lap mid-corner moves 0.20° towards understeer; entry and exit hold.');
  // more than three clear: the biggest named
  const many = stint({ sections: ['T1', 'T2', 'T3', 'T4', 'T5'].map((code, i) => ({ code, corner: true,
    exit: { early: 0, late: 0.2 + i / 10, shift: 0.2 + i / 10 }, fade: {}, driver: {} })),
  balance_laps: { laps: [], corners: ['T1', 'T2', 'T3', 'T4', 'T5'].map((code) => ({ code,
    exit: { values: [], trend: { per_lap: 0.1, within: 0.01, change: 1, clear: true, laps: 9 } } })) } });
  assert.equal(balanceWords(many).sure, 'Lap by lap, all 5 stand clear of the lap-to-lap scatter.');
  many.balance_laps.corners[0].exit.trend.clear = false;
  assert.equal(balanceWords(many).sure, 'Lap by lap, 4 of the 5 shifts over 0.15° stand clear of the lap-to-lap scatter, the biggest T5 on exit, T4 on exit and T3 on exit; the others are a lean to watch.');
  assert.equal(wholeLap({ balance_entry: fit(0, 0, false) }), 'Over the whole lap the balance holds in every phase (within ±0.15°).');
  // nothing over 0.15°: it holds
  const calm = stint({ sections: [{ code: 'T1', corner: true, mid: { early: 0, late: 0.1, shift: 0.1 }, fade: {}, driver: {} }] });
  assert.match(balanceWords(calm).headline, /^The balance holds in every corner: none moves more than 0.15°/);
  // too few laps, or no balance at all
  assert.match(balanceWords(stint({ groups: null })).headline, /^Too few laps/);
  assert.match(balanceWords(stint({ laps: [lap(4, { balance: null })] })).headline, /^No balance/);
  // a view kept before the laps' balance was added: the shifts, without saying how sure
  assert.equal(balanceWords(stint({ balance_laps: undefined })).sure, null);
});

test('tyres against fuel, and the net, adding up', () => {
  const sp = fuelSplit(stint());
  assert.equal(sp.from, 4);
  assert.equal(sp.to, 14);
  assert.equal(sp.tyres.per_lap, 0.15);
  assert.equal(sp.fuel.per_lap, -0.02);
  assert.ok(Math.abs(sp.tyres.total + sp.fuel.total - sp.net.total) < 1e-9);
  assert.equal(sp.fuel.burnt_kg, 2 * 8); // the laps from 4 up to 14, each 2 kg (laps 7 and 9 aren't in the list)
  const w = splitWords(sp);
  assert.equal(w.headline, 'Over laps 4 to 14 the tyres cost 0.15 s a lap, 1.5 s by lap 14; burning 16.0 kg of fuel gave back 0.02 s a lap, 0.2 s in all. Net, the car lost 0.13 s a lap: on the trend lap 14 was 1.3 s slower than lap 4.');
  assert.equal(w.sure[0], 'Tyres: a clear trend, bigger than the lap-to-lap scatter (±0.07 s a lap over 9 laps).');
  assert.match(w.sure[1], /^Fuel: the fuel used is measured by the log \(1.90 kg a lap\)/);
  // an estimate says so
  const est = splitWords(fuelSplit(stint({ fuel: { ...stint().fuel, source: 'estimate' } })));
  assert.match(est.sure[1], /^Fuel: an estimate from the time at full throttle/);
  // no clear fade
  const flat = splitWords(fuelSplit(stint({ fits: { time: fit(0.01, 0.1, false), corrected_time: fit(0.03, 0.3, false) } })));
  assert.match(flat.headline, /the tyres show no clear fade \(\+0.03 s a lap, within the scatter\)/);
  assert.match(flat.headline, /Net, the lap times hold within the scatter/);
  // without a fuel figure only the lap times
  const nofuel = splitWords(fuelSplit(stint({ fuel: null })));
  assert.match(nofuel.headline, /the lap times fade 0.13 s a lap.*can’t be told apart/);
  assert.match(splitWords(fuelSplit(stint({ fits: {} }))).headline, /^Too few laps/);
});
