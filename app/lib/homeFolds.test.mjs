// The home page's events by year and championship, and what is open by default. Run with `npm test`.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  byYear, carLine, champKey, driverLapsLine, driversLine, eventKey, finishesLine, monthSpan, openByDefault, OTHER, shortName, surname, yearKey,
} from './homeFolds.ts';

const ev = (id, start, end, extra = {}) => ({
  id, key: String(id), name: `Event ${id}`, series: null, track: null, start, end, dates_by_hand: false,
  log_start: null, log_end: null, sessions: 1, clean_laps: 1, best_lap_s: 100, best_session_id: null,
  best_session: null, season: null, ...extra,
});
const gt4 = (round) => ({ season: { id: 7, name: 'GT4 European Series 2026', year: 2026, round } });

const folders = [
  { ...ev(null, '2025-05-05', '2025-05-05'), key: 'none', name: 'Not in an event' },
  ev(1, '2025-05-05', '2025-05-06'),
  ev(2, '2026-09-18', '2026-09-20', gt4(5)),
  ev(3, '2026-04-10', '2026-04-12', gt4(1)),
  ev(4, '2026-06-02', '2026-06-02'),
  ev(5, '2026-10-09', '2026-10-11', { ...gt4(6), sessions: 0 }),
  ev(6, null, null, { sessions: 0 }),
  ev(7, '2026-07-01', '2026-07-03', { series: 'ADAC GT4 Germany' }),
];

test('events by year, newest first, no date last; championships by name, the rest last; rounds in date order', () => {
  const years = byYear(folders);
  assert.deepEqual(years.map((y) => y.key), ['2026', '2025', 'none']);
  const [y26, y25, none] = years;
  assert.equal(y26.events, 5);
  assert.deepEqual([y26.start, y26.end], ['2026-04-10', '2026-10-11']);
  assert.deepEqual(y26.championships.map((c) => c.name), ['ADAC GT4 Germany', 'GT4 European Series 2026', OTHER]);
  assert.deepEqual(y26.championships[1].events.map((f) => f.id), [3, 2, 5]);
  assert.deepEqual(y25.championships.map((c) => [c.name, c.other, c.events.length]), [[OTHER, true, 1]]);
  assert.deepEqual(none.championships[0].events.map((f) => f.id), [6]);
  assert.equal(none.year, null);
  // the runs in no event have their own line, not a year
  assert.ok(!years.some((y) => y.championships.some((c) => c.events.some((f) => f.id == null))));
});

test('open by default: this year and the lead event\'s year, every championship, the lead event', () => {
  const years = byYear(folders);
  const lead = folders.find((f) => f.id === 2);
  const open = openByDefault(years, lead, 2026);
  assert.ok(open.has('y:2026') && !open.has('y:2025') && !open.has('y:none'));
  assert.ok(open.has(champKey(years[0], years[0].championships[1])));
  assert.ok(open.has(eventKey(lead)) && !open.has('e:3'));
  // only last year's test: its year opens, with it
  const old = byYear([ev(1, '2025-05-05', '2025-05-06')]);
  assert.deepEqual([...openByDefault(old, old[0].championships[0].events[0], 2026)].sort(),
    ['c:2025:other', 'e:1', 'y:2025']);
  // no lead at all: the newest year
  assert.ok(openByDefault(old, null, 2026).has(yearKey(old[0])));
});

test('a round\'s event reads without its championship\'s name under it', () => {
  assert.equal(shortName(ev(1, null, null, { ...gt4(5), name: 'Zandvoort · GT4 European Series 2026' })), 'Zandvoort');
  assert.equal(shortName(ev(1, null, null, { ...gt4(5), name: 'Zandvoort weekend' })), 'Zandvoort weekend');
  assert.equal(shortName(ev(1, null, null, { name: 'Monza test · GT4 European Series 2026' })),
    'Monza test · GT4 European Series 2026'); // in no championship: as it is
});

test('the months a year spans', () => {
  assert.equal(monthSpan('2026-04-10', '2026-10-11'), 'Apr–Oct');
  assert.equal(monthSpan('2025-05-05', '2025-05-06'), 'May');
  assert.equal(monthSpan('2025-12-30', '2026-01-02'), 'Dec 2025–Jan 2026');
  assert.equal(monthSpan(null, null), null);
});

test("an event's drivers by surname and its main car", () => {
  assert.equal(surname('Gabriele Piana'), 'Piana');
  assert.equal(surname('Max van Splunteren'), 'van Splunteren');
  assert.equal(surname('Gabriele'), 'Gabriele');
  assert.equal(surname('  Michael   Rackl '), 'Rackl');
  assert.equal(driversLine({ drivers: ['Gabriele Piana', 'Michael Rackl'] }), 'Piana, Rackl');
  assert.equal(driversLine({ drivers: [] }), null);
  assert.equal(driversLine({}), null);
  assert.equal(carLine({ cars: ['BMW M4 GT4 Evo (G82)'] }), 'BMW M4 GT4 Evo');
  assert.equal(carLine({ cars: ['BMW M4 GT4 Evo (G82)', 'Car #7'] }), 'BMW M4 GT4 Evo +1');
  assert.equal(carLine({ cars: ['Car #7', 'Car #8', 'Car #9'] }), 'Car #7 +2');
  assert.equal(carLine({ cars: [] }), null);
  assert.equal(carLine({}), null);
});

test("each driver's laps: three letters of the surname, then the laps nobody is set on", () => {
  const f = { drivers: ['Gabriele Piana', 'Michael Rackl'], unassigned_laps: 12,
    driver_laps: [{ name: 'Gabriele Piana', laps: 84 }, { name: 'Michael Rackl', laps: 71 }] };
  assert.equal(driverLapsLine(f), 'PIA 84 laps · RAC 71 laps · 12 laps unassigned');
  assert.equal(driverLapsLine({ ...f, unassigned_laps: 0, driver_laps: [{ name: 'Gabriele Piana', laps: 1 }] }), 'PIA 1 lap');
  // two drivers with the same three letters: their surnames
  assert.equal(driverLapsLine({ drivers: [], unassigned_laps: 0, driver_laps: [
    { name: 'Anna Piana', laps: 3 }, { name: 'Marco Pianari', laps: 2 }] }), 'Piana 3 laps · Pianari 2 laps');
  assert.equal(driverLapsLine({ drivers: [], driver_laps: [], unassigned_laps: 5 }), '5 laps unassigned');
  assert.equal(driverLapsLine({ drivers: [], driver_laps: [], unassigned_laps: 0 }), null);
  assert.equal(driverLapsLine({ drivers: ['Gabriele Piana'] }), 'Piana'); // an older server: the names only
});

test('race finishes: overall place, the class place when there are classes, DNF when not classified', () => {
  const f = (code, position, cls = null, cp = null, status = 'classified') =>
    ({ code, position, class: cls, class_position: cp, status });
  assert.equal(finishesLine([f('R1', 5), f('R2', 3)]), 'R1 P5 · R2 P3');
  assert.equal(finishesLine([f('R1', 12, 'Am', 2)]), 'R1 P12 (Am P2)');
  assert.equal(finishesLine([f('R1', 7), f('R2', null, null, null, 'dnf')]), 'R1 P7 · R2 DNF');
  assert.equal(finishesLine([]), null);
  assert.equal(finishesLine(undefined), null);
});
