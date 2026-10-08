// A control's state for the phone and the web alike (lib/a11yState.ts). Run with `npm test`.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { a11yState } from './a11yState.ts';

test('the phone keeps accessibilityState as it was; the web gets the same in aria-* props', () => {
  assert.deepEqual(a11yState({ checked: true }), { accessibilityState: { checked: true }, 'aria-checked': true });
  assert.deepEqual(a11yState({ checked: false, disabled: true }),
    { accessibilityState: { checked: false, disabled: true }, 'aria-checked': false, 'aria-disabled': true });
  assert.deepEqual(a11yState({ checked: 'mixed' })['aria-checked'], 'mixed');
  assert.deepEqual(a11yState({ expanded: false }), { accessibilityState: { expanded: false }, 'aria-expanded': false });
  assert.deepEqual(a11yState({ disabled: true, busy: true }),
    { accessibilityState: { disabled: true, busy: true }, 'aria-disabled': true, 'aria-busy': true });
});

test('a false state is said too ("not ticked", "folded"); a missing one is left out', () => {
  assert.equal(a11yState({ expanded: false })['aria-expanded'], false);
  const p = a11yState({ selected: true, checked: undefined, disabled: undefined }, 'radio');
  assert.equal('aria-checked' in p, false);
  assert.equal('aria-disabled' in p, false);
  assert.deepEqual(p.accessibilityState, { selected: true, checked: undefined, disabled: undefined });
});

test('picked: a tab is selected, a button pressed, a link the page it is on, a radio checked', () => {
  assert.deepEqual(a11yState({ selected: true }, 'tab'), { accessibilityState: { selected: true }, 'aria-selected': true });
  assert.equal(a11yState({ selected: true })['aria-selected'], true); // no role: the matching attribute
  // a browser drops aria-selected on a button, a link and a radio
  assert.deepEqual(a11yState({ selected: false }, 'button'),
    { accessibilityState: { selected: false }, 'aria-pressed': false });
  assert.equal(a11yState({ selected: true }, 'button')['aria-selected'], undefined);
  assert.deepEqual(a11yState({ selected: true }, 'link'), { accessibilityState: { selected: true }, 'aria-current': 'page' });
  assert.equal(a11yState({ selected: false }, 'link')['aria-current'], false);
  assert.deepEqual(a11yState({ selected: true, checked: true }, 'radio'),
    { accessibilityState: { selected: true, checked: true }, 'aria-checked': true });
});
