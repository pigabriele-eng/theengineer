// One debrief at the end of FP1 about all its stints, split where the setup changed. Run with `npm test`.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { coversLine } from './debriefCovers.ts';

const run = (name, group = 0) => ({ name, group });

test('the stints a debrief covers, by setup', () => {
  assert.equal(coversLine({ runs: [run('FP1 stint 3')] }), 'Covers FP1 stint 3 only.');
  assert.equal(coversLine({ runs: [run('FP1 stint 1'), run('FP1 stint 2'), run('FP1 stint 3')] }),
    'Covers FP1 stint 1, FP1 stint 2 and FP1 stint 3, all on one setup.');
  assert.equal(coversLine({ runs: [run('FP1 stint 1'), run('FP1 stint 2'), run('FP1 stint 3', 1)] }),
    'Covers FP1 stint 1 and FP1 stint 2 on setup 1, FP1 stint 3 on setup 2.');
  assert.equal(coversLine({ runs: [run('FP1 stint 2', 2), run('FP1 stint 3', 5)] }),
    'Covers FP1 stint 2 on setup 1, FP1 stint 3 on setup 2.');
});
