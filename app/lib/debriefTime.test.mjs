// When a debrief was recorded, and how it is shown. Run with `npm test`.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { fileRecordedAt, linkedLine, localTime, recordedLabel } from './debriefTime.ts';

test('local time on the device, no zone', () => {
  assert.equal(localTime(new Date(2026, 9, 9, 14, 32, 5)), '2026-10-09T14:32:05');
  assert.equal(localTime(new Date(2026, 0, 2, 3, 4, 5)), '2026-01-02T03:04:05');
});

test('a picked file: its last change, else now', () => {
  const at = new Date(2026, 9, 9, 14, 40, 0);
  assert.equal(fileRecordedAt(at.getTime()), '2026-10-09T14:40:00');
  assert.equal(fileRecordedAt(undefined, at), '2026-10-09T14:40:00');
});

test('shown as written, with the weekday', () => {
  assert.equal(recordedLabel('2026-10-09T14:32:05'), 'Fri 9 Oct, 14:32');
  assert.equal(recordedLabel('not a time'), 'not a time');
});

test('why a debrief went with its run', () => {
  assert.equal(linkedLine('FP2', 6), 'Recorded 6 min after FP2 ended, so it went with that run.');
  assert.equal(linkedLine('FP2', 0), 'Recorded as FP2 ended, so it went with that run.');
  assert.equal(linkedLine('FP2', undefined), 'Recorded after FP2, so it went with that run.');
});
