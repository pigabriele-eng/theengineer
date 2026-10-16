// venueKey against the names the server's venue_key() is tested with, and the names the app's events carry.
// Run with `npm test` (Node's own test runner; Node 22.18 or later reads the .ts file directly).
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { knownVenue, trackName, venueKey } from './venues.ts';

test('circuit names map to one key per venue', () => {
  assert.equal(venueKey('Circuit Paul Ricard'), 'paul-ricard');
  assert.equal(venueKey('Le Castellet'), 'paul-ricard');
  assert.equal(venueKey('N&uuml;rburgring'), 'nurburgring');
  assert.equal(venueKey('Nürburgring Nordschleife'), 'nurburgring');
  assert.equal(venueKey('Hockenheim GP'), 'hockenheim');
  assert.equal(venueKey('Hockenheimring'), 'hockenheim');
  assert.equal(venueKey('Hockenheimring Baden-Württemberg'), 'hockenheim');
  assert.equal(venueKey('Circuit Zandvoort'), 'zandvoort');
  assert.equal(venueKey('Circuit de Spa-Francorchamps'), 'spa');
  assert.equal(venueKey('Autódromo Internacional do Algarve'), 'portimao');
  assert.equal(venueKey('Red Bull Ring'), 'red-bull-ring');
  assert.equal(venueKey('Circuit de Barcelona-Catalunya'), 'barcelona');
});

test('an unknown venue keeps its own name as the key', () => {
  assert.equal(venueKey('Zwartkops Raceway'), 'zwartkops-raceway');
  assert.equal(venueKey('  Most_Autodrom '), 'most-autodrom');
});

test('no name, no key', () => {
  assert.equal(venueKey(null), null);
  assert.equal(venueKey(''), null);
  assert.equal(venueKey('---'), null);
});

test('a short name is a word of its own: Spain is not Spa, as on the server', () => {
  assert.equal(venueKey('Circuit de Barcelona-Catalunya, Spain'), 'barcelona');
  assert.equal(knownVenue('Spain test'), null);
  assert.equal(knownVenue('03_SPA'), 'spa');
  assert.equal(knownVenue('Monza test'), 'monza');
  assert.equal(knownVenue('Salzburgring'), null);
});

test("a track's name on the list", () => {
  assert.equal(trackName('Hockenheimring Baden-Württemberg'), 'Hockenheim');
  assert.equal(trackName('Hockenheim GP'), 'Hockenheim');
  assert.equal(trackName('Circuit de Spa-Francorchamps'), 'Spa-Francorchamps');
  assert.equal(trackName('Autódromo Internacional do Algarve'), 'Portimão');
  assert.equal(trackName('  Salzburgring_GP '), 'Salzburgring GP');
});
