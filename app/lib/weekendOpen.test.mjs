// The race weekends among events, and the next one the app opens on. Run with `npm test`.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { isCoachingDay, nextWeekend, weekendsOf } from './weekendOpen.ts';

const ev = (id, start, end, extra = {}) => ({
  id, key: String(id), name: `Event ${id}`, series: null, track: null, start, end, dates_by_hand: false,
  log_start: null, log_end: null, sessions: 0, clean_laps: 0, best_lap_s: null, best_session_id: null,
  best_session: null, ...extra,
});

test('coaching days are not weekends; an event without a mode is one', () => {
  const list = [ev(1, '2026-10-10', '2026-10-11'), ev(2, '2026-10-12', '2026-10-12', { mode: 'coaching' }),
    ev(3, '2026-10-13', '2026-10-13', { mode: 'weekend' })];
  assert.deepEqual(weekendsOf(list).map((f) => f.id), [1, 3]);
  assert.equal(isCoachingDay(list[1]), true);
});

test('the next weekend starting within 14 days, the soonest first', () => {
  const today = '2026-10-07';
  const list = [
    ev(1, '2026-10-30', '2026-11-01'), // too far
    ev(2, '2026-10-17', '2026-10-18'),
    ev(3, '2026-10-11', '2026-10-12', { mode: 'coaching' }), // a coaching day
    ev(4, '2026-10-14', '2026-10-15'),
    ev(null, '2026-10-09', '2026-10-09', { key: 'none' }), // runs in no event
    ev(5, null, null), // planned, no date yet
  ];
  assert.equal(nextWeekend(list, today)?.id, 4);
  assert.equal(nextWeekend(list, today, 5), null);
  // exactly 14 days ahead still counts; tomorrow's event is already on (the list opens on it as current)
  assert.equal(nextWeekend([ev(6, '2026-10-21', '2026-10-22')], today)?.id, 6);
  assert.equal(nextWeekend([ev(7, '2026-10-08', '2026-10-09')], today), null);
  // the same first day: the newest
  assert.equal(nextWeekend([ev(8, '2026-10-14', '2026-10-15'), ev(9, '2026-10-14', '2026-10-14')], today)?.id, 9);
});
