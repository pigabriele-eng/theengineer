// Polling that backs off, stops, and holds off while the page is hidden (lib/poll.ts). Run with `npm test`.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { nextWait, poll, POLL_TIMES, waits } from './poll.ts';

/** A clock that only moves when told to, and a page that is hidden or shown when told to. */
function world() {
  let now = 0;
  let timers = [];
  let seq = 0;
  const clock = {
    now: () => now,
    later: (run, ms) => {
      const t = { id: ++seq, at: now + ms, run };
      timers.push(t);
      return t.id;
    },
    cancel: (id) => {
      timers = timers.filter((t) => t.id !== id);
    },
  };
  let hidden = false;
  const backs = new Set();
  const page = {
    hidden: () => hidden,
    onBack: (back) => {
      backs.add(back);
      return () => backs.delete(back);
    },
  };
  const settle = () => new Promise((r) => setImmediate(r));
  return {
    clock,
    page,
    pending: () => timers.map((t) => t.at - now),
    listening: () => backs.size,
    /** Moves the clock on by ms, running every timer due on the way (and the asks they start). */
    async advance(ms) {
      const end = now + ms;
      for (;;) {
        await settle();
        timers.sort((a, b) => a.at - b.at);
        const t = timers[0];
        if (!t || t.at > end) break;
        timers.shift();
        now = t.at;
        t.run();
      }
      now = end;
      await settle();
    },
    hide() {
      hidden = true;
    },
    async show() {
      hidden = false;
      for (const b of [...backs]) b();
      await settle();
    },
  };
}

test('the waits start at 3.5 s, grow 1.5 times each, stop growing at 15 s, and end after 5 minutes', () => {
  assert.equal(nextWait(null), 3500);
  assert.equal(nextWait(3500), 5250);
  assert.equal(nextWait(12000), 15000);
  const w = waits();
  assert.deepEqual(w.slice(0, 5), [3500, 5250, 7875, 11813, 15000]);
  assert.ok(w.slice(4).every((x) => x === 15000));
  const total = w.reduce((a, b) => a + b, 0);
  assert.ok(total <= POLL_TIMES.stopAfterMs && total + 15000 > POLL_TIMES.stopAfterMs);
  // about 23 asks in 5 minutes, where one every 4 s made 75
  assert.ok(w.length + 1 < 25, `${w.length + 1} asks`);
});

test('asks at once, then after each wait while the answer is "still working", then stops for good', async () => {
  const w = world();
  const asked = [];
  let left = 3;
  poll(() => {
    asked.push(w.clock.now());
    return --left > 0;
  }, { clock: w.clock, page: w.page });
  await w.advance(60000);
  assert.deepEqual(asked, [0, 3500, 8750]);
  assert.deepEqual(w.pending(), []);
  assert.equal(w.listening(), 0); // no longer listening for the page coming back
});

test('stops asking after a few minutes, and starts again at once when the page is back', async () => {
  const w = world();
  const asked = [];
  poll(() => {
    asked.push(w.clock.now());
    return true;
  }, { clock: w.clock, page: w.page });
  await w.advance(20 * 60000);
  assert.equal(asked.length, waits().length + 1);
  assert.ok(asked.at(-1) <= POLL_TIMES.stopAfterMs);
  assert.deepEqual(w.pending(), []);
  const before = asked.length;
  await w.show(); // the window got the focus again
  assert.equal(asked.length, before + 1);
  assert.equal(asked.at(-1), 20 * 60000);
  await w.advance(3500); // the waits start over
  assert.equal(asked.length, before + 2);
});

test('onGiveUp is told when it stops asking after a few minutes, not when the answer comes or it is stopped', async () => {
  const w = world();
  let gaveUp = 0;
  poll(() => true, { clock: w.clock, page: w.page, onGiveUp: () => gaveUp++ });
  await w.advance(20 * 60000);
  assert.equal(gaveUp, 1);
  const done = world();
  let told = 0;
  poll(() => false, { clock: done.clock, page: done.page, onGiveUp: () => told++ });
  const stop = poll(() => true, { clock: done.clock, page: done.page, onGiveUp: () => told++ });
  await done.advance(1000);
  stop();
  await done.advance(20 * 60000);
  assert.equal(told, 0);
});

test("doesn't ask while the page is hidden; asks at once when it's shown again", async () => {
  const w = world();
  const asked = [];
  poll(() => {
    asked.push(w.clock.now());
    return true;
  }, { clock: w.clock, page: w.page });
  await w.advance(1000);
  w.hide();
  await w.advance(10 * 60000);
  assert.deepEqual(asked, [0]); // the wait ran out while hidden: nothing asked
  await w.show();
  assert.deepEqual(asked, [0, 10 * 60000 + 1000]);
  await w.advance(3500);
  assert.equal(asked.length, 3);
});

test('focus while it is still polling asks nothing extra', async () => {
  const w = world();
  let n = 0;
  poll(() => {
    n++;
    return true;
  }, { clock: w.clock, page: w.page });
  await w.advance(1000);
  await w.show();
  await w.show();
  assert.equal(n, 1);
});

test('stop() ends it: no more asks, a late answer is not wanted, the page is no longer watched', async () => {
  const w = world();
  let resolve;
  let lived = null;
  let n = 0;
  const stop = poll((live) => {
    n++;
    return new Promise((r) => {
      resolve = () => {
        lived = live();
        r(true);
      };
    });
  }, { clock: w.clock, page: w.page });
  await w.advance(10);
  stop();
  resolve();
  await w.advance(60000);
  assert.equal(lived, false);
  assert.equal(n, 1);
  assert.deepEqual(w.pending(), []);
  assert.equal(w.listening(), 0);
  await w.show();
  assert.equal(n, 1);
});

test('a failed ask counts as "ask again"; now: false waits before the first ask; times can be set', async () => {
  const w = world();
  const asked = [];
  poll(() => {
    asked.push(w.clock.now());
    if (asked.length < 3) throw new Error('server busy');
    return false;
  }, { clock: w.clock, page: w.page, now: false, firstMs: 1000, factor: 2, maxMs: 1500 });
  await w.advance(60000);
  assert.deepEqual(asked, [1000, 2500, 4000]); // 1 s, then 2 s capped at 1.5 s
});
