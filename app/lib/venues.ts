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

/** 'Circuit Paul Ricard' -> 'paul-ricard', 'N&uuml;rburgring' -> 'nurburgring', 'Hockenheim GP' -> 'hockenheim'. */
export function venueKey(name: string | null | undefined): string | null {
  if (!name) return null;
  const low = plain(name).replace(/_/g, ' ');
  for (const [key, words] of Object.entries(ALIASES)) {
    if (words.some((w) => low.includes(w))) return key;
  }
  return low.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || null;
}
