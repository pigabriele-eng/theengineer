// The manual's parts and its find. Run with `npm test`.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { test } from 'node:test';

import { findInManual, MANUAL } from './manual.ts';

const parts = [
  { key: 'a', title: 'Race weekends', dek: '', items: [
    { name: 'Delete a run', where: ['Weekend', 'Delete next to the run'], what: 'Removes the run and its logs.' },
    { name: 'Rename a run', where: ['Weekend', 'Rename next to the run'], what: 'Gives the run its session’s name.' },
  ] },
  { key: 'b', title: 'Debriefs', dek: '', items: [
    { name: 'Record a debrief', where: ['Debrief'], what: 'Records what the driver says after a run.' },
  ] },
];

test('no words: every part as it is', () => {
  assert.deepEqual(findInManual(parts, '  '), parts);
});

test('every word must be found, in any case, accents and order', () => {
  assert.deepEqual(findInManual(parts, 'RUN delete').map((p) => p.items.map((i) => i.name)), [['Delete a run']]);
  assert.deepEqual(findInManual(parts, 'session').map((p) => p.items.map((i) => i.name)), [['Rename a run']]);
  assert.deepEqual(findInManual(parts, 'débrief').map((p) => p.key), ['b']);
});

test('a part found by its own name keeps all its functions', () => {
  assert.deepEqual(findInManual(parts, 'debriefs').map((p) => p.items.length), [1]);
  assert.deepEqual(findInManual(parts, 'race weekends').map((p) => p.items.length), [2]);
});

test('a word is found at the start of a word, not inside one', () => {
  const tc = [{ key: 't', title: 'Tools', dek: '', items: [
    { name: 'Traction control', where: ['a report'], what: 'Where TC cut in.' },
    { name: 'Light or dark', where: ['Tools'], what: 'Switch how the app looks.' },
  ] }];
  assert.deepEqual(findInManual(tc, 'tc').map((p) => p.items.map((i) => i.name)), [['Traction control']]);
  assert.deepEqual(findInManual(tc, 'swi').map((p) => p.items.map((i) => i.name)), [['Light or dark']]);
});

test('nothing found: no parts', () => {
  assert.deepEqual(findInManual(parts, 'carburettor'), []);
});

test('the manual: unique keys and names, every function says where and what, every page it opens exists', () => {
  const keys = MANUAL.map((p) => p.key);
  assert.equal(new Set(keys).size, keys.length);
  const names = MANUAL.flatMap((p) => p.items.map((i) => i.name));
  assert.equal(new Set(names).size, names.length, 'two functions share a name');
  for (const p of MANUAL) {
    assert.ok(p.items.length > 0, `${p.title} has no functions`);
    for (const i of p.items) {
      assert.ok(i.where.length > 0 && i.what.trim().length > 0, i.name);
      assert.ok(!/\bT\d+\b.*\b(?:Hairpin|Chicane|Curve|Kurve)\b/i.test(i.what), `${i.name}: corners by number only`);
    }
  }
  // a page it opens is a route of the app: app/<path>.tsx, app/<path>/index.tsx or app/(tabs)/<path>.tsx
  const hrefs = MANUAL.flatMap((p) => [p.href, ...p.items.map((i) => i.href)]).filter(Boolean);
  for (const h of hrefs) {
    const path = h.split('?')[0].replace(/^\//, '') || 'index';
    const here = new URL('../app/', import.meta.url);
    const found = [`${path}.tsx`, `${path}/index.tsx`, `(tabs)/${path}.tsx`].some((f) => existsSync(new URL(f, here)));
    assert.ok(found, `${h} is not a page of the app`);
  }
});
