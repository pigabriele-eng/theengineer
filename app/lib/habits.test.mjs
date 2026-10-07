// The habit tracker's page logic (lib/habitView.ts; lib/habits.ts needs the app's API client, which Node can't load):
// the shared request, the teammate set beside a driver, the words of figures and trends, the headline, the habit list,
// where a habit shows most, a habit event by event and the style differences the right way round.
// Run with `npm test` (Node's own test runner; Node 22.18 or later reads the .ts file directly).
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  barScale,
  checkingWords,
  cornerWords,
  dayWords,
  defaultMate,
  eventLabel,
  figures,
  habitsFor,
  headline,
  history,
  keepDriver,
  keepMate,
  pct,
  perLap,
  sharedEvents,
  sharedLoader,
  styleDifferences,
  topHabit,
  traitLine,
  trendMark,
  trendSentence,
} from './habitView.ts';

const PIA = 1;
const RAC = 2;
const NEW = 3;
const drivers = [{ id: PIA }, { id: RAC }, { id: NEW }]; // most laps first
const events = [
  { id: 10, name: 'Zandvoort test', track: 'Zandvoort', date: '2026-04-02', laps: { 1: 30, 2: 28 } },
  { id: 11, name: 'Monza round', track: 'Monza', date: '2026-05-20', laps: { 1: 22, 2: 25, 3: 12 } },
  { id: 12, name: 'Misano round', track: null, date: null, laps: { 1: 18, 2: 0, 3: 20 } },
];
const stat = (rate, cost, fields = {}) => ({ rate, cost_per_lap_s: cost, laps: 50, events: 2, trend: null, by_event: [],
  corners: [], types: {}, ...fields });
const habit = (kind, label, by) => ({ kind, label, group: 'braking', do: 'Do this instead.', drivers: by });

test('one request for many trackers, kept for a while, a failure not kept', async () => {
  let calls = 0;
  let clock = 0;
  let fail = false;
  const shared = sharedLoader(async () => {
    calls += 1;
    if (fail) throw new Error('down');
    return { n: calls };
  }, () => clock);
  assert.equal(shared.peek(30_000), null);
  const [x, y] = await Promise.all([shared.load(30_000), shared.load(30_000)]);
  assert.equal(calls, 1);
  assert.equal(x, y);
  clock = 20_000;
  assert.equal(await shared.load(30_000), x); // still fresh
  assert.equal(shared.peek(30_000), x);
  assert.deepEqual(await shared.load(5_000), { n: 2 }); // a poll asks for a fresher one
  clock = 60_000;
  fail = true;
  await assert.rejects(shared.load(30_000), /down/);
  fail = false;
  assert.deepEqual(await shared.load(30_000), { n: 4 }); // the failure was not kept: asked again
});

test('the driver picked stays while they are in the list, else the one with most laps', () => {
  assert.equal(keepDriver(drivers, RAC), RAC);
  assert.equal(keepDriver(drivers, 99), PIA);
  assert.equal(keepDriver(drivers, null), PIA);
  assert.equal(keepDriver([], null), null);
});

test('the teammate beside a driver is the one they shared most events with; nobody without one', () => {
  assert.equal(sharedEvents(events, PIA, RAC), 2); // Misano: RAC has no laps
  assert.equal(sharedEvents(events, PIA, NEW), 2);
  assert.equal(defaultMate(drivers, events, PIA), RAC); // a tie: the one with more laps
  assert.equal(defaultMate(drivers, events, NEW), PIA);
  assert.equal(defaultMate(drivers, events, RAC), PIA);
  assert.equal(defaultMate([{ id: PIA }, { id: 9 }], events, PIA), null); // never in the car together
  assert.equal(defaultMate([{ id: PIA }], events, PIA), null);
});

test('a teammate picked is kept, nobody on purpose stays nobody, a stale pick falls back', () => {
  assert.equal(keepMate(drivers, events, PIA, undefined), RAC);
  assert.equal(keepMate(drivers, events, PIA, NEW), NEW);
  assert.equal(keepMate(drivers, events, PIA, null), null);
  assert.equal(keepMate(drivers, events, PIA, 99), RAC);
  assert.equal(keepMate(drivers, events, PIA, PIA), RAC);
});

test('figures in plain words, how often first', () => {
  assert.equal(pct(0.08), '8%');
  assert.equal(pct(0.004), 'under 1%');
  assert.equal(pct(0), '0%');
  assert.equal(perLap(0.213), '0.21 s a lap');
  assert.equal(perLap(0.001), 'under 0.01 s a lap');
  assert.equal(figures({ rate: 0.08, cost_per_lap_s: 0.21 }), '8% of corners, 0.21 s a lap');
});

test('a trend: its marker and its sentence, or why there is none yet', () => {
  const better = { dir: 'better', words: 'Better: from 12% of corners at Zandvoort to 5% at Misano' };
  assert.equal(trendMark(better), 'better');
  assert.equal(trendMark(null), 'no trend yet');
  assert.equal(trendSentence(better), 'Better: from 12% of corners at Zandvoort to 5% at Misano.');
  assert.equal(trendSentence({ dir: 'steady', words: 'About the same.' }), 'About the same.');
  assert.match(trendSentence(null), /^Not enough events yet/);
});

test('the headline is the costliest habit the driver has, with its trend', () => {
  const trend = { dir: 'better', words: 'Better: from 12% of corners at Zandvoort to 5% at Misano' };
  const habits = [
    habit('early_brake', 'Braking too early', { 1: stat(0.2, 0.1), 2: stat(0.3, 0.4) }),
    habit('lift_exit', 'Lifting on the way out', { 1: stat(0.08, 0.21, { trend }), 2: stat(0, 0) }),
    habit('coast', 'Coasting', { 1: stat(0, 0.5) }), // never happened: not a habit of theirs
  ];
  assert.equal(topHabit(habits, PIA).kind, 'lift_exit');
  assert.deepEqual(headline(habits, PIA), { text: 'Lifting on the way out, 8% of corners, 0.21 s a lap.', trend,
    none: false });
  assert.equal(topHabit(habits, RAC).kind, 'early_brake');
  assert.deepEqual(headline(habits, NEW), { text: 'No repeated mistake found yet.', trend: null, none: true });
});

test('the list: habits either driver has, the driver\'s costliest first', () => {
  const habits = [
    habit('a', 'A', { 1: stat(0.1, 0.05), 2: stat(0.2, 0.3) }),
    habit('b', 'B', { 1: stat(0.1, 0.2) }),
    habit('c', 'C', { 2: stat(0.1, 0.1) }), // only the teammate
    habit('d', 'D', { 1: stat(0, 0), 2: stat(0, 0) }), // neither
  ];
  assert.deepEqual(habitsFor(habits, PIA, RAC).map((h) => h.kind), ['b', 'a', 'c']);
  assert.deepEqual(habitsFor(habits, PIA, null).map((h) => h.kind), ['b', 'a']);
});

test('where a habit shows most: official corner numbers, by track, else the event\'s name', () => {
  const corners = [
    { code: 'T7', event_id: 10, track: 'Zandvoort', rate: 0.5 },
    { code: 'T3', event_id: 10, track: 'Zandvoort', rate: 0.4 },
    { code: 'T8/T9', event_id: 12, track: null, rate: 0.3 },
  ];
  assert.equal(cornerWords(corners, events), 'Most at T7 and T3 Zandvoort, T8/T9 Misano round');
  assert.equal(cornerWords([corners[0]], events), 'Most at T7 Zandvoort');
  assert.equal(cornerWords([], events), null);
});

test('events in a list: the track (else the name) and the day', () => {
  assert.equal(dayWords('2026-04-02'), '2 Apr 2026');
  assert.equal(eventLabel(events[0]), 'Zandvoort · 2 Apr 2026');
  assert.equal(eventLabel(events[2]), 'Misano round');
  assert.equal(checkingWords(['Spa', 'Misano']), 'Still checking the laps of Spa, Misano…');
  assert.equal(checkingWords(['A', 'B', 'C', 'D', 'E']), 'Still checking the laps of A, B, C and 2 more…');
  assert.equal(checkingWords([]), 'Still checking the latest laps…');
});

test('a habit event by event, oldest first, with who did not drive there', () => {
  const h = habit('a', 'A', {
    1: stat(0.1, 0.1, { by_event: [{ event_id: 10, rate: 0.12, cost_per_lap_s: 0.2, laps: 30 },
      { event_id: 12, rate: 0.05, cost_per_lap_s: 0.1, laps: 18 }] }),
    2: stat(0.2, 0.2, { by_event: [{ event_id: 10, rate: 0.2, cost_per_lap_s: 0.3, laps: 28 }] }),
  });
  const lines = history(h, [PIA, RAC], events);
  assert.deepEqual(lines.map((l) => [l.event.id, l.label, l.rates]), [
    [10, 'Zandvoort · 2 Apr 2026', [0.12, 0.2]],
    [12, 'Misano round', [0.05, null]],
  ]);
  assert.deepEqual(history(h, [RAC], events).map((l) => l.event.id), [10]);
  assert.equal(barScale([0.12, 0.2, null]), 0.2);
  assert.equal(barScale([0.21]), 0.25);
  assert.equal(barScale([0.02, 0]), 0.1); // a rare habit keeps short bars
  assert.equal(barScale([]), 0.1);
});

test('style differences worded for the driver shown, flipped when they are the pair\'s second', () => {
  const groups = [{ key: 'braking', label: 'Braking' }, { key: 'throttle', label: 'Throttle and exits' }];
  const trait = (kind, group, words, words_b, agree, of) =>
    ({ kind, group, label: kind, explain: '', words, words_b, agree, of, size: 1 });
  const pairs = [{ a: PIA, b: RAC, events: 4, traits: [
    trait('throttle_early', 'throttle', 'opens the throttle sooner', 'opens the throttle later', 3, 4),
    trait('brake_point', 'braking', 'brakes later', 'brakes earlier', 4, 4),
    trait('odd', 'nowhere', 'does it more', 'does it less', 1, 1),
  ] }];
  const pia = { id: PIA, code: 'PIA' };
  const rac = { id: RAC, code: 'RAC' };
  const mine = styleDifferences(pairs, groups, pia, rac);
  assert.equal(mine.events, 4);
  assert.deepEqual(mine.groups.map((g) => g.label), ['Braking', 'Throttle and exits', 'Other']);
  assert.deepEqual(mine.groups[0].lines[0], { kind: 'brake_point', line: 'PIA brakes later than RAC', at: 'at 4 of 4 events' });
  assert.equal(mine.groups[2].lines[0].at, 'at 1 of 1 event');
  const theirs = styleDifferences(pairs, groups, rac, pia);
  assert.equal(theirs.groups[0].lines[0].line, 'RAC brakes earlier than PIA');
  assert.equal(theirs.groups[1].lines[0].line, 'RAC opens the throttle later than PIA');
  assert.equal(traitLine({ words: 'brakes later than RAC', words_b: '' }, false, 'PIA', 'RAC'), 'PIA brakes later than RAC');
  assert.equal(styleDifferences(pairs, groups, pia, { id: NEW, code: 'NEW' }), null);
  assert.equal(styleDifferences([{ a: PIA, b: RAC, events: 2, traits: [] }], groups, pia, rac), null);
});
