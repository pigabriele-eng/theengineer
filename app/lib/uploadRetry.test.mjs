// An upload sent again after a server restart cuts it off. Run with `npm test`.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CUT, withRetries } from './uploadRetry.ts';

const run = async (answers, waits = [1, 2, 3]) => {
  const heard = [];
  const slept = [];
  let i = 0;
  const send = async () => {
    const a = answers[i++];
    if (a instanceof Error) throw a;
    return { status: a };
  };
  try {
    const res = await withRetries(send, (r) => heard.push(r), waits, async (ms) => { slept.push(ms); });
    return { res, heard, slept, tries: i };
  } catch (e) {
    return { error: e.message, heard, slept, tries: i };
  }
};

test('cut off by a restart: sent again after each wait until the server answers', async () => {
  const got = await run([new Error(CUT), 502, 202]);
  assert.equal(got.res.status, 202);
  assert.equal(got.tries, 3);
  assert.deepEqual(got.slept, [1000, 2000]);
  assert.deepEqual(got.heard, [{ attempt: 2, of: 4, wait_s: 1 }, { attempt: 3, of: 4, wait_s: 2 }, null]);
});

test('an answer is handed back at once, even a refusal; other errors are not sent again', async () => {
  assert.deepEqual((await run([413])).res, { status: 413 });
  assert.equal((await run([413])).tries, 1);
  const other = await run([new Error('The upload took too long: try fewer files at a time.')]);
  assert.equal(other.tries, 1);
  assert.match(other.error, /too long/);
});

test('still cut off after every wait: the cut-off is said', async () => {
  const got = await run([new Error(CUT), new Error(CUT), new Error(CUT), new Error(CUT)]);
  assert.equal(got.tries, 4);
  assert.equal(got.error, CUT);
  assert.equal(got.heard.at(-1), null);
  assert.deepEqual((await run([503, 503, 503, 503])).res, { status: 503 });
});
