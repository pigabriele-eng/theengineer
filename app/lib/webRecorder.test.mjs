// Recording a debrief in the browser: stops that never hang, parts, throwing away. Run with `npm test`.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { extFor, pickMime, silentWav, WebRecorder } from './webRecorder.ts';

/** A stand-in for the browser's MediaRecorder. `silent`: stop() never answers (as iPhone Safari did). */
function fake({ silent = false } = {}) {
  const on = {};
  const fire = (type, e = {}) => (on[type] ?? []).forEach((fn) => fn(e));
  const mr = {
    state: 'inactive',
    mimeType: 'audio/mp4',
    start() { this.state = 'recording'; },
    pause() { this.state = 'paused'; },
    resume() { this.state = 'recording'; },
    stop() {
      if (silent) return;
      this.state = 'inactive';
      fire('dataavailable', { data: new Blob(['end'], { type: 'audio/mp4' }) });
      fire('stop');
    },
    addEventListener(type, fn) { (on[type] ??= []).push(fn); },
    piece(text) { fire('dataavailable', { data: new Blob([text], { type: 'audio/mp4' }) }); },
    die() { this.state = 'inactive'; fire('stop'); },
  };
  return mr;
}

const clock = () => {
  let t = 0;
  return { now: () => t, go: (ms) => { t += ms; } };
};

test('stop and send gives the sound recorded', async () => {
  const mr = fake();
  let released = 0;
  const r = new WebRecorder(mr, () => released++);
  r.start();
  mr.piece('one ');
  const blob = await r.finish();
  assert.equal(await blob.text(), 'one end');
  assert.equal(blob.type, 'audio/mp4');
  assert.equal(released, 1);
});

test('a stop the browser never answers still finishes, with what came in every second', async () => {
  const mr = fake({ silent: true });
  const r = new WebRecorder(mr);
  r.start();
  mr.piece('a');
  mr.piece('b');
  const t0 = Date.now();
  const blob = await r.finish(50);
  assert.ok(Date.now() - t0 < 1000);
  assert.equal(await blob.text(), 'ab');
});

test('paused parts make one recording, the pauses left out of its length', async () => {
  const c = clock();
  const mr = fake();
  const r = new WebRecorder(mr, () => {}, c.now);
  r.start();
  c.go(20_000);
  r.pause();
  assert.equal(r.state, 'paused');
  c.go(60_000);
  assert.equal(r.ms, 20_000);
  assert.ok(r.resume());
  c.go(5_000);
  assert.equal(r.state, 'recording');
  assert.equal(r.ms, 25_000);
});

test('throwing it away keeps nothing; the browser ending it by itself is told', async () => {
  const mr = fake();
  const r = new WebRecorder(mr);
  r.start();
  mr.piece('x');
  r.discard();
  assert.equal((await r.finish(10)).size, 0);

  const mr2 = fake();
  const r2 = new WebRecorder(mr2);
  let told = 0;
  r2.onEnded = () => told++;
  r2.start();
  mr2.piece('kept');
  mr2.die();
  assert.equal(told, 1);
  assert.equal(r2.state, 'ended');
  assert.equal(r2.resume(), false);
  assert.equal(await (await r2.finish(10)).text(), 'kept');
});

test('format and file ending', () => {
  assert.equal(pickMime((t) => t === 'audio/mp4'), 'audio/mp4');
  assert.equal(pickMime((t) => t.startsWith('audio/webm')), 'audio/webm;codecs=opus');
  assert.equal(pickMime(() => { throw new Error('no'); }), undefined);
  assert.equal(extFor('audio/mp4'), '.m4a');
  assert.equal(extFor('audio/webm;codecs=opus'), '.webm');
  assert.equal(extFor(''), '.webm');
  const wav = silentWav(1, 8000);
  assert.equal(wav.length, 44 + 16000);
  assert.equal(new TextDecoder().decode(wav.slice(0, 4)), 'RIFF');
});
