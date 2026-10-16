// The home page's tracks with their events, what an event is called, and the lines its events show. Run with `npm test`.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  byTrack, carLine, driverLapsLine, driversLine, eventLabel, finishesLine, shortName, surname, UNKNOWN, UNKNOWN_NAME,
  yearSpan,
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

// where an event was, as the page works it out (its track, else its planned venue, else its name)
const keyOf = { 'Hockenheim GP': 'hockenheim', Hockenheimring: 'hockenheim', Zandvoort: 'zandvoort', Monza: 'monza' };
const at = (f) => (f.track && keyOf[f.track] ? { key: keyOf[f.track], name: f.track.replace(/ GP$|ring$/, '') } : null);

test('events by track: the latest driven first, planned-only tracks after, unknown last; events newest first', () => {
  const list = [
    { ...ev(null, '2025-05-05', '2025-05-05'), key: 'none', name: 'Not in an event' },
    ev(1, '2025-05-05', '2025-05-06', { track: 'Hockenheim GP' }),
    ev(2, '2026-09-18', '2026-09-20', { ...gt4(5), track: 'Zandvoort', clean_laps: 40 }),
    ev(3, '2026-04-10', '2026-04-12', { ...gt4(1), track: 'Hockenheimring', clean_laps: 30 }),
    ev(4, '2026-02-03', '2026-02-03', { track: 'Hockenheim GP', clean_laps: 12 }),
    ev(5, '2026-11-09', '2026-11-11', { track: 'Monza', sessions: 0, clean_laps: 0 }),
    ev(6, null, null, { sessions: 0, clean_laps: 0 }),
    ev(7, '2026-12-01', '2026-12-01', { track: 'Zandvoort', sessions: 0, clean_laps: 0 }),
  ];
  const tracks = byTrack(list, at);
  assert.deepEqual(tracks.map((t) => t.key), ['zandvoort', 'hockenheim', 'monza', UNKNOWN]);
  const [zan, hoc, mon, none] = tracks;
  // a planned event later than the latest driven one comes first under its track, and doesn't move the track
  assert.deepEqual(zan.events.map((f) => f.id), [7, 2]);
  assert.deepEqual(hoc.events.map((f) => f.id), [3, 4, 1]); // two names, one circuit
  assert.equal(hoc.name, 'Hockenheim');
  assert.deepEqual([hoc.driven, hoc.cleanLaps, hoc.first, hoc.last], [3, 43, '2025-05-05', '2026-04-12']);
  assert.deepEqual([mon.driven, mon.events.length], [0, 1]);
  assert.deepEqual([none.name, none.events.map((f) => f.id)], [UNKNOWN_NAME, [6]]);
  // the runs in no event have their own line, not a track
  assert.ok(!tracks.some((t) => t.events.some((f) => f.id == null)));
});

test('an event is called by its championship and year, else Test and its month', () => {
  assert.equal(eventLabel(ev(1, '2025-09-18', '2025-09-20', { season: { id: 1, name: 'GT4 European Series 2025', year: 2025, round: 5 } })),
    'GT4 Euro 2025');
  assert.equal(eventLabel(ev(1, '2026-07-01', '2026-07-03', { series: 'ADAC GT4 Germany' })), 'ADAC GT4 Germany 2026');
  // the season's year, not the day's: a round that ran into the new year
  assert.equal(eventLabel(ev(1, '2027-01-02', '2027-01-03', { season: { id: 1, name: 'Winter Series', year: 2026, round: 4 } })),
    'Winter Series 2026');
  assert.equal(eventLabel(ev(1, '2026-02-03', '2026-02-04')), 'Test February 2026');
  // named a test, in a championship: still a test
  assert.equal(eventLabel(ev(1, '2026-03-20', '2026-03-20', { series: 'ADAC GT4 Germany', name: 'ADAC Testtage Oschersleben' })),
    'Test March 2026');
  assert.equal(eventLabel(ev(1, null, null)), 'Test');
  assert.equal(eventLabel(ev(1, null, null, { series: 'GT4 European Series' })), 'GT4 Euro');
});

test('the years a track\'s events span', () => {
  assert.equal(yearSpan('2025-05-05', '2026-04-12'), '2025–2026');
  assert.equal(yearSpan('2026-02-03', '2026-04-12'), '2026');
  assert.equal(yearSpan(null, null), null);
});

test('a round\'s event reads without its championship\'s name under it', () => {
  assert.equal(shortName(ev(1, null, null, { ...gt4(5), name: 'Zandvoort · GT4 European Series 2026' })), 'Zandvoort');
  assert.equal(shortName(ev(1, null, null, { ...gt4(5), name: 'Zandvoort weekend' })), 'Zandvoort weekend');
  assert.equal(shortName(ev(1, null, null, { name: 'Monza test · GT4 European Series 2026' })),
    'Monza test · GT4 European Series 2026'); // in no championship: as it is
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
