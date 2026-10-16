// One key per circuit, whatever a results site, a logger or a user calls it: the app's copy of venue_key() in
// server/app/results/venues.py (keep the two lists the same). The track photos (constants/trackPhotos.ts) are keyed by
// it. Tested in lib/venues.test.mjs (npm test).

const ALIASES: Record<string, string[]> = {
  'paul-ricard': ['paul ricard', 'le castellet', 'castellet'],
  spa: ['spa', 'francorchamps'],
  nurburgring: ['nurburgring'],
  hockenheim: ['hockenheim'],
  zandvoort: ['zandvoort'],
  monza: ['monza'],
  misano: ['misano'],
  barcelona: ['barcelona', 'catalunya', 'montmelo'],
  jeddah: ['jeddah', 'corniche'],
  portimao: ['portimao', 'algarve'],
  imola: ['imola'],
  'red-bull-ring': ['red bull ring', 'spielberg'],
  valencia: ['valencia', 'ricardo tormo'],
  'brands-hatch': ['brands hatch'],
  silverstone: ['silverstone'],
  'magny-cours': ['magny cours', 'magny-cours'],
  lausitzring: ['lausitz'],
  sachsenring: ['sachsenring'],
  oschersleben: ['oschersleben'],
  norisring: ['norisring'],
};

// the HTML entities results sites use in circuit names
const ENTITIES: Record<string, string> = {
  amp: '&', apos: "'", quot: '"', nbsp: ' ', uuml: 'ü', ouml: 'ö', auml: 'ä', Uuml: 'Ü', Ouml: 'Ö', Auml: 'Ä',
  eacute: 'é', egrave: 'è', aacute: 'á', agrave: 'à', iacute: 'í', oacute: 'ó', uacute: 'ú', atilde: 'ã',
  otilde: 'õ', ccedil: 'ç', ntilde: 'ñ', szlig: 'ß',
};
const unescape = (s: string) => s
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
  .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
  .replace(/&([a-z]+);/gi, (m, name) => ENTITIES[name] ?? m);

/** Lower case, accents off, spaces squeezed. */
export function plain(text: string | null | undefined) {
  return unescape(text ?? '').normalize('NFKD').replace(/\p{M}/gu, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

/** A word of the name, or the start of one for a long word ("Hockenheimring"): "spa" is not in "Spain". */
const says = (low: string, word: string) =>
  new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}${word.length >= 6 ? '' : '\\b'}`).test(low);

/** The key of a circuit the list knows by name, else null: 'Hockenheim GP' -> 'hockenheim', 'Monza test' -> 'monza',
 * 'Spain test' -> null. */
export function knownVenue(name: string | null | undefined): string | null {
  if (!name) return null;
  const low = plain(name).replace(/_/g, ' ');
  for (const [key, words] of Object.entries(ALIASES)) {
    if (words.some((w) => says(low, w))) return key;
  }
  return null;
}

/** 'Circuit Paul Ricard' -> 'paul-ricard', 'N&uuml;rburgring' -> 'nurburgring', 'Hockenheim GP' -> 'hockenheim'. */
export function venueKey(name: string | null | undefined): string | null {
  if (!name) return null;
  return knownVenue(name) ?? (plain(name).replace(/_/g, ' ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || null);
}

// what the track list calls a circuit it knows (the app's own: the server has no need of it)
const NAMES: Record<string, string> = {
  'paul-ricard': 'Paul Ricard', spa: 'Spa-Francorchamps', nurburgring: 'Nürburgring', hockenheim: 'Hockenheim',
  zandvoort: 'Zandvoort', monza: 'Monza', misano: 'Misano', barcelona: 'Barcelona', jeddah: 'Jeddah',
  portimao: 'Portimão', imola: 'Imola', 'red-bull-ring': 'Red Bull Ring', valencia: 'Valencia',
  'brands-hatch': 'Brands Hatch', silverstone: 'Silverstone', 'magny-cours': 'Magny-Cours', lausitzring: 'Lausitzring',
  sachsenring: 'Sachsenring', oschersleben: 'Oschersleben', norisring: 'Norisring',
};

/** A track's name on the list: 'Hockenheimring Baden-Württemberg' -> 'Hockenheim', 'Circuit de Spa-Francorchamps' ->
 * 'Spa-Francorchamps'; a circuit it doesn't know keeps the name it was given, tidied ('Salzburgring'). */
export function trackName(name: string): string {
  const key = knownVenue(name);
  return (key && NAMES[key]) || unescape(name).replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
}
