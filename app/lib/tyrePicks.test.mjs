// Tyres for each stint after an upload (lib/tyrePicks.ts): which rows show, the app's guess against the driver's own
// pick, and what "Confirm all" sends. Run with `npm test`.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  afterConfirm, choiceSpeech, confirmAll, confirmedWords, guesses, isMine, picked, rowNote, rowOf, uploadRows,
  uploadRunIds,
} from './tyrePicks.ts';

// as GET /technique/events/{id}/tyres answers: Zandvoort, qualifying and both races, one practice run guessed
const run = (id, name, tyres, extra = {}) => ({
  id, name, short: name, day: null, date: '2026-09-19', time: '13:05', driver: 'Gabriele Piana', tyres, ...extra,
});
const guess = (level, why, sure = false) => ({
  tyres: level, label: level, pair: level === 'new' ? 'new' : 'used', sure, why, set_laps: null, set_by_driver: false,
});
const mine = (level, theirGuess) => ({ ...guess(level, 'set by you', true), guess: theirGuess, set_by_driver: true });
const event = [
  run(1, '03_Q', guess('new', 'qualifying: always a new set', true)),
  run(2, '03_Q (2)', guess('new', 'qualifying: always a new set', true), { driver: 'Max Rackl' }),
  run(3, 'FP1 stint 1', guess('used', 'no new set seen before it: how old the set is isn’t known')),
  run(4, '04_R1', mine('used', 'fresh')),
  run(5, '05_R2', null), // no laps: no tyres
  run(6, '05_R2 (2)', guess('fresh', 'race: on the qualifying set', true)),
];

test('the driver’s pick against the app’s guess', () => {
  assert.equal(isMine(event[3].tyres), true); // set by the driver: the server sends its guess beside it
  assert.equal(isMine(event[0].tyres), false); // qualifying, sure by rule: still the app's pick to confirm
  assert.equal(isMine(event[2].tyres), false);
  // the server's flag decides; a server older than it: the guess sent beside the pick, or its "set by you"
  assert.equal(isMine({ ...event[3].tyres, set_by_driver: false }), false);
  assert.equal(isMine({ ...event[0].tyres, set_by_driver: true }), true);
  const { set_by_driver: _a, ...older } = event[3].tyres;
  assert.equal(isMine(older), true);
  const { set_by_driver: _b, ...olderGuess } = event[2].tyres;
  assert.equal(isMine(olderGuess), false);
  assert.deepEqual(rowOf(event[3]), { id: 4, name: '04_R1', driver: 'Gabriele Piana', level: 'used', mine: true, why: '' });
  assert.equal(rowOf(event[4]), null);
});

test('which rows show: the upload’s runs, in the order they ran, each once', () => {
  const rows = uploadRows(event, [6, 1, 4, 99, 1]);
  assert.deepEqual(rows.map((r) => r.id), [1, 4, 6]); // the event's order, not the upload's; 99 isn't in the event
  assert.deepEqual(uploadRows(event, [5]), []); // a run without tyres gets no row
  assert.deepEqual(uploadRows(event, []), []);
  // a log uploaded again is skipped as already in the app: its run still gets its row
  const job = { session_ids: [6], skipped: [{ already: true, session_id: 1 }, { already: false }, { already: true, session_id: 6 }] };
  assert.deepEqual(uploadRunIds(job), [6, 1]);
  assert.deepEqual(uploadRunIds({ session_ids: [2] }), [2]);
});

test('a guess says so, with its why; the driver’s pick is confirmed', () => {
  const [q, r1, fp] = [rowOf(event[0]), rowOf(event[3]), rowOf(event[2])];
  assert.equal(rowNote(q), 'Guess · qualifying: always a new set');
  assert.equal(rowNote(r1), 'Confirmed');
  assert.equal(rowNote({ ...fp, why: '' }), 'Guess');
  assert.equal(choiceSpeech(q, 'PIA', 'new', 'New'), 'Tyres for 03_Q, PIA: New, a guess');
  assert.equal(choiceSpeech(q, 'PIA', 'used', 'Used'), 'Tyres for 03_Q, PIA: Used');
  assert.equal(choiceSpeech(r1, null, 'used', 'Used'), 'Tyres for 04_R1: Used, confirmed');
  assert.equal(choiceSpeech(picked(fp, 'worn'), 'PIA', 'worn', 'Very used'), 'Tyres for FP1 stint 1, PIA: Very used, confirmed');
});

test('what Confirm all sends: every guess shown, never over the driver’s pick', () => {
  const rows = uploadRows(event, [1, 2, 3, 4, 6]);
  assert.equal(guesses(rows), 4);
  assert.deepEqual(confirmAll(rows), [
    { id: 1, tyres: 'new' }, { id: 2, tyres: 'new' }, { id: 3, tyres: 'used' }, { id: 6, tyres: 'fresh' },
  ]);
  // a row tapped first was saved then: not sent again, and its tapped level is kept
  const tapped = rows.map((r) => (r.id === 3 ? picked(r, 'worn') : r));
  assert.deepEqual(confirmAll(tapped).map((p) => p.id), [1, 2, 6]);
  // the driver set run 2 on another screen since: read again just before, it is left alone
  const now = uploadRows([...event.slice(0, 1), run(2, '03_Q (2)', mine('fresh', 'new')), ...event.slice(2)], [1, 2, 3, 4, 6]);
  const sent = confirmAll(tapped, now);
  assert.deepEqual(sent.map((p) => p.id), [1, 6]);
  const after = afterConfirm(tapped, sent, now);
  assert.deepEqual(after.map((r) => [r.id, r.level, r.mine]),
    [[1, 'new', true], [2, 'fresh', true], [3, 'worn', true], [4, 'used', true], [6, 'fresh', true]]);
  assert.equal(guesses(after), 0);
  assert.deepEqual(confirmAll(after), []); // all confirmed: nothing more to send
  // a save that failed stays a guess
  assert.deepEqual(afterConfirm(rows, [{ id: 1, tyres: 'new' }]).filter((r) => !r.mine).map((r) => r.id), [2, 3, 6]);
});

test('the line after Confirm all', () => {
  assert.equal(confirmedWords(4, 0), 'Saved the tyres of 4 stints.');
  assert.equal(confirmedWords(1, 0), 'Saved the tyres of 1 stint.');
  assert.equal(confirmedWords(0, 0), 'Every stint’s tyres were already confirmed.');
  assert.equal(confirmedWords(3, 1), 'Couldn’t save 1 stint: try again.');
});
