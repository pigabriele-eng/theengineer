// The debrief report as plain text for sharing. Run with `npm test`.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { debriefText, shareLinks } from './debriefText.ts';

const SECTIONS = [['balance', 'Car balance'], ['corners', 'Corner by corner'], ['tyres', 'Tyres']];
const point = (id, section, text, extra = {}) =>
  ({ id, section, text, speaker: null, corner_code: null, phase: null, audio_start_s: null, ...extra });

test('header, summary, then each section with tagged points', () => {
  const d = {
    mode: 'individual',
    summary: 'Understeer in the slow corners.',
    speakers: null,
    points: [
      point(1, 'corners', 'Pushes wide', { corner_code: 'T3', phase: 'mid' }),
      point(2, 'balance', 'Car is stable on the brakes'),
      point(3, 'corners', 'Late on the throttle', { corner_code: 'T8/T9', phase: 'exit' }),
    ],
  };
  assert.equal(debriefText(d, SECTIONS, { event: 'Hockenheim GT4', run: 'Q1', date: '12 Oct 2026', driver: 'Max Piana' }), [
    'DEBRIEF REPORT',
    'Hockenheim GT4 · Q1',
    '12 Oct 2026 · Driver: Max Piana',
    '',
    'Understeer in the slow corners.',
    '',
    'CAR BALANCE',
    '- Car is stable on the brakes',
    '',
    'CORNER BY CORNER',
    '- [T3 mid-corner] Pushes wide',
    '- [T8/T9 exit] Late on the throttle',
  ].join('\n'));
});

test('speaker names only in group mode, missing header parts left out', () => {
  const d = {
    mode: 'group',
    summary: null,
    speakers: { S1: { role: 'driver', name: 'Rackl' }, S2: { role: 'engineer', name: null } },
    points: [
      point(1, 'tyres', 'Rears gone after 6 laps', { speaker: 'S1' }),
      point(2, 'tyres', 'Pressures were high', { speaker: 'S2', phase: 'braking' }),
    ],
  };
  assert.equal(debriefText(d, SECTIONS, { date: '1 Oct 2026' }), [
    'DEBRIEF REPORT',
    '1 Oct 2026',
    '',
    'TYRES',
    '- Rears gone after 6 laps (Rackl)',
    '- [braking] Pressures were high (engineer)',
  ].join('\n'));
  assert.ok(!debriefText({ ...d, mode: 'individual' }, SECTIONS).includes('(Rackl)'));
});

test('fallback links carry the text', () => {
  const l = shareLinks('a & b\nc', 'Debrief report');
  assert.equal(l.whatsapp, 'https://wa.me/?text=a%20%26%20b%0Ac');
  assert.equal(l.email, 'mailto:?subject=Debrief%20report&body=a%20%26%20b%0Ac');
});
