// The app's look in one place: type, shape and spacing shared by every screen, the race-track picture behind the
// pages, and the hooks screens take their colours (constants/Colors.ts) and styles from. A screen never writes a
// colour, a corner radius or a label style of its own.
import { ImageSourcePropType, Platform, StyleSheet, TextStyle } from 'react-native';

import { useColorScheme } from '@/components/useColorScheme';
import Colors, { INK, Palette, PhaseKey, Scheme } from '@/constants/Colors';

export type { Palette, PhaseKey, Scheme } from '@/constants/Colors';

export const Fonts = {
  // the system sans everywhere (SVG text on the web would otherwise fall back to a serif face)
  sans: Platform.select({ web: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif', default: undefined }),
  // lap times and other figures that line up in columns
  mono: Platform.select({
    web: 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace',
    ios: 'Menlo',
    android: 'monospace',
    default: undefined,
  }),
};

export const Radius = {
  card: 10, // cards, panels, banners, forms, tables
  control: 8, // buttons, inputs, segmented tabs
  chip: 16, // chips and pills
  tag: 4, // small inline tags
};

export const Space = { page: 16, card: 12, gap: 8 };

export const Type = {
  // section labels ("TYRES", "SETUP"...)
  label: { fontSize: 13, fontWeight: '600', opacity: 0.6, textTransform: 'uppercase', letterSpacing: 0.5 } as TextStyle,
  // lap times, deltas and every figure that lines up with the one below it
  number: { fontVariant: ['tabular-nums'] } as TextStyle,
};

// The race-track picture behind the pages: a made-up circuit seen from above (assets/images/backdrop-*.png, drawn
// for this app). Null: no picture.
export const BACKDROP: Record<Scheme, ImageSourcePropType | null> = {
  light: require('../assets/images/backdrop-light.png'),
  dark: require('../assets/images/backdrop-dark.png'),
};

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
  'turn-in': 'turnIn',
  'mid-corner': 'mid',
  mid: 'mid',
  'at the grip limit': 'mid',
  exit: 'traction',
  traction: 'traction',
  'full throttle': 'throttle',
  power: 'throttle',
};

/** The colour of a driving phase ("braking", "entry", "mid-corner", "exit", "full throttle", or the stint tool's
 * "trail", "mid", "power"); grey for a name that isn't a phase. */
export function phaseColor(c: Palette, phase: string): string {
  const k = PHASE_OF[phase.toLowerCase()];
  return k ? c.phase[k] : c.chart.other;
}

/** The colour of a time difference in seconds (negative: quicker), stronger with its size against `scale` (the size
 * that counts as big on this screen). `wash`: the soft step for a background, else the colour for text and marks. */
export function deltaColor(c: Palette, seconds: number, scale: number, wash = false): string {
  const even = Math.abs(seconds) < 0.005;
  if (!wash) return even ? c.delta.even : seconds < 0 ? c.delta.gain : c.delta.loss;
  if (even) return 'transparent';
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
