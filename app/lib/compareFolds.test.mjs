// Which track of the Compare page's list opens first, and the folds kept for the visit. Run with `npm test`.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { eventTrack, keepFold, latestTrack, openFirst, pickedTrack, visitFolds } from './compareFolds.ts';

const run = (id, event, date) => ({ id, name: `Run ${id}`, driver: null, event, date, best_lap: 1, best_time: 100,
  laps: [{ number: 1, time: 100, clean: true }] });
const groups = [
  { key: 'track 2', track: 'Zandvoort',
    sessions: [run(12, 'zandvoort-2026-09', '2026-09-19'), run(13, 'zandvoort-2026-09', '2026-09-20')] },
  { key: 'track 1', track: 'Hockenheimring',
    sessions: [run(1, 'Hockenheim test', '2025-05-05'), run(7, 'Hockenheim test', '2025-05-06')] },
  { key: 'venue Spa', track: 'Spa', sessions: [run(20, 'Spa', null)] },
];
const ev = (name, track) => ({ name, track });

test('no event on: the track of the most recent session', () => {
  assert.equal(openFirst(groups, {}), 'track 2');
  assert.equal(latestTrack(groups).key, 'track 2');
  // the same day: the newest session; a session without a day comes after every dated one
  const sameDay = [{ ...groups[1], sessions: [run(3, 'x', '2026-09-20')] },
    { ...groups[0], sessions: [run(9, 'y', '2026-09-20')] }];
  assert.equal(latestTrack(sameDay).key, 'track 2');
  assert.equal(latestTrack([groups[2], groups[1]]).key, 'track 1');
  assert.equal(openFirst([], {}), null);
});

test('during a weekend: the track of the event that is on', () => {
  assert.equal(openFirst(groups, { current: ev('Hockenheim test', 'Hockenheimring') }), 'track 1');
  // by its track's name, whatever its runs are called (a planned weekend at a track driven before)
  assert.equal(openFirst(groups, { current: ev('GT4 Round 6', ' hockenheimring ') }), 'track 1');
  // no track on the event: the track its runs are listed under
  assert.equal(eventTrack(groups, ev('Spa', null)).key, 'venue Spa');
  // an event at a track with no laps yet: the most recent session's track
  assert.equal(openFirst(groups, { current: ev('Monza test', 'Monza') }), 'track 2');
  assert.equal(eventTrack(groups, null), null);
});

test('opened with picked laps: their track, before the event that is on', () => {
  assert.equal(openFirst(groups, { picked: [7, 1], current: ev('zandvoort-2026-09', 'Zandvoort') }), 'track 1');
  // a picked session no longer listed is passed over
  assert.equal(openFirst(groups, { picked: [99, 20] }), 'venue Spa');
  assert.equal(openFirst(groups, { picked: [99] }), 'track 2');
  assert.equal(pickedTrack(groups, [99]), null);
});

test('folds tapped are kept for the visit, and can be forgotten', () => {
  keepFold('track 2', false);
  keepFold('track 1', true);
  assert.deepEqual(visitFolds(), { 'track 2': false, 'track 1': true });
  keepFold('track 1', null);
  assert.deepEqual(visitFolds(), { 'track 2': false });
});
