// Swiping a run row left for its Delete, holding it for its menu: the numbers and the one open row. Run with `npm test`.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { dragOffset, isMenuKey, openRows, REVEAL, settlesOpen, SLOP, takesSwipe } from './swipe.ts';

test('only a clear sideways move is a swipe: a scroll up or down stays the page’s', () => {
  assert.equal(takesSwipe(-SLOP, 0, false), true, 'a short swipe left');
  assert.equal(takesSwipe(-(SLOP - 1), 0, false), false, 'under the slop: a tap');
  assert.equal(takesSwipe(-40, 25, false), false, 'more down than twice sideways: a scroll');
  assert.equal(takesSwipe(-40, 20, false), true, 'twice as far sideways as down');
  assert.equal(takesSwipe(0, -60, false), false, 'straight up: a scroll');
  assert.equal(takesSwipe(40, 0, false), false, 'closed, a swipe right does nothing');
  assert.equal(takesSwipe(40, 0, true), true, 'open, a swipe right closes it');
  assert.equal(takesSwipe(-40, 0, true), true, 'open, a swipe left too');
  assert.equal(takesSwipe(NaN, 0, false), false, 'no movement known');
});

test('the row follows the finger from where it was, never right of closed, slower past open', () => {
  assert.equal(dragOffset(-30, false), -30);
  assert.equal(dragOffset(30, false), 0, 'closed, dragged right: stays');
  assert.equal(dragOffset(-REVEAL, false), -REVEAL);
  assert.equal(dragOffset(-REVEAL - 30, false), -REVEAL - 10, 'past open: a third as far');
  assert.equal(dragOffset(40, true), -REVEAL + 40, 'open, dragged back');
  assert.equal(dragOffset(REVEAL + 50, true), 0, 'open, dragged right past closed');
});

test('lifted, the row opens past half the button or on a flick left, and closes on a flick right', () => {
  assert.equal(settlesOpen(-REVEAL / 2 - 1, 0), true);
  assert.equal(settlesOpen(-REVEAL / 2 + 1, 0), false);
  assert.equal(settlesOpen(-20, -0.8), true, 'a quick flick left opens it from little way');
  assert.equal(settlesOpen(-REVEAL, 0.8), false, 'a quick flick right closes it');
});

test('the menu key and Shift+F10 open the menu from the keyboard', () => {
  assert.equal(isMenuKey('ContextMenu', false), true);
  assert.equal(isMenuKey('F10', true), true);
  assert.equal(isMenuKey('F10', false), false);
  assert.equal(isMenuKey('Enter', true), false);
});

test('one row open at a time; a touch elsewhere closes it, a touch on it does not', () => {
  const rows = openRows();
  const closed = [];
  rows.opening('a', () => closed.push('a'));
  assert.equal(rows.openId, 'a');
  rows.opening('b', () => closed.push('b'));
  assert.deepEqual(closed, ['a'], 'opening b closes a');
  assert.equal(rows.openId, 'b');

  rows.touchedRow('b');
  rows.touchedPage();
  assert.deepEqual(closed, ['a'], 'a touch on the open row leaves it open');
  assert.equal(rows.openId, 'b');

  rows.touchedRow('c');
  rows.touchedPage();
  assert.deepEqual(closed, ['a', 'b'], 'a touch on another row closes it');
  assert.equal(rows.openId, null);

  rows.opening('a', () => closed.push('a again'));
  rows.touchedPage();
  assert.deepEqual(closed, ['a', 'b', 'a again'], 'a touch off every row closes it');

  rows.opening('d', () => closed.push('d'));
  rows.closed('d');
  rows.touchedPage();
  assert.equal(closed.at(-1), 'a again', 'a row closed by itself is not closed again');
});
