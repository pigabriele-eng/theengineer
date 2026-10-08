// Where the masthead's Back goes. Run with `npm test`.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { backFrom, backLabel, parentOf, step } from './backTo.ts';

const up = (path, event) => parentOf(path, event)?.path ?? null;

test('the race weekends are the top: no Back there', () => {
  assert.equal(parentOf('/'), null);
  assert.equal(parentOf(''), null);
  assert.equal(backFrom(['/event/3', '/'], '/', null, true), null);
});

test('an event goes up to the race weekends', () => {
  assert.equal(up('/event/3'), '/');
  assert.equal(up('/event/none'), '/'); // the runs in no event
});

test('a run goes up to its event, else the race weekends', () => {
  assert.deepEqual(parentOf('/session/12', { id: 3, name: 'Hockenheim test' }), { path: '/event/3', name: 'Hockenheim test' });
  assert.deepEqual(parentOf('/session/12', { id: 3 }), { path: '/event/3', name: 'the event' });
  assert.equal(up('/session/12'), '/');
  assert.equal(up('/session/12', null), '/');
  assert.equal(up('/session/12', { id: 'none' }), '/');
});

test("an event's reports and checks go up to the event they have, else the race weekends", () => {
  for (const p of ['/report', '/technique', '/quali', '/prep', '/prediction', '/debrief/4']) {
    assert.equal(up(p, { id: '7' }), '/event/7', p);
    assert.equal(up(p), '/', p);
  }
});

test('compare and the top-level pages go up to the race weekends, even with an event', () => {
  for (const p of ['/compare', '/drivers', '/coaching', '/setup', '/upload', '/debrief', '/tools']) {
    assert.equal(up(p, { id: 7 }), '/', p);
  }
  assert.equal(up('/drivers/'), '/');
});

test('a tool, the garage and seasons go up to Tools; a driver page to Drivers', () => {
  for (const p of ['/tools/pressures', '/tools/stint', '/tools/calendar', '/garage', '/seasons']) {
    assert.deepEqual(parentOf(p, { id: 7 }), { path: '/tools', name: 'Tools' }, p);
  }
  for (const p of ['/drivers/tag', '/drivers/compare', '/drivers/fingerprints', '/drivers/habits']) {
    assert.deepEqual(parentOf(p), { path: '/drivers', name: 'Drivers' }, p);
  }
});

test('the trail of visited pages: on top, the same again, one back', () => {
  let t = [];
  for (const p of ['/', '/event/3', '/session/12']) t = step(t, p);
  assert.deepEqual(t, ['/', '/event/3', '/session/12']);
  assert.equal(step(t, '/session/12'), t);
  t = step(t, '/event/3'); // a step back
  assert.deepEqual(t, ['/', '/event/3']);
  t = step(t, '/');
  assert.deepEqual(t, ['/']);
  assert.deepEqual(step(step([], '/drivers/'), '/drivers/tag'), ['/drivers', '/drivers/tag']);
  // another run of the event, picked on the run page, takes the run's place: Back still goes to the event
  assert.deepEqual(step(['/', '/event/3', '/session/12'], '/session/13'), ['/', '/event/3', '/session/13']);
  assert.deepEqual(step(['/', '/tools'], '/tools/pressures'), ['/', '/tools', '/tools/pressures']);
});

test("the masthead's Weekend, Upload, Debrief and Tools close what was opened over them, as the navigator does", () => {
  // Weekend -> Drivers -> Tools: one page back from Tools is the race weekends, not Drivers
  assert.deepEqual(step(['/', '/drivers'], '/tools'), ['/', '/tools']);
  assert.deepEqual(step(['/', '/event/3', '/session/12'], '/upload'), ['/', '/upload']);
  assert.deepEqual(step(['/session/12'], '/'), ['/']);
  // opened fresh on Tools: the race weekends are under it
  assert.deepEqual(step([], '/tools'), ['/', '/tools']);
  assert.deepEqual(step(['/', '/tools', '/tools/pressures'], '/tools'), ['/', '/tools']);
  assert.deepEqual(backFrom(step(['/', '/drivers'], '/tools'), '/tools', null, true),
    { to: 'history', place: { path: '/', name: 'the race weekends' } });
});

test('with pages visited, Back is one page back, named when it can be', () => {
  const event = { id: 3, name: 'Hockenheim test' };
  assert.deepEqual(backFrom(['/', '/event/3', '/session/12'], '/session/12', event, true),
    { to: 'history', place: { path: '/event/3', name: 'Hockenheim test' } });
  assert.deepEqual(backFrom(['/', '/event/3'], '/event/3', null, true),
    { to: 'history', place: { path: '/', name: 'the race weekends' } });
  assert.deepEqual(backFrom(['/', '/tools'], '/tools', null, true),
    { to: 'history', place: { path: '/', name: 'the race weekends' } });
  assert.deepEqual(backFrom(['/report', '/tools/stint'], '/tools/stint', null, true), { to: 'history', place: null });
});

test('a fresh load has no history: Back goes up, whatever the navigator keeps under it', () => {
  const event = { id: 3, name: 'Hockenheim test' };
  assert.deepEqual(backFrom(['/session/12'], '/session/12', event, true),
    { to: 'parent', place: { path: '/event/3', name: 'Hockenheim test' } });
  assert.deepEqual(backFrom([], '/session/12', { id: 3 }, true), { to: 'parent', place: { path: '/event/3', name: 'the event' } });
  // the trail says there was a page before, but the navigator can't go back to it
  assert.deepEqual(backFrom(['/', '/tools/pressures'], '/tools/pressures', null, false),
    { to: 'parent', place: { path: '/tools', name: 'Tools' } });
});

test("the screen reader's words", () => {
  assert.equal(backLabel({ path: '/event/3', name: 'Hockenheim test' }), 'Back to Hockenheim test');
  assert.equal(backLabel(null), 'Back');
});
