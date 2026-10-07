// The app's look in one place: type, shape and spacing shared by every screen, and the hooks screens take their colours
// (constants/Colors.ts) and styles from. A screen never writes a colour, a corner radius or a label style of its own.
//
// The look is a timing screen: square edges everywhere (no rounded cards, no pills), full-width bands split by hairline
// rules, condensed uppercase letter-spaced labels, monospaced numbers.
import { ImageSourcePropType, StyleSheet, TextStyle, ViewStyle } from 'react-native';

import { useColorScheme } from '@/components/useColorScheme';
import Colors, { INK, Palette, PhaseKey, Scheme } from '@/constants/Colors';

export type { Palette, PhaseKey, Scheme } from '@/constants/Colors';

// ---------- type ----------

// The faces the app loads before its first render (app/_layout.tsx), by the name each is registered under:
// Barlow Condensed for labels, headings and the big italic names; Barlow Semi Condensed for reading text;
// JetBrains Mono for every number.
export const FACES = {
  label: {
    600: 'BarlowCondensed_600SemiBold',
    700: 'BarlowCondensed_700Bold',
    800: 'BarlowCondensed_800ExtraBold',
  },
  labelItalic: { 800: 'BarlowCondensed_800ExtraBold_Italic' },
  body: {
    400: 'BarlowSemiCondensed_400Regular',
    500: 'BarlowSemiCondensed_500Medium',
    600: 'BarlowSemiCondensed_600SemiBold',
  },
  mono: {
    500: 'JetBrainsMono_500Medium',
    700: 'JetBrainsMono_700Bold',
  },
} as const;

export type FontRole = 'label' | 'body' | 'mono';

/** The face of a role at a weight (the nearest one loaded); italic only exists for the condensed headings. */
export function face(role: FontRole, weight: number = role === 'label' ? 600 : role === 'mono' ? 500 : 400,
  italic = false): string {
  if (role === 'label' && italic) return FACES.labelItalic[800];
  const faces = FACES[role] as Record<number, string>;
  const weights = Object.keys(faces).map(Number);
  const best = weights.reduce((a, b) => (Math.abs(b - weight) < Math.abs(a - weight) ? b : a));
  return faces[best];
}

export const Fonts = {
  label: face('label', 700),
  body: face('body', 400),
  mono: face('mono', 500),
  // text inside charts (react-native-svg): ticks and values, so the number face
  sans: face('mono', 500),
};

const ROLE_OF_FACE: Record<string, FontRole> = Object.fromEntries(
  (['label', 'labelItalic', 'body', 'mono'] as const).flatMap((k) =>
    Object.values(FACES[k]).map((f) => [f, k === 'labelItalic' ? 'label' : k] as [string, FontRole])),
);

const weightOf = (w: TextStyle['fontWeight']): number =>
  w == null || w === 'normal' ? 400 : w === 'bold' ? 700 : Number(w) || 400;

/** What the app's Text draws a style with: the face for its role and weight. A style names its role with one of
 * FACES' names (Fonts.label, Fonts.mono...) or leaves it to the text: figures that line up (tabular-nums) take the number
 * face, uppercase labels the condensed face, the rest the reading face. Uppercase labels get their letter-spacing.
 * Other font families (none in the app) are left alone. */
export function resolveFont(style: TextStyle): TextStyle | null {
  const named = style.fontFamily;
  if (named && !(named in ROLE_OF_FACE)) return null;
  const upper = style.textTransform === 'uppercase';
  const role: FontRole = named ? ROLE_OF_FACE[named]
    : style.fontVariant?.includes('tabular-nums') ? 'mono' : upper ? 'label' : 'body';
  const italic = style.fontStyle === 'italic';
  // a role's own face sets the weight when the style gives none
  const weight = style.fontWeight != null ? weightOf(style.fontWeight)
    : named ? Number(Object.entries(FACES[role]).find(([, f]) => f === named)?.[0] ?? 400) : role === 'label' ? 600 : 400;
  const out: TextStyle = { fontFamily: face(role, weight, italic), fontWeight: 'normal' };
  if (italic && role === 'label') out.fontStyle = 'normal'; // the face is italic itself
  if (upper && role === 'label') {
    const size = style.fontSize ?? 14;
    if ((style.letterSpacing ?? 0) < size * 0.1) out.letterSpacing = Math.round(size * 0.13 * 10) / 10;
  }
  return out;
}

export const Type = {
  // section labels ("TYRES", "SETUP"...): condensed, uppercase, letter-spaced, muted
  label: { fontFamily: face('label', 600), fontSize: 12, letterSpacing: 1.7, textTransform: 'uppercase', opacity: 0.62 } as TextStyle,
  // lap times, deltas and every figure that lines up with the one below it
  number: { fontFamily: Fonts.mono, fontVariant: ['tabular-nums'] } as TextStyle,
  // a page's name where there is no photo band: big condensed italic capitals
  title: { fontFamily: face('label', 800, true), fontSize: 40, lineHeight: 42, textTransform: 'uppercase' } as TextStyle,
  // a band's header ("01 PACE")
  heading: { fontFamily: face('label', 700), fontSize: 15, letterSpacing: 2.1, textTransform: 'uppercase' } as TextStyle,
  // a text action: uppercase condensed
  action: { fontFamily: face('label', 700), fontSize: 13, letterSpacing: 1.6, textTransform: 'uppercase' } as TextStyle,
};

// Square edges everywhere: the names stay so every screen's boxes, buttons and chips lose their rounding at once.
export const Radius = {
  card: 0,
  control: 0,
  chip: 0,
  tag: 0,
};

export const Space = { page: 16, card: 12, gap: 8, gutter: 24 };

/** A chart's root: it sits on the page like everything else (no plate, no rounding). Spread it into the chart's root
 * style. A chart that measures its own root takes PLATE_PAD off each side. */
export const chartPlate = (c: Palette): ViewStyle => ({ backgroundColor: c.chart.surface, padding: PLATE_PAD });
export const PLATE_PAD = 4;

// ---------- photos ----------

export type Photo = {
  source: ImageSourcePropType;
  credit: string; // the credit tag on the photo
  short: string; // the credit tag on a phone
  link: string; // the photo's page, with its author and licence
};

// The photos at the top of the event list and the report (assets/images, credits in assets/CREDITS.md).
export const PHOTOS: Record<'track' | 'hockenheim', Photo> = {
  track: {
    source: require('../assets/images/track-dusk.jpg'),
    credit: 'Photo: Dimitrios Savva and Jarod Guest via Poly Haven / Wikimedia Commons, CC0',
    short: 'Photo: D. Savva, J. Guest / Poly Haven, CC0',
    link: 'https://commons.wikimedia.org/wiki/File:Backplate_%E2%80%93_Zwartkops_Curve_Sunset_(Dimitrios_Savva_and_Jarod_Guest_via_Poly_Haven)_39.jpg',
  },
  hockenheim: {
    source: require('../assets/images/hockenheim-straight.jpg'),
    credit: 'Photo: Kmtextor / Wikimedia Commons, CC BY-SA 4.0 (cropped, darkened)',
    short: 'Photo: Kmtextor, CC BY-SA 4.0 (cropped, darkened)',
    link: 'https://commons.wikimedia.org/wiki/File:Hockenheimring_start-ziel-gerade_2010.jpg',
  },
};

/** The photo for a track: the Hockenheim one at Hockenheim, the generic dusk corner elsewhere. */
export const photoFor = (track: string | null | undefined): Photo =>
  track && /hockenheim/i.test(track) ? PHOTOS.hockenheim : PHOTOS.track;

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

// The phase names the analyses use, onto the five driving phases of the colour coding
const PHASE_OF: Record<string, PhaseKey> = {
  braking: 'braking',
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
 * screen): bars, track sections, the edge of a row. Time lost takes the yellow time-lost ramp. */
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
