// How an event's days sit side by side on the home page and the event page. Run with `npm test`.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { dayColumns, MIN_EVENT_DAY } from './dayColumns.ts';

const GUTTER = 32;

test('one or two days, or a phone: the page keeps its usual layout', () => {
  assert.equal(dayColumns(1, 1440, true, GUTTER), null);
  assert.equal(dayColumns(2, 1440, true, GUTTER), null);
  assert.equal(dayColumns(4, 390, false, 16), null);
});

test('three or four days on a wide screen sit in one row', () => {
  assert.equal(dayColumns(3, 1440, true, GUTTER), 'across');
  assert.equal(dayColumns(4, 1440, true, GUTTER), 'across');
  assert.equal(dayColumns(4, 1100, true, GUTTER), 'across'); // 4 columns of 241 px
});

test('a window too narrow for that many columns shows two a row', () => {
  assert.equal(dayColumns(4, 1000, true, GUTTER), 'half'); // 4 columns would be 216 px
  assert.equal(dayColumns(3, 780, true, GUTTER), 'half');
  assert.equal(dayColumns(3, 900, true, GUTTER), 'across');
});

test('the page stops widening at 1240 px', () => {
  assert.equal(dayColumns(5, 1440, true, GUTTER), 'half'); // 5 columns would be 216 px
  assert.equal(dayColumns(5, 2560, true, GUTTER), 'half');
});

test('the event page wants wider columns: four go two a row below a 1176 px window', () => {
  assert.equal(dayColumns(4, 1440, true, GUTTER, MIN_EVENT_DAY), 'across'); // 276 px each
  assert.equal(dayColumns(4, 1180, true, GUTTER, MIN_EVENT_DAY), 'across'); // 261 px
  assert.equal(dayColumns(4, 1100, true, GUTTER, MIN_EVENT_DAY), 'half'); // 241 px would cut the run names
  assert.equal(dayColumns(3, 1100, true, GUTTER, MIN_EVENT_DAY), 'across');
});
