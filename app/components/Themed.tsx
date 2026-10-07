/**
 * Text and View in the app's colours (constants/Colors.ts), in the scheme picked in Tools › Appearance, and Text in the
 * programme's faces (constants/Theme.ts resolveFont): Anton for headlines and big figures, Archivo Narrow for labels
 * and numbers in columns, Newsreader for the rest. Text is never drawn smaller than the readable sizes
 * (constants/Theme.ts MIN_TEXT): 12 px, 13 px for a label, 16 px for reading text on a phone.
 */
import { Children, createContext, isValidElement, ReactNode, useContext } from 'react';
import { Text as DefaultText, View as DefaultView, StyleSheet, TextStyle, useWindowDimensions } from 'react-native';

import { useColorScheme } from './useColorScheme';

import Colors, { Palette } from '@/constants/Colors';
import { MIN_TEXT, readableSize, resolveFont, WIDE } from '@/constants/Theme';

type ThemeProps = {
  lightColor?: string;
  darkColor?: string;
};

export type TextProps = ThemeProps & DefaultText['props'];
export type ViewProps = ThemeProps & DefaultView['props'];

// the tokens that are a single colour
type ColorName = { [K in keyof Palette]: Palette[K] extends string ? K : never }[keyof Palette];

export function useThemeColor(props: { light?: string; dark?: string }, colorName: ColorName) {
  const theme = useColorScheme();
  const colorFromProps = props[theme];

  if (colorFromProps) {
    return colorFromProps;
  } else {
    return Colors[theme][colorName];
  }
}

// The size the reading text a Text sits in was raised to: the words nested in it (a bold figure, a name) keep up.
const ReadingFloor = createContext(0);

/** How many characters a Text's children say (counting what nested texts say), up to `cap`. */
function charsOf(children: ReactNode, cap: number): number {
  let n = 0;
  Children.forEach(children, (child) => {
    if (n > cap) return;
    if (typeof child === 'string' || typeof child === 'number') n += String(child).length;
    else if (isValidElement<{ children?: ReactNode }>(child)) n += charsOf(child.props.children, cap - n);
  });
  return n;
}

export function Text(props: TextProps) {
  const { style, lightColor, darkColor, ...otherProps } = props;
  const color = useThemeColor({ light: lightColor, dark: darkColor }, 'text');
  const phone = useWindowDimensions().width < WIDE;
  const floor = useContext(ReadingFloor);
  const flat = (StyleSheet.flatten(style) ?? {}) as TextStyle;
  const font = resolveFont(flat);
  // a paragraph on a phone: 16 px at least, and so is everything nested in it
  const reading = phone && floor === 0 && charsOf(props.children, MIN_TEXT.bodyChars) > MIN_TEXT.bodyChars;
  const size = readableSize(flat, floor, reading);

  const text = <DefaultText style={[{ color }, flat, font, size]} {...otherProps} />;
  return reading ? <ReadingFloor.Provider value={MIN_TEXT.phoneBody}>{text}</ReadingFloor.Provider> : text;
}

// Views are see-through: the paper shows behind them.
export function View(props: ViewProps) {
  const { style, lightColor, darkColor, ...otherProps } = props;
  const theme = useColorScheme();
  const backgroundColor = (theme === 'dark' ? darkColor : lightColor) ?? 'transparent';

  return <DefaultView style={[{ backgroundColor }, style]} {...otherProps} />;
}
