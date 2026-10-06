// The app's look in one place: type, shape and spacing shared by every screen, the race-track picture behind the
// pages, and the hooks screens take their colours (constants/Colors.ts) and styles from. A screen never writes a
// colour, a corner radius or a label style of its own.
import { ImageSourcePropType, Platform, StyleSheet, TextStyle } from 'react-native';

import { useColorScheme } from '@/components/useColorScheme';
import Colors, { Palette, Scheme } from '@/constants/Colors';

export type { Palette, Scheme } from '@/constants/Colors';

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

/** Light and dark versions of a set of colours made from the tokens, picked with `[scheme]`. */
export function byScheme<T>(make: (c: Palette) => T): Record<Scheme, T> {
  return { light: make(Colors.light), dark: make(Colors.dark) };
}
