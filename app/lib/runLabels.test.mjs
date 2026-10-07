// The report's runs by their own names, never a number. Run with `npm test` (Node's own test runner).
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { runNamer } from './runLabels.ts';

const run = (id, name, short, fields = {}) => ({ id, name, short, day: null, date: null, time: null, driver: null, ...fields });

// a report kept from before run 12 (imported from the folder 01_PTS/1 as "1") was named from the timetable
const answer = {
  runs: [run(12, 'PT1 stint 1', 'PT1 S1'), run(13, 'Q1 · Gabriele Piana', 'Q1 PIA'), run(14, 'Race 1 stint 2', 'R1 S2')],
  sessions: [{ id: 14, name: 'Race 1 stint 2' }],
  report: {
    trends: {
      runs: [{ run: 'PTS 1', session_id: 12 }, { run: 'Q1 · Gabriele Piana', session_id: 13 }],
    },
  },
};

test('a run is called by its name now, found by its session', () => {
  const names = runNamer(answer);
  assert.equal(names.name('PTS 1'), 'PT1 stint 1');
  assert.equal(names.short('PTS 1'), 'PT1 S1');
  assert.equal(names.short('Q1 · Gabriele Piana', 13), 'Q1 PIA');
  assert.equal(names.short('Race 1 stint 2'), 'R1 S2'); // through the report's sessions
  assert.equal(names.lap('PTS 1#13'), 'PT1 stint 1 lap 13');
  assert.equal(names.byId(14)?.name, 'Race 1 stint 2');
});

test('a run the answer does not know keeps the name the report gives it', () => {
  const names = runNamer(null);
  assert.equal(names.name('07_D2S2'), '07_D2S2');
  assert.equal(names.lap('07_D2S2#13'), '07_D2S2 lap 13');
  assert.equal(names.byId(1), undefined);
});

test('no run is ever called by a number', () => {
  const names = runNamer(answer);
  for (const r of answer.report.trends.runs) assert.ok(!/^\d+$/.test(names.short(r.run, r.session_id)));
});
