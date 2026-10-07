// countryOf against the names circuits go by on results sites, loggers and the app's events, and the flags' geometry.
// Run with `npm test` (Node's own test runner; Node 22.18 or later reads the .ts file directly).
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { COUNTRIES, countryOf, countryOfAny, FLAG_H, FLAG_W } from './countries.ts';

const code = (name) => countryOf(name)?.code ?? null;

test('every circuit of GT4 European Series, ADAC GT4 Germany and GT World Challenge Europe has its country', () => {
  const cases = {
    GER: ['Hockenheimring', 'Hockenheimring Baden-Württemberg', 'Hockenheim GP', 'Nürburgring',
      'Nürburgring Nordschleife', 'Nurburgring', 'Sachsenring', 'Lausitzring', 'DEKRA Lausitzring',
      'Motorsport Arena Oschersleben', 'Norisring'],
    AUT: ['Red Bull Ring', 'Spielberg', 'Salzburgring'],
    NED: ['Circuit Zandvoort', 'CM.com Circuit Zandvoort', 'TT Circuit Assen'],
    BEL: ['Circuit de Spa-Francorchamps', 'Spa', 'Circuit Zolder'],
    FRA: ['Circuit Paul Ricard', 'Le Castellet', 'Circuit de Nevers Magny-Cours', 'Magny Cours', 'Le Mans'],
    ITA: ['Autodromo Nazionale Monza', 'Misano World Circuit Marco Simoncelli', 'Autodromo Enzo e Dino Ferrari',
      'Imola', 'Mugello Circuit', 'Vallelunga'],
    ESP: ['Circuit de Barcelona-Catalunya', 'Circuit Ricardo Tormo', 'Valencia', 'Circuito del Jarama',
      'MotorLand Aragón', 'Circuito de Navarra'],
    POR: ['Autódromo Internacional do Algarve', 'Portimão', 'Estoril'],
    GBR: ['Silverstone Circuit', 'Brands Hatch', 'Donington Park'],
    HUN: ['Hungaroring'],
    CZE: ['Autodrom Most', 'Automotodrom Brno', 'Masaryk Circuit'],
    SVK: ['Slovakia Ring', 'Slovakiaring'],
    KSA: ['Jeddah Corniche Circuit'],
  };
  for (const [want, names] of Object.entries(cases)) {
    for (const n of names) assert.equal(code(n), want, n);
  }
});

test('the venue keys of lib/venues.ts have their country', () => {
  const keys = {
    'paul-ricard': 'FRA', spa: 'BEL', nurburgring: 'GER', hockenheim: 'GER', zandvoort: 'NED', monza: 'ITA',
    misano: 'ITA', barcelona: 'ESP', jeddah: 'KSA', portimao: 'POR', imola: 'ITA', 'red-bull-ring': 'AUT',
    valencia: 'ESP', 'brands-hatch': 'GBR', silverstone: 'GBR', 'magny-cours': 'FRA', lausitzring: 'GER',
    sachsenring: 'GER', oschersleben: 'GER', norisring: 'GER',
  };
  for (const [key, want] of Object.entries(keys)) assert.equal(code(key), want, key);
});

test('words, not parts of words', () => {
  assert.equal(code('Circuit Ricardo Tormo, Valencia, Spain'), 'ESP'); // "Spain" is not Spa
  assert.equal(code('Espace test day'), null);
  assert.equal(code('Almost done'), null); // not Most
  assert.equal(code('Massenrich'), null);
});

test("an event's name or a country's name will do", () => {
  assert.equal(code('Monza test'), 'ITA');
  assert.equal(code('Zandvoort · GT4 European Series 2026'), 'NED');
  assert.equal(code('Some Raceway, Germany'), 'GER');
  assert.equal(countryOfAny([null, 'Circuit Paul Ricard', 'Monza test'])?.code, 'FRA');
  assert.equal(countryOfAny([null, undefined, 'Spa weekend'])?.code, 'BEL');
});

test('unknown or no name, no country', () => {
  assert.equal(code('02_ADACGT4_T01_HOC'), null);
  assert.equal(code('Zwartkops Raceway'), null);
  assert.equal(code(null), null);
  assert.equal(code(''), null);
  assert.equal(countryOfAny([]), null);
});

test('every flag is drawn on its board, with its colours and a timing-screen code', () => {
  for (const [iso, c] of Object.entries(COUNTRIES)) {
    assert.equal(c.iso, iso);
    assert.match(c.code, /^[A-Z]{3}$/);
    assert.ok(c.colors.length >= 2, iso);
    if (c.weights) assert.equal(c.weights.length, c.colors.length, iso);
    for (const col of c.colors) assert.match(col, /^#[0-9A-F]{6}$/, iso);
    assert.ok(c.shapes.length > 0, iso);
    // its blocks stay on the board
    for (const s of c.shapes) {
      if ('rect' in s) {
        const [x, y, w, h] = s.rect;
        assert.ok(x >= 0 && y >= 0 && x + w <= FLAG_W + 1e-9 && y + h <= FLAG_H + 1e-9, `${iso} rect in the board`);
      }
      if ('poly' in s) assert.equal(s.poly.length % 2, 0, `${iso} poly in pairs`);
    }
  }
  const codes = Object.values(COUNTRIES).map((c) => c.code);
  assert.equal(new Set(codes).size, codes.length);
});
