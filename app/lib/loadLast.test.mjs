// A heavy read that waits for the page's other reads. Run with `npm test`.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { afterOthers, counted } from './loadLast.ts';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const later = (ms) => counted(sleep(ms));

test('waits until the other reads have answered, then a little more', async () => {
  const order = [];
  later(60).then(() => order.push('first read'));
  later(120).then(() => order.push('second read'));
  afterOthers(() => order.push('the heavy one'), 30);
  await sleep(250);
  assert.deepEqual(order, ['first read', 'second read', 'the heavy one']);
});

test('a read that starts while it waits is waited for too; stop calls nothing', async () => {
  const order = [];
  afterOthers(() => order.push('the heavy one'), 50);
  await sleep(20);
  later(80).then(() => order.push('a late read'));
  const stop = afterOthers(() => order.push('never'), 10);
  stop();
  await sleep(250);
  assert.deepEqual(order, ['a late read', 'the heavy one']);
});

test('does not wait for ever', async () => {
  const order = [];
  later(400);
  afterOthers(() => order.push('the heavy one'), 30, 100);
  await sleep(150);
  assert.deepEqual(order, ['the heavy one']);
  await sleep(300);
});
