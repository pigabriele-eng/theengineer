// The country of a circuit, from its name, its venue key (lib/venues.ts) or an event's name ("Monza test"), and each
// country's flag as simple drawn geometry: square bands, with the Union Jack and the flags with an emblem simplified but
// recognisable. Never emoji flags (Windows shows them as two letters). components/Flag.tsx draws them with
// react-native-svg. Pure, so it is tested in lib/countries.test.mjs (npm test): no imports but types.
//
// The national colours here are data, like a track photo, not the app's theme: they stay the same in light and dark.

/** A shape of a flag drawn on a 30 × 20 board (every flag is drawn 3:2, as a timing screen shows them). */
export type FlagShape =
  | { rect: [number, number, number, number]; fill: string } // x, y, width, height
  | { poly: number[]; fill: string } // x1, y1, x2, y2, ...
  | { line: [number, number, number, number]; stroke: string; width: number }
  | { circle: [number, number, number]; fill?: string; stroke?: string; width?: number }; // cx, cy, r

export type Country = {
  iso: string; // ISO 3166-1 alpha-2: 'DE'
  code: string; // the three letters of a timing screen: 'GER', 'NED', 'POR' (not ISO's DEU, NLD, PRT)
  name: string;
  // the national colours in order (top to bottom for a flag in horizontal bands, hoist to fly for vertical ones),
  // with their shares: a stripe or a rule in the country's colours
  colors: string[];
  weights?: number[];
  shapes: FlagShape[]; // the flag on its 30 × 20 board, drawn in order
};

export const FLAG_W = 30;
export const FLAG_H = 20;

const BLACK = '#000000';
const WHITE = '#FFFFFF';

/** A flag of horizontal bands, top to bottom. */
function across(colors: string[], weights = colors.map(() => 1)): FlagShape[] {
  const total = weights.reduce((a, b) => a + b, 0);
  let y = 0;
  return colors.map((fill, i) => {
    const h = (weights[i] / total) * FLAG_H;
    const shape: FlagShape = { rect: [0, y, FLAG_W, h], fill };
    y += h;
    return shape;
  });
}

/** A flag of vertical bands, hoist to fly. */
function down(colors: string[], weights = colors.map(() => 1)): FlagShape[] {
  const total = weights.reduce((a, b) => a + b, 0);
  let x = 0;
  return colors.map((fill, i) => {
    const w = (weights[i] / total) * FLAG_W;
    const shape: FlagShape = { rect: [x, 0, w, FLAG_H], fill };
    x += w;
    return shape;
  });
}

const DE = { black: BLACK, red: '#DD0000', gold: '#FFCE00' };
const NL = { red: '#AE1C28', blue: '#21468B' };
const BE = { yellow: '#FDDA24', red: '#EF3340' };
const FR = { blue: '#0055A4', red: '#EF4135' };
const IT = { green: '#009246', red: '#CE2B37' };
const AT = { red: '#C8102E' };
const HU = { red: '#CD2A3E', green: '#436F4D' };
const ES = { red: '#AA151B', yellow: '#F1BF00' };
const PT = { green: '#046A38', red: '#DA291C', yellow: '#FFE900' };
const GB = { blue: '#012169', red: '#C8102E' };
const CZ = { blue: '#11457E', red: '#D7141A' };
const SK = { blue: '#0B4EA2', red: '#EE1C25' };
const SA = { green: '#006C35' };
const CH = { red: '#DA291C' };
const PL = { red: '#DC143C' };

export const COUNTRIES: Record<string, Country> = {
  DE: { iso: 'DE', code: 'GER', name: 'Germany', colors: [DE.black, DE.red, DE.gold],
    shapes: across([DE.black, DE.red, DE.gold]) },
  AT: { iso: 'AT', code: 'AUT', name: 'Austria', colors: [AT.red, WHITE, AT.red],
    shapes: across([AT.red, WHITE, AT.red]) },
  NL: { iso: 'NL', code: 'NED', name: 'Netherlands', colors: [NL.red, WHITE, NL.blue],
    shapes: across([NL.red, WHITE, NL.blue]) },
  BE: { iso: 'BE', code: 'BEL', name: 'Belgium', colors: [BLACK, BE.yellow, BE.red],
    shapes: down([BLACK, BE.yellow, BE.red]) },
  FR: { iso: 'FR', code: 'FRA', name: 'France', colors: [FR.blue, WHITE, FR.red],
    shapes: down([FR.blue, WHITE, FR.red]) },
  IT: { iso: 'IT', code: 'ITA', name: 'Italy', colors: [IT.green, WHITE, IT.red],
    shapes: down([IT.green, WHITE, IT.red]) },
  // red, yellow (twice as tall), red; the arms simplified to a shield under a crown between two pillars, a third in
  ES: { iso: 'ES', code: 'ESP', name: 'Spain', colors: [ES.red, ES.yellow, ES.red], weights: [1, 2, 1],
    shapes: [
      ...across([ES.red, ES.yellow, ES.red], [1, 2, 1]),
      { rect: [6.2, 7.2, 0.9, 6], fill: '#8C8C8C' }, // the pillars
      { rect: [12.1, 7.2, 0.9, 6], fill: '#8C8C8C' },
      { poly: [7.8, 7.4, 11.4, 7.4, 11.4, 11.6, 9.6, 13.4, 7.8, 11.6], fill: ES.red }, // the shield
      { rect: [8.6, 8.4, 2, 2.2], fill: ES.yellow }, // its castle, as a block
      { rect: [7.8, 5.8, 3.6, 1.2], fill: '#C8B100' }, // the crown
    ] },
  // green (two fifths), red; the armillary sphere on the line between them, the shield in it
  PT: { iso: 'PT', code: 'POR', name: 'Portugal', colors: [PT.green, PT.red], weights: [2, 3],
    shapes: [
      ...down([PT.green, PT.red], [2, 3]),
      { circle: [12, 10, 4.3], stroke: PT.yellow, width: 1.3 },
      { poly: [10.6, 8, 13.4, 8, 13.4, 11, 12, 12.4, 10.6, 11], fill: WHITE },
      { poly: [11.1, 8.5, 12.9, 8.5, 12.9, 10.8, 12, 11.7, 11.1, 10.8], fill: PT.red },
    ] },
  // the Union Jack, simplified: the red saltire on the white one without its offset
  GB: { iso: 'GB', code: 'GBR', name: 'Great Britain', colors: [GB.blue, WHITE, GB.red],
    shapes: [
      { rect: [0, 0, FLAG_W, FLAG_H], fill: GB.blue },
      { line: [-3, -2, 33, 22], stroke: WHITE, width: 4 },
      { line: [33, -2, -3, 22], stroke: WHITE, width: 4 },
      { line: [-3, -2, 33, 22], stroke: GB.red, width: 1.3 },
      { line: [33, -2, -3, 22], stroke: GB.red, width: 1.3 },
      { rect: [12, 0, 6, FLAG_H], fill: WHITE },
      { rect: [0, 6.6, FLAG_W, 6.8], fill: WHITE },
      { rect: [13.4, 0, 3.2, FLAG_H], fill: GB.red },
      { rect: [0, 8.2, FLAG_W, 3.6], fill: GB.red },
    ] },
  HU: { iso: 'HU', code: 'HUN', name: 'Hungary', colors: [HU.red, WHITE, HU.green],
    shapes: across([HU.red, WHITE, HU.green]) },
  // white over red, the blue wedge from the hoist to the middle
  CZ: { iso: 'CZ', code: 'CZE', name: 'Czechia', colors: [WHITE, CZ.blue, CZ.red],
    shapes: [...across([WHITE, CZ.red]), { poly: [0, 0, 15, 10, 0, 20], fill: CZ.blue }] },
  // white, blue, red; the arms simplified: a red shield edged white, the white double cross, the blue hills
  SK: { iso: 'SK', code: 'SVK', name: 'Slovakia', colors: [WHITE, SK.blue, SK.red],
    shapes: [
      ...across([WHITE, SK.blue, SK.red]),
      { poly: [5, 4.4, 13, 4.4, 13, 11.6, 9, 15.6, 5, 11.6], fill: WHITE },
      { poly: [5.7, 5.1, 12.3, 5.1, 12.3, 11.3, 9, 14.6, 5.7, 11.3], fill: SK.red },
      { rect: [8.55, 5.9, 0.9, 6.4], fill: WHITE },
      { rect: [7.4, 7, 3.2, 0.8], fill: WHITE },
      { rect: [6.8, 8.8, 4.4, 0.8], fill: WHITE },
      { poly: [5.9, 11.6, 7.4, 10.6, 9, 11.5, 10.6, 10.6, 12.1, 11.6, 9, 14.4], fill: SK.blue },
    ] },
  // green, the creed as a white line of script, the sword under it
  SA: { iso: 'SA', code: 'KSA', name: 'Saudi Arabia', colors: [SA.green, WHITE],
    shapes: [
      { rect: [0, 0, FLAG_W, FLAG_H], fill: SA.green },
      { rect: [7, 5.6, 16, 1.2], fill: WHITE },
      { rect: [8.5, 7.6, 13, 1.2], fill: WHITE },
      { rect: [7, 13, 15.5, 1], fill: WHITE },
      { rect: [21.4, 12, 0.9, 3], fill: WHITE },
    ] },
  CH: { iso: 'CH', code: 'SUI', name: 'Switzerland', colors: [CH.red, WHITE, CH.red],
    shapes: [
      { rect: [0, 0, FLAG_W, FLAG_H], fill: CH.red },
      { rect: [13.5, 4.5, 3, 11], fill: WHITE },
      { rect: [9.5, 8.5, 11, 3], fill: WHITE },
    ] },
  PL: { iso: 'PL', code: 'POL', name: 'Poland', colors: [WHITE, PL.red], shapes: across([WHITE, PL.red]) },
};

// Circuits by country, as words in a plain name (lower case, no accents, hyphens as spaces). Every circuit of GT4
// European Series, ADAC GT4 Germany and GT World Challenge Europe, the venue keys of lib/venues.ts, and the other
// circuits of Europe they have raced at. Words, not parts of words: "Spa" is not "Spain".
const CIRCUITS: [RegExp, string][] = [
  [/\bhockenheim|\bnurburgring|\bnordschleife\b|\bsachsenring\b|\blausitz|\boschersleben\b|\bnorisring\b|\bbilster berg\b/, 'DE'],
  [/\bred bull ring\b|\bspielberg\b|\bosterreichring\b|\ba1 ring\b|\bsalzburgring\b/, 'AT'],
  [/\bzandvoort\b|\bassen\b|\btt circuit\b/, 'NL'],
  [/\bspa\b|\bfrancorchamps\b|\bzolder\b|\bheusden\b/, 'BE'],
  [/\bpaul ricard\b|\bcastellet\b|\bmagny cours\b|\ble mans\b|\bbugatti\b|\bnogaro\b|\bdijon\b|\bledenon\b|\balbi\b/, 'FR'],
  [/\bmonza\b|\bmisano\b|\bimola\b|\benzo e dino ferrari\b|\bmugello\b|\bvallelunga\b/, 'IT'],
  [/\bbarcelona\b|\bcatalunya\b|\bmontmelo\b|\bvalencia\b|\bricardo tormo\b|\bcheste\b|\bjarama\b|\baragon\b|\bmotorland\b|\balcaniz\b|\bnavarra\b|\bjerez\b/, 'ES'],
  [/\bportimao\b|\balgarve\b|\bestoril\b/, 'PT'],
  [/\bsilverstone\b|\bbrands hatch\b|\bdonington\b|\bsnetterton\b|\boulton park\b|\bthruxton\b|\bknockhill\b/, 'GB'],
  [/\bhungaroring\b|\bmogyorod\b|\bbalaton park\b/, 'HU'],
  [/\bmost\b|\bbrno\b|\bmasaryk\b/, 'CZ'],
  [/\bslovakia ?ring\b|\borechova poton\b/, 'SK'],
  [/\bjeddah\b|\bcorniche\b/, 'SA'],
  [/\bposnan\b|\bpoznan\b/, 'PL'],
];

// A country's own name in a venue ("Circuit X, Germany"), after the circuits.
const NAMES: [RegExp, string][] = [
  [/\bgermany\b|\bdeutschland\b/, 'DE'],
  [/\baustria\b|\bosterreich\b/, 'AT'],
  [/\bnetherlands\b|\bholland\b|\bnederland\b/, 'NL'],
  [/\bbelgium\b|\bbelgique\b|\bbelgie\b/, 'BE'],
  [/\bfrance\b/, 'FR'],
  [/\bitaly\b|\bitalia\b/, 'IT'],
  [/\bspain\b|\bespana\b/, 'ES'],
  [/\bportugal\b/, 'PT'],
  [/\bgreat britain\b|\bunited kingdom\b|\bengland\b|\bscotland\b|\bwales\b|\buk\b/, 'GB'],
  [/\bhungary\b|\bmagyarorszag\b/, 'HU'],
  [/\bczechia\b|\bczech republic\b/, 'CZ'],
  [/\bslovakia\b/, 'SK'],
  [/\bsaudi arabia\b/, 'SA'],
  [/\bswitzerland\b|\bschweiz\b|\bsuisse\b/, 'CH'],
  [/\bpoland\b|\bpolska\b/, 'PL'],
];

/** Lower case, accents off, hyphens and underscores as spaces, spaces squeezed. */
function plainWords(text: string) {
  return text.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/** The country of a circuit, from its name or its venue key: 'Hockenheimring' -> Germany, 'red-bull-ring' -> Austria,
 * 'Circuit de Spa-Francorchamps' -> Belgium. Null when it isn't known. */
export function countryOf(name: string | null | undefined): Country | null {
  if (!name) return null;
  const low = plainWords(name);
  if (!low) return null;
  for (const [words, iso] of CIRCUITS) if (words.test(low)) return COUNTRIES[iso];
  for (const [words, iso] of NAMES) if (words.test(low)) return COUNTRIES[iso];
  return null;
}

/** The first country found among names, in order: an event's track, then its planned venue, then its own name. */
export function countryOfAny(names: (string | null | undefined)[]): Country | null {
  for (const n of names) {
    const c = countryOf(n);
    if (c) return c;
  }
  return null;
}
