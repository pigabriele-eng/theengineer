// Live speech to text: the language asked of the browser and the phrases stamped in seconds. Run with `npm test`.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { hear, heardNothing, restarted, speechLang, speechSupported, startLiveSpeech } from './liveSpeech.ts';

test('the debrief language picks the recogniser language', () => {
  assert.equal(speechLang('en'), 'en-GB');
  assert.equal(speechLang('it'), 'it-IT');
  assert.equal(speechLang('de'), 'de-DE');
  assert.equal(speechLang('multi', 'fr-FR'), 'fr-FR');
  assert.equal(speechLang('multi'), 'en-GB');
});

test('a phrase runs from its first words to its final', () => {
  let out = hear(heardNothing(), [{ final: false, text: 'entry under' }], 2.5);
  assert.equal(out.interim, 'entry under');
  out = hear(out.heard, [{ final: false, text: 'entry understeer' }], 3.4);
  assert.equal(out.heard.phraseStart, 2.5);
  out = hear(out.heard, [{ final: true, text: ' entry understeer in T1 ' }], 4.1);
  assert.deepEqual(out.heard.finals, [{ start: 2.5, end: 4.1, text: 'entry understeer in T1' }]);
  assert.equal(out.interim, '');
  assert.equal(out.heard.done, 1);
});

test('a final with no interim before it starts where the last one ended', () => {
  let out = hear(heardNothing(), [{ final: true, text: 'one' }], 2);
  out = hear(out.heard, [{ final: true, text: 'one' }, { final: true, text: 'two' }, { final: false, text: 'thr' }], 5);
  assert.deepEqual(out.heard.finals, [{ start: 0, end: 2, text: 'one' }, { start: 2, end: 5, text: 'two' }]);
  assert.equal(out.interim, 'thr');
  assert.equal(out.heard.phraseStart, 5);
});

test('after a restart the list starts over and the phrases are kept', () => {
  let out = hear(heardNothing(), [{ final: true, text: 'one' }, { final: false, text: 'cut' }], 3);
  const h = restarted(out.heard);
  assert.equal(h.done, 0);
  assert.equal(h.phraseStart, null);
  out = hear(h, [{ final: true, text: 'two' }], 70);
  assert.deepEqual(out.heard.finals.map((s) => s.text), ['one', 'two']);
  assert.equal(out.heard.finals[1].start, 3);
});

test('empty finals are skipped', () => {
  const out = hear(heardNothing(), [{ final: true, text: '  ' }], 1);
  assert.deepEqual(out.heard.finals, []);
  assert.equal(out.heard.done, 1);
});

test('without a browser recogniser nothing is heard and nothing throws', () => {
  assert.equal(speechSupported(), false);
  assert.deepEqual(startLiveSpeech('en-GB', Date.now(), () => {}).stop(), []);
});

test('with a recogniser: restarts after it ends, stamps finals, stops quietly', () => {
  const made = [];
  class Fake {
    constructor() { this.starts = 0; made.push(this); }
    start() { this.starts++; }
    stop() { this.stopped = true; }
  }
  globalThis.window = { webkitSpeechRecognition: Fake };
  try {
    assert.equal(speechSupported(), true);
    const seen = [];
    const live = startLiveSpeech('it-IT', Date.now() - 2000, (f, i) => seen.push([f.length, i]));
    const r = made[0];
    assert.equal(r.lang, 'it-IT');
    assert.equal(r.continuous, true);
    assert.equal(r.interimResults, true);
    const res = (final, t) => Object.assign([{ transcript: t }], { isFinal: final });
    r.onresult({ results: [res(false, 'curva')] });
    r.onresult({ results: [res(true, 'curva uno')] });
    r.onerror({ error: 'no-speech' });
    r.onend();
    assert.equal(r.starts, 2);
    const finals = live.stop();
    assert.equal(finals.length, 1);
    assert.equal(finals[0].text, 'curva uno');
    assert.ok(finals[0].end >= 2);
    r.onend();
    assert.equal(r.starts, 2);
    assert.deepEqual(seen.map((s) => s[1]), ['curva', '']);
  } finally {
    delete globalThis.window;
  }
});
