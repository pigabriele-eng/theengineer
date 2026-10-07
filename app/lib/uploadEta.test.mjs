// The time left of an upload (lib/uploadEta.ts). Run with `npm test` (Node's own test runner).
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  etaLines, FALLBACK_RATES, leftWords, SendSpeed, serverSeconds, Smoother, UploadEta, whileReceiving, whileSending,
} from './uploadEta.ts';

const MB = 1e6;
const rates = {
  receive_s_per_mb: 0.01, unpack_s: 0.5, zip_expansion: 10, check_s_per_mb: 0.02, log_s: 1, log_s_per_mb: 0.1,
  mean_log_mb: 20, finish_s: 1, measured: 50,
};

test('the server part is the same sum as the server makes (import_rates.before)', () => {
  // a 90 MB zip: 900 MB of logs, 45 logs of 20 MB
  const s = serverSeconds(rates, 90 * MB, 90 * MB);
  assert.ok(Math.abs(s - (0.5 + 900 * 0.02 + 45 * 1 + 900 * 0.1 + 1)) < 1e-9);
  // loose logs are as large as they are sent; at least one log
  assert.ok(Math.abs(serverSeconds(rates, 5 * MB, 0) - (0.5 + 5 * 0.02 + 1 + 0.5 + 1)) < 1e-9);
  // the guesses before the server has imported anything give a figure too
  assert.ok(serverSeconds(FALLBACK_RATES, 90 * MB, 90 * MB) > 0);
});

test('while sending: the bytes left at the speed, then the server; no figure before there is a speed', () => {
  const e = whileSending(rates, { loaded: 30 * MB, total: 90 * MB, zipBytes: 90 * MB, bytesPerS: 1.25 * MB });
  assert.equal(e.stage, 'sending');
  assert.ok(Math.abs(e.stage_s - 48) < 1e-9);
  assert.ok(Math.abs(e.total_s - (48 + 0.9 + serverSeconds(rates, 90 * MB, 90 * MB))) < 1e-9);
  assert.deepEqual(whileSending(rates, { loaded: 0, total: 90 * MB, zipBytes: 0, bytesPerS: null }),
    { stage: 'sending', stage_s: null, total_s: null });
  const r = whileReceiving(rates, { total: 90 * MB, zipBytes: 90 * MB, sinceSentS: 0.4 });
  assert.equal(r.stage, 'receiving');
  assert.ok(Math.abs(r.stage_s - 0.5) < 1e-9);
});

test('the speed is smoothed over several seconds, not the speed of the last moment', () => {
  const s = new SendSpeed();
  let loaded = 0;
  let t = 0;
  for (; t <= 20000; t += 100) {
    s.add(loaded, t);
    loaded += 0.125 * MB; // 1.25 MB/s
  }
  assert.ok(Math.abs(s.bytesPerS - 1.25 * MB) < 0.01 * MB, String(s.bytesPerS));
  // the line halves its speed: a second later the figure has barely moved, after half a minute it is there
  const until = (end) => {
    for (; t <= end; t += 100) {
      s.add(loaded, t);
      loaded += 0.0625 * MB;
    }
  };
  until(21000);
  assert.ok(s.bytesPerS > 1.1 * MB, String(s.bytesPerS));
  until(50000);
  assert.ok(Math.abs(s.bytesPerS - 0.625 * MB) < 0.05 * MB, String(s.bytesPerS));
});

test('a stalled upload slows the speed down when it is asked again with nothing moved', () => {
  const s = new SendSpeed();
  for (let t = 0; t <= 10000; t += 500) s.add(t * 1000, t); // 1 MB/s
  const before = s.bytesPerS;
  for (let t = 10500; t <= 20000; t += 500) s.add(10000 * 1000, t);
  assert.ok(s.bytesPerS < before * 0.4, `${s.bytesPerS} vs ${before}`);
});

test('the number shown counts down, follows a lower estimate, and rises only on a clearly higher one that holds', () => {
  const m = new Smoother();
  assert.equal(m.update(null, 0), null);
  assert.equal(m.update(100, 0), 100);
  assert.equal(m.update(null, 5000), 95); // no estimate: the clock counts it down
  assert.equal(m.update(80, 6000), 80); // lower: at once
  assert.equal(m.update(85, 7000), 80); // a little higher than 79: held still, not up
  assert.equal(m.update(84, 8000), 80);
  // a spike of one estimate is not shown
  assert.equal(m.update(200, 9000), 80);
  assert.equal(m.update(79, 10000), 79);
  // clearly higher: held while it holds, and shown once it has for a few seconds
  assert.equal(m.update(150, 11000), 79);
  assert.equal(m.update(150, 12000), 79);
  assert.equal(m.update(150, 13000), 79);
  assert.equal(m.update(150, 14000), 150);
});

test('the time in words: to 5 s under a minute, whole minutes above, and almost done at the end', () => {
  assert.equal(leftWords(null), null);
  assert.equal(leftWords(3), 'almost done');
  assert.equal(leftWords(10), 'almost done');
  assert.equal(leftWords(11), 'about 10 s left');
  assert.equal(leftWords(42), 'about 40 s left');
  assert.equal(leftWords(43), 'about 45 s left');
  assert.equal(leftWords(58), 'about 1 min left');
  assert.equal(leftWords(89), 'about 1 min left');
  assert.equal(leftWords(95), 'about 2 min left');
  assert.equal(leftWords(3600), 'about 1 h left');
  assert.equal(leftWords(7100), 'about 2 h left');
  assert.equal(leftWords(5000), 'about 1 h 25 min left');
});

test('the two lines: the whole upload and the stage it is at', () => {
  assert.deepEqual(etaLines('sending', 42, 130), { total: 'About 2 min left', stage: 'Sending: about 40 s left' });
  assert.deepEqual(etaLines('receiving', 2, 70), { total: 'About 1 min left', stage: 'Taking it in: almost done' });
  assert.deepEqual(etaLines('sending', null, null), { total: 'Working out the time left', stage: 'Sending' });
  assert.deepEqual(etaLines('logs', 50, 50), { total: 'About 50 s left', stage: 'Reading the logs, the last step' });
});

test('a whole upload: sending at a wobbly speed, taken in, then the server; the figure never jumps about', () => {
  const eta = new UploadEta(rates);
  const total = 90 * MB;
  const shown = [];
  let loaded = 0;
  let t = 0;
  // 1.25 MB/s on average, each second 25 % faster or slower than that
  while (loaded < total) {
    for (let k = 0; k < 10 && loaded < total; k++) {
      t += 100;
      loaded = Math.min(total, loaded + (Math.floor(t / 1000) % 2 ? 0.15625 : 0.09375) * MB);
      eta.sent(loaded, total, total, t);
    }
    const e = eta.at(t);
    shown.push({ t, ...e });
  }
  const sentAt = t; // 72 s
  assert.ok(Math.abs(sentAt - 72000) < 200, String(sentAt));
  // half way, the stage figure is close to the time the rest really took
  const half = shown.find((s) => s.t >= 36000);
  assert.equal(half.stage, 'sending');
  assert.ok(Math.abs(half.stage_s - (sentAt - half.t) / 1000) < 6, JSON.stringify(half));
  // the whole: the sending left plus the server's part
  assert.ok(Math.abs(half.total_s - (half.stage_s + 0.9 + serverSeconds(rates, total, total))) < 8, JSON.stringify(half));
  // taken in, then the import job's own figures
  t += 500;
  assert.equal(eta.at(t).stage, 'receiving');
  t += 500;
  eta.job({ stage: 'logs', stage_s: 150, total_s: 150 }, t);
  for (let k = 0; k < 10; k++) {
    t += 1000;
    shown.push({ t, ...eta.at(t) });
  }
  const last = shown.at(-1);
  assert.equal(last.stage, 'logs');
  assert.ok(Math.abs(last.total_s - 140) < 1, JSON.stringify(last));
  // never up once the speed had settled (the server's figure was lower than the guess from the size)
  const settled = shown.filter((s) => s.t > 10000 && s.total_s != null);
  for (let i = 1; i < settled.length; i++) {
    assert.ok(settled[i].total_s <= settled[i - 1].total_s + 1e-9, JSON.stringify([settled[i - 1], settled[i]]));
  }
});
