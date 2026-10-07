// The app's look in one place: type, shape and spacing shared by every screen, the photos, and the hooks screens take
// their colours (constants/Colors.ts) and styles from. A screen never writes a colour, a corner radius or a label style
// of its own. The shared pieces of the page (masthead, photo hero, numbered sections, rules, big figures, text links)
// are in components/Programme.tsx.
//
// The look is a race programme: square edges everywhere (no cards, no rounded corners, no pills), thick and thin ink
// rules, Anton for headlines and very large figures, Newsreader for reading, Archivo Narrow for labels and numbers in
// columns.
import { ImageSourcePropType, StyleSheet, TextStyle, ViewStyle } from 'react-native';

import { useColorScheme } from '@/components/useColorScheme';
import Colors, { INK, Palette, PhaseKey, Scheme } from '@/constants/Colors';

export type { Palette, PhaseKey, Scheme } from '@/constants/Colors';

// ---------- type ----------

// The faces the app loads before its first render (app/_layout.tsx), by the name each is registered under.
export const FACES = {
  display: { 400: 'Anton_400Regular' },
  body: {
    400: 'Newsreader_400Regular',
    600: 'Newsreader_600SemiBold',
    700: 'Newsreader_700Bold',
  },
  bodyItalic: { 400: 'Newsreader_400Regular_Italic' },
  label: {
    400: 'ArchivoNarrow_400Regular',
    500: 'ArchivoNarrow_500Medium',
    600: 'ArchivoNarrow_600SemiBold',
    700: 'ArchivoNarrow_700Bold',
  },
} as const;

/** display: Anton, headlines and very large figures (always capitals); body: Newsreader, reading text; label: Archivo
 * Narrow, labels, navigation and numbers in columns. */
export type FontRole = 'display' | 'body' | 'label';

/** The face of a role at a weight (the nearest one loaded); italic exists for the reading face. */
export function face(role: FontRole, weight = 400, italic = false): string {
  if (role === 'body' && italic) return FACES.bodyItalic[400];
  const faces = FACES[role] as Record<number, string>;
  const weights = Object.keys(faces).map(Number);
  const best = weights.reduce((a, b) => (Math.abs(b - weight) < Math.abs(a - weight) ? b : a));
  return faces[best];
}

export const Fonts = {
  display: face('display'),
  body: face('body'),
  label: face('label', 600),
  // numbers that line up in columns
  mono: face('label', 600),
  // text inside charts (react-native-svg): ticks, values and their names
  sans: face('label', 600),
};

// every loaded face: its role, weight and slant
const FACE_INFO: Record<string, { role: FontRole; weight: number; italic: boolean }> = Object.fromEntries(
  (['display', 'body', 'bodyItalic', 'label'] as const).flatMap((k) =>
    Object.entries(FACES[k]).map(([w, f]) => [f, { role: k === 'bodyItalic' ? 'body' : k, weight: Number(w),
      italic: k === 'bodyItalic' }])),
);

const weightOf = (w: TextStyle['fontWeight']): number =>
  w == null || w === 'normal' ? 400 : w === 'bold' ? 700 : Number(w) || 400;

/** What the app's Text draws a style with. A style names its role with one of FACES' names (Fonts.display,
 * Fonts.label...) or leaves it to the text: a big figure (tabular-nums, 30 px or more) and a heading (20 px or more,
 * semibold or bolder) take Anton in capitals; other figures that line up (tabular-nums) and uppercase labels take Archivo
 * Narrow, letter-spaced; the rest Newsreader. Other font families are left alone. */
export function resolveFont(style: TextStyle): TextStyle | null {
  const named = style.fontFamily ? FACE_INFO[style.fontFamily] : undefined;
  if (style.fontFamily && !named) return null;
  const size = style.fontSize ?? 14;
  const upper = style.textTransform === 'uppercase';
  const tabular = style.fontVariant?.includes('tabular-nums') ?? false;
  const weight = style.fontWeight != null ? weightOf(style.fontWeight) : named?.weight ?? 400;
  let role: FontRole;
  if (named) role = named.role;
  else if (tabular) role = size >= 30 ? 'display' : 'label';
  else if (upper) role = 'label';
  else role = size >= 20 && weight >= 600 ? 'display' : 'body';
  const italic = style.fontStyle === 'italic' || (named?.italic ?? false);
  const out: TextStyle = {
    fontFamily: face(role, style.fontWeight == null && !named && role === 'label' ? 600 : weight, italic),
    fontWeight: 'normal',
  };
  if (italic && role === 'body') out.fontStyle = 'normal'; // the face is italic itself
  if (role === 'display' && !named) out.textTransform = 'uppercase';
  if (upper && role === 'label' && (style.letterSpacing ?? 0) < size * 0.08) out.letterSpacing = Math.round(size * 0.1 * 10) / 10;
  return out;
}

export const Type = {
  // section labels ("TYRES", "SETUP"...): Archivo Narrow, capitals, letter-spaced
  label: { fontFamily: face('label', 700), fontSize: 12, letterSpacing: 1.4, textTransform: 'uppercase' } as TextStyle,
  // lap times, deltas and every figure that lines up with the one below it
  number: { fontFamily: face('label', 600), fontVariant: ['tabular-nums'] } as TextStyle,
  // a headline or a very large figure: Anton, capitals
  display: { fontFamily: Fonts.display, textTransform: 'uppercase' } as TextStyle,
  // a page's name where there is no photo hero
  title: { fontFamily: Fonts.display, fontSize: 44, lineHeight: 46, textTransform: 'uppercase' } as TextStyle,
  // the italic line under a title or a figure
  dek: { fontFamily: FACES.bodyItalic[400], fontSize: 17, lineHeight: 24 } as TextStyle,
  // a text link: Archivo Narrow capitals over an underline (components/Programme.tsx TextLink draws the underline)
  link: { fontFamily: face('label', 700), fontSize: 14, letterSpacing: 1.4, textTransform: 'uppercase' } as TextStyle,
};

// Square edges everywhere: the names stay so every screen's boxes, buttons and chips lose their rounding at once.
export const Radius = {
  card: 0,
  control: 0,
  chip: 0,
  tag: 0,
};

export const Space = { page: 16, card: 12, gap: 8, gutter: 32, gutterPhone: 16 };

/** The width from which pages take their multi-column (desktop) layout. */
export const WIDE = 760;

/** A chart's root: it sits on the paper like everything else (no plate, no rounding). Spread it into the chart's root
 * style. A chart that measures its own root takes PLATE_PAD off each side. */
export const chartPlate = (c: Palette): ViewStyle => ({ backgroundColor: c.chart.surface, padding: PLATE_PAD });
export const PLATE_PAD = 4;

// ---------- photos ----------

/** Where the picture is anchored when it is cropped to fill its frame, 0 to 1 across and down (CSS object-position). */
export type Focus = { x: number; y: number };

export type Photo = {
  source: ImageSourcePropType;
  width: number; // pixels of the file
  height: number;
  credit: string; // shown in the hero's top-right corner or as a picture's caption
  link: string; // the photo's page, with its author and licence
  focus: Focus;
  focusPhone?: Focus;
};

// The photos (assets/images, licences in assets/CREDITS.md). The Hockenheim photo is CC BY-SA 4.0: shown cropped to
// the frame, so its credit says so.
export const PHOTOS = {
  hockenheim: {
    source: require('../assets/images/hockenheim-straight.jpg'),
    width: 1600, height: 1066,
    credit: 'Photo: Kmtextor / Wikimedia Commons, CC BY-SA 4.0, cropped',
    link: 'https://commons.wikimedia.org/wiki/File:Hockenheimring_start-ziel-gerade_2010.jpg',
    focus: { x: 0.4, y: 1 }, focusPhone: { x: 0.22, y: 0.5 },
  },
  dusk: {
    source: require('../assets/images/track-dusk.jpg'),
    width: 1600, height: 1066,
    credit: 'Photo: Dimitrios Savva and Jarod Guest via Poly Haven / Wikimedia Commons, CC0',
    link: 'https://commons.wikimedia.org/wiki/File:Backplate_%E2%80%93_Zwartkops_Curve_Sunset_(Dimitrios_Savva_and_Jarod_Guest_via_Poly_Haven)_39.jpg',
    focus: { x: 0.5, y: 0.3 }, focusPhone: { x: 0.28, y: 0.5 },
  },
  zandvoort: {
    source: require('../assets/images/zandvoort-aerial.jpg'),
    width: 1600, height: 1065,
    credit: 'Photo: dronepicr / Wikimedia Commons, CC BY 2.0',
    link: 'https://commons.wikimedia.org/wiki/File:Aerial_view_of_Motorsport_race_track_Circuit_Zandvoort_Formula_one_(40889997713).jpg',
    focus: { x: 0.5, y: 0.5 },
  },
} satisfies Record<string, Photo>;

/** The photo of a track: Hockenheim's and Zandvoort's own, the empty corner at dusk anywhere else. */
export const photoFor = (track: string | null | undefined): Photo =>
  track && /hockenheim/i.test(track) ? PHOTOS.hockenheim
    : track && /zandvoort/i.test(track) ? PHOTOS.zandvoort : PHOTOS.dusk;

// ---------- colours ----------

/** The colour tokens of the scheme in use. */
export function useTheme(): Palette {
  return Colors[useColorScheme()];
}

/** A screen's styles made from the colour tokens: `const useStyles = themed((c) => ({ card: { borderColor: c.border } }))`,
 * then `const styles = useStyles()` in each component. One style sheet per scheme, made the first time it's drawn. */
export function themed<T extends StyleSheet.NamedStyles<T> | StyleSheet.NamedStyles<any>>(
  factory: (c: Palette) => T & StyleSheet.NamedStyles<any>,
): () => T {
  const sheets: Partial<Record<Scheme, T>> = {};
  return function useStyles() {
    const scheme = useColorScheme();
    return (sheets[scheme] ??= StyleSheet.create(factory(Colors[scheme])));
  };
}

// The phase names the analyses use, onto the five driving phases of the colour coding (brake red, entry orange,
// mid-corner violet, exit teal, full throttle green)
const PHASE_OF: Record<string, PhaseKey> = {
  braking: 'braking',
  brake: 'braking',
  entry: 'turnIn',
  trail: 'turnIn',
  'trail braking': 'turnIn',
  'turn-in': 'turnIn',
  turn_in: 'turnIn',
  'mid-corner': 'mid',
  mid_corner: 'mid',
  mid: 'mid',
  'at the grip limit': 'mid',
  exit: 'traction',
  traction: 'throttle',
  'full throttle': 'throttle',
  throttle: 'throttle',
  power: 'throttle',
};

/** The colour of a driving phase ("braking", "entry", "mid-corner", "exit", "full throttle", or the stint tool's
 * "trail", "mid", "power"); grey for a name that isn't a phase. */
export function phaseColor(c: Palette, phase: string): string {
  const k = PHASE_OF[phase.toLowerCase()];
  return k ? c.phase[k] : c.chart.other;
}

const EVEN_S = 0.005; // a time difference smaller than this is no difference

/** Text colour of a time difference in seconds: green when quicker (negative), red when slower, grey when even. */
export function deltaColor(c: Palette, seconds: number | null | undefined): string | undefined {
  if (seconds == null || !Number.isFinite(seconds)) return undefined;
  return Math.abs(seconds) < EVEN_S ? c.delta.even : seconds < 0 ? c.delta.gain : c.delta.loss;
}

/** A mark's colour for a time difference, deeper the bigger it is against `scale` (what counts as big on the
 * screen): bars, track sections, the edge of a row. Time lost takes a step of the time-lost ramp. */
export function deltaMark(c: Palette, seconds: number, scale: number): string {
  if (Math.abs(seconds) < EVEN_S) return c.delta.even;
  if (seconds > 0) return lossStep(c, seconds / Math.max(scale, 1e-6));
  return ramp(c.delta.gainRamp, Math.abs(seconds) / Math.max(scale, 1e-6));
}

/** A step of the time-lost ramp for a share (0 to 1) of what counts as big on the screen. */
export function lossStep(c: Palette, share: number): string {
  const steps = c.timing.loss;
  return steps[Math.max(0, Math.min(steps.length - 1, Math.ceil(share * steps.length) - 1))];
}

/** A soft background for a time difference (a table cell), stronger the bigger it is against `scale`. */
export function deltaWash(c: Palette, seconds: number, scale: number): string {
  if (Math.abs(seconds) < EVEN_S) return 'transparent';
  const steps = seconds < 0 ? c.delta.gainSteps : c.delta.lossSteps;
  const k = Math.min(steps.length - 1, Math.floor((Math.abs(seconds) / Math.max(scale, 1e-6)) * steps.length));
  return steps[k];
}

const hexRgb = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));

/** A step along a two-colour ramp, t from 0 to 1. */
export function ramp([lo, hi]: string[], t: number) {
  const k = Math.max(0, Math.min(1, t));
  const a = hexRgb(lo);
  const b = hexRgb(hi);
  return `#${a.map((v, i) => Math.round(v + (b[i] - v) * k).toString(16).padStart(2, '0')).join('')}`;
}

/** Near-black or white for text on a filled colour, whichever reads. */
export function inkOn(fill: string) {
  const [r, g, b] = hexRgb(fill).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.35 ? INK.onLight : INK.onDark;
}

/** Light and dark versions of a set of colours made from the tokens, picked with `[scheme]`. */
export function byScheme<T>(make: (c: Palette) => T): Record<Scheme, T> {
  return { light: make(Colors.light), dark: make(Colors.dark) };
}
